// In-app self-update. Checks GitHub releases (latest.json endpoint in
// tauri.conf.json) on launch and every 6h. An available update surfaces as an
// unobtrusive status-bar chip — nothing downloads or installs until the user
// clicks it. Click → download (progress on the chip) → install → relaunch.
//
// All state transitions go through the pure reducer in updaterState.ts; this
// module owns the plugin calls, the timer, and a tiny subscribable store
// (module-level, same pattern as terminal.ts — survives React remounts).

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { log } from "./logger";
import {
  initialUpdaterState,
  reduceUpdater,
  type UpdaterEvent,
  type UpdaterUiState,
} from "./updaterState";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

let state: UpdaterUiState = initialUpdaterState;
let pendingUpdate: Update | null = null;
let started = false;
let installing = false;
const listeners = new Set<() => void>();

function dispatch(event: UpdaterEvent): void {
  const next = reduceUpdater(state, event);
  if (next === state) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

/** Snapshot for useSyncExternalStore — stable reference between dispatches. */
export function getUpdaterState(): UpdaterUiState {
  return state;
}

export function subscribeUpdater(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function runCheck(): Promise<void> {
  // Never disturb a surfaced/in-flight update; only re-check from idle.
  if (state.phase !== "idle") return;
  try {
    const update = await check();
    if (update) {
      pendingUpdate = update;
      log.info(`Update available: ${update.version}`);
      dispatch({ type: "update-found", version: update.version });
    } else {
      log.debug("No update available");
    }
  } catch (e) {
    // Background check failures stay silent (log only): while the repo is
    // private or the machine is offline, check() fails on every launch — a
    // pinned "update failed" chip would be permanent noise. The error chip is
    // reserved for the user-initiated download/install path.
    log.warn(`Update check failed: ${e}`);
  }
}

/**
 * Start the update loop: check now, then every 6h. Idempotent (StrictMode /
 * remount safe).
 */
export function startUpdater(): void {
  if (started) return;
  started = true;
  void runCheck();
  setInterval(() => void runCheck(), CHECK_INTERVAL_MS);
}

/** User clicked the "available" chip: download with progress, install, relaunch. */
export async function installUpdate(): Promise<void> {
  const update = pendingUpdate;
  if (!update || installing) return;
  installing = true;
  try {
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          dispatch({
            type: "download-started",
            contentLength: event.data.contentLength ?? null,
          });
          break;
        case "Progress":
          dispatch({
            type: "download-progress",
            chunkBytes: event.data.chunkLength,
          });
          break;
        case "Finished":
          dispatch({ type: "install-started" });
          break;
      }
    });
    log.info("Update installed, relaunching");
    await relaunch();
  } catch (e) {
    log.warn(`Update install failed: ${e}`);
    dispatch({ type: "update-failed", message: String(e) });
  } finally {
    installing = false;
  }
}

/** User clicked the error chip: re-attempt the install for the held update. */
export async function retryUpdate(): Promise<void> {
  if (state.phase !== "error") return;
  if (pendingUpdate) {
    dispatch({ type: "update-found", version: pendingUpdate.version });
    await installUpdate();
  } else {
    // No held update (shouldn't happen — error implies one existed); heal by
    // clearing the chip and re-checking.
    dispatch({ type: "reset" });
    await runCheck();
  }
}
