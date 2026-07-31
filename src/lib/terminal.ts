// Terminal utilities + compatibility facade over the keep-alive registry.
//
// Instance OWNERSHIP (creation, keep-alive DOM, once-only PTY wiring, WebGL
// attach/detach policy, disposal) lives in terminalRegistry.ts — panes acquire
// and release instances through it, keyed by owner tokens whose rules are in
// terminalLifecycle.ts. This module keeps the measurement/serialize/scroll
// helpers and re-exports the registry-backed pieces so existing consumers
// (workspace.ts, fitQueue.ts, App.tsx, useKeyboardShortcuts.ts, export.ts)
// keep their import surface unchanged.

import { log } from "./logger";
import { resizeDecision } from "./resizePolicy";
import {
  getTerminal,
  getAllTerminalIds,
  enableWebGL,
  disableWebGL,
  setResizePropagationSuppressed,
  registerDisposeCleanup,
  isTerminalDetached,
  setScreenWebGLGate,
} from "./terminalRegistry";

export type { TerminalInstance } from "./terminalRegistry";
export {
  getTerminal,
  getAllTerminalIds,
  enableWebGL,
  disableWebGL,
  setTerminalConfig,
  isSessionDirty,
  clearSessionDirty,
  disposeTerminal,
} from "./terminalRegistry";

// Saved scroll positions for restoring after visibility change / sleep-wake
const savedScrollPositions = new Map<string, { viewportY: number; baseY: number }>();

// Hidden session tracking: sessions whose parent container has display:none
// (single-pane mode keeps every tab MOUNTED and toggles CSS visibility — this
// is distinct from the registry's keep-alive root, which holds UNMOUNTED
// panes' terminals).
const hiddenSessionIds = new Set<string>();

// The registry owns all disposal paths (session close / kill, app teardown);
// clear this module's per-session state on every one of them.
registerDisposeCleanup((sessionId) => {
  savedScrollPositions.delete(sessionId);
  hiddenSessionIds.delete(sessionId);
});

/**
 * Mark a terminal as hidden (parent container set to display:none by the
 * rendering layer).  Disables WebGL to free the GPU context but leaves the
 * terminal element in the DOM — no scroll reset, no reattach needed.
 */
export function hideTerminal(sessionId: string): void {
  // WebGL drop BEFORE the already-hidden guard (disableWebGL is idempotent):
  // a remount while CSS-hidden — hide tab B → split unmounts its pane
  // (parked, still in hiddenSessionIds) → back to single → B remounts with
  // visible=false — has acquireTerminal re-enable WebGL, and the guard alone
  // would leave that GPU context alive behind display:none.
  disableWebGL(sessionId);
  if (hiddenSessionIds.has(sessionId)) return;
  hiddenSessionIds.add(sessionId);
  log.debug(`Terminal hidden id=${sessionId}`);
}

/**
 * Mark a terminal as visible again.  Re-enables WebGL and returns true if the
 * terminal was previously hidden (caller should enqueueFit to adjust to the
 * now-visible container dimensions).
 */
export function showTerminal(sessionId: string): boolean {
  if (!hiddenSessionIds.has(sessionId)) return false;
  hiddenSessionIds.delete(sessionId);
  enableWebGL(sessionId);
  log.debug(`Terminal shown id=${sessionId}`);
  return true;
}

/** Check if a terminal is currently hidden */
export function isTerminalHidden(sessionId: string): boolean {
  return hiddenSessionIds.has(sessionId);
}

/**
 * Screen-level visibility (T11): the workstation shell hides the ENTIRE
 * terminal screen with display:none while a non-terminal route (KB, Explorer)
 * is active — a hide that TerminalPane's visible prop (tab visibility WITHIN
 * the screen) never observes, so panes kept their GPU contexts behind it.
 * App calls this on route changes. Hide = drop WebGL on every attached,
 * non-CSS-hidden pane (same policy hideTerminal applies per tab); show =
 * re-enable + repaint exactly like the adopt/show paths (hidden writes
 * advanced the buffer while the renderer skipped them). CSS-hidden tabs and
 * keep-alive-parked terminals stay WebGL-less on both transitions; the
 * registry-side gate also keeps acquire/adopt/show/recover from creating
 * contexts while the screen is hidden.
 */
