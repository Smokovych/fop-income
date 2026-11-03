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
    "TAX_API": f"http://127.0.0.1:{MOCK_PORT}/tax",
    "CMP_TEST_URL": f"http://127.0.0.1:{MOCK_PORT}/cmp",
    "FISCAL_API": f"http://127.0.0.1:{MOCK_PORT}/fs",
    "SECRET_KEY": "test-secret-key-0123456789",
    "KEP_TEST_SKIP_EXPIRY": "1",
    "MONO_MIN_INTERVAL_SEC": "0",
    "REGISTER_PER_HOUR": "1000",
    "PUBLIC_URL": "https://fop.example.com",
})

from app import db, tax, sync, server, accounts, store, bg  # noqa: E402

mock_banks.serve(MOCK_PORT)
db.init()


def _legacy_seed():
    """Дані однокористувацької версії (до облікових записів) — мають перейти в профіль ФОП 3333333333."""
    conn = db.connect()
    conn.executescript("""CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
        data TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);
        CREATE TABLE IF NOT EXISTS app_state_backup (version INTEGER PRIMARY KEY, data TEXT NOT NULL, saved_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS kep_store (id INTEGER PRIMARY KEY CHECK (id = 1), blob TEXT NOT NULL, info TEXT, created_at INTEGER NOT NULL);""")
    st = {"settings": {"owner_name": "ПЕТРЕНКО ОЛЕНА ІВАНІВНА", "owner_tax_id": "3333333333"}, "accounts": {"x:1": {"id": "x:1"}},
          "tx": {"x:1": {"id": "x:1", "amount": 500}}, "connections": [], "log": []}
    conn.execute("INSERT INTO app_state VALUES (1, 7, ?, 1, 'old')", (json.dumps(st),))
    conn.execute("INSERT INTO app_state_backup VALUES (6, ?, 1)", (json.dumps(st),))
    conn.execute("INSERT INTO kep_store VALUES (1, 'old-blob', ?, 1)", (json.dumps({"tin": "3333333333", "name": "Петренко О. І."}),))
    conn.commit()


_legacy_seed()
server.init()


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


class _Http(unittest.TestCase):
    PORT = APP_PORT

    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer
        cls.srv = ThreadingHTTPServer(("127.0.0.1", cls.PORT), server.Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.PORT}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def req(self, method, path, body=None, cookie=None, profile=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method)
        if data:
            r.add_header("Content-Type", "application/json")
        if cookie:
            r.add_header("Cookie", cookie)
        if profile:
            r.add_header("X-Profile", str(profile))
        for k, v in (headers or {}).items():
            r.add_header(k, v)
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, resp.read(), resp.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def j(self, *a, **kw):
        st, body, _ = self.req(*a, **kw)
        return st, (json.loads(body) if body else None)

    _n = 0

    def user(self, name="Тест", email=None):
        """Реєструє нового користувача; повертає (cookie, me)."""
        _Http._n += 1
        email = email or f"user{_Http._n}-{self.PORT}@example.com"
        st, body, h = self.req("POST", "/api/register", {"email": email, "name": name, "password": "password-123"})
        self.assertEqual(st, 200, body)
        return h["Set-Cookie"].split(";")[0], json.loads(body)

    def login(self):
        """Користувач із власним ФОП: (cookie, id профілю)."""
        c, me = self.user()
        tin = str(4000000000 + _Http._n)
        pid = accounts.create_profile(tin, "ФОП ТЕСТ", me["user"]["id"])
        return c, pid



