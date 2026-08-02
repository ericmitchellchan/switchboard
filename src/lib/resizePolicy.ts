// Resize decision policy for terminal sessions — pure logic, Node-testable.
// Ported from ky-desktop's ChatTerminal refit (the settled fix for resize
// text duplication), adapted to Switchboard's N-sessions model: the decision
// is pure and per-call; per-session runtime state (streaming timestamps,
// pending-refit flags) lives in fitQueue.ts keyed by session id.
//
// Why this policy exists — the root cause it prevents:
// On a WIDTH change, the old refit path let fitAddon.fit() shrink/grow cols
// freely. xterm's reflow moves the line count, while the PTY resize (SIGWINCH)
// makes claude's TUI repaint its live frame ASYNCHRONOUSLY, tens of ms later,
// with cursor-relative erase sequences sized to a screen state that no longer
// exists — stamping a duplicated, misaligned copy of the live frame into
// scrollback that nothing ever heals (claude only repaints the LIVE frame,
// history is write-once). This repo's known issues "viewport scroll desync"
// and "text duplication on resize" are that bug.
//
// The policy:
//   • GROW-ONLY WIDTH, capped at MAX_TERMINAL_COLS. A narrower pane NEVER
//     re-wraps — cols are kept and the pane host horizontal-scrolls instead
//     (overflow-x: auto in TerminalPane). Rows always follow the pane.
//   • WIDEN → "reflow": snapshot → reset → resize → write(snapshot), with the
//     viewport restored in the write CALLBACK (xterm's parse is async).
//   • HEIGHT-ONLY (or the capped-legacy shrink) → "resize": resize() only, no
//     snapshot, no reflow, no conflict window.
//   • MID-STREAM → "defer": while the session is actively streaming output,
//     any grid change waits for ~1.5s of quiet (a reflow against an
//     in-flight repaint is exactly the duplication bug).
//   • AGENT BUSY → "defer" too, and for LONGER. See below.
//   • INITIAL fit (a freshly created terminal, nothing rendered yet) sizes
//     freely to the container — shrink allowed — but still capped.
//
// WHY "BUSY" EXISTS ON TOP OF "STREAMING" (2026-08-02, Eric, driving the app):
// output recency alone is the physically-correct signal but its window is only
// STREAM_QUIET_MS. A working agent is not a solid wall of output — claude
// pauses between a tool call and the next frame — so a 1.5s gap in the middle
// of a long run let a queued refit through, and the TUI repainted its live
// frame on top of the reflowed grid a moment later. That is the mangled text
// Eric sees when he opens a panel or resizes the window mid-run.
//
// So the grid is FROZEN for the whole time the agent is working, exactly as he
// asked ("whenever a session is thinking or working, it's fixed... it doesn't
// resize until it's completely done"). `busy` is fed from the status detector's
// RUNNING state (fitQueue.noteSessionStatus) and defers on its own.
//
// THE SAFETY VALVE, and why it is safe: a status detector that wedges in
// RUNNING would otherwise freeze a terminal's grid forever. So a deferred
// refit still runs after BUSY_QUIET_MS of TOTAL SILENCE even while busy. That
// cannot reintroduce the bug — the duplication needs a repaint IN FLIGHT, and
// 30 seconds without a single PTY byte means nothing is in flight. A genuinely
// working claude renders a spinner continuously and never reaches it.

/** Hard cap on terminal columns: a huge window must not grow the grid to the
 *  whole pane width (→ endless horizontal scroll after the pane narrows). */
export const MAX_TERMINAL_COLS = 160;

/** Output quiet window that ends "actively streaming" — and the delay before
 *  a deferred refit runs after the last output chunk. */
export const STREAM_QUIET_MS = 1500;

/** Quiet window a deferred refit must see before it runs ANYWAY while the
 *  agent still reads as busy — the wedged-detector safety valve described in
 *  the header. Long enough that a working agent never reaches it, short enough
 *  that a stuck RUNNING state costs half a minute rather than the session. */
export const BUSY_QUIET_MS = 30_000;

export interface GridSize {
  cols: number;
  rows: number;
}

export type ResizeAction =
  /** Grid is already right (or the proposal is unusable) — do nothing. */
  | { kind: "none" }
  /** A grid change is needed but the session is actively streaming — set the
   *  pending-refit flag and re-run when output settles. */
  | { kind: "defer" }
  /** Apply with a plain resize(): height-only change, or the rare capped
   *  shrink of a legacy >MAX_TERMINAL_COLS grid. No reflow. */
  | { kind: "resize"; cols: number; rows: number }
  /** Width grew: snapshot → reset → resize → write(snapshot, cb) so the PTY's
   *  async SIGWINCH repaint lands on content that matches its cursor model. */
  | { kind: "reflow"; cols: number; rows: number };

export interface ResizeDecisionOpts {
  /** Session produced PTY output within the last STREAM_QUIET_MS. */
  streaming: boolean;
  /** The agent in this session is THINKING OR WORKING (statusDetector's
   *  RUNNING). Independent of `streaming`: a working agent goes quiet between
   *  frames, and those gaps are exactly where a refit used to slip through. */
  busy?: boolean;
  /** First fit of a freshly created terminal (nothing rendered yet): size
   *  freely to the container — shrink allowed, no reflow needed — but capped. */
  initial?: boolean;
}

/**
 * Decide what a fit should do, given the current grid, the container-proposed
 * grid (fitAddon.proposeDimensions()), and whether output is streaming.
 */
export function resizeDecision(
  prev: GridSize,
  proposed: GridSize | null | undefined,
  opts: ResizeDecisionOpts
): ResizeAction {
  // Unusable proposal: hidden/zero-size container (proposeDimensions returns
  // undefined or NaN/0 dims when the terminal isn't measurable).
  if (
    !proposed ||
    !Number.isFinite(proposed.cols) ||
    !Number.isFinite(proposed.rows) ||
    proposed.cols <= 0 ||
    proposed.rows <= 0
  ) {
    return { kind: "none" };
  }

  const rows = proposed.rows;
  const cols = opts.initial
    ? Math.min(MAX_TERMINAL_COLS, proposed.cols)
    : Math.min(MAX_TERMINAL_COLS, Math.max(prev.cols, proposed.cols));

  if (cols === prev.cols && rows === prev.rows) return { kind: "none" };

  // Initial fit: nothing is rendered yet, so a plain resize is always safe —
  // no reflow conflict to defer around, even if restore output just flushed.
  if (opts.initial) return { kind: "resize", cols, rows };

  // Any genuine grid change mid-stream is deferred — even rows-only: the
  // SIGWINCH repaint it triggers races the in-flight frame the same way. And
  // any grid change while the agent is WORKING is deferred for the whole run,
  // not just for the current burst (see the header).
  if (opts.streaming || opts.busy) return { kind: "defer" };

  if (cols > prev.cols) return { kind: "reflow", cols, rows };

  // Height-only, the initial free fit, or the capped legacy shrink
  // (prev.cols > MAX_TERMINAL_COLS from a pre-policy workspace).
  return { kind: "resize", cols, rows };
}
