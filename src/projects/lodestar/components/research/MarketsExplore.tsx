/**
 * Markets exploration (Trading): a case Study surface as a CROSS-DAY view — days, not one
 * day (owner: "I care about trends"). Orbit already holds ~2.5 years of ES/NQ daily
 * bars (2022-12 → today), so this surfaces the full window as a price trend you can
 * scan for regimes and outlier days, then drill into one session's intraday price +
 * volume. The coverage is stated in-view (owner: "note the window in the exploration").
 * No tick/"calc" capture for the history — daily OHLCV only, which is the point:
 * plain history still widens scenario coverage. Pattern-match is a later lens.
 */

import { useEffect, useRef, useState } from "react";
import { api, type Bar, type SessionSummary } from "../../api/client";

const SYMBOLS = ["ES", "NQ"] as const;
// Trailing window (trading days) → the getMarketSessions limit. ~260 ≈ 1 year.
const WINDOWS: { n: number; label: string }[] = [
  { n: 40, label: "40d" },
  { n: 120, label: "6mo" },
  { n: 260, label: "1yr" },
  { n: 1000, label: "all" },
];
const INTRADAY_TFS = ["1m", "5m", "15m"] as const;
const UP = "#4ea96a";
const DN = "#e0645b";
const BLUE = "#5aa6c9";

const pct = (v: number | null): string => (v == null ? "—" : `${(v * 100).toFixed(2)}%`);
const vol = (v: number): string =>
  v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : String(v);
