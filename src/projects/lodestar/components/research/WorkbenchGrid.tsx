/**
 * Case workbench (owner ask 2026-07-03): the case's home surface — a widget
 * dashboard COMPOSED BY THE AGENT at runtime via set_case_workbench. The
 * layout is data on the case; the workspace's normal case sync re-renders it,
 * so widgets the agent adds mid-conversation appear with no reload.
 *
 * Each widget self-fetches what it needs. v1 types: price_chart / flow /
 * metric / note. Unknown types render an honest placeholder (a newer agent
 * may compose types this build can't draw yet).
 */

import { useEffect, useState } from "react";
import FlowDeepDive from "./FlowDeepDive";
import Markdown from "../Markdown";
import { api, type AnomalyMoment, type HistoricalDetail } from "../../api/client";

interface Widget {
  type: string;
  params: Record<string, unknown>;
  title?: string;
}

function Frame({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    // Quiet containment (redesign Direction A): a soft hairline + faint fill,
    // not a hard box — the composed views sit calmly on the canvas.
    <div className="rounded-lg border border-line/40 bg-surface/30 p-3">
      {title ? (
        <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-dim">{title}</div>
      ) : null}
      {children}
    </div>
  );
}

function MetricWidget({ w }: { w: Widget }) {
  return (
    <Frame title={String(w.params.label ?? w.title ?? "metric")}>
      <div className="font-mono text-xl text-text">{String(w.params.value ?? "—")}</div>
      {w.params.note ? <div className="mt-0.5 font-mono text-[10px] text-dim">{String(w.params.note)}</div> : null}
    </Frame>
  );
}

function NoteWidget({ w }: { w: Widget }) {
  // Normalize any literal "\n" the agent emitted so it renders as real prose.
  const text = String(w.params.text ?? "").replace(/\\n/g, "\n");
  return (
    <Frame title={w.title}>
      <div className="text-xs leading-relaxed text-text">
        <Markdown text={text} />
      </div>
    </Frame>
  );
}

/** Compact price/volume chart for a ticker — the workbench's own rendering,
 * independent of the Markets page. */
