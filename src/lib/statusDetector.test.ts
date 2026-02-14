import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initDetector,
  destroyDetector,
  processOutput,
  clearWaiting,
  markExited,
} from "./statusDetector";
const SID = "test-session";

beforeEach(() => {
  vi.useFakeTimers();
  initDetector(SID);
});

afterEach(() => {
  destroyDetector(SID);
  vi.useRealTimers();
});

// ── initDetector / destroyDetector ──────────────────────────────

describe("initDetector / destroyDetector", () => {
  it("init creates state and processOutput works", () => {
    const cb = vi.fn();
    processOutput(SID, "hello world", cb);
    // Already running, so no change callback
    expect(cb).not.toHaveBeenCalled();
  });

  it("destroy cleans up — processOutput is a no-op after", () => {
    destroyDetector(SID);
    const cb = vi.fn();
    processOutput(SID, "hello", cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("double init does not leak (destroys first)", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb); // → waiting
    expect(cb).toHaveBeenCalledWith(SID, "waiting");

    // Re-init should reset
    initDetector(SID);
    const cb2 = vi.fn();
    processOutput(SID, "hello", cb2);
    // Fresh state is "running", output is meaningful → stays running, no change
    expect(cb2).not.toHaveBeenCalled();
  });

  it("destroy non-existent session is safe", () => {
    expect(() => destroyDetector("nonexistent")).not.toThrow();
  });
});

// ── Pattern matching — waiting ──────────────────────────────────

describe("pattern matching — waiting", () => {
  const waitingInputs = [
    "(y/n)",
    "[y/n]",
    "(yes/no)",
    "Do you want to proceed?",
    "Do you want to continue?",
    "Do you want to make this edit to src/App.tsx?",
    "Do you want to allow Claude to fetch this content?",
    "Would you like to proceed?",
    "Would you like to install this LSP plugin?",
    "Would you like to stash these changes?",
    "Allow this action?",
    "Press any key to continue",
    "Are you sure?",
    "Confirm deletion",
    "? [Y/n]",
    "? (Y/n)",
    "Enter a value:",
    "waiting for input",
  ];

  it.each(waitingInputs)("detects waiting for: %s", (input) => {
    const cb = vi.fn();
    processOutput(SID, input, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("case insensitivity works", () => {
    const cb = vi.fn();
    processOutput(SID, "DO YOU WANT TO PROCEED", cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("pattern embedded in ANSI-styled output still matches", () => {
    const cb = vi.fn();
    processOutput(SID, "\x1b[1;33m(y/n)\x1b[0m", cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("'Confirmed' does NOT trigger waiting (word-boundary check)", () => {
    const cb = vi.fn();
    processOutput(SID, "Confirmed: package installed", cb);
    expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
  });

  it("'Confirmation' does NOT trigger waiting", () => {
    const cb = vi.fn();
    processOutput(SID, "Confirmation complete", cb);
    expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
  });

  it("pattern inside terminal title (OSC) does NOT trigger waiting", () => {
    const cb = vi.fn();
    processOutput(SID, "\x1b]0;Confirm updates\x07", cb);
    // OSC is stripped before matching, and the remaining text is non-meaningful
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── Pattern matching — error ────────────────────────────────────

describe("pattern matching — error", () => {
  const errorInputs = [
    "Error: something went wrong",
    "FAILED to compile",
    "panic: runtime error",
    "ERROR in module",
    "fatal: not a git repository",
    "Traceback (most recent call last):",
    "Exception: division by zero",
  ];

  it.each(errorInputs)("detects error for: %s", (input) => {
    const cb = vi.fn();
    processOutput(SID, input, cb);
    expect(cb).toHaveBeenCalledWith(SID, "error");
  });

  it("FAILED matches (case-sensitive uppercase)", () => {
    const cb = vi.fn();
    processOutput(SID, "test FAILED", cb);
    expect(cb).toHaveBeenCalledWith(SID, "error");
  });

  it("`failed` (lowercase) does NOT match FAILED pattern", () => {
    // "failed" alone doesn't match FAILED (case sensitive) or Error: (needs colon)
    const cb = vi.fn();
    processOutput(SID, "test failed gracefully", cb);
    // No error/waiting pattern → stays running
    expect(cb).not.toHaveBeenCalled();
  });

  it("Error: matches case-insensitively", () => {
    const cb = vi.fn();
    processOutput(SID, "error: bad config", cb);
    expect(cb).toHaveBeenCalledWith(SID, "error");
  });

  it("waiting takes priority over error (both present → waiting wins)", () => {
    const cb = vi.fn();
    processOutput(SID, "Error: fix this? (y/n)", cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });
});

// ── isMeaningfulOutput ──────────────────────────────────────────

describe("isMeaningfulOutput (via processOutput behavior)", () => {
  it("pure ANSI escape sequences → ignored (no timer reset)", () => {
    const cb = vi.fn();
    // Move cursor to 1,1
    processOutput(SID, "\x1b[1;1H", cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("ANSI + visible text → processed normally", () => {
    const cb = vi.fn();
    processOutput(SID, "\x1b[32mhello\x1b[0m", cb);
    // Already running, meaningful text keeps running → no change
    expect(cb).not.toHaveBeenCalled();
    // But timer should be set — advance past 5s and check
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("only whitespace/control chars → ignored", () => {
    const cb = vi.fn();
    processOutput(SID, "\r\n\t  \r", cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("cursor movement sequences → ignored", () => {
    const cb = vi.fn();
    processOutput(SID, "\x1b[2J\x1b[H", cb); // clear screen + home
    expect(cb).not.toHaveBeenCalled();
  });

  it("terminal title updates (OSC) → ignored", () => {
    const cb = vi.fn();
    processOutput(SID, "\x1b]0;My Terminal\x07", cb);
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── State machine transitions ───────────────────────────────────

describe("state machine transitions", () => {
  it("running → waiting pattern → 'waiting' + callback fires", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("waiting → 1-2 output chunks (no pattern) → stays 'waiting' (sticky)", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
    cb.mockClear();
    processOutput(SID, "some normal output", cb);
    expect(cb).not.toHaveBeenCalled();
    processOutput(SID, "more output", cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("waiting → 3 output chunks without re-match → sticky auto-expires → 'running'", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
    cb.mockClear();
    processOutput(SID, "chunk 1", cb);
    processOutput(SID, "chunk 2", cb);
    expect(cb).not.toHaveBeenCalled(); // still waiting
    processOutput(SID, "chunk 3", cb);
    expect(cb).toHaveBeenCalledWith(SID, "running"); // auto-expired
  });

  it("waiting pattern re-appearing resets the auto-expiry counter", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb);
    cb.mockClear();
    processOutput(SID, "chunk 1", cb);
    processOutput(SID, "chunk 2", cb);
    // Pattern appears again — counter resets
    processOutput(SID, "(y/n)", cb);
    expect(cb).not.toHaveBeenCalled(); // still waiting, no transition
    // Need 3 MORE chunks to auto-expire
    processOutput(SID, "chunk A", cb);
    processOutput(SID, "chunk B", cb);
    expect(cb).not.toHaveBeenCalled();
    processOutput(SID, "chunk C", cb);
    expect(cb).toHaveBeenCalledWith(SID, "running");
  });

  it("waiting → clearWaiting(id, callback) → 'running'", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb);
    cb.mockClear();
    clearWaiting(SID, cb);
    expect(cb).toHaveBeenCalledWith(SID, "running");
  });

  it("waiting → clearWaiting(id) without callback → sticky cleared but status stays 'waiting'", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb);
    cb.mockClear();
    clearWaiting(SID); // no callback
    // Status stays waiting (no callback to transition) but sticky is cleared
    // Next meaningful output should now allow transition away from waiting
    processOutput(SID, "normal text", cb);
    expect(cb).toHaveBeenCalledWith(SID, "running");
  });

  it("running → error pattern → 'error' + callback fires", () => {
    const cb = vi.fn();
    processOutput(SID, "Error: bad things", cb);
    expect(cb).toHaveBeenCalledWith(SID, "error");
  });

  it("error → normal output → 'running' + callback fires", () => {
    const cb = vi.fn();
    processOutput(SID, "Error: bad", cb);
    cb.mockClear();
    processOutput(SID, "all clear now", cb);
    expect(cb).toHaveBeenCalledWith(SID, "running");
  });

  it("running → 5s idle → 'done' + callback fires", () => {
    const cb = vi.fn();
    processOutput(SID, "compiling...", cb);
    expect(cb).not.toHaveBeenCalled(); // still running
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("waiting → 5s idle → stays 'waiting' (timer doesn't override)", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
    cb.mockClear();
    vi.advanceTimersByTime(5000);
    // Timer checks s.currentStatus === "running" — it's "waiting" so no-op
    expect(cb).not.toHaveBeenCalled();
  });

  it("done → new output → 'running' + callback fires", () => {
    const cb = vi.fn();
    processOutput(SID, "compiling...", cb);
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledWith(SID, "done");
    cb.mockClear();
    processOutput(SID, "new output", cb);
    expect(cb).toHaveBeenCalledWith(SID, "running");
  });

  it("any state → markExited → 'exited'", () => {
    const cb = vi.fn();
    processOutput(SID, "hello", cb);
    markExited(SID, cb);
    expect(cb).toHaveBeenCalledWith(SID, "exited");
  });

  it("markExited from waiting state", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb);
    cb.mockClear();
    markExited(SID, cb);
    expect(cb).toHaveBeenCalledWith(SID, "exited");
  });
});

// ── Timer behavior ──────────────────────────────────────────────

describe("timer behavior", () => {
  it("output resets the 5s timer", () => {
    const cb = vi.fn();
    processOutput(SID, "line 1", cb);
    vi.advanceTimersByTime(3000);
    processOutput(SID, "line 2", cb); // resets timer
    vi.advanceTimersByTime(3000);
    expect(cb).not.toHaveBeenCalled(); // only 3s since last output
    vi.advanceTimersByTime(2000); // now 5s since line 2
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("rapid output — only one timer active", () => {
    const cb = vi.fn();
    processOutput(SID, "a", cb);
    processOutput(SID, "b", cb);
    processOutput(SID, "c", cb);
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("timer fires after exactly DONE_TIMEOUT_MS (5000)", () => {
    const cb = vi.fn();
    processOutput(SID, "output", cb);
    vi.advanceTimersByTime(4999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("timer does not fire if new output arrives before timeout", () => {
    const cb = vi.fn();
    processOutput(SID, "output 1", cb);
    vi.advanceTimersByTime(4000);
    processOutput(SID, "output 2", cb);
    vi.advanceTimersByTime(4000);
    // 4s since "output 2" — no done yet
    expect(cb).not.toHaveBeenCalled();
  });

  it("non-meaningful output does NOT reset timer", () => {
    const cb = vi.fn();
    processOutput(SID, "real output", cb);
    vi.advanceTimersByTime(3000);
    processOutput(SID, "\x1b[1;1H", cb); // just cursor move
    vi.advanceTimersByTime(2000); // 5s since "real output"
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });
});

// ── Callback discipline ─────────────────────────────────────────

describe("callback discipline", () => {
  it("callback only fires on status change (same status → no call)", () => {
    const cb = vi.fn();
    processOutput(SID, "hello", cb);
    processOutput(SID, "world", cb);
    processOutput(SID, "foo", cb);
    // All keep it "running" → no change → cb never called
    expect(cb).not.toHaveBeenCalled();
  });

  it("multiple outputs producing same status → callback fires once", () => {
    const cb = vi.fn();
    processOutput(SID, "Error: a", cb);
    processOutput(SID, "Error: b", cb);
    processOutput(SID, "Error: c", cb);
    // First one transitions to error, subsequent ones stay error
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(SID, "error");
  });
});
