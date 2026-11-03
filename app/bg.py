"""Фонова робота сервера: оновлення виписок і облікових даних з Кабінету, зберігання ключа КЕП.

Сама робота з банками й Кабінетом виконується в Node (app/node/worker.js) тим самим кодом, що й у браузері.
Результат зливається зі станом на сервері так само, як зливаються зміни двох пристроїв (merge3 —
порт standalone/remote.js), тож правки, зроблені в програмі під час оновлення, не губляться.

Ключ КЕП зберігається окремо від даних програми (таблиця kep_store, не потрапляє ні в браузер, ні в
резервні копії) і лише зашифрованим: шифрує і розшифровує воркер ключем, похідним від SECRET_KEY.

Усе — окремо для кожного профілю ФОП (pid): свій стан, свій ключ, свій стан фонової роботи. Одночасно для
одного ФОП виконується лише одна операція; на весь сервер — не більше WORKER_SLOTS процесів Node.
"""
import copy
import json
import os
import shutil
import subprocess
import threading
import time
import traceback

from . import config, db, store, accounts

WORKER = os.path.join(config.BASE_DIR, "app", "node", "worker.js")
MISSING = object()
TAX_REFRESH_SEC = 24 * 3600
FISCAL_REFRESH_SEC = 6 * 3600
_slots = threading.BoundedSemaphore(max(1, int(os.environ.get("WORKER_SLOTS", "2"))))
_locks = {}
_locks_mx = threading.Lock()
_status = {}
loop_status = {"next_at": None}

SCHEMA = """
CREATE TABLE IF NOT EXISTS kep_keys (
    profile_id INTEGER PRIMARY KEY,
    blob TEXT NOT NULL,
    info TEXT,
    created_at INTEGER NOT NULL,
    created_by INTEGER
);
"""


class WorkerError(Exception):
    pass


def init():
    db.connect().executescript(SCHEMA)
    db.connect().commit()


def status(pid):
    return _status.setdefault(pid, {"running": None, "last_sync_at": None, "last_error": None})


def node_available():
    return bool(shutil.which(config.NODE_BIN))


def kep_secret():
    """Секрет для шифрування ключа — лише зі змінних середовища (не з бази, де лежить сам ключ)."""
    return os.environ.get("KEP_SECRET") or os.environ.get("SECRET_KEY") or ""


def api_config():
    return {"mono": config.MONO_API, "nbu": config.NBU_API, "privat": config.PRIVAT_API, "tax": config.TAX_API,
            "cmpTest": config.CMP_TEST_URL or "", "fiscal": config.FISCAL_API, "monoInterval": int(config.MONO_MIN_INTERVAL_SEC * 1000),
            "maxRunMs": int(os.environ.get("SYNC_MAX_RUN_SEC", "480")) * 1000}


def run_node(req, timeout=3000, wait=120):
    if not node_available():
        raise WorkerError("На сервері немає Node.js — фонове оновлення недоступне")
    if not _slots.acquire(timeout=wait):
        raise WorkerError("Сервер зараз зайнятий оновленням інших ФОП — спробуйте за кілька хвилин")
    try:
        req = dict(req, api=api_config())
        try:
            p = subprocess.run([config.NODE_BIN, WORKER], input=json.dumps(req, ensure_ascii=False), capture_output=True,
                               text=True, timeout=timeout, encoding="utf-8")
        except subprocess.TimeoutExpired:
            raise WorkerError("Оновлення триває задовго й перерване") from None
    finally:
        _slots.release()
    if p.stderr and os.environ.get("WORKER_LOG") == "1":
        print("[worker]", p.stderr[-2000:])
    try:
        out = json.loads(p.stdout or "{}")
    except ValueError:
        raise WorkerError("Воркер повернув некоректну відповідь") from None
    if "error" in out:
        raise WorkerError(out["error"])
    return out


# ---------------------------------------------------------------- злиття (як merge3 у standalone/remote.js)
def _is_id_list(v):
    return isinstance(v, list) and all(isinstance(x, dict) and x.get("id") is not None for x in v)


def merge3(base, ours, theirs):
    if isinstance(ours, dict) and isinstance(theirs, dict):
        b = base if isinstance(base, dict) else {}
        for k in set(ours) | set(theirs):
            v = merge3(b.get(k, MISSING), ours.get(k, MISSING), theirs.get(k, MISSING))
            if v is MISSING:
                ours.pop(k, None)
            else:
                ours[k] = v
        return ours
    if _is_id_list(ours) and _is_id_list(theirs) and (base is MISSING or _is_id_list(base)):
        as_map = lambda lst: {str(x["id"]): x for x in (lst if isinstance(lst, list) else [])}
        m = merge3(as_map(base), as_map(ours), as_map(theirs))
        order = list(dict.fromkeys([str(x["id"]) for x in theirs] + [str(x["id"]) for x in ours]))
        return [m[i] for i in order if i in m]
    if ours == base or (ours is MISSING and base is MISSING):
        return copy.deepcopy(theirs) if theirs is not MISSING else MISSING
    return ours


