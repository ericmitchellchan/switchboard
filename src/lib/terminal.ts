import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { open } from "@tauri-apps/plugin-shell";
import { log } from "./logger";

const THEME = {
  background: "#0C0C0E",
  foreground: "#E4E4E7",
  cursor: "#A78BFA",
  cursorAccent: "#0C0C0E",
  selectionBackground: "rgba(167, 139, 250, 0.3)",
  selectionForeground: "#E4E4E7",
  black: "#18181B",
  red: "#EF4444",
  green: "#34D399",
  yellow: "#F59E0B",
  blue: "#60A5FA",
  magenta: "#A78BFA",
  cyan: "#22D3EE",
  white: "#E4E4E7",
  brightBlack: "#52525B",
  brightRed: "#FCA5A5",
  brightGreen: "#6EE7B7",
  brightYellow: "#FCD34D",
  brightBlue: "#93C5FD",
  brightMagenta: "#C4B5FD",
  brightCyan: "#67E8F9",
  brightWhite: "#FAFAFA",
};

export interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  webglAddon: WebglAddon | null;
  searchAddon: SearchAddon;
  serializeAddon: SerializeAddon;
  webLinksAddon: WebLinksAddon;
}

// Module-level map: keeps terminal instances alive across React renders
const terminalMap = new Map<string, TerminalInstance>();

// Saved scroll positions for restoring after visibility change / sleep-wake
const savedScrollPositions = new Map<string, { viewportY: number; baseY: number }>();

// Hidden session tracking: sessions whose parent container has display:none
const hiddenSessionIds = new Set<string>();

// Dirty tracking: sessions that received new PTY data since last serialization.
// Prevents saveAllScrollbacks from serializing unchanged terminals every 30s.
const dirtySessionIds = new Set<string>();

// Module-level config for font settings — set once from App after config loads
let terminalConfig = {
  fontSize: 13,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'SF Mono', monospace",
};

export function setTerminalConfig(cfg: { fontSize?: number; fontFamily?: string }) {
  if (cfg.fontSize !== undefined) terminalConfig.fontSize = cfg.fontSize;
  if (cfg.fontFamily !== undefined) terminalConfig.fontFamily = `'${cfg.fontFamily}', 'Cascadia Code', 'SF Mono', monospace`;
}

export function createTerminal(
  sessionId: string,
  opts?: { cols?: number; rows?: number }
): TerminalInstance {
  // Return existing if already created
  const existing = terminalMap.get(sessionId);
  if (existing) return existing;

  log.debug(`Creating terminal for session id=${sessionId} cols=${opts?.cols} rows=${opts?.rows}`);

  const terminal = new Terminal({
    fontFamily: terminalConfig.fontFamily,
    fontSize: terminalConfig.fontSize,
    lineHeight: 1.3,
    theme: THEME,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 10000,
    allowProposedApi: true,
    convertEol: true,
    screenReaderMode: false,
    ...(opts?.cols ? { cols: opts.cols } : {}),
    ...(opts?.rows ? { rows: opts.rows } : {}),
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);

  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);

  const webLinksAddon = new WebLinksAddon((_event, uri) => {
    open(uri).catch(console.error);
  });
  terminal.loadAddon(webLinksAddon);

  const instance: TerminalInstance = {
    terminal,
    fitAddon,
    webglAddon: null,
    searchAddon,
    serializeAddon,
    webLinksAddon,
  };

  terminalMap.set(sessionId, instance);
  return instance;
}

export function attachToDOM(sessionId: string, container: HTMLElement, withWebGL = true): void {
  const instance = terminalMap.get(sessionId);
  if (!instance) return;

  log.debug(`Attaching terminal to DOM id=${sessionId} withWebGL=${withWebGL}`);

  const { terminal } = instance;

  // Open terminal into the container
  if (!terminal.element) {
    terminal.open(container);
  } else {
    container.appendChild(terminal.element);
  }

  // Load WebGL addon
  if (withWebGL) {
    enableWebGL(sessionId);
  }

  // NOTE: Do NOT call fit()/scrollToBottom() here.  TerminalPane owns
  // all fit timing via a double-RAF to ensure the container layout has
  // fully settled before measuring.  A competing fit() here would read
  // stale dimensions and cause xterm to reflow its buffer with the
  // wrong column count, producing garbled text and broken scroll.
}

export function enableWebGL(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance || instance.webglAddon) return;

  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      log.warn(`WebGL context lost for session id=${sessionId}`);
      webglAddon.dispose();
      instance.webglAddon = null;
    });
    instance.terminal.loadAddon(webglAddon);
    instance.webglAddon = webglAddon;
    log.debug(`WebGL enabled for session id=${sessionId}`);
  } catch (e) {
    log.warn(`Failed to enable WebGL for session id=${sessionId}: ${e}`);
    instance.webglAddon = null;
  }
}

export function disableWebGL(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance || !instance.webglAddon) return;

  log.debug(`Disabling WebGL for session id=${sessionId}`);
  instance.webglAddon.dispose();
  instance.webglAddon = null;
}

