/**
 * Sports desk dashboard (desk-dashboards epic phase 1, owner pin 20260731-140628):
 * what's hot, what's tired, what's paying — across CAPTURED leagues (MLB in
 * season), before picking a case. One GET /dashboard/sports; every number is
 * derived from the local snapshot and the notes say exactly how (capture-era
 * records, true-settled hit-rates). Identity = text labels; green/red only for
 * polarity (W/L, streaks). No ghost widgets — needs-source ideas live in the
 * epic, not on this surface.
 */

import { useState } from "react";
import {
  api,
  type BatterFormRow,
  type SportsDashboard,
  type StreakRow,
} from "../../api/client";
import { useCachedFetch } from "../../lib/queryCache";
import { ptTime, ptWeekday } from "../../lib/time";

const AMBER = "#d18f5a";

/** IL moves read in opposite directions — a placement costs a team a player, an
 *  activation gives one back. Polarity only, per the house rule. */
const MOVE_TONE: Record<string, string> = {
  placed: "text-dn",
  transferred: "text-dn",
  activated: "text-up",
};

function BatLine({ b, tone }: { b: BatterFormRow; tone: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-dashed border-line py-1 last:border-b-0">
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-text">{b.player}</span>
      <span className={`font-mono text-[10.5px] ${tone}`}>{b.avg.toFixed(3).replace(/^0/, "")}</span>
      <span className="w-16 shrink-0 text-right font-mono text-[9.5px] text-dim">
        {b.at_bats} AB{b.home_runs > 0 ? ` · ${b.home_runs}HR` : ""}
      </span>
    </div>
  );
}

function StreakLine({ s }: { s: StreakRow }) {
  const win = s.streak.startsWith("W");
  return (
    <div className="flex items-center gap-2 border-b border-dashed border-line py-1.5 last:border-b-0">
      <span className="truncate text-[12px] text-text">{s.team}</span>
      <span
        className={`rounded px-1.5 py-px font-mono text-[9.5px] ${win ? "text-up" : "text-dn"}`}
        style={{ background: win ? "rgba(78,169,106,.12)" : "rgba(224,100,91,.12)" }}
      >
        {s.streak}
      </span>
      <span className="ml-auto font-mono text-[10px] text-dim">
        {s.wins}-{s.losses}
      </span>
    </div>
  );
}

