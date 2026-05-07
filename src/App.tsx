import { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import type { AgentStatus, RepoConfig } from "./types";
import { TabBar } from "./components/TabBar";
import { SessionHeader } from "./components/SessionHeader";
import { TerminalPane, cleanupSessionListeners } from "./components/TerminalPane";
import { StatusBar } from "./components/StatusBar";
import { ToastStack } from "./components/Toast";
import { TaskSidebar } from "./components/TaskSidebar";
import { PaneContainer } from "./components/PaneContainer";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { useSessions } from "./hooks/useSessions";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useToasts } from "./hooks/useToasts";
import { useTasks } from "./hooks/useTasks";
import { useSidebarState } from "./hooks/useSidebarState";
import { useConfig } from "./hooks/useConfig";
import { usePaneLayout } from "./hooks/usePaneLayout";
import { listen } from "@tauri-apps/api/event";
import { createSession, closeSession, restartSession, renameSession, clearSessionScrollback, getHomeDir, flashTaskbar, notify, confirmAppClose, openPipWindow, closePipWindow, isPipWindowOpen } from "./lib/ipc";
import { disposeTerminal, getTerminal, setTerminalConfig, recoverAllWebGL, clearAllTextureAtlases, getAllTerminalIds, saveScrollPosition, getSavedScrollPosition, clearSessionDirty, isSessionDirty, serializeForPip } from "./lib/terminal";
import { onPipReady, sendPipOutput, onPipSwitchSession, broadcastPipSessions, onPipClosing } from "./lib/pipBridge";
import { onSessionOutput } from "./lib/ipc";
import type { Session } from "./types";
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

function shouldConfirmSessionClose(session: Session): boolean {
  if (session.status === "running" || session.status === "waiting") return true;
  if (isSessionDirty(session.id)) return true;
  return false;
}

function sessionConfirmMessage(session: Session): string {
  if (session.status === "running") {
    return `"${session.name}" is currently running. Closing will end the session and lose any in-progress work.`;
  }
  if (session.status === "waiting") {
    return `"${session.name}" is waiting for input. Closing will end the session.`;
  }
  return `"${session.name}" has unsaved output. Close anyway?`;
}

type ConfirmState = {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
};

