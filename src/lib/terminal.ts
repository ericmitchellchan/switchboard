// Terminal utilities + compatibility facade over the keep-alive registry.
//
// Instance OWNERSHIP (creation at the pinned grid, keep-alive DOM, once-only
// PTY wiring, WebGL attach/detach policy, the scroll-range re-sync, disposal)
// lives in terminalRegistry.ts — panes acquire and release instances through
// it, keyed by owner tokens whose rules are in terminalLifecycle.ts. This
// module keeps the CSS-hide bookkeeping, the serialize helpers and the two
// "the pane is on screen again" moves, and re-exports the registry-backed
// pieces so existing consumers (workspace.ts, App.tsx, useKeyboardShortcuts.ts,
// export.ts) keep their import surface unchanged.
//
// There is no fit here any more (SWIT-103): the grid is a constant
// (terminalGrid.ts) and a layout change never measures, proposes or resizes
// anything. Showing a terminal is refresh + re-sync + land, never a resize.

import { log } from "./logger";
import {
  isRepaintRewriting,
  repaintBracketedPaste,
  repaintSnapshot,
  whenRepaintIdle,
} from "./repaintRunner";
import {
  getTerminal,
  getAllTerminalIds,
  enableWebGL,
  disableWebGL,
  registerDisposeCleanup,
  isTerminalDetached,
  setScreenWebGLGate,
  resyncTerminalViewport,
  parkTerminalHost,
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
  getSessionWriteCount,
  disposeTerminal,
} from "./terminalRegistry";

// Hidden session tracking: sessions whose parent container has display:none
// (single-pane mode keeps every tab MOUNTED and toggles CSS visibility — this
// is distinct from the registry's keep-alive root, which holds UNMOUNTED
// panes' terminals).
const hiddenSessionIds = new Set<string>();

// The registry owns all disposal paths (session close / kill, app teardown);
// clear this module's per-session state on every one of them.
registerDisposeCleanup((sessionId) => {
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
 * terminal was previously hidden (the caller then lands the view —
 * `landTerminalView` — because everything written while it was hidden was
 * measured against a zero-height viewport).
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
 * re-enable + repaint + re-sync the scroll range, exactly like the adopt/show
 * paths (hidden writes advanced the buffer while the renderer skipped them,
 * and were measured against a zero-height viewport). CSS-hidden tabs and
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
      refreshTerminalView(sessionId, "screen-show");
    } else {
      disableWebGL(sessionId);
    }
  }
}

/**
 * Repaint a terminal that may have gone stale and re-measure its scroll range
 * — the whole of what a wake from sleep, an alt-tab back or a screen switch
 * needs. Nothing is measured against the pane and nothing is resized: the
 * buffer (viewportY included) is the truth, and the re-sync writes the DOM
 * scroller from it. That is also why no scroll position is saved across a
 * hide any more — the old fit pipeline moved it, this does not.
 */
export function refreshTerminalView(sessionId: string, cause: string): void {
  const instance = getTerminal(sessionId);
  if (!instance) return;
  instance.terminal.refresh(0, instance.terminal.rows - 1);
  resyncTerminalViewport(sessionId, cause);
}

/** `refreshTerminalView` for every terminal a pane is actually showing (not
 *  parked in the keep-alive root, not a CSS-hidden tab — those are landed
 *  when they are shown). */
export function refreshAllTerminalViews(cause: string): void {
  for (const sessionId of getAllTerminalIds()) {
    if (isTerminalDetached(sessionId)) continue;
    if (hiddenSessionIds.has(sessionId)) continue;
    refreshTerminalView(sessionId, cause);
  }
}

/**
 * A pane just put this terminal on screen (a mount, an adopt, a tab switch):
 * repaint it, re-sync its scroll range, and put the pane on the content's
 * bottom. `toBottom` also takes xterm's own history to the prompt — a tab
 * switch does (you switch to a tab to see the latest); an adopt does not (the
 * instance survived the remount, and so does the reader's place in it).
 * Never a resize.
 */
export function landTerminalView(
  sessionId: string,
  cause: string,
  opts?: { toBottom?: boolean; focus?: boolean }
): void {
  const instance = getTerminal(sessionId);
  if (!instance) return;
  if (opts?.toBottom) instance.terminal.scrollToBottom();
  refreshTerminalView(sessionId, cause);
  // After a frame, so the host has laid the subtree out and its scroll range
  // is real (a pane shorter than the grid opens at scrollTop 0 otherwise).
  requestAnimationFrame(() => parkTerminalHost(sessionId));
  if (opts?.focus) instance.terminal.focus();
}

/** Is bracketed-paste mode on in this session's terminal? Mid-rewrite
 *  (SWIT-103) the reset turns every mode off until the snapshot's parse re-arms
 *  it, so the value the program had set is read from the rewrite instead —
 *  a multi-line composer send must not go unbracketed (each newline an Enter)
 *  because it landed in those few ms. Undefined when there is no terminal. */
export function bracketedPasteModeOf(sessionId: string): boolean | undefined {
  const during = repaintBracketedPaste(sessionId);
  if (during !== null) return during;
  return getTerminal(sessionId)?.terminal.modes.bracketedPasteMode;
}

