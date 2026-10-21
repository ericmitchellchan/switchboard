/**
 * Kalshi Trading / Flow - THE chart (SWIT-130): money vs bets over time, one
 * SVG. Hand-drawn because the band between two lines, signed gap bars with
 * last-season zones, and a rail of sized dots are not what a line-chart
 * component does.
 *
 * From the top:
 *   - share mode: the LEFT side's share of money (solid) and of bets (dashed)
 *     with the band between them tinted toward the side the money leans, an
 *     optional price line, and DraftKings' money share as a dotted line;
 *     totals mode: cumulative dollars (solid) and bets (dashed) per side.
 *   - the gap strip (share mode): money share minus bet share as signed bars,
 *     up = toward the left side. The shaded stripe is ORDINARY (inside last
 *     season's median); the dashed line is the widest fifth. The white line is
 *     the same gap with every $1k+ bet taken out.
 *   - the rail: every $1k+ bet as a dot, area = dollars, left side above the
 *     line, right side below.
 * Each plotted point is a transparent column marked `pt:<iso>` so a pin lands
 * on a point. The width is measured with a ResizeObserver.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NbaFlowBigBet } from "../../api/client";
import { fmtCount, fmtEt, fmtGap, fmtMoney, fmtPct, parseIso, shortSide } from "../../lib/kalshiFlow";
import {
  gapAxisMax,
  pointsIn,
  ticksNeedDay,
  timeTicks,
  type BookPoint,
  type ChartWindow,
  type SharePoint,
} from "../../lib/kalshiFlowSeries";
import { SIDE_INK, SVG_TEXT } from "./flowInk";

export type ChartMode = "share" | "totals";

export interface FlowChartProps {
  mode: ChartMode;
  /** Cumulative points (all of them; the window picks what is in view). */
  points: readonly SharePoint[];
  window: ChartWindow;
  /** Full names of the left and right side (as the timeline and big bets spell them). */
  a: string;
  b: string;
  bigBets: readonly NbaFlowBigBet[];
  /** DraftKings' snapshots for the left side. */
  dk: readonly BookPoint[];
  showPrice: boolean;
  /** Last season's gap percentiles for this line, or null. */
  bands: readonly number[] | null;
  tipMs: number;
  bucketMin: number;
  width: number;
}

const PAD = { l: 52, r: 86 } as const;
const TOP = 10;
const SHARE_H = 230;
const GAP_H = 120;
const RAIL_H = 36;
const AXIS_H = 22;

const pathOf = <P,>(arr: readonly P[], fx: (p: P) => number, fy: (p: P) => number) =>
  arr.map((p, i) => `${i ? "L" : "M"}${fx(p).toFixed(1)},${fy(p).toFixed(1)}`).join(" ");

/** The plain-words description of the last point, for the SVG's label. */
export function chartLabel(points: readonly SharePoint[], a: string, dk: readonly BookPoint[]): string {
  const last = points[points.length - 1];
  if (last) {
    return `Money vs bets over time. At the end, ${shortSide(a)} has ${fmtPct(last.mA)} of the money and ${fmtPct(last.bA)} of the bets.`;
  }
  const d = dk[dk.length - 1];
  return d
    ? `DraftKings splits over time. At the end, ${shortSide(a)} has ${fmtPct(d.money)} of the money and ${fmtPct(d.bets)} of the bets.`
    : "Money vs bets over time. Nothing to draw yet.";
}

