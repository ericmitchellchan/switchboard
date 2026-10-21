/**
 * Kalshi Trading / Flow - the derived numbers (SWIT-130). Pure: no React, no
 * DOM, no fetch, so every rule here has a unit test and the components only
 * draw what these return.
 *
 * Definitions the page prints: a BET is one taker order; HANDLE is the dollars
 * the takers paid; a BIG bet is $1,000 or more; a LEAN is a side whose share of
 * money beats its share of bets by 10+ points; prices are cents per $1 for that
 * side. DraftKings publishes percentages only - no dollars, no bet counts - so
 * nothing here ever derives a DraftKings dollar figure.
 *
 * Left side = the away team (moneyline, spread) or Over (total); right side =
 * home or Under. Everywhere: board, strip, detail, chart.
 */

import type {
  NbaFlowBigBet,
  NbaFlowBookGame,
  NbaFlowBookLine,
  NbaFlowGame,
  NbaFlowGapBands,
  NbaFlowLine,
  NbaFlowLineKey,
  NbaFlowSide,
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
/** The lean chip turns loud from this gap. */
export const BIG_LEAN_POINTS = 30;
/** The "Biggest splits" strip only ranks Kalshi lines with at least this much handle. */
export const SPLITS_MIN_HANDLE = 5000;
/** How many lines the strip shows. */
export const SPLITS_COUNT = 4;

/** The size buckets in ascending order, the page's public-to-sharp axis. */
export const SIZE_BUCKETS: readonly NbaFlowSizeBucket[] = ["<$10", "$10-100", "$100-1k", "$1k-10k", "$10k+"];

// -- formatting ---------------------------------------------------------------

/** "$850", "$18.2k", "$1.3M". */
export function fmtMoney(v: number): string {
  if (!Number.isFinite(v)) return "-";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  // Tiers on the ROUNDED value, so 999.6 reads "$1k" (not "$1000") and 999,999 "$1M".
  if (a >= 999_500) return `${sign}$${trim1(a / 1_000_000)}M`;
  if (a >= 100_000) return `${sign}$${Math.round(a / 1000)}k`;
  if (a >= 999.5) return `${sign}$${trim1(a / 1000)}k`;
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

/** The money-minus-bets gap in points, signed: "+23", "-23", "0". */
export function fmtGap(gap: number): string {
  if (!Number.isFinite(gap)) return "-";
  const r = Math.round(gap);
  return r > 0 ? `+${r}` : r < 0 ? `-${Math.abs(r)}` : "0";
}

/** Cents per $1: "47c". */
export function fmtCents(c: number | null | undefined): string {
  return c == null || !Number.isFinite(c) ? "-" : `${Math.round(c)}c`;
}

/** "1 bet", "412 bets". */
export function fmtBets(n: number): string {
  return `${fmtCount(n)} ${n === 1 ? "bet" : "bets"}`;
}

const ET = "America/New_York";

/** A time in Eastern ("7:30 PM"), with the weekday when asked ("Sat 7:30 PM"); "-" when
 *  there is no time. `tz` pins another zone for tests. */
export function fmtEt(iso: string | number | null | undefined, withDay = false, tz: string = ET): string {
  if (iso == null || iso === "") return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
    ...(withDay ? { weekday: "short" } : {}),
  }).format(d);
}

/** Today's NBA slate date: the Eastern calendar date, "2026-10-21" (the
 *  backend's own default, so a viewer in another zone sees the same slate). */
