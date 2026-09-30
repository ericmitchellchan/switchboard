// KB data-layer tests (T6) — the PURE parts: tree building, list equality,
// the poll differ (mergeDocRead), doc-kind switch, ancestor expansion. The
// hooks are thin shells over these; IPC itself is Rust-tested (kb.rs).

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildKbTree,
  ancestorFolders,
  sameDocList,
  mergeDocRead,
  docKind,
  EMPTY_DOC_STATE,
  KB_MISS_CAP,
  getCachedDocList,
  noteKbMiss,
  refreshDocList,
  rememberKbMiss,
  resolveWithFreshKbDocs,
  subscribeDocList,
  __resetKbCacheForTests,
} from "./kb";
import type { KbNode } from "./kb";
import { kbListDocs } from "./ipc";
import { resolveDocTarget } from "./evidenceModel";

// The list IPC is the one effect the miss rule has (SWIT-101) — everything
// else in this file is pure and never touches it.
vi.mock("./ipc", () => ({ kbListDocs: vi.fn(), kbReadDoc: vi.fn() }));
const listDocs = vi.mocked(kbListDocs);

/** Let the coalescing microtask and the refresh it starts both finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function names(nodes: KbNode[]): string[] {
  return nodes.map((n) => `${n.type}:${n.name}`);
}

describe("buildKbTree", () => {
  it("returns [] for an empty list", () => {
    expect(buildKbTree([])).toEqual([]);
  });

  it("groups by top segment (project) with root docs alongside", () => {
    const tree = buildKbTree([
      "switchboard/notes.md",
      "lodestar/plan.md",
      "README.md",
      "registry.json",
    ]);
    expect(names(tree)).toEqual([
      "folder:lodestar",
      "folder:switchboard",
      "doc:README.md",
      "doc:registry.json",
    ]);
    const sb = tree[1];
    expect(sb.type).toBe("folder");
    if (sb.type === "folder") {
      expect(sb.children).toEqual([
        { type: "doc", name: "notes.md", path: "switchboard/notes.md" },
      ]);
    }
  });

  it("nests deep paths and carries full relative paths on every node", () => {
    const tree = buildKbTree([
      "switchboard/features/personal-workstation/requirements.md",
      "switchboard/features/personal-workstation/wireframes/shell.html",
    ]);
    expect(tree).toHaveLength(1);
    const [sb] = tree;
    if (sb.type !== "folder") throw new Error("expected folder");
    expect(sb.path).toBe("switchboard");
    const features = sb.children[0];
    if (features.type !== "folder") throw new Error("expected folder");
    expect(features.path).toBe("switchboard/features");
    const pw = features.children[0];
    if (pw.type !== "folder") throw new Error("expected folder");
    expect(pw.path).toBe("switchboard/features/personal-workstation");
    // folders before docs at the same level
    expect(names(pw.children)).toEqual(["folder:wireframes", "doc:requirements.md"]);
  });

  it("defensively filters _ and . prefixed segments at ANY depth", () => {
    const tree = buildKbTree([
      "_templates/tpl.md",
      ".git/config.md",
      "proj/_drafts/x.md",
      "proj/.pins.json",
      "proj/doc.md",
    ]);
    expect(tree).toHaveLength(1);
    const [proj] = tree;
    if (proj.type !== "folder") throw new Error("expected folder");
    expect(proj.children).toEqual([{ type: "doc", name: "doc.md", path: "proj/doc.md" }]);
  });

  it("sorts folders first then docs, each alphabetically", () => {
    const tree = buildKbTree(["b.md", "a.md", "zz/x.md", "aa/y.md"]);
    expect(names(tree)).toEqual(["folder:aa", "folder:zz", "doc:a.md", "doc:b.md"]);
  });

  it("dedupes repeated paths and ignores empty segments", () => {
    const tree = buildKbTree(["proj//doc.md", "proj/doc.md", ""]);
    expect(tree).toHaveLength(1);
    const [proj] = tree;
    if (proj.type !== "folder") throw new Error("expected folder");
    expect(proj.children).toHaveLength(1);
  });
});

describe("ancestorFolders", () => {
  it("lists every folder that must expand to reveal the doc", () => {
    expect(ancestorFolders("a/b/c/doc.md")).toEqual(["a", "a/b", "a/b/c"]);
  });
  it("is empty for a root-level doc", () => {
    expect(ancestorFolders("README.md")).toEqual([]);
  });
});

describe("sameDocList", () => {
  it("equal content is same, order-sensitively", () => {
    expect(sameDocList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameDocList(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameDocList(["a"], ["a", "b"])).toBe(false);
    expect(sameDocList([], [])).toBe(true);
  });
});

describe("mergeDocRead (poll differ)", () => {
  const path = "proj/doc.md";

  it("first read produces fresh state", () => {
    const next = mergeDocRead(EMPTY_DOC_STATE, path, { ok: true, content: "# hi" });
    expect(next).toEqual({ path, content: "# hi", error: null });
  });

  it("unchanged content returns the PREVIOUS object reference (no re-render)", () => {
    const prev = mergeDocRead(EMPTY_DOC_STATE, path, { ok: true, content: "# hi" });
    const next = mergeDocRead(prev, path, { ok: true, content: "# hi" });
    expect(next).toBe(prev);
  });

  it("changed content swaps state", () => {
    const prev = mergeDocRead(EMPTY_DOC_STATE, path, { ok: true, content: "v1" });
    const next = mergeDocRead(prev, path, { ok: true, content: "v2" });
    expect(next).not.toBe(prev);
    expect(next.content).toBe("v2");
  });

  it("a doc switch replaces content even when bytes match a different path", () => {
    const prev = mergeDocRead(EMPTY_DOC_STATE, "other.md", { ok: true, content: "same" });
    const next = mergeDocRead(prev, path, { ok: true, content: "same" });
    expect(next).not.toBe(prev);
    expect(next.path).toBe(path);
  });

  it("read error keeps last good content of the SAME doc, surfaces the error", () => {
    const prev = mergeDocRead(EMPTY_DOC_STATE, path, { ok: true, content: "good" });
    const next = mergeDocRead(prev, path, { ok: false, error: "boom" });
    expect(next.content).toBe("good");
    expect(next.error).toBe("boom");
  });

  it("repeated identical error returns the previous reference", () => {
    const errored = mergeDocRead(EMPTY_DOC_STATE, path, { ok: false, error: "boom" });
    const again = mergeDocRead(errored, path, { ok: false, error: "boom" });
    expect(again).toBe(errored);
  });

  it("error for a DIFFERENT doc drops the stale content", () => {
    const prev = mergeDocRead(EMPTY_DOC_STATE, "other.md", { ok: true, content: "stale" });
    const next = mergeDocRead(prev, path, { ok: false, error: "boom" });
    expect(next.content).toBeNull();
    expect(next.error).toBe("boom");
  });

  it("recovery after an error swaps back to clean content", () => {
    const errored = mergeDocRead(EMPTY_DOC_STATE, path, { ok: false, error: "boom" });
    const next = mergeDocRead(errored, path, { ok: true, content: "back" });
    expect(next).toEqual({ path, content: "back", error: null });
  });
});

describe("docKind", () => {
  it("classifies every KB extension, case-insensitively", () => {
    expect(docKind("a/b/spec.md")).toBe("markdown");
    expect(docKind("a/SPEC.MD")).toBe("markdown");
    expect(docKind("wireframes/shell.html")).toBe("wireframe");
    expect(docKind("diagrams/flow.mmd")).toBe("diagram");
    expect(docKind("src/comp.tsx")).toBe("code");
    expect(docKind("src/comp.jsx")).toBe("code");
    expect(docKind("registry.json")).toBe("data");
    expect(docKind("Makefile")).toBe("unknown");
  });

  it("routes a kept view's .view.json suffix to \"view\", not \"data\" (SWIT-53)", () => {
    expect(docKind("_scratch/switchboard/trades-2026-09-20.view.json")).toBe("view");
    expect(docKind("_scratch/switchboard/trades-2026-09-20.VIEW.JSON")).toBe("view");
    // a plain .json (no .view. suffix) is still "data" — the ordinary case
    // is unchanged.
    expect(docKind("_scratch/switchboard/trades-2026-09-20.json")).toBe("data");
  });
});

describe("a KB-list miss refreshes the list ONCE (SWIT-101)", () => {
  beforeEach(() => {
    __resetKbCacheForTests();
    listDocs.mockReset();
  });

  it("rememberKbMiss: an address asks once; at the cap the memory starts over", () => {
    const remembered = new Set<string>();
    expect(rememberKbMiss(remembered, "a/b.md")).toBe(true);
    expect(rememberKbMiss(remembered, "a/b.md")).toBe(false);
    expect(rememberKbMiss(remembered, "c/d.md")).toBe(true);
    // A tiny cap: the third distinct address clears the memory first.
    const small = new Set<string>();
    expect(rememberKbMiss(small, "1", 2)).toBe(true);
    expect(rememberKbMiss(small, "2", 2)).toBe(true);
    expect(rememberKbMiss(small, "3", 2)).toBe(true);
    expect([...small]).toEqual(["3"]);
    expect(KB_MISS_CAP).toBeGreaterThanOrEqual(1000);
  });

  it("refreshDocList notifies subscribers only when the list actually changed", async () => {
    let notified = 0;
    const unsubscribe = subscribeDocList(() => (notified += 1));
    listDocs.mockResolvedValue(["a/one.md"]);
    const first = await refreshDocList();
    expect(notified).toBe(1);
    // Unchanged content: same reference, no notification.
    listDocs.mockResolvedValue(["a/one.md"]);
    expect(await refreshDocList()).toBe(first);
    expect(notified).toBe(1);
    listDocs.mockResolvedValue(["a/one.md", "a/two.md"]);
    await refreshDocList();
    expect(notified).toBe(2);
    unsubscribe();
    listDocs.mockResolvedValue([]);
    await refreshDocList();
    expect(notified).toBe(2);
  });

  it("RENDER: a paint's worth of new misses share ONE kb_list, and the same misses never ask again", async () => {
    listDocs.mockResolvedValue(["switchboard/notes.md"]);
    await refreshDocList(); // the list a page seeded itself with
    expect(listDocs).toHaveBeenCalledTimes(1);
    // The agent writes a doc; the page paints a row for it (and two repo paths).
    listDocs.mockResolvedValue(["switchboard/new-spec.md", "switchboard/notes.md"]);
    const paint = () => {
      const docs = getCachedDocList();
      return ["switchboard/new-spec.md", "src/App.tsx", "src/lib/kb.ts", "switchboard/notes.md"].map((a) =>
        resolveDocTarget(a, docs, "switchboard", noteKbMiss)
      );
    };
    // The stale paint: the new doc falls back to a repo file (the SWIT-101 bug).
    expect(paint()[0]).toEqual({ kind: "repo-file", project: "switchboard", path: "switchboard/new-spec.md" });
    let notified = 0;
    subscribeDocList(() => (notified += 1));
    await settle();
    // Three misses, ONE refresh — and the subscribed page is told.
    expect(listDocs).toHaveBeenCalledTimes(2);
    expect(notified).toBe(1);
    // The repaint: the doc is a KB doc; the repo paths miss AGAIN and ask for nothing.
    expect(paint()[0]).toEqual({ kind: "kb-doc", path: "switchboard/new-spec.md" });
    for (let i = 0; i < 20; i++) paint();
    await settle();
    expect(listDocs).toHaveBeenCalledTimes(2);
  });

  it("RENDER: a failed kb_list is not retried per paint (never a loop)", async () => {
    listDocs.mockResolvedValue([]);
    await refreshDocList();
    listDocs.mockRejectedValue(new Error("kb root missing"));
    for (let i = 0; i < 10; i++) {
      noteKbMiss("switchboard/x.md");
      await settle();
    }
    expect(listDocs).toHaveBeenCalledTimes(2); // the seed + the ONE failed refresh
  });

  it("ONE-SHOT: a miss against a cached list refreshes once and resolves again — even for an address already remembered", async () => {
    listDocs.mockResolvedValue(["switchboard/notes.md"]);
    await refreshDocList();
    // The address was seen BEFORE its file existed: remembered as a miss.
    noteKbMiss("switchboard/new-spec.md");
    await settle();
    expect(listDocs).toHaveBeenCalledTimes(2);
    // Now the file exists. A paint would not ask again…
    listDocs.mockResolvedValue(["switchboard/new-spec.md", "switchboard/notes.md"]);
    noteKbMiss("switchboard/new-spec.md");
    await settle();
    expect(listDocs).toHaveBeenCalledTimes(2);
    // …but an explicit open (a click, the turn-end hook, the agent's `show`) does.
    const runs: Array<readonly string[] | null> = [];
    const target = await resolveWithFreshKbDocs((docs, onKbMiss) => {
      runs.push(docs);
      return resolveDocTarget("switchboard/new-spec.md", docs, "lodestar", onKbMiss);
    });
    expect(target).toEqual({ kind: "kb-doc", path: "switchboard/new-spec.md" });
    expect(listDocs).toHaveBeenCalledTimes(3);
    expect(runs).toHaveLength(2);
    // A hit costs nothing.
    await resolveWithFreshKbDocs((docs, onKbMiss) => resolveDocTarget("switchboard/notes.md", docs, "lodestar", onKbMiss));
    expect(listDocs).toHaveBeenCalledTimes(3);
  });

  it("ONE-SHOT: a genuine repo path costs one kb_list and keeps its repo target; an unchanged list does not re-run", async () => {
    listDocs.mockResolvedValue(["switchboard/notes.md"]);
    await refreshDocList();
    let runs = 0;
    const target = await resolveWithFreshKbDocs((docs, onKbMiss) => {
      runs += 1;
      return resolveDocTarget("specs/sextant/gamma-metric-design.md", docs, "lodestar", onKbMiss);
    });
    expect(target).toEqual({ kind: "repo-file", project: "lodestar", path: "specs/sextant/gamma-metric-design.md" });
    expect(listDocs).toHaveBeenCalledTimes(2);
    expect(runs).toBe(1); // same list reference back → the first answer stands
  });

  it("ONE-SHOT: a COLD cache is loaded once — a miss against the list just read does not read it twice", async () => {
    listDocs.mockResolvedValue(["switchboard/notes.md"]);
    expect(getCachedDocList()).toBeNull();
    const target = await resolveWithFreshKbDocs((docs, onKbMiss) => resolveDocTarget("src/App.tsx", docs, "switchboard", onKbMiss));
    expect(target).toEqual({ kind: "repo-file", project: "switchboard", path: "src/App.tsx" });
    expect(listDocs).toHaveBeenCalledTimes(1);
  });

  it("ONE-SHOT: a failing kb_list degrades to the first answer, never a throw", async () => {
    listDocs.mockRejectedValue(new Error("kb root missing"));
    // Cold + failing: the list is unknown, the repo fallback still answers.
    await expect(
      resolveWithFreshKbDocs((docs, onKbMiss) => resolveDocTarget("src/App.tsx", docs, "switchboard", onKbMiss))
    ).resolves.toEqual({ kind: "repo-file", project: "switchboard", path: "src/App.tsx" });
    // Warm, then failing on the miss refresh.
    listDocs.mockResolvedValueOnce([]);
    await refreshDocList();
    await expect(
      resolveWithFreshKbDocs((docs, onKbMiss) => resolveDocTarget("switchboard/x.md", docs, null, onKbMiss))
    ).resolves.toBeNull();
  });
});
