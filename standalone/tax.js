// ============================================================ Облікові дані з Електронного кабінету платника
// API приватної частини ЕК (https://cabinet.tax.gov.ua/help/api-registers-int.html):
//   GET https://cabinet.tax.gov.ua/ws/public_api/payer_card            — усі блоки облікових даних
//   GET https://cabinet.tax.gov.ua/ws/public_api/payer_card/{група}?page=0&size=… — блок зі списком
//   Authorization: РНОКПП, підписаний КЕП внутрішнім підписом з сертифікатом, у BASE64.
// Підпис робиться тут же, у браузері: користувач відкриває свій файловий ключ (.pfx, .jks, Key-6.dat)
// паролем, бібліотека FopKep (standalone/vendor) підписує РНОКПП за ДСТУ 4145. Ключ і пароль живуть
// лише в пам'яті вкладки — не зберігаються і нікуди не надсилаються; надсилається тільки готовий підпис.
// Кабінет не відповідає сторінкам у браузері (немає CORS), тому запити йдуть через «міст» —
// скрипт Google Apps Script користувача. Міст нічого не зберігає — підпис передається в кожному запиті.

const TAX_ALLOWED_HINT = "payer_card, payer_card/{група}";

const TAX_BRIDGE_VERSION = 2;

function taxBridgeCode(key) {
  const cmpUrls = typeof FopKep !== "undefined" ? FopKep.CMP_URLS : [];
  return `// Міст ФОП-дохід → Електронний кабінет платника (лише читання облікових даних)
// + пошук сертифіката вашого ключа на сервері надавача (CMP), як це робить сайт Кабінету
const ACCESS_KEY = ${JSON.stringify(key)};
const VERSION = ${TAX_BRIDGE_VERSION};
const BASE = 'https://cabinet.tax.gov.ua/ws/public_api/';
const ALLOWED = /^payer_card(\\/\\d{1,2})?$/;
const PARAMS = ['page', 'size'];
const CMP = ${JSON.stringify(cmpUrls)};

function doGet(e) {
  const p = (e && e.parameter) || {};
  return out_({ status: 'SUCCESS', bridge: 'ok', kind: 'tax', version: VERSION, keyOk: p.key === ACCESS_KEY });
}

function doPost(e) {
  let p;
  try { p = JSON.parse(e.postData.contents); } catch (err) { return out_({ status: 'ERROR', message: 'Некоректний запит' }); }
  if (p.key !== ACCESS_KEY) return out_({ status: 'ERROR', message: 'Невірний ключ доступу до мосту. Скопіюйте код мосту з програми ще раз.' });
  if (p.path === 'cmp') return cmp_(p);
  if (!ALLOWED.test(p.path || '')) return out_({ status: 'ERROR', message: 'Недозволений запит' });
  if (!p.auth) return out_({ status: 'ERROR', message: 'Немає підпису' });
  const q = PARAMS.filter(function (k) { return p.params && p.params[k] != null; })
    .map(function (k) { return k + '=' + encodeURIComponent(p.params[k]); }).join('&');
  let r;
  try {
    r = UrlFetchApp.fetch(BASE + p.path + (q ? '?' + q : ''), {
      method: 'get', muteHttpExceptions: true,
      headers: { 'Authorization': p.auth, 'Accept': 'application/json', 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return out_({ status: 'ERROR', stage: 'cabinet', message: 'Міст працює, але не зміг з’єднатися з Кабінетом: ' + err });
  }
  return out_({ status: 'SUCCESS', http: r.getResponseCode(), body: r.getContentText('UTF-8') });
}

// Запит сертифіката за ідентифікатором відкритого ключа — лише до серверів надавачів зі списку
function cmp_(p) {
  if (CMP.indexOf(p.url) < 0) return out_({ status: 'ERROR', message: 'Недозволена адреса' });
  try {
    const r = UrlFetchApp.fetch(p.url, { method: 'post', contentType: 'application/octet-stream',
      payload: Utilities.base64Decode(p.body || ''), muteHttpExceptions: true });
    return out_({ status: 'SUCCESS', http: r.getResponseCode(), body64: Utilities.base64Encode(r.getContent()) });
  } catch (err) {
    return out_({ status: 'SUCCESS', http: 0, body64: '', message: String(err) });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

// ---------------------------------------------------------------- ключ (лише в пам'яті)
let kepKey = null;      // відкритий ключ: { info, sign(text) }
let kepAuth = null;     // готовий підпис РНОКПП на цю сесію: { tin, b64 }
let certSearch = null;  // null | "searching" | "notfound" | "needbridge" | "oldbridge"

async function openKepFiles(files, password) {
  if (typeof FopKep === "undefined") throw new Error("Бібліотека підпису не завантажилась. Оновіть сторінку.");
  if (!files.length) throw new Error("Оберіть файл ключа (.pfx, .jks або Key-6.dat)");
  const bufs = await Promise.all([...files].map(async (f) => new Uint8Array(await f.arrayBuffer())));
  await new Promise((r) => setTimeout(r, 30)); // дати інтерфейсу показати «Відкриваю…»
  return FopKep.openKey(bufs, password);
}

function kepTin() {
  return (kepKey && kepKey.info.cert && kepKey.info.cert.tin) || $("#tax-tin").value.trim() || S.settings.owner_tax_id || "";
}

// Сертифікат ключа: спершу збережений раніше (він публічний), далі — пошук у надавача через міст
async function ensureCert() {
  if (!kepKey || kepKey.info.hasCert) return true;
  if (S.tax.cert_b64 && kepKey.addCerts([S.tax.cert_b64])) return true;
  if (!S.tax.bridge_url) { certSearch = "needbridge"; renderKeyStatus(); return false; }
  if ((S.tax.bridge_version || 1) < TAX_BRIDGE_VERSION) { certSearch = "oldbridge"; renderKeyStatus(); return false; }
  certSearch = "searching"; renderKeyStatus();
  try {
    const r = await kepKey.findCert(async (url, bodyB64) => {
      const w = await bridgePost({ path: "cmp", url, body: bodyB64 });
      return { status: w.http, bodyB64: w.body64 };
    });
    if (r.ok) {
      S.tax.cert_b64 = kepKey.info.certB64; save(true);
      certSearch = null;
      log("info", `Сертифікат ключа знайдено на ${r.url.replace(/^https?:\/\//, "").split("/")[0]}`);
    } else certSearch = "notfound";
  } catch (e) { certSearch = "notfound"; toast(e.message, true); }
  const c = kepKey.info.cert;
  if (c && c.tin) $("#tax-tin").value = c.tin;
  renderKeyStatus();
  return kepKey.info.hasCert;
}

