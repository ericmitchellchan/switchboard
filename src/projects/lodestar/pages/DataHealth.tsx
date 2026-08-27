/**
 * Data Health — the review surface over the Sextant market-data foundation (SWIT-8 P1 gate).
 *
 * Master/detail workspace, NOT a scrolling document: the contract gate board owns a fixed
 * left pane, the drill-downs fill the right pane and are always in view (owner feedback
 * 2026-08-07 — stacked vertically, levels 2/3 rendered below 68 rows of table and read as
 * "clicking does nothing").
 *
 * The spine: gate board (a contract x its quality gates) -> that contract's coverage across
 * its whole life, session by session -> one session's 1m bars, for the deep-audit eyeball
 * against a broker chart. Every number carries the build that produced it — a claim you
 * can't rebuild isn't a claim.
 *
 * Hand-rolled SVG, no chart library (project convention).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSurfaceKeydown } from "../../../surfaces/page-api";
import {
  api,
  type SextantCoverage,
  type SextantDay,
  type SextantGates,
  type SextantQuality,
} from "../api/client";
import { etTime, ptDate, ptTime, utcTime } from "../lib/time";

const OK = "#4ea96a";
const WARN = "#d9a441";
const FAIL = "#e0645b";
const UP = "#4ea96a";
const DN = "#e0645b";
const SEL = "#8ab4f8";

/** Gate columns: label + how a row scores on it. */
const GATES: {
  key: string;
  label: string;
  score: (g: SextantGates) => { tone: string; text: string; title: string };
}[] = [
  {
    key: "hard_pass",
    label: "pass",
    score: (g) => ({
      tone: g.hard_pass ? OK : FAIL,
      text: g.hard_pass ? "✓" : "✕",
      title: g.hard_pass ? "all hard gates pass" : "a hard gate failed",
    }),
  },
  {
    key: "ohlc",
    label: "ohlc",
    score: (g) => ({
      tone: g.ohlc_violations === 0 ? OK : FAIL,
      text: String(g.ohlc_violations),
      title: `${g.ohlc_violations} bars where high < max(o,c), low > min(o,c), or high < low`,
    }),
  },
  {
    key: "mono",
    label: "mono",
    score: (g) => ({
      tone: g.ts_monotonic ? OK : FAIL,
      text: g.ts_monotonic ? "✓" : "✕",
      title: "timestamps strictly increasing",
    }),
  },
  {
    key: "dupes",
    label: "dupes",
    score: (g) => ({
      tone: g.duplicate_bars === 0 ? OK : FAIL,
      text: String(g.duplicate_bars),
      title: `${g.duplicate_bars} duplicate timestamps`,
    }),
  },
  {
    key: "parity",
    label: "5m",
    score: (g) => ({
      tone: g.parity_5m ? OK : FAIL,
      text: g.parity_5m ? "✓" : "✕",
      title: "stored 5m bars equal a fresh re-aggregation from 1m (single aggregation path)",
    }),
  },
  {
    key: "suspect",
    label: "susp",
    score: (g) => {
      const v = g.suspect_frac ?? 0;
      return {
        tone: v === 0 ? OK : v < 0.001 ? WARN : FAIL,
        text: v === 0 ? "0" : `${(v * 100).toFixed(2)}%`,
        title: `${(v * 100).toFixed(4)}% of bars flagged as possible bad prints (kept, never deleted)`,
      };
    },
  },
  {
    key: "outside",
    label: "outsd",
    score: (g) => {
      const v = g.outside_session_frac ?? 0;
      return {
        tone: v < 0.005 ? OK : v < 0.03 ? WARN : FAIL,
        text: v === 0 ? "0" : `${(v * 100).toFixed(2)}%`,
        title:
          `${(v * 100).toFixed(3)}% of bars fall outside the session envelope — post-settlement ` +
          `strays are normal at ~1%; a large value means a schedule/timezone bug`,
      };
    },
  },
];

const num = (n: number) => n.toLocaleString();

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Drag-to-zoom along x for the SVG charts: press and drag to band-select, release to zoom
 * into that span, double-click to reset. The live band is drawn as a shaded rect between
 * two vertical rails.
 *
 * `zoom` is a [start, end) index window into the caller's full series; the caller slices
 * and rescales its own y-axis, so zooming re-fits the price range to what's on screen.
 */
