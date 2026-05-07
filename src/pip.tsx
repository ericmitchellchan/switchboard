import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { open as openShellUrl } from "@tauri-apps/plugin-shell";
import { closePipWindow, listSessions, onSessionExited, writeToSession } from "./lib/ipc";
import { notifyPipClosing, notifyPipReady, notifyPipSwitchSession, onPipOutput, onPipSessions, type PipSessionInfo } from "./lib/pipBridge";
import { STATUS_CONFIGS } from "./lib/statusConfig";
import type { AgentStatus } from "./types";
import { log, initLogger } from "./lib/logger";
import "@xterm/xterm/css/xterm.css";
import "./styles/global.css";

const TAB_STRIP_HEIGHT = 28;

// Boot the Tauri logger so PiP-side log.info/debug/warn calls land in the
// same on-disk log file as main. Without this, PiP would only log to its
// (separate) DevTools console.
initLogger().catch(() => {});

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

function PipApp({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'SF Mono', monospace",
      fontSize: 11,
      lineHeight: 1.3,
      theme: THEME,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      allowProposedApi: true,
      convertEol: true,
      screenReaderMode: false,
    });

    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon((_e, uri) => {
      openShellUrl(uri).catch(console.error);
    });

    terminal.loadAddon(searchAddon);
    terminal.loadAddon(webLinksAddon);

    terminal.open(container);

    // We deliberately do NOT call fitAddon.fit() — PiP must keep the SAME
    // dimensions as main so that absolute cursor-positioning sequences in PTY
    // output (PSReadLine line redraws, TUI redraws) land at matching
    // coordinates in both windows. Main sends its cols/rows in the scrollback
    // handoff and we resize to match there. PiP's container may be smaller
    // than main's geometry — content past the visible area is clipped. This
    // is the price of keeping the two views byte-identical.
    requestAnimationFrame(() => {
      terminal.focus();
    });

    // User input → PTY (same channel as main window — both windows drive the same shell)
    const onDataDisposable = terminal.onData((data: string) => {
      writeToSession(sessionId, data).catch(console.error);
    });

    let unlistenOutput: (() => void) | undefined;
    let unlistenExited: (() => void) | undefined;

    // All PiP-bound content (snapshot + live PTY) flows through pip:output,
    // sequenced by main. The snapshot lands first; live chunks always come
    // after. No buffering / replay logic needed here — main owns ordering.
    // Listener MUST be registered before notifyPipReady so the snapshot can't
    // fire before we're listening.
    let cancelled = false;
    (async () => {
      unlistenOutput = await onPipOutput(sessionId, (payload) => {
        if (payload.type === "snapshot") {
          // Match main's geometry before writing so wrapping is identical and
          // subsequent live PTY positioning sequences land at the same row/col
          // here as in main.
          if (payload.cols && payload.rows && (terminal.cols !== payload.cols || terminal.rows !== payload.rows)) {
            terminal.resize(payload.cols, payload.rows);
          }
          log.info(`[PiP] snapshot received, length=${payload.text.length}, resized to cols=${terminal.cols} rows=${terminal.rows}`);
          if (payload.text) {
            terminal.write(payload.text, () => {
              terminal.scrollToBottom();
              const buf = terminal.buffer.active;
              log.info(`[PiP] snapshot applied, baseY=${buf.baseY} viewportY=${buf.viewportY} cursorY=${buf.cursorY} length=${buf.length}`);
            });
          }
          return;
        }
        // payload.type === "pty"
        try {
          const binaryStr = atob(payload.data);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          terminal.write(bytes);
        } catch (e) {
          log.warn(`[PiP] base64 decode error: ${e}`);
        }
      });

      unlistenExited = await onSessionExited(sessionId, () => {
        terminal.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      });

      if (cancelled) {
        unlistenOutput?.();
        unlistenExited?.();
        return;
      }

      log.info(`[PiP] listener ready, signaling main for session id=${sessionId}`);
      notifyPipReady(sessionId).catch((e) => log.warn(`[PiP] notifyPipReady failed: ${e}`));
    })();

    // No window-resize → fit handler. PiP intentionally stays at main's
    // geometry (matched in the scrollback handoff) regardless of container
    // size — resizing the xterm would cause cursor positions in incoming
    // PTY output to drift from main's rendering. Container resizes just clip
    // or reveal more of the buffer.

    return () => {
      cancelled = true;
      onDataDisposable.dispose();
      unlistenOutput?.();
      unlistenExited?.();
      terminal.dispose();
    };
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "fixed",
        top: TAB_STRIP_HEIGHT,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "#0C0C0E",
        overflow: "hidden",
      }}
    />
  );
}

