// THE TURN-END SETTLE, the imperative half (SWIT-103) — ported from the settle
// handler and `repaint()` in ky-desktop's `chat/ChatTerminal.tsx` (CC-591,
// CC-653, CC-685). The rules are pure and tested elsewhere: `repaintPlan.ts`
// (what an idle repaint may do) and `bufferSignals.ts` (what the live screen
// says). This module holds the per-session clock and executes the verdicts.
//
// WHAT IT DOES. The grid is pinned (terminalGrid.ts), so no layout change ever
// resizes xterm or the PTY. What is left to do at all happens here, at the one
// moment it is safe — output quiet for REPAINT_SETTLE_MS:
//
//   1. THE CLEAN REWRITE. When enough output has streamed since the last one
//      to have scarred the buffer, serialize the whole buffer → reset → write
//      it back. Hidden while it parses, never under a reader who is scrolled
//      up / wheeling / selecting, never while claude owns the frame.
//   2. THE RESYNC. Buffer clean: only re-measure xterm's scroll range (the
//      staleness a hidden terminal comes back with — viewportReach.ts).
//   3. THE NARROW-FRAME NUDGE. When claude's own rules are drawn narrower
//      than the grid, its width belief is stale; a rows-only PTY bounce makes
//      it repaint at the real width. Shares the bounce with the resume heal.
//
// SESSION-SCOPED, where Ky's is mount-scoped. Ky binds its settle handler per
// mount and keeps only the dirty counter on the registry; our panes are
// session-scoped already (status detection, the resume heal and dev-server
// detection all run for hidden panes), so the whole clock lives here, fed by
// the registry's one PTY write site. That removes Ky's adopt seam (a fresh
// mount whose "streaming" flag starts false while claude is mid-turn): the
// flag here never resets on a mount. A hidden terminal defers ("not-laid-out")
// and the pane that next shows it asks again.
//
// AGENT SESSIONS ONLY, for the rewrite and the nudge. Ky's terminals only ever
// run claude; ours also run plain shells and log tails, which have no scars to
// wipe and would only blink. `agentSeen` (sticky) is what tells them apart —
// the status detector's agent detection or claude's frame on screen at a
// settle. A plain shell still gets the resync: that is about xterm, not
// claude.
//
// NOT PORTED from Ky's settle: the driven-turn `pinBottom` park. Ky parks the
// pane at the prompt when the user drove the turn; here the host FOLLOWS the
// content's bottom on output and parks on user input (hostPark.ts, applied by
// the registry), so there is nothing left for the settle to park.
//
// IO is injected (the registry configures it at module load), so this file
// imports no xterm and no DOM and vitest drives the clock with fakes. Every
// verdict is a log line — a bad drive is diagnosed from the log, because
// nobody watches this run.

import { log } from "./logger";
import { NARROW_NUDGE_MIN_MS, agentOnScreen, detectNarrowFrame } from "./bufferSignals";
import { DIRTY_OUTPUT_THRESHOLD, planRepaint, type RepaintDeferWhy } from "./repaintPlan";
import { midTurnOnScreen } from "./resumeHeal";
import { TERMINAL_COLS, TERMINAL_ROWS } from "./terminalGrid";

/** Quiet after the last PTY byte that counts as a settle (Ky's turn-end idle,
 *  and the resume heal's RESUME_HEAL_SETTLE_MS). */
export const REPAINT_SETTLE_MS = 1_500;

/** How long the reader must sit at the bottom before a rewrite deferred under
 *  them runs. Flushing the instant they touched bottom ran the reset + rewrite
 *  under a scroll gesture still in progress — a flash of the top, then a yank
 *  back to the prompt. */
export const REPAINT_DWELL_MS = 600;

/** The slice of a live terminal the settle works with. Structural, so tests
 *  pass a plain object; the registry builds the real one over xterm. */
export type RepaintTerminal = {
  /** Identity of the underlying terminal — compared across the rewrite's
   *  async parse, which a dispose can land inside. */
  instance: unknown;
  cols: number;
  rows: number;
  buffer: {
    active: {
      baseY: number;
      cursorY: number;
      viewportY: number;
      /** "normal" | "alternate" */
      type?: string;
      getLine(y: number): { translateToString(trim?: boolean): string } | undefined;
    };
  };
  /** The host is actually on screen (not display:none, not zero-size). */
  laidOut(): boolean;
  hasSelection(): boolean;
  /** Keyboard focus is inside the terminal element. */
  hasFocus(): boolean;
  focus(): void;
  /** The WHOLE buffer, modes included — what a reset must put back. */
  serialize(): string;
  /** Hide/show the terminal element for the parse. */
  setHidden(hidden: boolean): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  write(data: string, done: () => void): void;
  /** Repaint every row of the viewport. */
  refresh(): void;
  scrollToBottom(): void;
  scrollLines(amount: number): void;
};

