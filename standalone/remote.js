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
let loginWaiter = null;
async function api(method, path, body, opts = {}) {
  const init = { method, credentials: "same-origin", headers: {} };
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
  return { ok: r.ok, status: r.status, data };
}

function showLogin() {
  if (loginWaiter) return loginWaiter;
  const box = $("#login"), form = $("#login-form"), err = $("#login-error");
  box.classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#login-password").focus();
  loginWaiter = new Promise((resolve) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = "";
      const res = await api("POST", "/api/login", JSON.stringify({ password: $("#login-password").value }), { noLogin: true })
        .catch((x) => ({ ok: false, data: { error: x.message } }));
      if (!res.ok) { err.textContent = res.data.error || "Не вдалося увійти"; return; }
      $("#login-password").value = "";
      box.classList.add("hidden");
      $("#app").classList.remove("hidden");
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
  const me = await api("GET", "/api/me", undefined, { noLogin: true });
  if (!me.data.auth_required && !me.data.authenticated) throw new Error("На сервері не задано пароль. Додайте змінну APP_PASSWORD у налаштуваннях сервера (Railway → Variables) і оновіть сторінку.");
  if (me.data.auth_required && !me.data.authenticated) await showLogin();
  $("#app").classList.add("hidden"); // показуємо програму лише після завантаження даних (інакше клік по вкладці — до появи S)
  const res = await api("GET", "/api/state");
  if (!res.ok) throw new Error(res.data.error || "Не вдалося завантажити дані з сервера");
  R.version = res.data.version;
  R.base = res.data.state ? JSON.parse(JSON.stringify(res.data.state)) : null;
  load(res.data.state);
  $("#app").classList.remove("hidden");
  if (!R.base || !sameJSON(R.base, S)) save();
  setInterval(pollRemote, 20000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollRemote(); });
  addEventListener("beforeunload", (e) => { if (R.changes || R.pushing) { e.preventDefault(); e.returnValue = ""; } });
  adaptUiForServer();
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
    refreshActive(); renderBanner(); setStatus(statusText);
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
    out.onclick = async () => { await api("POST", "/api/logout", "{}", { noLogin: true }); location.reload(); };
  }
}
