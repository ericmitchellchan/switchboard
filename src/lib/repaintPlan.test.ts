// The turn-end clean-repaint decision (planRepaint) — Ky's tests (CC-591,
// CC-685), ported with the planner (SWIT-103). Every branch: the defer guards
// (in precedence order), the clean-buffer resync fast path, and the
// full-rewrite verdicts. The grid is FULLY pinned — cols and rows — so the
// pane's measured size never enters the decision: the planner either resyncs,
// rewrites at the pin, or defers. A "rows follow the pane" verdict of any kind
// is a revert.

import { describe, expect, it } from "vitest";
import {
  DIRTY_OUTPUT_THRESHOLD,
  WHEEL_QUIET_MS,
  planRepaint,
  type RepaintInput,
} from "./repaintPlan";

/** A baseline that reaches the rewrite decision: idle, laid out, on the pin;
 *  tests override the field under test. */
const base = (over: Partial<RepaintInput> = {}): RepaintInput => ({
  streaming: false,
  refitting: false,
  laidOut: true,
  midTurn: false,
  current: { cols: 100, rows: 40 },
  pinnedCols: 100,
  pinnedRows: 40,
  dirtyBytes: 0,
  readerFromBottom: 0,
  msSinceWheel: 60_000,
  ...over,
});

describe("planRepaint — defer guards", () => {
  it("never touches the terminal while claude streams", () => {
    expect(planRepaint(base({ streaming: true, dirtyBytes: 999_999 }))).toEqual({
      action: "defer",
      why: "streaming",
    });
  });

  it("defers while a prior rewrite's async parse is in flight", () => {
    expect(planRepaint(base({ refitting: true, dirtyBytes: 999_999 }))).toEqual({
      action: "defer",
      why: "refitting",
    });
  });

  it("defers when the host isn't laid out (a hidden rewrite records a zero-height viewport)", () => {
    expect(planRepaint(base({ laidOut: false, dirtyBytes: 999_999 }))).toEqual({
      action: "defer",
      why: "not-laid-out",
    });
  });

  it("defers on a mid-turn marker even when output is silent (permission prompt / long tool)", () => {
    expect(planRepaint(base({ midTurn: true, dirtyBytes: 999_999 }))).toEqual({
      action: "defer",
      why: "mid-turn",
    });
  });

  it("never rewrites under a scrolled-up reader (their viewport is sacred)", () => {
    expect(
      planRepaint(base({ dirtyBytes: DIRTY_OUTPUT_THRESHOLD, readerFromBottom: 12 }))
    ).toEqual({ action: "defer", why: "reader-scrolled-up" });
    // Same for a back-onto-the-pin rewrite, not just a dirty one.
    expect(
      planRepaint(base({ current: { cols: 84, rows: 40 }, readerFromBottom: 3 }))
    ).toEqual({ action: "defer", why: "reader-scrolled-up" });
  });

  it("never rewrites while the reader's wheel moved within the quiet window", () => {
    expect(
      planRepaint(
        base({ dirtyBytes: DIRTY_OUTPUT_THRESHOLD, msSinceWheel: WHEEL_QUIET_MS - 1 })
      )
    ).toEqual({ action: "defer", why: "wheel-active" });
  });

  it("does NOT apply the reader guards to the non-destructive resync", () => {
    expect(planRepaint(base({ readerFromBottom: 12, msSinceWheel: 0 }))).toEqual({
      action: "resync",
    });
  });
});

describe("planRepaint — the fully pinned grid (CC-685)", () => {
  it("resyncs (only) on the pin with a clean buffer — a pane resize changes NOTHING", () => {
    expect(planRepaint(base())).toEqual({ action: "resync" });
  });

  it("stays clean under the dirty threshold (keystroke echoes don't blink the pane)", () => {
    expect(planRepaint(base({ dirtyBytes: DIRTY_OUTPUT_THRESHOLD - 1 }))).toEqual({
      action: "resync",
    });
  });

  it("rewrites on a dirty buffer at the PINNED grid — the turn-end scar wipe, no SIGWINCH", () => {
    expect(planRepaint(base({ dirtyBytes: DIRTY_OUTPUT_THRESHOLD }))).toEqual({
      action: "rewrite",
      cols: 100,
      rows: 40,
    });
  });

  it("rewrites back onto the pin if the grid ever drifted off it — cols or rows", () => {
    expect(planRepaint(base({ current: { cols: 84, rows: 40 } }))).toEqual({
      action: "rewrite",
      cols: 100,
      rows: 40,
    });
    expect(planRepaint(base({ current: { cols: 100, rows: 31 } }))).toEqual({
      action: "rewrite",
      cols: 100,
      rows: 40,
    });
  });

  it("allows the rewrite at exactly the wheel-quiet boundary", () => {
    expect(
      planRepaint(base({ dirtyBytes: DIRTY_OUTPUT_THRESHOLD, msSinceWheel: WHEEL_QUIET_MS }))
    ).toEqual({ action: "rewrite", cols: 100, rows: 40 });
  });
});

// Three guards beyond Ky's planner (SWIT-103): our terminals also run plain
// shells, so a session may have no agent in it at all, a full-screen program
// can own the alternate buffer at a settle, and a reset would clear a
// selection the reader is dragging out.
describe("planRepaint — a session no agent has drawn in", () => {
  it("is never dirty: a shell's output only ever gets the resync", () => {
    expect(planRepaint(base({ agent: false, dirtyBytes: 5_000_000 }))).toEqual({
      action: "resync",
    });
  });

  it("an absent flag reads as an agent session (Ky's planner, unchanged)", () => {
    expect(planRepaint(base({ dirtyBytes: DIRTY_OUTPUT_THRESHOLD }))).toEqual({
      action: "rewrite",
      cols: 100,
      rows: 40,
    });
    expect(planRepaint(base({ agent: true, dirtyBytes: DIRTY_OUTPUT_THRESHOLD }))).toEqual({
      action: "rewrite",
      cols: 100,
      rows: 40,
    });
  });

  it("still goes back onto the pin — a drifted grid is wrong for any session", () => {
    expect(planRepaint(base({ agent: false, current: { cols: 120, rows: 30 } }))).toEqual({
      action: "rewrite",
      cols: 100,
      rows: 40,
    });
  });
});

describe("planRepaint — the alternate screen and a live selection", () => {
  it("defers while a full-screen program owns the alternate buffer", () => {
    expect(planRepaint(base({ altScreen: true, dirtyBytes: 999_999 }))).toEqual({
      action: "defer",
      why: "alt-screen",
    });
    // Even a clean buffer: there is no history to re-sync under vim.
    expect(planRepaint(base({ altScreen: true }))).toEqual({ action: "defer", why: "alt-screen" });
  });

  it("a mid-turn marker outranks the alternate screen (claude's own editor)", () => {
    expect(planRepaint(base({ midTurn: true, altScreen: true }))).toEqual({
      action: "defer",
      why: "mid-turn",
    });
  });

  it("never rewrites under a selection", () => {
    expect(
      planRepaint(base({ dirtyBytes: DIRTY_OUTPUT_THRESHOLD, selecting: true }))
    ).toEqual({ action: "defer", why: "selecting" });
  });

  it("a selection does not block the non-destructive resync", () => {
    expect(planRepaint(base({ selecting: true }))).toEqual({ action: "resync" });
  });

  it("reports the reader's scroll before the selection", () => {
    expect(
      planRepaint(
        base({ dirtyBytes: DIRTY_OUTPUT_THRESHOLD, selecting: true, readerFromBottom: 4 })
      )
    ).toEqual({ action: "defer", why: "reader-scrolled-up" });
  });
});
