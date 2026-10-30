"""Мок-сервер Monobank + ПриватБанк + НБУ для тестів і демо.

Запуск: python -m tests.mock_banks 8090
Потім застосунок: MONO_API=http://127.0.0.1:8090/mono PRIVAT_API=http://127.0.0.1:8090/privat \
                  NBU_API=http://127.0.0.1:8090/nbu MONO_MIN_INTERVAL_SEC=0 python run.py
Токени: mono — будь-який, privat — будь-який.
"""
import json
import random
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

KYIV = timezone(timedelta(hours=2))
YEAR = 2026
CLIENTS = ["ТОВ «Альфа Софт»", "ТОВ «Бета Медіа»", "ФОП Коваленко О. В.", "Upwork Escrow Inc.", "ТОВ «Гамма Трейд»"]


def _gen_mono():
    rnd = random.Random(42)
    fop_uah, fop_usd, black = [], [], []
    start = datetime(YEAR, 1, 3, 10, tzinfo=KYIV)
    end = datetime(YEAR, 10, 28, 18, tzinfo=KYIV)
    d = start
    i = 0
    while d < end:
        i += 1
        # дохід від клієнтів у гривні
        if rnd.random() < 0.35:
            amt = rnd.randint(8_000, 65_000) * 100
            fop_uah.append(dict(id=f"mu{i}", time=int(d.timestamp()), description=f"Оплата за послуги згідно рахунку №{i}",
                                amount=amt, currencyCode=980, counterName=rnd.choice(CLIENTS), counterEdrpou="4" + str(1000000 + i),
                                counterIban=f"UA{i:027d}", hold=False))
        # валютна виручка
        if rnd.random() < 0.06:
            amt = rnd.randint(500, 3000) * 100
            fop_usd.append(dict(id=f"md{i}", time=int(d.timestamp()), description="Payment for software development services",
                                amount=amt, currencyCode=840, counterName="Deel Inc.", hold=False))
            # продаж валюти через день
            fop_usd.append(dict(id=f"ms{i}", time=int((d + timedelta(days=1)).timestamp()), description="Продаж валюти",
                                amount=-amt, currencyCode=840, hold=False))
            fop_uah.append(dict(id=f"mx{i}", time=int((d + timedelta(days=1, minutes=1)).timestamp()),
                                description="Продаж валюти", amount=int(amt * 41.3), currencyCode=980, hold=False))
        # витрати
        if rnd.random() < 0.25:
            fop_uah.append(dict(id=f"me{i}", time=int((d + timedelta(hours=3)).timestamp()),
                                description="Сплата єдиного податку", amount=-rnd.randint(500, 3000) * 100, currencyCode=980))
        # переказ собі на чорну картку і назад
        if rnd.random() < 0.05:
            fop_uah.append(dict(id=f"mo{i}", time=int((d + timedelta(hours=5)).timestamp()), description="Поповнення рахунку",
                                amount=2_000_000, currencyCode=980, counterName="ШЕВЧЕНКО МИХАЙЛО", counterIban="UA000000000000000000000000BLACK"))
        # на особисту картку — не дохід ФОП
        if rnd.random() < 0.2:
            black.append(dict(id=f"mb{i}", time=int(d.timestamp()), description="Від: Олена",
                              amount=rnd.randint(100, 2000) * 100, currencyCode=980))
        d += timedelta(days=1, minutes=rnd.randint(-120, 120))
    # повернення передоплати покупцю
    fop_uah.append(dict(id="mr1", time=int(datetime(YEAR, 5, 14, 12, tzinfo=KYIV).timestamp()),
                        description="Повернення передоплати за договором 12", amount=-1_500_000, currencyCode=980,
                        counterName="ТОВ «Бета Медіа»"))
    # відшкодування еквайрингу: на рахунок надходить сума мінус комісія, комісія — в призначенні
    for k, (gross, comm) in enumerate([(100000, 1300), (250000, 3250), (48000, 624)]):
        fop_uah.append(dict(id=f"ma{k}", time=int(datetime(YEAR, 10, 20 + k, 9, tzinfo=KYIV).timestamp()),
                            description=f"Відшкодування за операції з ПК, сума операцій {gross/100:.2f} грн, комісія {comm/100:.2f} грн".replace(".", ","),
                            amount=gross - comm, currencyCode=980, counterName="АТ «Банк Еквайр»"))
    # пачка дрібних платежів у березні для перевірки пагінації (>500 за вікно)
    base = datetime(YEAR, 3, 10, 9, tzinfo=KYIV)
    for k in range(620):
        fop_uah.append(dict(id=f"mp{k}", time=int((base + timedelta(minutes=37 * k)).timestamp()),
                            description="Оплата через еквайринг", amount=25_000, currencyCode=980, counterName="Еквайринг"))
    return {"acc-fop-uah": fop_uah, "acc-fop-usd": fop_usd, "acc-black": black}


MONO = _gen_mono()
for v in MONO.values():
    v.sort(key=lambda x: -x["time"])