export function setTerminalScreenVisible(visible: boolean): void {
  if (!setScreenWebGLGate(visible)) return; // no transition
  for (const sessionId of getAllTerminalIds()) {
    if (isTerminalDetached(sessionId)) continue;
    if (hiddenSessionIds.has(sessionId)) continue;
    if (visible) {
      enableWebGL(sessionId);
      const instance = getTerminal(sessionId);
      instance?.terminal.refresh(0, instance.terminal.rows - 1);
    } else {
      disableWebGL(sessionId);
    }
  }
}

/** Retrieve saved scroll position without deleting (non-destructive read) */
export function getSavedScrollPosition(sessionId: string): { viewportY: number; baseY: number } | undefined {
  return savedScrollPositions.get(sessionId);
}

/** Explicitly clear saved scroll position after successful restoration */
export function clearSavedScrollPosition(sessionId: string): void {
  savedScrollPositions.delete(sessionId);
}

/** Save scroll position without detaching (for visibility change / alt-tab) */
export function saveScrollPosition(sessionId: string): void {
  const instance = getTerminal(sessionId);
  if (!instance) return;
  const buf = instance.terminal.buffer.active;
  savedScrollPositions.set(sessionId, { viewportY: buf.viewportY, baseY: buf.baseY });
}

/** Restore scroll position from saved state (non-destructive — does not clear) */
export function restoreScrollPosition(sessionId: string): void {
  const instance = getTerminal(sessionId);
  if (!instance) return;
  const saved = savedScrollPositions.get(sessionId);
  if (!saved) return;
  const wasAtBottom = saved.viewportY >= saved.baseY;
  if (wasAtBottom) {
    instance.terminal.scrollToBottom();
  } else {
    const newBaseY = instance.terminal.buffer.active.baseY;
    instance.terminal.scrollToLine(Math.min(saved.viewportY, newBaseY));
  }
}

export function serializeTerminal(sessionId: string): string | null {
  const instance = getTerminal(sessionId);
  if (!instance) return null;
  try {
    return instance.serializeAddon.serialize();
  } catch (e) {
    log.warn(`Failed to serialize terminal for session id=${sessionId}: ${e}`);
    return null;
  }
}

/**
 * Snapshot main's terminal for PiP handoff: full buffer (scrollback + visible)
 * plus dimensions so PiP can match before writing.
 *
 * Why full serialize (not a range up to the cursor): PSReadLine and TUI redraws
 * issue absolute cursor-position sequences (`\x1b[ROW;COLH`) sized to the live
 * screen. For those to land at the same row in PiP as in main, both buffers
 * must have the same baseY (scrollback length) AND the same cols/rows. A
 * range-trimmed snapshot puts content at `baseY=0` in PiP while main's cursor
 * is at `baseY+cursorY` — and the same `\x1b[N H` sequence resolves to a
 * different row in each window. Full serialize (with the trailing
 * cursor-position sequence preserved) plus a matching `terminal.resize` keeps
 * the two buffers byte-identical.
 */
export function serializeForPip(
  sessionId: string
): { text: string; cols: number; rows: number } | null {
  const instance = getTerminal(sessionId);
  if (!instance) return null;
  try {
    const text = instance.serializeAddon.serialize();
    return {
      text,
      cols: instance.terminal.cols,
      rows: instance.terminal.rows,
    };
  } catch (e) {
    log.warn(`Failed to serialize for PiP id=${sessionId}: ${e}`);
    return null;
  }
}

export type FitOutcome =
  /** Nothing to do: grid already right, or the container isn't measurable. */
  | { outcome: "none" }
  /** A grid change is needed but the session is streaming — the caller
   *  (fitQueue) flags a pending refit and re-runs after output settles. */
  | { outcome: "deferred" }
  /** The grid changed. `reflowed` = the widen path ran (snapshot → reset →
   *  resize → async write): scroll restoration happens in the write callback,
   *  so the caller must NOT restore scroll itself for this fit. */
  | { outcome: "applied"; cols: number; rows: number; reflowed: boolean };

