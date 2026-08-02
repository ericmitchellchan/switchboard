// Tab → thread promotion (increment C).
//
// THE GAP: today a thread exists only if it was created via `+ new thread`. A
// conversation started by typing `claude` into a plain Ctrl+T tab is ORPHANED —
// no row, no revive chip, and after an app restart it is unrecoverable unless
// the session uuid happens to be known. This module closes that: the moment a
// claude conversation is running in ANY tab, that tab gets a thread record and
// becomes revivable.
//
// Division of labour:
//   · Rust (discovery.rs) answers "which tab is running which conversation",
//     exactly, and REFUSES rather than guesses when a tab or a conversation is
//     ambiguous. It observes a process snapshot; it never types.
//   · This module answers "what does that mean for the thread list" — create,
//     bind, adopt, or leave alone — and is pure (planPromotion) so every one of
//     those branches is unit-tested.
//   · App owns the interval and hands the effects in.
//
// The whole path is OBSERVE-ONLY. There is no writeToSession here, and there
// must never be: promotion notices a conversation, it does not start one.

import type { Thread } from "../types";
import type { ClaudeDiscovery } from "./ipc";

/** How often unbound tabs are checked. Promotion is not latency-critical (the
 *  spec's bar is "within a few seconds"), and each pass is one process
 *  snapshot plus a small directory read, so this is deliberately lazy. */
export const PROMOTION_POLL_MS = 4000;

/** The one skip reason that is the STEADY STATE rather than a surprise. It
 *  recurs on every pass for every bound tab, so it is the only skip that must
 *  not be logged — a named constant because the log filter compares on it. */
export const ALREADY_BOUND = "already bound";

export type PromotionPlan =
  /** Nothing to do — already bound to this conversation, or too ambiguous to
   *  act on. `reason` is logged. */
  | { kind: "skip"; reason: string }
  /** No record for this conversation and none for this tab: promote. */
  | { kind: "create"; discovery: ClaudeDiscovery }
  /** A record for this conversation exists but isn't bound to a live tab —
   *  the thread found its tab again (e.g. a revive whose binding was severed).
   *  Bind, don't duplicate. */
  | { kind: "bind"; threadId: string; discovery: ClaudeDiscovery }
  /** This tab already has a thread, but claude is now running a DIFFERENT
   *  conversation in it (claude restarted). Update the existing record. */
  | { kind: "adopt"; threadId: string; discovery: ClaudeDiscovery };

/** Decide what one discovery means for the current thread list.
 *
 *  `liveSessionIds` is the set of tabs that still exist — a thread whose
 *  sessionId points at a closed tab is NOT considered bound, otherwise a
 *  conversation could never find its way back to a row.
 *
 *  The IDEMPOTENCY rule lives here: every branch either touches one existing
 *  record or creates exactly one. There is no path that produces a second
 *  record for a tab or for a conversation. */
export function planPromotion(
  discovery: ClaudeDiscovery,
  threads: readonly Thread[],
  liveSessionIds: ReadonlySet<string>
): PromotionPlan {
  const byUuid = threads.find((t) => t.chatSessionId === discovery.chatSessionId);
  const bySession = threads.find((t) => t.sessionId === discovery.sessionId);

  if (byUuid && bySession) {
    if (byUuid.id === bySession.id) {
      // The common steady state: an explicitly-created thread whose launch
      // line claude honoured, or a promoted thread seen again on a later pass.
      return { kind: "skip", reason: ALREADY_BOUND };
    }
    // This tab belongs to thread A while the conversation belongs to thread B.
    // Either answer would be a guess, and a wrong one re-points a row at
    // someone else's history — refuse, exactly like the Rust side does.
    return {
      kind: "skip",
      reason: `tab ${discovery.sessionId} is thread ${bySession.id} but conversation ${discovery.chatSessionId} is thread ${byUuid.id} — leaving both alone`,
    };
  }

  if (byUuid) {
    // The conversation has a record; the tab has none.
    if (byUuid.sessionId && liveSessionIds.has(byUuid.sessionId)) {
      // …but that record is bound to a DIFFERENT live tab. Stealing it would
      // move the row off a tab that is still on screen.
      return {
        kind: "skip",
        reason: `conversation ${discovery.chatSessionId} is already bound to live tab ${byUuid.sessionId}`,
      };
    }
    return { kind: "bind", threadId: byUuid.id, discovery };
  }

  if (bySession) {
    // The tab has a record under a different uuid — claude restarted here.
    return { kind: "adopt", threadId: bySession.id, discovery };
  }

  return { kind: "create", discovery };
}

/** Effects a promotion pass needs. Injected so the pass is testable under Node
 *  without Tauri, React or a real thread store. */
