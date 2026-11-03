"""HTTP-сервер: JSON API + статичний фронтенд. Лише стандартна бібліотека Python.

Користувачі входять за email і паролем (сесійна cookie). Кожен запит до даних програми стосується
одного профілю ФОП — його id браузер передає заголовком X-Profile; сервер перевіряє, що користувач
має доступ до цього ФОП (власник або бухгалтер).
"""
import gzip
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import traceback
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

from . import config, db, store, proxy, bg, ai, accounts

SESSION_TTL = 30 * 24 * 3600
ROUTES = []


def route(method, pattern, public=False):
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, rx, fn, public))
        return fn
    return deco


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _secret():
    if config.SECRET_KEY:
        return config.SECRET_KEY.encode()
    s = db.get_setting("_secret_key")
    if not s:
        s = secrets.token_hex(32)
        db.set_setting("_secret_key", s)
    return s.encode()


def _sig(payload):
    return hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()


def make_session(user):
    payload = f"{user['id']}.{user['session_gen']}.{int(time.time()) + SESSION_TTL}"
    return f"{payload}.{_sig(payload)}"


def session_user(value):
    """Користувач із сесійної cookie або None (підпис, строк, і що пароль після входу не змінювали)."""
    try:
        uid, gen, exp, sig = value.split(".")
        if not hmac.compare_digest(sig, _sig(f"{uid}.{gen}.{exp}")) or int(exp) < time.time():
            return None
        u = accounts.get_user(int(uid))
        return u if u and str(u["session_gen"]) == gen else None
    except Exception:
        return None


def _role(h, owner=False):
    """Профіль ФОП цього запиту (заголовок X-Profile) і роль користувача в ньому."""
    try:
        pid = int(h.headers.get("X-Profile") or h.qs("profile") or 0)
    except ValueError:
        pid = 0
    if not pid:
        raise HttpError(400, "Не вибрано ФОП")
    role = accounts.role_of(h.user["id"], pid)
    if not role:
        raise HttpError(403, "Немає доступу до цього ФОП")
    if owner and role != "owner":
        raise HttpError(403, "Це може зробити лише власник ФОП")
    return pid, role


def _pid(h, owner=False):
    return _role(h, owner)[0]


def _rate(bucket, key, limit, window):
    now = time.time()
    lst = [t for t in bucket.get(key, []) if t > now - window]
    bucket[key] = lst
    if len(lst) >= limit:
        raise HttpError(429, "Забагато спроб. Спробуйте трохи пізніше.")
    return lst


def _me(h):
    u = h.user
    return {"server": True, "authenticated": bool(u), "user": accounts.user_public(u),
            "registration": os.environ.get("REGISTRATION", "open"),
            "profiles": accounts.profiles_of(u["id"]) if u else [],
            "last_profile": u["last_profile"] if u else None}


# ======================================================================= вхід і реєстрація

@route("GET", "/api/me", public=True)
def api_me(h, m, body):
    return _me(h)


_login_fails = {}
_registrations = {}
_key_tries = {}


@route("POST", "/api/login", public=True)
def api_login(h, m, body):
    body = body or {}
    email = accounts.norm_email(body.get("email"))
    lst = _rate(_login_fails, email, 10, 600)
    _rate(_login_fails, "ip:" + h.client_ip(), 30, 600)
    u = accounts.authenticate(email, str(body.get("password") or ""))
    if not u:
        lst.append(time.time())
        _login_fails.setdefault("ip:" + h.client_ip(), []).append(time.time())
        time.sleep(0.5)
        raise HttpError(401, "Невірна адреса або пароль")
    h.user = u
    h.set_cookie = make_session(u)
    return _me(h)


@route("POST", "/api/register", public=True)
def api_register(h, m, body):
    body = body or {}
    lst = _rate(_registrations, h.client_ip(), int(os.environ.get("REGISTER_PER_HOUR", "20")), 3600)
    try:
        u = accounts.register(body.get("email"), body.get("name"), str(body.get("password") or ""))
    except accounts.AccessError as e:
        raise HttpError(e.status, str(e))
    lst.append(time.time())
    h.user = u
    h.set_cookie = make_session(u)
    return _me(h)


