import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initTaskDetector,
  destroyTaskDetector,
  detectTasks,
  detectResolutions,
} from "./taskDetector";

const SID = "test-session";

beforeEach(() => {
  initTaskDetector(SID);
  // Start with Date.now() well past the debounce window
  vi.spyOn(Date, "now").mockReturnValue(10_000);
});

afterEach(() => {
  destroyTaskDetector(SID);
  vi.restoreAllMocks();
});

// ── Pattern detection ───────────────────────────────────────────

describe("pattern detection", () => {
  it("Rust error with file+line", () => {
    const tasks = detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].fingerprint).toBe("rust:src/main.rs:12:E0425");
    expect(tasks[0].category).toBe("build");
    expect(tasks[0].priority).toBe("high");
  });

  it("Rust error simple (no file)", () => {
    const tasks = detectTasks(SID, "error[E0425]: cannot find value");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].fingerprint).toBe("rust:E0425");
  });

  it("TypeScript error with file+line", () => {
    const tasks = detectTasks(SID, "error TS2345: Argument of type 'string' file.ts(5,10)");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].fingerprint).toBe("ts:file.ts:TS2345");
    expect(tasks[0].category).toBe("build");
  });

  it("TypeScript error simple", () => {
    const tasks = detectTasks(SID, "error TS2345: Argument of type 'string'");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].fingerprint).toBe("ts:TS2345");
  });

  it("test failure", () => {
    const tasks = detectTasks(SID, "FAIL src/test.ts");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].fingerprint).toBe("test:src/test.ts");
    expect(tasks[0].category).toBe("test");
  });

  it("git conflict", () => {
    const tasks = detectTasks(SID, "CONFLICT (content): Merge conflict in README.md");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].fingerprint).toBe("git:conflict:README.md");
    expect(tasks[0].category).toBe("git");
  });

  it("test name truncation: 81+ char name truncated to 80", () => {
    const longName = "a".repeat(81);
    const tasks = detectTasks(SID, `FAIL ${longName}`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].fingerprint).toBe(`test:${"a".repeat(80)}`);
  });
});

// ── Fingerprint dedup ───────────────────────────────────────────

describe("fingerprint dedup", () => {
  it("same error twice → detected only once", () => {
    const t1 = detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    expect(t1).toHaveLength(1);
    // Need to advance past debounce for next detection
    vi.spyOn(Date, "now").mockReturnValue(13_000);
    const t2 = detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    expect(t2).toHaveLength(0);
  });

  it("different errors of same type → both detected via matchAll", () => {
    const t1 = detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    expect(t1).toHaveLength(1);
    vi.spyOn(Date, "now").mockReturnValue(13_000);
    const t2 = detectTasks(SID, "error[E0308] --> src/lib.rs:5:3");
    expect(t2).toHaveLength(1);
    expect(t2[0].fingerprint).toBe("rust:src/lib.rs:5:E0308");
  });

  it("different error types → both detected", () => {
    const t1 = detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    expect(t1).toHaveLength(1);
    vi.spyOn(Date, "now").mockReturnValue(13_000);
    const t2 = detectTasks(SID, "error TS2345: Argument of type 'string' file.ts(5,10)");
    expect(t2).toHaveLength(1);
    expect(t2[0].fingerprint).toBe("ts:file.ts:TS2345");
  });

  it("multiple errors in single chunk → all detected at once", () => {
    const multiError = [
      "error[E0425] --> src/main.rs:12:5",
      "error[E0308] --> src/lib.rs:5:3",
    ].join("\n");
    const tasks = detectTasks(SID, multiError);
    expect(tasks).toHaveLength(2);
    const fps = tasks.map((t) => t.fingerprint);
    expect(fps).toContain("rust:src/main.rs:12:E0425");
    expect(fps).toContain("rust:src/lib.rs:5:E0308");
  });

  it("after resolution, same error re-detected as new task", () => {
    detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    detectResolutions(SID, "Finished dev profile");
    vi.spyOn(Date, "now").mockReturnValue(13_000);
    const t2 = detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    expect(t2).toHaveLength(1);
    expect(t2[0].fingerprint).toBe("rust:src/main.rs:12:E0425");
  });
});

// ── Resolution detection ────────────────────────────────────────

