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
//   • INITIAL fit (a freshly created terminal, nothing rendered yet) sizes
//     freely to the container — shrink allowed — but still capped.

/** Hard cap on terminal columns: a huge window must not grow the grid to the
 *  whole pane width (→ endless horizontal scroll after the pane narrows). */
export const MAX_TERMINAL_COLS = 160;

/** Output quiet window that ends "actively streaming" — and the delay before
 *  a deferred refit runs after the last output chunk. */
export const STREAM_QUIET_MS = 1500;

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
  // SIGWINCH repaint it triggers races the in-flight frame the same way.
  if (opts.streaming) return { kind: "defer" };

  if (cols > prev.cols) return { kind: "reflow", cols, rows };

  // Height-only, the initial free fit, or the capped legacy shrink
  // (prev.cols > MAX_TERMINAL_COLS from a pre-policy workspace).
  return { kind: "resize", cols, rows };
}
