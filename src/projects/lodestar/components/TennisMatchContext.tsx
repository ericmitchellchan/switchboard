/**
 * Tennis match context panel — server-computed `get_tennis_match_context`
 * (LODE-53), the tennis analog of NbaGameContext: a persistent match header +
 * tabs (Overview / Sets & Breaks / Swings / Stats / H2H). All numbers come
 * precomputed from the backend — nothing is calculated here. Set/break/swing
 * rows with a wall-clock ts pin that moment on the market chart.
 */

import { useState } from "react";
import type { BreakMoment, SetLine, TennisMatchContext } from "../api/client";

function pct(p: number | null | undefined): string {
  return p == null ? "—" : `${Math.round(p * 100)}%`;
}
function signed(n: number | null | undefined, suffix = ""): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n}${suffix}`;
}

interface MomentRowProps {
  label: string;
  detail: string;
  move: number | null;
  ts: string | null;
  onSelect?: (ts: string) => void;
  activeTs?: string | null;
}

function MomentRow({ label, detail, move, ts, onSelect, activeTs }: MomentRowProps) {
  const tone = move == null ? "text-dim" : move > 0 ? "text-up" : move < 0 ? "text-dn" : "text-dim";
  const clickable = !!(ts && onSelect);
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => ts && onSelect?.(ts)}
      className={`flex w-full items-baseline justify-between gap-3 rounded px-1 py-0.5 text-left text-sm ${
        clickable ? "hover:bg-surface2" : "cursor-default"
      } ${ts && activeTs === ts ? "bg-surface2" : ""}`}
    >
      <span className="text-text">{label}</span>
      <span className="shrink-0 font-mono text-xs text-dim">
        {detail}
        {move != null && <span className={`ml-2 ${tone}`}>win-prob {signed(Math.round(move * 100), "pt")}</span>}
      </span>
    </button>
  );
}

interface PanelProps {
  ctx: TennisMatchContext;
  onSelectMoment?: (ts: string) => void;
  selectedTs?: string | null;
}

export default function TennisMatchContextPanel({ ctx, onSelectMoment, selectedTs }: PanelProps) {
  const m = ctx.match;
  const wp = ctx.win_prob;
  const [p1, p2] = [ctx.players[0], ctx.players[1]];

  const tabs = [
    { id: "overview", label: "Overview", show: !!(wp && wp.open != null) || !!m },
    { id: "sets", label: "Sets & Breaks", show: ctx.sets.length > 0 || ctx.breaks.length > 0 },
    { id: "swings", label: "Swings", show: ctx.swings.length > 0 },
    { id: "stats", label: "Stats", show: ctx.stats.length > 0 },
    { id: "h2h", label: "H2H", show: !!ctx.h2h },
  ].filter((t) => t.show);

  const [tab, setTab] = useState("overview");
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id;

  const setRow = (s: SetLine) => (
    <MomentRow
      key={`set-${s.set_no}`}
      label={`Set ${s.set_no}${s.winner_name ? ` — ${s.winner_name}` : ""}`}
      detail={`${s.games_p1 ?? "?"}-${s.games_p2 ?? "?"}${s.prob_end != null ? ` · ${pct(s.prob_end)}` : ""}`}
      move={s.prob_delta}
      ts={s.ts}
      onSelect={onSelectMoment}
      activeTs={selectedTs}
    />
  );

  const breakRow = (b: BreakMoment, i: number) => (
    <MomentRow
      key={`brk-${i}`}
      label={`${b.player_name ?? `P${b.player}`} breaks`}
      detail={`set ${b.set_no ?? "?"} · ${b.games ?? ""}`}
      move={b.prob_delta}
      ts={b.ts}
      onSelect={onSelectMoment}
      activeTs={selectedTs}
    />
  );

  return (
    <div className="space-y-3 rounded-md border border-line bg-bg p-3">
      {/* persistent match header */}
      {m && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-base text-text">
            {p1?.name ?? p1?.code} vs {p2?.name ?? p2?.code}
          </span>
          {m.final_score && <span className="font-mono text-sm text-text">{m.final_score}</span>}
          <span className="text-dim">·</span>
          <span className="text-sm text-dim">
            {[m.level, m.tournament, m.surface, m.status].filter(Boolean).join(" · ")}
          </span>
          {m.winner_name && <span className="text-xs text-accent">{m.winner_name} won</span>}
        </div>
      )}

      {/* tab bar */}
      {tabs.length > 0 && (
        <div className="flex gap-1 border-b border-line">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-2 py-1 font-mono text-[11px] uppercase tracking-wide transition-colors ${
                active === t.id ? "border-accent text-text" : "border-transparent text-dim hover:text-text"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* OVERVIEW */}
      {active === "overview" && (
        <div className="space-y-3">
          {wp && wp.open != null && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-sm">
              <span className="text-dim">open <span className="text-text">{pct(wp.open)}</span></span>
              <span className="text-dim">close <span className="text-text">{pct(wp.close)}</span></span>
              <span className="text-dim">range <span className="text-text">{pct(wp.min)}–{pct(wp.max)}</span></span>
              <span className="text-dim">max swing <span className="text-text">{signed(wp.max_swing == null ? null : Math.round(wp.max_swing * 100), "pt")}</span></span>
              <span className="text-dim">50% crossings <span className="text-text">{wp.crossings_50}</span></span>
            </div>
          )}
          {ctx.players.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {ctx.players.map((p) => (
                <div key={p.num} className="rounded border border-line bg-surface px-2 py-1 font-mono text-xs">
                  <span className="text-text">{p.name ?? p.code}</span>
                  {p.rank != null && <span className="ml-1 text-dim">#{p.rank}</span>}
                  {p.country && <span className="ml-1 text-dim">{p.country}</span>}
                  {ctx.side_player === p.num && <span className="ml-1 text-accent">← market side</span>}
                </div>
              ))}
            </div>
          )}
          {m?.round && <div className="text-xs text-dim">{m.round}</div>}
        </div>
      )}

      {/* SETS + BREAKS */}
      {active === "sets" && (
        <div className="space-y-3">
          {ctx.sets.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-dim">sets</div>
              {ctx.sets.map(setRow)}
            </div>
          )}
          {ctx.breaks.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-dim">
                breaks of serve ({ctx.breaks.length})
              </div>
              {ctx.breaks.map(breakRow)}
            </div>
          )}
        </div>
      )}

      {/* BIGGEST SWINGS */}
      {active === "swings" && (
        <div className="space-y-0.5">
          {ctx.swings.map((s, i) => {
            const tone = s.prob_delta > 0 ? "text-up" : "text-dn";
            const clickable = !!(s.ts && onSelectMoment);
            return (
              <button
                key={i}
                type="button"
                disabled={!clickable}
                onClick={() => s.ts && onSelectMoment?.(s.ts)}
                className={`flex w-full items-baseline justify-between gap-3 rounded px-1 py-0.5 text-left text-sm ${
                  clickable ? "hover:bg-surface2" : "cursor-default"
                } ${s.ts && selectedTs === s.ts ? "bg-surface2" : ""}`}
              >
                <span className="text-text">
                  sets {s.sets ?? "?"} · games {s.games ?? "?"}
                </span>
                <span className="shrink-0 font-mono text-xs text-dim">
                  {pct(s.prob)}
                  <span className={`ml-2 ${tone}`}>{signed(Math.round(s.prob_delta * 100), "pt")}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* SERVE / RETURN STATS */}
      {active === "stats" && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left font-mono text-[11px] uppercase tracking-wide text-dim">
                <th className="py-1 pr-3 font-medium">player</th>
                <th className="py-1 pr-3 font-medium">aces</th>
                <th className="py-1 pr-3 font-medium">DFs</th>
                <th className="py-1 pr-3 font-medium">1st srv</th>
                <th className="py-1 pr-3 font-medium">1st won</th>
                <th className="py-1 pr-3 font-medium">BP saved</th>
                <th className="py-1 pr-3 font-medium">BP conv</th>
                <th className="py-1 font-medium">pts</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              {ctx.stats.map((t) => (
                <tr key={t.player} className="border-t border-line">
                  <td className="py-1 pr-3 text-text">{t.name ?? `P${t.player}`}</td>
                  <td className="py-1 pr-3 text-text">{t.aces ?? "—"}</td>
                  <td className="py-1 pr-3 text-text">{t.double_faults ?? "—"}</td>
                  <td className="py-1 pr-3 text-text">{t.first_serve_pct != null ? `${t.first_serve_pct}%` : "—"}</td>
                  <td className="py-1 pr-3 text-text">
                    {t.first_serve_won != null && t.first_serve_total != null
                      ? `${t.first_serve_won}/${t.first_serve_total}`
                      : "—"}
                  </td>
                  <td className="py-1 pr-3 text-text">
                    {t.bp_saved != null && t.bp_save_total != null ? `${t.bp_saved}/${t.bp_save_total}` : "—"}
                  </td>
                  <td className="py-1 pr-3 text-text">
                    {t.bp_converted != null && t.bp_convert_total != null
                      ? `${t.bp_converted}/${t.bp_convert_total}`
                      : "—"}
                  </td>
                  <td className="py-1 text-text">
                    {t.total_points_won != null && t.total_points_total != null
                      ? `${t.total_points_won}/${t.total_points_total}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* HEAD-TO-HEAD */}
      {active === "h2h" && ctx.h2h && (
        <div className="space-y-2">
          <div className="font-mono text-sm">
            <span className="text-text">{p1?.name ?? "P1"} {ctx.h2h.p1_wins}</span>
            <span className="text-dim"> – </span>
            <span className="text-text">{ctx.h2h.p2_wins} {p2?.name ?? "P2"}</span>
          </div>
          {ctx.h2h.meetings.length > 0 && (
            <div className="space-y-0.5">
              {ctx.h2h.meetings.map((mt, i) => (
                <div key={i} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate text-text">
                    {mt.winner === "p1" ? p1?.name : mt.winner === "p2" ? p2?.name : "?"} won
                    {mt.tournament ? ` · ${mt.tournament}` : ""}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-dim">
                    {mt.score ?? ""}{mt.date ? ` · ${mt.date}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {ctx.note && <div className="text-xs text-dim">{ctx.note}</div>}
    </div>
  );
}