export type PromotionEffects = {
  /** Tabs to consider. Returns every LIVE session id plus whether each is
   *  already bound to a thread. */
  liveSessionIds: () => string[];
  threads: () => readonly Thread[];
  discover: (sessionIds: string[]) => Promise<ClaudeDiscovery[]>;
  /** Disk ground truth — does this conversation have a transcript?
   *  `chatStarted` is set from THIS, never assumed: a discovered conversation
   *  that already wrote a transcript IS started. */
  chatStartedOnDisk: (workingDir: string, chatSessionId: string) => Promise<boolean>;
  createThread: (args: {
    title: string;
    workingDir: string;
    chatSessionId: string;
    chatStarted: boolean;
    sessionId: string;
    /** claude's own launch time — becomes the record's createdAt. */
    startedAt: number;
  }) => string;
  bindThread: (threadId: string, sessionId: string) => void;
  adoptThread: (threadId: string, chatSessionId: string, chatStarted: boolean) => void;
  markLaunched: (threadId: string) => void;
  persist: () => void;
  defaultTitle: (repoName: string) => string;
  repoName: (workingDir: string) => string;
  log: (message: string) => void;
};

/** True when a pass is worth running at all: some live tab has no thread.
 *
 *  This is the "stop polling when nothing is unbound" rule. When every tab is
 *  bound the tick costs ZERO IPC — no snapshot, no file reads. (A pass that
 *  does run still asks about every tab, since it is one snapshot either way,
 *  which is what makes the claude-restarted-in-a-bound-tab case free.) */
export function shouldRunPromotionPass(
  liveSessionIds: readonly string[],
  threads: readonly Thread[]
): boolean {
  if (liveSessionIds.length === 0) return false;
  const bound = new Set<string>();
  for (const t of threads) if (t.sessionId) bound.add(t.sessionId);
  return liveSessionIds.some((id) => !bound.has(id));
}

/** Run one promotion pass. Returns the number of records created/updated
 *  (0 on a no-op pass), which the caller uses only for logging. */
export async function runPromotionPass(fx: PromotionEffects): Promise<number> {
  const sessionIds = fx.liveSessionIds();
  if (!shouldRunPromotionPass(sessionIds, fx.threads())) return 0;

  let discoveries: ClaudeDiscovery[];
  try {
    discoveries = await fx.discover(sessionIds);
  } catch (err) {
    // A failed snapshot is a skipped pass, never a thrown interval.
    fx.log(`Claude discovery failed: ${err}`);
    return 0;
  }
  if (discoveries.length === 0) return 0;

  // Re-read live ids AFTER the await: a tab can close mid-pass, and binding a
  // thread to a tab that no longer exists would leave an unclickable row.
  const liveNow = new Set(fx.liveSessionIds());
  let changed = 0;

  for (const d of discoveries) {
    if (!liveNow.has(d.sessionId)) continue;
    // Re-read threads each iteration: an earlier discovery in this same pass
    // may have created the record a later one would otherwise duplicate.
    const plan = planPromotion(d, fx.threads(), liveNow);
    if (plan.kind === "skip") {
      // "already bound" is the steady state on every pass — not worth a line.
      if (plan.reason !== ALREADY_BOUND) fx.log(`Promotion skipped: ${plan.reason}`);
      continue;
    }

    // Only the branches that WRITE a conversation id need the transcript
    // check; "bind" keeps the record's existing uuid and hint untouched.
    let chatStarted = false;
    if (plan.kind === "create" || plan.kind === "adopt") {
      try {
        chatStarted = await fx.chatStartedOnDisk(d.cwd, d.chatSessionId);
      } catch (err) {
        // Ground truth unavailable — record the conversation anyway with the
        // conservative hint. Revive re-checks disk at launch time, so a wrong
        // hint here costs nothing; NOT recording the thread would cost the
        // orphan case this whole feature exists to fix.
        fx.log(`Ground truth unavailable for ${d.chatSessionId}: ${err}`);
        chatStarted = false;
      }
    }

    switch (plan.kind) {
      case "create": {
        const title = fx.defaultTitle(fx.repoName(d.cwd));
        const threadId = fx.createThread({
          title,
          workingDir: d.cwd,
          chatSessionId: d.chatSessionId,
          chatStarted,
          sessionId: d.sessionId,
          startedAt: d.startedAt,
        });
        fx.markLaunched(threadId);
        fx.log(
          `Promoted tab ${d.sessionId} to thread ${threadId} (conversation ${d.chatSessionId}, cwd ${d.cwd}, started=${chatStarted})`
        );
        changed++;
        break;
      }
      case "bind": {
        fx.bindThread(plan.threadId, d.sessionId);
        fx.markLaunched(plan.threadId);
        fx.log(`Rebound thread ${plan.threadId} to tab ${d.sessionId}`);
        changed++;
        break;
      }
      case "adopt": {
        fx.adoptThread(plan.threadId, d.chatSessionId, chatStarted);
        fx.markLaunched(plan.threadId);
        fx.log(
          `Thread ${plan.threadId} adopted restarted conversation ${d.chatSessionId}`
        );
        changed++;
        break;
      }
    }
  }

  if (changed > 0) fx.persist();
  return changed;
}
