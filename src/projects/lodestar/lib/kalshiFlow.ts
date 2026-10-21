/**
 * Kalshi Trading / Flow — the derived numbers (SWIT-130). Pure: no React, no
 * DOM, no fetch, so every rule here has a unit test and the components only
 * draw what these return.
 *
 * Definitions the page prints (HELP below): a BET is one taker order; HANDLE
 * is the dollars the takers paid; BIG is a bet of $1,000 or more; a LEAN is a
 * side whose share of money beats its share of bets by 10+ points; prices are
 * cents per $1 for that side.
 */

import type {
  NbaFlowGame,
  NbaFlowLine,
  NbaFlowLineKey,
  NbaFlowSizeBucket,
  NbaFlowSizeRow,
  NbaFlowTimelineRow,
} from "../api/client";

export const LINE_KEYS: readonly NbaFlowLineKey[] = ["ml", "spread", "total"];

export const LINE_LABEL: Readonly<Record<NbaFlowLineKey, string>> = {
  ml: "Moneyline",
  spread: "Spread",
  total: "Total",
};

/** Above this share of zero-priced trades the handle is understated. */
export const OUTAGE_SHARE = 0.2;
export const OUTAGE_CHIP = "handle incomplete (capture outage)";

/** A side leans when its share of money beats its share of bets by this many points. */
export const LEAN_POINTS = 10;

/** The size buckets in ascending order, the page's public-to-sharp axis. */
export const SIZE_BUCKETS: readonly NbaFlowSizeBucket[] = ["<$10", "$10-100", "$100-1k", "$1k-10k", "$10k+"];

export const HELP: readonly { term: string; text: string }[] = [
  { term: "Bet", text: "one taker order." },
  { term: "Handle", text: "the dollars the takers paid." },
  { term: "Big", text: "a bet of $1,000 or more." },
  { term: "Lean", text: "the side whose share of money beats its share of bets by 10+ points." },
  { term: "Price", text: "cents per $1 for that side." },
];

// -- formatting ---------------------------------------------------------------

/** "$850", "$18.2k", "$1.3M". */
export function fmtMoney(v: number): string {
  if (!Number.isFinite(v)) return "-";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1_000_000) return `${sign}$${trim1(a / 1_000_000)}M`;
  if (a >= 1000) return `${sign}$${trim1(a / 1000)}k`;
  return `${sign}$${Math.round(a)}`;
}

function trim1(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** "1,203". */
export function fmtCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "-";
}

/** A 0..100 share as "64%". */
export function fmtPct(p: number): string {
  return Number.isFinite(p) ? `${Math.round(p)}%` : "-";
}

/** The money-minus-tickets gap in points, signed: "+23", "-23", "0". */
export function fmtGap(gap: number): string {
  if (!Number.isFinite(gap)) return "-";
  const r = Math.round(gap);
  return r > 0 ? `+${r}` : r < 0 ? `-${Math.abs(r)}` : "0";
}

/** Cents per $1: "47c". */
export function fmtCents(c: number | null | undefined): string {
  return c == null || !Number.isFinite(c) ? "-" : `${Math.round(c)}c`;
}

/** "42c to 47c" / "47c" / "-". */
export function fmtPriceMove(first: number | null, last: number | null): string {
  if (first == null && last == null) return "-";
  if (first == null || last == null || Math.round(first) === Math.round(last)) return fmtCents(last ?? first);
  return `${fmtCents(first)} to ${fmtCents(last)}`;
}

/** Tip time in the viewer's zone ("7:30 PM"); `tz` pins a zone for tests. */
export function fmtTip(iso: string | null, tz?: string): string {
  if (!iso) return "tip unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "tip unknown";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(d);
}

/** Today as the viewer's local calendar date, "2026-10-21". */
export function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isHandleIncomplete(priceZeroShare: number | null | undefined): boolean {
  return typeof priceZeroShare === "number" && priceZeroShare > OUTAGE_SHARE;
}

// -- lean / result ------------------------------------------------------------