export type RepaintIO = {
  /** The session's live terminal, or undefined once it is disposed. */
  getTerminal: (sessionId: string) => RepaintTerminal | undefined;
  /** Re-measure xterm's scroll range (non-destructive). */
  resyncViewport: (sessionId: string, cause: string) => void;
  /** The rows-only PTY bounce; false when nothing was sent. */
  bouncePty: (sessionId: string, cause: string) => boolean;
  /** When the PTY was last bounced by ANY caller (0 = never). */
  lastBounceAt: (sessionId: string) => number;
  /** A rewrite finished parsing: the buffer was reset and re-laid. */
  onRewritten?: (sessionId: string) => void;
  /** Output went quiet (every settle, before anything else is decided) — the
   *  registry lets a following pane come up to content that collapsed. */
  onSettle?: (sessionId: string) => void;
};

let io: RepaintIO | null = null;

export function configureRepaintIO(next: RepaintIO | null): void {
  io = next;
}

type RepaintState = {
  /** Live PTY bytes since the last clean rewrite. Counted for hidden and
   *  parked terminals too: a turn that streamed with no pane showing must
   *  still get its rewrite when one does. */
  dirtyBytes: number;
  /** Output arrived within the last REPAINT_SETTLE_MS. */
  streaming: boolean;
  settleTimer: ReturnType<typeof setTimeout> | null;
  /** A repaint was deferred — the next settle, dwell or layout change retries. */
  pending: boolean;
  /** Why the pending repaint was deferred. Each reason waits for ITS trigger:
   *  the reader-side ones (scrolled up, wheel moving, selecting) for the dwell
   *  at the bottom; the rest for the next settle or the next layout change. */
  pendingWhy: RepaintDeferWhy | null;
  /** A rewrite is mutating the terminal, through its async parse. */
  rewriting: boolean;
  /** When the reader's wheel last moved over this terminal. */
  lastWheelAt: number;
  /** When the last narrow-frame nudge fired. */
  narrowNudgeAt: number;
  dwellTimer: ReturnType<typeof setTimeout> | null;
  /** An agent (claude) has drawn in this session — sticky. The rewrite and
   *  the nudge are for such sessions only; a plain shell gets the resync and
   *  nothing else (repaintPlan's `agent`). Set by the status detector's agent
   *  detection (`noteRepaintAgent`) or by claude's frame being on screen at a
   *  settle, whichever comes first. */
  agentSeen: boolean;
};

const sessions = new Map<string, RepaintState>();

function stateFor(sessionId: string): RepaintState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      dirtyBytes: 0,
      streaming: false,
      settleTimer: null,
      pending: false,
      pendingWhy: null,
      rewriting: false,
      lastWheelAt: 0,
      narrowNudgeAt: 0,
      dwellTimer: null,
      agentSeen: false,
    };
    sessions.set(sessionId, s);
  }
  return s;
}

/** The status detector saw an agent in this session (its first non-idle
 *  status — a plain shell never leaves idle). Sticky until the session is
 *  forgotten. */
export function noteRepaintAgent(sessionId: string): void {
  const s = stateFor(sessionId);
  if (s.agentSeen) return;
  s.agentSeen = true;
  log.debug(`repaint: agent seen id=${sessionId} by=status`);
}

/** The other way in: claude's frame is on the live screen right now. */
function noteAgentOnScreen(sessionId: string, s: RepaintState, term: RepaintTerminal): void {
  if (s.agentSeen) return;
  try {
    if (!agentOnScreen(term)) return;
  } catch {
    return;
  }
  s.agentSeen = true;
  log.debug(`repaint: agent seen id=${sessionId} by=screen`);
}

/** Every LIVE PTY chunk written into the session's terminal: count it and
 *  push the settle out. Restored scrollback and the "[Process exited]" notice
 *  are written straight into the terminal and do not count — a replay
 *  re-emits a transcript, it does not scar one. */
export function noteRepaintOutput(sessionId: string, byteLength: number): void {
  const s = stateFor(sessionId);
  s.dirtyBytes += byteLength;
  s.streaming = true;
  if (s.settleTimer) clearTimeout(s.settleTimer);
  s.settleTimer = setTimeout(() => settle(sessionId), REPAINT_SETTLE_MS);
}

