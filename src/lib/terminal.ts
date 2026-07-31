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
import {
  getTerminal,
  getAllTerminalIds,
  enableWebGL,
  disableWebGL,
  setResizePropagationSuppressed,
  registerDisposeCleanup,
  isTerminalDetached,
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

export function fitTerminal(sessionId: string): { cols: number; rows: number } | null {
  const instance = getTerminal(sessionId);
  if (!instance) return null;

  // Guard: skip fit if container has zero or very small dimensions (detached,
  // not yet laid out, or mid-layout-transition).  fit() with tiny containers
  // produces cols=2/rows=1, causing xterm to reflow the entire scrollback to
  // 2 columns — corrupting all wrapped lines irreversibly.  A terminal parked
  // in the keep-alive root (display:none) measures 0x0 and is skipped here.
  const container = instance.terminal.element?.parentElement;
  if (container && (container.clientWidth < 10 || container.clientHeight < 10)) {
    log.debug(`Skipping fit for session id=${sessionId}: container too small (${container.clientWidth}x${container.clientHeight})`);
    return null;
  }

  try {
    instance.fitAddon.fit();
    return {
      cols: instance.terminal.cols,
      rows: instance.terminal.rows,
    };
  } catch (e) {
    log.warn(`Failed to fit terminal for session id=${sessionId}: ${e}`);
    return null;
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
