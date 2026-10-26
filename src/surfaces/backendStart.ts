// WHEN A SURFACE ASKS FOR ITS BACKEND (SWIT-154) — the pure half of the host's
// start-on-open. Eric, 2026-10-25: a page whose backend is down should start
// it, not print a command. Rust holds the command and refuses a second start
// while the first is alive (surface_backend.rs); this paces the asks and says
// which card to show.
//
// The ask record is per PROJECT and module-level — ONE instance, shared by
// every host (the panel and a full-width copy of the same page, or two pages
// of one project), so a second host never re-asks inside the first one's
// grace, and a remount after the card does not either. A host that sees the
// backend answer FORGETS the record: the start worked, so the next outage
// asks at once instead of waiting out a retry window it has no reason to.

/** How long "starting…" shows before the card says the start did not take. A
 *  cold `pnpm backend` (Docker check + uvicorn import) answered in ~27 s on
 *  2026-10-25. */
export const BACKEND_START_GRACE_MS = 90_000;
/** The earliest a host asks again after a start that never answered (or was
 *  refused). Longer than the grace, so a failed start is shown before it is
 *  retried. */
export const BACKEND_START_RETRY_MS = 120_000;

export type BackendView = "unknown" | "up" | "starting" | "down";

type Ask = { at: number; failed: boolean };
const asks = new Map<string, Ask>();

/** Ask now? Yes when this project has no record, or not within the retry. */
export function shouldAskStart(project: string, now: number): boolean {
  const last = asks.get(project);
  return last === undefined || now - last.at >= BACKEND_START_RETRY_MS;
}

export function noteAsked(project: string, now: number): void {
  asks.set(project, { at: now, failed: false });
}

/** The ask was refused (no start for the project, no registry repo, no Tauri):
 *  nothing is starting, so the card says "down" now — and the retry window
 *  still holds, so a refusal is not re-asked on every 5 s probe. */
export function noteAskFailed(project: string): void {
  const last = asks.get(project);
  if (last) asks.set(project, { ...last, failed: true });
}

/** The backend answered: whatever was asked is over. */
export function forgetAsk(project: string): void {
  asks.delete(project);
}

/** When a start that may still be coming up was asked, else null. */
export function pendingAskAt(project: string): number | null {
  const last = asks.get(project);
  return last && !last.failed ? last.at : null;
}

/** The card after a MISS: none yet below the miss limit (a restarting
 *  backend blinks), "starting" inside the grace of a live ask, else "down". */
export function viewAfterMiss(misses: number, missLimit: number, pendingAsk: number | null, now: number): BackendView | null {
  if (misses < missLimit) return null;
  if (pendingAsk !== null && now - pendingAsk < BACKEND_START_GRACE_MS) return "starting";
  return "down";
}

/** Tests only. */
export function resetBackendAsks(): void {
  asks.clear();
}
