/**
 * Unified fit/scroll pipeline for terminal sessions.
 *
 * All terminal fitting and scroll restoration funnels through enqueueFit().
 * Pipeline phases (terminals stay in DOM, visibility via CSS display toggle):
 *
 *   0. Layout gate — wait for container to have real dimensions
 *      (needed after display:none → flex transitions)
 *   1. fitTerminal — measure container, apply the resize POLICY
 *      (resizePolicy.ts): grow-only width capped at MAX_TERMINAL_COLS,
 *      widen = snapshot-reflow, height-only = plain resize, mid-stream
 *      changes deferred until output settles (pending-refit + settle timer,
 *      fed by noteSessionOutput)
 *   1.5. forceViewportRefresh — resize cycle to force syncScrollArea
 *   2. Wait 2 RAFs — let xterm's resize handler settle
 *   3. Scroll restore — set the scroll position (skipped after a reflow:
 *      the reflow's async write callback owns it)
 *   3.5. forceViewportScrollSync — double-sync DOM scrollTop to buffer
 *   3.7. fullRefresh — trailing settle pass repaints rows the PTY app never
 *      repainted after a divider drag
 *   4. Reveal + Focus — show container and focus terminal
 *
 * Per-session debouncing prevents rapid-fire fits during sidebar toggle,
 * window resize, and pane drag.
 */

import {
  fitTerminal,
  getTerminal,
  forceViewportRefresh,
  forceViewportScrollSync,
} from "./terminal";
import { registerDisposeCleanup } from "./terminalRegistry";
import { STREAM_QUIET_MS } from "./resizePolicy";
import { log } from "./logger";

export type FitReason = "attach" | "show" | "resize" | "wake" | "visibility";

export interface FitContext {
  isFirstAttach?: boolean;
  savedScroll?: { viewportY: number; baseY: number } | null;
  onReveal?: () => void;
  shouldFocus?: boolean;
  /** Trailing settle pass after a divider drag: full-refresh the viewport so
   *  rows the PTY app never repainted (claude only repaints the live frame)
   *  don't keep a stale rendering. */
  fullRefresh?: boolean;
}

// Per-session debounce timers
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// Streaming signal + deferred refits (ported resize policy, resizePolicy.ts)
//
// "Actively streaming" = PTY output within the last STREAM_QUIET_MS. Chosen
// over statusDetector's RUNNING state because output recency is the signal
// that physically matters — the duplication bug needs a repaint IN FLIGHT,
// and repaints ARE output. statusDetector's state lags real activity by its
// dwell-time hysteresis and its patterns are claude-shaped (a cargo build or
// vim repaint streams just as hard without ever reading RUNNING). The
// registry's output listener dispatches every chunk through the session
// hooks, so TerminalPane's onOutput hook feeds noteSessionOutput — the
// timestamp keeps updating while a pane is hidden or unmounted too.
//
// When a fit lands mid-stream the grid change is NOT applied (a reflow
// against an in-flight repaint stamps the duplicated frame). Instead the
// session is flagged pending-refit and a settle timer re-arms on every
// subsequent chunk; STREAM_QUIET_MS of quiet runs one clean refit.
// ---------------------------------------------------------------------------

const lastOutputAt = new Map<string, number>();
const pendingRefit = new Set<string>();
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Feed the streaming signal — called from TerminalPane's onOutput session
 *  hook on every PTY chunk (registry-dispatched, runs mounted or hidden). */
export function noteSessionOutput(sessionId: string): void {
  lastOutputAt.set(sessionId, Date.now());
  // A refit is waiting for quiet — push the settle window out.
  if (pendingRefit.has(sessionId)) armSettleTimer(sessionId);
}

/** True while the session produced output within the last STREAM_QUIET_MS. */
export function isSessionStreaming(sessionId: string): boolean {
  const t = lastOutputAt.get(sessionId);
  return t !== undefined && Date.now() - t < STREAM_QUIET_MS;
}

