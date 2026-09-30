import { useEffect, useRef, useState, useCallback, memo } from "react";
import type { Terminal } from "@xterm/xterm";
import type { Session, AgentStatus } from "../types";
import { getTerminal, showTerminal, hideTerminal, landTerminalView } from "../lib/terminal";
import {
  newOwnerToken,
  acquireTerminal,
  releaseTerminal,
  bindMountHandlers,
  unbindMountHandlers,
  registerSessionHooks,
  unregisterSessionHooks,
  reviveSession,
  registerDisposeCleanup,
  ensureViewportReach,
  followTerminalHost,
  noteTerminalHostScroll,
} from "../lib/terminalRegistry";
import { forgetRepaint, noteRepaintAgent, noteRepaintWheel, requestRepaint } from "../lib/repaintRunner";
import { routeWheelToHost } from "../lib/hostPark";
import {
  initDetector,
  processBufferLines,
  markExited,
  clearWaiting,
  syncDetectorPosition,
} from "../lib/statusDetector";
import { detectTasks, detectResolutions } from "../lib/taskDetector";
import { noteDevServerOutput, registerSessionDir } from "../lib/devServer";
import { log } from "../lib/logger";
import { clearComposerState, useComposerVisible } from "../lib/composer";
import {
  configureResumeHealIO,
  forgetPtyBounce,
  forgetResumeHeal,
  noteResumeHealOutput,
} from "../lib/resumeHealRunner";
import { resizeSession } from "../lib/ipc";
import { SearchBar } from "./SearchBar";
import { Composer } from "./Composer";

// The resume heal (SWIT-100) reads the live xterm and resizes the PTY through
// these; injected so its clock stays testable without xterm. The same IO
// carries the rows-only bounce the narrow-frame nudge shares (SWIT-103) —
// with the grid pinned, `resizeSession` here is the ONLY way a PTY is ever
// resized. Dispose clears the per-session state like every other
// registry-owned cleanup.
configureResumeHealIO({
  getTerminal: (sessionId) => getTerminal(sessionId)?.terminal,
  resizePty: resizeSession,
});
registerDisposeCleanup(forgetResumeHeal);
registerDisposeCleanup(forgetPtyBounce);

/** Debounce for the one thing a pane resize still asks for: a scroll-range
 *  re-sync (or a clean rewrite that was waiting for the terminal to be on
 *  screen). Coalesces the burst a divider drag or a settling layout fires. */
const REPAINT_DEBOUNCE_MS = 150;

