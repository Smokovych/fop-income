"""Фонова робота сервера: оновлення виписок і облікових даних з Кабінету, зберігання ключа КЕП.

Сама робота з банками й Кабінетом виконується в Node (app/node/worker.js) тим самим кодом, що й у браузері.
Результат зливається зі станом на сервері так само, як зливаються зміни двох пристроїв (merge3 —
порт standalone/remote.js), тож правки, зроблені в програмі під час оновлення, не губляться.

Ключ КЕП зберігається окремо від даних програми (таблиця kep_store, не потрапляє ні в браузер, ні в
резервні копії) і лише зашифрованим: шифрує і розшифровує воркер ключем, похідним від SECRET_KEY.
"""
import copy
import json
import os
import shutil
import subprocess
import threading
import time
import traceback

from . import config, db, store

WORKER = os.path.join(config.BASE_DIR, "app", "node", "worker.js")
MISSING = object()
TAX_REFRESH_SEC = 24 * 3600
_run_lock = threading.Lock()   # одночасно — лише одна фонова операція
status = {"running": None, "last_sync_at": None, "last_error": None, "next_at": None}

SCHEMA = """
CREATE TABLE IF NOT EXISTS kep_store (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    blob TEXT NOT NULL,
    info TEXT,
    created_at INTEGER NOT NULL
);
"""


class WorkerError(Exception):
    pass


def init():
    db.connect().executescript(SCHEMA)
    db.connect().commit()


def node_available():
    return bool(shutil.which(config.NODE_BIN))


def kep_secret():
    """Секрет для шифрування ключа — лише зі змінних середовища (не з бази, де лежить сам ключ)."""
    return os.environ.get("KEP_SECRET") or os.environ.get("SECRET_KEY") or ""


def api_config():
    return {"mono": config.MONO_API, "nbu": config.NBU_API, "privat": config.PRIVAT_API, "tax": config.TAX_API,
            "cmpTest": config.CMP_TEST_URL or "", "monoInterval": int(config.MONO_MIN_INTERVAL_SEC * 1000)}


def run_node(req, timeout=3000):
    if not node_available():
        raise WorkerError("На сервері немає Node.js — фонове оновлення недоступне")
    req = dict(req, api=api_config())
    try:
        p = subprocess.run([config.NODE_BIN, WORKER], input=json.dumps(req, ensure_ascii=False), capture_output=True,
                           text=True, timeout=timeout, encoding="utf-8")
    except subprocess.TimeoutExpired:
        raise WorkerError("Оновлення триває задовго й перерване") from None
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


def apply_result(base, result):
    """Зливає результат воркера (зміни відносно base) з поточним станом на сервері й записує."""
    for _ in range(10):
        cur = store.get()
        theirs = cur["state"] or {}
        ours = copy.deepcopy(result)
        log = _merge_log(ours.get("log"), theirs.get("log"))
        next_id = max(ours.get("nextId") or 0, theirs.get("nextId") or 0)
        merged = merge3(base, ours, theirs)
        merged["log"], merged["nextId"] = log, next_id
        try:
            return store.put(merged, cur["version"], device="server")
        except store.Conflict:
            continue
    raise WorkerError("Не вдалося записати результат — дані надто часто змінюються")


# ---------------------------------------------------------------- операції
def _locked(fn):
    def wrapper(*a, **kw):
        if not _run_lock.acquire(timeout=0.1):
            raise WorkerError("Сервер зараз уже оновлює дані — спробуйте за хвилину")
        try:
            return fn(*a, **kw)
        finally:
            _run_lock.release()
    return wrapper


@_locked
def sync_banks():
    cur = store.get()
    state = cur["state"]
    if not state or not state.get("connections"):
        return False
    lock = store.acquire_sync("server", ttl=3600)
    if not lock.get("granted"):
        return False  # зараз оновлює браузер — спробуємо наступного разу
    status["running"] = "sync"
    try:
        out = run_node({"cmd": "sync", "state": state})
        apply_result(state, out["state"])
        status["last_sync_at"], status["last_error"] = int(time.time()), None
        return True
    except WorkerError as e:
        status["last_error"] = str(e)
        raise
    finally:
        status["running"] = None
        store.release_sync("server")


def kep_get():
    r = db.q1("SELECT info, created_at FROM kep_store WHERE id=1")
    if not r:
        return {"stored": False}
    return {"stored": True, "info": json.loads(r["info"] or "null"), "created_at": r["created_at"]}


@_locked
def kep_save(files, password):
    secret = kep_secret()
    if len(secret) < 16:
        raise WorkerError("На сервері не задано SECRET_KEY — ключ не можна безпечно зберегти")
    out = run_node({"cmd": "kep-store", "files": files, "password": password, "secret": secret,
                    "skipExpiry": os.environ.get("KEP_TEST_SKIP_EXPIRY") == "1"}, timeout=180)
    db.ex("INSERT INTO kep_store(id, blob, info, created_at) VALUES (1, ?, ?, ?) "
          "ON CONFLICT(id) DO UPDATE SET blob=excluded.blob, info=excluded.info, created_at=excluded.created_at",
          (out["blob"], json.dumps(out.get("info"), ensure_ascii=False), int(time.time())))
    return out.get("info")


def kep_delete():
    db.ex("DELETE FROM kep_store WHERE id=1")


@_locked
def tax_refresh():
    r = db.q1("SELECT blob FROM kep_store WHERE id=1")
    if not r:
        raise WorkerError("Ключ КЕП не збережено на сервері")
    cur = store.get()
    state = cur["state"]
    if not state:
        raise WorkerError("Немає даних програми")
    status["running"] = "tax"
    try:
        out = run_node({"cmd": "tax-refresh", "state": state, "blob": r["blob"], "secret": kep_secret()}, timeout=300)
        apply_result(state, out["state"])
        return (out["state"].get("tax") or {})
    finally:
        status["running"] = None


# ---------------------------------------------------------------- планувальник
def _loop():
    time.sleep(90)  # дати серверу запуститися
    while True:
        status["next_at"] = int(time.time()) + config.SYNC_INTERVAL_MIN * 60
        try:
            sync_banks()
        except WorkerError as e:
            print("Фонове оновлення виписок:", e)
        except Exception:
            traceback.print_exc()
        try:
            st = store.get()["state"] or {}
            fetched = ((st.get("tax") or {}).get("fetched_at")) or 0
            if kep_get()["stored"] and time.time() - fetched > TAX_REFRESH_SEC:
                tax_refresh()
        except WorkerError as e:
            print("Оновлення облікових даних:", e)
        except Exception:
            traceback.print_exc()
        time.sleep(max(60, status["next_at"] - time.time()))


def start():
    if not node_available():
        print("⚠  Node.js не знайдено — фонове оновлення вимкнено")
        return
    threading.Thread(target=_loop, name="bg-sync", daemon=True).start()
