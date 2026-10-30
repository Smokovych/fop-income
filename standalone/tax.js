// ============================================================ Облікові дані з Електронного кабінету платника
// API приватної частини ЕК (https://cabinet.tax.gov.ua/help/api-registers-int.html):
//   GET https://cabinet.tax.gov.ua/ws/public_api/payer_card            — усі блоки облікових даних
//   GET https://cabinet.tax.gov.ua/ws/public_api/payer_card/{група}?page=0&size=… — блок зі списком
//   Authorization: РНОКПП, підписаний КЕП внутрішнім підписом з сертифікатом, у BASE64.
// Кабінет не відповідає сторінкам у браузері (немає CORS), тому запити йдуть через «міст» —
// скрипт Google Apps Script користувача. Підпис (.p7s) користувач робить сам на czo.gov.ua і
// завантажує в програму: пароль від ключа програма не бачить. Міст секретів не зберігає —
// підпис передається в кожному запиті.

const TAX_ALLOWED_HINT = "payer_card, payer_card/{група}";

function taxBridgeCode(key) {
  return `// Міст ФОП-дохід → Електронний кабінет платника (лише читання облікових даних)
const ACCESS_KEY = ${JSON.stringify(key)};
const BASE = 'https://cabinet.tax.gov.ua/ws/public_api/';
const ALLOWED = /^payer_card(\\/\\d{1,2})?$/;
const PARAMS = ['page', 'size'];

function doGet(e) {
  const p = (e && e.parameter) || {};
  return out_({ status: 'SUCCESS', bridge: 'ok', kind: 'tax', version: 1, keyOk: p.key === ACCESS_KEY });
}

function doPost(e) {
  let p;
  try { p = JSON.parse(e.postData.contents); } catch (err) { return out_({ status: 'ERROR', message: 'Некоректний запит' }); }
  if (p.key !== ACCESS_KEY) return out_({ status: 'ERROR', message: 'Невірний ключ доступу до мосту. Скопіюйте код мосту з програми ще раз.' });
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

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

// ---------------------------------------------------------------- підпис
// Приймає .p7s (двійковий DER), base64 або PEM. Повертає { auth, tin } або кидає помилку.
async function readSignatureFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!buf.length) throw new Error("Файл порожній");
  let b64;
  if (buf[0] === 0x30) {
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    b64 = btoa(s);
  } else {
    const text = new TextDecoder().decode(buf).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]+=*$/.test(text) || text.length < 200) throw new Error("Це не схоже на файл підпису. Потрібен файл .p7s, отриманий на czo.gov.ua («дані та підпис в одному файлі»).");
    b64 = text;
  }
  const der = atob(b64);
  if (der.charCodeAt(0) !== 0x30) throw new Error("Файл підпису пошкоджений");
  // РНОКПП — і в підписаних даних, і в сертифікаті (TINUA-…)
  const m = der.match(/TINUA-(\d{10})/) || der.match(/(?:^|[^\d])(\d{10})(?!\d)/);
  return { auth: b64, tin: m ? m[1] : null, size: der.length };
}

// ---------------------------------------------------------------- запити через міст
async function taxCall(path, params) {
  const t = S.tax || {};
  if (!t.bridge_url) throw new Error("Спершу підключіть міст до Кабінету");
  if (!t.auth) throw new Error("Спершу завантажте підписаний файл");
  let r;
  try {
    r = await fetch(t.bridge_url, {
      method: "POST", redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // без попереднього запиту CORS
      body: JSON.stringify({ key: t.bridge_key, path, params: params || {}, auth: t.auth }),
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
  let body = null;
  try { body = w.body ? JSON.parse(w.body) : null; } catch {}
  if (w.http === 401 || w.http === 403) {
    const msg = (body && (body.message || body.error_description || body.error)) || (w.body || "").slice(0, 200);
    throw new Error(`Кабінет не прийняв підпис (HTTP ${w.http})${msg ? ": " + msg : ""}. Можливо, підпис застарів або підписано не той текст — підпишіть файл з РНОКПП ще раз.`);
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
}

// Завантажує всі облікові дані; блоки-списки без даних догружає окремо
async function fetchPayerCard() {
  const groups = await taxCall("payer_card");
  if (!Array.isArray(groups)) throw new Error("Кабінет повернув дані в незнайомому форматі");
  for (const g of groups) {
    if (g.type === 1 || (Array.isArray(g.listValues) && g.listValues.length)) continue;
    if (g.values && Object.keys(g.values).length) continue;
    try {
      const rows = [];
      for (let page = 0; page < 20; page++) {
        const d = await taxCall(`payer_card/${g.idGroup}`, { page, size: 100 });
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
  $("#tax-setup").classList.toggle("collapsed", !!(hasCard && t.auth && t.bridge_url && !t.last_error));
  $("#tax-tin").value = $("#tax-tin").value || S.settings.owner_tax_id || "";
  $("#tax-sign-status").innerHTML = t.auth
    ? `✓ Підпис завантажено${t.auth_name ? ` (${esc(t.auth_name)})` : ""}${t.auth_tin ? `, РНОКПП ${esc(t.auth_tin)}` : ""}, ${new Date(t.auth_added_at * 1000).toLocaleDateString("uk-UA")}`
    : "Підпис ще не завантажено";
  $("#tax-bridge-status").innerHTML = t.bridge_url ? `✓ Міст підключено` : "Міст ще не підключено";
  if (!t.pending_key) { t.pending_key = randomKey(); S.tax = t; save(); }
  $("#tax-bridge-code").value = taxBridgeCode(t.bridge_key || t.pending_key);
  $("#tax-bridge-url").value = t.bridge_url || "";
  $("#btn-tax-load").disabled = !(t.auth && t.bridge_url);
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

async function refreshPayerCard() {
  const btn = $("#btn-tax-load");
  btn.disabled = true; btn.textContent = "Завантажую з Кабінету…";
  try {
    const card = await fetchPayerCard();
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
  $("#btn-tax-txt").addEventListener("click", () => {
    const tin = $("#tax-tin").value.trim();
    if (!/^\d{10}$/.test(tin)) return toast("Вкажіть РНОКПП — 10 цифр", true);
    download(`rnokpp-${tin}.txt`, tin, "text/plain");
  });
  $("#tax-sign-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const sig = await readSignatureFile(file);
      const expected = $("#tax-tin").value.trim() || S.settings.owner_tax_id;
      Object.assign(S.tax, { auth: sig.auth, auth_name: file.name, auth_tin: sig.tin, auth_added_at: nowTs(), last_error: null });
      save(true);
      toast(sig.tin && expected && sig.tin !== expected ? `Увага: у підписі РНОКПП ${sig.tin}, а вказано ${expected}` : "Підпис завантажено");
      loadAccount();
      if (S.tax.bridge_url) refreshPayerCard();
    } catch (err) { toast(err.message, true); }
    e.target.value = "";
  });
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
      await taxBridgePing(url, key);
      Object.assign(S.tax, { bridge_url: url, bridge_key: key, last_error: null });
      save(true);
      toast("Міст до Кабінету підключено");
      loadAccount();
      if (S.tax.auth) refreshPayerCard();
    } catch (err) { S.tax.last_error = err.message; save(); loadAccount(); toast(err.message, true); }
    btn.disabled = false; btn.textContent = "Підключити міст";
  });
  $("#btn-tax-load").addEventListener("click", refreshPayerCard);
  $("#btn-tax-setup").addEventListener("click", () => $("#tax-setup").classList.toggle("collapsed"));
  $("#btn-tax-forget").addEventListener("click", () => {
    if (!confirm("Видалити з програми підпис і облікові дані? Міст у Google залишиться — його можна видалити на script.google.com.")) return;
    S.tax = { pending_key: randomKey() }; save(true); loadAccount(); toast("Підпис і облікові дані видалено");
  });
}