function useDragZoom(total: number, W: number, padL: number, minSpan = 3) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  // A band-select ends in a click event; this stops that click from also being read as a
  // plain click on whatever mark sits under the release point.
  const didDrag = useRef(false);

  const base = zoom ? zoom[0] : 0;
  const count = zoom ? zoom[1] - zoom[0] : total;
  const plotW = W - padL - 8;

  const vbX = useCallback((clientX: number): number => {
    const el = svgRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * W;
  }, [W]);

  const indexAt = useCallback(
    (x: number): number => clamp(Math.round(((x - padL) / plotW) * count), 0, count),
    [padL, plotW, count],
  );

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const x = vbX(e.clientX);
    if (x < padL) return; // gutter (axis labels), not the plot
    setDrag({ x0: x, x1: x });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!drag) return;
    setDrag({ x0: drag.x0, x1: vbX(e.clientX) });
  };
  const onMouseUp = () => {
    if (!drag) return;
    const { x0, x1 } = drag;
    setDrag(null);
    if (Math.abs(x1 - x0) < 4) return; // a click, not a band
    didDrag.current = true;
    let a = base + indexAt(Math.min(x0, x1));
    let b = base + indexAt(Math.max(x0, x1));
    if (b - a < minSpan) b = a + minSpan;
    b = Math.min(b, base + count);
    a = Math.max(0, Math.min(a, b - minSpan));
    setZoom([a, b]);
  };
  const handlers = {
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onMouseLeave: () => setDrag(null),
    onDoubleClick: () => setZoom(null),
  };

  return {
    svgRef,
    zoom,
    drag,
    handlers,
    vbX,
    indexAt,
    reset: () => setZoom(null),
    /** True if the click now firing is the tail of a band-select — callers should ignore it. */
    consumeDragClick: () => {
      const was = didDrag.current;
      didDrag.current = false;
      return was;
    },
  };
}

/** The live band-select: shaded span between two vertical rails. */
function SelectionBand({
  drag,
  top,
  bottom,
  labels,
}: {
  drag: { x0: number; x1: number } | null;
  top: number;
  bottom: number;
  labels?: [string, string];
}) {
  if (!drag) return null;
  const lo = Math.min(drag.x0, drag.x1);
  const hi = Math.max(drag.x0, drag.x1);
  return (
    <g pointerEvents="none">
      <rect x={lo} y={top} width={hi - lo} height={bottom - top} fill={SEL} opacity={0.13} />
      <line x1={lo} x2={lo} y1={top} y2={bottom} stroke={SEL} strokeWidth={1} />
      <line x1={hi} x2={hi} y1={top} y2={bottom} stroke={SEL} strokeWidth={1} />
      {labels && (
        <>
          <text x={lo + 2} y={top + 9} fill={SEL} fontFamily="monospace" fontSize={9}>
            {labels[0]}
          </text>
          <text x={hi - 2} y={top + 9} textAnchor="end" fill={SEL} fontFamily="monospace" fontSize={9}>
            {labels[1]}
          </text>
        </>
      )}
    </g>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-line bg-surface/40 px-3 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-wider text-dim">{label}</div>
      <div className="font-mono text-sm" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
    </div>
  );
}