// Slim per-session tab strip. Doubles as the chromeless window's drag handle:
// the bar itself is `WebkitAppRegion: drag`, individual tab buttons opt back
// out via `no-drag` so clicks register normally.
function TabStrip({
  sessions,
  activeId,
  onTabClick,
  onClose,
}: {
  sessions: PipSessionInfo[];
  activeId: string;
  onTabClick: (sessionId: string) => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: TAB_STRIP_HEIGHT,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "0 4px 0 8px",
        backgroundColor: "rgba(255,255,255,0.04)",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        // @ts-expect-error — non-standard but supported by WebView2
        WebkitAppRegion: "drag",
        zIndex: 10,
        overflowX: "auto",
        overflowY: "hidden",
      }}
    >
      <div style={{ display: "flex", gap: 4, flex: 1, minWidth: 0, overflowX: "auto" }}>
      {sessions.map((s) => {
        const isActive = s.id === activeId;
        const cfg = STATUS_CONFIGS[s.status as AgentStatus] ?? STATUS_CONFIGS.idle;
        return (
          <button
            key={s.id}
            onClick={() => onTabClick(s.id)}
            title={s.name}
            style={{
              // @ts-expect-error — opt out of the parent drag region
              WebkitAppRegion: "no-drag",
              flexShrink: 0,
              maxWidth: 140,
              height: 20,
              padding: "0 8px",
              background: isActive ? "rgba(167, 139, 250, 0.18)" : "transparent",
              border: isActive ? "1px solid rgba(167, 139, 250, 0.35)" : "1px solid transparent",
              borderRadius: 4,
              color: isActive ? "#FAFAFA" : "#A1A1AA",
              fontSize: 11,
              fontFamily: "'JetBrains Mono', 'Cascadia Code', 'SF Mono', monospace",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: cfg.color,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {s.name}
            </span>
          </button>
        );
      })}
      </div>
      <button
        onClick={onClose}
        title="Close floating window"
        aria-label="Close floating window"
        style={{
          // @ts-expect-error — opt out of the parent drag region
          WebkitAppRegion: "no-drag",
          flexShrink: 0,
          width: 22,
          height: 20,
          padding: 0,
          background: "transparent",
          border: "1px solid transparent",
          borderRadius: 4,
          color: "#A1A1AA",
          fontSize: 13,
          lineHeight: 1,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(239, 68, 68, 0.15)";
          e.currentTarget.style.color = "#FCA5A5";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "#A1A1AA";
        }}
      >
        ×
      </button>
    </div>
  );
}

// Outer shell: owns the session list + active session id, swaps the inner
// PipApp via React `key` to get a clean terminal teardown/recreate on switch.
function PipShell({ initialSessionId }: { initialSessionId: string }) {
  const [activeSessionId, setActiveSessionId] = useState(initialSessionId);
  const [sessions, setSessions] = useState<PipSessionInfo[]>([]);

  useEffect(() => {
    // Initial fetch — main may not have broadcast yet by the time PiP mounts.
    // Status isn't in the Rust SessionInfo (it's frontend-derived in main), so
    // default to "idle" until the first pip:sessions broadcast lands with real
    // statuses.
    listSessions()
      .then((list) =>
        setSessions(list.map((s) => ({ id: s.id, name: s.name, status: "idle" })))
      )
      .catch((e) => log.warn(`[PiP] listSessions failed: ${e}`));

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onPipSessions((next) => {
      setSessions(next);
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleTabClick = useCallback(
    (sessionId: string) => {
      if (sessionId === activeSessionId) return;
      log.info(`[PiP] tab clicked, switching to id=${sessionId}`);
      setActiveSessionId(sessionId);
      void notifyPipSwitchSession(sessionId).catch((e) =>
        log.warn(`[PiP] switch notify failed: ${e}`)
      );
    },
    [activeSessionId]
  );

  const handleClose = useCallback(async () => {
    log.info(`[PiP] close button clicked`);
    // Tell main first so it tears down the router synchronously, then close
    // the window — closing first would leave main forwarding to a dead listener
    // for a few ms.
    try {
      await notifyPipClosing();
    } catch (e) {
      log.warn(`[PiP] notifyPipClosing failed: ${e}`);
    }
    try {
      await closePipWindow();
    } catch (e) {
      log.warn(`[PiP] closePipWindow failed: ${e}`);
    }
  }, []);

  return (
    <>
      <TabStrip
        sessions={sessions}
        activeId={activeSessionId}
        onTabClick={handleTabClick}
        onClose={handleClose}
      />
      {/* key={activeSessionId} forces a clean unmount/remount of PipApp on
          switch — disposes the xterm + listener, then sets up fresh ones for
          the new session. notifyPipReady fires from PipApp's mount effect, so
          main's rewired router lands a fresh snapshot in PiP. */}
      <PipApp key={activeSessionId} sessionId={activeSessionId} />
    </>
  );
}

// PiP body fills the window edge-to-edge — no scrollbars, no margins.
document.body.style.margin = "0";
document.body.style.overflow = "hidden";
document.body.style.background = "#0C0C0E";

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session");

const root = createRoot(document.getElementById("root") as HTMLElement);
if (!sessionId) {
  root.render(
    <div
      style={{
        padding: 20,
        color: "#EF4444",
        fontFamily: "monospace",
        fontSize: 13,
        backgroundColor: "#0C0C0E",
        minHeight: "100vh",
      }}
    >
      PiP error: missing ?session=&lt;id&gt; query param
    </div>
  );
} else {
  root.render(<PipShell initialSessionId={sessionId} />);
}
