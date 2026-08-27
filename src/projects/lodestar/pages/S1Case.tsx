/**
 * S1 Case — the EMA-test study, visualized (SWIT-13, the first real Sextant case).
 *
 * Centerpiece: the RESPONSE CURVE — hold rate vs target size (vol units), one line per
 * test number. The finding it draws: the test-number effect flips sign with target size
 * (small bounces strengthen with repeated tests; big continuations weaken). Eric's
 * tradability lens (>=10 NQ pts) is a drawn overlay, never baked into the definition —
 * edge and execution stay separate layers (his rule, 2026-08-09).
 *
 * Hand-rolled SVG, no chart libs (project convention).
 */

import { useEffect, useMemo, useState } from "react";
import { getJson } from "../api/client";

const OK = "#4ea96a";
const FAIL = "#e0645b";
const WARN = "#d9a441";
const SEL = "#8ab4f8";
const TEST_TONE: Record<string, string> = { "1": "#8ab4f8", "2": "#4ea96a", "3": "#d9a441", "4": "#e0645b" };

interface Rate { hold: number; n: number }
interface S1Summary {
  available: boolean;
  instrument: string;
  fracs: number[];
  events_total: number;
  curves: Record<string, Record<string, (Rate | null)[]>>;
  regime: { key: string; hold: number; n: number }[];
  slope: { key: string; hold: number; n: number; hold_big: number | null }[];
  era: { year: number; unit_pts: number; holdout: boolean; hold: number | null; n: number }[];
  definitions: { hold: string; unit: string; headline_frac: number };
}

interface ExampleEvent {
  session: string; side: string; test_no: number; outcome: string; regime: string;
  event_idx: number; break_idx: number | null;
  bars: { ts: string; o: number; h: number; l: number; c: number; ema: number | null }[];
}

/** One real event: candles + the EMA path + touch/resolution markers. */
function ExampleChart({ ev }: { ev: ExampleEvent }) {
  const W = 570, H = 240, PAD_L = 44;
  const bars = ev.bars;
  const lo = Math.min(...bars.map((b) => b.l));
  const hi = Math.max(...bars.map((b) => b.h));
  const span = hi - lo || 1;
  const bw = (W - PAD_L - 6) / bars.length;
  const x = (i: number) => PAD_L + i * bw + bw / 2;
  const y = (p: number) => 8 + (1 - (p - lo) / span) * (H - 30);
  const emaPath = bars
    .map((b, i) => (b.ema != null ? `${i === 0 || bars[i - 1].ema == null ? "M" : "L"}${x(i)},${y(b.ema)}` : ""))
    .join(" ");
  const ok = ev.outcome === "HOLD";
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="select-none">
      {[0.25, 0.75].map((f) => (
        <text key={f} x={2} y={y(lo + f * span) + 3} fill="#6b7280" fontFamily="monospace" fontSize={8.5}>
          {(lo + f * span).toFixed(1)}
        </text>
      ))}
      {bars.map((b, i) => {
        const up = b.c >= b.o;
        return (
          <g key={b.ts} opacity={i === ev.event_idx ? 1 : 0.8}>
            <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} stroke={up ? OK : FAIL} strokeWidth={Math.min(bw * 0.5, 1)} />
            <line x1={x(i)} x2={x(i)} y1={y(Math.max(b.o, b.c))} y2={y(Math.min(b.o, b.c))}
                  stroke={up ? OK : FAIL} strokeWidth={Math.max(Math.min(bw * 0.8, 2.4), 0.7)} />
          </g>
        );
      })}
      <path d={emaPath} fill="none" stroke={SEL} strokeWidth={1.6} opacity={0.9} />
      <line x1={x(ev.event_idx)} x2={x(ev.event_idx)} y1={6} y2={H - 22} stroke={WARN} strokeWidth={1.2} strokeDasharray="4 3" />
      <text x={x(ev.event_idx) + 3} y={16} fill={WARN} fontFamily="monospace" fontSize={9}>touch #{ev.test_no}</text>
      {ev.break_idx != null && ev.break_idx < bars.length && (
        <>
          <line x1={x(ev.break_idx)} x2={x(ev.break_idx)} y1={6} y2={H - 22} stroke={FAIL} strokeWidth={1.2} strokeDasharray="4 3" />
          <text x={x(ev.break_idx) + 3} y={28} fill={FAIL} fontFamily="monospace" fontSize={9}>break</text>
        </>
      )}
      <text x={W - 4} y={16} textAnchor="end" fill={ok ? OK : FAIL} fontFamily="monospace" fontSize={11}>
        {ev.outcome}
      </text>
      <text x={PAD_L} y={H - 8} fill="#6b7280" fontFamily="monospace" fontSize={9}>
        {ev.session} · {ev.side} · {ev.regime.replace("_", " ")} · blue = ema_avg
      </text>
    </svg>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-line bg-surface/40 px-3 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-wider text-dim">{label}</div>
      <div className="font-mono text-sm" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

