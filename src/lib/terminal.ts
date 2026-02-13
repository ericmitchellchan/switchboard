import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";

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
}

// Module-level map: keeps terminal instances alive across React renders
const terminalMap = new Map<string, TerminalInstance>();

// Module-level config for font settings — set once from App after config loads
let terminalConfig = {
  fontSize: 13,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'SF Mono', monospace",
};

export function setTerminalConfig(cfg: { fontSize?: number; fontFamily?: string }) {
  if (cfg.fontSize !== undefined) terminalConfig.fontSize = cfg.fontSize;
  if (cfg.fontFamily !== undefined) terminalConfig.fontFamily = `'${cfg.fontFamily}', 'Cascadia Code', 'SF Mono', monospace`;
}

export function createTerminal(sessionId: string): TerminalInstance {
  // Return existing if already created
  const existing = terminalMap.get(sessionId);
  if (existing) return existing;

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
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);

  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);

  const instance: TerminalInstance = {
    terminal,
    fitAddon,
    webglAddon: null,
    searchAddon,
    serializeAddon,
  };

  terminalMap.set(sessionId, instance);
  return instance;
}

export function attachToDOM(sessionId: string, container: HTMLElement, withWebGL = true): void {
  const instance = terminalMap.get(sessionId);
  if (!instance) return;

  const { terminal, fitAddon } = instance;

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

  // Fit to container and scroll to bottom (reattach can leave viewport mid-scrollback)
  requestAnimationFrame(() => {
    fitAddon.fit();
    terminal.scrollToBottom();
  });
}

export function enableWebGL(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance || instance.webglAddon) return;

  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
      instance.webglAddon = null;
    });
    instance.terminal.loadAddon(webglAddon);
    instance.webglAddon = webglAddon;
  } catch {
    instance.webglAddon = null;
  }
}

export function disableWebGL(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance || !instance.webglAddon) return;

  instance.webglAddon.dispose();
  instance.webglAddon = null;
}

export function detachFromDOM(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance) return;

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

export function getTerminal(sessionId: string): TerminalInstance | undefined {
  return terminalMap.get(sessionId);
}

export function disposeTerminal(sessionId: string): void {
  const instance = terminalMap.get(sessionId);
  if (!instance) return;

  if (instance.webglAddon) {
    instance.webglAddon.dispose();
  }
  instance.terminal.dispose();
  terminalMap.delete(sessionId);
}

export function serializeTerminal(sessionId: string): string | null {
  const instance = terminalMap.get(sessionId);
  if (!instance) return null;
  try {
    return instance.serializeAddon.serialize();
  } catch {
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

  try {
    instance.fitAddon.fit();
    return {
      cols: instance.terminal.cols,
      rows: instance.terminal.rows,
    };
  } catch {
    return null;
  }
}
