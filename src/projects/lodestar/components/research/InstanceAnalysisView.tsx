/**
 * Edge-engine Stage 1 UI (spec: pattern-edge-engine.md §8). Renders a grounded instance
 * decomposed into legs (dump / base / rip) as a marked candlestick chart — legs shaded,
 * each leg's decision bar marked — with the LEADING CONFIGURATION at each decision bar
 * listed below. The config is computed from data up to each decision bar only (no
 * look-ahead); this is the raw material the hypotheses are built from.
 *
 * The agent surfaces the analysis (legs + config, bars stripped for its context); this
 * view re-fetches the full analysis so the bars are index-aligned to the leg indices.
 */

import { useEffect, useState } from "react";
import { api, type Bar, type InstanceAnalysis, type InstanceLeg } from "../../api/client";

const UP = "#4ea96a";
const DN = "#e0645b";
const LEG: Record<string, { color: string; label: string }> = {
  dump: { color: "#e0645b", label: "dump" },
  base: { color: "#8a8a93", label: "base" },
  rip: { color: "#4ea96a", label: "rip" },
};

const ROWS: { k: keyof InstanceLeg["config"]; label: string; suffix?: string }[] = [
  { k: "rsi", label: "RSI" },
  { k: "macd_hist", label: "MACD" },
  { k: "ema20_dist_pct", label: "vs EMA20", suffix: "%" },
  { k: "vwap_dist_pct", label: "vs VWAP", suffix: "%" },
  { k: "atr_pct", label: "ATR", suffix: "%" },
  { k: "vol_z", label: "vol-z" },
  { k: "session_range_pct", label: "sess pos", suffix: "%" },
];

function AnalysisChart({ bars, legs }: { bars: Bar[]; legs: InstanceLeg[] }) {
  const finite = bars.filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low));
  if (finite.length < 2 || !bars.length) return <div className="p-6 text-sm text-dim">not enough bars</div>;
  const W = 900;
  const H = 300;
  const PAD = { l: 50, r: 12, t: 14, b: 26 };
  const lo = Math.min(...finite.map((b) => b.low));
  const hi = Math.max(...finite.map((b) => b.high));
  const cw = (W - PAD.l - PAD.r) / bars.length;
  const bw = Math.max(1, Math.min(6, cw * 0.6));
  const x = (i: number): number => PAD.l + i * cw + cw / 2;
  const y = (v: number): number => (hi === lo ? H / 2 : PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
      {/* leg bands */}
      {legs.map((l) => {
        const meta = LEG[l.name] ?? LEG.base;
        return (
          <rect
            key={`band-${l.name}`}
            x={x(l.start) - cw / 2}
            y={PAD.t}
            width={(l.end - l.start + 1) * cw}
            height={H - PAD.t - PAD.b}
            fill={meta.color}
            opacity={0.08}
          />
        );
      })}
      {[hi, (hi + lo) / 2, lo].map((v, i) => (
        <line key={i} x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#1e1e24" strokeDasharray="2 4" />
      ))}
      {bars.map((b, i) =>
        Number.isFinite(b.open) && Number.isFinite(b.close) ? (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={b.close >= b.open ? UP : DN} strokeWidth="1" />
            <rect
              x={x(i) - bw / 2}
              y={y(Math.max(b.open, b.close))}
              width={bw}
              height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
              fill={b.close >= b.open ? UP : DN}
            />
          </g>
        ) : null,
      )}
      {/* decision bars, marked + labeled */}
      {legs.map((l) => {
        const meta = LEG[l.name] ?? LEG.base;
        return (
          <g key={`dec-${l.name}`}>
            <line x1={x(l.decision)} x2={x(l.decision)} y1={PAD.t} y2={H - PAD.b} stroke={meta.color} strokeWidth="1" strokeDasharray="3 2" opacity="0.85" />
            <text x={x(l.decision)} y={PAD.t - 3} textAnchor="middle" fill={meta.color} fontSize="9" fontFamily="monospace">
              {meta.label} ▾
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function InstanceAnalysisView({ result }: { result: Record<string, unknown> }) {
  const symbol = String(result.symbol ?? "ES");
  const timeframe = String(result.timeframe ?? "5m");
  const req = (result.requested ?? {}) as { start?: string; end?: string };
  const passedLegs = (result.legs ?? []) as InstanceLeg[];
  const [full, setFull] = useState<InstanceAnalysis | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (!req.start || !req.end) {
      setErr(true);
      return;
    }
    let cancelled = false;
    api
      .getInstanceAnalysis(symbol, req.start, req.end, timeframe)
      .then((a) => !cancelled && setFull(a))
      .catch(() => !cancelled && setErr(true));
    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, req.start, req.end]);

  const legs = full?.legs ?? passedLegs;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm text-text">{symbol} · instance analysis</span>
        <span className="font-mono text-[10px] text-dim">
          {timeframe} · {String(req.start ?? "").slice(0, 16).replace("T", " ")} → {String(req.end ?? "").slice(0, 16).replace("T", " ")}
        </span>
        <div className="ml-auto flex gap-2 font-mono text-[9px]">
          {Object.entries(LEG).map(([k, m]) => (
            <span key={k} style={{ color: m.color }}>
              ▮ {m.label}
            </span>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded border border-line bg-surface/40 p-2">
        {err ? (
          <div className="p-4 text-sm text-dim">couldn't load bars — showing the leading config only</div>
        ) : full == null ? (
          <div className="h-64 animate-pulse rounded bg-surface2/60" />
        ) : (
          <AnalysisChart bars={full.bars} legs={legs} />
        )}
      </div>
      {/* per-leg leading configuration */}
      {legs.length ? (
        <div className="overflow-x-auto rounded border border-line">
          <table className="w-full text-left font-mono text-[10px]">
            <thead>
              <tr className="border-b border-line bg-surface2/60 text-dim">
                <th className="px-2 py-1 font-normal uppercase tracking-wide">leg</th>
                <th className="px-2 py-1 font-normal uppercase tracking-wide">decision</th>
                {ROWS.map((r) => (
                  <th key={r.k} className="px-2 py-1 font-normal uppercase tracking-wide">{r.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {legs.map((l) => {
                const meta = LEG[l.name] ?? LEG.base;
                return (
                  <tr key={l.name} className="text-text">
                    <td className="px-2 py-1" style={{ color: meta.color }}>{meta.label}</td>
                    <td className="px-2 py-1 text-dim">{String(l.decision_ts ?? "").slice(11, 16) || "—"}</td>
                    {ROWS.map((r) => {
                      const v = l.config?.[r.k] as number | null | undefined;
                      return (
                        <td key={r.k} className="px-2 py-1">
                          {v == null ? "—" : `${(v as number).toFixed(r.k === "rsi" ? 1 : 2)}${r.suffix ?? ""}`}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="font-mono text-[9px] text-dim/70">
        leading config computed from data up to each decision bar only — no look-ahead · the raw material for hypotheses
      </div>
    </div>
  );
}
