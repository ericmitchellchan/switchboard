// TIMELINE VIEW (T8 — SWIT-62): a match on one canvas — the price line, one
// SIZED mark per flagged moment toned by the side it backs, and the score as
// a STEP BAND under the price. Eric: "the odds throughout the timeline …
// each tick should be discrete so each moment happens with points, overlay
// with trades or what happened … I want to know how big that trade was".
//
// ONE uPlot instance, not two stacked ones: the price scale is stretched
// below zero (`y` range [-PRICE_FLOOR, 102]) so the bottom BAND_FRACTION of
// the plot is empty of price, and the games ride a second scale (`score`)
// whose range is chosen so 0..gamesMax lands inside that band. Cursor, zoom
// and the x axis are therefore shared for free, and a mark and the score
// under it are measured against the same x. The band's fill and the
// separator at price 0 are drawn in `drawClear` (under the series); the
// marks and the set boundaries in `draw` (over them).
//
// STEPS, NEVER INTERPOLATED: the games series use `uPlot.paths.stepped
// ({align: 1})` — a value holds until the next flagged moment. With flagged
// moments only, a step lands at the first flagged trade AFTER the game was
// won, which is as honest as the data allows and is what the toolbar's
// coverage line says. The price is drawn linear, as Kalshi draws it; the
// marks make its discreteness visible.
//
// HOVER + ANCHORS: uPlot's cursor `idx` is the nearest x, whatever the
// distance, so a mark counts as under the pointer only within HOVER_PROX_PX
// of it. The cursor hook calls `onHover(container)` / `onHover(null)`;
// ViewSurface asks the published provider for the anchor (`trade:<iso>`,
// from `cursorIdxRef`) and paints the tooltip from `rowForAnchor`. The
// HIGHLIGHT follows the `hoverKey` prop back down (not the cursor directly),
// so a hover ViewSurface clears — leaving the body — clears the ring too.
//
// Palette: the marks are `--up` / `--dn` by `backs_player` (a trade backing
// player 1 pushes player 1's price UP), accent when unknown; the band is
// `--line` with the steps in `--dim` (p1) and `--dim2` (p2, dashed). No new
// colours — these are surfaces.css's tokens as the literal values the canvas
// needs (candles.LEVEL_COLORS + LinePanel's CHROME).

import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { LEVEL_COLORS } from "../../surfaces/charts/candles";
import { useSurfaceAnchorRegistry } from "../../surfaces/page-api";
import type { SurfaceAnchorProvider } from "../../surfaces/page-api";
import { toTimelinePoints, tradeKey, isoToMillis } from "../../lib/viewStore";
import type { TimelinePoints, ViewMeta, ViewRow, ViewSpec } from "../../lib/viewStore";

const MONO = "var(--font-mono)";

/** surfaces.css tokens as canvas literals. */
const TONE = {
  text: "#a1a1aa", // --dim
  dim2: "#71717a", // --dim2
  line: "#1e1e22", // --line
  font: "10px 'JetBrains Mono', 'Cascadia Code', 'SF Mono', Consolas, monospace",
};

/** How far the price scale extends below 0 — the band is
 *  PRICE_FLOOR / (102 + PRICE_FLOOR) ≈ 28% of the plot height. */
const PRICE_FLOOR = 40;
const PRICE_TOP = 102;
const BAND_FRACTION = PRICE_FLOOR / (PRICE_TOP + PRICE_FLOOR);
/** A mark is "under the pointer" within this many CSS px on x. */
const HOVER_PROX_PX = 40;

export type TimelineViewProps = {
  spec: ViewSpec;
  rows: ViewRow[];
  meta: ViewMeta | null;
  /** The hovered anchor key from the host — paints the ring. */
  hoverKey: string | null;
  onHover: (el: EventTarget | null) => void;
  height?: number;
};

