/**
 * One backtest setup, drilled in (owner ask): click an instance → its window as candles
 * with the ENTRY marked, the tp/stop levels drawn, and the EXIT (first touch, computed
 * from the actual bars) marked — plus the $ P&L for this trade and ← → to toggle through
 * the whole set. This is the "see it on the chart" deep-dive.
 */

import { useEffect, useRef, useState } from "react";
import { useSurfaceKeydown } from "../../../../surfaces/page-api";
import { api, type Bar, type BacktestSetup, type PriceWindow } from "../../api/client";
import { ptTime, ptWeekday, utcTime } from "../../lib/time";

const TF_MIN: Record<string, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60 };

/** Store/bar timestamps are naive UTC ("2026-01-29 14:40:00" / "…T14:40:00") — parse as UTC,
 *  NOT local (new Date() would shift by the tz offset and fetch the wrong window). */
function utcMs(ts: string): number {
  const s = ts.replace(" ", "T");
  return Date.parse(s.endsWith("Z") ? s : `${s}Z`);
}
const UP = "#4ea96a";
const DN = "#e0645b";
const AC = "#6ea8d8";

// fixed-width bars → the chart is drawn at its natural width and scrolls, so bars aren't
// squashed and the entry/exit can sit at the middle of the view.
const BAR_W = 8;
const CH_H = 340;
const CH_PAD = { l: 6, r: 20, t: 28, b: 34 };
const chartX = (i: number): number => CH_PAD.l + i * BAR_W + BAR_W / 2;
const chartWidth = (n: number): number => CH_PAD.l + n * BAR_W + CH_PAD.r;

function Candles({
  bars,
  entryIdx,
  exitIdx,
  entryPx,
  tp,
  stop,
}: {
  bars: Bar[];
  entryIdx: number;
  exitIdx: number;
  entryPx: number;
  tp: number;
  stop: number;
}) {
  const finite = bars.filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low));
  if (finite.length < 2) return <div className="p-6 text-sm text-dim">not enough bars for this window</div>;
  const W = chartWidth(bars.length);
  const H = CH_H;
  const lo = Math.min(stop, ...finite.map((b) => b.low));
  const hi = Math.max(tp, ...finite.map((b) => b.high));
  const bw = Math.max(2, BAR_W * 0.62);
  const x = chartX;
  const y = (v: number): number => (hi === lo ? H / 2 : CH_PAD.t + (1 - (v - lo) / (hi - lo)) * (H - CH_PAD.t - CH_PAD.b));
  const exitI = exitIdx >= 0 ? exitIdx : bars.length - 1;
  const labelX = entryIdx >= 0 ? x(entryIdx) + 10 : 10;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block">
      {/* the trade span (entry → exit) shaded */}
      {entryIdx >= 0 ? (
        <rect x={x(entryIdx)} y={CH_PAD.t} width={(exitI - entryIdx) * BAR_W} height={H - CH_PAD.t - CH_PAD.b} fill={AC} opacity="0.07" />
      ) : null}
      {/* tp / stop — full-width lines, labels near the entry (visible when centred) */}
      {([["tp", tp, UP], ["stop", stop, DN]] as [string, number, string][]).map(([lab, v, col]) => (
        <g key={lab}>
          <line x1={0} x2={W} y1={y(v)} y2={y(v)} stroke={col} strokeWidth="0.9" strokeDasharray="4 3" opacity="0.6" />
          <text x={labelX} y={y(v) - 3} fill={col} fontSize="9" fontFamily="monospace">{lab} {v.toFixed(0)}</text>
        </g>
      ))}
      {/* candles (index-aligned with entry/exit — no filtering) */}
      {bars.map((b, i) =>
        Number.isFinite(b.high) && Number.isFinite(b.close) ? (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} stroke={b.close >= b.open ? UP : DN} strokeWidth="1" />
            <rect x={x(i) - bw / 2} y={y(Math.max(b.open, b.close))} width={bw} height={Math.max(1, Math.abs(y(b.open) - y(b.close)))} fill={b.close >= b.open ? UP : DN} />
          </g>
        ) : null,
      )}
      {/* ENTRY — arrow + label at the BOTTOM (distinct from exit at top) */}
      {entryIdx >= 0 ? (
        <g>
          <line x1={x(entryIdx)} x2={x(entryIdx)} y1={CH_PAD.t} y2={H - CH_PAD.b} stroke={AC} strokeWidth="1" opacity="0.9" />
          <circle cx={x(entryIdx)} cy={y(entryPx)} r="3.5" fill={AC} />
          <path d={`M ${x(entryIdx) - 4} ${H - CH_PAD.b + 11} L ${x(entryIdx) + 4} ${H - CH_PAD.b + 11} L ${x(entryIdx)} ${H - CH_PAD.b + 3} Z`} fill={AC} />
          <text x={x(entryIdx)} y={H - CH_PAD.b + 24} textAnchor="middle" fill={AC} fontSize="9" fontFamily="monospace">ENTRY</text>
        </g>
      ) : null}
      {/* EXIT — marker + label at the TOP */}
      {exitIdx >= 0 ? (
        <g>
          <line x1={x(exitIdx)} x2={x(exitIdx)} y1={CH_PAD.t} y2={H - CH_PAD.b} stroke="#9a9aa4" strokeWidth="0.9" strokeDasharray="3 2" />
          <path d={`M ${x(exitIdx) - 4} ${CH_PAD.t - 10} L ${x(exitIdx) + 4} ${CH_PAD.t - 10} L ${x(exitIdx)} ${CH_PAD.t - 2} Z`} fill="#9a9aa4" />
          <text x={x(exitIdx)} y={CH_PAD.t - 13} textAnchor="middle" fill="#9a9aa4" fontSize="9" fontFamily="monospace">EXIT</text>
        </g>
      ) : null}
    </svg>
  );
}

