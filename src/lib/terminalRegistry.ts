// Keep-alive terminal registry: xterm Terminal INSTANCES survive React
// unmount/remount. Ported from ky-desktop's terminalRegistry.ts (which evolved
// from this repo's terminal substrate).
//
// Why: claude's TUI streams by REPAINTING its whole in-progress message with
// relative cursor moves. Any snapshot/replay/re-attach cycle demands perfect
// cursor continuity with the snapshot — the first replayed repaint that lands
// against a screen state that no longer exists stamps a duplicated, garbled
// copy into scrollback that nothing ever heals (claude only repaints the LIVE
// frame, never the scrollback above it).
//
// So: never replay. On pane unmount the terminal's DOM subtree moves to a
// hidden `display:none` keep-alive root and the registry-owned PTY listener
// keeps writing into it — the render model is correct at every moment while
// hidden, at zero render cost. Remount adopts the SAME element back into the
// new host and refreshes the viewport (hidden writes advanced the buffer but
// the renderer skipped them). Real disposal happens on session close
// (App.destroySession → disposeTerminal), PTY exit (immediately if hidden,
// deferred while a mount shows the exit tail), or app teardown.
// Ownership/steal/disposal decision rules live in terminalLifecycle.ts (pure,
// unit-tested under Node).
//
// Handler wiring: because the Terminal outlives any mount, the term-level
// subscriptions (onData → PTY write, onResize → PTY resize, onWriteParsed,
// onBufferChange, the clipboard key handler) and the per-session Tauri
// output/exited listeners are registry-owned and created ONCE per instance.
// PTY forwarding is unconditional; React-side extras (status detection, task
// detection, exit callbacks) dispatch through per-SESSION hooks that
// TerminalPane registers — session-scoped rather than mount-scoped on purpose:
// Switchboard shows status dots for background tabs whose panes may be
// unmounted (split mode), so detection must keep running while hidden.
// Per-MOUNT handlers (onStolen) are owner-token guarded: last mount wins, the
// loser is severed so its late cleanup/fits are no-ops.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { open } from "@tauri-apps/plugin-shell";
import { listen } from "@tauri-apps/api/event";
import { writeToSession, resizeSession, loadScrollback } from "./ipc";
import { log } from "./logger";
import {
  adopt,
  attachedLifecycle,
  markExited as lifecycleMarkExited,
  release,
  revive,
  type KeepAliveLifecycle,
} from "./terminalLifecycle";

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

/** React-side extras dispatched by the registry-owned subscriptions. Keyed by
 *  SESSION (not mount) — registered once per session by TerminalPane and kept
 *  across unmounts so background sessions keep status/task detection. */
export type SessionHooks = {
  /** User typed/pasted — status bookkeeping. The PTY write itself is
   *  registry-owned and runs unconditionally. */
  onUserData?: (data: string) => void;
  /** Fires after xterm parses written output — status detection reads the
   *  buffer around the cursor. Runs mounted or hidden. */
  onWriteParsed?: (terminal: Terminal) => void;
  /** Per-chunk raw PTY bytes — task detection. The term.write itself is
   *  registry-owned and runs detached too. */
  onOutput?: (bytes: Uint8Array) => void;
  /** The PTY exited (fires after the exit tail is written). */
  onExited?: () => void;
};

/** Per-mount handlers, owner-token guarded. */
export type MountHandlers = {
  /** A newer mount adopted the instance out from under this one — the DOM
   *  just emptied; go inert and stop touching the terminal. */
  onStolen?: () => void;
};

type Entry = TerminalInstance & {
  /** Wrapper div that term.open()ed into — moves between the visible host and
   *  the hidden keep-alive root; the xterm element inside survives the move. */
  container: HTMLDivElement;
  lifecycle: KeepAliveLifecycle;
  /** The current owner's per-mount handlers; null while detached. */
  mount: { owner: number; handlers: MountHandlers } | null;
  /** While non-null, PTY output is buffered until scrollback restore lands. */
  pendingRestore: Uint8Array[] | null;
  stop: () => void;
  disposed: boolean;
};

const registry = new Map<string, Entry>();
const sessionHooks = new Map<string, SessionHooks>();

// Owner tokens: each mount gets one, so a late cleanup from a mount that lost
// the instance to a newer one (same session in two panes, single↔split
// transitions) is a no-op.
let nextOwnerToken = 1;
export function newOwnerToken(): number {
  return nextOwnerToken++;
}

// Detached terminals live here — in the DOM but display:none, so xterm keeps
// accepting writes (buffer model advances) with zero render cost.
let hiddenRoot: HTMLDivElement | null = null;
function keepAliveRoot(): HTMLDivElement {
  if (!hiddenRoot) {
    hiddenRoot = document.createElement("div");
    hiddenRoot.style.display = "none";
    hiddenRoot.setAttribute("data-terminal-keepalive", "");
    document.body.appendChild(hiddenRoot);
  }
  return hiddenRoot;
}

