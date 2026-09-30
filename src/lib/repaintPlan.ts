// THE TURN-END CLEAN REWRITE — the decision, pure so vitest can walk every
// branch without an xterm (SWIT-103; ported from ky-desktop's
// `chat/repaintPlan.ts`, CC-591 + CC-685). `repaintRunner.ts` executes it.
//
// The contract:
//   · THE GRID IS PINNED (terminalGrid.ts). Both numbers are constants the
//     caller passes in; the pane's measured size never enters the decision.
//     A layout change moves the viewport, never the content, and never
//     resizes the PTY.
//   · DURING a turn: touch nothing. claude's live frame is the whole streaming
//     message and it repaints cursor-relative; the callers defer everything.
//   · AT TURN-END IDLE: a FULL clean rewrite of the buffer — serialize →
//     reset → (resize to the pinned grid: a no-op, so no SIGWINCH) → write the
//     snapshot back. A pinned grid removes the reflow that used to mangle
//     history, but not claude's own slips (a repaint a few rows off, a frame
//     drawn at a stale width), and those scars are stamped into scrollback
//     for good. Re-laying the whole buffer from its own serialized form is
//     what keeps one from outliving the turn that made it. It is also the one
//     path back onto the pin if the grid ever drifted off it.
//
// "Dirty" = enough PTY output has landed since the last clean rewrite that the
// buffer may carry streaming scars. A threshold, not a boolean: keystroke
// echoes while typing straight into the TUI also arrive as output, and a full
// rewrite after every typing pause would blink the pane for nothing. A turn
// that can scar the buffer is a streaming TUI frame — far past this number.
//
// THREE GUARDS BEYOND KY'S, none of which can make a rewrite happen that Ky's
// planner would not — each only withholds the destructive path. Ky's terminals
// only ever run claude; ours also run plain shells.
//   · `agent` — the rewrite exists to wipe the scars claude's TUI leaves. A
//     session no agent has drawn in (a shell, a `pnpm dev` log) has none, and
//     rewriting it would blink the pane after every burst of output for
//     nothing. Such a session is "clean" however many bytes it has streamed.
//   · `altScreen` — a full-screen program (vim, less, claude's plan editor)
//     owns the alternate buffer; there is no history to wipe under it and a
//     reset would have to rebuild its screen from a snapshot.
//   · `selecting` — a reset clears the selection, and the settle lands 1.5s
//     after the last byte, which is exactly when someone starts dragging over
//     the answer to copy it.

/** How long the reader's wheel must be quiet before the destructive rewrite
 *  may run. The rewrite's async parse window colliding with a scroll gesture
 *  in progress is the "jumps to the top of the thread" bug: the reset empties
 *  the buffer, the wheel-up lands in a half-written one, and the restore
 *  honours that bogus position. */
export const WHEEL_QUIET_MS = 600;

/** Output bytes since the last clean rewrite before the buffer counts as
 *  possibly-scarred. Small enough that any real streamed turn crosses it,
 *  large enough that a few echoed keystrokes or a cursor nudge don't. */
export const DIRTY_OUTPUT_THRESHOLD = 2048;

export type RepaintDeferWhy =
  | "streaming"
  | "refitting"
  | "not-laid-out"
  | "mid-turn"
  | "alt-screen"
  | "reader-scrolled-up"
  | "wheel-active"
  | "selecting";

export type RepaintPlan =
  /** Not now — the caller sets its pending flag; a later settle, dwell or
   *  layout change retries. */
  | { action: "defer"; why: RepaintDeferWhy }
  /** Grid right, buffer clean — only re-sync the scroll area (the staleness a
   *  hidden terminal comes back with). */
  | { action: "resync" }
  /** The full clean rewrite: serialize whole buffer → reset → resize → write. */
  | { action: "rewrite"; cols: number; rows: number };

export type RepaintInput = {
  /** PTY output is still arriving (the settle timer has not fired). */
  streaming: boolean;
  /** A previous rewrite's async parse is still in flight. */
  refitting: boolean;
  /** The host element is actually laid out (not display:none / zero-size). */
  laidOut: boolean;
  /** The buffer tail shows a working footer or a permission prompt — claude
   *  owns the live frame even though output is quiet. */
  midTurn: boolean;
  /** The alternate buffer is active (a full-screen program owns the screen). */
  altScreen?: boolean;
  /** The terminal's current grid. */
  current: { cols: number; rows: number };
  /** The one grid the terminal ever has (TERMINAL_COLS × TERMINAL_ROWS). */
  pinnedCols: number;
  pinnedRows: number;
  /** PTY output bytes since the last clean rewrite. */
  dirtyBytes: number;
  /** An agent (claude) has drawn in this session. `false` = a plain shell:
   *  its output never counts as dirty. Absent reads as true (Ky's planner). */
  agent?: boolean;
  /** Viewport rows above the bottom; 0 = the reader is at the prompt. */
  readerFromBottom: number;
  /** ms since the reader's wheel last moved. */
  msSinceWheel: number;
  /** Text is selected in the terminal. */
  selecting?: boolean;
};

/** Decide what an idle-time repaint should do. Pure. */
export function planRepaint(input: RepaintInput): RepaintPlan {
  if (input.streaming) return { action: "defer", why: "streaming" };
  if (input.refitting) return { action: "defer", why: "refitting" };
  if (!input.laidOut) return { action: "defer", why: "not-laid-out" };
  if (input.midTurn) return { action: "defer", why: "mid-turn" };
  if (input.altScreen) return { action: "defer", why: "alt-screen" };
  // The pane's measured size is deliberately absent — see the header.
  const dirty = input.agent !== false && input.dirtyBytes >= DIRTY_OUTPUT_THRESHOLD;
  const onPin =
    input.current.cols === input.pinnedCols && input.current.rows === input.pinnedRows;
  if (!dirty && onPin) {
    // Clean buffer, on the pin — nothing a rewrite would fix.
    return { action: "resync" };
  }
  // The destructive path (reset + rewrite blanks the pane for the parse) —
  // never under a reader: a scrolled-up viewport is sacred, a wheel that moved
  // within the last beat races its next tick into the async parse window, and
  // a selection would be lost.
  if (input.readerFromBottom > 0) return { action: "defer", why: "reader-scrolled-up" };
  if (input.msSinceWheel < WHEEL_QUIET_MS) return { action: "defer", why: "wheel-active" };
  if (input.selecting) return { action: "defer", why: "selecting" };
  return { action: "rewrite", cols: input.pinnedCols, rows: input.pinnedRows };
}
