// LINE PANEL (Inc 5a — SWIT-39): the shared time-series component for tick,
// flow and probability panes, on uPlot.
//
// Where CandleChart is the market's own shape, this is the everything-else
// chart: a few series over one time axis, tens of thousands of points, 60fps
// on a live feed. uPlot draws on canvas with no per-point DOM, which is what
// makes it the right tool for a flow pane beside a live terminal. Kept
// deliberately small — series + optional bands are the whole API; a page
// that needs a bespoke pane composes on top rather than adding props here.
//
// ANCHORS + MARKERS (T7 — SWIT-61, for the `line` view kind): when `points`
// (the source ISO per x) is given AND a SurfaceAnchorContext is above, the
// panel publishes a programmatic provider the way CandleChart does —
// `getAnchor` answers `pt:<iso>` for the point under the cursor
// (`u.cursor.idx`), `locateAnchor` asks uPlot where that x sits now
// (`valToPos` against the FIRST series that has a value there). `markers`
// are drawn in a `draw` hook on the plot's own canvas at their nearest x
// (uPlot has no marker primitive; a triangle + label is the whole thing).
// Without `points` nothing is published — Lodestar's panes are unchanged.

import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { LEVEL_COLORS, isoToUtcSeconds, levelColor } from "./candles";
import { useSurfaceAnchorRegistry } from "../page-api";
import type { SurfaceAnchorProvider } from "../page-api";

export type LineSeries = {
  label: string;
  /** One value per x; null = gap. */
  values: readonly (number | null)[];
  /** Functional tone (candles.LEVEL_COLORS) or a CSS colour. */
  color?: string;
  width?: number;
  dashed?: boolean;
};

export type LinePanelProps = {
  /** X values as UTC SECONDS (uPlot's native time unit), ascending. */
  xs: readonly number[];
  series: readonly LineSeries[];
  height?: number;
  /** Fixed y range; omit for auto. */
  yRange?: [number, number];
  /** Y axis label formatter. */
  formatY?: (v: number) => string;
  /** Time-of-day ticks (intraday) instead of dates. */
  intraday?: boolean;
  /** The source ISO stamp per x (T7) — publishes `pt:<iso>` anchors while a
   *  SurfaceAnchorContext is above. Same length as `xs`. */
  points?: readonly string[];
  /** Labelled moments (T7): drawn at the nearest x on the first series. */
  markers?: readonly { ts: string; label: string }[];
};

const CHROME = {
  text: "#a1a1aa",
  grid: "#1e1e22",
  font: "10px 'JetBrains Mono', 'Cascadia Code', 'SF Mono', Consolas, monospace",
};

