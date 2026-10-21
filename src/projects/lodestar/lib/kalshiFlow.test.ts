// Kalshi Trading / Flow - the derived numbers (SWIT-130).

import { describe, it, expect } from "vitest";
import type { NbaFlowGame, NbaFlowLine, NbaFlowSizeRow, NbaFlowTimelineRow } from "../api/client";
import {
  bigTotals,
  buildFlowSeries,
  defaultLine,
  detailMatches,
  fetchErrorText,
  gameCodeTeams,
  flowSummary,
  fmtBets,
  fmtCount,
  fmtGap,
  fmtMoney,
  fmtPct,
  fmtPriceMove,
  fmtTip,
  isHandleIncomplete,
  leanLabel,
  leanOutcome,
  leanOutcomeLabel,
  lineAriaLabel,
  orderSides,
  parseIso,
  priceSummary,
  resultLabel,
  rungText,
  scoreLabel,
  selectionReducer,
  sideProfile,
  sizeMix,
  slateIsSettled,
  slateMatches,
  spansMoreThanADay,
  stabilize,
  todayLocal,
} from "./kalshiFlow";

const side = (s: string, o: Partial<NbaFlowLine["sides"][number]> = {}): NbaFlowLine["sides"][number] => ({
  side: s, bets: 0, handle: 0, big_bets: 0, big_handle: 0, ticket_pct: 50, money_pct: 50, gap: 0,
  price_first: null, price_last: null, ...o,
});

const line = (o: Partial<NbaFlowLine> = {}): NbaFlowLine => ({
  rung: null, bets: 0, handle: 0, sides: [], lean: null, result: null, ...o,
});

const game = (o: Partial<NbaFlowGame> = {}): NbaFlowGame => ({
  game: "26OCT21MINMIA", away: "MIN", home: "MIA", tip_utc: "2026-10-21T23:30:00Z", status: "scheduled",
  away_score: null, home_score: null, price_zero_share: 0, lines: { ml: null, spread: null, total: null }, ...o,
});

describe("formatting", () => {
  it("money reads in dollars, k and M", () => {
    expect(fmtMoney(0)).toBe("$0");
    expect(fmtMoney(849.6)).toBe("$850");
    expect(fmtMoney(1000)).toBe("$1k");
    expect(fmtMoney(18_240)).toBe("$18.2k");
    expect(fmtMoney(1_250_000)).toBe("$1.3M");
    expect(fmtMoney(Number.NaN)).toBe("-");
  });
  it("counts, percentages and signed gaps", () => {
    expect(fmtCount(1203)).toBe("1,203");
    expect(fmtPct(63.6)).toBe("64%");
    expect(fmtGap(22.6)).toBe("+23");
    expect(fmtGap(-10.2)).toBe("-10");
    expect(fmtGap(0.2)).toBe("0");
  });
  it("a price move collapses when nothing moved or a leg is missing", () => {
    expect(fmtPriceMove(42, 47)).toBe("42c to 47c");
    expect(fmtPriceMove(47, 47.2)).toBe("47c");
    expect(fmtPriceMove(null, 47)).toBe("47c");
    expect(fmtPriceMove(null, null)).toBe("-");
  });
  it("tip time is shown in the zone asked for, and absence is said", () => {
    expect(fmtTip("2026-10-21T23:30:00Z", "UTC")).toBe("11:30 PM");
    expect(fmtTip("2026-10-21T23:30:00Z", "America/Los_Angeles")).toBe("4:30 PM");
    expect(fmtTip(null)).toBe("tip unknown");
    expect(fmtTip("garbage")).toBe("tip unknown");
  });
  it("today is the local calendar date", () => {
    expect(todayLocal(new Date(2026, 9, 5, 23, 59))).toBe("2026-10-05");
  });
  it("pluralises bets", () => {
    expect(fmtBets(1)).toBe("1 bet");
    expect(fmtBets(0)).toBe("0 bets");
    expect(fmtBets(1203)).toBe("1,203 bets");
  });
});

