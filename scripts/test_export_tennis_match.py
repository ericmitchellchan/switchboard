#!/usr/bin/env python3
"""Unit tests for the PURE helpers of scripts/export-tennis-match.py (no DB needed).

    python scripts/test_export_tennis_match.py

Run by src/lib/viewStore.test.ts beside the JS<->Python drillPathKey parity check
(skipped there only when python itself is missing). The DB-backed `--full` export
is not tested here — it is smoke-tested by hand against the Shot Clock container.
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("export_tennis_match", os.path.join(HERE, "export-tennis-match.py"))
X = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(X)  # type: ignore[union-attr]

MID = "KXATPCHALLENGERMATCH-26MAR02HEIGAL"
P1, P2 = f"{MID}-HEI", f"{MID}-GAL"


class TradeStance(unittest.TestCase):
    """The port of Lodestar tennis_anomaly.py:79-84 — all four cells + the unknowns."""

    def test_four_cells(self):
        self.assertEqual(X.trade_stance(1, "yes"), 1)  # buy YES on p1's market backs p1
        self.assertEqual(X.trade_stance(1, "no"), 2)  # buy NO on p1's market backs p2
        self.assertEqual(X.trade_stance(2, "yes"), 2)
        self.assertEqual(X.trade_stance(2, "no"), 1)

    def test_case_and_unknown(self):
        self.assertEqual(X.trade_stance(1, "YES"), 1)
        self.assertEqual(X.trade_stance(2, "NO"), 1)
        self.assertIsNone(X.trade_stance(1, None))
        self.assertIsNone(X.trade_stance(1, ""))
        self.assertIsNone(X.trade_stance(1, "maker"))

    def test_ticker_side(self):
        self.assertEqual(X.player_tickers(MID), (P1, P2))
        self.assertEqual(X.ticker_side_player(P1, P1, P2), 1)
        self.assertEqual(X.ticker_side_player(P2, P1, P2), 2)
        self.assertIsNone(X.ticker_side_player(f"{MID}-XXX", P1, P2))


class SizeZ(unittest.TestCase):
    """The port of tennis_anomaly.py:95-106."""

    def test_too_few_is_zeros(self):
        self.assertEqual(X.size_zscores([1, 2, 3]), [0.0, 0.0, 0.0])
        self.assertEqual(X.size_zscores([]), [])

    def test_flat_is_zeros(self):
        self.assertEqual(X.size_zscores([5] * 10), [0.0] * 10)

    def test_log_scale_z(self):
        counts = [1, 2, 3, 4, 5, 6, 7, 5000]
        zs = X.size_zscores(counts)
        self.assertEqual(len(zs), 8)
        self.assertAlmostEqual(sum(zs), 0.0, places=9)  # z-scores centre on the mean
        self.assertEqual(max(zs), zs[-1])  # the whale is the max
        self.assertGreater(zs[-1], 2.0)
        self.assertLess(zs[-1], 3.0)  # log scale: 5000 vs single digits is ~2.4, not 2.6+ (linear)


class FoldPrice(unittest.TestCase):
    def test_fold(self):
        self.assertEqual(X.fold_price(P1, 46, P1, P2), (46, False))
        self.assertEqual(X.fold_price(P2, 44, P1, P2), (56, False))
        self.assertEqual(X.fold_price(f"{MID}-XXX", 44, P1, P2), (44, True))
        self.assertEqual(X.fold_price(P2, None, P1, P2), (None, False))


class Iso(unittest.TestCase):
    def test_naive_is_utc_and_ms(self):
        self.assertEqual(X._iso(dt.datetime(2026, 3, 2, 9, 5, 13, 524241)), "2026-03-02T09:05:13.524")

    def test_aware_is_converted_to_utc_and_printed_naive(self):
        pst = dt.timezone(dt.timedelta(hours=-8))
        self.assertEqual(X._iso(dt.datetime(2026, 3, 1, 19, 56, 42, 641277, tzinfo=pst)), "2026-03-02T03:56:42.641")
        self.assertEqual(X._iso(dt.datetime(2026, 3, 2, 3, 56, 42, 641277, tzinfo=dt.timezone.utc)), "2026-03-02T03:56:42.641")

    def test_none_and_other(self):
        self.assertIsNone(X._iso(None))
        self.assertEqual(X._iso("x"), "x")


class ShapeFullRows(unittest.TestCase):
    """The whole full-tape row shaping over fake tuples in the query's column order."""

    def tape(self):
        t0 = dt.datetime(2026, 3, 2, 8, 0, 0, 0, tzinfo=dt.timezone.utc)
        rows = []
        # two pre-match trades with no state, on both tickers
        rows.append((t0, P1, 46, 10, "no", False, None, None, None, None))
        rows.append((t0 + dt.timedelta(seconds=1), P2, 44, 25, "yes", False, None, None, None, None))
        # in-match: 8 sized trades on P2 (enough for a baseline), one unsized, one unknown taker
        for i in range(8):
            rows.append((t0 + dt.timedelta(minutes=i + 1), P2, 40 + i, 10 * (i + 1), "yes" if i % 2 else "no", False, 0, 0, i, 1))
        rows.append((t0 + dt.timedelta(minutes=20), P1, 60, 0, "yes", False, 1, 0, 0, 0))
        rows.append((t0 + dt.timedelta(minutes=21), P1, 61, 7, None, False, 1, 0, 1, 0))
        # a fill across two levels: two trades at ONE stamp (the reader keys on the ms)
        rows.append((t0 + dt.timedelta(minutes=22), P2, 30, 9, "yes", False, 1, 0, 1, 0))
        rows.append((t0 + dt.timedelta(minutes=22, microseconds=400), P2, 31, 9, "yes", False, 1, 0, 1, 0))
        return rows

    def test_rows_and_stats(self):
        rows, stats = X.shape_full_rows(self.tape(), MID)
        self.assertEqual(len(rows), 14)
        self.assertEqual(stats, {"unfolded": 0, "n_unsized": 1, "n_no_state": 2, "n_no_stance": 1, "n_same_ms": 1})
        self.assertEqual(rows[12]["ts"], rows[13]["ts"])
        # pre-match: state null, stance from the taker side
        self.assertEqual(rows[0]["ts"], "2026-03-02T08:00:00.000")
        self.assertIsNone(rows[0]["sets_p1"])
        self.assertEqual(rows[0]["backs_player"], 2)  # NO on p1's market backs p2
        self.assertEqual(rows[1]["backs_player"], 2)  # YES on p2's market backs p2
        self.assertEqual(rows[1]["price"], 56)  # folded to p1's yes-price
        self.assertEqual(rows[1]["price_raw"], 44)
        # size_z: P2 has 9 sized trades → a real baseline; P1 has 2 → zeros
        p2z = [r["size_z"] for r in rows if r["ticker"] == P2]
        self.assertTrue(all(z is not None for z in p2z))
        self.assertNotEqual(max(p2z), 0.0)
        self.assertEqual(rows[0]["size_z"], 0.0)
        # unsized trade: size_z null, count kept
        self.assertIsNone(rows[10]["size_z"])
        self.assertEqual(rows[10]["count"], 0)
        # unknown taker side: no stance
        self.assertIsNone(rows[11]["backs_player"])
        self.assertEqual(rows[11]["games_p1"], 1)
        # the game state rides through
        self.assertEqual(rows[5]["games_p1"], 3)
        self.assertEqual(rows[5]["games_p2"], 1)

    def test_column_set(self):
        rows, _ = X.shape_full_rows(self.tape(), MID)
        self.assertEqual(
            set(rows[0]),
            {"ts", "price", "price_raw", "ticker", "count", "size_z", "backs_player", "taker_side", "side_inferred",
             "sets_p1", "sets_p2", "games_p1", "games_p2"},
        )


