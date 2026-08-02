// Tab → thread promotion (increment C). The Rust side (discovery.rs) decides
// WHICH tab runs which conversation and refuses ambiguity there; these tests
// cover what a discovery MEANS for the thread list — and above all that no
// branch can produce a second record for one tab or one conversation.

import { describe, it, expect, vi } from "vitest";
import type { Thread } from "../types";
import type { ClaudeDiscovery } from "./ipc";
import {
  planPromotion,
  shouldRunPromotionPass,
  promotionPassReason,
  runPromotionPass,
  BOUND_SWEEP_MS,
  PROMOTION_POLL_MS,
} from "./threadPromotion";

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    title: "orbit · Aug 2",
    workingDir: "C:\\repos\\orbit",
    chatSessionId: "uuid-1",
    chatStarted: false,
    sessionId: null,
    createdAt: 1000,
    lastActivityAt: 1000,
    ...over,
  };
}

function discovery(over: Partial<ClaudeDiscovery> = {}): ClaudeDiscovery {
  return {
    sessionId: "tab-a",
    chatSessionId: "uuid-1",
    cwd: "C:\\repos\\orbit",
    startedAt: 5000,
    ...over,
  };
}

const LIVE = (...ids: string[]) => new Set(ids);

describe("planPromotion", () => {
  it("creates when neither the tab nor the conversation is known", () => {
    const plan = planPromotion(discovery(), [], LIVE("tab-a"));
    expect(plan.kind).toBe("create");
  });

  it("is a no-op once the tab and the conversation are the same thread", () => {
    const t = thread({ sessionId: "tab-a", chatSessionId: "uuid-1" });
    const plan = planPromotion(discovery(), [t], LIVE("tab-a"));
    expect(plan).toEqual({ kind: "skip", reason: "already bound" });
  });

  it("is a no-op for an EXPLICIT thread whose minted uuid claude honoured", () => {
    // The `+ new thread` path types `claude --session-id <our uuid>`, so the
    // discovery reports exactly our uuid. Promotion must not touch it.
    const t = thread({ sessionId: "tab-a", chatSessionId: "uuid-1", chatStarted: true });
    expect(planPromotion(discovery(), [t], LIVE("tab-a")).kind).toBe("skip");
  });

  it("binds when the conversation has a record whose tab is gone", () => {
    const t = thread({ sessionId: null });
    const plan = planPromotion(discovery(), [t], LIVE("tab-a"));
    expect(plan).toEqual({ kind: "bind", threadId: "t1", discovery: discovery() });
  });

  it("binds when the record points at a tab that no longer exists", () => {
    const t = thread({ sessionId: "tab-closed" });
    const plan = planPromotion(discovery(), [t], LIVE("tab-a"));
    expect(plan.kind).toBe("bind");
  });

  it("refuses to steal a conversation bound to another LIVE tab", () => {
    const t = thread({ sessionId: "tab-b" });
    const plan = planPromotion(discovery(), [t], LIVE("tab-a", "tab-b"));
    expect(plan.kind).toBe("skip");
  });

  it("supersedes when claude restarted in a tab under a new uuid (Decision 1)", () => {
    // Increment E reverses increment C here: the tab's OLD thread is named for
    // release, not for rewriting. Nothing is forgotten — the caller unbinds it
    // and creates a second record for the new conversation.
    const t = thread({ sessionId: "tab-a", chatSessionId: "uuid-old" });
    const plan = planPromotion(discovery({ chatSessionId: "uuid-new" }), [t], LIVE("tab-a"));
    expect(plan).toEqual({
      kind: "supersede",
      threadId: "t1",
      discovery: discovery({ chatSessionId: "uuid-new" }),
    });
  });

  it("still refuses to duplicate a RE-DETECTED conversation (same uuid, same tab)", () => {
    // The idempotency that survives Decision 1: a conversation is recorded
    // once, however many passes see it.
    const t = thread({ sessionId: "tab-a", chatSessionId: "uuid-1" });
    for (let pass = 0; pass < 3; pass++) {
      expect(planPromotion(discovery(), [t], LIVE("tab-a")).kind).toBe("skip");
    }
  });

  it("matches ARCHIVED records like any other — never a duplicate", () => {
    // An archived thread whose conversation turns up again must find its own
    // record. Filtering archived threads out here would mint a second one.
    const t = thread({ sessionId: null, archivedAt: 1234 });
    expect(planPromotion(discovery(), [t], LIVE("tab-a"))).toEqual({
      kind: "bind",
      threadId: "t1",
      discovery: discovery(),
    });
  });

  it("refuses when the tab is one thread and the conversation is another", () => {
    const a = thread({ id: "t-tab", sessionId: "tab-a", chatSessionId: "uuid-x" });
    const b = thread({ id: "t-conv", sessionId: null, chatSessionId: "uuid-1" });
    const plan = planPromotion(discovery(), [a, b], LIVE("tab-a"));
    expect(plan.kind).toBe("skip");
    // Refusals must be explicable — the reason names both records.
    if (plan.kind === "skip") {
      expect(plan.reason).toContain("t-tab");
      expect(plan.reason).toContain("t-conv");
    }
  });
});

