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
import { createSession, closeSession, restartSession, renameSession, clearSessionScrollback, getHomeDir, flashTaskbar, notify } from "./lib/ipc";
import { disposeTerminal, getTerminal, setTerminalConfig, recoverAllWebGL, clearAllTextureAtlases, getAllTerminalIds, saveScrollPosition, getSavedScrollPosition } from "./lib/terminal";
import { enqueueFit } from "./lib/fitQueue";
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
import { checkForUpdates } from "./lib/updater";
import { log, initLogger } from "./lib/logger";
import "@xterm/xterm/css/xterm.css";

export default function App() {
  const sessionCounterRef = useRef(0);
  const homeDirRef = useRef("");

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
    moveSession,
    reorderSession,
    bulkSetSessions,
  } = useSessions();

  const { toasts, addToast, dismissToast, dismissBySessionId } = useToasts();
  const { activeTasks, completedTasks, addTask, addAutoTask, resolveByFingerprint, toggleTask, removeTask, clearCompleted, clearAll, clearAutoTasks } = useTasks();
  const { sidebarState, cycleSidebar: rawCycleSidebar } = useSidebarState();
  const paneLayout = usePaneLayout();

  // No wrapper needed — the fitQueue's per-session debounce (100ms) naturally
  // coalesces the ResizeObserver events that fire during sidebar width transition.
  const cycleSidebar = rawCycleSidebar;

  const [searchOpen, setSearchOpen] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);

  // Throttle notifications: don't re-notify the same session within 30s
  const lastNotifyRef = useRef(new Map<string, number>());

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const activeIdRef = useRef(activeSessionId);
  activeIdRef.current = activeSessionId;

  const effectiveActiveIdRef = useRef<string | null>(null);

  // When active session changes via tab bar, sync with pane layout
  const switchToSession = useCallback(
    (sessionId: string) => {
      log.info(`Switch to session id=${sessionId}`);
      switchToSessionDirect(sessionId);
      dismissBySessionId(sessionId);
      if (paneLayout.root) {
        paneLayout.focusOrSwapSession(sessionId);
      }
    },
    [switchToSessionDirect, dismissBySessionId, paneLayout]
  );

  // Reinit pane layout when root becomes null but sessions still exist
  // (e.g. closing the only pane via tab X button leaves root=null)
  useEffect(() => {
    if (!paneLayout.root && activeSessionId && sessions.length > 0) {
      log.warn(`Pane layout root is null but ${sessions.length} sessions exist — reinitializing with id=${activeSessionId}`);
      paneLayout.initLayout(activeSessionId);
    }
  }, [paneLayout.root, activeSessionId, sessions.length, paneLayout]);

  // Derive active session from focused pane when split
  const effectiveActiveSessionId = paneLayout.isSplit
    ? paneLayout.focusedSessionId ?? activeSessionId
    : activeSessionId;

  effectiveActiveIdRef.current = effectiveActiveSessionId;

  const effectiveActiveSession = sessions.find((s) => s.id === effectiveActiveSessionId) ?? null;

  // Helper: create a session and return its info
  const doCreateSession = useCallback(
    async (name: string, repo: string, workingDir: string, repoColor?: string, group?: string) => {
      const info = await createSession(name, repo, workingDir);
      addSession({ ...info, status: "running", repoColor, group });
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
    sessionCounterRef.current++;
    const name = `Shell ${sessionCounterRef.current}`;
    try {
      const info = await doCreateSession(name, "", homeDirRef.current);
      if (!paneLayout.root) {
        paneLayout.initLayout(info.id);
      } else {
        paneLayout.focusOrSwapSession(info.id);
      }
    } catch (err) {
      log.error(`Failed to create session: ${err}`);
    }
  }, [doCreateSession, config.repos.length, paneLayout]);

  const handleCreateSession = useCallback(
    async (name: string, repo: string, workingDir: string, repoColor?: string, group?: string) => {
      setNewSessionDialogOpen(false);
      try {
        const info = await doCreateSession(name, repo, workingDir, repoColor, group);
        if (!paneLayout.root) {
          paneLayout.initLayout(info.id);
        } else {
          paneLayout.focusOrSwapSession(info.id);
        }
      } catch (err) {
        log.error(`Failed to create session: ${err}`);
      }
    },
    [doCreateSession, paneLayout]
  );

  const handleCloseTab = useCallback(async () => {
    const id = effectiveActiveIdRef.current;
    if (!id) return;

    log.info(`Close active tab id=${id} paneId=${paneLayout.focusedPaneId} sessions=${sessionsRef.current.length}`);

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
      log.info(`Destroying session id=${id} (not visible in other panes)`);
      destroyTaskDetector(id);
      cleanupSessionListeners(id);
      disposeTerminal(id);
      try {
        await closeSession(id);
        clearSessionScrollback(id).catch(() => {});
      } catch {
        // PTY may already be gone
      }
      removeSession(id);
    } else {
      log.debug(`Session id=${id} still visible in another pane, keeping alive`);
    }
  }, [removeSession, paneLayout]);

  // Close a specific session by ID (from tab X button)
  const handleCloseSpecificTab = useCallback(async (sessionId: string) => {
    log.info(`Close specific tab id=${sessionId} sessions=${sessionsRef.current.length}`);

    // If session is in a pane, close that pane first
    if (paneLayout.root) {
      const pane = findPaneBySessionId(paneLayout.root, sessionId);
      if (pane) {
        const newRoot = closePane(paneLayout.root, pane.id);
        const stillVisible = newRoot ? getVisibleSessionIds(newRoot).includes(sessionId) : false;
        paneLayout.close(pane.id);
        if (stillVisible) {
          log.debug(`Session id=${sessionId} still visible in another pane, keeping alive`);
          return;
        }
      }
    }

    log.info(`Destroying session id=${sessionId}`);
    destroyTaskDetector(sessionId);
    cleanupSessionListeners(sessionId);
    disposeTerminal(sessionId);
    try {
      await closeSession(sessionId);
      clearSessionScrollback(sessionId).catch(() => {});
    } catch {
      // PTY may already be gone
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
    sessionCounterRef.current++;
    const name = `Shell ${sessionCounterRef.current}`;
    try {
      const info = await doCreateSession(name, "", homeDirRef.current);
      paneLayout.split("horizontal", info.id);
    } catch (err) {
      log.error(`Failed to create session for split: ${err}`);
    }
  }, [doCreateSession, paneLayout]);

  const handleSplitVertical = useCallback(async () => {
    if (!paneLayout.root) return;
    sessionCounterRef.current++;
    const name = `Shell ${sessionCounterRef.current}`;
    try {
      const info = await doCreateSession(name, "", homeDirRef.current);
      paneLayout.split("vertical", info.id);
    } catch (err) {
      log.error(`Failed to create session for split: ${err}`);
    }
  }, [doCreateSession, paneLayout]);

  const handleSessionExited = useCallback(
    (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      log.info(`Session exited id=${sessionId} name=${session?.name ?? "?"}`);
      updateSessionStatus(sessionId, "exited");
    },
    [updateSessionStatus]
  );

  const handleRestartSession = useCallback(
    async (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;

      log.info(`Restarting session id=${sessionId} name=${session.name}`);

      // Clean up old listeners and terminal state
      cleanupSessionListeners(sessionId);
      const inst = getTerminal(sessionId);
      if (inst) {
        inst.terminal.clear();
      }

      // Re-init task detector for fresh detection
      destroyTaskDetector(sessionId);
      initTaskDetector(sessionId);

      try {
        await restartSession(
          sessionId,
          session.name,
          session.repo,
          session.working_dir,
        );
        updateSessionStatus(sessionId, "running");
      } catch (err) {
        log.error(`Failed to restart session id=${sessionId}: ${err}`);
      }
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

      // Desktop notifications: fire when window is unfocused OR when a
      // non-active session needs attention (user is looking at another tab)
      const isBackground = !document.hasFocus();
      const isDifferentTab = sessionId !== effectiveActiveIdRef.current;
      if ((status === "waiting" || status === "error") && (isBackground || isDifferentTab)) {
        // Taskbar flash only when window is unfocused (no effect if already focused)
        if (isBackground) {
          flashTaskbar();
        }

        // Throttle: don't re-notify the same session within 30s
        const now = Date.now();
        const lastTime = lastNotifyRef.current.get(sessionId) ?? 0;
        if (now - lastTime > 30_000) {
          lastNotifyRef.current.set(sessionId, now);
          const session = sessionsRef.current.find((s) => s.id === sessionId);
          const name = session?.name ?? "Session";
          if (status === "waiting") {
            notify("Session needs input", `${name} is waiting for your response`);
          } else {
            notify("Session error", `${name} encountered an error`);
          }
        }
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

  const handleExport = useCallback(async () => {
    const id = effectiveActiveIdRef.current;
    if (!id) return;
    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;
    try {
      const { exportSessionOutput } = await import("./lib/export");
      await exportSessionOutput(id, session.name);
    } catch (err) {
      log.error(`Export failed: ${err}`);
    }
  }, []);

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
      onExport: handleExport,
      onMoveTabLeft: () => { if (effectiveActiveSessionId) moveSession(effectiveActiveSessionId, -1); },
      onMoveTabRight: () => { if (effectiveActiveSessionId) moveSession(effectiveActiveSessionId, 1); },
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

      log.debug(`Clipboard paste received, length=${text.length}`);

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

  // Listen for file drop events — paste file paths into the active terminal
  useEffect(() => {
    const unlisten = listen<string[]>("file-drop", (event) => {
      const paths = event.payload;
      if (!paths || paths.length === 0) return;

      // Quote paths containing spaces, join with space separator
      const formatted = paths
        .map((p) => (p.includes(" ") ? `"${p}"` : p))
        .join(" ");

      const sessionId = effectiveActiveIdRef.current;
      if (sessionId) {
        const instance = getTerminal(sessionId);
        if (instance) {
          instance.terminal.paste(formatted);
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

    (async () => {
      // Initialize logger first so all subsequent logs are captured
      await initLogger();
      log.info("Switchboard starting");
      // Resolve home directory before creating any sessions
      try {
        homeDirRef.current = await getHomeDir();
      } catch {
        homeDirRef.current = "";
      }

      const savedWorkspace = loadWorkspaceFromStorage();

      if (savedWorkspace && savedWorkspace.sessions.length > 0) {
        log.info(`Restoring workspace with ${savedWorkspace.sessions.length} sessions`);
        const idMap = new Map<string, string>();
        const newSessions: import("./types").Session[] = [];
        const restoredCounter = savedWorkspace.sessionCounter;

        for (const saved of savedWorkspace.sessions) {
          try {
            const info = await createSession(saved.name, saved.repo, saved.working_dir);
            log.info(`Restored session "${saved.name}" old=${saved.id} -> new=${info.id}`);
            idMap.set(saved.id, info.id);
            newSessions.push({
              ...info,
              status: "running",
              repoColor: saved.repoColor,
              group: saved.group,
              restoredFromId: saved.id,
              cols: saved.cols,
              rows: saved.rows,
            });
            initTaskDetector(info.id);
          } catch (err) {
            log.error(`Failed to restore session ${saved.name}: ${err}`);
          }
        }

        if (newSessions.length === 0) {
          // All restores failed — fall back to fresh session
          sessionCounterRef.current++;
          const name = `Shell ${sessionCounterRef.current}`;
          try {
            const info = await createSession(name, "", homeDirRef.current);
            addSession({ ...info, status: "running" });
            initTaskDetector(info.id);
            paneLayout.initLayout(info.id);
          } catch (e) {
            log.error(`Failed to create session: ${e}`);
          }
          return;
        }

        // Remap pane layout IDs
        sessionCounterRef.current = restoredCounter;
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
          paneLayout.initLayout(newSessions[0].id);
        }
      } else {
        // Fresh start
        log.info("No saved workspace, creating fresh session");
        sessionCounterRef.current++;
        const name = `Shell ${sessionCounterRef.current}`;
        try {
          const info = await createSession(name, "", homeDirRef.current);
          addSession({ ...info, status: "running" });
          initTaskDetector(info.id);
          paneLayout.initLayout(info.id);
        } catch (err) {
          log.error(`Failed to create session: ${err}`);
        }
      }

      // Check for updates after workspace init (non-blocking)
      checkForUpdates();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic save (every 30s) + beforeunload
  useEffect(() => {
    startPeriodicSave(() => ({
      sessions: sessionsRef2.current,
      activeSessionId: activeIdRef2.current,
      paneLayout: paneLayoutRef.current.root,
      focusedPaneId: paneLayoutRef.current.focusedPaneId,
      sessionCounter: sessionCounterRef.current,
    }));

    const handleBeforeUnload = () => {
      log.info(`beforeunload: saving workspace with ${sessionsRef2.current.length} sessions`);
      const state = {
        sessions: sessionsRef2.current,
        activeSessionId: activeIdRef2.current,
        paneLayout: paneLayoutRef.current.root,
        focusedPaneId: paneLayoutRef.current.focusedPaneId,
        sessionCounter: sessionCounterRef.current,
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

    const GPU_SETTLE_MS = 2_000; // wait for GPU after wake

    // Shared helpers for sleep/wake (used by both native events and heartbeat fallback)
    const saveWorkspaceNow = () => {
      const state = {
        sessions: sessionsRef2.current,
        activeSessionId: activeIdRef2.current,
        paneLayout: paneLayoutRef.current.root,
        focusedPaneId: paneLayoutRef.current.focusedPaneId,
        sessionCounter: sessionCounterRef.current,
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
        saveAllScrollbacks(state.sessions).catch(() => {});
      }
    };

    const recoverFromWake = () => {
      // Clear corrupt texture atlases (cheap, safe)
      clearAllTextureAtlases();

      // Re-enable lost WebGL contexts after GPU settles, then re-fit
      setTimeout(() => {
        recoverAllWebGL();
        for (const id of getAllTerminalIds()) {
          const inst = getTerminal(id);
          if (!inst?.terminal.element?.parentElement) continue;
          enqueueFit(id, "wake", {}, 0);
        }
      }, GPU_SETTLE_MS);
    };

    // --- Visibility change (alt-tab back) ---
    // WebView2 may discard GPU-rendered content when backgrounded.
    // Unlike sleep/wake, the WebGL context isn't lost — just the render surface is stale.
    const handleVisibilityChange = () => {
      const ids = getAllTerminalIds();
      if (document.visibilityState === "hidden") {
        log.info(`Window hidden — saving scroll positions for ${ids.length} terminals`);
        for (const id of ids) {
          saveScrollPosition(id);
        }
        return;
      }
      log.info(`Window became visible, refreshing ${ids.length} terminals`);
      clearAllTextureAtlases();
      for (const id of ids) {
        const inst = getTerminal(id);
        if (!inst?.terminal.element?.parentElement) continue;
        const saved = getSavedScrollPosition(id);
        enqueueFit(id, "visibility", { savedScroll: saved }, 0);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // --- Native power events (Win32 WM_POWERBROADCAST) ---
    // These fire reliably even when the JS event loop was frozen during sleep.
    const unlistenSuspend = listen("power:suspend", () => {
      log.info("Power suspend detected (native)");
      saveWorkspaceNow();
    });

    const unlistenResume = listen("power:resume", () => {
      log.info("Power resume detected (native)");
      recoverFromWake();
    });

    // --- Heartbeat fallback for non-native wake detection ---
    //
    // Neither visibilitychange nor window.blur fire reliably in
    // Tauri/WebView2 on Windows (see tauri#10592, WebView2Feedback#4626).
    // The heartbeat catches wake events the native path might miss
    // (e.g., VM pause, platforms without WM_POWERBROADCAST).
    const HEARTBEAT_MS = 10_000;       // 10s heartbeat
    const SLEEP_THRESHOLD_MS = 15_000; // 15s gap = definitely slept
    let lastHeartbeat = Date.now();

    const heartbeatTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastHeartbeat > SLEEP_THRESHOLD_MS) {
        log.info(`System wake detected via heartbeat fallback (gap=${Math.round((now - lastHeartbeat) / 1000)}s)`);
        saveWorkspaceNow();
        recoverFromWake();
      }
      lastHeartbeat = now;
    }, HEARTBEAT_MS);

    return () => {
      stopPeriodicSave();
      clearInterval(heartbeatTimer);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      unlistenSuspend.then((fn) => fn());
      unlistenResume.then((fn) => fn());
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
        onReorder={reorderSession}
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
              onRestart={handleRestartSession}
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
                  onRestart={handleRestartSession}
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
          onClearAll={clearAll}
          onClearAutoTasks={clearAutoTasks}
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
  onCreateSession: (name: string, repo: string, workingDir: string, repoColor?: string, group?: string) => void;
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