describe("outage", () => {
  it("warns above 0.2 only", () => {
    expect(isHandleIncomplete(0.2)).toBe(false);
    expect(isHandleIncomplete(0.21)).toBe(true);
    expect(isHandleIncomplete(0)).toBe(false);
    expect(isHandleIncomplete(null)).toBe(false);
    expect(isHandleIncomplete(undefined)).toBe(false);
  });
});

describe("lean and result", () => {
  it("the lean outcome needs both a lean and a settled result", () => {
    expect(leanOutcome(line({ lean: "MIA", result: "MIA" }))).toBe("won");
    expect(leanOutcome(line({ lean: "MIA", result: "MIN" }))).toBe("lost");
    expect(leanOutcome(line({ lean: "MIA", result: "push" }))).toBe("push");
    expect(leanOutcome(line({ lean: "MIA", result: null }))).toBeNull();
    expect(leanOutcome(line({ lean: null, result: "MIA" }))).toBeNull();
  });
  it("labels", () => {
    const l = line({ lean: "MIA -4.5", sides: [side("MIN +4.5", { gap: -23 }), side("MIA -4.5", { gap: 22.6 })] });
    expect(leanLabel(l)).toBe("lean MIA -4.5 +23");
    expect(leanLabel(line())).toBeNull();
    expect(leanLabel(line({ lean: "X" }))).toBe("lean X");
    expect(resultLabel(line({ result: "MIA -4.5" }))).toBe("won MIA -4.5");
    expect(resultLabel(line({ result: "push" }))).toBe("push");
    expect(resultLabel(line())).toBeNull();
    expect(leanOutcomeLabel("won")).toBe("lean won");
    expect(leanOutcomeLabel("lost")).toBe("lean lost");
    expect(leanOutcomeLabel("push")).toBe("lean pushed");
    expect(leanOutcomeLabel(null)).toBeNull();
  });
  it("score and big totals", () => {
    expect(scoreLabel(game({ away_score: 101, home_score: 98 }))).toBe("MIN 101 - MIA 98");
    expect(scoreLabel(game())).toBeNull();
    const l = line({ sides: [side("a", { big_bets: 2, big_handle: 3000 }), side("b", { big_bets: 1, big_handle: 1500 })] });
    expect(bigTotals(l)).toEqual({ bets: 3, handle: 4500 });
  });
});

describe("selection", () => {
  const g = game({ lines: { ml: null, spread: line(), total: line() } });
  it("a row opens the first line that exists; the same row again closes", () => {
    expect(defaultLine(g)).toBe("spread");
    expect(defaultLine(game())).toBe("ml");
    const open = selectionReducer(null, { type: "row", game: g });
    expect(open).toEqual({ game: g.game, line: "spread", rung: null });
    expect(selectionReducer(open, { type: "row", game: g })).toBeNull();
    expect(selectionReducer(open, { type: "row", game: game({ game: "other" }) })?.game).toBe("other");
  });
  it("a line cell always opens that line, and changing the line drops the rung", () => {
    const open = selectionReducer(null, { type: "line", game: g, line: "total" });
    expect(open?.line).toBe("total");
    const withRung = selectionReducer(open, { type: "rung", rung: "243.5" });
    expect(withRung?.rung).toBe("243.5");
    expect(selectionReducer(withRung, { type: "setLine", line: "spread" })).toEqual({ game: g.game, line: "spread", rung: null });
    expect(selectionReducer(withRung, { type: "close" })).toBeNull();
    expect(selectionReducer(null, { type: "rung", rung: "x" })).toBeNull();
  });
});

