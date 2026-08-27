/**
 * Player ARC — form/trajectory over the 2-year match history (the segment the narrow
 * live window couldn't support). Search a player → see their month-by-month win rate
 * as a line, with the computed trajectory (rising / peak / fading / steady). Reads
 * lodestar_tennis_matches_hist via /research/tennis/arc; shows real numbers once the
 * Sackmann backfill has been loaded.
 */

import { useEffect, useState } from "react";
import { api, type TennisArc, type TennisHistPlayer } from "../../api/client";

const CLASS_COLOR: Record<string, string> = {
  rising: "#4ea96a",
  fading: "#e0645b",
  peak: "#7c8ce8",
  steady: "#5aa6c9",
  unrated: "#55555e",
};
const CLASS_NOTE: Record<string, string> = {
  rising: "recent form well above earlier",
  fading: "recent form well below earlier",
  peak: "holding strong, no decline",
  steady: "flat trajectory",
  unrated: "not enough history to judge",
};
const monthLabel = (p: string): string => {
  const [y, m] = p.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
};

/** Win-rate over time (line) with faint match-count bars underneath. */
function ArcChart({ arc }: { arc: TennisArc }) {
  const pts = arc.series.filter((s) => s.matches > 0);
  if (pts.length < 2) return <div className="text-[11px] text-dim">not enough dated matches to draw a trajectory</div>;
  const color = CLASS_COLOR[arc.arc_class] ?? "#5aa6c9";
  const W = 640;
  const H = 190;
  const PAD = { l: 34, r: 10, t: 12, b: 40 };
  const maxMatches = Math.max(...pts.map((s) => s.matches));
  const wr = (s: { wins: number; matches: number }): number => s.wins / s.matches;
  const x = (i: number): number => PAD.l + (i / (pts.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number): number => PAD.t + (1 - v) * (H - PAD.t - PAD.b); // v in [0,1]
  const barH = 24;
  const labelEvery = Math.ceil(pts.length / 9);
  const path = pts.map((s, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(wr(s)).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="#1e1e24" strokeDasharray="2 4" />
          <text x={PAD.l - 5} y={y(t) + 3} textAnchor="end" fill="#8a8a93" fontSize="8" fontFamily="monospace">
            {Math.round(t * 100)}%
          </text>
        </g>
      ))}
      {/* match-count bars along the bottom */}
      {pts.map((s, i) => {
        const h = (s.matches / maxMatches) * barH;
        return <rect key={`b${i}`} x={x(i) - 2.5} y={H - PAD.b + 12 - h} width="5" height={h} fill="#55555e" opacity="0.4" />;
      })}
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
      {pts.map((s, i) => (
        <circle key={`p${i}`} cx={x(i)} cy={y(wr(s))} r="2" fill={color} />
      ))}
      {pts.map((s, i) =>
        i % labelEvery === 0 ? (
          <text key={`l${i}`} x={x(i)} y={H - 4} textAnchor="middle" fill="#55555e" fontSize="7.5" fontFamily="monospace">
            {monthLabel(s.period)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

export default function TennisArcView() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TennisHistPlayer[]>([]);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [arc, setArc] = useState<TennisArc | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || q === selected?.name) {
      setResults([]);
      return;
    }
    let cancelled = false;
    api.searchTennisPlayers(q, 12).then((r) => !cancelled && setResults(r)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [query, selected]);

  useEffect(() => {
    if (!selected) {
      setArc(null);
      return;
    }
    let cancelled = false;
    setErr(false);
    setArc(null);
    api
      .getPlayerArc(selected.id, selected.name)
      .then((a) => !cancelled && setArc(a))
      .catch(() => !cancelled && setErr(true));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const pick = (p: TennisHistPlayer): void => {
    setSelected({ id: p.player_id, name: p.name });
    setQuery(p.name);
    setResults([]);
  };

  return (
    <div className="flex flex-col gap-3 pb-6">
      <div className="relative rounded-lg border border-line bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-wide text-dim">player</span>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
            placeholder="search a player (e.g. Alcaraz)…"
            className="w-64 rounded-md border border-line bg-bg px-2 py-1 text-xs text-text placeholder:text-dim focus:border-accent focus:outline-none"
          />
          <span className="ml-auto font-mono text-[10px] text-dim">form over the 2-year history · Ctrl+I to ask the agent</span>
        </div>
        {results.length > 0 ? (
          <div className="absolute left-14 top-11 z-10 max-h-56 w-64 overflow-y-auto rounded-md border border-line bg-surface2 py-1 shadow-lg">
            {results.map((p) => (
              <button
                key={p.player_id}
                type="button"
                onClick={() => pick(p)}
                className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs text-text hover:bg-bg"
              >
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="font-mono text-[9px] text-dim">{p.matches}m</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {err ? (
        <div className="rounded-lg border border-dashed border-line/70 p-6 text-sm text-dim">
          Couldn't load the arc — the history table may be empty. Run{" "}
          <span className="font-mono text-text">backfill_tennis_history</span> against :5433, then reopen.
        </div>
      ) : !selected ? (
        <div className="rounded-lg border border-dashed border-line/60 p-8 text-center text-sm text-dim">
          Search a player to see their trajectory — rising, peak, fading, or steady — over ~2 years of results.
        </div>
      ) : arc == null ? (
        <div className="h-48 animate-pulse rounded-lg bg-surface2/60" />
      ) : (
        <div className="rounded-lg border border-line bg-surface p-4">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-sm font-medium text-text">{arc.player}</h3>
            <span
              className="rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide"
              style={{ color: CLASS_COLOR[arc.arc_class], border: `1px solid ${CLASS_COLOR[arc.arc_class]}55` }}
            >
              {arc.arc_class}
            </span>
            <span className="font-mono text-[10px] text-dim">{CLASS_NOTE[arc.arc_class]}</span>
            {arc.earlier_wr != null && arc.recent_wr != null ? (
              <span className="ml-auto font-mono text-[10px] text-dim">
                earlier {Math.round(arc.earlier_wr * 100)}% → recent {Math.round(arc.recent_wr * 100)}%
                {arc.delta != null ? (
                  <span style={{ color: arc.delta >= 0 ? CLASS_COLOR.rising : CLASS_COLOR.fading }}>
                    {" "}
                    ({arc.delta >= 0 ? "+" : ""}
                    {Math.round(arc.delta * 100)})
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
          <ArcChart arc={arc} />
          <div className="mt-1 font-mono text-[10px] text-dim/70">
            win rate by month · {arc.n} matches over {arc.periods} months · bars = match count
          </div>
        </div>
      )}
    </div>
  );
}
