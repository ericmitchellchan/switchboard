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
// are drawn in a `draw` hook on the plot's own canvas — since SWIT-70 as a
// 1px vertical rule the plot's full height with the label at the top (a dot
// on a thin line was invisible; a moment is a TIME, not a y value).
// Without `points` nothing is published — Lodestar's panes are unchanged.
//
// SWIT-70 — a line chart tells the story:
//   · a series with NO explicit colour draws in `seriesColor(label)` — the
//     stable per-name palette (candles.SERIES_PALETTE), so `gamma` is the
//     same tone in every view;
//   · when the drawn y scale spans zero a 1px rule is drawn at 0
//     (`drawClear` hook — under the series, over nothing that matters);
//   · `regions` shade time bands (one neutral tone at low alpha, label small
//     at the band's top); `xRange` pins the x scale so small multiples share
//     one time domain.

import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { LEVEL_COLORS, isoToUtcSeconds, levelColor, seriesColor } from "./candles";
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
  /** Labelled moments (T7/SWIT-70): a full-height 1px rule at the nearest x
   *  with the label at the top. */
  markers?: readonly { ts: string; label: string }[];
  /** Shaded time bands (SWIT-70): ISO from/to, label small at the band top. */
  regions?: readonly { from: string; to: string; label?: string }[];
  /** Fixed x range in UTC seconds (SWIT-70: small multiples share one time
   *  domain); omit for auto. */
  xRange?: [number, number];
};

const CHROME = {
  text: "#b4b4b4",
  grid: "#242424",
  /** The zero rule (SWIT-70): --border-subtle — one step brighter than the
   *  grid, or a rule at 0 would vanish among the tick lines. */
  zero: "#3a3a3a",
  /** Region bands: --text-secondary (#b4b4b4) at low alpha — neutral, never
   *  a series tone. */
  region: "rgba(180, 180, 180, 0.07)",
  font: "10px 'JetBrains Mono', 'Cascadia Code', 'SF Mono', Consolas, monospace",
};

/** Longest marker / region label drawn before truncation (canvas, no CSS). */
const LABEL_MAX = 18;

