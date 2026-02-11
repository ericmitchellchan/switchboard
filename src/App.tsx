import { useCallback, useEffect, useRef } from "react";
import type { AgentStatus } from "./types";
import { TabBar } from "./components/TabBar";
import { SessionHeader } from "./components/SessionHeader";
import { TerminalPane } from "./components/TerminalPane";
import { StatusBar } from "./components/StatusBar";
import { ToastStack } from "./components/Toast";
import { TaskSidebar } from "./components/TaskSidebar";
import { useSessions } from "./hooks/useSessions";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useToasts } from "./hooks/useToasts";
import { useTasks } from "./hooks/useTasks";
import { useSidebarState } from "./hooks/useSidebarState";
import { createSession, closeSession, renameSession } from "./lib/ipc";
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
    waitingCount,
    addSession,
    removeSession,
    renameSession: renameSessionLocal,
    updateSessionStatus,
    switchToSession,
    switchByIndex,
    switchRelative,
  } = useSessions();

  const { toasts, addToast, dismissToast } = useToasts();
  const { activeTasks, completedTasks, addTask, toggleTask, removeTask } = useTasks();
  const { sidebarState, cycleSidebar } = useSidebarState();

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

  const handleStatusChange = useCallback(
    (sessionId: string, status: AgentStatus) => {
      updateSessionStatus(sessionId, status);

      // Fire toast when a background tab enters "waiting"
      if (status === "waiting" && sessionId !== activeIdRef.current) {
        const session = sessionsRef.current.find((s) => s.id === sessionId);
        if (session) {
          addToast(sessionId, session.name, "Needs your input");
        }
      }
    },
    [updateSessionStatus, addToast]
  );

  const handleRenameTab = useCallback(
    (id: string, newName: string) => {
      renameSessionLocal(id, newName);
      renameSession(id, newName).catch(console.error);
    },
    [renameSessionLocal]
  );

  useKeyboardShortcuts(
    {
      onNewTab: handleNewTab,
      onCloseTab: handleCloseTab,
      onPrevTab: () => switchRelative(-1),
      onNextTab: () => switchRelative(1),
      onSwitchToIndex: switchByIndex,
      onToggleSidebar: cycleSidebar,
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
        onRename={handleRenameTab}
        waitingCount={waitingCount}
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
              onStatusChange={handleStatusChange}
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

        <TaskSidebar
          state={sidebarState}
          activeTasks={activeTasks}
          completedTasks={completedTasks}
          onToggle={toggleTask}
          onRemove={removeTask}
          onAdd={addTask}
          onExpand={cycleSidebar}
        />
      </div>

      <ToastStack
        toasts={toasts}
        onDismiss={dismissToast}
        onClickToast={(sessionId) => switchToSession(sessionId)}
      />

      <StatusBar
        sessions={sessions}
        taskCount={activeTasks.length}
        onToggleSidebar={cycleSidebar}
      />
    </div>
  );
}
