import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, Component, Fragment } from "react";
import { flushSync } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
import type { AgentStatus, Artifact, RepoConfig, ScreenId, Session, Thread } from "./types";
import { TopBar } from "./components/TabBar";
import { Home } from "./components/Home";
import { SessionHeader, DevServerOffer } from "./components/SessionHeader";
import { TerminalPane, cleanupSessionListeners } from "./components/TerminalPane";
import { StatusBar } from "./components/StatusBar";
import { ToastStack } from "./components/Toast";
import { TaskSidebar } from "./components/TaskSidebar";
import { SideMenu, useSideMenuVisibility } from "./components/SideMenu";
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
import { createSession, closeSession, restartSession, renameSession, clearSessionScrollback, getHomeDir, flashTaskbar, notify, confirmAppClose, openPipWindow, closePipWindow, isPipWindowOpen, writeToSession, loadThreads, claudeSessionExists, discoverClaudeSessions, onSessionOutput, kbReadDoc, kbWriteDoc, kbRoot, scrollbackRoot, saveTranscript } from "./lib/ipc";
import { disposeTerminal, getTerminal, setTerminalConfig, recoverAllWebGL, clearAllTextureAtlases, getAllTerminalIds, saveScrollPosition, getSavedScrollPosition, clearSessionDirty, isSessionDirty, serializeForPip, plainTextTerminal, setTerminalScreenVisible } from "./lib/terminal";
import { onPipReady, sendPipOutput, onPipSwitchSession, broadcastPipSessions, onPipClosing, sendPipHost } from "./lib/pipBridge";
import { bumpSessionGeneration, addSessionInputListener, getSessionGeneration } from "./lib/terminalRegistry";
import {
  initThreadStore,
  remapThreadSessionsInStore,
  mergeThreads,
  parseThreadsFromDisk,
  createThreadRecord,
  bindThreadSession,
  markThreadLaunched,
  clearThreadLaunched,
  isThreadLaunched,
  markChatStarted,
  sameWorkingDir,
  promoteThreadRecord,
  unbindThread,
  renameThread,
  setThreadArchived,
  getThreads,
  threadRepoName,
  setThreadBooting,
  markThreadSessionExited,
  unbindThreadsForSession,
  deleteThread,
  getThreadById,
  findThreadBySessionId,
  launchCommand,
  createChatStartDetector,
  defaultThreadTitle,
  publishSessionStatuses,
  registerThreadActions,
  waitForShellReady,
  tryBeginRevive,
  endRevive,
  selectMenuThreads,
  getThreadsView,
  publishMenuSessions,
} from "./lib/threadStore";
import {
  initPanelStore,
  initPanelSides,
  usePanelSide,
  togglePanelSide,
  setPanelThreadResolver,
  notePanelThreadBinding,
  isLocalhostUrlOpen,
  remapPanelSessions,
  removeSessionPanel,
  togglePanel,
  panelToggleAvailableFor,
  openArtifactPicker,
  publishActiveTabSession,
  registerPanelActions,
  artifactFor,
  artifactShortTitle,
  activeTabArtifact,
  describeArtifact,
  inheritPanel,
  getPanelWidth,
  usePanelIdentity,
  usePanelToggleAvailable,
  setPoppedOutArtifact,
  clearPoppedOutArtifact,
  usePoppedOutIdentity,
  // Increment H — panel-hosted terminals.
  openInPanel,
  isPanelOwnedSession,
  usePanelOwnedSessions,
  parkPanelSession,
  releasePanelSession,
  publishSessionLabels,
  flushTerminalTranscript,
  type NewPanelTerminal,
  type PanelActions,
  type SessionLabel,
} from "./lib/panelStore";
import { clearDevServerSession, setPreviewOpenCheck } from "./lib/devServer";
import { dirtyCount, flushDrafts } from "./lib/editor";
import {
  buildSpawnContext,
  refOptions,
  setKbRootForContext,
  setScrollbackRootForContext,
} from "./lib/agentContext";
import { runPromotionPass, promotionPassReason, PROMOTION_POLL_MS } from "./lib/threadPromotion";
import { explorerProjects, registerExplorerActions } from "./lib/explorer";
import { parsePinsFile, pinsForDoc, pinTargetFor, surfacePinTargetFor } from "./lib/pins";
import { configurePinsIO, getPinsFile } from "./lib/pinsStore";
import { ArtifactPanel, CRUMB_TONE } from "./components/ArtifactPanel";
import { NewThreadDialog } from "./components/NewThreadDialog";
import { DocView } from "./components/kb/DocView";
import { ExplorerView } from "./components/ExplorerView";
import { BackButton } from "./components/BackButton";
import { ThreadsScreen } from "./components/ThreadsScreen";
import { ProjectView } from "./components/ProjectView";
import { findSurface } from "./surfaces/registry";
import { enqueueFit } from "./lib/fitQueue";
import { useRoute, navigate, readRouteFromUrl, getNavState } from "./lib/route";
import {
  loadWorkspaceFromStorage,
  buildSavedWorkspace,
  saveWorkspaceToStorage,
  saveAllScrollbacks,
  saveThreadsToDisk,
  startPeriodicSave,
  stopPeriodicSave,
} from "./lib/workspace";
import { remapSessionIds, getMaxPaneIdNumber, setPaneIdCounter, closePane, getVisibleSessionIds } from "./lib/paneLayout";
import type { PaneNode } from "./lib/paneLayout";
import { toggleComposer } from "./lib/composer";
import { initTaskDetector, destroyTaskDetector } from "./lib/taskDetector";
import { startUpdater, registerPreRelaunchFlush } from "./lib/updater";
import { log, initLogger } from "./lib/logger";
import "@xterm/xterm/css/xterm.css";

// Pins sidecar IO, wired at MODULE scope — before any render, so the first
// WireframeView to mount can never find the store unwired (an effect would be
// too late). The store owns sharing + scheduling; these are the only two file
// operations it performs.
configurePinsIO({ read: kbReadDoc, write: kbWriteDoc });

// SWIT-47: the panel is per-THREAD. panelStore resolves a session to its
// thread through this injected lookup (it must not import threadStore); a
// session with no thread record keys a transient shell panel. Module scope
// for the same reason as the pins IO above.
setPanelThreadResolver((sessionId) => findThreadBySessionId(sessionId)?.id ?? null);

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

// ── Thread shell-ready detection (T5) ────────────────────────────────────────
// The wait logic (first ACCEPTED output chunk + settle, capped fallback —
// full reasoning and the generation-filter rules live on
// threadStore.waitForShellReady) is pure and injected; this adapter binds it
// to the session's Tauri output events and the registry's current spawn
// generation, so a restart's dying old-reader chunks can't fake "shell
// ready" on revive-into-an-exited-tab.

function waitForSessionShellReady(sessionId: string): Promise<void> {
  return waitForShellReady({
    subscribe: (cb) => onSessionOutput(sessionId, (_data, gen) => cb(gen)),
    expectedGen: () => getSessionGeneration(sessionId),
  });
}

// ── Panel context for a spawn (T8 / A4, seam 1) ──────────────────────────────
// What the launching tab's panel shows, as the sanitized one-liner that rides
// in `--append-system-prompt`. Derived from the TARGET TAB's own panel
// (panelStore is per-TAB), which is what makes the sentence TRUE by
// construction: a tab with no panel makes no claim and the flag is omitted
// entirely. It describes the tab's ACTIVE artifact (artifactFor) — with a
// strip of several open, the honest sentence is about the one on screen.
// BOTH spawn paths can be rich — revive restores the tab's panel
// from workspace v4, and create INHERITS the panel the user launched from
// (A5: handleCreateThread → panelStore.inheritPanel) — so a `+ new thread`
// started beside an open spec tells the new claude process what is on screen
// next to it, and the claim is true because the panel really is open there.
//
// Re-derived at EVERY spawn (never cached on the thread record): stale context
// dies with the session instead of following a conversation around forever.
//
// Never throws and never blocks the launch: a missing/unreadable sidecar just
// means zero pins.
async function resolveSpawnContext(sessionId: string): Promise<string | null> {
  const artifact = artifactFor(sessionId);
  if (!artifact) return null;
  let pinCount = 0;
  // Both FILE kinds can carry pins now: a KB doc's sidecar sits next to it, a
  // repo file's is mirrored into the hidden `_repo-pins/` KB tree. pinTargetFor
  // is the one place that knows which — and it reads out of the KB either way,
  // so the lookup below is unchanged.
  // A `session` artifact has no file and no pins, but it DOES have a ref now
  // (its transcript mirror — see agentContext.artifactRef). Flush it first, so
  // the sentence the new thread boots with points at a file that already
  // contains what the panel terminal has printed rather than at whatever the
  // periodic save last happened to write.
  if (artifact.kind === "session") {
    await flushTerminalTranscript(artifact.sessionId);
    return buildSpawnContext(artifact, 0, {
      ...refOptions(),
      sessionName: artifactShortTitle(artifact),
    });
  }
  if (artifact.kind === "kb-doc" || artifact.kind === "repo-file" || artifact.kind === "surface") {
    // A SURFACE files its pins per project (Inc 3d); the two file kinds keep
    // their sidecar / mirror. Same shared-record-first lookup for all three.
    const { sidecarPath, docKey } =
      artifact.kind === "surface" ? surfacePinTargetFor(artifact) : pinTargetFor(artifact);
    // Prefer the SHARED record when a view has it loaded: it is the same
    // record every mount edits and it is newer than disk during the write
    // debounce, so a pin placed a moment ago is counted instead of missed.
    // Only fall back to disk when nothing has the sidecar open.
    const shared = getPinsFile(sidecarPath);
    if (shared) {
      pinCount = pinsForDoc(shared, docKey).length;
    } else {
      try {
        const text = await kbReadDoc(sidecarPath);
        pinCount = pinsForDoc(parsePinsFile(text), docKey).length;
      } catch {
        // No sidecar for this doc (kb_read_doc errors on missing files) — the
        // artifact still gets announced, just without a pin clause.
      }
    }
  }
  return buildSpawnContext(artifact, pinCount, {
    ...refOptions(),
    // A surface's anchor vocabulary is the PAGE's (registry pinHint).
    anchorHint:
      artifact.kind === "surface" ? (findSurface(artifact.project, artifact.page)?.pinHint ?? null) : null,
  });
}

