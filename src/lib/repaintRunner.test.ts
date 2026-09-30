// The turn-end settle, driven with a fake terminal and fake timers (SWIT-103).
// The pure verdicts are tested in repaintPlan.test.ts / bufferSignals.test.ts;
// this walks the SEQUENCING Ky's ChatTerminal.test.tsx covers for its mount-
// scoped handler: what runs at a settle, what a deferred repaint waits for,
// what a rewrite does to the terminal and in what order, and the nudge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NARROW_NUDGE_MIN_MS } from "./bufferSignals";
import { DIRTY_OUTPUT_THRESHOLD, WHEEL_QUIET_MS } from "./repaintPlan";
import {
  REPAINT_DWELL_MS,
  REPAINT_SETTLE_MS,
  __resetRepaintForTests,
  configureRepaintIO,
  forgetRepaint,
  isRepaintRewriting,
  noteRepaintAgent,
  noteRepaintOutput,
  noteRepaintScroll,
  noteRepaintWheel,
  repaintDirtyBytes,
  requestRepaint,
  type RepaintTerminal,
} from "./repaintRunner";

const rule = (n: number) => "─".repeat(n);

/** claude at rest on the pinned grid: full-width rules around its input box. */
const IDLE_FRAME = ["● Done — the tests pass.", "", rule(100), "> ", rule(100), "  ? for shortcuts"];
const WORKING_FRAME = ["● Running the migration…", "", "✻ Churning… (12s · esc to interrupt)", rule(100), "> ", rule(100)];
const NARROW_FRAME = ["● this whole turn wrapped at", "  forty columns", rule(40), "> ", rule(40), "  ? for shortcuts"];

type Fake = {
  term: RepaintTerminal;
  calls: string[];
  /** Finish the rewrite's async parse. */
  finishWrite: () => void;
  set: (over: Partial<{ lines: string[]; laidOut: boolean; selecting: boolean; focused: boolean; viewportY: number; baseY: number; alt: boolean; cols: number; rows: number; serializeThrows: boolean }>) => void;
};

function fake(): Fake {
  const st = {
    lines: IDLE_FRAME,
    laidOut: true,
    selecting: false,
    focused: false,
    viewportY: 200,
    baseY: 200,
    alt: false,
    cols: 100,
    rows: 40,
    serializeThrows: false,
  };
  const calls: string[] = [];
  let done: (() => void) | null = null;
  const term: RepaintTerminal = {
    instance: {},
    get cols() {
      return st.cols;
    },
    get rows() {
      return st.rows;
    },
    buffer: {
      get active() {
        return {
          baseY: st.baseY,
          viewportY: st.viewportY,
          // The cursor sits on the input line; the frame ends below it.
          cursorY: Math.max(0, st.lines.length - 3),
          type: st.alt ? "alternate" : "normal",
          getLine: (y: number) => {
            const i = y - st.baseY;
            return i >= 0 && i < st.lines.length ? { translateToString: () => st.lines[i]! } : undefined;
          },
        };
      },
    },
    laidOut: () => st.laidOut,
    hasSelection: () => st.selecting,
    hasFocus: () => st.focused,
    focus: () => calls.push("focus"),
    serialize: () => {
      if (st.serializeThrows) throw new Error("serialize blew up");
      calls.push("serialize");
      return "SNAP";
    },
    setHidden: (hidden) => calls.push(hidden ? "hide" : "show"),
    reset: () => calls.push("reset"),
    resize: (c, r) => {
      calls.push(`resize ${c}x${r}`);
      st.cols = c;
      st.rows = r;
    },
    write: (data, cb) => {
      calls.push(`write ${data}`);
      done = cb;
    },
    refresh: () => calls.push("refresh"),
    scrollToBottom: () => {
      calls.push("scrollToBottom");
      st.viewportY = st.baseY;
    },
    scrollLines: (n) => {
      calls.push(`scrollLines ${n}`);
      st.viewportY += n;
    },
  };
  return {
    term,
    calls,
    finishWrite: () => {
      const cb = done;
      done = null;
      cb?.();
    },
    set: (over) => Object.assign(st, over),
  };
}

