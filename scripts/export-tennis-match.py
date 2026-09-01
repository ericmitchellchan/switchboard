#!/usr/bin/env python3
"""Export one tennis match's flagged moments to a Switchboard `timeline` view file (T8, SWIT-62).

Reads `tennis_flow_anomaly_match` + `tennis_flow_anomaly_moment` from Lodestar's
research.duckdb and writes `{meta, rows}` JSON — the file the tennis TABLE's drill
opens: `.sb-views/tennis/<key>.json`, where <key> is the match_id passed through
the SAME sanitisation the shell applies to a drill key (`drillPathKey` in
src/lib/viewStore.ts — ported below, byte for byte in behaviour; a vitest diffs
the two on a list of awkward keys).

    python scripts/export-tennis-match.py <match_id | player-name substring> <out>
    python scripts/export-tennis-match.py --top [--min-trades 500] <out>
    python scripts/export-tennis-match.py --all <out-dir>
    python scripts/export-tennis-match.py --path-key <key>...      # print the sanitised keys

`out` is a directory (existing, or a path without a .json suffix) → the file is named
by the sanitised match_id inside it; a `.json` path is written verbatim. Prints one
line per file: `wrote <path> (<rows> rows, <n_trades> trades)`.

PRICE IS FOLDED TO PLAYER 1's YES-PRICE. Each moment's `price` in the DB is quoted on
whichever of the match's two tickers traded (one per player), so the raw column jumps
between ~5 and ~95 as the traded side alternates. Which ticker is player 1's comes
from the MATCH ID, not the match row's `ticker` column: a match_id ends in
`<code1><code2>` (three letters each) and every moment's ticker is
`<match_id>-<code1>` or `<match_id>-<code2>` (verified 2026-09-01: 1644 of 1644
moments), with code1 = player 1 — whereas the match row's `ticker` is player 1's in
only 73 of 137 matches. The row's `price` here is `price` on player 1's ticker and
`100 - price` on player 2's; a ticker matching neither is left raw and counted in
`meta.unfolded`. The raw value stays as `price_raw` with its `ticker`.

`backs_player` IS THE TAKER'S STANCE, NOT THE QUOTE. It is derived in Lodestar's
tennis_anomaly.py (trade_stance, lines 79-84) from buy-YES/buy-NO on the TRADED
ticker: buying YES on player X's market backs X, buying NO backs the other player.
The flagged moments over-represent bets AGAINST the on-court leader (the score
favors disagreement), so a `backs_player = 2` mark at a folded price of ~86 is a
cheap NO-side bet against a leading player 1 - expected, not inverted (verified
against the DB 2026-09-01: all four ticker-side x stance cells match this reading).

COVERAGE: the rows are FLAGGED moments only — and a subset of those: the `_moment`
table holds the TOP 12 flagged moments per match (verified 2026-09-01: 12 rows for
every one of the 137 matches, while `n_flagged` counts all flagged trades). The full
trade tape needs the backend. `meta.coverage` + `meta.n_trades` are what the view's
toolbar prints (`flagged moments only · 12 of 6117 trades`), so it never implies more.

stdlib + duckdb only.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys

DEFAULT_DB = "C:/Users/ericm/projects/lodestar/data/research.duckdb"
COVERAGE = "flagged moments only"

# ── drillPathKey, ported from src/lib/viewStore.ts ───────────────────────────
# JS: key.trim().slice(0, 120).replace(/[^A-Za-z0-9._-]/g, "_"); then "", "." and
# ".." (any run of dots) are refused. Two JS-isms are reproduced on purpose:
#   · `trim()` strips JS WhiteSpace + LineTerminators — NOT Python's isspace()
#     set (JS strips U+FEFF and not U+001C-U+001F; Python the reverse).
#   · `slice(0, 120)` counts UTF-16 code units and `.` in the regex matches
#     one code unit, so an astral character becomes TWO underscores and the cut
#     can split a surrogate pair (the lone half is also a `_`).
DRILL_KEY_CAP = 120
_JS_WS = (
    "\t\n\x0b\x0c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007"
    "\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_ALLOWED = re.compile(r"[A-Za-z0-9._-]")


def drill_path_key(key: str) -> str | None:
    trimmed = key.strip(_JS_WS)
    units = trimmed.encode("utf-16-le", "surrogatepass")[: DRILL_KEY_CAP * 2]
    sliced = units.decode("utf-16-le", "surrogatepass")
    out = []
    for ch in sliced:
        if _ALLOWED.fullmatch(ch):
            out.append(ch)
        else:
            out.append("_" * (len(ch.encode("utf-16-le", "surrogatepass")) // 2))
    cleaned = "".join(out)
    if cleaned == "" or re.fullmatch(r"\.+", cleaned):
        return None
    return cleaned


# ── the export ───────────────────────────────────────────────────────────────

MATCH_COLUMNS = (
    "match_id, ticker, level, player1_name, player2_name, winner, score, n_trades, "
    "n_flagged, flag_rate, first_trade, last_trade"
)


def _iso(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, _dt.datetime):
        # Naive stamps are UTC in Lodestar's tables; the reader treats a naive
        # ISO stamp as UTC (the candle rule), so no suffix is added.
        return v.strftime("%Y-%m-%dT%H:%M:%S.") + f"{v.microsecond // 1000:03d}"
    return str(v)


def _num(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v
    return v


def pick_matches(con, selector: str | None, top: bool, all_matches: bool, min_trades: int):
    if all_matches:
        return con.execute(
            f"select {MATCH_COLUMNS} from tennis_flow_anomaly_match order by score desc"
        ).fetchall()
    if top:
        rows = con.execute(
            f"select {MATCH_COLUMNS} from tennis_flow_anomaly_match where n_trades > ? "
            "order by score desc, match_id limit 1",
            [min_trades],
        ).fetchall()
        if not rows:
            sys.exit(f"no match with n_trades > {min_trades}")
        return rows
    if not selector:
        sys.exit("give a match_id or a player-name substring, or --top / --all")
    exact = con.execute(
        f"select {MATCH_COLUMNS} from tennis_flow_anomaly_match where match_id = ?", [selector]
    ).fetchall()
    if exact:
        return exact
    like = f"%{selector.lower()}%"
    hits = con.execute(
        f"select {MATCH_COLUMNS} from tennis_flow_anomaly_match "
        "where lower(player1_name) like ? or lower(player2_name) like ? order by score desc",
        [like, like],
    ).fetchall()
    if not hits:
        sys.exit(f"no match_id or player matches {selector!r}")
    if len(hits) > 1:
        lines = "\n".join(f"  {h[0]}  {h[3]} v {h[4]}  score {h[6]}  trades {h[7]}" for h in hits)
        sys.exit(f"{selector!r} matches {len(hits)} matches - pass the match_id:\n{lines}")
    return hits


def export_match(con, match, out_path: str) -> tuple[int, int]:
    (match_id, ticker, level, p1, p2, winner, score, n_trades, n_flagged, flag_rate, first, last) = match
    moments = con.execute(
        "select ts, ticker, price, count, backs_player, size_z, tilt, disagreement, side_inferred, "
        "score, sets_p1, sets_p2, games_p1, games_p2 from tennis_flow_anomaly_moment "
        "where match_id = ? order by ts",
        [match_id],
    ).fetchall()
    # Player 1's ticker is <match_id>-<code1>, code1 = the match id's tail [-6:-3].
    code1, code2 = match_id[-6:-3], match_id[-3:]
    p1_ticker, p2_ticker = f"{match_id}-{code1}", f"{match_id}-{code2}"
    unfolded = 0
    rows = []
    for m in moments:
        (ts, m_ticker, price, count, backs, size_z, tilt, disagreement, side_inferred, m_score, s1, s2, g1, g2) = m
        folded = None
        if price is not None:
            if m_ticker == p1_ticker:
                folded = price
            elif m_ticker == p2_ticker:
                folded = 100 - price
            else:
                folded = price
                unfolded += 1
        rows.append(
            {
                "ts": _iso(ts),
                "price": _num(folded),
                "price_raw": _num(price),
                "ticker": m_ticker,
                "count": _num(count),
                "size_z": _num(size_z),
                "backs_player": _num(backs),
                "side_inferred": side_inferred,
                "tilt": _num(tilt),
                "disagreement": _num(disagreement),
                "score": _num(m_score),
                "sets_p1": _num(s1),
                "sets_p2": _num(s2),
                "games_p1": _num(g1),
                "games_p2": _num(g2),
            }
        )
    payload = {
        "meta": {
            "coverage": COVERAGE,
            "source": "tennis_flow_anomaly_moment",
            "match_id": match_id,
            "ticker": ticker,
            "ticker_p1": p1_ticker,
            "ticker_p2": p2_ticker,
            "unfolded": unfolded,
            "level": level,
            "player1": p1,
            "player2": p2,
            "winner": _num(winner),
            "anomaly_score": _num(score),
            "n_trades": _num(n_trades),
            "n_flagged": _num(n_flagged),
            "flag_rate": _num(flag_rate),
            "price_of": p1,
            "first_trade": _iso(first),
            "last_trade": _iso(last),
            "exported_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "rows": rows,
    }
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    return len(rows), int(n_trades or 0)


def resolve_out(out: str, match_id: str) -> str:
    key = drill_path_key(match_id)
    if key is None:
        sys.exit(f"match_id {match_id!r} cannot name a file")
    is_dir = os.path.isdir(out) or out.endswith(("/", "\\")) or not out.lower().endswith(".json")
    return os.path.join(out, f"{key}.json") if is_dir else out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("selector", nargs="?", help="match_id or a player-name substring")
    ap.add_argument("out", nargs="?", help="output directory (file named by the match key) or a .json path")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--top", action="store_true", help="the top match by anomaly score with n_trades > --min-trades")
    ap.add_argument("--min-trades", type=int, default=500)
    ap.add_argument("--all", action="store_true", help="every match, one file each, into <out>")
    ap.add_argument("--path-key", nargs="+", metavar="KEY", help="print drillPathKey(KEY) per key as a JSON list and exit")
    args = ap.parse_args(argv)

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except Exception:
            pass

    if args.path_key is not None:
        print(json.dumps([drill_path_key(k) for k in args.path_key], ensure_ascii=False))
        return 0

    # With --top / --all the single positional is the out path.
    selector, out = args.selector, args.out
    if (args.top or args.all) and out is None:
        selector, out = None, selector
    if out is None:
        ap.error("an output directory or .json path is required")
    if args.all and out.lower().endswith(".json"):
        ap.error("--all needs an output DIRECTORY")

    import duckdb  # stdlib + duckdb: the one dependency

    if not os.path.exists(args.db):
        sys.exit(f"no database at {args.db}")
    con = duckdb.connect(args.db, read_only=True)
    matches = pick_matches(con, selector, args.top, args.all, args.min_trades)
    for match in matches:
        path = resolve_out(out, match[0])
        n_rows, n_trades = export_match(con, match, path)
        print(f"wrote {os.path.abspath(path)} ({n_rows} rows, {n_trades} trades)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
