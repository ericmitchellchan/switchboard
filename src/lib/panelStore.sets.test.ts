// SETS in the panel store (SWIT-79): the load gate (flatten, no sessions,
// dedupe, cap), identity = membership, the fold/split store ops with the
// per-set position, `focus: false`, showingArtifact, activatePageTab — and
// the default width that keeps 100 columns.

import { describe, it, expect, beforeEach } from "vitest";
import type { Artifact } from "../types";
import {
  __resetPanelStoreForTests,
  sanitizeArtifact,
  artifactIdentity,
  artifactShortTitle,
  describeArtifact,
  openInPanel,
  panelStateFor,
  activateArtifact,
  foldActiveKind,
  unfoldSetAt,
  setPositionFor,
  setSetPosition,
  showingArtifact,
  activatePageTab,
  togglePanel,
  previewIdentityFor,
  isLocalhostUrlOpen,
  setPanelThreadResolver,
  ensurePageTab,
  inheritPanel,
  artifactFor,
  setPoppedOutArtifact,
  getPoppedOutArtifact,
  defaultPanelWidth,
  effectivePanelWidth,
  isDefaultPanelWidth,
  DEFAULT_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  DIVIDER_WIDTH,
  TERMINAL_COLS,
  TERMINAL_GUTTER,
} from "./panelStore";
import { SET_ITEM_CAP } from "./artifactSets";

const v = (id: string): Artifact => ({ kind: "view", threadId: "th1", viewId: id });
const doc = (p: string): Artifact => ({ kind: "kb-doc", path: p });

beforeEach(() => {
  __resetPanelStoreForTests();
  setPanelThreadResolver((s) => (s === "tab1" ? "th1" : null));
});

describe("the load gate", () => {
  it("keeps a set lean: members through the gate, junk dropped, label capped", () => {
    const raw = {
      kind: "set",
      label: "  three views  ",
      items: [v("a"), { kind: "view", threadId: "th1" }, "junk", v("b")],
      extra: 1,
    };
    expect(sanitizeArtifact(raw)).toEqual({ kind: "set", label: "three views", items: [v("a"), v("b")] });
  });

  it("FLATTENS a nested set, drops sessions, collapses duplicates by identity", () => {
    const nested = { kind: "set", label: "inner", items: [v("b"), v("c"), { kind: "session", sessionId: "s1" }] };
    const raw = { kind: "set", label: "outer", items: [v("a"), nested, v("b"), { kind: "session", sessionId: "s2" }] };
    const clean = sanitizeArtifact(raw)!;
    expect(clean.kind).toBe("set");
    expect((clean as { items: Artifact[] }).items).toEqual([v("a"), v("b"), v("c")]);
  });

  it("caps the membership and refuses an empty set; a missing label gets a count caption", () => {
    const many = { kind: "set", items: Array.from({ length: SET_ITEM_CAP + 3 }, (_, i) => v(`v${i}`)) };
    const clean = sanitizeArtifact(many) as Extract<Artifact, { kind: "set" }>;
    expect(clean.items).toHaveLength(SET_ITEM_CAP);
    expect(clean.label).toBe(`${SET_ITEM_CAP} items`);
    expect(sanitizeArtifact({ kind: "set", label: "x", items: [] })).toBeNull();
    expect(sanitizeArtifact({ kind: "set", label: "x", items: [{ kind: "session", sessionId: "s" }] })).toBeNull();
    expect(sanitizeArtifact({ kind: "set", label: "x" })).toBeNull();
  });
});

describe("identity is membership", () => {
  it("sorts the member identities; the label is a caption, not a key", () => {
    const a: Artifact = { kind: "set", label: "one", items: [v("a"), v("b")] };
    const b: Artifact = { kind: "set", label: "other", items: [v("b"), v("a")] };
    const c: Artifact = { kind: "set", label: "one", items: [v("a"), v("c")] };
    expect(artifactIdentity(a)).toBe(artifactIdentity(b));
    expect(artifactIdentity(a)).not.toBe(artifactIdentity(c));
    expect(artifactIdentity(a)).toBe("set:[view:th1:a|view:th1:b]");
  });

  it("prints the fold mark + caption on the tab and `set / label` in the header", () => {
    const a: Artifact = { kind: "set", label: "3 views", items: [v("a"), v("b"), v("c")] };
    expect(artifactShortTitle(a)).toBe("⧉ 3 views");
    expect(describeArtifact(a).title).toBe("set / 3 views");
    expect(describeArtifact(a).crumbs.map((c) => c.text)).toEqual(["set", "3 views"]);
  });

  it("dedupes an opened set against one already in the strip", () => {
    openInPanel("tab1", { kind: "set", label: "x", items: [v("a"), v("b")] });
    openInPanel("tab1", { kind: "set", label: "y", items: [v("b"), v("a")] });
    expect(panelStateFor("tab1")!.artifacts).toHaveLength(1);
  });
});