/** The chart at a given width. Pure of hooks so a test can render it directly. */
export function FlowChartSvg(p: FlowChartProps) {
  const { mode, window: w, a, b, bigBets, dk, showPrice, bands, tipMs, width: W } = p;
  const share = mode === "share";
  const bucketMs = p.bucketMin * 60_000;
  const vis = pointsIn(p.points, w);
  const dkOnly = vis.length === 0;
  const dkIn = dk.filter((d) => d.t >= w.t0 && d.t <= w.t1);
  const hasGap = share && !dkOnly;
  const gapH = hasGap ? GAP_H : 0;
  const gTop = TOP + SHARE_H + (hasGap ? 30 : 0);
  const railTop = gTop + gapH;
  const hasRail = !dkOnly;
  const H = railTop + (hasRail ? RAIL_H : 0) + AXIS_H;
  const plotR = W - PAD.r;
  const x = (t: number) => PAD.l + ((t - w.t0) / (w.t1 - w.t0)) * (plotR - PAD.l);
  const yPct = (v: number) => TOP + SHARE_H - (v / 100) * SHARE_H;
  const axisBottom = H - AXIS_H;
  const label = SVG_TEXT;

  // Each plotted point owns the stretch from its bucket's start to the next
  // point's bucket start: the shares are cumulative, so a bucket with no bets
  // keeps the previous value and the bars / the hit columns run on unbroken.
  const starts: number[] = [];
  vis.forEach((q, i) => starts.push(Math.max(w.t0, q.t - bucketMs, i > 0 ? starts[i - 1] : -Infinity)));
  const spans = vis.map((q, i) => ({ x0: x(starts[i]), x1: x(i + 1 < vis.length ? starts[i + 1] : q.t) }));

  let body: ReactNode = null;

  if (share) {
    const parts: ReactNode[] = [];
    // the band between the money line and the bet line, tinted toward the side the money leans to
    for (let i = 1; i < vis.length; i++) {
      const p0 = vis[i - 1];
      const p1 = vis[i];
      parts.push(
        <path
          key={`band${i}`}
          d={`M${x(p0.t)},${yPct(p0.mA)} L${x(p1.t)},${yPct(p1.mA)} L${x(p1.t)},${yPct(p1.bA)} L${x(p0.t)},${yPct(p0.bA)} Z`}
          fill={p1.mA - p1.bA >= 0 ? SIDE_INK.a : SIDE_INK.b}
          opacity={0.1}
        />,
      );
    }
    parts.push(
      <line key="mid" x1={PAD.l} x2={plotR} y1={yPct(50)} y2={yPct(50)} stroke="var(--border-subtle)" strokeDasharray="2 4" />,
    );
    for (const v of [0, 25, 50, 75, 100]) {
      parts.push(
        <text key={`y${v}`} x={PAD.l - 6} y={yPct(v) + 4} textAnchor="end" style={label}>
          {v}%
        </text>,
      );
    }
    parts.push(
      <text key="la" x={plotR + 6} y={yPct(100) + 4} style={{ ...label, fill: SIDE_INK.a }}>
        {shortSide(a)}
      </text>,
      <text key="lb" x={plotR + 6} y={yPct(0)} style={{ ...label, fill: SIDE_INK.b }}>
        {shortSide(b)}
      </text>,
    );
    if (showPrice) {
      const priced = vis.filter((q) => q.px != null);
      if (priced.length > 1) {
        parts.push(
          <path key="px" d={pathOf(priced, (q) => x(q.t), (q) => yPct(q.px as number))} fill="none" stroke="var(--text-muted)" strokeWidth={1} opacity={0.7} />,
        );
      }
    }
    if (dkIn.length > 0) {
      parts.push(
        <g key="dk" data-series="dk-money">
          {dkIn.length > 1 ? (
            <path d={pathOf(dkIn, (q) => x(q.t), (q) => yPct(q.money))} fill="none" stroke={SIDE_INK.a} strokeWidth={1.6} strokeDasharray="1 3" strokeLinecap="round" />
          ) : null}
          {dkIn.map((q) => (
            <circle key={q.t} cx={x(q.t)} cy={yPct(q.money)} r={2.2} fill="var(--bg-panel)" stroke={SIDE_INK.a} strokeWidth={1.2} pointerEvents="auto">
              <title>{`DraftKings ${fmtEt(q.t, true)} ET · money ${fmtPct(q.money)} · bets ${fmtPct(q.bets)}`}</title>
            </circle>
          ))}
        </g>,
      );
    }
    if (dkOnly && dkIn.length > 1) {
      // nothing from Kalshi: DraftKings' bet share too, dashed, as the money/bets pair
      parts.push(
        <path key="dkb" d={pathOf(dkIn, (q) => x(q.t), (q) => yPct(q.bets))} fill="none" stroke={SIDE_INK.a} strokeWidth={1.4} strokeDasharray="5 4" opacity={0.8} />,
      );
    }
    if (!dkOnly) {
      parts.push(
        <path key="bets" d={pathOf(vis, (q) => x(q.t), (q) => yPct(q.bA))} fill="none" stroke={SIDE_INK.a} strokeWidth={1.6} strokeDasharray="5 4" />,
        <path key="money" d={pathOf(vis, (q) => x(q.t), (q) => yPct(q.mA))} fill="none" stroke={SIDE_INK.a} strokeWidth={2.2} />,
      );
      // The end values sit in the right gutter, level with where the lines end,
      // pushed apart so they never overlap each other, the side names or the dots.
      const last = vis[vis.length - 1];
      const lo = TOP + 26;
      const hi = TOP + SHARE_H - 18;
      let ym = Math.min(hi, Math.max(lo, yPct(last.mA) + 4));
      let yb = Math.min(hi, Math.max(lo, yPct(last.bA) + 4));
      if (Math.abs(ym - yb) < 14) {
        if (ym <= yb) {
          ym = Math.max(lo, yb - 14);
          yb = Math.max(yb, ym + 14);
        } else {
          yb = Math.max(lo, ym - 14);
          ym = Math.max(ym, yb + 14);
        }
      }
      parts.push(
        <text key="lm" x={plotR + 6} y={ym} style={{ ...label, fill: "var(--text-primary)" }}>
          {`money ${fmtPct(last.mA)}`}
        </text>,
        <text key="lbt" x={plotR + 6} y={yb} style={{ ...label, fill: "var(--text-secondary)" }}>
          {`bets ${fmtPct(last.bA)}`}
        </text>,
      );
    }

    if (hasGap) {
      const z1 = bands ? Math.round(bands[50]) : null;
      const z2 = bands ? Math.round(bands[80]) : null;
      const gMax = gapAxisMax(z2 ?? 20, vis.map((q) => q.gap));
      const gMid = gTop + GAP_H / 2;
      const yG = (v: number) => gMid - (v / gMax) * (GAP_H / 2 - 4);
      parts.push(
        <text key="gh" x={0} y={gTop - 10} style={{ ...label, fill: "var(--text-muted)" }}>
          gap: money share minus bet share, in points
        </text>,
      );
      if (z1 != null && z2 != null) {
        parts.push(
          <rect key="gz" x={PAD.l} y={yG(z1)} width={plotR - PAD.l} height={yG(-z1) - yG(z1)} fill="var(--text-primary)" opacity={0.035} />,
        );
        for (const v of [z1, -z1, z2, -z2]) {
          parts.push(
            <line key={`gl${v}`} x1={PAD.l} x2={plotR} y1={yG(v)} y2={yG(v)} stroke="var(--text-faint)" strokeDasharray={Math.abs(v) === z2 ? "4 3" : "1 4"} />,
            <text key={`gt${v}`} x={PAD.l - 6} y={yG(v) + 4} textAnchor="end" style={label}>
              {fmtGap(v)}
            </text>,
          );
        }
      }
      vis.forEach((q, i) => {
        const { x0, x1 } = spans[i];
        const mag = Math.abs(q.gap);
        const op = z1 == null || z2 == null ? 0.55 : mag >= z2 ? 0.9 : mag >= z1 ? 0.55 : 0.22;
        parts.push(
          <rect
            key={`g${q.t}`}
            x={x0}
            y={Math.min(gMid, yG(q.gap))}
            width={Math.max(1, x1 - x0)}
            height={Math.max(0.5, Math.abs(yG(q.gap) - gMid))}
            fill={q.gap >= 0 ? SIDE_INK.a : SIDE_INK.b}
            opacity={op}
            shapeRendering="crispEdges"
          />,
        );
      });
      // the same gap without $1k+ bets, as a step line over the same stretches
      const exSteps: string[] = [];
      vis.forEach((q, i) => {
        if (q.exGap == null) return;
        const y = yG(Math.max(-gMax, Math.min(gMax, q.exGap))).toFixed(1);
        exSteps.push(`${exSteps.length ? "L" : "M"}${spans[i].x0.toFixed(1)},${y} L${spans[i].x1.toFixed(1)},${y}`);
      });
      if (exSteps.length > 0) {
        parts.push(<path key="ex" d={exSteps.join(" ")} fill="none" stroke="var(--text-primary)" strokeWidth={1.4} opacity={0.85} />);
      }
      parts.push(
        <line key="g0" x1={PAD.l} x2={plotR} y1={gMid} y2={gMid} stroke="var(--border-subtle)" />,
        <text key="gta" x={plotR + 6} y={gTop + 10} style={{ ...label, fill: SIDE_INK.a }}>
          {`$ → ${shortSide(a)}`}
        </text>,
        <text key="gtb" x={plotR + 6} y={gTop + GAP_H - 2} style={{ ...label, fill: SIDE_INK.b }}>
          {`$ → ${shortSide(b)}`}
        </text>,
      );
      const lg = vis[vis.length - 1];
      parts.push(
        <text key="glast" x={x(lg.t) - 6} y={yG(lg.gap) + (lg.gap >= 0 ? -6 : 14)} textAnchor="end" style={{ ...label, fill: "var(--text-primary)" }}>
          {`${fmtGap(lg.gap)} pts`}
        </text>,
      );
    }
    body = <>{parts}</>;
  } else {
    // totals: cumulative dollars solid, bets dashed, per side
    const maxH = Math.max(1, ...vis.map((q) => Math.max(q.ha, q.hb)));
    const maxN = Math.max(1, ...vis.map((q) => Math.max(q.na, q.nb)));
    const yH = (v: number) => TOP + SHARE_H - (v / maxH) * SHARE_H;
    const yN = (v: number) => TOP + SHARE_H - (v / maxN) * SHARE_H;
    const bottom = TOP + SHARE_H;
    body = (
      <>
        <text x={PAD.l - 6} y={yH(maxH) + 4} textAnchor="end" style={label}>{fmtMoney(maxH)}</text>
        <text x={PAD.l - 6} y={bottom} textAnchor="end" style={label}>$0</text>
        <text x={plotR + 6} y={yN(maxN) + 4} style={label}>{`${fmtCount(maxN)} bets`}</text>
        <text x={plotR + 6} y={bottom} style={label}>0</text>
        {vis.length > 0
          ? (["a", "b"] as const).map((k) => (
              <g key={k}>
                <path d={pathOf(vis, (q) => x(q.t), (q) => yN(k === "a" ? q.na : q.nb))} fill="none" stroke={SIDE_INK[k]} strokeWidth={1.5} strokeDasharray="5 4" />
                <path d={pathOf(vis, (q) => x(q.t), (q) => yH(k === "a" ? q.ha : q.hb))} fill="none" stroke={SIDE_INK[k]} strokeWidth={2.2} />
              </g>
            ))
          : null}
      </>
    );
  }

  // time axis, the tip, the in-game wash
  const ticks = timeTicks(w.t0, w.t1);
  const day = ticksNeedDay(w.t0, w.t1);
  const tipX = Number.isFinite(tipMs) && tipMs >= w.t0 && tipMs <= w.t1 ? x(tipMs) : null;

  // the rail of $1k+ bets
  const maxD = Math.max(BIG_FLOOR, ...bigBets.map((z) => z.dollars));
  const railY = railTop + RAIL_H / 2 + 2;
  const dots = bigBets.flatMap((z) => {
    const t = parseIso(z.ts);
    if (!Number.isFinite(t) || t < w.t0 || t > w.t1) return [];
    const k: "a" | "b" = z.side === a ? "a" : "b";
    const r = 2.5 + Math.sqrt(z.dollars / maxD) * 8;
    return [{ z, t, k, r }];
  });

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chartLabel(p.points, a, dk)} data-chart={mode}>
      {/* The pin columns come FIRST, under everything, and the drawing lets clicks
          through (pointer-events none) so a click lands on its column - while the
          rail and DraftKings dots, which carry tooltips, take their own hover. */}
      {vis.map((q, i) => {
        const iso = new Date(q.t).toISOString();
        return (
          // SWITCHBOARD: `data-anchor` makes the point pinnable (surfaces/anchors.ts).
          <rect
            key={iso}
            x={spans[i].x0}
            y={TOP}
            width={Math.max(2, spans[i].x1 - spans[i].x0)}
            height={axisBottom - TOP}
            fill="transparent"
            data-anchor={`pt:${iso}`}
            data-anchor-label={`${fmtEt(q.t, true)} ET · money ${fmtPct(q.mA)} · bets ${fmtPct(q.bA)}`}
          >
            <title>{`${fmtEt(q.t, true)} ET · money ${fmtPct(q.mA)} · bets ${fmtPct(q.bA)} · gap ${fmtGap(q.gap)}`}</title>
          </rect>
        );
      })}
      <g pointerEvents="none">
        {tipX !== null && w.t1 > tipMs ? (
          <rect x={tipX} y={TOP} width={x(w.t1) - tipX} height={axisBottom - TOP} fill="var(--text-primary)" opacity={0.025} />
        ) : null}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={TOP} y2={axisBottom} stroke="var(--bg-active)" />
            <text x={x(t)} y={H - 6} textAnchor="middle" style={label}>{fmtEt(t, day)}</text>
          </g>
        ))}
        {body}
        {tipX !== null ? (
          <g>
            <line x1={tipX} x2={tipX} y1={TOP} y2={axisBottom} stroke="var(--text-muted)" />
            <text x={tipX - 4} y={TOP + 10} textAnchor="end" style={{ ...label, fill: "var(--text-muted)" }}>tip</text>
          </g>
        ) : null}
      </g>
      {hasRail ? (
        <g data-rail="big-bets" pointerEvents="none">
          <line x1={PAD.l} x2={plotR} y1={railY} y2={railY} stroke="var(--border)" />
          {dots.map(({ z, t, k, r }) => (
            <circle key={`${z.ts}${z.side}${z.dollars}`} cx={x(t)} cy={railY + (k === "a" ? -1 : 1) * Math.min(r, 7)} r={r} fill={SIDE_INK[k]} opacity={0.85} pointerEvents="auto">
              <title>{`${shortSide(z.side)} · ${fmtMoney(z.dollars)}${z.price != null ? ` · ${Math.round(z.price)}¢` : ""}`}</title>
            </circle>
          ))}
        </g>
      ) : null}
    </svg>
  );
}

/** What the chart actually draws for these inputs, so the legend lists only that. */
export function chartContents(
  c: Pick<FlowChartProps, "points" | "window" | "dk" | "bigBets" | "a">,
): { points: boolean; dk: boolean; price: boolean; exGap: boolean; big: boolean } {
  const vis = pointsIn(c.points, c.window);
  const inWin = (t: number) => t >= c.window.t0 && t <= c.window.t1;
  return {
    points: vis.length > 0,
    dk: c.dk.some((d) => inWin(d.t)),
    price: vis.filter((q) => q.px != null).length > 1,
    exGap: vis.some((q) => q.exGap != null),
    big: vis.length > 0 && c.bigBets.some((z) => inWin(parseIso(z.ts))),
  };
}

const BIG_FLOOR = 1000;

/** The chart sized to its container. */
export default function FlowShareChart(props: Omit<FlowChartProps, "width">) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(960);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      const cw = Math.floor(el.clientWidth);
      if (cw > 0) setW(cw);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} style={{ width: "100%", minWidth: 0 }}>
      <FlowChartSvg {...props} width={Math.max(480, w)} />
    </div>
  );
}
