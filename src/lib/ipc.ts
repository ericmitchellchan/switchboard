import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { SessionInfo, Config } from "../types";
import { log } from "./logger";

export async function createSession(
  name: string,
  repo: string,
  working_dir: string,
  cols?: number,
  rows?: number
): Promise<SessionInfo> {
  log.debug(`IPC createSession name=${name} repo=${repo} working_dir=${working_dir}`);
  return invoke("create_session", { name, repo, workingDir: working_dir, cols, rows });
}

export async function restartSession(
  sessionId: string,
  name: string,
  repo: string,
  working_dir: string,
  cols: number | undefined,
  rows: number | undefined,
  // Client-generated spawn generation for this restart. The caller MUST have
  // bumped the registry's expectation to this value BEFORE invoking (see
  // bumpSessionGeneration) — that ordering is what makes the old reader
  // thread's dying events droppable and the new spawn's first output safe.
  gen: number
): Promise<SessionInfo> {
  log.debug(`IPC restartSession id=${sessionId} name=${name} cols=${cols} rows=${rows} gen=${gen}`);
  return invoke("restart_session", { sessionId, name, repo, workingDir: working_dir, cols, rows, gen });
}

export async function closeSession(sessionId: string): Promise<void> {
  log.debug(`IPC closeSession id=${sessionId}`);
  return invoke("close_session", { sessionId });
}

export async function writeToSession(
  sessionId: string,
  data: string
): Promise<void> {
  log.debug(`IPC writeToSession id=${sessionId}`);
  return invoke("write_to_session", { sessionId, data });
}

export async function resizeSession(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  // This is the single path that SIGWINCHes the shell. Logged so a recurrence
  // of the text-render corruption can be traced to the resize(s) that caused it.
  log.debug(`IPC resizeSession id=${sessionId} cols=${cols} rows=${rows}`);
  return invoke("resize_session", { sessionId, cols, rows });
}

export async function renameSession(
  sessionId: string,
  newName: string
): Promise<void> {
  return invoke("rename_session", { sessionId, newName });
}

export async function listSessions(): Promise<SessionInfo[]> {
  return invoke("list_sessions");
}

export async function getConfig(): Promise<Config> {
  return invoke("get_config");
}

export async function getHomeDir(): Promise<string> {
  return invoke("get_home_dir");
}

export async function saveScrollback(sessionId: string, data: string): Promise<void> {
  return invoke("save_scrollback", { sessionId, data });
}

export async function loadScrollback(sessionId: string): Promise<string> {
  return invoke("load_scrollback", { sessionId });
}

export async function clearScrollback(): Promise<void> {
  return invoke("clear_scrollback");
}

export async function clearSessionScrollback(sessionId: string): Promise<void> {
  return invoke("clear_session_scrollback", { sessionId });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

export async function confirmAppClose(): Promise<void> {
  return invoke("confirm_app_close");
}

export async function openPipWindow(sessionId: string): Promise<void> {
  return invoke("open_pip_window", { sessionId });
}

export async function closePipWindow(): Promise<void> {
  return invoke("close_pip_window");
}

export async function isPipWindowOpen(): Promise<boolean> {
  return invoke("is_pip_window_open");
}

// PTY event payloads are structured: every event carries the spawn generation
// stamped by the Rust reader thread that emitted it. Event names are keyed
// only by session id, and a restart REUSES the id — the generation is how the
// terminal registry tells the restarted PTY's stream apart from the old
// (unjoined) reader thread's dying output/exited events and drops the latter.

export interface SessionOutputPayload {
  gen: number;
  /** Base64-encoded raw PTY bytes. */
  data: string;
}

export interface SessionExitedPayload {
  gen: number;
}

export function onSessionOutput(
  sessionId: string,
  callback: (data: string, gen: number) => void
): Promise<UnlistenFn> {
  return listen<SessionOutputPayload>(`session:output:${sessionId}`, (event) => {
    callback(event.payload.data, event.payload.gen);
  });
}

export function onSessionExited(
  sessionId: string,
  callback: (gen: number) => void
): Promise<UnlistenFn> {
  return listen<SessionExitedPayload>(`session:exited:${sessionId}`, (event) => {
    callback(event.payload.gen);
  });
}

export function flashTaskbar() {
  getCurrentWindow()
    .requestUserAttention(UserAttentionType.Informational)
    .catch(() => {});
}

export async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // Notification API unavailable — silently ignore
  }
}
