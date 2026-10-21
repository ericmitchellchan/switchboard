// Kalshi Trading / Flow - the series behind the detail chart (SWIT-130).

import { describe, it, expect } from "vitest";
import type { NbaFlowBookSeries, NbaFlowTimelineRow } from "../api/client";
import {
  MIN_BETS_TO_PLOT,
  bookPoints,
  bookWindow,
  buildSharePoints,
  chartWindow,
  gapAxisMax,
  pointsIn,
  ticksNeedDay,
  timeTicks,
} from "./kalshiFlowSeries";

const MIN = 60_000;
const H = 3_600_000;
const TIP = Date.parse("2026-10-21T23:30:00Z");

const row = (t: string, s: string, bets: number, handle: number, o: Partial<NbaFlowTimelineRow> = {}): NbaFlowTimelineRow => ({
  t, side: s, bets, handle, big_bets: 0, big_handle: 0, price: null, ...o,
});

// 18 bets by 20:30, 22 once the 20:30 bucket is in, then three more buckets
const timeline: NbaFlowTimelineRow[] = [
  row("2026-10-21T20:00:00Z", "A", 10, 100, { price: 44 }),
  row("2026-10-21T20:15:00Z", "A", 3, 30, { price: 45 }),
  row("2026-10-21T20:15:00Z", "B", 5, 50, { price: 56 }),
  row("2026-10-21T20:30:00Z", "A", 4, 400, { price: 46 }),
  row("2026-10-21T23:15:00Z", "B", 6, 600, { big_bets: 1, big_handle: 500 }),
  row("2026-10-21T23:30:00Z", "A", 8, 800, { price: 48 }), // opens at the tip: in game
  row("2026-10-21T23:45:00Z", "B", 4, 400),
];