/** Hold rate vs target size, one line per test number. */
function ResponseCurve({ d, arm, tradableFrac }: { d: S1Summary; arm: string; tradableFrac: number | null }) {
  const W = 1180, H = 360, PAD_L = 46, PAD_B = 34;
  const series = d.curves[arm] ?? {};
  const x = (i: number) => PAD_L + (i / (d.fracs.length - 1)) * (W - PAD_L - 12);
  const y = (v: number) => 10 + (1 - v) * (H - PAD_B - 14);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="select-none">
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={W - 4} y1={y(t)} y2={y(t)} stroke="#2a2f3a" strokeWidth={1} opacity={0.6} />
          <text x={2} y={y(t) + 3} fill="#6b7280" fontFamily="monospace" fontSize={9}>{(t * 100).toFixed(0)}%</text>
        </g>
      ))}
      <line x1={PAD_L} x2={W - 4} y1={y(0.5)} y2={y(0.5)} stroke="#6b7280" strokeWidth={1} strokeDasharray="3 4" />
      {d.fracs.map((f, i) => (
        <text key={f} x={x(i)} y={H - 18} textAnchor="middle" fill="#6b7280" fontFamily="monospace" fontSize={9}>
          {f}
        </text>
      ))}
      <text x={(PAD_L + W) / 2} y={H - 4} textAnchor="middle" fill="#6b7280" fontFamily="monospace" fontSize={9}>
        target size — fraction of a typical day's range (vol units, causal)
      </text>
      {tradableFrac != null && tradableFrac >= d.fracs[0] && tradableFrac <= d.fracs[d.fracs.length - 1] && (() => {
        // interpolate the x position of the tradability line between frac ticks
        let i = 0;
        while (i < d.fracs.length - 1 && d.fracs[i + 1] < tradableFrac) i++;
        const t = (tradableFrac - d.fracs[i]) / (d.fracs[i + 1] - d.fracs[i]);
        const xv = x(i) + t * (x(i + 1) - x(i));
        return (
          <g>
            <line x1={xv} x2={xv} y1={8} y2={H - PAD_B} stroke={SEL} strokeWidth={1.2} strokeDasharray="6 4" />
            <text x={xv + 4} y={18} fill={SEL} fontFamily="monospace" fontSize={9}>
              ≥10 NQ pts today (execution lens)
            </text>
          </g>
        );
      })()}
      {Object.entries(series).map(([tb, pts]) => {
        const path = pts
          .map((p, i) => (p ? `${i === 0 || !pts[i - 1] ? "M" : "L"}${x(i)},${y(p.hold)}` : ""))
          .join(" ");
        return (
          <g key={tb}>
            <path d={path} fill="none" stroke={TEST_TONE[tb]} strokeWidth={1.8} />
            {pts.map((p, i) => p && (
              <circle key={i} cx={x(i)} cy={y(p.hold)} r={2.4} fill={TEST_TONE[tb]}>
                <title>{`test ${tb === "4" ? "4+" : tb} · target ${d.fracs[i]}u · hold ${(p.hold * 100).toFixed(1)}% · n=${p.n.toLocaleString()}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
      {Object.keys(series).map((tb, k) => (
        <g key={tb}>
          <rect x={W - 150} y={16 + k * 16} width={10} height={3} fill={TEST_TONE[tb]} />
          <text x={W - 134} y={22 + k * 16} fill="#9aa3b2" fontFamily="monospace" fontSize={10}>
            test {tb === "4" ? "4+" : tb}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default function S1Case() {
  const [data, setData] = useState<S1Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [instrument, setInstrument] = useState("ES");
  const [arm, setArm] = useState("ema_avg");
  const [seed, setSeed] = useState(0);
  const [exAligned, setExAligned] = useState<ExampleEvent | null>(null);
  const [exOpposed, setExOpposed] = useState<ExampleEvent | null>(null);

  useEffect(() => {
    setExAligned(null);
    setExOpposed(null);
    getJson<{ examples: ExampleEvent[] }>(
      `/sextant/s1/${instrument}/examples?regime=trend_aligned&outcome=HOLD&seed=${seed}`,
    ).then((r) => setExAligned(r.examples[0] ?? null)).catch(() => setExAligned(null));
    getJson<{ examples: ExampleEvent[] }>(
      `/sextant/s1/${instrument}/examples?regime=trend_opposed&outcome=BREAK&seed=${seed}`,
    ).then((r) => setExOpposed(r.examples[0] ?? null)).catch(() => setExOpposed(null));
  }, [instrument, seed]);

  useEffect(() => {
    setData(null);
    setErr(null);
    getJson<S1Summary>(`/sextant/s1/${instrument}`)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(String(e)));
  }, [instrument]);

  // execution lens: 10 NQ pts (or ~3 ES pts) as a fraction of the LAST TRAIN year's
  // unit — holdout-era vol must not position the line (reviewer #2). unit_pts is the
  // full vol unit (the trailing daily-range scale), so the fraction is a plain ratio.
  const tradableFrac = useMemo(() => {
    if (!data) return null;
    const latest = [...data.era].reverse().find((e) => !e.holdout && e.unit_pts > 0);
    if (!latest) return null;
    const pts = instrument === "NQ" ? 10 : 3;
    return pts / latest.unit_pts;
  }, [data, instrument]);

  const arms = data ? Object.keys(data.curves) : [];
  const maxUnit = data ? Math.max(...data.era.map((e) => e.unit_pts)) : 1;

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 font-mono text-sm uppercase tracking-wider">S1 · the EMA-test case</h1>
        {["ES", "NQ"].map((s) => (
          <button key={s} type="button" onClick={() => setInstrument(s)}
                  className={`rounded border border-line px-2 py-0.5 font-mono text-[10px] uppercase ${instrument === s ? "text-accent" : "text-dim hover:text-text"}`}>
            {s}
          </button>
        ))}
        {data && <>
          <Tile label="events (train, RTH)" value={data.events_total.toLocaleString()} />
          <Tile label="key" value="frozen v1_dda9" />
          <Tile label="split" value="train only · holdout locked" tone={OK} />
        </>}
        <div className="ml-auto max-w-lg text-right font-mono text-[10px] leading-tight text-dim">
          HOLD = touch travels ≥ target (vol units) before a vol-scaled close-through
          (1% of the unit, floored at 6 ticks) ·
          unit = trailing 20-session avg daily range, lagged
        </div>
      </div>

      {err && <div className="rounded border border-line bg-surface/40 p-2 text-xs" style={{ color: FAIL }}>{err}</div>}
      {!data && !err && <div className="p-8 text-center text-xs text-dim">crunching 74K events…</div>}

      {data && (
        <>
          <div className="rounded-lg border border-line bg-surface/20 p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono text-xs uppercase tracking-wider">the response curve</span>
              <span className="font-mono text-[10px] text-dim">
                — the finding: the test-number effect flips sign with target size
              </span>
              <div className="ml-auto flex gap-1">
                {arms.map((a) => (
                  <button key={a} type="button" onClick={() => setArm(a)}
                          className={`rounded border border-line px-1.5 py-0.5 font-mono text-[10px] ${arm === a ? "text-accent" : "text-dim hover:text-text"}`}>
                    {a.replace("ema_", "")}
                  </button>
                ))}
              </div>
            </div>
            <ResponseCurve d={data} arm={arm} tradableFrac={tradableFrac} />
            <div className="mt-1 font-mono text-[10px] text-dim">
              left of the curves' crossover, repeated tests HELP (band-riding); right of it they
              HURT (level exhaustion). The dashed blue line is where your ≥10-NQ-point minimum sits
              in today's vol — an execution overlay, not part of the study.
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="min-w-[330px] flex-1 rounded-lg border border-line bg-surface/20 p-3">
              <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider">regime at the touch <span className="text-dim normal-case">(frozen key · ema_avg · 0.05u)</span></div>
              <table className="w-full font-mono text-[11px]">
                <tbody>
                  {data.regime.map((r) => (
                    <tr key={r.key} className="border-t border-line/40">
                      <td className="py-1">{r.key.replace("_", " ")}</td>
                      <td className="py-1 text-right" style={{ color: r.hold >= 0.95 ? OK : r.hold >= 0.9 ? WARN : FAIL }}>
                        {(r.hold * 100).toFixed(1)}%
                      </td>
                      <td className="py-1 pl-3 text-right text-dim">n={r.n.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-1 font-mono text-[10px] text-dim">
                HINDSIGHT DECOMPOSITION — regime labels use the whole segment window incl.
                bars after the touch. Valid as "when the market was in fact trending, touches
                held"; NOT a live prior. The tradable version awaits causal regime detectors
                (Regime Truth phase 2).
              </div>
            </div>

            <div className="min-w-[330px] flex-1 rounded-lg border border-line bg-surface/20 p-3">
              <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider">EMA slope <span className="text-dim normal-case">(|slope| terciles · ema_avg)</span></div>
              <table className="w-full font-mono text-[11px]">
                <thead><tr className="text-dim"><th className="text-left font-normal">slope</th><th className="text-right font-normal">hold @0.05u</th><th className="text-right font-normal">@0.2u</th><th className="text-right font-normal">n</th></tr></thead>
                <tbody>
                  {data.slope.map((r) => (
                    <tr key={r.key} className="border-t border-line/40">
                      <td className="py-1">{r.key}</td>
                      <td className="py-1 text-right">{(r.hold * 100).toFixed(1)}%</td>
                      <td className="py-1 text-right">{r.hold_big != null ? (r.hold_big * 100).toFixed(1) + "%" : "—"}</td>
                      <td className="py-1 text-right text-dim">{r.n.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-1 font-mono text-[10px] text-dim">
                CAUSAL — slope uses only past bars: this one is a live prior, usable at the
                screen today. Eric's conveyor theory: a moving EMA carries the test; a flat
                one is a level wearing out. Monotone at both target sizes, FDR-clean.
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-line bg-surface/20 p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="font-mono text-[11px] uppercase tracking-wider">real examples</span>
              <span className="font-mono text-[10px] text-dim">
                — the two regimes, in actual bars (ema_avg; sampled from the event log)
              </span>
              <button type="button" onClick={() => setSeed((s) => s + 1)}
                      className="ml-auto rounded border border-line px-2 py-0.5 font-mono text-[10px] text-dim hover:text-text">
                resample ↻
              </button>
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="min-w-[420px] flex-1">
                <div className="mb-1 font-mono text-[10px]" style={{ color: OK }}>
                  WITH the trend (trend-aligned touch → HOLD, the 95%+ class)
                </div>
                {exAligned ? <ExampleChart ev={exAligned} /> : <div className="p-6 text-center text-xs text-dim">loading…</div>}
              </div>
              <div className="min-w-[420px] flex-1">
                <div className="mb-1 font-mono text-[10px]" style={{ color: FAIL }}>
                  AGAINST the trend (trend-opposed touch → BREAK, the coin-flip class)
                </div>
                {exOpposed ? <ExampleChart ev={exOpposed} /> : <div className="p-6 text-center text-xs text-dim">loading…</div>}
              </div>
            </div>
            <div className="mt-1 font-mono text-[10px] text-dim">
              left: price rides above a rising average, dips into it, buyers defend, trend resumes —
              the touch was an entry. right: price trends THROUGH the average from the other side,
              the counter-trend touch gets steamrolled — the touch was bait. hit resample for more.
            </div>
          </div>

          <div className="rounded-lg border border-line bg-surface/20 p-3">
            <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider">
              eras — what one vol unit was worth <span className="text-dim normal-case">(edge vs execution, kept separate)</span>
            </div>
            <svg width="100%" viewBox="0 0 1180 120" className="select-none">
              {data.era.map((e, i) => {
                const bw = 1180 / data.era.length;
                const h = (e.unit_pts / maxUnit) * 70;
                const tradable = e.unit_pts * 0.2 >= (instrument === "NQ" ? 10 : 3);
                return (
                  <g key={e.year}>
                    <rect x={i * bw + 3} y={92 - h} width={bw - 6} height={h}
                          fill={e.holdout ? "#3a4152" : tradable ? OK : WARN} opacity={e.holdout ? 0.5 : 0.85}>
                      <title>{`${e.year}: 1u ≈ ${e.unit_pts} pts · 0.2u ≈ ${(e.unit_pts * 0.2).toFixed(1)} pts${e.hold != null ? ` · hold@0.05u ${(e.hold * 100).toFixed(1)}% (n=${e.n})` : e.holdout ? " · HOLDOUT (locked)" : " · n<30 (thin year)"}`}</title>
                    </rect>
                    {i % 2 === 0 && (
                      <text x={i * bw + bw / 2} y={104} textAnchor="middle" fill="#6b7280" fontFamily="monospace" fontSize={8.5}>
                        {String(e.year).slice(2)}
                      </text>
                    )}
                  </g>
                );
              })}
              <text x={4} y={12} fill="#6b7280" fontFamily="monospace" fontSize={9}>
                bar = one vol unit in points · green = a 0.2u move cleared the tradable minimum · grey = holdout (locked)
              </text>
            </svg>
            <div className="mt-1 font-mono text-[10px] text-dim">
              the edge is measured in vol units everywhere; whether it was worth YOUR chair time in
              a given year is an execution question — "the edge existed but was only 5 points" is
              policy, not science.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
