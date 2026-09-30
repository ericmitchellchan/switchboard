// HOME'S ROLL-UP RULES — pure. Home (components/Home.tsx) has no content of
// its own: every block is a view over the threads' page files, and the rules
// that decide WHAT a block lists live here, tested, so the component only
// draws.
//
// OLD QUESTIONS FOLD (SWIT-105). Needs you listed every open question of
// every thread that was not archived, so a question asked a month ago by a
// thread nobody has opened since sat at the top of Home forever, above
// today's. Now: questions from threads ACTIVE IN THE LAST 14 DAYS are
// listed; the rest sit behind ONE `N older questions · show` fold. "Active"
// is read generously — a thread is recent when it is live right now, or
// when the newest sign of life we have is inside the window: the record's
// own `lastActivityAt` (bound / revived / first turn), its page's latest
// turn, or the newest of its open questions. A long-running thread whose
// record stamp is old but whose agent asked yesterday is therefore recent.

import type { Thread } from "../types";
import type { RenderedPage } from "./pageStore";

/** How far back "active" reaches for Needs you's questions. */
export const NEEDS_YOU_RECENT_DAYS = 14;
const DAY_MS = 86_400_000;

type ThreadStamps = Pick<Thread, "lastActivityAt" | "createdAt">;
type PageStamps = Pick<RenderedPage, "latestTurn" | "openQuestions">;

/** The newest sign of life for a thread, in ms: the record's stamps, its
 *  page's latest turn, the newest of its open questions. Unparseable page
 *  stamps are ignored; 0 when nothing is known. Pure. */
export function threadLastActive(thread: ThreadStamps, page: PageStamps): number {
  let last = Math.max(thread.lastActivityAt || 0, thread.createdAt || 0);
  const stamps = [page.latestTurn?.at, ...page.openQuestions.map((q) => q.askedAt)];
  for (const s of stamps) {
    const t = Date.parse(s ?? "");
    if (Number.isFinite(t) && t > last) last = t;
  }
  return last;
}

/** Is the thread recent enough for its questions to be listed? Live now, or
 *  last active within the window (a stamp in the future — clock skew — is
 *  recent). Pure. */
export function isThreadRecent(
  lastActive: number,
  live: boolean,
  now: number,
  days: number = NEEDS_YOU_RECENT_DAYS
): boolean {
  return live || now - lastActive <= days * DAY_MS;
}

/** The ids of the threads whose questions FOLD on Home — not live, and no
 *  sign of life inside the window. Pure. */
export function olderThreadIds(
  digests: readonly { thread: ThreadStamps & Pick<Thread, "id">; page: PageStamps }[],
  launched: ReadonlySet<string>,
  now: number
): Set<string> {
  const out = new Set<string>();
  for (const d of digests) {
    if (!isThreadRecent(threadLastActive(d.thread, d.page), launched.has(d.thread.id), now)) out.add(d.thread.id);
  }
  return out;
}

/** The fold's words (PageBlock.Fold prints `<count> <label> · show`). */
export function olderQuestionsLabel(n: number): string {
  return n === 1 ? "older question" : "older questions";
}