const asDate = (d: string): Date => new Date(`${d}T00:00:00`);
const shortDate = (d: string): string =>
  asDate(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const monthYear = (d: string): string =>
  asDate(d).toLocaleDateString("en-US", { month: "short", year: "2-digit" });

/**
 * Cross-day trend: daily close as a line (the multi-year arc), each day a
 * direction-colored dot sized by its range% so outlier days pop; click to drill in.
 * Scales from a 40-day window to the full ~2.5-year history.
 */
function TrendLine({
  sessions,
  selected,
  onSelect,
}: {
  sessions: SessionSummary[];
  selected: string | null;
  onSelect: (date: string) => void;
}) {
  const days = [...sessions].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (days.length < 2) return <div className="text-[11px] text-dim">not enough sessions in this window</div>;
  const W = 640;
  const H = 150;
  const PAD = { l: 44, r: 10, t: 12, b: 24 };
  const closes = days.map((d) => d.close).filter(Number.isFinite);
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const maxRange = Math.max(...days.map((d) => d.range_pct ?? 0)) || 0.01;
  const step = (W - PAD.l - PAD.r) / days.length;
  const long = days.length > 180;
  const labelEvery = Math.ceil(days.length / 8);
  const x = (i: number): number => PAD.l + (i / (days.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number): number => (hi === lo ? H / 2 : PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b));
  const path = days
    .map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.close).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
      {[hi, (hi + lo) / 2, lo].map((v, i) => (
        <g key={i}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#1e1e24" strokeDasharray="2 4" />
          <text x={PAD.l - 5} y={y(v) + 3} textAnchor="end" fill="#8a8a93" fontSize="8" fontFamily="monospace">
            {Number.isFinite(v) ? v.toFixed(0) : "—"}
          </text>
        </g>
      ))}
      {days.map((d, i) =>
        d.date === selected ? (
          <line key="sel" x1={x(i)} x2={x(i)} y1={PAD.t} y2={H - PAD.b} stroke="#eaeaed" strokeWidth="1" opacity="0.4" />
        ) : null,
      )}
      <path d={path} fill="none" stroke={BLUE} strokeWidth="1.25" />
      {days.map((d, i) => {
        const on = d.date === selected;
        const r = on ? 3 : 1 + 2 * ((d.range_pct ?? 0) / maxRange);
        const color = (d.change_pct ?? 0) >= 0 ? UP : DN;
        return (
          <g key={d.date} style={{ cursor: "pointer" }} onClick={() => onSelect(d.date)}>
            <rect x={x(i) - Math.max(step / 2, 1)} y={PAD.t} width={Math.max(step, 2)} height={H - PAD.t - PAD.b} fill="transparent" />
            <circle cx={x(i)} cy={y(d.close)} r={r} fill={on ? "#eaeaed" : color} opacity={on ? 1 : 0.7} />
          </g>
        );
      })}
      {days.map((d, i) =>
        i % labelEvery === 0 ? (
          <text key={`l${i}`} x={x(i)} y={H - PAD.b + 13} textAnchor="middle" fill="#55555e" fontSize="7.5" fontFamily="monospace">
            {long ? monthYear(d.date) : shortDate(d.date)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

const CANDLE_W = 640;
const CANDLE_H = 230;
const CANDLE_PAD = { l: 46, r: 10, t: 10, b: 30 };

// --- indicator overlays (v1: computed client-side from the OHLCV we already have) ---
const INDICATORS: { key: string; label: string; color: string }[] = [
  { key: "sma", label: "SMA 20", color: "#d18f5a" },
  { key: "ema", label: "EMA 20", color: "#5aa6c9" },
  { key: "vwap", label: "VWAP", color: "#a78bcf" },
  { key: "seshl", label: "Session H/L", color: "#8a8a93" },
];
const IND_LEN = 20;

function sma(vals: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < vals.length; i += 1) {
    sum += vals[i];
    if (i >= n) sum -= vals[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}
function ema(vals: number[], n: number): (number | null)[] {
  const k = 2 / (n + 1);
  const out: (number | null)[] = [];
  let prev = vals[0] ?? 0;
  for (let i = 0; i < vals.length; i += 1) {
    prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k);
    out.push(i >= n - 1 ? prev : null);
  }
  return out;
}
function vwap(bars: Bar[]): (number | null)[] {
  let pv = 0;
  let vv = 0;
  return bars.map((b) => {
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * (b.volume || 0);
    vv += b.volume || 0;
    return vv > 0 ? pv / vv : null;
  });
}
/** A polyline path over indexed values, skipping leading nulls. */
function linePath(vals: (number | null)[], xf: (i: number) => number, yf: (v: number) => number): string {
  let d = "";
  let started = false;
  vals.forEach((v, i) => {
    if (v == null) return;
    d += `${started ? "L" : "M"}${xf(i).toFixed(1)},${yf(v).toFixed(1)}`;
    started = true;
  });
  return d;
}

/** One day's intraday CANDLESTICKS + volume, with drag-to-zoom (owner: click-drag a
 *  horizontal range → release to zoom; double-click resets). */
function Candles({ bars, inds }: { bars: Bar[]; inds: Set<string> }) {
  const all = bars.filter(
    (b) =>
      Number.isFinite(b.open) && Number.isFinite(b.close) && Number.isFinite(b.high) && Number.isFinite(b.low),
  );
  const [zoom, setZoom] = useState<{ s: number; e: number } | null>(null);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => setZoom(null), [bars]); // a new day/timeframe resets the zoom

  if (all.length < 2) {
    return <div className="text-[11px] text-dim">not enough bars for this day/timeframe</div>;
  }
  const W = CANDLE_W;
  const H = CANDLE_H;
  const PAD = CANDLE_PAD;
  const pts = zoom ? all.slice(zoom.s, zoom.e + 1) : all;
  const lo = Math.min(...pts.map((b) => b.low));
  const hi = Math.max(...pts.map((b) => b.high));
  const maxVol = Math.max(1, ...pts.map((b) => b.volume));
  const cw = (W - PAD.l - PAD.r) / pts.length;
  const bw = Math.max(1, Math.min(7, cw * 0.62));
  const x = (i: number): number => PAD.l + i * cw + cw / 2;
  const y = (v: number): number => (hi === lo ? H / 2 : PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b - 26));
  const volBase = H - PAD.b + 24;
  const volY = (v: number): number => volBase - (v / maxVol) * 22;

  const svgX = (clientX: number): number => {
    const r = svgRef.current?.getBoundingClientRect();
    return r ? ((clientX - r.left) / r.width) * W : 0;
  };
  const barAt = (sx: number): number => Math.max(0, Math.min(pts.length - 1, Math.floor((sx - PAD.l) / cw)));
  const onUp = (): void => {
    if (drag && Math.abs(drag.x1 - drag.x0) > 8) {
      const a = barAt(Math.min(drag.x0, drag.x1));
      const b = barAt(Math.max(drag.x0, drag.x1));
      const base = zoom ? zoom.s : 0; // map the visible slice back to absolute indices
      if (b > a) setZoom({ s: base + a, e: base + b });
    }
    setDrag(null);
  };

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="block w-full cursor-crosshair select-none"
      onMouseDown={(e) => setDrag({ x0: svgX(e.clientX), x1: svgX(e.clientX) })}
      onMouseMove={(e) => drag && setDrag({ ...drag, x1: svgX(e.clientX) })}
      onMouseUp={onUp}
      onMouseLeave={() => setDrag(null)}
      onDoubleClick={() => setZoom(null)}
    >
      {[hi, (hi + lo) / 2, lo].map((v, i) => (
        <g key={i}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#1e1e24" strokeDasharray="2 4" />
          <text x={PAD.l - 5} y={y(v) + 3} textAnchor="end" fill="#8a8a93" fontSize="8" fontFamily="monospace">
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
            {b.volume > 0 ? (
              <rect x={x(i) - bw / 2} y={volY(b.volume)} width={bw} height={volBase - volY(b.volume)} fill={c} opacity="0.28" />
            ) : null}
          </g>
        );
      })}
      {/* indicator overlays */}
      {inds.has("sma") ? <path d={linePath(sma(pts.map((b) => b.close), IND_LEN), x, y)} fill="none" stroke="#d18f5a" strokeWidth="1.1" opacity="0.9" /> : null}
      {inds.has("ema") ? <path d={linePath(ema(pts.map((b) => b.close), IND_LEN), x, y)} fill="none" stroke="#5aa6c9" strokeWidth="1.1" opacity="0.9" /> : null}
      {inds.has("vwap") ? <path d={linePath(vwap(pts), x, y)} fill="none" stroke="#a78bcf" strokeWidth="1.1" opacity="0.9" strokeDasharray="4 2" /> : null}
      {inds.has("seshl")
        ? (() => {
            // the FULL day's extremes — useful reference lines, esp. when zoomed
            const sh = Math.max(...all.map((b) => b.high));
            const sl = Math.min(...all.map((b) => b.low));
            return (
              <>
                {[["H", sh], ["L", sl]].map(([lbl, v]) => (
                  <g key={String(lbl)}>
                    <line x1={PAD.l} x2={W - PAD.r} y1={y(v as number)} y2={y(v as number)} stroke="#8a8a93" strokeWidth="0.8" strokeDasharray="3 3" opacity="0.5" />
                    <text x={W - PAD.r - 2} y={y(v as number) - 2} textAnchor="end" fill="#8a8a93" fontSize="7.5" fontFamily="monospace">
                      {lbl} {(v as number).toFixed(0)}
                    </text>
                  </g>
                ))}
              </>
            );
          })()
        : null}
      {/* the grey drag selection */}
      {drag ? (
        <rect x={Math.min(drag.x0, drag.x1)} y={PAD.t} width={Math.abs(drag.x1 - drag.x0)} height={H - PAD.t - PAD.b} fill="#8a8a93" opacity="0.2" />
      ) : null}
      <text x={PAD.l} y={H - 6} fill="#55555e" fontSize="8" fontFamily="monospace">
        {pts.length} bars{zoom ? " · zoomed — double-click to reset" : " · drag to zoom"}
      </text>
    </svg>
  );
}

export default function MarketsExplore() {
  const [symbol, setSymbol] = useState<(typeof SYMBOLS)[number]>("ES");
  const [windowN, setWindowN] = useState(120);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tf, setTf] = useState<(typeof INTRADAY_TFS)[number]>("5m");
  const [inds, setInds] = useState<Set<string>>(new Set());
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setErr(false);
    // A trailing window of N sessions (order=recent → contiguous by date).
    api
      .getMarketSessions(symbol, windowN, "recent")
      .then((s) => {
        if (cancelled) return;
        setSessions(s);
        setSelected((cur) => (cur && s.some((x) => x.date === cur) ? cur : s[0]?.date ?? null));
      })
      .catch(() => !cancelled && setErr(true));
    return () => {
      cancelled = true;
    };
  }, [symbol, windowN]);

  useEffect(() => {
    if (!selected) {
      setBars(null);
      return;
    }
    let cancelled = false;
    setBars(null);
    // The exact day at the chosen timeframe (get_price_window supports 1m + any frame).
    api
      .getPriceWindow(symbol, `${selected}T00:00:00Z`, `${selected}T23:59:59Z`, tf)
      .then((w) => !cancelled && setBars(w.bars))
      .catch(() => !cancelled && setBars([]));
    return () => {
      cancelled = true;
    };
  }, [symbol, selected, tf]);

  // Guard on the symbol too: on an ES↔NQ switch, `sessions` is briefly the old
  // symbol's, so a bare date match would show a stale OHLC header (review nit).
  const sel = sessions.find((s) => s.date === selected && s.symbol === symbol);
  const coverage =
    sessions.length > 0
      ? {
          n: sessions.length,
          first: sessions.reduce((m, s) => (s.date < m ? s.date : m), sessions[0].date),
          last: sessions.reduce((m, s) => (s.date > m ? s.date : m), sessions[0].date),
        }
      : null;

  return (
    <div className="flex flex-col gap-3 pb-6">
      {/* toolbar: symbol + trailing window */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
        <div className="inline-flex overflow-hidden rounded-md border border-line font-mono text-[11px]">
          {SYMBOLS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSymbol(s)}
              className={`px-2.5 py-0.5 transition-colors ${symbol === s ? "bg-surface2 text-text" : "text-dim hover:text-text"}`}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="ml-1 font-mono text-[9px] uppercase tracking-wide text-dim">window</span>
        {WINDOWS.map((w) => (
          <button
            key={w.n}
            type="button"
            onClick={() => setWindowN(w.n)}
            className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] transition-colors ${
              windowN === w.n ? "border-accent text-accent" : "border-line text-dim hover:text-text"
            }`}
          >
            {w.label}
          </button>
        ))}
        <span className="ml-auto font-mono text-[10px] text-dim">Ctrl+I to ask the agent</span>
      </div>

      {err ? (
        <div className="rounded-lg border border-dashed border-line/70 p-6 text-sm text-dim">
          Couldn't load sessions — Orbit's DuckDB may be missing. Check{" "}
          <span className="font-mono text-text">../orbit/data/orbit.duckdb</span> and reopen.
        </div>
      ) : (
        <>
          {/* cross-day: the price trend over the window, days colored by direction */}
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h3 className="text-sm font-medium text-text">{symbol} · daily close</h3>
              <span className="font-mono text-[10px] text-dim">green up · red down · dot size = range · click a day</span>
              {coverage ? (
                <span className="ml-auto font-mono text-[10px] text-dim/80">
                  {coverage.n} sessions · {coverage.first} → {coverage.last}
                </span>
              ) : null}
            </div>
            <TrendLine sessions={sessions} selected={selected} onSelect={setSelected} />
          </div>

          {/* selected day — candlesticks at a chosen timeframe; pick any day */}
          {selected ? (
            <div className="rounded-lg border border-line bg-surface p-4">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h3 className="text-sm font-medium text-text">
                  {symbol} · {asDate(selected).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </h3>
                <div className="inline-flex overflow-hidden rounded-md border border-line font-mono text-[10px]">
                  {INTRADAY_TFS.map((t) => (
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
                <input
                  type="date"
                  value={selected}
                  onChange={(e) => e.target.value && setSelected(e.target.value)}
                  title="pick a specific day"
                  className="rounded-md border border-line bg-bg px-1.5 py-0.5 font-mono text-[10px] text-text focus:border-accent focus:outline-none"
                />
                <div className="flex flex-wrap items-center gap-1">
                  {INDICATORS.map((ind) => {
                    const on = inds.has(ind.key);
                    return (
                      <button
                        key={ind.key}
                        type="button"
                        onClick={() =>
                          setInds((s) => {
                            const n = new Set(s);
                            if (n.has(ind.key)) n.delete(ind.key);
                            else n.add(ind.key);
                            return n;
                          })
                        }
                        className={`rounded-full border px-2 py-0.5 font-mono text-[9px] transition-colors ${
                          on ? "text-text" : "border-line text-dim hover:text-text"
                        }`}
                        style={on ? { borderColor: ind.color, color: ind.color } : undefined}
                      >
                        {ind.label}
                      </button>
                    );
                  })}
                </div>
                {sel ? (
                  <>
                    <span className="font-mono text-[10px]" style={{ color: (sel.change_pct ?? 0) >= 0 ? UP : DN }}>
                      {(sel.change_pct ?? 0) >= 0 ? "+" : ""}
                      {pct(sel.change_pct)}
                    </span>
                    <span className="font-mono text-[10px] text-dim">range {pct(sel.range_pct)} · vol {vol(sel.volume)}</span>
                  </>
                ) : null}
              </div>
              {bars == null ? (
                <div className="h-40 animate-pulse rounded bg-surface2/60" />
              ) : (
                <Candles bars={bars} inds={inds} />
              )}
            </div>
          ) : null}

          <div className="font-mono text-[10px] text-dim/70">
            Daily OHLCV history (no tick/calc capture) — the trend + scenario base. Next: pattern-match lens (43,891 windows) · promote a day into a case.
          </div>
        </>
      )}
    </div>
  );
}
