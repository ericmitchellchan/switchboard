// evidenceScan (SWIT-66): extraction from plain transcript text, the union
// store's add-only semantics, the cap, and the end-to-end acceptance — a
// transcript mentioning a ticket, a PR URL and a source path yields grouped
// rows with counts, zero agent calls.

import { beforeEach, describe, expect, it } from "vitest";
import {
  recordScan,
  scannedEvidenceFor,
  scanThreadTranscript,
  scanTranscript,
  SCAN_CAP,
  __resetEvidenceScanForTests,
} from "./evidenceScan";
import { groupEvidence, mergeScannedEvidence, SCANNED_STATUS } from "./evidenceModel";

beforeEach(() => __resetEvidenceScanForTests());

describe("scanTranscript", () => {
  it("extracts ticket keys, deduped, first-seen order", () => {
    const hits = scanTranscript("working SWIT-64 then CAD-12, SWIT-64 again");
    expect(hits).toEqual([
      { address: "SWIT-64", kind: "ticket" },
      { address: "CAD-12", kind: "ticket" },
    ]);
  });

  it("extracts GitHub PR URLs verbatim", () => {
    const hits = scanTranscript("opened https://github.com/ericmitchellchan/switchboard/pull/61 for review");
    expect(hits).toEqual([
      { address: "https://github.com/ericmitchellchan/switchboard/pull/61", kind: "pr" },
    ]);
  });

  it("extracts doc and file paths, folding backslashes", () => {
    const hits = scanTranscript("edited src\\lib\\pageStore.ts and wrote switchboard/features/notes.md.");
    expect(hits).toEqual([
      { address: "src/lib/pageStore.ts", kind: "file" },
      { address: "switchboard/features/notes.md", kind: "doc" },
    ]);
  });

  it("ignores URLs-as-paths, .. segments and bare words", () => {
    const hits = scanTranscript(
      "see http://localhost:5173/src/main.tsx and ../secret/x.md and refactor later"
    );
    expect(hits).toEqual([]);
  });

  it("tolerates ANSI escapes around a key", () => {
    const hits = scanTranscript("\x1b[1mSWIT-64\x1b[22m done");
    expect(hits).toEqual([{ address: "SWIT-64", kind: "ticket" }]);
  });
});

describe("the union store", () => {
  it("adds, never removes — absence from a later scan drops nothing", () => {
    scanThreadTranscript("t1", "SWIT-64 and src/lib/a.ts", new Date("2026-09-01T10:00:00Z"));
    scanThreadTranscript("t1", "only CAD-1 now", new Date("2026-09-01T10:05:00Z"));
    expect(scannedEvidenceFor("t1").map((r) => r.address)).toEqual([
      "CAD-1",
      "SWIT-64",
      "src/lib/a.ts",
    ]);
  });

  it("an unchanged re-scan is a no-op (same reference, no change)", () => {
    scanThreadTranscript("t1", "SWIT-64");
    const before = scannedEvidenceFor("t1");
    expect(recordScan("t1", [{ address: "SWIT-64", kind: "ticket" }])).toBe(false);
    expect(scannedEvidenceFor("t1")).toBe(before);
  });

  it("caps at SCAN_CAP newest-first — the oldest rows fall off", () => {
    for (let i = 0; i < SCAN_CAP + 5; i++) {
      recordScan("t1", [{ address: `SWIT-${i}`, kind: "ticket" }], new Date(1756700000000 + i * 1000));
    }
    const rows = scannedEvidenceFor("t1");
    expect(rows.length).toBe(SCAN_CAP);
    expect(rows[0].address).toBe(`SWIT-${SCAN_CAP + 4}`);
    expect(rows.some((r) => r.address === "SWIT-0")).toBe(false);
  });

  it("threads are independent", () => {
    scanThreadTranscript("t1", "SWIT-1");
    scanThreadTranscript("t2", "SWIT-2");
    expect(scannedEvidenceFor("t1").map((r) => r.address)).toEqual(["SWIT-1"]);
    expect(scannedEvidenceFor("t2").map((r) => r.address)).toEqual(["SWIT-2"]);
  });
});

describe("acceptance: scan → merge → group, zero agent calls", () => {
  it("a transcript mentioning SWIT-64, a PR URL and src/lib/pageStore.ts yields grouped rows", () => {
    scanThreadTranscript(
      "t1",
      [
        "$ claude",
        "Working SWIT-64 — see https://github.com/ericmitchellchan/switchboard/pull/61",
        "edited src/lib/pageStore.ts",
      ].join("\n"),
      new Date("2026-09-01T10:00:00Z")
    );
    const merged = mergeScannedEvidence([], scannedEvidenceFor("t1"));
    expect(merged.every((r) => r.status === SCANNED_STATUS)).toBe(true);
    const groups = groupEvidence(merged);
    expect(groups.map((g) => [g.id, g.count])).toEqual([
      ["recent", 3],
      ["tickets", 1],
      ["prs", 1],
      ["files", 1],
    ]);
  });
});
