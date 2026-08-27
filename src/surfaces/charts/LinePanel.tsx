// LINE PANEL (Inc 5a — SWIT-39): the shared time-series component for tick,
// flow and probability panes, on uPlot.
//
// Where CandleChart is the market's own shape, this is the everything-else
// chart: a few series over one time axis, tens of thousands of points, 60fps
// on a live feed. uPlot draws on canvas with no per-point DOM, which is what
// makes it the right tool for a flow pane beside a live terminal. Kept
// deliberately small — series + optional bands are the whole API; a page
// that needs a bespoke pane composes on top rather than adding props here.

import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { LEVEL_COLORS, levelColor } from "./candles";

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
}: LinePanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

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

  return <div ref={containerRef} style={{ width: "100%", color: "var(--dim)" }} />;
}
