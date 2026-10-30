"""Monobank — відкритий API для фізосіб (https://api.monobank.ua/docs/).

Токен: https://api.monobank.ua/ → «Отримати токен».
Обмеження банку:
  * /personal/client-info — не частіше 1 разу на 60 с;
  * /personal/statement/{account}/{from}/{to} — не частіше 1 разу на 60 с,
    період не більше 31 доби + 1 година, до 500 операцій за відповідь
    (якщо прийшло рівно 500 — запитуємо ще раз з to = час останньої операції).
Рахунки ФОП у client-info мають type = "fop".
"""
import time

from .. import config
from ..http import request
from . import ISO_NUM_TO_CC

MAX_PERIOD = 31 * 24 * 3600 + 3600
PAGE = 500


class MonoClient:
    def __init__(self, token, base=None, throttle=None):
        self.token = token
        self.base = (base or config.MONO_API).rstrip("/")
        self.throttle = throttle or (lambda: None)

    def _get(self, path):
        return request("GET", self.base + path, headers={"X-Token": self.token})

    def client_info(self):
        self.throttle()
        info = self._get("/personal/client-info")
        accounts = []
        for a in info.get("accounts", []):
            accounts.append({
                "ext_id": a["id"],
                "iban": a.get("iban"),
                "currency": ISO_NUM_TO_CC.get(a.get("currencyCode"), str(a.get("currencyCode"))),
                "type": a.get("type"),
                "name": _account_name(a),
                "balance": a.get("balance"),
                "is_fop": a.get("type") == "fop",
            })
        return {"name": info.get("name"), "accounts": accounts, "webHookUrl": info.get("webHookUrl")}

    def statement(self, account_id, ts_from, ts_to):
        """Генератор сирих операцій за період (сам ділить на вікна по 31 добі та сторінки)."""
        start = int(ts_from)
        while start < ts_to:
            end = min(int(ts_to), start + MAX_PERIOD - 1)
            to = end
            while True:
                self.throttle()
                items = self._get(f"/personal/statement/{account_id}/{start}/{to}") or []
                for it in items:
                    yield it
                if len(items) < PAGE:
                    break
                to = min(it["time"] for it in items) - 1
                if to <= start:
                    break
            start = end + 1

    def set_webhook(self, url):
        self.throttle()
        return request("POST", self.base + "/personal/webhook",
                       headers={"X-Token": self.token}, body={"webHookUrl": url})


def _account_name(a):
    t = a.get("type")
    names = {"fop": "ФОП", "black": "Чорна картка", "white": "Біла картка", "platinum": "Platinum",
             "iron": "Iron", "yellow": "Жовта картка", "eAid": "єПідтримка", "madeInUkraine": "Зроблено в Україні"}
    cc = ISO_NUM_TO_CC.get(a.get("currencyCode"), "")
    pan = (a.get("maskedPan") or [""])[0]
    return " ".join(x for x in [names.get(t, t or "Рахунок"), cc, pan or (a.get("iban") or "")[-6:]] if x)


def normalize(item, account):
    """Сира операція Monobank → нормалізований словник."""
    return {
        "ext_id": item["id"],
        "ts": int(item["time"]),
        "amount": int(item["amount"]),  # у валюті рахунку, мінімальні одиниці
        "currency": account["currency"],
        "description": item.get("description") or "",
        "comment": item.get("comment") or "",
        "counter_name": item.get("counterName") or "",
        "counter_edrpou": item.get("counterEdrpou") or "",
        "counter_iban": item.get("counterIban") or "",
        "hold": 1 if item.get("hold") else 0,
        "raw": item,
    }


class Throttle:
    """Глобальна пауза між запитами до Monobank для одного токена."""
    def __init__(self, interval=None):
        self.interval = config.MONO_MIN_INTERVAL_SEC if interval is None else interval
        self.last = 0.0

    def __call__(self):
        wait = self.last + self.interval - time.time()
        if wait > 0:
            time.sleep(wait)
        self.last = time.time()
