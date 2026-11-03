"""Користувачі, профілі ФОП і доступ до них.

• Користувач — людина з email і паролем (власник ФОП, бухгалтер або обидва одразу).
• Профіль — один ФОП (РНОКПП). Усі дані програми (виписки, правила, ключ КЕП) належать профілю.
• Доступ — хто і з якою роллю працює з профілем: owner (власник: усе, зокрема керування доступом)
  або accountant (бухгалтер: веде облік, оновлює дані з банків і Кабінету, але не роздає доступ
  і не видаляє ключ).
• Запрошення — доступ, наданий на email, з яким ще ніхто не зареєструвався; застосовується під час реєстрації.

Хто має ключ КЕП платника — той і є платник: додавши ФОП ключем, РНОКПП якого вже є в програмі,
користувач отримує доступ власника (так само до цього профілю прив'язуються дані, що були на сервері
до появи облікових записів).
"""
import hashlib
import hmac
import os
import re
import secrets
import threading
import time

from . import db

ROLES = {"owner": "Власник", "accountant": "Бухгалтер"}
EMAIL_RX = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")
PBKDF2_ITERS = 210_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    pass_hash TEXT NOT NULL,
    session_gen INTEGER NOT NULL DEFAULT 0,
    last_profile INTEGER,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tin TEXT UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    fop_group TEXT,
    created_by INTEGER,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_access (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    granted_by INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, user_id)
);
CREATE TABLE IF NOT EXISTS profile_invites (
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL,
    granted_by INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, email)
);
"""

_mx = threading.Lock()


class AccessError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def init():
    db.connect().executescript(SCHEMA)
    db.connect().commit()


# ---------------------------------------------------------------- паролі
def hash_password(pw):
    salt = secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, PBKDF2_ITERS)
    return f"pbkdf2${PBKDF2_ITERS}${salt.hex()}${h.hex()}"


def check_password(pw, stored):
    try:
        _, iters, salt, h = stored.split("$")
        got = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(got.hex(), h)
    except Exception:
        return False


_DUMMY_HASH = None


def _dummy():
    global _DUMMY_HASH
    if _DUMMY_HASH is None:
        _DUMMY_HASH = hash_password(secrets.token_hex(8))
    return _DUMMY_HASH


# ---------------------------------------------------------------- користувачі
def norm_email(email):
    return str(email or "").strip().lower()


def user_public(u):
    return {"id": u["id"], "email": u["email"], "name": u["name"]} if u else None


def get_user(uid):
    return db.q1("SELECT * FROM users WHERE id=?", (uid,))


def user_by_email(email):
    return db.q1("SELECT * FROM users WHERE email=?", (norm_email(email),))


def register(email, name, password):
    email, name = norm_email(email), str(name or "").strip()[:120]
    if not EMAIL_RX.match(email):
        raise AccessError(400, "Вкажіть правильну електронну адресу")
    if not name:
        raise AccessError(400, "Вкажіть ім'я")
    if len(password or "") < 8:
        raise AccessError(400, "Пароль — щонайменше 8 символів")
    mode = os.environ.get("REGISTRATION", "open")
    if mode == "invite" and not db.q1("SELECT 1 FROM profile_invites WHERE email=?", (email,)) \
            and email != norm_email(os.environ.get("LEGACY_OWNER_EMAIL")):
        raise AccessError(403, "Реєстрація — лише за запрошенням. Попросіть власника ФОП надати доступ на вашу адресу.")
    with _mx:
        if user_by_email(email):
            raise AccessError(409, "Користувач з такою адресою вже є — увійдіть")
        now = int(time.time())
        uid = db.ex("INSERT INTO users(email, name, pass_hash, created_at) VALUES (?,?,?,?)",
                    (email, name, hash_password(password), now)).lastrowid
        # запрошення на цю адресу → доступ
        for inv in db.q("SELECT * FROM profile_invites WHERE email=?", (email,)):
            db.ex("INSERT OR IGNORE INTO profile_access(profile_id, user_id, role, granted_by, created_at) VALUES (?,?,?,?,?)",
                  (inv["profile_id"], uid, inv["role"], inv["granted_by"], now))
        db.ex("DELETE FROM profile_invites WHERE email=?", (email,))
        # дані, що були на сервері до появи облікових записів, — адміністраторові з LEGACY_OWNER_EMAIL
        if email == norm_email(os.environ.get("LEGACY_OWNER_EMAIL")):
            for p in db.q("SELECT id FROM profiles WHERE id NOT IN (SELECT profile_id FROM profile_access)"):
                db.ex("INSERT OR IGNORE INTO profile_access(profile_id, user_id, role, created_at) VALUES (?,?,'owner',?)",
                      (p["id"], uid, now))
    return get_user(uid)


def authenticate(email, password):
    u = user_by_email(email)
    if not u:
        check_password(password or "", _dummy())  # однаковий час відповіді для наявних і відсутніх адрес
        return None
    return u if check_password(password or "", u["pass_hash"]) else None


def change_password(uid, old, new):
    u = get_user(uid)
    if not u or not check_password(old or "", u["pass_hash"]):
        raise AccessError(400, "Поточний пароль невірний")
    if len(new or "") < 8:
        raise AccessError(400, "Новий пароль — щонайменше 8 символів")
    db.ex("UPDATE users SET pass_hash=?, session_gen=session_gen+1 WHERE id=?", (hash_password(new), uid))
    return get_user(uid)


# ---------------------------------------------------------------- профілі
def profile(pid):
    return db.q1("SELECT * FROM profiles WHERE id=?", (pid,))


def profile_by_tin(tin):
    return db.q1("SELECT * FROM profiles WHERE tin=?", (str(tin),)) if tin else None


def role_of(uid, pid):
    r = db.q1("SELECT role FROM profile_access WHERE user_id=? AND profile_id=?", (uid, pid))
    return r["role"] if r else None


def profiles_of(uid):
    return db.q("""SELECT p.id, p.tin, p.name, p.fop_group, a.role FROM profile_access a JOIN profiles p ON p.id=a.profile_id
                   WHERE a.user_id=? ORDER BY CASE a.role WHEN 'owner' THEN 0 ELSE 1 END, p.name COLLATE NOCASE, p.id""", (uid,))


def all_profile_ids():
    return [r["id"] for r in db.q("SELECT id FROM profiles ORDER BY id")]


def create_profile(tin, name, uid=None):
    now = int(time.time())
    pid = db.ex("INSERT INTO profiles(tin, name, created_by, created_at) VALUES (?,?,?,?)",
                (str(tin) if tin else None, str(name or "")[:200], uid, now)).lastrowid
    if uid:
        grant(pid, uid, "owner", uid)
    return pid


def update_profile(pid, name=None, tin=None, fop_group=None):
    p = profile(pid)
    if not p:
        return
    if name and name != p["name"]:
        db.ex("UPDATE profiles SET name=? WHERE id=?", (str(name)[:200], pid))
    if tin and not p["tin"] and not profile_by_tin(tin):
        db.ex("UPDATE profiles SET tin=? WHERE id=?", (str(tin), pid))
    if fop_group is not None and str(fop_group) != (p["fop_group"] or ""):
        db.ex("UPDATE profiles SET fop_group=? WHERE id=?", (str(fop_group) or None, pid))


def grant(pid, uid, role, by):
    if role not in ROLES:
        raise AccessError(400, "Невідома роль")
    db.ex("INSERT INTO profile_access(profile_id, user_id, role, granted_by, created_at) VALUES (?,?,?,?,?) "
          "ON CONFLICT(profile_id, user_id) DO UPDATE SET role=excluded.role, granted_by=excluded.granted_by",
          (pid, uid, role, by, int(time.time())))


def share(pid, by_uid, email, role):
    """Надає доступ за email: одразу, якщо такий користувач є, інакше — запрошення до реєстрації."""
    email = norm_email(email)
    if not EMAIL_RX.match(email):
        raise AccessError(400, "Вкажіть правильну електронну адресу")
    if role not in ROLES:
        raise AccessError(400, "Невідома роль")
    u = user_by_email(email)
    if u:
        if u["id"] == by_uid:
            raise AccessError(400, "Це ваша власна адреса")
        cur = role_of(u["id"], pid)
        if cur == "owner" and role != "owner":
            _ensure_other_owner(pid, u["id"])
        grant(pid, u["id"], role, by_uid)
        return {"user": user_public(u), "role": role, "invited": False}
    db.ex("INSERT INTO profile_invites(profile_id, email, role, granted_by, created_at) VALUES (?,?,?,?,?) "
          "ON CONFLICT(profile_id, email) DO UPDATE SET role=excluded.role",
          (pid, email, role, by_uid, int(time.time())))
    return {"email": email, "role": role, "invited": True}


def _ensure_other_owner(pid, uid):
    n = db.q1("SELECT COUNT(*) AS n FROM profile_access WHERE profile_id=? AND role='owner' AND user_id<>?", (pid, uid))["n"]
    if not n:
        raise AccessError(409, "У ФОП має залишитися хоча б один власник")


def revoke(pid, uid):
    if role_of(uid, pid) == "owner":
        _ensure_other_owner(pid, uid)
    db.ex("DELETE FROM profile_access WHERE profile_id=? AND user_id=?", (pid, uid))
    db.ex("UPDATE users SET last_profile=NULL WHERE id=? AND last_profile=?", (uid, pid))


def cancel_invite(pid, email):
    db.ex("DELETE FROM profile_invites WHERE profile_id=? AND email=?", (pid, norm_email(email)))


def access_list(pid):
    users = db.q("""SELECT u.id, u.email, u.name, a.role, a.created_at FROM profile_access a JOIN users u ON u.id=a.user_id
                    WHERE a.profile_id=? ORDER BY CASE a.role WHEN 'owner' THEN 0 ELSE 1 END, a.created_at""", (pid,))
    invites = db.q("SELECT email, role, created_at FROM profile_invites WHERE profile_id=? ORDER BY created_at", (pid,))
    return {"users": users, "invites": invites}


def set_last_profile(uid, pid):
    db.ex("UPDATE users SET last_profile=? WHERE id=?", (pid, uid))