/**
 * Mark a terminal as hidden (parent container set to display:none by the
 * rendering layer).  Disables WebGL to free the GPU context but leaves the
 * terminal element in the DOM — no scroll reset, no reattach needed.
 */
export function hideTerminal(sessionId: string): void {
  if (hiddenSessionIds.has(sessionId)) return;
  hiddenSessionIds.add(sessionId);
  disableWebGL(sessionId);
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
 * Remove a terminal element from the DOM (final cleanup before dispose).
 * Only called when a session is being closed — NOT on tab switch.
 */
export function detachFromDOM(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance) return;

  log.debug(`Detaching terminal id=${sessionId} (final cleanup)`);

  hiddenSessionIds.delete(sessionId);

  // Dispose WebGL to free the context
  if (instance.webglAddon) {
    instance.webglAddon.dispose();
    instance.webglAddon = null;
  }

  // Remove the terminal element from DOM without disposing the terminal
  const el = instance.terminal.element;
  if (el && el.parentElement) {
    el.parentElement.removeChild(el);
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
  const instance = terminalMap.get(sessionId);
  if (!instance) return;
  const buf = instance.terminal.buffer.active;
  savedScrollPositions.set(sessionId, { viewportY: buf.viewportY, baseY: buf.baseY });
}

/** Restore scroll position from saved state (non-destructive — does not clear) */
export function restoreScrollPosition(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
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

export function getTerminal(sessionId: string): TerminalInstance | undefined {
  return terminalMap.get(sessionId);
}

/** Mark a session as having new data (call after terminal.write) */
export function markSessionDirty(sessionId: string): void {
  dirtySessionIds.add(sessionId);
}

/** Check if a session has new data since last clearSessionDirty */
export function isSessionDirty(sessionId: string): boolean {
  return dirtySessionIds.has(sessionId);
}

/** Clear dirty flag after serialization */
export function clearSessionDirty(sessionId: string): void {
  dirtySessionIds.delete(sessionId);
}

export function disposeTerminal(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance) return;

  log.debug(`Disposing terminal for session id=${sessionId}`);
  if (instance.webglAddon) {
    instance.webglAddon.dispose();
  }
  instance.terminal.dispose();
  terminalMap.delete(sessionId);
  savedScrollPositions.delete(sessionId);
  hiddenSessionIds.delete(sessionId);
}

export function serializeTerminal(sessionId: string): string | null {
  const instance = terminalMap.get(sessionId);
  if (!instance) return null;
  try {
    return instance.serializeAddon.serialize();
  } catch (e) {
    log.warn(`Failed to serialize terminal for session id=${sessionId}: ${e}`);
    return null;
  }
}

export function writeRestoreContent(sessionId: string, content: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance || !content) return;
  instance.terminal.write(content, () => {
    instance.terminal.scrollToBottom();
  });
}

export function fitTerminal(sessionId: string): { cols: number; rows: number } | null {
  const instance = terminalMap.get(sessionId);
  if (!instance) return null;

  // Guard: skip fit if container has zero or very small dimensions (detached,
  // not yet laid out, or mid-layout-transition).  fit() with tiny containers
  // produces cols=2/rows=1, causing xterm to reflow the entire scrollback to
  // 2 columns — corrupting all wrapped lines irreversibly.
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
 */
export function forceViewportRefresh(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance) return;
  const cols = instance.terminal.cols;
  const rows = instance.terminal.rows;
  if (cols <= 2) return; // can't shrink further
  instance.terminal.resize(cols - 1, rows);
  instance.terminal.resize(cols, rows);
}

/**
 * Directly sync the .xterm-viewport DOM element's scrollTop to match the
 * terminal buffer state. Fixes viewport desync after display:none transitions
 * where xterm's internal scroll area height and scrollTop are stale.
 */
export function forceViewportScrollSync(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
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

/** Return all active terminal session IDs */
export function getAllTerminalIds(): string[] {
  return Array.from(terminalMap.keys());
}

/**
 * Clear the texture atlas on all terminals that still have a live WebGL
 * context.  This fixes the Chromium/Nvidia bug where glyph textures
 * become corrupt after OS resume (the WebGL context is NOT lost, but
 * the GPU-side texture data is garbled).
 */
export function clearAllTextureAtlases(): void {
  let count = 0;
  for (const [sessionId, instance] of terminalMap) {
    if (!instance.webglAddon) continue;
    if (!instance.terminal.element?.parentElement) continue;
    log.debug(`Clearing texture atlas for session id=${sessionId}`);
    instance.terminal.clearTextureAtlas();
    count++;
  }
  log.info(`Cleared texture atlases for ${count}/${terminalMap.size} terminals`);
}

/**
 * Re-enable WebGL for all terminals that are attached to the DOM but lost
 * their WebGL context (e.g. after system sleep).  Falls back to canvas
 * rendering silently if WebGL re-creation fails.
 */
export function recoverAllWebGL(): void {
  let recovered = 0;
  for (const [sessionId, instance] of terminalMap) {
    // Only recover for terminals currently attached to the DOM
    if (!instance.terminal.element?.parentElement) continue;
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
