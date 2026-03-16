import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  initDetector,
  destroyDetector,
  processOutput,
  processBufferLines,
  clearWaiting,
  markExited,
  _testOnly,
} from "./statusDetector";
const SID = "test-session";

// Timing constants must match statusDetector.ts
const DONE_TIMEOUT_MS = 15_000;
const SHORT_DONE_TIMEOUT_MS = 2_000;
const PENDING_WAITING_DELAY_MS = 1_500;
// Dwell times for processBufferLines transitions
const DWELL_RUNNING = 600;
const DWELL_DONE = 500;

/** Activate agent detection for processBufferLines tests.
 *  Sends a token counter signal so the detector transitions from "idle" to "running". */
function activateAgent(cb?: ReturnType<typeof vi.fn>): void {
  const dummy = cb ?? vi.fn();
  processBufferLines(SID, ["(1s, 100 tokens)"], 0, dummy as any);
  dummy.mockClear();
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
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
    // But timer should be set — advance past DONE_TIMEOUT_MS and check
    vi.advanceTimersByTime(DONE_TIMEOUT_MS);
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

  it("waiting → 6 output chunks without re-match → sticky auto-expires → 'running'", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
    cb.mockClear();
    for (let i = 1; i <= 5; i++) {
      processOutput(SID, `chunk ${i}`, cb);
    }
    expect(cb).not.toHaveBeenCalled(); // still waiting
    processOutput(SID, "chunk 6", cb);
    expect(cb).toHaveBeenCalledWith(SID, "running"); // auto-expired
  });

  it("waiting pattern re-appearing resets the auto-expiry counter", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb);
    cb.mockClear();
    for (let i = 1; i <= 3; i++) {
      processOutput(SID, `chunk ${i}`, cb);
    }
    // Pattern appears again — counter resets
    processOutput(SID, "(y/n)", cb);
    expect(cb).not.toHaveBeenCalled(); // still waiting, no transition
    // Need 6 MORE chunks to auto-expire
    for (let i = 1; i <= 5; i++) {
      processOutput(SID, `chunk ${String.fromCharCode(64 + i)}`, cb);
    }
    expect(cb).not.toHaveBeenCalled();
    processOutput(SID, "chunk F", cb);
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

  it("running → idle timeout → 'done' + callback fires", () => {
    const cb = vi.fn();
    processOutput(SID, "compiling...", cb);
    expect(cb).not.toHaveBeenCalled(); // still running
    vi.advanceTimersByTime(DONE_TIMEOUT_MS);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("waiting → idle timeout → stays 'waiting' (timer doesn't override)", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
    cb.mockClear();
    vi.advanceTimersByTime(DONE_TIMEOUT_MS);
    // Timer checks s.currentStatus === "running" — it's "waiting" so no-op
    expect(cb).not.toHaveBeenCalled();
  });

  it("done → new output → 'running' + callback fires", () => {
    const cb = vi.fn();
    processOutput(SID, "compiling...", cb);
    vi.advanceTimersByTime(DONE_TIMEOUT_MS);
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
  it("output resets the idle timer", () => {
    const cb = vi.fn();
    processOutput(SID, "line 1", cb);
    vi.advanceTimersByTime(10000);
    processOutput(SID, "line 2", cb); // resets timer
    vi.advanceTimersByTime(10000);
    expect(cb).not.toHaveBeenCalled(); // only 10s since last output
    vi.advanceTimersByTime(5000); // now 15s since line 2
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("rapid output — only one timer active", () => {
    const cb = vi.fn();
    processOutput(SID, "a", cb);
    processOutput(SID, "b", cb);
    processOutput(SID, "c", cb);
    vi.advanceTimersByTime(DONE_TIMEOUT_MS);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("timer fires after exactly DONE_TIMEOUT_MS", () => {
    const cb = vi.fn();
    processOutput(SID, "output", cb);
    vi.advanceTimersByTime(DONE_TIMEOUT_MS - 1);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("timer does not fire if new output arrives before timeout", () => {
    const cb = vi.fn();
    processOutput(SID, "output 1", cb);
    vi.advanceTimersByTime(DONE_TIMEOUT_MS - 1000);
    processOutput(SID, "output 2", cb);
    vi.advanceTimersByTime(DONE_TIMEOUT_MS - 1000);
    // Not enough time since "output 2"
    expect(cb).not.toHaveBeenCalled();
  });

  it("non-meaningful output does NOT reset timer", () => {
    const cb = vi.fn();
    processOutput(SID, "real output", cb);
    vi.advanceTimersByTime(DONE_TIMEOUT_MS - 3000);
    processOutput(SID, "\x1b[1;1H", cb); // just cursor move
    vi.advanceTimersByTime(3000); // DONE_TIMEOUT_MS since "real output"
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

// ── Structural numbered-list detection ─────────────────────────────

describe("structural numbered-list detection", () => {
  // ─── Group 1: Basic detection ──────────────────────────────────────
  describe("basic detection", () => {
    it("detects 2-option list + silence as waiting", () => {
      const cb = vi.fn();
      processOutput(SID, "Claude wants to run a command:\n  1. Yes\n  2. No\n", cb);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting"); // not yet (timer pending)
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
    });

    it("detects 3-option list + silence as waiting", () => {
      const cb = vi.fn();
      processOutput(SID, "Choose:\n  1. Allow\n  2. Deny\n  3. Always allow\n", cb);
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
    });

    it("detects 4-option list + silence as waiting", () => {
      const cb = vi.fn();
      processOutput(
        SID,
        "Select:\n  1. Allow once\n  2. Allow always\n  3. Deny\n  4. Skip\n",
        cb
      );
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
    });
  });

  // ─── Group 2: False positive prevention ────────────────────────────
  describe("false positive prevention", () => {
    it("stays running when numbered list is followed by more output", () => {
      const cb = vi.fn();
      processOutput(SID, "Steps:\n  1. First thing\n  2. Second thing\n", cb);
      // More output arrives before timer fires
      vi.advanceTimersByTime(500);
      processOutput(SID, "Now let me explain step 1...\n", cb);
      vi.advanceTimersByTime(1200); // total 1700ms since list
      // Should not transition to waiting
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("does not match a single numbered item", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. Just one item\n", cb);
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("does not match non-consecutive numbers", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. First\n  3. Third\n", cb);
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("does not match list not starting from 1", () => {
      const cb = vi.fn();
      processOutput(SID, "  2. Second\n  3. Third\n", cb);
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("does not match numbers > 4", () => {
      const cb = vi.fn();
      // Trailing "5. E" breaks the backward scan, so no valid list detected
      processOutput(SID, "  1. A\n  2. B\n  3. C\n  4. D\n  5. E\n", cb);
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });
  });

  // ─── Group 3: Chunk boundaries ─────────────────────────────────────
  describe("chunk boundaries", () => {
    it("detects list split across 2 chunks", () => {
      const cb = vi.fn();
      processOutput(SID, "Permission needed:\n  1. Allow\n", cb);
      processOutput(SID, "  2. Deny\n", cb);
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
    });

    it("detects list split across 3 chunks", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. Yes\n", cb);
      processOutput(SID, "  2. No\n", cb);
      processOutput(SID, "  3. Always\n", cb);
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
    });

    it("resets timer when additional numbered item arrives", () => {
      const cb = vi.fn();
      processOutput(SID, "Question:\n  1. Yes\n  2. No\n", cb);
      vi.advanceTimersByTime(800);
      processOutput(SID, "  3. Maybe\n", cb);
      vi.advanceTimersByTime(800);
      vi.advanceTimersByTime(800);
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
    });
  });

  // ─── Group 4: clearWaiting interaction ─────────────────────────────
  describe("clearWaiting interaction", () => {
    it("cancels pending timer on clearWaiting", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. Yes\n  2. No\n", cb);
      clearWaiting(SID, cb);
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("clears recentLines so old lines don't combine with new", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. Yes\n", cb);
      clearWaiting(SID, cb);
      processOutput(SID, "  2. No\n", cb);
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });
  });

  // ─── Group 5: Legacy pattern interaction ───────────────────────────
  describe("legacy pattern interaction", () => {
    it("legacy waiting pattern takes priority over numbered list timer", () => {
      const cb = vi.fn();
      processOutput(SID, "Do you want to proceed (y/n)?\n  1. Yes\n  2. No\n", cb);
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
    });

    it("does not fire duplicate waiting when already waiting via legacy", () => {
      const cb = vi.fn();
      processOutput(SID, "Are you sure?\n  1. Yes\n  2. No\n", cb);
      const waitingCalls = cb.mock.calls.filter(
        (c) => c[1] === "waiting"
      ).length;
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      const afterCalls = cb.mock.calls.filter(
        (c) => c[1] === "waiting"
      ).length;
      expect(afterCalls).toBe(waitingCalls);
    });

    it("markExited cancels pending timer", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. Allow\n  2. Deny\n", cb);
      markExited(SID, cb);
      vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
      const lastCall = cb.mock.calls[cb.mock.calls.length - 1];
      expect(lastCall).toEqual([SID, "exited"]);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("destroyDetector cancels pending timer without crash", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. Allow\n  2. Deny\n", cb);
      destroyDetector(SID);
      expect(() => vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS)).not.toThrow();
    });
  });

  // ─── Group 6: hasTrailingNumberedList edge cases ───────────────────
  describe("hasTrailingNumberedList", () => {
    const { hasTrailingNumberedList } = _testOnly;

    it("returns false for empty array", () => {
      expect(hasTrailingNumberedList([])).toBe(false);
    });

    it("returns false for single item", () => {
      expect(hasTrailingNumberedList(["  1. Yes"])).toBe(false);
    });

    it("returns true for 2 consecutive items", () => {
      expect(hasTrailingNumberedList(["  1. Yes", "  2. No"])).toBe(true);
    });

    it("returns true when preamble precedes the list", () => {
      expect(
        hasTrailingNumberedList([
          "Do you want to allow this action?",
          "  1. Allow",
          "  2. Deny",
        ])
      ).toBe(true);
    });

    it("works without leading whitespace", () => {
      expect(hasTrailingNumberedList(["1. Allow", "2. Deny"])).toBe(true);
    });

    it("returns false when numbers skip", () => {
      expect(hasTrailingNumberedList(["  1. A", "  3. C"])).toBe(false);
    });

    it("returns false when list doesn't start from 1", () => {
      expect(hasTrailingNumberedList(["  2. B", "  3. C"])).toBe(false);
    });
  });

  // ─── Group 7: Token counter ────────────────────────────────────────
  describe("token counter", () => {
    it("cancels pending waiting timer when token counter appears", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. Allow\n  2. Deny\n", cb);
      vi.advanceTimersByTime(500);
      processOutput(SID, "(3s, 1.2k tokens)\n", cb);
      vi.advanceTimersByTime(1200);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("cancels pending timer for token counter without k suffix", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. Yes\n  2. No\n", cb);
      vi.advanceTimersByTime(300);
      processOutput(SID, "(12s, 450 tokens)\n", cb);
      vi.advanceTimersByTime(1300);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("token counter clears sticky waiting immediately", () => {
      const cb = vi.fn();
      processOutput(SID, "(y/n)", cb);
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
      cb.mockClear();
      // Token counter = strong running signal, should clear sticky and transition
      processOutput(SID, "(5s, 2.3k tokens)", cb);
      expect(cb).toHaveBeenCalledWith(SID, "running");
    });
  });

  // ─── Group 8: Completion pattern detection ──────────────────────────
  describe("completion pattern", () => {
    it("completion pattern triggers shorter done timeout (2s)", () => {
      const cb = vi.fn();
      processOutput(SID, "✓ Edited src/App.tsx (2s)", cb);
      // Should NOT be done yet at 1999ms
      vi.advanceTimersByTime(SHORT_DONE_TIMEOUT_MS - 1);
      expect(cb).not.toHaveBeenCalledWith(SID, "done");
      // Should be done at SHORT_DONE_TIMEOUT_MS
      vi.advanceTimersByTime(1);
      expect(cb).toHaveBeenCalledWith(SID, "done");
    });

    it("non-completion output uses full idle timeout", () => {
      const cb = vi.fn();
      processOutput(SID, "compiling files...", cb);
      vi.advanceTimersByTime(DONE_TIMEOUT_MS - 1);
      expect(cb).not.toHaveBeenCalledWith(SID, "done");
      vi.advanceTimersByTime(1);
      expect(cb).toHaveBeenCalledWith(SID, "done");
    });

    it("matches checkmark with fractional timing", () => {
      const cb = vi.fn();
      processOutput(SID, "✔ Wrote file.txt (0.5s)", cb);
      vi.advanceTimersByTime(SHORT_DONE_TIMEOUT_MS);
      expect(cb).toHaveBeenCalledWith(SID, "done");
    });
  });
});

// ── Idle / agent detection gate ──────────────────────────────────

describe("idle / agent detection gate", () => {
  it("starts in idle — plain shell output does not activate detection", () => {
    const cb = vi.fn();
    // Plain shell output: no agent signals
    processBufferLines(SID, ["PS C:\\Users\\ericm> cd"], 1, cb);
    processBufferLines(SID, ["PS C:\\Users\\ericm> ls"], 2, cb);
    // Should NOT transition — stays idle
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DONE_TIMEOUT_MS);
    expect(cb).not.toHaveBeenCalled();
  });

  it("token counter activates agent → transitions to running", () => {
    const cb = vi.fn();
    processBufferLines(SID, ["(3s, 1.2k tokens)"], 1, cb);
    expect(cb).toHaveBeenCalledWith(SID, "running");
  });

  it("completion checkmark activates agent → transitions to running", () => {
    const cb = vi.fn();
    processBufferLines(SID, ["✓ Edited src/App.tsx (2s)"], 1, cb);
    expect(cb).toHaveBeenCalledWith(SID, "running");
  });

  it("prompt ❯ activates agent → transitions to running", () => {
    const cb = vi.fn();
    processBufferLines(SID, ["❯ "], 1, cb);
    expect(cb).toHaveBeenCalledWith(SID, "running");
  });

  it("after agent activation, full state machine works normally", () => {
    const cb = vi.fn();
    // Activate via token counter
    processBufferLines(SID, ["(1s, 100 tokens)"], 1, cb);
    expect(cb).toHaveBeenCalledWith(SID, "running");
    cb.mockClear();

    // Now waiting pattern should work
    processBufferLines(SID, ["Do you want to proceed?"], 2, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("waiting pattern does NOT activate agent (prevents false positives from shell output)", () => {
    const cb = vi.fn();
    // Shell might output text matching a waiting pattern, but without
    // prior agent signals, it should stay idle
    processBufferLines(SID, ["Are you sure? (y/n)"], 1, cb);
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── Position-based delta detection (anti-flicker) ────────────────

describe("position-based delta detection", () => {
  it("same cursor position (cursor blink) resets idle timer but skips pattern matching", () => {
    const cb = vi.fn();
    activateAgent(cb);
    const lines = ["some output", "❯ "];

    // First read at cursorY=10: sets 500ms prompt-based done timeout + done dwell
    processBufferLines(SID, lines, 10, cb);
    vi.advanceTimersByTime(500 + DWELL_DONE);
    expect(cb).toHaveBeenCalledWith(SID, "done");
    cb.mockClear();

    // Second read at same cursorY=10 (cursor blink): should skip patterns
    // but reset idle timer (no false "running" transition)
    processBufferLines(SID, lines, 10, cb);
    vi.advanceTimersByTime(DONE_TIMEOUT_MS + DWELL_DONE);
    expect(cb).not.toHaveBeenCalledWith(SID, "running");
  });

  it("advanced cursor position processes new lines normally", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(SID, ["output line 1"], 10, cb);
    vi.advanceTimersByTime(500);

    // Cursor advanced — new content should be processed
    processBufferLines(SID, ["output line 1", "new output"], 11, cb);
    // Still running, so no callback (same status)
    expect(cb).not.toHaveBeenCalledWith(SID, "done");
  });

  it("position tracking is cleared on destroyDetector", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(SID, ["hello"], 10, cb);

    destroyDetector(SID);
    initDetector(SID);
    activateAgent(cb);

    // Same cursorY should be processed again after re-init (fresh state)
    processBufferLines(SID, ["hello"], 10, cb);
    vi.advanceTimersByTime(DONE_TIMEOUT_MS + DWELL_DONE);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("cursor position reset (terminal clear) reprocesses all lines", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(SID, ["some output"], 50, cb);
    vi.advanceTimersByTime(500);

    // Terminal cleared — cursorY dropped below previous
    processBufferLines(SID, ["(y/n)"], 0, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("cursor blink on running terminal resets idle timer correctly", () => {
    const cb = vi.fn();
    activateAgent(cb);
    // Initial output
    processBufferLines(SID, ["compiling..."], 10, cb);

    // 10s later, cursor blink (same position) — should reset timer
    vi.advanceTimersByTime(10000);
    processBufferLines(SID, ["compiling..."], 10, cb);

    // 10s after the blink — total 20s from first, but only 10s since blink reset
    vi.advanceTimersByTime(10000);
    expect(cb).not.toHaveBeenCalledWith(SID, "done");

    // 5 more seconds — now 15s since blink, idle fires → then dwell
    vi.advanceTimersByTime(5000);
    vi.advanceTimersByTime(DWELL_DONE);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });
});

// ── processBufferLines-specific tests ───────────────────────────

describe("processBufferLines", () => {
  it("token counter overrides waiting pattern in same scan window", () => {
    const cb = vi.fn();
    activateAgent(cb);
    // Both patterns visible in the same 15-line window — token counter should win
    processBufferLines(
      SID,
      [
        "Do you want to proceed (y/n)?",
        "processing...",
        "(3s, 1.2k tokens)",
      ],
      10,
      cb
    );
    expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
  });

  it("token counter overrides error pattern in same scan window", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(
      SID,
      [
        "Error: cannot find module",
        "(5s, 2.1k tokens)",
      ],
      10,
      cb
    );
    expect(cb).not.toHaveBeenCalledWith(SID, "error");
  });

  it("waiting pattern only matches in last 3 lines", () => {
    const cb = vi.fn();
    activateAgent(cb);
    // (y/n) is 8 lines back — outside the 3-line pattern scan window
    const lines = [
      "(y/n)",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9",
      "line 10",
    ];
    processBufferLines(SID, lines, 10, cb);
    // Pattern is outside last 3 lines → should NOT trigger waiting
    expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
  });

  it("waiting pattern in last 3 lines still triggers", () => {
    const cb = vi.fn();
    activateAgent(cb);
    const lines = [
      "some old output",
      "more old output",
      "Do you want to proceed?",
    ];
    processBufferLines(SID, lines, 10, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("prompt ❯ triggers fast done timeout (500ms + dwell)", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(SID, ["✓ Task completed (5s)", "❯ "], 10, cb);
    // 500ms idle timeout for prompt + DWELL_DONE dwell
    vi.advanceTimersByTime(500 + DWELL_DONE - 1);
    expect(cb).not.toHaveBeenCalledWith(SID, "done");
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("prompt ❯ with leading whitespace still matches", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(SID, ["  ❯ "], 10, cb);
    vi.advanceTimersByTime(500 + DWELL_DONE);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("token counter with numbered list does NOT set waiting timer", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(
      SID,
      [
        "  1. Allow",
        "  2. Deny",
        "(3s, 1.2k tokens)",
      ],
      10,
      cb
    );
    vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
    expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
  });
});

// ── Hybrid waiting detection (cursor blink + wide scan) ─────────

describe("hybrid waiting detection", () => {
  it("detects waiting on cursor blink (position unchanged) only when running", () => {
    const cb = vi.fn();
    activateAgent(cb);
    const lines = [
      "some output",
      "Do you want to proceed?",
    ];

    // First call at cursorAbsY=10 — status is "running", detects waiting
    processBufferLines(SID, lines, 10, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
    cb.mockClear();

    // Clear waiting → back to "running"
    clearWaiting(SID, cb);
    cb.mockClear();

    // Second call with same cursorAbsY=10 (cursor blink) while "running" — detects waiting
    processBufferLines(SID, lines, 10, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("does NOT detect waiting on cursor blink when status is done (anti-false-positive)", () => {
    const cb = vi.fn();
    activateAgent(cb);

    // Send output and advance to "done" state
    processBufferLines(SID, ["compiling..."], 10, cb);
    vi.advanceTimersByTime(DONE_TIMEOUT_MS + DWELL_DONE);
    expect(cb).toHaveBeenCalledWith(SID, "done");
    cb.mockClear();

    // Cursor blink with waiting pattern visible in buffer — should NOT trigger
    // because we're "done" (idle shell prompt, not an agent waiting for input)
    const linesWithPrompt = [
      "PS C:\\Users\\ericm> cd",
      "Do you want to proceed?", // old scrollback content
    ];
    processBufferLines(SID, linesWithPrompt, 10, cb);
    expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
  });

  it("detects waiting from done state via numbered list", () => {
    const cb = vi.fn();
    activateAgent(cb);

    // Send output and advance past idle timeout + dwell to reach "done"
    processBufferLines(SID, ["compiling..."], 10, cb);
    vi.advanceTimersByTime(DONE_TIMEOUT_MS + DWELL_DONE);
    expect(cb).toHaveBeenCalledWith(SID, "done");
    cb.mockClear();

    // Now send numbered list from "done" state
    processBufferLines(
      SID,
      ["Choose an option:", "  1. Allow", "  2. Deny"],
      12,
      cb
    );

    // Running dwell must fire first, then numbered list timer
    vi.advanceTimersByTime(DWELL_RUNNING);
    // Then advance past the numbered list timer (1500ms from processBufferLines call)
    // The numbered list timer was set at the same time as the running dwell,
    // so total time from processBufferLines = max(DWELL_RUNNING, PENDING_WAITING_DELAY_MS)
    vi.advanceTimersByTime(PENDING_WAITING_DELAY_MS);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("detects waiting with wide prompt (6+ lines)", () => {
    const cb = vi.fn();
    activateAgent(cb);
    // Realistic Claude Code prompt spanning 6 lines
    const lines = [
      "I'd like to edit src/App.tsx to add the new feature.",
      "",
      "Use the file editor to make changes?",
      "",
      "  1. Yes",
      "  2. No",
    ];
    processBufferLines(SID, lines, 10, cb);
    // The "Use the file editor" pattern should be detected within the 8-line window
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("new Claude Code patterns detected: Use the file editor", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(SID, ["Use the file editor to create the file?"], 10, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("new Claude Code patterns detected: Try to create a new file", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(SID, ["Try to create a new file?"], 10, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("new Claude Code patterns detected: Allow Read to access", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(SID, ["Allow Read to access the file?"], 10, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("new Claude Code patterns detected: Do you want to create", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(SID, ["Do you want to create this file?"], 10, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("new Claude Code patterns detected: May I proceed", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(SID, ["May I proceed with the changes?"], 10, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("new Claude Code patterns detected: Allow tool", () => {
    const cb = vi.fn();
    activateAgent(cb);
    processBufferLines(SID, ["Allow the Read tool to access this path?"], 10, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("cursor blink doesn't cause running→done flicker (regression)", () => {
    const cb = vi.fn();
    activateAgent(cb);
    // Initial output — running
    processBufferLines(SID, ["compiling..."], 10, cb);
    expect(cb).not.toHaveBeenCalled(); // still running

    // 3s later, cursor blink (same position, no prompt) — should reset idle timer
    vi.advanceTimersByTime(3000);
    processBufferLines(SID, ["compiling..."], 10, cb);

    // 3s after the blink (6s total) — should NOT be done yet (timer was reset)
    vi.advanceTimersByTime(3000);
    expect(cb).not.toHaveBeenCalledWith(SID, "done");

    // 12 more seconds (15s since blink reset) — idle fires, then dwell
    vi.advanceTimersByTime(12000);
    vi.advanceTimersByTime(DWELL_DONE);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("token counter suppresses waiting scan on cursor blink", () => {
    const cb = vi.fn();
    activateAgent(cb);
    // Lines contain both a token counter AND a waiting pattern
    const lines = [
      "Do you want to proceed?",
      "(3s, 1.2k tokens)",
    ];

    // First call
    processBufferLines(SID, lines, 10, cb);
    // Token counter suppresses waiting
    expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    cb.mockClear();

    // Second call at same position (cursor blink) — token counter should still suppress
    processBufferLines(SID, lines, 10, cb);
    expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
  });

  it("waiting pattern in 8-line window triggers (wider than 3-line error window)", () => {
    const cb = vi.fn();
    activateAgent(cb);
    // Place waiting pattern 6 lines back — inside 8-line window but outside 3-line error window
    const lines = [
      "old output line 1",
      "old output line 2",
      "Do you want to proceed?",
      "blank line",
      "  1. Yes",
      "  2. No",
      "  3. Always allow",
      "another line",
      "yet another line",
    ];
    processBufferLines(SID, lines, 10, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("error pattern outside 3-line window does NOT trigger", () => {
    const cb = vi.fn();
    activateAgent(cb);
    // Error pattern is 5 lines back — inside 8-line waiting window but outside 3-line error window
    const lines = [
      "Error: something went wrong",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
    ];
    processBufferLines(SID, lines, 10, cb);
    // Error should NOT be detected (it's outside the 3-line error scan window)
    expect(cb).not.toHaveBeenCalledWith(SID, "error");
  });
});
