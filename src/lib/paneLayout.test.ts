import { describe, it, expect, beforeEach } from "vitest";
import {
  setPaneIdCounter,
  createSinglePane,
  splitPane,
  closePane,
  resizeSplit,
  findLeaf,
  findPaneBySessionId,
  getVisibleSessionIds,
  getAllLeafIds,
  findAdjacentPane,
  remapSessionIds,
  getMaxPaneIdNumber,
  type PaneLeaf,
  type PaneBranch,
} from "./paneLayout";

beforeEach(() => {
  setPaneIdCounter(0);
});

// ── createSinglePane ────────────────────────────────────────────

describe("createSinglePane", () => {
  it("returns a leaf with the correct sessionId and auto-generated id", () => {
    const pane = createSinglePane("s1");
    expect(pane).toEqual({ type: "leaf", id: "pane-1", sessionId: "s1" });
  });

  it("sequential calls produce unique IDs", () => {
    const a = createSinglePane("s1");
    const b = createSinglePane("s2");
    expect(a.id).toBe("pane-1");
    expect(b.id).toBe("pane-2");
    expect(a.id).not.toBe(b.id);
  });
});

// ── splitPane ───────────────────────────────────────────────────

describe("splitPane", () => {
  it("splits a single leaf into a branch with two children at 50/50", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: newRoot, newPaneId } = splitPane(root, "pane-1", "horizontal", "s2");

    expect(newRoot.type).toBe("branch");
    const branch = newRoot as PaneBranch;
    expect(branch.direction).toBe("horizontal");
    expect(branch.ratio).toBe(0.5);
    expect(branch.first).toEqual({ type: "leaf", id: "pane-1", sessionId: "s1" });
    expect(branch.second).toEqual({ type: "leaf", id: "pane-2", sessionId: "s2" });
    expect(newPaneId).toBe("pane-2");
  });

  it("split vertical produces correct direction", () => {
    const root = createSinglePane("s1");
    const { root: newRoot } = splitPane(root, "pane-1", "vertical", "s2");
    expect((newRoot as PaneBranch).direction).toBe("vertical");
  });

  it("returns original tree when target not found", () => {
    const root = createSinglePane("s1");
    const { root: newRoot } = splitPane(root, "nonexistent", "horizontal", "s2");
    expect(newRoot).toBe(root);
  });

  it("splits a deeply nested leaf correctly", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: r2 } = splitPane(root, "pane-1", "horizontal", "s2"); // pane-2 new leaf, pane-3 branch
    // r2 is a branch with first=pane-1, second=pane-2
    const { root: r3 } = splitPane(r2, "pane-2", "vertical", "s3"); // pane-4 new leaf, pane-5 branch
    // r2.second (pane-2) should now be a branch
    expect(r3.type).toBe("branch");
    const outerBranch = r3 as PaneBranch;
    expect(outerBranch.second.type).toBe("branch");
    const innerBranch = outerBranch.second as PaneBranch;
    expect(innerBranch.direction).toBe("vertical");
    expect((innerBranch.first as PaneLeaf).sessionId).toBe("s2");
    expect((innerBranch.second as PaneLeaf).sessionId).toBe("s3");
  });

  it("two successive splits produce 3 panes", () => {
    const root = createSinglePane("s1");
    const { root: r2 } = splitPane(root, "pane-1", "horizontal", "s2");
    const { root: r3 } = splitPane(r2, "pane-1", "vertical", "s3");
    const ids = getVisibleSessionIds(r3);
    expect(ids).toHaveLength(3);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).toContain("s3");
  });
});

// ── closePane ───────────────────────────────────────────────────

describe("closePane", () => {
  it("close only pane returns null", () => {
    const root = createSinglePane("s1");
    expect(closePane(root, "pane-1")).toBeNull();
  });

  it("close first of two returns second", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: tree } = splitPane(root, "pane-1", "horizontal", "s2"); // pane-2 leaf, pane-3 branch
    const result = closePane(tree, "pane-1");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("leaf");
    expect((result as PaneLeaf).sessionId).toBe("s2");
  });

  it("close second of two returns first", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: tree, newPaneId } = splitPane(root, "pane-1", "horizontal", "s2");
    const result = closePane(tree, newPaneId);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("leaf");
    expect((result as PaneLeaf).sessionId).toBe("s1");
  });

  it("close in 3-pane tree unwraps correctly", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: r2 } = splitPane(root, "pane-1", "horizontal", "s2"); // pane-2 leaf, pane-3 branch
    const { root: r3, newPaneId } = splitPane(r2, "pane-2", "vertical", "s3"); // pane-4 leaf, pane-5 branch
    // Close the innermost new pane
    const result = closePane(r3, newPaneId);
    expect(result).not.toBeNull();
    const ids = getVisibleSessionIds(result!);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
  });

  it("target not found returns tree unchanged", () => {
    const root = createSinglePane("s1");
    const result = closePane(root, "nonexistent");
    expect(result).toBe(root);
  });
});

