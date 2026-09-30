// THE SCROLL RANGE MUST REACH THE BOTTOM ROW (SWIT-103; ported from
// ky-desktop's `chat/viewportReach.ts`, CC-709 + CC-755).
//
// xterm scrolls history by moving a real DOM scroller (`.xterm-viewport`)
// whose scroll area it sizes itself — rowHeight × bufferLines + (viewport
// height − screen height) — and it re-measures only when one of its own
// guards trips. Two ways that arithmetic goes stale here:
//
//   1. HIDDEN OUTPUT. While a terminal sits behind `display: none` (the
//      keep-alive root, a hidden tab, a non-terminal screen) every buffer
//      advance records a viewport height of ZERO and sizes the scroll area one
//      whole screen short. Nothing re-measures on re-show, so the wheel
//      scrolls against a range that stops above the prompt. This repo used to
//      poke that with a cols-1 → cols resize bounce; a resize re-wraps the
//      whole buffer, which is the very thing a pinned grid exists to never do.
//   2. A STALE DIMENSIONS REFERENCE. The Viewport keeps a reference to a
//      renderer's dimensions object, taken at the last onDimensionsChange. We
//      drop the WebGL renderer on every detach/hide and load a fresh one on
//      show, which never fires that event, so the Viewport goes on reading a
//      disposed renderer's frozen numbers. Change the display scaling under it
//      (dock → undock) and the range is off by rows × (dprNew / dprOld − 1):
//      100% → 150% leaves a 40-row grid 20 rows short.
//
// When the range is short the browser clamps scrollTop below the last rows:
// wheel-down stalls a fixed distance above the prompt, and scrollToBottom
// moves the BUFFER's viewportY to the bottom while the DOM stays clamped, so
// the next scroll event snaps the buffer back.
//
// The decision is pure (tested); the reader and the healer reach into xterm's
// private Viewport and treat anything missing as "nothing to check".

export type ReachGeometry = {
  /** Buffer row the viewport sits on when pinned to the bottom. */
  baseY: number;
  /** css px per row, as xterm's viewport believes. */
  rowHeight: number;
  /** The DOM scroller's range. */
  scrollHeight: number;
  clientHeight: number;
};

export type ReachPlan = {
  /** Highest buffer row the DOM scroller can actually reach. */
  maxRow: number;
  /** Rows the DOM range stops short of the bottom (0 = the prompt is reachable). */
  shortRows: number;
  short: boolean;
};

export function planViewportReach(g: ReachGeometry): ReachPlan {
  // No row height = the viewport never measured (hidden since creation); no
  // client height = not laid out right now (a hidden pane measures 0 on both,
  // which would read as "short by everything" and heal into the same
  // zero-height staleness); nothing to scroll = nothing to reach.
  if (!(g.rowHeight > 0) || !(g.clientHeight > 0) || g.baseY <= 0) {
    return { maxRow: g.baseY, shortRows: 0, short: false };
  }
  const range = Math.max(0, g.scrollHeight - g.clientHeight);
  const maxRow = Math.round(range / g.rowHeight);
  const shortRows = Math.max(0, g.baseY - maxRow);
  return { maxRow, shortRows, short: shortRows >= 1 };
}

/** A renderer's dimensions object (xterm's IRenderDimensions), as much of it
 *  as the reach check touches. */
export type RenderDimensionsLike = {
  css: { canvas: { height: number } };
  device?: { cell: { height: number } };
};

/** xterm's Viewport, as much of it as the reach check touches. Every field is
 *  optional — private API, so absence means "can't check", never a throw. */
export type ViewportLike = {
  syncScrollArea?: (immediate?: boolean) => void;
  _viewportElement?: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    offsetHeight: number;
  };
  _scrollArea?: { style: { height: string } };
  _currentRowHeight?: number;
  _lastRecordedViewportHeight?: number;
  _lastRecordedBufferLength?: number;
  _lastRecordedBufferHeight?: number;
  _renderDimensions?: RenderDimensionsLike;
};