def _merge_log(a, b):
    seen, out = set(), []
    for item in (a or []) + (b or []):
        k = (item.get("ts"), item.get("message"))
        if k not in seen:
            seen.add(k)
            out.append(item)
    return sorted(out, key=lambda x: -(x.get("ts") or 0))[:200]


def apply_result(pid, base, result):
    """Зливає результат воркера (зміни відносно base) з поточним станом профілю на сервері й записує."""
    for _ in range(10):
        cur = store.get(pid)
        theirs = cur["state"] or {}
        ours = copy.deepcopy(result)
        log = _merge_log(ours.get("log"), theirs.get("log"))
        next_id = max(ours.get("nextId") or 0, theirs.get("nextId") or 0)
        merged = merge3(base if base is not None else {}, ours, theirs)
        merged["log"], merged["nextId"] = log, next_id
        try:
            v = store.put(pid, merged, cur["version"], device="server")
            _sync_profile(pid, merged)
            return v
        except store.Conflict:
            continue
    raise WorkerError("Не вдалося записати результат — дані надто часто змінюються")


def _sync_profile(pid, state):
    """Назва, РНОКПП і група ФОП у списку профілів — з даних програми (Налаштування / Кабінет)."""
    s = (state or {}).get("settings") or {}
    accounts.update_profile(pid, name=s.get("owner_name") or None, tin=s.get("owner_tax_id") or None,
                            fop_group=s.get("fop_group") if s.get("fop_group") is not None else None)


# ---------------------------------------------------------------- операції
def _locked(fn):
    """Для одного ФОП одночасно — лише одна фонова операція (перший аргумент — pid)."""
    def wrapper(pid, *a, **kw):
        with _locks_mx:
            lk = _locks.setdefault(pid, threading.Lock())
        if not lk.acquire(timeout=0.1):
            raise WorkerError("Сервер зараз уже оновлює дані цього ФОП — спробуйте за хвилину")
        try:
            return fn(pid, *a, **kw)
        finally:
            lk.release()
    wrapper.__name__ = fn.__name__
    return wrapper


@_locked
def sync_banks(pid):
    state = store.get(pid)["state"]
    if not state or not state.get("connections"):
        return False
    lock = store.acquire_sync(pid, "server", ttl=3600)
    if not lock.get("granted"):
        return False  # зараз оновлює браузер — спробуємо наступного разу
    st = status(pid)
    st["running"] = "sync"
    try:
        out = run_node({"cmd": "sync", "state": state}, timeout=1200, wait=1800)
        apply_result(pid, state, out["state"])
        st["last_sync_at"], st["last_error"] = int(time.time()), None
        return "more" if out.get("more") else True
    except WorkerError as e:
        st["last_error"] = str(e)
        raise
    finally:
        st["running"] = None
        store.release_sync(pid, "server")


def _kep_row(pid):
    return db.q1("SELECT blob, info, created_at FROM kep_keys WHERE profile_id=?", (pid,))


def kep_get(pid):
    r = _kep_row(pid)
    if not r:
        return {"stored": False}
    return {"stored": True, "info": json.loads(r["info"] or "null"), "created_at": r["created_at"]}


def kep_open(files, password):
    """Відкриває ключ у воркері, перевіряє строк дії і повертає {blob (зашифрований ключ), info (сертифікат)}."""
    secret = kep_secret()
    if len(secret) < 16:
        raise WorkerError("На сервері не задано SECRET_KEY — ключ не можна безпечно зберегти")
    out = run_node({"cmd": "kep-store", "files": files, "password": password, "secret": secret,
                    "skipExpiry": os.environ.get("KEP_TEST_SKIP_EXPIRY") == "1"}, timeout=180)
    return {"blob": out["blob"], "info": out.get("info") or {}}


def kep_put(pid, opened, uid=None):
    db.ex("INSERT INTO kep_keys(profile_id, blob, info, created_at, created_by) VALUES (?, ?, ?, ?, ?) "
          "ON CONFLICT(profile_id) DO UPDATE SET blob=excluded.blob, info=excluded.info, created_at=excluded.created_at, "
          "created_by=excluded.created_by",
          (pid, opened["blob"], json.dumps(opened.get("info"), ensure_ascii=False), int(time.time()), uid))


@_locked
def kep_save(pid, files, password, uid=None):
    opened = kep_open(files, password)
    tin = str((opened["info"] or {}).get("tin") or "")
    p = accounts.profile(pid)
    if tin and p and p["tin"] and tin != p["tin"]:
        raise WorkerError(f"Цей ключ належить іншому платнику (РНОКПП {tin}), а не ФОП {p['tin']}")
    kep_put(pid, opened, uid)
    return opened["info"]


