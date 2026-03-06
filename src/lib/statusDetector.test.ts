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
    // But timer should be set — advance past 8s and check
    vi.advanceTimersByTime(8000);
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

  it("running → 8s idle → 'done' + callback fires", () => {
    const cb = vi.fn();
    processOutput(SID, "compiling...", cb);
    expect(cb).not.toHaveBeenCalled(); // still running
    vi.advanceTimersByTime(8000);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("waiting → 8s idle → stays 'waiting' (timer doesn't override)", () => {
    const cb = vi.fn();
    processOutput(SID, "(y/n)", cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
    cb.mockClear();
    vi.advanceTimersByTime(8000);
    // Timer checks s.currentStatus === "running" — it's "waiting" so no-op
    expect(cb).not.toHaveBeenCalled();
  });

  it("done → new output → 'running' + callback fires", () => {
    const cb = vi.fn();
    processOutput(SID, "compiling...", cb);
    vi.advanceTimersByTime(8000);
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
  it("output resets the 8s timer", () => {
    const cb = vi.fn();
    processOutput(SID, "line 1", cb);
    vi.advanceTimersByTime(5000);
    processOutput(SID, "line 2", cb); // resets timer
    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled(); // only 5s since last output
    vi.advanceTimersByTime(3000); // now 8s since line 2
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("rapid output — only one timer active", () => {
    const cb = vi.fn();
    processOutput(SID, "a", cb);
    processOutput(SID, "b", cb);
    processOutput(SID, "c", cb);
    vi.advanceTimersByTime(8000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("timer fires after exactly DONE_TIMEOUT_MS (8000)", () => {
    const cb = vi.fn();
    processOutput(SID, "output", cb);
    vi.advanceTimersByTime(7999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("timer does not fire if new output arrives before timeout", () => {
    const cb = vi.fn();
    processOutput(SID, "output 1", cb);
    vi.advanceTimersByTime(7000);
    processOutput(SID, "output 2", cb);
    vi.advanceTimersByTime(7000);
    // 7s since "output 2" — no done yet
    expect(cb).not.toHaveBeenCalled();
  });

  it("non-meaningful output does NOT reset timer", () => {
    const cb = vi.fn();
    processOutput(SID, "real output", cb);
    vi.advanceTimersByTime(5000);
    processOutput(SID, "\x1b[1;1H", cb); // just cursor move
    vi.advanceTimersByTime(3000); // 8s since "real output"
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
      vi.advanceTimersByTime(1500);
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
    });

    it("detects 3-option list + silence as waiting", () => {
      const cb = vi.fn();
      processOutput(SID, "Choose:\n  1. Allow\n  2. Deny\n  3. Always allow\n", cb);
      vi.advanceTimersByTime(1500);
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
    });

    it("detects 4-option list + silence as waiting", () => {
      const cb = vi.fn();
      processOutput(
        SID,
        "Select:\n  1. Allow once\n  2. Allow always\n  3. Deny\n  4. Skip\n",
        cb
      );
      vi.advanceTimersByTime(1500);
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
      vi.advanceTimersByTime(1500);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("does not match non-consecutive numbers", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. First\n  3. Third\n", cb);
      vi.advanceTimersByTime(1500);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("does not match list not starting from 1", () => {
      const cb = vi.fn();
      processOutput(SID, "  2. Second\n  3. Third\n", cb);
      vi.advanceTimersByTime(1500);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("does not match numbers > 4", () => {
      const cb = vi.fn();
      // Trailing "5. E" breaks the backward scan, so no valid list detected
      processOutput(SID, "  1. A\n  2. B\n  3. C\n  4. D\n  5. E\n", cb);
      vi.advanceTimersByTime(1500);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });
  });

  // ─── Group 3: Chunk boundaries ─────────────────────────────────────
  describe("chunk boundaries", () => {
    it("detects list split across 2 chunks", () => {
      const cb = vi.fn();
      processOutput(SID, "Permission needed:\n  1. Allow\n", cb);
      processOutput(SID, "  2. Deny\n", cb);
      vi.advanceTimersByTime(1500);
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
    });

    it("detects list split across 3 chunks", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. Yes\n", cb);
      processOutput(SID, "  2. No\n", cb);
      processOutput(SID, "  3. Always\n", cb);
      vi.advanceTimersByTime(1500);
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
    });

    it("resets timer when additional numbered item arrives", () => {
      const cb = vi.fn();
      processOutput(SID, "Question:\n  1. Yes\n  2. No\n", cb);
      // Timer started. 800ms later, a 3rd option arrives (also a numbered item,
      // so the old timer is NOT cancelled by the "non-numbered output" check,
      // but a new timer is started because the list still trails)
      vi.advanceTimersByTime(800);
      processOutput(SID, "  3. Maybe\n", cb);
      // Wait for original timer to fire (1500ms from first processOutput)
      vi.advanceTimersByTime(800);
      // The first timer may have fired — that's OK. Check final state after
      // the second timer also fires.
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
      vi.advanceTimersByTime(1500);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("clears recentLines so old lines don't combine with new", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. Yes\n", cb);
      clearWaiting(SID, cb);
      // Now send just "2. No" — should NOT match because buffer was cleared
      processOutput(SID, "  2. No\n", cb);
      vi.advanceTimersByTime(1500);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });
  });

  // ─── Group 5: Legacy pattern interaction ───────────────────────────
  describe("legacy pattern interaction", () => {
    it("legacy waiting pattern takes priority over numbered list timer", () => {
      const cb = vi.fn();
      processOutput(SID, "Do you want to proceed (y/n)?\n  1. Yes\n  2. No\n", cb);
      // Should be immediately waiting via legacy pattern, no timer needed
      expect(cb).toHaveBeenCalledWith(SID, "waiting");
    });

    it("does not fire duplicate waiting when already waiting via legacy", () => {
      const cb = vi.fn();
      processOutput(SID, "Are you sure?\n  1. Yes\n  2. No\n", cb);
      const waitingCalls = cb.mock.calls.filter(
        (c) => c[1] === "waiting"
      ).length;
      vi.advanceTimersByTime(1500);
      // Should not get an additional waiting transition
      const afterCalls = cb.mock.calls.filter(
        (c) => c[1] === "waiting"
      ).length;
      expect(afterCalls).toBe(waitingCalls);
    });

    it("markExited cancels pending timer", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. Allow\n  2. Deny\n", cb);
      markExited(SID, cb);
      vi.advanceTimersByTime(1500);
      const lastCall = cb.mock.calls[cb.mock.calls.length - 1];
      expect(lastCall).toEqual([SID, "exited"]);
      expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
    });

    it("destroyDetector cancels pending timer without crash", () => {
      const cb = vi.fn();
      processOutput(SID, "  1. Allow\n  2. Deny\n", cb);
      destroyDetector(SID);
      expect(() => vi.advanceTimersByTime(1500)).not.toThrow();
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
      vi.advanceTimersByTime(1999);
      expect(cb).not.toHaveBeenCalledWith(SID, "done");
      // Should be done at 2000ms
      vi.advanceTimersByTime(1);
      expect(cb).toHaveBeenCalledWith(SID, "done");
    });

    it("non-completion output uses full 8s timeout", () => {
      const cb = vi.fn();
      processOutput(SID, "compiling files...", cb);
      vi.advanceTimersByTime(7999);
      expect(cb).not.toHaveBeenCalledWith(SID, "done");
      vi.advanceTimersByTime(1);
      expect(cb).toHaveBeenCalledWith(SID, "done");
    });

    it("matches checkmark with fractional timing", () => {
      const cb = vi.fn();
      processOutput(SID, "✔ Wrote file.txt (0.5s)", cb);
      vi.advanceTimersByTime(2000);
      expect(cb).toHaveBeenCalledWith(SID, "done");
    });
  });
});

// ── processBufferLines-specific tests ───────────────────────────

describe("processBufferLines", () => {
  it("token counter overrides waiting pattern in same scan window", () => {
    const cb = vi.fn();
    // Both patterns visible in the same 15-line window — token counter should win
    processBufferLines(
      SID,
      [
        "Do you want to proceed (y/n)?",
        "processing...",
        "(3s, 1.2k tokens)",
      ],
      cb
    );
    expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
  });

  it("token counter overrides error pattern in same scan window", () => {
    const cb = vi.fn();
    processBufferLines(
      SID,
      [
        "Error: cannot find module",
        "(5s, 2.1k tokens)",
      ],
      cb
    );
    expect(cb).not.toHaveBeenCalledWith(SID, "error");
  });

  it("waiting pattern only matches in last 3 lines", () => {
    const cb = vi.fn();
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
    processBufferLines(SID, lines, cb);
    // Pattern is outside last 3 lines → should NOT trigger waiting
    expect(cb).not.toHaveBeenCalledWith(SID, "waiting");
  });

  it("waiting pattern in last 3 lines still triggers", () => {
    const cb = vi.fn();
    const lines = [
      "some old output",
      "more old output",
      "Do you want to proceed?",
    ];
    processBufferLines(SID, lines, cb);
    expect(cb).toHaveBeenCalledWith(SID, "waiting");
  });

  it("prompt ❯ triggers fast done timeout (500ms)", () => {
    const cb = vi.fn();
    processBufferLines(SID, ["✓ Task completed (5s)", "❯ "], cb);
    vi.advanceTimersByTime(499);
    expect(cb).not.toHaveBeenCalledWith(SID, "done");
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });

  it("prompt ❯ with leading whitespace still matches", () => {
    const cb = vi.fn();
    processBufferLines(SID, ["  ❯ "], cb);
    vi.advanceTimersByTime(500);
    expect(cb).toHaveBeenCalledWith(SID, "done");
  });
});
