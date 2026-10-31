"use strict";
/* ФОП-дохід — ядро: утиліти, параметри, сховище, класифікація, курси НБУ, синхронізація Monobank.
   Без звернень до сторінки на верхньому рівні — той самий код виконується і в браузері, і на сервері
   (app/node/worker.js — фонове оновлення виписок). Інтерфейс — у app.js.

   ФОП-дохід — версія, що працює повністю в браузері.
   Monobank і курси НБУ — напряму через їхні API; ПриватБанк — через міст або сервер; інші — імпорт файлу виписки.
   Локально дані зберігаються в localStorage цього браузера, на сервері — на сервері (див. remote.js). */

// ============================================================ утиліти
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
const money = (v) => nf.format(v || 0) + " ₴";
const moneyShort = (v) => Math.abs(v) >= 1e6 ? nf.format(v / 1e6) + " млн" : Math.abs(v) >= 1e3 ? nf0.format(v / 1e3) + " тис" : nf0.format(v);
const fmtDate = (iso) => iso ? iso.split("-").reverse().join(".") : "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowTs = () => Math.floor(Date.now() / 1000);
const MONTHS = ["Січ", "Лют", "Бер", "Кві", "Тра", "Чер", "Лип", "Сер", "Вер", "Жов", "Лис", "Гру"];
const CUR = { UAH: "₴", USD: "$", EUR: "€", GBP: "£", PLN: "zł" };
const ISO_NUM = { 980: "UAH", 840: "USD", 978: "EUR", 826: "GBP", 985: "PLN", 756: "CHF", 203: "CZK" };

// Адреси API (можна підмінити для тестів через localStorage "fopIncome.api")
const API = Object.assign({
  mono: "https://api.monobank.ua",
  nbu: "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange",
  monoInterval: 61000,
}, SERVER_MODE ? { mono: "/proxy/mono", nbu: "/proxy/nbu" } : {}, (() => { try { return JSON.parse(localStorage.getItem("fopIncome.api") || "{}"); } catch { return {}; } })());

const KYIV_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" });
const kyivDate = (ts) => KYIV_FMT.format(new Date(ts * 1000)); // YYYY-MM-DD
function kyivMidnight(iso) {
  // unix-час початку доби iso за Києвом
  const [y, m, d] = iso.split("-").map(Number);
  let guess = Date.UTC(y, m - 1, d) / 1000 - 2 * 3600;
  for (const off of [2, 3]) {
    const t = Date.UTC(y, m - 1, d) / 1000 - off * 3600;
    if (kyivDate(t) === iso && kyivDate(t - 1) !== iso) return t;
  }
  return guess;
}

// Числа й дати з банківських даних (потрібні і виписці ПриватБанку, і імпорту файлів)
function parseNum(v) {
  if (typeof v === "number") return v;
  const s = String(v ?? "").replace(/[\s ]/g, "").replace(/[^\d,.\-−]/g, "").replace("−", "-");
  if (!s) return 0;
  const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
  const t = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  return Number(t) || 0;
}

function parseDateTime(dv, tv) {
  let y, m, d, hh = 12, mi = 0, ss = 0;
  if (typeof dv === "number") { // серійна дата Excel
    const ms = Math.round((dv - 25569) * 86400000);
    const dt = new Date(ms);
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
    const frac = dv % 1;
    if (frac) { const sec = Math.round(frac * 86400); hh = Math.floor(sec / 3600); mi = Math.floor(sec / 60) % 60; ss = sec % 60; }
  } else {
    const s = String(dv).trim();
    let mt = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (mt) { d = +mt[1]; m = +mt[2]; y = +mt[3] < 100 ? 2000 + +mt[3] : +mt[3]; if (mt[4]) { hh = +mt[4]; mi = +mt[5]; ss = +(mt[6] || 0); } }
    else if ((mt = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/))) {
      y = +mt[1]; m = +mt[2]; d = +mt[3]; if (mt[4]) { hh = +mt[4]; mi = +mt[5]; ss = +(mt[6] || 0); }
    } else return null;
  }
  if (tv !== undefined && tv !== "") {
    if (typeof tv === "number") { const sec = Math.round((tv % 1) * 86400); hh = Math.floor(sec / 3600); mi = Math.floor(sec / 60) % 60; ss = sec % 60; }
    else { const mt = String(tv).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); if (mt) { hh = +mt[1]; mi = +mt[2]; ss = +(mt[3] || 0); } }
  }
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return kyivMidnight(iso) + hh * 3600 + mi * 60 + ss;
}