describe("buildSharePoints", () => {
  const pre = buildSharePoints(timeline, "A", "B", { tipMs: TIP, includeLive: false });
  const all = buildSharePoints(timeline, "A", "B", { tipMs: TIP, includeLive: true });

  it("hides the first stretch until the line has 20 bets", () => {
    expect(MIN_BETS_TO_PLOT).toBe(20);
    // 10 + 8 = 18 after the 20:15 bucket (no point), 22 after 20:30
    expect(pre[0].t).toBe(Date.parse("2026-10-21T20:45:00Z"));
    expect(pre[0].na + pre[0].nb).toBe(22);
    expect(buildSharePoints(timeline, "A", "B", { tipMs: TIP, includeLive: false, minBets: 1 })[0].t).toBe(
      Date.parse("2026-10-21T20:15:00Z"),
    );
  });
  it("a line that never reaches the minimum draws nothing", () => {
    expect(buildSharePoints(timeline.slice(0, 3), "A", "B", { tipMs: TIP, includeLive: true })).toEqual([]);
    expect(buildSharePoints([], "A", "B", { tipMs: TIP, includeLive: true })).toEqual([]);
  });
  it("is cumulative from the first bucket, plotted at each bucket's END", () => {
    expect(pre.map((p) => p.t)).toEqual([
      Date.parse("2026-10-21T20:45:00Z"),
      Date.parse("2026-10-21T23:30:00Z"), // the 23:15 bucket ends at the tip
    ]);
    const first = pre[0];
    expect([first.ha, first.hb, first.na, first.nb]).toEqual([530, 50, 17, 5]);
    expect(first.mA).toBeCloseTo((530 / 580) * 100);
    expect(first.bA).toBeCloseTo((17 / 22) * 100);
    expect(first.gap).toBeCloseTo(first.mA - first.bA);
    const last = pre[1];
    expect([last.ha, last.hb, last.na, last.nb]).toEqual([530, 650, 17, 11]);
  });
  it("a before-tip view stops at the tip; the whole game carries on", () => {
    expect(pre.every((p) => p.t <= TIP)).toBe(true);
    expect(all.map((p) => p.t).slice(-2)).toEqual([Date.parse("2026-10-21T23:45:00Z"), Date.parse("2026-10-22T00:00:00Z")]);
    expect(all[all.length - 1]).toMatchObject({ ha: 1330, hb: 1050, na: 25, nb: 15 });
  });
  it("a bucket the tip falls inside is clamped to the tip in a before-tip view", () => {
    const tl = [row("2026-10-21T23:20:00Z", "A", 30, 300), row("2026-10-21T23:20:00Z", "B", 10, 100)];
    const p = buildSharePoints(tl, "A", "B", { tipMs: TIP, includeLive: false });
    expect(p).toHaveLength(1);
    expect(p[0].t).toBe(TIP);
    expect(buildSharePoints(tl, "A", "B", { tipMs: TIP, includeLive: true })[0].t).toBe(Date.parse("2026-10-21T23:35:00Z"));
  });
  it("the same gap with every $1k+ bet out of both sides", () => {
    // by the tip: A has no big bets, B has one ($500 of its $650)
    const last = pre[1];
    const exA = 530;
    const exB = 150;
    const exNa = 17;
    const exNb = 10;
    expect(last.exGap).toBeCloseTo((exA / (exA + exB)) * 100 - (exNa / (exNa + exNb)) * 100);
    // the first point has no big bets: the two gaps agree
    expect(pre[0].exGap).toBeCloseTo(pre[0].gap);
  });
  it("a side with nothing yet is 50/50, and the gap without big bets is null when nothing is left", () => {
    const only = buildSharePoints([row("2026-10-21T20:00:00Z", "A", 25, 100, { big_bets: 25, big_handle: 100 })], "A", "B", {
      tipMs: TIP, includeLive: true,
    });
    expect(only[0].exGap).toBeNull();
    const zeroMoney = buildSharePoints([row("2026-10-21T20:00:00Z", "A", 25, 0)], "A", "B", { tipMs: TIP, includeLive: true });
    expect(zeroMoney[0].mA).toBe(50);
  });
  it("carries side A's last price forward, null before its first", () => {
    expect(pre[0].px).toBe(46);
    expect(pre[1].px).toBe(46); // nothing new before the tip
    expect(all[all.length - 1].px).toBe(48);
    const noPrice = buildSharePoints([row("2026-10-21T20:00:00Z", "A", 25, 10)], "A", "B", { tipMs: TIP, includeLive: true });
    expect(noPrice[0].px).toBeNull();
  });
  it("a zoneless stamp is UTC and an unparseable one is dropped", () => {
    const tl = [row("2026-10-21T20:00:00", "A", 25, 10), row("garbage", "A", 99, 99)];
    const p = buildSharePoints(tl, "A", "B", { tipMs: TIP, includeLive: true });
    expect(p).toHaveLength(1);
    expect(p[0].t).toBe(Date.parse("2026-10-21T20:15:00Z"));
    expect(p[0].na).toBe(25);
  });
  it("honours another bucket width", () => {
    const p = buildSharePoints([row("2026-10-21T20:00:00Z", "A", 25, 10)], "A", "B", { tipMs: TIP, includeLive: true, bucketMin: 60 });
    expect(p[0].t).toBe(Date.parse("2026-10-21T21:00:00Z"));
  });
});

describe("the window", () => {
  const pts = buildSharePoints(timeline, "A", "B", { tipMs: TIP, includeLive: true });
  it("opens at the first plotted bucket and closes at the tip", () => {
    const w = chartWindow(pts, "pre", TIP)!;
    expect(w.t0).toBe(Date.parse("2026-10-21T20:30:00Z"));
    expect(w.t1).toBe(TIP);
  });
  it("the whole game closes at the last bucket", () => {
    expect(chartWindow(pts, "all", TIP)!.t1).toBe(pts[pts.length - 1].t);
  });
  it("the last 6h opens six hours before the tip, never before the data", () => {
    const early = [{ ...pts[0], t: TIP - 20 * H }, ...pts.slice(1)];
    expect(chartWindow(early, "6h", TIP)!.t0).toBe(TIP - 6 * H);
    expect(chartWindow(pts, "6h", TIP)!.t0).toBe(Date.parse("2026-10-21T20:30:00Z"));
  });
  it("no points, no window; a tiny span is widened to one bucket; no tip closes at the last point", () => {
    expect(chartWindow([], "pre", TIP)).toBeNull();
    const one = chartWindow([pts[0]], "all", TIP)!;
    expect(one.t1 - one.t0).toBeGreaterThanOrEqual(15 * MIN);
    expect(chartWindow(pts, "pre", NaN)!.t1).toBe(pts[pts.length - 1].t);
  });
  it("keeps the points in view", () => {
    const w = chartWindow(pts, "pre", TIP)!;
    expect(pointsIn(pts, w).every((p) => p.t >= w.t0 && p.t <= w.t1)).toBe(true);
    expect(pointsIn(pts, w).length).toBeLessThan(pts.length);
  });
});

