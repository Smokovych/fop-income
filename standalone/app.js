"use strict";
/* ФОП-дохід — версія, що працює повністю в браузері.
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

const DEFAULT_TAX = {
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
    rates: {}, log: [], nextId: 100,
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
    const id = `${acc.bank}:${it.ext_id}`;
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
async function monoGet(token, path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = monoLast + API.monoInterval - Date.now();
    if (wait > 0) { setStatus(statusText, Math.ceil(wait / 1000)); await sleep(wait); }
    monoLast = Date.now();
    let r;
    try { r = await fetch(API.mono + path, { headers: { "X-Token": token } }); }
    catch { throw new Error("Немає з'єднання з Monobank"); }
    if (r.status === 429) continue; // занадто часто — чекаємо і пробуємо ще
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
  while (acc.loaded_from > startTs) {
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
function remainingWindows() {
  const startTs = kyivMidnight(S.settings.sync_start);
  return Object.values(S.accounts).filter((a) => a.bank === "mono" && a.enabled)
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
document.addEventListener("click", (e) => { if (e.target.id === "banner-resume") syncAll(); });

async function syncAll(onlyConnId, userInitiated = false) {
  if (syncing) { syncQueued = true; return; }
  syncing = true;
  if (!(await acquireSyncLock())) {
    syncing = false;
    setStatus("");
    if (userInitiated) toast("Виписки зараз оновлює інший ваш пристрій. Нові операції з'являться тут автоматично.");
    return;
  }
  renderBanner();
  try {
    for (const conn of S.connections) {
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
        conn.last_error = e.message;
        log("error", `${conn.name}: ${e.message}`);
        toast(`${conn.name}: ${e.message}`, true);
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
  }
}

// ============================================================ імпорт файлу виписки
function decodeText(buf) {
  const utf = new TextDecoder("utf-8").decode(buf);
  if (!utf.includes("�")) return utf.replace(/^﻿/, "");
  return new TextDecoder("windows-1251").decode(buf);
}

function parseCSV(text) {
  const first = text.split(/\r?\n/).slice(0, 20).join("\n");
  const delim = [";", "\t", ","].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("Не вдалося завантажити модуль читання Excel (потрібен інтернет)"));
    document.head.appendChild(s);
  });
}

async function readRows(file) {
  const buf = await file.arrayBuffer();
  if (/\.xlsx?$/i.test(file.name)) {
    if (!window.XLSX) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
    const wb = XLSX.read(buf, { type: "array", cellDates: false });
    const sh = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sh, { header: 1, raw: true, defval: "" }).filter((r) => r.some((c) => String(c).trim()));
  }
  return parseCSV(decodeText(buf));
}

const FIELD_DEFS = [
  ["date", "Дата *", /дата.*(опер|провед|платеж)|^дата$|дата/],
  ["time", "Час", /^час|час опер|time/],
  ["amount", "Сума (зі знаком)", /^сума$|сума опер|сума в валют|^сума|amount/],
  ["credit", "Надходження (кредит)", /кредит|надходж|зарахув/],
  ["debit", "Списання (дебет)", /дебет|списан|витрат/],
  ["currency", "Валюта", /валют|currency/],
  ["description", "Призначення платежу", /признач|опис|деталі|description/],
  ["counter_name", "Контрагент", /контрагент|кореспондент|платник|отримувач|назва/],
  ["counter_edrpou", "ЄДРПОУ / РНОКПП контрагента", /єдрпоу|едрпоу|окпо|ідентиф|рнокпп|іпн/],
  ["counter_iban", "Рахунок контрагента", /рахунок контр|рахунок кор|iban|рахунок/],
];

function guessHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const r = rows[i].map((c) => norm(c));
    if (r.some((c) => /дата/.test(c)) && r.some((c) => /сума|кредит|дебет|надходж/.test(c))) return i;
  }
  return 0;
}

function guessMapping(header) {
  const used = new Set(), map = {};
  for (const [key, , rx] of FIELD_DEFS) {
    const idx = header.findIndex((h, i) => !used.has(i) && rx.test(norm(h)));
    if (idx >= 0) { map[key] = idx; used.add(idx); }
  }
  if (map.credit !== undefined || map.debit !== undefined) {
    // якщо є окремі колонки надходження/списання, «сума» зі знаком не потрібна
    if (map.amount !== undefined && (map.amount === map.credit || map.amount === map.debit)) delete map.amount;
  }
  return map;
}

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

function hash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function rowsToTx(rows, headerIdx, map) {
  const out = [], seen = {};
  for (const r of rows.slice(headerIdx + 1)) {
    const g = (k) => (map[k] === undefined ? "" : r[map[k]]);
    const ts = parseDateTime(g("date"), map.time !== undefined ? g("time") : undefined);
    if (ts == null) continue;
    let amount = map.amount !== undefined ? parseNum(g("amount")) : 0;
    if (map.credit !== undefined || map.debit !== undefined) amount = Math.abs(parseNum(g("credit"))) - Math.abs(parseNum(g("debit")));
    amount = Math.round(amount * 100);
    if (!amount) continue;
    const cur = String(g("currency") || "UAH").trim().toUpperCase();
    const t = {
      ts, amount, currency: /^[A-Z]{3}$/.test(cur) ? cur : cur === "ГРН" || cur === "980" ? "UAH" : "UAH",
      description: String(g("description") || "").trim(), comment: "",
      counter_name: String(g("counter_name") || "").trim(), counter_edrpou: String(g("counter_edrpou") || "").trim(),
      counter_iban: String(g("counter_iban") || "").trim(), hold: 0,
    };
    const base = hash([t.ts, t.amount, t.currency, t.description, t.counter_name, t.counter_iban].join("|"));
    seen[base] = (seen[base] || 0) + 1; // однакові операції в одному файлі не зливаються
    t.ext_id = base + (seen[base] > 1 ? "-" + seen[base] : "");
    out.push(t);
  }
  return out;
}

let pendingImport = null;

async function startImport(file, accountName) {
  const rows = await readRows(file);
  if (rows.length < 2) throw new Error("У файлі немає рядків");
  const headerIdx = guessHeader(rows);
  const header = rows[headerIdx].map((c) => String(c).trim());
  pendingImport = { rows, headerIdx, header, map: guessMapping(header), accountName };
  renderImportMap();
}

function renderImportMap() {
  const p = pendingImport, box = $("#import-map");
  if (!p) { box.hidden = true; return; }
  box.hidden = false;
  const opts = (sel) => `<option value="">—</option>` + p.header.map((h, i) => `<option value="${i}" ${sel === i ? "selected" : ""}>${esc(h || "Колонка " + (i + 1))}</option>`).join("");
  const preview = rowsToTx(p.rows, p.headerIdx, p.map).slice(0, 5);
  box.innerHTML = `
    <div class="card-head"><h3>Перевірте колонки файлу</h3><span class="muted small">Рядок заголовків: ${p.headerIdx + 1}. Потрібні «Дата» і сума (або надходження/списання).</span></div>
    <div class="filters">${FIELD_DEFS.map(([k, label]) => `<label>${label}<select data-map="${k}">${opts(p.map[k])}</select></label>`).join("")}</div>
    <div class="table-wrap" style="margin-top:12px"><table class="table"><thead><tr><th>Дата</th><th>Контрагент</th><th>Призначення</th><th class="num">Сума</th></tr></thead>
      <tbody>${preview.map((t) => `<tr><td>${fmtDate(kyivDate(t.ts))}</td><td>${esc(t.counter_name)}</td><td class="small">${esc(t.description)}</td><td class="num">${nf.format(t.amount / 100)} ${esc(t.currency)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Не вдалося розпізнати операції — виберіть колонки вручну</td></tr>`}</tbody></table></div>
    <div class="conn-actions" style="margin-top:12px">
      <button class="btn primary" id="btn-import-go">Імпортувати ${rowsToTx(p.rows, p.headerIdx, p.map).length} операцій</button>
      <button class="btn" id="btn-import-cancel">Скасувати</button>
    </div>`;
}

$("#import-map").addEventListener("change", (e) => {
  const k = e.target.dataset.map;
  if (!k) return;
  if (e.target.value === "") delete pendingImport.map[k]; else pendingImport.map[k] = Number(e.target.value);
  renderImportMap();
});
$("#import-map").addEventListener("click", async (e) => {
  if (e.target.id === "btn-import-cancel") { pendingImport = null; renderImportMap(); }
  if (e.target.id === "btn-import-go") {
    const p = pendingImport;
    const txs = rowsToTx(p.rows, p.headerIdx, p.map);
    if (!txs.length) return toast("Немає операцій для імпорту", true);
    e.target.disabled = true; e.target.textContent = "Імпортую…";
    // id рахунку — за старим зведенням тексту (без заміни латинських літер), щоб повторний імпорт потрапляв у той самий рахунок
    const accId = "file:" + hash(String(p.accountName || "").toLowerCase().replace(/[ʼ’]/g, "'").replace(/\s+/g, " ").trim());
    if (!S.accounts[accId]) S.accounts[accId] = { id: accId, connection_id: null, bank: "file", ext_id: accId, iban: "", currency: txs[0].currency, type: "file", name: p.accountName, balance: null, is_fop: true, enabled: true };
    const acc = S.accounts[accId];
    const added = await storeTransactions(acc, txs.map((t) => ({ ...t, ext_id: accId.slice(5) + "-" + t.ext_id })));
    log("info", `Імпорт «${acc.name}»: нових операцій ${added} з ${txs.length}`);
    save(true);
    pendingImport = null;
    renderImportMap();
    toast(`Імпортовано нових операцій: ${added}`);
    loadBanks();
  }
});

// ============================================================ податки
const QUARTER_MONTHS = { 1: [1, 3], 2: [4, 6], 3: [7, 9], 4: [10, 12] };
const isoD = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

function taxParams(year) {
  if (S.taxParams[year]) return { ...S.taxParams[year], year };
  const ys = Object.keys(S.taxParams).map(Number).sort((a, b) => b - a);
  const y = ys.find((v) => v < year) || ys[0];
  return { ...S.taxParams[y], year, assumed: true };
}

function quarterDeadlines(year, q) {
  const mEnd = QUARTER_MONTHS[q][1];
  const qEnd = new Date(Date.UTC(year, mEnd, 1) - 86400000);
  const decl = addDays(qEnd, 40);
  const pay = addDays(decl, 10);
  let declW = decl;
  while ([0, 6].includes(declW.getUTCDay())) declW = addDays(declW, 1);
  const next = addDays(qEnd, 1);
  return { declaration: isoD(declW), single_tax: isoD(pay), military: isoD(pay), esv: isoD(new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), 20))) };
}

function summary(year) {
  const p = taxParams(year);
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, income: 0, refunds: 0, count: 0 }));
  let missing = 0;
  for (const t of Object.values(S.tx)) {
    if (!t.date.startsWith(year + "-") || !S.accounts[t.account_id]) continue;
    const c = catOf(t);
    if (c !== "income" && c !== "refund_to_buyer") continue;
    if (t.uah_amount == null) { missing++; continue; }
    const m = months[Number(t.date.slice(5, 7)) - 1];
    if (c === "income") { m.income += incomeUah(t); m.count++; } else m.refunds += Math.abs(t.uah_amount);
  }
  const today = isoD(new Date(Date.UTC(...kyivDate(nowTs()).split("-").map((v, i) => (i === 1 ? v - 1 : +v)))));
  let cum = 0;
  const quarters = Object.entries(QUARTER_MONTHS).map(([q, [m1, m2]]) => {
    const ms = months.slice(m1 - 1, m2);
    const inc = ms.reduce((a, m) => a + m.income, 0), ref = ms.reduce((a, m) => a + m.refunds, 0);
    const net = inc - ref; cum += net;
    const base = Math.max(net, 0) / 100;
    return {
      quarter: +q, income: inc / 100, refunds: ref / 100, net_income: net / 100, cumulative: cum / 100,
      single_tax: Math.round(base * p.single_tax_rate) / 100, military: Math.round(base * p.mil_rate) / 100,
      esv: S.settings.esv_enabled ? Math.round(p.esv_month * 300) / 100 : 0,
      deadlines: quarterDeadlines(year, +q), started: `${year}-${String(m1).padStart(2, "0")}-01` <= today,
    };
  });
  const total = cum / 100, over = Math.max(0, total - p.income_limit);
  return {
    year, params: p, esv_enabled: S.settings.esv_enabled, total_income: total, limit: p.income_limit,
    limit_used_pct: p.income_limit ? Math.round((total / p.income_limit) * 10000) / 100 : 0,
    limit_left: p.income_limit - total, over_limit: over, over_limit_tax: Math.round(over * 15) / 100,
    single_tax_total: quarters.reduce((a, q) => a + q.single_tax, 0), military_total: quarters.reduce((a, q) => a + q.military, 0),
    months: months.map((m) => ({ ...m, income: m.income / 100, refunds: m.refunds / 100 })), quarters, missing_rates: missing, today,
  };
}

function upcoming(limit = 6) {
  const y = new Date().getFullYear(), out = [];
  let today;
  for (const year of [y - 1, y]) {
    const s = summary(year); today = s.today;
    for (const q of s.quarters) {
      const d = q.deadlines;
      const items = [[d.declaration, `Декларація ЄП за ${q.quarter} кв. ${year}`, null],
        [d.single_tax, `Єдиний податок за ${q.quarter} кв. ${year}`, q.single_tax],
        [d.military, `Військовий збір за ${q.quarter} кв. ${year}`, q.military]];
      if (s.esv_enabled) items.push([d.esv, `ЄСВ за ${q.quarter} кв. ${year}`, q.esv]);
      for (const [date, title, amount] of items) if (date >= today) out.push({ date, title, amount, days_left: Math.round((Date.parse(date) - Date.parse(today)) / 86400000) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit);
}

// ============================================================ інтерфейс: загальне
let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), isError ? 7000 : 3500);
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; // латиницею: деякі браузери відкидають нелатинські імена
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const state = { year: new Date().getFullYear(), txShown: 100 };
const loaders = { overview: loadOverview, transactions: () => loadTransactions(true), banks: loadBanks, rules: loadRules, settings: loadSettings };
let activeTab = "overview";

function openTab(name) {
  activeTab = name;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((s) => s.classList.toggle("hidden", s.id !== "tab-" + name));
  try { history.replaceState(null, "", "#" + name); } catch {}
  loaders[name]();
}
function refreshActive() { updateReviewBadge(); if (activeTab !== "settings" && activeTab !== "rules") loaders[activeTab](); }
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) openTab(b.dataset.tab); });

// ============================================================ огляд
function loadOverview() {
  const s = summary(state.year);
  const years = new Set([new Date().getFullYear(), state.year, ...Object.values(S.tx).map((t) => +t.date.slice(0, 4))]);
  $("#year-select").innerHTML = [...years].sort((a, b) => b - a).map((y) => `<option ${y === state.year ? "selected" : ""}>${y}</option>`).join("");
  $("#empty-hint").classList.toggle("hidden", Object.keys(S.accounts).length > 0);
  const pend = updateReviewBadge();
  $("#review-hint").classList.toggle("hidden", !pend);
  $("#review-count").textContent = pend;

  const isCur = state.year === new Date().getFullYear();
  const q = s.quarters[(isCur ? Math.floor(new Date().getMonth() / 3) + 1 : 4) - 1];
  $("#kpis").innerHTML = [
    ["Дохід за " + state.year, money(s.total_income), `${s.months.reduce((a, m) => a + m.count, 0)} надходжень`],
    [`Дохід за ${q.quarter} кв.`, money(q.net_income), isCur ? "поточний квартал" : ""],
    [`Єдиний податок ${s.params.single_tax_rate}% за рік`, money(s.single_tax_total), `за ${q.quarter} кв.: ${money(q.single_tax)}`],
    [`Військовий збір ${s.params.mil_rate}% за рік`, money(s.military_total), s.esv_enabled ? `ЄСВ: ${money(s.params.esv_month)}/міс` : "ЄСВ не сплачується"],
  ].map(([l, v, sub]) => `<div class="kpi"><div class="label">${esc(l)}</div><div class="value">${v}</div><div class="sub">${esc(sub)}</div></div>`).join("");

  const fill = $("#limit-fill");
  fill.style.width = Math.min(100, s.limit_used_pct) + "%";
  fill.className = s.limit_used_pct >= 100 ? "over" : s.limit_used_pct >= 80 ? "high" : "";
  $("#limit-text").textContent = `${nf.format(s.limit_used_pct)}% · ${money(s.total_income)} з ${money(s.limit)} · залишок ${money(Math.max(0, s.limit_left))}`;
  const warn = $("#limit-warn");
  let w = "";
  if (s.over_limit > 0) w = `Ліміт перевищено на ${money(s.over_limit)}. Із суми перевищення сплачується 15% (${money(s.over_limit_tax)}), а з наступного кварталу потрібно перейти на загальну систему оподаткування — зверніться до бухгалтера.`;
  else if (s.limit_used_pct >= 80) w = "Використано понад 80% річного ліміту. Стежте за надходженнями.";
  if (s.params.assumed) w = `Податкові параметри для ${state.year} року не задано — використано параметри попереднього року. Оновіть їх у «Налаштуваннях».`;
  warn.textContent = w; warn.classList.toggle("hidden", !w);

  drawChart(s.months);

  const up = upcoming();
  $("#upcoming").innerHTML = up.length ? up.map((u) => `
    <li class="${u.days_left <= 10 ? "soon" : ""}">
      <div><div class="date">${fmtDate(u.date)}</div><div class="days">${u.days_left === 0 ? "сьогодні" : "через " + u.days_left + " дн."}</div></div>
      <div style="flex:1">${esc(u.title)}</div><div class="amt">${u.amount != null ? money(u.amount) : ""}</div></li>`).join("") : `<li class="muted">Немає</li>`;

  const qs = s.quarters;
  $("#quarters").innerHTML = `
    <thead><tr><th>Квартал</th><th class="num">Дохід</th><th class="num">Повернення</th><th class="num">Наростаючим</th>
      <th class="num">ЄП ${s.params.single_tax_rate}%</th><th class="num">ВЗ ${s.params.mil_rate}%</th><th class="num">ЄСВ</th>
      <th>Декларація до</th><th>Сплата ЄП/ВЗ до</th></tr></thead>
    <tbody>${qs.map((q) => `<tr><td>${q.quarter} кв.</td><td class="num">${money(q.income)}</td><td class="num">${q.refunds ? money(-q.refunds) : "—"}</td>
      <td class="num">${money(q.cumulative)}</td><td class="num">${money(q.single_tax)}</td><td class="num">${money(q.military)}</td>
      <td class="num">${money(q.esv)}</td><td>${fmtDate(q.deadlines.declaration)}</td><td>${fmtDate(q.deadlines.single_tax)}</td></tr>`).join("")}</tbody>
    <tfoot><tr><td>Рік</td><td class="num">${money(qs.reduce((a, q) => a + q.income, 0))}</td><td class="num">${money(-qs.reduce((a, q) => a + q.refunds, 0))}</td>
      <td class="num">${money(s.total_income)}</td><td class="num">${money(s.single_tax_total)}</td><td class="num">${money(s.military_total)}</td>
      <td class="num">${money(qs.reduce((a, q) => a + q.esv, 0))}</td><td></td><td></td></tr></tfoot>`;
  const mr = $("#missing-rates");
  mr.classList.toggle("hidden", !s.missing_rates);
  mr.textContent = `${s.missing_rates} валютних операцій ще без курсу НБУ — вони не враховані. Курси доберуться при наступному оновленні.`;
}
$("#year-select").addEventListener("change", (e) => { state.year = Number(e.target.value); loadOverview(); });

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1))), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function drawChart(months) {
  const el = $("#chart");
  const W = Math.max(320, el.clientWidth || 600), H = 260, padL = 52, padR = 8, padT = 16, padB = 26;
  const vals = months.map((m) => Math.max(0, m.income - m.refunds));
  const max = Math.max(...vals, 1), step = niceStep(max / 4), top = Math.ceil(max / step) * step;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const colW = (W - padL - padR) / 12, barW = Math.min(36, colW * 0.6);
  const axis = 'style="fill:var(--muted);font-size:11px"';
  let grid = "";
  for (let v = 0; v <= top + 1e-9; v += step) grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end" ${axis}>${moneyShort(v)}</text>`;
  const best = vals.indexOf(Math.max(...vals));
  const cols = months.map((m, i) => {
    const v = vals[i], x = padL + colW * i + (colW - barW) / 2, h = Math.max(0, y(0) - y(v)), r = Math.min(4, h);
    const path = h > 0 ? `M${x},${y(0)} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + barW - r} Q${x + barW},${y(v)} ${x + barW},${y(v) + r} V${y(0)} Z` : "";
    return `<g class="col" data-i="${i}"><rect class="bar-hit" x="${padL + colW * i}" y="${padT}" width="${colW}" height="${H - padT - padB}"/>
      <path class="bar" d="${path}"/>${i === best && v > 0 ? `<text class="val" x="${x + barW / 2}" y="${y(v) - 6}" text-anchor="middle">${moneyShort(v)}</text>` : ""}
      <text x="${padL + colW * i + colW / 2}" y="${H - 8}" text-anchor="middle" ${axis}>${MONTHS[i]}</text></g>`;
  }).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Дохід по місяцях"><g class="grid">${grid}</g>${cols}</svg>`;
  const tip = $("#tooltip");
  $$("g.col", el).forEach((g) => {
    const m = months[g.dataset.i];
    g.addEventListener("mousemove", (e) => {
      tip.innerHTML = `<b>${MONTHS[m.month - 1]} ${state.year}</b><br>Дохід: ${money(m.income)}${m.refunds ? `<br>Повернення: ${money(-m.refunds)}` : ""}<br>Надходжень: ${m.count}`;
      tip.classList.remove("hidden");
      tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
      tip.style.top = e.clientY + 12 + "px";
    });
    g.addEventListener("mouseleave", () => tip.classList.add("hidden"));
  });
}
let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (activeTab === "overview") loadOverview(); }, 200); });

// ============================================================ операції
function filteredTx() {
  const f = { from: $("#f-from").value, to: $("#f-to").value, acc: $("#f-account").value, cat: $("#f-category").value, dir: $("#f-direction").value, q: norm($("#f-q").value) };
  return Object.values(S.tx).filter((t) => S.accounts[t.account_id]
    && (!f.from || t.date >= f.from) && (!f.to || t.date <= f.to) && (!f.acc || t.account_id === f.acc)
    && (!f.cat || (f.cat === "__review" ? needsReview(t) : catOf(t) === f.cat)) && (f.dir !== "in" || t.amount > 0) && (f.dir !== "out" || t.amount < 0)
    && (!f.q || norm([t.description, t.counter_name, t.comment, t.note].join(" ")).includes(f.q)))
    .map((t) => [needsReview(t), t])
    .sort(([ra, a], [rb, b]) => (rb - ra) || (b.ts - a.ts)) // спершу ті, що чекають підтвердження
    .map(([, t]) => t);
}

function loadTransactions(reset) {
  if (reset) state.txShown = Math.max(100, reset === "keep" ? state.txShown : 100);
  const cur = $("#f-account").value;
  $("#f-account").innerHTML = `<option value="">Усі</option>` + Object.values(S.accounts)
    .map((a) => `<option value="${esc(a.id)}" ${a.id === cur ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  const all = filteredTx();
  const inc = all.filter((t) => catOf(t) === "income");
  const income = inc.reduce((a, t) => a + (incomeUah(t) || 0), 0);
  const comm = inc.reduce((a, t) => a + Math.round(commissionOf(t) * (t.nbu_rate || 1)), 0);
  const pending = all.filter(needsReview).length;
  $("#tx-summary").innerHTML = esc(`Знайдено операцій: ${all.length}. Дохід серед них: ${money(income / 100)}` + (comm ? `, у т.ч. комісія еквайрингу ${money(comm / 100)}` : ""))
    + (pending ? ` <span class="review-note">Чекають підтвердження: <b>${pending}</b> — вони вгорі списку й підсвічені жовтим.</span>` : "");
  updateReviewBadge();
  const rows = all.slice(0, state.txShown).map(txRow).join("");
  $("#tx-table").innerHTML = `<thead><tr><th>Дата</th><th>Контрагент / призначення</th><th>Рахунок</th><th class="num">Надійшло / списано</th><th class="num" title="Комісія еквайрингу, утримана банком. Береться з призначення платежу; клацніть, щоб змінити">Комісія</th><th class="num" title="Надійшло + комісія, у гривні за курсом НБУ. Ця сума йде в Книгу обліку доходів і декларацію">Дохід, грн</th><th>Категорія</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="muted">Операцій немає</td></tr>`}</tbody>`;
  $("#btn-more").classList.toggle("hidden", state.txShown >= all.length);
}

function commCell(t) {
  const v = commissionOf(t), manual = t.commission_manual != null;
  return `<button class="comm-btn ${manual ? "manual" : ""}${v ? "" : " empty"}" title="${manual ? "Вказано вручну" : t.commission_auto ? "Знайдено в призначенні платежу" : "Додати комісію"}">${v ? nf.format(v / 100) : "＋"}</button>
    ${manual ? `<div class="muted small">вручну</div>` : v ? `<div class="muted small">з призначення</div>` : ""}`;
}

function txRow(t) {
  const amt = t.amount / 100, c = catOf(t);
  const opts = Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}" ${k === c ? "selected" : ""}>${esc(v)}</option>`).join("");
  const time = new Date(t.ts * 1000).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" });
  const rv = reviewInfo(t);
  const yesLabel = t.amount < 0 ? "Так, повернення покупцю" : "Це дохід";
  const noLabel = t.amount < 0 ? "Ні, звичайна витрата" : "Не дохід";
  const review = rv ? `<div class="review-box"><div class="small"><b>Потрібне підтвердження.</b> ${esc(rv.reason)}.</div>
      <div class="review-actions"><button class="btn small review-yes">${yesLabel}</button><button class="btn small review-no">${noLabel}</button></div></div>` : "";
  return `<tr data-id="${esc(t.id)}"${rv ? ` class="needs-review"` : ""}>
    <td>${fmtDate(t.date)}<div class="muted small">${time}${t.hold ? " · в обробці" : ""}</div></td>
    <td class="desc"><div class="cp">${esc(t.counter_name || t.description)}</div><div class="sub">${esc(t.counter_name ? t.description : "")}${t.comment ? " · " + esc(t.comment) : ""}</div></td>
    <td class="small">${esc(S.accounts[t.account_id].name)}</td>
    <td class="num ${amt > 0 ? "pos" : "neg"}">${amt > 0 ? "+" : ""}${nf.format(amt)} ${CUR[t.currency] || t.currency}</td>
    <td class="num comm-cell">${amt > 0 ? commCell(t) : ""}</td>
    <td class="num">${c === "income" && incomeUah(t) != null ? `<b>${nf.format(incomeUah(t) / 100)}</b>` : `<span class="muted">—</span>`}${t.currency !== "UAH" && t.nbu_rate ? `<div class="muted small">курс ${t.nbu_rate}</div>` : ""}</td>
    <td><select class="cat ${t.manual_category ? "manual" : ""}" title="${esc(t.manual_category ? "Змінено вручну" : "Авто: " + (t.auto_reason || ""))}">${opts}</select>
      ${t.manual_category ? `<button class="btn ghost small reset" title="Повернути автоматичну категорію">↺</button>` : ""}
      <div class="muted small">${t.manual_category ? "вручну" : esc(t.auto_reason || "")}</div>${review}</td></tr>`;
}

$("#tx-table").addEventListener("change", (e) => {
  if (!e.target.classList.contains("cat")) return;
  const t = S.tx[e.target.closest("tr").dataset.id];
  t.manual_category = e.target.value;
  t.reviewed = true;
  save(true); toast("Категорію змінено"); loadTransactions("keep");
});
// Рішення по операції, що чекала підтвердження: «так» = доходом є (або для списання — це повернення покупцю)
function resolveReview(t, isIncome) {
  const rv = reviewInfo(t);
  if (!rv) return;
  const incomeSide = t.amount < 0 ? "refund_to_buyer" : "income";
  const target = isIncome ? incomeSide : (t.auto_category === incomeSide ? rv.alt : t.auto_category);
  t.manual_category = target === t.auto_category ? null : target;
  t.reviewed = true;
  save(true);
  toast(isIncome ? (t.amount < 0 ? "Підтверджено: повернення покупцю" : "Підтверджено: дохід") : `Не дохід: ${CATEGORIES[target]}. Категорію можна змінити у списку.`);
  loadTransactions("keep");
}

$("#tx-table").addEventListener("click", (e) => {
  if (e.target.classList.contains("review-yes") || e.target.classList.contains("review-no")) {
    return resolveReview(S.tx[e.target.closest("tr").dataset.id], e.target.classList.contains("review-yes"));
  }
  const cb = e.target.closest(".comm-btn");
  if (cb) {
    const td = cb.closest("td"), t = S.tx[td.closest("tr").dataset.id];
    td.innerHTML = `<input class="comm-input" type="text" inputmode="decimal" value="${commissionOf(t) ? (commissionOf(t) / 100).toFixed(2).replace(".", ",") : ""}" placeholder="0,00" aria-label="Комісія">
      <div class="small"><button class="btn ghost small comm-save">OK</button>${t.commission_manual != null ? `<button class="btn ghost small comm-auto" title="Повернути суму з призначення">↺</button>` : ""}</div>`;
    const inp = $("input", td); inp.focus(); inp.select();
    return;
  }
  if (e.target.classList.contains("comm-save")) return saveComm(e.target.closest("td"));
  if (e.target.classList.contains("comm-auto")) {
    S.tx[e.target.closest("tr").dataset.id].commission_manual = null;
    save(); loadTransactions("keep"); return;
  }
  if (!e.target.classList.contains("reset")) return;
  S.tx[e.target.closest("tr").dataset.id].manual_category = null;
  save(); loadTransactions("keep");
});
function saveComm(td) {
  const t = S.tx[td.closest("tr").dataset.id];
  const raw = $("input", td).value.trim();
  const v = raw === "" ? 0 : parseNum(raw);
  if (!isFinite(v) || v < 0) return toast("Вкажіть суму комісії числом, напр. 13,50", true);
  t.commission_manual = Math.round(v * 100);
  save(); toast("Комісію збережено"); loadTransactions("keep");
}
$("#tx-table").addEventListener("keydown", (e) => {
  if (!e.target.classList.contains("comm-input")) return;
  if (e.key === "Enter") { e.preventDefault(); saveComm(e.target.closest("td")); }
  if (e.key === "Escape") loadTransactions("keep");
});
let filterTimer;
["#f-from", "#f-to", "#f-account", "#f-category", "#f-direction", "#f-q"].forEach((id) =>
  $(id).addEventListener("input", () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => loadTransactions(true), 200); }));
$("#btn-more").addEventListener("click", () => { state.txShown += 200; loadTransactions(false); });

$("#btn-export").addEventListener("click", (e) => {
  e.preventDefault();
  const from = $("#f-from").value || `${state.year}-01-01`, to = $("#f-to").value || `${state.year}-12-31`;
  const rows = Object.values(S.tx).filter((t) => S.accounts[t.account_id] && t.date >= from && t.date <= to && ["income", "refund_to_buyer"].includes(catOf(t)))
    .sort((a, b) => a.ts - b.ts);
  const c = (v) => { const s = String(v ?? ""); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const num = (v) => v.toFixed(2).replace(".", ",");
  const lines = [["№", "Дата", "Сума доходу, грн", "Надійшло на рахунок, грн", "Комісія еквайрингу, грн", "Сума у валюті", "Валюта", "Курс НБУ", "Повернення коштів, грн", "Контрагент", "Призначення", "Рахунок"].join(";")];
  let total = 0, totalIn = 0, totalComm = 0, totalBack = 0;
  rows.forEach((t, i) => {
    const ref = catOf(t) === "refund_to_buyer", rate = t.nbu_rate || 0;
    const inc = ref ? 0 : (incomeUah(t) || 0) / 100;
    const got = ref ? 0 : Math.round(t.amount * rate) / 100;
    const comm = ref ? 0 : Math.round(inc * 100 - got * 100) / 100; // комісія в гривні = дохід − надійшло
    const back = ref ? Math.abs(t.uah_amount || 0) / 100 : 0;
    total += inc - back; totalIn += got; totalComm += comm; totalBack += back;
    lines.push([i + 1, fmtDate(t.date), ref ? "" : num(inc), ref ? "" : num(got), comm ? num(comm) : "",
      t.currency !== "UAH" ? num(Math.abs(t.amount + (ref ? 0 : commissionOf(t))) / 100) : "", t.currency, t.nbu_rate || "",
      ref ? num(back) : "", c(t.counter_name), c(t.description), c(S.accounts[t.account_id].name)].join(";"));
  });
  lines.push(["", "Разом", num(total), num(totalIn), num(totalComm), "", "", "", num(totalBack)].join(";"));
  download(`knyha-obliku-dokhodiv_${from}_${to}.csv`, "﻿" + lines.join("\r\n"), "text/csv;charset=utf-8");
});

// ============================================================ банки
function loadBanks() {
  const groups = [...S.connections.map((c) => ({ conn: c, accounts: Object.values(S.accounts).filter((a) => a.connection_id === c.id) }))];
  const files = Object.values(S.accounts).filter((a) => a.bank === "file");
  const accTable = (accs, withToggle) => `<div class="table-wrap acc-list"><table class="table">
    <thead><tr><th>Рахунок</th><th>IBAN</th><th class="num">Баланс</th><th class="num">Операцій</th><th>Рахунок ФОП</th>${withToggle ? "<th>Тягнути виписку</th>" : "<th></th>"}</tr></thead>
    <tbody>${accs.map((a) => `<tr data-acc="${esc(a.id)}"><td>${esc(a.name)}</td><td class="small">${esc(a.iban || "")}</td>
      <td class="num">${a.balance != null ? nf.format(a.balance / 100) + " " + (CUR[a.currency] || a.currency) : ""}</td>
      <td class="num">${Object.values(S.tx).filter((t) => t.account_id === a.id).length}</td>
      <td><input type="checkbox" data-field="is_fop" ${a.is_fop ? "checked" : ""}></td>
      <td>${withToggle ? `<input type="checkbox" data-field="enabled" ${a.enabled ? "checked" : ""}>` : `<button class="btn ghost danger" data-del-acc>Видалити</button>`}</td></tr>`).join("")}</tbody></table></div>`;
  $("#connections").innerHTML = (groups.map(({ conn: c, accounts }) => `
    <div class="card conn" data-id="${c.id}">
      <div class="conn-head"><div><h3>${esc(c.name)}</h3>
        <div class="muted small">${c.bridge_url ? "Через міст Google Apps Script" : `Токен ${esc(c.token.slice(0, 4))}…${esc(c.token.slice(-4))}`} · ${c.last_sync_at ? "оновлено " + new Date(c.last_sync_at * 1000).toLocaleString("uk-UA") : "ще не оновлювалось"}</div>
        ${c.last_error ? `<div class="error small">Помилка: ${esc(c.last_error)}</div>` : ""}</div>
        <div class="conn-actions"><button class="btn" data-act="sync">Оновити виписку</button><button class="btn danger" data-act="delete">Видалити</button></div></div>
      ${accTable(accounts, true)}</div>`).join("")
    + (files.length ? `<div class="card conn"><div class="conn-head"><div><h3>Імпортовані з файлів</h3><div class="muted small">Щоб оновити — імпортуйте нову виписку, дублікати пропускаються</div></div></div>${accTable(files, false)}</div>` : ""))
    || `<p class="muted">Ще немає підключених банків.</p>`;
  $("#sync-interval").textContent = "Автооновлення: при відкритті програми та щогодини, поки вона відкрита";
  $("#sync-log").innerHTML = S.log.slice(0, 40).map((l) => `<li class="${l.level}">${new Date(l.ts * 1000).toLocaleString("uk-UA")} — ${esc(l.message)}</li>`).join("") || `<li class="muted">Порожньо</li>`;
}

$("#connections").addEventListener("click", (e) => {
  if ("delAcc" in e.target.dataset) {
    const id = e.target.closest("tr").dataset.acc;
    if (!confirm("Видалити цей рахунок разом з усіма його операціями?")) return;
    delete S.accounts[id];
    for (const k of Object.keys(S.tx)) if (S.tx[k].account_id === id) delete S.tx[k];
    save(true); loadBanks(); return;
  }
  const act = e.target.dataset.act;
  if (!act) return;
  const id = Number(e.target.closest(".conn").dataset.id);
  if (act === "sync") { syncAll(id, true); toast("Оновлення запущено"); }
  if (act === "delete") {
    if (!confirm("Видалити підключення разом з усіма його операціями?")) return;
    S.connections = S.connections.filter((c) => c.id !== id);
    for (const a of Object.values(S.accounts)) if (a.connection_id === id) delete S.accounts[a.id];
    for (const k of Object.keys(S.tx)) if (!S.accounts[S.tx[k].account_id]) delete S.tx[k];
    save(true); loadBanks(); toast("Підключення видалено");
  }
});
$("#connections").addEventListener("change", (e) => {
  const f = e.target.dataset.field;
  if (!f) return;
  const acc = S.accounts[e.target.closest("tr").dataset.acc];
  acc[f] = e.target.checked;
  if (f === "is_fop") reclassifyAll();
  if (f === "enabled" && acc.enabled) syncAll(acc.connection_id);
  save(); toast("Збережено");
});

$("#form-mono").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target, btn = $("button", f), token = f.token.value.trim();
  if (S.connections.some((c) => c.token === token)) return toast("Цей токен уже підключено", true);
  btn.disabled = true; btn.textContent = "Підключаю…";
  try {
    const c = await addMono(token);
    f.reset();
    toast(`Підключено: ${c.name}. Завантажую виписку — не закривайте вкладку.`);
    loadBanks();
    syncAll(c.id);
  } catch (err) { toast(err.message, true); setStatus(""); }
  btn.disabled = false; btn.textContent = "Підключити";
});

$("#form-import").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try { await startImport(f.file.files[0], f.account.value.trim() || "Імпортований рахунок"); f.file.value = ""; }
  catch (err) { toast(err.message, true); }
});

$("#btn-backup").addEventListener("click", () => {
  const copy = JSON.parse(JSON.stringify(S));
  download(`fop-dokhid-backup_${kyivDate(nowTs())}.json`, JSON.stringify(copy), "application/json");
  toast("Резервну копію збережено. У ній є токен банку — зберігайте файл у надійному місці.");
});
$("#restore-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.tx || !data.accounts) throw new Error("Це не резервна копія ФОП-доходу");
    if (!confirm(SERVER_MODE ? "Замінити дані на сервері (на всіх пристроях) даними з резервної копії?" : "Замінити поточні дані даними з резервної копії?")) return;
    const fresh = Object.assign(freshState(), data);
    if (SERVER_MODE) { for (const k of Object.keys(S)) delete S[k]; Object.assign(S, fresh); } else S = fresh;
    save(true); toast("Дані відновлено"); openTab("overview");
  } catch (err) { toast(err.message, true); }
  e.target.value = "";
});
$("#btn-wipe").addEventListener("click", () => {
  if (!confirm("Видалити всі дані та токени з цього браузера? Без резервної копії їх не повернути.")) return;
  if (SERVER_MODE) { for (const k of Object.keys(S)) delete S[k]; Object.assign(S, freshState()); R.wipe = true; } else S = freshState();
  allowWipe = true; save(true); allowWipe = false; toast("Усі дані видалено"); openTab("overview");
});

$("#btn-sync-all").addEventListener("click", () => {
  if (!S.connections.length) return toast("Немає підключених через API банків. Додайте Monobank або ПриватБанк на вкладці «Банки».");
  syncAll(null, true); toast("Оновлення запущено");
});

// ============================================================ правила
function loadRules() {
  const fields = { any: "будь-де", description: "призначення", counter_name: "контрагент", counter_edrpou: "ЄДРПОУ", comment: "коментар" };
  const dirs = { in: "надходження", out: "списання", any: "будь-який" };
  $("#rules-table").innerHTML = `<thead><tr><th>Текст</th><th>Де</th><th>Напрям</th><th>Категорія</th><th></th></tr></thead>
    <tbody>${[...S.rules].sort((a, b) => a.priority - b.priority || a.id - b.id).map((r) => `<tr><td>«${esc(r.pattern)}»</td><td>${fields[r.field] || r.field}</td><td>${dirs[r.direction]}</td>
      <td>${esc(CATEGORIES[r.category] || r.category)}</td><td class="num"><button class="btn ghost danger" data-del="${r.id}">Видалити</button></td></tr>`).join("")}</tbody>`;
}
$("#rules-table").addEventListener("click", (e) => {
  if (!e.target.dataset.del) return;
  S.rules = S.rules.filter((r) => r.id !== Number(e.target.dataset.del));
  toast(`Правило видалено, перекласифіковано: ${reclassifyAll()}`);
  loadRules();
});
$("#form-rule").addEventListener("submit", (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  if (!d.pattern.trim()) return;
  S.rules.push({ id: newId(), pattern: d.pattern.trim(), field: d.field, direction: d.direction, category: d.category, priority: 50 });
  e.target.reset();
  toast(`Правило додано, перекласифіковано: ${reclassifyAll()}`);
  loadRules();
});

// ============================================================ налаштування
function loadSettings() {
  const f = $("#form-settings"), s = S.settings;
  f.owner_name.value = s.owner_name || ""; f.owner_tax_id.value = s.owner_tax_id || "";
  f.sync_start.value = s.sync_start || ""; f.esv_enabled.checked = !!s.esv_enabled;
  const cols = [["min_wage", "Мін. зарплата"], ["income_limit", "Ліміт доходу"], ["esv_month", "ЄСВ / міс"], ["single_tax_rate", "ЄП, %"], ["mil_rate", "ВЗ, %"]];
  const years = Object.keys(S.taxParams).map(Number).sort((a, b) => b - a);
  const next = Math.max(...years, new Date().getFullYear()) + 1;
  const rows = [[next, {}, true], ...years.map((y) => [y, S.taxParams[y], false])];
  $("#params-table").innerHTML = `<thead><tr><th>Рік</th>${cols.map(([, l]) => `<th>${l}</th>`).join("")}<th></th></tr></thead>
    <tbody>${rows.map(([y, p, isNew]) => `<tr data-year="${y}"><td>${y}${isNew ? " <span class='muted small'>(новий)</span>" : ""}</td>
      ${cols.map(([k]) => `<td><input type="number" step="0.01" name="${k}" value="${p[k] ?? ""}" style="width:120px"></td>`).join("")}
      <td><button class="btn" data-save>Зберегти</button></td></tr>`).join("")}</tbody>`;
}
$("#form-settings").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target, startChanged = f.sync_start.value && f.sync_start.value !== S.settings.sync_start;
  Object.assign(S.settings, { owner_name: f.owner_name.value.trim(), owner_tax_id: f.owner_tax_id.value.trim(), esv_enabled: f.esv_enabled.checked });
  if (startChanged) S.settings.sync_start = f.sync_start.value; // якщо дата раніша — історія догрузиться автоматично
  reclassifyAll(); save(true);
  toast(startChanged ? "Збережено. Виписки буде перезавантажено з нової дати." : "Збережено");
  if (startChanged && S.connections.length) syncAll();
});
$("#params-table").addEventListener("click", (e) => {
  if (!("save" in e.target.dataset)) return;
  const tr = e.target.closest("tr");
  const p = Object.fromEntries($$("input", tr).map((i) => [i.name, Number(i.value)]));
  if (Object.values(p).some((v) => !isFinite(v) || v <= 0)) return toast("Заповніть усі параметри числами", true);
  S.taxParams[tr.dataset.year] = p; save(true); toast("Параметри збережено"); loadSettings();
});

// ============================================================ старт
async function boot() {
if (SERVER_MODE) {
  try { await remoteBoot(); }
  catch (e) {
    document.body.innerHTML = `<div class="login"><div class="card login-card"><h1>ФОП-дохід</h1><p class="error">${esc(e.message)}</p><button class="btn primary" onclick="location.reload()">Спробувати ще раз</button></div></div>`;
    return;
  }
} else load();
// Нові стандартні правила додаються до вже збережених (видалені користувачем раніше правила не повертаємо)
if ((S.rulesVersion || 1) < RULES_VERSION) {
  const have = new Set(S.rules.map((r) => norm(r.pattern)));
  const added = DEFAULT_RULES.filter((r) => r.since > (S.rulesVersion || 1) && !have.has(norm(r.pattern)));
  for (const { since, ...r } of added) S.rules.push({ ...r, id: newId() });
  S.rulesVersion = RULES_VERSION;
  const n = reclassifyAll();
  if (added.length) log("info", `Додано стандартні правила: ${added.map((r) => "«" + r.pattern + "»").join(", ")}; перекласифіковано операцій: ${n}`);
  save(true);
}
if (S.commissionParser !== COMMISSION_PARSER_VERSION) {
  for (const t of Object.values(S.tx)) detectCommission(t);
  S.commissionParser = COMMISSION_PARSER_VERSION;
  save(true);
}
const catOpts = Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
$("#f-category").innerHTML = `<option value="">Усі</option><option value="__review">Чекають підтвердження</option>` + catOpts;
$("#rule-category").innerHTML = catOpts;
openTab((location.hash.slice(1) in loaders) ? location.hash.slice(1) : "overview");
addEventListener("hashchange", () => { const t = location.hash.slice(1); if (t in loaders && t !== activeTab) openTab(t); });
initPrivatForm();
setStatus("");
renderBanner();
if (S.connections.length) setTimeout(() => syncAll(), 500);
setInterval(() => { if (S.connections.length) syncAll(); }, 60 * 60 * 1000);
}
boot();
window.__fop = { get S() { return S; }, summary, syncAll, R }; // для діагностики
