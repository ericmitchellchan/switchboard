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
// xterm: the grid on screen does not change, so nothing reflows and the
// resize policy is not involved. It is the one deliberate SIGWINCH, sent at a
// moment the policy would also allow — output quiet, and the screen shows
// claude at rest.
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
  void bouncePtyRows(sessionId, term);
}

/** rows-1, a beat, rows — claude repaints its whole frame at the true grid on
 *  the way back. The grid is re-read for the second leg: a fit may have
 *  landed in between, and the PTY must end on what xterm actually shows. */
async function bouncePtyRows(sessionId: string, before: ResumeHealTerminal): Promise<void> {
  if (!io) return;
  try {
    await io.resizePty(sessionId, before.cols, Math.max(1, before.rows - 1));
  } catch (err) {
    // Leg 1 never landed: the PTY is still at its true size. Nothing to undo.
    log.warn(`resumeHeal: bounce failed id=${sessionId}: ${err}`);
    return;
  }
  await new Promise((r) => setTimeout(r, RESUME_HEAL_BOUNCE_GAP_MS));
  // Leg 2 is skipped only when the terminal itself is gone. A live PTY left a
  // row short clips claude's frame until the next real grid change (xterm's
  // onResize fires on a change only), so a failed restore is tried once more.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const after = io.getTerminal(sessionId);
    if (!after) return;
    try {
      await io.resizePty(sessionId, after.cols, after.rows);
      return;
    } catch (err) {
      log.warn(`resumeHeal: restore leg failed id=${sessionId} attempt=${attempt}: ${err}`);
    }
  }
}

/** Test-only: forget everything. */
export function __resetResumeHealForTests(): void {
  for (const id of [...sessions.keys()]) forgetResumeHeal(id);
  io = null;
}
