"""Запитання до ШІ про дані програми (вкладка «Операції»).

Модель Claude отримує запитання і відповідає, викликаючи інструменти, які рахують по даних на сервері:
вибірка й групування операцій, підсумки доходу й податків за рік. Самі виписки цілком моделі не передаються —
лише те, що вона запросила інструментами (зазвичай підсумки або кілька десятків операцій).

Потрібна змінна середовища ANTHROPIC_API_KEY (ключ з console.anthropic.com). Модель — AI_MODEL.
"""
import json
import os
import urllib.error
import urllib.request
from collections import OrderedDict
from datetime import datetime

from . import config, store

API_URL = os.environ.get("ANTHROPIC_API_URL", "https://api.anthropic.com/v1/messages")
MODEL = os.environ.get("AI_MODEL", "claude-sonnet-5-5")
MAX_ROUNDS = 8

CATEGORIES = {
    "income": "Дохід", "refund_to_buyer": "Повернення коштів покупцю (зменшує дохід)",
    "own_transfer": "Власні кошти / переказ між своїми рахунками", "currency_exchange": "Купівля/продаж валюти",
    "refund_in": "Повернення помилково/надміру сплачених коштів", "loan": "Кредит / позика / поворотна допомога",
    "tax_refund": "Повернення податків", "other_non_income": "Інше (не дохід)", "expense": "Витрата",
}
DEFAULT_TAX = {
    2022: {"income_limit": 7585500, "esv_month": 1430, "esv_q": [1430, 1430, 1430, 1474], "single_tax_rate": 5, "mil_rate": 0},
    2023: {"income_limit": 7818900, "esv_month": 1474, "single_tax_rate": 5, "mil_rate": 0},
    2024: {"income_limit": 8285700, "esv_month": 1760, "esv_q": [1562, 1760, 1760, 1760], "single_tax_rate": 5, "mil_rate": 0},
    2025: {"income_limit": 9336000, "esv_month": 1760, "single_tax_rate": 5, "mil_rate": 1},
    2026: {"income_limit": 10091049, "esv_month": 1902.34, "single_tax_rate": 5, "mil_rate": 1},
}


class AiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def enabled():
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


# ---------------------------------------------------------------- дані
def _cat(t):
    return t.get("manual_category") or t.get("auto_category") or ""


def _income_uah(t):
    if _cat(t) != "income" or t.get("nbu_rate") is None:
        return 0
    com = 0
    if t.get("amount", 0) > 0:
        com = t.get("commission_manual") if t.get("commission_manual") is not None else (t.get("commission_auto") or 0)
    return round((t["amount"] + com) * t["nbu_rate"])


def _uah(t):
    if t.get("uah_amount") is not None:
        return t["uah_amount"]
    return t["amount"] if t.get("currency") == "UAH" else None


def _bank_name(acc):
    return {"mono": "Monobank", "privat": "ПриватБанк"}.get(acc.get("bank"), "Файл")


def _rows(state):
    accs = state.get("accounts") or {}
    for t in (state.get("tx") or {}).values():
        a = accs.get(t.get("account_id"))
        if a:
            yield t, a


def _money(kop):
    return round((kop or 0) / 100, 2)


def _quarter(date):
    return f"{date[:4]}-Q{(int(date[5:7]) - 1) // 3 + 1}"


def query_transactions(state, p):
    df, dt = str(p.get("date_from") or ""), str(p.get("date_to") or "")
    cat, direction = p.get("category") or "any", p.get("direction") or "any"
    text = str(p.get("text") or "").lower().strip()
    cp = str(p.get("counterparty") or "").lower().strip()
    bank, cur = p.get("bank") or "any", str(p.get("currency") or "").upper()
    group, sort = p.get("group_by") or "none", p.get("sort") or "date_desc"
    limit = max(1, min(int(p.get("limit") or 50), 200))
    sel = []
    for t, a in _rows(state):
        d = t.get("date") or ""
        if (df and d < df) or (dt and d > dt):
            continue
        if cat != "any" and _cat(t) != cat:
            continue
        if direction == "in" and t["amount"] <= 0 or direction == "out" and t["amount"] >= 0:
            continue
        if bank != "any" and a.get("bank") != bank:
            continue
        if cur and t.get("currency") != cur:
            continue
        if cp and cp not in (t.get("counter_name") or "").lower():
            continue
        if text and text not in ((t.get("description") or "") + " " + (t.get("counter_name") or "") + " " + (t.get("comment") or "")).lower():
            continue
        sel.append((t, a))
    out = {"count": len(sel), "sum_uah": _money(sum(_uah(t) or 0 for t, _ in sel)),
           "income_uah": _money(sum(_income_uah(t) for t, _ in sel))}
    if group != "none":
        key = {"month": lambda t, a: t["date"][:7], "quarter": lambda t, a: _quarter(t["date"]), "year": lambda t, a: t["date"][:4],
               "counterparty": lambda t, a: (t.get("counter_name") or "—").strip(), "category": lambda t, a: CATEGORIES.get(_cat(t), _cat(t)),
               "account": lambda t, a: a.get("name") or a.get("id")}.get(group)
        if not key:
            raise ValueError("невідоме group_by")
        g = OrderedDict()
        for t, a in sel:
            k = key(t, a)
            x = g.setdefault(k, {"key": k, "count": 0, "sum_uah": 0, "income_uah": 0})
            x["count"] += 1
            x["sum_uah"] += _uah(t) or 0
            x["income_uah"] += _income_uah(t)
        groups = list(g.values())
        for x in groups:
            x["sum_uah"], x["income_uah"] = _money(x["sum_uah"]), _money(x["income_uah"])
        if group in ("counterparty", "category", "account"):
            groups.sort(key=lambda x: -abs(x["sum_uah"]))
        else:
            groups.sort(key=lambda x: x["key"])
        out["groups"] = groups[:limit]
        out["groups_total"] = len(groups)
        return out
    order = {"date_desc": (lambda x: x[0].get("ts") or 0, True), "date_asc": (lambda x: x[0].get("ts") or 0, False),
             "amount_desc": (lambda x: _uah(x[0]) or 0, True), "amount_asc": (lambda x: _uah(x[0]) or 0, False)}.get(sort, (lambda x: x[0].get("ts") or 0, True))
    sel.sort(key=order[0], reverse=order[1])
    out["rows"] = [{"date": t["date"], "account": a.get("name"), "bank": _bank_name(a), "amount": _money(t["amount"]), "currency": t.get("currency"),
                    "uah": _money(_uah(t)), "income_uah": _money(_income_uah(t)), "category": CATEGORIES.get(_cat(t), _cat(t)),
                    "counterparty": t.get("counter_name") or "", "description": (t.get("description") or "")[:200]} for t, a in sel[:limit]]
    return out