/** A wheel tick this long after the previous one starts a new gesture. */
const WHEEL_GESTURE_GAP_MS = 1000;

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
  // An in-place restart reuses the session id without disposing the terminal,
  // so the registry's dispose cleanup never runs. The turn-end settle's state
  // (dirty bytes, a deferred rewrite) and the resume heal are both about the
  // program that WAS here; the fresh shell starts clean.
  forgetRepaint(sessionId);
  forgetResumeHeal(sessionId);
  forgetPtyBounce(sessionId);
  // In-place restart reuses the session id: clear the exited latch so the
  // lifecycle state stays truthful for the new PTY. Harmless on the close
  // path — disposeTerminal follows unconditionally there.
  reviveSession(sessionId);
  sessionDecoders.delete(sessionId);
  wiredSessions.delete(sessionId);
  sessionCallbacks.delete(sessionId);
  // The composer's draft / send history / visibility override are about the
  // conversation this session was holding, and both callers end it (close, or
  // in-place restart into a fresh shell).
  clearComposerState(sessionId);
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

  // The single funnel every statusDetector emit path goes through (buffer
  // scan, raw output, markExited, clearWaiting); it runs for HIDDEN panes too
  // (the registry dispatches these hooks regardless of mount).
  const onStatus = (id: string, status: AgentStatus) => {
    // The PTY ended: there is no claude frame left to heal (SWIT-100).
    if (status === "exited") forgetResumeHeal(id);
    // A session leaves "idle" only once the detector has seen Claude
    // Code-specific output — a plain shell never does. That is what makes it
    // an AGENT session for the turn-end rewrite and the narrow-frame nudge
    // (SWIT-103): a shell or a log tail gets neither.
    else if (status !== "idle") noteRepaintAgent(id);
    getCbs()?.onStatusChange(id, status);
  };

  // onWriteParsed reads BUFFER_READ_LINES around the cursor for status
  // detection. baseY + cursorY converts the viewport-relative cursorY into
  // an absolute scrollback index — without this we'd read stale lines.
  const BUFFER_READ_LINES = 15;

  registerSessionHooks(sessionId, {
    onUserData: (_data) => {
      if (getCbs()) clearWaiting(sessionId, onStatus);
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
      processBufferLines(sessionId, lines, cursorAbsY, onStatus);
    },
    onOutput: (bytes) => {
      // Resume heal (SWIT-100): the settle clock for a `claude --resume`
      // session. A Map miss for every other session. (The turn-end settle —
      // repaintRunner — is fed by the registry's write site directly, right
      // after this hook returns.)
      noteResumeHealOutput(sessionId);
      // Task detection over the raw UTF-8 text (streaming decoder handles
      // multi-byte chars split across chunks). The term.write + dirty-marking
      // are registry-owned and already happened.
      const decoder = sessionDecoders.get(sessionId);
      const text = decoder ? decoder.decode(bytes, { stream: true }) : new TextDecoder().decode(bytes);
      // Dev-server URL detection (increment F) — the SAME registry-dispatched
      // hook, deliberately NOT a second listener chain, and deliberately NOT
      // behind `cbs`: a `pnpm dev` in a HIDDEN tab must still be noticed, and
      // the offer lives in its own store rather than in a mounted component's
      // callbacks. It only ever RECORDS an offer; nothing opens.
      noteDevServerOutput(sessionId, text);
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
        markExited(sessionId, onStatus);
        cbs.onExited(sessionId);
      }
    },
    onBufferRewritten: (terminal: Terminal) => {
      // The turn-end clean rewrite re-laid the buffer (SWIT-103). Nothing
      // happened as far as status goes — the registry withheld onWriteParsed
      // for the parse — but the row the detector anchors its delta on may
      // have moved.
      const buf = terminal.buffer.active;
      syncDetectorPosition(sessionId, buf.baseY + buf.cursorY);
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
  // Publish the session's cwd for the live-preview project lookup (increment
  // F): a detected URL knows nothing about projects, so the folder its pins are
  // filed under comes from the shell it was announced in. Idempotent, and a
  // plain map write — no render, no IPC.
  registerSessionDir(session.id, session.working_dir);
  // Re-wire if needed (no-op when already wired). Runs in render (not just the
  // mount effect) so an in-place restart — which clears the wiring via
  // cleanupSessionListeners without remounting — re-registers hooks and
  // re-inits detection on its next render.
  wireSession(session.id);

  // The one thing a pane resize or a re-show still asks of the terminal: a
  // scroll-range re-sync, or the clean rewrite that was waiting for it to be
  // on screen (repaintRunner). Debounced so a divider drag or a settling
  // layout is one request. NEVER a fit: the grid is pinned (terminalGrid.ts).
  const repaintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRepaint = useCallback(
    (cause: string) => {
      if (repaintTimerRef.current) clearTimeout(repaintTimerRef.current);
      repaintTimerRef.current = setTimeout(() => {
        repaintTimerRef.current = null;
        if (stolenRef.current) return;
        requestRepaint(session.id, cause);
      }, REPAINT_DEBOUNCE_MS);
    },
    [session.id]
  );

  // Mount: acquire the session's live terminal from the keep-alive registry
  // (adopting its DOM subtree if it already exists — buffer already rendered
  // and current, nothing to replay) or create it there, at the pinned grid, on
  // first mount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const sessionId = session.id;
    const owner = newOwnerToken();
    stolenRef.current = false;
    setStolen(false);

    const { adopted } = acquireTerminal(sessionId, container, owner, {
      restoredFromId: session.restoredFromId,
    });

    bindMountHandlers(sessionId, owner, {
      onStolen: () => {
        // Another mount adopted the terminal — our pane just emptied. Go
        // inert (nothing of ours may touch the winner's view) and show the
        // hand-off notice.
        stolenRef.current = true;
        setStolen(true);
      },
    });

    log.info(`Mount terminal id=${sessionId} owner=${owner} adopted=${adopted}`);

    // Hidden for the two frames the browser needs to lay the subtree out, so
    // the first thing shown is the landed view (WebGL's first frame is blank,
    // and a pane shorter than the grid opens at the top before it is parked).
    container.style.opacity = "0";
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        container.style.opacity = "1";
        if (stolenRef.current) return;
        // An ADOPT keeps the reader's place in xterm's history (the instance
        // survived, so did its viewport); a fresh terminal starts at the
        // bottom. Either way: repaint, re-sync the scroll range, park the
        // pane on the content. No fit, no resize.
        landTerminalView(sessionId, adopted ? "adopt" : "attach", { toBottom: !adopted });
      });
    });

    // ── The wheel, over a fixed grid ────────────────────────────────────────
    // (1) Wheel activity = the reader is reading. It gates the destructive
    // rewrite (never inside a scroll gesture) and, once per GESTURE, checks
    // that xterm's scroll range actually reaches the bottom row before the
    // tick lands on it. Capture-phase and passive: xterm's own wheel handling
    // is untouched.
    let lastWheelAt = 0;
    const onWheel = (ev: WheelEvent) => {
      const now = Date.now();
      const gestureStart = now - lastWheelAt > WHEEL_GESTURE_GAP_MS;
      lastWheelAt = now;
      noteRepaintWheel(sessionId);
      if (gestureStart) ensureViewportReach(sessionId, ev.deltaY < 0 ? "wheel-up" : "wheel-down");
    };
    container.addEventListener("wheel", onWheel, { passive: true, capture: true });
    // (2) ONE scroll across two scrollers. A pane shorter than the 40-row
    // grid scrolls the host over it, and xterm eats every wheel tick for its
    // own history — so without routing the wheel never reached the grid's
    // bottom rows. `routeWheelToHost` is the rule (Ky CC-689). Capture and
    // NON-passive, so a tick the host takes never also scrolls xterm.
    const routeWheel = (ev: WheelEvent) => {
      const inst = getTerminal(sessionId);
      if (!inst) return;
      const buf = inst.terminal.buffer.active;
      const next = routeWheelToHost({
        deltaY: ev.deltaY,
        slack: container.scrollHeight - container.clientHeight,
        scrollTop: container.scrollTop,
        xtermAtBottom: buf.viewportY >= buf.baseY,
      });
      if (next === null) return;
      container.scrollTop = next;
      // Told NOW, not at the scroll event: a follow pass already queued for
      // this frame must see that the reader just moved the pane.
      noteTerminalHostScroll(sessionId);
      ev.preventDefault();
      ev.stopPropagation();
    };
    container.addEventListener("wheel", routeWheel, { passive: false, capture: true });
    // (3) Whether the pane still holds the content's bottom — the registry
    // only follows new output while it does.
    const onHostScroll = () => noteTerminalHostScroll(sessionId);
    container.addEventListener("scroll", onHostScroll, { passive: true });

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (repaintTimerRef.current) {
        clearTimeout(repaintTimerRef.current);
        repaintTimerRef.current = null;
      }
      container.removeEventListener("wheel", onWheel, { capture: true });
      container.removeEventListener("wheel", routeWheel, { capture: true });
      container.removeEventListener("scroll", onHostScroll);
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
  // Becoming visible: re-enable WebGL and LAND the view — repaint, re-sync
  // the scroll range (everything written while hidden was measured against a
  // zero-height viewport), go to the bottom, park the pane. Becoming hidden:
  // drop WebGL to free the GPU context. The grid is never touched.
  useEffect(() => {
    const sessionId = session.id;
    if (stolenRef.current) return;
    if (visible) {
      const wasHidden = showTerminal(sessionId);
      if (wasHidden) {
        log.debug(`Terminal becoming visible id=${sessionId}`);
        landTerminalView(sessionId, "show", { toBottom: true, focus: isFocused });
        // A clean rewrite that was deferred because the terminal was hidden
        // ("not-laid-out") runs now that it is on screen — a beat later, like
        // a pane resize, so the tab is drawn before the parse hides it.
        scheduleRepaint("show");
      } else if (isFocused) {
        // Already visible, just needs focus (e.g. split pane focus change)
        const instance = getTerminal(sessionId);
        if (instance) instance.terminal.focus();
      }
    } else {
      hideTerminal(sessionId);
    }
  }, [visible, session.id, isFocused, scheduleRepaint]);

  // The pane changed size (window resize, divider drag, the panel opening,
  // the composer appearing). The terminal does NOT: the grid is pinned, so
  // there is nothing to fit and the PTY hears nothing. Two things follow a
  // size change, neither of them a resize: the pane keeps the content's bottom
  // in view if it was holding it, and xterm's scroll range is re-synced.
  // Skipped while hidden — the show path lands the view.
  useEffect(() => {
    if (!visible) return;
    const container = containerRef.current;
    if (!container) return;

    // Track the last known size: xterm's own internal layout can fire the
    // observer with the container's dimensions unchanged.
    let lastW = container.clientWidth;
    let lastH = container.clientHeight;
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === lastW && h === lastH) return; // no actual size change
      // Logged so a rendering report can be correlated with pane resizes —
      // which, since SWIT-103, are followed by no terminal or PTY resize.
      log.debug(`Pane size change id=${session.id} ${lastW}x${lastH} -> ${w}x${h}`);
      lastW = w;
      lastH = h;
      if (stolenRef.current) return;
      followTerminalHost(session.id, true);
      scheduleRepaint("ro");
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
    };
  }, [session.id, visible, scheduleRepaint]);

  // Close search refocuses terminal
  const handleCloseSearch = useCallback(() => {
    onCloseSearch?.();
    const instance = getTerminal(session.id);
    if (instance) {
      instance.terminal.focus();
    }
  }, [session.id, onCloseSearch]);

  const searchAddon = getTerminal(session.id)?.searchAddon;

  // Increment D: the composer belongs to THIS pane's session (Decision 2) —
  // in a split each pane addresses its own. Visibility is derived in
  // lib/composer from increment C's promotion signal plus the per-session
  // toggle; when it is false NOTHING renders, so a hidden composer costs the
  // terminal exactly zero height.
  const composerVisible = useComposerVisible(session.id);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {searchOpen && searchAddon && (
        <SearchBar searchAddon={searchAddon} onClose={handleCloseSearch} />
      )}
      <div
        ref={containerRef}
        // `terminal-host` carries the scrollbar rule (global.css): thin, one
        // step brighter, drawn only on an axis where the pane is smaller than
        // the pinned grid — the affordance that reaches the columns past the
        // right edge and the rows below the fold.
        className="terminal-host"
        // Click-to-focus for the WHOLE pane, not just the xterm element.
        // xterm installs its own focus handler on its element — but this
        // container is larger than that element whenever the pane is bigger
        // than the pinned grid (slack to the right or below), so clicking the
        // slack hit this div and focus stayed wherever it already was (the
        // composer). Typing and Ctrl+V then both went to the composer even
        // though the terminal is plainly what was clicked (owner 2026-08-02).
        // mousedown, not click: focus must land BEFORE the paste/keystroke.
        onMouseDown={(e) => {
          const inst = getTerminal(session.id);
          if (!inst) return;
          const el = inst.terminal.element;
          // Inside xterm proper — leave it alone so selection drags still work.
          if (el && e.target instanceof Node && el.contains(e.target)) return;
          // preventDefault so the browser's own mousedown focus step doesn't
          // immediately move focus off the textarea we just focused (this div
          // is not focusable, so there is no selection/caret behaviour to lose).
          e.preventDefault();
          inst.terminal.focus();
        }}
        style={{
          width: "100%",
          // Flex child, not height:100% — the composer is a SIBLING below, and
          // a percentage height would ignore it and overflow the pane. Shrink
          // and grow both land on the ResizeObserver above; showing the
          // composer is a height change like any other, and like any other it
          // moves the pane over the grid and resizes nothing.
          flex: 1,
          minHeight: 0,
          backgroundColor: "var(--bg-primary)",
          // THE GRID IS A FIXED TEXTURE (terminalGrid.ts, SWIT-103): 100×40
          // whatever the pane measures. A pane smaller than the grid scrolls
          // over it on BOTH axes — horizontally for width, vertically to
          // reach the bottom rows when the pane is shorter than 40 rows
          // (xterm's own wheel still scrolls history inside the terminal;
          // `routeWheel` above joins the two). A bigger pane leaves slack,
          // painted in the terminal's own background. `auto`, not `scroll`:
          // a bar exists only on an axis with overflow.
          overflow: "auto",
          transition: "opacity 0.05s",
          contain: "layout paint",
        }}
      />
      {composerVisible && !stolen && <Composer sessionId={session.id} />}
      {stolen && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "var(--bg-primary)",
          }}
        >
          <span
            style={{
              maxWidth: 360,
              padding: "0 16px",
              textAlign: "center",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text-dim)",
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
              background: "var(--bg-active)",
              border: "1px solid var(--border-subtle)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              padding: "6px 16px",
              borderRadius: 6,
              cursor: "pointer",
              transition: "background 0.15s, border-color 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--border)";
              e.currentTarget.style.borderColor = "var(--text-faint)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--bg-active)";
              e.currentTarget.style.borderColor = "var(--border-subtle)";
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