/** The reader's wheel moved over this terminal. Feeds the rewrite's
 *  wheel-quiet gate, and — xterm 5.5 fires no scroll event for a wheel-driven
 *  scroll — gives a rewrite deferred under a scrolled-up reader its way back:
 *  the dwell re-checks once the wheel has been still at the bottom. */
export function noteRepaintWheel(sessionId: string): void {
  const s = stateFor(sessionId);
  s.lastWheelAt = Date.now();
  if (dwellCanResolve(s) && !s.streaming && !s.rewriting) armDwell(sessionId, s);
}

/** The terminal's viewport scrolled (xterm's onScroll: output, scrollToBottom,
 *  typed input). A deferred rewrite flushes once the reader is back at the
 *  bottom and has dwelt there; leaving the bottom cancels the wait. */
export function noteRepaintScroll(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s || s.rewriting) return;
  const term = io?.getTerminal(sessionId);
  if (!term) return;
  if (!atBottom(term) || !dwellCanResolve(s) || s.streaming) {
    cancelDwell(s);
    return;
  }
  armDwell(sessionId, s);
}

/** A layout moment — the pane resized, or came back on screen. Never resizes
 *  anything: re-syncs the scroll range, or runs a rewrite that was waiting
 *  for the terminal to be visible. */
export function requestRepaint(sessionId: string, cause: string): void {
  repaint(sessionId, cause);
}

/** Is a rewrite mutating this session's terminal right now? The registry
 *  withholds its write-parsed dispatch while it is: the parse re-emits the
 *  transcript, and the status detector must not read it as a new turn. */
export function isRepaintRewriting(sessionId: string): boolean {
  return sessions.get(sessionId)?.rewriting === true;
}

/** Output bytes since the last clean rewrite (0 for an unknown session). */
export function repaintDirtyBytes(sessionId: string): number {
  return sessions.get(sessionId)?.dirtyBytes ?? 0;
}

/** Drop the session's state — closed, or restarted in place into a fresh
 *  shell whose buffer owes nothing to the old one's output. */
export function forgetRepaint(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.settleTimer) clearTimeout(s.settleTimer);
  cancelDwell(s);
  sessions.delete(sessionId);
}

/** Is the pending repaint one the reader coming back to the bottom can
 *  release? A claude parked on a permission prompt can sit for hours; arming
 *  the dwell for that on every wheel tick would be a poll with nothing to
 *  find. */
function dwellCanResolve(s: RepaintState): boolean {
  return (
    s.pending &&
    (s.pendingWhy === "reader-scrolled-up" ||
      s.pendingWhy === "wheel-active" ||
      s.pendingWhy === "selecting")
  );
}

function atBottom(term: RepaintTerminal): boolean {
  const buf = term.buffer.active;
  return buf.baseY - buf.viewportY <= 0;
}

function cancelDwell(s: RepaintState): void {
  if (!s.dwellTimer) return;
  clearTimeout(s.dwellTimer);
  s.dwellTimer = null;
}

function armDwell(sessionId: string, s: RepaintState): void {
  if (s.dwellTimer) return; // already counting
  s.dwellTimer = setTimeout(() => {
    s.dwellTimer = null;
    if (sessions.get(sessionId) !== s) return; // forgotten while waiting
    if (s.rewriting || s.streaming || !s.pending) return;
    const term = io?.getTerminal(sessionId);
    if (!term || !atBottom(term)) return;
    // A wheel-active re-defer re-arms this dwell from inside repaint (that
    // reason expires by itself in under a second, so the chain is bounded).
    // Every other reason waits for its own trigger — re-arming on a claude
    // parked on a permission prompt would be a 600ms poll for hours.
    repaint(sessionId, "dwell");
  }, REPAINT_DWELL_MS);
}

