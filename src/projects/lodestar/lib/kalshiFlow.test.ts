// Kalshi Trading / Flow - the derived numbers (SWIT-130).

import { describe, it, expect } from "vitest";
import type { NbaFlowGame, NbaFlowLine, NbaFlowSizeRow, NbaFlowTimelineRow } from "../api/client";
import {
  buildFlowSeries,
  defaultLine,
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
  parseIso,
  resultLabel,
  scoreLabel,
  selectionReducer,
  sideProfile,
  sizeMix,
  todayLocal,
  bigTotals,
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

  it("accumulates handle per side, carries a missing bucket forward, sorts rows", () => {
    const f = buildFlowSeries(
      [row(T2, "B", 10, 1, 55), row(T0, "A", 100, 4, 40), row(T1, "A", 50, 2, 42), row(T0, "B", 30, 3, 60)],
      ["A", "B"],
    );
    expect(f.xs).toEqual([Date.parse(T0) / 1000, Date.parse(T1) / 1000, Date.parse(T2) / 1000]);
    expect(f.handle.A).toEqual([100, 150, 150]);
    expect(f.handle.B).toEqual([30, 30, 40]);
    expect(f.price.A).toEqual([40, 42, 42]);
    expect(f.price.B).toEqual([60, 60, 55]);
    expect(f.totals.A).toEqual({ bets: 6, handle: 150 });
  });

  it("a side with no price yet is null, not zero", () => {
    const f = buildFlowSeries([row(T0, "A", 5, 1, 40), row(T1, "B", 5, 1, 50)], ["A", "B"]);
    expect(f.price.B).toEqual([null, 50]);
  });

  it("the tip gets an x of its own, after the last bucket or between buckets", () => {
    const after = buildFlowSeries([row(T0, "A", 1, 1, 1), row(T1, "A", 1, 1, 1)], ["A"], "2026-10-21T23:30:00Z");
    expect(after.xs.length).toBe(3);
    expect(after.isos[2]).toBe("2026-10-21T23:30:00.000Z");
    expect(after.handle.A).toEqual([1, 2, 2]);
    const between = buildFlowSeries([row(T0, "A", 1, 1, 1), row(T2, "A", 1, 1, 1)], ["A"], T1);
    expect(between.isos[1]).toBe("2026-10-21T20:15:00.000Z");
    // a tip already on a bucket adds nothing; no rows means no tip x either
    expect(buildFlowSeries([row(T0, "A", 1, 1, 1)], ["A"], T0).xs.length).toBe(1);
    expect(buildFlowSeries([], ["A"], T0).xs).toEqual([]);
  });

  it("unparseable stamps are dropped, and a zoneless stamp is UTC", () => {
    expect(buildFlowSeries([row("nope", "A", 1, 1, 1)], ["A"]).xs).toEqual([]);
    expect(parseIso("2026-10-21 20:00:00")).toBe(Date.parse(T0));
    expect(parseIso("2026-10-21T20:00:00+00:00")).toBe(Date.parse(T0));
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