class T5_Http(_Http):
    """Облікові записи, профілі ФОП і доступ бухгалтера."""

    def test_a_register_login_logout(self):
        c, me = self.user("Олена", email="Olena@Example.com")
        self.assertEqual((me["user"]["email"], me["profiles"]), ("olena@example.com", []))
        self.assertEqual(self.j("POST", "/api/register", {"email": "olena@example.com", "name": "x", "password": "password-123"})[0], 409)
        self.assertEqual(self.j("POST", "/api/register", {"email": "bad", "name": "x", "password": "password-123"})[0], 400)
        self.assertEqual(self.j("POST", "/api/register", {"email": "a@b.cc", "name": "x", "password": "short"})[0], 400)
        self.assertEqual(self.j("POST", "/api/login", {"email": "olena@example.com", "password": "wrong-pass"})[0], 401)
        st, body, h = self.req("POST", "/api/login", {"email": "OLENA@example.com", "password": "password-123"})
        self.assertEqual(st, 200)
        c2 = h["Set-Cookie"].split(";")[0]
        self.assertTrue(self.j("GET", "/api/me", cookie=c2)[1]["authenticated"])
        self.assertFalse(self.j("GET", "/api/me")[1]["authenticated"])
        self.assertFalse(self.j("GET", "/api/me", cookie="session=1.0.9999999999.bad")[1]["authenticated"])
        # після зміни пароля старі сесії недійсні
        self.assertEqual(self.j("POST", "/api/password", {"old": "password-123", "new": "password-456"}, cookie=c)[0], 200)
        self.assertEqual(self.j("GET", "/api/state/meta", cookie=c2, profile=1)[0], 401)

    def test_b_auth_required(self):
        self.assertEqual(self.req("GET", "/api/state")[0], 401)
        self.assertEqual(self.req("GET", "/proxy/nbu?valcode=USD&date=20260105")[0], 401)

    def test_c_profile_isolation_and_sharing(self):
        owner, pid = self.login()
        st = {"settings": {"owner_name": "ІВАНЕНКО ПЕТРО", "owner_tax_id": "4000000099", "fop_group": "3"},
              "accounts": {"a": {"id": "a"}}, "tx": {"t": {"id": "t", "amount": 1}}}
        self.assertEqual(self.j("PUT", "/api/state", {"state": st, "base_version": 0}, cookie=owner, profile=pid)[0], 200)
        # назва і група ФОП у списку профілів — з даних програми
        p = self.j("GET", "/api/me", cookie=owner)[1]["profiles"][0]
        self.assertEqual((p["name"], p["fop_group"], p["role"]), ("ІВАНЕНКО ПЕТРО", "3", "owner"))
        # чужий користувач не бачить даних
        acc, acc_me = self.user("Бухгалтер")
        self.assertEqual(self.j("GET", "/api/state", cookie=acc, profile=pid)[0], 403)
        self.assertEqual(self.j("GET", "/api/state", cookie=acc)[0], 400)   # ФОП не вибрано
        self.assertEqual(self.j("GET", f"/api/profiles/{pid}/access", cookie=acc)[0], 403)
        # власник надає доступ бухгалтеру
        st_, r = self.j("POST", f"/api/profiles/{pid}/access", {"email": acc_me["user"]["email"], "role": "accountant"}, cookie=owner)
        self.assertEqual((st_, r["invited"]), (200, False))
        me = self.j("GET", "/api/me", cookie=acc)[1]
        self.assertEqual([(x["id"], x["role"]) for x in me["profiles"]], [(pid, "accountant")])
        self.assertEqual(self.j("GET", "/api/state", cookie=acc, profile=pid)[1]["state"]["tx"]["t"]["amount"], 1)
        # бухгалтер працює з даними, але не роздає доступ і не видаляє ключ
        self.assertEqual(self.j("POST", f"/api/profiles/{pid}/access", {"email": "x@y.zz"}, cookie=acc)[0], 403)
        self.assertEqual(self.j("DELETE", "/api/kep", {}, cookie=acc, profile=pid)[0], 403)
        self.assertEqual(self.j("GET", "/api/server-status", cookie=acc, profile=pid)[1]["role"], "accountant")
        # запрошення для ще не зареєстрованого — доступ з'являється після реєстрації
        email = f"later-{self.PORT}@example.com"
        st_, r = self.j("POST", f"/api/profiles/{pid}/access", {"email": email, "role": "accountant"}, cookie=owner)
        self.assertTrue(r["invited"])
        self.assertEqual(self.j("GET", f"/api/profiles/{pid}/access", cookie=owner)[1]["invites"][0]["email"], email)
        self.assertEqual(self.j("GET", f"/api/profiles/{pid}/access", cookie=acc)[1]["invites"], [])
        c3, me3 = self.user("Пізніший", email=email.upper())
        self.assertEqual([x["id"] for x in me3["profiles"]], [pid])
        self.assertEqual(self.j("GET", f"/api/profiles/{pid}/access", cookie=owner)[1]["invites"], [])
        # бухгалтер може відмовитися сам; власник забирає доступ
        self.assertEqual(self.j("DELETE", f"/api/profiles/{pid}/access/{me3['user']['id']}", {}, cookie=c3)[0], 200)
        self.assertEqual(self.j("DELETE", f"/api/profiles/{pid}/access/{acc_me['user']['id']}", {}, cookie=owner)[0], 200)
        self.assertEqual(self.j("GET", "/api/state", cookie=acc, profile=pid)[0], 403)
        # останній власник не може піти
        owner_id = self.j("GET", "/api/me", cookie=owner)[1]["user"]["id"]
        self.assertEqual(self.j("DELETE", f"/api/profiles/{pid}/access/{owner_id}", {}, cookie=owner)[0], 409)

    def test_d_add_profile_by_key(self):
        """Додавання ФОП ключем: РНОКПП і ПІБ із сертифіката, ключ на сервері, облікові дані з Кабінету."""
        calls = []
        orig = bg.kep_open, bg.tax_refresh

        def fake_open(files, password):
            if password != "key-pass":
                raise bg.WorkerError("Не вдалося відкрити ключ. Перевірте пароль.")
            tin = {"KEYA": "2222222222", "KEYB": "", "KEYL": "3333333333"}[files[0]]
            return {"blob": "enc-" + files[0], "info": {"tin": tin, "name": "КОВАЛЬ ІРИНА ПЕТРІВНА", "issuer": "КНЕДП monobank"}}

        def fake_refresh(pid):
            calls.append(pid)
            cur = store.get(pid)
            stt = cur["state"] or {"settings": {}, "accounts": {}, "tx": {}}
            stt["settings"]["fop_group"] = "3"
            stt["tax"] = {"card": [{"idGroup": 1}], "fetched_at": 1}
            bg.apply_result(pid, cur["state"], stt)
            return stt["tax"]
        bg.kep_open, bg.tax_refresh = fake_open, fake_refresh
        try:
            c, me = self.user("Ірина")
            self.assertEqual(self.j("POST", "/api/profiles", {"files": ["KEYA"], "password": "key-pass"}, cookie=c)[0], 400)  # без згоди
            self.assertEqual(self.j("POST", "/api/profiles", {"files": ["KEYA"], "password": "bad", "consent": True}, cookie=c)[0], 409)
            st_, r = self.j("POST", "/api/profiles", {"files": ["KEYA"], "password": "key-pass", "consent": True}, cookie=c)
            self.assertEqual(st_, 200, r)
            pid = r["profile"]["id"]
            self.assertEqual((r["profile"]["tin"], r["profile"]["role"], r["profile"]["fop_group"], r["joined"]), ("2222222222", "owner", "3", False))
            self.assertEqual(calls, [pid])
            data = self.j("GET", "/api/state", cookie=c, profile=pid)[1]["state"]
            self.assertEqual((data["settings"]["owner_tax_id"], data["settings"]["owner_name"]), ("2222222222", "КОВАЛЬ ІРИНА ПЕТРІВНА"))
            self.assertTrue(self.j("GET", "/api/server-status", cookie=c, profile=pid)[1]["kep"]["stored"])
            # ключ іншого платника не можна зберегти для цього ФОП
            self.assertEqual(self.j("POST", "/api/kep", {"files": ["KEYL"], "password": "key-pass"}, cookie=c, profile=pid)[0], 409)
            # інший користувач з ключем цього ж ФОП стає співвласником (ключ підтверджує право)
            c2, _ = self.user("Ще хтось")
            r2 = self.j("POST", "/api/profiles", {"files": ["KEYA"], "password": "key-pass", "consent": True}, cookie=c2)[1]
            self.assertEqual((r2["profile"]["id"], r2["joined"], r2["profile"]["role"]), (pid, True, "owner"))
            # у сертифікаті немає РНОКПП → просимо ввести; чужий наявний РНОКПП так не отримати
            r3 = self.j("POST", "/api/profiles", {"files": ["KEYB"], "password": "key-pass", "consent": True}, cookie=c)[1]
            self.assertTrue(r3["need_tin"])
            self.assertEqual(self.j("POST", "/api/profiles", {"files": ["KEYB"], "password": "key-pass", "consent": True, "tin": "2222222222"}, cookie=c)[0], 409)
            r4 = self.j("POST", "/api/profiles", {"files": ["KEYB"], "password": "key-pass", "consent": True, "tin": "5555555555"}, cookie=c)[1]
            self.assertEqual(r4["profile"]["tin"], "5555555555")
            self.assertEqual(len(self.j("GET", "/api/me", cookie=c)[1]["profiles"]), 2)
            # дані однокористувацької версії переходять до того, хто додасть ключ з тим самим РНОКПП
            legacy = accounts.profile_by_tin("3333333333")
            self.assertEqual(store.get(legacy["id"])["version"], 7)
            self.assertEqual(bg.kep_get(legacy["id"])["info"]["tin"], "3333333333")
            self.assertEqual(store.backups(legacy["id"])[0]["version"], 6)
            self.assertIsNone(store.migrate_legacy())   # повторно не переносить
            c5, _ = self.user("Олена Петренко")
            r5 = self.j("POST", "/api/profiles", {"files": ["KEYL"], "password": "key-pass", "consent": True}, cookie=c5)[1]
            self.assertEqual((r5["profile"]["id"], r5["joined"]), (legacy["id"], True))
            self.assertEqual(self.j("GET", "/api/state", cookie=c5, profile=legacy["id"])[1]["state"]["tx"]["x:1"]["amount"], 500)
        finally:
            bg.kep_open, bg.tax_refresh = orig

    def test_e_csrf_form_post_rejected(self):
        c, pid = self.login()
        r = urllib.request.Request(self.base + "/api/tax/refresh", data=b"a=1", method="POST",
                                   headers={"Cookie": c, "X-Profile": str(pid), "Content-Type": "application/x-www-form-urlencoded"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(r)
        self.assertEqual(e.exception.code, 415)

    def test_f_static_traversal(self):
        st, body, _ = self.req("GET", "/../app/config.py")
        self.assertNotIn(b"os.environ.get", body)  # віддається лише сторінка програми, не файли сервера
        self.assertIn(b"fop-mode", body)


class T6_SharedState(_Http):
    """Спільне сховище для браузерної програми, замок синхронізації, запити до банків через сервер."""
    PORT = APP_PORT + 1

    def state(self, n_tx=1):
        return {"settings": {}, "connections": [], "rules": [], "rates": {}, "log": [], "nextId": 1,
                "accounts": {"mono:a": {"id": "mono:a"}},
                "tx": {f"mono:{i}": {"id": f"mono:{i}", "amount": 100 * i} for i in range(n_tx)}}

    def test_a_state_roundtrip_and_conflict(self):
        c, p = self.login()
        st, body, _ = self.req("GET", "/api/state", cookie=c, profile=p)
        self.assertEqual(st, 200)
        v0 = json.loads(body)["version"]
        st, body, _ = self.req("PUT", "/api/state", {"state": self.state(3), "base_version": v0, "device": "A"}, cookie=c, profile=p)
        self.assertEqual(st, 200)
        v1 = json.loads(body)["version"]
        self.assertEqual(v1, v0 + 1)
        # другий пристрій зі старою версією отримує конфлікт і актуальні дані
        st, body, _ = self.req("PUT", "/api/state", {"state": self.state(1), "base_version": v0, "device": "B"}, cookie=c, profile=p)
        self.assertEqual(st, 409)
        d = json.loads(body)
        self.assertEqual(d["error"], "conflict")
        self.assertEqual(d["version"], v1)
        self.assertEqual(len(d["state"]["tx"]), 3)
        st, body, _ = self.req("GET", "/api/state/meta", cookie=c, profile=p)
        self.assertEqual(json.loads(body)["version"], v1)
        # інший ФОП того ж користувача — окремі дані
        p2 = accounts.create_profile("4999999999", "Другий", self.j("GET", "/api/me", cookie=c)[1]["user"]["id"])
        self.assertIsNone(self.j("GET", "/api/state", cookie=c, profile=p2)[1]["state"])

    def test_b_empty_state_does_not_wipe(self):
        c, p = self.login()
        v = json.loads(self.req("PUT", "/api/state", {"state": self.state(2), "base_version": 0}, cookie=c, profile=p)[1])["version"]
        empty = {**self.state(0), "accounts": {}}
        st, _, _ = self.req("PUT", "/api/state", {"state": empty, "base_version": v}, cookie=c, profile=p)
        self.assertEqual(st, 409)
        st, body, _ = self.req("PUT", "/api/state", {"state": empty, "base_version": v, "wipe": True}, cookie=c, profile=p)
        self.assertEqual(st, 200)
        # копія перед очищенням збереглася
        st, body, _ = self.req("GET", "/api/backups", cookie=c, profile=p)
        self.assertTrue(any(b["version"] == v for b in json.loads(body)))
        restored = json.loads(self.req("GET", f"/api/backups/{v}", cookie=c, profile=p)[1])
        self.assertTrue(restored["tx"])

    def test_c_gzip_upload(self):
        import gzip
        c, p = self.login()
        raw = json.dumps({"state": self.state(2000), "base_version": 0}).encode()
        r = urllib.request.Request(self.base + "/api/state", data=gzip.compress(raw), method="PUT", headers={
            "Cookie": c, "X-Profile": str(p), "Content-Type": "application/json", "Content-Encoding": "gzip"})
        with urllib.request.urlopen(r) as resp:
            self.assertEqual(resp.status, 200)
        r = urllib.request.Request(self.base + "/api/state", headers={"Cookie": c, "X-Profile": str(p), "Accept-Encoding": "gzip"})
        with urllib.request.urlopen(r) as resp:
            self.assertEqual(resp.headers["Content-Encoding"], "gzip")
            self.assertEqual(len(json.loads(gzip.decompress(resp.read()))["state"]["tx"]), 2000)

    def test_e_sync_lock(self):
        c, p = self.login()
        c2, p2 = self.login()
        g = lambda d, cc=c, pp=p, **kw: json.loads(self.req("POST", "/api/sync-lock", {"device": d, **kw}, cookie=cc, profile=pp)[1])
        self.assertTrue(g("phone")["granted"])
        self.assertTrue(g("phone")["granted"])           # продовження власного замка
        self.assertFalse(g("laptop")["granted"])         # інший пристрій чекає
        self.assertTrue(g("laptop", c2, p2)["granted"])  # інший ФОП — свій замок
        g("phone", release=True)
        self.assertTrue(g("laptop")["granted"])
        g("laptop", release=True)

    def test_f_proxy(self):
        c, _ = self.login()
        r = urllib.request.Request(self.base + "/proxy/mono/personal/client-info", headers={"Cookie": c, "X-Token": "t"})
        with urllib.request.urlopen(r) as resp:
            self.assertEqual(len(json.loads(resp.read())["accounts"]), 3)
        # без токена сервер не звертається до банку
        st, body, _ = self.req("GET", "/proxy/mono/personal/client-info", cookie=c)
        self.assertEqual(st, 400)
        # помилка банку передається як є (статус і тіло)
        r = urllib.request.Request(self.base + "/proxy/mono/personal/statement/acc-fop-uah/0/99999999", headers={"Cookie": c, "X-Token": "t"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(r)
        self.assertEqual(e.exception.code, 400)
        self.assertIn("31 days", json.loads(e.exception.read())["errorDescription"])
        # лише дозволені шляхи
        self.assertEqual(self.req("GET", "/proxy/mono/personal/webhook", cookie=c)[0], 403)
        self.assertEqual(self.req("GET", "/proxy/privat/statements/../../admin", cookie=c)[0], 403)
        r = urllib.request.Request(self.base + "/proxy/privat/statements/balance?startDate=01-10-2026&endDate=01-10-2026",
                                   headers={"Cookie": c, "X-Privat-Token": "pt"})
        with urllib.request.urlopen(r) as resp:
            self.assertEqual(json.loads(resp.read())["status"], "SUCCESS")
        st, body, _ = self.req("GET", "/proxy/nbu?valcode=USD&date=20260105&json", cookie=c)
        self.assertEqual(json.loads(body)[0]["rate"], mock_banks.NBU_USD)
        self.assertEqual(self.req("GET", "/proxy/nbu?valcode=usd;x&date=20260105", cookie=c)[0], 400)

    def test_h_tax_bridge(self):
        import base64
        c, _ = self.login()
        tb = lambda b: self.req("POST", "/proxy/tax-bridge", b, cookie=c)
        self.assertEqual(self.req("POST", "/proxy/tax-bridge", {"path": "payer_card", "auth": "A" * 200})[0], 401)
        st, body, _ = tb({"path": "payer_card", "auth": "A" * 200})
        d = json.loads(body)
        self.assertEqual((st, d["status"], d["http"]), (200, "SUCCESS", 200))
        self.assertEqual(json.loads(d["body"])[0]["values"]["TIN"], "1234567890")
        d = json.loads(tb({"path": "payer_card/14", "params": {"page": 0, "size": 100, "evil": "x"}, "auth": "A" * 200})[1])
        self.assertEqual(json.loads(d["body"])["idGroup"], 14)
        d = json.loads(tb({"path": "payer_card", "auth": "A" * 100 + "=="})[1])  # підпис замалий для «Кабінету»
        self.assertEqual(d["http"], 401)
        # стан розрахунків з бюджетом — дозволено; інші розділи Кабінету — ні
        d = json.loads(tb({"path": "ta/splatp", "params": {"year": 2026}, "auth": "A" * 200})[1])
        self.assertEqual(json.loads(d["body"])[2]["plat1"], "30 18050400 00")
        d = json.loads(tb({"path": "ta/splatp/2026/2659/SINGLE01/pa", "params": {"page": 0}, "auth": "A" * 200})[1])
        self.assertEqual(d["status"], "SUCCESS")
        self.assertEqual(tb({"path": "ta/splatp/2026/2659/E2F2B841AF30059EE0430A2142061006/pa", "auth": "A" * 200})[0], 200)
        self.assertEqual(tb({"path": "ta/debt", "auth": "A" * 200})[0], 403)
        self.assertEqual(tb({"path": "ta/splatp/../../post/sent", "auth": "A" * 200})[0], 403)
        self.assertEqual(tb({"path": "payer_card", "auth": "bad auth!"})[0], 400)
        # CMP: лише адреси надавачів зі списку; відповідь — base64
        mock_banks.CMP_RESPONSE = b"\x30\x03\x02\x01\x01"
        d = json.loads(tb({"path": "cmp", "url": "http://ca.monobank.ua/services/cmp/", "body": base64.b64encode(b"q").decode()})[1])
        self.assertEqual((d["http"], base64.b64decode(d["body64"])), (200, mock_banks.CMP_RESPONSE))
        self.assertEqual(tb({"path": "cmp", "url": "http://evil.example/", "body": ""})[0], 403)

    def test_g_ui_served_in_server_mode(self):
        st, body, h = self.req("GET", "/")
        self.assertEqual(st, 200)
        self.assertIn(b'<meta name="fop-mode" content="server">', body)
        self.assertIn("frame-ancestors 'none'", h["Content-Security-Policy"])
        st, body, _ = self.req("GET", "/some/page")
        self.assertIn(b"fop-mode", body)



@unittest.skipUnless(__import__("shutil").which("node"), "потрібен Node.js")
class T7_Background(unittest.TestCase):
    """Фоновий воркер (Node): оновлення виписок, зберігання ключа КЕП, облікові дані з Кабінету."""

    @classmethod
    def setUpClass(cls):
        cls.pid = accounts.create_profile("1234567890", "Тест")
        cls.store, cls.bg = _ProfileStore(cls.pid), _ProfileBg(cls.pid)
        cur = cls.store.get()
        state = {"settings": {"owner_name": "", "owner_tax_id": "1234567890", "sync_start": "2026-01-01", "esv_enabled": True},
                 "taxParams": {}, "rules": [], "rates": {}, "log": [], "nextId": 100, "tax": {}, "rulesVersion": 2,
                 "connections": [{"id": 1, "bank": "mono", "name": "Monobank", "token": "t", "last_sync_at": None, "last_error": None},
                                 {"id": 2, "bank": "privat", "name": "ПриватБанк", "bridge_url": None, "token": "pt",
                                  "last_sync_at": None, "last_error": None}],
                 "accounts": {"keep:me": {"id": "keep:me", "bank": "file", "name": "x"}}, "tx": {}}
        cls.store.put(state, cur["version"], device="test", wipe=True)

    def test_a_sync_banks_merges_with_concurrent_edit(self):
        before = self.store.get()
        self.assertTrue(self.bg.sync_banks())
        after = self.store.get()["state"]
        self.assertGreater(len(after["tx"]), 800)
        self.assertTrue(all(c["last_sync_at"] for c in after["connections"]))
        self.assertTrue(any(k.startswith("privat:") for k in after["tx"]))
        # правка користувача між читанням і записом воркера не губиться
        tx_id = next(k for k in after["tx"] if k.startswith("mono:"))
        user = json_copy(after)
        user["tx"][tx_id]["manual_category"] = "loan"
        user["settings"]["owner_name"] = "Користувач"
        v = self.store.put(user, self.store.get()["version"], device="phone")
        base = self.store.get()["state"]
        worker_result = json_copy(base)
        worker_result["tx"][tx_id]["auto_reason"] = "оновлено воркером"
        worker_result["tx"]["mono:new-1"] = {"id": "mono:new-1", "amount": 1}
        base_old = json_copy(base); base_old["settings"]["owner_name"] = ""; base_old["tx"][tx_id]["manual_category"] = None
        worker_from_old = json_copy(base_old); worker_from_old["tx"][tx_id]["auto_reason"] = "оновлено воркером"
        worker_from_old["tx"]["mono:new-1"] = {"id": "mono:new-1", "amount": 1}
        self.bg.apply_result(base_old, worker_from_old)
        st = self.store.get()["state"]
        self.assertEqual(st["tx"][tx_id]["manual_category"], "loan")
        self.assertEqual(st["tx"][tx_id]["auto_reason"], "оновлено воркером")
        self.assertEqual(st["settings"]["owner_name"], "Користувач")
        self.assertIn("mono:new-1", st["tx"])
        self.assertIn("keep:me", st["accounts"])
        self.assertGreater(self.store.get()["version"], v)

    def test_b_server_lock_blocks_browser(self):
        self.assertTrue(self.store.acquire_sync("server", ttl=60)["granted"])
        self.assertFalse(self.store.acquire_sync("phone")["granted"])
        self.store.release_sync("server")
        self.assertTrue(self.store.acquire_sync("phone")["granted"])
        self.store.release_sync("phone")

    def test_c_kep_store_and_tax_refresh(self):
        import base64
        fx = os.environ.get("KEP_FIXTURES") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "kep")
        if not os.path.exists(os.path.join(fx, "key.pfx")):
            self.skipTest("немає тестових ключів (KEP_FIXTURES)")
        mock_banks.CMP_RESPONSE = base64.b64decode(open(os.path.join(fx, "cmp_resp.b64")).read())
        files = [base64.b64encode(open(os.path.join(fx, "key.pfx"), "rb").read()).decode()]
        with self.assertRaises(self.bg.WorkerError):
            self.bg.kep_save(files, "wrong")
        info = self.bg.kep_save(files, "test-pass")
        self.assertEqual(info["issuer"], "Very Much CA")
        row = db.q1("SELECT blob FROM kep_keys WHERE profile_id=?", (self.pid,))
        self.assertNotIn("test-pass", base64.b64decode(row["blob"]).decode())
        self.assertNotIn("kep", json.dumps(self.store.get()["state"]).lower().replace("kepkey", ""))  # ключа немає в даних програми
        tax = self.bg.tax_refresh()
        self.assertIsNone(tax.get("last_error"))
        st = self.store.get()["state"]
        self.assertEqual(st["tax"]["card"][0]["values"]["TIN"], "1234567890")
        self.assertTrue(st["tax"]["cert_b64"])
        self.assertTrue(self.bg.kep_get()["stored"])
        # фіскальні чеки ПРРО: каси → зміни → документи → чеки (ключ підписує лише команди перегляду)
        st = self.store.get()["state"]
        st["settings"]["sync_start"] = f"{mock_banks.YEAR}-09-01"
        self.store.put(st, self.store.get()["version"], device="test")
        mock_banks.FS_LOG.clear()
        res = self.bg.fiscal_sync()
        self.assertIsNone(res["error"])
        f = self.store.get()["state"]["fiscal"]
        self.assertEqual(list(f["registrars"]), ["4000123456"])
        self.assertEqual(sorted(f["checks"]), ["1001", "1002", "1003", "2001"])
        c = f["checks"]["1001"]
        self.assertEqual((c["sum"], c["date"], c["time"], c["pays"][0]["form"]), (185.5, f"0510{mock_banks.YEAR}", "093000", "Готівка"))
        self.assertEqual([i["name"] for i in c["items"]], ["Кава лате", "Круасан"])
        self.assertEqual(f["checks"]["1003"]["subtype"], 1)
        self.assertTrue(c["url"].startswith("https://cabinet.tax.gov.ua/"))
        self.assertEqual(set(mock_banks.FS_LOG), {"Objects", "Shifts", "Documents", "CheckExt"})
        # повторно — закриті зміни не перечитуються, чеки не дублюються
        mock_banks.FS_LOG.clear()
        loaded_to = self.store.get()["state"]["fiscal"]["registrars"]["4000123456"]["loaded_to"]
        st = self.store.get()["state"]   # свіже оновлення через межу місяця (сервер приймає лише один місяць)
        st["fiscal"]["registrars"]["4000123456"]["loaded_to"] = loaded_to[:8] + "01"
        self.store.put(st, self.store.get()["version"], device="test")
        self.assertIsNone(self.bg.fiscal_sync()["error"])
        self.assertNotIn("CheckExt", mock_banks.FS_LOG)
        self.assertEqual(len(self.store.get()["state"]["fiscal"]["checks"]), 4)
        self.bg.kep_delete()
        self.assertFalse(self.bg.kep_get()["stored"])


class _ProfileStore:
    """store/bg з фіксованим профілем — щоб тести фонового воркера читалися як раніше."""
    def __init__(self, pid):
        self.pid = pid

    def get(self):
        return store.get(self.pid)

    def put(self, state, base, **kw):
        return store.put(self.pid, state, base, **kw)

    def acquire_sync(self, device, **kw):
        return store.acquire_sync(self.pid, device, **kw)

    def release_sync(self, device):
        return store.release_sync(self.pid, device)


class _ProfileBg:
    WorkerError = bg.WorkerError

    def __init__(self, pid):
        self.pid = pid

    def __getattr__(self, name):
        fn = getattr(bg, name)
        return lambda *a, **kw: fn(self.pid, *a, **kw)


def json_copy(x):
    return json.loads(json.dumps(x))


import urllib.error  # noqa: E402
import urllib.parse  # noqa: E402

if __name__ == "__main__":
    unittest.main(verbosity=2)
