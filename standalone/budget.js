// ============================================================ Податки: стан розрахунків з бюджетом (Електронний кабінет)
// API приватної частини ЕК (https://cabinet.tax.gov.ua/help/api-registers-int.html):
//   GET ta/splatp?year=РРРР                         — по кожному платежу: нараховано, сплачено, недоїмка, реквізити
//   GET ta/splatp/{рік}/{код ДПС}/{ID рахунку}/pa?page=N — операції по особовому рахунку
// Запити йдуть тим самим шляхом, що й облікові дані (міст або сервер), з підписаним РНОКПП.
// Реквізити й QR — за Правилами НБУ для QR-кодів кредитових переказів (формат 002, посилання https://bank.gov.ua/qr/…).

// ---------------------------------------------------------------- завантаження
async function fetchBudget(auth, year) {
  const items = await taxCall("ta/splatp", { year }, auth);
  if (!Array.isArray(items)) throw new Error("Кабінет повернув стан розрахунків у незнайомому форматі");
  for (const it of items) {
    it.ops = [];
    if (!it.idpmnt || it.cSti == null) continue;
    try {
      for (let page = 0; page < 30; page++) {
        const d = await taxCall(`ta/splatp/${year}/${it.cSti}/${it.idpmnt}/pa`, { page }, auth);
        const rows = Array.isArray(d && d.content) ? d.content : Array.isArray(d) ? d : [];
        it.ops.push(...rows);
        if (!rows.length || (d && (d.last === true || (d.totalPages != null && page + 1 >= d.totalPages)))) break;
      }
    } catch (e) { it.opsError = e.message; }
  }
  return { year, fetched_at: nowTs(), items, error: null };
}

// ---------------------------------------------------------------- класифікація платежів
const KBK_NAMES = {
  "18050400": "Єдиний податок", "11011000": "Військовий збір", "71040000": "ЄСВ",
  "11010100": "ПДФО", "11010400": "ПДФО", "11010500": "ПДФО (декларація)", "11011600": "Військовий збір",
};
// порядок: спершу податки ФОП, потім податки з найманих працівників, далі решта — за активністю
const KBK_ORDER = ["18050400", "11011000", "11011600", "71040000", "11010100", "11010400", "11010500"];

const kbkOf = (it) => (String(it.plat1 || "").replace(/\s+/g, " ").match(/\b(\d{8})\b/) || [])[1] || "";
const num = (v) => (v == null || v === "" ? 0 : Number(String(v).replace(",", ".")) || 0);
const opRows = (it) => (it.ops || []).filter((o) => o && o.dateoper && String(o.vidpa || "").trim() !== "Всього");

function budgetTabs() {
  const b = S.tax && S.tax.budget;
  if (!b || !Array.isArray(b.items)) return [];
  const items = b.items.filter((it) => num(it.narah0) || num(it.splbd0) || num(it.nedoim0) || num(it.perepl0) || opRows(it).length);
  const rank = (it) => { const i = KBK_ORDER.indexOf(kbkOf(it)); return i < 0 ? 100 : i; };
  const activity = (it) => opRows(it).length * 1e9 + Math.abs(num(it.splbd0)) + Math.abs(num(it.narah0));
  const tabs = items.slice().sort((a, c) => rank(a) - rank(c) || activity(c) - activity(a));
  const seen = {};
  return tabs.map((it) => {
    const base = KBK_NAMES[kbkOf(it)] || String(it.namePlt || "Платіж").replace(/\s+/g, " ").trim();
    seen[base] = (seen[base] || 0) + 1;
    return { it, name: base, key: String(it.idpmnt || base) };
  }).map((t, _, all) => (all.filter((x) => x.name === t.name).length > 1 ? { ...t, name: `${t.name} · ${String(t.it.nameSti || t.it.cSti || "").split(/[ (]/)[0] || t.key.slice(-4)}` } : t));
}