export type ReachReading = {
  plan: ReachPlan;
  /** Everything a log line needs to explain a short range after the fact. */
  detail: Record<string, number | string>;
};

export function readViewportReach(
  vp: ViewportLike,
  buf: { baseY: number; viewportY: number; length: number }
): ReachReading | null {
  const el = vp._viewportElement;
  if (!el || typeof vp._currentRowHeight !== "number") return null;
  const geometry: ReachGeometry = {
    baseY: buf.baseY,
    rowHeight: vp._currentRowHeight,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  };
  const plan = planViewportReach(geometry);
  return {
    plan,
    detail: {
      baseY: buf.baseY,
      viewportY: buf.viewportY,
      lines: buf.length,
      maxRow: plan.maxRow,
      shortRows: plan.shortRows,
      rowHeight: Math.round(geometry.rowHeight * 100) / 100,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      offsetHeight: el.offsetHeight,
      scrollArea: vp._scrollArea?.style.height ?? "",
      recordedViewportHeight: vp._lastRecordedViewportHeight ?? -1,
      recordedLines: vp._lastRecordedBufferLength ?? -1,
      recordedScrollArea: vp._lastRecordedBufferHeight ?? -1,
      canvasHeight: vp._renderDimensions?.css.canvas.height ?? -1,
      deviceCellHeight: vp._renderDimensions?.device?.cell.height ?? -1,
    },
  };
}

/** Point the Viewport at the LIVE renderer's dimensions. Returns true when it
 *  swapped a stale reference — the caller must then force a full re-measure,
 *  because every cached row height came from the old object. A missing live
 *  object, or one already in place, is "nothing to do". */
export function repointViewportDimensions(
  vp: ViewportLike,
  live: RenderDimensionsLike | undefined
): boolean {
  if (!live || !("_renderDimensions" in vp)) return false;
  if (vp._renderDimensions === live) return false;
  vp._renderDimensions = live;
  return true;
}

export type RemeasureOutcome = {
  /** The Viewport was reading a different object than the live renderer's. */
  repointed: boolean;
  /** The row geometry differed between the two — the swap mattered, not just
   *  a fresh renderer with the same numbers (every show makes a new one). */
  cellChanged: boolean;
  /** Device cell height the Viewport believed before the swap (−1 = unknown). */
  staleCellHeight: number;
};

/** Re-measure the scroll range off the LIVE renderer: re-point first, and
 *  when that swapped something force the full re-measure (every cached row
 *  height came from the old object); otherwise a plain immediate sync. Returns
 *  what happened, for the log. */
export function remeasureViewport(
  vp: ViewportLike,
  live: RenderDimensionsLike | undefined
): RemeasureOutcome {
  const staleCellHeight = vp._renderDimensions?.device?.cell.height ?? -1;
  const repointed = repointViewportDimensions(vp, live);
  const liveCellHeight = live?.device?.cell.height ?? -1;
  const cellChanged = repointed && staleCellHeight !== liveCellHeight;
  if (!repointed || !healViewportReach(vp)) vp.syncScrollArea?.(true);
  return { repointed, cellChanged, staleCellHeight };
}

/** Force xterm to re-measure its scroll area from the live DOM and buffer.
 *  syncScrollArea only refreshes when one of its guards trips; zeroing the
 *  recorded buffer length trips the first guard, and the refresh it runs
 *  re-reads every input (viewport height, buffer length, row height) and
 *  re-applies scrollTop from the buffer's viewportY — DOM from buffer, never
 *  the reverse, so it cannot move the reader. Returns false when the private
 *  surface isn't there. */
export function healViewportReach(vp: ViewportLike): boolean {
  if (typeof vp.syncScrollArea !== "function") return false;
  if (typeof vp._lastRecordedBufferLength !== "number") return false;
  vp._lastRecordedBufferLength = 0;
  vp.syncScrollArea(true);
  return true;
}