export default function LinePanel({
  xs,
  series,
  height = 200,
  yRange,
  formatY,
  intraday = true,
  points,
  markers,
}: LinePanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  // The draw hook and the anchor provider read the CURRENT props through refs
  // so neither re-subscribes (nor rebuilds the plot) when they change.
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const xsRef = useRef(xs);
  xsRef.current = xs;

  const data = useMemo<uPlot.AlignedData>(
    () => [Array.from(xs), ...series.map((s) => Array.from(s.values))] as uPlot.AlignedData,
    [xs, series]
  );

  // Series OPTIONS change rarely (labels/colours); data changes often. uPlot
  // can take new data without a rebuild but not new series, so the instance
  // is keyed on the options signature and fed data separately.
  // `formatY` is a function and cannot be serialised; its PRESENCE is part of
  // the signature, and the latest instance is read through a ref below.
  const formatYRef = useRef(formatY);
  formatYRef.current = formatY;
  const optionsKey = useMemo(
    () =>
      JSON.stringify(series.map((s) => [s.label, s.color, s.width, s.dashed])) +
      `|${height}|${intraday}|${yRange?.join(",") ?? ""}|${formatY ? "fy" : ""}`,
    [series, height, intraday, yRange, formatY]
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const opts: uPlot.Options = {
      width: Math.max(100, el.clientWidth),
      height,
      cursor: { drag: { x: true, y: false } },
      legend: { show: true },
      axes: [
        {
          stroke: CHROME.text,
          grid: { stroke: CHROME.grid, width: 1 },
          ticks: { stroke: CHROME.grid, width: 1 },
          font: CHROME.font,
          values: intraday
            ? (_u, ticks) =>
                ticks.map((t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))
            : undefined,
        },
        {
          stroke: CHROME.text,
          grid: { stroke: CHROME.grid, width: 1 },
          ticks: { stroke: CHROME.grid, width: 1 },
          font: CHROME.font,
          values: formatY ? (_u, ticks) => ticks.map((t) => (formatYRef.current ?? String)(t)) : undefined,
        },
      ],
      scales: yRange ? { y: { range: yRange } } : {},
      hooks: { draw: [(u) => drawMarkers(u, markersRef.current)] },
      series: [
        { label: intraday ? "time" : "date" },
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color && s.color in LEVEL_COLORS ? levelColor(s.color) : (s.color ?? LEVEL_COLORS.accent),
          width: s.width ?? 1.25,
          dash: s.dashed ? [4, 3] : undefined,
          spanGaps: false,
        })),
      ],
    };
    const plot = new uPlot(opts, data, el);
    plotRef.current = plot;
    const ro = new ResizeObserver(() => {
      plot.setSize({ width: Math.max(100, el.clientWidth), height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
    // Rebuild only when the options signature changes; data flows below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  // Markers live on the canvas; a change means one redraw, not a rebuild.
  useEffect(() => {
    plotRef.current?.redraw(false, true);
  }, [markers]);

  // ── Anchors (T7): publish `pt:<iso>` while `points` is given ─────────────
  const registry = useSurfaceAnchorRegistry();
  const hasPoints = points !== undefined;
  useEffect(() => {
    if (!registry || !hasPoints) return;
    const provider: SurfaceAnchorProvider = {
      getAnchor: (target) => {
        const el = containerRef.current;
        const u = plotRef.current;
        if (!el || !u || !(target instanceof Node) || !el.contains(target)) return null;
        const idx = u.cursor.idx;
        if (idx === null || idx === undefined) return null;
        const iso = pointsRef.current?.[idx];
        if (!iso) return null;
        return { key: `pt:${iso}`, label: `pt ${fmtStamp(iso, intraday)}` };
      },
      locateAnchor: (key) => {
        if (!key.startsWith("pt:")) return null;
        const u = plotRef.current;
        if (!u) return null;
        const t = isoToUtcSeconds(key.slice(3));
        if (t === null) return null;
        const idx = xsRef.current.indexOf(t);
        if (idx < 0) return null;
        const y = firstValueAt(u, idx);
        if (y === null) return null;
        const px = u.valToPos(xsRef.current[idx], "x");
        const py = u.valToPos(y, "y");
        const over = u.over;
        // Off the plot area (panned / zoomed out of view) is "not on
        // screen", not "over the axis".
        if (px < 0 || px > over.clientWidth || py < 0 || py > over.clientHeight) return null;
        const rect = over.getBoundingClientRect();
        return new DOMRect(rect.left + px - 4, rect.top + py - 4, 8, 8);
      },
    };
    return registry.publish(provider);
  }, [registry, hasPoints, intraday]);

  return <div ref={containerRef} style={{ width: "100%", color: "var(--dim)" }} />;
}

/** The first series with a value at `idx` (the y a marker / anchor sits on). */
function firstValueAt(u: uPlot, idx: number): number | null {
  for (let s = 1; s < u.data.length; s++) {
    const v = u.data[s]?.[idx];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

/** Triangle + label per marker at its nearest x, on the plot canvas. */
function drawMarkers(u: uPlot, markers: readonly { ts: string; label: string }[] | undefined): void {
  if (!markers || markers.length === 0) return;
  const xs = u.data[0];
  if (!xs || xs.length === 0) return;
  const ctx = u.ctx;
  const dpr = devicePixelRatio || 1;
  ctx.save();
  ctx.font = `${Math.round(9 * dpr)}px 'JetBrains Mono', 'Cascadia Code', 'SF Mono', Consolas, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const m of markers) {
    const t = isoToUtcSeconds(m.ts);
    if (t === null) continue;
    let idx = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i] - t);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    const y = firstValueAt(u, idx);
    if (y === null) continue;
    const px = u.valToPos(xs[idx], "x", true);
    const py = u.valToPos(y, "y", true);
    if (px < u.bbox.left || px > u.bbox.left + u.bbox.width) continue;
    const h = 6 * dpr;
    ctx.fillStyle = LEVEL_COLORS.accent;
    ctx.beginPath();
    ctx.moveTo(px, py + 3 * dpr);
    ctx.lineTo(px - h / 2, py + 3 * dpr + h);
    ctx.lineTo(px + h / 2, py + 3 * dpr + h);
    ctx.closePath();
    ctx.fill();
    if (m.label) ctx.fillText(m.label, px, py + 4 * dpr + h);
  }
  ctx.restore();
}

function fmtStamp(ts: string, intraday: boolean): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return intraday
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
