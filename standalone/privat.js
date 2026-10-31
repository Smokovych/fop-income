// ============================================================ ПриватБанк (Автоклієнт)
// API ПриватБанку не дозволяє браузерним програмам звертатися до нього напряму (немає CORS).
// На сервері запити йдуть через сам сервер (/proxy/privat, токен у підключенні).
// Локально — через невеликий скрипт («міст») у Google-акаунті користувача: він тримає токен,
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
  if (p.path === 'ping') return out_({ status: 'SUCCESS', bridge: 'ok', version: 2, keyOk: p.key === ACCESS_KEY });
  if (p.key !== ACCESS_KEY) return out_({ status: 'ERROR', message: 'Невірний ключ доступу до мосту. Скопіюйте код мосту з програми ще раз.' });
  if (ALLOWED.indexOf(p.path) < 0) return out_({ status: 'ERROR', message: 'Недозволений запит' });
  const q = ['acc', 'startDate', 'endDate', 'followId', 'limit']
    .filter(function (k) { return p[k]; })
    .map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
  let r;
  try {
    r = UrlFetchApp.fetch('https://acp.privatbank.ua/api/' + p.path + (q ? '?' + q : ''), {
      method: 'get', muteHttpExceptions: true,
      headers: { 'User-Agent': 'fop-income', 'token': PRIVAT_TOKEN, 'Content-Type': 'application/json;charset=utf8' }
    });
  } catch (err) {
    return out_({ status: 'ERROR', stage: 'bank', message: "Міст працює, але не зміг з’єднатися з ПриватБанком: " + err });
  }
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