// ── resizeSplit ─────────────────────────────────────────────────

describe("resizeSplit", () => {
  function makeBranch(): { tree: PaneBranch; branchId: string } {
    const root = createSinglePane("s1"); // pane-1
    const { root: tree } = splitPane(root, "pane-1", "horizontal", "s2"); // pane-2 leaf, pane-3 branch
    return { tree: tree as PaneBranch, branchId: (tree as PaneBranch).id };
  }

  it("updates ratio to 0.3", () => {
    const { tree, branchId } = makeBranch();
    const result = resizeSplit(tree, branchId, 0.3) as PaneBranch;
    expect(result.ratio).toBe(0.3);
  });

  it("updates ratio to 0.7", () => {
    const { tree, branchId } = makeBranch();
    const result = resizeSplit(tree, branchId, 0.7) as PaneBranch;
    expect(result.ratio).toBe(0.7);
  });

  it("clamps below minimum (0.05 → 0.15)", () => {
    const { tree, branchId } = makeBranch();
    const result = resizeSplit(tree, branchId, 0.05) as PaneBranch;
    expect(result.ratio).toBe(0.15);
  });

  it("clamps above maximum (0.95 → 0.85)", () => {
    const { tree, branchId } = makeBranch();
    const result = resizeSplit(tree, branchId, 0.95) as PaneBranch;
    expect(result.ratio).toBe(0.85);
  });

  it("boundary value 0.15 passes through", () => {
    const { tree, branchId } = makeBranch();
    const result = resizeSplit(tree, branchId, 0.15) as PaneBranch;
    expect(result.ratio).toBe(0.15);
  });

  it("boundary value 0.85 passes through", () => {
    const { tree, branchId } = makeBranch();
    const result = resizeSplit(tree, branchId, 0.85) as PaneBranch;
    expect(result.ratio).toBe(0.85);
  });

  it("target branch not found returns tree unchanged", () => {
    const { tree } = makeBranch();
    const result = resizeSplit(tree, "nonexistent", 0.3);
    expect(result).toBe(tree);
  });
});

// ── findLeaf / findPaneBySessionId ──────────────────────────────

describe("findLeaf", () => {
  it("found in root leaf", () => {
    const root = createSinglePane("s1"); // pane-1
    expect(findLeaf(root, "pane-1")).toBe(root);
  });

  it("found in nested tree", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: tree, newPaneId } = splitPane(root, "pane-1", "horizontal", "s2");
    const found = findLeaf(tree, newPaneId);
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe("s2");
  });

  it("not found returns null", () => {
    const root = createSinglePane("s1");
    expect(findLeaf(root, "nonexistent")).toBeNull();
  });
});

describe("findPaneBySessionId", () => {
  it("found in root leaf", () => {
    const root = createSinglePane("s1");
    expect(findPaneBySessionId(root, "s1")).toBe(root);
  });

  it("found in nested tree", () => {
    const root = createSinglePane("s1");
    const { root: tree } = splitPane(root, "pane-1", "horizontal", "s2");
    const found = findPaneBySessionId(tree, "s2");
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe("s2");
  });

  it("not found returns null", () => {
    const root = createSinglePane("s1");
    expect(findPaneBySessionId(root, "nonexistent")).toBeNull();
  });
});

// ── getVisibleSessionIds / getAllLeafIds ─────────────────────────

describe("getVisibleSessionIds", () => {
  it("single pane returns one ID", () => {
    const root = createSinglePane("s1");
    expect(getVisibleSessionIds(root)).toEqual(["s1"]);
  });

  it("multi-pane returns all IDs in pre-order", () => {
    const root = createSinglePane("s1");
    const { root: tree } = splitPane(root, "pane-1", "horizontal", "s2");
    expect(getVisibleSessionIds(tree)).toEqual(["s1", "s2"]);
  });
});

describe("getAllLeafIds", () => {
  it("single pane returns one ID", () => {
    const root = createSinglePane("s1");
    expect(getAllLeafIds(root)).toEqual(["pane-1"]);
  });

  it("multi-pane returns all leaf IDs in pre-order", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: tree } = splitPane(root, "pane-1", "horizontal", "s2"); // pane-2 leaf
    expect(getAllLeafIds(tree)).toEqual(["pane-1", "pane-2"]);
  });
});

// ── findAdjacentPane ────────────────────────────────────────────