describe("axes", () => {
  it("ticks every 12h, 3h, 1h or 30 min by the span, on the clock", () => {
    const t0 = Date.parse("2026-10-21T00:00:00Z");
    expect(timeTicks(t0, t0 + 48 * H)[1] - timeTicks(t0, t0 + 48 * H)[0]).toBe(12 * H);
    expect(timeTicks(t0, t0 + 20 * H)[1] - timeTicks(t0, t0 + 20 * H)[0]).toBe(3 * H);
    expect(timeTicks(t0, t0 + 6 * H)[1] - timeTicks(t0, t0 + 6 * H)[0]).toBe(H);
    expect(timeTicks(t0, t0 + 2 * H)[1] - timeTicks(t0, t0 + 2 * H)[0]).toBe(30 * MIN);
    expect(timeTicks(t0 + 7 * MIN, t0 + 2 * H)[0]).toBe(t0 + 30 * MIN);
  });
  it("labels need a weekday only when the window spans most of a day", () => {
    expect(ticksNeedDay(0, 21 * H)).toBe(true);
    expect(ticksNeedDay(0, 6 * H)).toBe(false);
  });
  it("the gap strip reaches past the widest-fifth line, and past the biggest gap drawn, in tens", () => {
    expect(gapAxisMax(28, [3, -5])).toBe(38);
    expect(gapAxisMax(28, [3, -61])).toBe(70);
    expect(gapAxisMax(20, [])).toBe(30);
  });
});

describe("DraftKings snapshots", () => {
  const series: NbaFlowBookSeries = {
    game: "26OCT21MINMIA", line: "ml", book: "draftkings",
    series: [
      { t: "2026-10-21T17:00:00+00:00", sides: [{ side: "MIA", handle_pct: 29, bets_pct: 35 }, { side: "MIN", handle_pct: 71, bets_pct: 65 }] },
      { t: "2026-10-21T16:00:00+00:00", sides: [{ side: "MIA", handle_pct: 30, bets_pct: 36 }, { side: "MIN", handle_pct: 70, bets_pct: 64 }] },
      { t: "2026-10-21T18:00:00+00:00", sides: [{ side: "MIA", handle_pct: null, bets_pct: 36 }, { side: "MIN", handle_pct: null, bets_pct: 64 }] },
      { t: "2026-10-21T19:00:00+00:00", sides: [{ side: "XXX", handle_pct: 50, bets_pct: 50 }] },
    ],
  };
  it("the left side's money and bet share, oldest first; an incomplete snapshot is skipped", () => {
    const p = bookPoints(series, "ml", "MIN");
    expect(p).toEqual([
      { t: Date.parse("2026-10-21T16:00:00Z"), money: 70, bets: 64 },
      { t: Date.parse("2026-10-21T17:00:00Z"), money: 71, bets: 65 },
    ]);
    expect(bookPoints(null, "ml", "MIN")).toEqual([]);
    expect(bookPoints(series, "total", "Over 1")).toEqual([]);
  });
  it("a window for a line only DraftKings has: first snapshot to the tip", () => {
    const p = bookPoints(series, "ml", "MIN");
    expect(bookWindow(p, TIP)).toEqual({ t0: p[0].t - 15 * MIN, t1: TIP });
    expect(bookWindow(p, Date.parse("2026-10-21T16:30:00Z"))!.t1).toBe(p[1].t + 15 * MIN);
    expect(bookWindow([], TIP)).toBeNull();
  });
});
