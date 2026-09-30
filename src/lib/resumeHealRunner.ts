// RESUMED-SESSION HEAL, the imperative half (SWIT-100). The rule is
// `resumeHeal.planResumeHeal`; this module holds the per-session clock and
// sends the bounce.
//
// Fed from TerminalPane's registry-dispatched `onOutput` hook, so it works for
// hidden panes too (a thread revived and then switched away from still
// heals). Costs nothing for a session that was never marked: the note
// function returns on a Map miss.
//
// The bounce goes STRAIGHT to the PTY (`resize_session`), never through
// xterm: the grid on screen does not change, so nothing reflows. Since the
// grid was pinned (SWIT-103) a rows-only bounce is the ONLY thing that ever
// resizes a PTY — this heal and the narrow-frame nudge (repaintRunner) share
// `bouncePtyRows` below, one at a time per session.
//
// IO is injected (TerminalPane configures it once at module load) so this
// file imports no xterm and vitest can drive the clock with fakes.

import { log } from "./logger";
import {
  RESUME_HEAL_BOUNCE_GAP_MS,
  RESUME_HEAL_SETTLE_MS,
  claudeDrewAfterLaunch,
  midTurnOnScreen,
  planResumeHeal,
  resumeHealOpen,
  type TerminalTail,
} from "./resumeHeal";

export type ResumeHealTerminal = TerminalTail & { cols: number };

export type ResumeHealIO = {
  /** The session's live xterm, or undefined once it is disposed. */
  getTerminal: (sessionId: string) => ResumeHealTerminal | undefined;
  /** Resize the PTY only. */
  resizePty: (sessionId: string, cols: number, rows: number) => Promise<void>;
};

let io: ResumeHealIO | null = null;

export function configureResumeHealIO(next: ResumeHealIO | null): void {
  io = next;
}

type HealState = {
  firstOutputAt: number;
  bounces: number;
  lastBounceAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const sessions = new Map<string, HealState>();

/** A `claude --resume` launch line is about to be typed into this session.
 *  Called by App at the launch seam; a second launch in the same session
 *  (relaunch with page tools, a revive) starts a fresh window. */
export function markSessionResumed(sessionId: string): void {
  forgetResumeHeal(sessionId);
  sessions.set(sessionId, { firstOutputAt: 0, bounces: 0, lastBounceAt: 0, timer: null });
  log.debug(`resumeHeal: armed id=${sessionId}`);
}

/** Drop the session's heal state — session closed, exited, restarted in
 *  place, or the window ran out. */
export function forgetResumeHeal(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  sessions.delete(sessionId);
}

/** Every PTY chunk: stamp the first output and push the settle out. */
export function noteResumeHealOutput(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  const now = Date.now();
  if (!state.firstOutputAt) state.firstOutputAt = now;
  if (!resumeHealOpen({ firstOutputAt: state.firstOutputAt, now, bounces: state.bounces })) {
    forgetResumeHeal(sessionId);
    return;
  }
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => settle(sessionId), RESUME_HEAL_SETTLE_MS);
}

function settle(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  state.timer = null;
  const term = io?.getTerminal(sessionId);
  if (!term) return;
  const now = Date.now();
  const verdict = planResumeHeal({
    firstOutputAt: state.firstOutputAt,
    now,
    bounces: state.bounces,
    lastBounceAt: state.lastBounceAt,
    drawn: claudeDrewAfterLaunch(term),
    midTurn: midTurnOnScreen(term),
  });
  if (!verdict.bounce) {
    // The log is how this bug gets diagnosed — every refusal, resumed
    // sessions only.
    log.info(`resumeHeal: skip id=${sessionId} why=${verdict.why}`);
    return;
  }
  state.bounces += 1;
  state.lastBounceAt = now;
  log.info(`resumeHeal: bounce ${state.bounces} id=${sessionId} sinceFirstOutput=${now - state.firstOutputAt}ms`);
  bouncePtyRows(sessionId, "resume-heal");
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ROWS-ONLY PTY BOUNCE — shared by this heal and the narrow-frame nudge
// (repaintRunner, SWIT-103). rows-1, a beat, rows: claude repaints its whole
// frame at the true grid on the way back, and xterm is never touched. With the
// grid pinned this is the only PTY resize the app ever sends.
// ─────────────────────────────────────────────────────────────────────────────

/** Sessions with a bounce in flight — a second request is dropped, not
 *  stacked: both callers want the same repaint, and two overlapping bounces
 *  (rows-1, rows-1, rows, rows) are one repaint bought with four resizes. */
const bouncing = new Set<string>();
/** When each session's PTY was last bounced, by either caller. */
const lastBounce = new Map<string, number>();

/** When this session's PTY was last bounced (0 = never). The narrow-frame
 *  nudge reads it so a heal bounce counts against its own 30 s floor. */
export function lastPtyBounceAt(sessionId: string): number {
  return lastBounce.get(sessionId) ?? 0;
}

/** Drop the session's bounce record (session closed or restarted in place). */
export function forgetPtyBounce(sessionId: string): void {
  lastBounce.delete(sessionId);
}

/** Bounce the session's PTY rows. Returns false when nothing was sent: no IO,
 *  no live terminal, or a bounce already in flight. Never rejects. */
export function bouncePtyRows(sessionId: string, cause: string): boolean {
  const before = io?.getTerminal(sessionId);
  if (!io || !before) return false;
  if (bouncing.has(sessionId)) {
    log.info(`ptyBounce: skip id=${sessionId} cause=${cause} why=in-flight`);
    return false;
  }
  bouncing.add(sessionId);
  lastBounce.set(sessionId, Date.now());
  void runBounce(sessionId, before, cause).finally(() => bouncing.delete(sessionId));
  return true;
}

async function runBounce(sessionId: string, before: ResumeHealTerminal, cause: string): Promise<void> {
  if (!io) return;
  try {
    await io.resizePty(sessionId, before.cols, Math.max(1, before.rows - 1));
  } catch (err) {
    // Leg 1 never landed: the PTY is still at its true size. Nothing to undo.
    log.warn(`ptyBounce: bounce failed id=${sessionId} cause=${cause}: ${err}`);
    return;
  }
  await new Promise((r) => setTimeout(r, RESUME_HEAL_BOUNCE_GAP_MS));
  // Leg 2 is skipped only when the terminal itself is gone. With the grid
  // pinned nothing layout-driven will ever correct a PTY left a row short, so
  // a failed restore is tried once more.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const after = io?.getTerminal(sessionId);
    if (!io || !after) return;
    try {
      await io.resizePty(sessionId, after.cols, after.rows);
      return;
    } catch (err) {
      log.warn(`ptyBounce: restore leg failed id=${sessionId} cause=${cause} attempt=${attempt}: ${err}`);
    }
  }
}

/** Test-only: forget everything. */
export function __resetResumeHealForTests(): void {
  for (const id of [...sessions.keys()]) forgetResumeHeal(id);
  bouncing.clear();
  lastBounce.clear();
  io = null;
}