async function getAuth() {
  if (!kepKey) {
    const err = new Error("Відкрийте ключ (крок 1) — ключ не зберігається, тому після перезавантаження сторінки його треба відкрити знову.");
    err.code = "NOKEY";
    throw err;
  }
  if (!(await ensureCert())) throw new Error("Немає сертифіката ключа — див. крок 1.");
  const tin = kepTin();
  if (!/^\d{8,10}$/.test(tin)) throw new Error("Вкажіть РНОКПП — 10 цифр (у сертифікаті ключа його не знайдено)");
  if (!kepAuth || kepAuth.tin !== tin) kepAuth = { tin, b64: await kepKey.sign(tin) };
  return kepAuth.b64;
}

// ---------------------------------------------------------------- запити через міст
async function bridgePost(payload) {
  const t = S.tax || {};
  if (!t.bridge_url) throw new Error("Спершу підключіть міст до Кабінету (крок 2)");
  let r;
  try {
    r = await fetch(t.bridge_url, {
      method: "POST", redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // без попереднього запиту CORS
      body: JSON.stringify(Object.assign({ key: t.bridge_key }, payload)),
    });
  } catch {
    const err = new Error("Програма не може прочитати відповідь мосту до Кабінету. Перевірте розгортання в Google: доступ «Усі», адреса /exec, нова версія коду.");
    err.bridgeUnreachable = true;
    throw err;
  }
  const text = await r.text();
  let w;
  try { w = JSON.parse(text); }
  catch { throw new Error(/<html/i.test(text) ? "Міст відповів сторінкою Google замість даних. У розгортанні оберіть доступ «Усі»." : "Міст повернув некоректну відповідь"); }
  if (w.status !== "SUCCESS") throw new Error(w.message || "Помилка мосту");
  if (w.bridge) throw new Error("Це адреса старого мосту або мосту ПриватБанку. Для Кабінету потрібен окремий міст з кодом із цієї вкладки.");
  return w;
}

