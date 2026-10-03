#!/usr/bin/env python3
"""THE VIEW QUERY SERVER (SWIT-118) — a loopback endpoint a view's knobs can ask.

A view's controls (SWIT-111) substitute a value into its source; with a FILE
source a knob can only pick between answers the agent prepared. Pointed at this
server, a view's `query` source re-asks the DATA:

    source: {type: "query",
             url: "http://127.0.0.1:8792/q/research/gamma-book?expiry={expiry}"}

`/q/<db>/<name>` runs the SQL file `<sql-dir>/<name>.sql` against the database
named `<db>`, binding every `$param` in it from the query string (and, for a
POST, the JSON body — what a query source's `body` template sends). The answer
is `{"rows": [...], "meta": {...}}`, the shape every view already reads.

Safety, in order of what it costs a mistake:
  - bound to 127.0.0.1 only; a request whose Host is not this loopback address
    and port is refused (DNS rebinding); CORS answers only the app's own
    webview origins;
  - every database is opened READ-ONLY (a DuckDB file with read_only=True, a
    Postgres attached READ_ONLY), so no query writes to the DATABASE. The SQL
    files are the AGENT'S — the request only supplies bound values — and the
    agent is trusted: DuckDB still lets a query read other local files
    (read_csv) or write one (COPY ... TO), which is the same reach the agent's
    own shell already has;
  - ONE statement per file (a second one is refused);
  - parameters are BOUND, never spliced into the SQL; a `$param` the request
    does not supply is a 400 naming it; values arrive as text — cast in SQL
    (`$width::INTEGER`);
  - names are `[A-Za-z0-9_-]` and the SQL file must sit inside the sql dir;
  - a row cap and a time cap (the query is interrupted past it);
  - NaN / Infinity become null (JSON has no such numbers; the webview's parse
    would reject the whole answer).

Every refusal and failure prints its reason to stdout, so `job log` shows why
(the view's own line shows it too, from the answer's `error`).

Not supported in a .sql file: dollar-quoted strings ($$…$$) and nested block
comments — the statement and placeholder scans would misread them.

Run it as an app job (the `job` tool) so it outlives the conversation:

    python <this file> --db research=C:/path/research.duckdb \\
        [--db shotclock=postgres:postgresql://user:pw@127.0.0.1:5433/db] \\
        --sql-dir .sb-views/sql [--port 8792] [--max-rows 50000] [--timeout 20]

Standard library + duckdb only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PARAM_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)")
ALLOWED_ORIGINS = frozenset(
    {
        "http://localhost:1620",  # the dev build's webview
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    }
)
DEFAULT_PORT = 8792


# ── pure helpers (tested in scripts/test_view_query_server.py) ──────────────


def parse_db_args(items: list[str]) -> dict[str, str]:
    """`name=path` or `name=postgres:<url>` pairs → {name: target}."""
    dbs: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise ValueError(f"--db wants name=path, got {item!r}")
        name, target = item.split("=", 1)
        if not NAME_RE.fullmatch(name):
            raise ValueError(f"database name {name!r} must be [A-Za-z0-9_-]")
        if not target:
            raise ValueError(f"database {name!r} has no path")
        dbs[name] = target
    return dbs


def strip_sql_comments(sql: str) -> str:
    """Remove `-- line` and `/* block */` comments OUTSIDE string literals."""
    out: list[str] = []
    i, n = 0, len(sql)
    quote: str | None = None
    while i < n:
        c = sql[i]
        if quote:
            out.append(c)
            if c == quote:
                if i + 1 < n and sql[i + 1] == quote:  # '' or "" escape
                    out.append(sql[i + 1])
                    i += 1
                else:
                    quote = None
            i += 1
            continue
        if c in ("'", '"'):
            quote = c
            out.append(c)
            i += 1
        elif sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j < 0 else j
        elif sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            i = n if j < 0 else j + 2
            out.append(" ")
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _outside_strings(sql: str) -> str:
    """The SQL with string literals blanked — what placeholder and `;` scans read."""
    return re.sub(r"'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"", lambda m: " " * len(m.group(0)), sql)


def single_statement(sql: str) -> str:
    """The one statement in `sql` (comments and trailing `;` dropped), or
    ValueError when there are zero or several."""
    body = strip_sql_comments(sql).strip()
    while body.endswith(";"):
        body = body[:-1].rstrip()
    if not body:
        raise ValueError("the SQL file holds no statement")
    if ";" in _outside_strings(body):
        raise ValueError("the SQL file holds more than one statement — one per file")
    return body


def placeholders(sql: str) -> list[str]:
    """`$name` parameters outside string literals, first-seen order, unique."""
    seen: list[str] = []
    for m in PARAM_RE.finditer(_outside_strings(sql)):
        if m.group(1) not in seen:
            seen.append(m.group(1))
    return seen


def bind_params(sql: str, given: dict[str, str]) -> dict[str, str]:
    """The values for exactly the placeholders the SQL names; a missing one is
    a ValueError naming it. Extra request keys are ignored (a view may send
    knobs this query does not use)."""
    missing = [p for p in placeholders(sql) if p not in given]
    if missing:
        raise ValueError("missing parameter" + ("s" if len(missing) > 1 else "") + ": " + ", ".join(missing))
    return {p: given[p] for p in placeholders(sql)}


def resolve_sql_file(sql_dir: Path, name: str) -> Path:
    if not NAME_RE.fullmatch(name):
        raise ValueError("query names are [A-Za-z0-9_-]")
    root = sql_dir.resolve()
    path = (root / f"{name}.sql").resolve()
    if path.parent != root:
        raise ValueError("the query file must sit in the sql dir")
    if not path.is_file():
        raise FileNotFoundError(f"no query named {name!r}")
    return path


def request_params(query: str, body: bytes | None) -> dict[str, str]:
    """Query-string values, then a JSON body's top-level scalars over them."""
    params = {k: v[-1] for k, v in parse_qs(query, keep_blank_values=True).items()}
    if body:
        try:
            data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError(f"the body is not JSON: {e}") from None
        if not isinstance(data, dict):
            raise ValueError("the body must be a JSON object of parameters")
        for k, v in data.items():
            if isinstance(v, bool):
                params[str(k)] = "true" if v else "false"
            elif isinstance(v, (str, int, float)) or v is None:
                params[str(k)] = "" if v is None else str(v)
    return params