function settle(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.settleTimer = null;
  s.streaming = false;
  const term = io?.getTerminal(sessionId);
  if (!term) return;
  try {
    io?.onSettle?.(sessionId);
  } catch (err) {
    log.warn(`repaint: onSettle failed id=${sessionId}: ${err}`);
  }

  noteAgentOnScreen(sessionId, s, term);

  // The narrow-frame read comes FIRST, off the intact screen: a rewrite
  // starting below resets the buffer synchronously, and the detector would
  // then read an empty screen. (Ky reads after, so a turn that both scarred
  // the buffer and drew narrow waits for the next settle to be nudged.)
  // A claude parked on a prompt or still working is left alone — the settle
  // proves silence, not idleness, and with a dialog in place of the input box
  // the full-width rules that veto the detector are off screen. A session no
  // agent has drawn in is never nudged: a tool that prints a `─` rule is not
  // a claude with a stale width.
  const believed =
    !s.agentSeen || midTurnOnScreen(term) ? null : detectNarrowFrame(term, term.cols);

  log.debug(
    `repaint: settle id=${sessionId} dirtyBytes=${s.dirtyBytes} pending=${s.pending} agent=${s.agentSeen} readerAtBottom=${atBottom(term)} baseY=${term.buffer.active.baseY}`
  );
  if (s.pending || (s.agentSeen && s.dirtyBytes >= DIRTY_OUTPUT_THRESHOLD)) {
    repaint(sessionId, "settle");
  }

  if (believed === null) return;
  const now = Date.now();
  const last = Math.max(s.narrowNudgeAt, io?.lastBounceAt(sessionId) ?? 0);
  if (last && now - last <= NARROW_NUDGE_MIN_MS) {
    log.info(`narrowNudge: skip id=${sessionId} believed=${believed} why=too-soon sinceLast=${now - last}ms`);
    return;
  }
  s.narrowNudgeAt = now;
  const sent = io?.bouncePty(sessionId, "narrow-nudge") ?? false;
  log.info(
    `narrowNudge: bounce id=${sessionId} believed=${believed} grid=${term.cols}x${term.rows} sent=${sent}`
  );
}

function repaint(sessionId: string, cause: string): void {
  const s = stateFor(sessionId);
  const term = io?.getTerminal(sessionId);
  if (!io || !term) return;
  s.pending = false; // this attempt answers it; a defer below sets it again
  s.pendingWhy = null;
  noteAgentOnScreen(sessionId, s, term);
  const buf = term.buffer.active;
  const fromBottom = Math.max(0, buf.baseY - buf.viewportY);
  let midTurn = false;
  let laidOut = false;
  let selecting = false;
  try {
    laidOut = term.laidOut();
    // Only an agent has turns: a shell that happens to show "(y/n)" is not
    // mid-turn, and must not hold its resync behind a marker that never clears.
    midTurn = s.agentSeen && midTurnOnScreen(term);
    selecting = term.hasSelection();
  } catch (err) {
    // A terminal torn down under the read: treat as not on screen.
    log.warn(`repaint: read failed id=${sessionId} cause=${cause}: ${err}`);
  }
  const plan = planRepaint({
    streaming: s.streaming,
    // A repaint while a prior rewrite's parse is in flight would serialize a
    // HALF-WRITTEN buffer and reset + rewrite it — permanent corruption.
    refitting: s.rewriting,
    laidOut,
    midTurn,
    altScreen: buf.type === "alternate",
    current: { cols: term.cols, rows: term.rows },
    pinnedCols: TERMINAL_COLS,
    pinnedRows: TERMINAL_ROWS,
    dirtyBytes: s.dirtyBytes,
    agent: s.agentSeen,
    readerFromBottom: fromBottom,
    msSinceWheel: Date.now() - s.lastWheelAt,
    selecting,
  });

  if (plan.action === "defer") {
    s.pending = true;
    s.pendingWhy = plan.why;
    const line = `repaint: defer id=${sessionId} cause=${cause} why=${plan.why} dirtyBytes=${s.dirtyBytes}${
      plan.why === "reader-scrolled-up" ? ` fromBottom=${fromBottom}` : ""
    }`;
    // A hidden terminal and a mid-stream layout change defer constantly and
    // say nothing new; the rest are the lines a diagnosis needs.
    if (plan.why === "not-laid-out" || plan.why === "streaming") log.debug(line);
    else log.info(line);
    // wheel-active expires by itself in under a second — the one reason that
    // gets an automatic retry.
    if (plan.why === "wheel-active") armDwell(sessionId, s);
    return;
  }

  if (plan.action === "resync") {
    // The grid is right and the buffer is clean — which says nothing about
    // the SCROLL AREA. Safe on any path: it writes DOM from buffer state,
    // never the reverse, so it cannot move the reader.
    log.debug(`repaint: resync id=${sessionId} cause=${cause}`);
    io.resyncViewport(sessionId, cause);
    return;
  }

  rewrite(sessionId, s, term, plan.cols, plan.rows, cause);
}