export default function TimelineView({ spec, rows, meta, hoverKey, onHover, height = 340 }: TimelineViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const points = useMemo(() => toTimelinePoints(rows, spec), [rows, spec]);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  // What the cursor is NEAR (the provider's answer) vs what is PAINTED (the
  // host's hoverKey, fed back down) — two refs, see the header.
  const cursorIdxRef = useRef<number | null>(null);
  const hoverIdxRef = useRef<number | null>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  const labels = useMemo(() => {
    const str = (k: string) => (meta && typeof meta[k] === "string" && (meta[k] as string).trim() ? (meta[k] as string).trim() : null);
    return {
      price: str("price_of") ? `${str("price_of")} yes` : "price",
      p1: str("player1") ?? "p1",
      p2: str("player2") ?? "p2",
    };
  }, [meta]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || points.xs.length === 0) return;
    const steps = points.steps;
    const gamesTop = Math.max(steps?.gamesMax ?? 0, 6) + 0.8;
    const scoreTop = gamesTop / BAND_FRACTION;
    const gameSplits: number[] = [];
    for (let g = 0; g <= Math.max(steps?.gamesMax ?? 0, 6); g += 2) gameSplits.push(g);
    const stepped = uPlot.paths.stepped?.({ align: 1 });

    const data: uPlot.AlignedData = steps
      ? [points.xs, points.price, steps.gamesP1, steps.gamesP2]
      : [points.xs, points.price];

    const opts: uPlot.Options = {
      width: Math.max(100, el.clientWidth),
      height,
      cursor: { drag: { x: true, y: false }, points: { show: false }, y: false },
      legend: { show: true },
      scales: {
        x: { time: true },
        y: { range: [-PRICE_FLOOR, PRICE_TOP] },
        score: { range: [0, scoreTop] },
      },
      axes: [
        {
          stroke: TONE.text,
          grid: { stroke: TONE.line, width: 1 },
          ticks: { stroke: TONE.line, width: 1 },
          font: TONE.font,
          values: (_u, ticks) =>
            ticks.map((t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
        },
        {
          scale: "y",
          stroke: TONE.text,
          grid: { stroke: TONE.line, width: 1 },
          ticks: { stroke: TONE.line, width: 1 },
          font: TONE.font,
          size: 40,
          splits: () => [0, 25, 50, 75, 100],
        },
        ...(steps
          ? [
              {
                scale: "score",
                side: 1,
                stroke: TONE.dim2,
                grid: { show: false },
                ticks: { stroke: TONE.line, width: 1 },
                font: TONE.font,
                size: 30,
                splits: () => gameSplits,
              } as uPlot.Axis,
            ]
          : []),
      ],
      series: [
        { label: "time" },
        {
          label: labels.price,
          scale: "y",
          stroke: LEVEL_COLORS.accent,
          width: 1.25,
          points: { show: false },
          spanGaps: true,
        },
        ...(steps
          ? [
              {
                label: labels.p1,
                scale: "score",
                stroke: TONE.text,
                width: 1,
                paths: stepped,
                points: { show: false },
                spanGaps: true,
              } as uPlot.Series,
              {
                label: labels.p2,
                scale: "score",
                stroke: TONE.dim2,
                width: 1,
                dash: [3, 2],
                paths: stepped,
                points: { show: false },
                spanGaps: true,
              } as uPlot.Series,
            ]
          : []),
      ],
      hooks: {
        drawClear: [(u) => drawBand(u)],
        draw: [(u) => drawMarksAndSets(u, pointsRef.current, hoverIdxRef.current)],
        setCursor: [
          (u) => {
            const idx = u.cursor.idx;
            let near: number | null = null;
            if (idx !== null && idx !== undefined && u.cursor.left !== undefined && u.cursor.left >= 0) {
              const px = u.valToPos(pointsRef.current.xs[idx], "x");
              if (Math.abs(px - u.cursor.left) <= HOVER_PROX_PX) near = idx;
            }
            if (near === cursorIdxRef.current) return;
            cursorIdxRef.current = near;
            onHoverRef.current(near === null ? null : containerRef.current);
          },
        ],
      },
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
      cursorIdxRef.current = null;
    };
  }, [points, labels, height]);

  // The ring follows the HOST's hover, so clearing it upstream clears it here.
  useEffect(() => {
    const idx = hoverKey && hoverKey.startsWith("trade:") ? indexOfTs(pointsRef.current, hoverKey.slice(6)) : null;
    if (idx === hoverIdxRef.current) return;
    hoverIdxRef.current = idx;
    plotRef.current?.redraw(false, true);
  }, [hoverKey, points]);

  // ── Anchors: `trade:<iso>` for the mark under the cursor ──────────────────
  const registry = useSurfaceAnchorRegistry();
  useEffect(() => {
    if (!registry) return;
    const provider: SurfaceAnchorProvider = {
      getAnchor: (target) => {
        const el = containerRef.current;
        if (!el || !(target instanceof Node) || !el.contains(target)) return null;
        const idx = cursorIdxRef.current;
        if (idx === null) return null;
        const iso = pointsRef.current.ts[idx];
        if (!iso) return null;
        return { key: tradeKey(iso), label: `trade ${fmtStamp(iso)}` };
      },
      locateAnchor: (key) => {
        if (!key.startsWith("trade:")) return null;
        const u = plotRef.current;
        if (!u) return null;
        const pts = pointsRef.current;
        const idx = indexOfTs(pts, key.slice(6));
        if (idx === null) return null;
        const y = pts.price[idx];
        if (y === null) return null;
        const px = u.valToPos(pts.xs[idx], "x");
        const py = u.valToPos(y, "y");
        const over = u.over;
        if (px < 0 || px > over.clientWidth || py < 0 || py > over.clientHeight) return null;
        const r = pts.radius[idx];
        const rect = over.getBoundingClientRect();
        return new DOMRect(rect.left + px - r, rect.top + py - r, r * 2, r * 2);
      },
    };
    return registry.publish(provider);
  }, [registry]);

  if (points.xs.length === 0) {
    return (
      <div style={{ padding: 24, fontFamily: MONO, fontSize: 11, color: "var(--text-dim)" }}>
        no moments — a timeline expects rows with a time column and a price
      </div>
    );
  }
  return <div ref={containerRef} style={{ width: "100%", color: "var(--dim)" }} />;
}

