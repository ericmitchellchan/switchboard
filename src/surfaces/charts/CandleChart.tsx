// CANDLE CHART (Inc 5a — SWIT-39): the shared candlestick component every
// project surface draws candles with, on lightweight-charts v5.
//
// Replaces Lodestar's hand-rolled SVG `CandleChart` with the same props
// (bars / levels / height / intraday / highlightTs) plus `markers`, so the
// pages that used it swap an import and nothing else. What the library buys
// over the SVG: canvas rendering that stays smooth past a few thousand bars,
// zoom/pan with the wheel, `update()` on a live tick without re-laying the
// whole chart (later), and price lines / markers as first-class objects.
//
// ANCHORS: a canvas has no DOM per bar, so this component publishes a
// PROGRAMMATIC anchor provider (surfaces/anchors.ts, way 2) through the
// page-facing context — `getAnchor` answers with the bar under the crosshair
// (`bar:<iso>`), `locateAnchor` asks the chart where that bar's high sits now
// (time → x, price → y). A pin on a candle therefore survives zoom, pan, a
// resize and a data refresh, and reads "not on screen" when scrolled out.
//
// PALETTE: soft ramp for chrome (grid/axis/text from the surface tokens),
// functional colours only for data (up/down candles, level tones).
//
// PRICE MODE (T7 — SWIT-61): `priceMode` = "points" | "percent" is applied to
// the right price scale (`PriceScaleMode.Normal` / `.Percentage`) through
// applyOptions like every other option — a prop, not an imperative handle,
// because the chart instance never leaves this file. Anchors are BY TIME and
// `series.priceToCoordinate` converts through the scale's mode (the library
// re-bases to percent before mapping), so a pin on a bar and a marker on a
// bar stay on that bar in either mode; only the axis labels change.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";
import type {
  CandlestickData,
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  MouseEventParams,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import { useSurfaceAnchorRegistry } from "../page-api";
import type { SurfaceAnchorProvider } from "../page-api";
import {
  LEVEL_COLORS,
  barAnchorKey,
  drawableLevels,
  isoToUtcSeconds,
  levelColor,
  nearestCandle,
  toCandlePoints,
} from "./candles";
import type { CandlePoint, OhlcBar, PriceLevel } from "./candles";

export type { PriceLevel, OhlcBar } from "./candles";

/** A labelled moment on the chart (entry / exit / a flow moment). */
export type CandleMarker = {
  ts: string;
  label: string;
  /** Functional tone (candles.LEVEL_COLORS) — accent by default. */
  tone?: string;
  position?: "above" | "below";
};

export type CandleChartProps = {
  bars: readonly OhlcBar[];
  levels?: readonly PriceLevel[];
  height?: number;
  /** Time-of-day axis (intraday session) instead of dates. */
  intraday?: boolean;
  /** Pin a moment (ISO) — an accent marker on the nearest bar. */
  highlightTs?: string | null;
  markers?: readonly CandleMarker[];
  /** Fit all bars on (re)load. Default true; a page that keeps the user's
   *  zoom across refreshes passes false. */
  fitOnLoad?: boolean;
  /** The right price scale's mode: absolute points (default) or percent
   *  change from the first visible bar (T7). */
  priceMode?: "points" | "percent";
};

const CHROME = {
  text: "#a1a1aa",
  grid: "#1e1e22",
  border: "#27272a",
  crosshair: "#52525b",
  font: "'JetBrains Mono', 'Cascadia Code', 'SF Mono', Consolas, monospace",
};

const READOUT_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "4px 18px",
  marginTop: 8,
  padding: "5px 10px",
  border: "1px solid var(--line)",
  borderRadius: 4,
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  color: "var(--dim)",
};

