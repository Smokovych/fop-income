// Фоновий воркер сервера на Node: виконує той самий код програми, що й браузер (standalone/*.js),
// тож виписки, класифікація, комісія й курси НБУ рахуються однаково.
// Вхід — JSON у stdin, вихід — JSON у stdout (діагностика — у stderr). Команди:
//   {cmd:"sync", state, api}                          → {state}            оновити виписки всіх банків
//   {cmd:"kep-store", files:[b64], password, secret, api} → {blob, info}   перевірити ключ КЕП і зашифрувати
//   {cmd:"tax-refresh", state, blob, secret, api}     → {state}            облікові дані з Кабінету
// Ключ КЕП зберігається лише зашифрованим (AES-256-GCM, ключ шифрування — HKDF від секрету сервера) і
// використовується тільки для підпису РНОКПП платника — іншого тексту воркер не підписує.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const nodeCrypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const SOURCES = ["vendor/kep.bundle.js", "commission.js", "privat.js", "sync.js", "tax.js", "budget.js"];

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
  });
}

// ---------------------------------------------------------------- шифрування ключа КЕП
function encKey(secret) {
  if (!secret || String(secret).length < 16) throw new Error("На сервері не задано SECRET_KEY — ключ КЕП не можна безпечно зберегти");
  return Buffer.from(nodeCrypto.hkdfSync("sha256", Buffer.from(String(secret)), Buffer.from("fop-income/kep"), Buffer.from("v1"), 32));
}
function encrypt(obj, secret) {
  const iv = nodeCrypto.randomBytes(12);
  const c = nodeCrypto.createCipheriv("aes-256-gcm", encKey(secret), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.from(JSON.stringify({ v: 1, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") })).toString("base64");
}
function decrypt(blob, secret) {
  const b = JSON.parse(Buffer.from(blob, "base64").toString("utf8"));
  const d = nodeCrypto.createDecipheriv("aes-256-gcm", encKey(secret), Buffer.from(b.iv, "base64"));
  d.setAuthTag(Buffer.from(b.tag, "base64"));
  try { return JSON.parse(Buffer.concat([d.update(Buffer.from(b.ct, "base64")), d.final()]).toString("utf8")); }
  catch (e) { throw new Error("Не вдалося розшифрувати збережений ключ (змінився SECRET_KEY сервера?) — збережіть ключ заново"); }
}

// ---------------------------------------------------------------- середовище програми
function makeContext(api) {
  const log = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");
  const store = { "fopIncome.api": JSON.stringify({ mono: api.mono, nbu: api.nbu, monoInterval: api.monoInterval ?? 61000 }) };
  const ctx = {
    console: { log, warn: log, error: log, info: log },
    fetch, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, Blob, Response,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    crypto: nodeCrypto.webcrypto,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem() {}, removeItem() {} },
    document: { querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    navigator: { onLine: true },
  };
  ctx.globalThis = ctx; ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  const pre = `const SERVER_MODE = false; const PRIVAT_DIRECT_API = ${JSON.stringify(api.privat)};
    const SYNC_DEADLINE = Date.now() + ${Number(api.maxRunMs) || 40 * 60 * 1000}; // довга історія — частинами, решта наступного запуску
    async function acquireSyncLock() { return true; } function releaseSyncLock() {}
    function toast(msg, isError) { console.log((isError ? "! " : "") + msg); } function refreshActive() {}
    function loadBanks() {} function loadAccount() {} function updateReviewBadge() {}\n`;
  const post = `
    // Кабінет і CMP — напряму (у браузері це роблять міст або /proxy/tax-bridge)
    async function bridgePost(payload) {
      if (payload.path === "cmp") {
        try {
          const bin = Uint8Array.from(atob(payload.body || ""), (c) => c.charCodeAt(0));
          const r = await fetch(${JSON.stringify(api.cmpTest || "")} || payload.url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bin });
          const buf = new Uint8Array(await r.arrayBuffer());
          let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          return { status: "SUCCESS", http: r.status, body64: btoa(s) };
        } catch (e) { return { status: "SUCCESS", http: 0, body64: "" }; }
      }
      const q = new URLSearchParams(); for (const [k, v] of Object.entries(payload.params || {})) q.set(k, v);
      let r;
      try { r = await fetch(${JSON.stringify(api.tax)} + "/" + payload.path + (String(q) ? "?" + q : ""), { headers: { Authorization: payload.auth, Accept: "application/json", "Content-Type": "application/json" } }); }
      catch (e) { throw new Error("Сервер не зміг з'єднатися з Кабінетом: " + e.message); }
      return { status: "SUCCESS", http: r.status, body: await r.text() };
    }
    this.__fop = { get S() { return S; }, load, syncAll, fetchPayerCard, fetchBudget, taxSummary, reclassifyAll, log, kyivDate, nowTs };`;
  const code = pre + SOURCES.map((f) => fs.readFileSync(path.join(ROOT, "standalone", f), "utf8")).join("\n;\n") + post;
  ctx.atob = (s) => Buffer.from(s, "base64").toString("binary");
  ctx.btoa = (s) => Buffer.from(s, "binary").toString("base64");
  vm.runInContext(code, ctx, { filename: "fop-standalone.js" });
  return ctx;
}

// ---------------------------------------------------------------- ключ КЕП
async function openStoredKey(ctx, files, password, certB64) {
  const key = ctx.FopKep.openKey(files.map((b) => new Uint8Array(Buffer.from(b, "base64"))), password);
  if (!key.info.hasCert && certB64) key.addCerts([certB64]);
  if (!key.info.hasCert) {
    const post = async (url, bodyB64) => { const w = await vm.runInContext("bridgePost", ctx)({ path: "cmp", url, body: bodyB64 }); return { status: w.http, bodyB64: w.body64 }; };
    const r = await key.findCert(post);
    if (!r.ok) throw new Error("Сертифікат ключа не знайдено на серверах надавачів");
  }
  return key;
}

async function main() {
  const req = await readStdin();
  const api = req.api || {};
  const ctx = makeContext(api);
  const F = ctx.__fop;
  if (req.cmd === "sync") {
    F.load(req.state);
    await F.syncAll();
    return { state: F.S };
  }
  if (req.cmd === "kep-store") {
    const key = await openStoredKey(ctx, req.files || [], req.password || "", null);
    const c = key.info.cert;
    if (!req.skipExpiry && c && c.validTo && Date.parse(c.validTo) < Date.now()) throw new Error("Сертифікат ключа протермінований (діяв до " + c.validTo.slice(0, 10) + ")");
    return { blob: encrypt({ files: req.files, password: req.password }, req.secret), info: c, certB64: key.info.certB64 };
  }
  if (req.cmd === "tax-refresh") {
    F.load(req.state);
    const S = F.S;
    S.tax = S.tax || {};
    try {
      const k = decrypt(req.blob, req.secret);
      const key = await openStoredKey(ctx, k.files, k.password, S.tax.cert_b64);
      S.tax.cert_b64 = key.info.certB64;
      const tin = (key.info.cert && key.info.cert.tin) || S.settings.owner_tax_id;
      if (!/^\d{8,10}$/.test(String(tin || ""))) throw new Error("У сертифікаті ключа немає РНОКПП — вкажіть його в Налаштуваннях");
      const auth = await key.sign(String(tin));   // підписується лише РНОКПП
      S.tax.card = await F.fetchPayerCard(auth);
      try { S.tax.budget = await F.fetchBudget(auth, Number(F.kyivDate(F.nowTs()).slice(0, 4))); }
      catch (e) { S.tax.budget = Object.assign(S.tax.budget || {}, { error: "Стан розрахунків: " + e.message }); }
      S.tax.fetched_at = Math.floor(Date.now() / 1000);
      S.tax.last_error = null;
      const s = F.taxSummary();
      let filled = false;
      if (!S.settings.owner_tax_id && s.tin && /^\d{10}$/.test(String(s.tin))) { S.settings.owner_tax_id = String(s.tin); filled = true; }
      if (!S.settings.owner_name && s.name) { S.settings.owner_name = String(s.name).replace(/^ФОП\s+/i, ""); filled = true; }
      if (filled) F.reclassifyAll();
      F.log("info", `Облікові дані з Кабінету оновлено сервером, блоків: ${S.tax.card.length}`);
    } catch (e) {
      S.tax.last_error = e.message;
      F.log("error", `Кабінет: ${e.message}`);
    }
    return { state: S };
  }
  throw new Error("Невідома команда");
}

// вихід — лише після того, як увесь JSON записано в stdout (інакше великий стан обрізається)
const finish = (obj, code) => process.stdout.write(JSON.stringify(obj), () => process.exit(code));
main().then((out) => finish(out, 0)).catch((e) => finish({ error: String((e && e.message) || e) }, 1));
