// CANDLE DATA HELPERS (Inc 5a — SWIT-39): the pure half of CandleChart.
// lightweight-charts wants `{time, open, high, low, close}` with `time` as a
// UTC unix SECONDS timestamp, strictly ascending and unique; a project hands
// us ISO strings from its API (Lodestar's `Bar`). Everything that can be
// asserted without a canvas lives here.

import type { UTCTimestamp } from "lightweight-charts";

/** The bar shape every project's bar API resolves to (Lodestar `Bar`). */
export type OhlcBar = { ts: string; open: number; high: number; low: number; close: number; volume?: number };

export type CandlePoint = {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  /** The source ISO stamp — the anchor key (`bar:<ts>`) is built from it, so
   *  a pin survives a time-zone or precision change in the display. */
  ts: string;
};

/** ISO → UTC seconds, or null for an unparseable stamp.
 *
 *  A stamp with NO zone (`2026-08-01T13:31:00`, or `2026-08-01 13:31:00`) is
 *  read as UTC. Lodestar's bar endpoints serialise a naive `ts_utc` column
 *  exactly like that, and `Date.parse` would take it as LOCAL time — every bar
 *  7 hours off in Pacific, and a marker built from a `Z` stamp landing on the
 *  wrong candle (the review's blocker). A stamp that carries `Z` or an offset
 *  is taken as written. */
export function isoToUtcSeconds(ts: string): UTCTimestamp | null {
  const t = ts.trim().replace(" ", "T");
  const zoned = /(Z|[+-]\d\d:?\d\d)$/i.test(t) ? t : `${t}Z`;
  const ms = Date.parse(zoned);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000) as UTCTimestamp;
}

/** Bars → candle points: drops bars with a bad stamp or non-finite OHLC,
 *  sorts ascending, and collapses duplicate seconds (last one wins — the
 *  library throws on a duplicate time, and a duplicate is a data bug we
 *  render past rather than blank the chart for). */
export function toCandlePoints(bars: readonly OhlcBar[]): CandlePoint[] {
  const byTime = new Map<number, CandlePoint>();
  for (const b of bars) {
    const time = isoToUtcSeconds(b.ts);
    if (time === null) continue;
    if (![b.open, b.high, b.low, b.close].every(Number.isFinite)) continue;
    byTime.set(time, { time, open: b.open, high: b.high, low: b.low, close: b.close, ts: b.ts });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** The anchor key for a bar (surfaces/anchors.ts grammar): `bar:<iso>`. */
export function barAnchorKey(ts: string): string {
  return `bar:${ts}`;
}

/** Nearest candle to an ISO stamp (for `highlightTs`), or null when empty. */
export function nearestCandle(points: readonly CandlePoint[], ts: string | null | undefined): CandlePoint | null {
  if (!ts || points.length === 0) return null;
  const want = isoToUtcSeconds(ts);
  if (want === null) return null;
  let best: CandlePoint | null = null;
  let bestDist = Infinity;
  for (const p of points) {
    const d = Math.abs(p.time - want);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

/** Level tones a project may ask for, mapped onto the surface palette
 *  (styles/surfaces.css). Functional colours only: up / down / liquidity /
 *  accent. Unknown tone → accent. */
export const LEVEL_COLORS: Readonly<Record<string, string>> = {
  up: "#6fc492",
  dn: "#e88a8a",
  liq: "#7ab8e8",
  accent: "#7dd3a8",
  /** SWIT-75: a view's `levels` — --text-secondary (#b4b4b4), the tone the
   *  zero rule / region labels use: a level is CONTEXT, never a series. */
  neutral: "#b4b4b4",
};

export function levelColor(tone: string | undefined): string {
  return (tone && LEVEL_COLORS[tone]) || LEVEL_COLORS.accent;
}

/** THE SERIES PALETTE (SWIT-70): eight tones for line series, MIRRORING the
 *  `--chart-1`…`--chart-8` tokens in styles/surfaces.css (canvas cannot read
 *  a CSS var — change one, change the other, like LEVEL_COLORS above).
 *  `--up`/`--dn` are deliberately absent: those two carry meaning. */
export const SERIES_PALETTE: readonly string[] = [
  "#7ab8e8", // --chart-1 (blue / liq)
  "#a99cf0", // --chart-2 (violet)
  "#e8b765", // --chart-3 (amber)
  "#6fc9c0", // --chart-4 (teal)
  "#e89ab5", // --chart-5 (pink)
  "#a8c97e", // --chart-6 (lime)
  "#cf9de8", // --chart-7 (orchid)
  "#e8a27a", // --chart-8 (peach)
];

/** A STABLE colour for a series NAME (SWIT-70): the same name draws in the
 *  same tone in every view, so `gamma` is recognisable across four panels
 *  without reading four legends. FNV-1a over the name into the fixed palette
 *  — pure, no state, no registration. Key it on the DATA name (the column),
 *  not a display label, so relabelling never moves a colour. */
export function seriesColor(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return SERIES_PALETTE[(h >>> 0) % SERIES_PALETTE.length];
}

/** A horizontal level line (gamma flip, walls, vol trigger). `style`
 *  (SWIT-75) picks solid over the dashed default — a view's `levels` name
 *  it; Lodestar's pages never set it and draw as before. */
export type PriceLevel = { price: number; label: string; tone: string; style?: "solid" | "dashed" };

/** Levels that can be drawn: finite price, non-empty label. */
export function drawableLevels(levels: readonly PriceLevel[] | undefined): PriceLevel[] {
  return (levels ?? []).filter((l) => Number.isFinite(l.price) && l.label.trim().length > 0);
}

/** A view's level as the LINE chart draws it (SWIT-75): a rule at `price`
 *  (solid | dashed) or a `zone` band between `price` and `price2`. Same
 *  shape as viewStore's ViewLevel, declared here so the chart module owns
 *  its own props. */
export type ChartLevel = { price: number; label?: string; style?: "solid" | "dashed" | "zone"; price2?: number };

/** The y extent a set of levels needs — [min, max] over every price (and
 *  `price2` on zones); null with no finite level. LinePanel widens its auto
 *  y range to this so a level outside the data is still on the canvas. */
export function levelRange(levels: readonly ChartLevel[] | undefined): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const l of levels ?? []) {
    for (const p of [l.price, l.style === "zone" ? l.price2 : undefined]) {
      if (typeof p !== "number" || !Number.isFinite(p)) continue;
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** A view's levels as CANDLE price lines (SWIT-75): one neutral line per
 *  rule, labelled by its label or its price (the library shows the title on
 *  the line); a `zone` becomes its TWO EDGES, both dashed and both titled —
 *  lightweight-charts has no band primitive, and two honest edges beat a
 *  fake fill. Pure. */
export function candleLevelLines(levels: readonly ChartLevel[] | undefined): PriceLevel[] {
  const out: PriceLevel[] = [];
  for (const l of levels ?? []) {
    if (!Number.isFinite(l.price)) continue;
    const label = l.label && l.label.trim().length > 0 ? l.label.trim() : String(l.price);
    if (l.style === "zone") {
      if (typeof l.price2 !== "number" || !Number.isFinite(l.price2)) continue;
      out.push({ price: l.price, label, tone: "neutral", style: "dashed" });
      out.push({ price: l.price2, label, tone: "neutral", style: "dashed" });
      continue;
    }
    out.push({ price: l.price, label, tone: "neutral", style: l.style === "dashed" ? "dashed" : "solid" });
  }
  return out;
}