def kep_delete(pid):
    db.ex("DELETE FROM kep_keys WHERE profile_id=?", (pid,))


def _need_key(pid):
    r = _kep_row(pid)
    if not r:
        raise WorkerError("Ключ КЕП не збережено на сервері — збережіть його на вкладці «Облікові дані»")
    return r


@_locked
def tax_refresh(pid):
    r = _need_key(pid)
    state = store.get(pid)["state"]   # для нового ФОП даних ще немає — воркер почне з порожніх
    st = status(pid)
    st["running"] = "tax"
    try:
        out = run_node({"cmd": "tax-refresh", "state": state, "blob": r["blob"], "secret": kep_secret()}, timeout=300)
        apply_result(pid, state, out["state"])
        return (out["state"].get("tax") or {})
    finally:
        st["running"] = None


@_locked
def tax_budget(pid, year):
    """Стан розрахунків з бюджетом за попередній рік (вкладка «Податки» → Рік)."""
    r = _need_key(pid)
    state = store.get(pid)["state"]
    if not state:
        raise WorkerError("Немає даних програми")
    st = status(pid)
    st["running"] = "tax"
    try:
        out = run_node({"cmd": "tax-budget", "state": state, "year": int(year), "blob": r["blob"], "secret": kep_secret()}, timeout=600)
        apply_result(pid, state, out["state"])
        return {"error": out.get("error")}
    finally:
        st["running"] = None


@_locked
def fiscal_sync(pid):
    """Фіскальні чеки ПРРО з фіскального сервера ДПС (вкладка «Фіскальні чеки»). Повертає {"more", "error"}."""
    r = _need_key(pid)
    state = store.get(pid)["state"]
    if not state:
        raise WorkerError("Немає даних програми")
    st = status(pid)
    st["running"] = "fiscal"
    try:
        out = run_node({"cmd": "fiscal", "state": state, "blob": r["blob"], "secret": kep_secret()}, timeout=1200)
        apply_result(pid, state, out["state"])
        f = out["state"].get("fiscal") or {}
        return {"more": bool(out.get("more")), "error": f.get("error")}
    finally:
        st["running"] = None


# ---------------------------------------------------------------- планувальник
def _profile_round(pid):
    """Повертає True, якщо для цього ФОП ще є що довантажувати (наступне коло — за хвилину)."""
    more = False
    try:
        if sync_banks(pid) == "more":
            more = True  # історія ще довантажується: частину збережено, наступна — за хвилину
    except WorkerError as e:
        print(f"ФОП #{pid}: фонове оновлення виписок:", e)
    except Exception:
        traceback.print_exc()
    try:
        st = store.get(pid)["state"] or {}
        fetched = ((st.get("tax") or {}).get("fetched_at")) or 0
        if kep_get(pid)["stored"] and time.time() - fetched > TAX_REFRESH_SEC:
            tax_refresh(pid)
    except WorkerError as e:
        print(f"ФОП #{pid}: оновлення облікових даних:", e)
    except Exception:
        traceback.print_exc()
    try:
        # фіскальні чеки — лише якщо їх уже вмикали на вкладці (є знайдені ПРРО)
        f = (store.get(pid)["state"] or {}).get("fiscal") or {}
        if f.get("registrars") and kep_get(pid)["stored"] and (f.get("more") or time.time() - (f.get("fetched_at") or 0) > FISCAL_REFRESH_SEC):
            if fiscal_sync(pid).get("more"):
                more = True
    except WorkerError as e:
        print(f"ФОП #{pid}: фіскальні чеки:", e)
    except Exception:
        traceback.print_exc()
    return more


def _loop():
    time.sleep(90)  # дати серверу запуститися
    while True:
        loop_status["next_at"] = int(time.time()) + config.SYNC_INTERVAL_MIN * 60
        for pid in store.profiles_with_state():
            if _profile_round(pid):
                loop_status["next_at"] = min(loop_status["next_at"], int(time.time()) + 60)
        time.sleep(max(60, loop_status["next_at"] - time.time()))


def start_fiscal(pid):
    """Ручне оновлення чеків: частини одна за одною, поки є що довантажувати (і далі — фоновий цикл)."""
    def run():
        for _ in range(30):
            try:
                if not fiscal_sync(pid).get("more"):
                    break
            except WorkerError as e:
                print(f"ФОП #{pid}: фіскальні чеки:", e)
                break
            except Exception:
                traceback.print_exc()
                break
    threading.Thread(target=run, name=f"fiscal-{pid}", daemon=True).start()


def start():
    if not node_available():
        print("⚠  Node.js не знайдено — фонове оновлення вимкнено")
        return
    threading.Thread(target=_loop, name="bg-sync", daemon=True).start()
