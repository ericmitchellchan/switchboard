/**
 * Kalshi Trading / Portfolio - THE chart (SWIT-139): the desk's cash balance
 * (solid) and cumulative realized P&L (accent) over time, one hand-drawn SVG
 * in the approach of FlowShareChart. The two series have different scales (a
 * few hundred dollars of cash, tens of P&L), so each has its own axis: cash on
 * the left in dim ink, P&L on the right in the accent, and the dashed line is
 * P&L's zero. Time ticks are Eastern days.
 *
 * The cursor: moving across the plot snaps a crosshair to the nearest point of
 * either series with a small readout (the day, the balance, the P&L to date);
 * the arrow keys step it, a tap places it, Escape or leaving hides it. The
 * width is measured with a ResizeObserver; the SVG itself is hook-free so a
 * test can render it at a width.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { fmtSigned, fmtUsd } from "../../lib/comboDesk";
import {
  dayTicks,
  labelIndexes,
  niceAxis,
  readoutAt,
  scaleLinear,
  snapTimes,
  type DayBar,
  type PortfolioSeries,
} from "../../lib/comboPortfolio";
import { nearestIndex } from "../../lib/kalshiFlowSeries";
import { SVG_TEXT } from "./flowInk";

export const CASH_INK = "var(--text-primary)";
export const PNL_INK = "var(--accent)";

const PAD = { l: 58, r: 62 } as const;
const TOP = 10;
const PLOT_H = 220;
const AXIS_H = 22;
const H = TOP + PLOT_H + AXIS_H;
/** Width of one character of the 11px mono label, for sizing the readout. */
const CHAR_W = 6.6;

