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
  up: "#4ea96a",
  dn: "#e0645b",
  liq: "#5aa6c9",
  accent: "#7c8ce8",
};

export function levelColor(tone: string | undefined): string {
  return (tone && LEVEL_COLORS[tone]) || LEVEL_COLORS.accent;
}

/** THE SERIES PALETTE (SWIT-70): eight tones for line series, MIRRORING the
 *  `--chart-1`…`--chart-8` tokens in styles/surfaces.css (canvas cannot read
 *  a CSS var — change one, change the other, like LEVEL_COLORS above).
 *  `--up`/`--dn` are deliberately absent: those two carry meaning. */
export const SERIES_PALETTE: readonly string[] = [
  "#7c8ce8", // --chart-1 (accent)
  "#5aa6c9", // --chart-2 (liq)
  "#4fb3a4", // --chart-3
  "#c9a55a", // --chart-4
  "#b07cc9", // --chart-5
  "#c97ca6", // --chart-6
  "#8fb35a", // --chart-7
  "#c9855a", // --chart-8
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

/** A horizontal level line (gamma flip, walls, vol trigger). */
export type PriceLevel = { price: number; label: string; tone: string };

/** Levels that can be drawn: finite price, non-empty label. */
export function drawableLevels(levels: readonly PriceLevel[] | undefined): PriceLevel[] {
  return (levels ?? []).filter((l) => Number.isFinite(l.price) && l.label.trim().length > 0);
}
