// The Portfolio view's pure helpers (SWIT-139): Eastern days, scales and ticks,
// the two series, the hover readout, the daily bars, the figures and the
// by-strategy rows.

import { describe, expect, it } from "vitest";
import type { ComboPortfolio } from "../api/client";
import {
  buildSeries,
  dailyBars,
  dayLabel,
  dayTicks,
  etDay,
  etDayStartMs,
  fmtEtMs,
  fmtRate,
  isTagged,
  labelIndexes,
  nearestSnap,
  niceAxis,
  portfolioFigures,
  readoutAt,
  scaleLinear,
  snapTimes,
  strategyFold,
  strategyRows,
  valueAt,
} from "./comboPortfolio";

const PORTFOLIO: ComboPortfolio = {
  env: "demo",
  balance_series: [
    { ts: "2026-10-20T14:00:00Z", cash: 500, portfolio_value: 0 },
    { ts: "2026-10-21T14:00:00Z", cash: 480, portfolio_value: 36 },
    { ts: "2026-10-22T14:00:00Z", cash: 530, portfolio_value: 20 },
  ],
  pnl_by_day: [
    { day: "2026-10-21", realized: -12, cumulative: -12, n_settled: 2, wins: 0, losses: 2 },
    { day: "2026-10-22", realized: 42, cumulative: 30, n_settled: 3, wins: 2, losses: 1 },
  ],
  open_cost_by_day: [{ day: "2026-10-22", cost: 20 }],
  by_strategy: [{ tag: "lock-fade", n: 5, wins: 2, losses: 3, pnl: 30 }],
  figures: { balance: 530, realized_to_date: 30, open_cost: 20, best_day: 42, worst_day: -12, nights_traded: 2, win_rate: 0.4 },
};

