import { describe, expect, it } from "vitest";
import {
  FOLLOW_UP_ROWS,
  PARK_MARGIN_ROWS,
  followScrollTop,
  isFollowing,
  isTypedInput,
  parkTarget,
  routeWheelToHost,
  type HostGeometry,
} from "./hostPark";

// A 40-row grid at 13px × 1.3 line height, in a pane that shows 30 rows.
const ROW = 16.9;
const GRID = 40 * ROW; // 676
const PANE = 30 * ROW; // 507

const geo = (over: Partial<HostGeometry> = {}): HostGeometry => ({
  scrollHeight: GRID,
  clientHeight: PANE,
  rowHeight: ROW,
  cursorY: 39,
  lastContentRow: 39,
  ...over,
});

describe("parkTarget", () => {
  it("a full screen parks at the true bottom (Ky's park)", () => {
    expect(parkTarget(geo())).toBe(GRID - PANE);
  });

  it("a fresh shell — prompt on row 1 — parks at the top, not over blank rows", () => {
    expect(parkTarget(geo({ cursorY: 0, lastContentRow: 0 }))).toBe(0);
  });

  it("puts the content's bottom, plus a row of air, at the pane's bottom edge", () => {
    // Content down to row index 33 → 34 rows + 1 of air = 35 rows; the pane
    // shows 30, so 5 rows are scrolled off the top.
    const target = parkTarget(geo({ cursorY: 30, lastContentRow: 33 }));
    expect(target).toBe(Math.ceil((33 + 1 + PARK_MARGIN_ROWS) * ROW - PANE));
    expect(target).toBeGreaterThan(4 * ROW);
    expect(target).toBeLessThanOrEqual(5 * ROW + 1);
  });

  it("takes the LOWER of the cursor and the last text row (claude's footer sits under its cursor)", () => {
    const footerBelow = parkTarget(geo({ cursorY: 34, lastContentRow: 37 }));
    const cursorBelow = parkTarget(geo({ cursorY: 37, lastContentRow: 34 }));
    expect(footerBelow).toBe(cursorBelow);
  });

  it("is null when the pane fits the grid (nothing to scroll)", () => {
    expect(parkTarget(geo({ clientHeight: GRID }))).toBeNull();
    expect(parkTarget(geo({ clientHeight: GRID + 200, scrollHeight: GRID + 200 }))).toBeNull();
    // A sub-pixel slack is not a scroller.
    expect(parkTarget(geo({ clientHeight: GRID - 0.5 }))).toBeNull();
  });

  it("is null while the renderer has not measured a row", () => {
    expect(parkTarget(geo({ rowHeight: 0 }))).toBeNull();
    expect(parkTarget(geo({ rowHeight: Number.NaN }))).toBeNull();
  });

  it("an empty screen parks at the top", () => {
    expect(parkTarget(geo({ cursorY: 0, lastContentRow: -1 }))).toBe(0);
  });
});

describe("followScrollTop", () => {
  it("scrolls down as soon as content goes below the fold — mid-stream too", () => {
    expect(followScrollTop(120, 60, ROW, false)).toBe(120);
    expect(followScrollTop(120, 60, ROW, true)).toBe(120);
  });

  it("holds when the content's bottom rises a little (a spinner line came and went)", () => {
    const top = 5 * ROW;
    expect(followScrollTop(top - 3 * ROW, top, ROW, true)).toBe(top);
    expect(followScrollTop(top - FOLLOW_UP_ROWS * ROW, top, ROW, true)).toBe(top);
  });

  it("never scrolls UP mid-stream — a frame caught between erase and redraw is not a collapse", () => {
    expect(followScrollTop(0, GRID - PANE, ROW, false)).toBe(GRID - PANE);
  });

  it("scrolls up once output has settled and the content really collapsed (a clear)", () => {
    expect(followScrollTop(0, GRID - PANE, ROW, true)).toBe(0);
  });

  it("is a no-op on the target", () => {
    expect(followScrollTop(84, 84, ROW, false)).toBe(84);
    expect(followScrollTop(84, 84, ROW, true)).toBe(84);
  });
});

