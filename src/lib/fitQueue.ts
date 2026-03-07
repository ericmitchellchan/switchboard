/**
 * Unified fit/scroll pipeline for terminal sessions.
 *
 * All terminal fitting and scroll restoration funnels through enqueueFit().
 * This eliminates race conditions from multiple competing async operations
 * (double-RAF, 150ms timeouts, 5x forceViewportScrollSync loops) by
 * providing a single, ordered pipeline:
 *
 *   1. fit() — measure container, set cols/rows
 *   2. forceViewportRefresh — force xterm to recalculate scroll area
 *   3. Wait 2 RAFs — let xterm's internal syncScrollArea() complete
 *   4. Scroll restore — set the scroll position (now it sticks)
 *   5. forceViewportScrollSync — ensure DOM matches buffer state
 *   6. Wait 1 RAF — let browser paint
 *   7. Final forceViewportScrollSync — lock it in
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

export type FitReason = "attach" | "resize" | "wake" | "visibility";

export interface FitContext {
  isFirstAttach?: boolean;
  savedScroll?: { viewportY: number; baseY: number } | null;
  onReveal?: () => void;
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

/** Cancel any pending fit for a session (call on detach/cleanup). */
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

  // Phase 1: Fit terminal to container dimensions
  const dims = fitTerminal(sessionId);
  if (dims) {
    resizeSession(sessionId, dims.cols, dims.rows).catch(console.error);
  }

  // Phase 2: Force xterm to recalculate the viewport scroll area.
  // When the buffer grew while detached but container size didn't change,
  // fit() is a no-op (xterm skips resize for unchanged dims). The rows+1/rows
  // cycle forces xterm through its full resize codepath.
  if (reason === "attach" || reason === "visibility" || reason === "wake") {
    forceViewportRefresh(sessionId);
  }

  // Phase 3: Wait 2 RAFs for xterm's internal resize handler and
  // syncScrollArea() to complete. forceViewportRefresh triggers xterm's
  // resize handler which queues a RAF internally. Waiting 2 frames ensures
  // all internal updates are done before we set scroll position.
  await raf();
  await raf();

  // Phase 4: Scroll restoration (after xterm's internal state has settled)
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
  } else if (reason === "resize") {
    // On resize, maintain bottom position if user was at bottom
    const buf = inst.terminal.buffer.active;
    if (buf.viewportY >= buf.baseY) {
      inst.terminal.scrollToBottom();
    }
  } else {
    // Default fallback: scroll to bottom
    inst.terminal.scrollToBottom();
  }

  // Phase 5: Sync viewport DOM to match buffer state, then lock it in
  // after one more RAF (catches any xterm-internal RAF that might overwrite).
  forceViewportScrollSync(sessionId);
  await raf();
  forceViewportScrollSync(sessionId);

  // Reveal the container (hidden during attach to prevent flash)
  context.onReveal?.();

  log.debug(`fitQueue: complete id=${sessionId}`);
}
