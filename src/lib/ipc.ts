import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SessionInfo, Config } from "../types";

export async function createSession(
  name: string,
  repo: string,
  working_dir: string,
  cols?: number,
  rows?: number
): Promise<SessionInfo> {
  return invoke("create_session", { name, repo, workingDir: working_dir, cols, rows });
}

export async function closeSession(sessionId: string): Promise<void> {
  return invoke("close_session", { sessionId });
}

export async function writeToSession(
  sessionId: string,
  data: string
): Promise<void> {
  return invoke("write_to_session", { sessionId, data });
}

export async function resizeSession(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
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