// ---------------------------------------------------------------- QR НБУ
// Windows-1251 для кирилиці (у форматі 002 кодування «2»)
const CP1251 = (() => {
  const m = { "Ё": 0xa8, "ё": 0xb8, "Є": 0xaa, "є": 0xba, "І": 0xb2, "і": 0xb3, "Ї": 0xaf, "ї": 0xbf, "Ґ": 0xa5, "ґ": 0xb4,
    "№": 0xb9, "«": 0xab, "»": 0xbb, "–": 0x96, "—": 0x97, "’": 0x92, "‘": 0x91, "“": 0x93, "”": 0x94, " ": 0xa0 };
  for (let c = 0x410; c <= 0x44f; c++) m[String.fromCharCode(c)] = c - 0x410 + 0xc0;
  return m;
})();
function toCp1251(s) {
  const out = [];
  for (const ch of String(s)) {
    const c = ch.charCodeAt(0);
    out.push(c < 0x80 ? c : CP1251[ch] != null ? CP1251[ch] : 0x3f);
  }
  return out;
}
const b64url = (bytes) => btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function paymentDetails(it, amount) {
  const tin = (S.settings.owner_tax_id || "").trim();
  const kbk = kbkOf(it);
  const name = KBK_NAMES[kbk] || String(it.namePlt || "").trim();
  const debt = num(it.nedoim0) > 0;
  return {
    recipient: String(it.budgetPayerName || "").trim(),
    code: String(it.budgetTin || "").padStart(8, "0"),
    iban: String(it.budgetAccountIban || "").trim(),
    bank: String(it.budgetBankName || "").trim(),
    kbk,
    // структуроване призначення для податків: *;код виду сплати;код платника;опис;;;  (101 — сплата, 140 — погашення боргу)
    purpose: `*;${debt ? 140 : 101};${tin};${debt ? "Погашення заборгованості: " : ""}${name}${kbk ? " (" + kbk + ")" : ""};;;`.slice(0, 140),
    amount: amount > 0 ? Math.round(amount * 100) / 100 : null,
  };
}

function nbuQrLink(d) {
  const lines = ["BCD", "002", "2", "UCT", "", d.recipient, d.iban, d.amount ? "UAH" + d.amount.toFixed(2) : "", d.code, "", "", d.purpose, ""];
  return "https://bank.gov.ua/qr/" + b64url(toCp1251(lines.join("\n")));
}