/**
 * Fit the terminal to its container under the settled resize policy
 * (resizePolicy.ts): grow-only width capped at MAX_TERMINAL_COLS, rows follow
 * the pane, widen = snapshot-reflow, mid-stream changes deferred.
 *
 * Never calls fitAddon.fit() — fit() applies proposeDimensions() verbatim,
 * which would shrink cols on a narrowed pane (re-wrapping content the policy
 * says must horizontal-scroll instead). We propose, decide, then resize()
 * ourselves; xterm's onResize wiring forwards the one genuine PTY resize.
 */
export function fitTerminal(
  sessionId: string,
  opts?: { streaming?: boolean; initial?: boolean }
): FitOutcome {
  const instance = getTerminal(sessionId);
  if (!instance) return { outcome: "none" };

  // Guard: skip fit if container has zero or very small dimensions (detached,
  // not yet laid out, or mid-layout-transition).  Tiny containers propose
  // cols=2/rows=1; grow-only width blocks the col shrink, but the initial fit
  // doesn't, and rows=1 is wrong for everyone.  A terminal parked in the
  // keep-alive root (display:none) measures 0x0 and is skipped here.
  const container = instance.terminal.element?.parentElement;
  if (container && (container.clientWidth < 10 || container.clientHeight < 10)) {
    log.debug(`Skipping fit for session id=${sessionId}: container too small (${container.clientWidth}x${container.clientHeight})`);
    return { outcome: "none" };
  }

  try {
    const term = instance.terminal;
    const proposed = instance.fitAddon.proposeDimensions();
    const decision = resizeDecision(
      { cols: term.cols, rows: term.rows },
      proposed ?? null,
      { streaming: !!opts?.streaming, initial: !!opts?.initial }
    );

    switch (decision.kind) {
      case "none":
        return { outcome: "none" };
      case "defer":
        log.debug(`fit deferred (streaming) id=${sessionId}`);
        return { outcome: "deferred" };
      case "resize":
        // Height-only / initial / capped-legacy shrink: no reflow, no
        // conflict window. onResize forwards the one genuine PTY resize.
        term.resize(decision.cols, decision.rows);
        return { outcome: "applied", cols: decision.cols, rows: decision.rows, reflowed: false };
      case "reflow": {
        // Widen: reflow to the wider grid via snapshot + rewrite so the PTY's
        // async SIGWINCH repaint lands on content matching its cursor model
        // (a WIDER grid can't wrap-break existing lines). Keep the reader's
        // place as distance-from-bottom (0 = pinned at the prompt) and
        // restore it in the write CALLBACK — xterm's parse is async, and
        // restoring before the callback races the parse.
        //
        // Honest limits: the snapshot serializes only the last 3000 scrollback
        // lines (of the 10k cap), so a widen reflow TRUNCATES older history;
        // and fromBottom is measured in PRE-reflow row units, so the restored
        // viewport is approximate when re-wrapping changes line counts.
        const buf = term.buffer.active;
        const fromBottom = Math.max(0, buf.baseY - buf.viewportY);
        const snap = instance.serializeAddon.serialize({ scrollback: 3000 });
        term.reset();
        term.resize(decision.cols, decision.rows);
        term.write(snap, () => {
          // The parse window is async — the session can be disposed (or the
          // instance replaced) before this fires.
          const live = getTerminal(sessionId);
          if (!live || live.terminal !== term) return;
          term.scrollToBottom();
          if (fromBottom > 0) term.scrollLines(-fromBottom);
          term.refresh(0, term.rows - 1);
        });
        log.debug(
          `fit reflow id=${sessionId} -> ${decision.cols}x${decision.rows} fromBottom=${fromBottom}`
        );
        return { outcome: "applied", cols: decision.cols, rows: decision.rows, reflowed: true };
      }
    }
  } catch (e) {
    log.warn(`Failed to fit terminal for session id=${sessionId}: ${e}`);
    return { outcome: "none" };
  }
}