export default function LinePanel({
  xs,
  series,
  height = 200,
  yRange,
  formatY,
  intraday = true,
  points,
  markers,
  regions,
  xRange,
}: LinePanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  // The draw hook and the anchor provider read the CURRENT props through refs
  // so neither re-subscribes (nor rebuilds the plot) when they change.
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const regionsRef = useRef(regions);
  regionsRef.current = regions;
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
      `|${height}|${intraday}|${yRange?.join(",") ?? ""}|${xRange?.join(",") ?? ""}|${formatY ? "fy" : ""}`,
    [series, height, intraday, yRange, xRange, formatY]
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
      scales: {
        ...(xRange ? { x: { range: xRange } } : {}),
        ...(yRange ? { y: { range: yRange } } : {}),
      },
      hooks: {
        // Under the series: region bands + the zero rule (drawClear fires
        // after the canvas is cleared, before axes and series).
        drawClear: [(u) => drawUnder(u, regionsRef.current)],
        // Over the series: marker rules + labels, region labels.
        draw: [(u) => drawOver(u, markersRef.current, regionsRef.current)],
      },
      series: [
        { label: intraday ? "time" : "date" },
        ...series.map((s) => ({
          label: s.label,
          // No colour named → the stable per-name palette (SWIT-70); a
          // functional tone name → LEVEL_COLORS; anything else verbatim.
          stroke: s.color && s.color in LEVEL_COLORS ? levelColor(s.color) : (s.color ?? seriesColor(s.label)),
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

  // Markers + regions live on the canvas; a change means one redraw, not a
  // rebuild.
  useEffect(() => {
    plotRef.current?.redraw(false, true);
  }, [markers, regions]);

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

/** A label cut to LABEL_MAX for the canvas (no CSS ellipsis there). */
function cutLabel(label: string): string {
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

/** UNDER the series (SWIT-70, drawClear): region bands, then a 1px rule at 0
 *  when the drawn y scale spans zero — the story's baseline, one step
 *  brighter than the grid so it reads as "zero", not as a tick. */
function drawUnder(u: uPlot, regions: readonly { from: string; to: string; label?: string }[] | undefined): void {
  const ctx = u.ctx;
  const dpr = devicePixelRatio || 1;
  ctx.save();
  if (regions) {
    for (const r of regions) {
      const a = isoToUtcSeconds(r.from);
      const b = isoToUtcSeconds(r.to);
      if (a === null || b === null) continue;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const x1 = Math.max(u.bbox.left, u.valToPos(lo, "x", true));
      const x2 = Math.min(u.bbox.left + u.bbox.width, u.valToPos(hi, "x", true));
      if (x2 <= x1) continue;
      ctx.fillStyle = CHROME.region;
      ctx.fillRect(x1, u.bbox.top, x2 - x1, u.bbox.height);
    }
  }
  const sc = u.scales.y;
  if (sc && typeof sc.min === "number" && typeof sc.max === "number" && sc.min < 0 && sc.max > 0) {
    const py = u.valToPos(0, "y", true);
    ctx.strokeStyle = CHROME.zero;
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.beginPath();
    ctx.moveTo(u.bbox.left, py);
    ctx.lineTo(u.bbox.left + u.bbox.width, py);
    ctx.stroke();
  }
  ctx.restore();
}

/** OVER the series (SWIT-70, draw): each marker as a 1px vertical rule the
 *  plot's full height at its nearest x with the label at the top (flipped
 *  left of the rule near the right edge, truncated — never rotated: a canvas
 *  label on its side is a decoration, not a caption), and each region's
 *  label small at its band's top. */
function drawOver(
  u: uPlot,
  markers: readonly { ts: string; label: string }[] | undefined,
  regions: readonly { from: string; to: string; label?: string }[] | undefined
): void {
  const ctx = u.ctx;
  const dpr = devicePixelRatio || 1;
  const right = u.bbox.left + u.bbox.width;
  ctx.save();
  ctx.font = `${Math.round(9 * dpr)}px 'JetBrains Mono', 'Cascadia Code', 'SF Mono', Consolas, monospace`;
  ctx.textBaseline = "top";
  if (regions) {
    ctx.fillStyle = CHROME.text;
    ctx.textAlign = "left";
    for (const r of regions) {
      if (!r.label) continue;
      const a = isoToUtcSeconds(r.from);
      const b = isoToUtcSeconds(r.to);
      if (a === null || b === null) continue;
      const x1 = Math.max(u.bbox.left, u.valToPos(Math.min(a, b), "x", true));
      if (x1 >= right) continue;
      ctx.fillText(cutLabel(r.label), x1 + 3 * dpr, u.bbox.top + 2 * dpr);
    }
  }
  if (markers && markers.length > 0) {
    const xs = u.data[0];
    if (xs && xs.length > 0) {
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
        const px = u.valToPos(xs[idx], "x", true);
        if (px < u.bbox.left || px > right) continue;
        ctx.strokeStyle = LEVEL_COLORS.accent;
        ctx.lineWidth = Math.max(1, Math.round(dpr));
        ctx.beginPath();
        ctx.moveTo(px, u.bbox.top);
        ctx.lineTo(px, u.bbox.top + u.bbox.height);
        ctx.stroke();
        if (m.label) {
          ctx.fillStyle = LEVEL_COLORS.accent;
          const nearRightEdge = px > right - 90 * dpr;
          ctx.textAlign = nearRightEdge ? "right" : "left";
          ctx.fillText(cutLabel(m.label), px + (nearRightEdge ? -3 : 3) * dpr, u.bbox.top + 2 * dpr);
        }
      }
    }
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
