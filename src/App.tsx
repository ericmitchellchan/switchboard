import { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import type { AgentStatus, RepoConfig } from "./types";
import { TabBar } from "./components/TabBar";
import { SessionHeader } from "./components/SessionHeader";
import { TerminalPane, cleanupSessionListeners } from "./components/TerminalPane";
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
import { listen } from "@tauri-apps/api/event";
import { createSession, closeSession, renameSession, clearSessionScrollback } from "./lib/ipc";
import { disposeTerminal, getTerminal, setTerminalConfig } from "./lib/terminal";
import {
  loadWorkspaceFromStorage,
  buildSavedWorkspace,
  saveWorkspaceToStorage,
  saveAllScrollbacks,
  startPeriodicSave,
  stopPeriodicSave,
} from "./lib/workspace";
import { remapSessionIds, getMaxPaneIdNumber, setPaneIdCounter, closePane, getVisibleSessionIds, findPaneBySessionId } from "./lib/paneLayout";
import type { PaneNode } from "./lib/paneLayout";
import { initTaskDetector, destroyTaskDetector } from "./lib/taskDetector";
import "@xterm/xterm/css/xterm.css";

const DEFAULT_CWD = "C:\\Users\\ericm";

let sessionCounter = 0;

export default function App() {
  const config = useConfig();

  // Apply config font settings to terminal module
  useEffect(() => {
    setTerminalConfig({ fontSize: config.font_size, fontFamily: config.font });
  }, [config.font, config.font_size]);

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
    bulkSetSessions,
  } = useSessions();

  const { toasts, addToast, dismissToast, dismissBySessionId } = useToasts();
  const { activeTasks, completedTasks, addTask, addAutoTask, resolveByFingerprint, toggleTask, removeTask, clearCompleted } = useTasks();
  const { sidebarState, cycleSidebar } = useSidebarState();
  const paneLayout = usePaneLayout();

  const [searchOpen, setSearchOpen] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const activeIdRef = useRef(activeSessionId);
  activeIdRef.current = activeSessionId;

  const effectiveActiveIdRef = useRef<string | null>(null);

  // When active session changes via tab bar, sync with pane layout
  const switchToSession = useCallback(
    (sessionId: string) => {
      switchToSessionDirect(sessionId);
      dismissBySessionId(sessionId);
      if (paneLayout.root) {
        paneLayout.focusOrSwapSession(sessionId);
      }
    },
    [switchToSessionDirect, dismissBySessionId, paneLayout]
  );

  // Derive active session from focused pane when split
  const effectiveActiveSessionId = paneLayout.isSplit
    ? paneLayout.focusedSessionId ?? activeSessionId
    : activeSessionId;

  effectiveActiveIdRef.current = effectiveActiveSessionId;

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
    const id = effectiveActiveIdRef.current;
    if (!id) return;

    // Check if session will still be visible in another pane after closing
    let sessionStillVisible = false;
    if (paneLayout.root && paneLayout.focusedPaneId) {
      const newRoot = closePane(paneLayout.root, paneLayout.focusedPaneId);
      if (newRoot) {
        sessionStillVisible = getVisibleSessionIds(newRoot).includes(id);
      }
      paneLayout.close(paneLayout.focusedPaneId);
    }

    if (!sessionStillVisible) {
      try {
        destroyTaskDetector(id);
        cleanupSessionListeners(id);
        disposeTerminal(id);
        await closeSession(id);
        clearSessionScrollback(id).catch(() => {});
      } catch {
        // Session may already be gone
      }
      removeSession(id);
    }
  }, [removeSession, paneLayout]);

  // Close a specific session by ID (from tab X button)
  const handleCloseSpecificTab = useCallback(async (sessionId: string) => {
    // If session is in a pane, close that pane first
    if (paneLayout.root) {
      const pane = findPaneBySessionId(paneLayout.root, sessionId);
      if (pane) {
        const newRoot = closePane(paneLayout.root, pane.id);
        const stillVisible = newRoot ? getVisibleSessionIds(newRoot).includes(sessionId) : false;
        paneLayout.close(pane.id);
        if (stillVisible) return; // session still in another pane
      }
    }

    try {
      destroyTaskDetector(sessionId);
      cleanupSessionListeners(sessionId);
      disposeTerminal(sessionId);
      await closeSession(sessionId);
      clearSessionScrollback(sessionId).catch(() => {});
    } catch {
      // Session may already be gone
    }
    removeSession(sessionId);
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
      if (status === "waiting" && sessionId !== effectiveActiveIdRef.current) {
        const session = sessionsRef.current.find((s) => s.id === sessionId);
        if (session) {
          addToast(sessionId, session.name, "Needs your input", true);
        }
      } else if (status !== "waiting") {
        // Session left waiting state — dismiss any lingering toasts for it
        dismissBySessionId(sessionId);
      }
    },
    [updateSessionStatus, addToast, dismissBySessionId]
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

  // Listen for native clipboard-paste events (from hidden menu accelerator).
  // This handles Ctrl+V at the OS level, which catches simulated keystrokes
  // from tools like Wispr Flow that don't propagate through the webview.
  useEffect(() => {
    const unlisten = listen<string>("clipboard-paste", (event) => {
      const text = event.payload;
      if (!text) return;

      // If a non-terminal input is focused (e.g., dialog), paste into it
      const active = document.activeElement;
      const isTerminalTextarea = active?.classList.contains("xterm-helper-textarea");
      const isFormInput =
        active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;

      if (isFormInput && !isTerminalTextarea) {
        document.execCommand("insertText", false, text);
        return;
      }

      // Paste into the focused terminal session (respects bracketed paste mode)
      const sessionId = effectiveActiveIdRef.current;
      if (sessionId) {
        const instance = getTerminal(sessionId);
        if (instance) {
          instance.terminal.paste(text);
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Refs for periodic save to access latest state without re-creating the interval
  const sessionsRef2 = useRef(sessions);
  sessionsRef2.current = sessions;
  const activeIdRef2 = useRef(activeSessionId);
  activeIdRef2.current = activeSessionId;
  const paneLayoutRef = useRef(paneLayout);
  paneLayoutRef.current = paneLayout;

  // Restore workspace or create fresh session on mount
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;

    const savedWorkspace = loadWorkspaceFromStorage();

    if (savedWorkspace && savedWorkspace.sessions.length > 0) {
      // Restore from saved workspace
      (async () => {
        const idMap = new Map<string, string>();
        const newSessions: import("./types").Session[] = [];
        let restoredCounter = savedWorkspace.sessionCounter;

        for (const saved of savedWorkspace.sessions) {
          try {
            const info = await createSession(saved.name, saved.repo, saved.working_dir);
            idMap.set(saved.id, info.id);
            newSessions.push({
              ...info,
              status: "running",
              repoColor: saved.repoColor,
              group: saved.group,
              restoredFromId: saved.id,
            });
            initTaskDetector(info.id);
          } catch (err) {
            console.error("Failed to restore session:", saved.name, err);
          }
        }

        if (newSessions.length === 0) {
          // All restores failed — fall back to fresh session
          sessionCounter++;
          const name = `Shell ${sessionCounter}`;
          try {
            const info = await createSession(name, "", DEFAULT_CWD);
            addSession({ ...info, status: "running" });
            initTaskDetector(info.id);
            paneLayout.initLayout(info.id);
          } catch (e) {
            console.error("Failed to create session:", e);
          }
          return;
        }

        // Remap pane layout IDs
        sessionCounter = restoredCounter;
        const savedPaneLayout = savedWorkspace.paneLayout as PaneNode | null;
        let restoredRoot: PaneNode | null = null;
        let restoredFocusedPaneId: string | null = null;

        if (savedPaneLayout) {
          restoredRoot = remapSessionIds(savedPaneLayout, idMap);
          setPaneIdCounter(getMaxPaneIdNumber(restoredRoot));
          restoredFocusedPaneId = savedWorkspace.focusedPaneId;
        }

        // Determine active session
        const remappedActiveId = savedWorkspace.activeSessionId
          ? idMap.get(savedWorkspace.activeSessionId) ?? newSessions[0].id
          : newSessions[0].id;

        // Bulk-set sessions and pane layout
        bulkSetSessions(newSessions, remappedActiveId);

        if (restoredRoot) {
          paneLayout.setRoot(restoredRoot);
          if (restoredFocusedPaneId) {
            paneLayout.focusPane(restoredFocusedPaneId);
          }
        } else {
          // No saved pane layout — init with first session
          paneLayout.initLayout(newSessions[0].id);
        }
      })();
    } else {
      // Fresh start
      sessionCounter++;
      const name = `Shell ${sessionCounter}`;
      createSession(name, "", DEFAULT_CWD)
        .then((info) => {
          addSession({ ...info, status: "running" });
          initTaskDetector(info.id);
          paneLayout.initLayout(info.id);
        })
        .catch(console.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic save (every 30s) + beforeunload
  useEffect(() => {
    startPeriodicSave(() => ({
      sessions: sessionsRef2.current,
      activeSessionId: activeIdRef2.current,
      paneLayout: paneLayoutRef.current.root,
      focusedPaneId: paneLayoutRef.current.focusedPaneId,
      sessionCounter,
    }));

    const handleBeforeUnload = () => {
      const state = {
        sessions: sessionsRef2.current,
        activeSessionId: activeIdRef2.current,
        paneLayout: paneLayoutRef.current.root,
        focusedPaneId: paneLayoutRef.current.focusedPaneId,
        sessionCounter,
      };
      if (state.sessions.length > 0) {
        const workspace = buildSavedWorkspace(
          state.sessions,
          state.activeSessionId,
          state.paneLayout,
          state.focusedPaneId,
          state.sessionCounter
        );
        saveWorkspaceToStorage(workspace);
        // Fire-and-forget scrollback saves (can't await in beforeunload)
        saveAllScrollbacks(state.sessions).catch(() => {});
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      stopPeriodicSave();
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
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
        onClose={handleCloseSpecificTab}
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
          onClearCompleted={clearCompleted}
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