export default function CandleChart({
  bars,
  levels,
  height = 360,
  intraday = false,
  highlightTs = null,
  markers,
  fitOnLoad = true,
  priceMode = "points",
}: CandleChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const points = useMemo(() => toCandlePoints(bars), [bars]);
  const byTime = useMemo(() => new Map(points.map((p) => [p.time as number, p])), [points]);
  const [hover, setHover] = useState<CandlePoint | null>(null);
  const hoverRef = useRef<CandlePoint | null>(null);
  // The crosshair handler reads the CURRENT point index without re-subscribing.
  const byTimeRef = useRef(byTime);
  byTimeRef.current = byTime;
  // Fit the view ONCE, on the first non-empty load — a later data refresh
  // (bars polling) must not yank the user's zoom back out.
  const fittedRef = useRef(false);

  // ── Chart lifetime: one instance per mount, disposed on unmount ──────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: CHROME.text,
        fontFamily: CHROME.font,
        fontSize: 10,
        attributionLogo: false,
      },
      grid: { vertLines: { color: CHROME.grid }, horzLines: { color: CHROME.grid } },
      rightPriceScale: { borderColor: CHROME.border },
      // The library has no time zone of its own (axis ticks would print UTC);
      // both formatters render LOCAL time so the axis, the readout and the
      // anchor label all say the same clock.
      localization: { timeFormatter: (t: Time) => fmtStamp(timeToIso(t), true) },
      timeScale: {
        borderColor: CHROME.border,
        timeVisible: intraday,
        secondsVisible: false,
        tickMarkFormatter: (t: Time) => fmtStamp(timeToIso(t), intraday),
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: CHROME.crosshair, labelBackgroundColor: CHROME.border },
        horzLine: { color: CHROME.crosshair, labelBackgroundColor: CHROME.border },
      },
      handleScale: { axisPressedMouseMove: true },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: LEVEL_COLORS.up,
      downColor: LEVEL_COLORS.dn,
      wickUpColor: LEVEL_COLORS.up,
      wickDownColor: LEVEL_COLORS.dn,
      borderVisible: false,
    });
    const onMove = (p: MouseEventParams<Time>) => {
      const t = typeof p.time === "number" ? (p.time as number) : null;
      const next = t !== null ? (byTimeRef.current.get(t) ?? null) : null;
      if (next !== hoverRef.current) {
        hoverRef.current = next;
        setHover(next);
      }
    };
    chart.subscribeCrosshairMove(onMove);
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      markersRef.current?.detach();
      markersRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // The chart is created once; option changes below go through applyOptions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: { timeVisible: intraday, tickMarkFormatter: (t: Time) => fmtStamp(timeToIso(t), intraday) },
    });
  }, [intraday]);

  useEffect(() => {
    chartRef.current
      ?.priceScale("right")
      .applyOptions({ mode: priceMode === "percent" ? PriceScaleMode.Percentage : PriceScaleMode.Normal });
  }, [priceMode]);

  // ── Data ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    series.setData(points as CandlestickData<Time>[]);
    if (fitOnLoad && !fittedRef.current && points.length > 0) {
      chart.timeScale().fitContent();
      fittedRef.current = true;
    }
    if (hoverRef.current && !byTime.has(hoverRef.current.time as number)) {
      hoverRef.current = null;
      setHover(null);
    }
  }, [points, byTime, fitOnLoad]);

  // ── Levels: one price line each, replaced wholesale on change ────────────
  const drawn = useMemo(() => drawableLevels(levels), [levels]);
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const lines = drawn.map((l) =>
      series.createPriceLine({
        price: l.price,
        color: levelColor(l.tone),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: l.label,
      })
    );
    return () => {
      // Cleanups run in declaration order, so on unmount the chart is already
      // removed by the time this runs — nothing to detach from then.
      if (!chartRef.current) return;
      for (const line of lines) series.removePriceLine(line);
    };
  }, [drawn]);

  // ── Markers: highlight + explicit markers, one plugin instance ───────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const list: SeriesMarker<Time>[] = [];
    const hl = nearestCandle(points, highlightTs);
    if (hl) {
      list.push({ time: hl.time, position: "aboveBar", color: LEVEL_COLORS.accent, shape: "arrowDown", text: "" });
    }
    for (const m of markers ?? []) {
      const at = nearestCandle(points, m.ts);
      if (!at) continue;
      const below = m.position !== "above";
      list.push({
        time: at.time,
        position: below ? "belowBar" : "aboveBar",
        color: levelColor(m.tone),
        shape: below ? "arrowUp" : "arrowDown",
        text: m.label,
      });
    }
    list.sort((a, b) => (a.time as number) - (b.time as number));
    if (!markersRef.current) markersRef.current = createSeriesMarkers(series, list);
    else markersRef.current.setMarkers(list);
  }, [points, highlightTs, markers]);

  // ── Anchors: publish the programmatic provider while mounted ─────────────
  const registry = useSurfaceAnchorRegistry();
  useEffect(() => {
    if (!registry) return;
    const provider: SurfaceAnchorProvider = {
      getAnchor: (target) => {
        const el = containerRef.current;
        if (!el || !(target instanceof Node) || !el.contains(target)) return null;
        const p = hoverRef.current;
        if (!p) return null;
        return { key: barAnchorKey(p.ts), label: `bar ${fmtStamp(p.ts, intraday)}` };
      },
      locateAnchor: (key) => {
        if (!key.startsWith("bar:")) return null;
        const chart = chartRef.current;
        const series = seriesRef.current;
        const el = containerRef.current;
        if (!chart || !series || !el) return null;
        const time = isoToUtcSeconds(key.slice(4));
        if (time === null) return null;
        const point = byTimeRef.current.get(time as number);
        if (!point) return null;
        const x = chart.timeScale().timeToCoordinate(time as UTCTimestamp);
        const y = series.priceToCoordinate(point.high);
        if (x === null || y === null) return null;
        // `timeToCoordinate` answers for a bar PANNED OUT OF VIEW too (an
        // off-canvas x) — that bar is "not on screen", not "over the tab
        // beside the chart". Same for a price scrolled off the pane.
        if (x < 0 || x > el.clientWidth || y < 0 || y > el.clientHeight) return null;
        const rect = el.getBoundingClientRect();
        const w = Math.max(6, chart.timeScale().options().barSpacing);
        return new DOMRect(rect.left + x - w / 2, rect.top + y, w, 8);
      },
    };
    return registry.publish(provider);
  }, [registry, intraday]);

  const sel = hover ?? (points.length > 0 ? points[points.length - 1] : null);
  return (
    <div style={{ width: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height }} />
      {sel && (
        <div style={READOUT_STYLE}>
          <span>{fmtStamp(sel.ts, intraday)}</span>
          <span>
            O <b style={{ color: "var(--text)", fontWeight: 500 }}>{sel.open}</b>
          </span>
          <span>
            H <b style={{ color: "var(--text)", fontWeight: 500 }}>{sel.high}</b>
          </span>
          <span>
            L <b style={{ color: "var(--text)", fontWeight: 500 }}>{sel.low}</b>
          </span>
          <span>
            C{" "}
            <b style={{ color: sel.close >= sel.open ? LEVEL_COLORS.up : LEVEL_COLORS.dn, fontWeight: 500 }}>
              {sel.close}
            </b>
          </span>
        </div>
      )}
    </div>
  );
}

/** A library time (UTC seconds for our data) back to an ISO stamp. */
function timeToIso(t: Time): string {
  return typeof t === "number" ? new Date(t * 1000).toISOString() : String(t);
}

function fmtStamp(ts: string, intraday: boolean): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return intraday
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}