/** THE FULL CLEAN REWRITE: snapshot the whole buffer → reset → resize to the
 *  pinned grid (the same grid, so a no-op and no SIGWINCH — the reset + write
 *  does the work; the resize only matters if the grid ever drifted) → write
 *  the snapshot back. The rewritten content is exactly the serialized
 *  transcript, so text duplicated or mangled during the turn is gone.
 *
 *  HIDDEN while it runs: the reset collapses the viewport to line 1 and the
 *  replay scrolls the whole session past, which a reader at the bottom sees
 *  as "the thread snapped to the top". The parse is tens of ms, so hiding
 *  costs a frame or two of pane background.
 *
 *  THE WHOLE BUFFER, no scrollback cap — a capped snapshot silently destroys
 *  everything above the cap (the old widen reflow kept 3000 of 10000 lines). */
function rewrite(
  sessionId: string,
  s: RepaintState,
  term: RepaintTerminal,
  cols: number,
  rows: number,
  cause: string
): void {
  const startedAt = Date.now();
  const dirtyBefore = s.dirtyBytes;
  s.rewriting = true;
  try {
    // Focus is a casualty of the hide: visibility:hidden on an ancestor of
    // the focused element (xterm's helper textarea) blurs it to <body>, and
    // nothing restores it. Record BEFORE hiding.
    const hadFocus = term.hasFocus();
    const snap = term.serialize();
    log.info(
      `repaint: rewrite begin id=${sessionId} cause=${cause} dirtyBytes=${dirtyBefore} grid=${term.cols}x${term.rows}->${cols}x${rows} snapBytes=${snap.length}`
    );
    term.setHidden(true);
    term.reset();
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    // Clean as of this snapshot. Output landing during the async parse queues
    // behind the rewrite in xterm's write buffer and counts toward the NEXT
    // settle.
    s.dirtyBytes = 0;
    term.write(snap, () => {
      // The parse window is async — the session can be disposed (or its
      // terminal replaced) before this fires.
      const live = io?.getTerminal(sessionId);
      const ours = !!live && live.instance === term.instance;
      try {
        if (ours) {
          restoreAfterRewrite(sessionId, term);
          term.refresh();
          // The reset zeroed xterm's scroll-area bookkeeping and the replay
          // rebuilt the buffer under it; xterm re-syncs by itself on its next
          // frame, and this makes the DOM range match the buffer regardless
          // (from buffer state — it cannot move the reader).
          io?.resyncViewport(sessionId, "rewrite");
        }
        log.info(
          `repaint: rewrite done id=${sessionId} cause=${cause} parseMs=${Date.now() - startedAt} live=${ours}`
        );
      } catch (err) {
        log.warn(`repaint: restore failed id=${sessionId} cause=${cause}: ${err}`);
      } finally {
        // Unhide unconditionally — the element must never stay invisible.
        term.setHidden(false);
        // Give back what the hide took, only if it held focus going in.
        if (hadFocus && ours) term.focus();
        s.rewriting = false;
        if (ours) io?.onRewritten?.(sessionId);
      }
    });
  } catch (err) {
    // The element is hidden before the fallible steps — never leave the pane
    // invisible on a throw.
    try {
      term.setHidden(false);
    } catch {
      /* the element is gone */
    }
    s.rewriting = false;
    log.warn(`repaint: rewrite failed id=${sessionId} cause=${cause}: ${err}`);
  }
}

/** Put the reader back after the rewrite. The planner only ever STARTS a
 *  rewrite with the reader at the bottom, so this is scrollToBottom — unless
 *  they scrolled during the parse window itself. Then their position is
 *  relative to a buffer that was reset under the gesture, so honour the
 *  GESTURE, not the number: a wheel-up from the bottom means "a little way
 *  up". Clamp to two screens. */
function restoreAfterRewrite(sessionId: string, term: RepaintTerminal): void {
  const buf = term.buffer.active;
  const dist = buf.baseY - buf.viewportY;
  if (dist > 0) {
    const cap = term.rows * 2;
    log.info(`repaint: restore id=${sessionId} path=scrolled-during-parse dist=${dist} clamped=${dist > cap}`);
    if (dist > cap) {
      term.scrollToBottom();
      term.scrollLines(-cap);
    }
    return;
  }
  term.scrollToBottom();
}

/** Test-only: forget everything. */
export function __resetRepaintForTests(): void {
  for (const id of [...sessions.keys()]) forgetRepaint(id);
  io = null;
}
