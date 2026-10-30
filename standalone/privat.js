// ============================================================ ПриватБанк (Автоклієнт) через «міст» Google Apps Script
// API ПриватБанку не дозволяє браузерним програмам звертатися до нього напряму (немає CORS).
// Тому запити йдуть через невеликий скрипт у Google-акаунті користувача: він тримає токен,
// пропускає лише запити на читання балансів і виписок і повертає відповідь банку як є.
// Документація API: «Опис API для взаємодії з серверною частиною Автоклієнта версія 3.0.0».

function bridgeCode(token, key) {
  return `// Міст ФОП-дохід → ПриватБанк (лише читання балансів і виписок)
const PRIVAT_TOKEN = ${JSON.stringify(token)};
const ACCESS_KEY = ${JSON.stringify(key)};
const ALLOWED = ['statements/settings', 'statements/balance', 'statements/transactions',
  'statements/balance/interim', 'statements/transactions/interim',
  'statements/balance/final', 'statements/transactions/final'];

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.key !== ACCESS_KEY) return out_({ status: 'ERROR', message: 'Невірний ключ доступу до мосту' });
  if (ALLOWED.indexOf(p.path) < 0) return out_({ status: 'ERROR', message: 'Недозволений запит' });
  const q = ['acc', 'startDate', 'endDate', 'followId', 'limit']
    .filter(function (k) { return p[k]; })
    .map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
  const r = UrlFetchApp.fetch('https://acp.privatbank.ua/api/' + p.path + (q ? '?' + q : ''), {
    method: 'get', muteHttpExceptions: true,
    headers: { 'User-Agent': 'fop-income', 'token': PRIVAT_TOKEN, 'Content-Type': 'application/json;charset=utf8' }
  });
  const text = r.getContentText('UTF-8');
  try { JSON.parse(text); } catch (err) {
    return out_({ status: 'ERROR', message: 'ПриватБанк: HTTP ' + r.getResponseCode() + ' ' + text.slice(0, 300) });
  }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

function randomKey() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function privatGet(conn, path, params = {}) {
  const u = new URL(conn.bridge_url);
  u.searchParams.set("key", conn.bridge_key);
  u.searchParams.set("path", path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, v);
  let r;
  try { r = await fetch(u.toString(), { redirect: "follow" }); }
  catch { throw new Error("Немає зв'язку з мостом ПриватБанку. Перевірте адресу мосту та інтернет."); }
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); }
  catch {
    if (/<html/i.test(text)) throw new Error("Міст відповів сторінкою входу Google. У налаштуваннях розгортання оберіть доступ «Усі» (Anyone).");
    throw new Error("Міст повернув некоректну відповідь");
  }
  if (data.status && data.status !== "SUCCESS") throw new Error("ПриватБанк: " + (data.message || data.status));
  return data;
}

async function privatPaged(conn, path, params, key, onPage) {
  let follow = null;
  for (let guard = 0; guard < 1000; guard++) {
    const data = await privatGet(conn, path, { ...params, limit: 100, followId: follow });
    await onPage(data[key] || []);
    if (!data.exist_next_page || !data.next_page_id) break;
    follow = data.next_page_id;
    await sleep(250);
  }
}

const ddmmyyyy = (iso) => iso.split("-").reverse().join("-");
const minor = (s) => Math.round(parseNum(s) * 100);

async function privatAccounts(conn) {
  const today = ddmmyyyy(kyivDate(nowTs()));
  const out = {};
  await privatPaged(conn, "statements/balance", { startDate: today, endDate: today }, "balances", (rows) => {
    for (const b of rows) {
      if (!b.acc) continue;
      out[b.acc] = {
        ext_id: b.acc, iban: b.acc, currency: (b.currency || "UAH").toUpperCase(), type: "business",
        name: `${(b.nameACC || "Рахунок").trim()} ${(b.currency || "").toUpperCase()} …${b.acc.slice(-4)}`.replace(/\s+/g, " "),
        balance: minor(b.balanceOut ?? b.balanceOutEq ?? 0), is_fop: true,
      };
    }
  });
  return Object.values(out);
}

function privatDate(it) {
  const dt = String(it.DATE_TIME_DAT_OD_TIM_P || "").trim();
  if (dt) return parseDateTime(dt);
  return parseDateTime(String(it.DAT_OD || it.DAT_KL || "").trim(), it.TIM_P || undefined);
}

function privatNormalize(it, acc) {
  const ts = privatDate(it);
  if (ts == null) return null;
  if (String(it.FL_REAL || "r").toLowerCase() !== "r") return null;          // інформаційні — пропускаємо
  const st = String(it.PR_PR || "r").toLowerCase();
  if (st === "t" || st === "n") return null;                                 // сторновані / забраковані
  const sum = Math.abs(minor(it.SUM));
  const amount = String(it.TRANTYPE || "").toUpperCase() === "D" ? -sum : sum;
  return {
    ext_id: it.REF ? `${it.REF}.${it.REFN ?? ""}` : String(it.ID), // унікальність — REF+REFN (за документацією)
    ts, amount, currency: String(it.CCY || acc.currency || "UAH").toUpperCase(),
    description: it.OSND || "", comment: "",
    counter_name: it.AUT_CNTR_NAM || "", counter_edrpou: it.AUT_CNTR_CRF || "", counter_iban: it.AUT_CNTR_ACC || "",
    hold: st === "p" ? 1 : 0,
  };
}

const PRIVAT_CHUNK_DAYS = 31;

// Як і для Monobank: спершу свіжі операції, далі історія назад місяцями; кожен місяць зберігається одразу.
async function syncPrivatAccount(conn, acc) {
  const startIso = S.settings.sync_start;
  const todayIso = kyivDate(nowTs());
  let added = 0;
  const fetchRange = async (fromIso, toIso) => {
    await privatPaged(conn, "statements/transactions", { acc: acc.ext_id, startDate: ddmmyyyy(fromIso), endDate: ddmmyyyy(toIso) }, "transactions",
      async (rows) => {
        const items = rows.map((r) => privatNormalize(r, acc)).filter(Boolean);
        if (items.length) { added += await storeTransactions(acc, items); refreshActive(); }
      });
  };
  const shift = (iso, days) => kyivDate(kyivMidnight(iso) + days * 86400 + 3600);
  if (acc.p_loaded_to) {
    const from = [shift(acc.p_loaded_to, -3), startIso].sort().pop();
    setStatus(`${acc.name}: нові операції`);
    await fetchRange(from, todayIso);
  } else {
    acc.p_loaded_from = shift(todayIso, 1);
  }
  acc.p_loaded_to = todayIso;
  save();
  while (acc.p_loaded_from > startIso) {
    const end = shift(acc.p_loaded_from, -1);
    const begin = [shift(end, -(PRIVAT_CHUNK_DAYS - 1)), startIso].sort().pop();
    syncProgress.current = acc;
    setStatus(`${acc.name}: ${fmtDate(begin)} – ${fmtDate(end)}`);
    await fetchRange(begin, end);
    acc.p_loaded_from = begin;
    save(true);
    renderBanner();
  }
  acc.synced_to = nowTs();
  log("info", `${acc.name}: нових операцій ${added}`);
  save(true);
}

async function syncPrivatConnection(conn) {
  setStatus(`${conn.name}: рахунки…`);
  try { upsertAccounts(conn, await privatAccounts(conn)); }
  catch (e) { if (!Object.values(S.accounts).some((a) => a.connection_id === conn.id)) throw e; log("warn", `${conn.name}: не вдалося оновити рахунки: ${e.message}`); }
  for (const acc of Object.values(S.accounts).filter((a) => a.connection_id === conn.id && a.enabled)) await syncPrivatAccount(conn, acc);
}

function privatMonthsLeft() {
  const startIso = S.settings.sync_start;
  return Object.values(S.accounts).filter((a) => a.bank === "privat" && a.enabled).reduce((n, a) => {
    const from = a.p_loaded_from || kyivDate(nowTs());
    return n + Math.max(0, Math.ceil((kyivMidnight(from) - kyivMidnight(startIso)) / (PRIVAT_CHUNK_DAYS * 86400)));
  }, 0);
}

// ---------------------------------------------------------------- форма підключення
function initPrivatForm() {
  const f = $("#form-privat");
  if (!f) return;
  // ключ мосту зберігаємо, щоб він не змінився, якщо сторінку перезавантажать посеред налаштування
  if (!S.privatPendingKey) { S.privatPendingKey = randomKey(); save(); }
  let key = S.privatPendingKey;
  const codeBox = $("#privat-code");
  const renderCode = () => {
    const tok = f.token.value.trim();
    codeBox.value = tok ? bridgeCode(tok, key) : "";
    $("#privat-step2").hidden = !tok;
  };
  f.token.addEventListener("input", renderCode);
  $("#btn-copy-code").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(codeBox.value); toast("Код скопійовано"); }
    catch { codeBox.focus(); codeBox.select(); toast("Натисніть Cmd+C, щоб скопіювати виділений код"); }
  });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = f.bridge.value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url) && !/^http:\/\/127\.0\.0\.1/.test(url)) {
      return toast("Вставте адресу веб-застосунку, яка починається з https://script.google.com/macros/s/…", true);
    }
    if (S.connections.some((c) => c.bridge_url === url)) return toast("Цей міст уже підключено", true);
    const btn = $("button[type=submit]", f);
    btn.disabled = true; btn.textContent = "Перевіряю зв'язок з банком…";
    const conn = { id: S.nextId++, bank: "privat", name: "ПриватБанк", bridge_url: url, bridge_key: key, token: "", owner_name: null, last_sync_at: null, last_error: null, created_at: nowTs() };
    try {
      const accounts = await privatAccounts(conn);
      if (!accounts.length) throw new Error("Банк не повернув жодного рахунку. Перевірте, що в налаштуваннях API дозволено «Отримання балансів і транзакцій».");
      S.connections.push(conn);
      upsertAccounts(conn, accounts);
      log("info", `Додано ПриватБанк, рахунків: ${accounts.length}`);
      save(true);
      f.reset(); key = S.privatPendingKey = randomKey(); save(); renderCode();
      const files = Object.values(S.accounts).filter((a) => a.bank === "file");
      toast(`ПриватБанк підключено, рахунків: ${accounts.length}. Завантажую виписку.` + (files.length ? " Якщо раніше імпортували цей рахунок файлом — видаліть імпорт, щоб не було дублів." : ""));
      loadBanks();
      syncAll(conn.id);
    } catch (err) { toast(err.message, true); }
    btn.disabled = false; btn.textContent = "Підключити";
  });
}
