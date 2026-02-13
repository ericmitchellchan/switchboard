import type { Session, SavedSession, SavedWorkspace } from "../types";
import type { PaneNode } from "./paneLayout";
import { serializeTerminal } from "./terminal";
import { saveScrollback } from "./ipc";

const STORAGE_KEY = "switchboard:workspace";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// --- Build & save ---

export function buildSavedWorkspace(
  sessions: Session[],
  activeSessionId: string | null,
  paneLayout: PaneNode | null,
  focusedPaneId: string | null,
  sessionCounter: number
): SavedWorkspace {
  const savedSessions: SavedSession[] = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    repo: s.repo,
    working_dir: s.working_dir,
    repoColor: s.repoColor,
    group: s.group,
  }));

  return {
    version: 1,
    sessions: savedSessions,
    activeSessionId,
    paneLayout: paneLayout as unknown,
    focusedPaneId,
    sessionCounter,
    savedAt: Date.now(),
  };
}

export function saveWorkspaceToStorage(workspace: SavedWorkspace): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

export async function saveAllScrollbacks(sessions: Session[]): Promise<void> {
  const promises = sessions.map((s) => {
    const content = serializeTerminal(s.id);
    if (content) {
      return saveScrollback(s.id, content).catch(() => {});
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

    const ws = JSON.parse(raw) as SavedWorkspace;

    // Validate
    if (ws.version !== 1 || !Array.isArray(ws.sessions) || ws.sessions.length === 0) {
      return null;
    }

    // Staleness check
    if (Date.now() - ws.savedAt > MAX_AGE_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return ws;
  } catch {
    return null;
  }
}

export function clearWorkspaceStorage(): void {
  localStorage.removeItem(STORAGE_KEY);
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
    if (state.sessions.length === 0) return;

    const workspace = buildSavedWorkspace(
      state.sessions,
      state.activeSessionId,
      state.paneLayout,
      state.focusedPaneId,
      state.sessionCounter
    );
    saveWorkspaceToStorage(workspace);
    saveAllScrollbacks(state.sessions).catch(() => {});
  }, 30_000);
}

export function stopPeriodicSave(): void {
  if (periodicTimer !== null) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}
