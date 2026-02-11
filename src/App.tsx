import { useCallback, useEffect, useRef } from "react";
import { TabBar } from "./components/TabBar";
import { SessionHeader } from "./components/SessionHeader";
import { TerminalPane } from "./components/TerminalPane";
import { StatusBar } from "./components/StatusBar";
import { useSessions } from "./hooks/useSessions";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { createSession, closeSession } from "./lib/ipc";
import { disposeTerminal } from "./lib/terminal";
import "@xterm/xterm/css/xterm.css";

// Default working directory for new sessions
const DEFAULT_CWD =
  "C:\\Users\\ericm";

let sessionCounter = 0;

export default function App() {
  const {
    sessions,
    activeSessionId,
    activeSession,
    addSession,
    removeSession,
    updateSessionStatus,
    switchToSession,
    switchByIndex,
    switchRelative,
  } = useSessions();

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const activeIdRef = useRef(activeSessionId);
  activeIdRef.current = activeSessionId;

  const handleNewTab = useCallback(async () => {
    sessionCounter++;
    const name = `Shell ${sessionCounter}`;
    try {
      const info = await createSession(name, "", DEFAULT_CWD);
      addSession({
        ...info,
        status: "running",
      });
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, [addSession]);

  const handleCloseTab = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;
    try {
      disposeTerminal(id);
      await closeSession(id);
    } catch {
      // Session may already be gone
    }
    removeSession(id);
  }, [removeSession]);

  const handleSessionExited = useCallback(
    (sessionId: string) => {
      updateSessionStatus(sessionId, "exited");
    },
    [updateSessionStatus]
  );

  useKeyboardShortcuts(
    {
      onNewTab: handleNewTab,
      onCloseTab: handleCloseTab,
      onPrevTab: () => switchRelative(-1),
      onNextTab: () => switchRelative(1),
      onSwitchToIndex: switchByIndex,
    },
    activeSessionId
  );

  // Auto-create first session on mount
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    handleNewTab();
  }, [handleNewTab]);

  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "var(--bg-primary)",
        color: "var(--text-primary)",
        overflow: "hidden",
      }}
    >
      <TabBar
        sessions={sessions}
        activeId={activeSessionId}
        onSelect={switchToSession}
      />

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {activeSession ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              flex: 1,
              minWidth: 0,
            }}
          >
            <SessionHeader session={activeSession} />
            <TerminalPane
              session={activeSession}
              onExited={handleSessionExited}
            />
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: 16,
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 14,
                color: "#52525B",
              }}
            >
              No sessions open
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "#3F3F46",
              }}
            >
              Press Ctrl+T to open a new terminal
            </span>
          </div>
        )}
      </div>

      <StatusBar sessions={sessions} />
    </div>
  );
}