export function todayEt(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now)
    .reduce<Record<string, string>>((o, p) => ((o[p.type] = p.value), o), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The date `days` away from `iso` ("2026-10-21", +1 -> "2026-10-22"). */
export function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/** "Wed, Oct 21, 2026" for the date stepper. */
export function fmtDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function isHandleIncomplete(priceZeroShare: number | null | undefined): boolean {
  return typeof priceZeroShare === "number" && priceZeroShare > OUTAGE_SHARE;
}

/** "O 216.5" / "U 216.5" for a total's sides; any other side unchanged. */
export function shortSide(side: string): string {
  return side.replace(/^Over\s+/i, "O ").replace(/^Under\s+/i, "U ");
}

/** The readable rung when the backend gave one, its code otherwise, "" for none. */
export function rungText(x: { rung?: string | null; rung_label?: string | null; label?: string | null }): string {
  return x.rung_label ?? x.label ?? x.rung ?? "";
}

// -- the three sources ----------------------------------------------------------

/** Which book(s) the board draws. */
export type FlowSource = "kalshi" | "dk" | "both";

export const SOURCES: readonly { key: FlowSource; label: string }[] = [
  { key: "kalshi", label: "Kalshi" },
  { key: "dk", label: "DraftKings" },
  { key: "both", label: "Both" },
];

/** The first word of a side: the team of "ORL -2.5", the code of "ATL". */
export function sideTeam(side: string): string {
  return side.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
}

const isOver = (s: string) => /^over\b/i.test(s.trim());
const isUnder = (s: string) => /^under\b/i.test(s.trim());

/** -1 for a favourite's handicap ("ORL -2.5"), +1 for an underdog's ("ATL +2.5"), 0 for none
 *  or a pick'em ("MIA +0": DraftKings writes PK as +0 on both teams, so it matches either side). */
export function handicapSign(side: string): -1 | 0 | 1 {
  const m = /([+-])\s*(\d+(?:\.\d+)?)/.exec(side);
  if (!m || Number(m[2]) === 0) return 0;
  return m[1] === "-" ? -1 : 1;
}

/**
 * DraftKings' side that corresponds to a Kalshi side. A total matches by
 * Over/Under at any number. A moneyline matches by TEAM. A spread side is a
 * team AND a handicap direction: it matches by team only when both books give
 * the team the same direction (favourite with favourite, underdog with
 * underdog) - the number may differ. If DraftKings has the OTHER team as the
 * favourite, its numbers are a different bet and nothing matches. Null when the
 * book has no such side.
 */
export function matchBookSide<S extends { side: string }>(
  line: NbaFlowLineKey,
  side: string,
  candidates: readonly S[] | null | undefined,
): S | null {
  if (!candidates) return null;
  if (line === "total") {
    const want = isOver(side) ? isOver : isUnder(side) ? isUnder : null;
    return want ? (candidates.find((c) => want(c.side)) ?? null) : null;
  }
  const team = sideTeam(side);
  const sign = line === "spread" ? handicapSign(side) : 0;
  return (
    candidates.find((c) => {
      if (sideTeam(c.side) !== team) return false;
      const cs = line === "spread" ? handicapSign(c.side) : 0;
      return sign === 0 || cs === 0 || cs === sign;
    }) ?? null
  );
}

/** Sides in a stable order whatever order the backend sent them in, so a
 *  side keeps its place and colour everywhere: away team first (moneyline,
 *  spread), Over first (total). Unknown shapes keep the backend order. */
export function orderSides(
  sides: readonly string[],
  line: NbaFlowLineKey,
  game: Pick<NbaFlowGame, "away"> | undefined,
): string[] {
  const rank = (s: string): number => {
    if (line === "total") return isOver(s) ? 0 : 1;
    if (game) return sideTeam(s) === game.away.toUpperCase() ? 0 : 1;
    return 0;
  };
  return [...sides].sort((a, b) => rank(a) - rank(b));
}

/** "ATL -10.5" / "CLE +10.5" as a favourite and a size: the same spread
 *  whichever team it is written from. */
function spreadKey(label: string, game: Pick<NbaFlowGame, "away" | "home">): string | null {
  const m = /^([A-Za-z]{2,4})\s*([+-]\d+(?:\.\d+)?)$/.exec(label.trim());
  if (!m) return null;
  const team = m[1].toUpperCase();
  const n = Number(m[2]);
  const other = team === game.away.toUpperCase() ? game.home : game.away;
  return `${n < 0 ? team : other.toUpperCase()} ${Math.abs(n)}`;
}

/**
 * DraftKings' own line when it is not the line Kalshi's main rung is on
 * ("ORL -2.5" against Kalshi's "ATL -10.5"), else null. A moneyline has no line.
 */
export function bookLineNote(
  line: NbaFlowLineKey,
  game: Pick<NbaFlowGame, "away" | "home">,
  kalshi: Pick<NbaFlowLine, "rung" | "rung_label"> | null,
  dk: NbaFlowBookLine | null | undefined,
): string | null {
  if (line === "ml" || !kalshi || !dk?.line_label) return null;
  const k = rungText(kalshi);
  if (!k) return null;
  if (line === "total") {
    const kn = Number(k.replace(/^(over|under)\s+/i, ""));
    const dn = Number(dk.line_label.replace(/^(over|under)\s+/i, ""));
    return Number.isFinite(kn) && Number.isFinite(dn) && kn === dn ? null : dk.line_label;
  }
  const kk = spreadKey(k, game);
  const dd = spreadKey(dk.line_label, game);
  return kk && dd && kk === dd ? null : dk.line_label;
}

// -- the cell the board draws -----------------------------------------------------

/** One side of a market as drawn. */
export interface CellSide {
  /** Display name: Kalshi's when it has the line, DraftKings' otherwise. */
  side: string;
  short: string;
  /** The drawn shares, 0..100, of the chosen source (or the plain average). */
  betsPct: number;
  moneyPct: number;
  /** moneyPct - betsPct. */
  gap: number;
  /** Kalshi's last price before the tip (cents), null with no Kalshi bets. */
  price: number | null;
  /** This side won (the line is settled). */
  won: boolean;
  /** The OTHER source's shares, for the white tick marks; null when there is
   *  nothing to tick (or the average is drawn). */
  tickBetsPct: number | null;
  tickMoneyPct: number | null;
  /** DraftKings' shares whatever is drawn (null with no DraftKings split). */
  dkBetsPct: number | null;
  dkMoneyPct: number | null;
}

export type DrawnSource = "kalshi" | "dk" | "avg";

export interface CellModel {
  line: NbaFlowLineKey;
  drawn: DrawnSource;
  a: CellSide;
  b: CellSide;
  /** Kalshi's bet count and handle; null when Kalshi has no bets on the line. */
  bets: number | null;
  handle: number | null;
  /** The side whose money share beats its bet share by 10+ points. */
  lean: CellSide | null;
  /** The larger of the two sides' gaps (>= 0). */
  maxGap: number;
  /** Whose ticks are drawn on the bars: the source that is NOT drawn. */
  tickSource: "kalshi" | "dk" | null;
  /** Which source(s) the numbers come from, in words, when that needs saying. */
  note: string | null;
  /** DraftKings' own line, when it is not Kalshi's. */
  dkLine: string | null;
  /** A spread whose favourite is the OTHER team at DraftKings ("DK favours the
   *  other side: CHA -1.5"): its numbers are a different bet, so none are used. */
  dkMismatch: string | null;
  /** Kalshi's readable rung. */
  rung: string;
  result: string | null;
}

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
const mean = (x: number, y: number) => (x + y) / 2;

/**
 * Everything one market cell draws, from whichever sources have the line.
 *
 * Source "kalshi" draws Kalshi's bets and money shares (DraftKings as ticks),
 * "dk" the reverse, "both" the simple average of the two - no weighting. A
 * market only one source has draws that one and says which. Null when neither
 * has the market.
 */
export function buildCell(
  game: Pick<NbaFlowGame, "away" | "home">,
  key: NbaFlowLineKey,
  kalshi: NbaFlowLine | null | undefined,
  dk: NbaFlowBookLine | null | undefined,
  source: FlowSource,
): CellModel | null {
  const kSides = kalshi && kalshi.sides.length === 2 ? kalshi.sides : null;
  const kOrder = kSides ? orderSides(kSides.map((s) => s.side), key, game) : null;
  const dkOrder = dk && dk.sides.length >= 2 ? orderSides(dk.sides.map((s) => s.side), key, game) : null;

  // The pair of sides in left/right order, named by Kalshi when it has the line.
  const names: [string, string] | null = kOrder ? [kOrder[0], kOrder[1]] : dkOrder ? [dkOrder[0], dkOrder[1]] : null;
  if (!names) return null;

  const kFor = (name: string): NbaFlowSide | null => kSides?.find((s) => s.side === name) ?? null;
  const dFor = (name: string) => matchBookSide(key, name, dk?.sides);
  const kA = kFor(names[0]);
  const kB = kFor(names[1]);
  const dA = dFor(names[0]);
  const dB = dFor(names[1]);
  const hasK = !!kA && !!kB;
  const hasD =
    !!dA && !!dB && finite(dA.bets_pct) && finite(dA.handle_pct) && finite(dB.bets_pct) && finite(dB.handle_pct) && dA !== dB;
  if (!hasK && !hasD) return null;

  // A spread DraftKings has the other way round is a different bet: say so, use nothing of it.
  let dkMismatch: string | null = null;
  if (key === "spread" && hasK && dk && (!dA || !dB) && dk.sides.some((s) => names.some((n) => sideTeam(n) === sideTeam(s.side)))) {
    const fav = dk.sides.find((s) => handicapSign(s.side) < 0);
    if (fav) dkMismatch = `DK favours the other side: ${fav.side}`;
  }

  let drawn: DrawnSource;
  if (source === "both") drawn = hasK && hasD ? "avg" : hasK ? "kalshi" : "dk";
  else if (source === "kalshi") drawn = hasK ? "kalshi" : "dk";
  else drawn = hasD ? "dk" : "kalshi";

  // Said when the numbers are not what the source switch asked for (a fallback)
  // or when "both" had only one to give; a plain Kalshi board says nothing.
  const asked: DrawnSource = source === "dk" ? "dk" : "kalshi";
  const note =
    dkMismatch ??
    (drawn === "avg"
      ? "avg of Kalshi + DK"
      : source === "both" || drawn !== asked
        ? drawn === "kalshi"
          ? "Kalshi only"
          : "DraftKings only"
        : null);
  const tickSource: CellModel["tickSource"] = drawn === "kalshi" && hasD ? "dk" : drawn === "dk" && hasK ? "kalshi" : null;

  const side = (name: string, k: NbaFlowSide | null, d: typeof dA): CellSide => {
    const kb = k ? k.ticket_pct : null;
    const km = k ? k.money_pct : null;
    const db = hasD && d ? d.bets_pct : null;
    const dm = hasD && d ? d.handle_pct : null;
    let betsPct: number;
    let moneyPct: number;
    if (drawn === "avg") {
      betsPct = mean(kb as number, db as number);
      moneyPct = mean(km as number, dm as number);
    } else if (drawn === "kalshi") {
      betsPct = kb as number;
      moneyPct = km as number;
    } else {
      betsPct = db as number;
      moneyPct = dm as number;
    }
    return {
      side: name,
      short: shortSide(name),
      betsPct,
      moneyPct,
      gap: moneyPct - betsPct,
      price: k ? k.price_last : null,
      won: !!kalshi?.result && kalshi.result === name,
      tickBetsPct: tickSource === "dk" ? db : tickSource === "kalshi" ? kb : null,
      tickMoneyPct: tickSource === "dk" ? dm : tickSource === "kalshi" ? km : null,
      dkBetsPct: db,
      dkMoneyPct: dm,
    };
  };
  const a = side(names[0], kA, dA);
  const b = side(names[1], kB, dB);
  const lead = a.gap >= b.gap ? a : b;
  return {
    line: key,
    drawn,
    a,
    b,
    bets: hasK && kalshi ? kalshi.bets : null,
    handle: hasK && kalshi ? kalshi.handle : null,
    lean: lead.gap >= LEAN_POINTS ? lead : null,
    maxGap: Math.max(0, a.gap, b.gap),
    tickSource,
    note,
    dkLine: hasK && !dkMismatch ? bookLineNote(key, game, kalshi ?? null, dk) : null,
    dkMismatch,
    rung: kalshi ? rungText(kalshi) : (dk?.line_label ?? ""),
    result: hasK && kalshi ? kalshi.result : null,
  };
}

/** "$ -> MIA" text for the quiet lean chip; the loud form adds the gap. */
export function leanChip(cell: CellModel): { text: string; loud: boolean } | null {
  if (!cell.lean) return null;
  const loud = cell.lean.gap >= BIG_LEAN_POINTS;
  return { text: `$ → ${cell.lean.short}${loud ? ` +${Math.round(cell.lean.gap)}` : ""}`, loud };
}

/** DraftKings' bets/money for the left side as one mono line, or null. */
export function dkLine(cell: CellModel): string | null {
  if (cell.drawn !== "kalshi" || cell.a.dkBetsPct == null || cell.a.dkMoneyPct == null) return null;
  return `DK ${fmtPct(cell.a.dkBetsPct)} bets · ${fmtPct(cell.a.dkMoneyPct)} $`;
}

/** Kalshi's bets/money for the left side when DraftKings is the drawn source. */
export function kalshiLine(cell: CellModel): string | null {
  if (cell.drawn !== "dk" || cell.tickSource !== "kalshi" || cell.a.tickBetsPct == null || cell.a.tickMoneyPct == null) {
    return null;
  }
  return `Kalshi ${fmtPct(cell.a.tickBetsPct)} bets · ${fmtPct(cell.a.tickMoneyPct)} $`;
}

/** The book's line for one game, or undefined. */
export function bookGame(
  books: { games: readonly NbaFlowBookGame[] } | null | undefined,
  game: string,
): NbaFlowBookGame | undefined {
  return books?.games.find((g) => g.game === game);
}

/** One entry in the "Biggest splits" strip. */
export interface SplitEntry {
  game: NbaFlowGame;
  line: NbaFlowLineKey;
  cell: CellModel;
  side: CellSide;
  gap: number;
}

/**
 * The lines where one side's money share sits furthest above its bet share,
 * under the chosen source. Kalshi and Both rank only lines Kalshi has bets on,
 * and leave out those under $5k of handle (a few small bets can swing a share);
 * DraftKings-only lines stay out of them. DraftKings ranks the DraftKings
 * shares with no dollar gate (the book publishes no dollars).
 */
export function biggestSplits(
  games: readonly NbaFlowGame[],
  books: { games: readonly NbaFlowBookGame[] } | null | undefined,
  source: FlowSource,
  count: number = SPLITS_COUNT,
): SplitEntry[] {
  const all: SplitEntry[] = [];
  for (const game of games) {
    const bg = bookGame(books, game.game);
    for (const line of LINE_KEYS) {
      const cell = buildCell(game, line, game.lines[line], bg?.lines[line], source);
      if (!cell) continue;
      if (source === "dk") {
        if (cell.drawn !== "dk") continue;
      } else if (cell.drawn === "dk" || (cell.handle != null && cell.handle < SPLITS_MIN_HANDLE)) {
        continue;
      }
      const side = cell.a.gap >= cell.b.gap ? cell.a : cell.b;
      if (side.gap <= 0) continue;
      all.push({ game, line, cell, side, gap: side.gap });
    }
  }
  all.sort((x, y) => y.gap - x.gap);
  return all.slice(0, count);
}

// -- board sorting ---------------------------------------------------------------

export type BoardSort = "tip" | "handle" | "gap";

/** The games in the order asked for. `handle` is Kalshi dollars across the
 *  three lines; `gap` the widest side gap across them under the chosen source. */
export function sortGames(
  games: readonly NbaFlowGame[],
  books: { games: readonly NbaFlowBookGame[] } | null | undefined,
  source: FlowSource,
  sort: BoardSort,
): NbaFlowGame[] {
  const tip = (g: NbaFlowGame) => g.tip_utc ?? "";
  const handle = (g: NbaFlowGame) => LINE_KEYS.reduce((s, k) => s + (g.lines[k]?.handle ?? 0), 0);
  const gap = (g: NbaFlowGame) => {
    const bg = bookGame(books, g.game);
    return LINE_KEYS.reduce((m, k) => Math.max(m, buildCell(g, k, g.lines[k], bg?.lines[k], source)?.maxGap ?? 0), 0);
  };
  const by = sort === "handle" ? handle : sort === "gap" ? gap : null;
  return [...games].sort((x, y) => (by ? by(y) - by(x) : 0) || tip(x).localeCompare(tip(y)) || x.game.localeCompare(y.game));
}

// -- the gap and last season's bands --------------------------------------------

export type GapZone = "ordinary" | "wider" | "widest";

export const GAP_ZONE_LABEL: Readonly<Record<GapZone, string>> = {
  ordinary: "ordinary",
  wider: "wider than usual",
  widest: "widest fifth",
};

/** The percentile table for a line, falling back to the all-lines one. Null
 *  when the file is missing or not 101 long. */
export function bandsFor(bands: NbaFlowGapBands | null | undefined, line: NbaFlowLineKey): number[] | null {
  const own = bands?.[line];
  const pick = Array.isArray(own) && own.length === 101 ? own : bands?.all;
  return Array.isArray(pick) && pick.length === 101 && pick.every(finite) ? pick : null;
}

/** The share of last season's lines whose gap this one is wider than (0..100):
 *  the highest percentile whose value the gap reaches. */
export function gapPercentile(gap: number, p: readonly number[]): number {
  const g = Math.abs(gap);
  let hit = 0;
  for (let i = 0; i < p.length; i++) if (p[i] <= g) hit = i;
  return hit;
}

/** Inside the median is ordinary, past the 80th percentile is the widest fifth. */
export function gapZone(gap: number, p: readonly number[]): GapZone {
  const g = Math.abs(gap);
  return g >= p[80] ? "widest" : g >= p[50] ? "wider" : "ordinary";
}

/** One side's numbers with every $1k+ bet taken out. */
function exBig(s: Pick<NbaFlowSide, "bets" | "handle" | "big_bets" | "big_handle">) {
  return { handle: s.handle - s.big_handle, bets: s.bets - s.big_bets };
}

/** The gap of side `lead` (money share minus bet share) once every $1k+ bet is
 *  out of both sides; null when nothing is left to take a share of. */
export function gapWithoutBig(lead: NbaFlowSide, other: NbaFlowSide): number | null {
  const l = exBig(lead);
  const o = exBig(other);
  if (l.handle + o.handle <= 0 || l.bets + o.bets <= 0) return null;
  return (l.handle / (l.handle + o.handle)) * 100 - (l.bets / (l.bets + o.bets)) * 100;
}

export interface GapRead {
  lead: NbaFlowSide;
  other: NbaFlowSide;
  /** The lead side's gap in points (>= 0). */
  gap: number;
  /** Null when last season's file is unavailable. */
  zone: GapZone | null;
  /** The share of last season's lines this gap is wider than. */
  wider: number | null;
  exGap: number | null;
  /** Every $1k+ bet on the line, both sides. */
  bigCount: number;
  /** What the $1k+ bets explain - only said for a gap past the median: "few" when
   *  less than half the gap survives without them, else "broad". */
  bigBets: "few" | "broad" | null;
}

/** The one-line read of a line's gap against last season, and what the $1k+ bets do to it. */
export function gapRead(a: NbaFlowSide, b: NbaFlowSide, p: readonly number[] | null): GapRead {
  const [lead, other] = a.money_pct - a.ticket_pct >= b.money_pct - b.ticket_pct ? [a, b] : [b, a];
  const gap = Math.max(0, lead.money_pct - lead.ticket_pct);
  const exGap = gapWithoutBig(lead, other);
  const zone = p ? gapZone(gap, p) : null;
  const wider = p ? gapPercentile(gap, p) : null;
  const bigCount = lead.big_bets + other.big_bets;
  let bigBets: GapRead["bigBets"] = null;
  if (p && exGap != null && gap > 0 && bigCount > 0 && gap >= p[50]) bigBets = exGap / gap < 0.5 ? "few" : "broad";
  return { lead, other, gap, zone, wider, exGap, bigCount, bigBets };
}

export interface AvgBet {
  hi: { side: string; avg: number };
  lo: { side: string; avg: number };
  /** hi / lo, null when the smaller average is zero. */
  ratio: number | null;
  /** The ratio is worth printing (1.5x or more). */
  showRatio: boolean;
}

/** Average bet per side: the same split read as dollars per bet. */
export function avgBet(a: Pick<NbaFlowSide, "side" | "bets" | "handle">, b: Pick<NbaFlowSide, "side" | "bets" | "handle">): AvgBet {
  const av = (s: Pick<NbaFlowSide, "bets" | "handle">) => (s.bets > 0 ? s.handle / s.bets : 0);
  const [hi, lo] = av(a) >= av(b) ? [a, b] : [b, a];
  const ratio = av(lo) > 0 ? av(hi) / av(lo) : null;
  return {
    hi: { side: hi.side, avg: av(hi) },
    lo: { side: lo.side, avg: av(lo) },
    ratio,
    showRatio: ratio != null && ratio >= 1.5,
  };
}

// -- the one-line read ---------------------------------------------------------
// Sentences carry **bold** spans the detail renders as emphasis. They say what
// the numbers are and never tell anyone to bet.

/** "Money leans X: 78% of the money from 27% of the bets, against 73% of bets on Y." */
export function leanSentence(a: NbaFlowSide, b: NbaFlowSide): string {
  const [lead, other] = a.money_pct - a.ticket_pct >= b.money_pct - b.ticket_pct ? [a, b] : [b, a];
  if (lead.money_pct - lead.ticket_pct >= LEAN_POINTS) {
    return `Money leans **${lead.side}**: ${fmtPct(lead.money_pct)} of the money from ${fmtPct(lead.ticket_pct)} of the bets, against ${fmtPct(other.ticket_pct)} of bets on ${other.side}.`;
  }
  return `No lean: the money split (${fmtPct(a.money_pct)} / ${fmtPct(b.money_pct)}) tracks the bet split (${fmtPct(a.ticket_pct)} / ${fmtPct(b.ticket_pct)}).`;
}

/**
 * The gap against last season, and - only for a gap past the median - whether
 * the $1k+ bets make it. An ordinary gap says nothing about big bets.
 */
export function gapSentence(read: GapRead, line: NbaFlowLineKey): string {
  const lead = shortSide(read.lead.side);
  const head = `Gap **${Math.round(read.gap)} pts** toward ${lead}`;
  const kind = LINE_LABEL[line].toLowerCase();
  let out = read.zone && read.wider != null ? `${head}, wider than ${read.wider}% of ${kind} lines last season (${GAP_ZONE_LABEL[read.zone]}).` : `${head}.`;
  if (read.bigBets && read.exGap != null) {
    const change = `${fmtGap(read.gap)} → ${fmtGap(read.exGap)} without them`;
    out +=
      read.bigBets === "few"
        ? ` Take out all ${read.bigCount} $1k+ bets (${change}): **mostly a few big bets**.`
        : ` Take out all ${read.bigCount} $1k+ bets (${change}): **broad money**.`;
  }
  return out;
}

/** "Average bet: $412 on X against $77 on Y (5.3x)." */
export function avgBetSentence(avg: AvgBet): string {
  return `Average bet: **${fmtMoney(avg.hi.avg)}** on ${shortSide(avg.hi.side)} against ${fmtMoney(avg.lo.avg)} on ${shortSide(avg.lo.side)}${avg.showRatio && avg.ratio != null ? ` (${avg.ratio.toFixed(1)}x)` : ""}.`;
}

// -- when the money came in -----------------------------------------------------

export type WhenBucket = "over24h" | "24h-6h" | "6h-1h" | "lastHour" | "inGame";

export const WHEN_LABEL: Readonly<Record<WhenBucket, string>> = {
  over24h: "more than 24h out",
  "24h-6h": "24h to 6h out",
  "6h-1h": "6h to 1h out",
  lastHour: "last hour before tip",
  inGame: "in game",
};

const HOUR_MS = 3_600_000;

/** The bucket a timeline row starting at `startMs` belongs to for a tip at `tipMs`. */
export function whenBucketOf(startMs: number, tipMs: number): WhenBucket {
  if (startMs >= tipMs) return "inGame";
  const out = tipMs - startMs;
  return out > 24 * HOUR_MS ? "over24h" : out > 6 * HOUR_MS ? "24h-6h" : out > HOUR_MS ? "6h-1h" : "lastHour";
}

export interface WhenRow {
  bucket: WhenBucket;
  label: string;
  bets: number;
  handle: number;
  /** The left side's share of bets and of money inside this window (0..100);
   *  money is null when the window has no dollars. */
  leftBetPct: number;
  leftMoneyPct: number | null;
}

/**
 * Bets and dollars by how far ahead of the tip they came in, with the left
 * side's bet and money shares inside each window. Windows with no bets are left
 * out; "in game" only when `includeLive`.
 */
export function whenTheMoneyCame(
  timeline: readonly NbaFlowTimelineRow[],
  left: string,
  tipMs: number,
  includeLive: boolean,
): WhenRow[] {
  const order: WhenBucket[] = ["over24h", "24h-6h", "6h-1h", "lastHour", "inGame"];
  const acc = new Map<WhenBucket, { bets: number; handle: number; lBets: number; lHandle: number }>();
  for (const r of timeline) {
    const t = parseIso(r.t);
    if (!Number.isFinite(t) || !Number.isFinite(tipMs)) continue;
    const bucket = whenBucketOf(t, tipMs);
    if (bucket === "inGame" && !includeLive) continue;
    const x = acc.get(bucket) ?? { bets: 0, handle: 0, lBets: 0, lHandle: 0 };
    x.bets += r.bets;
    x.handle += r.handle;
    if (r.side === left) {
      x.lBets += r.bets;
      x.lHandle += r.handle;
    }
    acc.set(bucket, x);
  }
  return order.flatMap((bucket) => {
    const x = acc.get(bucket);
    if (!x || x.bets <= 0) return [];
    return [
      {
        bucket,
        label: WHEN_LABEL[bucket],
        bets: x.bets,
        handle: x.handle,
        leftBetPct: (x.lBets / x.bets) * 100,
        leftMoneyPct: x.handle > 0 ? (x.lHandle / x.handle) * 100 : null,
      },
    ];
  });
}

/**
 * One rung's two sides for the phase on screen, from the detail's own size mix
 * (exact per phase) and timeline (the price): the numbers the detail's versus
 * block, read and chart all agree on, whichever rung is open. Same shape as
 * the slate's sides so the same sentences read them.
 */
export function sideStats(
  sizes: readonly NbaFlowSizeRow[],
  timeline: readonly NbaFlowTimelineRow[],
  sides: readonly [string, string],
  tipMs: number,
  includeLive: boolean,
): [NbaFlowSide, NbaFlowSide] {
  const base = sides.map((side) => {
    const rows = sizes.filter((r) => r.side === side);
    const big = rows.filter((r) => r.bucket === "$1k-10k" || r.bucket === "$10k+");
    const priced = timeline
      .filter((r) => r.side === side && r.price != null && (includeLive || !Number.isFinite(tipMs) || parseIso(r.t) < tipMs))
      .sort((x, y) => parseIso(x.t) - parseIso(y.t));
    return {
      side,
      bets: rows.reduce((o, r) => o + r.bets, 0),
      handle: rows.reduce((o, r) => o + r.handle, 0),
      big_bets: big.reduce((o, r) => o + r.bets, 0),
      big_handle: big.reduce((o, r) => o + r.handle, 0),
      price_first: priced.length ? (priced[0].price as number) : null,
      price_last: priced.length ? (priced[priced.length - 1].price as number) : null,
    };
  });
  const bets = base[0].bets + base[1].bets;
  const money = base[0].handle + base[1].handle;
  const full = base.map((x) => {
    const ticket_pct = bets > 0 ? (x.bets / bets) * 100 : 0;
    const money_pct = money > 0 ? (x.handle / money) * 100 : 0;
    return { ...x, ticket_pct, money_pct, gap: money_pct - ticket_pct };
  });
  return [full[0], full[1]];
}

// -- size mix and big bets -------------------------------------------------------

export interface SizeMixRow {
  bucket: NbaFlowSizeBucket;
  a: { bets: number; handle: number };
  b: { bets: number; handle: number };
}

/** Every bucket in ascending size order, zero-filled, for the two sides. */
export function sizeMix(sizes: readonly NbaFlowSizeRow[], a: string, b: string): SizeMixRow[] {
  const sum = (bucket: NbaFlowSizeBucket, side: string) =>
    sizes
      .filter((r) => r.bucket === bucket && r.side === side)
      .reduce((o, r) => ({ bets: o.bets + r.bets, handle: o.handle + r.handle }), { bets: 0, handle: 0 });
  return SIZE_BUCKETS.map((bucket) => ({ bucket, a: sum(bucket, a), b: sum(bucket, b) }));
}

/** The big bets that belong to the window on screen, oldest first. */
export function bigBetsFor(bets: readonly NbaFlowBigBet[] | undefined, includeLive: boolean): NbaFlowBigBet[] {
  return (bets ?? []).filter((z) => includeLive || z.phase !== "live");
}

// -- selection ----------------------------------------------------------------

export interface FlowSelection {
  game: string;
  line: NbaFlowLineKey;
  /** null = the backend's default rung. */
  rung: string | null;
}

/** The line a click on a game opens: the first with Kalshi bets or a DraftKings
 *  split, ml when none does. */
export function defaultLine(g: Pick<NbaFlowGame, "lines">, bg?: NbaFlowBookGame): NbaFlowLineKey {
  return LINE_KEYS.find((k) => g.lines[k] || bg?.lines[k]) ?? "ml";
}

export type SelectionAction =
  | { type: "row"; game: NbaFlowGame; book?: NbaFlowBookGame }
  | { type: "line"; game: NbaFlowGame; line: NbaFlowLineKey }
  | { type: "setLine"; line: NbaFlowLineKey }
  | { type: "rung"; rung: string | null }
  | { type: "close" };

/** Opening a game opens its first line; a line cell always opens its line;
 *  changing the line resets the rung. */
export function selectionReducer(prev: FlowSelection | null, a: SelectionAction): FlowSelection | null {
  switch (a.type) {
    case "row":
      return { game: a.game.game, line: defaultLine(a.game, a.book), rung: null };
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

// -- time ------------------------------------------------------------------------

/** The bucket width the page asks the backend for (`bucket_min`). */
export const BUCKET_MIN = 15;

/** ISO to ms; a stamp with no zone designator is UTC. NaN when unparseable. */
export function parseIso(ts: string): number {
  const s = ts.replace(" ", "T");
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
}

// -- wording ------------------------------------------------------------------

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

/** Everything a market cell says, in a sentence, for a screen reader: the cell
 *  is a button, so its inner bars are presentational and only this is read. */
export function cellAriaLabel(cell: CellModel): string {
  const part = (s: CellSide) => `${s.side}: ${fmtPct(s.betsPct)} of bets, ${fmtPct(s.moneyPct)} of money`;
  const bits = [
    `${LINE_LABEL[cell.line]}${cell.rung ? ` ${cell.rung}` : ""}`,
    part(cell.a),
    part(cell.b),
    cell.bets != null && cell.handle != null ? `${fmtBets(cell.bets)}, ${fmtMoney(cell.handle)} handle` : null,
    cell.note,
    cell.lean ? `money leans ${cell.lean.side}` : null,
    cell.result ? (cell.result === "push" ? "push" : `won ${cell.result}`) : null,
  ];
  return `${bits.filter(Boolean).join(". ")}. Opens the game detail.`;
}

// -- stale-response guards ------------------------------------------------------

/** A past slate whose games are all final no longer changes: stop polling it. */
export function slateIsSettled(slate: { date: string; games: readonly Pick<NbaFlowGame, "status">[] } | null, today: string): boolean {
  return !!slate && slate.date < today && slate.games.length > 0 && slate.games.every((g) => g.status === "final");
}

/** The slate answers the date and phase on screen (a late answer for the
 *  previous ones must not be drawn). */
export function slateMatches<T extends { date: string; phase: string }>(slate: T | null | undefined, date: string, phase: string): slate is T {
  return !!slate && slate.date === date && slate.phase === phase;
}

/** The book answer is for the date on screen. */
export function booksMatch<T extends { date: string }>(books: T | null | undefined, date: string): books is T {
  return !!books && books.date === date;
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
 *  identical rows does not rebuild the series. */
export function stabilize<T>(prev: { json: string; value: T } | null, next: T): { json: string; value: T } {
  const json = JSON.stringify(next);
  return prev && prev.json === json ? prev : { json, value: next };
}
