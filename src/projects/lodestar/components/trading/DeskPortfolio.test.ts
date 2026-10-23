// The combo desk's Portfolio board (SWIT-139). No DOM in this repo's vitest, so
// the hook-free component is server-rendered to markup and read as text, and
// the chart's pure SVG is rendered at a width and driven through its handlers.

import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComboPortfolio } from "../../api/client";
import { buildSeries } from "../../lib/comboPortfolio";
import DeskPortfolio, { type DeskPortfolioProps } from "./DeskPortfolio";
import { DailyBarsSvg, PortfolioChartSvg } from "./PortfolioChart";
import { dailyBars } from "../../lib/comboPortfolio";

const text = (markup: string) => markup.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

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
  by_strategy: [
    { tag: "lock-fade", n: 3, wins: 2, losses: 1, pnl: 35 },
    { tag: "", n: 2, wins: 0, losses: 2, pnl: -5 },
  ],
  figures: { balance: 530, realized_to_date: 30, open_cost: 20, best_day: 42, worst_day: -12, nights_traded: 2, win_rate: 0.4 },
};

const props = (o: Partial<DeskPortfolioProps> = {}): DeskPortfolioProps => ({
  portfolio: PORTFOLIO,
  error: null,
  env: "demo",
  onEnv: vi.fn(),
  ...o,
});
const render = (o?: Partial<DeskPortfolioProps>) => renderToStaticMarkup(createElement(DeskPortfolio, props(o)) as ReactElement);

describe("DeskPortfolio", () => {
  it("draws the seven figures, signed, and both account switches", () => {
    const out = render();
    const t = text(out);
    for (const w of ["balance", "realized to date", "open cost", "best day", "worst day", "nights traded", "win rate per ticket"]) expect(t).toContain(w);
    expect(t).toContain("$530");
    expect(t).toContain("+$30");
    expect(t).toContain("-$12");
    expect(t).toContain("40%");
    expect(out).toMatch(/aria-pressed="true"[^>]*data-seg="demo"/);
    expect(out).toContain('data-seg="live"');
  });

  it("draws ONE balance chart with two series, a P&L zero line and day ticks", () => {
    const out = render();
    expect(out.match(/data-chart="portfolio"/g)).toHaveLength(1);
    expect(out.match(/data-series="cash"/g)).toHaveLength(1);
    expect(out.match(/data-series="pnl"/g)).toHaveLength(1);
    expect(out).toContain('data-zero="pnl"');
    expect(out).toContain('stroke-dasharray="4 4"');
    const t = text(out);
    expect(t).toContain("Cash balance");
    expect(t).toContain("Cumulative realized P&amp;L");
    // the Eastern day ticks
    expect(t).toContain("10/21");
    expect(t).toContain("10/22");
    // the cash axis in dollars, the P&L axis signed
    expect(t).toContain("$500");
    expect(t).toContain("+$20");
  });

  it("draws the daily bars: up for a profit, down for a loss, off a baseline, with day labels", () => {
    const out = render();
    expect(out).toContain('data-chart="daily"');
    expect(out).toMatch(/data-bar="2026-10-21" data-tone="dn"/);
    expect(out).toMatch(/data-bar="2026-10-22" data-tone="up"/);
    expect(out).toContain("data-baseline");
    expect(out).toMatch(/data-bar="2026-10-21"[^]*?fill="var\(--dn\)"/);
    expect(out).toMatch(/data-bar="2026-10-22"[^]*?fill="var\(--up\)"/);
    expect(text(out)).toContain("Daily P&amp;L");
  });

  it("the by-strategy table lists each tag, with the untagged row named", () => {
    const out = render();
    const t = text(out);
    expect(t).toContain("By strategy");
    expect(out).toContain('data-strategy="lock-fade"');
    expect(out).toContain('data-strategy="untagged"');
    expect(t).toContain("strategy tickets won lost P&amp;L");
    expect(t).toContain("+$35");
    expect(t).toContain("-$5");
  });

  it("folds by-strategy to one quiet line when every ticket is untagged", () => {
    const t = text(render({ portfolio: { ...PORTFOLIO, by_strategy: [{ tag: null, n: 5, wins: 2, losses: 3, pnl: 30 }] } }));
    expect(t).toContain("5 tickets, none tagged with a strategy yet");
    expect(t).not.toContain("strategy tickets won lost");
  });

  it("with no settled tickets it says so once, keeps the figures, and draws no chart", () => {
    const empty: ComboPortfolio = {
      ...PORTFOLIO,
      balance_series: [],
      pnl_by_day: [],
      open_cost_by_day: [],
      by_strategy: [],
      figures: { balance: null, realized_to_date: null, open_cost: null, best_day: null, worst_day: null, nights_traded: null, win_rate: null },
    };
    const out = render({ portfolio: empty });
    const t = text(out);
    expect(t.match(/no settled tickets yet/g)).toHaveLength(1);
    expect(t).toContain("balance");
    expect(out).not.toContain("data-chart=");
    expect(t).toContain("no strategy split yet");
  });

  it("cash with no settled day still draws the chart, and says the days are empty", () => {
    const out = render({ portfolio: { ...PORTFOLIO, pnl_by_day: [] } });
    expect(out).toContain('data-chart="portfolio"');
    expect(out).not.toContain('data-series="pnl"');
    expect(out).not.toContain('data-zero="pnl"');
    expect(out).not.toContain('data-chart="daily"');
    expect(text(out)).toContain("no settled tickets yet");
  });

  it("loads before it draws, shows a poll failure, and survives nulls in every figure", () => {
    expect(text(render({ portfolio: null }))).toContain("loading the portfolio");
    expect(text(render({ portfolio: null, error: "Error: GET /combos/portfolio?env=demo -> 500 Internal Server Error" }))).toContain("endpoint returned 500");
    const nulls: ComboPortfolio = {
      ...PORTFOLIO,
      balance_series: [{ ts: "2026-10-21T14:00:00Z", cash: null, portfolio_value: null }],
      pnl_by_day: [{ day: "2026-10-21", realized: null, cumulative: null, n_settled: null, wins: null, losses: null }],
      by_strategy: [{ tag: "x", n: null, wins: null, losses: null, pnl: null }],
    };
    expect(() => render({ portfolio: nulls })).not.toThrow();
  });
});