@route("POST", "/api/logout", public=True)
def api_logout(h, m, body):
    h.set_cookie = ""
    return {"ok": True}


@route("POST", "/api/password")
def api_password(h, m, body):
    body = body or {}
    try:
        u = accounts.change_password(h.user["id"], body.get("old"), body.get("new"))
    except accounts.AccessError as e:
        raise HttpError(e.status, str(e))
    h.set_cookie = make_session(u)   # інші пристрої після зміни пароля мають увійти знову
    return {"ok": True}


# ======================================================================= профілі ФОП і доступ

def _key_files(body):
    files = (body or {}).get("files") or []
    if not isinstance(files, list) or not files or len(files) > 5 or not all(isinstance(f, str) and len(f) < 200_000 for f in files):
        raise HttpError(400, "Оберіть файл ключа")
    return files


def _bg(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except bg.WorkerError as e:
        raise HttpError(409, str(e))


@route("POST", "/api/profiles")
def api_profile_add(h, m, body):
    """Додає ФОП за ключем КЕП: сертифікат дає РНОКПП і ПІБ, ключ зберігається на сервері, облікові дані — з Кабінету."""
    body = body or {}
    if not body.get("consent"):
        raise HttpError(400, "Потрібна ваша згода на отримання даних з Електронного кабінету")
    files = _key_files(body)
    _rate(_key_tries, h.user["id"], 20, 3600).append(time.time())   # кожна спроба — важкий процес Node
    opened = _bg(bg.kep_open, files, str(body.get("password") or ""))
    info = opened["info"] or {}
    tin = str(info.get("tin") or "").strip()
    typed = re.sub(r"\D", "", str(body.get("tin") or ""))
    if not tin:
        if not re.fullmatch(r"\d{10}", typed):
            return {"need_tin": True, "info": info}
        if accounts.profile_by_tin(typed):
            raise HttpError(409, "ФОП з цим РНОКПП уже є в програмі, а в сертифікаті ключа РНОКПП немає. "
                                 "Попросіть власника надати вам доступ.")
        tin = typed
    uid = h.user["id"]
    p = accounts.profile_by_tin(tin)
    joined = bool(p)
    if p:
        # ключ платника підтверджує право на його дані — у тому числі на дані, перенесені з однокористувацької версії
        if accounts.role_of(uid, p["id"]) != "owner":
            accounts.grant(p["id"], uid, "owner", uid)
        pid = p["id"]
    else:
        pid = accounts.create_profile(tin, info.get("name") or "", uid)
    bg.kep_put(pid, opened, uid)
    accounts.set_last_profile(uid, pid)
    tax_state = {}
    try:
        tax_state = bg.tax_refresh(pid)
    except bg.WorkerError as e:
        tax_state = {"last_error": str(e)}
    if not store.get(pid)["state"]:
        # Кабінет недоступний — програма все одно стартує з ПІБ і РНОКПП із сертифіката
        accounts.update_profile(pid, name=info.get("name") or None)
    st = store.get(pid)
    if st["state"] is not None:
        s = st["state"].setdefault("settings", {})
        changed = False
        if not s.get("owner_tax_id"):
            s["owner_tax_id"], changed = tin, True
        if not s.get("owner_name") and info.get("name"):
            s["owner_name"], changed = info["name"], True
        if changed:
            try:
                store.put(pid, st["state"], st["version"], device="server")
            except store.Conflict:
                pass
    return {"profile": next((x for x in accounts.profiles_of(uid) if x["id"] == pid), None), "joined": joined,
            "info": info, "tax": {"fetched_at": tax_state.get("fetched_at"), "last_error": tax_state.get("last_error")}}


@route("POST", r"/api/profiles/(?P<pid>\d+)/select")
def api_profile_select(h, m, body):
    pid = int(m["pid"])
    if not accounts.role_of(h.user["id"], pid):
        raise HttpError(403, "Немає доступу до цього ФОП")
    accounts.set_last_profile(h.user["id"], pid)
    return {"ok": True}


@route("GET", r"/api/profiles/(?P<pid>\d+)/access")
def api_access(h, m, body):
    pid = int(m["pid"])
    role = accounts.role_of(h.user["id"], pid)
    if not role:
        raise HttpError(403, "Немає доступу до цього ФОП")
    out = accounts.access_list(pid)
    if role != "owner":
        out["invites"] = []
    return {**out, "role": role, "me": h.user["id"], "roles": accounts.ROLES}


@route("POST", r"/api/profiles/(?P<pid>\d+)/access")
def api_access_add(h, m, body):
    pid = int(m["pid"])
    if accounts.role_of(h.user["id"], pid) != "owner":
        raise HttpError(403, "Надавати доступ може лише власник ФОП")
    try:
        return accounts.share(pid, h.user["id"], (body or {}).get("email"), (body or {}).get("role") or "accountant")
    except accounts.AccessError as e:
        raise HttpError(e.status, str(e))


@route("DELETE", r"/api/profiles/(?P<pid>\d+)/access/(?P<uid>\d+)")
def api_access_remove(h, m, body):
    pid, uid = int(m["pid"]), int(m["uid"])
    me = h.user["id"]
    # власник прибирає будь-кого; будь-хто може відмовитися від власного доступу
    if accounts.role_of(me, pid) != "owner" and uid != me:
        raise HttpError(403, "Забирати доступ може лише власник ФОП")
    if not accounts.role_of(uid, pid):
        raise HttpError(404, "Цей користувач не має доступу")
    try:
        accounts.revoke(pid, uid)
    except accounts.AccessError as e:
        raise HttpError(e.status, str(e))
    return {"ok": True}


@route("DELETE", r"/api/profiles/(?P<pid>\d+)/invites")
def api_invite_cancel(h, m, body):
    pid = int(m["pid"])
    if accounts.role_of(h.user["id"], pid) != "owner":
        raise HttpError(403, "Це може зробити лише власник ФОП")
    accounts.cancel_invite(pid, (body or {}).get("email"))
    return {"ok": True}


# ======================================================================= спільне сховище (дані ФОП)

@route("GET", "/api/state")
def api_state_get(h, m, body):
    return store.get(_pid(h))


@route("GET", "/api/state/meta")
def api_state_meta(h, m, body):
    return store.meta(_pid(h))


@route("PUT", "/api/state")
def api_state_put(h, m, body):
    pid = _pid(h)
    body = body or {}
    try:
        v = store.put(pid, body.get("state"), int(body.get("base_version") or 0),
                      device=str(body.get("device") or "")[:64] or None, wipe=bool(body.get("wipe")))
    except store.Conflict as c:
        h.send_json(409, {"error": "conflict", **c.current})
        return None
    except store.WipeRefused:
        raise HttpError(409, "Порожні дані не можуть замінити збережені. Для очищення скористайтеся «Видалити всі дані».")
    except ValueError as e:
        raise HttpError(400, str(e))
    bg._sync_profile(pid, body.get("state"))
    return {"version": v}


@route("GET", "/api/backups")
def api_backups(h, m, body):
    return store.backups(_pid(h))


@route("GET", r"/api/backups/(?P<version>\d+)")
def api_backup(h, m, body):
    data = store.backup(_pid(h), int(m["version"]))
    if data is None:
        raise HttpError(404, "Копію не знайдено")
    return data


@route("POST", "/api/sync-lock")
def api_sync_lock(h, m, body):
    pid = _pid(h)
    device = str((body or {}).get("device") or "")[:64]
    if not device:
        raise HttpError(400, "Не вказано пристрій")
    if (body or {}).get("release"):
        store.release_sync(pid, device)
        return {"released": True}
    return store.acquire_sync(pid, device)


# ======================================================================= запити до банків і НБУ

def _proxied(h, result):
    status, data, ctype = result
    h.send_raw(status, data, ctype, {"Cache-Control": "no-store"})


@route("GET", r"/proxy/mono/(?P<path>.+)")
def px_mono(h, m, body):
    _proxied(h, proxy.mono(m["path"], h.headers.get("X-Token", "")))


@route("GET", r"/proxy/privat/(?P<path>.+)")
def px_privat(h, m, body):
    q = {k: v[0] for k, v in h._qs.items()}
    _proxied(h, proxy.privat(m["path"], q, h.headers.get("X-Privat-Token", "")))


@route("POST", "/proxy/tax-bridge")
def px_tax(h, m, body):
    return proxy.tax_bridge(body or {})


@route("GET", "/proxy/nbu")
def px_nbu(h, m, body):
    q = {k: v[0] for k, v in h._qs.items()}
    q.setdefault("json", "")
    _proxied(h, proxy.nbu(q))


# ======================================================================= фонове оновлення і ключ КЕП

@route("GET", "/api/server-status")
def api_server_status(h, m, body):
    pid, role = _role(h)
    return {"node": bg.node_available(), "secret": len(bg.kep_secret()) >= 16, "interval_min": config.SYNC_INTERVAL_MIN,
            "bg": bg.status(pid), "kep": bg.kep_get(pid), "role": role}


@route("POST", "/api/kep")
def api_kep_save(h, m, body):
    pid = _pid(h)
    info = _bg(bg.kep_save, pid, _key_files(body), str((body or {}).get("password") or ""), h.user["id"])
    try:
        tax_state = bg.tax_refresh(pid)
    except bg.WorkerError as e:
        tax_state = {"last_error": str(e)}
    return {"info": info, "tax": {"fetched_at": tax_state.get("fetched_at"), "last_error": tax_state.get("last_error")}}


@route("DELETE", "/api/kep")
def api_kep_delete(h, m, body):
    bg.kep_delete(_pid(h, owner=True))
    return {"ok": True}


@route("POST", "/api/tax/refresh")
def api_tax_refresh(h, m, body):
    t = _bg(bg.tax_refresh, _pid(h))
    return {"fetched_at": t.get("fetched_at"), "last_error": t.get("last_error")}


@route("POST", "/api/tax/budget")
def api_tax_budget(h, m, body):
    pid = _pid(h)
    try:
        year = int((body or {}).get("year"))
    except (TypeError, ValueError):
        raise HttpError(400, "Вкажіть рік")
    if not 2017 <= year <= 2100:
        raise HttpError(400, "Некоректний рік")
    return _bg(bg.tax_budget, pid, year)


@route("POST", "/api/fiscal/refresh")
def api_fiscal_refresh(h, m, body):
    # довге завантаження (до кількох хвилин на частину) — у фоні; програма побачить результат при опитуванні стану
    pid = _pid(h)
    if not bg.kep_get(pid)["stored"]:
        raise HttpError(409, "Ключ КЕП не збережено на сервері — збережіть його на вкладці «Облікові дані»")
    if bg.status(pid).get("running"):
        return {"started": False, "running": bg.status(pid)["running"]}
    bg.start_fiscal(pid)
    return {"started": True}


@route("GET", "/api/ai/status")
def api_ai_status(h, m, body):
    return {"enabled": ai.enabled(), "model": ai.MODEL}


@route("POST", "/api/ai/ask")
def api_ai_ask(h, m, body):
    pid = _pid(h)
    body = body or {}
    try:
        return ai.ask(body.get("question"), body.get("history"), store.get(pid)["state"])
    except ai.AiError as e:
        raise HttpError(e.status, str(e))


@route("POST", "/api/ai/kved")
def api_ai_kved(h, m, body):
    body = body or {}
    try:
        return {"results": ai.kved_check(body.get("kveds"), body.get("items"))}
    except ai.AiError as e:
        raise HttpError(e.status, str(e))


# ======================================================================= обробник

class Handler(BaseHTTPRequestHandler):
    server_version = "fop-income"
    set_cookie = None
    user = None

    def log_message(self, fmt, *args):
        if os.environ.get("ACCESS_LOG") == "1":
            super().log_message(fmt, *args)

    def qs(self, key):
        return self._qs.get(key, [None])[0]

    def client_ip(self):
        fwd = (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        return fwd or self.client_address[0]

    def load_user(self):
        c = SimpleCookie(self.headers.get("Cookie", ""))
        self.user = session_user(c["session"].value) if "session" in c else None
        return self.user

    def send_raw(self, status, data, ctype, extra=None):
        extra = dict(extra or {})
        if (len(data) > 2048 and "gzip" in (self.headers.get("Accept-Encoding") or "")
                and ("json" in ctype or ctype.startswith("text/"))):
            data = gzip.compress(data, 5)
            extra["Content-Encoding"] = "gzip"
            extra["Vary"] = "Accept-Encoding"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        if self.set_cookie is not None:
            https = config.COOKIE_SECURE or (self.headers.get("X-Forwarded-Proto") or "").lower() == "https"
            attrs = "Path=/; HttpOnly; SameSite=Lax" + ("; Secure" if https else "")
            if self.set_cookie:
                self.send_header("Set-Cookie", f"session={self.set_cookie}; Max-Age={SESSION_TTL}; {attrs}")
            else:
                self.send_header("Set-Cookie", f"session=; Max-Age=0; {attrs}")
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, status, obj):
        self.send_raw(status, json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8"),
                      "application/json; charset=utf-8", {"Cache-Control": "no-store"})

    def _dispatch(self, method):
        url = urlparse(self.path)
        self._qs = parse_qs(url.query)
        path = url.path
        try:
            if not path.startswith(("/api/", "/webhook/", "/proxy/")):
                if method in ("GET", "HEAD"):
                    return self._static(path)
                raise HttpError(404, "Not found")
            for rmethod, rx, fn, public in ROUTES:
                mt = rx.match(path)
                if mt and rmethod == method:
                    if not self.load_user() and not public:
                        raise HttpError(401, "Потрібен вхід")
                    body = None
                    if method in ("POST", "PUT", "PATCH", "DELETE"):
                        n = int(self.headers.get("Content-Length") or 0)
                        limit = 100_000_000 if path == "/api/state" else 1_000_000
                        if n > limit:
                            raise HttpError(413, "Завеликий запит")
                        raw = self.rfile.read(n) if n else b""
                        if raw and (self.headers.get("Content-Encoding") or "").lower() == "gzip":
                            try:
                                raw = gzip.decompress(raw)
                            except OSError:
                                raise HttpError(400, "Некоректне стиснення")
                            if len(raw) > 500_000_000:
                                raise HttpError(413, "Завеликий запит")
                        # захист від CSRF: для API приймаємо лише JSON
                        if path.startswith("/api/") and raw and "application/json" not in (self.headers.get("Content-Type") or ""):
                            raise HttpError(415, "Очікується application/json")
                        try:
                            body = json.loads(raw) if raw else {}
                        except ValueError:
                            raise HttpError(400, "Некоректний JSON")
                    result = fn(self, {k: unquote(v) for k, v in mt.groupdict().items()}, body)
                    if result is not None:
                        self.send_json(200, result)
                    return
            raise HttpError(404, "Not found")
        except (HttpError, proxy.ProxyError) as e:
            self.send_json(e.status, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            self.send_json(500, {"error": f"Внутрішня помилка: {e}"})

    def _static(self, path):
        """Будь-яка сторінка — це однофайлова програма (docs/index.html) у режимі сервера."""
        try:
            with open(config.UI_FILE, "rb") as f:
                data = f.read()
        except FileNotFoundError:
            raise HttpError(500, "Немає docs/index.html — зберіть програму: python3 standalone/build.py")
        data = data.replace(b'<meta name="fop-mode" content="local">', b'<meta name="fop-mode" content="server">', 1)
        self.send_raw(200, data, "text/html; charset=utf-8", {
            "Cache-Control": "no-cache",
            "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
                                       "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://script.google.com https://script.googleusercontent.com; "
                                       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        })

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")


def init():
    db.init()
    accounts.init()
    store.init()
    bg.init()
    store.migrate_legacy()


def main():
    init()
    if not config.SECRET_KEY:
        print("⚠  SECRET_KEY не задано — ключі КЕП не можна зберігати на сервері.")
    if os.environ.get("DISABLE_SYNC") != "1":
        bg.start()  # фонове оновлення виписок і облікових даних (стара серверна модель sync.worker більше не запускається)
    srv = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    print(f"ФОП-дохід працює: http://localhost:{config.PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
