/**
 * Path Case — the whole journey of a moment, every minute, with NO default window.
 *
 * Eric's brief: "I still feel like you're defaulting to default windows… let's see the
 * maximum, minimum, and the variance between the volatility between the paths. What's the
 * normal distribution? We should have a sampler where you can see certain cases on the
 * actual chart, and the overall metrics plotted across all these tests."
 *
 * So: the horizon is a SLIDER, not a constant. Everything on the page recomputes from it.
 *   1. The path fan       — p10/p25/median/p75/p90 of where price actually went, per minute
 *   2. Max & min envelope — running MFE and MAE, the range the path actually covered
 *   3. Dispersion         — cross-sectional IQR/sd per minute: the volatility BETWEEN paths
 *   4. The distribution   — outcomes at the chosen horizon vs a matched normal curve
 *   5. The sampler        — real bars of individual instances, the signal marked
 *   6. Cross-moment table — the same metrics for every moment, side by side
 *
 * Plain-English-first per Eric's standing rule. Hand-rolled SVG, no chart libs.
 */

import { useEffect, useMemo, useState } from "react";
import { getJson } from "../api/client";

const OK = "#4ea96a";
const FAIL = "#e0645b";
const SEL = "#8ab4f8";
const MUTE = "#6d7684";

interface Curve {
  t: number; n: number; p10: number; p25: number; med: number; p75: number; p90: number;
  mean: number; sd: number; iqr: number; adj_mean: number; base_mean: number;
  mfe_med: number; mfe_p75: number; mae_med: number; mae_p75: number; under: number;
}
interface Dist {
  available: boolean; n?: number; mean?: number; sd?: number; median?: number;
  skew?: number; excess_kurtosis?: number; within_1sd?: number; gauss_within_1sd?: number;
  p05?: number; p95?: number; bins?: { x: number; n: number }[];
  tails?: { k: number; observed: number; normal: number; ratio: number }[];
}
interface MomentData {
  available: boolean; moment: string; horizon: number; max_t: number;
  curves: Curve[]; distribution: Dist;
  summary: { n: number | null; median_room: number | null; rv_med: number | null;
    mfe_med: number | null; mae_med: number | null; t_best_med: number | null;
    t_worst_med: number | null; under_med: number | null };
}
interface Bar { rel: number; et: string; o: number; h: number; l: number; c: number }
interface Case { id: number; session: string; dir: number; entry: number; atr_at: number;
  et_at_signal: string; bars: Bar[] }

const MOMENT_LABEL: Record<string, string> = {
  k1a: "K1a — fresh efficient movement",
  doji30: "Doji (30m), continuation reading",
  burst5: "Burst — a fast move vs the recent norm",
};

const fmt = (v: number | null | undefined, d = 2) =>
  v == null || !isFinite(v) ? "—" : (v >= 0 ? "+" : "") + v.toFixed(d);

/** Panels 1-3: the fan, the max/min envelope, and the between-path dispersion. */
function PathFan({ curves, horizon }: { curves: Curve[]; horizon: number }) {
  const W = 720, H = 300, PL = 48, PB = 28, PT = 12;
  const c = curves.filter((r) => r.t <= horizon);
  if (c.length < 3) return null;
  const lo = Math.min(...c.map((r) => Math.min(r.p10, -r.mae_p75)));
  const hi = Math.max(...c.map((r) => Math.max(r.p90, r.mfe_p75)));
  const x = (t: number) => PL + ((t - 1) / Math.max(1, horizon - 1)) * (W - PL - 10);
  const y = (v: number) => PT + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (H - PT - PB);
  const area = (a: keyof Curve, b: keyof Curve) =>
    c.map((r) => `${x(r.t)},${y(r[a] as number)}`).join(" ") + " " +
    c.slice().reverse().map((r) => `${x(r.t)},${y(r[b] as number)}`).join(" ");
  const line = (k: keyof Curve, sign = 1) =>
    c.map((r, i) => `${i ? "L" : "M"}${x(r.t)},${y(sign * (r[k] as number))}`).join(" ");
  const ticks = [lo, (lo + hi) / 2, 0, hi].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <svg width={W} height={H} role="img" aria-label="Path fan with max and min envelope">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PL} x2={W - 10} y1={y(v)} y2={y(v)} stroke={v === 0 ? "#3a4150" : "#242a35"} />
          <text x={PL - 6} y={y(v) + 4} fill={MUTE} fontSize="10" textAnchor="end">{v.toFixed(1)}</text>
        </g>
      ))}
      <polygon points={area("p10", "p90")} fill={SEL} opacity={0.10} />
      <polygon points={area("p25", "p75")} fill={SEL} opacity={0.20} />
      <path d={line("mfe_med")} stroke={OK} strokeWidth={1.5} fill="none" strokeDasharray="4 3" />
      <path d={line("mae_med", -1)} stroke={FAIL} strokeWidth={1.5} fill="none" strokeDasharray="4 3" />
      <path d={line("med")} stroke={SEL} strokeWidth={2} fill="none" />
      <path d={line("base_mean")} stroke={MUTE} strokeWidth={1.5} fill="none" strokeDasharray="2 3" />
      <text x={PL} y={H - 8} fill={MUTE} fontSize="10">1 min</text>
      <text x={W - 10} y={H - 8} fill={MUTE} fontSize="10" textAnchor="end">{horizon} min</text>
    </svg>
  );
}