def _gen_privat():
    rnd = random.Random(7)
    items = []
    d = datetime(YEAR, 1, 5, 11, tzinfo=KYIV)
    i = 0
    while d < datetime(YEAR, 10, 28, tzinfo=KYIV):
        i += 1
        if rnd.random() < 0.15:
            items.append({"ID": f"P{i}", "TRANTYPE": "C", "SUM": f"{rnd.randint(5000, 40000)}.00", "CCY": "UAH",
                          "OSND": f"Оплата за товар згідно рах. {i}, у т.ч. без ПДВ", "AUT_CNTR_NAM": rnd.choice(CLIENTS),
                          "AUT_CNTR_CRF": "38" + str(100000 + i), "AUT_CNTR_ACC": f"UA9{i:026d}", "AUT_MY_ACC": "UA213052990000026001000000001",
                          "DAT_OD": d.strftime("%d.%m.%Y"), "TIM_P": d.strftime("%H:%M"),
                          "DATE_TIME_DAT_OD_TIM_P": d.strftime("%d.%m.%Y %H:%M:%S"), "PR_PR": "r", "FL_REAL": "r"})
        if rnd.random() < 0.03:
            items.append({"ID": f"PL{i}", "TRANTYPE": "C", "SUM": "50000.00", "CCY": "UAH",
                          "OSND": "Повернення поворотної фінансової допомоги", "AUT_CNTR_NAM": "ТОВ «Альфа Софт»",
                          "DAT_OD": d.strftime("%d.%m.%Y"), "TIM_P": "15:00", "PR_PR": "r", "FL_REAL": "r"})
        if rnd.random() < 0.02:  # інформаційна — має ігноруватись
            items.append({"ID": f"PI{i}", "TRANTYPE": "C", "SUM": "999999.00", "CCY": "UAH", "OSND": "Інформаційна",
                          "DAT_OD": d.strftime("%d.%m.%Y"), "PR_PR": "r", "FL_REAL": "i"})
        d += timedelta(days=1)
    return items


PRIVAT = _gen_privat()
NBU_USD = 41.0


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "X-Token, token, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.end_headers()

    def do_POST(self):
        if self.path.startswith("/mono/personal/webhook"):
            return self._json({"status": "ok"})
        self._json({"error": "nf"}, 404)

    def do_GET(self):
        u = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path
        if p.startswith("/mono/"):
            if not self.headers.get("X-Token"):
                return self._json({"errorDescription": "Unknown 'X-Token'"}, 403)
            if p == "/mono/personal/client-info":
                return self._json({"clientId": "x", "name": "Шевченко Михайло", "accounts": [
                    {"id": "acc-fop-uah", "currencyCode": 980, "balance": 15432100, "type": "fop", "iban": "UA000000000000000000000000FOPUAH", "maskedPan": []},
                    {"id": "acc-fop-usd", "currencyCode": 840, "balance": 120000, "type": "fop", "iban": "UA000000000000000000000000FOPUSD", "maskedPan": []},
                    {"id": "acc-black", "currencyCode": 980, "balance": 500000, "type": "black", "iban": "UA000000000000000000000000BLACK", "maskedPan": ["537541******1234"]},
                ]})
            if p.startswith("/mono/personal/statement/"):
                _, _, _, _, acc, fr, to = p.split("/")
                fr, to = int(fr), int(to)
                if to - fr > 31 * 24 * 3600 + 3600:
                    return self._json({"errorDescription": "Period must be no more than 31 days"}, 400)
                items = [x for x in MONO.get(acc, []) if fr <= x["time"] <= to]
                return self._json(items[:500])
        bridged = False
        if p == "/bridge":  # імітація мосту Google Apps Script
            if not qs.get("key"):
                return self._json({"status": "ERROR", "message": "Невірний ключ доступу до мосту"})
            p, bridged = "/privat/" + qs.get("path", ""), True
        if p == "/privat/statements/balance":
            if not self.headers.get("token") and not bridged:
                return self._json({"status": "ERROR", "message": "token required"}, 401)
            return self._json({"status": "SUCCESS", "type": "balances", "exist_next_page": False, "balances": [
                {"acc": "UA213052990000026001000000001", "currency": "UAH", "balanceOut": "254300.15", "nameACC": "ФОП ШЕВЧЕНКО МИХАЙЛО"}]})
        if p == "/privat/statements/transactions":
            fmt = "%d-%m-%Y"
            s = datetime.strptime(qs["startDate"], fmt).date()
            e = datetime.strptime(qs["endDate"], fmt).date()
            items = [x for x in PRIVAT if s <= datetime.strptime(x["DAT_OD"], "%d.%m.%Y").date() <= e]
            off = int(qs.get("followId") or 0)
            lim = min(int(qs.get("limit") or 20), 50)  # маленька сторінка, щоб перевірити пагінацію
            page = items[off:off + lim]
            more = off + lim < len(items)
            return self._json({"status": "SUCCESS", "type": "transactions", "exist_next_page": more,
                               "next_page_id": str(off + lim) if more else None, "transactions": page})
        if p == "/nbu":
            d = qs["date"]
            return self._json([{"r030": 840, "cc": qs["valcode"], "rate": NBU_USD, "exchangedate": f"{d[6:]}.{d[4:6]}.{d[:4]}"}])
        self._json({"error": "not found"}, 404)


def serve(port):
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    print(f"Mock banks on http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
