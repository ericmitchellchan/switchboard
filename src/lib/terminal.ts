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

// Saved scroll positions for restoring after detach/reattach
const savedScrollPositions = new Map<string, { viewportY: number; baseY: number }>();

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

export function detachFromDOM(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance) return;

  // Save scroll position before detaching so we can restore after reattach
  const buf = instance.terminal.buffer.active;
  const scrollPos = { viewportY: buf.viewportY, baseY: buf.baseY };
  savedScrollPositions.set(sessionId, scrollPos);

  const atBottom = scrollPos.viewportY >= scrollPos.baseY;
  log.debug(`Detaching terminal id=${sessionId} scroll={viewportY:${scrollPos.viewportY}, baseY:${scrollPos.baseY}, atBottom:${atBottom}} webgl=${!!instance.webglAddon}`);

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

  // Guard: skip fit if container has zero dimensions (detached or not yet laid out).
  // fit() with a 0-size container produces cols=2/rows=1, causing a buffer reflow
  // that corrupts scroll state.
  const container = instance.terminal.element?.parentElement;
  if (container && (container.clientWidth === 0 || container.clientHeight === 0)) {
    log.debug(`Skipping fit for session id=${sessionId}: container has zero dimensions`);
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
 * Force the viewport DOM element's scroll state to match the terminal buffer.
 *
 * After a detach/reattach cycle the browser resets .xterm-viewport scrollTop
 * to 0.  xterm's internal syncScrollArea() may read this stale value before
 * our scroll restoration runs, leaving the viewport permanently desynced.
 *
 * This function:
 * 1. Recalculates .xterm-scroll-area height from the *actual* buffer line
 *    count (fixes "can't scroll to bottom" when fit() read stale dimensions).
 * 2. Sets .xterm-viewport scrollTop to match buffer.viewportY (fixes
 *    "viewport stuck at top").
 */
export function forceViewportScrollSync(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance) return;

  const terminal = instance.terminal;
  const el = terminal.element;
  if (!el || !el.parentElement) return;

  const core = (terminal as any)._core;
  const cellHeight: number | undefined =
    core?._renderService?.dimensions?.css?.cell?.height;
  if (!cellHeight || cellHeight <= 0) return;

  const buf = terminal.buffer.active;

  // Fix scroll area height — must equal totalLines * cellHeight so the
  // viewport's max scrollTop allows reaching the real bottom.
  const scrollAreaEl = el.querySelector(".xterm-scroll-area") as HTMLElement | null;
  if (scrollAreaEl) {
    scrollAreaEl.style.height = `${buf.length * cellHeight}px`;
  }

  // Fix viewport scrollTop
  const viewportEl = el.querySelector(".xterm-viewport") as HTMLElement | null;
  if (viewportEl) {
    viewportEl.scrollTop = buf.viewportY * cellHeight;
  }
}

/**
 * Force xterm to fully recalculate viewport scroll state.
 *
 * After detach/reattach, fit() is a no-op when the container size hasn't
 * changed — xterm never calls resize(), so the viewport scroll area stays
 * stale from before detach.  Content written while the tab was hidden
 * increases the buffer but the scroll area height doesn't update, making
 * it impossible to scroll to the real bottom.
 *
 * A rows+1 / rows cycle forces xterm through its full resize path
 * (buffer adjust + viewport refresh) without causing a column reflow.
 */
export function forceViewportRefresh(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance) return;
  const { terminal } = instance;
  if (!terminal.element?.parentElement) return;

  const { cols, rows } = terminal;
  if (cols < 2 || rows < 2) return;

  terminal.resize(cols, rows + 1);
  terminal.resize(cols, rows);
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
