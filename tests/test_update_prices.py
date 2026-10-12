"""Pruebas del script de precios. Ejecutar:  python3 -m unittest discover -s tests -v

Ojo: estas pruebas usan textos de ejemplo copiados de lo que muestran las webs; comprueban la
lógica del script, NO que las webs sigan teniendo el mismo formato hoy. Para eso está el modo
`probe` (ver README)."""
import json
import os
import sys
import threading
import unittest
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import update_prices as up  # noqa: E402

TODAY = date(2026, 10, 12)


class Numbers(unittest.TestCase):
    def test_formats(self):
        self.assertAlmostEqual(up.parse_number("13,066492"), 13.066492)
        self.assertAlmostEqual(up.parse_number("1.260,49"), 1260.49)
        self.assertAlmostEqual(up.parse_number("446.9632"), 446.9632)
        self.assertAlmostEqual(up.parse_number("1,234.56"), 1234.56)
        self.assertAlmostEqual(up.parse_number("107,06"), 107.06)

    def test_ambiguous_thousands_with_hint(self):
        self.assertAlmostEqual(up.parse_number("1.234", ","), 1234.0)
        self.assertAlmostEqual(up.parse_number("1,234", "."), 1234.0)
        self.assertAlmostEqual(up.parse_number("2.081", "."), 2.081)

    def test_dates(self):
        self.assertEqual(up.parse_date("27/09/2026"), date(2026, 9, 27))
        self.assertEqual(up.parse_date("03.08.26"), date(2026, 8, 3))
        self.assertEqual(up.parse_date("2026-10-09"), date(2026, 10, 9))
        self.assertEqual(up.parse_date("Oct 09 2026"), date(2026, 10, 9))
        self.assertEqual(up.parse_date("Oct 9, 2026"), date(2026, 10, 9))
        self.assertIsNone(up.parse_date("basura"))
        self.assertIsNone(up.parse_date("31/02/2026"))

    def test_html_to_text(self):
        raw = "<html><script>var x=1;</script><div>Hola&nbsp;<b>mundo</b></div><p>Precio 1,5</p></html>"
        t = up.html_to_text(raw)
        self.assertIn("Hola mundo", t)
        self.assertNotIn("var x", t)
        self.assertIn("Precio 1,5", t)


class Parsers(unittest.TestCase):
    def test_quefondos_plan(self):
        text = ("Última valoración\nValor liquidativo: 13,066492 EUR\n"
                "Patrimonio (miles de euros):346.532,97\nFecha: 27/09/2026\nRentabilidades anuales")
        q = up.parse_quefondos(text)
        self.assertAlmostEqual(q.price, 13.066492)
        self.assertEqual(q.nav_date, date(2026, 9, 27))

    def test_quefondos_without_date(self):
        q = up.parse_quefondos("Valor liquidativo: 26,175991 EUR\nPatrimonio 1")
        self.assertIsNone(q.nav_date)

    def test_quefondos_missing(self):
        with self.assertRaises(up.SourceError):
            up.parse_quefondos("nada de nada")

    def test_finect(self):
        text = ("Vanguard Global Stock Index Fund Institutional Plus EUR Acc\n444,30\n"
                "Fecha de valor liquidativo:\nLogotipo de Finect")
        q = up.parse_finect(text)
        self.assertAlmostEqual(q.price, 444.30)
        self.assertIsNone(q.nav_date)

    def test_finect_with_date(self):
        q = up.parse_finect("Nao Renta Variable Europa M FI\n2,08\nFecha de valor liquidativo: 09/10/2026\n")
        self.assertAlmostEqual(q.price, 2.08)
        self.assertEqual(q.nav_date, date(2026, 10, 9))

    def test_ft(self):
        text = "Summary\nPrice (EUR) 107.16 Today's Change 0.10 / 0.09%\nData delayed, as of Oct 09 2026\n"
        q = up.parse_ft(text)
        self.assertAlmostEqual(q.price, 107.16)
        self.assertEqual(q.nav_date, date(2026, 10, 9))

    def test_ft_wrong_currency(self):
        with self.assertRaises(up.SourceError):
            up.parse_ft("Price (GBP) 107.16")

    def test_yahoo_chart(self):
        payload = {"chart": {"result": [{
            "meta": {"currency": "EUR", "regularMarketPrice": 101.3, "regularMarketTime": 1760000000,
                     "exchangeTimezoneName": "Europe/Paris"},
            "timestamp": [], "indicators": {"quote": [{"close": []}]}}], "error": None}}
        orig = up.http_get
        up.http_get = lambda url, **k: json.dumps(payload)
        try:
            q = up.yahoo_chart("ABVX.PA")
            self.assertAlmostEqual(q.price, 101.3)
            self.assertEqual(q.nav_date, date(2025, 10, 9))
            payload["chart"]["result"][0]["meta"]["currency"] = "USD"
            with self.assertRaises(up.SourceError):
                up.yahoo_chart("ABVX")
        finally:
            up.http_get = orig

    def test_yahoo_chart_falls_back_to_last_close(self):
        payload = {"chart": {"result": [{
            "meta": {"currency": "EUR"},
            "timestamp": [1760000000, 1760086400], "indicators": {"quote": [{"close": [10.0, None]}]}}]}}
        orig = up.http_get
        up.http_get = lambda url, **k: json.dumps(payload)
        try:
            self.assertAlmostEqual(up.yahoo_chart("X.PA").price, 10.0)
        finally:
            up.http_get = orig

    def test_yahoo_search_filters_types(self):
        payload = {"quotes": [{"symbol": "AAA", "quoteType": "FUTURE"}, {"symbol": "0P0001.F", "quoteType": "MUTUALFUND"}]}
        orig = up.http_get
        up.http_get = lambda url, **k: json.dumps(payload)
        try:
            self.assertEqual(up.yahoo_search("IE00BFPM9N11"), ["0P0001.F"])
        finally:
            up.http_get = orig

    def test_url_regex(self):
        orig = up.http_get
        up.http_get = lambda url, **k: "<div>VL actual: <b>1.234,56</b> € a fecha 05/10/2026</div>"
        try:
            q = up.src_url_regex({"url": "http://x", "price_regex": r"VL actual:\s*([\d.,]+)",
                                  "date_regex": r"fecha (\d{2}/\d{2}/\d{4})", "decimal": ","})
            self.assertAlmostEqual(q.price, 1234.56)
            self.assertEqual(q.nav_date, date(2026, 10, 5))
        finally:
            up.http_get = orig