export type LeanOutcome = "won" | "lost" | "push" | null;

/** Did the lean side win? null when there is no lean or the line is unsettled. */
export function leanOutcome(line: Pick<NbaFlowLine, "lean" | "result">): LeanOutcome {
  if (!line.lean || !line.result) return null;
  if (line.result === "push") return "push";
  return line.result === line.lean ? "won" : "lost";
}

/** "lean MIA +23" — the chip text — or null. */
export function leanLabel(line: NbaFlowLine): string | null {
  if (!line.lean) return null;
  const s = line.sides.find((x) => x.side === line.lean);
  return s ? `lean ${line.lean} ${fmtGap(s.gap)}` : `lean ${line.lean}`;
}

/** "won MIA" / "push" / null (unsettled). */
export function resultLabel(line: Pick<NbaFlowLine, "result">): string | null {
  if (!line.result) return null;
  return line.result === "push" ? "push" : `won ${line.result}`;
}

/** "lean won" / "lean lost" / "lean pushed" / null. */
export function leanOutcomeLabel(o: LeanOutcome): string | null {
  return o === "won" ? "lean won" : o === "lost" ? "lean lost" : o === "push" ? "lean pushed" : null;
}

export function scoreLabel(g: Pick<NbaFlowGame, "away" | "home" | "away_score" | "home_score">): string | null {
  if (g.away_score == null || g.home_score == null) return null;
  return `${g.away} ${g.away_score} - ${g.home} ${g.home_score}`;
}

/** Sum of big bets / big handle across a line's sides. */
export function bigTotals(line: NbaFlowLine): { bets: number; handle: number } {
  return line.sides.reduce(
    (acc, s) => ({ bets: acc.bets + s.big_bets, handle: acc.handle + s.big_handle }),
    { bets: 0, handle: 0 },
  );
}

// -- selection ----------------------------------------------------------------

export interface FlowSelection {
  game: string;
  line: NbaFlowLineKey;
  /** null = the backend's default rung. */
  rung: string | null;
}

/** The line a row click opens: the first that exists, ml when none does. */
export function defaultLine(g: Pick<NbaFlowGame, "lines">): NbaFlowLineKey {
  return LINE_KEYS.find((k) => g.lines[k]) ?? "ml";
}

export type SelectionAction =
  | { type: "row"; game: NbaFlowGame }
  | { type: "line"; game: NbaFlowGame; line: NbaFlowLineKey }
  | { type: "setLine"; line: NbaFlowLineKey }
  | { type: "rung"; rung: string | null }
  | { type: "close" };

/** Row click opens that game (clicking the open game again closes it); a line
 *  cell always opens its line; changing the line resets the rung. */
export function selectionReducer(prev: FlowSelection | null, a: SelectionAction): FlowSelection | null {
  switch (a.type) {
    case "row":
      return prev?.game === a.game.game ? null : { game: a.game.game, line: defaultLine(a.game), rung: null };
    case "line":
      return { game: a.game.game, line: a.line, rung: null };
    case "setLine":
      return prev ? { ...prev, line: a.line, rung: null } : prev;
    case "rung":
      return prev ? { ...prev, rung: a.rung } : prev;
    case "close":
      return null;
  }
}

// -- the timeline -------------------------------------------------------------

/** The bucket width the page asks the backend for (`bucket_min`). */
export const BUCKET_MIN = 15;

/** ISO to ms; a stamp with no zone designator is UTC. NaN when unparseable. */
export function parseIso(ts: string): number {
  const s = ts.replace(" ", "T");
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
}

export interface FlowSeries {
  /** UTC seconds, ascending. */
  xs: number[];
  /** The source ISO per x. */
  isos: string[];
  /** Cumulative handle in dollars per side at each x. */
  handle: Record<string, number[]>;
  /** Price in cents per side, the last seen carried forward; null before a
   *  side's first priced bucket. */
  price: Record<string, (number | null)[]>;
  /** Totals per side over the whole timeline. */
  totals: Record<string, { bets: number; handle: number }>;
}

