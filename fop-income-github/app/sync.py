"""Синхронізація виписок: фоновий потік + планувальник."""
import json
import queue
import secrets
import threading
import time
import traceback
from datetime import datetime, timedelta

from . import config, db, nbu
from .banks import monobank, privatbank
from .classify import Classifier

_throttles = {}
_throttle_lock = threading.Lock()


def mono_throttle(token):
    with _throttle_lock:
        if token not in _throttles:
            _throttles[token] = monobank.Throttle()
        return _throttles[token]


def mono_client(conn):
    return monobank.MonoClient(conn["token"], throttle=mono_throttle(conn["token"]))


def privat_client(conn):
    return privatbank.PrivatClient(conn["token"], conn.get("client_id"))


def _now():
    return int(time.time())


def default_start_ts():
    s = db.get_setting("sync_start")
    if not s:
        s = f"{datetime.now(config.KYIV).year}-01-01"
    d = datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=config.KYIV)
    return int(d.timestamp())


# ---------------------------------------------------------------- підключення

def add_connection(bank, token, client_id=None, name=None):
    token = (token or "").strip()
    if not token:
        raise ValueError("Вкажіть токен")
    if bank == "mono":
        info = monobank.MonoClient(token, throttle=mono_throttle(token)).client_info()
        owner, accounts = info["name"], info["accounts"]
        name = name or f"Monobank — {owner}"
    elif bank == "privat":
        accounts = privatbank.PrivatClient(token, client_id).accounts()
        owner = None
        name = name or "ПриватБанк (Автоклієнт)"
    else:
        raise ValueError("Невідомий банк")
    cur = db.ex("INSERT INTO connections(bank, name, token, client_id, owner_name, webhook_secret, created_at)"
                " VALUES (?,?,?,?,?,?,?)",
                (bank, name, token, client_id or None, owner, secrets.token_urlsafe(16), _now()))
    conn_id = cur.lastrowid
    _upsert_accounts(conn_id, bank, accounts, first=True)
    if owner and not db.get_setting("owner_name"):
        db.set_setting("owner_name", owner)
    db.log("info", f"Додано підключення «{name}», рахунків: {len(accounts)}")
    return conn_id


def refresh_accounts(conn_id):
    conn = db.q1("SELECT * FROM connections WHERE id=?", (conn_id,))
    if conn["bank"] == "mono":
        info = mono_client(conn).client_info()
        accounts = info["accounts"]
        db.ex("UPDATE connections SET owner_name=? WHERE id=?", (info["name"], conn_id))
    else:
        accounts = privat_client(conn).accounts()
    _upsert_accounts(conn_id, conn["bank"], accounts)
    return accounts


def _upsert_accounts(conn_id, bank, accounts, first=False):
    for a in accounts:
        acc_id = f"{bank}:{a['ext_id']}"
        exists = db.q1("SELECT id FROM accounts WHERE id=?", (acc_id,))
        if exists:
            db.ex("UPDATE accounts SET iban=?, currency=?, type=?, name=?, balance=? WHERE id=?",
                  (a["iban"], a["currency"], a["type"], a["name"], a["balance"], acc_id))
        else:
            # за замовчуванням тягнемо лише рахунки ФОП
            db.ex("INSERT INTO accounts(id, connection_id, bank, ext_id, iban, currency, type, name, balance, is_fop, enabled)"
                  " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                  (acc_id, conn_id, bank, a["ext_id"], a["iban"], a["currency"], a["type"], a["name"],
                   a["balance"], 1 if a["is_fop"] else 0, 1 if a["is_fop"] else 0))


# ---------------------------------------------------------------- збереження операцій

