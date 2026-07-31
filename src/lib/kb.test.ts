// KB data-layer tests (T6) — the PURE parts: tree building, list equality,
// the poll differ (mergeDocRead), doc-kind switch, ancestor expansion. The
// hooks are thin shells over these; IPC itself is Rust-tested (kb.rs).

import { describe, it, expect } from "vitest";
import {
  buildKbTree,
  ancestorFolders,
  sameDocList,
  mergeDocRead,
  docKind,
  EMPTY_DOC_STATE,
} from "./kb";
import type { KbNode } from "./kb";

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
});