describe("Eastern days", () => {
  it("names the Eastern day of an instant across the UTC date line", () => {
    expect(etDay(Date.parse("2026-10-22T02:30:00Z"))).toBe("2026-10-21"); // 22:30 EDT
    expect(etDay(Date.parse("2026-10-22T04:00:00Z"))).toBe("2026-10-22");
  });
  it("finds a day's midnight through the November clock change", () => {
    expect(new Date(etDayStartMs("2026-10-21") as number).toISOString()).toBe("2026-10-21T04:00:00.000Z");
    expect(new Date(etDayStartMs("2026-11-02") as number).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(etDayStartMs("tomorrow")).toBeNull();
  });
  it("labels days and instants the way the desk reads them", () => {
    expect(dayLabel("2026-10-21")).toBe("10/21");
    expect(dayLabel("odd")).toBe("odd");
    expect(fmtEtMs(Date.parse("2026-10-21T18:03:00Z"))).toBe("10/21 14:03");
  });
});

describe("scales and ticks", () => {
  it("maps a domain onto a range, and a flat domain to the middle", () => {
    const y = scaleLinear(0, 100, 200, 0);
    expect(y(0)).toBe(200);
    expect(y(100)).toBe(0);
    expect(y(25)).toBe(150);
    expect(scaleLinear(5, 5, 0, 10)(5)).toBe(5);
  });
  it("picks round ticks that cover the data", () => {
    const a = niceAxis(480, 530, 4);
    expect(a.ticks[0]).toBeLessThanOrEqual(480);
    expect(a.ticks[a.ticks.length - 1]).toBeGreaterThanOrEqual(530);
    expect(a.ticks).toEqual([480, 500, 520, 540]);
    expect(a.lo).toBe(480);
    expect(a.hi).toBe(540);
  });
  it("a P&L axis always contains zero, as an exact 0", () => {
    const a = niceAxis(12, 42, 4, true);
    expect(a.ticks).toContain(0);
    expect(a.lo).toBe(0);
    const b = niceAxis(-12, 30, 4, true);
    expect(b.ticks).toContain(0);
    expect(b.lo).toBeLessThanOrEqual(-12);
    expect(b.hi).toBeGreaterThanOrEqual(30);
  });
  it("a flat range still has a span", () => {
    const a = niceAxis(500, 500, 4);
    expect(a.hi).toBeGreaterThan(a.lo);
    const z = niceAxis(0, 0, 4, true);
    expect(z.hi).toBeGreaterThan(z.lo);
  });
  it("ticks the window by Eastern day, thinned to the budget; inside one day it names that day", () => {
    const t0 = Date.parse("2026-10-20T14:00:00Z");
    const t1 = Date.parse("2026-10-22T14:00:00Z");
    expect(dayTicks(t0, t1).map((t) => t.label)).toEqual(["10/21", "10/22"]);
    expect(dayTicks(Date.parse("2026-10-21T14:00:00Z"), Date.parse("2026-10-21T20:00:00Z"))).toEqual([
      { t: Date.parse("2026-10-21T14:00:00Z"), label: "10/21" },
    ]);
    const long = dayTicks(Date.parse("2026-09-01T12:00:00Z"), Date.parse("2026-10-30T12:00:00Z"), 8);
    expect(long.length).toBeLessThanOrEqual(8);
    expect(long.length).toBeGreaterThan(3);
  });
  it("prints at most so many bar labels, spread evenly", () => {
    expect(labelIndexes(5, 8)).toEqual([0, 1, 2, 3, 4]);
    expect(labelIndexes(20, 5)).toEqual([0, 4, 8, 12, 16, 19]);
    expect(labelIndexes(0, 5)).toEqual([]);
  });
});

describe("buildSeries", () => {
  const s = buildSeries(PORTFOLIO)!;
  it("holds the cash samples and the cumulative P&L, which starts from a zero at the first settled day", () => {
    expect(s.cash.map((q) => q.v)).toEqual([500, 480, 530]);
    expect(s.pnl.map((q) => q.v)).toEqual([0, -12, 30]);
    expect(s.pnl[0].t).toBe(etDayStartMs("2026-10-21"));
    expect(s.t0).toBe(Date.parse("2026-10-20T14:00:00Z"));
    expect(s.t1).toBeGreaterThan(s.t0);
  });
  it("never puts a P&L point past the last cash sample", () => {
    expect(Math.max(...s.pnl.map((q) => q.t))).toBeLessThanOrEqual(Date.parse("2026-10-22T14:00:00Z"));
  });
  it("runs the cumulative itself when the API sends a day's realized and no cumulative", () => {
    const p = { ...PORTFOLIO, pnl_by_day: PORTFOLIO.pnl_by_day.map((d) => ({ ...d, cumulative: null })) };
    expect(buildSeries(p)!.pnl.map((q) => q.v)).toEqual([0, -12, 30]);
  });
  it("skips a null cash and a day with no figure at all", () => {
    const p: ComboPortfolio = {
      ...PORTFOLIO,
      balance_series: [
        { ts: "2026-10-21T14:00:00Z", cash: null, portfolio_value: 3 },
        { ts: "bad", cash: 1, portfolio_value: 1 },
      ],
      pnl_by_day: [{ day: "2026-10-21", realized: null, cumulative: null, n_settled: null, wins: null, losses: null }],
    };
    expect(buildSeries(p)).toBeNull();
  });
  it("is null with nothing to draw", () => {
    expect(buildSeries(null)).toBeNull();
    expect(buildSeries({ ...PORTFOLIO, balance_series: [], pnl_by_day: [] })).toBeNull();
  });
  it("draws on cash alone, or on P&L alone", () => {
    expect(buildSeries({ ...PORTFOLIO, pnl_by_day: [] })!.pnl).toEqual([]);
    const onlyPnl = buildSeries({ ...PORTFOLIO, balance_series: [] })!;
    expect(onlyPnl.cash).toEqual([]);
    expect(onlyPnl.pnl.length).toBe(3);
  });
});

describe("the hover", () => {
  const s = buildSeries(PORTFOLIO)!;
  it("lands on the nearest time either series has a point, by the Flow chart's rule", () => {
    const times = snapTimes(s);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
    expect(nearestSnap([10, 20, 40], 31)).toBe(2);
    expect(nearestSnap([10, 20, 40], 30)).toBe(1); // a tie goes to the earlier point
    expect(nearestSnap([], 5)).toBe(-1);
  });
  it("reads each series as of a time: the last point at or before it", () => {
    expect(valueAt(s.cash, Date.parse("2026-10-21T20:00:00Z"))).toBe(480);
    expect(valueAt(s.cash, Date.parse("2026-10-19T00:00:00Z"))).toBeNull();
  });
  it("the readout carries the day, the balance and the P&L to date", () => {
    const rd = readoutAt(s, Date.parse("2026-10-22T14:00:00Z"), { cash: "c", pnl: "p" });
    expect(rd.title).toBe("10/22 10:00");
    expect(rd.rows).toEqual([
      { label: "Balance", value: "$530", ink: "c" },
      { label: "P&L to date", value: "+$30", ink: "p" },
    ]);
    const early = readoutAt(s, Date.parse("2026-10-20T14:00:00Z"), { cash: "c", pnl: "p" });
    expect(early.rows[1].value).toBe("-");
  });
});

describe("daily bars", () => {
  it("one bar per settled day with its sign and a hover line", () => {
    const bars = dailyBars(PORTFOLIO);
    expect(bars.map((b) => [b.label, b.value, b.tone])).toEqual([
      ["10/21", -12, "dn"],
      ["10/22", 42, "up"],
    ]);
    expect(bars[1].title).toBe("10/22: +$42 on 3 tickets (2 won, 1 lost)");
  });
  it("skips a day with no realized figure and handles no data", () => {
    expect(
      dailyBars({ ...PORTFOLIO, pnl_by_day: [{ day: "2026-10-21", realized: null, cumulative: null, n_settled: null, wins: null, losses: null }] }),
    ).toEqual([]);
    expect(dailyBars(null)).toEqual([]);
  });
});

describe("figures", () => {
  it("lists the seven figures with their signs", () => {
    const f = portfolioFigures(PORTFOLIO);
    expect(f.map((x) => [x.label, x.value])).toEqual([
      ["balance", "$530"],
      ["realized to date", "+$30"],
      ["open cost", "$20"],
      ["best day", "+$42"],
      ["worst day", "-$12"],
      ["nights traded", "2"],
      ["win rate per ticket", "40%"],
    ]);
    expect(f.map((x) => x.tone)).toEqual([null, "up", null, "up", "dn", null, null]);
  });
  it("reads a best day that names its day, and every null as a dash", () => {
    const f = portfolioFigures({
      ...PORTFOLIO,
      figures: { ...PORTFOLIO.figures, best_day: { day: "2026-10-22", realized: 42 }, worst_day: null, win_rate: null, balance: null },
    });
    expect(f.find((x) => x.key === "best-day")).toMatchObject({ label: "best day · 10/22", value: "+$42" });
    expect(f.find((x) => x.key === "worst-day")).toMatchObject({ value: "-", tone: null });
    expect(f.find((x) => x.key === "win-rate")!.value).toBe("-");
    expect(f.find((x) => x.key === "balance")!.value).toBe("-");
    expect(portfolioFigures(null).every((x) => x.value === "-")).toBe(true);
  });
  it("a win rate is a fraction, or a percent already when over 1", () => {
    expect(fmtRate(0.625)).toBe("63%");
    expect(fmtRate(1)).toBe("100%");
    expect(fmtRate(62.5)).toBe("63%");
    expect(fmtRate(undefined)).toBe("-");
  });
});

describe("by strategy", () => {
  it("rows carry the counts and a signed P&L", () => {
    expect(strategyRows(PORTFOLIO)).toEqual([
      { key: "lock-fade0", tag: "lock-fade", tagged: true, tickets: "5", won: "2", lost: "3", pnl: "+$30", pnlTone: "up" },
    ]);
    expect(strategyFold(PORTFOLIO)).toBeNull();
  });
  it("folds to one quiet line when every ticket is untagged, or when there is nothing", () => {
    const untagged = {
      ...PORTFOLIO,
      by_strategy: [
        { tag: null, n: 4, wins: 1, losses: 3, pnl: -5 },
        { tag: "untagged", n: 1, wins: 1, losses: 0, pnl: 2 },
      ],
    };
    expect(strategyFold(untagged)).toBe("5 tickets, none tagged with a strategy yet");
    expect(strategyFold({ ...PORTFOLIO, by_strategy: [] })).toBe("no strategy split yet");
    expect(strategyFold(null)).toBe("no strategy split yet");
  });
  it("one tag among untagged rows keeps the table, and the untagged row is named", () => {
    const mixed = {
      ...PORTFOLIO,
      by_strategy: [
        { tag: "lock-fade", n: 2, wins: 1, losses: 1, pnl: 1 },
        { tag: "", n: 3, wins: 0, losses: 3, pnl: -9 },
      ],
    };
    expect(strategyFold(mixed)).toBeNull();
    expect(strategyRows(mixed).map((r) => [r.tag, r.tagged])).toEqual([
      ["lock-fade", true],
      ["untagged", false],
    ]);
  });
  it("knows a tag from the backend's word for none", () => {
    for (const t of [null, "", "  ", "Untagged", "none"]) expect(isTagged(t)).toBe(false);
    expect(isTagged("lock-fade")).toBe(true);
  });
});