def store_transactions(account, items, classifier=None):
    """Зберігає нормалізовані операції. Повертає кількість нових."""
    classifier = classifier or Classifier()
    conn = db.connect()
    new = 0
    for tx in items:
        tx_id = f"{account['bank']}:{tx['ext_id']}"
        dt = datetime.fromtimestamp(tx["ts"], config.KYIV)
        tx["date"] = dt.strftime("%Y-%m-%d")
        cat, reason = classifier.classify(tx, account)
        old = conn.execute("SELECT id FROM transactions WHERE id=?", (tx_id,)).fetchone()
        rate, uah = _uah(tx)
        values = (tx["ts"], tx["date"], tx["amount"], tx["currency"], tx["description"], tx["comment"],
                  tx["counter_name"], tx["counter_edrpou"], tx["counter_iban"], tx["hold"], cat, reason,
                  rate, uah, json.dumps(tx["raw"], ensure_ascii=False), _now())
        if old:
            conn.execute("""UPDATE transactions SET ts=?, date=?, amount=?, currency=?, description=?, comment=?,
                            counter_name=?, counter_edrpou=?, counter_iban=?, hold=?, auto_category=?, auto_reason=?,
                            nbu_rate=COALESCE(?, nbu_rate), uah_amount=COALESCE(?, uah_amount), raw=?, updated_at=?
                            WHERE id=?""", values + (tx_id,))
        else:
            conn.execute("""INSERT INTO transactions(ts, date, amount, currency, description, comment, counter_name,
                            counter_edrpou, counter_iban, hold, auto_category, auto_reason, nbu_rate, uah_amount,
                            raw, updated_at, id, account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                         values + (tx_id, account["id"]))
            new += 1
    conn.commit()
    return new


def _uah(tx):
    if tx["currency"] == "UAH":
        return 1.0, tx["amount"]
    try:
        rate = nbu.get_rate(tx["currency"], tx["date"])
        return rate, int(round(tx["amount"] * rate))
    except Exception as e:  # курс доберемо пізніше
        db.log("warn", f"Немає курсу НБУ {tx['currency']} на {tx['date']}: {e}")
        return None, None


def fill_missing_rates():
    rows = db.q("SELECT id, amount, currency, date FROM transactions WHERE uah_amount IS NULL")
    for r in rows:
        rate, uah = _uah(r)
        if uah is not None:
            db.ex("UPDATE transactions SET nbu_rate=?, uah_amount=? WHERE id=?", (rate, uah, r["id"]))


# ---------------------------------------------------------------- синхронізація

def sync_account(account, conn, progress=None):
    start = default_start_ts()
    if account["synced_to"]:
        start = max(start, account["synced_to"] - config.RESYNC_OVERLAP_DAYS * 86400)
    end = _now()
    classifier = Classifier()
    if conn["bank"] == "mono":
        client = mono_client(conn)
        raw = client.statement(account["ext_id"], start, end)
        norm = (monobank.normalize(it, account) for it in raw)
    else:
        client = privat_client(conn)
        raw = client.transactions(account["ext_id"], start, end)
        norm = (privatbank.normalize(it, account) for it in raw if privatbank.is_real(it))

    batch, new = [], 0
    for tx in norm:
        batch.append(tx)
        if len(batch) >= 200:
            new += store_transactions(account, batch, classifier)
            batch = []
            if progress:
                progress(account, new)
    new += store_transactions(account, batch, classifier)
    db.ex("UPDATE accounts SET synced_to=? WHERE id=?", (end, account["id"]))
    return new


def sync_connection(conn_id, progress=None):
    conn = db.q1("SELECT * FROM connections WHERE id=?", (conn_id,))
    if not conn:
        return 0
    total = 0
    try:
        try:
            refresh_accounts(conn_id)  # оновити баланси / нові рахунки
        except Exception as e:
            db.log("warn", f"{conn['name']}: не вдалося оновити список рахунків: {e}")
        for acc in db.q("SELECT * FROM accounts WHERE connection_id=? AND enabled=1", (conn_id,)):
            if progress:
                progress(acc, 0)
            n = sync_account(acc, conn, progress)
            total += n
            db.log("info", f"{acc['name']}: нових операцій {n}")
        fill_missing_rates()
        db.ex("UPDATE connections SET last_sync_at=?, last_error=NULL WHERE id=?", (_now(), conn_id))
    except Exception as e:
        db.ex("UPDATE connections SET last_error=? WHERE id=?", (str(e)[:500], conn_id))
        db.log("error", f"{conn['name']}: {e}")
        traceback.print_exc()
    return total


# ---------------------------------------------------------------- вебхук Monobank

def handle_mono_webhook(secret, payload):
    conn = db.q1("SELECT * FROM connections WHERE bank='mono' AND webhook_secret=?", (secret,))
    if not conn or not isinstance(payload, dict) or payload.get("type") != "StatementItem":
        return False
    data = payload.get("data") or {}
    acc = db.q1("SELECT * FROM accounts WHERE id=?", (f"mono:{data.get('account')}",))
    if not acc or not acc["enabled"] or not data.get("statementItem"):
        return True
    store_transactions(acc, [monobank.normalize(data["statementItem"], acc)])
    db.log("info", f"{acc['name']}: операція з вебхука")
    return True


def set_mono_webhook(conn_id):
    conn = db.q1("SELECT * FROM connections WHERE id=? AND bank='mono'", (conn_id,))
    if not conn:
        raise ValueError("Підключення не знайдено")
    if not config.PUBLIC_URL:
        raise ValueError("Задайте PUBLIC_URL (публічна https-адреса застосунку), щоб увімкнути вебхук")
    url = f"{config.PUBLIC_URL}/webhook/mono/{conn['webhook_secret']}"
    mono_client(conn).set_webhook(url)
    db.log("info", f"Вебхук Monobank встановлено: {url}")
    return url


# ---------------------------------------------------------------- фоновий воркер

class SyncWorker:
    def __init__(self):
        self.q = queue.Queue()
        self.status = {"running": False, "current": None, "queued": 0, "last_run": None, "next_run": None}
        self._pending = set()
        self._lock = threading.Lock()

    def start(self):
        threading.Thread(target=self._worker, daemon=True, name="sync-worker").start()
        threading.Thread(target=self._scheduler, daemon=True, name="sync-scheduler").start()

    def enqueue(self, conn_id=None):
        ids = [conn_id] if conn_id else [c["id"] for c in db.q("SELECT id FROM connections")]
        with self._lock:
            for i in ids:
                if i not in self._pending:
                    self._pending.add(i)
                    self.q.put(i)
            self.status["queued"] = len(self._pending)
        return len(ids)

    def _progress(self, acc, n):
        self.status["current"] = {"account": acc["name"], "new": n}

    def _worker(self):
        while True:
            conn_id = self.q.get()
            self.status["running"] = True
            try:
                sync_connection(conn_id, self._progress)
            finally:
                with self._lock:
                    self._pending.discard(conn_id)
                    self.status["queued"] = len(self._pending)
                self.status["current"] = None
                self.status["running"] = bool(self._pending)
                self.status["last_run"] = _now()

    def _scheduler(self):
        time.sleep(5)
        while True:
            if config.SYNC_INTERVAL_MIN > 0:
                self.enqueue()
                nxt = _now() + config.SYNC_INTERVAL_MIN * 60
                self.status["next_run"] = nxt
                time.sleep(config.SYNC_INTERVAL_MIN * 60)
            else:
                time.sleep(3600)


worker = SyncWorker()