describe("fold / split in the store", () => {
  function strip(): void {
    ensurePageTab("tab1");
    openInPanel("tab1", v("a"));
    openInPanel("tab1", doc("d.md"));
    openInPanel("tab1", v("b"));
    openInPanel("tab1", v("c"), { preview: true });
    activateArtifact("tab1", 3); // v("b")
  }

  it("folds the active kind into one set, positioned on the item that was active", () => {
    strip();
    expect(foldActiveKind("tab1")).toBe(true);
    const state = panelStateFor("tab1")!;
    expect(state.artifacts.map((a) => a.kind)).toEqual(["page", "set", "kb-doc"]);
    expect(state.activeIndex).toBe(1);
    const set = state.artifacts[1] as Extract<Artifact, { kind: "set" }>;
    expect(setPositionFor(set)).toBe(1);
    expect(showingArtifact(set)).toEqual(v("b"));
    // The folded preview's mark is gone — a member of a set is not a glance.
    expect(previewIdentityFor("tab1")).toBe("");
  });

  it("refuses when there is nothing to fold", () => {
    ensurePageTab("tab1");
    openInPanel("tab1", v("a"));
    expect(foldActiveKind("tab1")).toBe(false);
    expect(foldActiveKind("nope")).toBe(false);
  });

  it("steps the position (clamped) and splits back to tabs with the showing item active", () => {
    strip();
    foldActiveKind("tab1");
    const set = panelStateFor("tab1")!.artifacts[1] as Extract<Artifact, { kind: "set" }>;
    setSetPosition(set, 2);
    expect(setPositionFor(set)).toBe(2);
    setSetPosition(set, 99);
    expect(setPositionFor(set)).toBe(2);
    expect(unfoldSetAt("tab1", 1)).toBe(true);
    const state = panelStateFor("tab1")!;
    expect(state.artifacts.map((a) => (a.kind === "view" ? a.viewId : a.kind))).toEqual(["page", "a", "b", "c", "kb-doc"]);
    expect(state.activeIndex).toBe(3);
    expect(unfoldSetAt("tab1", 0)).toBe(false);
  });

  it("a set never floats, inherits as its showing member, and counts its members as open", () => {
    const set: Artifact = { kind: "set", label: "x", items: [{ kind: "localhost", project: "p", url: "http://localhost:5173" }, doc("d.md")] };
    openInPanel("tab1", set);
    setPoppedOutArtifact("tab1", set);
    expect(getPoppedOutArtifact()).toBeNull();
    expect(isLocalhostUrlOpen("http://127.0.0.1:5173")).toBe(true);
    setPanelThreadResolver((s) => (s === "tab1" ? "th1" : s === "tab2" ? "th2" : null));
    expect(inheritPanel(set, "tab2")).toBe(true);
    expect(artifactFor("tab2")).toEqual({ kind: "localhost", project: "p", url: "http://localhost:5173" });
  });
});

describe("focus: false (open behind)", () => {
  it("appends without stealing the active tab, and replaces the preview without stealing it", () => {
    ensurePageTab("tab1");
    openInPanel("tab1", doc("spec.md"), { preview: true, focus: false });
    let state = panelStateFor("tab1")!;
    expect(state.artifacts.map((a) => a.kind)).toEqual(["page", "kb-doc"]);
    expect(state.activeIndex).toBe(0);
    expect(previewIdentityFor("tab1")).toBe(artifactIdentity(doc("spec.md")));
    openInPanel("tab1", doc("other.md"), { preview: true, focus: false });
    state = panelStateFor("tab1")!;
    expect(state.artifacts.map((a) => (a.kind === "kb-doc" ? a.path : a.kind))).toEqual(["page", "other.md"]);
    expect(state.activeIndex).toBe(0);
  });

  it("the default still focuses", () => {
    ensurePageTab("tab1");
    openInPanel("tab1", doc("spec.md"), { preview: true });
    expect(panelStateFor("tab1")!.activeIndex).toBe(1);
  });
});

describe("activatePageTab", () => {
  it("brings the page tab to the front, restoring a hidden strip first", () => {
    ensurePageTab("tab1");
    openInPanel("tab1", doc("spec.md"));
    expect(panelStateFor("tab1")!.activeIndex).toBe(1);
    expect(activatePageTab("tab1")).toBe(true);
    expect(panelStateFor("tab1")!.activeIndex).toBe(0);
    activateArtifact("tab1", 1);
    togglePanel("tab1");
    expect(panelStateFor("tab1")).toBeNull();
    expect(activatePageTab("tab1")).toBe(true);
    expect(panelStateFor("tab1")!.activeIndex).toBe(0);
    expect(activatePageTab("nope")).toBe(false);
  });
});

describe("the default width keeps 100 columns", () => {
  it("is the widest panel leaving TERMINAL_COLS at the cell width, clamped", () => {
    const cell = 7.2;
    const need = Math.ceil(TERMINAL_COLS * cell) + TERMINAL_GUTTER;
    expect(defaultPanelWidth(1600, cell)).toBe(1600 - DIVIDER_WIDTH - need);
    expect(defaultPanelWidth(3000, cell)).toBe(MAX_PANEL_WIDTH);
    // A window that cannot afford 100 columns: the floor wins and the grid
    // starts narrower (the visible scrollbar is the fallback).
    expect(defaultPanelWidth(900, cell)).toBe(MIN_PANEL_WIDTH);
  });

  it("falls back to the constant when unmeasured", () => {
    expect(defaultPanelWidth(0, 7)).toBe(DEFAULT_PANEL_WIDTH);
    expect(defaultPanelWidth(NaN, 7)).toBe(DEFAULT_PANEL_WIDTH);
    expect(defaultPanelWidth(1600, null)).toBe(DEFAULT_PANEL_WIDTH);
    expect(defaultPanelWidth(1600, 0)).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("applies ONLY while the stored width is the untouched default — a dragged width is the user's", () => {
    expect(isDefaultPanelWidth(DEFAULT_PANEL_WIDTH)).toBe(true);
    expect(isDefaultPanelWidth(500)).toBe(false);
    expect(effectivePanelWidth(DEFAULT_PANEL_WIDTH, 1600, 7.2)).toBe(defaultPanelWidth(1600, 7.2));
    expect(effectivePanelWidth(500, 1600, 7.2)).toBe(500);
  });
});
