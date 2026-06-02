import { useEffect, useRef, useCallback, memo } from "react";
import type { Session, AgentStatus } from "../types";
import {
  createTerminal,
  attachToDOM,
  getTerminal,
  writeRestoreContent,
  showTerminal,
  hideTerminal,
  markSessionDirty,
  setXtermWiring,
  unsetXtermWiring,
  isResizePropagationSuppressed,
} from "../lib/terminal";
import {
  writeToSession,
  resizeSession,
  onSessionOutput,
  onSessionExited,
  loadScrollback,
} from "../lib/ipc";
import { enqueueFit, cancelPendingFit } from "../lib/fitQueue";
import {
  initDetector,
  processBufferLines,
  markExited,
  clearWaiting,
} from "../lib/statusDetector";
import { detectTasks, detectResolutions } from "../lib/taskDetector";
import { log } from "../lib/logger";
import { SearchBar } from "./SearchBar";

// Module-level map for event listener cleanup functions
const listenerCleanups = new Map<string, (() => void)[]>();

// Per-session streaming UTF-8 decoders (handles multi-byte chars split across chunks)
const sessionDecoders = new Map<string, TextDecoder>();

// Module-level wiring guard: prevents duplicate listeners when React
// unmounts/remounts TerminalPane for the same session (e.g. single-pane ↔ split)
const wiredSessions = new Set<string>();

// Module-level callback refs so listener closures always see the latest
// callbacks regardless of which component instance last rendered.
const sessionCallbacks = new Map<
  string,
  {
    onStatusChange: (sessionId: string, status: AgentStatus) => void;
    onExited: (sessionId: string) => void;
    onAutoTask?: (task: { text: string; fingerprint: string; priority: "high" | "med" | "low"; category: string }, sessionId: string) => void;
    onResolveTask?: (fingerprintPrefix: string) => void;
  }
>();

export function cleanupSessionListeners(sessionId: string) {
  const fns = listenerCleanups.get(sessionId);
  if (fns) {
    fns.forEach((fn) => fn());
    listenerCleanups.delete(sessionId);
  }
  unsetXtermWiring(sessionId);
  sessionDecoders.delete(sessionId);
  wiredSessions.delete(sessionId);
  sessionCallbacks.delete(sessionId);
}

interface TerminalPaneProps {
  session: Session;
  visible?: boolean;
  searchOpen?: boolean;
  onCloseSearch?: () => void;
  onExited: (sessionId: string) => void;
  onStatusChange: (sessionId: string, status: AgentStatus) => void;
  onAutoTask?: (task: { text: string; fingerprint: string; priority: "high" | "med" | "low"; category: string }, sessionId: string) => void;
  onResolveTask?: (fingerprintPrefix: string) => void;
  onRestart?: (sessionId: string) => void;
  isFocused?: boolean;
}

