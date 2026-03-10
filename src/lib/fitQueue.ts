/**
 * Unified fit/scroll pipeline for terminal sessions.
 *
 * All terminal fitting and scroll restoration funnels through enqueueFit().
 * Simplified pipeline (terminals stay in DOM, no reattach workarounds):
 *
 *   1. fit() — measure container, set cols/rows
 *   2. Wait 1 RAF — let xterm settle
 *   3. Scroll restore — set the scroll position
 *   4. Reveal — show the container
 *
 * Per-session debouncing prevents rapid-fire fits during sidebar toggle,
 * window resize, and pane drag.
 */

import {
  fitTerminal,
  getTerminal,
} from "./terminal";
import { resizeSession } from "./ipc";
import { log } from "./logger";

export type FitReason = "attach" | "show" | "resize" | "wake" | "visibility";

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

  // Phase 2: Wait 1 RAF for xterm's internal resize handler to settle
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

  // Phase 4: Reveal the container
  context.onReveal?.();

  log.debug(`fitQueue: complete id=${sessionId}`);
}
