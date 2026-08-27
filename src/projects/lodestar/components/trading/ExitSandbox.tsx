/**
 * Exit Sandbox — the tweakable exit engine, in the app.
 *
 * Keeps your entries exactly as traded and replays each trade minute-by-minute
 * over @NQ bars under a policy you dial in (stop / trailing / target as points or
 * ATR, a situational breakeven, a time stop, an optional let-run horizon). The
 * result is the net-P&L delta vs your ACTUAL exits — so you can see, live, which
 * rule keeps the edge and which bleeds it. Backend: /trades/exit-sim.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ExitPolicy,
  type ExitSimResult,
  type TradeAnalysis,
} from "../../api/client";

const POS = "#46c08a";
const NEG = "#e8624a";
const money = (n: number | null | undefined): string =>
  n == null ? "—" : (n < 0 ? "−$" : "+$") + Math.abs(Math.round(n)).toLocaleString("en-US");
const pnlColor = (n: number): string => (n >= 0 ? POS : NEG);

type LegMode = "off" | "pts" | "atr";

interface Leg {
  mode: LegMode;
  val: number;
}

interface Toggle {
  on: boolean;
  val: number;
}

interface PolicyState {
  stop: Leg;
  trail: Leg;
  tp: Leg;
  be: Toggle;
  time: Toggle;
  horizon: Toggle;
}

const BLANK: PolicyState = {
  stop: { mode: "off", val: 4 },
  trail: { mode: "off", val: 3 },
  tp: { mode: "off", val: 4 },
  be: { on: false, val: 20 },
  time: { on: false, val: 120 },
  horizon: { on: false, val: 240 },
};

/** Turn the UI state into the backend ExitPolicy (omit disabled legs). */
function toPolicy(s: PolicyState, name: string): ExitPolicy {
  const p: ExitPolicy = { name };
  if (s.stop.mode === "pts") p.stop_pts = s.stop.val;
  if (s.stop.mode === "atr") p.stop_atr = s.stop.val;
  if (s.trail.mode === "pts") p.trail_pts = s.trail.val;
  if (s.trail.mode === "atr") p.trail_atr = s.trail.val;
  if (s.tp.mode === "pts") p.tp_pts = s.tp.val;
  if (s.tp.mode === "atr") p.tp_atr = s.tp.val;
  if (s.be.on) p.be_after_pts = s.be.val;
  if (s.time.on) p.time_min = s.time.val;
  if (s.horizon.on) p.horizon_min = s.horizon.val;
  return p;
}

const PRESETS: { label: string; state: PolicyState }[] = [
  { label: "Catastrophe fuse 400pt", state: { ...BLANK, stop: { mode: "pts", val: 400 } } },
  { label: "ATR stop 4×", state: { ...BLANK, stop: { mode: "atr", val: 4 } } },
  { label: "Trail 3× ATR", state: { ...BLANK, trail: { mode: "atr", val: 3 } } },
  {
    label: "Fuse + breakeven@+20",
    state: { ...BLANK, stop: { mode: "pts", val: 400 }, be: { on: true, val: 20 } },
  },
  {
    label: "ATR stop 4× + target 3×",
    state: { ...BLANK, stop: { mode: "atr", val: 4 }, tp: { mode: "atr", val: 3 } },
  },
];