/** Paste into the session's terminal the way Ctrl+V does (xterm's own paste:
 *  bracketed when the program asked for it). Mid-rewrite it waits for the
 *  parse to finish — xterm reads bracketed-paste mode at paste time, and it
 *  reads OFF between the reset and the parse. */
export function pasteIntoTerminal(sessionId: string, text: string): void {
  whenRepaintIdle(sessionId, () => getTerminal(sessionId)?.terminal.paste(text));
}

/** The user sent something from OUTSIDE the terminal (the composer): take
 *  them to the prompt — xterm's history AND the pane — the way typing into the
 *  terminal does by itself, so the echoed message is in view. */
export function landTerminalAtPrompt(sessionId: string): void {
  const instance = getTerminal(sessionId);
  if (!instance) return;
  instance.terminal.scrollToBottom();
  parkTerminalHost(sessionId);
}

export function serializeTerminal(sessionId: string): string | null {
  const instance = getTerminal(sessionId);
  if (!instance) return null;
  // The turn-end clean rewrite (SWIT-103) resets the buffer and writes it
  // back over a few tens of ms. A save landing inside that window would put a
  // half-written transcript on disk; null makes the caller skip this round
  // (the session stays dirty, so the next periodic save takes it).
  if (isRepaintRewriting(sessionId)) {
    log.debug(`Skipping serialize for session id=${sessionId}: a rewrite is in flight`);
    return null;
  }
  try {
    // SWIT-93: the modes (bracketed paste, application cursor keys, mouse
    // tracking) belong to the program that was running; the file is read
    // back into a FRESH shell, which arms its own. See lib/scrollbackRestore.
    return instance.serializeAddon.serialize({ excludeModes: true });
  } catch (e) {
    log.warn(`Failed to serialize terminal for session id=${sessionId}: ${e}`);
    return null;
  }
}

/**
 * PLAIN TEXT of a session's buffer — no ANSI, no cursor sequences.
 *
 * Deliberately NOT `serializeTerminal`. That one round-trips into another
 * xterm, so it is full of SGR colour runs and absolute cursor moves; it is the
 * right thing for restore and for PiP and the wrong thing for the ONE consumer
 * that is not a terminal — an AGENT reading a panel terminal's output through
 * its transcript mirror (agentContext's session ref). Handing claude 200KB of
 * escape sequences would technically be "the linkage" and practically be
 * noise.
 *
 * `translateToString(true)` right-trims each row, which also collapses the
 * grid's padding back to real lines. Trailing blank rows (the unused part of
 * the viewport) are dropped so the file ends where the output does.
 *
 * Soft-WRAPPED rows (`buffer.getLine(y).isWrapped` — the renderer split a
 * logical line at the grid width, no real newline was ever printed) are joined
 * to the previous row with NO separator, so a URL or path wrapped mid-token
 * comes back whole. Fixes the evidence scan's fragment hits (SWIT-66 review;
 * the wrapped-URL fixture in evidenceScan.test.ts is the rationale — a real
 * xterm buffer is impractical under vitest) and the agent transcript seam,
 * which had the same bug from day one.
 */
export function plainTextTerminal(sessionId: string): string | null {
  const instance = getTerminal(sessionId);
  if (!instance) return null;
  // Mid-rewrite (SWIT-103) the buffer is reset and half re-laid: an empty or
  // truncated transcript. Null = "no read this time" — the evidence scan
  // waits for the next output, the transcript flush keeps the older file.
  if (isRepaintRewriting(sessionId)) {
    log.debug(`Skipping plain-text read for session id=${sessionId}: a rewrite is in flight`);
    return null;
  }
  try {
    const buf = instance.terminal.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      const text = line?.translateToString(true) ?? "";
      if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();
    return lines.join("\n");
  } catch (e) {
    log.warn(`Failed to read plain text for session id=${sessionId}: ${e}`);
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
 * cursor-position sequence preserved) into a PiP terminal of the SAME grid
 * keeps the two buffers byte-identical. Since SWIT-103 that grid is the
 * pinned one in both windows; the dimensions still ride along so the mirror
 * checks rather than assumes.
 */
export function serializeForPip(
  sessionId: string
): { text: string; cols: number; rows: number } | null {
  const instance = getTerminal(sessionId);
  if (!instance) return null;
  try {
    // Mid-rewrite (SWIT-103) the terminal is reset and half re-laid; the
    // rewrite's own snapshot IS the buffer as it was and is about to be
    // again (modes included, like this serialize), and every PTY chunk the
    // mirror receives after it lands behind it in both windows.
    const text = repaintSnapshot(sessionId) ?? instance.serializeAddon.serialize();
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

/**
 * The terminal's CSS cell WIDTH (px per column), or null while unmeasured
 * (no instance, or the renderer has not laid out yet). SWIT-79: what the
 * panel's default width is computed against — the widest panel that leaves
 * the pane as wide as the pinned grid (panelStore.defaultPanelWidth). Read
 * off the live renderer's dimensions (private API, hence the optional chain).
 */
export function terminalCellWidth(sessionId: string): number | null {
  const instance = getTerminal(sessionId);
  if (!instance) return null;
  const core = (instance.terminal as any)._core;
  const w = core?._renderService?.dimensions?.css?.cell?.width;
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : null;
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