describe("promotionPassReason (the gate, sweep included)", () => {
  const bound = [thread({ sessionId: "tab-a" })];

  it("runs immediately when a live tab has no thread", () => {
    expect(promotionPassReason(["tab-a"], [], 10_000, 10_000)).toBe("unbound");
  });

  it("still costs zero IPC with no tabs at all, however long it has been", () => {
    expect(promotionPassReason([], bound, 1_000_000, 0)).toBeNull();
  });

  it("SWEEPS an all-bound workspace rather than going silent forever", () => {
    // The bug this closes: one tab, bound, user restarts claude in it. The old
    // gate returned false for good and supersede could never fire.
    expect(promotionPassReason(["tab-a"], bound, BOUND_SWEEP_MS, 0)).toBe("sweep");
  });

  it("holds the sweep until its cadence is due", () => {
    expect(promotionPassReason(["tab-a"], bound, BOUND_SWEEP_MS - 1, 0)).toBeNull();
    // …which is what keeps the steady state cheap: most 4s ticks do nothing.
    expect(promotionPassReason(["tab-a"], bound, PROMOTION_POLL_MS, 0)).toBeNull();
  });

  it("is markedly lazier than the base tick, and not a disguised constant poll", () => {
    expect(BOUND_SWEEP_MS).toBeGreaterThanOrEqual(PROMOTION_POLL_MS * 4);
  });

  it("an unbound pass resets the sweep clock too — one snapshot covers every tab", () => {
    // Caller contract: `lastPassAt` is when a pass RAN, either reason.
    expect(promotionPassReason(["tab-a", "tab-b"], bound, 5_000, 0)).toBe("unbound");
    expect(promotionPassReason(["tab-a"], bound, 5_000 + BOUND_SWEEP_MS - 1, 5_000)).toBeNull();
  });
});

describe("shouldRunPromotionPass", () => {
  it("runs when a live tab has no thread", () => {
    expect(shouldRunPromotionPass(["tab-a"], [])).toBe(true);
  });

  it("stops when every live tab is bound (the zero-IPC steady state)", () => {
    const t = thread({ sessionId: "tab-a" });
    expect(shouldRunPromotionPass(["tab-a"], [t])).toBe(false);
  });

  it("stops when there are no tabs at all", () => {
    expect(shouldRunPromotionPass([], [thread()])).toBe(false);
  });

  it("runs when one of several tabs is unbound", () => {
    const t = thread({ sessionId: "tab-a" });
    expect(shouldRunPromotionPass(["tab-a", "tab-b"], [t])).toBe(true);
  });
});

// ── Pass runner ──────────────────────────────────────────────────────────────

