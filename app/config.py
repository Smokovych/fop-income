"""Налаштування застосунку та податкові параметри.

Усі параметри можна перевизначити через змінні середовища (див. .env.example).
Податкові параметри за роками також редагуються в інтерфейсі (вкладка «Налаштування»).
"""
import os
from datetime import timezone, timedelta

try:
    from zoneinfo import ZoneInfo
    KYIV = ZoneInfo("Europe/Kyiv")
except Exception:  # немає бази часових поясів (напр. мінімальний Docker-образ)
    KYIV = timezone(timedelta(hours=2), "Europe/Kyiv")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
DB_PATH = os.environ.get("DB_PATH", os.path.join(DATA_DIR, "fop.sqlite3"))
STATIC_DIR = os.path.join(BASE_DIR, "static")
# Інтерфейс — та сама однофайлова програма, що й на GitHub Pages (збирається standalone/build.py)
UI_FILE = os.environ.get("UI_FILE", os.path.join(BASE_DIR, "docs", "index.html"))

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))

# Пароль для входу у веб-інтерфейс. Якщо порожній — вхід без пароля (лише для локального запуску!).
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
# Секрет для підпису сесійних cookie. На сервері обов'язково задайте свій.
SECRET_KEY = os.environ.get("SECRET_KEY", "")
# Ставити Secure-прапорець на cookie (вмикайте, коли сайт працює через HTTPS)
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0") == "1"

# Як часто автоматично тягнути виписки (хвилини)
SYNC_INTERVAL_MIN = int(os.environ.get("SYNC_INTERVAL_MIN", "60"))
# Скільки днів назад перечитувати при кожній синхронізації (щоб підхопити зміни статусів)
RESYNC_OVERLAP_DAYS = int(os.environ.get("RESYNC_OVERLAP_DAYS", "3"))

# Базові URL API (можна підмінити для тестів / мок-сервера)
MONO_API = os.environ.get("MONO_API", "https://api.monobank.ua")
PRIVAT_API = os.environ.get("PRIVAT_API", "https://acp.privatbank.ua/api")
NBU_API = os.environ.get("NBU_API", "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange")
# API приватної частини Електронного кабінету платника
TAX_API = os.environ.get("TAX_API", "https://cabinet.tax.gov.ua/ws/public_api").rstrip("/")
# Node.js для фонового воркера (app/node/worker.js)
NODE_BIN = os.environ.get("NODE_BIN", "node")
# Лише для тестів: куди насправді слати CMP-запити (пошук сертифіката ключа)
CMP_TEST_URL = os.environ.get("CMP_TEST_URL", "")
# Пауза між запитами виписки Monobank (ліміт банку — 1 запит на 60 с)
MONO_MIN_INTERVAL_SEC = float(os.environ.get("MONO_MIN_INTERVAL_SEC", "61"))

# Публічна адреса застосунку (для вебхука Monobank), напр. https://fop.example.com
PUBLIC_URL = os.environ.get("PUBLIC_URL", "").rstrip("/")

# Податкові параметри за замовчуванням (ФОП 3 група).
# min_wage — мінімальна зарплата на 1 січня; income_limit = 1167 × min_wage;
# esv_month = 22% × min_wage; mil_rate — військовий збір для 3 групи, % від доходу.
DEFAULT_TAX_PARAMS = {
    2025: {"min_wage": 8000.00, "income_limit": 9336000.00, "esv_month": 1760.00,
           "single_tax_rate": 5.0, "mil_rate": 1.0},
    2026: {"min_wage": 8647.00, "income_limit": 10091049.00, "esv_month": 1902.34,
           "single_tax_rate": 5.0, "mil_rate": 1.0},
}

# Категорії операцій
CATEGORIES = {
    "income": "Дохід",
    "refund_to_buyer": "Повернення коштів покупцю (зменшує дохід)",
    "own_transfer": "Власні кошти / переказ між своїми рахунками",
    "currency_exchange": "Купівля/продаж валюти",
    "refund_in": "Повернення помилково/надміру сплачених коштів",
    "loan": "Кредит / позика / поворотна допомога",
    "tax_refund": "Повернення податків",
    "other_non_income": "Інше (не дохід)",
    "expense": "Витрата",
}
INCOME_CATEGORIES = {"income"}
INCOME_REDUCING = {"refund_to_buyer"}
