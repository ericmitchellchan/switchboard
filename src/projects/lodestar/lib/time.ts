/**
 * Time helpers. Store/bar timestamps are naive UTC ("2026-03-08 22:07:00" / "…T22:07:00").
 * The owner trades from Pacific, so surfaces show the current (UTC) time AND Pacific.
 */

function parseUtc(ts: string): Date {
  const s = ts.replace(" ", "T");
  // Naive stamps get a Z; ones that already carry a designator (Z or ±HH:MM — FastAPI emits
  // "+00:00" for tz-aware values) are parsed as-is. Appending Z to those yields Invalid Date.
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
}

const PT = "America/Los_Angeles";

/** Pacific time, 24h "14:07". */
export function ptTime(ts: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: PT, hour: "2-digit", minute: "2-digit", hour12: false }).format(parseUtc(ts));
}

/** Pacific weekday, "Sun". */
export function ptWeekday(ts: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: PT, weekday: "short" }).format(parseUtc(ts));
}

/** UTC HH:mm straight from a naive-UTC ts (what we already show). */
export function utcTime(ts: string): string {
  return ts.slice(11, 16);
}

const ET = "America/New_York";

/** Exchange time, 24h "09:30" — the frame RTH boundaries are defined in. */
export function etTime(ts: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", hour12: false }).format(parseUtc(ts));
}

/** Pacific calendar date, "2026-03-08" — the trading day as the owner sees it. */
export function ptDate(ts: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit" });
  return p.format(parseUtc(ts));
}

/** "22:07 UTC · 14:07 PT" — current time kept, Pacific added alongside. */
export function dualTime(ts: string): string {
  return `${utcTime(ts)} UTC · ${ptTime(ts)} PT`;
}