function harness(opts: {
  sessions: string[];
  threads: Thread[];
  discoveries?: ClaudeDiscovery[];
  discoverError?: unknown;
  onDisk?: boolean;
  /** Ground truth unavailable (home dir unresolvable) — the pass must still
   *  record the thread. */
  onDiskError?: unknown;
}) {
  const threads = [...opts.threads];
  const created: Array<{
    chatSessionId: string;
    chatStarted: boolean;
    title: string;
    workingDir: string;
    sessionId: string;
    startedAt: number;
  }> = [];
  const bound: Array<[string, string]> = [];
  const unbound: string[] = [];
  const launched: string[] = [];
  const logs: string[] = [];
  const persist = vi.fn();

  const fx = {
    liveSessionIds: () => opts.sessions,
    threads: () => threads,
    discover: vi.fn(async () => {
      if (opts.discoverError) throw opts.discoverError;
      return opts.discoveries ?? [];
    }),
    chatStartedOnDisk: vi.fn(async (): Promise<boolean> => {
      if (opts.onDiskError) throw opts.onDiskError;
      return opts.onDisk ?? false;
    }),
    createThread: (args: {
      title: string;
      workingDir: string;
      chatSessionId: string;
      chatStarted: boolean;
      sessionId: string;
      startedAt: number;
    }) => {
      created.push(args);
      const id = `new-${created.length}`;
      threads.push({
        id,
        title: args.title,
        workingDir: args.workingDir,
        chatSessionId: args.chatSessionId,
        chatStarted: args.chatStarted,
        sessionId: args.sessionId,
        createdAt: args.startedAt,
        lastActivityAt: 1,
      });
      return id;
    },
    bindThread: (threadId: string, sessionId: string) => {
      bound.push([threadId, sessionId]);
      const t = threads.find((x) => x.id === threadId);
      if (t) t.sessionId = sessionId;
    },
    unbindThread: (threadId: string) => {
      unbound.push(threadId);
      const t = threads.find((x) => x.id === threadId);
      if (t) t.sessionId = null;
    },
    markLaunched: (id: string) => launched.push(id),
    persist,
    defaultTitle: (repo: string) => `${repo} · Aug 2`,
    repoName: (dir: string) => dir.split(/[/\\]/).filter(Boolean).pop() ?? dir,
    log: (m: string) => logs.push(m),
  };

  return { fx, threads, created, bound, unbound, launched, logs, persist };
}