/** Level 1 — the gate board (left pane): one symbol at a time, scrollable, sticky header. */
function GateBoard({
  rows,
  selected,
  onSelect,
}: {
  rows: SextantGates[];
  selected: string | null;
  onSelect: (c: string) => void;
}) {
  return (
    <table className="w-full border-collapse font-mono text-[10px]">
      <thead className="sticky top-0 z-10 bg-bg">
        <tr className="text-dim">
          <th className="py-1 pr-1.5 text-left font-normal">contract</th>
          <th className="py-1 pr-1.5 text-right font-normal">rows</th>
          {GATES.map((g) => (
            <th key={g.key} className="px-0.5 py-1 text-center font-normal">
              {g.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.contract}
            onClick={() => onSelect(r.contract)}
            className={`cursor-pointer border-t border-line/40 hover:bg-surface/60 ${
              selected === r.contract ? "bg-surface" : ""
            }`}
          >
            <td className="py-[3px] pr-1.5 text-left" style={selected === r.contract ? { color: SEL } : undefined}>
              {r.contract}
            </td>
            <td className="py-[3px] pr-1.5 text-right text-dim">{num(r.rows_1m)}</td>
            {GATES.map((g) => {
              const s = g.score(r);
              return (
                <td key={g.key} className="px-0.5 py-[3px] text-center" title={s.title}>
                  <span style={{ color: s.tone }}>{s.text}</span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Level 2 — coverage across a contract's life. Each session is a bar; click to relive it. */
function CoverageTimeline({
  cov,
  selectedDate,
  onPick,
}: {
  cov: SextantCoverage;
  selectedDate: string | null;
  onPick: (d: string) => void;
}) {
  const W = 1180;
  const H = 130;
  const PAD_L = 34;
  const PAD_B = 20;
  const all = cov.days;
  const { svgRef, zoom, drag, handlers, reset, consumeDragClick } = useDragZoom(all.length, W, PAD_L);

  // A new contract means new indices — drop any zoom from the previous one.
  useEffect(() => reset(), [cov.contract]); // eslint-disable-line react-hooks/exhaustive-deps

  const days = zoom ? all.slice(zoom[0], zoom[1]) : all;
  if (!all.length) return <div className="text-xs text-dim">no sessions with RTH bars.</div>;

  const bw = Math.max(1, (W - PAD_L - 8) / days.length);
  const y = (pct: number) => H - PAD_B - (pct / 100) * (H - PAD_B - 8);
  const front = all.filter((d) => (d.coverage_pct ?? 0) >= 99.5).length;

  return (
    <div>
      <svg
        ref={svgRef}
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        className="select-none"
        preserveAspectRatio="none"
        style={{ cursor: "crosshair" }}
        {...handlers}
      >
        {[0, 50, 100].map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - 4} y1={y(t)} y2={y(t)} stroke="#2a2f3a" strokeWidth={1} />
            <text x={2} y={y(t) + 3} fill="#6b7280" fontFamily="monospace" fontSize={9}>
              {t}%
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const pct = d.coverage_pct ?? 0;
          const isSel = d.date === selectedDate;
          const tone = isSel ? SEL : pct >= 99.5 ? OK : pct >= 50 ? WARN : "#4a5163";
          return (
            <rect
              key={d.date}
              x={PAD_L + i * bw}
              y={y(pct)}
              width={Math.max(bw - 0.4, 0.8)}
              height={Math.max(y(0) - y(pct), 0.8)}
              fill={tone}
              opacity={isSel ? 1 : 0.9}
              onClick={() => {
                if (consumeDragClick()) return; // tail of a band-select, not a pick
                onPick(d.date);
              }}
              style={{ cursor: "pointer" }}
            >
              <title>
                {`${d.date} · ${d.rth_bars}/${d.expected} RTH bars (${pct.toFixed(1)}%) · ${d.total_bars} total · ${d.session_kind}`}
              </title>
            </rect>
          );
        })}
        <SelectionBand drag={drag} top={4} bottom={H - PAD_B} />
        <text x={PAD_L} y={H - 5} fill="#6b7280" fontFamily="monospace" fontSize={9}>
          {days[0].date}
        </text>
        <text x={W - 4} y={H - 5} textAnchor="end" fill="#6b7280" fontFamily="monospace" fontSize={9}>
          {days[days.length - 1].date}
        </text>
      </svg>
      <div className="mt-1 font-mono text-[10px] text-dim">
        {zoom ? (
          <>
            <span style={{ color: SEL }}>
              zoomed · {days.length} of {all.length} sessions
            </span>{" "}
            · drag to zoom further, double-click to reset
          </>
        ) : (
          <>
            {all.length} sessions · {front} at full coverage (its front period) · the low ragged
            stretch is its back-month life, before it took over. Click a bar to relive that
            session; drag across to zoom.
          </>
        )}
      </div>
    </div>
  );
}

/** Level 3 — one session's 1m bars. The deep-audit eyeball. */
function DayChart({
  day,
  expanded,
  onToggleExpand,
}: {
  day: SextantDay;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const W = 1180;
  const H = expanded ? 620 : 300;
  const PAD_L = 52;
  const PAD_B = 34; // room for the time axis under the volume strip
  const [rthOnly, setRthOnly] = useState(false);
  const all = useMemo(() => (rthOnly ? day.bars.filter((b) => b.in_rth) : day.bars), [day, rthOnly]);
  const { svgRef, zoom, drag, handlers, vbX, indexAt, reset } = useDragZoom(all.length, W, PAD_L);
  const [hover, setHover] = useState<number | null>(null);

  // Indices are only meaningful for one series: reset on a new session or an RTH-filter flip.
  useEffect(() => reset(), [day.contract, day.date, rthOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const bars = zoom ? all.slice(zoom[0], zoom[1]) : all;
  if (!bars.length) return <div className="text-xs text-dim">no bars for this session.</div>;

  const lo = Math.min(...bars.map((b) => b.low));
  const hi = Math.max(...bars.map((b) => b.high));
  const span = hi - lo || 1;
  const bw = (W - PAD_L - 8) / bars.length;
  const y = (p: number) => 8 + (1 - (p - lo) / span) * (H - PAD_B - 12);
  const xOf = (i: number) => PAD_L + i * bw + bw / 2;
  const maxVol = Math.max(...bars.map((b) => b.volume), 1);
  const volTop = H - PAD_B + 2;
  const rthFrom = bars.findIndex((b) => b.in_rth);
  const rthTo = bars.length - 1 - [...bars].reverse().findIndex((b) => b.in_rth);
  const first = bars[0];
  const last = bars[bars.length - 1];

  const hovered = hover != null && hover >= 0 && hover < bars.length ? bars[hover] : null;

  // Time axis: ~9 ticks, labelled in PT (how the owner reads a chart); a tick that opens a
  // new PT calendar date carries the date too — an overnight session spans two of them.
  const tickStep = Math.max(1, Math.round(bars.length / (expanded ? 14 : 9)));
  const ticks: { i: number; time: string; date: string | null }[] = [];
  for (let i = 0; i < bars.length; i += tickStep) {
    const d = ptDate(bars[i].ts);
    const prev = ticks.length ? ticks[ticks.length - 1].date : null;
    ticks.push({ i, time: ptTime(bars[i].ts), date: d !== prev ? d : null });
  }

  const onMove = (e: React.MouseEvent) => {
    handlers.onMouseMove(e);
    setHover(clamp(indexAt(vbX(e.clientX)), 0, bars.length - 1));
  };
  const onLeave = () => {
    handlers.onMouseLeave();
    setHover(null);
  };

  const b = hovered;
  const chg = b ? b.close - b.open : 0;

  return (
    <div>
      {/* toolbar */}
      <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-dim">
        <button
          type="button"
          onClick={() => setRthOnly((v) => !v)}
          className={`rounded border border-line px-1.5 py-0.5 hover:text-text ${rthOnly ? "text-accent" : ""}`}
        >
          {rthOnly ? "RTH only" : "full session"}
        </button>
        {zoom && (
          <button
            type="button"
            onClick={reset}
            className="rounded border border-line px-1.5 py-0.5 hover:text-text"
            style={{ color: SEL }}
          >
            zoomed {bars.length}/{all.length} — reset
          </button>
        )}
        <button
          type="button"
          onClick={onToggleExpand}
          className="rounded border border-line px-1.5 py-0.5 hover:text-text"
          title={expanded ? "collapse (Esc)" : "expand to full screen"}
        >
          {expanded ? "⤡ collapse" : "⤢ full screen"}
        </button>
        <span className="text-dim/70">
          {ptDate(first.ts)} {ptTime(first.ts)}–{ptTime(last.ts)} PT
        </span>
      </div>

      {/* live readout — fixed position so it never jitters under the cursor */}
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded border border-line bg-surface/40 px-2 py-1 font-mono text-[10px]">
        {b ? (
          <>
            <span style={{ color: SEL }}>{ptDate(b.ts)}</span>
            <span className="text-dim">
              {ptTime(b.ts)} PT · {etTime(b.ts)} ET · {utcTime(b.ts)} UTC
            </span>
            <span>
              <span className="text-dim">O</span> {b.open} <span className="text-dim">H</span> {b.high}{" "}
              <span className="text-dim">L</span> {b.low} <span className="text-dim">C</span> {b.close}
            </span>
            <span style={{ color: chg >= 0 ? UP : DN }}>
              {chg >= 0 ? "+" : "−"}
              {Math.abs(chg).toFixed(2)}
            </span>
            <span className="text-dim">vol {num(b.volume)}</span>
            <span className="text-dim">rng {(b.high - b.low).toFixed(2)}</span>
            <span style={{ color: b.in_rth ? SEL : undefined }} className={b.in_rth ? "" : "text-dim"}>
              {b.in_rth ? "RTH" : "ETH"}
            </span>
            {b.suspect && <span style={{ color: FAIL }}>SUSPECT</span>}
            <span className="text-dim/60">{b.source_grade}</span>
          </>
        ) : (
          <span className="text-dim">
            session — <span className="text-dim">O</span> {first.open} <span className="text-dim">H</span> {hi}{" "}
            <span className="text-dim">L</span> {lo} <span className="text-dim">C</span> {last.close} · hover a
            bar for its full detail
          </span>
        )}
      </div>

      <svg
        ref={svgRef}
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        className="select-none"
        style={{ cursor: "crosshair" }}
        onMouseDown={handlers.onMouseDown}
        onMouseMove={onMove}
        onMouseUp={handlers.onMouseUp}
        onMouseLeave={onLeave}
        onDoubleClick={handlers.onDoubleClick}
      >
        {!rthOnly && rthFrom >= 0 && (
          <rect
            x={PAD_L + rthFrom * bw}
            y={4}
            width={Math.max((rthTo - rthFrom + 1) * bw, 1)}
            height={H - PAD_B - 4}
            fill={SEL}
            opacity={0.06}
          />
        )}

        {/* price gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const p = lo + f * span;
          return (
            <g key={f}>
              <line x1={PAD_L} x2={W - 4} y1={y(p)} y2={y(p)} stroke="#2a2f3a" strokeWidth={1} />
              <text x={2} y={y(p) + 3} fill="#6b7280" fontFamily="monospace" fontSize={9}>
                {p.toFixed(2)}
              </text>
            </g>
          );
        })}

        {/* time axis */}
        <line x1={PAD_L} x2={W - 4} y1={H - PAD_B} y2={H - PAD_B} stroke="#2a2f3a" strokeWidth={1} />
        {ticks.map((t) => (
          <g key={t.i}>
            <line
              x1={xOf(t.i)}
              x2={xOf(t.i)}
              y1={8}
              y2={H - PAD_B}
              stroke="#2a2f3a"
              strokeWidth={1}
              opacity={0.45}
            />
            <text
              x={xOf(t.i)}
              y={H - 12}
              textAnchor="middle"
              fill="#6b7280"
              fontFamily="monospace"
              fontSize={9}
            >
              {t.time}
            </text>
            {t.date && (
              <text
                x={xOf(t.i)}
                y={H - 2}
                textAnchor="middle"
                fill="#8b93a1"
                fontFamily="monospace"
                fontSize={8.5}
              >
                {t.date}
              </text>
            )}
          </g>
        ))}
        <text x={2} y={H - 12} fill="#6b7280" fontFamily="monospace" fontSize={8.5}>
          PT
        </text>

        {/* candles + volume */}
        {bars.map((bar, i) => {
          const x = xOf(i);
          const up = bar.close >= bar.open;
          const color = bar.suspect ? FAIL : up ? UP : DN;
          const vh = (bar.volume / maxVol) * (PAD_B - 16);
          return (
            <g key={bar.ts} opacity={bar.in_rth || rthOnly ? 1 : 0.5}>
              <line x1={x} x2={x} y1={y(bar.high)} y2={y(bar.low)} stroke={color} strokeWidth={Math.min(bw * 0.5, 1)} />
              <line
                x1={x}
                x2={x}
                y1={y(Math.max(bar.open, bar.close))}
                y2={y(Math.min(bar.open, bar.close))}
                stroke={color}
                strokeWidth={Math.max(Math.min(bw * 0.8, 3), 0.7)}
              />
              <rect
                x={x - bw / 2}
                y={volTop}
                width={Math.max(bw * 0.8, 0.6)}
                height={vh}
                fill={color}
                opacity={0.35}
              />
              {bar.suspect && <circle cx={x} cy={y(bar.high) - 4} r={2} fill={FAIL} />}
            </g>
          );
        })}

        {/* crosshair on the hovered bar */}
        {b && hover != null && !drag && (
          <g pointerEvents="none">
            <line x1={xOf(hover)} x2={xOf(hover)} y1={4} y2={H - PAD_B} stroke={SEL} strokeWidth={1} opacity={0.55} />
            <line x1={PAD_L} x2={W - 4} y1={y(b.close)} y2={y(b.close)} stroke={SEL} strokeWidth={1} opacity={0.35} />
            <rect x={0} y={y(b.close) - 6} width={PAD_L - 4} height={12} fill={SEL} opacity={0.9} rx={2} />
            <text x={PAD_L - 6} y={y(b.close) + 3} textAnchor="end" fill="#0b0d12" fontFamily="monospace" fontSize={9}>
              {b.close.toFixed(2)}
            </text>
            <rect x={xOf(hover) - 22} y={H - PAD_B + 1} width={44} height={11} fill={SEL} opacity={0.9} rx={2} />
            <text
              x={xOf(hover)}
              y={H - PAD_B + 9.5}
              textAnchor="middle"
              fill="#0b0d12"
              fontFamily="monospace"
              fontSize={8.5}
            >
              {ptTime(b.ts)}
            </text>
          </g>
        )}

        <SelectionBand
          drag={drag}
          top={4}
          bottom={H - PAD_B}
          labels={
            drag
              ? (() => {
                  const i0 = clamp(indexAt(Math.min(drag.x0, drag.x1)), 0, bars.length - 1);
                  const i1 = clamp(indexAt(Math.max(drag.x0, drag.x1)), 0, bars.length - 1);
                  return [ptTime(bars[i0].ts), ptTime(bars[i1].ts)];
                })()
              : undefined
          }
        />
      </svg>
      <div className="mt-1 font-mono text-[10px] text-dim">
        shaded band = RTH · dim bars = overnight · red = suspect print (kept, flagged) ·{" "}
        <span style={{ color: SEL }}>drag to zoom, double-click to reset</span> · times shown in PT
        (ET and UTC in the readout) — compare this against the same contract/day on your broker chart.
      </div>
    </div>
  );
}

export default function DataHealth() {
  const [quality, setQuality] = useState<SextantQuality | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [symbol, setSymbol] = useState("ES");
  const [contract, setContract] = useState<string | null>(null);
  const [cov, setCov] = useState<SextantCoverage | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [day, setDay] = useState<SextantDay | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    api.sextantQuality().then(setQuality).catch((e) => setErr(String(e)));
  }, []);

  // Esc leaves the full-screen chart. SWITCHBOARD: listens on the surface
  // root (page-api), never on window — the terminal's keys stay its own.
  useSurfaceKeydown((e) => {
    if (expanded && e.key === "Escape") setExpanded(false);
  });

  useEffect(() => {
    if (!contract) return;
    setCov(null);
    setDate(null);
    setDay(null);
    api
      .sextantCoverage(contract)
      .then((c) => {
        setCov(c);
        // Land straight on a representative session — the most recent full-coverage day,
        // i.e. this contract while it was front. Saves a click and shows level 3 at once.
        const full = [...c.days].reverse().find((d) => (d.coverage_pct ?? 0) >= 99.5);
        if (full) setDate(full.date);
      })
      .catch((e) => setErr(String(e)));
  }, [contract]);

  useEffect(() => {
    if (!contract || !date) return;
    setDay(null);
    api.sextantDay(contract, date).then(setDay).catch((e) => setErr(String(e)));
  }, [contract, date]);

  const meta = quality?.meta;
  const s = quality?.summary;
  const rows = useMemo(
    () => (quality?.contracts ?? []).filter((c) => c.symbol === symbol),
    [quality, symbol],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* provenance strip — every number on this page came from this build */}
      <div className="flex flex-wrap items-center gap-2">
        {s && (
          <>
            <Tile
              label="contracts passing"
              value={`${s.n_pass} / ${s.n_contracts}`}
              tone={s.n_pass === s.n_contracts ? OK : FAIL}
            />
            <Tile label="1m bars" value={num(s.total_rows_1m)} />
            <Tile label="build" value={meta?.code_sha ?? "—"} />
            <Tile label="manifest" value={meta?.manifest_hash ?? "—"} />
            <Tile
              label="built"
              value={meta?.built_utc ? `${meta.built_utc.slice(0, 16).replace("T", " ")}Z` : "—"}
            />
          </>
        )}
        <div className="ml-auto max-w-md text-right font-mono text-[10px] leading-tight text-dim">
          pick a contract → its coverage across its life → a session → the 1m bars
        </div>
      </div>

      {err && (
        <div className="rounded border border-line bg-surface/40 p-2 text-xs" style={{ color: FAIL }}>
          {err}
        </div>
      )}
      {quality && !quality.available && (
        <div className="rounded border border-line bg-surface/40 p-2 text-xs text-dim">
          {quality.reason ?? "foundation data unavailable"} — run the Orbit-side build
          (<span className="font-mono">foundation/scripts/build_l1.py</span>).
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        {/* left: the gate board */}
        <div className="flex w-[430px] shrink-0 flex-col rounded-lg border border-line bg-surface/20">
          <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
            {["ES", "NQ"].map((sym) => (
              <button
                key={sym}
                type="button"
                onClick={() => setSymbol(sym)}
                className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                  symbol === sym ? "bg-surface text-accent" : "text-dim hover:text-text"
                }`}
              >
                {sym}
              </button>
            ))}
            <span className="ml-auto font-mono text-[10px] text-dim">{rows.length} contracts</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <GateBoard rows={rows} selected={contract} onSelect={setContract} />
          </div>
        </div>

        {/* right: the drill-downs, always in view */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
          {!contract && (
            <div className="flex h-full items-center justify-center rounded-lg border border-line bg-surface/20 p-6 text-center">
              <div className="max-w-md space-y-2">
                <div className="font-mono text-xs uppercase tracking-wider text-dim">
                  pick a contract on the left
                </div>
                <p className="text-xs leading-relaxed text-dim">
                  The board is every contract against every hard gate — all 136 pass today, so
                  what you're really checking is whether the <em>data</em> is right, not whether
                  the gates ran. Click one and you'll get its coverage across its entire life,
                  then land on a representative session's 1m bars to compare against your broker
                  chart.
                </p>
              </div>
            </div>
          )}

          {contract && (
            <div className="rounded-lg border border-line bg-surface/20 p-3">
              <div className="mb-1.5 flex items-baseline gap-3">
                <span className="font-mono text-xs uppercase tracking-wider" style={{ color: SEL }}>
                  {contract}
                </span>
                <span className="font-mono text-[10px] text-dim">
                  coverage — RTH bars present vs the session calendar's expected minutes
                </span>
              </div>
              {cov ? (
                <CoverageTimeline cov={cov} selectedDate={date} onPick={setDate} />
              ) : (
                <div className="py-6 text-center text-xs text-dim">loading…</div>
              )}
            </div>
          )}

          {contract && date && (
            <div
              className={
                expanded
                  ? "fixed inset-0 z-50 overflow-y-auto border border-line bg-bg p-4"
                  : "rounded-lg border border-line bg-surface/20 p-3"
              }
            >
              <div className="mb-1.5 flex items-baseline gap-3">
                <span className="font-mono text-xs uppercase tracking-wider">
                  {contract} · {date}
                </span>
                {day && (
                  <span className="font-mono text-[10px] text-dim">
                    {day.n_bars} bars · {day.n_suspect} suspect
                    {day.session
                      ? ` · ${day.session.session_kind}${
                          day.session.is_half_day ? " (half day)" : ""
                        } · expected ${day.session.expected_rth_minutes} RTH min`
                      : " · no calendar row"}
                  </span>
                )}
              </div>
              {day ? (
                <DayChart day={day} expanded={expanded} onToggleExpand={() => setExpanded((v) => !v)} />
              ) : (
                <div className="py-6 text-center text-xs text-dim">loading…</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
