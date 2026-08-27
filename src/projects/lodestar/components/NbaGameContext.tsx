/**
 * NBA game context panel — server-computed `get_nba_game_context` (LODE-16/18/19),
 * organized as a persistent score header + tabs (Overview / Runs / Swings / Book)
 * so the dense data isn't one long scroll (LODE-45). All numbers come precomputed
 * from the backend — nothing is calculated here.
 */

import { useEffect, useState } from "react";
import { api, type GameRun, type NbaGameContext, type PlayRow } from "../api/client";

function pct(p: number | null | undefined): string {
  return p == null ? "—" : `${Math.round(p * 100)}%`;
}
function signed(n: number | null | undefined, suffix = ""): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n}${suffix}`;
}

function RunRow({ r, onSelect, activeTs }: { r: GameRun; onSelect?: (ts: string) => void; activeTs?: string | null }) {
  const move = r.prob_delta;
  const tone = move == null ? "text-dim" : move > 0 ? "text-up" : move < 0 ? "text-dn" : "text-dim";
  const label =
    r.kind === "lead_change"
      ? `${r.team_name ?? r.team} take the lead`
      : `${r.team_name ?? r.team} ${r.points}-0 run`;
  const clickable = !!(r.ts && onSelect);
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => r.ts && onSelect?.(r.ts)}
      className={`flex w-full items-baseline justify-between gap-3 rounded px-1 py-0.5 text-left text-sm ${
        clickable ? "hover:bg-surface2" : "cursor-default"
      } ${r.ts && activeTs === r.ts ? "bg-surface2" : ""}`}
    >
      <span className="text-text">{label}</span>
      <span className="shrink-0 font-mono text-xs text-dim">
        {r.start_clock ? `${r.start_clock}→${r.end_clock}` : r.end_clock}
        {" · "}
        {r.away_score}-{r.home_score}
        {move != null && <span className={`ml-2 ${tone}`}>win-prob {signed(Math.round(move * 100), "pt")}</span>}
      </span>
    </button>
  );
}

interface PanelProps {
  ctx: NbaGameContext;
  onSelectMoment?: (ts: string) => void;
  selectedTs?: string | null;
}

export default function NbaGameContextPanel({ ctx, onSelectMoment, selectedTs }: PanelProps) {
  const g = ctx.game;
  const wp = ctx.win_prob;
  const bl = ctx.book_lines;
  const hasScore = !!(g && g.home_score != null);

  const tabs = [
    { id: "overview", label: "Overview", show: !!(wp && wp.open != null) || ctx.quarters.length > 0 },
    { id: "pbp", label: "Play-by-play", show: hasScore },
    { id: "runs", label: "Runs", show: ctx.runs.length > 0 || ctx.lead_changes.length > 0 },
    { id: "swings", label: "Swings", show: ctx.swings.length > 0 },
    { id: "book", label: "Book", show: !!bl },
  ].filter((t) => t.show);

  const [tab, setTab] = useState("overview");
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id;

  // Lazy-load the full play-by-play only when the PBP tab is opened.
  const [plays, setPlays] = useState<PlayRow[] | null>(null);
  useEffect(() => {
    setPlays(null);
  }, [ctx.ticker]);
  useEffect(() => {
    if (active !== "pbp" || plays) return;
    let cancelled = false;
    api
      .getNbaPbp(ctx.ticker)
      .then((p) => !cancelled && setPlays(p.plays))
      .catch(() => !cancelled && setPlays([]));
    return () => {
      cancelled = true;
    };
  }, [active, ctx.ticker, plays]);

  return (
    <div className="space-y-3 rounded-md border border-line bg-bg p-3">
      {/* persistent score header */}
      {hasScore && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-base text-text">
            {g.away_team} {g.away_score} @ {g.home_team} {g.home_score}
          </span>
          <span className="text-dim">·</span>
          <span className="text-sm text-dim">{g.status ?? ""}</span>
          {!g.linked && <span className="text-xs text-dim">(no live play-by-play)</span>}
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
          {ctx.quarters.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {ctx.quarters.map((q) => (
                <div key={q.period} className="rounded border border-line bg-surface px-2 py-1 font-mono text-xs">
                  <span className="text-dim">{q.label} </span>
                  <span className="text-text">{q.away_score}-{q.home_score}</span>
                  {q.prob_end != null && <span className="ml-1 text-dim">({pct(q.prob_end)})</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* RUNS + LEAD CHANGES */}
      {active === "runs" && (
        <div className="space-y-3">
          {ctx.runs.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-dim">scoring runs</div>
              {ctx.runs.map((r, i) => (
                <RunRow key={i} r={r} onSelect={onSelectMoment} activeTs={selectedTs} />
              ))}
            </div>
          )}
          {ctx.lead_changes.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-dim">
                lead changes ({ctx.lead_changes.length})
              </div>
              {ctx.lead_changes.slice(0, 8).map((r, i) => (
                <RunRow key={i} r={r} onSelect={onSelectMoment} activeTs={selectedTs} />
              ))}
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
                <span className="truncate text-text">{s.play}</span>
                <span className="shrink-0 font-mono text-xs text-dim">
                  {s.clock} · {s.away_score}-{s.home_score}
                  <span className={`ml-2 ${tone}`}>{signed(Math.round(s.prob_delta * 100), "pt")}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* PLAY-BY-PLAY */}
      {active === "pbp" && (
        <div className="space-y-0.5">
          {plays == null ? (
            <div className="text-sm text-dim">loading plays…</div>
          ) : plays.length === 0 ? (
            <div className="text-sm text-dim">no play-by-play for this game</div>
          ) : (
            <>
              {!plays[0]?.ts && (
                <div className="mb-1 text-xs text-dim">
                  backfilled play-by-play — not pinned to the chart (game-clock only)
                </div>
              )}
              {plays.map((p, i) => {
                const clickable = !!(p.ts && onSelectMoment);
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={!clickable}
                    onClick={() => p.ts && onSelectMoment?.(p.ts)}
                    className={`flex w-full items-baseline justify-between gap-3 rounded px-1 py-0.5 text-left text-sm ${
                      clickable ? "hover:bg-surface2" : "cursor-default"
                    } ${p.ts && selectedTs === p.ts ? "bg-surface2" : ""}`}
                  >
                    <span className="truncate text-text">{p.description}</span>
                    <span className="shrink-0 font-mono text-xs text-dim">
                      {p.clock} · {p.away_score}-{p.home_score}
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}

      {/* BOOK CONSENSUS */}
      {active === "book" && bl && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-sm">
          <span className="text-dim">spread(home) <span className="text-text">{signed(bl.spread_home)}</span></span>
          <span className="text-dim">total <span className="text-text">{bl.total ?? "—"}</span></span>
          {bl.side && (
            <span className="text-dim">{bl.side} fair <span className="text-text">{bl.side_fair_cents ?? "—"}¢</span></span>
          )}
          {bl.kalshi_open_cents != null && (
            <span className="text-dim">Kalshi open <span className="text-text">{bl.kalshi_open_cents}¢</span></span>
          )}
          {bl.edge_cents != null && (
            <span className="text-dim">
              edge <span className={bl.edge_cents > 0 ? "text-up" : bl.edge_cents < 0 ? "text-dn" : "text-text"}>{signed(bl.edge_cents, "¢")}</span>
            </span>
          )}
          <span className="text-dim">books <span className="text-text">{bl.books}</span></span>
        </div>
      )}

      {ctx.note && <div className="text-xs text-dim">{ctx.note}</div>}
    </div>
  );
}
