import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Thread } from "../types";
import {
  newThread,
  launchCommand,
  waitForShellReady,
  tryBeginRevive,
  endRevive,
  clearThreadLaunched,
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
  promoteThreadRecord,
  unbindThread,
  renameThread,
  setThreadArchived,
  isThreadArchived,
  activeThreads,
  archivedThreads,
  derivedThreadTitle,
  threadRepoName,
  sameWorkingDir,
  orderThreadRepoChoices,
  sortThreadsForHistory,
  selectMenuThreads,
  groupMenuThreads,
  menuThreadRows,
  quickCreateWorkingDir,
  explicitThreadTitle,
  NEW_THREAD_TITLE,
  requestThreadRename,
  clearThreadRenameRequest,
  renameEditorHoldsFocus,
  RENAME_FOCUS_HOLD_MS,
  selectShellSessions,
  resolveThreadByQuery,
  type MenuSession,
  filterThreads,
  relativeActivity,
  MENU_THREAD_LIMIT,
  __resetThreadStoreForTests,
} from "./threadStore";
import { parseThreadPost } from "./composer";

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
// `resume` is disk ground truth (claude_session_exists), never the
// chatStarted hint — see the decision table on launchCommand.

describe("launchCommand", () => {
  it("no transcript on disk → --session-id (same pinned uuid)", () => {
    expect(launchCommand({ chatSessionId: "abc-123", resume: false })).toBe(
      "claude --session-id abc-123"
    );
  });

  it("transcript exists → --resume", () => {
    expect(launchCommand({ chatSessionId: "abc-123", resume: true })).toBe(
      "claude --resume abc-123"
    );
  });

  // SWIT-49: the per-spawn mcp-config flag.
  it("mcpConfig appends --mcp-config with backslashes folded to forward slashes", () => {
    expect(
      launchCommand({
        chatSessionId: "abc-123",
        resume: true,
        mcpConfig: "C:\\Users\\eric\\AppData\\Local\\switchboard\\threads\\t1\\mcp-config.json",
      })
    ).toBe(
      'claude --resume abc-123 --mcp-config "C:/Users/eric/AppData/Local/switchboard/threads/t1/mcp-config.json"'
    );
  });

  it("null/empty mcpConfig omits the flag entirely — degraded, never an empty arg", () => {
    expect(launchCommand({ chatSessionId: "a", resume: false, mcpConfig: null })).toBe(
      "claude --session-id a"
    );
    expect(launchCommand({ chatSessionId: "a", resume: false, mcpConfig: "" })).toBe(
      "claude --session-id a"
    );
  });

  it("mcp-config and append-system-prompt compose on one line, config first", () => {
    const line = launchCommand({
      chatSessionId: "a",
      resume: false,
      appendSystemPrompt: "context here",
      mcpConfig: "C:/t/mcp-config.json",
    });
    expect(line).toBe(
      'claude --session-id a --mcp-config "C:/t/mcp-config.json" --append-system-prompt "context here"'
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

// ─── Workspace v1/v2 → v3 migration ──────────────────────────────────────────
// Panel-specific migration coverage (panels/panelWidth) lives in
// panelStore.test.ts; these cases own the sessions/threads half.

describe("migrateSavedWorkspace", () => {
  it("migrates v1: sessions/layout preserved, threads default []", () => {
    const raw = mkWorkspaceV1();
    const ws = migrateSavedWorkspace(raw);
    expect(ws).not.toBeNull();
    expect(ws!.version).toBe(6);
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
    expect(migrateSavedWorkspace(mkWorkspaceV1({ version: 7 }))).toBeNull();
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

  it("keeps archivedAt when it is a real timestamp", () => {
    // Increment E brought the field back WITH behaviour, so it is schema now.
    const t = mkThread();
    const clean = sanitizeThread({ ...t, archivedAt: 123 })!;
    expect(clean.archivedAt).toBe(123);
    expect(isThreadArchived(clean)).toBe(true);
  });

  it("omits archivedAt entirely for an active record — a lean record stays lean", () => {
    const t = mkThread();
    expect("archivedAt" in sanitizeThread(t)!).toBe(false);
    // Not archived "at the epoch": 0 and garbage both mean active.
    expect("archivedAt" in sanitizeThread({ ...t, archivedAt: 0 })!).toBe(false);
    expect("archivedAt" in sanitizeThread({ ...t, archivedAt: "yes" })!).toBe(false);
  });

  it("round-trips an ARCHIVED record through the disk format", () => {
    // Acceptance 5: archived threads survive a restart AS archived.
    const t = { ...mkThread(), archivedAt: 1_700_000_000_000 };
    const parsed = parseThreadsFromDisk(serializeThreadsForDisk([t]))!;
    expect(parsed[0]).toEqual(t);
    expect(isThreadArchived(parsed[0])).toBe(true);
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

  it("clearThreadLaunched rolls the row back to revivable (write failure)", () => {
    const t = createThreadRecord({ title: "x", workingDir: "C:/r" });
    markThreadLaunched(t.id);
    expect(isThreadLaunched(t.id)).toBe(true);
    clearThreadLaunched(t.id);
    expect(isThreadLaunched(t.id)).toBe(false);
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

// ─── Revive re-entrancy gate ─────────────────────────────────────────────────

describe("revive in-flight gate", () => {
  it("second begin bails while the first is in flight", () => {
    expect(tryBeginRevive("t1")).toBe(true);
    expect(tryBeginRevive("t1")).toBe(false); // double-click window
    expect(tryBeginRevive("t2")).toBe(true); // independent threads unaffected
  });

  it("end releases the gate (completion AND failure paths)", () => {
    expect(tryBeginRevive("t1")).toBe(true);
    endRevive("t1");
    expect(tryBeginRevive("t1")).toBe(true);
  });

  it("create→revive interleaving: a click during the create window bails", () => {
    // handleCreateThread takes the gate synchronously after minting the
    // record, BEFORE its first await — the row is already rendered but
    // unbound, so a click routes openThread → revive; that revive must see
    // the gate held and bail instead of launching a second shell on the
    // same chatSessionId.
    expect(tryBeginRevive("new-thread")).toBe(true); // create path takes it
    expect(tryBeginRevive("new-thread")).toBe(false); // mid-create click bails
    endRevive("new-thread"); // create's finally
    expect(tryBeginRevive("new-thread")).toBe(true); // later real revive proceeds
    endRevive("new-thread");
  });
});

// ─── Shell-ready wait (generation-filtered) ──────────────────────────────────

describe("waitForShellReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(expectedGen: () => number | undefined) {
    let emit: (gen: number) => void = () => {};
    const unsub = vi.fn();
    let resolved = false;
    const promise = waitForShellReady({
      subscribe: (cb) => {
        emit = cb;
        return Promise.resolve(unsub);
      },
      expectedGen,
      settleMs: 300,
      fallbackMs: 1500,
    });
    void promise.then(() => {
      resolved = true;
    });
    return { emit: (gen: number) => emit(gen), unsub, isResolved: () => resolved };
  }

  it("first accepted chunk + settle resolves (before the fallback)", async () => {
    const h = harness(() => 2);
    await vi.advanceTimersByTimeAsync(0); // flush subscribe
    h.emit(2);
    await vi.advanceTimersByTimeAsync(299);
    expect(h.isResolved()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.isResolved()).toBe(true);
    expect(h.unsub).toHaveBeenCalled();
  });

  it("a stale-generation dying chunk does NOT start the settle", async () => {
    // Revive-into-exited-tab: the restart's old reader thread emits chunks
    // stamped with the previous generation. They must not fake "first
    // output" — the wait holds until the fallback (or a real chunk).
    const h = harness(() => 2);
    await vi.advanceTimersByTimeAsync(0);
    h.emit(1); // old spawn's dying output
    await vi.advanceTimersByTimeAsync(400); // past settleMs — must NOT resolve
    expect(h.isResolved()).toBe(false);
    await vi.advanceTimersByTimeAsync(1100); // fallback at 1500 total
    expect(h.isResolved()).toBe(true);
  });

  it("a stale chunk then the new spawn's chunk resolves on the settle", async () => {
    const h = harness(() => 2);
    await vi.advanceTimersByTimeAsync(0);
    h.emit(1); // ignored
    h.emit(2); // real first output
    await vi.advanceTimersByTimeAsync(300);
    expect(h.isResolved()).toBe(true);
  });

  it("undefined expectation accepts any chunk (fresh session, pane not mounted yet)", async () => {
    const h = harness(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    h.emit(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.isResolved()).toBe(true);
  });

  it("no output at all → fallback resolves (silent profile / already-live shell)", async () => {
    const h = harness(() => 2);
    await vi.advanceTimersByTimeAsync(1499);
    expect(h.isResolved()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.isResolved()).toBe(true);
    expect(h.unsub).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Increment C — promotion records + thread history selection
// ─────────────────────────────────────────────────────────────────────────────

describe("threadRepoName", () => {
  it("takes the basename of either separator style", () => {
    expect(threadRepoName("C:\\Users\\ericm\\projects\\orbit")).toBe("orbit");
    expect(threadRepoName("/home/e/projects/orbit")).toBe("orbit");
  });

  it("tolerates trailing separators and degenerate input", () => {
    expect(threadRepoName("C:\\repos\\orbit\\")).toBe("orbit");
    expect(threadRepoName("")).toBe("");
  });
});

describe("sameWorkingDir", () => {
  // Revive compares the bound TAB's cwd against the thread's. A promoted
  // thread's dir comes from claude's session file; the tab's comes from our
  // own config — so the two strings routinely differ in shape while naming
  // the same directory.
  it("ignores separator style, trailing separators and case", () => {
    expect(sameWorkingDir("C:\\repos\\Orbit", "C:/repos/orbit")).toBe(true);
    expect(sameWorkingDir("C:\\repos\\orbit\\", "C:\\repos\\orbit")).toBe(true);
  });

  it("ignores the Windows verbatim prefix", () => {
    expect(sameWorkingDir("\\\\?\\C:\\repos\\orbit", "C:\\repos\\orbit")).toBe(true);
    expect(sameWorkingDir("\\\\?\\UNC\\srv\\share", "\\\\srv\\share")).toBe(true);
  });

  it("still distinguishes genuinely different directories", () => {
    // The whole point: `Ctrl+T` in the parent, `cd` into the child, `claude`.
    expect(sameWorkingDir("C:\\repos", "C:\\repos\\orbit")).toBe(false);
    expect(sameWorkingDir("C:\\repos\\orbit", "C:\\repos\\orbit2")).toBe(false);
  });
});

describe("promoteThreadRecord", () => {
  beforeEach(() => __resetThreadStoreForTests());

  it("ADOPTS claude's uuid instead of minting one", () => {
    const t = promoteThreadRecord({
      title: "orbit · Aug 2",
      workingDir: "C:\\repos\\orbit",
      chatSessionId: "discovered-uuid",
      chatStarted: true,
      sessionId: "tab-a",
    });
    expect(t.chatSessionId).toBe("discovered-uuid");
    expect(t.chatStarted).toBe(true);
    expect(t.sessionId).toBe("tab-a");
    // Its own thread id is still freshly minted — only the CONVERSATION id
    // comes from claude.
    expect(t.id).toMatch(UUID_RE);
    expect(t.id).not.toBe("discovered-uuid");
    expect(getThreads()).toHaveLength(1);
  });

  it("dates the record from CLAUDE's launch, not from the poll that saw it", () => {
    const t = promoteThreadRecord({
      title: "x",
      workingDir: "C:\\repos\\orbit",
      chatSessionId: "abc",
      chatStarted: true,
      sessionId: "tab-a",
      startedAt: 1_700_000_000_000,
    });
    expect(t.createdAt).toBe(1_700_000_000_000);
    // Being seen alive IS activity, so lastActivityAt is now, not then.
    expect(t.lastActivityAt).toBeGreaterThan(t.createdAt);
  });

  it("ignores a missing or impossible startedAt", () => {
    const base = { title: "x", workingDir: "C:\\repos\\orbit", chatSessionId: "abc", chatStarted: false, sessionId: "tab-a" };
    expect(promoteThreadRecord(base).createdAt).toBeGreaterThan(0);
    expect(promoteThreadRecord({ ...base, startedAt: 0 }).createdAt).toBeGreaterThan(0);
    // A future timestamp would sort the row above everything forever.
    const future = Date.now() + 1_000_000;
    expect(promoteThreadRecord({ ...base, startedAt: future }).createdAt).toBeLessThan(future);
  });

  it("produces a record that survives the sanitize gate unchanged", () => {
    // Promoted records ride the SAME persistence path as explicit ones — a
    // shape the lean-record gate rejected would silently never persist.
    const t = promoteThreadRecord({
      title: "orbit · Aug 2",
      workingDir: "C:\\repos\\orbit",
      chatSessionId: "discovered-uuid",
      chatStarted: false,
      sessionId: "tab-a",
    });
    expect(sanitizeThread(t)).toEqual(t);
  });

  it("is indistinguishable from an explicit thread at revive time", () => {
    // The whole point of the shared field: revive reads chatSessionId and disk
    // ground truth, never "how did this record get here".
    const promoted = promoteThreadRecord({
      title: "x",
      workingDir: "C:\\repos\\orbit",
      chatSessionId: "abc",
      chatStarted: true,
      sessionId: "tab-a",
    });
    expect(launchCommand({ chatSessionId: promoted.chatSessionId, resume: true }))
      .toBe("claude --resume abc");
  });
});

describe("unbindThread (Decision 1: nothing is forgotten)", () => {
  beforeEach(() => __resetThreadStoreForTests());

  it("severs the tab binding and keeps the record whole", () => {
    const t = createThreadRecord({ title: "x", workingDir: "C:\\repos\\orbit" });
    bindThreadSession(t.id, "tab-a");
    markThreadLaunched(t.id);

    unbindThread(t.id);

    const after = getThreadById(t.id)!;
    expect(after.sessionId).toBeNull();
    // The uuid is what makes it revivable — the whole point of not adopting.
    expect(after.chatSessionId).toBe(t.chatSessionId);
    expect(getThreads()).toHaveLength(1);
    // No claude process behind it any more.
    expect(isThreadLaunched(t.id)).toBe(false);
  });

  it("leaves other threads alone and ignores an unknown id", () => {
    const a = createThreadRecord({ title: "a", workingDir: "C:\\repos\\orbit" });
    bindThreadSession(a.id, "tab-a");
    unbindThread("nope");
    expect(getThreadById(a.id)?.sessionId).toBe("tab-a");
  });
});

// ── Rename (Decision 4) ──────────────────────────────────────────────────────

describe("renameThread", () => {
  beforeEach(() => __resetThreadStoreForTests());

  it("renames the record and touches nothing else", () => {
    const t = createThreadRecord({ title: "orbit", workingDir: "C:\\repos\\orbit" });
    renameThread(t.id, "  rate limiter spike  ");
    const after = getThreadById(t.id)!;
    expect(after.title).toBe("rate limiter spike");
    // A rename is LOCAL to Switchboard's record: claude's conversation id and
    // the started hint are untouched.
    expect(after.chatSessionId).toBe(t.chatSessionId);
    expect(after.chatStarted).toBe(t.chatStarted);
  });

  it("falls back to the record's DERIVED default on an empty title", () => {
    const t = createThreadRecord({ title: "spike", workingDir: "C:\\repos\\lodestar" });
    renameThread(t.id, "   ");
    expect(getThreadById(t.id)?.title).toBe(derivedThreadTitle(t));
    expect(getThreadById(t.id)?.title).toContain("lodestar");
  });

  it("derives the default from the thread's OWN creation date, not today", () => {
    const t = {
      ...mkThread({ workingDir: "C:\\repos\\orbit" }),
      createdAt: new Date(2026, 0, 9, 12).getTime(),
    };
    expect(derivedThreadTitle(t)).toBe("orbit \u00b7 Jan 9");
  });

  it("survives the sanitize gate and the disk round trip (acceptance 3b)", () => {
    const t = createThreadRecord({ title: "x", workingDir: "C:\\repos\\orbit" });
    renameThread(t.id, "renamed");
    const parsed = parseThreadsFromDisk(serializeThreadsForDisk(getThreads()))!;
    expect(parsed[0].title).toBe("renamed");
  });

  it("is a no-op for an unknown id or an unchanged title", () => {
    const t = createThreadRecord({ title: "x", workingDir: "C:\\repos\\orbit" });
    const before = getThreadById(t.id);
    renameThread(t.id, "x");
    renameThread("nope", "y");
    expect(getThreadById(t.id)).toBe(before);
  });
});

// ── Archive (Decision 5) ─────────────────────────────────────────────────────

describe("setThreadArchived", () => {
  beforeEach(() => __resetThreadStoreForTests());

  it("archives and unarchives losslessly — only the flag moves", () => {
    const t = createThreadRecord({ title: "x", workingDir: "C:\\repos\\orbit" });
    bindThreadSession(t.id, "tab-a");

    setThreadArchived(t.id, true);
    const archived = getThreadById(t.id)!;
    expect(isThreadArchived(archived)).toBe(true);
    // Everything that makes the thread revivable is untouched — archiving is
    // not deleting.
    expect(archived.chatSessionId).toBe(t.chatSessionId);
    expect(archived.sessionId).toBe("tab-a");

    setThreadArchived(t.id, false);
    const back = getThreadById(t.id)!;
    expect(isThreadArchived(back)).toBe(false);
    // The key is REMOVED, not zeroed — the lean-record shape comes back too.
    expect("archivedAt" in back).toBe(false);
  });

  it("is a no-op when the state already matches, or for an unknown id", () => {
    const t = createThreadRecord({ title: "x", workingDir: "C:\\repos\\orbit" });
    const before = getThreadById(t.id);
    setThreadArchived(t.id, false);
    setThreadArchived("nope", true);
    expect(getThreadById(t.id)).toBe(before);
  });

  it("never touches the thread's session binding (acceptance 6)", () => {
    const t = createThreadRecord({ title: "x", workingDir: "C:\\repos\\orbit" });
    bindThreadSession(t.id, "tab-a");
    setThreadArchived(t.id, true);
    expect(findThreadBySessionId("tab-a")?.id).toBe(t.id);
  });

  it("markThreadLaunched unarchives — a running conversation is not put away", () => {
    const t = createThreadRecord({ title: "x", workingDir: "C:\\repos\\orbit" });
    setThreadArchived(t.id, true);
    markThreadLaunched(t.id);
    expect(isThreadArchived(getThreadById(t.id)!)).toBe(false);
    expect(isThreadLaunched(t.id)).toBe(true);
  });
});

// ── History selection ────────────────────────────────────────────────────────

function ht(id: string, lastActivityAt: number, over: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    workingDir: "C:\\repos\\orbit",
    chatSessionId: `c-${id}`,
    chatStarted: false,
    sessionId: null,
    createdAt: lastActivityAt,
    lastActivityAt,
    ...over,
  };
}

describe("sortThreadsForHistory", () => {
  it("puts live threads first, then most recent activity", () => {
    const list = [ht("a", 300), ht("b", 100), ht("c", 200)];
    const out = sortThreadsForHistory(list, new Set(["b"]));
    expect(out.map((t) => t.id)).toEqual(["b", "a", "c"]);
  });

  it("is a total, stable order when timestamps tie", () => {
    const list = [ht("z", 100), ht("a", 100)];
    const out = sortThreadsForHistory(list, new Set());
    expect(out.map((t) => t.id)).toEqual(["a", "z"]);
    // …and does not mutate the input.
    expect(list.map((t) => t.id)).toEqual(["z", "a"]);
  });
});

describe("archived thread selection", () => {
  const list = [
    ht("a", 3),
    { ...ht("b", 2), title: "put away", archivedAt: 1_700_000_000_000 },
    ht("c", 1),
  ];

  it("splits the two lists and never loses a record between them", () => {
    expect(activeThreads(list).map((t) => t.id)).toEqual(["a", "c"]);
    expect(archivedThreads(list).map((t) => t.id)).toEqual(["b"]);
    expect(activeThreads(list).length + archivedThreads(list).length).toBe(list.length);
  });

  it("keeps archived threads off the side menu (acceptance 4)", () => {
    expect(selectMenuThreads(list, new Set()).map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("hides an archived thread from the rail even while it is LIVE", () => {
    // Archiving is an explicit act on the record; the live-thread rule exists
    // to stop TRUNCATION, not to override the user.
    expect(selectMenuThreads(list, new Set(["b"])).map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("leaves the history screen's own ordering alone (it partitions first)", () => {
    // sortThreadsForHistory must NOT filter — the Archived tab sorts too.
    expect(sortThreadsForHistory(list, new Set()).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("filters within a tab, so a query never leaks the other list", () => {
    expect(filterThreads(archivedThreads(list), "put away").map((t) => t.id)).toEqual(["b"]);
    expect(filterThreads(activeThreads(list), "put away")).toEqual([]);
  });
});

describe("selectMenuThreads", () => {
  it("caps the rail at the limit", () => {
    const list = Array.from({ length: 20 }, (_, i) => ht(`t${i}`, i));
    expect(selectMenuThreads(list, new Set())).toHaveLength(MENU_THREAD_LIMIT);
  });

  it("keeps every LIVE thread visible however old it is", () => {
    // t0 is the oldest of 20 — it would be cut, but it is live.
    const list = Array.from({ length: 20 }, (_, i) => ht(`t${i}`, i));
    const out = selectMenuThreads(list, new Set(["t0"]));
    expect(out).toHaveLength(MENU_THREAD_LIMIT);
    expect(out[0].id).toBe("t0");
  });

  it("grows past the limit rather than hiding a live thread", () => {
    const list = Array.from({ length: 20 }, (_, i) => ht(`t${i}`, i));
    const live = new Set(list.slice(0, 12).map((t) => t.id));
    const out = selectMenuThreads(list, live);
    expect(out).toHaveLength(12);
    expect(out.every((t) => live.has(t.id))).toBe(true);
  });

  it("returns everything when there is less than a limit's worth", () => {
    const list = [ht("a", 1), ht("b", 2)];
    expect(selectMenuThreads(list, new Set())).toHaveLength(2);
  });
});

// ── SWIT-46: the grouped rail + the shells group ─────────────────────────────

describe("groupMenuThreads", () => {
  it("groups by repo name, in the order of each group's best-ranked thread", () => {
    const list = [
      ht("lode1", 300, { workingDir: "C:\\repos\\lodestar" }),
      ht("swit1", 400, { workingDir: "C:\\repos\\switchboard" }),
      ht("lode2", 200, { workingDir: "C:\\repos\\lodestar" }),
    ];
    const out = groupMenuThreads(list, new Set());
    expect(out.map((g) => g.project)).toEqual(["switchboard", "lodestar"]);
    expect(out[1].threads.map((t) => t.id)).toEqual(["lode1", "lode2"]);
  });

  it("live threads pull their group to the front and count in liveCount", () => {
    const list = [
      ht("a", 300, { workingDir: "C:\\repos\\switchboard" }),
      ht("b", 100, { workingDir: "C:\\repos\\lodestar" }),
      ht("c", 200, { workingDir: "C:\\repos\\lodestar" }),
    ];
    const out = groupMenuThreads(list, new Set(["b"]));
    // b is live → lodestar's best-ranked thread is first overall.
    expect(out.map((g) => g.project)).toEqual(["lodestar", "switchboard"]);
    expect(out[0].threads.map((t) => t.id)).toEqual(["b", "c"]);
    expect(out[0].liveCount).toBe(1);
    expect(out[1].liveCount).toBe(0);
  });

  it("is a fold over selectMenuThreads — same threads, same order, just grouped", () => {
    const list = Array.from({ length: 20 }, (_, i) =>
      ht(`t${i}`, i, { workingDir: i % 2 === 0 ? "C:\\repos\\a" : "C:\\repos\\b" })
    );
    const live = new Set(["t0"]);
    const flat = groupMenuThreads(list, live).flatMap((g) => g.threads.map((t) => t.id));
    const selected = selectMenuThreads(list, live).map((t) => t.id);
    expect([...flat].sort()).toEqual([...selected].sort());
  });

  it("hides archived threads exactly as the flat rail does", () => {
    const list = [
      ht("a", 300, { workingDir: "C:\\repos\\a" }),
      ht("b", 200, { workingDir: "C:\\repos\\a", archivedAt: 250 }),
    ];
    const out = groupMenuThreads(list, new Set());
    expect(out).toHaveLength(1);
    expect(out[0].threads.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("selectShellSessions", () => {
  const shell = (id: string): MenuSession => ({
    id,
    name: id,
    workingDir: "C:\\Users\\me",
    status: "idle",
  });

  it("returns sessions no thread record claims", () => {
    const threads = [ht("t1", 1, { sessionId: "s1" })];
    const out = selectShellSessions(threads, [shell("s1"), shell("s2")]);
    expect(out.map((s) => s.id)).toEqual(["s2"]);
  });

  it("a promotion (thread gains the session id) empties the shells group", () => {
    const sessions = [shell("s1")];
    expect(selectShellSessions([ht("t1", 1)], sessions)).toHaveLength(1);
    expect(selectShellSessions([ht("t1", 1, { sessionId: "s1" })], sessions)).toHaveLength(0);
  });

  it("an ARCHIVED thread still claims its session — archive is a state, not a loss", () => {
    const threads = [ht("t1", 1, { sessionId: "s1", archivedAt: 5 })];
    expect(selectShellSessions(threads, [shell("s1")])).toHaveLength(0);
  });
});

describe("filterThreads", () => {
  const list = [
    ht("a", 1, { title: "orbit · Aug 2", workingDir: "C:\\repos\\orbit" }),
    ht("b", 2, { title: "nightly sweep", workingDir: "C:\\repos\\lodestar" }),
  ];

  it("matches title case-insensitively", () => {
    expect(filterThreads(list, "ORBIT").map((t) => t.id)).toEqual(["a"]);
  });

  it("matches the repo name too", () => {
    expect(filterThreads(list, "lodestar").map((t) => t.id)).toEqual(["b"]);
  });

  it("returns everything for a blank or whitespace query", () => {
    expect(filterThreads(list, "")).toHaveLength(2);
    expect(filterThreads(list, "   ")).toHaveLength(2);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterThreads(list, "zzz")).toEqual([]);
  });
});

describe("relativeActivity", () => {
  const NOW = 1_000_000_000;

  it("reads as minutes, hours then days", () => {
    expect(relativeActivity(NOW - 30_000, NOW)).toBe("just now");
    expect(relativeActivity(NOW - 12 * 60_000, NOW)).toBe("12m ago");
    expect(relativeActivity(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
    expect(relativeActivity(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  });

  it("prints an honest dash for a record with no activity", () => {
    expect(relativeActivity(0, NOW)).toBe("—");
  });

  it("clamps a future timestamp instead of printing a negative age", () => {
    expect(relativeActivity(NOW + 60_000, NOW)).toBe("just now");
  });
});

describe("resolveThreadByQuery (@thread targets, SWIT-52)", () => {
  const list = [
    ht("t1", 1, { title: "sim audit" }),
    ht("t2", 2, { title: "markets - Aug 30" }),
    ht("t3", 3, { title: "coaching reorg" }),
    ht("t4", 4, { title: "old audit", archivedAt: 9 }),
  ];

  it("exact id wins; a unique title substring resolves case-insensitively", () => {
    expect(resolveThreadByQuery(list, "t2")).toEqual({ thread: list[1] });
    expect(resolveThreadByQuery(list, "COACHING")).toEqual({ thread: list[2] });
    expect(resolveThreadByQuery(list, "markets")).toEqual({ thread: list[1] });
  });

  it("self is excluded, archived threads never match, misses and ambiguity are sentences", () => {
    expect(resolveThreadByQuery(list, "sim audit", "t1")).toHaveProperty("error");
    expect(resolveThreadByQuery(list, "old audit")).toHaveProperty("error"); // archived
    expect("error" in resolveThreadByQuery(list, "nothing-matches")).toBe(true);
    // "audit" matches only sim audit among ACTIVE threads -> unique.
    expect(resolveThreadByQuery(list, "audit")).toEqual({ thread: list[0] });
    const multi = resolveThreadByQuery([...list, ht("t5", 5, { title: "audit two" })], "audit");
    expect("error" in multi).toBe(true);
  });
});

describe("parseThreadPost (the composer's @ form)", () => {
  it("one-word and quoted targets, body required", () => {
    expect(parseThreadPost("@sim-audit re-run the check")).toEqual({
      target: "sim-audit",
      body: "re-run the check",
    });
    expect(parseThreadPost('@"markets - Aug 30" look at this')).toEqual({
      target: "markets - Aug 30",
      body: "look at this",
    });
  });

  it("ordinary messages (and bare @) are NOT posts", () => {
    expect(parseThreadPost("plain message")).toBeNull();
    expect(parseThreadPost("@target")).toBeNull(); // no body
    expect(parseThreadPost("email me @ home later")).toBeNull();
    expect(parseThreadPost("")).toBeNull();
  });
});

// ── SWIT-56: the Ky-shaped band — flat rows, the `+`, the default title ──────

describe("explicitThreadTitle (SWIT-56 default)", () => {
  it("is what was typed, trimmed", () => {
    expect(explicitThreadTitle("  fix the fit queue ")).toBe("fix the fit queue");
  });

  it("falls back to `New thread`, never to repo · date, when nothing was typed", () => {
    expect(NEW_THREAD_TITLE).toBe("New thread");
    expect(explicitThreadTitle("")).toBe(NEW_THREAD_TITLE);
    expect(explicitThreadTitle("   ")).toBe(NEW_THREAD_TITLE);
    expect(explicitThreadTitle(undefined)).toBe(NEW_THREAD_TITLE);
    expect(explicitThreadTitle(null)).toBe(NEW_THREAD_TITLE);
  });

  it("leaves the promoted default alone — repo · date is still what a discovered thread is called", () => {
    expect(defaultThreadTitle("lodestar", new Date(2026, 8, 1))).toBe("lodestar · Sep 1");
  });
});

describe("menuThreadRows (what the rail draws = what Ctrl+1–9 counts)", () => {
  const orbit = "C:\\repos\\orbit";
  const lode = "C:\\repos\\lodestar";
  // Interleaved projects so grouping and flat ranking DISAGREE.
  const list = [
    ht("o1", 10, { workingDir: orbit }),
    ht("l1", 9, { workingDir: lode }),
    ht("o2", 8, { workingDir: orbit }),
    ht("l2", 7, { workingDir: lode }),
  ];

  it("flat (bare mode): live first, then most recent by last activity", () => {
    expect(menuThreadRows(list, new Set(), false).map((t) => t.id)).toEqual(["o1", "l1", "o2", "l2"]);
    expect(menuThreadRows(list, new Set(["l2"]), false).map((t) => t.id)).toEqual(["l2", "o1", "l1", "o2"]);
  });

  it("flat ordering is exactly selectMenuThreads' — one rule, two callers", () => {
    const live = new Set(["o2"]);
    expect(menuThreadRows(list, live, false)).toEqual(selectMenuThreads(list, live));
  });

  it("grouped (full mode): the SWIT-46 grouping, flattened in draw order", () => {
    expect(menuThreadRows(list, new Set(), true).map((t) => t.id)).toEqual(["o1", "o2", "l1", "l2"]);
    expect(menuThreadRows(list, new Set(), true)).toEqual(
      groupMenuThreads(list, new Set()).flatMap((g) => g.threads)
    );
  });

  it("keeps the cap and the live-never-truncated rule in both modes", () => {
    const many = Array.from({ length: 20 }, (_, i) => ht(`t${i}`, i));
    expect(menuThreadRows(many, new Set(), false)).toHaveLength(MENU_THREAD_LIMIT);
    expect(menuThreadRows(many, new Set(), true)).toHaveLength(MENU_THREAD_LIMIT);
    expect(menuThreadRows(many, new Set(["t0"]), false)[0].id).toBe("t0");
    expect(menuThreadRows(many, new Set(["t0"]), true)[0].id).toBe("t0");
  });

  it("drops archived threads like the rail does", () => {
    const withArchived = [...list, ht("gone", 100, { archivedAt: 5 })];
    expect(menuThreadRows(withArchived, new Set(), false).map((t) => t.id)).not.toContain("gone");
    expect(menuThreadRows(withArchived, new Set(), true).map((t) => t.id)).not.toContain("gone");
  });
});

describe("quickCreateWorkingDir (where the header `+` puts a thread)", () => {
  const orbit = "C:\\repos\\orbit";
  const lode = "C:\\repos\\lodestar";

  it("prefers the thread bound to the ACTIVE tab", () => {
    const list = [
      ht("recent", 100, { workingDir: lode }),
      ht("bound", 1, { workingDir: orbit, sessionId: "s-active" }),
    ];
    expect(quickCreateWorkingDir(list, "s-active")).toBe(orbit);
  });

  it("else the most recently active thread's directory", () => {
    const list = [
      ht("old", 1, { workingDir: orbit }),
      ht("recent", 100, { workingDir: lode }),
    ];
    expect(quickCreateWorkingDir(list, null)).toBe(lode);
    // An active tab no thread claims (a plain shell) is the same case.
    expect(quickCreateWorkingDir(list, "s-unbound")).toBe(lode);
  });

  it("counts an archived thread for recency — putting a thread away says nothing about the repo", () => {
    const list = [
      ht("old", 1, { workingDir: orbit }),
      ht("recent-archived", 100, { workingDir: lode, archivedAt: 200 }),
    ];
    expect(quickCreateWorkingDir(list, null)).toBe(lode);
  });

  it("is null with no threads (or none with a directory) — the caller falls back to the tab's cwd", () => {
    expect(quickCreateWorkingDir([], null)).toBeNull();
    expect(quickCreateWorkingDir([ht("blank", 1, { workingDir: "  " })], null)).toBeNull();
  });
});

describe("rename request (the `+` opens the title box)", () => {
  beforeEach(() => __resetThreadStoreForTests());
  const two = () => {
    const a = createThreadRecord({ title: "New thread", workingDir: "C:/a" });
    const b = createThreadRecord({ title: "New thread", workingDir: "C:/b" });
    return [a.id, b.id] as const;
  };

  it("is null until asked, set once asked, and cleared by the row that honoured it", () => {
    const [t1] = two();
    expect(getThreadsView().renameRequest).toBeNull();
    requestThreadRename(t1);
    expect(getThreadsView().renameRequest).toBe(t1);
    clearThreadRenameRequest(t1);
    expect(getThreadsView().renameRequest).toBeNull();
  });

  it("a stale clear does not cancel a newer request", () => {
    const [t1, t2] = two();
    requestThreadRename(t1);
    requestThreadRename(t2);
    expect(getThreadsView().renameRequest).toBe(t2);
    clearThreadRenameRequest(t1);
    expect(getThreadsView().renameRequest).toBe(t2);
  });

  it("re-asking the same id does not notify again (no re-render churn)", () => {
    const [t1] = two();
    requestThreadRename(t1);
    const before = getThreadsView();
    requestThreadRename(t1);
    expect(getThreadsView()).toBe(before);
  });

  // Review fix (SWIT-55..57): a request never outlives its thread or its box.
  it("a rename answers the request — even one that leaves the title unchanged", () => {
    const [t1] = two();
    requestThreadRename(t1);
    renameThread(t1, "New thread"); // the box committed untouched
    expect(getThreadsView().renameRequest).toBeNull();
    requestThreadRename(t1);
    renameThread(t1, "fix the fit queue");
    expect(getThreadsView().renameRequest).toBeNull();
    expect(getThreadById(t1)!.title).toBe("fix the fit queue");
  });

  it("archiving or deleting the thread drops its request", () => {
    const [t1, t2] = two();
    requestThreadRename(t1);
    setThreadArchived(t1, true);
    expect(getThreadsView().renameRequest).toBeNull();
    requestThreadRename(t2);
    deleteThread(t2);
    expect(getThreadsView().renameRequest).toBeNull();
  });

  it("a request for a thread that is not in the list reads as null", () => {
    const [t1] = two();
    requestThreadRename("never-created");
    expect(getThreadsView().renameRequest).toBeNull();
    requestThreadRename(t1);
    expect(getThreadsView().renameRequest).toBe(t1);
  });

  it("the box holds focus against a programmatic terminal focus only", () => {
    const steal = { blurredToTerminal: true, pointerSinceOpen: false, ageMs: 300 };
    expect(renameEditorHoldsFocus(steal)).toBe(true);
    // A click on the terminal is a gesture: commit.
    expect(renameEditorHoldsFocus({ ...steal, pointerSinceOpen: true })).toBe(false);
    // Focus leaving for anywhere else: commit.
    expect(renameEditorHoldsFocus({ ...steal, blurredToTerminal: false })).toBe(false);
    // Past the settle window: commit (a bound, not a fight).
    expect(renameEditorHoldsFocus({ ...steal, ageMs: RENAME_FOCUS_HOLD_MS })).toBe(false);
  });
});

// ── The header `+` chooser's order (0.5.2) ───────────────────────────────────
describe("orderThreadRepoChoices", () => {
  const opt = (name: string, path: string, archived = false) => ({
    name,
    path,
    color: "#A78BFA",
    group: "",
    status: archived ? "archived" : "active",
    archived,
    source: "registry" as const,
  });
  const options = [
    opt("switchboard", "C:/p/switchboard"),
    opt("lodestar", "C:/p/lodestar"),
    opt("orbit", "C:/p/orbit"),
    opt("zz-retired", "C:/p/zz-retired", true),
  ];

  it("puts the default target's repo first, the rest alphabetical, archived sunk last", () => {
    const r = orderThreadRepoChoices(options, "C:\\p\\Switchboard");
    expect(r.defaultIsRepo).toBe(true);
    expect(r.repos.map((o) => o.name)).toEqual(["switchboard", "lodestar", "orbit", "zz-retired"]);
  });

  it("matches the default by sameWorkingDir's rule (case, slashes, trailing separators)", () => {
    const r = orderThreadRepoChoices(options, "C:\\P\\ORBIT\\");
    expect(r.defaultIsRepo).toBe(true);
    expect(r.repos[0].name).toBe("orbit");
  });

  it("no default dir → alphabetical with no default row", () => {
    for (const dir of [null, "", "   "]) {
      const r = orderThreadRepoChoices(options, dir);
      expect(r.defaultIsRepo).toBe(false);
      expect(r.repos.map((o) => o.name)).toEqual(["lodestar", "orbit", "switchboard", "zz-retired"]);
    }
  });

  it("a default dir no repo claims leaves defaultIsRepo false — the no-repo row is the default", () => {
    const r = orderThreadRepoChoices(options, "C:/somewhere/else");
    expect(r.defaultIsRepo).toBe(false);
    expect(r.repos).toHaveLength(4);
  });

  it("empty options never throw", () => {
    expect(orderThreadRepoChoices([], "C:/p/x")).toEqual({ repos: [], defaultIsRepo: false });
  });
});
