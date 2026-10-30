"""Тести: python -m unittest discover -s tests -v"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tests import mock_banks  # noqa: E402

MOCK_PORT = 18090
APP_PORT = 18091
_tmp = tempfile.mkdtemp()
os.environ.update({
    "DB_PATH": os.path.join(_tmp, "test.sqlite3"),
    "MONO_API": f"http://127.0.0.1:{MOCK_PORT}/mono",
    "PRIVAT_API": f"http://127.0.0.1:{MOCK_PORT}/privat",
    "NBU_API": f"http://127.0.0.1:{MOCK_PORT}/nbu",
    "MONO_MIN_INTERVAL_SEC": "0",
    "APP_PASSWORD": "secret-pass",
    "PUBLIC_URL": "https://fop.example.com",
})

from app import db, tax, sync, server  # noqa: E402

mock_banks.serve(MOCK_PORT)
db.init()


def expected_mono_income():
    """Незалежний розрахунок очікуваного доходу з мок-даних (2026 рік)."""
    total = 0
    for x in mock_banks.MONO["acc-fop-uah"]:
        if x["amount"] > 0 and x["description"] != "Продаж валюти" and x.get("counterName") != "ШЕВЧЕНКО МИХАЙЛО":
            total += x["amount"]
        if x["id"] == "mr1":
            total += x["amount"]  # повернення покупцю (від'ємне)
    for x in mock_banks.MONO["acc-fop-usd"]:
        if x["amount"] > 0:
            total += round(x["amount"] * mock_banks.NBU_USD)
    return total / 100


def expected_privat_income():
    return sum(float(x["SUM"]) for x in mock_banks.PRIVAT
               if x["FL_REAL"] == "r" and "поворотної" not in x["OSND"])


class T1_Deadlines(unittest.TestCase):
    def test_q1_2026(self):
        d = tax.quarter_deadlines(2026, 1)
        self.assertEqual(d["declaration"], "2026-05-11")  # 10.05 — неділя → понеділок
        self.assertEqual(d["single_tax"], "2026-05-20")
        self.assertEqual(d["esv"], "2026-04-20")

    def test_q4(self):
        d = tax.quarter_deadlines(2026, 4)
        self.assertEqual(d["declaration"], "2027-02-09")
        self.assertEqual(d["esv"], "2027-01-20")


class T2_Mono(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cid = sync.add_connection("mono", "test-token")
        sync.sync_connection(cls.cid)

    def test_accounts(self):
        accs = {a["ext_id"]: a for a in db.q("SELECT * FROM accounts WHERE bank='mono'")}
        self.assertTrue(accs["acc-fop-uah"]["enabled"])
        self.assertTrue(accs["acc-fop-usd"]["is_fop"])
        self.assertFalse(accs["acc-black"]["enabled"])  # особиста картка за замовчуванням не тягнеться
        self.assertEqual(db.get_setting("owner_name"), "Шевченко Михайло")

    def test_pagination(self):
        n = db.q1("SELECT COUNT(*) n FROM transactions WHERE id LIKE 'mono:mp%'")["n"]
        self.assertEqual(n, 620)

    def test_classification(self):
        cat = lambda i: db.q1("SELECT auto_category c FROM transactions WHERE id=?", (i,))["c"]
        own = db.q1("SELECT id FROM transactions WHERE id LIKE 'mono:mo%'")
        if own:
            self.assertEqual(cat(own["id"]), "own_transfer")
        fx = db.q1("SELECT id FROM transactions WHERE id LIKE 'mono:mx%'")
        self.assertEqual(cat(fx["id"]), "currency_exchange")
        self.assertEqual(cat("mono:mr1"), "refund_to_buyer")
        usd = db.q1("SELECT * FROM transactions WHERE id LIKE 'mono:md%'")
        self.assertEqual(usd["auto_category"], "income")
        self.assertEqual(usd["uah_amount"], round(usd["amount"] * mock_banks.NBU_USD))


class T3_Privat(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cid = sync.add_connection("privat", "privat-token")
        sync.sync_connection(cls.cid)

    def test_imported(self):
        n_real = sum(1 for x in mock_banks.PRIVAT if x["FL_REAL"] == "r")
        n = db.q1("SELECT COUNT(*) n FROM transactions WHERE id LIKE 'privat:%'")["n"]
        self.assertEqual(n, n_real)  # інформаційні пропущено, пагінація працює

    def test_loan(self):
        r = db.q1("SELECT auto_category c FROM transactions WHERE id LIKE 'privat:PL%'")
        if r:
            self.assertEqual(r["c"], "loan")


class T4_Totals(unittest.TestCase):
    def test_total_income(self):
        s = tax.summary(2026)
        exp = expected_mono_income() + expected_privat_income()
        self.assertAlmostEqual(s["total_income"], exp, places=2)
        q = s["quarters"][1]
        self.assertAlmostEqual(q["single_tax"], round(q["net_income"] * 0.05, 2), places=2)
        self.assertAlmostEqual(q["military"], round(q["net_income"] * 0.01, 2), places=2)
        self.assertEqual(s["quarters"][1]["refunds"], 15000.0)

    def test_resync_idempotent(self):
        before = db.q1("SELECT COUNT(*) n FROM transactions")["n"]
        db.ex("UPDATE accounts SET synced_to=NULL")
        for c in db.q("SELECT id FROM connections"):
            sync.sync_connection(c["id"])
        self.assertEqual(db.q1("SELECT COUNT(*) n FROM transactions")["n"], before)

    def test_manual_override_survives_resync(self):
        tx = db.q1("SELECT id FROM transactions WHERE auto_category='income' LIMIT 1")
        db.ex("UPDATE transactions SET manual_category='other_non_income' WHERE id=?", (tx["id"],))
        db.ex("UPDATE accounts SET synced_to=NULL")
        for c in db.q("SELECT id FROM connections"):
            sync.sync_connection(c["id"])
        self.assertEqual(db.q1("SELECT manual_category m FROM transactions WHERE id=?", (tx["id"],))["m"], "other_non_income")
        db.ex("UPDATE transactions SET manual_category=NULL WHERE id=?", (tx["id"],))


class T5_Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer
        cls.srv = ThreadingHTTPServer(("127.0.0.1", APP_PORT), server.Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{APP_PORT}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def req(self, method, path, body=None, cookie=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method)
        if data:
            r.add_header("Content-Type", "application/json")
        if cookie:
            r.add_header("Cookie", cookie)
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, resp.read(), resp.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def login(self):
        st, _, h = self.req("POST", "/api/login", {"password": "secret-pass"})
        self.assertEqual(st, 200)
        return h["Set-Cookie"].split(";")[0]

    def test_auth_required(self):
        st, _, _ = self.req("GET", "/api/summary")
        self.assertEqual(st, 401)
        st, _, _ = self.req("POST", "/api/login", {"password": "wrong"})
        self.assertEqual(st, 401)

    def test_summary_and_export(self):
        c = self.login()
        st, body, _ = self.req("GET", "/api/summary?year=2026", cookie=c)
        self.assertEqual(st, 200)
        s = json.loads(body)
        self.assertGreater(s["total_income"], 0)
        st, body, h = self.req("GET", "/api/export/income-book.csv?from=2026-01-01&to=2026-12-31", cookie=c)
        self.assertEqual(st, 200)
        text = body.decode("utf-8-sig")
        self.assertIn("Разом", text)
        last = text.strip().splitlines()[-1].split(";")
        self.assertAlmostEqual(float(last[2].replace(",", ".")), s["total_income"], places=2)

    def test_patch_category(self):
        c = self.login()
        st, body, _ = self.req("GET", "/api/transactions?category=income&limit=1", cookie=c)
        tx = json.loads(body)["items"][0]
        st, _, _ = self.req("PATCH", "/api/transactions/" + urllib.parse.quote(tx["id"]),
                            {"manual_category": "own_transfer"}, cookie=c)
        self.assertEqual(st, 200)
        st, _, _ = self.req("PATCH", "/api/transactions/" + urllib.parse.quote(tx["id"]),
                            {"manual_category": None}, cookie=c)
        self.assertEqual(st, 200)

    def test_csrf_form_post_rejected(self):
        c = self.login()
        r = urllib.request.Request(self.base + "/api/sync", data=b"a=1", method="POST",
                                   headers={"Cookie": c, "Content-Type": "application/x-www-form-urlencoded"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(r)
        self.assertEqual(e.exception.code, 415)

    def test_webhook(self):
        conn = db.q1("SELECT * FROM connections WHERE bank='mono'")
        item = {"id": "wh-1", "time": int(date(2026, 10, 29).strftime("%s")) + 43200, "description": "Оплата",
                "amount": 100000, "currencyCode": 980, "counterName": "ТОВ «Нова»"}
        st, _, _ = self.req("POST", f"/webhook/mono/{conn['webhook_secret']}",
                            {"type": "StatementItem", "data": {"account": "acc-fop-uah", "statementItem": item}})
        self.assertEqual(st, 200)
        self.assertEqual(db.q1("SELECT auto_category c FROM transactions WHERE id='mono:wh-1'")["c"], "income")
        st, _, _ = self.req("POST", "/webhook/mono/wrong", {"type": "StatementItem", "data": {}})
        self.assertEqual(st, 404)
        db.ex("DELETE FROM transactions WHERE id='mono:wh-1'")

    def test_static_traversal(self):
        st, body, _ = self.req("GET", "/../app/config.py")
        self.assertNotIn(b"APP_PASSWORD", body)


import urllib.error  # noqa: E402
import urllib.parse  # noqa: E402

if __name__ == "__main__":
    unittest.main(verbosity=2)
