/**
 * A pattern match, drilled in (owner ask): click a match card/row → its exact window
 * as a full CANDLESTICK chart with the 64-bar pattern window shaded, the 32-bar forward
 * outcome shaded lighter, and ~16 bars of context before — so you can see "does it
 * actually look like the pattern, and what happened next?". Clear start/end times, the
 * signature (rules) it matched on, and a timeframe toggle to see it across frames.
 */

import { useEffect, useState } from "react";
import { useSurfaceKeydown } from "../../../../surfaces/page-api";
import { api, type Bar, type PriceWindow } from "../../api/client";

const TF_MIN: Record<string, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };

/** Naive-UTC timestamps ("…T14:40:00" / "… 14:40:00") — parse as UTC, not local. */
function utcMs(ts: string): number {
  const s = ts.replace(" ", "T");
  return Date.parse(s.endsWith("Z") ? s : `${s}Z`);
}
const TFS = ["1m", "5m", "15m", "1h"] as const;
const UP = "#4ea96a";
const DN = "#e0645b";
const CTX_BEFORE = 16; // bars of context before the pattern
const CTX_AFTER = 40; // bars after (covers the 32-bar forward outcome + a little)

/** Plain-language read of the abstract shape signature (owner: "let me see the criteria"). */
export function describeSignature(sig?: Record<string, number>): string | null {
  if (!sig) return null;
  const nm = sig.net_move ?? 0;
  const vol = sig.volatility ?? 0;
  const rng = sig.path_range ?? 0;
  const dir =
    Math.abs(nm) < 0.4 ? "ends about where it started (a round trip)" : nm > 0 ? "ends net higher" : "ends net lower";
  const choppy = vol < 0.25 ? "smooth" : vol < 0.4 ? "moderately choppy" : "very choppy";
  const travel = rng < 3 ? "a tight path" : rng < 4.5 ? "a wide path" : "a very wide path";
  return `${dir} · ${choppy} bar-to-bar · ${travel} (~${rng.toFixed(1)}σ traveled)`;
}

export interface PatternMatch {
  symbol?: string;
  timeframe?: string;
  start_ts?: string;
  end_ts?: string;
  net_move?: number;
  volatility?: number;
  path_range?: number;
  fwd_ret_pct?: number | null;
  fwd_max_up_pct?: number | null;
  fwd_max_dn_pct?: number | null;
}

function DetailCandles({
  pts,
  startMs,
  endMs,
}: {
  pts: Bar[];
  startMs: number;
  endMs: number;
}) {
  if (pts.length < 2) return <div className="p-6 text-sm text-dim">not enough bars for this window</div>;
  const W = 900;
  const H = 320;
  const PAD = { l: 52, r: 12, t: 12, b: 28 };
  const lo = Math.min(...pts.map((b) => b.low));
  const hi = Math.max(...pts.map((b) => b.high));
  const maxVol = Math.max(1, ...pts.map((b) => b.volume));
  const cw = (W - PAD.l - PAD.r) / pts.length;
  const bw = Math.max(1, Math.min(6, cw * 0.6));
  const x = (i: number): number => PAD.l + i * cw + cw / 2;
  const y = (v: number): number => (hi === lo ? H / 2 : PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b - 26));
  const volBase = H - PAD.b + 24;
  const volY = (v: number): number => volBase - (v / maxVol) * 22;
  const idx = (pred: (b: Bar) => boolean): number[] => pts.map((b, i) => (pred(b) ? i : -1)).filter((i) => i >= 0);
  const pat = idx((b) => utcMs(b.ts) >= startMs && utcMs(b.ts) <= endMs);
  const fwd = idx((b) => utcMs(b.ts) > endMs).slice(0, 32); // the 32-bar forward horizon (rest is context)
  const band = (ids: number[], fill: string, op: number): React.ReactNode =>
    ids.length ? (
      <rect x={x(ids[0]) - cw / 2} y={PAD.t} width={(ids[ids.length - 1] - ids[0] + 1) * cw} height={H - PAD.t - PAD.b} fill={fill} opacity={op} />
    ) : null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
      {band(pat, "#7c8ce8", 0.12)}
      {band(fwd, "#8a8a93", 0.07)}
      {[hi, (hi + lo) / 2, lo].map((v, i) => (
        <g key={i}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#1e1e24" strokeDasharray="2 4" />
          <text x={PAD.l - 5} y={y(v) + 3} textAnchor="end" fill="#8a8a93" fontSize="9" fontFamily="monospace">
            {v.toFixed(0)}
          </text>
        </g>
      ))}
      {pts.map((b, i) => {
        const up = b.close >= b.open;
        const c = up ? UP : DN;
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={c} strokeWidth="1" />
            <rect x={x(i) - bw / 2} y={y(Math.max(b.open, b.close))} width={bw} height={Math.max(1, Math.abs(y(b.open) - y(b.close)))} fill={c} />
            {b.volume > 0 ? <rect x={x(i) - bw / 2} y={volY(b.volume)} width={bw} height={volBase - volY(b.volume)} fill={c} opacity="0.26" /> : null}
          </g>
        );
      })}
      {/* pattern-window bounds */}
      {pat.length ? (
        <>
          <line x1={x(pat[0]) - cw / 2} x2={x(pat[0]) - cw / 2} y1={PAD.t} y2={H - PAD.b} stroke="#7c8ce8" strokeWidth="0.8" opacity="0.6" />
          <line x1={x(pat[pat.length - 1]) + cw / 2} x2={x(pat[pat.length - 1]) + cw / 2} y1={PAD.t} y2={H - PAD.b} stroke="#7c8ce8" strokeWidth="0.8" opacity="0.6" />
        </>
      ) : null}
      {/* structural points within the pattern window — the swing low ("the bottom") + high */}
      {pat.length
        ? (() => {
            let lowI = pat[0];
            let highI = pat[0];
            for (const i of pat) {
              if (pts[i].low < pts[lowI].low) lowI = i;
              if (pts[i].high > pts[highI].high) highI = i;
            }
            const mark = (i: number, v: number, label: string, col: string, below: boolean): React.ReactNode => (
              <g key={label}>
                <circle cx={x(i)} cy={y(v)} r="4.5" fill="none" stroke={col} strokeWidth="1.4" />
                <text x={x(i)} y={below ? y(v) + 14 : y(v) - 8} textAnchor="middle" fill={col} fontSize="8.5" fontFamily="monospace">
                  {label}
                </text>
              </g>
            );
            return (
              <>
                {mark(lowI, pts[lowI].low, "low", UP, true)}
                {mark(highI, pts[highI].high, "high", DN, false)}
              </>
            );
          })()
        : null}
      <text x={PAD.l} y={H - 8} fill="#55555e" fontSize="8" fontFamily="monospace">
        {pts.length} bars · shaded = pattern · lighter = 32-bar forward · ○ swing low/high
      </text>
    </svg>
  );
}