const pathOf = (pts: readonly { x: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

export interface PortfolioChartProps {
  series: PortfolioSeries;
  width: number;
  /** The time the cursor sits on (one of the series' points), or null / absent for none. */
  cursorT?: number | null;
  /** Reports where the cursor moved (null: hidden). Absent: the chart is not interactive. */
  onCursor?: (t: number | null) => void;
}

/** The plain-words description of the chart, for the SVG's label. */
export function portfolioChartLabel(s: PortfolioSeries): string {
  const cash = s.cash[s.cash.length - 1];
  const pnl = s.pnl[s.pnl.length - 1];
  const bits: string[] = [];
  if (cash) bits.push(`balance ${fmtUsd(cash.v)}`);
  if (pnl) bits.push(`realized P&L to date ${fmtSigned(pnl.v)}`);
  return `Cash balance and cumulative realized P&L over time. At the end: ${bits.join(", ")}.`;
}

/** The chart at a given width. Pure of hooks so a test can render it directly. */
export function PortfolioChartSvg({ series: s, width: W, cursorT, onCursor }: PortfolioChartProps) {
  const label = SVG_TEXT;
  const plotR = W - PAD.r;
  const bottom = TOP + PLOT_H;
  const x = scaleLinear(s.t0, s.t1, PAD.l, plotR);

  const cashAxis = s.cash.length ? niceAxis(Math.min(...s.cash.map((q) => q.v)), Math.max(...s.cash.map((q) => q.v)), 4) : null;
  const pnlAxis = s.pnl.length ? niceAxis(Math.min(...s.pnl.map((q) => q.v)), Math.max(...s.pnl.map((q) => q.v)), 4, true) : null;
  const yCash = cashAxis ? scaleLinear(cashAxis.lo, cashAxis.hi, bottom, TOP + 4) : null;
  const yPnl = pnlAxis ? scaleLinear(pnlAxis.lo, pnlAxis.hi, bottom, TOP + 4) : null;
  const ticks = dayTicks(s.t0, s.t1);

  const snaps = snapTimes(s);
  const ci = cursorT != null ? snaps.indexOf(cursorT) : -1;
  const live = !!onCursor && snaps.length > 0;
  const pointAt = (e: PointerEvent<SVGSVGElement>): number | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const sx = r.width > 0 ? ((e.clientX - r.left) * W) / r.width : e.clientX - r.left;
    if (sx < PAD.l - 8 || sx > plotR + 8) return null;
    const i = nearestIndex(snaps.map(x), sx);
    return i < 0 ? null : snaps[i];
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!onCursor) return;
    if (e.key === "Escape") {
      onCursor(null);
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = e.key === "ArrowLeft" ? -1 : 1;
    const next = ci < 0 ? (step < 0 ? snaps.length - 1 : 0) : Math.max(0, Math.min(snaps.length - 1, ci + step));
    onCursor(snaps[next]);
  };

  let cross: ReactNode = null;
  if (ci >= 0) {
    const t = snaps[ci];
    const cx = x(t);
    const rd = readoutAt(s, t, { cash: CASH_INK, pnl: PNL_INK });
    const dot = (key: string, py: number, ink: string) => <circle key={key} cx={cx} cy={py} r={3.5} fill={ink} stroke="var(--bg-secondary)" strokeWidth={1.5} />;
    const dots: ReactNode[] = [];
    const cashHit = s.cash.find((q) => q.t === t);
    const pnlHit = s.pnl.find((q) => q.t === t);
    if (cashHit && yCash) dots.push(dot("cash", yCash(cashHit.v), CASH_INK));
    if (pnlHit && yPnl) dots.push(dot("pnl", yPnl(pnlHit.v), PNL_INK));
    const labelW = Math.max(0, ...rd.rows.map((r) => r.label.length));
    const valueW = Math.max(0, ...rd.rows.map((r) => r.value.length));
    const pw = Math.ceil(Math.max(rd.title.length, labelW + 2 + valueW) * CHAR_W) + 36;
    const ph = 15 + 4 + 16 * rd.rows.length + 7;
    let px0 = cx + 12;
    if (px0 + pw > W - 4) px0 = cx - 12 - pw;
    px0 = Math.max(2, px0);
    const py0 = TOP + 4;
    cross = (
      <g data-crosshair={t} pointerEvents="none">
        <line x1={cx} x2={cx} y1={TOP} y2={bottom} stroke="var(--text-dim)" strokeWidth={1} />
        {dots}
        <g data-readout>
          <rect x={px0} y={py0} width={pw} height={ph} rx={4} fill="var(--bg-secondary)" stroke="var(--border)" strokeWidth={1} />
          <text x={px0 + 10} y={py0 + 15} style={{ ...label, fill: "var(--text-muted)" }}>
            {rd.title}
          </text>
          {rd.rows.map((r, i) => {
            const y = py0 + 15 + 4 + 16 * (i + 1);
            return (
              <g key={r.label}>
                <circle cx={px0 + 14} cy={y - 4} r={2.5} fill={r.ink} />
                <text x={px0 + 22} y={y} style={{ ...label, fill: "var(--text-secondary)" }}>
                  {r.label}
                </text>
                <text x={px0 + pw - 10} y={y} textAnchor="end" style={{ ...label, fill: "var(--text-primary)" }}>
                  {r.value}
                </text>
              </g>
            );
          })}
        </g>
      </g>
    );
  }

  const base = portfolioChartLabel(s);
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={live ? `${base} Move across it, or use the left and right arrow keys, for a readout of the numbers at each point.` : base}
      data-chart="portfolio"
      tabIndex={live ? 0 : undefined}
      style={live ? { touchAction: "pan-y" } : undefined}
      onPointerMove={live ? (e) => onCursor?.(pointAt(e)) : undefined}
      onPointerDown={live ? (e) => onCursor?.(pointAt(e)) : undefined}
      onPointerLeave={live ? (e) => (e.pointerType === "touch" ? undefined : onCursor?.(null)) : undefined}
      onKeyDown={live ? onKey : undefined}
      onBlur={live ? () => onCursor?.(null) : undefined}
    >
      <g pointerEvents="none">
        {ticks.map((tk) => (
          <g key={tk.t}>
            <line x1={x(tk.t)} x2={x(tk.t)} y1={TOP} y2={bottom} stroke="var(--bg-active)" />
            <text x={x(tk.t)} y={H - 6} textAnchor="middle" style={label}>
              {tk.label}
            </text>
          </g>
        ))}
        {cashAxis && yCash
          ? cashAxis.ticks.map((v) => (
              <g key={`c${v}`}>
                <line x1={PAD.l} x2={plotR} y1={yCash(v)} y2={yCash(v)} stroke="var(--bg-active)" />
                <text x={PAD.l - 6} y={yCash(v) + 4} textAnchor="end" style={label}>
                  {fmtUsd(v)}
                </text>
              </g>
            ))
          : null}
        {pnlAxis && yPnl
          ? pnlAxis.ticks.map((v) => (
              <text key={`p${v}`} x={plotR + 6} y={yPnl(v) + 4} style={{ ...label, fill: PNL_INK }}>
                {fmtSigned(v)}
              </text>
            ))
          : null}
        {pnlAxis && yPnl ? (
          <line data-zero="pnl" x1={PAD.l} x2={plotR} y1={yPnl(0)} y2={yPnl(0)} stroke={PNL_INK} strokeDasharray="4 4" opacity={0.6} />
        ) : null}
        {yCash && s.cash.length > 1 ? (
          <path data-series="cash" d={pathOf(s.cash.map((q) => ({ x: x(q.t), y: yCash(q.v) })))} fill="none" stroke={CASH_INK} strokeWidth={2} />
        ) : null}
        {yCash && s.cash.length === 1 ? <circle data-series="cash" cx={x(s.cash[0].t)} cy={yCash(s.cash[0].v)} r={3} fill={CASH_INK} /> : null}
        {yPnl && s.pnl.length > 1 ? (
          <path data-series="pnl" d={pathOf(s.pnl.map((q) => ({ x: x(q.t), y: yPnl(q.v) })))} fill="none" stroke={PNL_INK} strokeWidth={2} />
        ) : null}
        {yPnl ? s.pnl.slice(1).map((q) => <circle key={q.t} cx={x(q.t)} cy={yPnl(q.v)} r={2.5} fill={PNL_INK} />) : null}
      </g>
      {cross}
    </svg>
  );
}