def allowed_host(host: str | None, port: int) -> bool:
    """The request was addressed to THIS loopback server — not a hostname
    that a page rebound to 127.0.0.1 (DNS rebinding)."""
    return host in (f"127.0.0.1:{port}", f"localhost:{port}")


def finite(value):
    """NaN / Infinity → None, through lists and dicts (list and struct
    columns) — JSON has no such numbers."""
    import math

    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, list):
        return [finite(v) for v in value]
    if isinstance(value, dict):
        return {k: finite(v) for k, v in value.items()}
    return value


def allowed_origin(origin: str | None) -> str | None:
    return origin if origin in ALLOWED_ORIGINS else None


def json_default(o):
    """What json cannot encode itself: a DECIMAL is a number (a chart needs
    one — DuckDB reads `10.5` literals and NUMERIC columns as Decimal), a date
    or timestamp is ISO 8601, anything else its text."""
    from decimal import Decimal

    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() and abs(o) < 2**53 else float(o)
    iso = getattr(o, "isoformat", None)
    if callable(iso):
        return iso()
    return str(o)


# ── the database side ───────────────────────────────────────────────────────


def open_readonly(target: str):
    import duckdb  # imported here so the pure helpers test without it

    if target.startswith("postgres:"):
        con = duckdb.connect(":memory:")
        con.execute("LOAD postgres")
        con.execute("ATTACH ? AS src (TYPE postgres, READ_ONLY)", [target[len("postgres:"):]])
        con.execute("USE src")
        return con
    return duckdb.connect(target, read_only=True)


def run_query(target: str, sql: str, params: dict[str, str], max_rows: int, timeout_s: float):
    con = open_readonly(target)
    timer = threading.Timer(timeout_s, con.interrupt)
    timer.start()
    try:
        cur = con.execute(sql, params) if params else con.execute(sql)
        cols = [d[0] for d in (cur.description or [])]
        fetched = cur.fetchmany(max_rows + 1)
    finally:
        timer.cancel()
        con.close()
    capped = len(fetched) > max_rows
    rows = [{c: finite(v) for c, v in zip(cols, r)} for r in fetched[:max_rows]]
    return rows, capped


# ── HTTP ────────────────────────────────────────────────────────────────────