/**
 * Cumulative handle and last-seen price per side from the bucketed timeline.
 *
 * A timeline row is stamped at the bucket START and holds the bets in
 * [t, t + bucket), so a bucket's bets are only all in by its END. The
 * cumulative is therefore plotted at the bucket end: a zero anchor at the
 * first bucket's start, then for each bucket a point at its start (carrying
 * the previous total, only when there is a gap) and one at its end holding the
 * new total. The price is carried forward the same way.
 *
 * The tip gets an x of its own, holding the total of everything that was in
 * before it (the last point at or before the tip): a bucket the tip falls
 * inside therefore ramps up AFTER the tip marker, never before it, and a tip
 * on a bucket boundary reads exactly the pre-tip total. A tip before the first
 * bucket reads zero. No rows means no points, tip or not.
 */
export function buildFlowSeries(
  timeline: readonly NbaFlowTimelineRow[],
  sides: readonly string[],
  tipIso?: string | null,
  bucketMin: number = BUCKET_MIN,
): FlowSeries {
  const bucketMs = bucketMin * 60_000;
  const byT = new Map<number, Map<string, NbaFlowTimelineRow[]>>();
  for (const r of timeline) {
    const t = parseIso(r.t);
    if (!Number.isFinite(t)) continue;
    let m = byT.get(t);
    if (!m) byT.set(t, (m = new Map()));
    const arr = m.get(r.side);
    if (arr) arr.push(r);
    else m.set(r.side, [r]);
  }
  const starts = [...byT.keys()].sort((a, b) => a - b);

  const totals: Record<string, { bets: number; handle: number }> = {};
  const lastPrice: Record<string, number | null> = {};
  for (const s of sides) {
    totals[s] = { bets: 0, handle: 0 };
    lastPrice[s] = null;
  }

  type Pt = { ms: number; handle: Record<string, number>; price: Record<string, number | null> };
  const snap = (ms: number): Pt => ({
    ms,
    handle: Object.fromEntries(sides.map((s) => [s, totals[s].handle])),
    price: { ...lastPrice },
  });
  const pts: Pt[] = [];
  if (starts.length > 0) pts.push(snap(starts[0])); // the zero anchor
  for (const t of starts) {
    if (pts[pts.length - 1].ms < t) pts.push(snap(t)); // a gap: hold until this bucket opens
    for (const s of sides) {
      for (const r of byT.get(t)?.get(s) ?? []) {
        totals[s].handle += r.handle;
        totals[s].bets += r.bets;
        if (r.price != null && Number.isFinite(r.price)) lastPrice[s] = r.price;
      }
    }
    pts.push(snap(t + bucketMs));
  }

  const tipMs = tipIso ? parseIso(tipIso) : NaN;
  if (Number.isFinite(tipMs) && pts.length > 0 && !pts.some((p) => p.ms === tipMs)) {
    let before: Pt | null = null;
    for (const p of pts) if (p.ms <= tipMs) before = p;
    const zero: Pt = {
      ms: tipMs,
      handle: Object.fromEntries(sides.map((s) => [s, 0])),
      price: Object.fromEntries(sides.map((s) => [s, null])),
    };
    const at: Pt = before ? { ...before, ms: tipMs } : zero;
    const idx = pts.findIndex((p) => p.ms > tipMs);
    if (idx < 0) pts.push(at);
    else pts.splice(idx, 0, at);
  }

  const handle: Record<string, number[]> = {};
  const price: Record<string, (number | null)[]> = {};
  for (const s of sides) {
    handle[s] = pts.map((p) => p.handle[s]);
    price[s] = pts.map((p) => p.price[s]);
  }
  return {
    xs: pts.map((p) => p.ms / 1000),
    isos: pts.map((p) => new Date(p.ms).toISOString()),
    handle,
    price,
    totals,
  };
}

/** More than a day on the x axis: time-of-day ticks alone would be ambiguous. */
export function spansMoreThanADay(xs: readonly number[]): boolean {
  return xs.length > 1 && xs[xs.length - 1] - xs[0] > 86_400;
}