describe("findAdjacentPane", () => {
  it("two panes: left from right returns left", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: tree, newPaneId } = splitPane(root, "pane-1", "horizontal", "s2"); // pane-2
    expect(findAdjacentPane(tree, newPaneId, "left")).toBe("pane-1");
  });

  it("two panes: right from left returns right", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: tree, newPaneId } = splitPane(root, "pane-1", "horizontal", "s2");
    expect(findAdjacentPane(tree, "pane-1", "right")).toBe(newPaneId);
  });

  it("single pane returns null", () => {
    const root = createSinglePane("s1");
    expect(findAdjacentPane(root, "pane-1", "left")).toBeNull();
    expect(findAdjacentPane(root, "pane-1", "right")).toBeNull();
  });

  it("three panes: middle can go both directions", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: r2 } = splitPane(root, "pane-1", "horizontal", "s2"); // pane-2 leaf, pane-3 branch
    const { root: r3 } = splitPane(r2, "pane-1", "vertical", "s3"); // pane-4 leaf, pane-5 branch
    // Tree: branch(branch(pane-1, pane-4), pane-2)
    // Pre-order leaves: pane-1, pane-4, pane-2
    const allLeaves = getAllLeafIds(r3);
    const middleId = allLeaves[1]; // pane-4
    expect(findAdjacentPane(r3, middleId, "left")).toBe(allLeaves[0]);
    expect(findAdjacentPane(r3, middleId, "right")).toBe(allLeaves[2]);
  });

  it("edge pane going further out returns null", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: tree } = splitPane(root, "pane-1", "horizontal", "s2"); // pane-2
    expect(findAdjacentPane(tree, "pane-1", "left")).toBeNull();
    expect(findAdjacentPane(tree, "pane-2", "right")).toBeNull();
  });
});

// ── remapSessionIds ─────────────────────────────────────────────

describe("remapSessionIds", () => {
  it("full remap: all sessions updated", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: tree } = splitPane(root, "pane-1", "horizontal", "s2");
    const mapped = remapSessionIds(tree, new Map([["s1", "x1"], ["s2", "x2"]]));
    expect(getVisibleSessionIds(mapped)).toEqual(["x1", "x2"]);
  });

  it("partial remap: unmapped sessions unchanged", () => {
    const root = createSinglePane("s1");
    const { root: tree } = splitPane(root, "pane-1", "horizontal", "s2");
    const mapped = remapSessionIds(tree, new Map([["s1", "x1"]]));
    expect(getVisibleSessionIds(mapped)).toEqual(["x1", "s2"]);
  });

  it("empty map: tree unchanged", () => {
    const root = createSinglePane("s1");
    const mapped = remapSessionIds(root, new Map());
    expect(mapped).toBe(root);
  });
});

// ── getMaxPaneIdNumber ──────────────────────────────────────────

describe("getMaxPaneIdNumber", () => {
  it("single pane extracts number", () => {
    const root = createSinglePane("s1"); // pane-1
    expect(getMaxPaneIdNumber(root)).toBe(1);
  });

  it("multi-pane returns max", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: tree } = splitPane(root, "pane-1", "horizontal", "s2"); // pane-2 leaf, pane-3 branch
    expect(getMaxPaneIdNumber(tree)).toBe(3);
  });

  it("includes branch IDs in scan", () => {
    const root = createSinglePane("s1"); // pane-1
    const { root: r2 } = splitPane(root, "pane-1", "horizontal", "s2"); // pane-2, pane-3
    const { root: r3 } = splitPane(r2, "pane-2", "vertical", "s3"); // pane-4, pane-5
    expect(getMaxPaneIdNumber(r3)).toBe(5);
  });
});

// ── Immutability ────────────────────────────────────────────────

describe("immutability", () => {
  it("splitPane does not mutate original tree", () => {
    const root = createSinglePane("s1");
    const rootCopy = { ...root };
    splitPane(root, "pane-1", "horizontal", "s2");
    expect(root).toEqual(rootCopy);
  });

  it("closePane does not mutate original tree", () => {
    const root = createSinglePane("s1");
    const { root: tree } = splitPane(root, "pane-1", "horizontal", "s2");
    const treeCopy = JSON.parse(JSON.stringify(tree));
    closePane(tree, "pane-2");
    expect(tree).toEqual(treeCopy);
  });

  it("resizeSplit does not mutate original tree", () => {
    const root = createSinglePane("s1");
    const { root: tree } = splitPane(root, "pane-1", "horizontal", "s2");
    const branchId = (tree as PaneBranch).id;
    const treeCopy = JSON.parse(JSON.stringify(tree));
    resizeSplit(tree, branchId, 0.3);
    expect(tree).toEqual(treeCopy);
  });
});
