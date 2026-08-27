/**
 * MLB exploration (v1): a different animal from Tennis/Markets — the domain's data
 * is a conditioned SITUATION STUDY, so the exploration IS the conditioning. Set the
 * run threshold / innings / batting side and watch the response-vs-baseline bars and
 * the run distribution re-compute live (/research/mlb/situation). Real data, with
 * ±SE whiskers so "inside the noise" reads honestly.
 */

import { useEffect, useState } from "react";
import { api, type SituationParams, type SituationStudy } from "../../api/client";

const ORANGE = "#d18f5a";
const GREY = "#55555e";
const DEFAULTS: SituationParams = {
  run_threshold: 2,
  min_scoreless_before: 0,
  inning_min: 1,
  inning_max: 9,
  batting_side: "any",
  include_market_overlay: true,
};
const pct = (v: number | null): string => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

/** Conditioned response rate vs baseline, each with ±1 SE whiskers. */
function RateVsBaseline({ s }: { s: SituationStudy }) {
  const r = s.response_rate ?? 0;
  const re = s.response_se ?? 0;
  const b = s.baseline_rate ?? 0;
  const be = s.baseline_se ?? 0;
  const W = 320;
  const H = 180;
  const PAD = { l: 40, t: 16, b: 40 };
  const max = Math.max(r + re, b + be, 0.05) * 1.15;
  const y = (v: number): number => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const bar = (cx: number, val: number, se: number, color: string, label: string, sub: string) => (
    <g>
      <rect x={cx - 28} y={y(val)} width={56} height={H - PAD.b - y(val)} rx="2" fill={color} opacity="0.8" />
      {se > 0
        ? (() => {
            // Clamp to [0, max] so a small-sample whisker (se > rate) can't draw
            // below the axis / outside the viewBox (review nit).
            const lo = y(Math.max(0, val - se));
            const hi = y(Math.min(max, val + se));
            return (
              <>
                <line x1={cx} y1={lo} x2={cx} y2={hi} stroke="#eaeaed" strokeWidth="1" />
                <line x1={cx - 5} y1={hi} x2={cx + 5} y2={hi} stroke="#eaeaed" />
                <line x1={cx - 5} y1={lo} x2={cx + 5} y2={lo} stroke="#eaeaed" />
              </>
            );
          })()
        : null}
      <text x={cx} y={H - PAD.b + 15} textAnchor="middle" fill={color} fontSize="11" fontFamily="monospace">
        {pct(val)}
      </text>
      <text x={cx} y={H - PAD.b + 28} textAnchor="middle" fill="#8a8a93" fontSize="9">{label}</text>
      <text x={cx} y={H - PAD.b + 38} textAnchor="middle" fill="#55555e" fontSize="8" fontFamily="monospace">{sub}</text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
      {[0, max / 2, max].map((t, i) => (
        <g key={i}>
          <line x1={PAD.l} x2={W - 8} y1={y(t)} y2={y(t)} stroke="#1e1e24" strokeDasharray="2 4" />
          <text x={PAD.l - 5} y={y(t) + 3} textAnchor="end" fill="#8a8a93" fontSize="8" fontFamily="monospace">{pct(t)}</text>
        </g>
      ))}
      {bar(110, r, re, ORANGE, "conditioned", `n=${s.events}`)}
      {bar(230, b, be, GREY, "baseline", `n=${s.baseline_n}`)}
    </svg>
  );
}