describe("buildFlowSeries", () => {
  const row = (t: string, s: string, handle: number, bets: number, price: number | null): NbaFlowTimelineRow => ({
    t, side: s, handle, bets, big_bets: 0, big_handle: 0, price,
  });
  const T0 = "2026-10-21T20:00:00Z";
  const T1 = "2026-10-21T20:15:00Z";
  const T2 = "2026-10-21T20:30:00Z";
  const T3 = "2026-10-21T20:45:00Z";
  const sec = (iso: string) => Date.parse(iso) / 1000;
  /** The side's cumulative at the point whose x is exactly `iso`. */
  const at = (f: ReturnType<typeof buildFlowSeries>, s: string, iso: string) => {
    const i = f.xs.indexOf(sec(iso));
    expect(i).toBeGreaterThanOrEqual(0);
    return f.handle[s][i];
  };

  it("plots each bucket's total at its END, with a zero anchor at the first start", () => {
    // rows are stamped at the bucket START and hold [t, t + 15 min)
    const f = buildFlowSeries([row(T1, "A", 50, 2, 42), row(T0, "A", 100, 4, 40), row(T0, "B", 30, 3, 60)], ["A", "B"]);
    expect(f.xs).toEqual([sec(T0), sec(T1), sec(T2)]);
    expect(f.handle.A).toEqual([0, 100, 150]);
    expect(f.handle.B).toEqual([0, 30, 30]);
    expect(f.totals.A).toEqual({ bets: 6, handle: 150 });
  });

  it("carries the price forward from the bucket end; null before a side's first price", () => {
    const f = buildFlowSeries([row(T0, "A", 5, 1, 40), row(T1, "B", 5, 1, 50), row(T2, "A", 5, 1, 45)], ["A", "B"]);
    expect(f.xs).toEqual([sec(T0), sec(T1), sec(T2), sec(T3)]);
    expect(f.price.A).toEqual([null, 40, 40, 45]);
    expect(f.price.B).toEqual([null, null, 50, 50]);
  });

  it("a missing bucket holds the total flat until the next bucket opens", () => {
    const f = buildFlowSeries([row(T0, "A", 100, 4, 40), row(T2, "A", 10, 1, 41)], ["A"]);
    // anchor T0, end of T0's bucket (T1), hold until T2 opens, end of T2's bucket (T3)
    expect(f.xs).toEqual([sec(T0), sec(T1), sec(T2), sec(T3)]);
    expect(f.handle.A).toEqual([0, 100, 100, 110]);
  });

  describe("the tip marker", () => {
    const rows = [row(T0, "A", 100, 4, 40), row(T1, "A", 50, 2, 42), row(T2, "A", 25, 1, 43)];

    it("on a bucket boundary: no extra x, and the total at the tip is exactly what was in before it", () => {
      const f = buildFlowSeries(rows, ["A"], T1);
      expect(f.xs).toEqual([sec(T0), sec(T1), sec(T2), sec(T3)]); // the tip is already an x
      expect(at(f, "A", T1)).toBe(100); // only the [T0, T1) bucket was in
      expect(at(f, "A", T2)).toBe(150);
    });

    it("mid-bucket: the tip sits between the last pre-tip point and the first post-tip point", () => {
      const tip = "2026-10-21T20:20:00Z"; // inside [T1, T2)
      const f = buildFlowSeries(rows, ["A"], tip);
      const i = f.xs.indexOf(sec(tip));
      expect(i).toBeGreaterThan(0);
      expect(f.xs[i - 1]).toBe(sec(T1));
      expect(f.xs[i + 1]).toBe(sec(T2));
      expect(f.handle.A[i]).toBe(100); // the pre-tip total, not part of the straddling bucket
      expect(f.handle.A[i + 1]).toBe(150); // the straddling bucket lands after the marker
      expect(f.price.A[i]).toBe(40);
      // the series stays ascending in x and non-decreasing in handle
      expect([...f.xs].sort((p, q) => p - q)).toEqual(f.xs);
      expect([...f.handle.A].sort((p, q) => p - q)).toEqual(f.handle.A);
    });

    it("after the last bucket: appended with the full total", () => {
      const f = buildFlowSeries(rows.slice(0, 2), ["A"], "2026-10-21T23:30:00Z");
      expect(f.isos[f.isos.length - 1]).toBe("2026-10-21T23:30:00.000Z");
      expect(f.handle.A[f.handle.A.length - 1]).toBe(150);
    });

    it("before the first bucket (all in-play): zero at the tip", () => {
      const f = buildFlowSeries(rows, ["A"], "2026-10-21T19:00:00Z");
      expect(f.xs[0]).toBe(sec("2026-10-21T19:00:00Z"));
      expect(f.handle.A[0]).toBe(0);
    });

    it("no rows means no points, tip or not", () => {
      expect(buildFlowSeries([], ["A"], T0).xs).toEqual([]);
    });
  });

  it("honours a different bucket width", () => {
    const f = buildFlowSeries([row(T0, "A", 10, 1, 40)], ["A"], null, 5);
    expect(f.xs).toEqual([sec(T0), sec("2026-10-21T20:05:00Z")]);
  });

  it("unparseable stamps are dropped, and a zoneless stamp is UTC", () => {
    expect(buildFlowSeries([row("nope", "A", 1, 1, 1)], ["A"]).xs).toEqual([]);
    expect(parseIso("2026-10-21 20:00:00")).toBe(Date.parse(T0));
    expect(parseIso("2026-10-21T20:00:00+00:00")).toBe(Date.parse(T0));
  });

  it("a span over 24 h is not an intraday axis", () => {
    expect(spansMoreThanADay([0, 3600])).toBe(false);
    expect(spansMoreThanADay([0, 86_400])).toBe(false);
    expect(spansMoreThanADay([0, 86_401])).toBe(true);
    expect(spansMoreThanADay([5])).toBe(false);
  });
});

