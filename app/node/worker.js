// Фоновий воркер сервера на Node: виконує той самий код програми, що й браузер (standalone/*.js),
// тож виписки, класифікація, комісія й курси НБУ рахуються однаково.
// Вхід — JSON у stdin, вихід — JSON у stdout (діагностика — у stderr). Команди:
//   {cmd:"sync", state, api}                          → {state}            оновити виписки всіх банків
//   {cmd:"kep-store", files:[b64], password, secret, api} → {blob, info}   перевірити ключ КЕП і зашифрувати
//   {cmd:"tax-refresh", state, blob, secret, api}     → {state}            облікові дані з Кабінету
//   {cmd:"fiscal", state, blob, secret, api}          → {state, more}      фіскальні чеки ПРРО з фіскального сервера ДПС
// Ключ КЕП зберігається лише зашифрованим (AES-256-GCM, ключ шифрування — HKDF від секрету сервера) і підписує
// лише РНОКПП платника (Кабінет) та команди ПЕРЕГЛЯДУ фіскального сервера (FISCAL_READ_COMMANDS) — видати чек чи
// відкрити зміну ним неможливо.
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
    const SYNC_DEADLINE = Date.now() + ${Number(api.maxRunMs) || 8 * 60 * 1000}; // довга історія — частинами по кілька хвилин, кожна зберігається
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
    this.__fop = { get S() { return S; }, load, syncAll, backlog: () => remainingWindows() + privatMonthsLeft(), fetchPayerCard, fetchBudget, taxSummary, reclassifyAll, log, kyivDate, nowTs };`;
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

// ---------------------------------------------------------------- фіскальний сервер ДПС (ПРРО)
// Протокол: JSON-команда, підписана КЕП (CAdES, дані всередині), POST на <адреса>/cmd як application/octet-stream.
// Відповідь — JSON (з ?resultAsJson=true помилки теж JSON: ErrorCode/ErrorMessage). Дати змін — ISO 8601.
const FISCAL_READ_COMMANDS = new Set(["Objects", "Shifts", "Documents", "CheckExt"]);
let fsTsp = false;   // чи вимагає сервер позначку часу (CAdES-E-T) — з'ясовується за першою відмовою

async function fiscalCmd(ctx, key, api, cmd) {
  if (!FISCAL_READ_COMMANDS.has(cmd.Command)) throw new Error("Недозволена команда фіскального сервера");
  const text = JSON.stringify(Object.assign({}, cmd, { UID: nodeCrypto.randomUUID() }));
  const post = async (url, bodyB64) => {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/tsp-request" }, body: Buffer.from(bodyB64, "base64") });
      return { status: r.status, bodyB64: Buffer.from(await r.arrayBuffer()).toString("base64") };
    } catch (e) { return { status: 0, bodyB64: "" }; }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    let signed;
    try { signed = await key.sign(text, null, fsTsp ? { post } : undefined); }
    catch (e) { if (fsTsp) throw new Error("Не вдалося отримати позначку часу від надавача ключа"); throw e; }
    let r;
    try {
      r = await fetch(api.fiscal + "/cmd?resultAsJson=true", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from(signed, "base64") });
    } catch (e) {
      if (attempt < 2) { await new Promise((ok) => setTimeout(ok, 3000 * (attempt + 1))); continue; }
      throw new Error("Немає зв'язку з фіскальним сервером ДПС: " + ((e.cause && e.cause.code) || e.message));
    }
    if (r.status === 204) return null;
    const body = await r.text();
    let j = null;
    try { j = JSON.parse(body); } catch (e) { /* не JSON */ }
    const err = j && j.ErrorCode != null && j.ErrorCode !== 0 ? `${j.ErrorMessage || "помилка"} (код ${j.ErrorCode})` : !r.ok ? (body || "HTTP " + r.status).slice(0, 300) : null;
    if (err) {
      if (!fsTsp && /позначк|timestamp|час(у)? засвідч/i.test(err)) { fsTsp = true; continue; }   // повтор з позначкою часу
      if ([500, 502, 503, 504].includes(r.status) && attempt < 2) { await new Promise((ok) => setTimeout(ok, 3000 * (attempt + 1))); continue; }
      throw new Error("Фіскальний сервер: " + err);
    }
    if (!j) throw new Error("Фіскальний сервер повернув відповідь у незнайомому форматі");
    return j;
  }
  throw new Error("Фіскальний сервер не відповідає");
}

// XML чека (windows-1251) → коротка картка: шапка, сума, форми оплати, товари
function parseCheckXml(buf) {
  let xml = new TextDecoder("windows-1251").decode(buf);
  if (!/<CHECK[\s>]/.test(xml)) {
    // підписаний документ (CMS) — XML лежить усередині, шукаємо його в байтах
    const raw = Buffer.from(buf).toString("latin1"), a = raw.indexOf("<?xml"), b = raw.lastIndexOf("</CHECK>");
    if (a < 0 || b < 0) return null;
    xml = new TextDecoder("windows-1251").decode(Buffer.from(raw.slice(a, b + 8), "latin1"));
  }
  const tag = (s, n) => { const m = s.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`)); return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").trim() : null; };
  const rows = (s, n) => { const m = s.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`)); return m ? [...m[1].matchAll(/<ROW[^>]*>([\s\S]*?)<\/ROW>/g)].map((x) => x[1]) : []; };
  const head = tag(xml, "CHECKHEAD") || "", total = tag(xml, "CHECKTOTAL") || "";
  const n = (v) => (v == null ? null : Number(String(v).replace(",", ".")));
  return {
    doctype: n(tag(head, "DOCTYPE")), subtype: n(tag(head, "DOCSUBTYPE")),
    date: tag(head, "ORDERDATE"), time: tag(head, "ORDERTIME"), cashier: tag(head, "CASHIER"),
    point: tag(head, "POINTNM"), sum: n(tag(total, "SUM")),
    pays: rows(xml, "CHECKPAY").map((r) => ({ form: tag(r, "PAYFORMNM"), code: n(tag(r, "PAYFORMCD")), sum: n(tag(r, "SUM")) })),
    items: rows(xml, "CHECKBODY").map((r) => ({ name: tag(r, "NAME"), qty: n(tag(r, "AMOUNT")), unit: tag(r, "UNITNM"), price: n(tag(r, "PRICE")), cost: n(tag(r, "COST")) })),
  };
}

// Синхронізація: каси (Objects) → зміни за період (по місяцях, від свіжих до старих) → документи зміни → чеки.
// Працює до SYNC_DEADLINE; повертає true, якщо ще є що довантажувати (сервер запустить наступну частину).
async function fiscalSync(ctx, F, S, key, api, req) {
  const FS = S.fiscal;
  const deadline = Date.now() + (Number(api.maxRunMs) || 8 * 60 * 1000);
  const timeUp = () => Date.now() > deadline;
  const today = F.kyivDate(F.nowTs());
  const startIso = req.from || (S.settings.sync_start || today.slice(0, 4) + "-01-01");
  const objs = await fiscalCmd(ctx, key, api, { Command: "Objects" });
  for (const o of (objs && objs.TaxObjects) || []) {
    for (const r of o.TransactionsRegistrars || []) {
      const id = String(r.NumFiscal);
      FS.registrars[id] = Object.assign(FS.registrars[id] || {}, { id, name: r.Name || "", local: r.NumLocal, closed: !!r.Closed,
        object: o.Name || "", address: o.Address || "", org: o.OrgName || "" });
    }
  }
  if (!Object.keys(FS.registrars).length) { F.log("info", "Фіскальний сервер: ПРРО для вашого ключа не знайдено"); return false; }
  let newChecks = 0;
  for (const reg of Object.values(FS.registrars)) {
    // 1) свіжі зміни: від останнього завантаженого дня (з перекриттям 2 дні) до сьогодні; 2) історія назад по місяцях
    const tomorrow = new Date(Date.parse(today) + 864e5).toISOString().slice(0, 10);
    if (reg.loaded_to) {
      const fresh = new Date(Date.parse(reg.loaded_to) - 2 * 864e5).toISOString().slice(0, 10);
      if (await fiscalWindow(ctx, F, FS, key, api, reg, fresh, today, () => newChecks++, timeUp)) reg.loaded_to = today;
    }
    if (!reg.loaded_from) reg.loaded_from = tomorrow;
    while (!timeUp() && reg.loaded_from > startIso) {
      const end = new Date(Date.parse(reg.loaded_from) - 864e5);
      const from = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1)).toISOString().slice(0, 10);
      const f = from < startIso ? startIso : from, t = end.toISOString().slice(0, 10);
      if (!(await fiscalWindow(ctx, F, FS, key, api, reg, f, t, () => newChecks++, timeUp))) break;
      reg.loaded_from = f;
      if (!reg.loaded_to) reg.loaded_to = today;
    }
  }
  F.log("info", `Фіскальні чеки: нових ${newChecks}, усього ${Object.keys(FS.checks).length}`);
  return Object.values(FS.registrars).some((r) => r.loaded_from > startIso);
}

// Зміщення Києва для дати (взимку +02:00, влітку +03:00) — щоб період не виходив за межі місяця
function kyivOffset(iso) {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Kyiv", timeZoneName: "longOffset" }).formatToParts(new Date(iso + "T12:00:00Z")).find((p) => p.type === "timeZoneName").value;
    const m = s.match(/([+-]\d{2}):?(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : "+02:00";
  } catch (e) { return "+02:00"; }
}

// Фіскальний сервер приймає запит змін лише в межах одного календарного місяця — ділимо період по місяцях
async function fiscalWindow(ctx, F, FS, key, api, reg, from, to, onNew, timeUp) {
  for (let a = from; a <= to;) {
    const d = new Date(a + "T00:00:00Z");
    const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const b = monthEnd < to ? monthEnd : to;
    if (!(await fiscalMonth(ctx, F, FS, key, api, reg, a, b, onNew, timeUp))) return false;
    a = new Date(Date.parse(b + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);
  }
  return true;
}

async function fiscalMonth(ctx, F, FS, key, api, reg, from, to, onNew, timeUp) {
  const sh = await fiscalCmd(ctx, key, api, { Command: "Shifts", NumFiscal: reg.id, From: `${from}T00:00:00${kyivOffset(from)}`, To: `${to}T23:59:59${kyivOffset(to)}` });
  for (const s of (sh && sh.Shifts) || []) {
    if (timeUp()) return false;
    const sid = String(s.ShiftId);
    const known = FS.shifts[sid];
    if (known && known.done) continue;   // закриту й повністю завантажену зміну не перечитуємо
    FS.shifts[sid] = { id: sid, reg: reg.id, opened: s.Opened || null, closed: s.Closed || null, cashier: s.OpenName || "", z: s.ZRepFiscalNum || null, testing: !!s.Testing };
    const docs = await fiscalCmd(ctx, key, api, { Command: "Documents", NumFiscal: reg.id, ShiftId: sid, OpenShiftFiscalNum: s.OpenShiftFiscalNum != null ? String(s.OpenShiftFiscalNum) : undefined });
    let complete = true;
    for (const d of (docs && docs.Documents) || []) {
      if (d.DocClass !== "Check" || !d.NumFiscal) continue;
      const fn = String(d.NumFiscal);
      if (FS.checks[fn] && FS.checks[fn].items) { Object.assign(FS.checks[fn], { revoked: !!d.Revoked, storned: !!d.Storned }); continue; }
      if (timeUp()) { complete = false; break; }
      const c = { fn, reg: reg.id, shift: sid, local: d.NumLocal, dt: d.DocDateTime || null, type: d.CheckDocType || "", subtype: d.CheckDocSubType || "",
        revoked: !!d.Revoked, storned: !!d.Storned };
      if (/^(SaleGoods|ReturnGoods|Sale|Return)/i.test(c.type) || !c.type) {
        try {
          const r = await fiscalCmd(ctx, key, api, { Command: "CheckExt", RegistrarNumFiscal: reg.id, NumFiscal: fn, Type: 1, AcquireCabinetUrl: true });
          if (r && r.Data) Object.assign(c, parseCheckXml(Buffer.from(r.Data, "base64")) || {});
          if (r && r.CabinetUrl) c.url = r.CabinetUrl;
        } catch (e) { c.error = e.message; complete = false; }
      }
      c.items = c.items || [];
      FS.checks[fn] = c;
      onNew();
    }
    FS.shifts[sid].done = complete && !!s.Closed;
  }
  return !timeUp();
}

async function main() {
  const req = await readStdin();
  const api = req.api || {};
  const ctx = makeContext(api);
  const F = ctx.__fop;
  if (req.cmd === "sync") {
    F.load(req.state);
    const before = F.backlog();
    await F.syncAll();
    const after = F.backlog();
    // ще є що довантажувати і цей запуск просунувся — сервер одразу запустить наступну частину
    return { state: F.S, more: after > 0 && after < before };
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
  if (req.cmd === "tax-budget") {
    // стан розрахунків з бюджетом за вибраний (попередній) рік → S.tax.budgets[рік]
    F.load(req.state);
    const S = F.S, year = Number(req.year);
    S.tax = S.tax || {};
    S.tax.budgets = S.tax.budgets || {};
    try {
      const k = decrypt(req.blob, req.secret);
      const key = await openStoredKey(ctx, k.files, k.password, S.tax.cert_b64);
      const tin = (key.info.cert && key.info.cert.tin) || S.settings.owner_tax_id;
      if (!/^\d{8,10}$/.test(String(tin || ""))) throw new Error("У сертифікаті ключа немає РНОКПП — вкажіть його в Налаштуваннях");
      const auth = await key.sign(String(tin));   // підписується лише РНОКПП
      S.tax.budgets[year] = await F.fetchBudget(auth, year);
      F.log("info", `Стан розрахунків за ${year} рік завантажено з Кабінету`);
      return { state: S };
    } catch (e) {
      return { state: S, error: e.message };
    }
  }
  if (req.cmd === "fiscal") {
    F.load(req.state);
    const S = F.S;
    S.fiscal = S.fiscal || { registrars: {}, shifts: {}, checks: {} };
    const out = { state: S, more: false };
    try {
      const k = decrypt(req.blob, req.secret);
      const key = await openStoredKey(ctx, k.files, k.password, S.tax && S.tax.cert_b64);
      out.more = await fiscalSync(ctx, F, S, key, api, req);
      S.fiscal.more = out.more;
      S.fiscal.error = null;
    } catch (e) {
      S.fiscal.error = e.message;
      F.log("error", `Фіскальні чеки: ${e.message}`);
    }
    S.fiscal.fetched_at = Math.floor(Date.now() / 1000);
    return out;
  }
  throw new Error("Невідома команда");
}

// вихід — лише після того, як увесь JSON записано в stdout (інакше великий стан обрізається)
const finish = (obj, code) => process.stdout.write(JSON.stringify(obj), () => process.exit(code));
main().then((out) => finish(out, 0)).catch((e) => finish({ error: String((e && e.message) || e) }, 1));