async function taxCall(path, params, auth) {
  const w = await bridgePost({ path, params: params || {}, auth });
  let body = null;
  try { body = w.body ? JSON.parse(w.body) : null; } catch {}
  if (w.http === 401 || w.http === 403) {
    const msg = (body && (body.message || body.error_description || body.error)) || (w.body || "").slice(0, 200);
    kepAuth = null; // наступна спроба — з новим підписом
    throw new Error(`Кабінет не прийняв підпис (HTTP ${w.http})${msg ? ": " + msg : ""}. Перевірте, що ключ чинний і належить цьому РНОКПП; спробуйте ще раз.`);
  }
  if (w.http >= 400 || !body) throw new Error(`Кабінет відповів помилкою HTTP ${w.http}: ${(w.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200)}`);
  return body;
}

async function taxBridgePing(url, key) {
  let r;
  try { r = await fetch(`${url}?path=ping&key=${encodeURIComponent(key)}`, { redirect: "follow" }); }
  catch { throw new Error("Програма не може прочитати відповідь мосту. Перевірте розгортання в Google: «Хто має доступ» — «Усі», адреса закінчується на /exec."); }
  const data = await r.json().catch(() => null);
  if (!data) throw new Error("Міст відповів не тим, що очікувалось. Перевірте, що вставили код мосту саме з цієї вкладки.");
  if (data.kind !== "tax") throw new Error("Це міст для ПриватБанку або старий код. Для Кабінету створіть окремий міст з кодом із цієї вкладки.");
  if (data.keyOk === false) throw new Error("Міст відповідає, але ключ у ньому інший. Скопіюйте код мосту з програми ще раз і оновіть розгортання («Нова версія»).");
  return data.version || 1;
}

// Завантажує всі облікові дані; блоки-списки без даних догружає окремо
async function fetchPayerCard(auth) {
  const groups = await taxCall("payer_card", null, auth);
  if (!Array.isArray(groups)) throw new Error("Кабінет повернув дані в незнайомому форматі");
  for (const g of groups) {
    if (g.type === 1 || (Array.isArray(g.listValues) && g.listValues.length)) continue;
    if (g.values && Object.keys(g.values).length) continue;
    try {
      const rows = [];
      for (let page = 0; page < 20; page++) {
        const d = await taxCall(`payer_card/${g.idGroup}`, { page, size: 100 }, auth);
        const vals = Array.isArray(d.values) ? d.values : Array.isArray(d.content) ? d.content : [];
        rows.push(...vals);
        if (vals.length < 100) break;
      }
      g.listValues = rows;
    } catch (e) { g.loadError = e.message; }
  }
  return groups;
}

// ---------------------------------------------------------------- зведення
const TAX_FIELDS = {
  name: [/FULL_NAME/, /^NAME$/, /ПІБ|найменуван/i],
  tin: [/^TIN$/, /податковий номер|РНОКПП|код/i],
  address: [/ADR|ADDRESS|MISCE/i, /адрес|місцезнаход|місце прожив/i],
  sti: [/STI|DPI|NAME_STI/i, /орган ДПС|податков.*орган|ДПІ|контролюючого орган/i],
};

// Шукає значення в блоці за назвою поля (ключ або підпис у headers)
function groupValue(g, patterns) {
  if (!g || !g.values || Array.isArray(g.values)) return null;
  for (const re of patterns) {
    for (const [k, v] of Object.entries(g.values)) {
      if (v == null || v === "") continue;
      if (re.test(k) || re.test((g.headers || {})[k] || "")) return v;
    }
  }
  return null;
}

function taxGroups() { return (S.tax && S.tax.card) || []; }
const taxGroup = (id) => taxGroups().find((g) => g.idGroup === id);

function groupRows(g) {
  if (!g) return [];
  if (Array.isArray(g.listValues)) return g.listValues;
  if (Array.isArray(g.values)) return g.values;
  return [];
}

