/**
 * K1 Case — early trend identification (the strategy-slate keystone), visualized.
 *
 * Centerpiece: the PAYOFF FAN — from each signal, where price actually went over the
 * next 5-60 minutes, as percentile bands, with NO trading rules attached — next to the
 * dead-flat baseline. Then the establishment ladder (patience is nearly free) and the
 * execution pricing (step 2 of edge-before-execution: templates read off the curves).
 *
 * Plain-English-first per Eric's rule. Hand-rolled SVG, no chart libs.
 */

import { useEffect, useState } from "react";
import { getJson } from "../api/client";

const OK = "#4ea96a";
const FAIL = "#e0645b";
const WARN = "#d9a441";
const SEL = "#8ab4f8";

interface LadderRow {
  rung: string; era: string; n: number; t2c_med: number | null; precision: number | null;
  atr_pts: number;
  [k: string]: string | number | null;
}
interface PricingRow {
  rung: string; stop: number; exit: string; era: string; n: number;
  mean_atr: number; lb: number; ub: number; win: number; atr_pts: number;
}
interface K1Summary {
  available: boolean; instrument: string; horizons: number[];
  ladder: LadderRow[]; pricing: PricingRow[];
  definitions: { signal: string; fan: string; baseline: string };
}

const RUNG_LABEL: Record<string, string> = {
  hold3m: "held 3 min", hold5m: "held 5 min", hold10m: "held 10 min",
  hold15m: "held 15 min", baseline: "dumb baseline",
};