describe("chart summaries", () => {
  it("states each side's share of bets and money, and where the money leans", () => {
    const totals = { MIN: { bets: 300, handle: 4000 }, MIA: { bets: 100, handle: 14000 } };
    expect(flowSummary(totals, ["MIN", "MIA"])).toBe(
      "MIN 75% of bets, 22% of money; MIA 25% of bets, 78% of money; money leans MIA",
    );
    const even = { A: { bets: 50, handle: 500 }, B: { bets: 50, handle: 500 } };
    expect(flowSummary(even, ["A", "B"])).toContain("no side leans by 10+ points");
    expect(flowSummary({ A: { bets: 0, handle: 0 } }, ["A"])).toBe("no bets in this window");
  });
  it("states each side's first and last price", () => {
    expect(priceSummary({ A: [null, 44, 44, 41], B: [null, null, null, null] }, ["A", "B"])).toBe("A 44c to 41c; B no price yet");
  });
});

describe("side order", () => {
  it("away first for ml and spread, Over first for a total, whatever order the backend used", () => {
    const g = { away: "MIN" };
    expect(orderSides(["MIA", "MIN"], "ml", g)).toEqual(["MIN", "MIA"]);
    expect(orderSides(["MIA -4.5", "MIN +4.5"], "spread", g)).toEqual(["MIN +4.5", "MIA -4.5"]);
    expect(orderSides(["Under 243.5", "Over 243.5"], "total", g)).toEqual(["Over 243.5", "Under 243.5"]);
    expect(orderSides(["b", "a"], "ml", undefined)).toEqual(["b", "a"]);
  });
});

describe("wording", () => {
  it("shows the readable rung when there is one and the code otherwise", () => {
    expect(rungText({ rung: "MIA5", rung_label: "MIA -4.5" })).toBe("MIA -4.5");
    expect(rungText({ rung: "MIA5", label: "MIA -4.5" })).toBe("MIA -4.5");
    expect(rungText({ rung: "MIA5" })).toBe("MIA5");
    expect(rungText({ rung: null })).toBe("");
  });
  it("tells an HTTP failure from an unreachable backend", () => {
    expect(fetchErrorText("Error: GET /nba/flow/games?date=x -> 404 Not Found")).toBe("endpoint returned 404 Not Found");
    expect(fetchErrorText("Error: GET /p -> 500 Server Error · db down")).toBe("endpoint returned 500 Server Error - db down");
    expect(fetchErrorText("TypeError: Failed to fetch")).toBe("backend unreachable - TypeError: Failed to fetch");
  });
  it("gives a line cell a sentence a screen reader can use", () => {
    const l = line({
      rung: "MIA5", rung_label: "MIA -4.5", bets: 412, handle: 18_240, lean: "MIA -4.5", result: "MIA -4.5",
      sides: [
        side("MIN +4.5", { ticket_pct: 73, money_pct: 22 }),
        side("MIA -4.5", { ticket_pct: 27, money_pct: 78 }),
      ],
    });
    const t = lineAriaLabel("spread", l);
    expect(t).toContain("Spread MIA -4.5");
    expect(t).not.toContain("MIA5");
    expect(t).toContain("MIN +4.5: 73% of bets, 22% of money");
    expect(t).toContain("MIA -4.5: 27% of bets, 78% of money");
    expect(t).toContain("412 bets, $18.2k handle");
    expect(t).toContain("money leans MIA -4.5");
    expect(t).toContain("lean won");
  });
});

