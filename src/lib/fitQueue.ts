/**
 * Unified fit/scroll pipeline for terminal sessions.
 *
 * All terminal fitting and scroll restoration funnels through enqueueFit().
 * Pipeline phases (terminals stay in DOM, visibility via CSS display toggle):
 *
 *   0. Layout gate — wait for container to have real dimensions
 *      (needed after display:none → flex transitions)
 *   1. fit() — measure container, set cols/rows
 *   1.5. forceViewportRefresh — resize cycle to force syncScrollArea
 *   2. Wait 2 RAFs — let xterm's resize handler settle
 *   3. Scroll restore — set the scroll position
 *   3.5. forceViewportScrollSync — double-sync DOM scrollTop to buffer
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
import { resizeSession } from "./ipc";
import { log } from "./logger";

export type FitReason = "attach" | "show" | "resize" | "wake" | "visibility";

export interface FitContext {
  isFirstAttach?: boolean;
  savedScroll?: { viewportY: number; baseY: number } | null;
  onReveal?: () => void;
  shouldFocus?: boolean;
}

// Per-session debounce timers
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

/** Cancel any pending fit for a session (call on cleanup). */
export function cancelPendingFit(sessionId: string): void {
  const pending = debounceTimers.get(sessionId);
  if (pending) {
    clearTimeout(pending);
    debounceTimers.delete(sessionId);
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
  }

  // Phase 1: Fit terminal to container dimensions
  const dims = fitTerminal(sessionId);
  if (dims) {
    resizeSession(sessionId, dims.cols, dims.rows).catch(console.error);
  }

  // Phase 1.5: Force viewport refresh (ensures xterm recalculates scroll area).
  // Only needed after visibility transitions (display:none → flex) where xterm's
  // internal scroll area goes stale.
  // Skip for "resize" — fit() already handled dimensions and the 1-col bounce
  //   would trigger onWriteParsed → status detector → React re-render → ResizeObserver loop.
  // Skip for "wake" — terminal was never display:none; GPU recovery (atlas clear +
  //   WebGL re-enable) handles the visual refresh without the cols-1 bounce that
  //   triggers unnecessary PTY redraws and status re-evaluation.
  if (reason !== "resize" && reason !== "wake") {
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

  if (isFirstAttach) {
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
  if (reason !== "resize" && reason !== "wake") {
    forceViewportScrollSync(sessionId);
    await raf();
    forceViewportScrollSync(sessionId);
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