/** A readable one-liner under the handle chart: each side's share of bets and
 *  of money, and which side the money leans to (10+ points over its bets). */
export function flowSummary(totals: FlowSeries["totals"], sides: readonly string[]): string {
  const bets = sides.reduce((a, s) => a + (totals[s]?.bets ?? 0), 0);
  const money = sides.reduce((a, s) => a + (totals[s]?.handle ?? 0), 0);
  if (bets <= 0 || money <= 0) return "no bets in this window";
  const parts = sides.map((s) => {
    const b = ((totals[s]?.bets ?? 0) / bets) * 100;
    const m = ((totals[s]?.handle ?? 0) / money) * 100;
    return { s, b, m };
  });
  const text = parts.map((p) => `${p.s} ${fmtPct(p.b)} of bets, ${fmtPct(p.m)} of money`).join("; ");
  const lean = parts.find((p) => p.m - p.b >= LEAN_POINTS);
  return `${text}; ${lean ? `money leans ${lean.s}` : "no side leans by 10+ points"}`;
}

/** A readable one-liner under the price chart: each side's first and last price. */
export function priceSummary(price: FlowSeries["price"], sides: readonly string[]): string {
  const parts = sides.map((s) => {
    const vals = (price[s] ?? []).filter((v): v is number => v != null);
    return vals.length ? `${s} ${fmtPriceMove(vals[0], vals[vals.length - 1])}` : `${s} no price yet`;
  });
  return parts.join("; ");
}

/** Sides in a stable order whatever order the backend sent them in, so a
 *  side keeps its colour across rungs: away team first (moneyline, spread),
 *  Over first (total). Unknown shapes keep the backend order. */
export function orderSides(
  sides: readonly string[],
  line: NbaFlowLineKey,
  game: Pick<NbaFlowGame, "away"> | undefined,
): string[] {
  const rank = (s: string): number => {
    if (line === "total") return /^over(\s|$)/i.test(s) ? 0 : 1;
    if (game) return s === game.away || s.startsWith(`${game.away} `) ? 0 : 1;
    return 0;
  };
  return [...sides].sort((a, b) => rank(a) - rank(b));
}

// -- size mix -----------------------------------------------------------------

export interface SizeMixRow {
  bucket: NbaFlowSizeBucket;
  side: string;
  bets: number;
  handle: number;
  /** Average bet in dollars, 0 when there are no bets. */
  avg: number;
}

/** Every bucket for every side, zero-filled, in ascending size order. */
export function sizeMix(sizes: readonly NbaFlowSizeRow[], sides: readonly string[]): SizeMixRow[] {
  const out: SizeMixRow[] = [];
  for (const bucket of SIZE_BUCKETS) {
    for (const side of sides) {
      let bets = 0;
      let handle = 0;
      for (const r of sizes) {
        if (r.bucket === bucket && r.side === side) {
          bets += r.bets;
          handle += r.handle;
        }
      }
      out.push({ bucket, side, bets, handle, avg: bets > 0 ? handle / bets : 0 });
    }
  }
  return out;
}

/** Per side: average bet and the share of its handle that came from bets of
 *  $1k and up (the two largest buckets) — the public-versus-sharp read. */
export function sideProfile(
  sizes: readonly NbaFlowSizeRow[],
  sides: readonly string[],
): { side: string; bets: number; handle: number; avg: number; bigShare: number }[] {
  return sides.map((side) => {
    const rows = sizes.filter((r) => r.side === side);
    const bets = rows.reduce((a, r) => a + r.bets, 0);
    const handle = rows.reduce((a, r) => a + r.handle, 0);
    const big = rows.filter((r) => r.bucket === "$1k-10k" || r.bucket === "$10k+").reduce((a, r) => a + r.handle, 0);
    return { side, bets, handle, avg: bets > 0 ? handle / bets : 0, bigShare: handle > 0 ? (big / handle) * 100 : 0 };
  });
}