// ============================================================ параметри
const CATEGORIES = {
  income: "Дохід",
  refund_to_buyer: "Повернення коштів покупцю (зменшує дохід)",
  own_transfer: "Власні кошти / переказ між своїми рахунками",
  currency_exchange: "Купівля/продаж валюти",
  refund_in: "Повернення помилково/надміру сплачених коштів",
  loan: "Кредит / позика / поворотна допомога",
  tax_refund: "Повернення податків",
  other_non_income: "Інше (не дохід)",
  expense: "Витрата",
};

// Ліміт 3 групи = 1167 мінімальних зарплат на 1 січня. ЄСВ — мінімальний внесок на місяць; esv_q — помісячно для
// кожного кварталу, якщо протягом року змінювався. Військовий збір для платників ЄП — з 2025 року.
const DEFAULT_TAX = {
  2022: { min_wage: 6500, income_limit: 7585500, esv_month: 1430, esv_q: [1430, 1430, 1430, 1474], single_tax_rate: 5, mil_rate: 0 },
  2023: { min_wage: 6700, income_limit: 7818900, esv_month: 1474, single_tax_rate: 5, mil_rate: 0 },
  2024: { min_wage: 7100, income_limit: 8285700, esv_month: 1760, esv_q: [1562, 1760, 1760, 1760], single_tax_rate: 5, mil_rate: 0 },
  2025: { min_wage: 8000, income_limit: 9336000, esv_month: 1760, single_tax_rate: 5, mil_rate: 1 },
  2026: { min_wage: 8647, income_limit: 10091049, esv_month: 1902.34, single_tax_rate: 5, mil_rate: 1 },
};

const DEFAULT_RULES = [
  ["продаж валют", "any", "in", "currency_exchange", 10],
  ["продаж безготівкової", "any", "in", "currency_exchange", 10],
  ["купівля валют", "any", "any", "currency_exchange", 10],
  ["обмін валют", "any", "any", "currency_exchange", 10],
  ["конвертац", "any", "any", "currency_exchange", 10],
  ["повернення помилково", "any", "in", "refund_in", 20],
  ["помилково зарахован", "any", "in", "refund_in", 20],
  ["повернення коштів", "any", "in", "refund_in", 30],
  ["повернення податку", "any", "in", "tax_refund", 20],
  ["повернення надміру", "any", "in", "tax_refund", 20],
  ["поворотн", "any", "in", "loan", 20],
  ["позик", "any", "in", "loan", 30],
  ["кредит", "description", "in", "loan", 40],
  ["власних коштів", "any", "in", "own_transfer", 20],
  ["власні кошти", "any", "in", "own_transfer", 20],
  ["між власними", "any", "in", "own_transfer", 20],
  ["поповнення рахунку власн", "any", "in", "own_transfer", 20],
  ["з чорної картки", "description", "in", "own_transfer", 20],
  ["з білої картки", "description", "in", "own_transfer", 20],
  ["з картки монобанк", "description", "in", "own_transfer", 40],
  ["повернення передоплати", "any", "out", "refund_to_buyer", 20],
  ["повернення коштів покупц", "any", "out", "refund_to_buyer", 20],
  // v2: формулювання банку при продажу валютної виручки («Продаж UAH клієнтів / Гривні від продажу 922.00 USD по курсу 44.57»)
  ["гривні від продажу", "any", "in", "currency_exchange", 10, 2],
  ["продаж uah", "any", "in", "currency_exchange", 10, 2],
].map(([pattern, field, direction, category, priority, since = 1], i) => ({ id: i + 1, pattern, field, direction, category, priority, since }));
const RULES_VERSION = 2;

