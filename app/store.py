"""Спільне сховище даних програми для всіх пристроїв.

Браузерна програма тримає всі дані в одному JSON-об'єкті (стан S). На сервері він
зберігається цілком у SQLite разом з номером версії. Пристрій надсилає новий стан
разом з версією, від якої він починав зміни; якщо за цей час інший пристрій уже
записав новішу версію, сервер відповідає конфліктом і повертає актуальний стан —
пристрій об'єднує зміни і надсилає ще раз.

Тут же — «замок» синхронізації з банками: виписки тягне лише один пристрій за раз
(Monobank дозволяє один запит на хвилину на токен).

Кожен профіль ФОП має свій стан (profile_state), свої автокопії і свій замок. Дані, що були на сервері
до появи облікових записів (таблиця app_state), переносяться в окремий профіль — migrate_legacy().
"""
import json
import threading
import time

from . import db

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS profile_state (
    profile_id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
);
CREATE TABLE IF NOT EXISTS profile_state_backup (
    profile_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, version)
);
"""

BACKUP_EVERY_SEC = 6 * 3600   # автоматична копія стану не частіше ніж раз на 6 год
BACKUPS_KEEP = 30


class Conflict(Exception):
    def __init__(self, current):
        super().__init__("conflict")
        self.current = current


class WipeRefused(Exception):
    pass


def init():
    db.connect().executescript(SCHEMA)
    db.connect().commit()


def _row(pid):
    return db.q1("SELECT version, data, updated_at, updated_by FROM profile_state WHERE profile_id=?", (pid,))


def meta(pid):
    r = db.q1("SELECT version, updated_at, updated_by FROM profile_state WHERE profile_id=?", (pid,))
    return r or {"version": 0, "updated_at": None, "updated_by": None}


def get(pid):
    r = _row(pid)
    if not r:
        return {"version": 0, "state": None, "updated_at": None}
    return {"version": r["version"], "state": json.loads(r["data"]), "updated_at": r["updated_at"]}


def _is_empty(state):
    return not (state or {}).get("tx") and not (state or {}).get("connections") and not (state or {}).get("accounts")


def put(pid, state, base_version, device=None, wipe=False):
    """Записує стан профілю, якщо base_version збігається з поточною версією. Повертає нову версію."""
    if not isinstance(state, dict) or "tx" not in state or "accounts" not in state:
        raise ValueError("Некоректні дані програми")
    data = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    with _lock:
        r = _row(pid)
        cur_version = r["version"] if r else 0
        if base_version != cur_version:
            raise Conflict(get(pid))
        # запобіжник: порожній стан не перезаписує дані, якщо це не явне «Видалити всі дані»
        if r and not wipe and _is_empty(state) and not _is_empty(json.loads(r["data"])):
            raise WipeRefused()
        now = int(time.time())
        conn = db.connect()
        if r:
            last = conn.execute("SELECT MAX(saved_at) FROM profile_state_backup WHERE profile_id=?", (pid,)).fetchone()[0] or 0
            if wipe or now - last >= BACKUP_EVERY_SEC:
                conn.execute("INSERT OR REPLACE INTO profile_state_backup(profile_id, version, data, saved_at) VALUES (?,?,?,?)",
                             (pid, r["version"], r["data"], now))
                conn.execute("DELETE FROM profile_state_backup WHERE profile_id=? AND version NOT IN "
                             "(SELECT version FROM profile_state_backup WHERE profile_id=? ORDER BY version DESC LIMIT ?)",
                             (pid, pid, BACKUPS_KEEP))
        new_version = cur_version + 1
        conn.execute("INSERT INTO profile_state(profile_id, version, data, updated_at, updated_by) VALUES (?,?,?,?,?) "
                     "ON CONFLICT(profile_id) DO UPDATE SET version=excluded.version, data=excluded.data, "
                     "updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                     (pid, new_version, data, now, device))
        conn.commit()
        return new_version


def backups(pid):
    return db.q("SELECT version, saved_at, length(data) AS size FROM profile_state_backup WHERE profile_id=? ORDER BY version DESC", (pid,))


def backup(pid, version):
    r = db.q1("SELECT data FROM profile_state_backup WHERE profile_id=? AND version=?", (pid, version))
    return json.loads(r["data"]) if r else None


def profiles_with_state():
    return [r["profile_id"] for r in db.q("SELECT profile_id FROM profile_state ORDER BY profile_id")]


# ------------------------------------------------------------------ перенесення даних однокористувацької версії
def migrate_legacy():
    """Переносить спільний стан (app_state) і ключ КЕП (kep_store) у профіль ФОП з РНОКПП з цих даних.

    Профіль створюється без доступу: його отримує користувач, який додасть ФОП ключем з тим самим РНОКПП
    (або зареєструється з адресою LEGACY_OWNER_EMAIL). Повертає id профілю або None.
    """
    from . import accounts
    conn = db.connect()
    if db.get_setting("legacy_migrated"):
        return None
    has = lambda t: conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()
    row = db.q1("SELECT version, data, updated_at, updated_by FROM app_state WHERE id=1") if has("app_state") else None
    kep = db.q1("SELECT blob, info, created_at FROM kep_store WHERE id=1") if has("kep_store") else None
    pid = None
    if row or kep:
        state = json.loads(row["data"]) if row else {}
        settings = state.get("settings") or {}
        info = json.loads((kep or {}).get("info") or "null") or {}
        tin = str(info.get("tin") or settings.get("owner_tax_id") or "").strip() or None
        name = settings.get("owner_name") or info.get("name") or ""
        existing = accounts.profile_by_tin(tin)
        pid = existing["id"] if existing else accounts.create_profile(tin, name)
        if row and not _row(pid):
            conn.execute("INSERT INTO profile_state(profile_id, version, data, updated_at, updated_by) VALUES (?,?,?,?,?)",
                         (pid, row["version"], row["data"], row["updated_at"], row["updated_by"]))
            if has("app_state_backup"):
                conn.execute("INSERT OR IGNORE INTO profile_state_backup(profile_id, version, data, saved_at) "
                             "SELECT ?, version, data, saved_at FROM app_state_backup", (pid,))
        if kep:
            conn.execute("INSERT OR IGNORE INTO kep_keys(profile_id, blob, info, created_at) VALUES (?,?,?,?)",
                         (pid, kep["blob"], kep["info"], kep["created_at"]))
        conn.commit()
        print(f"Дані однокористувацької версії перенесено в профіль ФОП #{pid} (РНОКПП {tin or 'невідомий'})")
    db.set_setting("legacy_migrated", True)
    return pid


# ------------------------------------------------------------------ замок синхронізації з банками (окремий для кожного ФОП)
_sync_holders = {}
_sync_mx = threading.Lock()


def acquire_sync(pid, device, ttl=180):
    """Видає замок пристрою, якщо він вільний, протермінований або вже належить цьому пристрою."""
    now = time.time()
    with _sync_mx:
        h = _sync_holders.setdefault(pid, {"device": None, "until": 0})
        if h["device"] in (None, device) or h["until"] < now:
            h.update(device=device, until=now + ttl)
            return {"granted": True}
        return {"granted": False, "holder": h["device"], "seconds_left": int(h["until"] - now)}


def release_sync(pid, device):
    with _sync_mx:
        h = _sync_holders.get(pid)
        if h and h["device"] == device:
            h.update(device=None, until=0)