// Адреса веб-застосунку: прибираємо зайве і перевіряємо, що це саме /exec
function cleanBridgeUrl(raw) {
  let url = String(raw || "").trim().replace(/[?#].*$/, "");
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return { url };
  if (!/^https:\/\/script\.google(usercontent)?\.com\/.+/.test(url)) return { error: "Вставте адресу веб-застосунку, яка починається з https://script.google.com/macros/s/…" };
  if (/\/dev$/.test(url)) return { error: "Це тестова адреса (закінчується на /dev) — вона працює лише для вас у Google. Потрібна адреса з розгортання, що закінчується на /exec: «Розгорнути» → «Керувати розгортаннями» → скопіюйте «URL веб-застосунку»." };
  if (/\/macros\/s\/[^/]+$/.test(url)) url += "/exec";
  if (!/\/exec$/.test(url)) return { error: "Адреса мосту має закінчуватися на /exec. Скопіюйте «URL веб-застосунку» з вікна розгортання." };
  return { url };
}

function showBridgeDiag(f, url, key, message) {
  const box = $("#privat-diag", f);
  if (!box) return toast(message, true);
  if (!message) { box.hidden = true; return; }
  const probe = url ? `${url}?path=ping&key=${encodeURIComponent(key)}` : "";
  box.hidden = false;
  box.innerHTML = `<b>Не вдалося підключити ПриватБанк.</b> ${esc(message)}`
    + (probe ? `<ol class="steps small" style="margin:8px 0 0">
      <li><a href="${esc(probe)}" target="_blank" rel="noopener">Відкрийте міст у новій вкладці</a> і подивіться, що там:
        <ul>
          <li><b>текст із <code>"bridge":"ok"</code></b> — міст працює; якщо там <code>"keyOk":false</code>, скопіюйте код мосту з програми ще раз і оновіть розгортання;</li>
          <li><b>сторінка входу Google</b> — у розгортанні вибрано не той доступ: «Розгорнути» → «Керувати розгортаннями» → ✎ → «Хто має доступ»: <b>Усі</b> (не «Усі з обліковим записом Google»);</li>
          <li><b>«Сценарій не знайдено» / помилка або «потрібна авторизація»</b> — у редакторі скрипта натисніть ▶ «Виконати» для doGet і дозвольте доступ, потім створіть нове розгортання;</li>
          <li><b>помилка «Unknown action» або старий текст</b> — у розгортанні стара версія коду: «Керувати розгортаннями» → ✎ → «Версія»: <b>Нова версія</b> → «Розгорнути».</li>
        </ul></li></ol>` : "");
}

function randomKey() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function privatGet(conn, path, params = {}) {
  if (!conn.bridge_url) return typeof PRIVAT_DIRECT_API !== "undefined" ? privatGetDirect(conn, path, params) : privatGetServer(conn, path, params);
  const u = new URL(conn.bridge_url);
  u.searchParams.set("key", conn.bridge_key);
  u.searchParams.set("path", path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, v);
  let r;
  try { r = await fetch(u.toString(), { redirect: "follow" }); }
  catch {
    if (!navigator.onLine) throw new Error("Немає інтернету.");
    const err = new Error("Програма не може прочитати відповідь мосту ПриватБанку. Найчастіше причина — у налаштуваннях розгортання в Google (доступ, адреса /exec) або в старій версії коду мосту.");
    err.bridgeUnreachable = true;
    throw err;
  }
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

// Напряму до API (лише на сервері, у фоновому оновленні — там немає обмежень браузера)
async function privatGetDirect(conn, path, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") q.set(k, v);
  let r;
  try { r = await fetch(`${PRIVAT_DIRECT_API}/${path}?${q}`, { headers: { "User-Agent": "fop-income", token: conn.token, "Content-Type": "application/json;charset=utf8" } }); }
  catch { throw new Error("Немає з'єднання з ПриватБанком"); }
  const data = await r.json().catch(() => null);
  if (!data) throw new Error("ПриватБанк: некоректна відповідь (HTTP " + r.status + ")");
  if (data.status && data.status !== "SUCCESS") throw new Error("ПриватБанк: " + (data.message || data.status));
  if (!r.ok) throw new Error("ПриватБанк: HTTP " + r.status);
  return data;
}

async function privatGetServer(conn, path, params) {
  if (typeof SERVER_MODE === "undefined" || !SERVER_MODE) throw new Error("Це підключення ПриватБанку працює лише на сервері програми");
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") q.set(k, v);
  let r;
  try { r = await fetch(`/proxy/privat/${path}?${q}`, { headers: { "X-Privat-Token": conn.token }, credentials: "same-origin" }); }
  catch { throw new Error("Немає зв'язку з сервером програми"); }
  const data = await r.json().catch(() => null);
  if (!data) throw new Error("ПриватБанк: некоректна відповідь (HTTP " + r.status + ")");
  if (data.error && !data.status) throw new Error(data.error);
  if (data.status && data.status !== "SUCCESS") throw new Error("ПриватБанк: " + (data.message || data.status));
  if (!r.ok) throw new Error("ПриватБанк: HTTP " + r.status);
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
// На сервері міст не потрібен: лише токен
function initPrivatFormServer(f) {
  f.innerHTML = `<h3>ПриватБанк — автоматично через API</h3>
    <ol class="steps">
      <li><b>Токен.</b> Приват24 для бізнесу → «Каталог послуг» → «Інтеграція (Автоклієнт)» → «Підключити API». Поле IP-адрес залиште порожнім. У налаштуваннях застосунку на вкладці «Обмеження по сервісам» увімкніть обмеження й залиште лише «Отримання балансів і транзакцій за рахунками». Скопіюйте токен.</li>
      <li><b>Вставте токен</b> і натисніть «Підключити»:
        <input name="token" placeholder="Токен Автоклієнта" autocomplete="off" style="width:100%;margin-top:6px"></li>
    </ol>
    <button class="btn primary" type="submit">Підключити</button>`;
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = f.token.value.trim();
    if (!token) return toast("Вставте токен Автоклієнта", true);
    if (S.connections.some((c) => c.bank === "privat" && c.token === token)) return toast("Цей токен уже підключено", true);
    const btn = $("button[type=submit]", f);
    btn.disabled = true; btn.textContent = "Перевіряю зв'язок з банком…";
    const conn = { id: 0, bank: "privat", name: "ПриватБанк", bridge_url: null, token, owner_name: null, last_sync_at: null, last_error: null, created_at: nowTs() };
    try {
      const accounts = await privatAccounts(conn);
      if (!accounts.length) throw new Error("Банк не повернув жодного рахунку. Перевірте, що в налаштуваннях API дозволено «Отримання балансів і транзакцій».");
      conn.id = newId();
      S.connections.push(conn);
      upsertAccounts(conn, accounts);
      log("info", `Додано ПриватБанк, рахунків: ${accounts.length}`);
      save(true);
      f.reset();
      toast(`ПриватБанк підключено, рахунків: ${accounts.length}. Завантажую виписку.`);
      loadBanks();
      syncAll(conn.id, true);
    } catch (err) { toast(err.message, true); }
    btn.disabled = false; btn.textContent = "Підключити";
  });
}

function initPrivatForm() {
  const f = $("#form-privat");
  if (!f) return;
  if (typeof SERVER_MODE !== "undefined" && SERVER_MODE) return initPrivatFormServer(f);
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
    const { url, error } = cleanBridgeUrl(f.bridge.value);
    if (error) return showBridgeDiag(f, null, key, error);
    f.bridge.value = url;
    if (S.connections.some((c) => c.bridge_url === url)) return toast("Цей міст уже підключено", true);
    const btn = $("button[type=submit]", f);
    showBridgeDiag(f, null, key, "");
    const conn = { id: 0, bank: "privat", name: "ПриватБанк", bridge_url: url, bridge_key: key, token: "", owner_name: null, last_sync_at: null, last_error: null, created_at: nowTs() };
    try {
      // 1) чи відповідає міст (налаштування Google)
      btn.disabled = true; btn.textContent = "Перевіряю міст…";
      const ping = await privatGet(conn, "ping").catch((err) => {
        if (/Недозволений запит/.test(err.message)) return { old: true }; // старий код мосту без ping — перевіримо далі
        throw err;
      });
      if (ping && ping.keyOk === false) throw new Error("Міст відповідає, але ключ у ньому інший. Скопіюйте код мосту з програми ще раз, вставте в редактор і оновіть розгортання (Версія: «Нова версія»).");
      // 2) чи відповідає банк
      btn.textContent = "Перевіряю зв'язок з банком…";
      const accounts = await privatAccounts(conn);
      if (!accounts.length) throw new Error("Банк не повернув жодного рахунку. Перевірте, що в налаштуваннях API дозволено «Отримання балансів і транзакцій».");
      conn.id = newId();
      S.connections.push(conn);
      upsertAccounts(conn, accounts);
      log("info", `Додано ПриватБанк, рахунків: ${accounts.length}`);
      save(true);
      f.reset(); key = S.privatPendingKey = randomKey(); save(); renderCode();
      const files = Object.values(S.accounts).filter((a) => a.bank === "file");
      toast(`ПриватБанк підключено, рахунків: ${accounts.length}. Завантажую виписку.` + (files.length ? " Якщо раніше імпортували цей рахунок файлом — видаліть імпорт, щоб не було дублів." : ""));
      loadBanks();
      syncAll(conn.id);
    } catch (err) { showBridgeDiag(f, url, key, err.message); }
    btn.disabled = false; btn.textContent = "Підключити";
  });
}