// ============================================================ сховище
const STORE_KEY = "fopIncome.v1";
let S;

function freshState() {
  return {
    settings: { owner_name: "", owner_tax_id: "", sync_start: `${new Date().getFullYear()}-01-01`, esv_enabled: true },
    taxParams: JSON.parse(JSON.stringify(DEFAULT_TAX)),
    connections: [], accounts: {}, tx: {}, rules: DEFAULT_RULES.map(({ since, ...r }) => r), rulesVersion: RULES_VERSION,
    rates: {}, log: [], nextId: 100, tax: {},
  };
}

// Новий id для підключень і правил: часова мітка, щоб два пристрої не видали однаковий id
function newId() {
  S.nextId = Math.max((S.nextId || 0) + 1, Date.now());
  return S.nextId;
}

function load(data) {
  if (data !== undefined) S = data ? JSON.parse(JSON.stringify(data)) : freshState();
  else {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      S = raw ? JSON.parse(raw) : freshState();
    } catch { S = freshState(); }
  }
  const f = freshState();
  if (S.rulesVersion === undefined) S.rulesVersion = 1; // дані, збережені до появи версій правил
  for (const k of Object.keys(f)) if (S[k] === undefined) S[k] = f[k];
  for (const [y, p] of Object.entries(DEFAULT_TAX)) if (!S.taxParams[y]) S.taxParams[y] = { ...p };
}

let saveTimer, allowWipe = false;
function save(now = false) {
  if (SERVER_MODE) return remoteSave(now);
  clearTimeout(saveTimer);
  const doSave = () => {
    try {
      // запобіжник: порожній стан ніколи не перезаписує збережені дані (крім явного «Видалити всі дані»)
      const empty = !Object.keys(S.tx).length && !S.connections.length && !Object.keys(S.accounts).length;
      if (empty && !allowWipe && (localStorage.getItem(STORE_KEY) || "").length > 5000) return;
      localStorage.setItem(STORE_KEY, JSON.stringify(S));
    }
    catch (e) { toast("Не вдалося зберегти дані в браузері: " + e.message, true); }
  };
  if (now) doSave(); else saveTimer = setTimeout(doSave, 300);
}

function log(level, message) {
  S.log.unshift({ ts: nowTs(), level, message });
  S.log.length = Math.min(S.log.length, 200);
  save();
}

