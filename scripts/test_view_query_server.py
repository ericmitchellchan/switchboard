"""SWIT-118 — the view query server's rules and one real round trip.

Pure helpers first (no duckdb needed), then an end-to-end run against a
temporary DuckDB file over real HTTP on an ephemeral port: a bound query, a
missing parameter, a write refused by the read-only connection, two statements
refused, a name that tries to leave the sql dir, CORS for the app's origin only,
a POST body's parameters, and the row cap. Run by src/lib/viewQueryServer.test.ts.
"""

import importlib.util
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "src-tauri" / "resources" / "mcp" / "view-query-server.py"
spec = importlib.util.spec_from_file_location("view_query_server", SCRIPT)
vqs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vqs)


class PureHelpers(unittest.TestCase):
    def test_db_args(self):
        self.assertEqual(vqs.parse_db_args(["a=C:/x.duckdb", "pg=postgres:postgresql://h/db"]),
                         {"a": "C:/x.duckdb", "pg": "postgres:postgresql://h/db"})
        for bad in ["noequals", "bad name=x", "a="]:
            with self.assertRaises(ValueError):
                vqs.parse_db_args([bad])

    def test_one_statement_only(self):
        self.assertEqual(vqs.single_statement("SELECT 1;  -- trailing\n"), "SELECT 1")
        self.assertEqual(vqs.single_statement("SELECT ';' AS semi"), "SELECT ';' AS semi")
        with self.assertRaises(ValueError):
            vqs.single_statement("SELECT 1; DROP TABLE t")
        with self.assertRaises(ValueError):
            vqs.single_statement("-- only a comment\n")

    def test_placeholders_skip_strings_and_comments(self):
        sql = vqs.single_statement("SELECT '$notme' AS s, $expiry, $width::INT, $expiry -- $comment\n")
        self.assertEqual(vqs.placeholders(sql), ["expiry", "width"])

    def test_bind_names_what_is_missing_and_ignores_extras(self):
        self.assertEqual(vqs.bind_params("SELECT $a", {"a": "1", "b": "2"}), {"a": "1"})
        with self.assertRaisesRegex(ValueError, "missing parameter: a"):
            vqs.bind_params("SELECT $a", {})

    def test_sql_file_stays_in_its_folder(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "ok.sql").write_text("SELECT 1")
            self.assertEqual(vqs.resolve_sql_file(Path(d), "ok").name, "ok.sql")
            for bad in ["../ok", "a/b", "", "x" * 65]:
                with self.assertRaises(ValueError):
                    vqs.resolve_sql_file(Path(d), bad)
            with self.assertRaises(FileNotFoundError):
                vqs.resolve_sql_file(Path(d), "absent")

    def test_request_params_query_then_body(self):
        self.assertEqual(vqs.request_params("a=1&b=x%20y", None), {"a": "1", "b": "x y"})
        self.assertEqual(vqs.request_params("a=1", b'{"a": 2, "c": true, "d": null}'), {"a": "2", "c": "true", "d": ""})
        with self.assertRaises(ValueError):
            vqs.request_params("", b"[1,2]")

    def test_json_numbers_and_dates(self):
        from decimal import Decimal
        import datetime
        self.assertEqual(vqs.json_default(Decimal("10.5")), 10.5)
        self.assertEqual(vqs.json_default(Decimal("12")), 12)
        self.assertEqual(vqs.json_default(datetime.date(2026, 10, 3)), "2026-10-03")

    def test_host_must_be_this_loopback_server(self):
        self.assertTrue(vqs.allowed_host("127.0.0.1:8792", 8792))
        self.assertTrue(vqs.allowed_host("localhost:8792", 8792))
        self.assertFalse(vqs.allowed_host("evil.example:8792", 8792))
        self.assertFalse(vqs.allowed_host("127.0.0.1:9999", 8792))
        self.assertFalse(vqs.allowed_host(None, 8792))

    def test_non_finite_numbers_become_null(self):
        self.assertEqual(vqs.finite(float("nan")), None)
        self.assertEqual(vqs.finite([1.5, float("inf"), {"x": float("-inf")}]), [1.5, None, {"x": None}])

    def test_cors_answers_the_app_only(self):
        self.assertEqual(vqs.allowed_origin("http://tauri.localhost"), "http://tauri.localhost")
        self.assertIsNone(vqs.allowed_origin("https://evil.example"))
        self.assertIsNone(vqs.allowed_origin(None))


