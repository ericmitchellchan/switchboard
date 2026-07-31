import { describe, it, expect, beforeEach } from "vitest";
import type { Thread } from "../types";
import {
  newThread,
  launchCommand,
  defaultThreadTitle,
  sanitizeThread,
  createChatStartDetector,
  remapThreadSessions,
  serializeThreadsForDisk,
  parseThreadsFromDisk,
  mergeThreads,
  migrateSavedWorkspace,
  applyWorkspaceStaleness,
  THREADS_DISK_VERSION,
  initThreadStore,
  remapThreadSessionsInStore,
  createThreadRecord,
  bindThreadSession,
  markThreadLaunched,
  isThreadLaunched,
  markChatStarted,
  markThreadSessionExited,
  unbindThreadsForSession,
  deleteThread,
  getThreads,
  getThreadById,
  findThreadBySessionId,
  getThreadsView,
  setThreadBooting,
  publishSessionStatuses,
  __resetThreadStoreForTests,
} from "./threadStore";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mkThread(overrides: Partial<Thread> = {}): Thread {
  return { ...newThread({ title: "t", workingDir: "C:/repo" }), ...overrides };
}

function mkWorkspaceV1(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    sessions: [
      { id: "s1", name: "shell", repo: "repo", working_dir: "C:/repo", cols: 120, rows: 30 },
    ],
    activeSessionId: "s1",
    paneLayout: { type: "leaf", id: "pane-1", sessionId: "s1" },
    focusedPaneId: "pane-1",
    sessionCounter: 3,
    savedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  __resetThreadStoreForTests();
});

// ─── Record construction ─────────────────────────────────────────────────────

describe("newThread", () => {
  it("mints distinct uuids for thread id and chatSessionId", () => {
    const t = newThread({ title: "spike", workingDir: "C:/repo" });
    expect(t.id).toMatch(UUID_RE);
    expect(t.chatSessionId).toMatch(UUID_RE);
    expect(t.id).not.toBe(t.chatSessionId);
  });

  it("starts unbound and unstarted", () => {
    const t = newThread({ title: "spike", workingDir: "C:/repo", now: 42 });
    expect(t.sessionId).toBeNull();
    expect(t.chatStarted).toBe(false);
    expect(t.createdAt).toBe(42);
    expect(t.lastActivityAt).toBe(42);
  });
});

describe("defaultThreadTitle", () => {
  it("is repo name + date", () => {
    expect(defaultThreadTitle("lodestar", new Date(2026, 6, 31))).toBe("lodestar · Jul 31");
  });
});

// ─── Launch command gating (--resume vs --session-id) ────────────────────────

describe("launchCommand", () => {
  it("uses --session-id before the first real turn", () => {
    expect(launchCommand({ chatStarted: false, chatSessionId: "abc-123" })).toBe(
      "claude --session-id abc-123"
    );
  });

  it("uses --resume once chatStarted", () => {
    expect(launchCommand({ chatStarted: true, chatSessionId: "abc-123" })).toBe(
      "claude --resume abc-123"
    );
  });
});

// ─── chatStarted detector ────────────────────────────────────────────────────

describe("createChatStartDetector", () => {
  it("a bracketed paste does NOT flip, a following real Enter does", () => {
    const detect = createChatStartDetector();
    // The spec's exact scenario: paste, then a real \r.
    expect(detect("\x1b[200~pasted\x1b[201~")).toBe(false);
    expect(detect("\r")).toBe(true);
  });

  it("an Enter INSIDE the pasted body does not flip", () => {
    const detect = createChatStartDetector();
    expect(detect("\x1b[200~line one\rline two\x1b[201~")).toBe(false);
  });

  it("a paste spanning multiple chunks stays a paste", () => {
    const detect = createChatStartDetector();
    expect(detect("\x1b[200~first ")).toBe(false);
    expect(detect("second\rthird")).toBe(false);
    expect(detect("\x1b[201~")).toBe(false);
    expect(detect("\r")).toBe(true);
  });

  it("typed text then Enter flips", () => {
    const detect = createChatStartDetector();
    expect(detect("h")).toBe(false);
    expect(detect("i")).toBe(false);
    expect(detect("\r")).toBe(true);
  });

  it("a bare Enter with an empty composer does not flip", () => {
    const detect = createChatStartDetector();
    expect(detect("\r")).toBe(false);
    expect(detect("\r\r")).toBe(false);
  });

  it("escape sequences (arrow keys) are not content", () => {
    const detect = createChatStartDetector();
    expect(detect("\x1b[A\x1b[B\x1bOA")).toBe(false);
    expect(detect("\r")).toBe(false);
    expect(detect("x\r")).toBe(true);
  });
});

// ─── Workspace v1 → v2 migration ─────────────────────────────────────────────