export const TerminalPane = memo(function TerminalPane({
  session,
  visible = true,
  searchOpen,
  onCloseSearch,
  onExited,
  onStatusChange,
  onAutoTask,
  onResolveTask,
  onRestart,
  isFocused = true,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Update module-level callback refs on every render so listener closures
  // always invoke the latest callbacks from whichever component instance is active.
  sessionCallbacks.set(session.id, { onStatusChange, onExited, onAutoTask, onResolveTask });

  // Set up terminal data wiring (once per session, module-level guard)
  const wireSession = useCallback((sessionId: string, restoredFromId?: string) => {
    if (wiredSessions.has(sessionId)) return;
    wiredSessions.add(sessionId);

    log.debug(`Wiring session id=${sessionId}`);

    const instance = getTerminal(sessionId);
    if (!instance) return;

    // Init status detector and per-session UTF-8 decoder
    initDetector(sessionId);
    sessionDecoders.set(sessionId, new TextDecoder("utf-8"));

    // Helper to store unlisten functions
    const pushCleanup = (unlisten: () => void) => {
      const arr = listenerCleanups.get(sessionId) ?? [];
      arr.push(unlisten);
      listenerCleanups.set(sessionId, arr);
    };

    // Callback accessors that read from the module-level map
    const getCbs = () => sessionCallbacks.get(sessionId);

    // Helper: process a single PTY output chunk (write + task detect).
    // Looks up the terminal per-call so it survives recreate-in-document
    // (e.g. when the session is moved to/from a Picture-in-Picture window).
    const processPtyChunk = (bytes: Uint8Array) => {
      const inst = getTerminal(sessionId);
      if (!inst) return;
      inst.terminal.write(bytes);
      markSessionDirty(sessionId);

      const decoder = sessionDecoders.get(sessionId);
      const text = decoder ? decoder.decode(bytes, { stream: true }) : new TextDecoder().decode(bytes);
      const cbs = getCbs();
      if (cbs) {
        if (cbs.onAutoTask) {
          const detected = detectTasks(sessionId, text);
          for (const task of detected) cbs.onAutoTask(task, sessionId);
        }
        if (cbs.onResolveTask) {
          const resolved = detectResolutions(sessionId, text);
          for (const prefix of resolved) cbs.onResolveTask(prefix);
        }
      }
    };

    // xterm-level wiring (onData, onWriteParsed, onBufferChange, onResize).
    // Lives in terminal.ts so it can be re-attached automatically when the
    // Terminal is disposed and recreated for Picture-in-Picture.
    //
    // onWriteParsed reads BUFFER_READ_LINES around the cursor for status
    // detection. baseY + cursorY converts the viewport-relative cursorY into
    // an absolute scrollback index — without this we'd read stale lines.
    const BUFFER_READ_LINES = 15;
    setXtermWiring(sessionId, {
      onUserData: (sid, data) => {
        const cbs = getCbs();
        if (cbs) clearWaiting(sid, cbs.onStatusChange);
        writeToSession(sid, data).catch(console.error);
      },
      onWriteParsed: (sid, terminal) => {
        const cbs = getCbs();
        if (!cbs) return;
        const buf = terminal.buffer.active;
        const lines: string[] = [];
        const cursorAbsY = buf.baseY + buf.cursorY;
        const startY = Math.max(0, cursorAbsY - BUFFER_READ_LINES + 1);
        for (let y = startY; y <= cursorAbsY; y++) {
          const line = buf.getLine(y);
          if (line) lines.push(line.translateToString(true));
        }
        processBufferLines(sid, lines, cursorAbsY, cbs.onStatusChange);
      },
      onBufferChange: (sid, terminal) => {
        // Without a refresh + texture atlas clear, WebGL can render stale
        // glyphs from the previous buffer when an app like vim or Claude
        // Code's plan editor switches to/from the alt screen.
        terminal.refresh(0, terminal.rows - 1);
        const inst = getTerminal(sid);
        if (inst?.webglAddon) {
          terminal.clearTextureAtlas();
        }
      },
      onResize: (sid, { cols, rows }) => {
        // Skip the forceViewportRefresh cols-1 bounce — it's a display-only
        // scroll-area recalc, not a real terminal size change. Forwarding it
        // would SIGWINCH the shell and make TUI apps redraw (stranding
        // duplicate frames in scrollback).
        if (isResizePropagationSuppressed(sid)) return;
        resizeSession(sid, cols, rows).catch(console.error);
      },
    });

    // Buffer PTY output while scrollback is being restored to prevent
    // the new shell's prompt from appearing before the old scrollback content.
    let pendingOutput: Uint8Array[] | null = restoredFromId ? [] : null;

    // PTY output -> terminal + status detector + task detector
    onSessionOutput(sessionId, (b64data: string) => {
      try {
        const binaryStr = atob(b64data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        if (pendingOutput !== null) {
          pendingOutput.push(bytes);
          return;
        }
        processPtyChunk(bytes);
      } catch (e) {
        log.warn(`Base64 decode error for session id=${sessionId}: ${e}`);
      }
    }).then(pushCleanup);

    // Session exit — per-call lookup so it works after PiP recreate
    onSessionExited(sessionId, () => {
      const inst = getTerminal(sessionId);
      if (inst) inst.terminal.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      const cbs = getCbs();
      if (cbs) {
        markExited(sessionId, cbs.onStatusChange);
        cbs.onExited(sessionId);
      }
    }).then(pushCleanup);

    // Restore scrollback for sessions restored from a saved workspace
    if (restoredFromId) {
      log.debug(`Restoring scrollback for session id=${sessionId} from=${restoredFromId}`);
      loadScrollback(restoredFromId).then((content) => {
        if (content) writeRestoreContent(sessionId, content);
        log.debug(`Scrollback restored for session id=${sessionId}`);
        const buffered = pendingOutput;
        pendingOutput = null;
        if (buffered) for (const chunk of buffered) processPtyChunk(chunk);
      }).catch((e) => {
        log.warn(`Failed to restore scrollback for session id=${sessionId}: ${e}`);
        const buffered = pendingOutput;
        pendingOutput = null;
        if (buffered) for (const chunk of buffered) processPtyChunk(chunk);
      });
    }
  }, []);

  // Mount-once: create terminal, attach to DOM, wire data listeners.
  // The terminal element stays in the DOM for the lifetime of the component —
  // visibility is toggled via CSS (display:none on the parent wrapper) and
  // the showTerminal/hideTerminal helpers manage WebGL context.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const sessionId = session.id;

    // Create terminal if it doesn't exist (pass saved dims for restored sessions)
    createTerminal(sessionId, { cols: session.cols, rows: session.rows });
    wireSession(sessionId, session.restoredFromId);

    log.info(`Mount terminal id=${sessionId}`);

    // Hide until first fit completes to prevent flash at wrong size/position
    container.style.opacity = "0";

    // Attach to DOM (only opens terminal.open() on first call)
    attachToDOM(sessionId, container);

    // Double-RAF so the browser fully computes layout before measuring.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        enqueueFit(sessionId, "attach", {
          isFirstAttach: true,
          onReveal: () => { container.style.opacity = "1"; },
        }, 0);
      });
    });

    // Cleanup only runs when the component unmounts (session close)
    return () => {
      cancelPendingFit(sessionId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // Visibility effect: show/hide terminal when the visible prop changes.
  // When becoming visible, re-enable WebGL and fit to (potentially new) container size.
  // When becoming hidden, disable WebGL to free GPU context.
  useEffect(() => {
    const sessionId = session.id;
    if (visible) {
      const wasHidden = showTerminal(sessionId);
      if (wasHidden) {
        log.debug(`Terminal becoming visible id=${sessionId}`);
        // Hide during fit pipeline to prevent scroll jump flash
        const container = containerRef.current;
        if (container) container.style.opacity = "0";
        enqueueFit(sessionId, "show", {
          shouldFocus: isFocused,
          onReveal: () => { if (container) container.style.opacity = "1"; },
        }, 0);
      } else if (isFocused) {
        // Already visible, just needs focus (e.g. split pane focus change)
        const instance = getTerminal(sessionId);
        if (instance) instance.terminal.focus();
      }
    } else {
      hideTerminal(sessionId);
    }
  }, [visible, session.id, isFocused]);

  // Handle window/container resize via unified fit pipeline (100ms debounce).
  // Skip resize when hidden — the "show" fit handles re-measuring when visible.
  useEffect(() => {
    if (!visible) return;

    let mounted = true;

    const handleResize = () => {
      if (!mounted) return;
      const inst = getTerminal(session.id);
      if (!inst?.terminal.element?.parentElement) return;
      const buf = inst.terminal.buffer.active;
      enqueueFit(session.id, "resize", {
        savedScroll: { viewportY: buf.viewportY, baseY: buf.baseY },
      }, 100);
    };

    window.addEventListener("resize", handleResize);

    const container = containerRef.current;
    let ro: ResizeObserver | null = null;
    if (container) {
      // Track last known size to avoid spurious resize events.
      // xterm.js internal layout changes can trigger ResizeObserver even when
      // the container dimensions haven't changed, causing unnecessary fits
      // that reset the scroll position and make the terminal content jump.
      let lastW = container.clientWidth;
      let lastH = container.clientHeight;
      ro = new ResizeObserver(() => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === lastW && h === lastH) return; // no actual size change
        // Logged so a recurrence of text-render corruption can be correlated
        // with container resizes (the trigger for the fit → PTY resize path).
        log.debug(`ResizeObserver size change id=${session.id} ${lastW}x${lastH} -> ${w}x${h}`);
        lastW = w;
        lastH = h;
        handleResize();
      });
      ro.observe(container);
    }

    return () => {
      mounted = false;
      cancelPendingFit(session.id);
      window.removeEventListener("resize", handleResize);
      if (ro) ro.disconnect();
    };
  }, [session.id, visible]);

  // Close search refocuses terminal
  const handleCloseSearch = useCallback(() => {
    onCloseSearch?.();
    const instance = getTerminal(session.id);
    if (instance) {
      instance.terminal.focus();
    }
  }, [session.id, onCloseSearch]);

  const searchAddon = getTerminal(session.id)?.searchAddon;

  return (
    <div
      style={{
        flex: 1,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {searchOpen && searchAddon && (
        <SearchBar searchAddon={searchAddon} onClose={handleCloseSearch} />
      )}
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          backgroundColor: "#0C0C0E",
          overflow: "hidden",
          transition: "opacity 0.05s",
          contain: "layout paint",
        }}
      />
      {session.status === "exited" && onRestart && (
        <div
          style={{
            position: "absolute",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10,
          }}
        >
          <button
            onClick={() => onRestart(session.id)}
            style={{
              background: "#A78BFA22",
              border: "1px solid #A78BFA66",
              color: "#A78BFA",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              padding: "6px 16px",
              borderRadius: 6,
              cursor: "pointer",
              transition: "background 0.15s, border-color 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "#A78BFA33";
              e.currentTarget.style.borderColor = "#A78BFA99";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "#A78BFA22";
              e.currentTarget.style.borderColor = "#A78BFA66";
            }}
          >
            Restart Session
          </button>
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  // Custom comparator: skip re-render when only unrelated session fields changed.
  // Status changes on OTHER sessions create new sessions array → new session refs,
  // but TerminalPane only cares about its own session's identity and visibility.
  // Callbacks are stable (useCallback with stable deps) and synced via sessionCallbacks map.
  return (
    prev.session.id === next.session.id &&
    prev.session.status === next.session.status && // restart button visibility
    prev.visible === next.visible &&
    prev.searchOpen === next.searchOpen &&
    prev.isFocused === next.isFocused
  );
});
