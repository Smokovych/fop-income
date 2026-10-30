"""HTTP-сервер: JSON API + статичний фронтенд. Лише стандартна бібліотека Python."""
import csv
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import time
import traceback
from datetime import date
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

from . import config, db, tax
from .classify import reclassify_all
from .sync import worker, add_connection, set_mono_webhook, handle_mono_webhook, refresh_accounts

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


def make_session():
    exp = str(int(time.time()) + SESSION_TTL)
    sig = hmac.new(_secret(), exp.encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def valid_session(value):
    try:
        exp, sig = value.split(".", 1)
        good = hmac.new(_secret(), exp.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, good) and int(exp) > time.time()
    except Exception:
        return False


# ======================================================================= API

@route("GET", "/api/me", public=True)
def api_me(h, m, body):
    return {"auth_required": bool(config.APP_PASSWORD), "authenticated": h.authenticated()}


@route("POST", "/api/login", public=True)
def api_login(h, m, body):
    if not config.APP_PASSWORD:
        return {"ok": True}
    pw = (body or {}).get("password", "")
    if not hmac.compare_digest(pw.encode(), config.APP_PASSWORD.encode()):
        time.sleep(1.0)
        raise HttpError(401, "Невірний пароль")
    h.set_cookie = make_session()
    return {"ok": True}


@route("POST", "/api/logout")
def api_logout(h, m, body):
    h.set_cookie = ""
    return {"ok": True}


@route("GET", "/api/categories")
def api_categories(h, m, body):
    return config.CATEGORIES


@route("GET", "/api/summary")
def api_summary(h, m, body):
    year = int(h.qs("year") or date.today().year)
    s = tax.summary(year)
    s["upcoming"] = tax.upcoming()
    s["accounts"] = db.q("SELECT id, name, currency, balance, is_fop, enabled, bank FROM accounts WHERE enabled=1")
    s["years"] = [r["y"] for r in db.q("SELECT DISTINCT substr(date,1,4) AS y FROM transactions ORDER BY y DESC")]
    return s


@route("GET", "/api/transactions")
def api_transactions(h, m, body):
    where, params = ["1=1"], []
    if h.qs("from"):
        where.append("t.date >= ?"); params.append(h.qs("from"))
    if h.qs("to"):
        where.append("t.date <= ?"); params.append(h.qs("to"))
    if h.qs("account"):
        where.append("t.account_id = ?"); params.append(h.qs("account"))
    if h.qs("category"):
        where.append("COALESCE(t.manual_category, t.auto_category) = ?"); params.append(h.qs("category"))
    if h.qs("direction") == "in":
        where.append("t.amount > 0")
    elif h.qs("direction") == "out":
        where.append("t.amount < 0")
    if h.qs("q"):
        where.append("(t.description LIKE ? OR t.counter_name LIKE ? OR t.comment LIKE ? OR t.note LIKE ?)")
        params += ["%" + h.qs("q") + "%"] * 4
    limit = min(int(h.qs("limit") or 100), 1000)
    offset = int(h.qs("offset") or 0)
    w = " AND ".join(where)
    rows = db.q(f"""SELECT t.id, t.account_id, t.ts, t.date, t.amount, t.currency, t.description, t.comment,
                    t.counter_name, t.counter_edrpou, t.counter_iban, t.hold, t.auto_category, t.auto_reason,
                    t.manual_category, t.note, t.nbu_rate, t.uah_amount,
                    COALESCE(t.manual_category, t.auto_category) AS category, a.name AS account_name
                    FROM transactions t JOIN accounts a ON a.id=t.account_id
                    WHERE {w} ORDER BY t.ts DESC LIMIT ? OFFSET ?""", params + [limit, offset])
    total = db.q1(f"""SELECT COUNT(*) AS n,
                      SUM(CASE WHEN COALESCE(t.manual_category,t.auto_category)='income' THEN t.uah_amount ELSE 0 END) AS income
                      FROM transactions t WHERE {w}""", params)
    return {"items": rows, "total": total["n"], "income": (total["income"] or 0) / 100}


@route("PATCH", r"/api/transactions/(?P<id>[^/]+)")
def api_tx_update(h, m, body):
    tx_id = m["id"]
    if not db.q1("SELECT id FROM transactions WHERE id=?", (tx_id,)):
        raise HttpError(404, "Операцію не знайдено")
    if "manual_category" in body:
        cat = body["manual_category"] or None
        if cat and cat not in config.CATEGORIES:
            raise HttpError(400, "Невідома категорія")
        db.ex("UPDATE transactions SET manual_category=? WHERE id=?", (cat, tx_id))
    if "note" in body:
        db.ex("UPDATE transactions SET note=? WHERE id=?", ((body["note"] or "")[:500], tx_id))
    return {"ok": True}


# ----------------------------------------------------------------- банки

def _conn_public(c):
    c = dict(c)
    tok = c.pop("token")
    c["token_masked"] = tok[:4] + "…" + tok[-4:] if len(tok) > 10 else "••••"
    c.pop("webhook_secret", None)
    c["accounts"] = db.q("SELECT * FROM accounts WHERE connection_id=? ORDER BY is_fop DESC, name", (c["id"],))
    return c


@route("GET", "/api/connections")
def api_connections(h, m, body):
    return [_conn_public(c) for c in db.q("SELECT * FROM connections ORDER BY id")]


@route("POST", "/api/connections")
def api_conn_add(h, m, body):
    try:
        cid = add_connection(body.get("bank"), body.get("token"), body.get("client_id"), body.get("name"))
    except ValueError as e:
        raise HttpError(400, str(e))
    except Exception as e:
        raise HttpError(502, f"Банк відхилив запит: {e}")
    worker.enqueue(cid)
    return _conn_public(db.q1("SELECT * FROM connections WHERE id=?", (cid,)))


@route("DELETE", r"/api/connections/(?P<id>\d+)")
def api_conn_delete(h, m, body):
    db.ex("DELETE FROM connections WHERE id=?", (int(m["id"]),))
    return {"ok": True}


@route("POST", r"/api/connections/(?P<id>\d+)/sync")
def api_conn_sync(h, m, body):
    worker.enqueue(int(m["id"]))
    return {"ok": True}


@route("POST", r"/api/connections/(?P<id>\d+)/refresh")
def api_conn_refresh(h, m, body):
    try:
        refresh_accounts(int(m["id"]))
    except Exception as e:
        raise HttpError(502, str(e))
    return {"ok": True}


@route("POST", r"/api/connections/(?P<id>\d+)/webhook")
def api_conn_webhook(h, m, body):
    try:
        return {"url": set_mono_webhook(int(m["id"]))}
    except ValueError as e:
        raise HttpError(400, str(e))
    except Exception as e:
        raise HttpError(502, str(e))


@route("PATCH", r"/api/accounts/(?P<id>[^/]+)")
def api_account_update(h, m, body):
    acc = db.q1("SELECT * FROM accounts WHERE id=?", (m["id"],))
    if not acc:
        raise HttpError(404, "Рахунок не знайдено")
    if "enabled" in body:
        db.ex("UPDATE accounts SET enabled=? WHERE id=?", (1 if body["enabled"] else 0, acc["id"]))
        if body["enabled"]:
            worker.enqueue(acc["connection_id"])
    if "is_fop" in body:
        db.ex("UPDATE accounts SET is_fop=? WHERE id=?", (1 if body["is_fop"] else 0, acc["id"]))
        reclassify_all()
    return {"ok": True}


@route("POST", "/api/sync")
def api_sync(h, m, body):
    return {"queued": worker.enqueue()}


@route("GET", "/api/sync/status")
def api_sync_status(h, m, body):
    return {"status": worker.status, "interval_min": config.SYNC_INTERVAL_MIN,
            "log": db.q("SELECT * FROM sync_log ORDER BY id DESC LIMIT 30")}


# ----------------------------------------------------------------- правила

@route("GET", "/api/rules")
def api_rules(h, m, body):
    return db.q("SELECT * FROM rules ORDER BY priority, id")


@route("POST", "/api/rules")
def api_rule_add(h, m, body):
    pat = (body.get("pattern") or "").strip()
    if not pat or body.get("category") not in config.CATEGORIES:
        raise HttpError(400, "Вкажіть текст і категорію")
    field = body.get("field") if body.get("field") in ("any", "description", "counter_name", "counter_edrpou", "comment") else "any"
    direction = body.get("direction") if body.get("direction") in ("in", "out", "any") else "in"
    db.ex("INSERT INTO rules(pattern, field, direction, category, priority) VALUES (?,?,?,?,?)",
          (pat, field, direction, body["category"], int(body.get("priority") or 50)))
    return {"reclassified": reclassify_all()}


@route("DELETE", r"/api/rules/(?P<id>\d+)")
def api_rule_delete(h, m, body):
    db.ex("DELETE FROM rules WHERE id=?", (int(m["id"]),))
    return {"reclassified": reclassify_all()}


# ----------------------------------------------------------------- налаштування

SETTING_KEYS = {"owner_name": str, "owner_tax_id": str, "sync_start": str, "esv_enabled": bool}


@route("GET", "/api/settings")
def api_settings(h, m, body):
    s = {k: db.get_setting(k) for k in SETTING_KEYS}
    if s["esv_enabled"] is None:
        s["esv_enabled"] = True
    s["sync_start"] = s["sync_start"] or f"{date.today().year}-01-01"
    s["tax_params"] = db.q("SELECT * FROM tax_params ORDER BY year DESC")
    s["public_url"] = config.PUBLIC_URL
    return s


@route("PUT", "/api/settings")
def api_settings_put(h, m, body):
    for k, typ in SETTING_KEYS.items():
        if k in body:
            v = body[k]
            if k == "sync_start" and v and not re.match(r"^\d{4}-\d{2}-\d{2}$", v):
                raise HttpError(400, "Дата у форматі РРРР-ММ-ДД")
            db.set_setting(k, typ(v) if v is not None else None)
    if "sync_start" in body:
        db.ex("UPDATE accounts SET synced_to=NULL")  # перезавантажити з нової дати
    reclassify_all()
    return {"ok": True}


@route("PUT", r"/api/tax-params/(?P<year>\d{4})")
def api_tax_params(h, m, body):
    try:
        vals = [float(body[k]) for k in ("min_wage", "income_limit", "esv_month", "single_tax_rate", "mil_rate")]
    except (KeyError, TypeError, ValueError):
        raise HttpError(400, "Заповніть усі параметри числами")
    db.ex("INSERT OR REPLACE INTO tax_params(year, min_wage, income_limit, esv_month, single_tax_rate, mil_rate)"
          " VALUES (?,?,?,?,?,?)", [int(m["year"])] + vals)
    return {"ok": True}


# ----------------------------------------------------------------- експорт

@route("GET", "/api/export/income-book.csv")
def api_export(h, m, body):
    d_from = h.qs("from") or f"{date.today().year}-01-01"
    d_to = h.qs("to") or f"{date.today().year}-12-31"
    out = io.StringIO()
    w = csv.writer(out, delimiter=";")
    w.writerow(["№", "Дата", "Сума доходу, грн", "Сума у валюті", "Валюта", "Курс НБУ",
                "Повернення коштів, грн", "Контрагент", "Призначення", "Рахунок"])
    total = 0
    for i, r in enumerate(tax.income_book(d_from, d_to), 1):
        uah = (r["uah_amount"] or 0) / 100
        is_ref = r["category"] == "refund_to_buyer"
        total += -abs(uah) if is_ref else uah
        w.writerow([i, date.fromisoformat(r["date"]).strftime("%d.%m.%Y"),
                    "" if is_ref else f"{uah:.2f}".replace(".", ","),
                    f"{abs(r['amount']) / 100:.2f}".replace(".", ",") if r["currency"] != "UAH" else "",
                    r["currency"], r["nbu_rate"] or "",
                    f"{abs(uah):.2f}".replace(".", ",") if is_ref else "",
                    r["counter_name"], r["description"], r["account"]])
    w.writerow(["", "Разом", f"{total:.2f}".replace(".", ",")])
    h.send_raw(200, ("﻿" + out.getvalue()).encode("utf-8"), "text/csv; charset=utf-8",
               {"Content-Disposition": f'attachment; filename="income-book_{d_from}_{d_to}.csv"'})
    return None


# ----------------------------------------------------------------- вебхук

@route("GET", r"/webhook/mono/(?P<secret>[\w-]+)", public=True)
def wh_mono_check(h, m, body):
    return {"ok": True}


@route("POST", r"/webhook/mono/(?P<secret>[\w-]+)", public=True)
def wh_mono(h, m, body):
    if not handle_mono_webhook(m["secret"], body):
        raise HttpError(404, "not found")
    return {"ok": True}


# ======================================================================= обробник

class Handler(BaseHTTPRequestHandler):
    server_version = "fop-income"
    set_cookie = None

    def log_message(self, fmt, *args):
        if os.environ.get("ACCESS_LOG") == "1":
            super().log_message(fmt, *args)

    def qs(self, key):
        return self._qs.get(key, [None])[0]

    def authenticated(self):
        if not config.APP_PASSWORD:
            return True
        c = SimpleCookie(self.headers.get("Cookie", ""))
        return "session" in c and valid_session(c["session"].value)

    def send_raw(self, status, data, ctype, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        if self.set_cookie is not None:
            attrs = "Path=/; HttpOnly; SameSite=Lax" + ("; Secure" if config.COOKIE_SECURE else "")
            if self.set_cookie:
                self.send_header("Set-Cookie", f"session={self.set_cookie}; Max-Age={SESSION_TTL}; {attrs}")
            else:
                self.send_header("Set-Cookie", f"session=; Max-Age=0; {attrs}")
        for k, v in (extra or {}).items():
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
            if not path.startswith("/api/") and not path.startswith("/webhook/"):
                if method in ("GET", "HEAD"):
                    return self._static(path)
                raise HttpError(404, "Not found")
            for rmethod, rx, fn, public in ROUTES:
                mt = rx.match(path)
                if mt and rmethod == method:
                    if not public and not self.authenticated():
                        raise HttpError(401, "Потрібен вхід")
                    body = None
                    if method in ("POST", "PUT", "PATCH", "DELETE"):
                        n = int(self.headers.get("Content-Length") or 0)
                        if n > 1_000_000:
                            raise HttpError(413, "Завеликий запит")
                        raw = self.rfile.read(n) if n else b""
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
        except HttpError as e:
            self.send_json(e.status, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            self.send_json(500, {"error": f"Внутрішня помилка: {e}"})

    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.realpath(os.path.join(config.STATIC_DIR, path.lstrip("/")))
        if not full.startswith(os.path.realpath(config.STATIC_DIR)) or not os.path.isfile(full):
            full = os.path.join(config.STATIC_DIR, "index.html")
        with open(full, "rb") as f:
            data = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self.send_raw(200, data, ctype, {"Cache-Control": "no-cache"})

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


def main():
    db.init()
    if not config.APP_PASSWORD:
        print("⚠  APP_PASSWORD не задано — вхід без пароля. Не відкривайте застосунок в інтернет без пароля!")
    if os.environ.get("DISABLE_SYNC") != "1":
        worker.start()
    srv = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    print(f"ФОП-дохід працює: http://localhost:{config.PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
