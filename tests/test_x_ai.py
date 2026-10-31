# Імпортується після test_app (за алфавітом), бо той задає змінні середовища до першого імпорту app.config
import unittest
from app import ai

STATE = {
    "settings": {"owner_name": "Тест", "sync_start": "2024-01-01"},
    "accounts": {"a": {"id": "a", "name": "UAH", "bank": "privat", "currency": "UAH", "is_fop": True, "enabled": True},
                 "e": {"id": "e", "name": "EUR", "bank": "privat", "currency": "EUR", "is_fop": True, "enabled": True}},
    "tx": {
        "1": {"account_id": "a", "date": "2024-02-10", "ts": 1, "amount": 100000, "currency": "UAH", "uah_amount": 100000, "nbu_rate": 1, "auto_category": "income", "counter_name": "Клієнт А", "description": "оплата"},
        "2": {"account_id": "e", "date": "2024-05-10", "ts": 2, "amount": 10000, "currency": "EUR", "uah_amount": 420000, "nbu_rate": 42, "auto_category": "income", "counter_name": "Client B", "description": "From B"},
        "3": {"account_id": "a", "date": "2024-05-11", "ts": 3, "amount": 430000, "currency": "UAH", "uah_amount": 430000, "nbu_rate": 1, "auto_category": "currency_exchange", "description": "Гривні від продажу"},
        "4": {"account_id": "a", "date": "2024-06-01", "ts": 4, "amount": 50000, "currency": "UAH", "uah_amount": 50000, "nbu_rate": 1, "auto_category": "own_transfer", "manual_category": "income", "counter_name": "Клієнт А"},
    },
}


class AiToolsTest(unittest.TestCase):
    def test_group_by_quarter_income_only(self):
        r = ai.query_transactions(STATE, {"category": "income", "group_by": "quarter"})
        self.assertEqual(r["count"], 3)
        self.assertEqual([(g["key"], g["income_uah"]) for g in r["groups"]], [("2024-Q1", 1000.0), ("2024-Q2", 4700.0)])

    def test_fx_sale_not_income(self):
        r = ai.query_transactions(STATE, {"text": "продажу"})
        self.assertEqual((r["count"], r["income_uah"]), (1, 0.0))

    def test_tax_overview(self):
        r = ai.tax_overview(STATE, {"year": 2024})
        self.assertEqual(r["year_income"], 5700.0)
        self.assertEqual(r["quarters"][1]["single_tax"], 235.0)

    def test_disabled_without_key(self):
        import os
        os.environ.pop("ANTHROPIC_API_KEY", None)
        with self.assertRaises(ai.AiError):
            ai.ask("питання")


if __name__ == "__main__":
    unittest.main()