/** The index of the point whose stamp is `iso` (by millisecond), or null. */
function indexOfTs(pts: TimelinePoints, iso: string): number | null {
  const ms = isoToMillis(iso);
  if (ms === null) return null;
  const x = ms / 1000;
  const idx = pts.xs.indexOf(x);
  return idx >= 0 ? idx : null;
}

/** The band under price 0: a `--line` fill and a hairline separator. Drawn
 *  after the clear, before the series. */
function drawBand(u: uPlot): void {
  const ctx = u.ctx;
  const top = u.valToPos(0, "y", true);
  const bottom = u.bbox.top + u.bbox.height;
  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.fillStyle = TONE.line;
  ctx.fillRect(u.bbox.left, top, u.bbox.width, Math.max(0, bottom - top));
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = TONE.dim2;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(u.bbox.left, top);
  ctx.lineTo(u.bbox.left + u.bbox.width, top);
  ctx.stroke();
  ctx.restore();
}

/** One sized circle per moment (toned by side, ringed when hovered) and a
 *  dashed hairline + `s1–s2` label in the band wherever the SET score
 *  changes. Drawn over the series. */
function drawMarksAndSets(u: uPlot, pts: TimelinePoints, hoverIdx: number | null): void {
  const ctx = u.ctx;
  const dpr = devicePixelRatio || 1;
  const left = u.bbox.left;
  const right = u.bbox.left + u.bbox.width;
  ctx.save();

  // Set boundaries first, so marks paint over them.
  const steps = pts.steps;
  if (steps) {
    const bandTop = u.valToPos(0, "y", true);
    const bandBottom = u.bbox.top + u.bbox.height;
    ctx.font = `${Math.round(9 * dpr)}px 'JetBrains Mono', 'Cascadia Code', 'SF Mono', Consolas, monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    let prev: string | null = null;
    for (let i = 0; i < pts.xs.length; i++) {
      const s1 = steps.setsP1[i];
      const s2 = steps.setsP2[i];
      if (s1 === null || s2 === null) continue;
      const cur = `${s1}–${s2}`;
      if (prev !== null && cur !== prev) {
        const px = u.valToPos(pts.xs[i], "x", true);
        if (px >= left && px <= right) {
          ctx.strokeStyle = TONE.dim2;
          ctx.lineWidth = 1 * dpr;
          ctx.setLineDash([3 * dpr, 3 * dpr]);
          ctx.beginPath();
          ctx.moveTo(px, bandTop);
          ctx.lineTo(px, bandBottom);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = TONE.text;
          ctx.fillText(cur, px + 3 * dpr, bandTop + 2 * dpr);
        }
      }
      prev = cur;
    }
  }

  // Marks.
  for (let i = 0; i < pts.xs.length; i++) {
    const y = pts.price[i];
    if (y === null) continue;
    const px = u.valToPos(pts.xs[i], "x", true);
    if (px < left || px > right) continue;
    const py = u.valToPos(y, "y", true);
    const r = pts.radius[i] * dpr;
    const side = pts.side[i];
    const tone = side === 1 ? LEVEL_COLORS.up : side === 2 ? LEVEL_COLORS.dn : LEVEL_COLORS.accent;
    const hovered = i === hoverIdx;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.globalAlpha = hovered ? 0.75 : 0.35;
    ctx.fillStyle = tone;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = (hovered ? 1.5 : 1) * dpr;
    ctx.strokeStyle = tone;
    ctx.stroke();
    if (hovered) {
      ctx.beginPath();
      ctx.arc(px, py, r + 3 * dpr, 0, Math.PI * 2);
      ctx.lineWidth = 1 * dpr;
      ctx.strokeStyle = TONE.text;
      ctx.stroke();
    }
  }
  ctx.restore();
}

function fmtStamp(ts: string): string {
  const ms = isoToMillis(ts);
  if (ms === null) return ts;
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