def q(price, nav=None, source="x"):
    return up.Quote(price, nav, source)


class Choose(unittest.TestCase):
    def test_first_fresh_wins_and_skips_the_rest(self):
        calls = []

        def fetch(cfg):
            calls.append(cfg["type"])
            return q(10, date(2026, 10, 9), cfg["type"])
        got, errs = up.choose_quote([{"type": "a"}, {"type": "b"}], TODAY, 10, fetch)
        self.assertEqual(got.source, "a")
        self.assertEqual(calls, ["a"])

    def test_falls_back_when_first_fails(self):
        def fetch(cfg):
            if cfg["type"] == "a":
                raise up.SourceError("caída")
            return q(10, date(2026, 10, 9), "b")
        got, errs = up.choose_quote([{"type": "a"}, {"type": "b"}], TODAY, 10, fetch)
        self.assertEqual(got.source, "b")
        self.assertEqual(len(errs), 1)

    def test_prefers_fresh_over_stale(self):
        data = {"a": q(10, date(2026, 6, 1), "a"), "b": q(11, date(2026, 10, 8), "b")}
        got, _ = up.choose_quote([{"type": "a"}, {"type": "b"}], TODAY, 10, lambda c: data[c["type"]])
        self.assertEqual(got.source, "b")

    def test_all_stale_returns_freshest(self):
        data = {"a": q(10, date(2026, 6, 1), "a"), "b": q(11, date(2026, 8, 1), "b")}
        got, errs = up.choose_quote([{"type": "a"}, {"type": "b"}], TODAY, 10, lambda c: data[c["type"]])
        self.assertEqual(got.source, "b")
        self.assertEqual(len(errs), 2)

    def test_all_fail(self):
        def fetch(cfg):
            raise up.SourceError("no")
        got, errs = up.choose_quote([{"type": "a"}], TODAY, 10, fetch)
        self.assertIsNone(got)

    def test_future_date_is_discarded(self):
        got, _ = up.choose_quote([{"type": "a"}], TODAY, 10, lambda c: q(10, date(2027, 1, 1)))
        self.assertIsNone(got.nav_date)

    def test_per_source_max_age(self):
        got, _ = up.choose_quote([{"type": "a", "max_age_days": 60}], TODAY, 10,
                                 lambda c: q(10, date(2026, 9, 1)))
        self.assertIsNotNone(got)


