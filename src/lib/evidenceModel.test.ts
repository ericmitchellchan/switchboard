// evidenceModel (SWIT-66): kind inference, fixed-group folding, the scanned-
// row merge precedence (agent wins), and the doc/file link rule.

import { describe, expect, it } from "vitest";
import {
  evidenceKindOf,
  groupEvidence,
  isPathShaped,
  mergeScannedEvidence,
  resolveDocTarget,
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

  it("gives decisions and pages their own groups", () => {
    const groups = groupEvidence([row("decision:q1"), row("surface:lodestar/trading")]);
    expect(groups.map((g) => g.id)).toEqual(["recent", "pages", "decisions"]);
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