// Dirty tracking: sessions that received new PTY data since last serialization.
// Owned here because the registry's output listener is what writes the data.
const dirtySessionIds = new Set<string>();

export function markSessionDirty(sessionId: string): void {
  dirtySessionIds.add(sessionId);
}
export function isSessionDirty(sessionId: string): boolean {
  return dirtySessionIds.has(sessionId);
}
export function clearSessionDirty(sessionId: string): void {
  dirtySessionIds.delete(sessionId);
}

// Sessions whose onResize events should NOT be forwarded to the PTY — fences
// the forceViewportRefresh cols-1 bounce (display-only scroll-area recalc)
// from SIGWINCHing the shell. See terminal.ts#forceViewportRefresh.
const resizePropagationSuppressed = new Set<string>();

export function isResizePropagationSuppressed(sessionId: string): boolean {
  return resizePropagationSuppressed.has(sessionId);
}
export function setResizePropagationSuppressed(sessionId: string, on: boolean): void {
  if (on) resizePropagationSuppressed.add(sessionId);
  else resizePropagationSuppressed.delete(sessionId);
}

// External per-session state cleanup (e.g. terminal.ts's saved scroll
// positions) — run on every disposal path, including exit-while-hidden, so
// facade-owned maps can't leak. Registered at module load, not per session.
const disposeCleanups: Array<(sessionId: string) => void> = [];
export function registerDisposeCleanup(fn: (sessionId: string) => void): void {
  disposeCleanups.push(fn);
}

// Module-level config for font settings — set once from App after config loads
let terminalConfig = {
  fontSize: 13,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'SF Mono', monospace",
};

export function setTerminalConfig(cfg: { fontSize?: number; fontFamily?: string }) {
  if (cfg.fontSize !== undefined) terminalConfig.fontSize = cfg.fontSize;
  if (cfg.fontFamily !== undefined) terminalConfig.fontFamily = `'${cfg.fontFamily}', 'Cascadia Code', 'SF Mono', monospace`;
}

export function getTerminal(sessionId: string): TerminalInstance | undefined {
  return registry.get(sessionId);
}

export function getAllTerminalIds(): string[] {
  return Array.from(registry.keys());
}

/** True when the session's terminal is parked in the hidden keep-alive root
 *  (no mount is showing it). Such terminals must not get a WebGL context —
 *  they get a fresh one on re-adoption. */
export function isTerminalDetached(sessionId: string): boolean {
  const entry = registry.get(sessionId);
  return !!entry && entry.lifecycle.attachedTo === null;
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** WebGL renderer, loaded per ATTACH and disposed on detach, so hidden
 *  terminals don't pile up GPU contexts — browsers cap live WebGL contexts
 *  and evict the oldest, which could be the one on screen (the likely root of
 *  the sleep/wake texture corruption). Falls back to the DOM renderer if the
 *  context can't be created or is lost. */
export function enableWebGL(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry || entry.webglAddon) return;
  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      log.warn(`WebGL context lost for session id=${sessionId}`);
      webglAddon.dispose();
      if (entry.webglAddon === webglAddon) entry.webglAddon = null;
    });
    entry.terminal.loadAddon(webglAddon);
    entry.webglAddon = webglAddon;
    log.debug(`WebGL enabled for session id=${sessionId}`);
  } catch (e) {
    log.warn(`Failed to enable WebGL for session id=${sessionId}: ${e}`);
    entry.webglAddon = null; /* DOM renderer fallback */
  }
}

export function disableWebGL(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry || !entry.webglAddon) return;
  log.debug(`Disabling WebGL for session id=${sessionId}`);
  try {
    entry.webglAddon.dispose();
  } catch {
    /* context already lost/disposed */
  }
  entry.webglAddon = null;
}

/** Process one PTY chunk: render it, mark for the periodic scrollback save,
 *  and dispatch the session's React-side extras (task detection). */
function writeChunk(entry: Entry, sessionId: string, bytes: Uint8Array): void {
  entry.terminal.write(bytes);
  dirtySessionIds.add(sessionId);
  sessionHooks.get(sessionId)?.onOutput?.(bytes);
}

/** Adopt the session's live terminal into `host` (moving its DOM subtree), or
 *  create one there on first mount. `adopted` = the buffer is already rendered
 *  and current — the mount has nothing to replay or wait on. */