/** Panel 3: the volatility BETWEEN paths — how much the outcomes spread as time passes. */
function Dispersion({ curves, horizon }: { curves: Curve[]; horizon: number }) {
  const W = 340, H = 150, PL = 40, PB = 24, PT = 10;
  const c = curves.filter((r) => r.t <= horizon);
  if (c.length < 3) return null;
  const hi = Math.max(...c.map((r) => r.iqr));
  const x = (t: number) => PL + ((t - 1) / Math.max(1, horizon - 1)) * (W - PL - 10);
  const y = (v: number) => PT + (1 - v / Math.max(1e-9, hi)) * (H - PT - PB);
  return (
    <svg width={W} height={H} role="img" aria-label="Spread between paths over time">
      <line x1={PL} x2={W - 10} y1={y(0)} y2={y(0)} stroke="#3a4150" />
      <path d={c.map((r, i) => `${i ? "L" : "M"}${x(r.t)},${y(r.iqr)}`).join(" ")}
        stroke="#d9a441" strokeWidth={2} fill="none" />
      <text x={PL - 6} y={y(hi) + 4} fill={MUTE} fontSize="10" textAnchor="end">{hi.toFixed(1)}</text>
      <text x={PL} y={H - 6} fill={MUTE} fontSize="10">spread (IQR, ATR) — grows with time</text>
    </svg>
  );
}

/** Panel 4: is the outcome distribution normal? Histogram vs a matched Gaussian. */
function Distribution({ d }: { d: Dist }) {
  const W = 340, H = 150, PL = 30, PB = 24, PT = 10;
  if (!d.available || !d.bins?.length) return <p style={{ color: MUTE }}>Not enough data.</p>;
  const maxN = Math.max(...d.bins.map((b) => b.n));
  const xs = d.bins.map((b) => b.x);
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const x = (v: number) => PL + ((v - lo) / Math.max(1e-9, hi - lo)) * (W - PL - 10);
  const y = (n: number) => PT + (1 - n / Math.max(1, maxN)) * (H - PT - PB);
  const step = (hi - lo) / Math.max(1, d.bins.length - 1);
  const g = (v: number) => {
    const z = (v - (d.mean ?? 0)) / Math.max(1e-9, d.sd ?? 1);
    return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI) / Math.max(1e-9, d.sd ?? 1);
  };
  const gMax = Math.max(...xs.map(g));
  return (
    <svg width={W} height={H} role="img" aria-label="Outcome distribution vs normal">
      {d.bins.map((b) => (
        <rect key={b.x} x={x(b.x) - 3} y={y(b.n)} width={6} height={Math.max(0, y(0) - y(b.n))}
          fill={SEL} opacity={0.5} />
      ))}
      <path d={xs.map((v, i) => `${i ? "L" : "M"}${x(v)},${y((g(v) / gMax) * maxN)}`).join(" ")}
        stroke={FAIL} strokeWidth={1.5} fill="none" />
      <line x1={x(0)} x2={x(0)} y1={PT} y2={y(0)} stroke="#3a4150" strokeDasharray="3 3" />
      <text x={PL} y={H - 6} fill={MUTE} fontSize="10">outcome (ATR) · red = matched normal</text>
      <text x={W - 10} y={H - 6} fill={MUTE} fontSize="10" textAnchor="end">
        step {step.toFixed(2)}
      </text>
    </svg>
  );
}

