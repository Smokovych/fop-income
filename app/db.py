"""SQLite-сховище. Одне з'єднання на потік, WAL-режим."""
import json
import os
import sqlite3
import threading

from . import config

_local = threading.local()
_init_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS tax_params (
    year INTEGER PRIMARY KEY,
    min_wage REAL NOT NULL,
    income_limit REAL NOT NULL,
    esv_month REAL NOT NULL,
    single_tax_rate REAL NOT NULL,
    mil_rate REAL NOT NULL
);

-- Підключення до банку (один токен = одне підключення)
CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank TEXT NOT NULL,              -- 'mono' | 'privat'
    name TEXT,
    token TEXT NOT NULL,
    client_id TEXT,                  -- для ПриватБанку (id з Автоклієнта), необов'язково
    owner_name TEXT,                 -- ім'я власника (з client-info), для пошуку власних переказів
    webhook_secret TEXT,
    last_sync_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,             -- '<bank>:<зовнішній id>'
    connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    bank TEXT NOT NULL,
    ext_id TEXT NOT NULL,            -- id рахунку в банку (для Привату — IBAN)
    iban TEXT,
    currency TEXT NOT NULL,          -- 'UAH', 'USD', ...
    type TEXT,                       -- для mono: fop/black/white...
    name TEXT,
    balance INTEGER,                 -- у мінімальних одиницях (копійки/центи)
    is_fop INTEGER NOT NULL DEFAULT 0, -- рахунок ФОП: надходження рахуються як дохід
    enabled INTEGER NOT NULL DEFAULT 0, -- чи тягнути виписку
    synced_to INTEGER                -- unix-час, до якого виписка вже завантажена
);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,             -- '<bank>:<зовнішній id>'
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,             -- unix-час операції
    date TEXT NOT NULL,              -- YYYY-MM-DD (Київ)
    amount INTEGER NOT NULL,         -- зі знаком, у мінімальних одиницях валюти рахунку
    currency TEXT NOT NULL,
    description TEXT,
    comment TEXT,
    counter_name TEXT,
    counter_edrpou TEXT,
    counter_iban TEXT,
    hold INTEGER NOT NULL DEFAULT 0, -- 1 = ще не проведена банком
    auto_category TEXT NOT NULL,
    auto_reason TEXT,
    manual_category TEXT,
    note TEXT,
    nbu_rate REAL,                   -- курс НБУ на дату надходження (для валюти)
    uah_amount INTEGER,              -- сума в копійках гривні
    raw TEXT,
    updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS ix_tx_account ON transactions(account_id);

-- Правила автоматичної класифікації (за ключовими словами)
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,           -- підрядок (без урахування регістру)
    field TEXT NOT NULL DEFAULT 'any', -- any | description | counter_name | counter_edrpou | comment
    direction TEXT NOT NULL DEFAULT 'in', -- in | out | any
    category TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS nbu_rates (
    cc TEXT NOT NULL,
    date TEXT NOT NULL,
    rate REAL NOT NULL,
    PRIMARY KEY (cc, date)
);

CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
);
"""

DEFAULT_RULES = [
    # (pattern, field, direction, category, priority)
    ("продаж валют", "any", "in", "currency_exchange", 10),
    ("продаж безготівкової", "any", "in", "currency_exchange", 10),
    ("купівля валют", "any", "any", "currency_exchange", 10),
    ("обмін валют", "any", "any", "currency_exchange", 10),
    ("конвертац", "any", "any", "currency_exchange", 10),
    ("повернення помилково", "any", "in", "refund_in", 20),
    ("помилково зарахован", "any", "in", "refund_in", 20),
    ("повернення коштів", "any", "in", "refund_in", 30),
    ("повернення податку", "any", "in", "tax_refund", 20),
    ("повернення надміру", "any", "in", "tax_refund", 20),
    ("поворотн", "any", "in", "loan", 20),
    ("позик", "any", "in", "loan", 30),
    ("кредит", "description", "in", "loan", 40),
    ("власних коштів", "any", "in", "own_transfer", 20),
    ("власні кошти", "any", "in", "own_transfer", 20),
    ("між власними", "any", "in", "own_transfer", 20),
    ("поповнення рахунку власн", "any", "in", "own_transfer", 20),
    ("з чорної картки", "description", "in", "own_transfer", 20),
    ("з білої картки", "description", "in", "own_transfer", 20),
    ("з картки монобанк", "description", "in", "own_transfer", 40),
    ("повернення передоплати", "any", "out", "refund_to_buyer", 20),
    ("повернення коштів покупц", "any", "out", "refund_to_buyer", 20),
]


def connect():
    conn = getattr(_local, "conn", None)
    if conn is None:
        os.makedirs(os.path.dirname(config.DB_PATH) or ".", exist_ok=True)
        conn = sqlite3.connect(config.DB_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


def init():
    with _init_lock:
        conn = connect()
        conn.executescript(SCHEMA)
        for year, p in config.DEFAULT_TAX_PARAMS.items():
            conn.execute(
                "INSERT OR IGNORE INTO tax_params(year, min_wage, income_limit, esv_month, single_tax_rate, mil_rate)"
                " VALUES (?,?,?,?,?,?)",
                (year, p["min_wage"], p["income_limit"], p["esv_month"], p["single_tax_rate"], p["mil_rate"]),
            )
        if not conn.execute("SELECT 1 FROM settings WHERE key='rules_seeded'").fetchone():
            conn.executemany(
                "INSERT INTO rules(pattern, field, direction, category, priority) VALUES (?,?,?,?,?)",
                DEFAULT_RULES,
            )
            conn.execute("INSERT INTO settings(key, value) VALUES ('rules_seeded', '1')")
        conn.commit()


def q(sql, params=()):
    return [dict(r) for r in connect().execute(sql, params).fetchall()]


def q1(sql, params=()):
    r = connect().execute(sql, params).fetchone()
    return dict(r) if r else None


def ex(sql, params=()):
    conn = connect()
    cur = conn.execute(sql, params)
    conn.commit()
    return cur


def get_setting(key, default=None):
    r = q1("SELECT value FROM settings WHERE key=?", (key,))
    if not r:
        return default
    try:
        return json.loads(r["value"])
    except (TypeError, ValueError):
        return r["value"]


def set_setting(key, value):
    ex("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
       (key, json.dumps(value, ensure_ascii=False)))


def log(level, message):
    ex("INSERT INTO sync_log(ts, level, message) VALUES (strftime('%s','now'), ?, ?)", (level, message))
    ex("DELETE FROM sync_log WHERE id < (SELECT MAX(id) - 500 FROM sync_log)")