export function acquireTerminal(
  sessionId: string,
  host: HTMLElement,
  owner: number,
  opts?: { cols?: number; rows?: number; restoredFromId?: string }
): { instance: TerminalInstance; adopted: boolean } {
  const existing = registry.get(sessionId);
  if (existing && !existing.disposed) {
    const outcome = adopt(existing.lifecycle, owner);
    if (outcome.action === "adopt") {
      if (outcome.steal) {
        // Last mount wins (same session in two panes) — tell the loser its
        // pane emptied and sever its handlers so nothing double-fires.
        log.debug(`Terminal stolen id=${sessionId} from=${existing.mount?.owner} to=${owner}`);
        existing.mount?.handlers.onStolen?.();
      }
      existing.mount = null;
      existing.lifecycle = outcome.next;
      host.appendChild(existing.container);
      enableWebGL(sessionId);
      // Hidden writes advanced the buffer but the renderer skipped them —
      // repaint the viewport now that it's visible again.
      existing.terminal.refresh(0, existing.terminal.rows - 1);
      log.debug(`Terminal adopted id=${sessionId} owner=${owner}`);
      return { instance: existing, adopted: true };
    }
    // Exited — dead end, never re-adopt; start fresh.
    disposeEntry(sessionId, existing);
  }

  log.debug(`Creating terminal for session id=${sessionId} cols=${opts?.cols} rows=${opts?.rows} owner=${owner}`);

  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "100%";
  host.appendChild(container);

  const terminal = new Terminal({
    fontFamily: terminalConfig.fontFamily,
    fontSize: terminalConfig.fontSize,
    lineHeight: 1.3,
    theme: THEME,
    cursorBlink: true,
    cursorStyle: "bar" as const,
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
  terminal.open(container);

  const entry: Entry = {
    terminal,
    fitAddon,
    webglAddon: null,
    searchAddon,
    serializeAddon,
    webLinksAddon,
    container,
    lifecycle: attachedLifecycle(owner),
    mount: null,
    pendingRestore: opts?.restoredFromId ? [] : null,
    stop: () => {},
    disposed: false,
  };
  registry.set(sessionId, entry);
  enableWebGL(sessionId);

  // NOTE: no fit() here — TerminalPane owns all fit timing via the fitQueue
  // double-RAF so the container layout has fully settled before measuring.

  // Registry-owned term subscriptions — created once for the instance's whole
  // life. PTY forwarding is unconditional; React-side extras dispatch through
  // the session hooks (which persist across unmounts).
  terminal.onData((data) => {
    sessionHooks.get(sessionId)?.onUserData?.(data);
    writeToSession(sessionId, data).catch(console.error);
  });
  terminal.onResize(({ cols, rows }) => {
    // Skip the forceViewportRefresh cols-1 bounce — it's a display-only
    // scroll-area recalc, not a real terminal size change. Forwarding it
    // would SIGWINCH the shell and make TUI apps redraw (stranding duplicate
    // frames in scrollback).
    if (resizePropagationSuppressed.has(sessionId)) return;
    resizeSession(sessionId, cols, rows).catch(console.error);
  });
  terminal.onWriteParsed(() => {
    sessionHooks.get(sessionId)?.onWriteParsed?.(terminal);
  });
  terminal.buffer.onBufferChange(() => {
    // Without a refresh + texture atlas clear, WebGL can render stale glyphs
    // from the previous buffer when an app like vim or Claude Code's plan
    // editor switches to/from the alt screen.
    terminal.refresh(0, terminal.rows - 1);
    if (entry.webglAddon) terminal.clearTextureAtlas();
  });

  // Clipboard keys: Ctrl/Cmd+C copies the selection ONLY when there is one —
  // otherwise it falls through as the interrupt. Ctrl/Cmd+V just SKIPS xterm's
  // keydown mapping (^V) so the browser's default paste proceeds: xterm wires
  // its own `paste` listener (bracketed paste into the PTY), so writing the
  // clipboard here too would double-paste every paste/dictation (Wispr Flow
  // injects via paste). NOTE: useKeyboardShortcuts replaces this handler once
  // the session first becomes active (xterm has a single custom-handler slot);
  // its handler carries the same Ctrl+C rule — this one covers the window
  // before first activation.
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === "c" || e.key === "C")) {
      if (terminal.hasSelection()) {
        // clipboard can reject (permission/focus) — swallow so it doesn't
        // surface as an unhandled rejection.
        void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
        terminal.clearSelection();
        return false; // handled — keep ^C from interrupting
      }
      return true; // no selection → ^C interrupts as usual
    }
    if (mod && !e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V")) return false;
    return true;
  });

  // Registry-owned Tauri listeners — they outlive any mount, which is the
  // point: output keeps flowing into the terminal while detached, so its
  // render model is correct at every moment and reattach has nothing to
  // reconcile. They die only with the entry (session close / PTY exit).
  void (async () => {
    const unOut = await listen<string>(`session:output:${sessionId}`, (event) => {
      if (entry.disposed) return;
      let bytes: Uint8Array;
      try {
        bytes = b64ToBytes(event.payload);
      } catch (e) {
        log.warn(`Base64 decode error for session id=${sessionId}: ${e}`);
        return;
      }
      // Buffer PTY output while scrollback is being restored to prevent the
      // new shell's prompt from appearing before the old scrollback content.
      if (entry.pendingRestore) {
        entry.pendingRestore.push(bytes);
        return;
      }
      writeChunk(entry, sessionId, bytes);
    });
    const unExit = await listen(`session:exited:${sessionId}`, () => {
      if (entry.disposed) return;
      entry.terminal.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      sessionHooks.get(sessionId)?.onExited?.();
      const outcome = lifecycleMarkExited(entry.lifecycle);
      if (outcome.action === "dispose") disposeEntry(sessionId, entry);
      else entry.lifecycle = outcome.next;
    });
    entry.stop = () => {
      unOut();
      unExit();
    };
    if (entry.disposed) entry.stop(); // raced a dispose while subscribing
  })();

  // Restore scrollback for sessions restored from a saved workspace, then
  // flush any PTY chunks that arrived meanwhile (xterm writes are queued in
  // order, so the restore content lands first).
  if (opts?.restoredFromId) {
    const restoredFromId = opts.restoredFromId;
    log.debug(`Restoring scrollback for session id=${sessionId} from=${restoredFromId}`);
    loadScrollback(restoredFromId)
      .then((content) => {
        if (content && !entry.disposed) {
          entry.terminal.write(content, () => entry.terminal.scrollToBottom());
        }
        log.debug(`Scrollback restored for session id=${sessionId}`);
      })
      .catch((e) => {
        log.warn(`Failed to restore scrollback for session id=${sessionId}: ${e}`);
      })
      .finally(() => {
        const buffered = entry.pendingRestore;
        entry.pendingRestore = null;
        if (buffered && !entry.disposed) {
          for (const chunk of buffered) writeChunk(entry, sessionId, chunk);
        }
      });
  }

  return { instance: entry, adopted: false };
}