class FakeDb:
    def __init__(self, assets, last=None):
        self.assets, self.last, self.saved = assets, last or {}, []

    def get_assets(self):
        return self.assets

    def last_price(self, asset_id):
        return self.last.get(asset_id)

    def upsert_price(self, row):
        self.saved.append(row)


def asset(i, cat="fondo", sources=None, valuation="units"):
    return {"id": i, "user_id": "u1", "name": f"Activo {i}", "category": cat, "valuation": valuation,
            "sources": [{"type": "s"}] if sources is None else sources}


class RunUpdate(unittest.TestCase):
    def run_one(self, a, last=None, quote=None, exc=None):
        db = FakeDb([a], {a["id"]: last} if last else {})

        def fetch(cfg):
            if exc:
                raise exc
            return quote
        res = up.run_update(db, TODAY, False, fetch)
        return res[0], db

    def test_ok_saves_row(self):
        r, db = self.run_one(asset("1"), quote=q(100, date(2026, 10, 9), "yahoo"))
        self.assertEqual(r.status, "OK")
        self.assertEqual(db.saved[0]["price"], 100)
        self.assertEqual(db.saved[0]["date"], "2026-10-12")
        self.assertEqual(db.saved[0]["nav_date"], "2026-10-09")
        self.assertEqual(db.saved[0]["user_id"], "u1")

    def test_dry_run_does_not_save(self):
        db = FakeDb([asset("1")])
        up.run_update(db, TODAY, True, lambda c: q(100, date(2026, 10, 9)))
        self.assertEqual(db.saved, [])

    def test_unchanged_not_saved(self):
        last = {"date": "2026-10-11", "nav_date": "2026-10-09", "price": 100, "source": "yahoo"}
        r, db = self.run_one(asset("1"), last, q(100, date(2026, 10, 9)))
        self.assertEqual(r.status, "SIN CAMBIOS")
        self.assertEqual(db.saved, [])

    def test_new_nav_date_saved(self):
        last = {"date": "2026-10-09", "nav_date": "2026-10-08", "price": 100, "source": "yahoo"}
        r, db = self.run_one(asset("1"), last, q(100.5, date(2026, 10, 9)))
        self.assertEqual(r.status, "OK")
        self.assertEqual(len(db.saved), 1)

    def test_suspicious_jump_rejected_for_fund(self):
        last = {"date": "2026-10-09", "nav_date": "2026-10-08", "price": 2.08, "source": "finect"}
        r, db = self.run_one(asset("1"), last, q(208.0, date(2026, 10, 9)))
        self.assertEqual(r.status, "SOSPECHOSO")
        self.assertTrue(r.failure)
        self.assertEqual(db.saved, [])

    def test_big_move_allowed_for_stock(self):
        last = {"date": "2026-10-09", "nav_date": "2026-10-09", "price": 100, "source": "yahoo"}
        r, db = self.run_one(asset("1", "accion"), last, q(135, date(2026, 10, 12)))
        self.assertEqual(r.status, "OK")

    def test_jump_ignored_when_last_is_old(self):
        last = {"date": "2026-06-01", "nav_date": "2026-06-01", "price": 50, "source": "yahoo"}
        r, db = self.run_one(asset("1"), last, q(100, date(2026, 10, 9)))
        self.assertEqual(r.status, "OK")

    def test_error_with_recent_last_is_not_failure(self):
        last = {"date": "2026-10-10", "nav_date": "2026-10-09", "price": 100, "source": "yahoo"}
        r, db = self.run_one(asset("1"), last, exc=up.SourceError("caída"))
        self.assertEqual(r.status, "ERROR")
        self.assertFalse(r.failure)

    def test_error_with_old_last_is_failure(self):
        last = {"date": "2026-09-20", "nav_date": "2026-09-19", "price": 100, "source": "yahoo"}
        r, db = self.run_one(asset("1"), last, exc=up.SourceError("caída"))
        self.assertTrue(r.failure)

    def test_error_without_any_price_is_failure(self):
        r, db = self.run_one(asset("1"), None, exc=up.SourceError("caída"))
        self.assertTrue(r.failure)

    def test_manual_price_today_is_respected(self):
        last = {"date": "2026-10-12", "nav_date": None, "price": 77, "source": "manual"}
        r, db = self.run_one(asset("1"), last, q(100, date(2026, 10, 9)))
        self.assertEqual(r.status, "MANUAL")
        self.assertEqual(db.saved, [])

    def test_manual_assets_and_no_sources(self):
        db = FakeDb([asset("1", "efectivo", valuation="manual"), asset("2", sources=[])])
        res = up.run_update(db, TODAY, False, lambda c: q(1))
        self.assertEqual([r.status for r in res], ["SIN FUENTES"])
        self.assertFalse(res[0].failure)

    def test_stale_quote_is_saved_with_warning(self):
        r, db = self.run_one(asset("1"), None, q(10, date(2026, 8, 1)))
        self.assertEqual(r.status, "AVISO")
        self.assertEqual(len(db.saved), 1)


