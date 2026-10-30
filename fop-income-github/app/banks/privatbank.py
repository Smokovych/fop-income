"""ПриватБанк — API «Автоклієнт» (Приват24 для бізнесу).

Підключення: Приват24 для бізнесу → Каталог послуг → Інтеграція (Автоклієнт) →
створити інтеграцію «Отримання виписок» і скопіювати токен (і, якщо видано, id).

Базова адреса: https://acp.privatbank.ua/api
  GET /statements/balance?acc=&startDate=ДД-ММ-РРРР&endDate=&followId=&limit=
  GET /statements/transactions?acc=&startDate=ДД-ММ-РРРР&endDate=&followId=&limit=
Відповідь: {"status": "SUCCESS", "exist_next_page": bool, "next_page_id": "...",
            "transactions": [...], "balances": [...]}
Поля транзакції: ID, TRANTYPE (C — надходження, D — списання), SUM, CCY, OSND (призначення),
AUT_CNTR_NAM / AUT_CNTR_CRF / AUT_CNTR_ACC (контрагент), AUT_MY_ACC, DAT_OD, TIM_P,
DATE_TIME_DAT_OD_TIM_P, PR_PR (r — проведена), FL_REAL (r — реальна), REF, REFN.
"""
import time
from datetime import datetime

from .. import config
from ..http import request

PAGE = 500


class PrivatClient:
    def __init__(self, token, client_id=None, base=None):
        self.token = token
        self.client_id = client_id
        self.base = (base or config.PRIVAT_API).rstrip("/")

    def _headers(self):
        h = {"token": self.token, "Content-Type": "application/json;charset=utf8"}
        if self.client_id:
            h["id"] = self.client_id
        return h

    def _get(self, path, params):
        data = request("GET", self.base + path, headers=self._headers(), params=params)
        if isinstance(data, dict) and data.get("status") not in (None, "SUCCESS"):
            raise RuntimeError(f"ПриватБанк: {data.get('message') or data.get('status')}")
        return data or {}

    def _paged(self, path, params, key):
        follow = None
        while True:
            p = dict(params, limit=PAGE)
            if follow:
                p["followId"] = follow
            data = self._get(path, p)
            for it in data.get(key) or []:
                yield it
            if not data.get("exist_next_page") or not data.get("next_page_id"):
                break
            follow = data["next_page_id"]
            time.sleep(0.3)

    def accounts(self):
        """Список рахунків з балансами (за сьогодні)."""
        today = datetime.now(config.KYIV).strftime("%d-%m-%Y")
        result = {}
        for b in self._paged("/statements/balance", {"startDate": today, "endDate": today}, "balances"):
            acc = b.get("acc")
            if not acc:
                continue
            bal = b.get("balanceOutEq") or b.get("balanceOut") or "0"
            result[acc] = {
                "ext_id": acc,
                "iban": acc,
                "currency": (b.get("currency") or "UAH").upper(),
                "type": "business",
                "name": (b.get("nameACC") or "Рахунок") + " " + acc[-6:],
                "balance": _to_minor(b.get("balanceOut") or bal),
                "is_fop": True,
            }
        return list(result.values())

    def transactions(self, acc, ts_from, ts_to):
        start = datetime.fromtimestamp(ts_from, config.KYIV).strftime("%d-%m-%Y")
        end = datetime.fromtimestamp(ts_to, config.KYIV).strftime("%d-%m-%Y")
        yield from self._paged("/statements/transactions",
                               {"acc": acc, "startDate": start, "endDate": end}, "transactions")


def _to_minor(s):
    try:
        return int(round(float(str(s).replace(",", ".").replace(" ", "")) * 100))
    except (TypeError, ValueError):
        return 0


def _parse_dt(item):
    for key, fmts in (("DATE_TIME_DAT_OD_TIM_P", ("%d.%m.%Y %H:%M:%S", "%d.%m.%Y %H:%M")),
                      ("DAT_OD", ("%d.%m.%Y", "%Y-%m-%d")),
                      ("DAT_KL", ("%d.%m.%Y", "%Y-%m-%d"))):
        v = (item.get(key) or "").strip()
        if not v:
            continue
        if key == "DAT_OD" and item.get("TIM_P"):
            v2 = v + " " + item["TIM_P"].strip()
            for f in ("%d.%m.%Y %H:%M", "%d.%m.%Y %H:%M:%S"):
                try:
                    return datetime.strptime(v2, f).replace(tzinfo=config.KYIV)
                except ValueError:
                    pass
        for f in fmts:
            try:
                return datetime.strptime(v, f).replace(tzinfo=config.KYIV)
            except ValueError:
                pass
    raise ValueError(f"Невідомий формат дати в операції ПриватБанку: {item.get('ID')}")


def is_real(item):
    """Пропускаємо інформаційні та сторновані/забраковані операції."""
    if (item.get("FL_REAL") or "r").lower() != "r":
        return False
    return (item.get("PR_PR") or "r").lower() in ("r", "p")


def normalize(item, account):
    dt = _parse_dt(item)
    amount = _to_minor(item.get("SUM"))
    if (item.get("TRANTYPE") or "").upper() == "D":
        amount = -abs(amount)
    else:
        amount = abs(amount)
    ext_id = str(item.get("ID") or f"{item.get('REF')}.{item.get('REFN')}")
    return {
        "ext_id": ext_id,
        "ts": int(dt.timestamp()),
        "amount": amount,
        "currency": (item.get("CCY") or account["currency"]).upper(),
        "description": item.get("OSND") or "",
        "comment": "",
        "counter_name": item.get("AUT_CNTR_NAM") or "",
        "counter_edrpou": item.get("AUT_CNTR_CRF") or "",
        "counter_iban": item.get("AUT_CNTR_ACC") or "",
        "hold": 0 if (item.get("PR_PR") or "r").lower() == "r" else 1,
        "raw": item,
    }