class Config:
    def __init__(self, dbs: dict[str, str], sql_dir: Path, max_rows: int, timeout_s: float):
        self.dbs = dbs
        self.sql_dir = sql_dir
        self.max_rows = max_rows
        self.timeout_s = timeout_s


def make_handler(cfg: Config):
    class Handler(BaseHTTPRequestHandler):
        server_version = "SwitchboardViewQuery/1"

        def log_message(self, fmt, *args):  # one line per request, to the job log
            print(f"{self.command} {self.path} - " + (fmt % args), flush=True)

        def _cors(self):
            origin = allowed_origin(self.headers.get("Origin"))
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def _send(self, status: int, payload: dict):
            if status >= 400 and "error" in payload:
                # The reason goes to the job log too — `job log` is where an
                # agent looks when a knob stops working.
                print(f"{self.command} {self.path} -> {status}: {payload['error']}", flush=True)
            data = json.dumps(payload, default=json_default, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):  # the preflight a JSON POST from the webview sends
            self.send_response(204)
            origin = allowed_origin(self.headers.get("Origin"))
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, POST")
                self.send_header("Access-Control-Allow-Headers", "content-type")
                self.send_header("Vary", "Origin")
            self.end_headers()

        def do_GET(self):
            self._handle(None)

        def do_POST(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0:
                self._send(400, {"error": "a bad Content-Length"})
                return
            if length > 1_000_000:
                self._send(413, {"error": "the body is over 1 MB"})
                return
            self._handle(self.rfile.read(length) if length else b"")

        def _handle(self, body: bytes | None):
            if not allowed_host(self.headers.get("Host"), self.server.server_address[1]):
                self._send(403, {"error": "this server answers only requests addressed to its own loopback address"})
                return
            url = urlsplit(self.path)
            if url.path == "/health":
                self._send(200, {"ok": True, "databases": sorted(cfg.dbs)})
                return
            parts = url.path.strip("/").split("/")
            if len(parts) != 3 or parts[0] != "q":
                self._send(404, {"error": "ask /q/<db>/<query>"})
                return
            db, name = parts[1], parts[2]
            if db not in cfg.dbs:
                self._send(404, {"error": f"no database named {db!r} (have: {', '.join(sorted(cfg.dbs))})"})
                return
            try:
                path = resolve_sql_file(cfg.sql_dir, name)
                sql = single_statement(path.read_text(encoding="utf-8"))
                params = bind_params(sql, request_params(url.query, body))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
                return
            except ValueError as e:
                self._send(400, {"error": str(e)})
                return
            t0 = time.perf_counter()
            try:
                rows, capped = run_query(cfg.dbs[db], sql, params, cfg.max_rows, cfg.timeout_s)
            except Exception as e:  # a SQL error, an interrupt, a locked file
                self._send(422, {"error": f"{type(e).__name__}: {e}"[:2000]})
                return
            ms = round((time.perf_counter() - t0) * 1000)
            self._send(200, {"rows": rows, "meta": {"db": db, "query": name, "n": len(rows), "capped": capped, "ms": ms, "params": params}})

    return Handler


def serve(cfg: Config, port: int) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(cfg))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Loopback query endpoint for Switchboard views (SWIT-118).")
    ap.add_argument("--db", action="append", default=[], help="name=path.duckdb or name=postgres:<url> (repeatable)")
    ap.add_argument("--sql-dir", required=True, help="the folder of <name>.sql files")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--max-rows", type=int, default=50_000)
    ap.add_argument("--timeout", type=float, default=20.0, help="seconds before a query is interrupted")
    args = ap.parse_args(argv)
    # The job log is read as UTF-8; a piped Windows stdout defaults to the
    # code page, which garbles (or, for a path outside it, crashes on) output.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    try:
        dbs = parse_db_args(args.db)
    except ValueError as e:
        ap.error(str(e))
    if not dbs:
        ap.error("give at least one --db")
    sql_dir = Path(args.sql_dir)
    if not sql_dir.is_dir():
        ap.error(f"--sql-dir {sql_dir} is not a folder")
    srv = serve(Config(dbs, sql_dir, args.max_rows, args.timeout), args.port)
    print(f"view query server on http://127.0.0.1:{srv.server_address[1]} - databases: {', '.join(sorted(dbs))}; sql: {sql_dir.resolve()}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