/** The payoff fan: percentile bands of where price went, per horizon. */
function PayoffFan({ row, horizons: allH, tone }: { row: LadderRow; horizons: number[]; tone: string }) {
  const W = 380, H = 240, PAD_L = 40, PAD_B = 26;
  // only horizons this rung actually has (long ones can be absent near session end)
  const horizons = allH.filter((h) => row[`end_med_${h}`] != null);
  if (horizons.length < 2) return null;
  const spanVals = horizons.flatMap((h) =>
    ["end_p10", "end_p90", "best_med", "worst_med"].map((p) => Math.abs((row[`${p}_${h}`] as number) ?? 0)));
  const lim = Math.max(4, Math.ceil(Math.max(...spanVals)) + 0.5);
  const x = (i: number) => PAD_L + (i / (horizons.length - 1)) * (W - PAD_L - 10);
  const y = (v: number) => 8 + (1 - (v + lim) / (2 * lim)) * (H - PAD_B - 12);
  const series = (p: string) => horizons.map((h, i) => {
    const v = row[`${p}_${h}`];
    return v == null ? "" : `${i === 0 ? "M" : "L"}${x(i)},${y(v as number)}`;
  }).join(" ");
  const band = (pLo: string, pHi: string) => {
    const up = horizons.map((h, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(row[`${pHi}_${h}`] as number)}`).join(" ");
    const dn = horizons.slice().reverse().map((h) => {
      const i = horizons.indexOf(h);
      return `L${x(i)},${y(row[`${pLo}_${h}`] as number)}`;
    }).join(" ");
    return `${up} ${dn} Z`;
  };
  const hasFan = row[`end_p10_${horizons[0]}`] != null;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="select-none">
      <line x1={PAD_L} x2={W - 6} y1={y(0)} y2={y(0)} stroke="#6b7280" strokeWidth={1} strokeDasharray="3 4" />
      {[-6, -3, 3, 6].map((v) => (
        <g key={v}>
          <line x1={PAD_L} x2={W - 6} y1={y(v)} y2={y(v)} stroke="#2a2f3a" strokeWidth={0.7} opacity={0.5} />
          <text x={2} y={y(v) + 3} fill="#6b7280" fontFamily="monospace" fontSize={8.5}>{v > 0 ? `+${v}` : v}</text>
        </g>
      ))}
      {hasFan && <path d={band("end_p10", "end_p90")} fill={tone} opacity={0.10} />}
      {hasFan && <path d={band("end_p25", "end_p75")} fill={tone} opacity={0.18} />}
      <path d={series("end_med")} fill="none" stroke={tone} strokeWidth={2} />
      <path d={series("best_med")} fill="none" stroke={OK} strokeWidth={1.1} strokeDasharray="4 3" opacity={0.8} />
      <path d={series("worst_med")} fill="none" stroke={FAIL} strokeWidth={1.1} strokeDasharray="4 3" opacity={0.8}
            transform={`translate(0,0)`} />
      {horizons.map((h, i) => (
        <text key={h} x={x(i)} y={H - 10} textAnchor="middle" fill="#6b7280" fontFamily="monospace" fontSize={9}>
          +{h}m
        </text>
      ))}
      <text x={W - 8} y={14} textAnchor="end" fill={tone} fontFamily="monospace" fontSize={10}>
        {RUNG_LABEL[row.rung] ?? row.rung}
      </text>
      <text x={W - 8} y={26} textAnchor="end" fill="#6b7280" fontFamily="monospace" fontSize={8.5}>
        n={row.n.toLocaleString()}{row.precision != null ? ` · right ${(100 * (row.precision as number)).toFixed(0)}%` : ""}
      </text>
    </svg>
  );
}

export default function K1Case() {
  const [data, setData] = useState<K1Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [instrument, setInstrument] = useState("ES");
  const [era, setEra] = useState("19-23");

  useEffect(() => {
    setData(null);
    setErr(null);
    getJson<K1Summary>(`/sextant/k1/${instrument}`)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(String(e)));
  }, [instrument]);

  const rows = data ? data.ladder.filter((r) => r.era === era) : [];
  const signalRows = rows.filter((r) => r.rung !== "baseline");
  const baseRow = rows.find((r) => r.rung === "baseline");
  const pricing = data ? data.pricing.filter((p) => p.era === era) : [];

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 font-mono text-sm uppercase tracking-wider">K1 · can we call a trend in time?</h1>
        {["ES", "NQ"].map((s) => (
          <button key={s} onClick={() => setInstrument(s)}
                  className={`rounded-md border px-2.5 py-1 font-mono text-xs ${instrument === s ? "border-accent text-accent" : "border-line text-dim hover:text-fg"}`}>
            {s}
          </button>
        ))}
        {["19-23", "all"].map((e) => (
          <button key={e} onClick={() => setEra(e)}
                  className={`rounded-md border px-2.5 py-1 font-mono text-xs ${era === e ? "border-accent text-accent" : "border-line text-dim hover:text-fg"}`}>
            {e === "19-23" ? "modern era" : "all years"}
          </button>
        ))}
        <div className="ml-auto max-w-xl text-right font-mono text-[10px] leading-tight text-dim">
          the signal: the last 30 minutes moved efficiently one way (top-5% strength) and kept it up ·
          each panel: where price went next, NO trading rules attached
        </div>
      </div>

      {err && <div className="rounded-md border border-red-900/60 bg-red-950/30 p-2 font-mono text-xs text-red-300">{err}</div>}
      {!data && !err && <div className="p-6 font-mono text-xs text-dim">loading…</div>}

      {data && (
        <>
          <div className="rounded-lg border border-line bg-surface/20 p-3">
            <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider">
              the payoff fans <span className="text-dim normal-case">— solid line = typical outcome (in the called direction, ATR units) · shaded = where the middle 50% / 80% of outcomes landed · green dashes = typical best reached · red dashes = typical worst endured. The baseline panel is what "no information" looks like: flat and symmetric. Every signal panel should — and does — pull away from it.</span>
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {signalRows.map((r) => <PayoffFan key={r.rung} row={r} horizons={data.horizons} tone={SEL} />)}
              {baseRow && <PayoffFan row={baseRow} horizons={data.horizons} tone={WARN} />}
            </div>
            <div className="mt-1.5 text-[11px] leading-snug text-dim">
              the ladder reads left to right as "demand more proof before believing": the reading must
              hold 3 → 15 minutes. Being pickier lifts the right-rate (~34% → ~45%) and costs almost
              nothing — the call arrives only ~2 minutes later and the payoff spread keeps its shape.
              The only price is fewer signals: the strictest rung fires about once every 3-4 sessions.
            </div>
          </div>

          <div className="rounded-lg border border-line bg-surface/20 p-3">
            <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider">
              priced as trades <span className="text-dim normal-case">— step two, only after the fans showed real shape: stops and holds read OFF the curves (never invented), graded with the worst-case bar-ordering assumption, net of costs. [range] = the statistical confidence band: money is only claimed if its LOW end clears zero.</span>
            </div>
            {pricing.length === 0 && <div className="p-3 font-mono text-xs text-dim">pricing run not yet available — refresh after it lands</div>}
            {pricing.length > 0 && (
              <table className="w-full font-mono text-[11px]">
                <thead>
                  <tr className="text-left text-[9px] uppercase tracking-wider text-dim">
                    <th className="py-0.5">signal held</th><th>stop</th><th>exit</th><th>trades</th>
                    <th>avg / trade</th><th>confidence band</th><th>win rate</th><th className="text-right">≈ points</th>
                  </tr>
                </thead>
                <tbody>
                  {pricing.sort((a, b) => b.lb - a.lb).map((p, i) => (
                    <tr key={i} className="border-t border-line/40">
                      <td className="py-1">{RUNG_LABEL[p.rung] ?? p.rung}</td>
                      <td>{p.stop.toFixed(1)} ATR</td>
                      <td>{p.exit}</td>
                      <td>{p.n.toLocaleString()}</td>
                      <td style={{ color: p.mean_atr >= 0 ? OK : FAIL }}>
                        {p.mean_atr >= 0 ? "+" : ""}{p.mean_atr.toFixed(3)} ATR
                      </td>
                      <td style={{ color: p.lb > 0 ? OK : "#9aa3b2" }}>
                        [{p.lb >= 0 ? "+" : ""}{p.lb.toFixed(3)}, {p.ub >= 0 ? "+" : ""}{p.ub.toFixed(3)}]
                        {p.lb > 0 ? " ✓" : ""}
                      </td>
                      <td>{(100 * p.win).toFixed(0)}%</td>
                      <td className="text-right">{(p.mean_atr * p.atr_pts) >= 0 ? "+" : ""}{(p.mean_atr * p.atr_pts).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mt-1.5 text-[11px] leading-snug text-dim">
              honesty notes: this signal variant was chosen after seeing its scoreboard, so everything
              here is characterization — the locked-away data (untouched since the freeze) delivers the
              verdict, and only for a plan that clears the pre-written bar on BOTH instruments. A ✓ in
              the confidence-band column means the low end clears zero on training data — necessary,
              not sufficient.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