function armSettleTimer(sessionId: string): void {
  const existing = settleTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  settleTimers.set(
    sessionId,
    setTimeout(() => {
      settleTimers.delete(sessionId);
      if (!pendingRefit.delete(sessionId)) return;
      log.debug(`fitQueue: deferred refit running after settle id=${sessionId}`);
      // Re-measure from scratch — the pane may have moved again while the
      // session streamed. Scroll preservation: the reflow path restores the
      // reader's place in its write callback; a settle that turns out to be
      // a no-op touches nothing (policy #6 — a resize-repaint settle never
      // parks the viewport).
      enqueueFit(sessionId, "resize", { fullRefresh: true }, 0);
    }, STREAM_QUIET_MS)
  );
}

// Registry-owned disposal paths (session close/kill, teardown) clear this
// module's per-session state so nothing leaks or fires after dispose.
// cancelPendingFit covers the debounce + pending refit + settle timer.
registerDisposeCleanup((sessionId) => {
  cancelPendingFit(sessionId);
  lastOutputAt.delete(sessionId);
});

/**
 * Enqueue a fit+scroll operation for a session.
 *
 * @param sessionId  Terminal session to fit
 * @param reason     Why the fit is needed (affects which phases run)
 * @param context    Scroll state and callbacks
 * @param debounceMs Debounce window (0 = run immediately after current microtask)
 */
export function enqueueFit(
  sessionId: string,
  reason: FitReason,
  context: FitContext = {},
  debounceMs = 16,
): void {
  // Cancel any pending debounce for this session
  const pending = debounceTimers.get(sessionId);
  if (pending) clearTimeout(pending);

  if (debounceMs <= 0) {
    debounceTimers.delete(sessionId);
    runFit(sessionId, reason, context);
    return;
  }

  const timer = setTimeout(() => {
    debounceTimers.delete(sessionId);
    runFit(sessionId, reason, context);
  }, debounceMs);
  debounceTimers.set(sessionId, timer);
}

/** Cancel any pending fit for a session (call on cleanup). Also drops a
 *  deferred (mid-stream) refit — the mount is going away or lost the
 *  terminal; whoever shows the session next re-measures from scratch. */
export function cancelPendingFit(sessionId: string): void {
  const pending = debounceTimers.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    debounceTimers.delete(sessionId);
  }
  pendingRefit.delete(sessionId);
  const settle = settleTimers.get(sessionId);
  if (settle) {
    clearTimeout(settle);
    settleTimers.delete(sessionId);
  }
}

function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Wait until the terminal's container has real dimensions (post display:none → flex) */
async function waitForLayout(sessionId: string, maxAttempts = 10): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const inst = getTerminal(sessionId);
    const container = inst?.terminal.element?.parentElement;
    if (container && container.clientWidth > 0 && container.clientHeight > 0) {
      return true;
    }
    await raf();
  }
  return false;
}