class FailureLine(unittest.TestCase):
    def test_label_drops_credentials(self):
        self.assertEqual(X.pg_label("postgresql://shotclock:shotclock@localhost:5433/shotclock"), "localhost:5433/shotclock")
        self.assertEqual(X.pg_label("postgresql://host:5432"), "host:5432")
        self.assertEqual(X.pg_label("garbage"), "<db>")

    def test_one_line_names_the_container_and_command(self):
        # duckdb's own message echoes the URL with its credentials — scrubbed too.
        line = X.unreachable_line(
            X.DEFAULT_PG_URL,
            RuntimeError('IO Error: Unable to connect to Postgres at "postgresql://shotclock:shotclock@localhost:5433/shotclock": refused\nsecond line'),
        )
        self.assertNotIn("\n", line)
        self.assertNotIn("shotclock:shotclock", line)
        self.assertIn('"postgresql://localhost:5433/shotclock"', line)
        self.assertIn("localhost:5433/shotclock", line)
        self.assertIn("IO Error: Unable to connect", line)
        self.assertNotIn("second line", line)
        self.assertIn("docker start lode_shotclock_db", line)
        self.assertEqual(X.DB_UNREACHABLE_EXIT, 2)


class PathKey(unittest.TestCase):
    def test_smoke(self):
        self.assertEqual(X.drill_path_key(MID), MID)
        self.assertEqual(X.drill_path_key("a b/c"), "a_b_c")
        self.assertIsNone(X.drill_path_key(".."))


if __name__ == "__main__":
    unittest.main(verbosity=1)
