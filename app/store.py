"""Спільне сховище даних програми для всіх пристроїв.

Браузерна програма тримає всі дані в одному JSON-об'єкті (стан S). На сервері він
зберігається цілком у SQLite разом з номером версії. Пристрій надсилає новий стан
разом з версією, від якої він починав зміни; якщо за цей час інший пристрій уже
записав новішу версію, сервер відповідає конфліктом і повертає актуальний стан —
пристрій об'єднує зміни і надсилає ще раз.

Тут же — «замок» синхронізації з банками: виписки тягне лише один пристрій за раз
(Monobank дозволяє один запит на хвилину на токен).
"""
import json
import threading
import time

from . import db

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
);
CREATE TABLE IF NOT EXISTS app_state_backup (
    version INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    saved_at INTEGER NOT NULL
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


def _row():
    return db.q1("SELECT version, data, updated_at, updated_by FROM app_state WHERE id=1")


def meta():
    r = db.q1("SELECT version, updated_at, updated_by FROM app_state WHERE id=1")
    return r or {"version": 0, "updated_at": None, "updated_by": None}


def get():
    r = _row()
    if not r:
        return {"version": 0, "state": None, "updated_at": None}
    return {"version": r["version"], "state": json.loads(r["data"]), "updated_at": r["updated_at"]}


def _is_empty(state):
    return not (state or {}).get("tx") and not (state or {}).get("connections") and not (state or {}).get("accounts")


def put(state, base_version, device=None, wipe=False):
    """Записує стан, якщо base_version збігається з поточною версією. Повертає нову версію."""
    if not isinstance(state, dict) or "tx" not in state or "accounts" not in state:
        raise ValueError("Некоректні дані програми")
    data = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    with _lock:
        r = _row()
        cur_version = r["version"] if r else 0
        if base_version != cur_version:
            raise Conflict(get())
        # запобіжник: порожній стан не перезаписує дані, якщо це не явне «Видалити всі дані»
        if r and not wipe and _is_empty(state) and not _is_empty(json.loads(r["data"])):
            raise WipeRefused()
        now = int(time.time())
        conn = db.connect()
        if r:
            last = conn.execute("SELECT MAX(saved_at) FROM app_state_backup").fetchone()[0] or 0
            if wipe or now - last >= BACKUP_EVERY_SEC:
                conn.execute("INSERT OR REPLACE INTO app_state_backup(version, data, saved_at) VALUES (?,?,?)",
                             (r["version"], r["data"], now))
                conn.execute("DELETE FROM app_state_backup WHERE version NOT IN "
                             "(SELECT version FROM app_state_backup ORDER BY version DESC LIMIT ?)", (BACKUPS_KEEP,))
        new_version = cur_version + 1
        conn.execute("INSERT INTO app_state(id, version, data, updated_at, updated_by) VALUES (1,?,?,?,?) "
                     "ON CONFLICT(id) DO UPDATE SET version=excluded.version, data=excluded.data, "
                     "updated_at=excluded.updated_at, updated_by=excluded.updated_by",
                     (new_version, data, now, device))
        conn.commit()
        return new_version


def backups():
    return db.q("SELECT version, saved_at, length(data) AS size FROM app_state_backup ORDER BY version DESC")


def backup(version):
    r = db.q1("SELECT data FROM app_state_backup WHERE version=?", (version,))
    return json.loads(r["data"]) if r else None


# ------------------------------------------------------------------ замок синхронізації з банками
_sync_holder = {"device": None, "until": 0}
_sync_mx = threading.Lock()


def acquire_sync(device, ttl=180):
    """Видає замок пристрою, якщо він вільний, протермінований або вже належить цьому пристрою."""
    now = time.time()
    with _sync_mx:
        if _sync_holder["device"] in (None, device) or _sync_holder["until"] < now:
            _sync_holder.update(device=device, until=now + ttl)
            return {"granted": True}
        return {"granted": False, "holder": _sync_holder["device"], "seconds_left": int(_sync_holder["until"] - now)}


def release_sync(device):
    with _sync_mx:
        if _sync_holder["device"] == device:
            _sync_holder.update(device=None, until=0)