async function runFit(
  sessionId: string,
  reason: FitReason,
  context: FitContext,
): Promise<void> {
  const instance = getTerminal(sessionId);
  if (!instance?.terminal.element?.parentElement) {
    context.onReveal?.();
    return;
  }

  log.debug(`fitQueue: start id=${sessionId} reason=${reason}`);

  // Phase 0: Wait for layout (needed after display:none → flex transitions)
  if (reason === "show" || reason === "visibility" || reason === "attach") {
    const hasLayout = await waitForLayout(sessionId);
    if (!hasLayout) {
      log.warn(`fitQueue: layout timeout id=${sessionId} reason=${reason}`);
      context.onReveal?.();
      return;
    }
    // Session may have been disposed during waitForLayout's RAFs.
    if (!getTerminal(sessionId)) return;
  }

  // Phase 1: Fit terminal to container dimensions under the resize policy
  // (grow-only width capped at MAX_TERMINAL_COLS; widen = snapshot-reflow;
  // height-only = plain resize; mid-stream = defer to output settle).
  // No explicit resizeSession here: terminal.resize() fires the onResize
  // wiring → resizeSession exactly when the dimensions actually change. A
  // second resizeSession call here only ever re-sent the same dims (a
  // redundant SIGWINCH that made TUI apps redraw).
  const fit = fitTerminal(sessionId, {
    streaming: isSessionStreaming(sessionId),
    initial: !!context.isFirstAttach,
  });
  if (fit.outcome === "deferred") {
    // Mid-stream grid change: flag it and let the settle timer (re-armed on
    // every output chunk) run one clean refit after STREAM_QUIET_MS of quiet.
    pendingRefit.add(sessionId);
    armSettleTimer(sessionId);
  }
  // The reflow path's write() parses async and restores the viewport in its
  // own callback — scroll phases here would race the parse and lose.
  const reflowed = fit.outcome === "applied" && fit.reflowed;

  // Phase 1.5: Force viewport refresh (ensures xterm recalculates scroll area).
  // Only needed after visibility transitions (display:none → flex) where xterm's
  // internal scroll area goes stale.
  // Skip for "resize" — fit() already handled dimensions and the 1-col bounce
  //   would trigger onWriteParsed → status detector → React re-render → ResizeObserver loop.
  // Skip for "wake" — terminal was never display:none; GPU recovery (atlas clear +
  //   WebGL re-enable) handles the visual refresh without the cols-1 bounce that
  //   triggers unnecessary PTY redraws and status re-evaluation.
  // Skip after a reflow — its write() is still parsing asynchronously, and the
  //   cols-1 bounce would mutate the grid mid-parse (the duplicated-frame bug
  //   class); the reflow's own write callback finishes with a full refresh.
  if (reason !== "resize" && reason !== "wake" && !reflowed) {
    forceViewportRefresh(sessionId);
  }

  // Phase 2: Wait 2 RAFs for xterm's resize handler + syncScrollArea
  await raf();
  await raf();

  // Phase 3: Scroll restoration
  const inst = getTerminal(sessionId);
  if (!inst?.terminal.element?.parentElement) {
    context.onReveal?.();
    return;
  }

  const { isFirstAttach, savedScroll } = context;

  if (reflowed) {
    // Scroll restoration owned by the reflow's write callback (async parse).
  } else if (isFirstAttach) {
    inst.terminal.scrollToBottom();
  } else if (savedScroll) {
    const wasAtBottom = savedScroll.viewportY >= savedScroll.baseY;
    const newBaseY = inst.terminal.buffer.active.baseY;
    if (wasAtBottom) {
      inst.terminal.scrollToBottom();
    } else {
      inst.terminal.scrollToLine(Math.min(savedScroll.viewportY, newBaseY));
    }
    log.debug(
      `fitQueue: scroll restore id=${sessionId} wasAtBottom=${wasAtBottom} ` +
        `saved={vp:${savedScroll.viewportY},base:${savedScroll.baseY}} newBase=${newBaseY}`,
    );
  } else if (reason === "show" || reason === "attach") {
    // Terminal becoming visible — scroll to bottom (user expects to see latest)
    inst.terminal.scrollToBottom();
  } else if (reason === "resize") {
    // On resize, maintain bottom position if user was at bottom
    const buf = inst.terminal.buffer.active;
    if (buf.viewportY >= buf.baseY) {
      inst.terminal.scrollToBottom();
    }
  }
  // For wake/visibility with no savedScroll: leave scroll position as-is

  // Phase 3.5: Viewport scroll sync (double-sync pattern from v0.1.x).
  // Only needed after visibility transitions where xterm's internal scrollTop
  // is stale. Skip for "resize" and "wake" — the scroll restore in Phase 3
  // already set the right position, and the double-sync would fight with
  // xterm's own viewport management during active output, causing visible jumping.
  // Skip after a reflow too: its write callback owns the final scroll state
  // and syncing mid-parse would pin a stale position.
  if (reason !== "resize" && reason !== "wake" && !reflowed) {
    forceViewportScrollSync(sessionId);
    await raf();
    // Session may have been disposed between syncs.
    if (!getTerminal(sessionId)) return;
    forceViewportScrollSync(sessionId);
  }

  // Phase 3.7: Trailing settle refresh. The PTY app only repaints its live
  // frame after a resize — rows above it keep whatever wrap the drag left
  // behind. One full refresh after the grid settles repaints them. The
  // reflow path's write callback already does this.
  if (context.fullRefresh && !reflowed) {
    inst.terminal.refresh(0, inst.terminal.rows - 1);
  }

  // Phase 4: Reveal + Focus
  context.onReveal?.();

  if (context.shouldFocus) {
    const focusInst = getTerminal(sessionId);
    if (focusInst) {
      focusInst.terminal.focus();
    }
  }

  log.debug(`fitQueue: complete id=${sessionId}`);
}
