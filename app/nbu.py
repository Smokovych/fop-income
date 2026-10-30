"""Офіційні курси НБУ (дохід у валюті перераховується за курсом НБУ на дату зарахування)."""
from . import config, db
from .http import request, ApiError


def get_rate(cc, date_iso):
    """Курс НБУ: скільки гривень за 1 одиницю валюти cc на дату date_iso (YYYY-MM-DD)."""
    cc = cc.upper()
    if cc == "UAH":
        return 1.0
    row = db.q1("SELECT rate FROM nbu_rates WHERE cc=? AND date=?", (cc, date_iso))
    if row:
        return row["rate"]
    data = request("GET", config.NBU_API, params={
        "valcode": cc, "date": date_iso.replace("-", ""), "json": ""}, timeout=20)
    if not data:
        raise ApiError(f"НБУ не повернув курс {cc} на {date_iso}")
    rate = float(data[0]["rate"])
    db.ex("INSERT OR REPLACE INTO nbu_rates(cc, date, rate) VALUES (?,?,?)", (cc, date_iso, rate))
    return rate