describe("repaintRunner", () => {
  let f: Fake;
  let live: boolean;
  let resyncs: string[];
  let bounces: string[];
  let lastBounce: number;
  let rewritten: string[];
  let settles: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    f = fake();
    live = true;
    resyncs = [];
    bounces = [];
    lastBounce = 0;
    rewritten = [];
    settles = [];
    configureRepaintIO({
      getTerminal: () => (live ? f.term : undefined),
      resyncViewport: (_id, cause) => resyncs.push(cause),
      bouncePty: (_id, cause) => {
        bounces.push(cause);
        return true;
      },
      lastBounceAt: () => lastBounce,
      onRewritten: (id) => rewritten.push(id),
      // Records how many terminal calls had been made when the settle fired.
      onSettle: () => settles.push(f.calls.length),
    });
  });

  afterEach(() => {
    __resetRepaintForTests();
    vi.useRealTimers();
  });

  const settleNow = () => vi.advanceTimersByTime(REPAINT_SETTLE_MS);
  const stream = (bytes = DIRTY_OUTPUT_THRESHOLD) => noteRepaintOutput("s1", bytes);

  describe("the settle", () => {
    it("a few echoed keystrokes touch nothing — no rewrite, no resync", () => {
      stream(40);
      settleNow();
      expect(f.calls).toEqual([]);
      expect(resyncs).toEqual([]);
      expect(repaintDirtyBytes("s1")).toBe(40);
    });

    it("a streamed turn gets the clean rewrite, in order, hidden for the parse", () => {
      stream();
      settleNow();
      expect(f.calls).toEqual(["serialize", "hide", "reset", "write SNAP"]);
      expect(isRepaintRewriting("s1")).toBe(true);
      expect(repaintDirtyBytes("s1")).toBe(0); // clean as of the snapshot

      f.finishWrite();
      expect(f.calls).toEqual([
        "serialize",
        "hide",
        "reset",
        "write SNAP",
        "scrollToBottom",
        "refresh",
        "show",
      ]);
      expect(isRepaintRewriting("s1")).toBe(false);
      expect(rewritten).toEqual(["s1"]);
      // …and the scroll range is re-measured over the re-laid buffer.
      expect(resyncs).toEqual(["rewrite"]);
    });

    it("never resizes on the pin — the grid is a constant", () => {
      stream();
      settleNow();
      f.finishWrite();
      expect(f.calls.some((c) => c.startsWith("resize"))).toBe(false);
    });

    it("output keeps pushing the settle out; nothing runs while it streams", () => {
      stream();
      vi.advanceTimersByTime(REPAINT_SETTLE_MS - 100);
      stream(10);
      vi.advanceTimersByTime(200);
      expect(f.calls).toEqual([]);
      settleNow();
      expect(f.calls).toContain("reset");
    });

    it("bytes that land during the parse count toward the NEXT settle", () => {
      stream();
      settleNow();
      stream(500); // queued behind the rewrite in xterm's write buffer
      f.finishWrite();
      expect(repaintDirtyBytes("s1")).toBe(500);
    });

    it("does nothing once the terminal is gone", () => {
      stream();
      live = false;
      settleNow();
      expect(f.calls).toEqual([]);
      expect(settles).toEqual([]);
    });

    it("tells the host about every settle, before a rewrite resets the buffer", () => {
      stream(10);
      settleNow();
      expect(settles).toEqual([0]); // a clean settle still counts
      stream();
      settleNow();
      expect(settles).toEqual([0, 0]); // no terminal call had happened yet
      expect(f.calls).toContain("reset");
    });
  });

  describe("deferring", () => {
    it("claude mid-turn: silence is not idleness — wait for the next settle", () => {
      f.set({ lines: WORKING_FRAME });
      stream();
      settleNow();
      expect(f.calls).toEqual([]);

      f.set({ lines: IDLE_FRAME });
      stream(10); // the turn's last bytes
      settleNow();
      expect(f.calls).toContain("reset");
    });

    it("a hidden terminal waits, and the pane that shows it runs the rewrite", () => {
      f.set({ laidOut: false });
      stream();
      settleNow();
      expect(f.calls).toEqual([]);

      f.set({ laidOut: true });
      requestRepaint("s1", "show");
      expect(f.calls).toEqual(["serialize", "hide", "reset", "write SNAP"]);
    });

    it("a layout change mid-stream is deferred to the settle", () => {
      stream();
      requestRepaint("s1", "ro");
      expect(f.calls).toEqual([]);
      expect(resyncs).toEqual([]);
      settleNow();
      expect(f.calls).toContain("reset");
    });

    it("a second repaint inside the parse window never serializes a half-written buffer", () => {
      stream();
      settleNow();
      const afterBegin = f.calls.length;
      requestRepaint("s1", "ro");
      expect(f.calls.length).toBe(afterBegin);
      f.finishWrite();
      expect(f.calls.filter((c) => c === "serialize")).toHaveLength(1);
    });

    it("the alternate screen and a live selection both hold the rewrite", () => {
      f.set({ alt: true });
      stream();
      settleNow();
      expect(f.calls).toEqual([]);

      f.set({ alt: false, selecting: true });
      requestRepaint("s1", "ro");
      expect(f.calls).toEqual([]);

      f.set({ selecting: false });
      requestRepaint("s1", "ro");
      expect(f.calls).toContain("reset");
    });
  });

  describe("the reader", () => {
    it("a scrolled-up viewport is sacred; the rewrite runs once they are back and have dwelt", () => {
      f.set({ viewportY: 150 }); // 50 rows above the bottom
      stream();
      settleNow();
      expect(f.calls).toEqual([]);

      // Still reading: a wheel tick above the bottom arms the dwell, which
      // finds them not at the bottom and does nothing.
      noteRepaintWheel("s1");
      vi.advanceTimersByTime(REPAINT_DWELL_MS);
      expect(f.calls).toEqual([]);

      // Back at the bottom, wheel still — the dwell flushes.
      f.set({ viewportY: 200 });
      noteRepaintWheel("s1");
      vi.advanceTimersByTime(REPAINT_DWELL_MS);
      expect(f.calls).toContain("reset");
    });

    it("a wheel still moving at the dwell re-arms it (bounded), then flushes", () => {
      f.set({ viewportY: 150 });
      stream();
      settleNow();
      f.set({ viewportY: 200 });
      noteRepaintWheel("s1"); // arms the dwell
      vi.advanceTimersByTime(REPAINT_DWELL_MS - 100);
      noteRepaintWheel("s1"); // still wheeling
      vi.advanceTimersByTime(100); // dwell fires: wheel-active → re-armed
      expect(f.calls).toEqual([]);
      vi.advanceTimersByTime(REPAINT_DWELL_MS);
      expect(f.calls).toContain("reset");
      expect(WHEEL_QUIET_MS).toBeLessThanOrEqual(REPAINT_DWELL_MS);
    });

    it("a terminal-side scroll back to the bottom arms the same dwell; leaving cancels it", () => {
      f.set({ viewportY: 150 });
      stream();
      settleNow();

      f.set({ viewportY: 200 });
      noteRepaintScroll("s1"); // e.g. scrollToBottom on typed input
      f.set({ viewportY: 190 });
      noteRepaintScroll("s1"); // left the bottom again
      vi.advanceTimersByTime(REPAINT_DWELL_MS * 2);
      expect(f.calls).toEqual([]);

      f.set({ viewportY: 200 });
      noteRepaintScroll("s1");
      vi.advanceTimersByTime(REPAINT_DWELL_MS);
      expect(f.calls).toContain("reset");
    });

    it("a wheel over a claude parked on a prompt polls nothing — that defer waits for a settle", () => {
      f.set({ lines: ["● Bash(git push)", "Do you want to proceed?", "❯ 1. Yes", "  2. No"] });
      noteRepaintAgent("s1");
      stream();
      settleNow(); // deferred: mid-turn
      f.set({ lines: IDLE_FRAME }); // answered, but no settle yet
      noteRepaintWheel("s1");
      noteRepaintScroll("s1");
      vi.advanceTimersByTime(REPAINT_DWELL_MS * 3);
      expect(f.calls).toEqual([]);
      stream(10);
      settleNow();
      expect(f.calls).toContain("reset");
    });

    it("a scroll with nothing pending arms nothing", () => {
      stream(10);
      settleNow();
      noteRepaintScroll("s1");
      vi.advanceTimersByTime(REPAINT_DWELL_MS * 2);
      expect(f.calls).toEqual([]);
      expect(resyncs).toEqual([]);
    });

    it("a reader who scrolled DURING the parse is kept near where they went, clamped to two screens", () => {
      stream();
      settleNow();
      f.set({ viewportY: 40 }); // wheeled up inside the parse window: 160 rows
      f.finishWrite();
      expect(f.calls).toContain("scrollLines -80");
      expect(f.calls.filter((c) => c === "scrollToBottom")).toHaveLength(1);
    });

    it("a short scroll during the parse is left exactly where it is", () => {
      stream();
      settleNow();
      f.set({ viewportY: 180 });
      f.finishWrite();
      expect(f.calls).not.toContain("scrollToBottom");
      expect(f.calls.some((c) => c.startsWith("scrollLines"))).toBe(false);
    });
  });

  describe("the rewrite", () => {
    it("gives focus back only when the terminal held it going in", () => {
      f.set({ focused: true });
      stream();
      settleNow();
      f.finishWrite();
      expect(f.calls[f.calls.length - 1]).toBe("focus");
    });

    it("does not take focus it never had (the composer keeps it)", () => {
      stream();
      settleNow();
      f.finishWrite();
      expect(f.calls).not.toContain("focus");
    });

    it("a session disposed inside the parse is unhidden and otherwise left alone", () => {
      f.set({ focused: true });
      stream();
      settleNow();
      live = false;
      f.finishWrite();
      expect(f.calls.slice(-1)).toEqual(["show"]);
      expect(f.calls).not.toContain("refresh");
      expect(f.calls).not.toContain("focus");
      expect(rewritten).toEqual([]);
      expect(resyncs).toEqual([]);
    });

    it("a throw before the write never leaves the pane hidden or the flag stuck", () => {
      f.set({ serializeThrows: true });
      stream();
      settleNow();
      expect(f.calls).toEqual(["show"]);
      expect(isRepaintRewriting("s1")).toBe(false);
    });

    it("is the one path back onto the pin if the grid ever drifted", () => {
      f.set({ cols: 84 });
      requestRepaint("s1", "ro"); // clean buffer, off the pin
      expect(f.calls).toEqual(["serialize", "hide", "reset", "resize 100x40", "write SNAP"]);
    });
  });

  describe("the resync", () => {
    it("a layout change on a clean buffer only re-measures the scroll range", () => {
      requestRepaint("s1", "ro");
      expect(resyncs).toEqual(["ro"]);
      expect(f.calls).toEqual([]);
    });

    it("runs under a scrolled-up reader too — it cannot move them", () => {
      f.set({ viewportY: 10 });
      requestRepaint("s1", "show");
      expect(resyncs).toEqual(["show"]);
    });
  });

  describe("the narrow-frame nudge", () => {
    it("bounces the PTY rows when claude's rules are narrower than the grid", () => {
      f.set({ lines: NARROW_FRAME });
      stream(10);
      settleNow();
      expect(bounces).toEqual(["narrow-nudge"]);
    });

    it("leaves a full-width frame and a plain shell alone", () => {
      stream(10);
      settleNow();
      f.set({ lines: ["PS C:\\projects> git status", "On branch main", "PS C:\\projects> "] });
      stream(10);
      settleNow();
      expect(bounces).toEqual([]);
    });

    it("is read off the intact screen even when the same settle starts a rewrite", () => {
      f.set({ lines: NARROW_FRAME });
      stream();
      settleNow();
      expect(f.calls).toContain("reset");
      expect(bounces).toEqual(["narrow-nudge"]);
    });

    it("never nudges a claude that is mid-turn", () => {
      f.set({ lines: ["✻ Churning… (esc to interrupt)", rule(40), "> ", rule(40)] });
      stream(10);
      settleNow();
      expect(bounces).toEqual([]);
    });

    it("waits out the floor between nudges — the bounce's own repaint settles too", () => {
      f.set({ lines: NARROW_FRAME });
      stream(10);
      settleNow();
      stream(10); // claude's repaint, still narrow for some other reason
      settleNow();
      expect(bounces).toHaveLength(1);

      vi.advanceTimersByTime(NARROW_NUDGE_MIN_MS);
      stream(10);
      settleNow();
      expect(bounces).toHaveLength(2);
    });

    it("a resume-heal bounce counts against the same floor", () => {
      f.set({ lines: NARROW_FRAME });
      lastBounce = Date.now() - 2_000; // the heal bounced two seconds ago
      stream(10);
      settleNow();
      expect(bounces).toEqual([]);
    });
  });

  describe("a session no agent has drawn in", () => {
    const SHELL = ["PS C:\\projects> pnpm dev", "  VITE v6.0.0  ready in 412 ms", "  ➜  Local: http://localhost:5173/"];

    it("is never rewritten, however much it prints — a log tail must not blink", () => {
      f.set({ lines: SHELL });
      stream(500_000);
      settleNow();
      expect(f.calls).toEqual([]);
      // A pane resize still only re-syncs.
      requestRepaint("s1", "ro");
      expect(f.calls).toEqual([]);
      expect(resyncs).toEqual(["ro"]);
    });

    it("is never nudged, even when it prints a short rule", () => {
      f.set({ lines: ["PS C:\\projects> pnpm test", rule(60), " Test Files  59 passed", "PS C:\\projects> "] });
      stream(10);
      settleNow();
      expect(bounces).toEqual([]);
    });

    it("becomes an agent session when the status detector says so", () => {
      f.set({ lines: SHELL });
      stream(500_000);
      noteRepaintAgent("s1");
      settleNow();
      expect(f.calls).toContain("reset");
    });

    it("becomes one when claude's frame shows up on screen, and stays one after it leaves", () => {
      f.set({ lines: SHELL });
      stream(10);
      settleNow();
      f.set({ lines: IDLE_FRAME });
      stream(10);
      settleNow(); // claude's frame seen — still under the threshold
      expect(f.calls).toEqual([]);

      f.set({ lines: SHELL }); // claude exited back to the shell
      stream();
      settleNow();
      expect(f.calls).toContain("reset");
    });
  });

  describe("forgetting", () => {
    it("drops the dirty count and every armed timer", () => {
      stream();
      forgetRepaint("s1");
      settleNow();
      expect(f.calls).toEqual([]);
      expect(repaintDirtyBytes("s1")).toBe(0);
    });

    it("a dwell armed before the forget does nothing after it", () => {
      f.set({ viewportY: 150 });
      stream();
      settleNow();
      f.set({ viewportY: 200 });
      noteRepaintWheel("s1");
      forgetRepaint("s1");
      vi.advanceTimersByTime(REPAINT_DWELL_MS * 2);
      expect(f.calls).toEqual([]);
    });
  });
});
