/**
 * The combo desk's Portfolio view (SWIT-139): the pure helpers behind
 * components/trading/DeskPortfolio.tsx and PortfolioChart.tsx - the two series
 * (cash balance, cumulative realized P&L) on one time axis, their scales and
 * ticks, the readout at a point, the daily bars, the figures row and the
 * by-strategy rows - so the components draw and nothing else, and every number
 * can be tested without a DOM.
 *
 * Money from the API is dollars. Days are Eastern ("YYYY-MM-DD"), the desk's
 * clock. Every number the API sends may be null; none is guessed.
 */

import type { ComboPortfolio, ComboPortfolioDayFigure } from "../api/client";
import { fmtSigned, fmtUsd, pnlTone } from "./comboDesk";
import { nearestIndex } from "./kalshiFlowSeries";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// -- Eastern days -------------------------------------------------------------

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function etParts(ms: number): Record<string, string> {
  return Object.fromEntries(ET_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
}

/** The Eastern day of an instant: "2026-10-21". */
export function etDay(ms: number): string {
  const p = etParts(ms);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The instant an Eastern day begins (its local midnight), or null for text that is not a day. */
export function etDayStartMs(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Eastern is UTC-5 or UTC-4: midnight there is 04:00 or 05:00 UTC.
  for (const h of [4, 5]) {
    const ms = base + h * HOUR;
    const p = etParts(ms);
    if (`${p.year}-${p.month}-${p.day}` === day && p.hour === "00") return ms;
  }
  return null;
}

/** "2026-10-21" -> "10/21"; anything else as it came. */
export function dayLabel(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${Number(m[1])}/${Number(m[2])}` : day;
}

/** An instant as Eastern "10/21 14:03". */
export function fmtEtMs(ms: number): string {
  const p = etParts(ms);
  return `${Number(p.month)}/${Number(p.day)} ${p.hour}:${p.minute}`;
}

// -- scales and ticks ---------------------------------------------------------

/** A linear map from a domain to a range; a flat domain maps to the middle of the range. */
export function scaleLinear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  if (!(d1 > d0)) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

/** A round step (1, 2, 5 x 10^k) that covers `span` in about `n` steps. */
function niceStep(span: number, n: number): number {
  const raw = span / Math.max(1, n);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

export interface Axis {
  /** The domain, widened to the outer ticks. */
  lo: number;
  hi: number;
  ticks: number[];
}

/**
 * Round ticks over [lo, hi] (about `n` of them) and the domain they span.
 * `includeZero` widens the range to take in 0 (the P&L axis always shows its
 * zero). A flat or empty range gets a small span so a scale never divides by 0.
 */
export function niceAxis(lo: number, hi: number, n = 4, includeZero = false): Axis {
  let a = Number.isFinite(lo) ? lo : 0;
  let b = Number.isFinite(hi) ? hi : 0;
  if (includeZero) {
    a = Math.min(a, 0);
    b = Math.max(b, 0);
  }
  if (!(b > a)) {
    const pad = Math.max(1, Math.abs(a) * 0.05);
    a -= pad;
    b += pad;
  }
  const step = niceStep(b - a, n);
  const t0 = Math.floor(a / step) * step;
  const t1 = Math.ceil(b / step) * step;
  const ticks: number[] = [];
  for (let v = t0; v <= t1 + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : Number(v.toPrecision(12)));
  return { lo: t0, hi: t1, ticks };
}

export interface DayTick {
  t: number;
  label: string;
}

/**
 * Time ticks by Eastern day over [t0, t1]: each day's midnight inside the
 * window, thinned to at most `max`. A window inside one day gets one tick, at
 * its start, named for that day.
 */
export function dayTicks(t0: number, t1: number, max = 8): DayTick[] {
  const days: DayTick[] = [];
  if (!(t1 >= t0)) return days;
  let day = etDay(t0);
  for (let guard = 0; guard < 400; guard++) {
    const s = etDayStartMs(day);
    if (s == null) break;
    if (s > t1) break;
    if (s >= t0) days.push({ t: s, label: dayLabel(day) });
    // the next Eastern day: 36h after midnight is next day's midday, DST or not
    day = etDay(s + 36 * HOUR);
  }
  if (days.length === 0) return [{ t: t0, label: dayLabel(etDay(t0)) }];
  if (days.length <= max) return days;
  const stride = Math.ceil(days.length / max);
  return days.filter((_, i) => i % stride === 0);
}

// -- the two series -----------------------------------------------------------

export interface SeriesPoint {
  t: number;
  v: number;
}

export interface PortfolioSeries {
  /** Cash balance at each sample, oldest first. */
  cash: SeriesPoint[];
  /** Cumulative realized P&L: a zero where the first settled day begins, then one point at the end of each settled day. */
  pnl: (SeriesPoint & { day: string })[];
  t0: number;
  t1: number;
}

const num = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/**
 * The chart's two series, or null when there is nothing to draw (no cash
 * sample and no settled day). A settled day's point sits at the end of that
 * Eastern day, held back to the last cash sample so the line never runs past
 * the data we have.
 */
export function buildSeries(p: ComboPortfolio | null): PortfolioSeries | null {
  if (!p) return null;
  const cash: SeriesPoint[] = [];
  for (const r of p.balance_series ?? []) {
    const t = Date.parse(r.ts);
    if (Number.isFinite(t) && num(r.cash)) cash.push({ t, v: r.cash });
  }
  cash.sort((a, b) => a.t - b.t);
  const lastCash = cash.length ? cash[cash.length - 1].t : Infinity;

  const pnl: PortfolioSeries["pnl"] = [];
  let running = 0;
  const days = [...(p.pnl_by_day ?? [])].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  for (const d of days) {
    const start = etDayStartMs(d.day);
    if (start == null) continue;
    const cum = num(d.cumulative) ? d.cumulative : num(d.realized) ? running + d.realized : null;
    if (cum == null) continue;
    running = cum;
    if (pnl.length === 0) pnl.push({ t: start, v: 0, day: d.day });
    pnl.push({ t: Math.max(start + 1, Math.min(start + DAY - 1, lastCash)), v: cum, day: d.day });
  }
  if (cash.length === 0 && pnl.length === 0) return null;
  const ts = [...cash, ...pnl].map((q) => q.t);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  return { cash, pnl, t0, t1: t1 > t0 ? t1 : t0 + HOUR };
}

/** Every time a series has a point, once, oldest first: where the hover can land. */
export function snapTimes(s: PortfolioSeries): number[] {
  return [...new Set([...s.cash.map((q) => q.t), ...s.pnl.map((q) => q.t)])].sort((a, b) => a - b);
}

/** The index in `xs` (pixel positions) nearest to `x`, or -1; the Flow chart's rule. */
export const nearestSnap = nearestIndex;

/** The value of a series as of time t: its last point at or before t, or null before its first. */
export function valueAt(points: readonly SeriesPoint[], t: number): number | null {
  let v: number | null = null;
  for (const q of points) {
    if (q.t > t) break;
    v = q.v;
  }
  return v;
}

export interface ReadoutRow {
  label: string;
  value: string;
  ink: string;
}

export interface Readout {
  title: string;
  rows: ReadoutRow[];
}

/** What the readout says at time t: the day, the balance then, and the P&L to date. */
export function readoutAt(s: PortfolioSeries, t: number, ink: { cash: string; pnl: string }): Readout {
  const cash = valueAt(s.cash, t);
  const pnl = valueAt(s.pnl, t);
  return {
    title: fmtEtMs(t),
    rows: [
      { label: "Balance", value: cash == null ? "-" : fmtUsd(cash), ink: ink.cash },
      { label: "P&L to date", value: pnl == null ? "-" : fmtSigned(pnl), ink: ink.pnl },
    ],
  };
}

// -- the daily bars -----------------------------------------------------------

export interface DayBar {
  day: string;
  label: string;
  value: number;
  tone: "up" | "dn" | null;
  /** "10/21: +$12.4 on 3 tickets (2 won, 1 lost)". */
  title: string;
}

/** One bar per settled day that has a realized figure, oldest first. */
export function dailyBars(p: ComboPortfolio | null): DayBar[] {
  const out: DayBar[] = [];
  for (const d of [...(p?.pnl_by_day ?? [])].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    if (!num(d.realized)) continue;
    const bits: string[] = [];
    if (num(d.n_settled)) bits.push(`${d.n_settled} ticket${d.n_settled === 1 ? "" : "s"}`);
    const wl = num(d.wins) && num(d.losses) ? ` (${d.wins} won, ${d.losses} lost)` : "";
    out.push({
      day: d.day,
      label: dayLabel(d.day),
      value: d.realized,
      tone: pnlTone(d.realized),
      title: `${dayLabel(d.day)}: ${fmtSigned(d.realized)}${bits.length ? ` on ${bits.join("")}` : ""}${wl}`,
    });
  }
  return out;
}

/** Which of `n` bar labels to print so at most `max` show: every k-th, always the last. */
export function labelIndexes(n: number, max: number): number[] {
  if (n <= 0) return [];
  const stride = Math.max(1, Math.ceil(n / Math.max(1, max)));
  const out: number[] = [];
  for (let i = 0; i < n; i += stride) out.push(i);
  if (out[out.length - 1] !== n - 1 && n - 1 - out[out.length - 1] >= Math.ceil(stride / 2)) out.push(n - 1);
  return out;
}

// -- the figures row ----------------------------------------------------------

export interface PortfolioFigure {
  key: string;
  label: string;
  value: string;
  tone: "up" | "dn" | null;
}

/** A best/worst day figure: a bare number, or an object naming the day. */
function dayFigure(v: ComboPortfolioDayFigure | undefined): { value: number | null; day: string | null } {
  if (v == null) return { value: null, day: null };
  if (typeof v === "number") return { value: Number.isFinite(v) ? v : null, day: null };
  const value = num(v.realized) ? v.realized : num(v.pnl) ? v.pnl : null;
  return { value, day: v.day ? dayLabel(v.day) : null };
}

/** A win rate as a percent: 0..1 is a fraction, anything over 1 is already a percent. */
export function fmtRate(v: number | null | undefined): string {
  if (!num(v)) return "-";
  return `${Math.round(v <= 1 ? v * 100 : v)}%`;
}

export function portfolioFigures(p: ComboPortfolio | null): PortfolioFigure[] {
  const f = p?.figures;
  const best = dayFigure(f?.best_day);
  const worst = dayFigure(f?.worst_day);
  return [
    { key: "balance", label: "balance", value: fmtUsd(f?.balance), tone: null },
    { key: "realized", label: "realized to date", value: fmtSigned(f?.realized_to_date), tone: pnlTone(f?.realized_to_date) },
    { key: "open-cost", label: "open cost", value: fmtUsd(f?.open_cost), tone: null },
    { key: "best-day", label: best.day ? `best day · ${best.day}` : "best day", value: fmtSigned(best.value), tone: pnlTone(best.value) },
    { key: "worst-day", label: worst.day ? `worst day · ${worst.day}` : "worst day", value: fmtSigned(worst.value), tone: pnlTone(worst.value) },
    { key: "nights", label: "nights traded", value: num(f?.nights_traded) ? String(f?.nights_traded) : "-", tone: null },
    { key: "win-rate", label: "win rate per ticket", value: fmtRate(f?.win_rate), tone: null },
  ];
}

// -- by strategy --------------------------------------------------------------

export interface StrategyRow {
  key: string;
  tag: string;
  tagged: boolean;
  tickets: string;
  won: string;
  lost: string;
  pnl: string;
  pnlTone: "up" | "dn" | null;
}

const UNTAGGED = new Set(["", "untagged", "none", "(none)", "null", "-"]);

/** A tag that names a strategy (not blank, not the backend's word for "no tag"). */
export const isTagged = (tag: string | null | undefined): boolean => !UNTAGGED.has((tag ?? "").trim().toLowerCase());

const count = (v: number | null | undefined): string => (num(v) ? String(v) : "-");

export function strategyRows(p: ComboPortfolio | null): StrategyRow[] {
  return (p?.by_strategy ?? []).map((r, i) => {
    const tagged = isTagged(r.tag);
    return {
      key: `${r.tag ?? "untagged"}${i}`,
      tag: tagged ? (r.tag as string).trim() : "untagged",
      tagged,
      tickets: count(r.n),
      won: count(r.wins),
      lost: count(r.losses),
      pnl: fmtSigned(r.pnl),
      pnlTone: pnlTone(r.pnl),
    };
  });
}

/**
 * The one quiet line that replaces the strategy table when it has no split to
 * show - nothing, or every ticket untagged - else null (draw the table).
 */
export function strategyFold(p: ComboPortfolio | null): string | null {
  const rows = p?.by_strategy ?? [];
  if (rows.length === 0) return "no strategy split yet";
  if (rows.some((r) => isTagged(r.tag))) return null;
  const n = rows.reduce((a, r) => a + (num(r.n) ? r.n : 0), 0);
  return `${n} ticket${n === 1 ? "" : "s"}, none tagged with a strategy yet`;
}