class RoundTrip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            import duckdb  # noqa: F401
        except ModuleNotFoundError:
            raise unittest.SkipTest("duckdb not installed — the round trip is skipped")
        import duckdb

        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        db = root / "t.duckdb"
        con = duckdb.connect(str(db))
        con.execute("CREATE TABLE book AS SELECT * FROM (VALUES (1,'front',10.5),(2,'front',11.0),(3,'all',12.0)) t(id, expiry, gamma)")
        con.close()
        sql = root / "sql"
        sql.mkdir()
        (sql / "book.sql").write_text("-- the book at one expiry set\nSELECT id, gamma FROM book WHERE expiry = $expiry ORDER BY id;\n")
        (sql / "every.sql").write_text("SELECT id FROM book ORDER BY id")
        (sql / "write.sql").write_text("DELETE FROM book")
        (sql / "two.sql").write_text("SELECT 1; SELECT 2")
        (sql / "nan.sql").write_text("SELECT 'NaN'::DOUBLE AS a, 'inf'::DOUBLE AS b, 1.5::DOUBLE AS c")
        cls.srv = vqs.serve(vqs.Config({"t": str(db)}, sql, max_rows=2, timeout_s=5), 0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    # No proxy: an HTTP_PROXY in the environment must not route a loopback test.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def ask(self, path, body=None, origin=None, host=None, method=None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=body, method=method or ("POST" if body else "GET"))
        if body:
            req.add_header("content-type", "application/json")
        if origin:
            req.add_header("Origin", origin)
        if host:
            req.add_header("Host", host)
        try:
            with self.opener.open(req, timeout=10) as r:
                if r.status == 204:
                    return r.status, None, dict(r.headers)
                return r.status, json.loads(r.read()), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read()), dict(e.headers)

    def test_a_bound_query_returns_rows(self):
        status, data, _ = self.ask("/q/t/book?expiry=front")
        self.assertEqual(status, 200)
        self.assertEqual(data["rows"], [{"id": 1, "gamma": 10.5}, {"id": 2, "gamma": 11.0}])
        self.assertEqual(data["meta"]["params"], {"expiry": "front"})

    def test_a_value_is_bound_not_spliced(self):
        status, data, _ = self.ask("/q/t/book?expiry=" + urllib.request.quote("front' OR '1'='1"))
        self.assertEqual(status, 200)
        self.assertEqual(data["rows"], [])

    def test_a_missing_parameter_is_named(self):
        status, data, _ = self.ask("/q/t/book")
        self.assertEqual(status, 400)
        self.assertIn("expiry", data["error"])

    def test_the_connection_cannot_write(self):
        status, data, _ = self.ask("/q/t/write")
        self.assertEqual(status, 422)
        status, data, _ = self.ask("/q/t/every")
        self.assertEqual(len(data["rows"]), 2)  # still three rows behind the cap

    def test_two_statements_are_refused(self):
        self.assertEqual(self.ask("/q/t/two")[0], 400)

    def test_unknowns_are_404(self):
        self.assertEqual(self.ask("/q/nope/book?expiry=x")[0], 404)
        self.assertEqual(self.ask("/q/t/absent")[0], 404)
        self.assertEqual(self.ask("/elsewhere")[0], 404)

    def test_the_row_cap_says_so(self):
        _, data, _ = self.ask("/q/t/every")
        self.assertTrue(data["meta"]["capped"])
        self.assertEqual(data["meta"]["n"], 2)

    def test_a_post_body_carries_the_parameters(self):
        status, data, _ = self.ask("/q/t/book", body=b'{"expiry": "all"}')
        self.assertEqual(status, 200)
        self.assertEqual(data["rows"], [{"id": 3, "gamma": 12.0}])

    def test_a_rebound_hostname_is_refused(self):
        status, data, _ = self.ask("/q/t/book?expiry=front", host=f"evil.example:{self.port}")
        self.assertEqual(status, 403)

    def test_nan_and_infinity_arrive_as_null_in_valid_json(self):
        status, data, _ = self.ask("/q/t/nan")
        self.assertEqual(status, 200)
        self.assertEqual(data["rows"], [{"a": None, "b": None, "c": 1.5}])

    def test_the_preflight_answers_the_app_origin(self):
        status, _, h = self.ask("/q/t/book", origin="http://tauri.localhost", method="OPTIONS")
        self.assertEqual(status, 204)
        self.assertEqual(h.get("Access-Control-Allow-Origin"), "http://tauri.localhost")
        self.assertIn("POST", h.get("Access-Control-Allow-Methods", ""))

    def test_cors_for_the_app_origin_only(self):
        _, _, h = self.ask("/q/t/book?expiry=front", origin="http://tauri.localhost")
        self.assertEqual(h.get("Access-Control-Allow-Origin"), "http://tauri.localhost")
        _, _, h = self.ask("/q/t/book?expiry=front", origin="https://evil.example")
        self.assertIsNone(h.get("Access-Control-Allow-Origin"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
