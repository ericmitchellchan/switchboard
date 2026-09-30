import { describe, expect, it, vi } from "vitest";
import {
  healViewportReach,
  planViewportReach,
  readViewportReach,
  remeasureViewport,
  repointViewportDimensions,
  type RenderDimensionsLike,
  type ViewportLike,
} from "./viewportReach";

// Ky's tests (CC-709, CC-755), ported with the module (SWIT-103). The numbers
// are Ky's measured case — its 2026-09-02 diag: a 40-row grid, baseY 872, the
// wheel stalling at row 852, rowHeight 16.25 (its 12.5px font x 1.3 line
// height; ours is 13px, the arithmetic is the same).
const ROW = 16.25;
const SCREEN = 40 * ROW; // 650

describe("planViewportReach", () => {
  it("a range that reaches the bottom is not short", () => {
    const plan = planViewportReach({
      baseY: 872,
      rowHeight: ROW,
      scrollHeight: (872 + 40) * ROW,
      clientHeight: SCREEN,
    });
    expect(plan).toEqual({ maxRow: 872, shortRows: 0, short: false });
  });

  it("a range clamped 20 rows above the prompt is short by 20", () => {
    const plan = planViewportReach({
      baseY: 872,
      rowHeight: ROW,
      scrollHeight: (852 + 40) * ROW,
      clientHeight: SCREEN,
    });
    expect(plan).toEqual({ maxRow: 852, shortRows: 20, short: true });
  });

  it("sub-pixel rounding of the range is not a short row", () => {
    const plan = planViewportReach({
      baseY: 872,
      rowHeight: ROW,
      scrollHeight: Math.round((872 + 40) * ROW) - 1,
      clientHeight: SCREEN,
    });
    expect(plan.short).toBe(false);
  });

  it("a range that overshoots (horizontal scrollbar) is never short", () => {
    const plan = planViewportReach({
      baseY: 872,
      rowHeight: ROW,
      scrollHeight: (872 + 40) * ROW,
      clientHeight: SCREEN - 17,
    });
    expect(plan.short).toBe(false);
  });

  it("nothing to scroll, or an unmeasured viewport, is never short", () => {
    expect(
      planViewportReach({ baseY: 0, rowHeight: ROW, scrollHeight: SCREEN, clientHeight: SCREEN })
        .short
    ).toBe(false);
    expect(
      planViewportReach({ baseY: 500, rowHeight: 0, scrollHeight: 0, clientHeight: 0 }).short
    ).toBe(false);
  });

  it("a hidden pane (zero client height) is undecidable, not short", () => {
    expect(
      planViewportReach({ baseY: 872, rowHeight: ROW, scrollHeight: 0, clientHeight: 0 }).short
    ).toBe(false);
  });
});

function fakeViewport(maxRow: number): ViewportLike & { sync: ReturnType<typeof vi.fn> } {
  const sync = vi.fn();
  return {
    sync,
    syncScrollArea: sync,
    _viewportElement: {
      scrollTop: maxRow * ROW,
      scrollHeight: (maxRow + 40) * ROW,
      clientHeight: SCREEN,
      offsetHeight: SCREEN,
    },
    _scrollArea: { style: { height: `${(maxRow + 40) * ROW}px` } },
    _currentRowHeight: ROW,
    _lastRecordedViewportHeight: SCREEN,
    _lastRecordedBufferLength: maxRow + 40,
    _lastRecordedBufferHeight: (maxRow + 40) * ROW,
    _renderDimensions: { css: { canvas: { height: SCREEN } }, device: { cell: { height: 20 } } },
  };
}

describe("readViewportReach", () => {
  it("reports the short range with the geometry the diag needs", () => {
    const reading = readViewportReach(fakeViewport(852), {
      baseY: 872,
      viewportY: 852,
      length: 912,
    });
    expect(reading?.plan.shortRows).toBe(20);
    expect(reading?.detail).toMatchObject({
      baseY: 872,
      maxRow: 852,
      shortRows: 20,
      rowHeight: 16.25,
      recordedLines: 892,
      canvasHeight: SCREEN,
      deviceCellHeight: 20,
    });
  });

  it("returns null when the private surface is missing", () => {
    expect(readViewportReach({}, { baseY: 872, viewportY: 872, length: 912 })).toBeNull();
  });
});

describe("healViewportReach", () => {
  it("trips xterm's buffer-length guard and syncs immediately", () => {
    const vp = fakeViewport(852);
    expect(healViewportReach(vp)).toBe(true);
    expect(vp._lastRecordedBufferLength).toBe(0);
    expect(vp.sync).toHaveBeenCalledWith(true);
  });

  it("does nothing without the private surface", () => {
    const sync = vi.fn();
    expect(healViewportReach({ syncScrollArea: sync })).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });
});

