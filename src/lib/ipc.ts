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
  cols?: number,
  rows?: number
): Promise<SessionInfo> {
  log.debug(`IPC restartSession id=${sessionId} name=${name}`);
  return invoke("restart_session", { sessionId, name, repo, workingDir: working_dir, cols, rows });
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

export function onSessionOutput(
  sessionId: string,
  callback: (data: string) => void
): Promise<UnlistenFn> {
  return listen<string>(`session:output:${sessionId}`, (event) => {
    callback(event.payload);
  });
}

export function onSessionExited(
  sessionId: string,
  callback: () => void
): Promise<UnlistenFn> {
  return listen(`session:exited:${sessionId}`, () => {
    callback();
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