export default function SetupDetail({
  setups,
  index,
  setIndex,
  symbol,
  timeframe,
  tpAtr,
  stopAtr,
  direction,
  pointValue,
  onClose,
}: {
  setups: BacktestSetup[];
  index: number;
  setIndex: (i: number) => void;
  symbol: string; // the DATA symbol (NQ/ES) for get_price_window
  timeframe: string;
  tpAtr: number;
  stopAtr: number;
  direction: string;
  pointValue: number;
  onClose: () => void;
}) {
  const s = setups[index];
  const [win, setWin] = useState<PriceWindow | null>(null);
  const [err, setErr] = useState(false);
  const [prevDay, setPrevDay] = useState<Bar | null>(null);

  useEffect(() => {
    // the prior trading day's bar — "what it did yesterday" context
    const day = s.ts.slice(0, 10);
    const from = new Date(new Date(day).getTime() - 6 * 86400000).toISOString();
    let cancelled = false;
    api
      .getPriceWindow(symbol, from, `${day}T00:00:00Z`, "1d")
      .then((w) => {
        if (cancelled) return;
        const prior = (w.bars || []).filter((b) => String(b.ts).slice(0, 10) < day);
        setPrevDay(prior[prior.length - 1] ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [s.ts, symbol]);

  useEffect(() => {
    setWin(null);
    setErr(false);
    const m = TF_MIN[timeframe] ?? 5;
    const entry = utcMs(s.ts);
    // as much lead-in (the setup that led here) as follow-through — so the trade isn't
    // clipped at the entry (owner: "see what happened before").
    const start = new Date(entry - 60 * m * 60000).toISOString();
    const end = new Date(entry + 70 * m * 60000).toISOString();
    let cancelled = false;
    api.getPriceWindow(symbol, start, end, timeframe).then((w) => !cancelled && setWin(w)).catch(() => !cancelled && setErr(true));
    return () => {
      cancelled = true;
    };
  }, [s.ts, symbol, timeframe]);

  // SWITCHBOARD: surface-scoped, not window-scoped (page-api).
  useSurfaceKeydown((e) => {
    if (e.key === "ArrowRight" && index < setups.length - 1) setIndex(index + 1);
    else if (e.key === "ArrowLeft" && index > 0) setIndex(index - 1);
    else if (e.key === "Escape") onClose();
  });

  const up = direction === "up";
  const atr = s.atr_pct ?? 0.1;
  const entryPx = s.close;
  const tp = up ? entryPx * (1 + (tpAtr * atr) / 100) : entryPx * (1 - (tpAtr * atr) / 100);
  const stop = up ? entryPx * (1 - (stopAtr * atr) / 100) : entryPx * (1 + (stopAtr * atr) / 100);

  const bars = win?.bars ?? [];
  const entryMs = utcMs(s.ts);
  const entryIdx = bars.findIndex((b) => utcMs(b.ts) >= entryMs);
  // exit = first bar (after entry) that touches tp or stop, from the ACTUAL bars
  let exitIdx = -1;
  let outcome: "win" | "stop" | "open" = "open";
  for (let i = entryIdx + 1; entryIdx >= 0 && i < bars.length; i += 1) {
    const b = bars[i];
    if (up) {
      if (b.low <= stop) { exitIdx = i; outcome = "stop"; break; }
      if (b.high >= tp) { exitIdx = i; outcome = "win"; break; }
    } else {
      if (b.high >= stop) { exitIdx = i; outcome = "stop"; break; }
      if (b.low <= tp) { exitIdx = i; outcome = "win"; break; }
    }
  }
  const rewardPts = Math.abs(tp - entryPx);
  const riskPts = Math.abs(entryPx - stop);
  const pnl = outcome === "win" ? rewardPts * pointValue : outcome === "stop" ? -riskPts * pointValue : null;
  const outColor = outcome === "win" ? UP : outcome === "stop" ? DN : "#8a8a93";

  // centre the scroll view on the entry→exit midpoint (owner: entry/exit at the middle)
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !win || entryIdx < 0) return;
    const exitI = exitIdx >= 0 ? exitIdx : bars.length - 1;
    const midX = (chartX(entryIdx) + chartX(exitI)) / 2;
    el.scrollLeft = Math.max(0, midX - el.clientWidth / 2);
  }, [win, index, entryIdx, exitIdx, bars.length]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div className="flex max-h-full w-full max-w-5xl flex-col gap-2 rounded-lg border border-line bg-bg p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px]">
          <span className="text-sm text-text">{symbol} · {timeframe}</span>
          <span className="text-dim">{s.ts.slice(0, 10)} · {utcTime(s.ts)} UTC · {ptTime(s.ts)} PT</span>
          {entryIdx >= 0 && entryIdx < 20 ? (
            <span className="rounded px-1.5" style={{ background: "rgba(224,180,90,0.15)", color: "#e0b45a" }}>
              session just opened · {entryIdx} bars prior
            </span>
          ) : null}
          <span className="uppercase" style={{ color: outColor }}>{outcome}</span>
          <span><span className="text-dim">entry </span>{entryPx}</span>
          <span><span className="text-dim">tp </span><span style={{ color: UP }}>{tp.toFixed(0)}</span></span>
          <span><span className="text-dim">stop </span><span style={{ color: DN }}>{stop.toFixed(0)}</span></span>
          {pnl != null ? <span><span className="text-dim">P&L </span><span style={{ color: pnl >= 0 ? UP : DN }}>{pnl >= 0 ? "+" : "-"}${Math.abs(pnl).toFixed(0)}</span><span className="text-dim"> /contract</span></span> : null}
          <span className="ml-auto text-dim">{index + 1} / {setups.length}</span>
          <button type="button" onClick={() => index > 0 && setIndex(index - 1)} disabled={index === 0} className="px-1 text-dim hover:text-text disabled:opacity-40">←</button>
          <button type="button" onClick={() => index < setups.length - 1 && setIndex(index + 1)} disabled={index === setups.length - 1} className="px-1 text-dim hover:text-text disabled:opacity-40">→</button>
          <button type="button" onClick={onClose} className="text-dim hover:text-text">✕</button>
        </div>
        {/* context going into the trade */}
        <div className="grid grid-cols-3 gap-x-4 gap-y-1 rounded border border-line bg-surface/40 px-3 py-1.5 font-mono text-[10px] sm:grid-cols-6">
          <div className="sm:col-span-2"><span className="text-dim">time </span>{utcTime(s.ts)} UTC · {ptTime(s.ts)} PT · {ptWeekday(s.ts)}</div>
          <div><span className="text-dim">at </span>{s.close}</div>
          <div><span className="text-dim">RSI </span>{s.rsi ?? "—"}</div>
          <div><span className="text-dim">vs VWAP </span>{s.vwap_dist != null ? `${s.vwap_dist >= 0 ? "+" : ""}${s.vwap_dist}%` : "—"}</div>
          <div><span className="text-dim">above low </span>{s.session_low_dist != null ? `${s.session_low_dist}%` : "—"}</div>
          <div><span className="text-dim">ATR </span>{s.atr_pct != null ? `${s.atr_pct}%` : "—"}</div>
          {prevDay ? (
            <div className="col-span-3 sm:col-span-6">
              <span className="text-dim">yesterday </span>
              O {prevDay.open} H {prevDay.high} L {prevDay.low} C {prevDay.close}
              <span style={{ color: prevDay.close >= prevDay.open ? UP : DN }}>
                {" "}({prevDay.close >= prevDay.open ? "+" : ""}{(((prevDay.close - prevDay.open) / prevDay.open) * 100).toFixed(2)}%)
              </span>
            </div>
          ) : null}
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden rounded border border-line bg-surface/40 p-2">
          {err ? (
            <div className="p-6 text-sm text-dim">couldn't load bars for this window</div>
          ) : win == null ? (
            <div className="h-72 animate-pulse rounded bg-surface2/60" />
          ) : (
            <Candles bars={bars} entryIdx={entryIdx} exitIdx={exitIdx} entryPx={entryPx} tp={tp} stop={stop} />
          )}
        </div>
        <div className="font-mono text-[9px] text-dim2">
          exit = first bar to touch tp or stop on the actual bars (true first-touch) · scroll the chart to pan · ← → to step through setups · Esc to close
        </div>
      </div>
    </div>
  );
}
