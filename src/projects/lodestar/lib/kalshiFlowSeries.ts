/**
 * Kalshi Trading / Flow - the series behind the detail chart (SWIT-130). Pure:
 * cumulative shares and gaps from the bucketed timeline, the time window, the
 * axis ticks, and DraftKings' snapshots as a line. The component only draws
 * what these return.
 *
 * Everything is CUMULATIVE from the first bucket of the tape, so the last
 * point of a window equals the numbers in the versus block above the chart;
 * the 6h / before-tip / whole-game switch only chooses how much of it is in
 * view.
 */

import type { NbaFlowBookSeries, NbaFlowLineKey, NbaFlowTimelineRow } from "../api/client";
import { BUCKET_MIN, matchBookSide, parseIso } from "./kalshiFlow";

/** The first stretch is hidden until the line has this many bets in all: a
 *  share of five bets swings from 0 to 100 and says nothing. */
export const MIN_BETS_TO_PLOT = 20;

/** One point of the share chart: the running totals at a bucket's END. */
export interface SharePoint {
  /** The bucket's end, ms (clamped to the tip when the view stops there). */
  t: number;
  /** Cumulative handle ($) and bets per side, a = left, b = right. */
  ha: number;
  hb: number;
  na: number;
  nb: number;
  /** The left side's share of money and of bets, 0..100 (50 with nothing yet). */
  mA: number;
  bA: number;
  /** mA - bA. */
  gap: number;
  /** The same gap with every $1k+ bet out of both sides; null when nothing is left. */
  exGap: number | null;
  /** The left side's last price (cents), carried forward; null before its first. */
  px: number | null;
}

export interface ShareOptions {
  tipMs: number;
  /** Count the in-game buckets too (whole game). */
  includeLive: boolean;
  bucketMin?: number;
  minBets?: number;
}

/**
 * Cumulative share points from the timeline. A row is stamped at its bucket
 * START and holds the bets in [t, t + bucket), so its point sits at the bucket
 * end. The backend cuts the bucket the tip falls inside AT the tip, so a row
 * with t < tip is pregame (its point is clamped to the tip) and a row with
 * t >= tip is live: a before-tip view stops at the first row at or after the
 * tip. Points are dropped until the line has `minBets` bets.
 */
export function buildSharePoints(
  timeline: readonly NbaFlowTimelineRow[],
  a: string,
  b: string,
  { tipMs, includeLive, bucketMin = BUCKET_MIN, minBets = MIN_BETS_TO_PLOT }: ShareOptions,
): SharePoint[] {
  const bucketMs = bucketMin * 60_000;
  const byStart = new Map<number, NbaFlowTimelineRow[]>();
  for (const r of timeline) {
    const t = parseIso(r.t);
    if (!Number.isFinite(t)) continue;
    const arr = byStart.get(t);
    if (arr) arr.push(r);
    else byStart.set(t, [r]);
  }
  const starts = [...byStart.keys()].sort((x, y) => x - y);

  const run = { ha: 0, hb: 0, na: 0, nb: 0, bha: 0, bhb: 0, bna: 0, bnb: 0 };
  let px: number | null = null;
  const out: SharePoint[] = [];
  for (const start of starts) {
    if (!includeLive && Number.isFinite(tipMs) && start >= tipMs) break;
    for (const r of byStart.get(start) ?? []) {
      if (r.side === a) {
        run.ha += r.handle;
        run.na += r.bets;
        run.bha += r.big_handle;
        run.bna += r.big_bets;
        if (r.price != null && Number.isFinite(r.price)) px = r.price;
      } else if (r.side === b) {
        run.hb += r.handle;
        run.nb += r.bets;
        run.bhb += r.big_handle;
        run.bnb += r.big_bets;
      }
    }
    // The backend cuts a bucket at the tip: a row that starts before it is purely
    // pregame (so it ends there), a row that starts AT the tip holds the live part.
    let t = start + bucketMs;
    if (Number.isFinite(tipMs) && start < tipMs) t = Math.min(t, tipMs);
    const money = run.ha + run.hb;
    const bets = run.na + run.nb;
    const mA = money > 0 ? (run.ha / money) * 100 : 50;
    const bA = bets > 0 ? (run.na / bets) * 100 : 50;
    const xh = run.ha - run.bha;
    const xhb = run.hb - run.bhb;
    const xn = run.na - run.bna;
    const xnb = run.nb - run.bnb;
    const exGap = xh + xhb > 0 && xn + xnb > 0 ? (xh / (xh + xhb)) * 100 - (xn / (xn + xnb)) * 100 : null;
    out.push({ t, ha: run.ha, hb: run.hb, na: run.na, nb: run.nb, mA, bA, gap: mA - bA, exGap, px });
  }
  const first = out.findIndex((p) => p.na + p.nb >= minBets);
  return first < 0 ? [] : out.slice(first);
}

