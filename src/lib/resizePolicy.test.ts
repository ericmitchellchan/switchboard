// Pure Node tests for the resize decision policy (resizePolicy.ts) — the
// settled fix for resize text duplication, ported from ky-desktop. No DOM, no
// xterm: the decision is pure; fitQueue/terminal.ts apply it.

import { describe, it, expect } from "vitest";
import {
  MAX_TERMINAL_COLS,
  STREAM_QUIET_MS,
  resizeDecision,
  type GridSize,
} from "./resizePolicy";

const idle = { streaming: false };
const streaming = { streaming: true };
const grid = (cols: number, rows: number): GridSize => ({ cols, rows });

describe("no-op proposals", () => {
  it("identical grid → none", () => {
    expect(resizeDecision(grid(120, 30), grid(120, 30), idle)).toEqual({ kind: "none" });
  });

  it("null / undefined proposal (hidden or unmeasurable container) → none", () => {
    expect(resizeDecision(grid(120, 30), null, idle)).toEqual({ kind: "none" });
    expect(resizeDecision(grid(120, 30), undefined, idle)).toEqual({ kind: "none" });
  });

  it("zero / negative / NaN dims → none", () => {
    expect(resizeDecision(grid(120, 30), grid(0, 30), idle)).toEqual({ kind: "none" });
    expect(resizeDecision(grid(120, 30), grid(120, 0), idle)).toEqual({ kind: "none" });
    expect(resizeDecision(grid(120, 30), grid(-4, 12), idle)).toEqual({ kind: "none" });
    expect(resizeDecision(grid(120, 30), grid(NaN, 30), idle)).toEqual({ kind: "none" });
  });
});

describe("grow-only width", () => {
  it("narrower pane, same rows → none (cols kept, host scrolls horizontally)", () => {
    expect(resizeDecision(grid(120, 30), grid(80, 30), idle)).toEqual({ kind: "none" });
  });

  it("narrower pane + row change → plain resize keeping cols (rows follow the pane)", () => {
    expect(resizeDecision(grid(120, 30), grid(80, 24), idle)).toEqual({
      kind: "resize",
      cols: 120,
      rows: 24,
    });
  });

  it("height-only change → plain resize, no reflow", () => {
    expect(resizeDecision(grid(120, 30), grid(120, 40), idle)).toEqual({
      kind: "resize",
      cols: 120,
      rows: 40,
    });
  });

  it("widen → reflow to the wider grid", () => {
    expect(resizeDecision(grid(100, 30), grid(140, 30), idle)).toEqual({
      kind: "reflow",
      cols: 140,
      rows: 30,
    });
  });

  it("widen + row change → one reflow carrying both", () => {
    expect(resizeDecision(grid(100, 30), grid(140, 42), idle)).toEqual({
      kind: "reflow",
      cols: 140,
      rows: 42,
    });
  });
});

describe("the MAX_TERMINAL_COLS cap", () => {
  it("widen past the cap → reflow clamped to the cap", () => {
    expect(resizeDecision(grid(100, 30), grid(400, 30), idle)).toEqual({
      kind: "reflow",
      cols: MAX_TERMINAL_COLS,
      rows: 30,
    });
  });

  it("already at the cap, pane still wider → none", () => {
    expect(
      resizeDecision(grid(MAX_TERMINAL_COLS, 30), grid(400, 30), idle)
    ).toEqual({ kind: "none" });
  });

  it("legacy grid above the cap (pre-policy workspace) → capped via plain resize, not reflow", () => {
    expect(resizeDecision(grid(200, 30), grid(220, 30), idle)).toEqual({
      kind: "resize",
      cols: MAX_TERMINAL_COLS,
      rows: 30,
    });
  });
});

describe("mid-stream defer", () => {
  it("widen while streaming → defer (never reflow against an in-flight repaint)", () => {
    expect(resizeDecision(grid(100, 30), grid(140, 30), streaming)).toEqual({ kind: "defer" });
  });

  it("rows-only change while streaming → defer (its SIGWINCH repaint races the same way)", () => {
    expect(resizeDecision(grid(120, 30), grid(120, 40), streaming)).toEqual({ kind: "defer" });
  });

  it("no grid change while streaming → none, not defer (no pending flag to arm)", () => {
    expect(resizeDecision(grid(120, 30), grid(80, 30), streaming)).toEqual({ kind: "none" });
  });
});

describe("initial fit (fresh terminal, nothing rendered)", () => {
  it("sizes freely down to the container (shrink allowed) via plain resize", () => {
    expect(
      resizeDecision(grid(80, 24), grid(60, 20), { streaming: false, initial: true })
    ).toEqual({ kind: "resize", cols: 60, rows: 20 });
  });

  it("sizes up via plain resize — never reflow (nothing to snapshot)", () => {
    expect(
      resizeDecision(grid(80, 24), grid(140, 40), { streaming: false, initial: true })
    ).toEqual({ kind: "resize", cols: 140, rows: 40 });
  });

  it("still capped at MAX_TERMINAL_COLS", () => {
    expect(
      resizeDecision(grid(80, 24), grid(400, 40), { streaming: false, initial: true })
    ).toEqual({ kind: "resize", cols: MAX_TERMINAL_COLS, rows: 40 });
  });

  it("ignores streaming — a just-flushed restore must not delay the first fit", () => {
    expect(
      resizeDecision(grid(80, 24), grid(100, 40), { streaming: true, initial: true })
    ).toEqual({ kind: "resize", cols: 100, rows: 40 });
  });
});

describe("constants", () => {
  it("cap and quiet window match the settled ky policy", () => {
    expect(MAX_TERMINAL_COLS).toBe(160);
    expect(STREAM_QUIET_MS).toBe(1500);
  });
});