function PriceChartWidget({ w }: { w: Widget }) {
  const ticker = String(w.params.ticker ?? "");
  const [detail, setDetail] = useState<HistoricalDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!ticker) {
      setErr("widget has no ticker");
      return;
    }
    api
      .getHistoricalDetail(ticker)
      .then((d) => !cancelled && setDetail(d))
      .catch(() => !cancelled && setErr("market data unavailable"));
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  if (err) return <Frame title={w.title ?? ticker}><div className="text-[11px] text-dim">{err}</div></Frame>;
  if (!detail) return <Frame title={w.title ?? ticker}><div className="h-24 animate-pulse rounded bg-surface2/60" /></Frame>;

  const pts = detail.points.filter((p) => p.last_price != null);
  if (pts.length < 2) {
    return <Frame title={w.title ?? ticker}><div className="text-[11px] text-dim">not enough priced ticks</div></Frame>;
  }
  const W = 560;
  const H = 110;
  const prices = pts.map((p) => p.last_price as number);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const x = (i: number): number => (i / (pts.length - 1)) * (W - 8) + 4;
  const y = (v: number): number => (hi === lo ? H / 2 : 6 + (1 - (v - lo) / (hi - lo)) * (H - 30));
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.last_price as number).toFixed(1)}`).join(" ");
  const maxVol = Math.max(1, ...pts.map((p) => p.volume));

  return (
    <Frame title={w.title ?? detail.label ?? ticker}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
        {pts.map((p, i) =>
          p.volume > 0 ? (
            <rect
              key={i}
              x={x(i) - 1}
              y={H - 4 - (p.volume / maxVol) * 18}
              width="2"
              height={(p.volume / maxVol) * 18}
              fill="#5aa6c9"
              opacity="0.5"
            />
          ) : null,
        )}
        <path d={path} fill="none" stroke="#7c8ce8" strokeWidth="1.5" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-dim">
        <span>{lo}–{hi}¢</span>
        <span>{pts.length} pts · vol bars ↓</span>
      </div>
    </Frame>
  );
}

/** The flow-vs-state deep-dive for an anomaly-board match. */
function FlowWidget({ w }: { w: Widget }) {
  const matchId = String(w.params.match_id ?? w.params.ticker ?? "");
  const [detail, setDetail] = useState<HistoricalDetail | null>(null);
  const [moments, setMoments] = useState<AnomalyMoment[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!matchId) {
      setErr("widget has no match_id");
      return;
    }
    api
      .getMatchAnomaly(matchId.split("-").slice(0, 2).join("-"))
      .then(async (r) => {
        if (cancelled) return;
        setMoments(r.moments);
        setTotal(r.match?.n_moments ?? r.moments.length);
        const tkr = r.match?.ticker ?? matchId;
        const d = await api.getHistoricalDetail(tkr);
        if (!cancelled) setDetail(d);
      })
      .catch(() => !cancelled && setErr("not on the anomaly board (or data unavailable)"));
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  if (err) return <Frame title={w.title ?? matchId}><div className="text-[11px] text-dim">{err}</div></Frame>;
  if (!detail || !moments) {
    return <Frame title={w.title ?? matchId}><div className="h-40 animate-pulse rounded bg-surface2/60" /></Frame>;
  }
  return (
    <Frame title={w.title ?? `flow vs state · ${matchId}`}>
      <FlowDeepDive points={detail.points} moments={moments} breaks={[]} sets={[]} totalMoments={total ?? undefined} />
    </Frame>
  );
}

/** Fixed categorical order (dataviz rule: color follows the entity, assigned in
 * order, never cycled or re-ranked). */
const SERIES_COLORS = ["#7c8ce8", "#5aa6c9", "#4ea96a", "#e0645b", "#c9a75a", "#a78bcf"];

interface ChartSeries {
  label: string;
  kind?: string; // line | bars | dots
  points: { x: number | string; y: number }[];
}

/** Agent-composed chart from a declarative spec: the agent computes the data
 * with its tools and hands over points — no code, no reload. ONE y-axis. */
function CustomChartWidget({ w }: { w: Widget }) {
  const series = (w.params.series as ChartSeries[] | undefined) ?? [];
  const provenance = w.params.provenance as Record<string, unknown> | undefined;
  const parsed = series
    .map((s) => ({
      ...s,
      pts: s.points
        .map((p) => ({
          x: typeof p.x === "number" ? p.x : new Date(p.x).getTime(),
          y: p.y,
        }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .sort((a, b) => a.x - b.x),
    }))
    .filter((s) => s.pts.length >= 2);
  if (parsed.length === 0) {
    return <Frame title={w.title ?? "custom chart"}><div className="text-[11px] text-dim">no drawable series in the spec</div></Frame>;
  }
  const isTime = series.some((s) => s.points.some((p) => typeof p.x === "string"));
  const allX = parsed.flatMap((s) => s.pts.map((p) => p.x));
  const allY = parsed.flatMap((s) => s.pts.map((p) => p.y));
  const x0 = Math.min(...allX);
  const x1 = Math.max(...allX);
  const yLo = Math.min(...allY);
  const yHi = Math.max(...allY);
  const W = 560;
  const H = 150;
  const PAD = { l: 42, r: 8, t: 8, b: 18 };
  const sx = (v: number): number => PAD.l + (x1 === x0 ? 0.5 : (v - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
  const sy = (v: number): number => PAD.t + (yHi === yLo ? 0.5 : 1 - (v - yLo) / (yHi - yLo)) * (H - PAD.t - PAD.b);
  const syZero = sy(Math.max(yLo, Math.min(0, yHi))); // bar baseline clamped into range
  const fmtX = (v: number): string =>
    isTime
      ? new Date(v).toLocaleString("en-US", { month: "short", day: "numeric" })
      : String(Math.round(v * 100) / 100);

  return (
    <Frame title={w.title ?? "custom chart"}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
        {[yLo, (yLo + yHi) / 2, yHi].map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={sy(v)} y2={sy(v)} stroke="#1e1e22" strokeDasharray="2 4" />
            <text x={PAD.l - 4} y={sy(v) + 3} textAnchor="end" fill="#8a8a93" fontSize="8" fontFamily="monospace">
              {Math.round(v * 100) / 100}
            </text>
          </g>
        ))}
        {parsed.map((s, si) => {
          const color = SERIES_COLORS[si % SERIES_COLORS.length];
          if (s.kind === "bars") {
            const bw = Math.max(1.5, (W - PAD.l - PAD.r) / Math.max(s.pts.length * 1.6, 1));
            return s.pts.map((pt, i) => (
              <rect key={`${si}-${i}`} x={sx(pt.x) - bw / 2} y={Math.min(sy(pt.y), syZero)}
                width={bw} height={Math.max(1, Math.abs(sy(pt.y) - syZero))} fill={color} opacity="0.75" rx="1" />
            ));
          }
          if (s.kind === "dots") {
            return s.pts.map((pt, i) => (
              <circle key={`${si}-${i}`} cx={sx(pt.x)} cy={sy(pt.y)} r="2.5" fill={color} opacity="0.85" />
            ));
          }
          const d = s.pts.map((pt, i) => `${i === 0 ? "M" : "L"}${sx(pt.x).toFixed(1)},${sy(pt.y).toFixed(1)}`).join(" ");
          return <path key={si} d={d} fill="none" stroke={color} strokeWidth="1.5" />;
        })}
        <text x={PAD.l} y={H - 5} fill="#8a8a93" fontSize="8" fontFamily="monospace">{fmtX(x0)}</text>
        <text x={W - PAD.r} y={H - 5} textAnchor="end" fill="#8a8a93" fontSize="8" fontFamily="monospace">{fmtX(x1)}</text>
      </svg>
      {/* legend — always present for >= 2 series; identity never color-alone */}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-[9px] text-dim">
        {parsed.length >= 2
          ? parsed.map((s, si) => (
              <span key={si} className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-3" style={{ background: SERIES_COLORS[si % SERIES_COLORS.length] }} />
                {s.label}
              </span>
            ))
          : null}
        {w.params.y_label ? <span>y: {String(w.params.y_label)}</span> : null}
        {provenance ? (
          <span className="ml-auto">
            {String(provenance.tool ?? "?")} · {String(provenance.data_window ?? "?")} · n={String(provenance.sample_size ?? "?")}
          </span>
        ) : null}
      </div>
    </Frame>
  );
}

function TableWidget({ w }: { w: Widget }) {
  const columns = (w.params.columns as string[] | undefined) ?? [];
  const rows = (w.params.rows as unknown[][] | undefined) ?? [];
  return (
    <Frame title={w.title ?? "table"}>
      <div className="overflow-x-auto rounded-md border border-line/70">
        <table className="w-full text-left font-mono text-[11px]">
          <thead>
            <tr className="border-b border-line bg-surface2/60 text-dim">
              {columns.map((c, i) => (
                <th key={i} className="whitespace-nowrap px-2.5 py-1.5 text-[10px] font-normal uppercase tracking-wide">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={`text-text ${i % 2 === 1 ? "bg-surface2/25" : ""}`}>
                {columns.map((_, j) => (
                  <td key={j} className="px-2.5 py-1.5 align-top"><span className="break-words">{String(r[j] ?? "—")}</span></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {w.params.note ? <div className="mt-1 font-mono text-[9px] text-dim">{String(w.params.note)}</div> : null}
    </Frame>
  );
}

/** The main (non-chip) widget's element, or null for metric/note. */
function renderMain(w: Widget): React.ReactNode {
  if (w.type === "price_chart") return <PriceChartWidget w={w} />;
  if (w.type === "flow") return <FlowWidget w={w} />;
  if (w.type === "custom_chart") return <CustomChartWidget w={w} />;
  if (w.type === "table") return <TableWidget w={w} />;
  if (w.type === "note") return <NoteWidget w={w} />; // full-width prose, not a chip
  if (w.type === "metric") return null; // rendered in the chip row
  return (
    <Frame title={w.title ?? w.type}>
      <div className="text-[11px] text-dim">this build can't render “{w.type}” widgets yet</div>
    </Frame>
  );
}

export default function WorkbenchGrid({
  widgets,
  onPromote,
  isPromoted,
}: {
  widgets: Widget[];
  /** When present, each artifact shows a "＋ evidence" affordance — the first
   *  rung of the promotion ladder (a conversation artifact becomes a pin). */
  onPromote?: (w: Widget) => void;
  /** Already promoted to evidence? Swaps the button for a settled state so a
   *  second click can't create a duplicate pin. */
  isPromoted?: (w: Widget) => boolean;
}) {
  return (
    <div className="space-y-3">
      {/* metric widgets flow in a chip-like row; notes + charts stack full-width */}
      {widgets.some((w) => w.type === "metric") ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {widgets.filter((w) => w.type === "metric").map((w, i) => (
            <MetricWidget key={i} w={w} />
          ))}
        </div>
      ) : null}
      {widgets.map((w, i) => {
        const el = renderMain(w);
        if (!el) return null;
        return (
          <div key={i} className="group relative">
            {el}
            {onPromote ? (
              isPromoted?.(w) ? (
                <span className="absolute right-2 top-2 rounded border border-line/50 bg-bg/80 px-1.5 py-0.5 font-mono text-[9px] text-dim/70 backdrop-blur-sm">
                  in evidence ✓
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onPromote(w)}
                  title="promote this artifact to evidence"
                  className="absolute right-2 top-2 rounded border border-line/60 bg-bg/80 px-1.5 py-0.5 font-mono text-[9px] text-accent opacity-0 backdrop-blur-sm transition-opacity hover:text-text group-hover:opacity-100"
                >
                  ＋ evidence
                </button>
              )
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
