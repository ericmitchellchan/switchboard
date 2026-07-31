import { useEffect, useRef, useState, useCallback, memo } from "react";
import type { Terminal } from "@xterm/xterm";
import type { Session, AgentStatus } from "../types";
import { getTerminal, showTerminal, hideTerminal } from "../lib/terminal";
import {
  newOwnerToken,
  acquireTerminal,
  releaseTerminal,
  bindMountHandlers,
  unbindMountHandlers,
  registerSessionHooks,
  unregisterSessionHooks,
  reviveSession,
} from "../lib/terminalRegistry";
import { enqueueFit, cancelPendingFit, noteSessionOutput } from "../lib/fitQueue";
import {
  initDetector,
  processBufferLines,
  markExited,
  clearWaiting,
} from "../lib/statusDetector";
import { detectTasks, detectResolutions } from "../lib/taskDetector";
import { log } from "../lib/logger";
import { SearchBar } from "./SearchBar";

// Per-session streaming UTF-8 decoders (handles multi-byte chars split across chunks)
const sessionDecoders = new Map<string, TextDecoder>();

// Module-level wiring guard: the session hooks + status detector are per
// SESSION, not per mount — registered once and kept across unmount/remount
// (background sessions keep status/task detection while their pane is gone).
const wiredSessions = new Set<string>();

// Module-level callback refs so hook closures always see the latest
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

// Called by App on session close AND on in-place restart. The registry's own
// Tauri/PTY listeners are NOT touched here — they live and die with the
// terminal instance (disposeTerminal), which is what lets an in-place restart
// stream its new PTY's output into the same live terminal.
export function cleanupSessionListeners(sessionId: string) {
  unregisterSessionHooks(sessionId);
  // In-place restart reuses the session id: clear the exited latch so the
  // lifecycle state stays truthful for the new PTY. Harmless on the close
  // path — disposeTerminal follows unconditionally there.
  reviveSession(sessionId);
  sessionDecoders.delete(sessionId);
  wiredSessions.delete(sessionId);
  sessionCallbacks.delete(sessionId);
}