export default function ExitSandbox() {
  const [analysis, setAnalysis] = useState<TradeAnalysis | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [state, setState] = useState<PolicyState>(PRESETS[0].state);
  const [result, setResult] = useState<ExitSimResult | null>(null);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api
      .getTradesAnalysis()
      .then(setAnalysis)
      .catch((e: unknown) =>
        setLoadErr(e instanceof Error ? e.message : "no trades imported yet"),
      );
  }, []);

  const policy = useMemo(() => toPolicy(state, "sandbox"), [state]);

  useEffect(() => {
    if (loadErr) return;
    if (debounce.current) clearTimeout(debounce.current);
    setBusy(true);
    debounce.current = setTimeout(() => {
      api
        .runExitSim(policy)
        .then(setResult)
        .catch(() => setResult(null))
        .finally(() => setBusy(false));
    }, 280);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [policy, loadErr]);

  const setLeg = useCallback(
    (key: "stop" | "trail" | "tp", patch: Partial<Leg>) =>
      setState((s) => ({ ...s, [key]: { ...s[key], ...patch } })),
    [],
  );
  const setToggle = useCallback(
    (key: "be" | "time" | "horizon", patch: Partial<Toggle>) =>
      setState((s) => ({ ...s, [key]: { ...s[key], ...patch } })),
    [],
  );

  if (loadErr) {
    return (
      <div className="rounded border border-line bg-surface p-6 text-sm text-dim">
        <p className="mb-1 font-medium text-text">No trades imported yet.</p>
        <p>
          Decode your NinjaTrader exports first:{" "}
          <code className="rounded bg-bg px-1.5 py-0.5 text-accent">
            python -m lodestar_backend.scripts.analyze_ninjatrader *.csv
          </code>{" "}
          then persist them via <code className="rounded bg-bg px-1.5 py-0.5">TradeStore.import_csvs</code>.
        </p>
        <p className="mt-2 text-dim/70">({loadErr})</p>
      </div>
    );
  }

  const ex = analysis?.excursion;
  const reasons = result ? Object.entries(result.exit_reasons).sort((a, b) => b[1] - a[1]) : [];
  const reasonTotal = reasons.reduce((s, [, n]) => s + n, 0) || 1;

  return (
    <div className="flex flex-col gap-4 pb-6">
      {/* header — your actual, and what the price path proved */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded border border-line bg-line sm:grid-cols-4">
        <Stat k="Your actual net" v={money(analysis?.headline.total_pnl_usd)}
          color={analysis ? pnlColor(analysis.headline.total_pnl_usd) : undefined} />
        <Stat k="Win rate" v={analysis ? `${Math.round((analysis.headline.win_rate ?? 0) * 100)}%` : "—"} />
        <Stat k="Payoff" v={analysis?.headline.payoff_ratio?.toFixed(2) ?? "—"} />
        <Stat k="Worst trade" v={money(analysis?.headline.largest_loss_usd)} color={NEG} />
      </div>
      {ex ? (
        <p className="text-xs text-dim">
          Price-path facts:{" "}
          <b className="text-text">{ex.runners_to_losers.n}</b> losers were green before losing (
          <span style={{ color: NEG }}>{money(ex.runners_to_losers.usd_lost)}</span>) ·{" "}
          <b className="text-text">{ex.profit_given_back.n}</b> winners gave back most of their peak (~
          <span style={{ color: NEG }}>{money(-ex.profit_given_back.left_on_table_usd)}</span> left on table) ·
          aligned {ex.alignment.covered}/{ex.alignment.covered + ex.alignment.uncovered} trades.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
        {/* ── policy controls ── */}
        <div className="rounded border border-line bg-surface p-4">
          <h3 className="mb-3 font-mono text-xs uppercase tracking-wider text-dim">Exit policy</h3>
          <div className="flex flex-col gap-3">
            <LegControl label="Stop" leg={state.stop} onChange={(p) => setLeg("stop", p)} />
            <LegControl label="Trailing" leg={state.trail} onChange={(p) => setLeg("trail", p)} />
            <LegControl label="Target" leg={state.tp} onChange={(p) => setLeg("tp", p)} />
            <ToggleControl label="Breakeven at +" unit="pts" t={state.be} onChange={(p) => setToggle("be", p)} />
            <ToggleControl label="Time stop" unit="min" t={state.time} onChange={(p) => setToggle("time", p)} />
            <ToggleControl label="Let-run horizon" unit="min" t={state.horizon} onChange={(p) => setToggle("horizon", p)} />
          </div>
          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-dim">Presets</div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setState(p.state)}
                  className="rounded border border-line bg-bg px-2 py-1 text-xs text-dim transition-colors hover:border-accent hover:text-text"
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setState(BLANK)}
                className="rounded border border-dashed border-line px-2 py-1 text-xs text-dim hover:text-text"
              >
                Clear
              </button>
            </div>
          </div>
        </div>

        {/* ── results ── */}
        <div className="rounded border border-line bg-surface p-4">
          <div className="flex items-baseline justify-between">
            <h3 className="font-mono text-xs uppercase tracking-wider text-dim">
              vs your actual exits {busy ? <span className="text-dim/50">· simulating…</span> : null}
            </h3>
            <span className="font-mono text-[11px] text-dim">{result?.n ?? "—"} trades</span>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-8">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">Δ vs actual</div>
              <div className="font-mono text-4xl font-semibold tabular-nums"
                style={{ color: result ? pnlColor(result.delta_usd) : undefined }}>
                {result ? money(result.delta_usd) : "—"}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">Sim net</div>
              <div className="font-mono text-xl tabular-nums text-text">{money(result?.sim_net_usd)}</div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">Sim win%</div>
              <div className="font-mono text-xl tabular-nums text-text">
                {result?.sim_win_rate != null ? `${Math.round(result.sim_win_rate * 100)}%` : "—"}
              </div>
            </div>
          </div>

          <p className="mt-3 text-xs text-dim">
            {result && result.delta_usd >= 0
              ? "This rule beats your actual exits — keep it and pressure-test it."
              : "This rule loses vs your actual exits — your mean-reverting edge needs room; only a wide fuse tends to win."}
          </p>

          {/* exit-reason breakdown */}
          {reasons.length ? (
            <div className="mt-4">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-dim">
                How the simulated trades exited
              </div>
              <div className="flex flex-col gap-1.5">
                {reasons.map(([reason, n]) => (
                  <div key={reason} className="flex items-center gap-2">
                    <span className="w-20 font-mono text-[11px] text-dim">{reason}</span>
                    <div className="h-3 flex-1 overflow-hidden rounded-sm bg-bg">
                      <div className="h-full rounded-sm bg-accent/60"
                        style={{ width: `${(n / reasonTotal) * 100}%` }} />
                    </div>
                    <span className="w-10 text-right font-mono text-[11px] tabular-nums text-dim">{n}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="bg-surface px-4 py-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{k}</div>
      <div className="font-mono text-lg font-medium tabular-nums" style={color ? { color } : undefined}>
        {v}
      </div>
    </div>
  );
}

function LegControl({ label, leg, onChange }: { label: string; leg: Leg; onChange: (p: Partial<Leg>) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-sm text-text">{label}</span>
      <select
        value={leg.mode}
        onChange={(e) => onChange({ mode: e.target.value as LegMode })}
        className="rounded border border-line bg-bg px-1.5 py-1 font-mono text-xs text-text"
      >
        <option value="off">off</option>
        <option value="pts">points</option>
        <option value="atr">× ATR</option>
      </select>
      {leg.mode !== "off" ? (
        <input
          type="number"
          step={leg.mode === "atr" ? 0.5 : 5}
          min={0}
          value={leg.val}
          onChange={(e) => onChange({ val: Number(e.target.value) })}
          className="w-20 rounded border border-line bg-bg px-2 py-1 font-mono text-xs tabular-nums text-text"
        />
      ) : (
        <span className="text-xs text-dim/50">disabled</span>
      )}
    </div>
  );
}

function ToggleControl({ label, unit, t, onChange }: { label: string; unit: string; t: Toggle; onChange: (p: Partial<Toggle>) => void }) {
  return (
    <div className="flex items-center gap-2">
      <label className="flex flex-1 items-center gap-2 text-sm text-text">
        <input type="checkbox" checked={t.on} onChange={(e) => onChange({ on: e.target.checked })} />
        {label}
      </label>
      <input
        type="number"
        step={5}
        min={0}
        disabled={!t.on}
        value={t.val}
        onChange={(e) => onChange({ val: Number(e.target.value) })}
        className="w-20 rounded border border-line bg-bg px-2 py-1 font-mono text-xs tabular-nums text-text disabled:opacity-40"
      />
      <span className="w-8 font-mono text-[11px] text-dim">{unit}</span>
    </div>
  );
}
