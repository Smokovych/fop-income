"""Розрахунок доходу та податків ФОП 3 групи (неплатник ПДВ)."""
from datetime import date, timedelta

from . import config, db

QUARTER_MONTHS = {1: (1, 3), 2: (4, 6), 3: (7, 9), 4: (10, 12)}


def tax_params(year):
    p = db.q1("SELECT * FROM tax_params WHERE year=?", (year,))
    if p:
        return p
    # якщо параметрів року ще немає — беремо найближчий попередній рік
    p = db.q1("SELECT * FROM tax_params WHERE year<? ORDER BY year DESC LIMIT 1", (year,)) or \
        db.q1("SELECT * FROM tax_params ORDER BY year DESC LIMIT 1")
    p = dict(p)
    p["year"] = year
    p["assumed"] = True
    return p


def _next_workday(d):
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def quarter_deadlines(year, quarter):
    """Граничні строки за квартал.

    Декларація: 40 календарних днів після кінця кварталу (з переносом з вихідного).
    Єдиний податок і військовий збір: протягом 10 днів після граничного строку подання декларації.
    ЄСВ за себе: до 20 числа місяця, що настає за кварталом.
    """
    _, m_end = QUARTER_MONTHS[quarter]
    q_end = (date(year + 1, 1, 1) if m_end == 12 else date(year, m_end + 1, 1)) - timedelta(days=1)
    decl = q_end + timedelta(days=40)
    pay = decl + timedelta(days=10)
    esv_month = q_end + timedelta(days=1)
    esv = date(esv_month.year, esv_month.month, 20)
    return {
        "declaration": _next_workday(decl).isoformat(),
        "single_tax": pay.isoformat(),
        "military": pay.isoformat(),
        "esv": esv.isoformat(),
    }


def _income_rows(year):
    """Операції, що впливають на дохід, за рік (з урахуванням ручних категорій)."""
    return db.q(
        """SELECT t.*, COALESCE(t.manual_category, t.auto_category) AS category
           FROM transactions t JOIN accounts a ON a.id = t.account_id
           WHERE t.date >= ? AND t.date <= ?
             AND COALESCE(t.manual_category, t.auto_category) IN ('income', 'refund_to_buyer')""",
        (f"{year}-01-01", f"{year}-12-31"))


def summary(year):
    p = tax_params(year)
    rate = p["single_tax_rate"] / 100.0
    mil = p["mil_rate"] / 100.0
    esv_enabled = db.get_setting("esv_enabled", True)

    months = {m: {"income": 0, "refunds": 0, "count": 0} for m in range(1, 13)}
    missing_rates = 0
    for t in _income_rows(year):
        m = int(t["date"][5:7])
        uah = t["uah_amount"]
        if uah is None:
            missing_rates += 1
            continue
        if t["category"] == "income":
            months[m]["income"] += uah
            months[m]["count"] += 1
        else:  # повернення покупцю — зменшує дохід
            months[m]["refunds"] += abs(uah)

    quarters = []
    cumulative = 0
    today = date.today()
    for qn, (m1, m2) in QUARTER_MONTHS.items():
        inc = sum(months[m]["income"] for m in range(m1, m2 + 1))
        ref = sum(months[m]["refunds"] for m in range(m1, m2 + 1))
        net = inc - ref
        cumulative += net
        tax_base = max(net, 0)
        q_start = date(year, m1, 1)
        quarters.append({
            "quarter": qn,
            "income": inc / 100,
            "refunds": ref / 100,
            "net_income": net / 100,
            "cumulative": cumulative / 100,
            "single_tax": round(tax_base * rate / 100, 2),
            "military": round(tax_base * mil / 100, 2),
            "esv": round(p["esv_month"] * 3, 2) if esv_enabled else 0.0,
            "deadlines": quarter_deadlines(year, qn),
            "started": q_start <= today,
        })

    total = cumulative / 100
    limit = p["income_limit"]
    over = max(0.0, total - limit)
    return {
        "year": year,
        "params": p,
        "esv_enabled": esv_enabled,
        "total_income": total,
        "limit": limit,
        "limit_used_pct": round(total / limit * 100, 2) if limit else 0,
        "limit_left": round(limit - total, 2),
        "over_limit": round(over, 2),
        "over_limit_tax": round(over * 0.15, 2),  # 15% із суми перевищення
        "single_tax_total": round(sum(q["single_tax"] for q in quarters), 2),
        "military_total": round(sum(q["military"] for q in quarters), 2),
        "esv_total": round(sum(q["esv"] for q in quarters if q["started"]), 2),
        "months": [{"month": m, "income": v["income"] / 100, "refunds": v["refunds"] / 100,
                    "count": v["count"]} for m, v in months.items()],
        "quarters": quarters,
        "missing_rates": missing_rates,
    }


def upcoming(limit=6):
    """Найближчі податкові дедлайни (від сьогодні)."""
    today = date.today()
    out = []
    for year in (today.year - 1, today.year):
        s = summary(year)
        for q in s["quarters"]:
            d = q["deadlines"]
            items = [
                (d["declaration"], f"Декларація ЄП за {q['quarter']} кв. {year}", None),
                (d["single_tax"], f"Єдиний податок за {q['quarter']} кв. {year}", q["single_tax"]),
                (d["military"], f"Військовий збір за {q['quarter']} кв. {year}", q["military"]),
            ]
            if s["esv_enabled"]:
                items.append((d["esv"], f"ЄСВ за {q['quarter']} кв. {year}", q["esv"]))
            for when, title, amount in items:
                if when >= today.isoformat():
                    out.append({"date": when, "title": title, "amount": amount,
                                "days_left": (date.fromisoformat(when) - today).days})
    out.sort(key=lambda x: x["date"])
    return out[:limit]


def income_book(date_from, date_to):
    """Рядки для Книги обліку доходів (дата, сума доходу в грн, примітка)."""
    rows = db.q(
        """SELECT t.date, t.uah_amount, t.amount, t.currency, t.nbu_rate, t.description, t.counter_name,
                  COALESCE(t.manual_category, t.auto_category) AS category, a.name AS account
           FROM transactions t JOIN accounts a ON a.id=t.account_id
           WHERE t.date BETWEEN ? AND ?
             AND COALESCE(t.manual_category, t.auto_category) IN ('income','refund_to_buyer')
           ORDER BY t.date, t.ts""", (date_from, date_to))
    return rows


CATEGORY_LABELS = config.CATEGORIES