/** Distribution of opponent response runs (0 / 1 / 2 / 3+). */
function Distribution({ dist }: { dist: Record<string, number> }) {
  const keys = ["0", "1", "2", "3+"];
  const vals = keys.map((k) => dist[k] ?? 0);
  const max = Math.max(1, ...vals);
  const W = 320;
  const H = 180;
  const PAD = { l: 30, t: 16, b: 28 };
  const step = (W - PAD.l - 10) / keys.length;
  const y = (v: number): number => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
      <line x1={PAD.l} x2={W - 10} y1={H - PAD.b} y2={H - PAD.b} stroke="#26262e" />
      {keys.map((k, i) => {
        const cx = PAD.l + i * step + step / 2;
        const v = vals[i];
        return (
          <g key={k}>
            <rect x={cx - 22} y={y(v)} width={44} height={H - PAD.b - y(v)} rx="2" fill={ORANGE} opacity={i === 0 ? 0.8 : 0.55} />
            <text x={cx} y={y(v) - 4} textAnchor="middle" fill="#8a8a93" fontSize="9" fontFamily="monospace">{v}</text>
            <text x={cx} y={H - PAD.b + 14} textAnchor="middle" fill="#8a8a93" fontSize="10" fontFamily="monospace">{k}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function MlbExplore() {
  const [params, setParams] = useState<SituationParams>(DEFAULTS);
  const [source, setSource] = useState<"live" | "history">("live");
  const [seasons, setSeasons] = useState<number[]>([2024, 2025]);
  const [study, setStudy] = useState<SituationStudy | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);

  const seasonKey = seasons.join(",");
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(false);
    const run =
      source === "history"
        ? api.runSituationStudyHistory(params, seasons)
        : api.runSituationStudy(params);
    run
      .then((s) => !cancelled && setStudy(s))
      .catch(() => !cancelled && setErr(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // seasonKey stands in for the seasons array identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, source, seasonKey]);

  const toggleSeason = (yr: number): void =>
    setSeasons((s) => {
      if (s.includes(yr)) {
        // Keep at least one season: empty would query ALL backfilled seasons (a
        // confusing "deselect everything → get more" inversion), so block it.
        return s.length === 1 ? s : s.filter((y) => y !== yr);
      }
      return [...s, yr].sort((a, b) => a - b);
    });

  const set = (patch: Partial<SituationParams>): void => setParams((p) => ({ ...p, ...patch }));
  const chip = (active: boolean): string =>
    `rounded-full border px-2.5 py-0.5 font-mono text-[10px] transition-colors ${
      active ? "border-accent text-accent" : "border-line text-dim hover:text-text"
    }`;
  // Is the conditioned vs baseline difference inside the noise?
  const noise =
    study?.response_rate != null &&
    study.baseline_rate != null &&
    // pooled SE of the difference, not just the conditioned SE (review nit)
    Math.abs(study.response_rate - study.baseline_rate) <
      Math.hypot(study.response_se ?? 0, study.baseline_se ?? 0);

  return (
    <div className="flex flex-col gap-3 pb-6">
      {/* conditioning controls — the exploration */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-wide text-dim">after scoring ≥</span>
          {[1, 2, 3, 4].map((n) => (
            <button key={n} type="button" onClick={() => set({ run_threshold: n })} className={chip(params.run_threshold === n)}>
              {n}
            </button>
          ))}
          <span className="font-mono text-[9px] text-dim">runs</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-wide text-dim">innings</span>
          {([[1, 9, "all"], [1, 3, "early"], [4, 6, "middle"], [7, 9, "late"]] as const).map(([lo, hi, lbl]) => (
            <button
              key={lbl}
              type="button"
              onClick={() => set({ inning_min: lo, inning_max: hi })}
              className={chip(params.inning_min === lo && params.inning_max === hi)}
            >
              {lbl}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-wide text-dim">batting</span>
          {(["any", "home", "away"] as const).map((s) => (
            <button key={s} type="button" onClick={() => set({ batting_side: s })} className={chip(params.batting_side === s)}>
              {s}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-wide text-dim">data</span>
          <div className="inline-flex overflow-hidden rounded-md border border-line font-mono text-[10px]">
            {(["live", "history"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={`px-2 py-0.5 transition-colors ${source === s ? "bg-surface2 text-text" : "text-dim hover:text-text"}`}
              >
                {s === "live" ? "live capture" : "seasons"}
              </button>
            ))}
          </div>
          {source === "history"
            ? [2024, 2025].map((yr) => (
                <button key={yr} type="button" onClick={() => toggleSeason(yr)} className={chip(seasons.includes(yr))}>
                  {yr}
                </button>
              ))
            : null}
        </div>
      </div>

      {err ? (
        <div className="rounded-lg border border-dashed border-line/70 p-6 text-sm text-dim">
          Couldn't run the study — the local DB (:5433) may be offline. Run{" "}
          <span className="font-mono text-text">pnpm db:historicals</span> and reopen.
        </div>
      ) : study ? (
        <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <div className="mb-3 font-mono text-[11px] text-dim">
            After a team scores ≥{params.run_threshold} in a half-inning, does the opponent respond next half? ·{" "}
            {study.games} games · {study.data_window}
            {noise ? <span className="ml-2 text-amber-400">difference within ~1 SE (noise)</span> : null}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-line bg-surface p-4">
              <div className="mb-1 text-sm font-medium text-text">Opponent response rate vs baseline</div>
              <RateVsBaseline s={study} />
            </div>
            <div className="rounded-lg border border-line bg-surface p-4">
              <div className="mb-1 text-sm font-medium text-text">Response runs, when they respond</div>
              <Distribution dist={study.response_dist} />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-dim">
            <span>avg response: <span className="text-text">{study.avg_response_runs?.toFixed(2) ?? "—"}</span> vs baseline {study.baseline_avg_runs?.toFixed(2) ?? "—"} runs</span>
            {study.avg_abs_move_cents != null ? (
              <span>market: avg move {study.avg_abs_move_cents.toFixed(1)}¢ · toward big team {study.avg_move_vs_big_team_cents?.toFixed(1) ?? "—"}¢</span>
            ) : null}
            {study.runs_capture_pct != null && study.runs_capture_pct < 0.95 ? (
              <span className="text-amber-400">runs capture {pct(study.runs_capture_pct)} — caveat conclusions</span>
            ) : null}
          </div>
          {study.note ? <div className="mt-2 font-mono text-[10px] text-dim/70">{study.note}</div> : null}
        </div>
      ) : (
        <div className="h-48 animate-pulse rounded-lg bg-surface2/60" />
      )}
    </div>
  );
}
