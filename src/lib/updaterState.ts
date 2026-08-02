// Pure state machine for the in-app updater chip. All transitions live here so
// they're unit-testable; the impure side (plugin-updater calls, timers, the
// relaunch) lives in updater.ts and only dispatches events into this reducer.
//
// Phases:
//   idle        → no chip (no update known)
//   available   → chip "update vX.Y.Z — restart to install" (click = install)
//   downloading → chip shows download progress (not clickable)
//   installing  → chip "installing vX.Y.Z…" (not clickable)
//   error       → dim chip "update failed — retry" (click = retry)

export type UpdatePhase =
  | "idle"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export interface UpdaterUiState {
  phase: UpdatePhase;
  version: string | null;
  downloadedBytes: number;
  /** Total download size in bytes; null when the server didn't report one. */
  contentLength: number | null;
  error: string | null;
}

export const initialUpdaterState: UpdaterUiState = {
  phase: "idle",
  version: null,
  downloadedBytes: 0,
  contentLength: null,
  error: null,
};

export type UpdaterEvent =
  | { type: "update-found"; version: string }
  | { type: "no-update" }
  | { type: "download-started"; contentLength: number | null }
  | { type: "download-progress"; chunkBytes: number }
  | { type: "install-started" }
  | { type: "update-failed"; message: string }
  | { type: "reset" };

export function reduceUpdater(
  state: UpdaterUiState,
  event: UpdaterEvent
): UpdaterUiState {
  switch (event.type) {
    case "update-found":
      // A periodic re-check racing an active download/install must not reset
      // the in-flight flow.
      if (state.phase === "downloading" || state.phase === "installing") {
        return state;
      }
      return {
        ...initialUpdaterState,
        phase: "available",
        version: event.version,
      };
    case "no-update":
      // Only a chip that isn't mid-flow can be cleared (e.g. a release was
      // pulled between checks).
      if (state.phase === "idle") return state;
      if (state.phase === "available") return initialUpdaterState;
      return state;
    case "download-started":
      if (state.phase !== "available" && state.phase !== "error") return state;
      return {
        ...state,
        phase: "downloading",
        downloadedBytes: 0,
        contentLength: event.contentLength,
        error: null,
      };
    case "download-progress":
      if (state.phase !== "downloading") return state;
      return {
        ...state,
        downloadedBytes: state.downloadedBytes + event.chunkBytes,
      };
    case "install-started":
      if (state.phase !== "downloading") return state;
      return { ...state, phase: "installing" };
    case "update-failed":
      // Failures only make sense once a flow exists; a stray event in idle
      // must not surface a chip for an update the user never saw.
      if (state.phase === "idle") return state;
      return { ...state, phase: "error", error: event.message };
    case "reset":
      return initialUpdaterState;
  }
}

/** 0-100 while downloading with a known total; null otherwise. */
export function progressPercent(state: UpdaterUiState): number | null {
  if (state.phase !== "downloading") return null;
  if (!state.contentLength || state.contentLength <= 0) return null;
  return Math.min(
    100,
    Math.round((state.downloadedBytes / state.contentLength) * 100)
  );
}

/** Chip text; null = chip hidden. */
export function chipLabel(state: UpdaterUiState): string | null {
  switch (state.phase) {
    case "idle":
      return null;
    case "available":
      return `update v${state.version} — restart to install`;
    case "downloading": {
      const pct = progressPercent(state);
      return pct === null
        ? `downloading v${state.version}…`
        : `downloading v${state.version} ${pct}%`;
    }
    case "installing":
      return `installing v${state.version}…`;
    case "error":
      return "update failed — retry";
  }
}

export function isChipClickable(state: UpdaterUiState): boolean {
  return state.phase === "available" || state.phase === "error";
}