class Probe(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(up.classify("IE00BFPM9N11"), "isin")
        self.assertEqual(up.classify("ES0165283021"), "isin")
        self.assertEqual(up.classify("N2621"), "dgs")
        self.assertEqual(up.classify("ABVX.PA"), "ticker")

    def test_probe_reports_ok_and_failures(self):
        def fetch(cfg):
            if cfg["type"] == "yahoo":
                return up.Quote(10.5, date(2026, 10, 9), "yahoo", "SYM")
            raise up.SourceError("no responde")
        text, md = up.probe(["IE00BFPM9N11"], fetch)
        self.assertIn("OK  10.5", text)
        self.assertIn("FALLA  no responde", text)
        self.assertIn("| IE00BFPM9N11 |", md)


class Handler(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *a):
        pass

    def _reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        Handler.seen.append(("GET", self.path, dict(self.headers), None))
        if "/prices" in self.path:
            self._reply([{"date": "2026-10-09", "nav_date": "2026-10-08", "price": 12.5, "source": "ft"}])
        else:
            self._reply([{"id": "a1", "user_id": "u1", "name": "X", "category": "fondo",
                          "valuation": "units", "sources": []}])

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        Handler.seen.append(("POST", self.path, dict(self.headers), json.loads(self.rfile.read(n))))
        self.send_response(201)
        self.send_header("Content-Length", "0")
        self.end_headers()


class SupabaseClient(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), Handler)
        cls.url = f"http://127.0.0.1:{cls.srv.server_port}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        Handler.seen.clear()

    def test_new_secret_key_goes_only_in_apikey(self):
        db = up.SupabaseDb(self.url, "sb_secret_abc")
        db.get_assets()
        h = {k.lower(): v for k, v in Handler.seen[0][2].items()}
        self.assertEqual(h["apikey"], "sb_secret_abc")
        self.assertNotIn("authorization", h)

    def test_legacy_key_goes_in_both(self):
        db = up.SupabaseDb(self.url, "eyJlegacy")
        db.get_assets()
        h = {k.lower(): v for k, v in Handler.seen[0][2].items()}
        self.assertEqual(h["apikey"], "eyJlegacy")
        self.assertEqual(h["authorization"], "Bearer eyJlegacy")

    def test_last_price_and_upsert(self):
        db = up.SupabaseDb(self.url, "sb_secret_abc")
        lp = db.last_price("a1")
        self.assertEqual(lp["price"], 12.5)
        self.assertIn("asset_id=eq.a1", Handler.seen[0][1])
        db.upsert_price({"asset_id": "a1", "date": "2026-10-12", "price": 1})
        method, path, headers, body = Handler.seen[1]
        self.assertEqual(method, "POST")
        self.assertIn("on_conflict=asset_id,date", path)
        h = {k.lower(): v for k, v in headers.items()}
        self.assertIn("merge-duplicates", h["prefer"])
        self.assertEqual(body, [{"asset_id": "a1", "date": "2026-10-12", "price": 1}])

    def test_end_to_end_with_fake_server(self):
        db = up.SupabaseDb(self.url, "sb_secret_abc")
        # el servidor de prueba devuelve un activo sin fuentes -> "SIN FUENTES", sin escrituras
        res = up.run_update(db, TODAY, False, lambda c: q(1))
        self.assertEqual(res[0].status, "SIN FUENTES")
        self.assertFalse([s for s in Handler.seen if s[0] == "POST"])


class Render(unittest.TestCase):
    def test_render(self):
        res = [up.Result("A", "OK", 10.0, date(2026, 10, 9), "yahoo"),
               up.Result("B", "ERROR", note="cae | todo", failure=True)]
        text, md = up.render(res, TODAY, False)
        self.assertIn("[OK", text)
        self.assertIn("| A | OK | 10 | 2026-10-09 | yahoo |", md)
        self.assertNotIn("cae | todo", md)  # el | de la nota no rompe la tabla


if __name__ == "__main__":
    unittest.main()
