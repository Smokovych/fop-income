"""Пропускає запити браузерної програми до API банків і НБУ.

ПриватБанк не приймає запити з браузера (немає CORS), тому на сервері програма звертається
до банків через ці адреси. Дозволено лише читання: виписки, баланси, курси. Відповідь банку
повертається як є (статус і тіло), тож браузерний код обробляє її так само, як пряму.
"""
import base64
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


# Сервери CMP кваліфікованих надавачів (з реєстру IIT CAs.json, жовтень 2026) — той самий список,
# що FopKep.CMP_URLS у standalone/vendor/kep-entry.js. Сюди сервер шле запит сертифіката за ідентифікатором ключа.
_CMP_HOSTS = ["ca.monobank.ua/services/cmp/", "acsk.privatbank.ua", "ca.diia.gov.ua", "ca.tax.gov.ua", "ca.depositsign.com",
              "ca.vchasno.ua", "uakey.com.ua", "masterkey.ua", "pki.pumb.ua", "csk.ukrsibbank.com", "ca.sensebank.com.ua",
              "ca.credit-agricole.ua", "amokey.com.ua", "ca.edin.ua", "cmp.e-life.com.ua/api/PKI/CMP", "ca.bankalliance.ua/cmp",
              "qca.ukrgasbank.com/cmp", "ca.pravex.com.ua", "ca.tascombank.ua", "csk.uss.gov.ua", "csk.uz.gov.ua",
              "acsk.oree.com.ua", "canbu.bank.gov.ua", "ca.mil.gov.ua", "acsk.dpsu.gov.ua", "ca.ngu.gov.ua", "ca.mvs.gov.ua",
              "ca.szru.gov.ua", "ca.gp.gov.ua/cmp", "va1-knedp.ssu.gov.ua/services/cmp/"]
CMP_URLS = ["http://" + (h if "/" in h else h + "/services/cmp/") for h in _CMP_HOSTS]
TAX_ALLOWED = re.compile(r"^(payer_card(/\d{1,2})?|ta/splatp(/\d{4}/\d{1,6}/[0-9A-Za-z]{8,64}/pa)?)$")
TAX_PARAMS = ("page", "size", "year")


class ProxyError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _fetch(url, headers, timeout=60, data=None):
    """Повертає (статус, байти, content-type). Помилки HTTP банку не є винятком — їх віддаємо як є."""
    headers = {"User-Agent": "fop-income/1.0", **headers}
    req = urllib.request.Request(url, headers=headers, method="POST" if data is not None else "GET", data=data)
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


def tax_bridge(p):
    """Те саме, що міст Google Apps Script для Кабінету (standalone/tax.js), але на сервері.

    p = {path: "payer_card[/N]", params, auth} — запит до Кабінету з підписаним РНОКПП;
    p = {path: "cmp", url, body} — пошук сертифіката ключа на сервері надавача.
    Відповідь у форматі мосту: {status, http, body | body64}.
    """
    path = str(p.get("path") or "")
    if path == "cmp":
        url = str(p.get("url") or "")
        if url not in CMP_URLS:
            raise ProxyError(403, "Недозволена адреса")
        try:
            payload = base64.b64decode(p.get("body") or "", validate=True)
        except (ValueError, TypeError):
            raise ProxyError(400, "Некоректний запит") from None
        try:
            status, body, _ = _fetch(config.CMP_TEST_URL or url, {"Content-Type": "application/octet-stream"}, timeout=30, data=payload)
        except ProxyError as e:
            return {"status": "SUCCESS", "http": 0, "body64": "", "message": str(e)}
        return {"status": "SUCCESS", "http": status, "body64": base64.b64encode(body).decode()}
    if not TAX_ALLOWED.match(path):
        raise ProxyError(403, "Недозволений запит")
    auth = str(p.get("auth") or "")
    if not auth or not re.fullmatch(r"[A-Za-z0-9+/=]{100,200000}", auth):
        raise ProxyError(400, "Немає підпису")
    params = {k: str(v) for k, v in (p.get("params") or {}).items() if k in TAX_PARAMS and re.fullmatch(r"\d{1,4}", str(v))}
    url = f"{config.TAX_API}/{path}" + ("?" + urllib.parse.urlencode(params) if params else "")
    try:
        status, body, _ = _fetch(url, {"Authorization": auth, "Accept": "application/json", "Content-Type": "application/json"})
    except ProxyError as e:
        return {"status": "ERROR", "stage": "cabinet", "message": f"Сервер не зміг з'єднатися з Кабінетом: {e}"}
    return {"status": "SUCCESS", "http": status, "body": body.decode("utf-8", "replace")}
