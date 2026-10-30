"""Автоматична класифікація операцій: дохід чи ні.

Логіка (ФОП 3 група, ст. 292 ПКУ):
  * дохід — кошти, що надійшли на рахунок ФОП від клієнтів;
  * НЕ дохід — власні кошти, перекази між своїми рахунками, купівля/продаж валюти,
    повернення помилково зарахованих коштів, кредити/позики, повернення податків;
  * повернення коштів покупцю зменшує дохід того періоду, в якому повернуто.
Користувач завжди може змінити категорію вручну — ручна категорія має пріоритет.
"""
import re

from . import db


def _norm(s):
    return re.sub(r"\s+", " ", (s or "").lower().replace("ʼ", "'").replace("’", "'")).strip()


class Classifier:
    def __init__(self):
        self.rules = db.q("SELECT * FROM rules ORDER BY priority, id")
        self.own_ibans = {r["iban"] for r in db.q("SELECT iban FROM accounts WHERE iban IS NOT NULL AND iban != ''")}
        owner = db.get_setting("owner_name") or ""
        names = {owner} | {r["owner_name"] for r in db.q("SELECT owner_name FROM connections") if r["owner_name"]}
        self.owner_names = [_norm(n) for n in names if n and len(n.strip()) >= 5]
        self.owner_tax_id = (db.get_setting("owner_tax_id") or "").strip()

    def _is_owner_name(self, counter_name):
        cn = _norm(counter_name)
        if not cn:
            return False
        for n in self.owner_names:
            parts = [p for p in n.split(" ") if len(p) > 1]
            # збіг, якщо в назві контрагента є прізвище та ім'я власника
            if len(parts) >= 2 and all(p in cn for p in parts[:2]):
                return True
            if n == cn:
                return True
        return False

    def classify(self, tx, account):
        """Повертає (категорія, причина)."""
        amount = tx["amount"]
        direction = "in" if amount > 0 else "out"
        fields = {
            "description": _norm(tx.get("description")),
            "counter_name": _norm(tx.get("counter_name")),
            "counter_edrpou": _norm(tx.get("counter_edrpou")),
            "comment": _norm(tx.get("comment")),
        }
        for r in self.rules:
            if r["direction"] not in ("any", direction):
                continue
            pat = _norm(r["pattern"])
            if not pat:
                continue
            hay = " | ".join(fields.values()) if r["field"] == "any" else fields.get(r["field"], "")
            if pat in hay:
                return r["category"], f"правило «{r['pattern']}»"

        if direction == "out":
            return "expense", "списання"

        if not account.get("is_fop"):
            return "other_non_income", "надходження на особистий (не ФОП) рахунок"
        if tx.get("counter_iban") and tx["counter_iban"] in self.own_ibans:
            return "own_transfer", "з власного рахунку (IBAN)"
        if self.owner_tax_id and tx.get("counter_edrpou") == self.owner_tax_id:
            return "own_transfer", "відправник — ваш РНОКПП"
        if self._is_owner_name(tx.get("counter_name")):
            return "own_transfer", "відправник — ви"
        return "income", "надходження на рахунок ФОП"


def reclassify_all():
    """Перекласифікувати всі операції (ручні категорії не чіпаємо)."""
    c = Classifier()
    accounts = {a["id"]: a for a in db.q("SELECT * FROM accounts")}
    conn = db.connect()
    n = 0
    for tx in db.q("SELECT * FROM transactions"):
        acc = accounts.get(tx["account_id"])
        if not acc:
            continue
        cat, reason = c.classify(tx, acc)
        if cat != tx["auto_category"] or reason != tx["auto_reason"]:
            conn.execute("UPDATE transactions SET auto_category=?, auto_reason=? WHERE id=?", (cat, reason, tx["id"]))
            n += 1
    conn.commit()
    return n