describe("resolution detection", () => {
  it("Finished after Rust errors → returns [\"rust:\"], clears rust fingerprints", () => {
    detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    const resolved = detectResolutions(SID, "Finished dev profile");
    expect(resolved).toContain("rust:");
  });

  it("Found 0 errors → clears TS fingerprints", () => {
    detectTasks(SID, "error TS2345: something file.ts(5,10)");
    const resolved = detectResolutions(SID, "Found 0 errors");
    expect(resolved).toContain("ts:");
  });

  it("test result: ok → clears test fingerprints", () => {
    detectTasks(SID, "FAIL src/test.ts");
    const resolved = detectResolutions(SID, "test result: ok");
    expect(resolved).toContain("test:");
  });

  it("All conflicts fixed → clears git fingerprints", () => {
    detectTasks(SID, "CONFLICT (content): Merge conflict in README.md");
    const resolved = detectResolutions(SID, "All conflicts fixed");
    expect(resolved).toContain("git:conflict:");
  });

  it("no known fingerprints → returns empty array", () => {
    const resolved = detectResolutions(SID, "Finished dev profile");
    expect(resolved).toEqual([]);
  });
});

// ── Debounce ────────────────────────────────────────────────────

describe("debounce (DEBOUNCE_MS = 2000)", () => {
  it("first detection always succeeds (lastDetectionTime starts at 0)", () => {
    const tasks = detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    expect(tasks).toHaveLength(1);
  });

  it("call within 2000ms → returns empty", () => {
    // First detection at 10_000
    detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    // Second call at 11_000 (within debounce)
    vi.spyOn(Date, "now").mockReturnValue(11_000);
    const tasks = detectTasks(SID, "error[E0308] --> src/lib.rs:5:3");
    expect(tasks).toHaveLength(0);
  });

  it("call after 2000ms → processes normally", () => {
    detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    // 2001ms later
    vi.spyOn(Date, "now").mockReturnValue(12_001);
    const tasks = detectTasks(SID, "error[E0308] --> src/lib.rs:5:3");
    expect(tasks).toHaveLength(1);
  });

  it("boundary: exactly at 2000ms passes (< is strict)", () => {
    detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    // 12000 - 10000 = 2000, condition is `< 2000` → false → not debounced
    vi.spyOn(Date, "now").mockReturnValue(12_000);
    const tasks = detectTasks(SID, "error[E0308] --> src/lib.rs:5:3");
    expect(tasks).toHaveLength(1);
  });
});

// ── Line buffer ─────────────────────────────────────────────────

describe("line buffer", () => {
  it("single-line input → added to buffer, detected", () => {
    const tasks = detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    expect(tasks).toHaveLength(1);
  });

  it("multi-line input → all lines added", () => {
    const tasks = detectTasks(
      SID,
      "compiling...\nerror[E0425] --> src/main.rs:12:5\nhelp: did you mean"
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].fingerprint).toBe("rust:src/main.rs:12:E0425");
  });

  it("buffer exceeds 20 lines → oldest discarded", () => {
    // Fill buffer with 20 lines of junk
    const junkLines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    detectTasks(SID, junkLines);

    // Now add an error — it should push out old lines
    vi.spyOn(Date, "now").mockReturnValue(13_000);
    const tasks = detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    expect(tasks).toHaveLength(1);
  });

  it("multi-line Rust error across buffer → matched via join", () => {
    // The error pattern matches on the joined buffer
    detectTasks(SID, "some preamble");
    vi.spyOn(Date, "now").mockReturnValue(13_000);
    const tasks = detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    expect(tasks).toHaveLength(1);
  });
});

// ── Session isolation ───────────────────────────────────────────

describe("session isolation", () => {
  const SID2 = "test-session-2";

  beforeEach(() => {
    initTaskDetector(SID2);
  });

  afterEach(() => {
    destroyTaskDetector(SID2);
  });

  it("two sessions with same error → each gets its own detection", () => {
    const t1 = detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    const t2 = detectTasks(SID2, "error[E0425] --> src/main.rs:12:5");
    expect(t1).toHaveLength(1);
    expect(t2).toHaveLength(1);
  });

  it("destroying one session doesn't affect other", () => {
    detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    detectTasks(SID2, "error[E0425] --> src/main.rs:12:5");
    destroyTaskDetector(SID);
    // SID2 should still have its fingerprints
    vi.spyOn(Date, "now").mockReturnValue(13_000);
    const tasks = detectTasks(SID2, "error[E0425] --> src/main.rs:12:5");
    // Should be deduped (already known)
    expect(tasks).toHaveLength(0);
    // But SID is gone
    const tasks2 = detectTasks(SID, "error[E0425] --> src/main.rs:12:5");
    expect(tasks2).toHaveLength(0); // no state, returns []
  });
});
