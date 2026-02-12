import { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import type { AgentStatus, RepoConfig } from "./types";
import { TabBar } from "./components/TabBar";
import { SessionHeader } from "./components/SessionHeader";
import { TerminalPane } from "./components/TerminalPane";
import { StatusBar } from "./components/StatusBar";
import { ToastStack } from "./components/Toast";
import { TaskSidebar } from "./components/TaskSidebar";
import { PaneContainer } from "./components/PaneContainer";
import { useSessions } from "./hooks/useSessions";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useToasts } from "./hooks/useToasts";
import { useTasks } from "./hooks/useTasks";
import { useSidebarState } from "./hooks/useSidebarState";
import { useConfig } from "./hooks/useConfig";
import { usePaneLayout } from "./hooks/usePaneLayout";
import { createSession, closeSession, renameSession } from "./lib/ipc";
import { disposeTerminal } from "./lib/terminal";
import { initTaskDetector, destroyTaskDetector } from "./lib/taskDetector";
import "@xterm/xterm/css/xterm.css";

const DEFAULT_CWD = "C:\\Users\\ericm";

let sessionCounter = 0;

export default function App() {
  const config = useConfig();

  const {
    sessions,
    activeSessionId,
    waitingCount,
    addSession,
    removeSession,
    renameSession: renameSessionLocal,
    updateSessionStatus,
    switchToSession: switchToSessionDirect,
    switchByIndex,
    switchRelative,
  } = useSessions();

  const { toasts, addToast, dismissToast } = useToasts();
  const { activeTasks, completedTasks, addTask, addAutoTask, resolveByFingerprint, toggleTask, removeTask } = useTasks();
  const { sidebarState, cycleSidebar } = useSidebarState();
  const paneLayout = usePaneLayout();

  const [searchOpen, setSearchOpen] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const activeIdRef = useRef(activeSessionId);
  activeIdRef.current = activeSessionId;

  // When active session changes via tab bar, sync with pane layout
  const switchToSession = useCallback(
    (sessionId: string) => {
      switchToSessionDirect(sessionId);
      if (paneLayout.root) {
        paneLayout.focusOrSwapSession(sessionId);
      }
    },
    [switchToSessionDirect, paneLayout]
  );

  // Derive active session from focused pane when split
  const effectiveActiveSessionId = paneLayout.isSplit
    ? paneLayout.focusedSessionId ?? activeSessionId
    : activeSessionId;

  const effectiveActiveSession = sessions.find((s) => s.id === effectiveActiveSessionId) ?? null;

  // Helper: create a session and return its info
  const doCreateSession = useCallback(
    async (name: string, repo: string, workingDir: string, repoColor?: string) => {
      const info = await createSession(name, repo, workingDir);
      addSession({ ...info, status: "running", repoColor });
      initTaskDetector(info.id);
      return info;
    },
    [addSession]
  );

  const handleNewTab = useCallback(async () => {
    if (config.repos.length > 0) {
      setNewSessionDialogOpen(true);
      return;
    }
    sessionCounter++;
    const name = `Shell ${sessionCounter}`;
    try {
      const info = await doCreateSession(name, "", DEFAULT_CWD);
      // Init pane layout if this is the first session
      if (!paneLayout.root) {
        paneLayout.initLayout(info.id);
      }
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, [doCreateSession, config.repos.length, paneLayout]);

  const handleCreateSession = useCallback(
    async (name: string, repo: string, workingDir: string, repoColor?: string) => {
      setNewSessionDialogOpen(false);
      try {
        const info = await doCreateSession(name, repo, workingDir, repoColor);
        if (!paneLayout.root) {
          paneLayout.initLayout(info.id);
        }
      } catch (err) {
        console.error("Failed to create session:", err);
      }
    },
    [doCreateSession, paneLayout]
  );

  const handleCloseTab = useCallback(async () => {
    const id = activeIdRef.current;
    if (!id) return;

    // If split, close the pane that has this session
    if (paneLayout.root && paneLayout.focusedPaneId) {
      // Close the focused pane and its session
      paneLayout.close(paneLayout.focusedPaneId);
    }

    try {
      destroyTaskDetector(id);
      disposeTerminal(id);
      await closeSession(id);
    } catch {
      // Session may already be gone
    }
    removeSession(id);
  }, [removeSession, paneLayout]);

  const handleClosePane = useCallback(() => {
    // Close pane but keep session alive
    if (!paneLayout.root || !paneLayout.focusedPaneId) return;
    paneLayout.close(paneLayout.focusedPaneId);
  }, [paneLayout]);

  const handleSplitHorizontal = useCallback(async () => {
    if (!paneLayout.root) return;
    sessionCounter++;
    const name = `Shell ${sessionCounter}`;
    try {
      const info = await doCreateSession(name, "", DEFAULT_CWD);
      paneLayout.split("horizontal", info.id);
    } catch (err) {
      console.error("Failed to create session for split:", err);
    }
  }, [doCreateSession, paneLayout]);

  const handleSplitVertical = useCallback(async () => {
    if (!paneLayout.root) return;
    sessionCounter++;
    const name = `Shell ${sessionCounter}`;
    try {
      const info = await doCreateSession(name, "", DEFAULT_CWD);
      paneLayout.split("vertical", info.id);
    } catch (err) {
      console.error("Failed to create session for split:", err);
    }
  }, [doCreateSession, paneLayout]);

  const handleSessionExited = useCallback(
    (sessionId: string) => {
      updateSessionStatus(sessionId, "exited");
    },
    [updateSessionStatus]
  );

  const handleStatusChange = useCallback(
    (sessionId: string, status: AgentStatus) => {
      updateSessionStatus(sessionId, status);
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

  const handleAutoTask = useCallback(
    (task: { text: string; fingerprint: string; priority: "high" | "med" | "low"; category: string }, sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      addAutoTask(task, sessionId, session?.repo);
    },
    [addAutoTask]
  );

  const toggleSearch = useCallback(() => {
    setSearchOpen((prev) => !prev);
  }, []);

  useKeyboardShortcuts(
    {
      onNewTab: handleNewTab,
      onCloseTab: handleCloseTab,
      onPrevTab: () => switchRelative(-1),
      onNextTab: () => switchRelative(1),
      onSwitchToIndex: switchByIndex,
      onToggleSidebar: cycleSidebar,
      onSearch: toggleSearch,
      onSplitHorizontal: handleSplitHorizontal,
      onSplitVertical: handleSplitVertical,
      onClosePane: handleClosePane,
      onMoveFocus: paneLayout.moveFocus,
    },
    effectiveActiveSessionId
  );

  // Auto-create first session on mount
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    sessionCounter++;
    const name = `Shell ${sessionCounter}`;
    createSession(name, "", DEFAULT_CWD)
      .then((info) => {
        addSession({ ...info, status: "running" });
        initTaskDetector(info.id);
        paneLayout.initLayout(info.id);
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        activeId={effectiveActiveSessionId}
        onSelect={switchToSession}
        onRename={handleRenameTab}
        waitingCount={waitingCount}
      />

      {newSessionDialogOpen && config.repos.length > 0 && (
        <NewSessionDialogLazy
          repos={config.repos}
          onCreateSession={handleCreateSession}
          onClose={() => setNewSessionDialogOpen(false)}
        />
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {paneLayout.root ? (
          paneLayout.isSplit ? (
            <PaneContainer
              root={paneLayout.root}
              sessions={sessions}
              focusedPaneId={paneLayout.focusedPaneId}
              searchOpen={searchOpen}
              onCloseSearch={() => setSearchOpen(false)}
              onFocusPane={paneLayout.focusPane}
              onResize={paneLayout.resize}
              onExited={handleSessionExited}
              onStatusChange={handleStatusChange}
              onAutoTask={handleAutoTask}
              onResolveTask={resolveByFingerprint}
              isSplit
            />
          ) : (
            // Single pane — render without PaneContainer overhead
            effectiveActiveSession ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <SessionHeader session={effectiveActiveSession} />
                <TerminalPane
                  session={effectiveActiveSession}
                  searchOpen={searchOpen}
                  onCloseSearch={() => setSearchOpen(false)}
                  onExited={handleSessionExited}
                  onStatusChange={handleStatusChange}
                  onAutoTask={handleAutoTask}
                  onResolveTask={resolveByFingerprint}
                />
              </div>
            ) : null
          )
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
          onSwitchToSession={switchToSession}
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

// Lazy wrapper for NewSessionDialog
const NewSessionDialogComponent = lazy(() =>
  import("./components/NewSessionDialog").then((m) => ({ default: m.NewSessionDialog }))
);

function NewSessionDialogLazy({
  repos,
  onCreateSession,
  onClose,
}: {
  repos: RepoConfig[];
  onCreateSession: (name: string, repo: string, workingDir: string, repoColor?: string) => void;
  onClose: () => void;
}) {
  return (
    <Suspense fallback={null}>
      <NewSessionDialogComponent
        repos={repos}
        onCreateSession={onCreateSession}
        onClose={onClose}
      />
    </Suspense>
  );
}
