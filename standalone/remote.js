// ============================================================ режим сервера (спільні дані на всіх пристроях)
// Та сама програма працює двома способами:
//  • локально (файл або GitHub Pages) — дані в localStorage цього браузера;
//  • на сервері — дані зберігаються на сервері й однакові на всіх пристроях, запити до банків
//    ідуть через сервер (ПриватБанк — без мосту Google). Сервер підставляє <meta name="fop-mode" content="server">.
// Збереження: увесь стан надсилається на сервер разом з версією, від якої почались зміни. Якщо інший
// пристрій встиг записати новішу версію, зміни об'єднуються (тристороннє злиття: база / наші / їхні)
// і надсилаються ще раз. Об'єкти змінюються на місці, тож синхронізація, що саме йде, нічого не губить.

const SERVER_MODE = (document.querySelector('meta[name="fop-mode"]') || {}).content === "server";
const DEVICE_ID = (() => {
  try {
    let d = localStorage.getItem("fopIncome.device");
    if (!d) { d = randomKey().slice(0, 12); localStorage.setItem("fopIncome.device", d); }
    return d;
  } catch { return randomKey().slice(0, 12); }
})();

const R = { version: 0, base: null, changes: 0, pushing: false, again: false, timer: null, wipe: false, failing: false, retry: null };

// ---------------------------------------------------------------- злиття
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sameJSON = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const isIdArray = (v) => Array.isArray(v) && v.every((x) => isPlain(x) && x.id != null);

function merge3(base, ours, theirs) {
  if (isPlain(ours) && isPlain(theirs)) {
    const b = isPlain(base) ? base : {};
    for (const k of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      const v = merge3(b[k], ours[k], theirs[k]);
      if (v === undefined) delete ours[k]; else ours[k] = v;
    }
    return ours;
  }
  if (isIdArray(ours) && isIdArray(theirs) && (base === undefined || isIdArray(base))) {
    const toMap = (arr) => Object.fromEntries((arr || []).map((x) => [String(x.id), x]));
    const m = merge3(toMap(base), toMap(ours), toMap(theirs));
    const order = [...theirs.map((x) => String(x.id)), ...ours.map((x) => String(x.id))];
    return [...new Set(order)].filter((id) => m[id] !== undefined).map((id) => m[id]);
  }
  if (sameJSON(ours, base)) return theirs === undefined ? undefined : JSON.parse(JSON.stringify(theirs));
  return ours; // змінили обидва — перемагає цей пристрій
}

function mergeLog(a, b) {
  const seen = new Set(), out = [];
  for (const l of [...(a || []), ...(b || [])]) {
    const k = l.ts + "|" + l.message;
    if (!seen.has(k)) { seen.add(k); out.push(l); }
  }
  return out.sort((x, y) => y.ts - x.ts).slice(0, 200);
}

// Вливає в S стан з сервера (theirs), зберігаючи зміни цього пристрою відносно бази.
function absorbRemote(theirs) {
  const log = mergeLog(S.log, theirs.log);
  const nextId = Math.max(S.nextId || 0, theirs.nextId || 0);
  merge3(R.base || {}, S, theirs);
  S.log = log; S.nextId = nextId;
}

// ---------------------------------------------------------------- запити до сервера
// ME — хто увійшов і до яких ФОП має доступ (/api/me); ACTIVE — ФОП, з даними якого зараз працює програма.
// Кожен запит до даних іде із заголовком X-Profile — сервер перевіряє доступ до цього ФОП.
let ME = null, ACTIVE = null;
const PROFILE_KEY = "fopIncome.profile";
let loginWaiter = null;
async function api(method, path, body, opts = {}) {
  const init = { method, credentials: "same-origin", headers: {} };
  if (ACTIVE && !opts.noProfile) init.headers["X-Profile"] = String(ACTIVE.id);
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = body;
    if (opts.gzip) init.headers["Content-Encoding"] = "gzip";
  }
  let r;
  try { r = await fetch(path, init); }
  catch { throw new Error("Немає зв'язку з сервером"); }
  if (r.status === 401 && !opts.noLogin) { await showLogin(); return api(method, path, body, opts); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 403 && ACTIVE && data.error === "Немає доступу до цього ФОП") lostAccess();
  return { ok: r.ok, status: r.status, data };
}

let lostShown = false;
function lostAccess() {
  if (lostShown) return;
  lostShown = true;
  try { localStorage.removeItem(PROFILE_KEY); } catch {}
  R.changes = 0;
  alert("Доступ до цього ФОП більше не надається. Програма відкриє інший ФОП.");
  location.reload();
}

