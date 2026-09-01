// evidenceScan (SWIT-66): extraction from plain transcript text, the union
// store's add-only semantics, the cap, and the end-to-end acceptance — a
// transcript mentioning a ticket, a PR URL and a source path yields grouped
// rows with counts, zero agent calls.

import { beforeEach, describe, expect, it } from "vitest";
import {
  noteScanWriteCount,
  pruneThreadScan,
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

  it("a ticket-shaped hit counts only when its prefix is a known project key", () => {
    const junk = "encoded UTF-8, hashed SHA-256, asked GPT-4, dated ISO-8601, since COVID-19";
    expect(scanTranscript(junk)).toEqual([]);
    expect(scanTranscript("shipped SWIT-64")).toEqual([{ address: "SWIT-64", kind: "ticket" }]);
  });

  it("accepts an injected prefix set", () => {
    expect(scanTranscript("ABC-1 then SWIT-2", new Set(["ABC"]))).toEqual([
      { address: "ABC-1", kind: "ticket" },
    ]);
  });

  it("a soft-wrapped URL, joined back into one line, yields no path fragment", () => {
    // plainTextTerminal joins rows whose isWrapped is true with NO separator;
    // this fixture is that joined output. A real xterm buffer is impractical
    // under vitest, so the terminal.ts change is exercised here at the scan
    // layer: the unjoined form (a raw newline mid-URL) is the pre-fix bug.
    const unjoined = "see https://github.com/e/x/blob/main/sr\nc/lib/deep/pageStore.ts now";
    expect(scanTranscript(unjoined).some((h) => h.address === "c/lib/deep/pageStore.ts")).toBe(true);
    expect(scanTranscript(unjoined.replace("\n", ""))).toEqual([]);
  });

  it("a 1MB dash run scans fast — one match start position, not one per char", () => {
    const t0 = performance.now();
    scanTranscript("-".repeat(1_000_000));
    expect(performance.now() - t0).toBeLessThan(100);
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

  it("an evicted address can return — eviction clears it from the seen-set", () => {
    recordScan("t1", [{ address: "SWIT-0", kind: "ticket" }]);
    for (let i = 1; i <= SCAN_CAP; i++) {
      recordScan("t1", [{ address: `SWIT-${i}`, kind: "ticket" }]);
    }
    expect(scannedEvidenceFor("t1").some((r) => r.address === "SWIT-0")).toBe(false);
    expect(recordScan("t1", [{ address: "SWIT-0", kind: "ticket" }])).toBe(true);
    expect(scannedEvidenceFor("t1")[0].address).toBe("SWIT-0");
  });

  it("noteScanWriteCount gates: an unchanged counter says skip", () => {
    expect(noteScanWriteCount("t1", 0)).toBe(true);
    expect(noteScanWriteCount("t1", 0)).toBe(false);
    expect(noteScanWriteCount("t1", 3)).toBe(true);
    expect(noteScanWriteCount("t1", 3)).toBe(false);
    expect(noteScanWriteCount("t2", 3)).toBe(true);
  });

  it("pruneThreadScan drops rows, seen-set and gate for one thread", () => {
    scanThreadTranscript("t1", "SWIT-64");
    noteScanWriteCount("t1", 5);
    pruneThreadScan("t1");
    expect(scannedEvidenceFor("t1")).toEqual([]);
    expect(noteScanWriteCount("t1", 5)).toBe(true);
    scanThreadTranscript("t1", "SWIT-64");
    expect(scannedEvidenceFor("t1").map((r) => r.address)).toEqual(["SWIT-64"]);
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