// Register the session-level hooks the registry dispatches from its once-only
// term subscriptions and PTY listeners. Guarded per session; re-runs after
// cleanupSessionListeners (restart) to re-init detection fresh.
function wireSession(sessionId: string) {
  if (wiredSessions.has(sessionId)) return;
  wiredSessions.add(sessionId);

  log.debug(`Wiring session id=${sessionId}`);

  // Init status detector and per-session UTF-8 decoder
  initDetector(sessionId);
  sessionDecoders.set(sessionId, new TextDecoder("utf-8"));

  // Callback accessors that read from the module-level map
  const getCbs = () => sessionCallbacks.get(sessionId);

  // onWriteParsed reads BUFFER_READ_LINES around the cursor for status
  // detection. baseY + cursorY converts the viewport-relative cursorY into
  // an absolute scrollback index — without this we'd read stale lines.
  const BUFFER_READ_LINES = 15;

  registerSessionHooks(sessionId, {
    onUserData: (_data) => {
      const cbs = getCbs();
      if (cbs) clearWaiting(sessionId, cbs.onStatusChange);
    },
    onWriteParsed: (terminal: Terminal) => {
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
      processBufferLines(sessionId, lines, cursorAbsY, cbs.onStatusChange);
    },
    onOutput: (bytes) => {
      // Streaming signal for the resize policy: stamp last-output-at so fits
      // that land mid-stream defer to output settle (fitQueue). Runs for
      // every chunk, mounted or hidden — registry-dispatched.
      noteSessionOutput(sessionId);
      // Task detection over the raw UTF-8 text (streaming decoder handles
      // multi-byte chars split across chunks). The term.write + dirty-marking
      // are registry-owned and already happened.
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
    },
    onExited: () => {
      const cbs = getCbs();
      if (cbs) {
        markExited(sessionId, cbs.onStatusChange);
        cbs.onExited(sessionId);
      }
    },
  });
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
  // True after a newer mount adopted this session's live terminal (one xterm
  // per session — e.g. the same session shown in two split panes). This pane
  // goes inert behind a hand-off notice; remounting takes the terminal back.
  const [stolen, setStolen] = useState(false);
  const stolenRef = useRef(false);

  // Update module-level callback refs on every render so hook closures always
  // invoke the latest callbacks from whichever component instance is active.
  sessionCallbacks.set(session.id, { onStatusChange, onExited, onAutoTask, onResolveTask });
  // Re-wire if needed (no-op when already wired). Runs in render (not just the
  // mount effect) so an in-place restart — which clears the wiring via
  // cleanupSessionListeners without remounting — re-registers hooks and
  // re-inits detection on its next render.
  wireSession(session.id);

  // Mount: acquire the session's live terminal from the keep-alive registry
  // (adopting its DOM subtree if it already exists — buffer already rendered
  // and current, nothing to replay) or create it there on first mount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const sessionId = session.id;
    const owner = newOwnerToken();
    stolenRef.current = false;
    setStolen(false);

    const { instance, adopted } = acquireTerminal(sessionId, container, owner, {
      cols: session.cols,
      rows: session.rows,
      restoredFromId: session.restoredFromId,
    });

    bindMountHandlers(sessionId, owner, {
      onStolen: () => {
        // Another mount adopted the terminal — our pane just emptied. Go
        // inert: no more fits from this mount (they'd race the winner's), and
        // show the hand-off notice.
        stolenRef.current = true;
        cancelPendingFit(sessionId);
        setStolen(true);
      },
    });

    log.info(`Mount terminal id=${sessionId} owner=${owner} adopted=${adopted}`);

    // Hide until first fit completes to prevent flash at wrong size/position
    container.style.opacity = "0";

    // For an adopted terminal, capture the pre-fit scroll position so the
    // fit pipeline can put the reader back (bottom-pinned stays pinned).
    const buf = instance.terminal.buffer.active;
    const savedScroll = adopted ? { viewportY: buf.viewportY, baseY: buf.baseY } : null;

    // Double-RAF so the browser fully computes layout before measuring.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (stolenRef.current) return;
        enqueueFit(sessionId, adopted ? "show" : "attach", {
          isFirstAttach: !adopted,
          savedScroll,
          onReveal: () => { container.style.opacity = "1"; },
        }, 0);
      });
    });

    return () => {
      cancelPendingFit(sessionId);
      unbindMountHandlers(sessionId, owner);
      // Keep-alive: the instance moves to the hidden root and keeps consuming
      // PTY output — reattach is adoption, never replay. Real teardown happens
      // only on session close (App → disposeTerminal) or app teardown; even an
      // exited session's buffer stays readable until then.
      releaseTerminal(sessionId, owner);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // Visibility effect: show/hide terminal when the visible prop changes
  // (single-pane mode keeps every tab mounted and toggles CSS display).
  // When becoming visible, re-enable WebGL and fit to (potentially new)
  // container size. When becoming hidden, disable WebGL to free GPU context.
  useEffect(() => {
    const sessionId = session.id;
    if (stolenRef.current) return;
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

  // Handle window/container resize via unified fit pipeline (150ms debounce),
  // plus a ~400ms TRAILING settle pass: both timers re-arm on every resize
  // event, so after a divider drag ends the debounced fit lands first and the
  // settle pass follows with a full viewport refresh — the PTY app (claude)
  // only repaints its live frame on SIGWINCH, so rows above it would keep the
  // drag's stale wrap without that refresh.
  // Skip resize when hidden — the "show" fit handles re-measuring when visible.
  useEffect(() => {
    if (!visible) return;

    let mounted = true;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const handleResize = () => {
      if (!mounted || stolenRef.current) return;
      const inst = getTerminal(session.id);
      if (!inst?.terminal.element?.parentElement) return;
      const buf = inst.terminal.buffer.active;
      enqueueFit(session.id, "resize", {
        savedScroll: { viewportY: buf.viewportY, baseY: buf.baseY },
      }, 150);
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (!mounted || stolenRef.current) return;
        const settleInst = getTerminal(session.id);
        if (!settleInst?.terminal.element?.parentElement) return;
        const settleBuf = settleInst.terminal.buffer.active;
        enqueueFit(session.id, "resize", {
          savedScroll: { viewportY: settleBuf.viewportY, baseY: settleBuf.baseY },
          fullRefresh: true,
        }, 0);
      }, 400);
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
      if (settleTimer) clearTimeout(settleTimer);
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
          // Grow-only width (see resizePolicy.ts): when the pane is narrower
          // than the terminal's columns, scroll horizontally rather than
          // re-wrap/break already-rendered content. Vertical stays clipped —
          // xterm scrolls itself.
          overflowX: "auto",
          overflowY: "hidden",
          transition: "opacity 0.05s",
          contain: "layout paint",
        }}
      />
      {stolen && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "#0C0C0E",
          }}
        >
          <span
            style={{
              maxWidth: 360,
              padding: "0 16px",
              textAlign: "center",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "#52525B",
            }}
          >
            This session moved to another pane (one live terminal per session).
          </span>
        </div>
      )}
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
