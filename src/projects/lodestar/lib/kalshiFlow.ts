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

export const BIG_BET_USD = 1000;

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

/** ISO to ms; a stamp with no zone designator is UTC. NaN when unparseable. */
export function parseIso(ts: string): number {
  const s = ts.replace(" ", "T");
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
}

export interface FlowSeries {
  /** UTC seconds, ascending: every bucket start, plus the tip when it falls
   *  outside or between them (so the tip marker sits at the real time). */
  xs: number[];
  /** The source ISO per x. */
  isos: string[];
  /** Cumulative handle in dollars per side, carried forward between buckets. */
  handle: Record<string, number[]>;
  /** Price in cents per side, the last seen carried forward; null before a
   *  side's first priced bucket. */
  price: Record<string, (number | null)[]>;
  /** Cumulative bets per side at the last x. */
  totals: Record<string, { bets: number; handle: number }>;
}

/**
 * Cumulative handle and last-seen price per side from the bucketed timeline.
 * Rows may arrive in any order and any side may be absent from a bucket.
 * `tipIso`, when given and parseable, becomes an x of its own so the marker is
 * drawn at the true tip time rather than the nearest bucket.
 */
export function buildFlowSeries(
  timeline: readonly NbaFlowTimelineRow[],
  sides: readonly string[],
  tipIso?: string | null,
): FlowSeries {
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
  const times = [...byT.keys()];
  const tipMs = tipIso ? parseIso(tipIso) : NaN;
  if (Number.isFinite(tipMs) && times.length > 0 && !byT.has(tipMs)) times.push(tipMs);
  times.sort((a, b) => a - b);

  const handle: Record<string, number[]> = {};
  const price: Record<string, (number | null)[]> = {};
  const totals: Record<string, { bets: number; handle: number }> = {};
  for (const s of sides) {
    handle[s] = [];
    price[s] = [];
    totals[s] = { bets: 0, handle: 0 };
  }
  const lastPrice: Record<string, number | null> = Object.fromEntries(sides.map((s) => [s, null]));

  for (const t of times) {
    const bucket = byT.get(t);
    for (const s of sides) {
      for (const r of bucket?.get(s) ?? []) {
        totals[s].handle += r.handle;
        totals[s].bets += r.bets;
        if (r.price != null && Number.isFinite(r.price)) lastPrice[s] = r.price;
      }
      handle[s].push(totals[s].handle);
      price[s].push(lastPrice[s]);
    }
  }
  return {
    xs: times.map((t) => t / 1000),
    isos: times.map((t) => new Date(t).toISOString()),
    handle,
    price,
    totals,
  };
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