// -- wording ------------------------------------------------------------------

/** "1 bet", "412 bets". */
export function fmtBets(n: number): string {
  return `${fmtCount(n)} ${n === 1 ? "bet" : "bets"}`;
}

/** The readable rung when the backend gave one, its code otherwise, "" for none. */
export function rungText(x: { rung?: string | null; rung_label?: string | null; label?: string | null }): string {
  return x.rung_label ?? x.label ?? x.rung ?? "";
}

/**
 * What to tell the person when a fetch fails. The client's errors read
 * "GET /path -> 404 Not Found · detail": an HTTP answer means the backend is up
 * and the ENDPOINT is the problem, which "backend unreachable" would hide.
 */
export function fetchErrorText(message: string): string {
  const m = /->\s*(\d{3})\s*([^·]*?)\s*(?:·\s*(.*))?$/.exec(message);
  if (m) {
    const status = [m[1], m[2]].filter(Boolean).join(" ");
    return `endpoint returned ${status}${m[3] ? ` - ${m[3]}` : ""}`;
  }
  return `backend unreachable - ${message.replace(/^Error:\s*/, "")}`;
}

/** Everything a line cell says, in a sentence, for a screen reader: the cell is
 *  a button, so its inner bars are presentational and only this is read. */
export function lineAriaLabel(lineKey: NbaFlowLineKey, line: NbaFlowLine): string {
  const rung = rungText(line);
  const sides = line.sides
    .map((s) => `${s.side}: ${fmtPct(s.ticket_pct)} of bets, ${fmtPct(s.money_pct)} of money`)
    .join("; ");
  const bits = [
    `${LINE_LABEL[lineKey]}${rung ? ` ${rung}` : ""}`,
    sides,
    `${fmtBets(line.bets)}, ${fmtMoney(line.handle)} handle`,
    line.lean ? `money leans ${line.lean}` : null,
    resultLabel(line),
    leanOutcomeLabel(leanOutcome(line)),
  ];
  return `${bits.filter(Boolean).join(". ")}. Opens the game detail.`;
}

/** A past slate whose games are all final no longer changes: stop polling it. */
export function slateIsSettled(slate: { date: string; games: readonly Pick<NbaFlowGame, "status">[] } | null, today: string): boolean {
  return !!slate && slate.date < today && slate.games.length > 0 && slate.games.every((g) => g.status === "final");
}

// -- stale-response guards ------------------------------------------------------

/** The slate answers the date and phase on screen (a late answer for the
 *  previous ones must not be drawn). */
export function slateMatches<T extends { date: string; phase: string }>(slate: T | null | undefined, date: string, phase: string): slate is T {
  return !!slate && slate.date === date && slate.phase === phase;
}

/** The detail answers the game and line on screen. The rung is NOT compared:
 *  the backend may substitute its main rung for the one asked for, and a
 *  comparison would then wait forever. A response is tied to its own request by
 *  the poll's per-run stale drop and the selection-keyed cache, and the page
 *  shows the answer's rung in the select. */
export function detailMatches<T extends { game: string; line: string }>(
  sel: { game: string; line: string },
  d: T | null | undefined,
): d is T {
  return !!d && d.game === sel.game && d.line === sel.line;
}

/** The two team codes in a game code ("26OCT21MINMIA" -> MIN away, MIA home),
 *  so the side order does not wait for the slate row. */
export function gameCodeTeams(code: string): { away: string; home: string } | null {
  const m = /^\d{2}[A-Z]{3}\d{2}([A-Z]{3})([A-Z]{3})$/.exec(code);
  return m ? { away: m[1], home: m[2] } : null;
}

/** Keep the SAME object while the data is unchanged, so a poll that returns
 *  identical rows does not rebuild the series and reset the chart's zoom. */
export function stabilize<T>(prev: { json: string; value: T } | null, next: T): { json: string; value: T } {
  const json = JSON.stringify(next);
  return prev && prev.json === json ? prev : { json, value: next };
}