/** Register the session's React-side extras. Idempotent — last registration
 *  wins; hooks persist across unmounts (background sessions keep detecting). */
export function registerSessionHooks(sessionId: string, hooks: SessionHooks): void {
  sessionHooks.set(sessionId, hooks);
}

/** Remove a session's hooks (call on session close/restart-rewire). */
export function unregisterSessionHooks(sessionId: string): void {
  sessionHooks.delete(sessionId);
}

/** Bind the mounted component's per-mount handlers. Owner-guarded: a mount
 *  that already lost the instance can't clobber the current owner's. */
export function bindMountHandlers(sessionId: string, owner: number, handlers: MountHandlers): void {
  const entry = registry.get(sessionId);
  if (entry && entry.lifecycle.attachedTo === owner) entry.mount = { owner, handlers };
}

/** Unbind at mount cleanup — only this owner's own binding. */
export function unbindMountHandlers(sessionId: string, owner: number): void {
  const entry = registry.get(sessionId);
  if (entry && entry.mount?.owner === owner) entry.mount = null;
}

/** A mount is unmounting: detach into the keep-alive root (or dispose, if the
 *  PTY already exited — nothing left worth keeping). */
export function releaseTerminal(sessionId: string, owner: number): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  const outcome = release(entry.lifecycle, owner);
  if (outcome.action === "ignore") return; // a newer mount owns it now
  if (outcome.action === "dispose") {
    disposeEntry(sessionId, entry);
    return;
  }
  log.debug(`Terminal released to keep-alive id=${sessionId} owner=${owner}`);
  entry.lifecycle = outcome.next;
  entry.mount = null;
  disableWebGL(sessionId); // no GPU context while hidden; DOM renderer takes over
  keepAliveRoot().appendChild(entry.container);
}

/** In-place restart on the same session id (App's Restart button): clear the
 *  exited latch so the live terminal isn't disposed under the new PTY. */
export function reviveSession(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (entry) entry.lifecycle = revive(entry.lifecycle);
}

/** Tear the instance down for real: session close, PTY exit while hidden.
 *  Unconditional — the caller has decided the session itself is over. */
export function disposeTerminal(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (entry) disposeEntry(sessionId, entry);
}

function disposeEntry(sessionId: string, entry: Entry): void {
  if (entry.disposed) return;
  log.debug(`Disposing terminal for session id=${sessionId}`);
  entry.disposed = true;
  registry.delete(sessionId);
  entry.stop();
  entry.mount = null;
  entry.pendingRestore = null;
  if (entry.webglAddon) {
    try {
      entry.webglAddon.dispose();
    } catch {
      /* context already lost/disposed */
    }
    entry.webglAddon = null;
  }
  try {
    entry.terminal.dispose();
  } catch {
    /* already disposed */
  }
  entry.container.remove();
  dirtySessionIds.delete(sessionId);
  resizePropagationSuppressed.delete(sessionId);
  for (const fn of disposeCleanups) fn(sessionId);
}
