/**
 * The combo desk's positions view (SWIT-129): the pure helpers behind
 * components/trading/DeskPositions.tsx, so the component stays hook-free and
 * every sentence and number it prints can be tested without a DOM.
 *
 * Money from the API is dollars; a per-contract price is dollars too (0..1),
 * drawn in cents. Times are drawn in Eastern, the desk's clock.
 */

import type { ComboDeskPosition, ComboDeskView } from "../api/client";

// -- tickers ------------------------------------------------------------------

/** The stat a KXNBA* series counts, when it is not points (points is the default). */
const STAT_WORD: Record<string, string> = { REB: "reb", AST: "ast", "3PT": "3s", STL: "stl", BLK: "blk" };

/** "ATLJJOHNSON1" -> "ATL J.Johnson": team = first 3 chars, name = the rest with
 *  trailing digits (a disambiguator) stripped, first letter the initial. null
 *  when the segment is not that shape. */
export function playerLabel(seg: string): string | null {
  const m = /^([A-Z]{3})([A-Z])([A-Z]+)\d*$/.exec(seg);
  if (!m) return null;
  const [, team, initial, rest] = m;
  return `${team} ${initial}.${rest.charAt(0)}${rest.slice(1).toLowerCase()}`;
}

/** The last two segments of a ticker, or the whole thing when it is shorter. */
export function tickerTail(ticker: string): string {
  const parts = ticker.split("-");
  return parts.length > 2 ? parts.slice(-2).join("-") : ticker;
}

/**
 * A readable leg: "KXNBAPTS-26OCT21ATLORL-ATLJJOHNSON1-20" -> "ATL J.Johnson 20+".
 * A non-points NBA series says its stat ("ATL J.Johnson 8+ reb"). Anything that
 * is not series-game-player-threshold falls back to the ticker tail.
 */
export function legLabel(ticker: string): string {
  const parts = ticker.split("-");
  if (parts.length === 4) {
    const [series, , player, threshold] = parts;
    const who = playerLabel(player);
    if (who && /^\d+(\.\d+)?$/.test(threshold)) {
      const nba = series.startsWith("KXNBA");
      const stat = nba ? STAT_WORD[series.slice("KXNBA".length)] : undefined;
      return `${who} ${threshold}${nba ? "+" : ""}${stat ? ` ${stat}` : ""}`;
    }
  }
  return tickerTail(ticker);
}

/** A game key "26OCT21ATLORL" -> "ATL @ ORL"; anything else as it came. */
export function gameLabel(key: string): string {
  const m = /^\d{2}[A-Z]{3}\d{2}([A-Z]{3})([A-Z]{3})$/.exec(key);
  return m ? `${m[1]} @ ${m[2]}` : key;
}

// -- numbers ------------------------------------------------------------------

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Dollars: "$157", "$19.6", "$3.47", "$1,240"; null/NaN -> "-". */
export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 100) return `${sign}$${Math.round(a).toLocaleString("en-US")}`;
  return `${sign}$${trimZeros(a.toFixed(2))}`;
}

/** A signed P&L: "+$12.4", "-$3.1", "$0". */
export function fmtSigned(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  if (Math.abs(v) < 0.005) return "$0";
  return `${v > 0 ? "+" : "-"}${fmtUsd(Math.abs(v))}`;
}

/** The sign of a P&L as a tone for the ink: up, dn, or neither. */
export function pnlTone(v: number | null | undefined): "up" | "dn" | null {
  if (v == null || !Number.isFinite(v) || Math.abs(v) < 0.005) return null;
  return v > 0 ? "up" : "dn";
}

/** A contract count, up to 2 decimals (Kalshi counts can be fractional): "30", "29.7". */
export function fmtContracts(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return trimZeros(n.toFixed(2));
}

/** A per-contract price in dollars as cents: 0.375 -> "37.5c". A value over 1 is taken as cents already. */
export function fmtCents(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "-";
  const c = p <= 1 ? p * 100 : p;
  return `${trimZeros(c.toFixed(1))}c`;
}