describe("stale-response guards", () => {
  it("the slate must answer the date and phase on screen", () => {
    const slate = { date: "2026-10-21", phase: "pregame" };
    expect(slateMatches(slate, "2026-10-21", "pregame")).toBe(true);
    expect(slateMatches(slate, "2026-10-22", "pregame")).toBe(false);
    expect(slateMatches(slate, "2026-10-21", "all")).toBe(false);
    expect(slateMatches(null, "2026-10-21", "all")).toBe(false);
  });
  it("the detail must answer the game and the line; the rung is not compared (the backend may substitute its main one)", () => {
    const d = { game: "G", line: "spread", rung: "MIA5" };
    expect(detailMatches({ game: "G", line: "spread" }, d)).toBe(true);
    expect(detailMatches({ game: "G", line: "total" }, d)).toBe(false);
    expect(detailMatches({ game: "H", line: "spread" }, d)).toBe(false);
    expect(detailMatches({ game: "G", line: "spread" }, null)).toBe(false);
  });
  it("the team codes come out of the game code", () => {
    expect(gameCodeTeams("26OCT21MINMIA")).toEqual({ away: "MIN", home: "MIA" });
    expect(gameCodeTeams("nonsense")).toBeNull();
  });
  it("identical data keeps the same object, changed data does not", () => {
    const first = stabilize(null, { a: 1 });
    expect(stabilize(first, { a: 1 })).toBe(first);
    const next = stabilize(first, { a: 2 });
    expect(next).not.toBe(first);
    expect(next.value).toEqual({ a: 2 });
  });
  it("a past slate stops polling only when every game is final", () => {
    const g = (status: "final" | "live") => ({ status });
    expect(slateIsSettled({ date: "2026-10-20", games: [g("final"), g("final")] }, "2026-10-21")).toBe(true);
    expect(slateIsSettled({ date: "2026-10-20", games: [g("final"), g("live")] }, "2026-10-21")).toBe(false);
    expect(slateIsSettled({ date: "2026-10-21", games: [g("final")] }, "2026-10-21")).toBe(false);
    expect(slateIsSettled({ date: "2026-10-20", games: [] }, "2026-10-21")).toBe(false);
    expect(slateIsSettled(null, "2026-10-21")).toBe(false);
  });
});

describe("size mix", () => {
  const sizes: NbaFlowSizeRow[] = [
    { bucket: "<$10", side: "A", bets: 90, handle: 400 },
    { bucket: "$1k-10k", side: "A", bets: 2, handle: 4000 },
    { bucket: "$10k+", side: "B", bets: 1, handle: 12_000 },
    { bucket: "$10-100", side: "B", bets: 10, handle: 300 },
  ];
  it("every bucket for every side, in size order, zero-filled, with the average bet", () => {
    const rows = sizeMix(sizes, ["A", "B"]);
    expect(rows.length).toBe(10);
    expect(rows.map((r) => r.bucket).filter((_, i) => i % 2 === 0)).toEqual(["<$10", "$10-100", "$100-1k", "$1k-10k", "$10k+"]);
    expect(rows[0]).toEqual({ bucket: "<$10", side: "A", bets: 90, handle: 400, avg: 400 / 90 });
    expect(rows[1]).toMatchObject({ bucket: "<$10", side: "B", bets: 0, handle: 0, avg: 0 });
  });
  it("profiles each side by average bet and the share of handle in $1k+ bets", () => {
    const [a, b] = sideProfile(sizes, ["A", "B"]);
    expect(a.bets).toBe(92);
    expect(a.handle).toBe(4400);
    expect(a.bigShare).toBeCloseTo((4000 / 4400) * 100);
    expect(b.avg).toBeCloseTo(12_300 / 11);
    expect(sideProfile([], ["A"])[0]).toMatchObject({ bets: 0, avg: 0, bigShare: 0 });
  });
});