// ============================================================ класифікація
// Банки інколи пишуть українські слова з латинськими літерами-двійниками («клiєнтiв», «Гривнi»).
// Зводимо такі літери до кириличних — однаково і в тексті операції, і в правилі, тож збіг не залежить від розкладки.
const LATIN_LOOKALIKE = { a: "а", c: "с", e: "е", i: "і", o: "о", p: "р", x: "х", y: "у", k: "к" };
const norm = (s) => String(s || "").toLowerCase().replace(/[ʼ’`]/g, "'").replace(/[aceiopxyk]/g, (ch) => LATIN_LOOKALIKE[ch])
  .replace(/\s+/g, " ").trim();

function makeClassifier() {
  const rules = [...S.rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
  const ownIbans = new Set(Object.values(S.accounts).map((a) => a.iban).filter(Boolean));
  const names = new Set([S.settings.owner_name, ...S.connections.map((c) => c.owner_name)].filter((n) => n && n.trim().length >= 5));
  const ownerNames = [...names].map(norm);
  const taxId = (S.settings.owner_tax_id || "").trim();
  const isOwner = (cn) => {
    cn = norm(cn);
    if (!cn) return false;
    return ownerNames.some((n) => {
      const parts = n.split(" ").filter((p) => p.length > 1);
      return n === cn || (parts.length >= 2 && parts.slice(0, 2).every((p) => cn.includes(p)));
    });
  };
  return (tx, acc) => {
    const dir = tx.amount > 0 ? "in" : "out";
    const f = { description: norm(tx.description), counter_name: norm(tx.counter_name), counter_edrpou: norm(tx.counter_edrpou), comment: norm(tx.comment) };
    for (const r of rules) {
      if (r.direction !== "any" && r.direction !== dir) continue;
      const pat = norm(r.pattern);
      if (!pat) continue;
      const hay = r.field === "any" ? Object.values(f).join(" | ") : f[r.field] || "";
      if (hay.includes(pat)) return ["" + r.category, `правило «${r.pattern}»`];
    }
    if (dir === "out") return ["expense", "списання"];
    if (!acc.is_fop) return ["other_non_income", "надходження на особистий (не ФОП) рахунок"];
    // валютна виручка приходить з розподільчого рахунку 2603 банку, де «відправником» вказано самого ФОП
    if (tx.currency !== "UAH" && /^UA\d{8}0*2603/.test(tx.counter_iban || "")) return ["income", "валютна виручка (з розподільчого рахунку)"];
    if (tx.counter_iban && ownIbans.has(tx.counter_iban)) return ["own_transfer", "з власного рахунку (IBAN)"];
    if (taxId && tx.counter_edrpou === taxId) return ["own_transfer", "відправник — ваш РНОКПП"];
    if (isOwner(tx.counter_name)) return ["own_transfer", "відправник — ви"];
    return ["income", "надходження на рахунок ФОП"];
  };
}

function reclassifyAll() {
  const c = makeClassifier();
  let n = 0;
  for (const t of Object.values(S.tx)) {
    const acc = S.accounts[t.account_id];
    if (!acc) continue;
    const [cat, reason] = c(t, acc);
    if (cat !== t.auto_category || reason !== t.auto_reason) { t.auto_category = cat; t.auto_reason = reason; n++; }
  }
  save();
  return n;
}

const catOf = (t) => t.manual_category || t.auto_category;

// ---------------------------------------------------------------- операції, що потребують підтвердження
// Надходження на рахунок ФОП, які не на 100% є доходом: програма просить користувача вирішити.
// Рішення зберігається в t.reviewed (і за потреби — у manual_category); ручна зміна категорії теж є рішенням.
const REVIEW_BY_CATEGORY = {
  own_transfer: "Схоже на переказ між вашими рахунками",
  refund_in: "Схоже на повернення коштів",
  loan: "Схоже на позику / поворотну фінансову допомогу",
  tax_refund: "Схоже на повернення податку",
  other_non_income: "Надходження не віднесено до доходу",
};
// Слова в описі, через які надходження з категорією «Дохід» варто перевірити: [шаблон, пояснення, категорія «не дохід»]
const REVIEW_KEYWORDS = [
  ["роялті", "Роялті", "other_non_income"],
  ["допомог", "Схоже на допомогу", "loan"],
  ["матеріальн", "Схоже на матеріальну допомогу", "other_non_income"],
  ["благодійн", "Схоже на благодійний внесок", "other_non_income"],
  ["грант", "Схоже на грант", "other_non_income"],
  ["повернен", "Схоже на повернення коштів", "refund_in"],
  ["відшкодув", "Схоже на відшкодування", "refund_in"],
  ["компенсац", "Схоже на компенсацію", "refund_in"],
  ["позик", "Схоже на позику", "loan"],
  ["позичк", "Схоже на позику", "loan"],
  ["поворотн", "Схоже на поворотну допомогу", "loan"],
  ["кредит", "Схоже на кредит", "loan"],
  ["зарплат", "Схоже на заробітну плату", "other_non_income"],
  ["заробітн", "Схоже на заробітну плату", "other_non_income"],
  ["дивіденд", "Схоже на дивіденди", "other_non_income"],
  ["відсотк", "Схоже на відсотки банку", "other_non_income"],
  ["депозит", "Схоже на депозит", "other_non_income"],
  ["кешбек", "Схоже на кешбек", "other_non_income"],
  ["cashback", "Схоже на кешбек", "other_non_income"],
  ["страхов", "Схоже на страхову виплату", "other_non_income"],
  ["поповнення", "Поповнення рахунку — перевірте, чи це оплата від клієнта", "own_transfer"],
  ["переказ з картки", "Переказ з картки — перевірте, чи це оплата від клієнта", "own_transfer"],
  ["переказ коштів", "Переказ коштів — перевірте, чи це оплата від клієнта", "own_transfer"],
  ["власн", "Схоже на власні кошти", "own_transfer"],
];

const ACQUIRING_HINTS = ["еквайринг", "операції з пк", "операцій з пк", "операції з платіжн", "операціями з платіжн", "відшкодування за операц", "торговельн", "термінал"];

// Повертає { reason, alt } для операції, що чекає рішення, або null
function reviewInfo(t) {
  if (t.reviewed || t.manual_category) return null;
  const acc = S.accounts[t.account_id];
  if (!acc || !acc.is_fop) return null;
  if (t.amount < 0) return t.auto_category === "refund_to_buyer" ? { reason: "Повернення покупцю зменшує дохід", alt: "expense" } : null;
  if (REVIEW_BY_CATEGORY[t.auto_category]) return { reason: REVIEW_BY_CATEGORY[t.auto_category], alt: "income" };
  if (t.auto_category !== "income") return null;
  const hay = norm([t.description, t.comment, t.counter_name].join(" "));
  // виплати еквайрингу («Відшкодування за операції з ПК…», з утриманою комісією) — звичайний дохід, не питаємо
  if (t.commission_auto > 0 || ACQUIRING_HINTS.some((h) => hay.includes(norm(h)))) return null;
  for (const [pat, reason, alt] of REVIEW_KEYWORDS) if (hay.includes(norm(pat))) return { reason, alt };
  return null;
}
const needsReview = (t) => !!reviewInfo(t);
function pendingReviewCount() {
  let n = 0;
  for (const t of Object.values(S.tx)) if (needsReview(t)) n++;
  return n;
}
function updateReviewBadge() {
  const n = pendingReviewCount(), b = $("#review-badge");
  if (b) { b.textContent = n; b.hidden = !n; }
  return n;
}
// Комісія еквайрингу (у валюті рахунку, копійки): ручна має пріоритет над знайденою в призначенні
const commissionOf = (t) => (t.amount > 0 ? (t.commission_manual ?? t.commission_auto ?? 0) : 0);
// Дохід у гривні = (надійшло на рахунок + утримана комісія) × курс НБУ; лише для категорії «Дохід»
const incomeUah = (t) => (t.nbu_rate == null ? null : Math.round((t.amount + commissionOf(t)) * t.nbu_rate));
const COMMISSION_PARSER_VERSION = 1;
function detectCommission(t) {
  t.commission_auto = t.amount > 0 ? parseCommission([t.description, t.comment].join(" ")) : 0;
}

// ============================================================ курси НБУ
async function nbuRate(cc, iso) {
  if (cc === "UAH") return 1;
  const key = cc + "|" + iso;
  if (S.rates[key]) return S.rates[key];
  const url = `${API.nbu}?valcode=${encodeURIComponent(cc)}&date=${iso.replace(/-/g, "")}&json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("НБУ: HTTP " + r.status);
  const data = await r.json();
  if (!data.length) throw new Error(`НБУ не має курсу ${cc} на ${iso}`);
  S.rates[key] = Number(data[0].rate);
  return S.rates[key];
}

async function fillRate(t) {
  if (t.currency === "UAH") { t.nbu_rate = 1; t.uah_amount = t.amount; return; }
  try {
    t.nbu_rate = await nbuRate(t.currency, t.date);
    t.uah_amount = Math.round(t.amount * t.nbu_rate);
  } catch (e) { log("warn", `Немає курсу НБУ ${t.currency} на ${t.date}: ${e.message}`); }
}

async function fillMissingRates() {
  for (const t of Object.values(S.tx)) if (t.uah_amount == null) await fillRate(t);
  save();
}

// ============================================================ збереження операцій
async function storeTransactions(acc, items) {
  const classify = makeClassifier();
  let added = 0;
  for (const it of items) {
    let id = `${acc.bank}:${it.ext_id}`;
    // переказ між двома своїми рахунками одного банку має однаковий референс в обох — друга сторона отримує свій id
    if (S.tx[id] && S.tx[id].account_id !== acc.id) id = `${acc.bank}:${it.ext_id}@${acc.id}`;
    const old = S.tx[id];
    const t = Object.assign(old || { id, account_id: acc.id, manual_category: null, note: "" }, it, { date: kyivDate(it.ts) });
    delete t.ext_id;
    detectCommission(t);
    [t.auto_category, t.auto_reason] = classify(t, acc);
    if (!old || old.uah_amount == null || old.amount !== it.amount) await fillRate(t);
    if (!old) { S.tx[id] = t; added++; }
  }
  save();
  return added;
}

// ============================================================ Monobank
let monoLast = 0;
// Тимчасові збої (сервер програми перезапускається, банк перевантажений): 502/503/504 і обрив зв'язку
const TRANSIENT = new Set([502, 503, 504]);
function transientError(msg) { const e = new Error(msg); e.transient = true; return e; }

async function monoGet(token, path) {
  let fails = 0;
  for (let attempt = 0; attempt < 7; attempt++) {
    const wait = monoLast + API.monoInterval - Date.now();
    if (wait > 0) { setStatus(statusText, Math.ceil(wait / 1000)); await sleep(wait); }
    monoLast = Date.now();
    let r;
    try { r = await fetch(API.mono + path, { headers: { "X-Token": token } }); }
    catch { if (++fails <= 3) { await sleep(5000 * fails); continue; } throw transientError("Немає з'єднання з Monobank"); }
    if (r.status === 429) continue; // занадто часто — чекаємо і пробуємо ще
    if (TRANSIENT.has(r.status)) {
      if (++fails <= 3) { await sleep(10000 * fails); continue; }
      throw transientError("Monobank тимчасово не відповідає (HTTP " + r.status + ") — спробую пізніше");
    }
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error((data && data.errorDescription) || "Monobank: HTTP " + r.status);
    return data;
  }
  throw new Error("Monobank: перевищено ліміт запитів, спробуйте пізніше");
}

const MONO_TYPES = { fop: "ФОП", black: "Чорна картка", white: "Біла картка", platinum: "Platinum", iron: "Iron", yellow: "Жовта картка", eAid: "єПідтримка", madeInUkraine: "Зроблено в Україні" };

async function monoClientInfo(token) {
  const info = await monoGet(token, "/personal/client-info");
  return {
    name: info.name,
    accounts: (info.accounts || []).map((a) => {
      const cc = ISO_NUM[a.currencyCode] || String(a.currencyCode);
      const pan = (a.maskedPan || [])[0] || (a.iban || "").slice(-6);
      return { ext_id: a.id, iban: a.iban || "", currency: cc, type: a.type, balance: a.balance,
               name: [MONO_TYPES[a.type] || a.type || "Рахунок", cc, pan].filter(Boolean).join(" "), is_fop: a.type === "fop" };
    }),
  };
}

const MONO_MAX = 31 * 24 * 3600 + 3600;
// Одне вікно (до 31 доби): сторінки по 500 операцій, кожна передається в onPage одразу
async function monoWindow(token, accId, start, end, onPage) {
  let upto = end;
  for (;;) {
    const items = (await monoGet(token, `/personal/statement/${accId}/${start}/${upto}`)) || [];
    await onPage(items);
    if (items.length < 500) break;
    upto = Math.min(...items.map((i) => i.time)) - 1;
    if (upto <= start) break;
  }
}

function monoNormalize(it, acc) {
  return {
    ext_id: it.id, ts: it.time, amount: it.amount, currency: acc.currency,
    description: it.description || "", comment: it.comment || "",
    counter_name: it.counterName || "", counter_edrpou: it.counterEdrpou || "", counter_iban: it.counterIban || "",
    hold: it.hold ? 1 : 0,
  };
}

function upsertAccounts(conn, accounts) {
  for (const a of accounts) {
    const id = `${conn.bank}:${a.ext_id}`;
    const old = S.accounts[id];
    if (old) Object.assign(old, { iban: a.iban, currency: a.currency, type: a.type, name: a.name, balance: a.balance });
    else S.accounts[id] = { id, connection_id: conn.id, bank: conn.bank, ...a, enabled: !!a.is_fop, synced_to: null };
  }
  save();
}

async function addMono(token) {
  setStatus("Перевіряю токен Monobank…");
  const info = await monoClientInfo(token);
  const conn = { id: newId(), bank: "mono", name: `Monobank — ${info.name}`, token, owner_name: info.name, last_sync_at: null, last_error: null, created_at: nowTs() };
  S.connections.push(conn);
  upsertAccounts(conn, info.accounts);
  if (!S.settings.owner_name) S.settings.owner_name = info.name;
  log("info", `Додано ${conn.name}, рахунків: ${info.accounts.length}`);
  save(true);
  setStatus("");
  return conn;
}

// ============================================================ синхронізація
let syncing = false, syncQueued = false, statusText = "";

function setStatus(text, secondsLeft) {
  statusText = text;
  const ind = $("#sync-indicator");
  if (!ind) return;
  if (text) {
    ind.className = "sync-indicator busy";
    ind.textContent = text + (secondsLeft ? ` · пауза банку ${secondsLeft} с` : "");
  } else {
    ind.className = "sync-indicator";
    const last = Math.max(0, ...S.connections.map((c) => c.last_sync_at || 0));
    ind.textContent = last ? "Оновлено " + new Date(last * 1000).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : "";
  }
}

// Синхронізація рахунку Monobank.
// Спершу — свіжі операції, потім догрузка історії від сьогодні назад до дати початку.
// Кожне вікно зберігається одразу, тож операції з'являються поступово, а після
// перезавантаження сторінки завантаження продовжується з того місця, де зупинилось.
async function syncMonoAccount(conn, acc) {
  const startTs = kyivMidnight(S.settings.sync_start);
  const store = async (items) => {
    if (!items.length) return 0;
    const n = await storeTransactions(acc, items.map((it) => monoNormalize(it, acc)));
    refreshActive();
    return n;
  };
  let added = 0;
  const now = nowTs();
  if (acc.loaded_to && acc.loaded_from != null) {
    // свіжі операції з моменту останнього оновлення (з запасом 3 дні)
    let from = Math.max(startTs, acc.loaded_to - 3 * 86400);
    while (from < now) {
      const end = Math.min(now, from + MONO_MAX - 1);
      setStatus(`${acc.name}: нові операції`);
      await monoWindow(conn.token, acc.ext_id, from, end, async (items) => { added += await store(items); });
      from = end + 1;
    }
    acc.loaded_to = now;
  } else {
    acc.loaded_to = now;
    acc.loaded_from = now + 1;
  }
  save();
  // догрузка історії назад
  while (acc.loaded_from > startTs && !syncTimeUp()) {
    const end = acc.loaded_from - 1;
    const begin = Math.max(startTs, end - MONO_MAX + 1);
    syncProgress.current = acc;
    setStatus(`${acc.name}: ${fmtDate(kyivDate(begin))} – ${fmtDate(kyivDate(end))}`);
    await monoWindow(conn.token, acc.ext_id, begin, end, async (items) => { added += await store(items); });
    acc.loaded_from = begin;
    save(true);
    renderBanner();
  }
  acc.synced_to = acc.loaded_to;
  log("info", `${acc.name}: нових операцій ${added}`);
  save(true);
}

const syncProgress = { current: null };
// Межа часу одного запуску синхронізації (задає фоновий воркер сервера); у браузері — без обмежень
function syncTimeUp() { return typeof SYNC_DEADLINE !== "undefined" && Date.now() > SYNC_DEADLINE; }

function remainingWindows() {
  const startTs = kyivMidnight(S.settings.sync_start);
  return Object.values(S.accounts).filter((a) => a.bank === "mono" && a.enabled && a.connection_id)
    .reduce((n, a) => n + (a.loaded_from == null ? Math.ceil((nowTs() - startTs) / MONO_MAX) : Math.max(0, Math.ceil((a.loaded_from - startTs) / MONO_MAX))), 0);
}

function renderBanner() {
  const el = $("#sync-banner");
  if (!el) return;
  const errs = S.connections.filter((c) => c.last_error);
  const leftMono = remainingWindows(), leftPrivat = privatMonthsLeft(), left = leftMono + leftPrivat;
  if (syncing && left > 0) {
    const mins = Math.max(1, Math.ceil((leftMono * API.monoInterval + leftPrivat * 6000) / 60000));
    const a = syncProgress.current;
    const fromIso = a ? (a.bank === "privat" ? a.p_loaded_from : a.loaded_from && a.loaded_from <= nowTs() ? kyivDate(a.loaded_from) : null) : null;
    el.className = "banner";
    el.innerHTML = `<span class="spinner"></span><div><b>Завантажуємо виписки.</b> ${a && fromIso ? `${esc(a.name)}: завантажено з ${fmtDate(fromIso)}. ` : ""}Залишилось близько ${mins} хв${leftMono ? " — Monobank віддає дані лише раз на хвилину" : ""}. Не закривайте вкладку; операції з'являються поступово.</div>`;
  } else if (errs.length) {
    el.className = "banner error";
    el.innerHTML = `<div><b>Помилка оновлення.</b> ${errs.map((c) => esc(c.name + ": " + c.last_error)).join("; ")}. Деталі — у журналі на вкладці «Банки».</div>`;
  } else if (!syncing && left > 0 && S.connections.length) {
    el.className = "banner";
    el.innerHTML = `<div>Виписки завантажено не повністю. <button class="btn" id="banner-resume">Продовжити завантаження</button></div>`;
  } else el.className = "banner hidden";
}
if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("click", (e) => { if (e.target.id === "banner-resume") syncAll(); });

async function syncAll(onlyConnId, userInitiated = false) {
  let retryLater = false;
  if (syncing) { syncQueued = true; return; }
  syncing = true;
  if (!(await acquireSyncLock())) {
    syncing = false;
    setStatus("");
    if (userInitiated) toast("Виписки зараз оновлює сервер або інший ваш пристрій. Нові операції з'являться тут автоматично.");
    return;
  }
  renderBanner();
  try {
    // ПриватБанк — першим: він швидкий (місяць за кілька секунд), а довге довантаження історії Monobank
    // (1 запит на хвилину) могло вичерпати час фонового запуску сервера, і до Привату черга не доходила
    const order = [...S.connections].sort((a, b) => (a.bank === "privat" ? 0 : 1) - (b.bank === "privat" ? 0 : 1));
    for (const conn of order) {
      if (onlyConnId && conn.id !== onlyConnId) continue;
      try {
        if (conn.bank === "privat") {
          await syncPrivatConnection(conn);
          conn.last_sync_at = nowTs(); conn.last_error = null;
          save(true);
          continue;
        }
        if (conn.bank !== "mono") continue;
        setStatus(`${conn.name}: рахунки…`);
        try {
          const info = await monoClientInfo(conn.token);
          conn.owner_name = info.name;
          upsertAccounts(conn, info.accounts);
        } catch (e) { log("warn", `${conn.name}: не вдалося оновити рахунки: ${e.message}`); }
        for (const acc of Object.values(S.accounts).filter((a) => a.connection_id === conn.id && a.enabled)) {
          await syncMonoAccount(conn, acc);
        }
        conn.last_sync_at = nowTs();
        conn.last_error = null;
      } catch (e) {
        if (e.transient) {
          // тимчасовий збій: не показуємо як помилку підключення, повторимо за кілька хвилин
          log("warn", `${conn.name}: ${e.message}`);
          retryLater = true;
        } else {
          conn.last_error = e.message;
          log("error", `${conn.name}: ${e.message}`);
          toast(`${conn.name}: ${e.message}`, true);
        }
      }
      save(true);
    }
    await fillMissingRates();
  } finally {
    releaseSyncLock();
    syncing = false;
    syncProgress.current = null;
    setStatus("");
    renderBanner();
    refreshActive();
    if (syncQueued) { syncQueued = false; syncAll(); }
    else if (retryLater && typeof window !== "undefined" && window.document && window.document.body) setTimeout(() => syncAll(onlyConnId), 3 * 60 * 1000);
  }
}