describe("migrateSavedWorkspace", () => {
  it("migrates v1: sessions/layout preserved, threads default []", () => {
    const raw = mkWorkspaceV1();
    const ws = migrateSavedWorkspace(raw);
    expect(ws).not.toBeNull();
    expect(ws!.version).toBe(2);
    expect(ws!.sessions).toEqual(raw.sessions);
    expect(ws!.paneLayout).toEqual(raw.paneLayout);
    expect(ws!.activeSessionId).toBe("s1");
    expect(ws!.focusedPaneId).toBe("pane-1");
    expect(ws!.sessionCounter).toBe(3);
    expect(ws!.threads).toEqual([]);
  });

  it("passes v2 through with threads sanitized", () => {
    const t = mkThread();
    const raw = mkWorkspaceV1({
      version: 2,
      threads: [
        { ...t, scrollback: "x".repeat(1000), messages: [{ role: "user" }] },
        { junk: true },
      ],
    });
    const ws = migrateSavedWorkspace(raw);
    expect(ws!.threads).toHaveLength(1);
    expect(ws!.threads[0]).toEqual(t);
  });

  it("rejects unknown versions and malformed payloads", () => {
    expect(migrateSavedWorkspace(null)).toBeNull();
    expect(migrateSavedWorkspace("nope")).toBeNull();
    expect(migrateSavedWorkspace(mkWorkspaceV1({ version: 3 }))).toBeNull();
    expect(migrateSavedWorkspace(mkWorkspaceV1({ sessions: "bad" }))).toBeNull();
  });
});

describe("applyWorkspaceStaleness", () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  it("keeps a fresh workspace untouched", () => {
    const ws = migrateSavedWorkspace(mkWorkspaceV1({ version: 2, threads: [mkThread()] }))!;
    expect(applyWorkspaceStaleness(ws, ws.savedAt + WEEK, WEEK)).toBe(ws);
  });

  it("expires sessions but threads survive — threads never expire", () => {
    const t = mkThread({ sessionId: "s1" });
    const ws = migrateSavedWorkspace(mkWorkspaceV1({ version: 2, threads: [t] }))!;
    const stale = applyWorkspaceStaleness(ws, ws.savedAt + WEEK + 1, WEEK);
    expect(stale.sessions).toEqual([]);
    expect(stale.paneLayout).toBeNull();
    expect(stale.activeSessionId).toBeNull();
    expect(stale.threads).toEqual([t]);
  });
});

// ─── Lean-record invariant ───────────────────────────────────────────────────

describe("sanitizeThread (lean-record invariant)", () => {
  it("keeps only schema fields — no scrollback/messages ever persist", () => {
    const t = mkThread();
    const bloated = {
      ...t,
      scrollback: "x".repeat(10000),
      messages: [{ role: "user", content: "hi" }],
      status: "running",
    };
    const clean = sanitizeThread(bloated)!;
    expect(clean).toEqual(t);
    expect("scrollback" in clean).toBe(false);
    expect("messages" in clean).toBe(false);
  });

  it("preserves archivedAt when present", () => {
    const t = mkThread({ archivedAt: 123 });
    expect(sanitizeThread(t)).toEqual(t);
  });

  it("rejects records missing critical fields", () => {
    const t = mkThread();
    expect(sanitizeThread({ ...t, chatSessionId: undefined })).toBeNull();
    expect(sanitizeThread({ ...t, chatSessionId: "" })).toBeNull();
    expect(sanitizeThread({ ...t, id: undefined })).toBeNull();
    expect(sanitizeThread(null)).toBeNull();
  });

  it("round-trips through the disk format lean", () => {
    const t = mkThread();
    const raw = serializeThreadsForDisk([{ ...t, extra: "junk" } as unknown as Thread]);
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(THREADS_DISK_VERSION);
    expect(parsed.threads[0]).toEqual(t);
    expect(parseThreadsFromDisk(raw)).toEqual([t]);
  });
});

// ─── Disk mirror: parse + disk-wins merge ────────────────────────────────────

describe("disk mirror", () => {
  it("parseThreadsFromDisk: empty/garbage → null (no disk copy)", () => {
    expect(parseThreadsFromDisk("")).toBeNull();
    expect(parseThreadsFromDisk("not json")).toBeNull();
    expect(parseThreadsFromDisk(JSON.stringify({ version: 99, threads: [] }))).toBeNull();
  });

  it("disk wins over localStorage when both exist", () => {
    const disk = [mkThread({ title: "disk copy" })];
    const local = [mkThread({ title: "local copy" })];
    expect(mergeThreads(disk, local)).toBe(disk);
  });

  it("a valid EMPTY disk list still wins (all threads deleted is real state)", () => {
    const local = [mkThread()];
    expect(mergeThreads([], local)).toEqual([]);
  });

  it("falls back to localStorage when no disk copy exists", () => {
    const local = [mkThread()];
    expect(mergeThreads(null, local)).toBe(local);
  });
});