def tax_overview(state, p):
    year = int(p.get("year") or datetime.now(config.KYIV).year)
    par = dict(DEFAULT_TAX.get(year) or DEFAULT_TAX[max(DEFAULT_TAX)])
    par.update((state.get("taxParams") or {}).get(str(year)) or {})
    q_inc, q_ref = [0] * 4, [0] * 4
    for t, _ in _rows(state):
        if not (t.get("date") or "").startswith(f"{year}-"):
            continue
        q = (int(t["date"][5:7]) - 1) // 3
        if _cat(t) == "income":
            q_inc[q] += _income_uah(t)
        elif _cat(t) == "refund_to_buyer":
            q_ref[q] += abs(_uah(t) or 0)
    quarters, cum = [], 0
    for i in range(4):
        net = q_inc[i] - q_ref[i]
        cum += net
        base = max(net, 0) / 100
        esv_m = (par.get("esv_q") or [par["esv_month"]] * 4)[i]
        quarters.append({"quarter": i + 1, "income": _money(q_inc[i]), "refunds": _money(q_ref[i]), "net_income": _money(net),
                         "single_tax": round(base * par["single_tax_rate"] / 100, 2), "military_levy": round(base * par.get("mil_rate", 0) / 100, 2),
                         "esv_min": round(esv_m * 3, 2), "cumulative_income": _money(cum)})
    res = {"year": year, "group": "3 група, 5%", "params": par, "quarters": quarters, "year_income": _money(cum),
           "limit_used_pct": round(cum / 100 / par["income_limit"] * 100, 2) if par.get("income_limit") else None}
    budget = (state.get("tax") or {}).get("budget")
    if budget and int(p.get("year") or year) == year:
        raw = json.dumps(budget, ensure_ascii=False)
        res["cabinet_budget_state"] = json.loads(raw) if len(raw) < 12000 else raw[:12000] + "…(обрізано)"
    return res


TOOLS = [
    {"name": "query_transactions",
     "description": "Вибірка операцій з банківських виписок ФОП з фільтрами. Без group_by повертає список операцій (rows), з group_by — підсумки по групах. "
                    "Суми в гривнях: sum_uah — рух коштів (надходження +, списання −) за курсом НБУ; income_uah — дохід ФОП (лише категорія «Дохід», з утриманою комісією). "
                    "Завжди повертає count, sum_uah, income_uah по всій вибірці.",
     "input_schema": {"type": "object", "properties": {
         "date_from": {"type": "string", "description": "YYYY-MM-DD включно"},
         "date_to": {"type": "string", "description": "YYYY-MM-DD включно"},
         "category": {"type": "string", "enum": ["any"] + list(CATEGORIES)},
         "direction": {"type": "string", "enum": ["any", "in", "out"]},
         "text": {"type": "string", "description": "підрядок у призначенні платежу, контрагенті або коментарі (без урахування регістру)"},
         "counterparty": {"type": "string", "description": "підрядок у назві контрагента"},
         "bank": {"type": "string", "enum": ["any", "mono", "privat", "file"]},
         "currency": {"type": "string", "description": "UAH, USD, EUR…"},
         "group_by": {"type": "string", "enum": ["none", "month", "quarter", "year", "counterparty", "category", "account"]},
         "sort": {"type": "string", "enum": ["date_desc", "date_asc", "amount_desc", "amount_asc"]},
         "limit": {"type": "integer", "description": "скільки рядків або груп повернути (до 200)"}}}},
    {"name": "tax_overview",
     "description": "Дохід ФОП за рік по кварталах (наростаючим підсумком), розрахункові ЄП 5%, військовий збір, мінімальний ЄСВ, ліміт доходу 3 групи і, якщо завантажено, стан розрахунків з бюджетом з Електронного кабінету.",
     "input_schema": {"type": "object", "properties": {"year": {"type": "integer"}}, "required": ["year"]}},
]