/** The daily bars: one bar per settled day, up (--up) for a profit and down (--dn) for a loss, off a hairline baseline. */
export function DailyBarsSvg({ bars, width: W }: { bars: readonly DayBar[]; width: number }) {
  const label = SVG_TEXT;
  const BAR_TOP = 14;
  const BAR_H = 96;
  const barBottom = BAR_TOP + BAR_H;
  const h = barBottom + AXIS_H;
  const plotR = W - PAD.r;
  const axis = niceAxis(Math.min(...bars.map((b) => b.value)), Math.max(...bars.map((b) => b.value)), 2, true);
  const y = scaleLinear(axis.lo, axis.hi, barBottom, BAR_TOP);
  const band = (plotR - PAD.l) / Math.max(1, bars.length);
  const bw = Math.max(2, Math.min(44, band * 0.62));
  const shown = new Set(labelIndexes(bars.length, Math.max(1, Math.floor((plotR - PAD.l) / 56))));
  const valuesOn = bars.length <= 14;
  const zero = y(0);
  return (
    <svg
      width={W}
      height={h}
      viewBox={`0 0 ${W} ${h}`}
      role="img"
      aria-label={`Realized P&L for each of ${bars.length} settled day${bars.length === 1 ? "" : "s"}.`}
      data-chart="daily"
    >
      {axis.ticks.map((v) => (
        <text key={v} x={PAD.l - 6} y={y(v) + 4} textAnchor="end" style={label}>
          {fmtSigned(v)}
        </text>
      ))}
      {bars.map((b, i) => {
        const cx = PAD.l + band * (i + 0.5);
        const yv = y(b.value);
        const ink = b.tone === "dn" ? "var(--dn)" : "var(--up)";
        return (
          <g key={b.day} data-bar={b.day} data-tone={b.tone ?? "flat"}>
            <title>{b.title}</title>
            <rect x={cx - bw / 2} y={Math.min(yv, zero)} width={bw} height={Math.max(1, Math.abs(yv - zero))} fill={ink} opacity={b.tone ? 0.9 : 0.4} shapeRendering="crispEdges" />
            {valuesOn ? (
              <text x={cx} y={b.value >= 0 ? Math.min(yv, zero) - 4 : Math.max(yv, zero) + 12} textAnchor="middle" style={{ ...label, fill: "var(--text-secondary)" }}>
                {fmtSigned(b.value)}
              </text>
            ) : null}
            {shown.has(i) ? (
              <text x={cx} y={h - 6} textAnchor="middle" style={label}>
                {b.label}
              </text>
            ) : null}
          </g>
        );
      })}
      <line data-baseline x1={PAD.l} x2={plotR} y1={zero} y2={zero} stroke="var(--border)" />
    </svg>
  );
}

/** A box whose measured width the drawing below it follows. */
function useBoxWidth(): [RefObject<HTMLDivElement>, number] {
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
  return [box, w];
}

/** The chart sized to its container. */
export default function PortfolioChart({ series }: { series: PortfolioSeries }) {
  const [box, w] = useBoxWidth();
  const [cursorT, setCursorT] = useState<number | null>(null);
  return (
    <div ref={box} style={{ width: "100%", minWidth: 0 }}>
      <PortfolioChartSvg series={series} width={Math.max(480, w)} cursorT={cursorT} onCursor={setCursorT} />
    </div>
  );
}

/** The daily bars sized to their container. */
export function DailyBars({ bars }: { bars: readonly DayBar[] }) {
  const [box, w] = useBoxWidth();
  return (
    <div ref={box} style={{ width: "100%", minWidth: 0 }}>
      <DailyBarsSvg bars={bars} width={Math.max(480, w)} />
    </div>
  );
}
