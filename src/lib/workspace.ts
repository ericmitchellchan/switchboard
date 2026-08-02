import type { Session, SavedSession, SavedWorkspace } from "../types";
import type { PaneNode } from "./paneLayout";
import { serializeTerminal, getTerminal, isSessionDirty, clearSessionDirty } from "./terminal";
import { saveScrollback, saveThreads } from "./ipc";
import {
  getThreads,
  serializeThreadsForDisk,
  migrateSavedWorkspace,
  applyWorkspaceStaleness,
} from "./threadStore";
import { getPanelsRecord, getPanelWidth, DEFAULT_PANEL_WIDTH } from "./panelStore";

const STORAGE_KEY = "switchboard:workspace";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — sessions only; threads never expire

// --- Build & save ---

export function buildSavedWorkspace(
  sessions: Session[],
  activeSessionId: string | null,
  paneLayout: PaneNode | null,
  focusedPaneId: string | null,
  sessionCounter: number
): SavedWorkspace {
  const savedSessions: SavedSession[] = sessions.map((s) => {
    const inst = getTerminal(s.id);
    return {
      id: s.id,
      name: s.name,
      repo: s.repo,
      working_dir: s.working_dir,
      repoColor: s.repoColor,
      group: s.group,
      cols: inst?.terminal.cols,
      rows: inst?.terminal.rows,
    };
  });

  return {
    version: 4,
    sessions: savedSessions,
    activeSessionId,
    paneLayout: paneLayout as unknown,
    focusedPaneId,
    sessionCounter,
    savedAt: Date.now(),
    // Threads ride in the same blob (records are lean by invariant — see
    // threadStore.sanitizeThread) AND mirror to disk via saveThreadsToDisk.
    threads: getThreads(),
    // Artifact panel state (v4): per-tab TAB STRIPS keyed by session id (lean
    // by invariant — see panelStore.sanitizePanelState) + the global width.
    panels: getPanelsRecord(),
    panelWidth: getPanelWidth(),
  };
}

export function saveWorkspaceToStorage(workspace: SavedWorkspace): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

const MAX_SCROLLBACK_SIZE = 1_000_000; // 1MB

/**
 * Serialize and save scrollback for sessions that have new data.
 * @param onlyDirty - when true (default for periodic saves), skip sessions
 *   that haven't received PTY data since the last save.  Pass false for
 *   beforeunload / explicit saves where completeness matters.
 */
export async function saveAllScrollbacks(sessions: Session[], onlyDirty = false): Promise<void> {
  const promises = sessions.map((s) => {
    if (onlyDirty && !isSessionDirty(s.id)) return Promise.resolve();
    const content = serializeTerminal(s.id);
    if (content) {
      clearSessionDirty(s.id);
      const capped = content.length > MAX_SCROLLBACK_SIZE
        ? content.slice(-MAX_SCROLLBACK_SIZE) // keep the tail (most recent)
        : content;
      return saveScrollback(s.id, capped).catch(() => {});
    }
    return Promise.resolve();
  });
  await Promise.all(promises);
}

// --- Load ---

export function loadWorkspaceFromStorage(): SavedWorkspace | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    // v1/v2 blobs migrate in place (sessions/layout preserved, missing
    // threads/panels defaulted); v3's single-artifact panels become one-tab
    // strips; v4 passes through with threads + panels sanitized; anything else
    // is rejected.
    const migrated = migrateSavedWorkspace(JSON.parse(raw));
    if (!migrated) return null;

    // Staleness expires SESSIONS only — threads are durable by definition, so
    // a stale workspace comes back sessionless but with its threads intact
    // (the old loader removed the whole key here; that would delete threads).
    const ws = applyWorkspaceStaleness(migrated, Date.now(), MAX_AGE_MS);

    // Nothing worth restoring: no sessions, no threads. Returning the blob
    // anyway would make App treat it as a real restore. But `panelWidth` is
    // GLOBAL chrome preference, not session state — dropping it here silently
    // reset a dragged panel to 420px whenever the workspace aged out. Hand
    // back a minimal blob that carries the width and nothing else. (Panel
    // BINDINGS are correctly dropped: they key on sessions that are gone, and
    // App's restore path remaps survivors through an empty idMap regardless.)
    if (ws.sessions.length === 0 && ws.threads.length === 0) {
      return ws.panelWidth === DEFAULT_PANEL_WIDTH
        ? null
        : { ...ws, sessions: [], threads: [], panels: {}, activeSessionId: null };
    }

    return ws;
  } catch {
    return null;
  }
}

export function clearWorkspaceStorage(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// --- Thread disk mirror ---

/**
 * Mirror the current thread records to disk (save_threads IPC → threads.json
 * in the app's local data dir). Fire-and-forget safe: failures are swallowed —
 * the localStorage copy in the workspace blob still exists. Called from the
 * periodic save, beforeunload, and App's critical-mutation flush points
 * (create / chatStarted flip / delete — losing chatSessionId or chatStarted
 * to a crash inside the 30s window would strand a conversation).
 */
export async function saveThreadsToDisk(): Promise<void> {
  try {
    await saveThreads(serializeThreadsForDisk(getThreads()));
  } catch {
    // disk mirror is best-effort; localStorage still has the records
  }
}

// --- Periodic save ---

let periodicTimer: ReturnType<typeof setInterval> | null = null;

export function startPeriodicSave(
  getState: () => {
    sessions: Session[];
    activeSessionId: string | null;
    paneLayout: PaneNode | null;
    focusedPaneId: string | null;
    sessionCounter: number;
  }
): void {
  stopPeriodicSave();
  periodicTimer = setInterval(() => {
    const state = getState();
    // Threads make an otherwise-empty workspace worth saving (a thread with
    // zero open sessions is exactly the durable state we must not lose).
    if (state.sessions.length === 0 && getThreads().length === 0) return;

    const workspace = buildSavedWorkspace(
      state.sessions,
      state.activeSessionId,
      state.paneLayout,
      state.focusedPaneId,
      state.sessionCounter
    );
    saveWorkspaceToStorage(workspace);
    saveAllScrollbacks(state.sessions, true).catch(() => {});
    saveThreadsToDisk().catch(() => {});
  }, 30_000);
}

export function stopPeriodicSave(): void {
  if (periodicTimer !== null) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}
