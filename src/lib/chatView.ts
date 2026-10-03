// THE CHAT VIEW'S STATE (SWIT-117). Two small things the pane needs:
//
// 1. THE TOGGLE — ONE preference for every thread (Ky's call: the
//    formatting problem was never one thread's, and a preference that follows
//    you is less surprising than one that does not). Default ON: the chat is
//    the view, the terminal one click away. A per-viewer convenience, so
//    localStorage, read through try/catch — an unreadable store means ON.
//
// 2. WHAT A PANE WOULD SHOW — a session's chat TARGET (the thread it is bound
//    to, the conversation uuid claude writes its record under, the folder
//    that record is filed by) and its live status. Both are selected out of
//    threadStore as PRIMITIVE snapshots, so a terminal pane re-renders when
//    its target or its status changes and on nothing else.

import { useMemo, useSyncExternalStore } from "react";
import type { AgentStatus } from "../types";
import { findThreadBySessionId, getThreadsView, subscribeThreads } from "./threadStore";
import { isComposerVisible } from "./composer";

const PREF_KEY = "switchboard:chat-view";

/** `"off"` turns the chat view off; anything else (absent, garbage) is on. */
export function parseChatViewPref(raw: string | null): boolean {
  return raw !== "off";
}

let enabled = (() => {
  try {
    return parseChatViewPref(globalThis.localStorage?.getItem(PREF_KEY) ?? null);
  } catch {
    return true;
  }
})();
const prefListeners = new Set<() => void>();

export function isChatViewEnabled(): boolean {
  return enabled;
}

export function setChatViewEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  try {
    globalThis.localStorage?.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    // a blocked store keeps the choice for this run only
  }
  for (const l of prefListeners) l();
}

function subscribePref(l: () => void): () => void {
  prefListeners.add(l);
  return () => {
    prefListeners.delete(l);
  };
}

export function useChatViewEnabled(): boolean {
  return useSyncExternalStore(subscribePref, isChatViewEnabled);
}

export interface ChatTarget {
  threadId: string;
  /** The conversation uuid — the record's file name. */
  chatSessionId: string;
  /** The folder the record is filed under (claude munges it). */
  workingDir: string;
}

const SEP = "\u0000";

/** The target as one primitive (a stable snapshot), or null when the session
 *  is not a LAUNCHED thread with a conversation — a plain shell, a panel
 *  terminal and a dead thread draw no chat. Exported for tests. */
export function chatTargetKey(
  thread: { id: string; chatSessionId: string; workingDir: string } | undefined,
  launched: ReadonlySet<string>,
): string | null {
  if (!thread || !thread.chatSessionId || !thread.workingDir || !launched.has(thread.id)) return null;
  return [thread.id, thread.chatSessionId, thread.workingDir].join(SEP);
}

export function parseChatTargetKey(key: string | null): ChatTarget | null {
  if (!key) return null;
  const [threadId, chatSessionId, workingDir] = key.split(SEP);
  return threadId && chatSessionId && workingDir ? { threadId, chatSessionId, workingDir } : null;
}

export function useChatTarget(sessionId: string): ChatTarget | null {
  const key = useSyncExternalStore(subscribeThreads, () =>
    chatTargetKey(findThreadBySessionId(sessionId), getThreadsView().launched),
  );
  return useMemo(() => parseChatTargetKey(key), [key]);
}

export function useSessionStatus(sessionId: string): AgentStatus | null {
  return useSyncExternalStore(subscribeThreads, () => getThreadsView().sessionStatuses[sessionId] ?? null);
}

/** Is the chat view covering this session's terminal right now? The same rule
 *  TerminalPane renders by (a launched thread with a conversation, the toggle
 *  on, the composer there) — read imperatively by the paths that would
 *  otherwise type into, paste into or focus a terminal nobody can see. */
export function isChatShownFor(sessionId: string | null): boolean {
  if (!sessionId || !enabled || !isComposerVisible(sessionId)) return false;
  return chatTargetKey(findThreadBySessionId(sessionId), getThreadsView().launched) !== null;
}

function composerBox(sessionId: string): HTMLTextAreaElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLTextAreaElement>(`textarea[data-composer-session="${CSS.escape(sessionId)}"]`);
}

/** Focus the session's composer; false when it is not mounted. */
export function focusComposerFor(sessionId: string): boolean {
  const box = composerBox(sessionId);
  if (!box) return false;
  box.focus();
  return true;
}

/** Type `text` into the session's composer at its caret — the same
 *  `insertText` route App's OS-level paste takes, so the textarea's own
 *  change handler sees it. False when the composer is not mounted. */
export function insertIntoComposer(sessionId: string, text: string): boolean {
  if (!focusComposerFor(sessionId)) return false;
  document.execCommand("insertText", false, text);
  return true;
}

/** How often the pane re-reads the record: fast while a turn is in flight
 *  (or waiting on the user — it may resume any second), slow otherwise. A
 *  re-read of an unchanged file is answered from its size and modified time
 *  alone — Rust reads nothing and sends no text (`unchanged`). */
export const CHAT_POLL_ACTIVE_MS = 1500;
export const CHAT_POLL_IDLE_MS = 10_000;
export function chatPollMs(status: AgentStatus | null): number {
  return status === "running" || status === "waiting" ? CHAT_POLL_ACTIVE_MS : CHAT_POLL_IDLE_MS;
}

/** The read window: 1 MB, doubling on "load earlier" up to the Rust cap.
 *  Images make a record heavy (a 10 MB file held ~150 lines in its last MB),
 *  so the ceiling is higher than Ky's 2 MB. */
export const CHAT_WINDOW_START = 1024 * 1024;
export const CHAT_WINDOW_MAX = 8 * 1024 * 1024;
export function nextChatWindow(current: number): number {
  return Math.min(CHAT_WINDOW_MAX, current * 2);
}