// Вхід і реєстрація (один екран, два режими)
function showLogin() {
  if (loginWaiter) return loginWaiter;
  const box = $("#login"), form = $("#login-form"), err = $("#login-error");
  let mode = "login";
  const setMode = (m) => {
    mode = m;
    for (const b of form.querySelectorAll(".auth-seg button")) b.classList.toggle("active", b.dataset.mode === m);
    for (const el of form.querySelectorAll(".auth-reg")) el.classList.toggle("hidden", m !== "register");
    $("#login-name").required = $("#login-password2").required = m === "register";
    $("#login-password").autocomplete = m === "register" ? "new-password" : "current-password";
    $("#login-submit").textContent = m === "register" ? "Зареєструватися" : "Увійти";
    $("#login-lead").textContent = m === "register"
      ? "Створіть обліковий запис. Далі ви підключите свій ФОП ключем КЕП — або отримаєте доступ до ФОП клієнтів, якщо ви бухгалтер."
      : "Увійдіть, щоб продовжити";
    err.textContent = "";
  };
  form.querySelectorAll(".auth-seg button").forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  setMode("login");
  box.classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#onboard").classList.add("hidden");
  $("#login-email").focus();
  loginWaiter = new Promise((resolve) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = "";
      const email = $("#login-email").value.trim(), password = $("#login-password").value;
      if (mode === "register" && password !== $("#login-password2").value) { err.textContent = "Паролі не збігаються"; return; }
      const body = mode === "register" ? { email, password, name: $("#login-name").value.trim() } : { email, password };
      $("#login-submit").disabled = true;
      const res = await api("POST", mode === "register" ? "/api/register" : "/api/login", JSON.stringify(body), { noLogin: true, noProfile: true })
        .catch((x) => ({ ok: false, data: { error: x.message } }));
      $("#login-submit").disabled = false;
      if (!res.ok) { err.textContent = res.data.error || "Не вдалося увійти"; return; }
      // інший користувач на тому самому пристрої — почати з чистого аркуша
      if (ME && ME.user && ME.user.id !== res.data.user.id) { R.changes = 0; location.reload(); return; }
      ME = res.data;
      $("#login-password").value = $("#login-password2").value = "";
      box.classList.add("hidden");
      if (S) $("#app").classList.remove("hidden");
      loginWaiter = null;
      resolve();
    };
  });
  return loginWaiter;
}

async function gzipText(text) {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------- завантаження і збереження
async function remoteBoot() {
  $("#app").classList.add("hidden");
  const me = await api("GET", "/api/me", undefined, { noLogin: true, noProfile: true });
  if (!me.ok) throw new Error(me.data.error || "Сервер недоступний");
  ME = me.data;
  if (!ME.authenticated) await showLogin();
  ACTIVE = pickProfile();
  if (!ACTIVE) {
    ACTIVE = await showOnboard(false);
    if (ACTIVE) location.hash = "account"; // щойно підключений ФОП — одразу показати облікові дані з Кабінету
  }
  try { localStorage.setItem(PROFILE_KEY, String(ACTIVE.id)); } catch {}
  if (ME.last_profile !== ACTIVE.id) api("POST", `/api/profiles/${ACTIVE.id}/select`, "{}").catch(() => {});
  $("#app").classList.add("hidden"); // показуємо програму лише після завантаження даних (інакше клік по вкладці — до появи S)
  const res = await api("GET", "/api/state");
  if (!res.ok) throw new Error(res.data.error || "Не вдалося завантажити дані з сервера");
  R.version = res.data.version;
  R.base = res.data.state ? JSON.parse(JSON.stringify(res.data.state)) : null;
  load(res.data.state);
  // новий ФОП, для якого Кабінет ще не відповів, — ПІБ і РНОКПП із сертифіката ключа
  if (!S.settings.owner_tax_id && ACTIVE.tin) S.settings.owner_tax_id = ACTIVE.tin;
  if (!S.settings.owner_name && ACTIVE.name) S.settings.owner_name = ACTIVE.name;
  $("#app").classList.remove("hidden");
  if (!R.base || !sameJSON(R.base, S)) save();
  setInterval(pollRemote, 20000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollRemote(); });
  addEventListener("beforeunload", (e) => { if (R.changes || R.pushing) { e.preventDefault(); e.returnValue = ""; } });
  adaptUiForServer();
  initProfileMenu();
}

// Який ФОП відкрити: останній на цьому пристрої → останній на сервері → перший зі списку
function pickProfile() {
  const list = (ME && ME.profiles) || [];
  let saved = null;
  try { saved = Number(localStorage.getItem(PROFILE_KEY)); } catch {}
  return list.find((p) => p.id === saved) || list.find((p) => p.id === ME.last_profile) || list[0] || null;
}

