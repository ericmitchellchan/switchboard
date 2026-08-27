/**
 * MLB situation study panel (research-streams T11): the conditioning knobs +
 * results for the big-inning question, run live against the local capture.
 * Lives as the "study" tab of an MLB case; "save variant" pins the exact
 * parameterization + result to the case with full provenance, so variants
 * accumulate as comparable evidence.
 *
 * Honesty rules carried through: rates always show ±SE and a within-noise
 * indicator; capture-health caveats render whenever the data is lossy.
 */

import { useState } from "react";
import { api, type SituationParams, type SituationStudy } from "../../api/client";

const DEFAULTS: SituationParams = {
  run_threshold: 2,
  min_scoreless_before: 2,
  inning_min: 1,
  inning_max: 9,
  batting_side: "any",
  include_market_overlay: true,
};

function Num({
  label, value, min, max, onChange,
}: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-dim">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-14 rounded border border-line bg-bg px-1 py-0.5 text-right font-mono text-xs text-text focus:outline-none"
      />
    </label>
  );
}

export default function SituationStudyPanel({
  onPin,
}: {
  /** Pin the variant (params + study) to the open case. */
  onPin: (title: string, payload: Record<string, unknown>, provenance: Record<string, unknown>) => Promise<void>;
}) {
  const [params, setParams] = useState<SituationParams>(DEFAULTS);
  const [study, setStudy] = useState<SituationStudy | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      setStudy(await api.runSituationStudy(params));
    } catch (e) {
      setMsg(`study failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const pin = async (): Promise<void> => {
    if (!study) return;
    const p = study.params;
    const title = `Big inning ${p.run_threshold}+ after ${p.min_scoreless_before} scoreless · inn ${p.inning_min}-${p.inning_max} · ${p.batting_side}`;
    await onPin(title, study as unknown as Record<string, unknown>, {
      tool: "run_situation_study",
      params: p as unknown as Record<string, unknown>,
      data_window: study.data_window,
      sample_size: study.events,
      computed_at: new Date().toISOString(),
    })
      .then(() => setMsg("variant pinned to the case"))
      .catch(() => setMsg("pin failed — retry"));
  };

  const diff =
    study?.response_rate != null && study.baseline_rate != null
      ? study.response_rate - study.baseline_rate
      : null;
  const noise =
    diff != null && study?.response_se != null && Math.abs(diff) <= study.response_se;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-line bg-bg p-2.5">
        <div className="mb-1.5 font-mono text-[10px] uppercase text-dim">conditioning</div>
        <div className="space-y-1">
          <Num label="big inning = runs ≥" value={params.run_threshold} min={1} max={10}
               onChange={(v) => setParams({ ...params, run_threshold: v })} />
          <Num label="scoreless halves before ≥" value={params.min_scoreless_before} min={0} max={8}
               onChange={(v) => setParams({ ...params, min_scoreless_before: v })} />
          <Num label="inning from" value={params.inning_min} min={1} max={20}
               onChange={(v) => setParams({ ...params, inning_min: v })} />
          <Num label="inning to (9 = no extras)" value={params.inning_max} min={1} max={20}
               onChange={(v) => setParams({ ...params, inning_max: v })} />
          <label className="flex items-center justify-between gap-2 text-[11px] text-dim">
            big-inning side
            <select
              value={params.batting_side}
              onChange={(e) =>
                setParams({ ...params, batting_side: e.target.value as SituationParams["batting_side"] })
              }
              className="rounded border border-line bg-bg px-1 py-0.5 font-mono text-xs text-text focus:outline-none"
            >
              <option value="any">any</option>
              <option value="home">home</option>
              <option value="away">away</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="mt-2 w-full rounded-md bg-accent px-2 py-1 text-sm font-medium text-bg disabled:opacity-40"
        >
          {busy ? "running…" : "run study"}
        </button>
      </div>

      {study ? (
        <div className="rounded-lg border border-line bg-bg p-2.5">
          <div className="mb-1 font-mono text-[10px] uppercase text-dim">
            result · {study.events} events / {study.baseline_n.toLocaleString()} baseline · {study.data_window}
          </div>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-dim">opponent responds</span>
            <span className="font-mono text-text">
              {study.response_rate != null ? `${(study.response_rate * 100).toFixed(1)}%` : "—"}
              {study.response_se != null ? <span className="text-dim"> ±{(study.response_se * 100).toFixed(1)}</span> : null}
            </span>
          </div>
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-dim">baseline</span>
            <span className="font-mono text-text">
              {study.baseline_rate != null ? `${(study.baseline_rate * 100).toFixed(1)}%` : "—"}
              {study.baseline_se != null ? <span className="text-dim"> ±{(study.baseline_se * 100).toFixed(1)}</span> : null}
            </span>
          </div>
          {diff != null ? (
            <div className="mt-0.5 flex items-baseline justify-between text-xs">
              <span className="text-dim">difference</span>
              <span className={`font-mono ${noise ? "text-dim" : diff > 0 ? "text-up" : "text-dn"}`}>
                {diff > 0 ? "+" : ""}{(diff * 100).toFixed(1)}pp{noise ? " · within noise" : ""}
              </span>
            </div>
          ) : null}
          {/* response distribution */}
          <div className="mt-1.5 flex gap-1">
            {Object.entries(study.response_dist).map(([k, n]) => {
              const total = Math.max(study.events, 1);
              return (
                <div key={k} className="flex-1">
                  <div className="h-8 rounded bg-surface2">
                    <div
                      className="rounded bg-accent/70"
                      style={{ height: `${Math.min(100, (n / total) * 100)}%`, marginTop: `${100 - Math.min(100, (n / total) * 100)}%`.replace("%", "%") }}
                    />
                  </div>
                  <div className="text-center font-mono text-[9px] text-dim">{k}·{n}</div>
                </div>
              );
            })}
          </div>
          {/* market overlay */}
          {study.overlay_events > 0 ? (
            <div className="mt-1.5 border-t border-line pt-1.5 font-mono text-[10px] text-dim">
              market: |move| {study.avg_abs_move_cents}¢ · toward big team{" "}
              <span className={study.avg_move_vs_big_team_cents! >= 0 ? "text-up" : "text-dn"}>
                {study.avg_move_vs_big_team_cents}¢
              </span>{" "}
              · n={study.overlay_events}{study.overlay_sampled ? " (sampled)" : ""}
            </div>
          ) : null}
          {/* capture-health caveats — always shown when lossy */}
          {(study.games_excluded_overcount > 0 || (study.runs_capture_pct ?? 1) < 0.98) && (
            <div className="mt-1.5 rounded bg-surface2 px-1.5 py-1 font-mono text-[9px] leading-snug text-dim">
              capture: {study.runs_capture_pct != null ? `${(study.runs_capture_pct * 100).toFixed(1)}% of runs` : "?"} ·{" "}
              {study.games_excluded_overcount} corrupted games excluded · {study.games_undercount} games undercount
            </div>
          )}
          <button
            type="button"
            onClick={() => void pin()}
            className="mt-2 w-full rounded-md border border-line px-2 py-1 text-xs text-dim hover:border-accent hover:text-text"
          >
            + save variant to the case
          </button>
        </div>
      ) : null}
      {msg ? <div className="px-1 font-mono text-[10px] text-accent">{msg}</div> : null}
    </div>
  );
}