// ─── Restore reconciliation ──────────────────────────────────────────────────

describe("remapThreadSessions", () => {
  it("remaps restored bindings, severs dead ones", () => {
    const a = mkThread({ sessionId: "old-1" });
    const b = mkThread({ sessionId: "old-2" });
    const c = mkThread({ sessionId: null });
    const out = remapThreadSessions([a, b, c], new Map([["old-1", "new-1"]]));
    expect(out[0].sessionId).toBe("new-1");
    expect(out[1].sessionId).toBeNull(); // session didn't restore → dead → revivable
    expect(out[2].sessionId).toBeNull();
  });

  it("empty map (fresh start) severs every binding", () => {
    const out = remapThreadSessions([mkThread({ sessionId: "old" })], new Map());
    expect(out[0].sessionId).toBeNull();
  });
});

// ─── Store behavior ──────────────────────────────────────────────────────────

describe("thread store", () => {
  it("create + bind: record inserted, session bound, findable both ways", () => {
    const t = createThreadRecord({ title: "spike", workingDir: "C:/repo" });
    expect(getThreads()).toHaveLength(1);
    expect(t.chatSessionId).toMatch(UUID_RE);

    bindThreadSession(t.id, "sess-1");
    expect(getThreadById(t.id)!.sessionId).toBe("sess-1");
    expect(findThreadBySessionId("sess-1")!.id).toBe(t.id);
  });

  it("markChatStarted flips once and updates activity", () => {
    const t = createThreadRecord({ title: "x", workingDir: "C:/r" });
    expect(getThreadById(t.id)!.chatStarted).toBe(false);
    markChatStarted(t.id);
    expect(getThreadById(t.id)!.chatStarted).toBe(true);
  });

  it("boot: initThreadStore + remap resets liveness — every thread revivable", () => {
    const t = mkThread({ sessionId: "old-sess" });
    initThreadStore([t]);
    remapThreadSessionsInStore(new Map()); // app restart: claude processes gone
    const view = getThreadsView();
    expect(view.threads[0].sessionId).toBeNull();
    expect(view.launched.size).toBe(0);
  });

  it("initThreadStore sanitizes bloated records (lean invariant at the gate)", () => {
    const t = mkThread();
    initThreadStore([{ ...t, scrollback: "junk" } as unknown as Thread]);
    expect(getThreads()[0]).toEqual(t);
  });

  it("session exit: thread stays, keeps tab binding, loses liveness", () => {
    const t = createThreadRecord({ title: "x", workingDir: "C:/r" });
    bindThreadSession(t.id, "sess-1");
    markThreadLaunched(t.id);
    expect(isThreadLaunched(t.id)).toBe(true);

    markThreadSessionExited("sess-1");
    expect(getThreadById(t.id)!.sessionId).toBe("sess-1"); // exit tail still readable there
    expect(isThreadLaunched(t.id)).toBe(false); // → revive chip
  });

  it("tab close: binding severed, thread survives", () => {
    const t = createThreadRecord({ title: "x", workingDir: "C:/r" });
    bindThreadSession(t.id, "sess-1");
    markThreadLaunched(t.id);

    unbindThreadsForSession("sess-1");
    expect(getThreadById(t.id)!.sessionId).toBeNull();
    expect(isThreadLaunched(t.id)).toBe(false);
    expect(getThreads()).toHaveLength(1);
  });

  it("explicit delete removes the record", () => {
    const t = createThreadRecord({ title: "x", workingDir: "C:/r" });
    setThreadBooting(t.id, true);
    deleteThread(t.id);
    expect(getThreads()).toHaveLength(0);
    expect(getThreadsView().booting.size).toBe(0);
  });

  it("publishSessionStatuses is change-detected (no notify churn)", () => {
    let notifies = 0;
    // subscribe via the view path
    const unsub = (() => {
      const listener = () => notifies++;
      // reuse public subscribe through useSyncExternalStore's contract
      // (subscribe isn't exported; count via getThreadsView cache identity)
      return listener;
    })();
    void unsub;
    publishSessionStatuses({ a: "running" }, "a");
    const v1 = getThreadsView();
    publishSessionStatuses({ a: "running" }, "a"); // identical — must not bump
    const v2 = getThreadsView();
    expect(v2).toBe(v1); // cached snapshot survives = no bump happened
    publishSessionStatuses({ a: "waiting" }, "a");
    expect(getThreadsView()).not.toBe(v1);
    expect(getThreadsView().sessionStatuses.a).toBe("waiting");
  });
});
