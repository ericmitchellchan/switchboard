// SETS (SWIT-79, Ky's set tabs): the pure fold / split / position rules and
// the agent's sets.json parse.

import { describe, it, expect } from "vitest";
import type { Artifact, PanelState } from "../types";
import {
  SET_ITEM_CAP,
  FOLDABLE_KINDS,
  isFoldableKind,
  setNounFor,
  setLabelFor,
  tabsOfKind,
  foldableCount,
  foldPlan,
  unfoldPlan,
  setPosition,
  stepPosition,
  flattenArtifacts,
  parseSetsFile,
  setArtifactFor,
} from "./artifactSets";

const page: Artifact = { kind: "page", threadId: "th1" };
const v = (id: string): Artifact => ({ kind: "view", threadId: "th1", viewId: id });
const doc = (p: string): Artifact => ({ kind: "kb-doc", path: p });

describe("what folds", () => {
  it("names the foldable kinds — never the page, a session, a question or a set", () => {
    expect([...FOLDABLE_KINDS].sort()).toEqual(["kb-doc", "localhost", "repo-file", "surface", "view"]);
    expect(isFoldableKind("page")).toBe(false);
    expect(isFoldableKind("session")).toBe(false);
    expect(isFoldableKind("set")).toBe(false);
    expect(isFoldableKind("view")).toBe(true);
  });

  it("captions a fold in plain words by kind and count", () => {
    expect(setNounFor("view", 1)).toBe("view");
    expect(setNounFor("view", 3)).toBe("views");
    expect(setNounFor("kb-doc", 2)).toBe("docs");
    expect(setNounFor("surface", 2)).toBe("pages");
    expect(setLabelFor([v("a"), v("b"), v("c")])).toBe("3 views");
    expect(setLabelFor([doc("a.md"), doc("b.md")])).toBe("2 docs");
  });

  it("collects the strip's tabs of one kind with their indices, never sets or sessions", () => {
    const set: Artifact = { kind: "set", label: "x", items: [v("z")] };
    const tabs = tabsOfKind([page, v("a"), doc("d.md"), set, v("b")], "view");
    expect(tabs.map((t) => t.index)).toEqual([1, 4]);
    expect(tabs.map((t) => (t.artifact as { viewId: string }).viewId)).toEqual(["a", "b"]);
    expect(tabsOfKind([{ kind: "session", sessionId: "s" }], "session")).toEqual([]);
  });

  it("foldableCount is the header's `⧉ N`: ≥2 of the ACTIVE tab's kind, else 0", () => {
    expect(foldableCount(null)).toBe(0);
    expect(foldableCount({ artifacts: [page, v("a"), v("b")], activeIndex: 1 })).toBe(2);
    expect(foldableCount({ artifacts: [page, v("a"), v("b")], activeIndex: 0 })).toBe(0);
    expect(foldableCount({ artifacts: [page, v("a"), doc("d.md")], activeIndex: 1 })).toBe(0);
  });
});

describe("foldPlan / unfoldPlan", () => {
  const strip: PanelState = { artifacts: [page, v("a"), doc("d.md"), v("b"), v("c")], activeIndex: 3 };

  it("folds every tab of the active kind into ONE set in the first one's slot, landing on the item that was active", () => {
    const plan = foldPlan(strip)!;
    expect(plan).not.toBeNull();
    expect(plan.next.artifacts.map((a) => a.kind)).toEqual(["page", "set", "kb-doc"]);
    expect(plan.next.activeIndex).toBe(1);
    expect(plan.set.label).toBe("3 views");
    expect(plan.set.items.map((a) => (a as { viewId: string }).viewId)).toEqual(["a", "b", "c"]);
    expect(plan.showing).toBe(1); // v("b") was active
  });

  it("refuses with fewer than two of the kind, or a non-foldable active tab", () => {
    expect(foldPlan({ artifacts: [page, v("a"), doc("d.md")], activeIndex: 1 })).toBeNull();
    expect(foldPlan({ artifacts: [page, v("a"), v("b")], activeIndex: 0 })).toBeNull();
    const set: Artifact = { kind: "set", label: "x", items: [v("a"), v("b")] };
    expect(foldPlan({ artifacts: [page, set], activeIndex: 1 })).toBeNull();
  });

  it("splits a set back into its items in place, the showing item active; a non-set index is refused", () => {
    const plan = foldPlan(strip)!;
    const back = unfoldPlan(plan.next, 1, 2)!;
    expect(back.artifacts.map((a) => (a.kind === "view" ? a.viewId : a.kind))).toEqual(["page", "a", "b", "c", "kb-doc"]);
    expect(back.activeIndex).toBe(3); // index 1 + showing 2
    expect(unfoldPlan(plan.next, 0, 0)).toBeNull();
    expect(unfoldPlan(plan.next, 9, 0)).toBeNull();
  });

  it("a fold then a split round-trips the strip's content (nothing is lost)", () => {
    const plan = foldPlan(strip)!;
    const back = unfoldPlan(plan.next, 1, plan.showing)!;
    expect(back.artifacts.map((a) => JSON.stringify(a)).sort()).toEqual(strip.artifacts.map((a) => JSON.stringify(a)).sort());
    expect(back.artifacts[back.activeIndex]).toEqual(strip.artifacts[strip.activeIndex]);
  });
});