const ET_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** An ISO time as Eastern "10/21 14:03"; unparseable text comes back as it was. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const p = Object.fromEntries(ET_TIME.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

// -- the headline figures -----------------------------------------------------

export type HealthTone = "ok" | "warn" | "kill";

/** The desk's health in a few words: "killed", the nonzero counts ("2 pending
 *  · 1 unmatched"), else "ok". Order is severity: a kill first, then what is
 *  waiting, then what does not reconcile. */
export function healthWord(view: ComboDeskView): { text: string; tone: HealthTone } {
  const h = view.health;
  if (h.killed) return { text: "killed", tone: "kill" };
  const parts: string[] = [];
  if (h.pending > 0) parts.push(`${h.pending} pending`);
  if (h.unmatched > 0) parts.push(`${h.unmatched} unmatched`);
  if (h.unknown_fills > 0) parts.push(`${h.unknown_fills} unknown fill${h.unknown_fills === 1 ? "" : "s"}`);
  if (h.failed_confirms > 0) parts.push(`${h.failed_confirms} failed confirm${h.failed_confirms === 1 ? "" : "s"}`);
  if (h.errors > 0) parts.push(`${h.errors} error${h.errors === 1 ? "" : "s"}`);
  return parts.length ? { text: parts.join(" · "), tone: "warn" } : { text: "ok", tone: "ok" };
}

/** "$157 / $200": the worst case held against the total-open limit. */
export function riskText(view: ComboDeskView): string {
  return `${fmtUsd(view.exposure.total_open)} / ${fmtUsd(view.limits.total_open)}`;
}

/** Settled P&L: Kalshi's number when it reported one, else the ledger's. */
export function settledPnl(view: ComboDeskView): number {
  return view.pnl.realized_kalshi ?? view.pnl.realized_ledger;
}

/** Positions that are still open. */
export function openCount(view: ComboDeskView): number {
  return view.positions.filter((p) => p.status === "open").length;
}

// -- one position row ---------------------------------------------------------

export type RowStatusKind = "open" | "won" | "lost" | "ledger_only" | "kalshi_only";

export interface PositionRow {
  key: string;
  /** One readable label per leg. */
  legs: string[];
  /** What the held side needs: "NO wins if either misses". */
  held: string;
  contracts: string;
  /** Kalshi's count, only when it differs from the ledger's. */
  contractsKalshi: string | null;
  price: string;
  cost: string;
  /** Kalshi's cost, only when it differs from the ledger's. */
  costKalshi: string | null;
  worst: string;
  status: { kind: RowStatusKind; word: string; pnl: string | null; pnlTone: "up" | "dn" | null };
  agree: boolean;
  note: string | null;
}

/** "NO wins if either misses", "YES wins if both hit", "YES wins if all 3 hit". */
export function heldText(side: "yes" | "no", nLegs: number): string {
  const word = side.toUpperCase();
  if (nLegs <= 1) return `${word} on one leg`;
  if (side === "no") return `${word} wins if ${nLegs === 2 ? "either" : "any"} misses`;
  return `${word} wins if ${nLegs === 2 ? "both" : `all ${nLegs}`} hit`;
}

const differs = (a: number | null, b: number | null, tol: number): boolean => a != null && b != null && Math.abs(a - b) > tol;

function statusOf(p: ComboDeskPosition): PositionRow["status"] {
  if (p.status === "ledger_only") return { kind: "ledger_only", word: "ledger only", pnl: null, pnlTone: null };
  if (p.status === "kalshi_only") return { kind: "kalshi_only", word: "Kalshi only", pnl: null, pnlTone: null };
  if (p.status === "open") return { kind: "open", word: "open", pnl: null, pnlTone: null };
  // settled: the winner is the side that matches the result; with no result, the sign of the pnl
  const won = p.result != null ? p.result === p.side : (p.pnl_kalshi ?? 0) > 0;
  return { kind: won ? "won" : "lost", word: won ? "won" : "lost", pnl: p.pnl_kalshi != null ? fmtSigned(p.pnl_kalshi) : null, pnlTone: pnlTone(p.pnl_kalshi) };
}

export function positionRows(view: ComboDeskView): PositionRow[] {
  return view.positions.map((p) => {
    const legTickers = p.legs.length ? p.legs.map((l) => l.market_ticker) : [p.market_ticker];
    const contracts = p.contracts_ledger ?? p.contracts_kalshi;
    const cost = p.cost_ledger ?? p.cost_kalshi;
    const price = p.price_ledger ?? (cost != null && contracts ? cost / contracts : null);
    return {
      key: p.market_ticker,
      legs: legTickers.map(legLabel),
      held: heldText(p.side, legTickers.length),
      contracts: fmtContracts(contracts),
      contractsKalshi: !p.agree && differs(p.contracts_ledger, p.contracts_kalshi, 0.005) ? fmtContracts(p.contracts_kalshi) : null,
      price: fmtCents(price),
      cost: fmtUsd(cost),
      costKalshi: !p.agree && differs(p.cost_ledger, p.cost_kalshi, 0.005) ? fmtUsd(p.cost_kalshi) : null,
      worst: fmtUsd(p.worst_case),
      status: statusOf(p),
      agree: p.agree,
      note: p.note,
    };
  });
}

// -- exposure -----------------------------------------------------------------

export interface ExposureBar {
  key: string;
  label: string;
  /** Worst case as a share of its cap, 0..100 (a cap of 0 reads 0). */
  pct: number;
  /** "$19.6 / $40". */
  value: string;
  over: boolean;
}

export function exposureBars(
  rows: readonly { key: string; worst_case: number; cap: number }[],
  label: (key: string) => string,
): ExposureBar[] {
  return rows.map((r) => ({
    key: r.key,
    label: label(r.key),
    pct: r.cap > 0 ? Math.max(0, Math.min(100, (100 * r.worst_case) / r.cap)) : 0,
    value: `${fmtUsd(r.worst_case)} / ${fmtUsd(r.cap)}`,
    over: r.cap > 0 && r.worst_case > r.cap,
  }));
}

/** A player exposure key as a name when it has the player shape, else as it came. */
export function exposurePlayerLabel(key: string): string {
  // The desk scopes a player key to its game: "26OCT21ATLORL:ATLJJOHNSON1".
  const seg = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
  return playerLabel(seg) ?? key;
}

// -- kill switch --------------------------------------------------------------

/** The text of a failed kill/unkill: the backend's `detail` (the part after
 *  the " · " getJson adds), else the message without its "Error:" prefix. */
export function killErrorText(message: string): string {
  const i = message.indexOf(" · ");
  return (i >= 0 ? message.slice(i + 3) : message).replace(/^Error:\s*/, "");
}