describe("isFollowing", () => {
  it("holds at the target and below it", () => {
    expect(isFollowing(100, 100, ROW)).toBe(true);
    expect(isFollowing(100, 169, ROW)).toBe(true);
  });

  it("tolerates less than a row above the target", () => {
    expect(isFollowing(100, 100 - ROW + 1, ROW)).toBe(true);
  });

  it("ends once the reader scrolled the pane up past it", () => {
    expect(isFollowing(100, 100 - ROW - 1, ROW)).toBe(false);
    expect(isFollowing(169, 0, ROW)).toBe(false);
  });
});

describe("isTypedInput", () => {
  it("printable keys, Enter, Backspace and Ctrl+key are typing", () => {
    expect(isTypedInput("a")).toBe(true);
    expect(isTypedInput("\r")).toBe(true);
    expect(isTypedInput("\x7f")).toBe(true);
    expect(isTypedInput("\x03")).toBe(true);
  });

  it("a paste into the terminal parks like typing — bracketed or plain", () => {
    expect(isTypedInput("\x1b[200~git status\rls\x1b[201~")).toBe(true);
    expect(isTypedInput("\x1b[200~\x1b[201~")).toBe(true);
    expect(isTypedInput("pasted without brackets\r")).toBe(true);
  });

  it("nothing is not input", () => {
    expect(isTypedInput("")).toBe(false);
  });

  it("what the terminal answers by itself is not typing — focus, mouse and cursor reports", () => {
    expect(isTypedInput("\x1b[I")).toBe(false); // focus in
    expect(isTypedInput("\x1b[O")).toBe(false); // focus out
    expect(isTypedInput("\x1b[<0;12;7M")).toBe(false); // SGR mouse
    expect(isTypedInput("\x1b[24;80R")).toBe(false); // cursor position report
  });

  it("arrow and function keys are left out with them", () => {
    expect(isTypedInput("\x1b[A")).toBe(false);
    expect(isTypedInput("\x1bOP")).toBe(false);
  });

  it("text typed right after a paste still counts", () => {
    expect(isTypedInput("\x1b[200~pasted\x1b[201~\r")).toBe(true);
  });
});

describe("routeWheelToHost (Ky CC-689)", () => {
  const slack = GRID - PANE;

  it("a pane that fits the grid never takes a tick", () => {
    expect(routeWheelToHost({ deltaY: 100, slack: 0, scrollTop: 0, xtermAtBottom: true })).toBeNull();
    expect(routeWheelToHost({ deltaY: -100, slack: 1, scrollTop: 0, xtermAtBottom: true })).toBeNull();
  });

  it("wheel-down: xterm's history first, then the pane", () => {
    expect(routeWheelToHost({ deltaY: 100, slack, scrollTop: 0, xtermAtBottom: false })).toBeNull();
    expect(routeWheelToHost({ deltaY: 100, slack, scrollTop: 0, xtermAtBottom: true })).toBe(100);
  });

  it("wheel-down at the pane's bottom goes back to xterm (nothing left to reveal)", () => {
    expect(routeWheelToHost({ deltaY: 100, slack, scrollTop: slack, xtermAtBottom: true })).toBeNull();
  });

  it("wheel-up: the pane first while it has room, then xterm's history", () => {
    expect(routeWheelToHost({ deltaY: -100, slack, scrollTop: 60, xtermAtBottom: true })).toBe(0);
    expect(routeWheelToHost({ deltaY: -30, slack, scrollTop: 60, xtermAtBottom: false })).toBe(30);
    expect(routeWheelToHost({ deltaY: -100, slack, scrollTop: 0, xtermAtBottom: true })).toBeNull();
  });

  it("clamps into the pane's range", () => {
    expect(routeWheelToHost({ deltaY: 900, slack, scrollTop: 10, xtermAtBottom: true })).toBe(slack);
  });

  it("ignores a horizontal-only tick", () => {
    expect(routeWheelToHost({ deltaY: 0, slack, scrollTop: 10, xtermAtBottom: true })).toBeNull();
  });
});
