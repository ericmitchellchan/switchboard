// evidenceModel (SWIT-66): kind inference, fixed-group folding, the scanned-
// row merge precedence (agent wins), and the doc/file link rule.

import { describe, expect, it } from "vitest";
import {
  evidenceKindOf,
  groupEvidence,
  isPathShaped,
  latchViewKey,
  mergeScannedEvidence,
  mergeViewEvidence,
  resolveDocTarget,
  viewAddress,
  viewIdOfAddress,
  viewAnchorOfAddress,
  RECENT_CAP,
  SCANNED_STATUS,
} from "./evidenceModel";
import type { ScannedEvidence } from "./evidenceModel";
import type { PageEvidence } from "./pageStore";

const row = (address: string, over: Partial<PageEvidence> = {}): PageEvidence => ({
  address,
  label: over.label ?? "",
  status: over.status ?? null,
  updatedAt: over.updatedAt ?? "",
});

describe("evidenceKindOf", () => {
  it("classifies ticket keys", () => {
    expect(evidenceKindOf("SWIT-64")).toBe("ticket");
    expect(evidenceKindOf("CAD-1234")).toBe("ticket");
  });

  it("rejects ticket lookalikes", () => {
    expect(evidenceKindOf("swit-64")).toBe("other"); // lowercase
    expect(evidenceKindOf("SWIT-64 open")).toBe("other"); // not the whole address
    expect(evidenceKindOf("X-1")).toBe("other"); // one-letter project
  });

  it("classifies GitHub PR URLs, scheme optional", () => {
    expect(evidenceKindOf("https://github.com/ericmitchellchan/switchboard/pull/61")).toBe("pr");
    expect(evidenceKindOf("github.com/o/r/pull/7")).toBe("pr");
    expect(evidenceKindOf("https://github.com/o/r/issues/7")).toBe("other");
  });

  it("classifies surface addresses and decisions by prefix", () => {
    expect(evidenceKindOf("surface:lodestar/trading?instrument=NQ")).toBe("page");
    expect(evidenceKindOf("decision:q1")).toBe("decision");
  });

  it("classifies .md paths as doc, other paths as file", () => {
    expect(evidenceKindOf("switchboard/features/notes.md")).toBe("doc");
    expect(evidenceKindOf("README.md")).toBe("doc");
    expect(evidenceKindOf("src/lib/pageStore.ts")).toBe("file");
    expect(evidenceKindOf("Cargo.toml")).toBe("file"); // extension, no slash
  });

  it("prose and bad paths are other", () => {
    expect(evidenceKindOf("the tennis exporter")).toBe("other");
    expect(evidenceKindOf("refactor")).toBe("other"); // bare word, no extension
    expect(evidenceKindOf("../etc/passwd.md")).toBe("other"); // .. segment
    expect(evidenceKindOf("switchboard #61")).toBe("other");
  });
});

describe("isPathShaped", () => {
  it("holds the tight charset", () => {
    expect(isPathShaped("src/lib/a-b_c.d.ts")).toBe(true);
    expect(isPathShaped("a//b")).toBe(false); // empty segment
    expect(isPathShaped("a/../b")).toBe(false);
    expect(isPathShaped("a/b c")).toBe(false); // space
  });
});

describe("groupEvidence", () => {
  it("returns nothing for no rows", () => {
    expect(groupEvidence([])).toEqual([]);
  });

  it("folds rows into ordered kind groups with counts, empty groups dropped", () => {
    const rows = [
      row("SWIT-64"),
      row("https://github.com/o/r/pull/1"),
      row("src/lib/pageStore.ts"),
      row("notes.md"),
      row("SWIT-65"),
    ];
    const groups = groupEvidence(rows);
    expect(groups.map((g) => g.id)).toEqual(["recent", "tickets", "prs", "docs", "files"]);
    expect(groups[0].count).toBe(5); // recent holds all 5 (< cap)
    expect(groups.find((g) => g.id === "tickets")?.count).toBe(2);
    expect(groups.find((g) => g.id === "tickets")?.rows.map((r) => r.address)).toEqual([
      "SWIT-64",
      "SWIT-65",
    ]);
  });

  it("caps recent at RECENT_CAP, newest (input) first", () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`SWIT-${i}`));
    const groups = groupEvidence(rows);
    const recent = groups.find((g) => g.id === "recent");
    expect(recent?.count).toBe(RECENT_CAP);
    expect(recent?.rows[0].address).toBe("SWIT-0");
    expect(groups.find((g) => g.id === "tickets")?.count).toBe(12);
  });

  it("gives decisions, pages and views their own groups", () => {
    const groups = groupEvidence([row("decision:q1"), row("surface:lodestar/trading"), row("view:v3")]);
    expect(groups.map((g) => g.id)).toEqual(["recent", "pages", "views", "decisions"]);
  });
});