const CLOSED_CONFIRM: ConfirmState = {
  open: false,
  title: "",
  message: "",
  onConfirm: () => {},
};

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
  const [confirmState, setConfirmState] = useState<ConfirmState>(CLOSED_CONFIRM);
  const [pipSessionId, setPipSessionId] = useState<string | null>(null);
  const pipSessionIdRef = useRef<string | null>(null);
  pipSessionIdRef.current = pipSessionId;
  // Cleanup hooks for the active PiP router. The router is wired in
  // handleTogglePip BEFORE the floating window opens — that way the pip:ready
  // signal can never arrive before main is listening, and PTY chunks are
  // sequenced through main so PiP and main render the same byte stream.
  const pipRouterCleanupRef = useRef<(() => void) | null>(null);

  const closeConfirm = useCallback(() => {
    setConfirmState((prev) => ({ ...prev, open: false }));
  }, []);

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

  // Helper: create a session and return its info
  const doCreateSession = useCallback(
    async (name: string, repo: string, workingDir: string, repoColor?: string, group?: string) => {
      const info = await createSession(name, repo, workingDir);
      addSession({ ...info, status: "idle", repoColor, group });
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

  // Tear down a session: terminal, PTY, scrollback, listeners, state.
  // Caller is responsible for any pane-layout changes BEFORE invoking this.
  // If the session is currently in PiP, closes the floating window first.
  const destroySession = useCallback(async (id: string) => {
    if (pipSessionIdRef.current === id) {
      log.info(`Closing PiP window for disposing session id=${id}`);
      try {
        await closePipWindow();
      } catch (e) {
        log.warn(`Failed to close PiP window during session disposal: ${e}`);
      }
      pipRouterCleanupRef.current?.();
      pipRouterCleanupRef.current = null;
      setPipSessionId(null);
    }
    log.info(`Destroying session id=${id}`);
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
  }, [removeSession]);

  const handleCloseTab = useCallback(async () => {
    const id = effectiveActiveIdRef.current;
    if (!id) return;
    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;

    const focusedPaneId = paneLayout.focusedPaneId;
    const root = paneLayout.root;

    // Pre-compute whether the session would still be visible in another pane
    // after closing the focused one — that branch never disposes the session,
    // so it never needs confirmation.
    let sessionStillVisible = false;
    if (root && focusedPaneId) {
      const newRoot = closePane(root, focusedPaneId);
      if (newRoot) {
        sessionStillVisible = getVisibleSessionIds(newRoot).includes(id);
      }
    }

    const performClose = () => {
      log.info(`Close active tab id=${id} paneId=${focusedPaneId} sessions=${sessionsRef.current.length}`);
      if (focusedPaneId) {
        paneLayout.close(focusedPaneId);
      }
      if (sessionStillVisible) {
        log.debug(`Session id=${id} still visible in another pane, keeping alive`);
      } else {
        void destroySession(id);
      }
    };

    if (!sessionStillVisible && shouldConfirmSessionClose(session)) {
      setConfirmState({
        open: true,
        title: "Close session?",
        message: sessionConfirmMessage(session),
        onConfirm: () => {
          closeConfirm();
          performClose();
        },
      });
      return;
    }

    performClose();
  }, [paneLayout, destroySession, closeConfirm]);

  // Close a specific session by ID (from tab X button)
  const handleCloseSpecificTab = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current.find((s) => s.id === sessionId);
    if (!session) return;

    let paneToClose: string | null = null;
    let sessionStillVisible = false;
    if (paneLayout.root) {
      const pane = findPaneBySessionId(paneLayout.root, sessionId);
      if (pane) {
        paneToClose = pane.id;
        const newRoot = closePane(paneLayout.root, pane.id);
        sessionStillVisible = newRoot ? getVisibleSessionIds(newRoot).includes(sessionId) : false;
      }
    }

    const performClose = () => {
      log.info(`Close specific tab id=${sessionId} sessions=${sessionsRef.current.length}`);
      if (paneToClose) {
        paneLayout.close(paneToClose);
        if (sessionStillVisible) {
          log.debug(`Session id=${sessionId} still visible in another pane, keeping alive`);
          return;
        }
      }
      void destroySession(sessionId);
    };

    if (!sessionStillVisible && shouldConfirmSessionClose(session)) {
      setConfirmState({
        open: true,
        title: "Close session?",
        message: sessionConfirmMessage(session),
        onConfirm: () => {
          closeConfirm();
          performClose();
        },
      });
      return;
    }

    performClose();
  }, [paneLayout, destroySession, closeConfirm]);

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
      // Clear stale dirty flag so the next periodic save doesn't write
      // pre-restart scrollback for a now-cleared terminal.
      clearSessionDirty(sessionId);

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
        updateSessionStatus(sessionId, "idle");
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

  // Wire (or rewire) the PiP router for a given session. Tears down any
  // existing router first. Used both on initial open and on session switch
  // from PiP's tab strip.
  const setupPipRouter = useCallback(async (sessionId: string) => {
    pipRouterCleanupRef.current?.();
    pipRouterCleanupRef.current = null;

    let isReady = false;
    let snapshotSent = false;
    const unlistenPipReady = await onPipReady((payload) => {
      if (payload.sessionId !== sessionId || snapshotSent) return;
      const snapshot = serializeForPip(sessionId);
      const text = snapshot?.text ?? "";
      const cols = snapshot?.cols ?? 80;
      const rows = snapshot?.rows ?? 24;
      log.info(`PiP ready id=${sessionId}, sending snapshot length=${text.length} cols=${cols} rows=${rows}`);
      void sendPipOutput(sessionId, { type: "snapshot", text, cols, rows }).catch((e) =>
        log.warn(`PiP snapshot send failed: ${e}`)
      );
      snapshotSent = true;
      // Order matters: flip isReady AFTER the snapshot is queued so any PTY
      // chunk that fires next on main's session:output handler is forwarded
      // strictly after the snapshot in PiP's event queue.
      isReady = true;
    });
    const unlistenPty = await onSessionOutput(sessionId, (b64data: string) => {
      if (!isReady) return; // pre-snapshot chunks are already in the snapshot
      void sendPipOutput(sessionId, { type: "pty", data: b64data }).catch((e) =>
        log.warn(`PiP pty forward failed: ${e}`)
      );
    });
    pipRouterCleanupRef.current = () => {
      unlistenPipReady();
      unlistenPty();
    };
  }, []);

  const handleTogglePip = useCallback(async () => {
    const isOpen = await isPipWindowOpen().catch(() => false);
    if (isOpen) {
      try {
        await closePipWindow();
      } catch (e) {
        log.warn(`Failed to close PiP window: ${e}`);
      }
      pipRouterCleanupRef.current?.();
      pipRouterCleanupRef.current = null;
      setPipSessionId(null);
      return;
    }
    const sessionId = effectiveActiveIdRef.current;
    if (!sessionId) return;

    // Wire the PiP router BEFORE opening the window. Listeners must be live
    // before pip:ready can arrive, otherwise the snapshot is never sent and
    // the first burst of PTY chunks is dropped on the floor.
    await setupPipRouter(sessionId);

    try {
      await openPipWindow(sessionId);
      setPipSessionId(sessionId);
    } catch (e) {
      log.warn(`Failed to open PiP window: ${e}`);
      pipRouterCleanupRef.current?.();
      pipRouterCleanupRef.current = null;
    }
  }, [setupPipRouter]);

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
      onTogglePip: handleTogglePip,
    },
    effectiveActiveSessionId
  );

  // Defensive: if the app unmounts (page reload) with PiP open, close it so
  // the floating window doesn't outlive its parent and tear down the router.
  useEffect(() => {
    return () => {
      pipRouterCleanupRef.current?.();
      pipRouterCleanupRef.current = null;
      void closePipWindow().catch(() => {});
    };
  }, []);

  // PiP tab strip: listen for session switches from the floating window and
  // rewire main's router to the new session. PiP fires pip:ready right after
  // its inner terminal remounts, which feeds into setupPipRouter's listener.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onPipSwitchSession((payload) => {
      log.info(`PiP requested session switch to id=${payload.sessionId}`);
      void setupPipRouter(payload.sessionId).catch((e) =>
        log.warn(`PiP router rewire failed: ${e}`)
      );
      setPipSessionId(payload.sessionId);
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
  }, [setupPipRouter]);

  // Broadcast the session list to PiP whenever it changes (and PiP is open).
  // PiP's tab strip uses this to render tabs and reflect status updates.
  useEffect(() => {
    if (!pipSessionId) return;
    const minimal = sessions.map((s) => ({ id: s.id, name: s.name, status: s.status }));
    void broadcastPipSessions(minimal).catch(() => {});
  }, [pipSessionId, sessions]);

  // PiP X button → tear down router + clear state. Without this the router
  // would stay subscribed (harmlessly forwarding to a dead listener) until
  // Ctrl+Shift+P toggled and reset things.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onPipClosing(() => {
      log.info(`PiP closing notification received`);
      pipRouterCleanupRef.current?.();
      pipRouterCleanupRef.current = null;
      setPipSessionId(null);
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

  // Tauri intercepts the OS close request so we can prompt for confirmation
  // before the app exits. If no session needs confirmation, exit immediately.
  useEffect(() => {
    const exitApp = async () => {
      // Close PiP first so the floating window doesn't outlive its parent
      try {
        await closePipWindow();
      } catch { /* may not be open; ignore */ }
      await confirmAppClose();
    };

    const unlisten = listen("app-close-requested", () => {
      const sessions = sessionsRef.current;
      const needsConfirm = sessions.some((s) => shouldConfirmSessionClose(s));

      if (!needsConfirm) {
        void exitApp();
        return;
      }

      const activeCount = sessions.filter(
        (s) => s.status === "running" || s.status === "waiting"
      ).length;
      const message =
        activeCount > 0
          ? `${activeCount} session${activeCount === 1 ? " is" : "s are"} still active. Closing Switchboard will end ${activeCount === 1 ? "it" : "them"} and lose any in-progress work.`
          : `${sessions.length} session${sessions.length === 1 ? " has" : "s have"} unsaved output. Close anyway?`;

      setConfirmState({
        open: true,
        title: "Close Switchboard?",
        message,
        onConfirm: () => {
          closeConfirm();
          void exitApp();
        },
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [closeConfirm]);

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
              status: "idle",
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
            addSession({ ...info, status: "idle" });
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
          addSession({ ...info, status: "idle" });
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
            // Single pane — render ALL sessions, toggle visibility via CSS.
            // Keeps xterm instances mounted in the DOM so tab switches don't
            // trigger detach/reattach (which resets scroll position).
            sessions.length > 0 ? (
              sessions.map((s) => {
                const isActive = s.id === effectiveActiveSessionId;
                return (
                  <div
                    key={s.id}
                    style={{
                      display: isActive ? "flex" : "none",
                      flexDirection: "column",
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <SessionHeader session={s} />
                    <TerminalPane
                      session={s}
                      visible={isActive}
                      searchOpen={isActive ? searchOpen : false}
                      onCloseSearch={() => setSearchOpen(false)}
                      onExited={handleSessionExited}
                      onStatusChange={handleStatusChange}
                      onAutoTask={handleAutoTask}
                      onResolveTask={resolveByFingerprint}
                      onRestart={handleRestartSession}
                    />
                  </div>
                );
              })
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

      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        onConfirm={confirmState.onConfirm}
        onCancel={closeConfirm}
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
