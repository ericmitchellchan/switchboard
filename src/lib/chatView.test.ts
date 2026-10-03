// SWIT-117 — the chat view's small pure rules: the toggle's stored form, the
// target selection (which sessions get a chat at all), the read cadence and
// the window.

import { describe, it, expect } from "vitest";
import {
  parseChatViewPref,
  chatTargetKey,
  parseChatTargetKey,
  chatPollMs,
  nextChatWindow,
  CHAT_POLL_ACTIVE_MS,
  CHAT_POLL_IDLE_MS,
  CHAT_WINDOW_START,
  CHAT_WINDOW_MAX,
} from "./chatView";

describe("the toggle", () => {
  it("is ON unless the stored value says off — a missing or garbled value is on", () => {
    expect(parseChatViewPref(null)).toBe(true);
    expect(parseChatViewPref("on")).toBe(true);
    expect(parseChatViewPref("garbage")).toBe(true);
    expect(parseChatViewPref("off")).toBe(false);
  });
});

describe("the target", () => {
  const thread = { id: "t1", chatSessionId: "a68db398-30cb-4bd7-aa2d-c25df79cc164", workingDir: "C:\\Users\\ericm\\projects\\switchboard" };

  it("a launched thread with a conversation has a chat; it round-trips", () => {
    const key = chatTargetKey(thread, new Set(["t1"]));
    expect(parseChatTargetKey(key)).toEqual({ threadId: "t1", chatSessionId: thread.chatSessionId, workingDir: thread.workingDir });
  });

  it("a plain shell, a dead thread, or a thread with no conversation draws no chat", () => {
    expect(chatTargetKey(undefined, new Set())).toBeNull();
    expect(chatTargetKey(thread, new Set())).toBeNull();
    expect(chatTargetKey({ ...thread, chatSessionId: "" }, new Set(["t1"]))).toBeNull();
    expect(parseChatTargetKey(null)).toBeNull();
  });

  it("the key is a primitive that changes only with the target — a stable snapshot", () => {
    const a = chatTargetKey(thread, new Set(["t1"]));
    const b = chatTargetKey({ ...thread }, new Set(["t1", "t2"]));
    expect(a).toBe(b);
    expect(chatTargetKey({ ...thread, workingDir: "C:\\other" }, new Set(["t1"]))).not.toBe(a);
  });
});

describe("the cadence and the window", () => {
  it("reads fast while a turn is in flight or waiting on the user, slow otherwise", () => {
    expect(chatPollMs("running")).toBe(CHAT_POLL_ACTIVE_MS);
    expect(chatPollMs("waiting")).toBe(CHAT_POLL_ACTIVE_MS);
    expect(chatPollMs("done")).toBe(CHAT_POLL_IDLE_MS);
    expect(chatPollMs(null)).toBe(CHAT_POLL_IDLE_MS);
  });

  it("load earlier doubles the window up to the cap", () => {
    expect(nextChatWindow(CHAT_WINDOW_START)).toBe(CHAT_WINDOW_START * 2);
    expect(nextChatWindow(CHAT_WINDOW_MAX)).toBe(CHAT_WINDOW_MAX);
  });
});
