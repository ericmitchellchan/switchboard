// WHAT THE LIVE SCREEN SAYS — the narrow-frame read (SWIT-103; ported from
// ky-desktop's `chat/bufferSignals.ts`, CC-653). Pure over the structural
// terminal type `resumeHeal.ts` already declares (that file holds the other
// half of Ky's bufferSignals: `tailText`, `midTurnOnScreen`,
// `claudeDrewAfterLaunch`), so vitest fakes the buffer and nothing here
// imports xterm.

import type { TerminalTail } from "./resumeHeal";

/** The whole VISIBLE screen as clean text — the rows below the cursor
 *  included, the scrollback above it excluded.
 *
 *  `tailText` stops AT the cursor, which is right for a prompt or an echo
 *  (both render above claude's input box). claude's input-box rules and its
 *  footer sit AROUND and UNDER the cursor, so a cursor-anchored window can
 *  never see the lower one. And scrollback must stay out in the other
 *  direction: a rule that has scrolled up out of the live frame is history,
 *  not what claude believes now. */
export function screenText(term: TerminalTail): string {
  const buf = term.buffer.active;
  const end = buf.baseY + term.rows - 1;
  let text = "";
  for (let i = buf.baseY; i <= end; i++) {
    const line = buf.getLine(i);
    if (line) text += line.translateToString(true) + "\n";
  }
  return text;
}

/** Text only claude's TUI draws: its working footer, its idle footer (the
 *  default hint or a mode chip), its boot banner. Deliberately NOT its `─`
 *  rules — plenty of command-line tools print those. */
const AGENT_MARKERS: RegExp[] = [
  /\besc to interrupt\b/i,
  /\? for shortcuts/i,
  /shift\+tab to cycle/i,
  /Claude Code v\d/,
];

/** Is claude's frame on the live screen? The turn-end rewrite and the
 *  narrow-frame nudge are for sessions an agent has drawn in; a plain shell
 *  gets neither (repaintPlan's `agent`). One of two signals the runner takes
 *  — the status detector's agent detection is the other — and either is
 *  enough, once. */
export function agentOnScreen(term: TerminalTail): boolean {
  const text = screenText(term);
  return AGENT_MARKERS.some((p) => p.test(text));
}

/** Below this a `─` run is markdown decoration, not a frame rule. */
export const NARROW_RULE_MIN = 20;

/** Cells a rule may fall short of `cols` and still count as full width — a
 *  trimmed trailing cell, or a `---` drawn inside a `● `-indented body. */
export const NARROW_FULL_WIDTH_SLACK = 3;

/** Floor between two narrow-frame nudges on one terminal. claude repaints
 *  after the bounce and the next settle re-checks; a claude that keeps drawing
 *  narrow for some other reason must not turn every settle into a resize. */
export const NARROW_NUDGE_MIN_MS = 30_000;

/** The width claude BELIEVES the terminal has, when that is narrower than the
 *  grid — i.e. its own width tracking has gone stale.
 *
 *  Ky's finding (its meta thread, 2026-08-28): on Windows a whole turn can
 *  wrap at ~40 columns inside a 102-column pane while the ConPTY reads 102 the
 *  entire time. It could not be reproduced by replaying the resize sequence
 *  against a bare ConPTY, so the trigger is inside claude; what is proven is
 *  that ANY ConPTY resize makes claude repaint at the real width.
 *
 *  The read: Claude Code draws unbroken `─` rules above and below its input
 *  box at exactly the width it believes in. Any rule at (or within a couple of
 *  cells of) `cols` proves the belief is current → null. Otherwise the
 *  narrowest rule on screen is the belief. Only the visible screen counts
 *  (scrollback rules are history) and only pure `─` lines (table borders
 *  carry `┌┬┐┼` joins and are as wide as their content). A markdown `---`
 *  inside an indented message body is a few cells short of full width — hence
 *  the tolerance — and still null. Null too when the frame shows no rule at
 *  all, which is every plain shell. */
export function detectNarrowFrame(term: TerminalTail, cols: number): number | null {
  let narrowest: number | null = null;
  for (const line of screenText(term).split("\n")) {
    const rule = line.trim();
    if (rule.length < NARROW_RULE_MIN || !/^─+$/.test(rule)) continue;
    if (rule.length >= cols - NARROW_FULL_WIDTH_SLACK) return null; // full width: belief is current
    if (narrowest === null || rule.length < narrowest) narrowest = rule.length;
  }
  return narrowest;
}