function remoteSave(now) {
  R.changes++;
  clearTimeout(R.timer);
  R.timer = setTimeout(pushRemote, now ? 200 : 2000);
}

function setSaveState(text, isError) {
  const el = $("#save-state");
  if (!el) return;
  el.textContent = text;
  el.className = "muted small" + (isError ? " error" : "");
}

async function pushRemote() {
  if (R.pushing) { R.again = true; return; }
  if (!R.changes) return;
  R.pushing = true;
  const startChanges = R.changes;
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const snapshot = JSON.stringify(S);
      const payload = JSON.stringify({ state: JSON.parse(snapshot), base_version: R.version, device: DEVICE_ID, wipe: R.wipe });
      const gz = await gzipText(payload);
      const res = await api("PUT", "/api/state", gz || payload, { gzip: !!gz });
      if (res.ok) {
        R.version = res.data.version;
        R.base = JSON.parse(snapshot);
        R.wipe = false;
        if (R.changes === startChanges) R.changes = 0;
        if (R.failing) { R.failing = false; toast("Дані знову зберігаються на сервері"); }
        setSaveState("Збережено на сервері");
        return;
      }
      if (res.status === 409 && res.data.error === "conflict") {
        absorbRemote(res.data.state || {});
        R.base = JSON.parse(JSON.stringify(res.data.state || {}));
        R.version = res.data.version;
        refreshActive(); renderBanner();
        continue;
      }
      throw new Error(res.data.error || "HTTP " + res.status);
    }
    throw new Error("Не вдалося об'єднати зміни з іншими пристроями");
  } catch (e) {
    setSaveState("Не збережено на сервері — повторю спробу", true);
    if (!R.failing) { R.failing = true; toast("Не вдалося зберегти на сервері: " + e.message + ". Спробую ще раз.", true); }
    clearTimeout(R.retry);
    R.retry = setTimeout(pushRemote, 30000);
  } finally {
    R.pushing = false;
    if (R.again) { R.again = false; clearTimeout(R.timer); R.timer = setTimeout(pushRemote, 500); }
  }
}

// Негайно записати локальні зміни на сервер (перед дією, яку сервер виконує з цими даними)
async function flushRemote() {
  if (!SERVER_MODE) return;
  for (let i = 0; i < 100 && (R.pushing || R.changes); i++) {
    if (!R.pushing && R.changes) { clearTimeout(R.timer); await pushRemote(); }
    else await sleep(100);
  }
}

// Підтягує зміни з інших пристроїв
async function pollRemote(force) {
  if (R.pushing || loginWaiter) return;
  if (force && R.changes) await pushRemote();
  try {
    const meta = await api("GET", "/api/state/meta", undefined, { noLogin: true });
    if (!meta.ok || meta.data.version <= R.version) return;
    if (R.changes) return pushRemote(); // сервер поверне конфлікт з новими даними — зміни об'єднаються
    const res = await api("GET", "/api/state");
    if (!res.ok || R.pushing || R.changes || !res.data.state) return;
    absorbRemote(res.data.state);
    R.base = JSON.parse(JSON.stringify(res.data.state));
    R.version = res.data.version;
    refreshActive(); renderBanner(); setStatus(statusText); renderBrand();
  } catch {}
}

// ---------------------------------------------------------------- замок синхронізації з банками
let lockTimer = null;
async function acquireSyncLock() {
  if (!SERVER_MODE) return true;
  const res = await api("POST", "/api/sync-lock", JSON.stringify({ device: DEVICE_ID })).catch(() => null);
  if (!res || !res.ok) return true; // сервер недоступний — не блокуємо роботу
  if (!res.data.granted) return false;
  clearInterval(lockTimer);
  lockTimer = setInterval(() => api("POST", "/api/sync-lock", JSON.stringify({ device: DEVICE_ID })).catch(() => {}), 60000);
  return true;
}
function releaseSyncLock() {
  if (!SERVER_MODE) return;
  clearInterval(lockTimer);
  api("POST", "/api/sync-lock", JSON.stringify({ device: DEVICE_ID, release: true })).catch(() => {});
}

// ---------------------------------------------------------------- тексти інтерфейсу для сервера
function adaptUiForServer() {
  const p = $("#data-note");
  if (p) p.textContent = "Дані зберігаються на вашому сервері й однакові на всіх пристроях: телефоні, ноутбуці, планшеті. "
    + "Сервер щодня робить кілька автоматичних копій, але власна резервна копія не завадить — особливо перед поданням декларації.";
  const out = $("#btn-logout");
  if (out) {
    out.hidden = false;
    out.onclick = logout;
  }
}