def _context(state):
    s = state.get("settings") or {}
    years = {}
    for t, _ in _rows(state):
        y = (t.get("date") or "")[:4]
        years[y] = years.get(y, 0) + 1
    accs = [f"- {a.get('name')} ({_bank_name(a)}, {a.get('currency')}, {'рахунок ФОП' if a.get('is_fop') else 'особистий'}"
            f"{'' if a.get('enabled') else ', вимкнений'})" for a in (state.get("accounts") or {}).values()]
    today = datetime.now(config.KYIV).strftime("%Y-%m-%d")
    return (f"Ти — помічник-аналітик у програмі «ФОП-дохід» для українського ФОП 3 групи (єдиний податок 5%). "
            f"Відповідай українською, коротко й по суті, з конкретними числами (гривні з копійками, пробіл між тисячами). "
            f"Числа бери лише з інструментів — нічого не вигадуй і не рахуй з пам'яті. Якщо даних бракує, так і скажи. "
            f"Для таблиць використовуй markdown. Податкові поради — загальні, наприкінці не треба застережень, якщо не питають.\n\n"
            f"Сьогодні {today}. ФОП: {s.get('owner_name') or 'не вказано'}. Облік з {s.get('sync_start')}.\n"
            f"Операцій за роками: {json.dumps(dict(sorted(years.items())), ensure_ascii=False)}.\n"
            f"Рахунки:\n" + "\n".join(accs) + "\n"
            f"Категорії операцій: {json.dumps(CATEGORIES, ensure_ascii=False)}. Доходом ФОП є лише категорія income; "
            f"валютна виручка — дохід за курсом НБУ на дату зарахування на валютний рахунок, гривня від продажу валюти — не дохід.")


# ---------------------------------------------------------------- виклик моделі
def _call(payload):
    req = urllib.request.Request(API_URL, data=json.dumps(payload).encode(), method="POST", headers={
        "x-api-key": os.environ.get("ANTHROPIC_API_KEY", ""), "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", {}).get("message", "")
        except Exception:
            msg = ""
        if e.code == 401:
            raise AiError(502, "Ключ ANTHROPIC_API_KEY на сервері недійсний") from None
        if e.code == 429:
            raise AiError(429, "Забагато запитів до ШІ — спробуйте за хвилину") from None
        if e.code == 529:
            raise AiError(503, "Сервіс ШІ перевантажений — спробуйте трохи пізніше") from None
        raise AiError(502, f"Помилка ШІ (HTTP {e.code}) {msg}".strip()) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise AiError(502, f"Немає зв'язку з сервісом ШІ: {getattr(e, 'reason', e)}") from None


def ask(question, history=None):
    if not enabled():
        raise AiError(503, "ШІ не налаштовано: додайте змінну ANTHROPIC_API_KEY у налаштуваннях сервера (Render → Environment)")
    question = str(question or "").strip()[:2000]
    if not question:
        raise AiError(400, "Напишіть запитання")
    state = store.get()["state"] or {}
    messages = []
    for h in (history or [])[-4:]:
        if isinstance(h, dict) and h.get("q") and h.get("a"):
            messages += [{"role": "user", "content": str(h["q"])[:2000]}, {"role": "assistant", "content": str(h["a"])[:6000]}]
    messages.append({"role": "user", "content": question})
    tools_used = 0
    for _ in range(MAX_ROUNDS):
        r = _call({"model": MODEL, "max_tokens": 3000, "system": _context(state), "tools": TOOLS, "messages": messages})
        messages.append({"role": "assistant", "content": r.get("content") or []})
        calls = [c for c in r.get("content") or [] if c.get("type") == "tool_use"]
        if r.get("stop_reason") != "tool_use" or not calls:
            text = "\n".join(c.get("text", "") for c in r.get("content") or [] if c.get("type") == "text").strip()
            return {"answer": text or "Не вдалося сформулювати відповідь", "tools_used": tools_used, "model": r.get("model")}
        results = []
        for c in calls:
            tools_used += 1
            try:
                fn = {"query_transactions": query_transactions, "tax_overview": tax_overview}[c["name"]]
                out, err = json.dumps(fn(state, c.get("input") or {}), ensure_ascii=False), False
            except Exception as e:
                out, err = f"Помилка: {e}", True
            results.append({"type": "tool_result", "tool_use_id": c["id"], "content": out[:60000], "is_error": err})
        messages.append({"role": "user", "content": results})
    raise AiError(504, "Аналіз вийшов задовгим — уточніть запитання")