describe("runPromotionPass", () => {
  it("promotes a plain tab running claude, adopting claude's uuid and cwd", async () => {
    // Acceptance 1: `Ctrl+T`, `cd` into a repo, type `claude`.
    const h = harness({
      sessions: ["tab-a"],
      threads: [],
      discoveries: [discovery({ cwd: "C:\\repos\\lodestar" })],
      onDisk: true,
    });
    expect(await runPromotionPass(h.fx)).toBe(1);
    expect(h.created).toEqual([
      {
        title: "lodestar · Aug 2",
        workingDir: "C:\\repos\\lodestar",
        chatSessionId: "uuid-1",
        // Acceptance 2's precondition: a discovered conversation with a
        // transcript on disk IS started, so revive will --resume it.
        chatStarted: true,
        sessionId: "tab-a",
        // claude's own launch time, not the poll that noticed it.
        startedAt: 5000,
      },
    ]);
    expect(h.launched).toEqual(["new-1"]);
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("marks chatStarted false when no transcript exists yet", async () => {
    const h = harness({
      sessions: ["tab-a"],
      threads: [],
      discoveries: [discovery()],
      onDisk: false,
    });
    await runPromotionPass(h.fx);
    expect(h.created[0].chatStarted).toBe(false);
  });

  it("still records the thread when ground truth is unavailable", async () => {
    // Losing the transcript check costs a hint that revive re-derives anyway;
    // losing the RECORD costs the orphan case this feature exists to fix.
    const h = harness({
      sessions: ["tab-a"],
      threads: [],
      discoveries: [discovery()],
      onDiskError: new Error("home dir unresolvable"),
    });
    expect(await runPromotionPass(h.fx)).toBe(1);
    expect(h.created[0].chatStarted).toBe(false);
    expect(h.logs.some((l) => l.includes("Ground truth unavailable"))).toBe(true);
  });

  it("does nothing when no tab is running claude", async () => {
    // Acceptance 3: a plain shell stays out of Threads.
    const h = harness({ sessions: ["tab-a"], threads: [], discoveries: [] });
    expect(await runPromotionPass(h.fx)).toBe(0);
    expect(h.created).toEqual([]);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("promotes only the tab that is actually running claude", async () => {
    // Acceptance 4: two tabs in the SAME repo. Rust reports one binding; this
    // side must not spread it.
    const h = harness({
      sessions: ["tab-a", "tab-b"],
      threads: [],
      discoveries: [discovery({ sessionId: "tab-b" })],
      onDisk: false,
    });
    await runPromotionPass(h.fx);
    expect(h.created).toHaveLength(1);
    expect(h.created[0].sessionId).toBe("tab-b");
  });

  it("is idempotent — a second pass over the same tab creates nothing", async () => {
    const h = harness({
      sessions: ["tab-a"],
      threads: [],
      discoveries: [discovery()],
      onDisk: true,
    });
    await runPromotionPass(h.fx);
    // Now the tab is bound, so the pass short-circuits before any IPC.
    expect(await runPromotionPass(h.fx)).toBe(0);
    expect(h.created).toHaveLength(1);
    expect(h.fx.discover).toHaveBeenCalledTimes(1);
  });

  it("never issues IPC when every tab is already bound", async () => {
    const h = harness({
      sessions: ["tab-a"],
      threads: [thread({ sessionId: "tab-a" })],
      discoveries: [discovery()],
    });
    expect(await runPromotionPass(h.fx)).toBe(0);
    expect(h.fx.discover).not.toHaveBeenCalled();
  });

  it("a SWEEP runs over an all-bound workspace and supersedes a restart", async () => {
    // The single-tab shape the old gate could never see: one bound tab whose
    // claude restarted under a new uuid. With the reason supplied, the pass
    // runs and Decision 1 applies as usual.
    const h = harness({
      sessions: ["tab-a"],
      threads: [thread({ sessionId: "tab-a", chatSessionId: "uuid-old" })],
      discoveries: [discovery({ sessionId: "tab-a", chatSessionId: "uuid-new" })],
      onDisk: true,
    });
    expect(await runPromotionPass(h.fx, "sweep")).toBe(1);
    expect(h.fx.discover).toHaveBeenCalledTimes(1);
    expect(h.unbound).toEqual(["t1"]);
    expect(h.created).toHaveLength(1);
    expect(h.created[0].chatSessionId).toBe("uuid-new");
  });

  it("a sweep with nothing new is still a clean no-op", async () => {
    const h = harness({
      sessions: ["tab-a"],
      threads: [thread({ sessionId: "tab-a", chatSessionId: "uuid-1" })],
      discoveries: [discovery({ sessionId: "tab-a", chatSessionId: "uuid-1" })],
    });
    expect(await runPromotionPass(h.fx, "sweep")).toBe(0);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("a sweep over zero tabs issues no IPC", async () => {
    const h = harness({ sessions: [], threads: [], discoveries: [discovery()] });
    expect(await runPromotionPass(h.fx, "sweep")).toBe(0);
    expect(h.fx.discover).not.toHaveBeenCalled();
  });

  it("starts a NEW thread when claude restarts in a bound tab (acceptance 1)", async () => {
    // Two tabs: tab-b is unbound (so the pass runs), tab-a has a thread whose
    // claude restarted under a new uuid. Thread A is released — keeping its
    // uuid, and therefore revivable — and thread B takes the tab.
    const h = harness({
      sessions: ["tab-a", "tab-b"],
      threads: [thread({ sessionId: "tab-a", chatSessionId: "uuid-old" })],
      discoveries: [discovery({ sessionId: "tab-a", chatSessionId: "uuid-new" })],
      onDisk: true,
    });
    expect(await runPromotionPass(h.fx)).toBe(1);

    expect(h.unbound).toEqual(["t1"]);
    // A is intact: same record, same conversation id, just no tab.
    const a = h.threads.find((t) => t.id === "t1")!;
    expect(a.chatSessionId).toBe("uuid-old");
    expect(a.sessionId).toBeNull();

    // B is a real second record bound to the tab, with claude's new uuid.
    expect(h.created).toEqual([
      {
        title: "orbit · Aug 2",
        workingDir: "C:\\repos\\orbit",
        chatSessionId: "uuid-new",
        chatStarted: true,
        sessionId: "tab-a",
        startedAt: 5000,
      },
    ]);
    expect(h.launched).toEqual(["new-1"]);
    expect(h.threads).toHaveLength(2);
  });

  it("a superseded thread is not re-superseded on the next pass", async () => {
    // Idempotency across passes: after the swap the tab and the conversation
    // are the same thread again, so the next pass is a plain no-op.
    const h = harness({
      sessions: ["tab-a", "tab-b"],
      threads: [thread({ sessionId: "tab-a", chatSessionId: "uuid-old" })],
      discoveries: [discovery({ sessionId: "tab-a", chatSessionId: "uuid-new" })],
      onDisk: true,
    });
    await runPromotionPass(h.fx);
    expect(await runPromotionPass(h.fx)).toBe(0);
    expect(h.created).toHaveLength(1);
    expect(h.unbound).toEqual(["t1"]);
  });

  it("releases BEFORE creating, so the tab is never claimed by two records", async () => {
    const h = harness({
      sessions: ["tab-a", "tab-b"],
      threads: [thread({ sessionId: "tab-a", chatSessionId: "uuid-old" })],
      discoveries: [discovery({ sessionId: "tab-a", chatSessionId: "uuid-new" })],
    });
    const order: string[] = [];
    const realUnbind = h.fx.unbindThread;
    const realCreate = h.fx.createThread;
    h.fx.unbindThread = (id: string) => {
      order.push("unbind");
      realUnbind(id);
    };
    h.fx.createThread = (args) => {
      order.push("create");
      // At this moment exactly one record may name tab-a.
      expect(h.threads.filter((t) => t.sessionId === "tab-a")).toHaveLength(0);
      return realCreate(args);
    };
    await runPromotionPass(h.fx);
    expect(order).toEqual(["unbind", "create"]);
  });

  it("a bind does not re-check disk — it keeps the record's own uuid and hint", async () => {
    const h = harness({
      sessions: ["tab-a", "tab-b"],
      threads: [thread({ sessionId: null, chatStarted: true })],
      discoveries: [discovery()],
    });
    expect(await runPromotionPass(h.fx)).toBe(1);
    expect(h.bound).toEqual([["t1", "tab-a"]]);
    expect(h.fx.chatStartedOnDisk).not.toHaveBeenCalled();
    expect(h.threads[0].chatStarted).toBe(true);
  });

  it("skips a discovery whose tab closed during the pass", async () => {
    const h = harness({ sessions: ["tab-a"], threads: [], discoveries: [discovery()] });
    // The tab list empties between discover() and the apply loop.
    let calls = 0;
    h.fx.liveSessionIds = () => (calls++ === 0 ? ["tab-a"] : []);
    expect(await runPromotionPass(h.fx)).toBe(0);
    expect(h.created).toEqual([]);
  });

  it("survives a failed discovery without throwing", async () => {
    const h = harness({
      sessions: ["tab-a"],
      threads: [],
      discoverError: new Error("snapshot failed"),
    });
    expect(await runPromotionPass(h.fx)).toBe(0);
    expect(h.logs.some((l) => l.includes("Claude discovery failed"))).toBe(true);
  });

  it("does not duplicate when two discoveries name the same conversation", async () => {
    // Defence in depth: Rust already refuses this, but the apply loop must not
    // be the place a duplicate could appear either.
    const h = harness({
      sessions: ["tab-a", "tab-b"],
      threads: [],
      discoveries: [discovery({ sessionId: "tab-a" }), discovery({ sessionId: "tab-b" })],
      onDisk: false,
    });
    await runPromotionPass(h.fx);
    expect(h.created).toHaveLength(1);
    // The second one hits the "already bound to live tab" refusal.
    expect(h.logs.some((l) => l.includes("Promotion skipped"))).toBe(true);
  });

  it("persists once per pass, not once per record", async () => {
    const h = harness({
      sessions: ["tab-a", "tab-b"],
      threads: [],
      discoveries: [
        discovery({ sessionId: "tab-a", chatSessionId: "uuid-1" }),
        discovery({ sessionId: "tab-b", chatSessionId: "uuid-2" }),
      ],
      onDisk: false,
    });
    expect(await runPromotionPass(h.fx)).toBe(2);
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("polls lazily — promotion is not latency-critical", () => {
    expect(PROMOTION_POLL_MS).toBeGreaterThanOrEqual(2000);
  });
});