type ConfirmState = {
  open: boolean;
  title: string;
  message: string;
  /** Verb on the destructive button. Omitted = ConfirmDialog's "Close"
   *  default, which is right for the session-close callers but not for a
   *  delete — the button must name what it actually does. */
  confirmLabel?: string;
  /** Omitted = Enter confirms (the session-close default). Thread delete
   *  passes false so the destructive button cannot be fired by reflex —
   *  increment E, Decision 3. */
  enterConfirms?: boolean;
  /** Non-destructive alternatives (increment H): the panel-terminal close
   *  guard has three real outcomes, and two buttons could only offer them by
   *  lying about one. */
  extraActions?: Array<{ label: string; onClick: () => void }>;
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
    switchRelative,
    bulkSetSessions,
    // A panel terminal is a real session that is deliberately NOT in the tab
    // bar (increment H), so every "which tab now?" decision inside the hook —
    // Ctrl+1…9, Ctrl+[ / ], the next tab after a close — has to step over it.
    // The predicate reads the panel store, which is current the instant a
    // mutation lands, so `promote to tab` can release ownership and switch to
    // the promoted session in the same breath.
  } = useSessions(useCallback((s: Session) => !isPanelOwnedSession(s.id), []));

  // Sessions the TAB BAR and the PANE TREE may show: everything the panel does
  // not own. This is the load-bearing half of the one-live-view invariant —
  // the single-pane branch below mounts EVERY session it is given, so a
  // panel-owned session left in this list would be mounted twice and the
  // registry would have to arbitrate a steal.
  const panelOwnedSessions = usePanelOwnedSessions();
  const tabSessions = useMemo(
    () => (panelOwnedSessions.size === 0 ? sessions : sessions.filter((s) => !panelOwnedSessions.has(s.id))),
    [sessions, panelOwnedSessions]
  );

  const { toasts, addToast, dismissToast, dismissBySessionId } = useToasts();
  const { activeTasks, completedTasks, addTask, addAutoTask, resolveByFingerprint, toggleTask, removeTask, clearCompleted, clearAll, clearAutoTasks } = useTasks();
  const { sidebarState, cycleSidebar: rawCycleSidebar } = useSidebarState();
  const paneLayout = usePaneLayout();

  // ── Workstation navigation (T4) ──
  // Route state lives in the URL via src/lib/route.ts; the side menu is
  // additive chrome (hidden by default, Ctrl+Shift+B).
  const route = useRoute();
  const [sideMenuVisible, toggleSideMenu] = useSideMenuVisibility();

  // Grow-only keep-alive activation cache: a screen mounts on its first visit
  // and never unmounts (bounded by KEEP_ALIVE_SCREENS). Mutating a ref during
  // render for a memo cache is a supported React pattern — the same render
  // pass that adds a screen paints it. "terminal" is pre-seeded so the
  // workspace (sessions, xterm instances) always mounts at boot even when a
  // deep link lands on another screen.
  const activatedScreensRef = useRef<Set<ScreenId>>(new Set(["terminal"]));
  if (isKeepAliveScreen(route.screen)) activatedScreensRef.current.add(route.screen);
  const activatedScreens = activatedScreensRef.current;

  // T6: the kb screen's open doc. Route-driven while kb is active; while
  // hidden (keep-alive display:none) the last kb route keeps the prop STABLE
  // so the mounted screen doesn't unmount its DocView mid-hide (which would
  // drop scroll position and force a re-read on return). getNavState() is
  // safe to read during render — useRoute() already subscribes App to the
  // same store, and lastByScreen only changes on navigation.
  const lastKbRoute = getNavState().lastByScreen.kb;
  const kbDoc =
    route.screen === "kb"
      ? route.doc
      : lastKbRoute?.screen === "kb"
        ? lastKbRoute.doc
        : undefined;

  // Defensive: resync the store if something external mutates history. NOTE
  // writeRouteToUrl only ever replaceState's — no BROWSER history entries are
  // pushed, so Alt+Left has nothing to pop; the working back affordance is the
  // store's own stack, driven by `navigateBack` from the full-width screens'
  // BackButton (increment G). This listener stays a defensive resync, and
  // `navigate`'s same-route dedupe makes it a cheap no-op when nothing moved.
  useEffect(() => {
    const onPop = () => navigate(readRouteFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Screen-level WebGL policy (T11): a non-terminal route hides the whole
  // pane tree behind a screen-level display:none that TerminalPane's visible
  // prop never sees — treat every pane as hidden for WebGL purposes so KB /
  // Explorer visits don't keep GPU contexts alive; returning re-enables and
  // repaints (terminal.ts#setTerminalScreenVisible).
  useEffect(() => {
    setTerminalScreenVisible(route.screen === "terminal");
  }, [route.screen]);

  // No wrapper needed — the fitQueue's per-session debounce (150ms) naturally
  // coalesces the ResizeObserver events that fire during sidebar width transition.
  const cycleSidebar = rawCycleSidebar;

  const [searchOpen, setSearchOpen] = useState(false);
  const [newSessionDialogOpen, setNewSessionDialogOpen] = useState(false);
  // Session id for a toast that belongs to NO session (a spawn that failed —
  // there is nothing to focus). ToastStack's click handler skips it.
  const NO_SESSION = "";
  // How many projects the REGISTRY knows (increment B). The repo picker now
  // offers registry projects merged with config.repos, so "is there anything
  // to pick from?" can no longer be answered by config.repos alone — with an
  // empty config.json the twelve registry projects would be unreachable from
  // Ctrl+T. One cheap read of registry.json at boot; a failure just leaves the
  // old config-only gate in force.
  const [registryProjectCount, setRegistryProjectCount] = useState(0);
  const [newThreadDialogOpen, setNewThreadDialogOpen] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState>(CLOSED_CONFIRM);
  const [pipSessionId, setPipSessionId] = useState<string | null>(null);
  const pipSessionIdRef = useRef<string | null>(null);
  pipSessionIdRef.current = pipSessionId;
  // Cleanup hooks for the active PiP router. The router is wired in
  // handleTogglePip BEFORE the floating window opens — that way the pip:ready
  // signal can never arrive before main is listening, and PTY chunks are
  // sequenced through main so PiP and main render the same byte stream.
  const pipRouterCleanupRef = useRef<(() => void) | null>(null);
  /** An "open terminal here" spawn is in flight (double-submit guard). */
  const openTerminalBusyRef = useRef(false);

  // Active chatStarted detectors, keyed by session id (T5). Entries are
  // removed when the detector fires, when a revive re-arms the same session,
  // and in destroySession — a session closed before its first turn would
  // otherwise leak its entry here forever (the registry's own listener set is
  // already cleared by disposeTerminal; this map is App's bookkeeping).
  const chatDetectorRemoversRef = useRef(new Map<string, () => void>());

  const closeConfirm = useCallback(() => {
    setConfirmState((prev) => ({ ...prev, open: false }));
  }, []);

  // Throttle notifications: don't re-notify the same session within 30s
  const lastNotifyRef = useRef(new Map<string, number>());

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const activeIdRef = useRef(activeSessionId);
  activeIdRef.current = activeSessionId;
  // Which side the ACTIVE TAB keeps its panel on (SWIT-33) — drives the
  // pane-tree row's direction on the terminal screen.
  const panelSide = usePanelSide(activeSessionId);

  const effectiveActiveIdRef = useRef<string | null>(null);

  // When active session changes via tab bar, sync with pane layout
  const switchToSession = useCallback(
    (sessionId: string) => {
      log.info(`Switch to session id=${sessionId}`);
      // Any "show me this session" intent (tab click, toast, task sidebar)
      // implies the terminal screen (T4) — otherwise the switch would happen
      // invisibly behind KB/Explorer.
      if (getNavState().route.screen !== "terminal") navigate({ screen: "terminal" });
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
    // TAB sessions, not all sessions: a workspace whose only shells are panel
    // terminals has nothing for the pane tree to hold, and seeding it with one
    // would mount that terminal a second time.
    if (!paneLayout.root && activeSessionId && tabSessions.length > 0 && !isPanelOwnedSession(activeSessionId)) {
      log.warn(`Pane layout root is null but ${tabSessions.length} tab sessions exist — reinitializing with id=${activeSessionId}`);
      paneLayout.initLayout(activeSessionId);
    }
  }, [paneLayout.root, activeSessionId, tabSessions.length, paneLayout]);

  // Derive active session from focused pane when split
  const effectiveActiveSessionId = paneLayout.isSplit
    ? paneLayout.focusedSessionId ?? activeSessionId
    : activeSessionId;

  effectiveActiveIdRef.current = effectiveActiveSessionId;

  // Helper: create a session and return its info
  const doCreateSession = useCallback(
    async (name: string, repo: string, workingDir: string, repoColor?: string, group?: string) => {
      // A new session always lands on the terminal screen (T4) — the new tab
      // would otherwise be hidden behind the active KB/Explorer screen.
      if (getNavState().route.screen !== "terminal") navigate({ screen: "terminal" });
      const info = await createSession(name, repo, workingDir);
      addSession({ ...info, status: "idle", repoColor, group });
      initTaskDetector(info.id);
      return info;
    },
    [addSession]
  );

  useEffect(() => {
    let cancelled = false;
    explorerProjects()
      .then((list) => {
        if (!cancelled) setRegistryProjectCount(list.length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** Is there anything for the repo picker to offer beyond a plain shell? */
  const repoPickerAvailable = config.repos.length > 0 || registryProjectCount > 0;

  // KNOWN, DELIBERATE divergence from acceptance criterion 3's first clause
  // ("opening a new shell tab does NOT close or blank the panel"): panel state
  // is per-TAB (Decision 1, resolved AFTER that criterion was written), so a
  // brand-new shell has no panel and the panel visually disappears until you
  // switch back — the binding is intact, it just isn't this tab's. Only the
  // THREAD create path inherits (handleCreateThread → inheritPanel), because
  // there the inheritance also makes the spawn-context sentence true. Do not
  // "fix" this by making Ctrl+T inherit without deciding that a plain shell
  // should carry the previous tab's artifact — that is a product call, not a
  // bug.
  const handleNewTab = useCallback(async () => {
    if (repoPickerAvailable) {
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
  }, [doCreateSession, repoPickerAvailable, paneLayout]);

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
        // A spawn failure used to be log-only. That was survivable for the
        // DIALOG (which closes, so you see it did nothing) but not for the
        // Explorer's `>_`, where a renamed or deleted repo turns the
        // affordance into a click that silently does nothing at all.
        log.error(`Failed to create session: ${err}`);
        addToast(NO_SESSION, `Cannot open ${name}`, String(err));
      }
    },
    [doCreateSession, paneLayout, addToast]
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
    // Closing a thread's TAB kills the session but NOT the thread — the
    // binding is severed and the side menu shows the revive chip.
    unbindThreadsForSession(id);
    // The tab's panel binding dies WITH the tab (per-tab state, nothing to
    // revive) — unlike the thread record, which survives severed. Any PANEL
    // TERMINALS in that strip are PARKED rather than killed (increment H — see
    // removeSessionPanel): they keep running and stay reachable from any tab's
    // `+`, because a dev server dying because its host tab closed is the same
    // surprise the close guard exists to prevent.
    removeSessionPanel(id);
    // If THIS session was itself a panel terminal, the panel stops owning it in
    // the same batch as removeSession below — never before, or the pane tree
    // would mount a session that is already disposed.
    releasePanelSession(id);
    // Same for its dev-server detection state (increment F): the tail buffer,
    // the already-offered URLs and the cwd all die with the tab. Session ids
    // are never reused, so nothing would ever read them again.
    clearDevServerSession(id);
    // Drop any un-fired chatStarted detector bookkeeping for the session
    // (closed before its first turn). The registry listener itself died with
    // disposeTerminal; calling the stale remover is a harmless no-op.
    chatDetectorRemoversRef.current.get(id)?.();
    chatDetectorRemoversRef.current.delete(id);
    void saveThreadsToDisk();
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

  // (The per-tab × close went with the tab strip — Ctrl+W closes the active
  // session, and a thread row's ⋯ menu covers the rest.)

  const handleClosePane = useCallback(() => {
    // Close pane but keep session alive
    if (!paneLayout.root || !paneLayout.focusedPaneId) return;
    paneLayout.close(paneLayout.focusedPaneId);
  }, [paneLayout]);

  // (The split-creation handlers retired with the split chords — SWIT-45. A
  // restored workspace can still HOLD a split; PaneContainer renders it and
  // Ctrl+Shift+W unwinds it, but nothing creates a new one.)

  const handleSessionExited = useCallback(
    (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      log.info(`Session exited id=${sessionId} name=${session?.name ?? "?"}`);
      updateSessionStatus(sessionId, "exited");
      // A bound thread stays (tab binding kept — the exit tail is readable
      // there) but is no longer live: its row shows the revive chip.
      markThreadSessionExited(sessionId);
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

      // Bump the expected spawn generation BEFORE the invoke: the old PTY is
      // killed inside restart_session, so by the time any new-generation
      // event can exist the registry already expects it — and the old reader
      // thread's dying output/exited events (stamped with the previous gen)
      // are dropped whenever they trickle in, instead of stamping garbage
      // above the new prompt or re-latching the fresh session as exited.
      const gen = bumpSessionGeneration(sessionId);

      try {
        // Spawn the new PTY at the live terminal's grid — xterm keeps its
        // real cols/rows across restart, and omitting them spawned the shell
        // at the 120x30 default until the next fit SIGWINCHed it.
        await restartSession(
          sessionId,
          session.name,
          session.repo,
          session.working_dir,
          inst?.terminal.cols,
          inst?.terminal.rows,
          gen,
        );
        updateSessionStatus(sessionId, "idle");
      } catch (err) {
        log.error(`Failed to restart session id=${sessionId}: ${err}`);
      }
    },
    [updateSessionStatus]
  );

  // ── Threads (T5) ───────────────────────────────────────────────────────────

  // Arm the chatStarted detector on the thread's session. Fires on the first
  // REAL user turn (Enter with content, outside a bracketed paste — see
  // createChatStartDetector) and then disarms itself. The seam is the
  // registry's additive input-listener channel: it observes the exact onData
  // stream the PTY receives, without touching the once-only PTY wiring or
  // TerminalPane's SessionHooks slot. Our own launch line goes through
  // writeToSession (IPC), NOT xterm onData, so it can never trip the detector.
  const armChatStartDetector = useCallback((sessionId: string, threadId: string) => {
    // Disarm any previous detector on this session first — a revive that
    // reuses the bound tab (restart path) would otherwise stack listeners,
    // because the terminal instance (and thus the registry's listener set)
    // survives in-place restarts.
    chatDetectorRemoversRef.current.get(sessionId)?.();
    const detect = createChatStartDetector();
    const remove = addSessionInputListener(sessionId, (data) => {
      if (!detect(data)) return;
      remove();
      chatDetectorRemoversRef.current.delete(sessionId);
      log.info(`Thread first real turn — chatStarted id=${threadId}`);
      markChatStarted(threadId);
      // Critical-field flush: losing chatStarted to a crash inside the 30s
      // periodic window would make the next revive relaunch fresh instead of
      // resuming (the conversation exists on disk but we'd forget it does).
      void saveThreadsToDisk();
    });
    chatDetectorRemoversRef.current.set(sessionId, remove);
  }, []);

  // Type the thread's claude launch line into its (shell) session once the
  // shell is ready. Never exec claude directly — the shell-then-type path is
  // the cross-platform-proven one.
  //
  // The --resume vs --session-id choice is GROUND TRUTH: claude_session_exists
  // checks whether the transcript .jsonl actually exists on disk (decision
  // table on threadStore.launchCommand). chatStarted stays a UI hint — kept
  // in sync with disk truth here, but never the decider. This heals both
  // detector failure directions: the shell false positive (Ctrl+C claude,
  // then `git status⏎` flips the flag forever) and the PiP bypass false
  // negative (first turn typed in the PiP window never reaches the main
  // window's detector).
  const launchClaudeInSession = useCallback(
    async (sessionId: string, threadId: string) => {
      const thread = getThreadById(threadId);
      if (!thread) return;
      await waitForSessionShellReady(sessionId);
      let resume: boolean;
      try {
        resume = await claudeSessionExists(thread.workingDir, thread.chatSessionId);
      } catch (err) {
        // Ground truth unavailable (home dir unresolvable?) — fall back to
        // the chatStarted hint rather than failing the launch.
        log.warn(`claude_session_exists failed id=${threadId}, falling back to chatStarted: ${err}`);
        resume = thread.chatStarted;
      }
      if (resume && !thread.chatStarted) {
        // Disk says the conversation started (e.g. its first turn happened in
        // the PiP window) — re-sync the hint.
        markChatStarted(threadId);
        void saveThreadsToDisk();
      }
      // T8 seam 1: what this tab's panel shows, re-derived HERE so every spawn
      // carries current context and a failure degrades to no flag at all.
      let panelContext: string | null = null;
      try {
        panelContext = await resolveSpawnContext(sessionId);
      } catch (err) {
        log.warn(`Panel context unavailable for thread id=${threadId}: ${err}`);
      }
      const line = launchCommand({
        chatSessionId: thread.chatSessionId,
        resume,
        appendSystemPrompt: panelContext,
      });
      log.info(`Thread launch id=${threadId} session=${sessionId} exists=${resume}: ${line}`);
      try {
        await writeToSession(sessionId, line + "\r");
      } catch (err) {
        // No claude behind the row after all — roll back liveness so the row
        // returns to its revive chip instead of lying live.
        log.error(`Failed to type thread launch line id=${threadId}: ${err}`);
        clearThreadLaunched(threadId);
        setThreadBooting(threadId, false);
        return;
      }
      if (!resume) armChatStartDetector(sessionId, threadId);
    },
    [armChatStartDetector]
  );

  const handleCreateThread = useCallback(
    async (repoName: string, workingDir: string, repoColor: string | undefined, group: string | undefined, title: string) => {
      setNewThreadDialogOpen(false);
      const finalTitle = title || defaultThreadTitle(repoName);
      const thread = createThreadRecord({ title: finalTitle, workingDir });
      // Same re-entrancy gate as handleReviveThread, taken SYNCHRONOUSLY
      // before the first await: the row renders as soon as the record exists,
      // but sessionId stays null until the create below resolves — clicking
      // it in that window would route openThread → revive → tryBeginRevive
      // succeeds → a SECOND shell on the same chatSessionId. Holding the gate
      // through the create makes that click bail. (Always true for a fresh
      // uuid; the check keeps the invariant explicit.) Released in finally.
      if (!tryBeginRevive(thread.id)) return;
      // A5: what the tab he was LOOKING AT shows, captured synchronously —
      // creating the session flips the active tab, after which this reads the
      // new (empty) one. The new thread inherits it below so seam 1's
      // "panel shows X" is a fact about the new tab rather than a claim about
      // a panel that isn't open (see panelStore.inheritPanel).
      const inherited = activeTabArtifact();
      log.info(`Create thread id=${thread.id} chatSessionId=${thread.chatSessionId} dir=${workingDir}`);
      try {
        const info = await doCreateSession(finalTitle, repoName, workingDir, repoColor, group);
        if (!paneLayout.root) {
          paneLayout.initLayout(info.id);
        } else {
          paneLayout.focusOrSwapSession(info.id);
        }
        bindThreadSession(thread.id, info.id);
        // SWIT-47: the fresh session now resolves to the thread's panel key.
        notePanelThreadBinding(info.id);
        // Before the launch below: resolveSpawnContext reads THIS tab's panel.
        if (inheritPanel(inherited, info.id)) {
          log.info(`Thread inherits panel id=${thread.id} session=${info.id}`);
        }
        markThreadLaunched(thread.id);
        void saveThreadsToDisk();
        void launchClaudeInSession(info.id, thread.id);
      } catch (err) {
        log.error(`Failed to create thread session: ${err}`);
      } finally {
        endRevive(thread.id);
      }
    },
    [doCreateSession, paneLayout, launchClaudeInSession]
  );

  // Revive a dead thread: get a live shell (reuse the bound tab when one
  // exists — restart it if its PTY exited — else spawn a fresh session in
  // workingDir), then type `claude --resume <uuid>` (or `--session-id` if the
  // conversation never started — nothing exists on disk to resume yet). A
  // visible resume error in the terminal is acceptable v1: the user sees it;
  // we never parse claude's output.
  const handleReviveThread = useCallback(
    async (threadId: string) => {
      const thread = getThreadById(threadId);
      if (!thread) return;
      if (isThreadLaunched(threadId)) {
        // Already live — treat as open.
        if (thread.sessionId) switchToSession(thread.sessionId);
        return;
      }
      // Re-entrancy gate, taken SYNCHRONOUSLY before the first await: the
      // session-create await below runs with the thread still unbound and
      // unlaunched, so a second click in that window would route through
      // openThread → sessionId null → revive AGAIN — two shells resuming one
      // conversation. Released in the finally.
      if (!tryBeginRevive(threadId)) return;
      log.info(`Revive thread id=${threadId} chatStarted=${thread.chatStarted}`);
      setThreadBooting(threadId, true);
      // Booting window: ~10s of MCP/tool reload is normal on --resume. The
      // chip clears on a timer (no output parsing in v1).
      window.setTimeout(() => setThreadBooting(threadId, false), 12_000);
      try {
        const boundTab = thread.sessionId
          ? sessionsRef.current.find((s) => s.id === thread.sessionId)
          : undefined;
        // The bound tab is only reusable if its shell is actually IN the
        // thread's directory. For an explicitly-created thread that is always
        // true (we spawned the tab there), so this changes nothing for T5.
        // For a PROMOTED thread it need not be: `Ctrl+T` (spawns in the
        // configured dir), `cd repo`, `claude` binds the conversation to
        // `repo`, and after a restart the restored tab is back at its ORIGINAL
        // cwd. Typing `claude --resume` there would look for the transcript
        // under the wrong munged path and quietly find nothing. We cannot `cd`
        // the shell (never mutate a live shell), so we SPAWN a fresh tab in
        // the right directory instead — the same "only ever spawn" posture the
        // Explorer's open-terminal-here affordance takes.
        const bound =
          boundTab && sameWorkingDir(boundTab.working_dir, thread.workingDir)
            ? boundTab
            : undefined;
        if (boundTab && !bound) {
          log.info(
            `Revive id=${threadId}: bound tab cwd ${boundTab.working_dir} != thread dir ${thread.workingDir}, spawning a fresh shell there`
          );
        }
        let sessionId: string;
        if (bound) {
          // The thread kept a tab binding (restored workspace, or its claude
          // exited in place). Reuse the tab: restart the PTY if it died,
          // otherwise type into the live shell.
          if (bound.status === "exited") await handleRestartSession(bound.id);
          switchToSession(bound.id);
          sessionId = bound.id;
        } else {
          const parts = thread.workingDir.split(/[/\\]/).filter(Boolean);
          const repoName = parts[parts.length - 1] ?? thread.workingDir;
          const repoCfg = config.repos.find((r) => r.path === thread.workingDir);
          const info = await doCreateSession(
            thread.title,
            repoName,
            thread.workingDir,
            repoCfg?.color,
            repoCfg?.group
          );
          if (!paneLayout.root) {
            paneLayout.initLayout(info.id);
          } else {
            paneLayout.focusOrSwapSession(info.id);
          }
          bindThreadSession(threadId, info.id);
          // SWIT-47: the fresh session resolves to the thread's panel key —
          // this is the seam that makes a revived thread's strip reappear.
          notePanelThreadBinding(info.id);
          sessionId = info.id;
        }
        markThreadLaunched(threadId);
        void saveThreadsToDisk();
        await launchClaudeInSession(sessionId, threadId);
      } catch (err) {
        log.error(`Failed to revive thread id=${threadId}: ${err}`);
        clearThreadLaunched(threadId);
        setThreadBooting(threadId, false);
      } finally {
        endRevive(threadId);
      }
    },
    [config.repos, doCreateSession, paneLayout, switchToSession, handleRestartSession, launchClaudeInSession]
  );

  const handleOpenThread = useCallback(
    (threadId: string) => {
      const thread = getThreadById(threadId);
      if (!thread) return;
      if (thread.sessionId && sessionsRef.current.some((s) => s.id === thread.sessionId)) {
        switchToSession(thread.sessionId);
      } else {
        void handleReviveThread(threadId);
      }
    },
    [switchToSession, handleReviveThread]
  );

  // Ctrl+1–9 (SWIT-45): jump to the Nth THREAD in side-menu order — the same
  // selection + ordering the rail renders (selectMenuThreads: live first,
  // archived hidden), so the chord and the menu can never disagree about what
  // "thread 3" is. A dead thread revives, exactly like clicking its row.
  const handleJumpToThread = useCallback(
    (index: number) => {
      const rows = selectMenuThreads(getThreads(), getThreadsView().launched, 9);
      const thread = rows[index];
      if (thread) handleOpenThread(thread.id);
    },
    [handleOpenThread]
  );

  const handleDeleteThread = useCallback((threadId: string) => {
    log.info(`Delete thread id=${threadId}`);
    deleteThread(threadId);
    void saveThreadsToDisk();
  }, []);

  // THE delete gate (increment E, Decision 3). ONE dialog, not two stacked
  // ones: sequential confirmations train reflexive clicking and make the
  // second meaningless. Its safety comes from two things instead —
  //
  //   · `enterConfirms: false`, so the destructive button is unreachable by
  //     reflex (Cancel holds focus; Enter and Esc are both harmless);
  //   · copy that says precisely what IS and IS NOT lost. claude's own
  //     transcript on disk is not deleted and never has been; what goes is
  //     Switchboard's record of the conversation's id, which is the only thing
  //     the revive affordance runs on. That distinction belongs in the dialog,
  //     not in a comment — a user deciding here cannot read this file.
  //
  // The last line names the reversible alternative, because a user who is
  // hesitating usually wants archive.
  const handleConfirmDeleteThread = useCallback(
    (threadId: string) => {
      const thread = getThreadById(threadId);
      if (!thread) return;
      setConfirmState({
        open: true,
        title: `Delete “${thread.title}”?`,
        confirmLabel: "Delete thread",
        enterConfirms: false,
        message:
          `This deletes Switchboard's RECORD of the thread — its row, and the conversation id that "revive" needs. That cannot be undone.\n\n` +
          `claude's own transcript on disk is NOT deleted. Nothing under ~/.claude is touched; Switchboard just stops knowing how to reach it.\n\n` +
          `The thread's terminal tab, if one is open, keeps running.\n\n` +
          `To put the thread away without losing any of that, archive it instead.`,
        onConfirm: () => {
          closeConfirm();
          handleDeleteThread(threadId);
        },
      });
    },
    [closeConfirm, handleDeleteThread]
  );

  // Rename (Decision 4) and archive (Decision 5) both mutate the record and
  // must survive a restart, so both flush the disk mirror exactly like the
  // other critical mutations — the 30s periodic save is not a durability
  // guarantee for something the user just typed.
  // The other half of the one-name rule (see handleRenameTab): renaming from a
  // thread row renames the TAB it is bound to. Read the record back AFTER the
  // rename rather than trusting the typed string — an emptied box falls back to
  // the derived default (`lodestar · Jul 31`), and the tab must show that, not
  // become blank.
  const handleRenameThread = useCallback((threadId: string, title: string) => {
    renameThread(threadId, title);
    void saveThreadsToDisk();
    const thread = getThreadById(threadId);
    if (thread?.sessionId) {
      renameSessionLocal(thread.sessionId, thread.title);
      renameSession(thread.sessionId, thread.title).catch(console.error);
    }
  }, [renameSessionLocal]);

  const handleSetThreadArchived = useCallback((threadId: string, archived: boolean) => {
    log.info(`${archived ? "Archive" : "Unarchive"} thread id=${threadId}`);
    setThreadArchived(threadId, archived);
    void saveThreadsToDisk();
  }, []);

  // Bridge App's handlers to ThreadsSection (module singleton — see
  // threadStore.ThreadActions).
  useEffect(() => {
    registerThreadActions({
      openThread: handleOpenThread,
      reviveThread: (id) => void handleReviveThread(id),
      newThread: () => setNewThreadDialogOpen(true),
      confirmDeleteThread: handleConfirmDeleteThread,
      renameThread: handleRenameThread,
      setThreadArchived: handleSetThreadArchived,
    });
    return () => registerThreadActions(null);
  }, [
    handleOpenThread,
    handleReviveThread,
    handleConfirmDeleteThread,
    handleRenameThread,
    handleSetThreadArchived,
  ]);

  // ── Tab/thread parity (increment C) ────────────────────────────────────────
  // A conversation started by typing `claude` into a plain tab used to be
  // ORPHANED: no thread row, no revive chip, unrecoverable after a restart.
  // This interval notices it and promotes the tab to a real thread.
  //
  // OBSERVE-ONLY, by construction: the pass calls discoverClaudeSessions
  // (a process snapshot + JSON reads in Rust) and claudeSessionExists (a stat).
  // There is no writeToSession anywhere on this path — the standing
  // never-mutate-a-live-shell rule is not a review note here, it is the reason
  // discovery reads process trees instead of asking the shell anything.
  //
  // Cadence is deliberately lazy (PROMOTION_POLL_MS), and a tick where every
  // tab already has a thread costs ZERO IPC (shouldRunPromotionPass). Reads go
  // through refs/getters rather than the deps array so the interval is
  // installed exactly once and never restarts on a session change.
  useEffect(() => {
    let running = false;
    // When a pass last actually ran. Drives the BOUND SWEEP: with every tab
    // bound the gate would otherwise never fire again, and a `claude` restarted
    // inside the one open tab would never be noticed (increment E's supersede
    // unreachable in its commonest shape). See promotionPassReason.
    let lastPassAt = 0;
    const tick = () => {
      // A pass is async; overlapping passes could plan two records from one
      // discovery. One at a time.
      if (running) return;
      const reason = promotionPassReason(
        sessionsRef.current.map((s) => s.id),
        getThreads(),
        Date.now(),
        lastPassAt
      );
      if (!reason) return;
      lastPassAt = Date.now();
      if (reason === "sweep") {
        log.debug("Promotion sweep — every tab is bound, re-checking for a restarted claude");
      }
      running = true;
      void runPromotionPass({
        liveSessionIds: () => sessionsRef.current.map((s) => s.id),
        threads: () => getThreads(),
        discover: discoverClaudeSessions,
        chatStartedOnDisk: claudeSessionExists,
        createThread: (args) => promoteThreadRecord(args).id, // startedAt → createdAt
        bindThread: (threadId, sessionId) => {
          bindThreadSession(threadId, sessionId);
          // SWIT-47: a shell promoted on `claude` carries its strip into the
          // thread — the transient panel key moves to the thread key.
          notePanelThreadBinding(sessionId);
        },
        // Decision 1: a restarted claude does not overwrite the old record's
        // uuid — the old thread is released (still revivable) and the pass
        // creates a new one through the SAME createThread above.
        unbindThread,
        markLaunched: markThreadLaunched,
        persist: () => void saveThreadsToDisk(),
        defaultTitle: (repoName) => defaultThreadTitle(repoName),
        repoName: threadRepoName,
        log: (message) => log.info(message),
      }, reason).finally(() => {
        running = false;
      });
    };
    const id = window.setInterval(tick, PROMOTION_POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  // Bridge "open terminal here" (Explorer project rows) to the SAME creation
  // path the repo picker uses — handleCreateSession → doCreateSession →
  // createSession(name, repo, workingDir) → addSession → pane focus, plus
  // doCreateSession's reveal of the terminal screen. Not a fork of it: the
  // affordance is a repo-picker choice made from the tree instead of the
  // dialog, and it must behave identically.
  //
  // NEVER-MUTATE GUARANTEE: this path only SPAWNS. There is no
  // writeToSession, no `cd`, no keystroke aimed at an existing terminal —
  // every existing shell (mid-command, running claude, or in a REPL) is
  // untouched. Decision 2 keeps the useful half and drops the risky one.
  //
  // Double-submit guard: the dialog path is protected by closing itself on
  // select, but `>_` stays under the cursor, and a session spawn is a slow
  // async call — a double-click would otherwise create two sessions in the
  // same repo. A ref, not state: the affordance unmounts when hover ends, so
  // component-local state would forget the in-flight spawn.
  useEffect(() => {
    registerExplorerActions({
      openTerminalHere: (name, workingDir) => {
        if (openTerminalBusyRef.current) return;
        openTerminalBusyRef.current = true;
        void handleCreateSession(name, name, workingDir).finally(() => {
          openTerminalBusyRef.current = false;
        });
      },
      // A `terminals` row in the Projects section (SWIT-31) is a plain tab
      // switch — the same intent as a tab click or a toast, through the same
      // path (it also lands on the terminal screen). A PANEL-OWNED session is
      // refused outright: the tree already filters them, and this is the
      // structural backstop — switchToSession would leave the tab alone but
      // still swap a pane onto the id, which is the second-live-view case.
      showSession: (id) => {
        if (isPanelOwnedSession(id)) return;
        switchToSession(id);
      },
    });
    return () => registerExplorerActions(null);
  }, [handleCreateSession, switchToSession]);

  // Publish session statuses + active session so thread rows can render live
  // status dots (statusConfig colors) and the active-row highlight.
  useEffect(() => {
    const statuses: Record<string, AgentStatus> = {};
    for (const s of sessions) statuses[s.id] = s.status;
    publishSessionStatuses(statuses, effectiveActiveSessionId);
    // TAB sessions only (panel-owned already filtered out of tabSessions) —
    // the menu's `shells` group derives from these minus thread-bound ones
    // (threadStore.selectShellSessions), so a promotion moves the row without
    // a second publication. Skip-if-unchanged lives in the store.
    publishMenuSessions(
      tabSessions.map((s) => ({
        id: s.id,
        name: s.name,
        workingDir: s.working_dir,
        status: s.status,
      }))
    );
  }, [sessions, tabSessions, effectiveActiveSessionId]);

  // The same publication, one layer over, for the PANEL (increment H): a
  // `session` artifact carries an id and nothing else, so the tab strip, the
  // header and the `+` picker read the name + live status from here. Separate
  // from the thread bridge above because it carries the NAME too, and because
  // panelStore must not import threadStore to get it.
  useEffect(() => {
    const labels = new Map<string, SessionLabel>();
    for (const s of sessions) {
      labels.set(s.id, { name: s.name, status: s.status, workingDir: s.working_dir });
    }
    publishSessionLabels(labels);
  }, [sessions]);

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

  // (Tab reorder/move retired with the tab strip — SWIT-45. Session ORDER
  // still exists in state for Ctrl+[ ] cycling, it just has no drag surface.)

  // ONE NAME, TWO SURFACES (2026-08-02). A tab and the thread bound to it are
  // the same conversation seen from the tab bar and from the side menu, and
  // they START synced — handleCreateThread passes one title to both. Only
  // RENAME forked them: renaming the tab left the thread row saying the old
  // thing, so Eric had to type the name twice and the two lists disagreed
  // about what he was working on.
  //
  // Both directions go through the PRIMITIVES (renameThread /
  // renameSessionLocal), never through each other's handler, so there is no
  // ping-pong to guard against; `renameThread` also returns early when the
  // title is unchanged. A tab with no thread is unaffected — a `Ctrl+T` shell
  // has no record to keep in step (see the promote-on-claude rule).
  const handleRenameTab = useCallback(
    (id: string, newName: string) => {
      renameSessionLocal(id, newName);
      renameSession(id, newName).catch(console.error);
      const thread = findThreadBySessionId(id);
      if (thread) {
        renameThread(thread.id, newName);
        void saveThreadsToDisk();
      }
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
    const unlistenPty = await onSessionOutput(sessionId, (b64data: string, gen: number) => {
      if (!isReady) return; // pre-snapshot chunks are already in the snapshot
      // Mirror the registry's stale-generation drop: after an in-place
      // restart, the dying old reader's chunks are filtered from main's
      // terminal — PiP must not render bytes main never shows.
      if (gen !== getSessionGeneration(sessionId)) return;
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
      // The window may have been hosting an ARTIFACT rather than a terminal
      // (increment F) — closing it returns that artifact to the panel, exactly
      // as the window's own × does.
      clearPoppedOutArtifact();
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

  // ── Artifact panel (workstation v2) ──
  // Panel state is per-TAB (Decision 1), so everything here keys on
  // `activeSessionId` — the TAB — and deliberately NOT on
  // effectiveActiveSessionId, which follows the focused PANE in a split.
  // Requirements: a split terminal + panel "just shares the width"; moving
  // pane focus must not swap or blank the panel, and persistence must not
  // fork one binding per pane.
  //
  // Ctrl+Shift+P is a TRUE toggle now that A3's routing gives the panel an
  // open path: it hides the WHOLE panel — the entire tab strip, since one
  // session can now hold many artifacts (panelStore remembers the strip per
  // tab) — and restores it on the next press. The status-bar chip is shown
  // ONLY when the chord would actually do something, so it never advertises a
  // no-op. Closing ONE artifact is the strip's own `×`, not this chord.
  const handleTogglePanel = useCallback(() => {
    const sessionId = activeIdRef.current;
    // A genuinely dead chord stays dead — no panel and no memory means no
    // screen change either (the StatusBar chip is hidden in that state, so
    // this only guards the raw keystroke).
    if (!panelToggleAvailableFor(sessionId)) return;
    // Content first, screen second — exactly applyOpenDecision's order. The
    // panel renders ONLY on the terminal screen while the chord and the chip
    // are live on every screen, so without this reveal a press from KB /
    // Explorer opens or closes a surface the user cannot see and reads as a
    // no-op: the same "advertising a dead chord" lie the chip gate exists to
    // prevent, just from the other direction.
    togglePanel(sessionId);
    if (getNavState().route.screen !== "terminal") navigate({ screen: "terminal" });
  }, []);

  // The TAB BAR's panel button (right end of the bar, the wordmark's
  // counterpart). It is NOT a plain alias for the chord: a toggle on a tab
  // that has never opened anything would do nothing at all, and a button that
  // visibly does nothing is the dead affordance we have now fixed twice. So:
  //
  //   · panel open, or hidden-but-remembered → toggle it (exactly the chord);
  //   · nothing ever opened here → open the `+` PICKER, which is the manual
  //     "open an artifact" flow the button is really promising.
  //
  // Same content-first-screen-second order as the chord, and for the same
  // reason: the panel and its picker live on the terminal screen, so acting
  // from KB/Explorer without revealing it would read as a no-op.
  const handlePanelButton = useCallback(() => {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    if (panelToggleAvailableFor(sessionId)) togglePanel(sessionId);
    else openArtifactPicker(sessionId);
    if (getNavState().route.screen !== "terminal") navigate({ screen: "terminal" });
  }, []);

  // ── Composer (increment D) ──
  // Ctrl+Shift+M toggles the composer on the FOCUSED PANE's session, not the
  // tab's — deliberately the opposite of the panel above, and for the same
  // underlying reason. The panel is per-TAB because a split "just shares the
  // width"; the composer is per-PANE because it TYPES INTO A SESSION, and in a
  // split the session your keystrokes reach is the focused pane's (Decision 2).
  // Same target `handleSendToThread` writes to.
  //
  // The terminal screen is revealed first, mirroring handleTogglePanel: the
  // composer renders only there, so toggling from KB/Explorer would otherwise
  // flip a surface the user cannot see.
  const handleToggleComposer = useCallback(() => {
    const sessionId = effectiveActiveIdRef.current ?? activeIdRef.current;
    if (!sessionId) return;
    toggleComposer(sessionId);
    if (getNavState().route.screen !== "terminal") navigate({ screen: "terminal" });
  }, []);

  // The KB root never changes while the app runs — fetch it once so T8's
  // builders can emit ABSOLUTE doc paths (a thread's cwd is a repo; a
  // KB-relative path is not resolvable from inside the conversation). On
  // failure the refs stay KB-relative, which is weaker but still honest.
  useEffect(() => {
    kbRoot()
      .then(setKbRootForContext)
      .catch((err) => log.warn(`kb_root unavailable — agent refs stay KB-relative: ${err}`));
    // Same shape, same reason, for PANEL TERMINALS: a live shell's ref is its
    // transcript file, which needs the mirror directory's absolute path. On
    // failure a session artifact simply has no ref, which is the behaviour that
    // shipped before the linkage existed — degraded, never wrong.
    scrollbackRoot()
      .then(setScrollbackRootForContext)
      .catch((err) =>
        log.warn(`scrollback_root unavailable — panel terminals stay unreferenceable: ${err}`)
      );
  }, []);

  // T8 seam 2 — send-to-thread. TYPES the reference into the terminal and
  // STOPS: no trailing \r, because pressing Enter for the user is exactly the
  // dishonesty this feature refuses. He reads it, edits it, sends it.
  //
  // Target = the FOCUSED session (the pane his keystrokes actually go to),
  // falling back to the tab's own session; in the common unsplit case they are
  // the same id. The terminal screen is revealed first — typing into a surface
  // he cannot see would read as a no-op — and the terminal is focused after
  // the write so the very next key lands in the composer.
  //
  // NOTE (verified against terminalRegistry): this write is IPC, not xterm
  // onData, so it does NOT feed the chatStarted detector — see the comment on
  // armChatStartDetector. The user's Enter DOES reach the detector, but with
  // `hasContent` still false (the detector never saw our text), so a bare
  // Enter on a send-to-thread line does not flip the hint. Harmless by
  // design: chatStarted is a UI hint only and revive decides from disk ground
  // truth (claude_session_exists), which re-syncs the hint on the next launch.
  const handleSendToThread = useCallback((text: string) => {
    const sessionId = effectiveActiveIdRef.current ?? activeIdRef.current;
    if (!sessionId || text.length === 0) return;
    if (getNavState().route.screen !== "terminal") navigate({ screen: "terminal" });
    log.info(`Send to thread session=${sessionId}: ${text}`);
    writeToSession(sessionId, text)
      .then(() => getTerminal(sessionId)?.terminal.focus())
      .catch((err) => log.error(`Failed to type reference into session=${sessionId}: ${err}`));
  }, []);

  // POP OUT (increment F, Decision 2) — hand the panel's active artifact to
  // the FLOATING window, which is the same window Ctrl+Shift+O mirrors a
  // terminal into. One window lifecycle, two host modes:
  //
  //   · window already open (terminal mirror or another artifact) → RE-AIM it
  //     over `pip:host`. Closing and recreating a window that is already on
  //     screen would flash and would lose its position and size.
  //   · window closed → open it straight into artifact mode via the URL.
  //
  // The store is only told AFTER the window actually has it: a failed open must
  // not leave the panel showing "it's in the floating window" for a window that
  // does not exist. The terminal router is torn down either way — the window is
  // no longer mirroring a shell, and leaving the forwarder live would keep
  // pushing PTY bytes at a page with no terminal to write them to.
  const handlePopOutArtifact = useCallback(
    async (artifact: Artifact) => {
      const sessionId = activeIdRef.current;
      const json = JSON.stringify(artifact);
      const wasOpen = await isPipWindowOpen().catch(() => false);
      try {
        if (wasOpen) {
          await sendPipHost(json);
        } else {
          // `sessionId` still rides along so the window can fall back to a
          // terminal mirror if the artifact is ever taken away from it.
          await openPipWindow(sessionId ?? "", json);
        }
      } catch (e) {
        log.warn(`Failed to pop artifact out to the floating window: ${e}`);
        return;
      }
      pipRouterCleanupRef.current?.();
      pipRouterCleanupRef.current = null;
      setPipSessionId(null);
      if (sessionId) setPoppedOutArtifact(sessionId, artifact);
    },
    []
  );

  // ── PANEL TERMINALS (increment H) ────────────────────────────────────────
  // A shell that lives in the panel instead of a pane. Three actions, all of
  // them App's because they touch sessions, the pane layout or the confirm
  // dialog — the panel owns only the artifact record.

  /** `+ → new terminal` is in flight (double-submit guard). Its own ref, not
   *  the Explorer's: a spawn from the tree must not silently swallow a `+`. */
  const panelTerminalBusyRef = useRef(false);

  // CREATE — through App's EXISTING creation path (doCreateSession), never a
  // fork of it, then open the result as a `session` artifact in the tab that
  // asked. The three store writes after the await are SYNCHRONOUS and
  // deliberately so: `addSession` makes the new session active and (for that
  // instant) a tab-bar candidate, and React 18 batches all of it into ONE
  // commit — so the session is already panel-owned by the time anything
  // renders, and the active tab never visibly moves.
  const handleCreatePanelTerminal = useCallback(
    (tabSessionId: string, target: NewPanelTerminal) => {
      if (panelTerminalBusyRef.current) return;
      panelTerminalBusyRef.current = true;
      void (async () => {
        try {
          const info = await doCreateSession(
            target.name,
            target.repo,
            target.workingDir,
            target.repoColor,
            target.group
          );
          log.info(`Panel terminal created id=${info.id} tab=${tabSessionId} dir=${target.workingDir}`);
          openInPanel(tabSessionId, { kind: "session", sessionId: info.id });
          switchToSessionDirect(tabSessionId);
        } catch (err) {
          log.error(`Failed to create panel terminal: ${err}`);
          addToast(NO_SESSION, `Cannot open ${target.name}`, String(err));
        } finally {
          panelTerminalBusyRef.current = false;
        }
      })();
    },
    [doCreateSession, switchToSessionDirect, addToast]
  );

  // FLUSH — write a session's buffer to its AGENT-FACING transcript, now.
  //
  // This is the whole of the panel-terminal → agent linkage on App's side. A
  // running shell is not something claude can attach to, but its output is
  // text, and text is a file claude can Read. Two things make that honest:
  //
  //  · PLAIN TEXT, not the restore mirror. `<id>.txt` is an xterm serialize
  //    (SGR runs, absolute cursor moves) because restore and PiP write it back
  //    into a terminal; an agent handed that is being handed noise. So this
  //    writes `<id>.transcript.txt` from `plainTextTerminal`.
  //  · FRESHNESS. Nothing writes the transcript on a timer, so it is produced
  //    HERE, at the moment a reference to it is built — a reference typed a
  //    second after `pnpm dev` failed must point at a file that contains the
  //    failure, not at whatever a background save last happened to catch.
  //
  // Never rejects: a failed flush leaves an older (or absent) file, and the
  // reference is still worth typing — its wording already tells the agent the
  // file is a snapshot to re-read.
  const handleFlushTerminalTranscript = useCallback(async (sessionId: string) => {
    const text = plainTextTerminal(sessionId);
    if (text === null) return;
    try {
      await saveTranscript(sessionId, text);
    } catch (err) {
      log.warn(`Transcript flush failed id=${sessionId} — the agent gets an older file: ${err}`);
    }
  }, []);

  // PROMOTE — MOVE the session to the tab bar. ONE LIVE VIEW ACROSS THE MOVE,
  // guaranteed by taking two commits instead of one:
  //
  //   1. PARK inside flushSync. The artifact leaves the strip, so the panel
  //      UNMOUNTS its TerminalPane — the instance parks in the keep-alive root
  //      and keeps consuming PTY output. Ownership is RETAINED, so the pane
  //      tree cannot mount it in this commit. flushSync is what makes the
  //      unmount happen here rather than whenever React next renders.
  //   2. RELEASE + place. Ownership ends and the tab bar / pane tree take it;
  //      the single-pane branch mounts it and `acquireTerminal` ADOPTS the
  //      parked instance (scrollback intact, nothing replayed).
  //
  // No steal can fire: at the moment acquireTerminal runs, the panel's mount
  // has already released the instance, so `adopt` sees no owner.
  const handlePromotePanelTerminal = useCallback(
    (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) {
        // Nothing to promote — just stop claiming it.
        releasePanelSession(sessionId);
        return;
      }
      log.info(`Promoting panel terminal to tab id=${sessionId}`);
      // Both halves are tagged `promote-move` so the removal audit reads as a
      // MOVE rather than as two unexplained drops (see panelStore's audit).
      flushSync(() => parkPanelSession(sessionId, "promote-move"));
      releasePanelSession(sessionId, "promote-move");
      if (!paneLayout.root) paneLayout.initLayout(sessionId);
      switchToSession(sessionId);
    },
    [paneLayout, switchToSession]
  );

  // CLOSE — and ASK when the process is alive. A dev server dying because a
  // tab closed is exactly the surprise this app should not have, so the guard
  // states what each outcome does instead of hiding two of them behind one
  // button. Enter is unbound (increment E's rule for a destructive default):
  // Cancel holds focus, and the destructive button here would end a process.
  const handleClosePanelTerminal = useCallback(
    (_tabSessionId: string, sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      // Nothing alive to protect: the record is gone, or the shell already
      // exited (its buffer is the only thing left, and closing the tab is what
      // the user just asked for). Even here the view is taken away FIRST —
      // releasing ownership before `removeSession` lands would leave one commit
      // in which the pane tree could mount a session that is being disposed.
      if (!session) {
        releasePanelSession(sessionId);
        return;
      }
      if (session.status === "exited") {
        flushSync(() => parkPanelSession(sessionId));
        void destroySession(sessionId);
        return;
      }
      const name = session.name;
      setConfirmState({
        open: true,
        title: "This terminal is still running",
        message:
          `"${name}" has a live process in this panel tab.\n\n` +
          `Keep it running — closes the tab only. The shell keeps going with no view; ` +
          `reopen it from the panel's + under "running terminals" (this app session only — ` +
          `a restart respawns it as an ordinary tab).\n\n` +
          `Promote to tab — moves it to the tab bar, scrollback intact, still one live terminal.\n\n` +
          `Kill it — ends the process and closes the session. Its scrollback goes with it.`,
        confirmLabel: "Kill it",
        enterConfirms: false,
        extraActions: [
          {
            label: "Keep it running",
            onClick: () => {
              closeConfirm();
              parkPanelSession(sessionId);
            },
          },
          {
            label: "Promote to tab",
            onClick: () => {
              closeConfirm();
              handlePromotePanelTerminal(sessionId);
            },
          },
        ],
        onConfirm: () => {
          closeConfirm();
          // Take the view away FIRST (park + commit), then kill: the pane tree
          // must never mount a session that is being disposed, and
          // destroySession's own `releasePanelSession` ends ownership in the
          // same batch as `removeSession`.
          flushSync(() => parkPanelSession(sessionId));
          void destroySession(sessionId);
        },
      });
    },
    [closeConfirm, destroySession, handlePromotePanelTerminal]
  );

  // THE ONE LIVE VIEW of a panel terminal. Handed to ArtifactPanel, which
  // renders it in exactly one place (the body of the active tab of the active
  // tab's panel) and nowhere else — ArtifactSurface deliberately refuses to
  // draw a terminal, so no other host can become a second view.
  //
  // A plain function, not a useCallback: ArtifactPanel is not memoized, so it
  // re-renders with App and this closure is always current.
  const renderPanelSession = (panelSessionId: string): ReactNode => {
    const session = sessions.find((s) => s.id === panelSessionId);
    if (!session) {
      // The artifact outlived its session (a failed restore, or a race with a
      // close). Say so rather than painting an empty black column.
      return (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            textAlign: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-dim)",
          }}
        >
          This terminal's session is gone.
        </div>
      );
    }
    return (
      <>
        {/* THE OFFER, FOR A SHELL THAT HAS NO HEADER (2026-08-02). Detection
            already ran here — `noteDevServerOutput` hangs off the registry's
            per-session output hook, so a `pnpm dev` in the panel was noticed
            whether or not anything was mounted — but the chip lives on
            SessionHeader, which a panel terminal does not render. The offer was
            therefore recorded and INVISIBLE: reachable only if you thought to
            open `+` and read the detected-URL list. Since the panel is exactly
            where Eric runs dev servers, that was the common case failing.

            Rendered as a SIBLING above TerminalPane (whose root is `flex: 1`
            inside the panel's column), so it costs no layout while there is no
            offer and, when one appears, the resulting height change goes
            through the pane's existing ResizeObserver → fitQueue → grow-only
            policy like any other. Same component, same rules, same wording —
            not a second implementation that could drift. */}
        <DevServerOffer session={session} compact={false} framed />
        <TerminalPane
        key={session.id}
        session={session}
        // The panel only renders on the terminal screen at all, so this is the
        // same condition every other panel body gets — and it drives the same
        // show/hide + WebGL path a pane's does. `isFocused` is FALSE: mounting
        // a panel terminal must not steal the keyboard from the pane Eric is
        // typing in. Clicking it focuses it, exactly like any terminal.
        visible={route.screen === "terminal"}
        searchOpen={false}
        onCloseSearch={() => setSearchOpen(false)}
        onExited={handleSessionExited}
        onStatusChange={handleStatusChange}
        onAutoTask={handleAutoTask}
        onResolveTask={resolveByFingerprint}
        onRestart={handleRestartSession}
        isFocused={false}
        />
      </>
    );
  };

  // Bridge them to the panel header + the wireframe pin rail (module singleton —
  // see panelStore.PanelActions).
  //
  // REGISTERED ONCE, THROUGH A REF — load-bearing, not tidiness.
  // `registerPanelActions` calls the store's `bump()`, which re-renders every
  // panelStore subscriber, App among them (`usePanelIdentity`,
  // `usePanelOwnedSessions`, …). An effect keyed on the HANDLERS' identities
  // therefore closes a feedback loop the moment any one of them is unstable —
  // and `handlePromotePanelTerminal` depends on `paneLayout`, which
  // `usePaneLayout` rebuilds as a fresh object literal every render (it
  // memoizes its fields, not the bag), with `handleClosePanelTerminal`
  // inheriting the instability through its own dep list. Increment H shipped
  // exactly that: render → new handler → effect → bump → render, until React
  // gave up with "Maximum update depth exceeded" and threw it out of <App>,
  // ABOVE every ScreenErrorBoundary — the tree unmounted and the app booted to
  // a BLACK WINDOW. Registering identity-independently makes that loop
  // impossible rather than merely absent for today's dep arrays; the ref keeps
  // the forwarded closures current without ever re-registering.
  const panelActionsRef = useRef<PanelActions | null>(null);
  panelActionsRef.current = {
    sendToThread: handleSendToThread,
    popOutArtifact: (artifact) => void handlePopOutArtifact(artifact),
    createPanelTerminal: handleCreatePanelTerminal,
    promotePanelTerminal: handlePromotePanelTerminal,
    closePanelTerminal: handleClosePanelTerminal,
    flushTerminalTranscript: handleFlushTerminalTranscript,
  };
  useEffect(() => {
    registerPanelActions({
      sendToThread: (text) => panelActionsRef.current?.sendToThread(text),
      popOutArtifact: (artifact) => panelActionsRef.current?.popOutArtifact(artifact),
      createPanelTerminal: (tabSessionId, target) =>
        panelActionsRef.current?.createPanelTerminal(tabSessionId, target),
      promotePanelTerminal: (sessionId) =>
        panelActionsRef.current?.promotePanelTerminal(sessionId),
      closePanelTerminal: (tabSessionId, sessionId) =>
        panelActionsRef.current?.closePanelTerminal(tabSessionId, sessionId),
      flushTerminalTranscript: (sessionId) =>
        panelActionsRef.current?.flushTerminalTranscript(sessionId) ?? Promise.resolve(),
    });
    return () => registerPanelActions(null);
  }, []);

  // "Bring it back" (the panel's `↙ back`, and the placeholder's button) —
  // clearing the record is the panel's half; the WINDOW is App's, so it closes
  // here. Subscribing to the identity is how App notices the store-side clear.
  const poppedOutIdentity = usePoppedOutIdentity();
  const hadPoppedOutRef = useRef(false);
  useEffect(() => {
    const has = poppedOutIdentity !== "";
    const had = hadPoppedOutRef.current;
    hadPoppedOutRef.current = has;
    // Only the had→!has transition closes the window: the !had→has direction is
    // the pop-out itself (which just opened it), and a same-to-same render must
    // not touch a window the user is using.
    if (had && !has) {
      void closePipWindow().catch((e) => log.warn(`Failed to close floating window: ${e}`));
    }
  }, [poppedOutIdentity]);

  // Publish the active TAB to panelStore so the side-menu trees know which
  // session would host a panel (and which artifact to highlight) without a
  // prop threaded through SideMenu — the same bridge ThreadsSection uses.
  // The TAB, deliberately, not the focused pane: see the per-TAB note above.
  useEffect(() => {
    publishActiveTabSession(activeSessionId);
  }, [activeSessionId]);

  // Narrow subscription (panelStore#usePanelIdentity) — App must NOT re-render
  // on every divider-drag frame; only the panel itself does. Doubles as the
  // panel boundary's reset key, so a crash card clears when the artifact
  // changes or the panel closes.
  const activePanelIdentity = usePanelIdentity(activeSessionId);
  // Chip gate: a panel is open OR this tab remembers one — i.e. the chord has
  // something to do. Boolean snapshot, so it costs one re-render per real
  // change and none per drag frame.
  const panelToggleAvailable = usePanelToggleAvailable(activeSessionId);

  useKeyboardShortcuts(
    {
      onNewTab: handleNewTab,
      onCloseTab: handleCloseTab,
      onPrevTab: () => switchRelative(-1),
      onNextTab: () => switchRelative(1),
      onSwitchToIndex: handleJumpToThread,
      onToggleSidebar: cycleSidebar,
      onSearch: toggleSearch,
      onClosePane: handleClosePane,
      onExport: handleExport,
      onTogglePip: handleTogglePip,
      onToggleSideMenu: toggleSideMenu,
      onTogglePanel: handleTogglePanel,
      onToggleComposer: handleToggleComposer,
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
  // Ctrl+Shift+O toggled and reset things.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onPipClosing(() => {
      log.info(`PiP closing notification received`);
      pipRouterCleanupRef.current?.();
      pipRouterCleanupRef.current = null;
      setPipSessionId(null);
      // CLOSING RETURNS IT TO THE PANEL (increment F, acceptance 4). The
      // artifact was never moved, only hidden behind a placeholder, so this is
      // the whole of "returns": the panel renders it again on the next frame.
      clearPoppedOutArtifact();
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

      // Unsaved EDIT buffers are flushed to their draft mirror before anything
      // else — a close must not race the 400ms debounce. They are preserved,
      // not lost, so they never BLOCK the close; the dialog (when one appears
      // for another reason) says so rather than staying silent about them.
      flushDrafts();
      const drafts = dirtyCount();

      if (!needsConfirm) {
        void exitApp();
        return;
      }

      const activeCount = sessions.filter(
        (s) => s.status === "running" || s.status === "waiting"
      ).length;
      const draftNote =
        drafts > 0
          ? `\n\n${drafts} unsaved document edit${drafts === 1 ? "" : "s"} will be kept as a draft and restored next time.`
          : "";
      const message =
        (activeCount > 0
          ? `${activeCount} session${activeCount === 1 ? " is" : "s are"} still active. Closing Switchboard will end ${activeCount === 1 ? "it" : "them"} and lose any in-progress work.`
          : `${sessions.length} session${sessions.length === 1 ? " has" : "s have"} unsaved output. Close anyway?`) +
        draftNote;

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

      // T5: seed the thread store. Disk mirror WINS over the localStorage
      // copy whenever it exists (disk survives webview storage clears; both
      // are written on the same cadence). Bindings are remapped through the
      // restore idMap below — and since even a restored session is a FRESH
      // shell (the claude process died with the app), the transient launched
      // set starts empty: after any app restart, every thread shows revive.
      let diskThreads: Thread[] | null = null;
      try {
        diskThreads = parseThreadsFromDisk(await loadThreads());
      } catch (e) {
        log.warn(`Failed to load threads disk mirror: ${e}`);
      }
      initThreadStore(mergeThreads(diskThreads, savedWorkspace?.threads ?? []));

      // A1: seed the panel store from the SAME blob (no disk mirror — a panel
      // binding is machine-local UI state keyed by a session id). Seeded here,
      // remapped through the restore idMap below exactly like threads; every
      // path below calls remapPanelSessions, so bindings whose tab did not
      // come back are dropped rather than left pointing at nothing.
      initPanelStore(savedWorkspace?.panels ?? {}, savedWorkspace?.panelWidth);
      initPanelSides(savedWorkspace?.panelSides);

      // Detection asks the panel store "is this already framed?" before it
      // offers. Wired AFTER initPanelStore so a restored preview counts on the
      // very first banner a restarted dev server prints.
      setPreviewOpenCheck(isLocalhostUrlOpen);

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
          // All restores failed — fall back to fresh session. Every thread
          // binding is severed (no session survived to point at) and every
          // panel binding is dropped for the same reason.
          remapThreadSessionsInStore(new Map());
          remapPanelSessions(new Map(), new Set(getThreads().map((t) => t.id)));
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

        // Panels follow the same idMap, but an unmapped panel is DROPPED, not
        // severed — a panel binding without its tab is meaningless. Done HERE,
        // before the layout and active-tab decisions below, because increment H
        // made those decisions depend on it: a restored PANEL TERMINAL must not
        // be handed to the pane tree or made the active tab, and
        // `isPanelOwnedSession` can only answer that once the remap has landed.
        remapPanelSessions(idMap, new Set(getThreads().map((t) => t.id)));
        /** Restored sessions the TAB BAR can hold (i.e. not panel terminals). */
        const restoredTabSessions = newSessions.filter((s) => !isPanelOwnedSession(s.id));

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

        // Determine active session. A panel terminal is never it: the tab bar
        // does not hold one, so making it active would show an empty workspace.
        const fallbackActive = restoredTabSessions[0]?.id ?? null;
        const savedActive = savedWorkspace.activeSessionId
          ? idMap.get(savedWorkspace.activeSessionId) ?? null
          : null;
        const remappedActiveId =
          savedActive && !isPanelOwnedSession(savedActive) ? savedActive : fallbackActive;

        // Bulk-set sessions and pane layout
        bulkSetSessions(newSessions, remappedActiveId);

        if (restoredRoot) {
          paneLayout.setRoot(restoredRoot);
          if (restoredFocusedPaneId) {
            paneLayout.focusPane(restoredFocusedPaneId);
          }
        } else if (fallbackActive) {
          paneLayout.initLayout(fallbackActive);
        }

        // Threads whose sessions restored keep their tab binding (remapped to
        // the new session ids); the rest are severed → dead → revivable.
        remapThreadSessionsInStore(idMap);
      } else {
        // Fresh start — no sessions restored, so no thread or panel binding
        // can hold.
        remapThreadSessionsInStore(new Map());
        remapPanelSessions(new Map(), new Set(getThreads().map((t) => t.id)));
        // A threads-only workspace (sessions expired by staleness, threads
        // durable) still lands here: keep its session counter so fresh
        // "Shell N" names don't restart from 1.
        if (savedWorkspace) sessionCounterRef.current = savedWorkspace.sessionCounter;
        log.info("No saved workspace sessions, creating fresh session");
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

      // Start the self-update loop after workspace init (non-blocking):
      // checks now + every 6h; an available update surfaces as a status-bar
      // chip and installs only on click (see lib/updater.ts).
      startUpdater();
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
      // Threads mirror regardless of open sessions — a thread with no open
      // tab is exactly the durable state that must survive.
      saveThreadsToDisk().catch(() => {});
      // Same reasoning for unsaved DOCUMENT edits: synchronous localStorage,
      // so the 400ms debounce can never swallow the last few keystrokes on the
      // way out (increment G, acceptance 6). An F5 reload lands here too.
      flushDrafts();
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
      saveThreadsToDisk().catch(() => {});
    };

    // Updater pre-relaunch flush (review gate): relaunch() restarts the
    // process without reliable beforeunload delivery, so the installer
    // AWAITS this — the same saves as handleBeforeUnload, but with the disk
    // writes (scrollbacks, threads) awaited instead of fire-and-forget.
    registerPreRelaunchFlush(async () => {
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
        await saveAllScrollbacks(state.sessions);
      }
      await saveThreadsToDisk();
    });

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
      registerPreRelaunchFlush(null);
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
      <TopBar
        route={route}
        // The FOCUSED pane's session — the breadcrumb names what you are
        // typing in, exactly as the tab highlight used to.
        activeSession={sessions.find((s) => s.id === effectiveActiveSessionId) ?? null}
        isThread={
          effectiveActiveSessionId ? findThreadBySessionId(effectiveActiveSessionId) !== undefined : false
        }
        waitingCount={waitingCount}
        onToggleSideMenu={toggleSideMenu}
        onRename={handleRenameTab}
        // ⇄ acts on the TAB's panel (per-TAB state, SWIT-33), rendered only
        // while that panel is open.
        onTogglePanelSide={activeSessionId ? () => togglePanelSide(activeSessionId) : undefined}
        panelSide={panelSide}
        onFloat={effectiveActiveSessionId ? handleTogglePip : undefined}
        // Per-TAB, like everything else about the panel: activeSessionId, not
        // the focused pane. `""` from panelIdentityFor means "no panel open".
        onPanelButton={activeSessionId ? handlePanelButton : undefined}
        panelOpen={activePanelIdentity !== ""}
        panelToggleAvailable={panelToggleAvailable}
      />

      {newSessionDialogOpen && repoPickerAvailable && (
        <NewSessionDialogLazy
          repos={config.repos}
          onCreateSession={handleCreateSession}
          onClose={() => setNewSessionDialogOpen(false)}
        />
      )}

      {newThreadDialogOpen && (
        <NewThreadDialog
          repos={config.repos}
          onCreate={handleCreateThread}
          onClose={() => setNewThreadDialogOpen(false)}
        />
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {sideMenuVisible && <SideMenu route={route} />}

        {/* ── Screen switching (T4) ──
            Every screen is keep-alive: KEEP_ALIVE_SCREENS mount on their
            first visit and never unmount — inactive ones sit at display:none
            so their React state (and for the terminal screen, the live
            xterm/pane tree) survives. A future screen whose params are
            per-navigation identity would instead render fresh outside this
            cache (threads ended up as tab bindings, not a screen, so none
            exist today). Every screen gets its own ErrorBoundary so a crash
            in one — even a hidden one — can't take down the shell or the
            terminals. */}

        {/* Terminal — the default screen. Always mounted (pre-seeded in the
            activation cache), so screen switches never unmount panes: the T2
            registry's adopt path doesn't even fire on a switch back. */}
        <div
          style={{
            display: route.screen === "terminal" ? "flex" : "none",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          <ScreenErrorBoundary resetKey="terminal">
        {/* WORKSPACE (A2) — `[pane tree | divider | artifact panel]`.
            The TaskSidebar is deliberately OUTSIDE this container: it is a
            sibling utility rail, not part of the pane/panel geometry. The
            panel measures THIS element, so (a) the divider tracks the cursor
            regardless of sidebar state, (b) the MIN_TERMINAL_WIDTH floor is
            computed against space the pane tree can actually occupy, and (c)
            overlay mode's `right: 0` lands on the pane tree's right edge
            instead of covering the sidebar. `position: relative` is the
            containing block that makes (c) true by construction. */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            // PANEL SIDE (SWIT-33): the panel renders AFTER the pane tree in
            // this row; a left-side tab reverses the row, so `[divider][aside]`
            // lands as aside | divider | panes with no re-ordering of children.
            flexDirection: panelSide === "left" ? "row-reverse" : "row",
            overflow: "hidden",
            position: "relative",
          }}
        >
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
            // Single pane — render ALL TAB sessions, toggle visibility via CSS.
            // Keeps xterm instances mounted in the DOM so tab switches don't
            // trigger detach/reattach (which resets scroll position).
            //
            // `tabSessions`, NOT `sessions` (increment H): this branch mounts
            // every session it is handed, so a panel-owned one here would be a
            // SECOND mount of a terminal the panel is already showing — the
            // steal case. The filter is the enforcement.
            tabSessions.length > 0 ? (
              tabSessions.map((s) => {
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
            ) : (
              // Every session the workspace has is a PANEL terminal — the pane
              // tree really is empty, and saying so beats a black rectangle.
              <EmptyWorkspaceNote />
            )
          )
        ) : (
          <EmptyWorkspaceNote />
        )}

        {/* Artifact panel (workstation v2) — a SIBLING of the pane tree inside
            the workspace, never a wrapper: it renders a divider + a
            fixed-width column (or an absolute overlay on narrow workspaces)
            and leaves every pane node untouched. Terminal-screen-only,
            per-TAB content (keyed on activeSessionId, NOT the focused pane —
            a split "just shares the width", Decision 1).

            Its own error boundary, because untrusted doc content must never
            take the live shell down. The fallback is width-boxed (it stands in
            for the panel, so it must not claim flex:1 and crush the terminal),
            and the resetKey carries the ARTIFACT identity so opening a
            different doc — or closing the panel — clears a stale crash card
            instead of stranding it until the next tab switch.

            `active` mirrors how the KB screen computes its own: the panel only
            ever shows the ACTIVE tab's artifact, so "tab active" is structural
            and the remaining condition is "terminal screen visible" — which
            pauses DocView's poll exactly like the keep-alive screens pause
            theirs.

            SPLIT-MODE CONTRACT — three surfaces key off three DIFFERENT ids on
            purpose, and each one is correct for what it means:
              · TabBar highlight  → effectiveActiveSessionId (the FOCUSED PANE)
                — the tab strip names the session you are typing in.
              · this panel        → activeSessionId (the TAB) — Decision 1:
                a split "just shares the width", so moving pane focus must not
                swap or blank the panel, and persistence must not fork one
                binding per pane.
              · `→ thread` send   → effectiveActiveIdRef (the FOCUSED PANE) —
                text has to land in the terminal his keystrokes reach.
            In the unsplit case (almost always) all three are the same id. Do
            NOT unify them for consistency: each divergence is load-bearing,
            and aligning any one of them breaks the rule above it. */}
        <ScreenErrorBoundary
          resetKey={`panel:${activeSessionId ?? "none"}:${activePanelIdentity}`}
          fallbackStyle={{
            flex: "none",
            width: getPanelWidth(),
            // The hairline sits on the edge that meets the pane tree — which
            // side that is follows the tab's panel side (SWIT-33).
            ...(panelSide === "left"
              ? { borderRight: "1px solid var(--border-subtle)" }
              : { borderLeft: "1px solid var(--border-subtle)" }),
            // Same surface as the live panel (increment B) — a crash card must
            // not read as a hole in the terminal side.
            background: "var(--bg-elevated)",
          }}
        >
          <ArtifactPanel
            sessionId={activeSessionId}
            active={route.screen === "terminal"}
            repos={config.repos}
            renderSession={renderPanelSession}
          />
        </ScreenErrorBoundary>
        </div>

        {/* Terminal-screen-only BY DESIGN — the approved workstation
            wireframe shows no right task sidebar on the KB/Explorer screens.
            Sits OUTSIDE the workspace container above, so its width is never
            part of the panel's geometry. */}
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
          </ScreenErrorBoundary>
        </div>

        {/* Keep-alive screens — mounted on first visit only. */}
        {activatedScreens.has("home") && (
          <div
            style={{
              display: route.screen === "home" ? "flex" : "none",
              flex: 1,
              minWidth: 0,
            }}
          >
            <ScreenErrorBoundary resetKey="home">
              <Home active={route.screen === "home"} />
            </ScreenErrorBoundary>
          </div>
        )}
        {activatedScreens.has("kb") && (
          <div
            style={{
              display: route.screen === "kb" ? "flex" : "none",
              flex: 1,
              minWidth: 0,
            }}
          >
            <ScreenErrorBoundary resetKey="kb">
              <KnowledgeBaseScreen active={route.screen === "kb"} doc={kbDoc} menuHidden={!sideMenuVisible} />
            </ScreenErrorBoundary>
          </div>
        )}
        {activatedScreens.has("explorer") && (
          <div
            style={{
              display: route.screen === "explorer" ? "flex" : "none",
              flex: 1,
              minWidth: 0,
            }}
          >
            <ScreenErrorBoundary resetKey="explorer">
              <ExplorerScreen menuHidden={!sideMenuVisible} />
            </ScreenErrorBoundary>
          </div>
        )}
        {/* Thread history (increment C) — the side menu's `See all (N)`
            destination, and a deep-linkable route in its own right
            (?screen=threads), so it is reachable with the menu hidden. */}
        {activatedScreens.has("threads") && (
          <div
            style={{
              display: route.screen === "threads" ? "flex" : "none",
              flex: 1,
              minWidth: 0,
            }}
          >
            <ScreenErrorBoundary resetKey="threads">
              <ThreadsScreen
                active={route.screen === "threads"}
                menuHidden={!sideMenuVisible}
              />
            </ScreenErrorBoundary>
          </div>
        )}
        {/* A project PAGE full width (SWIT-30) — the "open full" of a surface
            artifact. Keep-alive like the others; the surface inside is keyed
            on (project, page) so switching pages remounts only the page. */}
        {activatedScreens.has("project") && (
          <div
            style={{
              display: route.screen === "project" ? "flex" : "none",
              flex: 1,
              minWidth: 0,
            }}
          >
            <ScreenErrorBoundary resetKey="project">
              <ProjectScreen menuHidden={!sideMenuVisible} />
            </ScreenErrorBoundary>
          </div>
        )}

      </div>

      <ToastStack
        toasts={toasts}
        onDismiss={dismissToast}
        // Guarded: a toast can outlive its session (it closed while the toast
        // was up) and a spawn-failure toast never had one (NO_SESSION).
        // switchToSession would navigate AND swap the focused pane to a dead
        // id, blanking it — so only switch to a session that still exists.
        onClickToast={(sessionId) => {
          if (sessions.some((s) => s.id === sessionId)) switchToSession(sessionId);
        }}
      />

      <StatusBar
        sessions={sessions}
        taskCount={activeTasks.length}
        onToggleSidebar={cycleSidebar}
        onToggleSideMenu={toggleSideMenu}
        onTogglePanel={panelToggleAvailable ? handleTogglePanel : undefined}
        onToggleComposer={effectiveActiveSessionId ? handleToggleComposer : undefined}
        onTogglePip={effectiveActiveSessionId ? handleTogglePip : undefined}
      />

      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        confirmLabel={confirmState.confirmLabel}
        enterConfirms={confirmState.enterConfirms}
        extraActions={confirmState.extraActions}
        onConfirm={confirmState.onConfirm}
        onCancel={closeConfirm}
      />
    </div>
  );
}

/** The pane tree with nothing in it. Two states reach it: no sessions at all,
 *  and (increment H) a workspace whose only shells are panel terminals. */
function EmptyWorkspaceNote() {
  return (
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
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "#52525B" }}>
        No sessions open
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "#3F3F46" }}>
        Press Ctrl+T to open a new terminal
      </span>
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

// ─────────────────────────────────────────────────────────────────────────────
// Workstation screen switching (T4)
// ─────────────────────────────────────────────────────────────────────────────

/** Param-less nav destinations kept mounted after first visit (inactive =
 *  display:none). New param-less screens APPEND here; a screen whose params
 *  are per-navigation identity would instead render fresh (re-mount per
 *  navigation) outside the activation cache — none exist today. ("threads"
 *  joined in increment C: the thread HISTORY is a param-less screen, while a
 *  thread itself is still a tab binding on the terminal screen.) */
// "project" (SWIT-30) joins as a keep-alive screen even though its params ARE
// identity: ProjectScreen keys the host on (project, page), so a different
// page remounts the SURFACE while the screen shell stays put — the same
// prop-stability trick ExplorerScreen plays with lastByScreen.
const KEEP_ALIVE_SCREENS = ["home", "terminal", "kb", "explorer", "threads", "project"] as const satisfies readonly ScreenId[];
const KEEP_ALIVE_SET: ReadonlySet<ScreenId> = new Set(KEEP_ALIVE_SCREENS);

function isKeepAliveScreen(screen: ScreenId): boolean {
  return KEEP_ALIVE_SET.has(screen);
}

type BoundaryProps = {
  resetKey: string;
  /** Overrides the fallback card's box. Screens want the default `flex: 1`
   *  (they OWN the row); a boundary standing in for a fixed-width surface —
   *  the artifact panel — must pass `flex: "none"` + a width, or the crash
   *  card grows into the space the live terminal was using. */
  fallbackStyle?: CSSProperties;
  children: ReactNode;
};
type BoundaryState = { error: Error | null };

/** Per-screen crash isolation (T4): a throwing screen — even a hidden one —
 *  renders a local fallback instead of unmounting the shell, so the terminal
 *  screen and its live PTYs survive. A resetKey change clears the error. */
class ScreenErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    log.error(`Screen crashed (resetKey=${this.props.resetKey}): ${error}`);
  }

  componentDidUpdate(prev: BoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      // Part of the panel-removal audit (panelStore): a boundary NEVER removes
      // an artifact — it swaps the surface for a crash card and swaps back —
      // but from the screen a crash card can read as "the doc went away", so
      // both edges of that state are on the record.
      log.info(
        `Screen boundary reset ${prev.resetKey} -> ${this.props.resetKey} (crash card cleared)`
      );
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            padding: 12,
            ...this.props.fallbackStyle,
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-secondary)" }}>
            This screen crashed.
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", maxWidth: 480, textAlign: "center" }}>
            {String(this.state.error)}
          </span>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-primary)",
              background: "var(--bg-active)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// (The shared PlaceholderScreen stub chrome was removed with T9 — both
// pre-T6/T9 stubs are now real screens.)

/** The Knowledge Base screen (T6, slimmed 2026-08-01) — breadcrumb header +
 *  full-width reading view over the personal-kb checkout. The doc TREE moved
 *  into the side menu's KNOWLEDGE BASE section (KbTreeSection.tsx — the menu
 *  is the navigator now); this screen renders content only. `active` comes
 *  from the route (App owns it) so DocView pauses its 2.5s doc poll while
 *  this keep-alive screen is hidden. The `doc` route param keeps deep links
 *  and lastByScreen restoration working. */
function KnowledgeBaseScreen({ active, doc, menuHidden }: { active: boolean; doc: string | undefined; menuHidden: boolean }) {
  // ONE breadcrumb rule for the doc, shared with the panel header
  // (panelStore.describeArtifact + ArtifactPanel.CRUMB_TONE): `kb` dim, the kb
  // project emphasized, intermediate ancestors dim, the file bright. The panel
  // used to promise "mirrors the KB screen exactly" in a comment — now the two
  // read the same function and cannot drift.
  const crumbs = doc ? describeArtifact({ kind: "kb-doc", path: doc }).crumbs : [];
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Breadcrumb header per wireframe row 2: 36px, `kb / <project> / … / file.md`. */}
      <div
        style={{
          height: 36,
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 14px",
          borderBottom: "1px solid var(--border)",
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          color: "var(--text-dim)",
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {/* Back to wherever you came from — including the terminal screen with
            its panel intact (increment G, Decision 5). */}
        <BackButton />
        {crumbs.map((crumb, i) => (
          <Fragment key={`${i}-${crumb.text}`}>
            {i > 0 && <span>/</span>}
            <span style={{ ...CRUMB_TONE[crumb.tone], overflow: "hidden", textOverflow: "ellipsis" }}>
              {crumb.text}
            </span>
          </Fragment>
        ))}
        {crumbs.length === 0 && (
          <>
            <span style={CRUMB_TONE.dim}>kb</span>
            <span>/</span>
          </>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {doc ? (
          <DocView path={doc} active={active} />
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--text-dim)",
            }}
          >
            <span>select a doc from the tree</span>
            {menuHidden && (
              <span style={{ color: "var(--text-faint)" }}>
                Ctrl+Shift+B (or click SWITCHBOARD) opens the navigator
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The Explorer screen (T9, slimmed 2026-08-01) — file VIEWER only. The
 *  project rail + directory listing moved into the side menu's EXPLORER
 *  section (ExplorerTreeSection.tsx); this screen shows the routed file
 *  ({screen:"explorer", project, path}) under a breadcrumb. Route handling
 *  mirrors the kb screen's kbDoc rule: while this keep-alive screen is
 *  hidden, the last explorer route keeps the props STABLE so the mounted
 *  viewer doesn't reset mid-hide. Reading useRoute()/getNavState() here
 *  (instead of plumbing through App) keeps the wiring confined to this
 *  block; both are safe during render (useRoute subscribes; lastByScreen
 *  only changes on navigation). */
function ExplorerScreen({ menuHidden }: { menuHidden: boolean }) {
  const route = useRoute();
  const active = route.screen === "explorer";
  const lastExplorerRoute = getNavState().lastByScreen.explorer;
  const effective = active
    ? route
    : lastExplorerRoute?.screen === "explorer"
      ? lastExplorerRoute
      : undefined;
  return (
    <ExplorerView
      project={effective?.project}
      path={effective?.path}
      menuHidden={menuHidden}
    />
  );
}

/** The project screen (SWIT-30): route-driven while active, and while hidden
 *  the last project route keeps the props STABLE so the mounted surface (its
 *  filters, open drill-in, backend probe state) survives a trip to another
 *  screen and back. Renders nothing until a project route has ever been
 *  visited — the screen only mounts on its first visit, so that is the
 *  common case. */
function ProjectScreen({ menuHidden }: { menuHidden: boolean }) {
  const route = useRoute();
  const active = route.screen === "project";
  const last = getNavState().lastByScreen.project;
  const effective = active ? route : last?.screen === "project" ? last : undefined;
  if (!effective) return null;
  return (
    <ProjectView
      project={effective.project}
      page={effective.page}
      active={active}
      menuHidden={menuHidden}
    />
  );
}