export default function PatternMatchDetail({
  match,
  signature,
  onClose,
}: {
  match: PatternMatch;
  signature?: Record<string, number>;
  onClose: () => void;
}) {
  const [tf, setTf] = useState(match.timeframe ?? "5m");
  const [win, setWin] = useState<PriceWindow | null>(null);
  const [err, setErr] = useState(false);
  const sym = (match.symbol ?? "ES").replace("@", "");

  useEffect(() => {
    if (!match.start_ts || !match.end_ts) {
      setErr(true);
      return;
    }
    const minutes = TF_MIN[tf] ?? 5;
    const shift = (iso: string, bars: number): string =>
      new Date(utcMs(iso) + bars * minutes * 60000).toISOString();
    let cancelled = false;
    setWin(null);
    setErr(false);
    api
      .getPriceWindow(sym, shift(match.start_ts, -CTX_BEFORE), shift(match.end_ts, CTX_AFTER), tf)
      .then((w) => !cancelled && setWin(w))
      .catch(() => !cancelled && setErr(true));
    return () => {
      cancelled = true;
    };
  }, [match, sym, tf]);

  // SWITCHBOARD: surface-scoped, not window-scoped (page-api).
  useSurfaceKeydown((e) => {
    if (e.key === "Escape") onClose();
  });

  const pts = (win?.bars ?? []).filter(
    (b) => Number.isFinite(b.open) && Number.isFinite(b.close) && Number.isFinite(b.high) && Number.isFinite(b.low),
  );
  const startMs = match.start_ts ? utcMs(match.start_ts) : 0;
  const endMs = match.end_ts ? utcMs(match.end_ts) : 0;
  const stamp = (iso?: string): string => (iso ? iso.slice(0, 16).replace("T", " ") : "—");
  const rules = (["net_move", "volatility", "path_range"] as const).map((k) => ({
    k,
    v: signature?.[k] ?? (match[k] as number | undefined),
  }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-5xl flex-col gap-2 rounded-lg border border-line bg-bg p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-base text-text">{sym}</span>
          <div className="inline-flex overflow-hidden rounded-md border border-line font-mono text-[10px]">
            {TFS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTf(t)}
                className={`px-2 py-0.5 transition-colors ${tf === t ? "bg-surface2 text-text" : "text-dim hover:text-text"}`}
              >
                {t}
              </button>
            ))}
          </div>
          <span className="font-mono text-[11px] text-dim">
            {stamp(match.start_ts)} → {stamp(match.end_ts)}
          </span>
          {match.fwd_ret_pct != null ? (
            <span className="font-mono text-[11px]" style={{ color: match.fwd_ret_pct >= 0 ? UP : DN }}>
              fwd {match.fwd_ret_pct >= 0 ? "+" : ""}
              {match.fwd_ret_pct.toFixed(2)}% (32 bars)
            </span>
          ) : null}
          <button type="button" onClick={onClose} className="ml-auto text-dim hover:text-text">
            ✕
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
          <span className="text-dim">pattern rules ·</span>
          {rules.map(({ k, v }) =>
            v == null ? null : (
              <span key={k} className="rounded border border-line px-1.5 py-0.5">
                <span className="text-dim">{k.replace(/_/g, " ")} </span>
                <span className="text-text">{v.toFixed(3)}</span>
              </span>
            ),
          )}
        </div>
        {(() => {
          const d = describeSignature(
            signature ?? {
              net_move: match.net_move ?? 0,
              volatility: match.volatility ?? 0,
              path_range: match.path_range ?? 0,
            },
          );
          return d ? <div className="font-mono text-[10px] text-dim/80">criteria — {d}</div> : null;
        })()}
        <div className="min-h-0 flex-1 overflow-hidden rounded border border-line bg-surface/40 p-2">
          {err ? (
            <div className="p-6 text-sm text-dim">couldn't load the bars for this window (maybe no {tf} data here)</div>
          ) : win == null ? (
            <div className="h-72 animate-pulse rounded bg-surface2/60" />
          ) : (
            <DetailCandles pts={pts} startMs={startMs} endMs={endMs} />
          )}
        </div>
      </div>
    </div>
  );
}
