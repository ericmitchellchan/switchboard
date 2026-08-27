/**
 * Tennis player profile drawer (research-streams T9): cohort rows from
 * research.duckdb with sample sizes beside every rate, peer percentiles, and a
 * start-a-case action (anchors a tennis case to the player).
 *
 * Resolution is KEY-FIRST (the match context carries player_key); the by-name
 * fallback exists for callers without a key and REFUSES to guess on name
 * collisions — a wrong anchor on a suspicion-shaped surface is worse than no
 * anchor.
 */

import { useEffect, useState } from "react";
import ResearchStatusChip from "./ResearchStatusChip";
import { api, type AnomalyMatch, type TennisProfileRow } from "../../api/client";

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

function Row({ label, value, n }: { label: string; value: string; n?: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-dim">{label}</span>
      <span className="font-mono text-text">
        {value}
        {n != null ? <span className="text-dim"> ·n={n}</span> : null}
      </span>
    </div>
  );
}

export default function ProfileDrawer({
  playerName,
  playerKey,
  onClose,
}: {
  playerName: string;
  /** Preferred: resolves the profile directly. Name fallback refuses collisions. */
  playerKey?: string | null;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<TennisProfileRow[] | null>(null);
  const [board, setBoard] = useState<AnomalyMatch[] | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [caseMsg, setCaseMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAmbiguous(false);
    if (playerKey) {
      api
        .getTennisProfile(playerKey)
        .then((r) => !cancelled && setRows(r))
        .catch(() => !cancelled && setRows([]));
    } else {
      // by-name fallback (callers without a key). Collisions are surfaced,
      // never guessed: two players sharing a name must not swap anchors.
      api
        .listTennisProfiles({ level: "all", surface: "all", limit: 10000 })
        .then((all) => {
          if (cancelled) return;
          const hits = all.filter((r) => r.player_name === playerName);
          if (hits.length === 0) {
            setRows([]);
            return;
          }
          if (hits.length > 1) {
            setAmbiguous(true);
            setRows([]);
            return;
          }
          return api.getTennisProfile(hits[0].player_key).then((r) => !cancelled && setRows(r));
        })
        .catch(() => !cancelled && setRows([]));
    }
    return () => {
      cancelled = true;
    };
  }, [playerName, playerKey]);

  // Recurrence: does this player keep appearing on the anomaly board? (the
  // question the agent flagged as unanswerable before)
  useEffect(() => {
    let cancelled = false;
    api
      .topAnomalies(200)
      .then((b) => {
        if (cancelled) return;
        setBoard(
          b.filter((r) => r.player1_name === playerName || r.player2_name === playerName),
        );
      })
      .catch(() => !cancelled && setBoard([]));
    return () => {
      cancelled = true;
    };
  }, [playerName]);

  const all = rows?.find((r) => r.level === "all" && r.surface === "all");
  const cohorts = (rows ?? []).filter((r) => !(r.level === "all" && r.surface === "all"));

  const startCase = async (): Promise<void> => {
    if (!all || creating) return;
    setCreating(true);
    const c = await api
      .createCase({
        title: `${playerName} — profile investigation`,
        stream: "tennis",
        subject: { kind: "player", player_key: all.player_key, label: playerName },
      })
      .catch((e) => {
        console.error("case creation failed", e);
        return null;
      });
    setCreating(false);
    setCaseMsg(c ? `case created (${c.case_id}) — open the Playground` : "case creation failed");
  };

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-[340px] flex-col border-l border-line bg-bg p-4 shadow-2xl">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="font-mono text-lg text-text">{playerName}</div>
          <div className="font-mono text-[11px] text-dim">
            player profile · <ResearchStatusChip dataset="tennis-profiles" />
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-dim hover:text-text">✕</button>
      </div>

      {rows == null ? (
        <div className="text-sm text-dim">loading…</div>
      ) : ambiguous ? (
        <div className="text-sm text-dim">
          Multiple players share this name — open the profile from a match view
          (which carries the exact player key) instead.
        </div>
      ) : !all ? (
        <div className="text-sm text-dim">
          No profile — the player has no completed matches in the built window
          (run build_research after a data refresh).
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="rounded-lg border border-line p-2.5">
            <div className="mb-1 font-mono text-[10px] uppercase text-dim">
              all matches · n={all.matches}
            </div>
            <Row label="win rate" value={pct(all.win_rate)} n={all.matches} />
            <Row label="closes after set 1" value={pct(all.close_rate_after_set1)} n={all.set1_matches} />
            <Row label="deciders won" value={pct(all.decider_win_rate)} n={all.deciders} />
            <Row label="hold rate" value={pct(all.hold_rate)} n={all.service_games} />
            <Row label="break rate" value={pct(all.break_rate)} n={all.return_games} />
            <Row label="breaks/match (both)" value={all.avg_breaks_per_match?.toFixed(1) ?? "—"} />
            <Row label="market swing (p5–p95)" value={all.avg_market_swing ? `${Math.round(all.avg_market_swing)}¢` : "—"} n={all.swing_matches} />
            <Row label="1st serve" value={all.first_serve_pct ? `${Math.round(all.first_serve_pct)}%` : "—"} />
            <Row label="BP saved / converted" value={`${pct(all.bp_save_rate)} / ${pct(all.bp_convert_rate)}`} />
          </div>

          {board && board.length > 0 ? (
            <div className="rounded-lg border border-line p-2.5">
              <div className="mb-1 font-mono text-[10px] uppercase text-dim">
                anomaly-board appearances · {board.length}
              </div>
              {board.map((r) => {
                const opp = r.player1_name === playerName ? r.player2_name : r.player1_name;
                const w = Math.min(100, Math.round((r.score_ratio / 2) * 100));
                return (
                  <div key={r.match_id} className="mb-1">
                    <div className="flex items-baseline justify-between gap-2 text-[11px]">
                      <span className="truncate text-dim">vs {opp ?? "?"}</span>
                      <span className="shrink-0 font-mono text-text">
                        ×{r.score_ratio.toFixed(2)}
                        <span className="text-dim"> ·n={r.n_sized_trades}</span>
                      </span>
                    </div>
                    <div className="h-1 w-full rounded bg-surface2">
                      <div
                        className="h-1 rounded"
                        style={{ width: `${w}%`, background: "#e0645b" }}
                      />
                    </div>
                  </div>
                );
              })}
              <div className="pt-0.5 font-mono text-[9px] leading-snug text-dim">
                matched by name over the sized window — repeated presence ≠ wrongdoing
              </div>
            </div>
          ) : null}
          {cohorts.map((r) => (
            <div key={`${r.level}-${r.surface}`} className="rounded-lg border border-line p-2.5">
              <div className="mb-1 font-mono text-[10px] uppercase text-dim">
                {r.level}{r.surface !== "all" ? ` · ${r.surface}` : ""} · n={r.matches}
              </div>
              <Row label="win rate" value={pct(r.win_rate)} n={r.matches} />
              <Row label="hold rate" value={pct(r.hold_rate)} n={r.service_games} />
              {r.peer_pct_hold != null && (
                <Row label="hold vs peers" value={`p${Math.round(r.peer_pct_hold * 100)}`} />
              )}
              {r.peer_pct_close != null && (
                <Row label="closing vs peers" value={`p${Math.round(r.peer_pct_close * 100)}`} />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-line pt-2">
        <button
          type="button"
          onClick={() => void startCase()}
          disabled={!all || creating}
          className="w-full rounded-md border border-line px-2 py-1.5 text-sm text-dim hover:border-accent hover:text-text disabled:opacity-40"
        >
          + start a case on {playerName}
        </button>
        {caseMsg ? <div className="mt-1 text-center text-[11px] text-accent">{caseMsg}</div> : null}
      </div>
    </div>
  );
}