describe("positions", () => {
  it("clamps a stored position into the membership; junk is 0", () => {
    expect(setPosition(undefined, 3)).toBe(0);
    expect(setPosition(2, 3)).toBe(2);
    expect(setPosition(9, 3)).toBe(2);
    expect(setPosition(-1, 3)).toBe(0);
    expect(setPosition(1.7, 3)).toBe(1);
    expect(setPosition(NaN, 3)).toBe(0);
    expect(setPosition(4, 0)).toBe(0);
  });

  it("steps wrap around (← from the first lands on the last)", () => {
    expect(stepPosition(0, -1, 3)).toBe(2);
    expect(stepPosition(2, 1, 3)).toBe(0);
    expect(stepPosition(1, 1, 3)).toBe(2);
    expect(stepPosition(0, 1, 0)).toBe(0);
  });

  it("flattens sets to their members for 'is it open anywhere' walks", () => {
    const set: Artifact = { kind: "set", label: "x", items: [v("a"), v("b")] };
    expect(flattenArtifacts([page, set, doc("d.md")]).map((a) => a.kind)).toEqual(["page", "view", "view", "kb-doc"]);
  });
});

describe("sets.json (the agent's sets)", () => {
  it("parses the server's shape newest-first and tolerates junk", () => {
    const raw = JSON.stringify({
      version: 1,
      sets: [
        { id: "s2", label: "gamma", ids: ["v1", "v2"], builtAt: "2026-09-08T10:00:00Z" },
        { id: "s1", label: "", ids: ["v3", "v3", "bad id!", 7], builtAt: "2026-09-08T09:00:00Z" },
        { id: "s0", ids: [] },
        { id: "s2", ids: ["v9"] },
        "junk",
        { ids: ["v1"] },
      ],
    });
    const sets = parseSetsFile(raw);
    expect(sets.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(sets[0]).toEqual({ id: "s2", label: "gamma", ids: ["v1", "v2"], builtAt: "2026-09-08T10:00:00Z" });
    // An empty label falls back to a count caption; bad member ids drop alone.
    expect(sets[1].label).toBe("1 view");
    expect(sets[1].ids).toEqual(["v3"]);
    expect(parseSetsFile("")).toEqual([]);
    expect(parseSetsFile("{not json")).toEqual([]);
    expect(parseSetsFile("[]")).toEqual([]);
    expect(parseSetsFile(JSON.stringify({ sets: "x" }))).toEqual([]);
  });

  it("caps the membership at SET_ITEM_CAP", () => {
    const ids = Array.from({ length: SET_ITEM_CAP + 5 }, (_, i) => `v${i}`);
    expect(parseSetsFile(JSON.stringify({ sets: [{ id: "s1", ids }] }))[0].ids).toHaveLength(SET_ITEM_CAP);
  });

  it("becomes ONE set artifact of view artifacts for the thread", () => {
    const set = setArtifactFor("th1", { id: "s1", label: "gamma", ids: ["v1", "v2"], builtAt: "" });
    expect(set).toEqual({
      kind: "set",
      label: "gamma",
      items: [
        { kind: "view", threadId: "th1", viewId: "v1" },
        { kind: "view", threadId: "th1", viewId: "v2" },
      ],
    });
  });
});