/**
 * Force xterm through a full resize cycle even if cols/rows didn't change.
 * Needed because fitAddon.fit() may skip the internal resize when dimensions
 * are unchanged after a display:none -> flex transition.
 *
 * The cols-1 bounce is fenced so its (transient) onResize events are not
 * forwarded to the PTY — the registry's onResize forwarding checks the
 * suppression flag. xterm fires onResize synchronously within resize(), so
 * the flag reliably covers both resize() calls.
 */
export function forceViewportRefresh(sessionId: string): void {
  const instance = getTerminal(sessionId);
  if (!instance) return;
  const cols = instance.terminal.cols;
  const rows = instance.terminal.rows;
  if (cols <= 2) return; // can't shrink further
  setResizePropagationSuppressed(sessionId, true);
  try {
    instance.terminal.resize(cols - 1, rows);
    instance.terminal.resize(cols, rows);
  } finally {
    setResizePropagationSuppressed(sessionId, false);
  }
}

/**
 * Directly sync the .xterm-viewport DOM element's scrollTop to match the
 * terminal buffer state. Fixes viewport desync after display:none transitions
 * where xterm's internal scroll area height and scrollTop are stale.
 */
export function forceViewportScrollSync(sessionId: string): void {
  const instance = getTerminal(sessionId);
  if (!instance) return;
  const el = instance.terminal.element;
  if (!el) return;
  const viewport = el.querySelector('.xterm-viewport') as HTMLElement | null;
  if (!viewport) return;
  const buf = instance.terminal.buffer.active;
  // Access cell height via core renderer dimensions (allowProposedApi is true)
  const core = (instance.terminal as any)._core;
  const cellHeight = core?._renderService?.dimensions?.css?.cell?.height;
  if (!cellHeight || cellHeight <= 0) return;
  const scrollArea = el.querySelector('.xterm-scroll-area') as HTMLElement | null;
  if (scrollArea) {
    scrollArea.style.height = `${(buf.baseY + instance.terminal.rows) * cellHeight}px`;
  }
  viewport.scrollTop = buf.viewportY * cellHeight;
}

/**
 * Clear the texture atlas on all terminals that still have a live WebGL
 * context.  This fixes the Chromium/Nvidia bug where glyph textures
 * become corrupt after OS resume (the WebGL context is NOT lost, but
 * the GPU-side texture data is garbled).
 */
export function clearAllTextureAtlases(): void {
  let count = 0;
  const ids = getAllTerminalIds();
  for (const sessionId of ids) {
    const instance = getTerminal(sessionId);
    if (!instance?.webglAddon) continue;
    if (!instance.terminal.element?.parentElement) continue;
    log.debug(`Clearing texture atlas for session id=${sessionId}`);
    instance.terminal.clearTextureAtlas();
    count++;
  }
  log.info(`Cleared texture atlases for ${count}/${ids.length} terminals`);
}

/**
 * Re-enable WebGL for all terminals that are attached to the DOM but lost
 * their WebGL context (e.g. after system sleep).  Falls back to canvas
 * rendering silently if WebGL re-creation fails.  Terminals parked in the
 * keep-alive root are skipped — they get a fresh context on re-adoption.
 */
export function recoverAllWebGL(): void {
  let recovered = 0;
  for (const sessionId of getAllTerminalIds()) {
    const instance = getTerminal(sessionId);
    if (!instance) continue;
    // Only recover for terminals actually viewable: skip keep-alive-parked
    // (unmounted — they get a fresh context on re-adoption) and CSS-hidden
    // tabs (they re-enable via showTerminal on switch).
    if (!instance.terminal.element?.parentElement) continue;
    if (isTerminalDetached(sessionId)) continue;
    if (hiddenSessionIds.has(sessionId)) continue;
    // Only recover if WebGL was lost (addon is null)
    if (instance.webglAddon) continue;

    log.debug(`Recovering WebGL for session id=${sessionId}`);
    enableWebGL(sessionId);
    recovered++;
  }
  if (recovered > 0) {
    log.info(`Recovered WebGL for ${recovered} terminals`);
  }
}
