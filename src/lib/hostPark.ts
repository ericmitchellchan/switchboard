// WHERE THE PANE SITS OVER THE FIXED GRID (SWIT-103) — pure geometry, tested.
//
// The grid is 100×40 for good (terminalGrid.ts), so a pane SHORTER than 40
// rows has two vertical scrollers: xterm's own (history) and the host's (which
// 40-row slice of the screen the pane shows). Ky parks the host at its true
// bottom — right for a claude whose frame has filled the screen, and the only
// case Ky's terminals have. Ours also start as a plain shell whose prompt is
// on ROW 1 of an otherwise empty screen, and a pane parked at the bottom of
// that shows nothing at all. So the host parks on the CONTENT's bottom — the
// lower of the cursor row and the last row holding text, plus a row of air —
// which is the true bottom once the screen is full and the top while it is
// nearly empty.
//
// The rules, all here (terminalRegistry applies them to the live DOM):
//   · `parkTarget` — the scrollTop that puts the content's bottom at the
//     pane's bottom edge. Used on show / adopt / user input (an explicit park;
//     `isTypedInput` says which input counts).
//   · `followScrollTop` — what new output does to a pane that is FOLLOWING:
//     down at once when content went below the fold; up only once output has
//     settled AND the content collapsed by more than FOLLOW_UP_ROWS (a
//     `clear`), so a claude frame that grows and shrinks by a spinner line —
//     or is caught half-redrawn — does not rock the pane.
//   · `isFollowing` — the pane still holds the content's bottom; a reader who
//     scrolled the pane up to look at the top of the screen is not followed.
// Plus Ky's wheel routing (`routeWheelToHost`, CC-689): one continuous scroll
// across the two scrollers.

export type HostGeometry = {
  /** The host's scroll range. */
  scrollHeight: number;
  clientHeight: number;
  /** css px per grid row; 0 = the renderer has not measured yet. */
  rowHeight: number;
  /** The cursor's row within the screen (0-based). */
  cursorY: number;
  /** The last screen row holding any text (0-based); −1 = an empty screen. */
  lastContentRow: number;
};

/** Rows of air kept under the content's bottom. */
export const PARK_MARGIN_ROWS = 1;

/** How far (rows) the content's bottom must rise before a following pane
 *  scrolls UP to it. */
export const FOLLOW_UP_ROWS = 8;

/** The scrollTop that shows the content's bottom, or null when there is
 *  nothing to park: the pane fits the grid (no slack) or the row height is
 *  not measured yet. */
export function parkTarget(g: HostGeometry): number | null {
  const slack = g.scrollHeight - g.clientHeight;
  if (!(slack > 1) || !(g.rowHeight > 0)) return null;
  const bottomRow = Math.max(g.cursorY, g.lastContentRow, 0);
  const contentBottom = (bottomRow + 1 + PARK_MARGIN_ROWS) * g.rowHeight;
  return Math.max(0, Math.min(slack, Math.ceil(contentBottom - g.clientHeight)));
}

/** The pane is following: where it should sit now.
 *
 *  DOWN at once, always — content went below the fold. UP only when `settled`
 *  (output has been quiet: the turn-end settle, or a pane resize) AND the
 *  content's bottom rose by more than FOLLOW_UP_ROWS. Mid-stream the content's
 *  bottom is not a fact yet: a TUI erases below its cursor and redraws, and a
 *  frame caught between the two reads as a collapse — following it up and
 *  back down would rock the pane on every repaint. */
export function followScrollTop(
  target: number,
  scrollTop: number,
  rowHeight: number,
  settled: boolean
): number {
  if (target > scrollTop) return target;
  if (settled && scrollTop - target > FOLLOW_UP_ROWS * rowHeight) return target; // a clear
  return scrollTop;
}

/** Does the pane still hold the content's bottom? False once the reader has
 *  scrolled the pane up past it by more than a row. */
export function isFollowing(target: number, scrollTop: number, rowHeight: number): boolean {
  return scrollTop >= target - rowHeight;
}

/** Is this `onData` chunk the user TYPING — the thing that takes the pane to
 *  the prompt? xterm's onData also carries what the terminal itself answers
 *  (focus in/out reports when the program asked for them, mouse reports,
 *  cursor-position replies) and pastes; none of those is a reason to move the
 *  pane — a click into the terminal must not yank a reader who scrolled the
 *  pane up. Every one of them is an ESC-led sequence, and so are arrow and
 *  function keys, which are left out with them: the next printable key,
 *  Enter, Backspace or Ctrl+key parks. */
export function isTypedInput(data: string): boolean {
  const typed = data.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, "");
  return typed.length > 0 && typed.charCodeAt(0) !== 0x1b;
}

export type WheelRoute = {
  deltaY: number;
  /** The host's scroll range (scrollHeight − clientHeight) and position. */
  slack: number;
  scrollTop: number;
  /** xterm's own viewport is at the bottom of its history. */
  xtermAtBottom: boolean;
};

/** ONE scroll over the fixed grid (Ky CC-689). xterm eats every wheel tick, so
 *  on a pane shorter than the grid the wheel never reached the bottom rows —
 *  claude's input box. Route: wheel-DOWN runs xterm's history until its
 *  viewport is at the bottom, THEN moves the pane down; wheel-UP moves the
 *  pane up while it has room, THEN xterm's history. Returns the host's new
 *  scrollTop when the host takes the tick (the caller then swallows the
 *  event), else null — xterm handles it. A pane that fits the grid has no
 *  slack and never takes one. */
export function routeWheelToHost(w: WheelRoute): number | null {
  if (!(w.slack > 1) || w.deltaY === 0) return null;
  const hostAtBottom = w.scrollTop >= w.slack - 1;
  const hostAtTop = w.scrollTop <= 0;
  const takeIt = w.deltaY > 0 ? w.xtermAtBottom && !hostAtBottom : !hostAtTop;
  if (!takeIt) return null;
  return Math.max(0, Math.min(w.slack, w.scrollTop + w.deltaY));
}
