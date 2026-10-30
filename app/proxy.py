"""Пропускає запити браузерної програми до API банків і НБУ.

ПриватБанк не приймає запити з браузера (немає CORS), тому на сервері програма звертається
до банків через ці адреси. Дозволено лише читання: виписки, баланси, курси. Відповідь банку
повертається як є (статус і тіло), тож браузерний код обробляє її так само, як пряму.
"""
import re
import urllib.error
import urllib.parse
import urllib.request

from . import config

MONO_ALLOWED = re.compile(r"^personal/(client-info|statement/[\w-]+/\d+(/\d+)?)$")
PRIVAT_ALLOWED = {
    "statements/settings", "statements/balance", "statements/transactions",
    "statements/balance/interim", "statements/transactions/interim",
    "statements/balance/final", "statements/transactions/final",
}
PRIVAT_PARAMS = ("acc", "startDate", "endDate", "followId", "limit")
NBU_PARAMS = ("valcode", "date", "json")


class ProxyError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _fetch(url, headers, timeout=60):
    """Повертає (статус, байти, content-type). Помилки HTTP банку не є винятком — їх віддаємо як є."""
    headers = {"User-Agent": "fop-income/1.0", **headers}
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), r.headers.get("Content-Type") or "application/json"
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("Content-Type") or "application/json"
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ProxyError(502, f"Немає з'єднання з банком: {getattr(e, 'reason', e)}") from None


def mono(path, token):
    if not MONO_ALLOWED.match(path):
        raise ProxyError(403, "Недозволений запит до Monobank")
    if not token:
        raise ProxyError(400, "Немає токена Monobank")
    return _fetch(f"{config.MONO_API}/{path}", {"X-Token": token})


def privat(path, query, token):
    if path not in PRIVAT_ALLOWED:
        raise ProxyError(403, "Недозволений запит до ПриватБанку")
    if not token:
        raise ProxyError(400, "Немає токена ПриватБанку")
    params = {k: query[k] for k in PRIVAT_PARAMS if query.get(k)}
    url = f"{config.PRIVAT_API}/{path}" + ("?" + urllib.parse.urlencode(params) if params else "")
    status, body, ctype = _fetch(url, {"token": token, "Content-Type": "application/json;charset=utf8"})
    if "1251" in ctype.lower():
        body = body.decode("cp1251", "replace").encode("utf-8")
        ctype = "application/json; charset=utf-8"
    return status, body, ctype


def nbu(query):
    params = {k: query[k] for k in NBU_PARAMS if k in query}
    if not params.get("valcode") or not re.fullmatch(r"[A-Z]{3}", params["valcode"]):
        raise ProxyError(400, "Некоректний код валюти")
    if not re.fullmatch(r"\d{8}", params.get("date") or ""):
        raise ProxyError(400, "Некоректна дата")
    url = f"{config.NBU_API}?valcode={params['valcode']}&date={params['date']}&json"
    return _fetch(url, {}, timeout=30)