describe("PortfolioChartSvg", () => {
  const series = buildSeries(PORTFOLIO)!;
  const W = 900;
  const pad = { l: 58, r: 62 };
  const snapAt = (k: number, n: number) => pad.l + (k / n) * (W - pad.l - pad.r);

  it("draws a crosshair and a readout of the day, the balance and the P&L at the cursor", () => {
    const t = series.pnl[1].t; // the end of 10/21, when that night settled
    const out = renderToStaticMarkup(createElement(PortfolioChartSvg, { series, width: W, cursorT: t, onCursor: () => {} }));
    expect(out).toContain(`data-crosshair="${t}"`);
    const r = text(out.slice(out.indexOf("data-readout")));
    expect(r).toContain("10/21 23:59");
    expect(r).toContain("Balance");
    expect(r).toContain("$480");
    expect(r).toContain("P&amp;L to date");
    expect(r).toContain("-$12");
    // no cursor, no crosshair
    expect(renderToStaticMarkup(createElement(PortfolioChartSvg, { series, width: W, cursorT: null, onCursor: () => {} }))).not.toContain("data-crosshair");
  });

  it("a pointer snaps to the nearest point; the gutters and leaving hide it", () => {
    const calls: (number | null)[] = [];
    const tree = PortfolioChartSvg({ series, width: W, onCursor: (t: number | null) => calls.push(t) }) as ReactElement<Record<string, unknown>>;
    const move = tree.props.onPointerMove as (e: unknown) => void;
    const at = (clientX: number) => ({ clientX, currentTarget: { getBoundingClientRect: () => ({ left: 0, width: W }) } });
    const first = series.cash[0].t;
    const last = series.cash[series.cash.length - 1].t;
    move(at(snapAt(0, 1) + 1)); // just inside the left edge: the first point
    move(at(snapAt(1, 1) - 1)); // just inside the right edge: the last point
    move(at(10)); // the left gutter
    move(at(W - 5)); // the right gutter
    expect(calls).toEqual([first, last, null, null]);
    calls.length = 0;
    (tree.props.onPointerLeave as (e: { pointerType: string }) => void)({ pointerType: "mouse" });
    (tree.props.onPointerLeave as (e: { pointerType: string }) => void)({ pointerType: "touch" });
    expect(calls).toEqual([null]);
  });

  it("the arrow keys step through the points and Escape hides", () => {
    const calls: (number | null)[] = [];
    const onKey = (cursorT: number | null) =>
      (PortfolioChartSvg({ series, width: W, cursorT, onCursor: (t: number | null) => calls.push(t) }) as ReactElement<Record<string, unknown>>).props.onKeyDown as (e: {
        key: string;
        preventDefault(): void;
      }) => void;
    const key = (h: (e: { key: string; preventDefault(): void }) => void, k: string) => h({ key: k, preventDefault: () => {} });
    const times = [...new Set([...series.cash, ...series.pnl].map((q) => q.t))].sort((a, b) => a - b);
    key(onKey(null), "ArrowRight");
    key(onKey(null), "ArrowLeft");
    key(onKey(times[1]), "ArrowRight");
    key(onKey(times[times.length - 1]), "ArrowRight");
    key(onKey(times[1]), "Escape");
    expect(calls).toEqual([times[0], times[times.length - 1], times[2], times[times.length - 1], null]);
  });

  it("without a handler the chart is a plain image, not a focus stop", () => {
    const out = renderToStaticMarkup(createElement(PortfolioChartSvg, { series, width: W }));
    expect(out).not.toContain("tabindex");
    expect(out).toContain('role="img"');
    expect(out).toContain("realized P&amp;L to date +$30");
  });
});

describe("DailyBarsSvg", () => {
  it("a bar sits above the baseline for a profit and below it for a loss", () => {
    const bars = dailyBars(PORTFOLIO);
    const out = renderToStaticMarkup(createElement(DailyBarsSvg, { bars, width: 900 }));
    const base = Number(/data-baseline[^>]*y1="([\d.]+)"/.exec(out)?.[1]);
    const rect = (day: string) => {
      const m = new RegExp(`data-bar="${day}"[^>]*>.*?<rect x="[\\d.]+" y="([\\d.]+)" width="[\\d.]+" height="([\\d.]+)"`).exec(out);
      return { y: Number(m?.[1]), h: Number(m?.[2]) };
    };
    const loss = rect("2026-10-21");
    const win = rect("2026-10-22");
    expect(loss.y).toBeCloseTo(base, 0); // a loss hangs from the baseline
    expect(win.y + win.h).toBeCloseTo(base, 0); // a profit stands on it
    expect(win.h).toBeGreaterThan(loss.h);
    expect(text(out)).toContain("10/22");
    expect(text(out)).toContain("+$42");
  });
});