// CC-755 — the 2026-09-07 diag: a terminal created docked on a 100% display
// (device cell 20 → dims frozen at dpr 1), read after undocking to the 150%
// panel. The live renderer measured cell 31 at dpr 1.5; the Viewport still
// held the disposed renderer's object, so rowHeight came out 20 / 1.5 = 13.33
// and the range stopped 40 × 0.5 = 20 rows short, heal after heal.
describe("repointViewportDimensions", () => {
  const stale: RenderDimensionsLike = {
    css: { canvas: { height: 800 } },
    device: { cell: { height: 20 } },
  };
  // xterm rounds css canvas height: round(31 * 40 / 1.5) = 827.
  const live: RenderDimensionsLike = {
    css: { canvas: { height: 827 } },
    device: { cell: { height: 31 } },
  };

  it("swaps a stale reference for the live renderer's object", () => {
    const vp: ViewportLike = { _renderDimensions: stale };
    expect(repointViewportDimensions(vp, live)).toBe(true);
    expect(vp._renderDimensions).toBe(live);
  });

  it("is a no-op when the Viewport already reads the live object", () => {
    const vp: ViewportLike = { _renderDimensions: live };
    expect(repointViewportDimensions(vp, live)).toBe(false);
    expect(vp._renderDimensions).toBe(live);
  });

  it("does nothing without a live object or without the private field", () => {
    const vp: ViewportLike = { _renderDimensions: stale };
    expect(repointViewportDimensions(vp, undefined)).toBe(false);
    expect(vp._renderDimensions).toBe(stale);
    const bare: ViewportLike = { syncScrollArea: vi.fn() };
    expect(repointViewportDimensions(bare, live)).toBe(false);
    expect("_renderDimensions" in bare).toBe(false);
  });

  it("a stale reference is the geometry of the 20-row stall, and re-pointing is what clears it", () => {
    // What xterm's _innerRefresh computes from each object at dpr 1.5.
    const dpr = 1.5;
    const rows = 40;
    const lines = 920;
    const rowHeightFrom = (d: RenderDimensionsLike): number => (d.device?.cell.height ?? 0) / dpr;
    const clientHeight = 827; // the pane, laid out at the true 20.67px rows
    const rangeFrom = (d: RenderDimensionsLike): number =>
      Math.round(rowHeightFrom(d) * lines) + (clientHeight - d.css.canvas.height);
    const planFor = (d: RenderDimensionsLike) =>
      planViewportReach({
        baseY: lines - rows,
        rowHeight: rowHeightFrom(d),
        scrollHeight: rangeFrom(d),
        clientHeight,
      });
    expect(planFor(stale)).toMatchObject({ shortRows: 20, short: true });
    expect(planFor(live)).toMatchObject({ shortRows: 0, short: false });
  });
});

describe("remeasureViewport", () => {
  const stale: RenderDimensionsLike = {
    css: { canvas: { height: 800 } },
    device: { cell: { height: 20 } },
  };
  const live: RenderDimensionsLike = {
    css: { canvas: { height: 827 } },
    device: { cell: { height: 31 } },
  };

  it("a stale reference is swapped and the full re-measure forced", () => {
    const vp = fakeViewport(852);
    vp._renderDimensions = stale;
    expect(remeasureViewport(vp, live)).toEqual({
      repointed: true,
      cellChanged: true,
      staleCellHeight: 20,
    });
    expect(vp._renderDimensions).toBe(live);
    expect(vp._lastRecordedBufferLength).toBe(0); // guard tripped
    expect(vp.sync).toHaveBeenCalledTimes(1);
    expect(vp.sync).toHaveBeenCalledWith(true);
  });

  it("a fresh renderer with the same geometry is a routine swap, not a changed cell", () => {
    const vp = fakeViewport(852);
    vp._renderDimensions = { css: { canvas: { height: 800 } }, device: { cell: { height: 20 } } };
    expect(remeasureViewport(vp, stale)).toMatchObject({ repointed: true, cellChanged: false });
  });

  it("the live object already in place gets the plain sync and no guard trip", () => {
    const vp = fakeViewport(852);
    vp._renderDimensions = live;
    const recorded = vp._lastRecordedBufferLength;
    expect(remeasureViewport(vp, live)).toEqual({
      repointed: false,
      cellChanged: false,
      staleCellHeight: 31,
    });
    expect(vp._lastRecordedBufferLength).toBe(recorded);
    expect(vp.sync).toHaveBeenCalledTimes(1);
    expect(vp.sync).toHaveBeenCalledWith(true);
  });

  it("no live object: the plain sync, unchanged reference", () => {
    const vp = fakeViewport(852);
    vp._renderDimensions = stale;
    expect(remeasureViewport(vp, undefined).repointed).toBe(false);
    expect(vp._renderDimensions).toBe(stale);
    expect(vp.sync).toHaveBeenCalledWith(true);
  });
});