/** Panel 5: the sampler — an actual instance on an actual chart. */
function Sampler({ c }: { c: Case }) {
  const W = 720, H = 260, PL = 46, PB = 24, PT = 10;
  const bars = c.bars;
  if (bars.length < 5) return null;
  const lo = Math.min(...bars.map((b) => b.l)), hi = Math.max(...bars.map((b) => b.h));
  const x = (r: number) => PL + ((r - bars[0].rel) / Math.max(1, bars[bars.length - 1].rel - bars[0].rel)) * (W - PL - 10);
  const y = (v: number) => PT + (1 - (v - lo) / Math.max(1e-9, hi - lo)) * (H - PT - PB);
  const w = Math.max(1, (W - PL - 10) / bars.length * 0.7);
  return (
    <svg width={W} height={H} role="img" aria-label={`Sample instance ${c.session}`}>
      <line x1={x(0)} x2={x(0)} y1={PT} y2={H - PB} stroke={SEL} strokeWidth={1.5} strokeDasharray="4 3" />
      <line x1={PL} x2={W - 10} y1={y(c.entry)} y2={y(c.entry)} stroke={MUTE} strokeDasharray="2 4" />
      {bars.map((b) => {
        const up = b.c >= b.o;
        return (
          <g key={b.rel}>
            <line x1={x(b.rel)} x2={x(b.rel)} y1={y(b.h)} y2={y(b.l)}
              stroke={b.rel < 0 ? "#4a5262" : up ? OK : FAIL} strokeWidth={0.8} />
            <rect x={x(b.rel) - w / 2} y={y(Math.max(b.o, b.c))} width={w}
              height={Math.max(0.8, Math.abs(y(b.o) - y(b.c)))}
              fill={b.rel < 0 ? "#4a5262" : up ? OK : FAIL} opacity={b.rel < 0 ? 0.5 : 0.9} />
          </g>
        );
      })}
      <text x={PL} y={H - 6} fill={MUTE} fontSize="10">
        {c.session} · signal at {c.et_at_signal} ET · {c.dir > 0 ? "long" : "short"} · grey = before the signal
      </text>
    </svg>
  );
}