export default function SportsDash() {
  // Cached across route changes so leaving the tab doesn't re-pay the build.
  // (That build was 32s until the LATERAL rewrite in dashboards.py made it ~1s;
  // the cache is what keeps a tab flick instant regardless.)
  const {
    data: dash,
    error: err,
    loading,
    refreshing,
    mutate,
  } = useCachedFetch<SportsDashboard>("dashboard:sports", () => api.getSportsDashboard(false));

  // The button forces a server-side REBUILD (refresh=true). That response IS the
  // new dashboard, so it goes straight into cache + state via `mutate` — issuing
  // a follow-up read would just re-download what we already hold.
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildErr, setRebuildErr] = useState<string | null>(null);
  const hardRefresh = (): void => {
    setRebuilding(true);
    setRebuildErr(null);
    void api
      .getSportsDashboard(true)
      .then(mutate)
      .catch((e: unknown) => setRebuildErr(String(e)))
      .finally(() => setRebuilding(false));
  };

  if (err && !dash) return <div className="rounded-lg border border-dashed border-line p-4 text-sm text-dim">{err}</div>;
  if (loading) return <div className="p-4 font-mono text-xs text-dim">loading…</div>;
  if (!dash) return null;

  return (
    <div className="max-w-5xl">
      <div className="mb-3 flex items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: AMBER }}>
          mlb · in season
        </span>
        {rebuildErr ? <span className="font-mono text-[9.5px] text-dn">refresh failed</span> : null}
        <button type="button" onClick={hardRefresh} className="ml-auto font-mono text-[10px] uppercase text-dim hover:text-text">
          {rebuilding || refreshing ? "refreshing…" : "refresh"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-line bg-surface p-3.5">
          <div className="mb-2 text-xs font-medium text-text">Hot / cold teams</div>
          {dash.streaks.hot.map((s) => (
            <StreakLine key={s.team} s={s} />
          ))}
          {dash.streaks.cold.map((s) => (
            <StreakLine key={s.team} s={s} />
          ))}
          {dash.streaks.hot.length + dash.streaks.cold.length === 0 ? (
            <div className="text-xs text-dim">no captured finals yet</div>
          ) : null}
        </div>

        <div className="rounded-lg border border-line bg-surface p-3.5">
          <div className="mb-0.5 text-xs font-medium text-text">Bets hitting lately</div>
          <div className="mb-2 font-mono text-[9.5px] text-dim">moneylines, true-settled from scores · first print</div>
          {dash.hit_rates.map((h) => (
            <div key={h.label} className="flex items-center gap-2 py-1.5">
              <span className="w-24 shrink-0 truncate text-[11.5px] text-text">{h.label}</span>
              {/* the track is the full remaining row — 100% hit rate fills it */}
              <span className="min-w-0 flex-1">
                <span className="block h-2 rounded-r" style={{ width: `${Math.round(h.hit_rate * 100)}%`, background: AMBER, opacity: 0.85 }} />
              </span>
              <span className="w-20 shrink-0 text-right font-mono text-[10px] text-dim">
                {(h.hit_rate * 100).toFixed(0)}% · n={h.n}
              </span>
            </div>
          ))}
          {dash.hit_rates.length === 0 ? <div className="text-xs text-dim">no settled moneylines in the window</div> : null}
        </div>

        <div className="rounded-lg border border-line bg-surface p-3.5">
          <div className="mb-2 text-xs font-medium text-text">Upcoming</div>
          {dash.upcoming.map((g) => (
            <div key={`${g.away}@${g.home}${g.tip_off_utc}`} className="flex items-center gap-2 border-b border-dashed border-line py-1.5 last:border-b-0">
              <span className="truncate text-[11.5px] text-text">
                {g.away} @ {g.home}
              </span>
              <span className="ml-auto font-mono text-[10px] text-dim">
                {ptWeekday(g.tip_off_utc)} {ptTime(g.tip_off_utc)}
              </span>
            </div>
          ))}
          {dash.upcoming.length === 0 ? <div className="text-xs text-dim">nothing scheduled in the snapshot window</div> : null}
        </div>
      </div>

      {/* ── phase 3: the StatsAPI lanes ── */}
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-line bg-surface p-3.5">
          <div className="mb-0.5 text-xs font-medium text-text">Key injuries</div>
          <div className="mb-2 font-mono text-[9.5px] text-dim">IL moves · last {dash.windows.injury_days} days</div>
          {dash.injuries.slice(0, 8).map((i, idx) => (
            <div key={`${i.player}-${i.date}-${idx}`} className="border-b border-dashed border-line py-1.5 last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-text">{i.player}</span>
                <span className={`font-mono text-[9.5px] ${MOVE_TONE[i.move] ?? "text-dim"}`}>
                  {i.move}
                  {i.il_kind ? ` ${i.il_kind}` : ""}
                </span>
              </div>
              <div className="truncate font-mono text-[9.5px] text-dim">
                {i.team}
                {i.date ? ` · ${i.date.slice(5)}` : ""}
              </div>
            </div>
          ))}
          {dash.injuries.length === 0 ? (
            <div className="text-xs text-dim">no IL moves in the window</div>
          ) : null}
        </div>

        <div className="rounded-lg border border-line bg-surface p-3.5">
          <div className="mb-0.5 text-xs font-medium text-text">Exhausted bullpens</div>
          <div className="mb-2 font-mono text-[9.5px] text-dim">high-usage arms · last {dash.windows.bullpen_days} days</div>
          {dash.bullpens.map((b) => (
            <div key={b.team} className="border-b border-dashed border-line py-1.5 last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-[11.5px] text-text">{b.team}</span>
                <span className="ml-auto font-mono text-[9.5px]" style={{ color: AMBER }}>
                  {b.flagged} arm{b.flagged === 1 ? "" : "s"}
                </span>
              </div>
              {b.arms.slice(0, 2).map((a) => (
                <div key={a.player} className="truncate font-mono text-[9.5px] text-dim">
                  {a.player} — {a.why.join(" · ")}
                </div>
              ))}
            </div>
          ))}
          {dash.bullpens.length === 0 ? (
            <div className="text-xs text-dim">no flagged arms — or the collector hasn't run</div>
          ) : null}
        </div>

        <div className="rounded-lg border border-line bg-surface p-3.5">
          <div className="mb-0.5 text-xs font-medium text-text">Probable starters</div>
          <div className="mb-2 font-mono text-[9.5px] text-dim">next 36 hours</div>
          {dash.probables.slice(0, 6).map((p, idx) => (
            <div key={`${p.away}@${p.home}-${idx}`} className="border-b border-dashed border-line py-1.5 last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-[11.5px] text-text">
                  {p.away} @ {p.home}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[9.5px] text-dim">
                  {p.game_time_utc ? `${ptWeekday(p.game_time_utc)} ${ptTime(p.game_time_utc)}` : ""}
                </span>
              </div>
              <div className="truncate font-mono text-[9.5px] text-dim">
                {p.away_pitcher ?? "TBD"} vs {p.home_pitcher ?? "TBD"}
                {p.state && p.state !== "Scheduled" ? ` · ${p.state}` : ""}
              </div>
            </div>
          ))}
          {dash.probables.length > 6 ? (
            // never silently truncate a slate — say how many are hidden
            <div className="pt-1.5 font-mono text-[9.5px] text-dim/70">
              +{dash.probables.length - 6} more
            </div>
          ) : null}
          {dash.probables.length === 0 ? (
            <div className="text-xs text-dim">no slate in the window</div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-line bg-surface p-3.5">
          <div className="mb-0.5 text-xs font-medium text-text">Out of today's lineup</div>
          <div className="mb-2 font-mono text-[9.5px] text-dim">
            played ≥70% of the club's last {dash.windows.scratch_days} days · cause shown only where known
          </div>
          <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            {dash.scratches.slice(0, 10).map((s) => (
              <div
                key={`${s.team}-${s.player}`}
                className="flex items-center gap-2 border-b border-dashed border-line py-1 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-text">{s.player}</span>
                <span className="shrink-0 font-mono text-[9.5px] text-dim">{s.team}</span>
                {/* an unexplained absence is stated as such, never guessed at */}
                <span className={`w-24 shrink-0 text-right font-mono text-[9.5px] ${s.reason ? "text-dn" : "text-dim/70"}`}>
                  {s.reason ?? `${s.recent_games}/${s.of_games} games`}
                </span>
              </div>
            ))}
          </div>
          {dash.scratches.length > 10 ? (
            <div className="pt-1.5 font-mono text-[9.5px] text-dim/70">
              +{dash.scratches.length - 10} more
            </div>
          ) : null}
          {dash.scratches.length === 0 ? (
            // say WHY it's empty rather than vanishing — pre-lineup hours are the
            // common case and a missing card reads as "nothing to report"
            <div className="text-xs text-dim">
              no lineups posted yet, or no regulars missing from the ones that are
            </div>
          ) : null}
      </div>

      <div className="mt-3 rounded-lg border border-line bg-surface p-3.5">
        <div className="mb-0.5 text-xs font-medium text-text">Trending bats</div>
        <div className="mb-2 font-mono text-[9.5px] text-dim">AVG over {dash.windows.form_days} days · min 15 AB</div>
        <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          <div>
            <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-dim">hot</div>
            {dash.trending_bats.hot.map((b) => (
              <BatLine key={b.player} b={b} tone="text-up" />
            ))}
          </div>
          <div>
            <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-dim">cold</div>
            {dash.trending_bats.cold.map((b) => (
              <BatLine key={b.player} b={b} tone="text-dn" />
            ))}
          </div>
        </div>
        {dash.trending_bats.hot.length === 0 ? (
          <div className="text-xs text-dim">not enough plate appearances captured yet</div>
        ) : null}
      </div>

      <div className="mt-3 rounded-lg border border-line bg-surface p-3.5">
        <div className="mb-2 text-xs font-medium text-text">Standings · captured finals</div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 lg:grid-cols-3">
          {dash.standings.map((d) => (
            <div key={d.division}>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-dim">{d.division}</div>
              {d.teams.map((t, i) => (
                <div key={t.team} className="flex items-center gap-2 py-0.5">
                  <span className={`text-[11.5px] ${i === 0 ? "text-text" : "text-dim"}`}>{t.team}</span>
                  <span className="ml-auto font-mono text-[10px] text-dim">
                    {t.wins}-{t.losses}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {dash.notes.length > 0 ? (
        <div className="mt-2 space-y-0.5">
          {dash.notes.map((n) => (
            <div key={n} className="font-mono text-[9.5px] text-dim/70">
              · {n}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