export type ChartRange = "6h" | "pre" | "all";

export const RANGE_LABEL: Readonly<Record<ChartRange, string>> = {
  "6h": "Last 6h",
  pre: "All before tip",
  all: "Whole game",
};

export interface ChartWindow {
  t0: number;
  t1: number;
}

/**
 * The x range for a range choice. The window opens at the first plotted
 * bucket (or six hours before the tip, whichever is later) and closes at the
 * tip, or at the last bucket for the whole game.
 */
export function chartWindow(
  points: readonly SharePoint[],
  range: ChartRange,
  tipMs: number,
  bucketMin: number = BUCKET_MIN,
): ChartWindow | null {
  if (points.length === 0) return null;
  const bucketMs = bucketMin * 60_000;
  const first = points[0].t - bucketMs;
  const last = points[points.length - 1].t;
  let t0 = first;
  let t1 = range === "all" || !Number.isFinite(tipMs) ? last : tipMs;
  if (range === "6h" && Number.isFinite(tipMs)) t0 = Math.max(first, tipMs - 6 * 3_600_000);
  if (t1 - t0 < bucketMs) t1 = t0 + bucketMs;
  return { t0, t1 };
}

/** The points in view. */
export function pointsIn(points: readonly SharePoint[], w: ChartWindow): SharePoint[] {
  return points.filter((p) => p.t >= w.t0 && p.t <= w.t1);
}

/**
 * The index of the value in `xs` (ascending x positions) closest to `x`: the
 * point the chart's cursor snaps to. A tie goes to the earlier point; -1 when
 * there is nothing to pick.
 */
export function nearestIndex(xs: readonly number[], x: number): number {
  if (xs.length === 0 || !Number.isFinite(x)) return -1;
  let best = 0;
  let bestD = Math.abs(xs[0] - x);
  for (let i = 1; i < xs.length; i++) {
    const d = Math.abs(xs[i] - x);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** Tick times for an axis over [t0, t1]: every 12h, 3h, 1h or 30 min by span. */
export function timeTicks(t0: number, t1: number): number[] {
  const span = t1 - t0;
  const H = 3_600_000;
  const step = span > 36 * H ? 12 * H : span > 12 * H ? 3 * H : span > 4 * H ? H : 30 * 60_000;
  const out: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) out.push(t);
  return out;
}

/** Whether tick labels need a weekday (the window spans most of a day). */
export function ticksNeedDay(t0: number, t1: number): boolean {
  return t1 - t0 > 20 * 3_600_000;
}

/** Half-height of the gap strip, in points: past the widest-fifth line with
 *  room, and past the biggest gap drawn, in steps of 10. */
export function gapAxisMax(widest: number, gaps: readonly number[]): number {
  const biggest = gaps.reduce((m, g) => Math.max(m, Math.abs(g)), 0);
  return Math.max(Math.round(widest) + 10, Math.ceil(biggest / 10) * 10);
}

// -- DraftKings snapshots ----------------------------------------------------------

export interface BookPoint {
  /** The snapshot time, ms. */
  t: number;
  /** DraftKings' share of money / bets on the left side, 0..100. */
  money: number;
  bets: number;
}

/** DraftKings' snapshots as the left side's money and bet share over time. */
export function bookPoints(
  series: Pick<NbaFlowBookSeries, "series"> | null | undefined,
  line: NbaFlowLineKey,
  left: string,
): BookPoint[] {
  if (!series) return [];
  const out: BookPoint[] = [];
  for (const s of series.series) {
    const t = parseIso(s.t);
    const side = matchBookSide(line, left, s.sides);
    if (!Number.isFinite(t) || !side) continue;
    if (typeof side.handle_pct !== "number" || typeof side.bets_pct !== "number") continue;
    out.push({ t, money: side.handle_pct, bets: side.bets_pct });
  }
  return out.sort((x, y) => x.t - y.t);
}

/** The x range when only DraftKings has data: from its first snapshot to the
 *  tip (or a little past its last snapshot). */
export function bookWindow(points: readonly BookPoint[], tipMs: number): ChartWindow | null {
  if (points.length === 0) return null;
  const pad = BUCKET_MIN * 60_000;
  const last = points[points.length - 1].t;
  return { t0: points[0].t - pad, t1: Number.isFinite(tipMs) && tipMs > last ? tipMs : last + pad };
}

/** DraftKings' latest snapshot inside one bucket, (end - bucketMs, end], or null. */
export function bookInBucket(points: readonly BookPoint[], end: number, bucketMs: number): BookPoint | null {
  let hit: BookPoint | null = null;
  for (const p of points) if (p.t > end - bucketMs && p.t <= end && (!hit || p.t >= hit.t)) hit = p;
  return hit;
}