function taxSummary() {
  const g1 = taxGroup(1), g2 = taxGroup(2), g6 = taxGroup(6), g7 = taxGroup(7), g5 = taxGroup(5), g16 = taxGroup(16);
  const any = (pats) => groupValue(g1, pats) ?? groupValue(g2, pats);
  const ep = [];
  const epSrc = g6 && (g6.values && !Array.isArray(g6.values) ? [g6.values] : groupRows(g6));
  for (const row of epSrc || []) {
    const parts = Object.entries(row).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${(g6.headers || {})[k] || k}: ${v}`);
    if (parts.length) ep.push(parts.join(" · "));
  }
  const kved = groupRows(g16).map((r) => {
    const vals = Object.entries(r).filter(([, v]) => v != null && v !== "");
    const code = (vals.find(([k, v]) => /KVED|KOD|CODE/i.test(k) || /^\d{2}\.\d{2}$/.test(String(v))) || [])[1];
    const name = (vals.find(([k]) => /NAME|NAZ/i.test(k)) || [])[1];
    const main = vals.some(([k, v]) => /MAIN|OSN|IS_?BASIC|PRIZN/i.test(k) && (v === 1 || v === true || /^(1|так|основн)/i.test(String(v))));
    return { code, name, main, raw: vals };
  });
  return {
    name: any(TAX_FIELDS.name), tin: any(TAX_FIELDS.tin), address: any(TAX_FIELDS.address), sti: any(TAX_FIELDS.sti),
    ep, kved, vat: g5 && (groupValue(g5, [/.*/]) != null || groupRows(g5).length) ? true : null, esv: g7,
  };
}

// ---------------------------------------------------------------- вкладка
function fmtTaxValue(v) {
  if (v == null || v === "") return "";
  if (typeof v === "boolean") return v ? "так" : "ні";
  return String(v);
}

function renderGroup(g) {
  const headers = g.headers || {};
  let body = "";
  if (g.values && !Array.isArray(g.values) && Object.keys(g.values).length) {
    const rows = Object.entries(g.values).filter(([, v]) => v != null && v !== "");
    body += rows.length ? `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(headers[k] || k)}</dt><dd>${esc(fmtTaxValue(v))}</dd>`).join("")}</dl>` : "";
  }
  const list = groupRows(g);
  if (list.length) {
    const cols = [...new Set([...Object.keys(headers).filter((k) => list.some((r) => r[k] != null && r[k] !== "")), ...list.flatMap((r) => Object.keys(r))])]
      .filter((k) => list.some((r) => r[k] != null && r[k] !== ""));
    body += `<div class="table-wrap"><table class="table kv-table"><thead><tr>${cols.map((k) => `<th>${esc(headers[k] || k)}</th>`).join("")}</tr></thead>
      <tbody>${list.map((r) => `<tr>${cols.map((k) => `<td data-label="${esc(headers[k] || k)}">${esc(fmtTaxValue(r[k]))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  if (g.loadError) body += `<p class="error small">Не вдалося завантажити: ${esc(g.loadError)}</p>`;
  return `<details class="card tax-group" ${body ? "" : "data-empty"}>
    <summary><span>${esc(g.title || "Блок " + g.idGroup)}</span><span class="muted small">${body ? (list.length ? `записів: ${list.length}` : "") : "немає даних"}</span></summary>
    ${body || `<p class="muted small">У Кабінеті немає даних цього блоку.</p>`}</details>`;
}

function loadAccount() {
  const t = S.tax || {};
  const hasCard = taxGroups().length > 0;
  // крок 1-2: підпис і міст
  // кроки підключення згортаються, коли все працює; при помилці (напр. підпис застарів) — розгортаються
  $("#tax-setup").classList.toggle("collapsed", !!(hasCard && kepKey && t.bridge_url && !t.last_error));
  $("#tax-tin").value = $("#tax-tin").value || S.settings.owner_tax_id || "";
  renderKeyStatus();
  $("#tax-bridge-status").innerHTML = t.bridge_url ? `✓ Міст підключено` : "Міст ще не підключено";
  if (!t.pending_key) { t.pending_key = randomKey(); S.tax = t; save(); }
  $("#tax-bridge-code").value = taxBridgeCode(t.bridge_key || t.pending_key);
  $("#tax-bridge-url").value = t.bridge_url || "";
  $("#btn-tax-load").disabled = false;
  $("#tax-meta").textContent = t.fetched_at ? `Оновлено з Кабінету ${new Date(t.fetched_at * 1000).toLocaleString("uk-UA")}` : "";
  $("#tax-error").hidden = !t.last_error;
  $("#tax-error").textContent = t.last_error || "";

  if (!hasCard) { $("#tax-summary").innerHTML = ""; $("#tax-groups").innerHTML = ""; return; }
  const s = taxSummary();
  const kv = [["Назва ФОП", s.name], ["Код (РНОКПП)", s.tin], ["Адреса", s.address], ["Податкова", s.sti]].filter(([, v]) => v);
  const mainK = s.kved.filter((k) => k.main), otherK = s.kved.filter((k) => !k.main);
  $("#tax-summary").innerHTML = `
    <div class="card tax-main">
      <dl class="kv kv-main">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(fmtTaxValue(v))}</dd>`).join("")}</dl>
      ${s.ep.length ? `<h4>Платник єдиного податку</h4><ul class="plain">${s.ep.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted small">Даних про реєстрацію платником єдиного податку немає.</p>`}
      ${s.kved.length ? `<h4>КВЕД</h4><ul class="plain kved">${[...mainK, ...otherK].map((k) => `<li>${k.main ? "<b>" : ""}${esc(k.code || "")} ${esc(k.name || k.raw.map(([, v]) => v).join(" · "))}${k.main ? "</b> <span class=\"muted small\">основний</span>" : ""}</li>`).join("")}</ul>` : ""}
    </div>`;
  $("#tax-groups").innerHTML = taxGroups().map(renderGroup).join("");
}

function renderKeyStatus() {
  const box = $("#tax-key-status");
  if (!kepKey) { box.className = "small muted"; box.textContent = "Ключ не відкрито. Він не зберігається: після перезавантаження сторінки відкрийте його знову."; return; }
  const c = kepKey.info.cert;
  if (!c) {
    const msg = {
      searching: ["small muted", "✓ Ключ відкрито. Шукаю сертифікат ключа на сервері надавача…"],
      needbridge: ["small muted", "✓ Ключ відкрито. Сертифіката у файлі немає — це звично: програма знайде його на сервері надавача (як сайт Кабінету), щойно ви підключите міст (крок 2)."],
      oldbridge: ["small warn", "✓ Ключ відкрито. Щоб програма знайшла сертифікат, оновіть код мосту: скопіюйте новий код (крок 2), вставте в редактор скрипта і «Керувати розгортаннями» → ✎ → «Версія»: «Нова версія» → «Розгорнути». Потім натисніть «Підключити міст»."],
      notfound: ["small warn", "Ключ відкрито, але сертифікат не знайдено на серверах надавачів. Додайте файл сертифіката (.cer) разом із ключем — його можна завантажити на сайті вашого надавача."],
    }[certSearch] || ["small muted", "✓ Ключ відкрито."];
    box.className = msg[0]; box.textContent = msg[1]; return;
  }
  const expired = c.validTo && Date.parse(c.validTo) < Date.now();
  box.className = "small " + (expired ? "warn" : "ok");
  box.innerHTML = `${expired ? "⚠ Сертифікат протермінований" : "✓ Ключ відкрито"}: <b>${esc(c.name || c.org || "—")}</b>`
    + (c.tin ? `, РНОКПП ${esc(c.tin)}` : "") + (c.issuer ? `<br><span class="muted">${esc(c.issuer)}</span>` : "")
    + (c.validTo ? `<span class="muted"> · діє до ${new Date(c.validTo).toLocaleDateString("uk-UA")}</span>` : "");
}

async function refreshPayerCard() {
  const btn = $("#btn-tax-load");
  if (!S.tax.bridge_url || !kepKey) {
    $("#tax-setup").classList.remove("collapsed");
    const target = !kepKey ? "#tax-key-files" : "#tax-bridge-url";
    $(target).scrollIntoView({ behavior: "smooth", block: "center" });
    return toast(!kepKey ? "Спершу відкрийте ключ (крок 1)" : "Спершу підключіть міст (крок 2)", true);
  }
  btn.disabled = true; btn.textContent = "Підписую й завантажую…";
  try {
    const card = await fetchPayerCard(await getAuth());
    S.tax.card = card;
    S.tax.fetched_at = nowTs();
    S.tax.last_error = null;
    // ПІБ і РНОКПП потрібні, щоб не рахувати доходом власні перекази
    const s = taxSummary();
    const filled = [];
    if (!S.settings.owner_tax_id && s.tin && /^\d{10}$/.test(String(s.tin))) { S.settings.owner_tax_id = String(s.tin); filled.push("РНОКПП"); }
    if (!S.settings.owner_name && s.name) { S.settings.owner_name = String(s.name).replace(/^ФОП\s+/i, ""); filled.push("ПІБ"); }
    if (filled.length) reclassifyAll();
    log("info", `Облікові дані з Кабінету оновлено, блоків: ${card.length}`);
    save(true);
    toast("Облікові дані завантажено" + (filled.length ? `. У Налаштуваннях заповнено: ${filled.join(", ")}` : ""));
  } catch (e) {
    S.tax.last_error = e.message; save();
    toast(e.message, true);
  }
  btn.textContent = "Оновити з Кабінету";
  loadAccount();
}

function initTaxTab() {
  if (!S.tax) S.tax = {};
  // старий спосіб (завантажений .p7s) більше не використовується — не тримаємо підпис у сховищі
  if (S.tax.auth) { for (const k of ["auth", "auth_name", "auth_tin", "auth_added_at"]) delete S.tax[k]; save(); }
  $("#form-tax-key").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", e.target), pw = $("#tax-key-password");
    btn.disabled = true; btn.textContent = "Відкриваю ключ…";
    try {
      kepKey = await openKepFiles($("#tax-key-files").files, pw.value);
      kepAuth = null; certSearch = null;
      pw.value = "";
      toast("Ключ відкрито");
      await ensureCert();
      const c = kepKey.info.cert;
      if (c && c.tin) $("#tax-tin").value = c.tin;
      renderKeyStatus();
      if (c && S.tax.bridge_url) refreshPayerCard();
    } catch (err) { kepKey = null; renderKeyStatus(); toast(err.message, true); }
    btn.disabled = false; btn.textContent = "Відкрити ключ";
  });
  $("#btn-tax-close-key").addEventListener("click", () => { kepKey = null; kepAuth = null; certSearch = null; $("#tax-key-files").value = ""; renderKeyStatus(); toast("Ключ закрито"); });
  $("#btn-tax-copy").addEventListener("click", async () => {
    const box = $("#tax-bridge-code");
    try { await navigator.clipboard.writeText(box.value); toast("Код скопійовано"); }
    catch { box.focus(); box.select(); toast("Натисніть Cmd+C, щоб скопіювати виділений код"); }
  });
  $("#form-tax-bridge").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { url, error } = cleanBridgeUrl($("#tax-bridge-url").value);
    if (error) return toast(error, true);
    const key = S.tax.bridge_key || S.tax.pending_key;
    const btn = $("button[type=submit]", e.target);
    btn.disabled = true; btn.textContent = "Перевіряю міст…";
    try {
      const version = await taxBridgePing(url, key);
      Object.assign(S.tax, { bridge_url: url, bridge_key: key, bridge_version: version, last_error: null });
      save(true);
      toast(version < TAX_BRIDGE_VERSION ? "Міст підключено, але код застарів — оновіть його (див. крок 1)" : "Міст до Кабінету підключено");
      loadAccount();
      if (kepKey && (await ensureCert())) refreshPayerCard();
    } catch (err) { S.tax.last_error = err.message; save(); loadAccount(); toast(err.message, true); }
    btn.disabled = false; btn.textContent = "Підключити міст";
  });
  $("#btn-tax-load").addEventListener("click", refreshPayerCard);
  $("#btn-tax-setup").addEventListener("click", () => $("#tax-setup").classList.toggle("collapsed"));
  $("#btn-tax-forget").addEventListener("click", () => {
    if (!confirm("Видалити з програми облікові дані й налаштування мосту? Міст у Google залишиться — його можна видалити на script.google.com.")) return;
    kepKey = null; kepAuth = null;
    S.tax = { pending_key: randomKey() }; save(true); loadAccount(); toast("Облікові дані видалено");
  });
}