export default function PathCase() {
  const [instrument] = useState("NQ");
  const [moment, setMoment] = useState("k1a");
  const [horizon, setHorizon] = useState(240);
  const [data, setData] = useState<MomentData | null>(null);
  const [all, setAll] = useState<Record<string, MomentData>>({});
  const [cases, setCases] = useState<Case[]>([]);
  const [idx, setIdx] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getJson<MomentData>(`/sextant/paths/${instrument}/${moment}?horizon=${horizon}`)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(String(e)));
  }, [instrument, moment, horizon]);

  useEffect(() => {
    getJson<{ cases: Case[] }>(`/sextant/paths/${instrument}/${moment}/samples`)
      .then((d) => { setCases(d.cases); setIdx(0); })
      .catch(() => setCases([]));
  }, [instrument, moment]);

  useEffect(() => {
    Object.keys(MOMENT_LABEL).forEach((m) => {
      getJson<MomentData>(`/sextant/paths/${instrument}/${m}?horizon=${horizon}`)
        .then((d) => setAll((p) => ({ ...p, [m]: d }))).catch(() => undefined);
    });
  }, [instrument, horizon]);

  const atH = useMemo(
    () => data?.curves.find((r) => r.t === horizon) ?? data?.curves.slice(-1)[0],
    [data, horizon]);

  if (err) return <div style={{ padding: 24, color: FAIL }}>Path case unavailable: {err}</div>;
  if (!data || !atH) return <div style={{ padding: 24, color: MUTE }}>Loading paths…</div>;
  const d = data.distribution;

  return (
    <div style={{ padding: 24, maxWidth: 1180 }}>
      <h1 style={{ margin: 0 }}>Path Case — what actually happens after a moment</h1>
      <p style={{ color: MUTE, maxWidth: 900, lineHeight: 1.5 }}>
        Every chart here is drawn from <strong>every minute</strong> after the signal, not a
        chosen window. Move the slider and the whole page recomputes — because picking a
        horizon is an <em>execution</em> decision, and this page is here to inform that
        decision rather than make it for you.
      </p>

      <div style={{ display: "flex", gap: 16, alignItems: "center", margin: "16px 0" }}>
        <select value={moment} onChange={(e) => setMoment(e.target.value)}
          style={{ background: "#12151c", color: "#e6e9ef", border: "1px solid #2a3040",
            padding: "6px 10px", borderRadius: 4 }}>
          {Object.entries(MOMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label style={{ color: MUTE, display: "flex", gap: 10, alignItems: "center", flex: 1 }}>
          horizon
          <input type="range" min={5} max={data.max_t} step={5} value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))} style={{ flex: 1 }} />
          <strong style={{ color: "#e6e9ef", width: 74 }}>{horizon} min</strong>
        </label>
      </div>

      <p style={{ lineHeight: 1.55 }}>
        <strong>In plain terms:</strong> after {data.summary.n?.toLocaleString()} of these
        moments, the typical path is <strong>{fmt(atH.med)} ATR</strong> from entry at{" "}
        {horizon} minutes — but it has run as far as <strong>{fmt(atH.mfe_med)}</strong> in
        favour and <strong>−{fmt(atH.mae_med).replace("+", "")}</strong> against along the
        way, and the middle half of outcomes span <strong>{atH.iqr.toFixed(1)} ATR</strong>.
        Once the market's own drift is removed the tilt is{" "}
        <strong>{fmt(atH.adj_mean)} ATR</strong>. {Math.round(atH.under * 100)}% of these
        paths are underwater at this point.
      </p>

      <h2 style={{ fontSize: 15, marginTop: 22 }}>1 · The path, and the range it covered</h2>
      <p style={{ color: MUTE, margin: "4px 0 8px" }}>
        Blue line = median path · bands = middle 50% and middle 80% · green dashes = how far
        it got in favour (max) · red dashes = how far against (min) · grey = the market's
        drift baseline.
      </p>
      <PathFan curves={data.curves} horizon={horizon} />

      <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginTop: 22 }}>
        <div>
          <h2 style={{ fontSize: 15 }}>2 · Volatility between paths</h2>
          <p style={{ color: MUTE, margin: "4px 0 8px", maxWidth: 340 }}>
            How far apart the outcomes are, minute by minute. This is the number that
            dwarfs the edge.
          </p>
          <Dispersion curves={data.curves} horizon={horizon} />
        </div>
        <div>
          <h2 style={{ fontSize: 15 }}>3 · Is it a normal distribution?</h2>
          <p style={{ color: MUTE, margin: "4px 0 8px", maxWidth: 340 }}>
            {d.available ? <>
              <strong>No — and the middle is what fools you.</strong> Excess kurtosis{" "}
              <strong>{fmt(d.excess_kurtosis)}</strong> (normal = 0). Inside 2 SD it tracks
              a normal almost exactly; past that it comes apart:
            </> : "Not enough data at this horizon."}
          </p>
          <Distribution d={d} />
          {d.tails && (
            <table style={{ borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
              <thead>
                <tr style={{ color: MUTE, textAlign: "right" }}>
                  <th style={{ textAlign: "left", padding: "2px 8px" }}>beyond</th>
                  <th style={{ padding: "2px 8px" }}>observed</th>
                  <th style={{ padding: "2px 8px" }}>normal says</th>
                  <th style={{ padding: "2px 8px" }}>how much worse</th>
                </tr>
              </thead>
              <tbody>
                {d.tails.map((t) => (
                  <tr key={t.k} style={{ textAlign: "right", borderTop: "1px solid #222834" }}>
                    <td style={{ textAlign: "left", padding: "2px 8px" }}>{t.k} SD</td>
                    <td style={{ padding: "2px 8px" }}>{(100 * t.observed).toFixed(2)}%</td>
                    <td style={{ padding: "2px 8px", color: MUTE }}>{(100 * t.normal).toFixed(3)}%</td>
                    <td style={{ padding: "2px 8px", color: t.ratio > 3 ? FAIL : MUTE }}>
                      {t.ratio < 1.5 ? "—" : `${t.ratio.toFixed(0)}×`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <h2 style={{ fontSize: 15, marginTop: 24 }}>4 · The sampler — real instances</h2>
      <p style={{ color: MUTE, margin: "4px 0 8px" }}>
        Individual cases on their actual bars, so the aggregate above can be checked against
        what a real one looked like. {cases.length} sampled.
      </p>
      {cases.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <button onClick={() => setIdx((i) => (i - 1 + cases.length) % cases.length)}
              style={{ background: "#1b1f29", color: "#e6e9ef", border: "1px solid #2a3040",
                borderRadius: 4, padding: "4px 12px", cursor: "pointer" }}>←</button>
            <span style={{ color: MUTE }}>{idx + 1} / {cases.length}</span>
            <button onClick={() => setIdx((i) => (i + 1) % cases.length)}
              style={{ background: "#1b1f29", color: "#e6e9ef", border: "1px solid #2a3040",
                borderRadius: 4, padding: "4px 12px", cursor: "pointer" }}>→</button>
          </div>
          <Sampler c={cases[idx]} />
        </>
      )}

      <h2 style={{ fontSize: 15, marginTop: 24 }}>5 · Every moment, same yardstick</h2>
      <table style={{ borderCollapse: "collapse", fontSize: 13, marginTop: 6 }}>
        <thead>
          <tr style={{ color: MUTE, textAlign: "right" }}>
            <th style={{ textAlign: "left", padding: "4px 10px" }}>moment</th>
            <th style={{ padding: "4px 10px" }}>n</th>
            <th style={{ padding: "4px 10px" }}>median @{horizon}m</th>
            <th style={{ padding: "4px 10px" }}>drift-adj mean</th>
            <th style={{ padding: "4px 10px" }}>spread (IQR)</th>
            <th style={{ padding: "4px 10px" }}>max fav</th>
            <th style={{ padding: "4px 10px" }}>max adv</th>
            <th style={{ padding: "4px 10px" }}>% underwater</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(MOMENT_LABEL).map(([k, label]) => {
            const m = all[k];
            const r = m?.curves.find((c) => c.t === horizon) ?? m?.curves.slice(-1)[0];
            if (!m || !r) return (
              <tr key={k}><td style={{ padding: "4px 10px" }}>{label}</td>
                <td colSpan={7} style={{ color: MUTE, padding: "4px 10px" }}>—</td></tr>);
            return (
              <tr key={k} style={{ borderTop: "1px solid #222834",
                background: k === moment ? "#161b24" : undefined, textAlign: "right" }}>
                <td style={{ textAlign: "left", padding: "4px 10px" }}>{label}</td>
                <td style={{ padding: "4px 10px" }}>{m.summary.n?.toLocaleString()}</td>
                <td style={{ padding: "4px 10px" }}>{fmt(r.med)}</td>
                <td style={{ padding: "4px 10px",
                  color: r.adj_mean > 0 ? OK : FAIL }}>{fmt(r.adj_mean)}</td>
                <td style={{ padding: "4px 10px" }}>{r.iqr.toFixed(1)}</td>
                <td style={{ padding: "4px 10px", color: OK }}>{fmt(r.mfe_med)}</td>
                <td style={{ padding: "4px 10px", color: FAIL }}>−{r.mae_med.toFixed(2)}</td>
                <td style={{ padding: "4px 10px" }}>{Math.round(r.under * 100)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p style={{ color: MUTE, marginTop: 14, maxWidth: 900, lineHeight: 1.5 }}>
        Read the spread column against the drift-adjusted mean. Across all three moments the
        tilt is a small fraction of the range the path travels — these are volatility events
        with a slight directional lean, which is why any stop tight enough to bound the
        adverse excursion also removes the edge.
      </p>
    </div>
  );
}