describe("view rows (SWIT-69 — the tab budget's ledger half)", () => {
  it("evidenceKindOf reads the view: prefix; viewIdOfAddress holds the id alphabet", () => {
    expect(evidenceKindOf("view:v1")).toBe("view");
    expect(viewAddress("v1")).toBe("view:v1");
    expect(viewIdOfAddress("view:v1")).toBe("v1");
    expect(viewIdOfAddress("view:no spaces!")).toBeNull();
    expect(viewIdOfAddress("view:")).toBeNull();
    expect(viewIdOfAddress("SWIT-64")).toBeNull();
  });

  it("viewAnchorOfAddress (SWIT-73): an optional #<anchor> names a report heading", () => {
    expect(viewAnchorOfAddress("view:v1")).toEqual({ viewId: "v1", anchor: null });
    expect(viewAnchorOfAddress("view:v1#h:the-path")).toEqual({ viewId: "v1", anchor: "h:the-path" });
    expect(viewAnchorOfAddress("view:v1#table:1:row:2")).toEqual({ viewId: "v1", anchor: "table:1:row:2" });
    // A malformed fragment makes the WHOLE address plain — never half a link.
    expect(viewAnchorOfAddress("view:v1#")).toBeNull();
    expect(viewAnchorOfAddress("view:v1#notakey")).toBeNull();
    expect(viewAnchorOfAddress("view:bad id#h:x")).toBeNull();
    expect(viewAnchorOfAddress("SWIT-64")).toBeNull();
  });

  it("mergeViewEvidence synthesizes a row per spec; an agent-posted row at the same address wins", () => {
    const agent = row("view:v1", { label: "the agent's words", status: "kept", updatedAt: "2026-09-01T12:00:00Z" });
    const out = mergeViewEvidence(
      [agent],
      [
        { id: "v1", title: "ignored — agent wins", builtAt: "2026-09-01T10:00:00Z" },
        { id: "v2", title: "Flow anomalies", builtAt: "2026-09-01T11:00:00Z" },
      ]
    );
    expect(out).toEqual([
      agent,
      { address: "view:v2", label: "Flow anomalies", status: null, updatedAt: "2026-09-01T11:00:00Z" },
    ]);
  });
});

describe("mergeScannedEvidence", () => {
  const scanned = (address: string, at = "2026-09-01T10:00:00Z"): ScannedEvidence => ({
    address,
    kind: "ticket",
    at,
  });

  it("adds scanned-only rows with the seen-in-thread status and no label", () => {
    const out = mergeScannedEvidence([], [scanned("SWIT-64")]);
    expect(out).toEqual([
      { address: "SWIT-64", label: "", status: SCANNED_STATUS, updatedAt: "2026-09-01T10:00:00Z" },
    ]);
  });

  it("an agent-posted row with the same address WINS (label + status)", () => {
    const agent = row("SWIT-64", { label: "the backlog epic", status: "in review", updatedAt: "2026-09-01T09:00:00Z" });
    const out = mergeScannedEvidence([agent], [scanned("SWIT-64")]);
    expect(out).toEqual([agent]);
  });

  it("interleaves newest-first by stamp; unparseable stamps sort last", () => {
    const agent = row("SWIT-1", { updatedAt: "2026-09-01T08:00:00Z" });
    const dateless = row("decision:q", { updatedAt: "" });
    const out = mergeScannedEvidence([agent, dateless], [scanned("SWIT-2", "2026-09-01T12:00:00Z")]);
    expect(out.map((r) => r.address)).toEqual(["SWIT-2", "SWIT-1", "decision:q"]);
  });
});

describe("resolveDocTarget", () => {
  it("resolves a KB doc against the real doc list", () => {
    expect(resolveDocTarget("switchboard/notes.md", ["switchboard/notes.md"], null)).toEqual({
      kind: "kb-doc",
      path: "switchboard/notes.md",
    });
  });

  it("falls back to the thread's project for a repo-relative path", () => {
    expect(resolveDocTarget("src/lib/pageStore.ts", [], "switchboard")).toEqual({
      kind: "repo-file",
      project: "switchboard",
      path: "src/lib/pageStore.ts",
    });
  });

  it("stays plain text without a resolution", () => {
    expect(resolveDocTarget("src/lib/pageStore.ts", [], null)).toBeNull(); // no project
    expect(resolveDocTarget("Cargo.toml", [], "switchboard")).toBeNull(); // no slash, not in KB
    expect(resolveDocTarget("SWIT-64", ["SWIT-64"], "switchboard")).toBeNull(); // not a doc/file kind
  });
});

describe("latchViewKey (SWIT-70 review fix F2 — a failed spec read retries)", () => {
  it("a clean pass latches the id list's own key", () => {
    expect(latchViewKey(["a", "b"], ["a", "b"])).toBe(["a", "b"].join("\n"));
  });

  it("a failed read leaves the latch unequal to the list key, so the next tick retries", () => {
    const latched = latchViewKey(["a", "b"], ["a"]); // "b" was caught mid-write
    expect(latched).not.toBe(["a", "b"].join("\n"));
    // ...and once "b" reads, the pass latches clean and the poll goes quiet.
    expect(latchViewKey(["a", "b"], ["a", "b"])).toBe(["a", "b"].join("\n"));
  });

  it("every read failing latches nothing that matches a non-empty list", () => {
    expect(latchViewKey(["a"], [])).not.toBe(["a"].join("\n"));
  });
});