function qrSvg(text) {
  if (typeof qrcode === "undefined") return "";
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// ---------------------------------------------------------------- вкладка
let taxesActive = null;

function loadTaxes() {
  const b = S.tax && S.tax.budget;
  const tabs = budgetTabs();
  const year = (b && b.year) || new Date().getFullYear();
  $("#taxes-meta").textContent = b && b.fetched_at ? `${year} рік · оновлено з Кабінету ${new Date(b.fetched_at * 1000).toLocaleString("uk-UA")}` : "";
  $("#taxes-error").hidden = !(b && b.error);
  $("#taxes-error").textContent = (b && b.error) || "";
  if (!tabs.length) {
    $("#taxes-tabs").innerHTML = "";
    $("#taxes-body").innerHTML = `<div class="card hint"><b>${b ? "У Кабінеті немає розрахунків за " + year + " рік." : "Даних ще немає."}</b>
      ${b ? "" : "Натисніть «Оновити з Кабінету». Потрібен ключ КЕП — на вкладці «Облікові дані» його можна зчитати або зберегти на сервері."}</div>`;
    return;
  }
  if (!tabs.some((t) => t.key === taxesActive)) taxesActive = tabs[0].key;
  $("#taxes-tabs").innerHTML = tabs.map((t) => {
    const debt = num(t.it.nedoim0) > 0;
    return `<button type="button" data-key="${esc(t.key)}" class="${t.key === taxesActive ? "active" : ""}">${esc(t.name)}${debt ? ' <span class="badge danger-badge" title="Є борг">!</span>' : ""}</button>`;
  }).join("");
  const t = tabs.find((x) => x.key === taxesActive), it = t.it, n = t.name;
  const debt = num(it.nedoim0), over = num(it.perepl0), penalty = num(it.sldpn0) || num(it.penia0);
  const ops = opRows(it).slice().sort((a, c) => parseDdmm(c.dateoper) - parseDdmm(a.dateoper));
  $("#taxes-body").innerHTML = `
    <div class="kpis kpis-3">
      <div class="kpi"><div class="label">Сплачено «${esc(n)}»</div><div class="value">${money(num(it.splbd0))}</div>${num(it.povbd0) ? `<div class="sub">повернуто з бюджету: ${money(num(it.povbd0))}</div>` : ""}</div>
      <div class="kpi"><div class="label">Списано «${esc(n)}»</div><div class="value">${money(num(it.narah0))}</div><div class="sub">нараховано до сплати</div></div>
      <div class="kpi ${debt > 0 ? "kpi-bad" : "kpi-good"}"><div class="label">Борг по «${esc(n)}»</div><div class="value">${money(Math.max(debt, 0))}</div>
        <div class="sub">${over > 0 ? `переплата: ${money(over)}` : debt > 0 ? "є заборгованість" : "заборгованості немає"}${penalty ? ` · пеня: ${money(penalty)}` : ""}</div></div>
    </div>
    <div class="conn-actions taxes-actions">
      <button class="btn" type="button" id="btn-tax-req">Реквізити</button>
      <a class="btn primary" id="btn-tax-pay" href="${esc(nbuQrLink(paymentDetails(it, debt > 0 ? debt : 0)))}" target="_blank" rel="noopener">Сплатити</a>
      <span class="muted small">${esc(it.nameSti || "")}</span>
    </div>
    <div class="card flush"><div class="table-wrap"><table class="table budget-table">
      <thead><tr><th>Дата</th><th>Операція</th><th class="num">Списано</th><th class="num">Сплачено / повернуто</th></tr></thead>
      <tbody>${ops.map((o) => `<tr><td class="td-date">${esc(o.dateoper)}</td>
        <td><div>${esc(o.namevid || o.vidpa || "")}</div>${o.templ && o.templ.trim() ? `<div class="muted small">${esc(o.templ.trim())}</div>` : ""}</td>
        <td class="num" data-label="Списано">${num(o.narah0) ? money(num(o.narah0)) : ""}</td>
        <td class="num" data-label="Сплачено / повернуто">${num(o.splpov0) ? `<span class="pos">${money(num(o.splpov0))}</span>` : ""}</td></tr>`).join("")
        || `<tr><td colspan="4" class="muted">${it.opsError ? "Не вдалося завантажити операції: " + esc(it.opsError) : "Операцій за рік немає"}</td></tr>`}</tbody></table></div></div>
    <details class="card raw-data"><summary>Дані з Кабінету як є (для перевірки)</summary>
      <p class="muted small">Відповідь API «Стан розрахунків з бюджетом» по цьому платежу: спершу підсумок (ta/splatp), далі операції (…/pa).</p>
      <div class="conn-actions"><button class="btn small" type="button" id="btn-raw-copy">Скопіювати</button><button class="btn small" type="button" id="btn-raw-all">Завантажити все (JSON)</button></div>
      <pre id="raw-json">${esc(JSON.stringify(rawOf(it), null, 2))}</pre></details>`;
}

// підсумок і операції так, як їх повернув Кабінет (без службових полів програми)
function rawOf(it) {
  const { ops, opsError, ...summary } = it;
  return { "ta/splatp": summary, "pa (операції)": ops || [] };
}

function parseDdmm(s) {
  const m = String(s || "").match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : 0;
}

function openRequisites() {
  const t = budgetTabs().find((x) => x.key === taxesActive);
  if (!t) return;
  const debt = num(t.it.nedoim0);
  const dlg = $("#tax-req-dialog");
  const render = () => {
    const amount = parseNum($("#req-amount").value);
    const d = paymentDetails(t.it, amount);
    const link = nbuQrLink(d);
    $("#req-fields").innerHTML = [["Отримувач", d.recipient], ["Код отримувача (ЄДРПОУ)", d.code], ["Рахунок (IBAN)", d.iban], ["Банк", d.bank],
      ["Код класифікації доходів бюджету", d.kbk], ["Призначення платежу", d.purpose]]
      .map(([k, v]) => `<dt>${k}</dt><dd><span>${esc(v || "—")}</span>${v ? `<button type="button" class="copy-btn" title="Копіювати" aria-label="Копіювати: ${esc(k)}" data-copy="${esc(v)}">⧉</button>` : ""}</dd>`).join("");
    $("#req-qr").innerHTML = qrSvg(link);
    $("#req-pay").href = link;
  };
  $("#req-title").textContent = `Реквізити: ${t.name}`;
  $("#req-amount").value = debt > 0 ? debt.toFixed(2).replace(".", ",") : "";
  $("#req-amount").oninput = render;
  render();
  dlg.showModal ? dlg.showModal() : dlg.setAttribute("open", "");
}

function initTaxesTab() {
  $("#taxes-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]");
    if (b) { taxesActive = b.dataset.key; loadTaxes(); }
  });
  $("#taxes-body").addEventListener("click", async (e) => {
    if (e.target.id === "btn-tax-req") openRequisites();
    if (e.target.id === "btn-raw-copy") {
      try { await navigator.clipboard.writeText($("#raw-json").textContent); toast("Скопійовано"); } catch { toast("Не вдалося скопіювати", true); }
    }
    if (e.target.id === "btn-raw-all") {
      const b = S.tax.budget || {};
      download(`stan-rozrakhunkiv_${b.year || ""}.json`, JSON.stringify((b.items || []).map(rawOf), null, 2), "application/json");
    }
  });
  $("#btn-taxes-refresh").addEventListener("click", () => refreshPayerCard());
  $("#tax-req-dialog").addEventListener("click", async (e) => {
    if (e.target.dataset.copy) {
      try { await navigator.clipboard.writeText(e.target.dataset.copy); toast("Скопійовано"); } catch { toast("Не вдалося скопіювати", true); }
    }
    if (e.target.id === "req-close" || e.target === e.currentTarget) e.currentTarget.close ? e.currentTarget.close() : e.currentTarget.removeAttribute("open");
  });
}
