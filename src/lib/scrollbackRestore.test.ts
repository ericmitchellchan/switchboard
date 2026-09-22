// SWIT-93: restoring a serialized frame must not hand the new session the old
// cursor position, and the tail cap must never split a row or a character.

import { describe, it, expect } from "vitest";
import {
  capSerialized,
  readRestoreGeometry,
  restoreSettleSequence,
  type BufferLike,
} from "./scrollbackRestore";

const ESC = "\x1b";

describe("capSerialized", () => {
  it("returns short content untouched", () => {
    expect(capSerialized("a\r\nb", 100)).toBe("a\r\nb");
  });

  it("cuts at the first row boundary inside the tail, never mid-row", () => {
    const rows = ["row one", "row two", "row three", "row four"];
    const content = rows.join("\r\n");
    // A cap that lands in the middle of "row two" keeps "row three" onward.
    const out = capSerialized(content, "wo\r\nrow three\r\nrow four".length);
    expect(out).toBe("row three\r\nrow four");
  });

  it("never lands inside an escape sequence at the cut", () => {
    const styled = `${ESC}[38;2;10;20;30mcoloured text${ESC}[0m`;
    const content = `first\r\n${styled}\r\nlast`;
    // Cap so the raw cut would land inside the SGR sequence.
    const rawCut = content.length - (content.indexOf("38;2") + 2);
    const out = capSerialized(content, rawCut);
    expect(out).toBe("last");
  });

  it("with no row boundary in the tail, does not split a surrogate pair", () => {
    const emoji = "😀"; // two UTF-16 units: indices 3 (high) and 4 (low)
    const content = "abc" + emoji + "def"; // length 8
    // A cap of 4 would start on the low surrogate (index 4); it steps past it.
    const start = content.length - 4;
    expect(content.charCodeAt(start)).toBeGreaterThanOrEqual(0xdc00);
    expect(capSerialized(content, 4)).toBe("def");
    // A cap of 5 starts on the high surrogate and keeps the whole character.
    expect(capSerialized(content, 5)).toBe(emoji + "def");
  });

  it("a zero or negative cap yields nothing", () => {
    expect(capSerialized("abc", 0)).toBe("");
    expect(capSerialized("abc", -1)).toBe("");
  });
});

describe("restoreSettleSequence", () => {
  it("resets attributes, moves to the last content row and opens a fresh line", () => {
    // 40-row viewport, content down to row 30, cursor parked up at row 26
    // (claude's input box) — the screenshot's shape.
    expect(restoreSettleSequence({ rows: 40, cursorY: 26, lastContentRow: 30 })).toBe(
      `${ESC}[0m${ESC}[31;1H\r\n`
    );
  });

  it("uses the cursor row when it already sits below the content", () => {
    expect(restoreSettleSequence({ rows: 40, cursorY: 35, lastContentRow: 30 })).toBe(
      `${ESC}[0m${ESC}[36;1H\r\n`
    );
  });

  it("an empty buffer still opens a fresh line from row 1", () => {
    expect(restoreSettleSequence({ rows: 40, cursorY: 0, lastContentRow: -1 })).toBe(
      `${ESC}[0m${ESC}[1;1H\r\n`
    );
  });

  it("clamps to the viewport", () => {
    expect(restoreSettleSequence({ rows: 10, cursorY: 99, lastContentRow: 99 })).toBe(
      `${ESC}[0m${ESC}[10;1H\r\n`
    );
    expect(restoreSettleSequence({ rows: 0, cursorY: 0, lastContentRow: 0 })).toBe(
      `${ESC}[0m${ESC}[1;1H\r\n`
    );
  });
});

function fakeBuffer(rows: number, lines: string[], cursorY: number, baseY = 0): BufferLike {
  return {
    rows,
    buffer: {
      active: {
        baseY,
        cursorY,
        length: lines.length,
        getLine: (y: number) =>
          y >= 0 && y < lines.length ? { translateToString: () => lines[y] } : undefined,
      },
    },
  };
}

describe("readRestoreGeometry", () => {
  it("finds the last viewport row with text, relative to the viewport", () => {
    const lines = ["scrolled", "away", "", "a", "b", "", "", "c", "", ""];
    // baseY 2 → viewport is rows 2..9 of the buffer (8 rows); "c" at buffer 7 = viewport 5
    const g = readRestoreGeometry(fakeBuffer(8, lines, 3, 2));
    expect(g).toEqual({ rows: 8, cursorY: 3, lastContentRow: 5 });
  });

  it("reports -1 for a viewport with no text", () => {
    expect(readRestoreGeometry(fakeBuffer(4, ["", "", "", ""], 0)).lastContentRow).toBe(-1);
  });

  it("never walks above the viewport into scrollback", () => {
    const lines = ["old text", "", "", "", ""];
    // baseY 1 → viewport rows 1..4, all empty; the scrollback's text is not counted.
    expect(readRestoreGeometry(fakeBuffer(4, lines, 0, 1)).lastContentRow).toBe(-1);
  });
});
