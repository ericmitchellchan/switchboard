/**
 * Tennis exploration (the engine, v1): a case Study surface as a PIVOT over the data.
 * Choose what to group by and what to measure; the chart composes from the live
 * aggregation service (/research/tennis/aggregate). Quick-starts are the entry
 * points; the ambient agent (Ctrl+I) composes anything the chips can't express.
 *
 * v1 dimensions: surface / level. Segments (player type/arc) + more measures land
 * next; the mechanism is here.
 */

import { useEffect, useState } from "react";
import { api, type TennisAggregate, type TennisCohort } from "../../api/client";
import TennisArcView from "./TennisArcView";

const GROUP_BY: { key: string; label: string; segment?: boolean }[] = [
  { key: "player_type", label: "Player type", segment: true },
  { key: "level", label: "Level" },
  { key: "surface", label: "Surface" },
];

const MEASURES: { key: string; label: string; pct: boolean }[] = [
  { key: "hold_rate", label: "Serve hold %", pct: true },
  { key: "break_rate", label: "Break %", pct: true },
  { key: "win_rate", label: "Win rate", pct: true },
  { key: "close_rate_after_set1", label: "Close-out after set 1", pct: true },
  { key: "decider_win_rate", label: "Decider win %", pct: true },
  { key: "bp_convert_rate", label: "BP conversion", pct: true },
  { key: "serve_pts_won_rate", label: "Serve pts won", pct: true },
  { key: "return_pts_won_rate", label: "Return pts won", pct: true },
  { key: "avg_market_swing", label: "Avg market swing (¢)", pct: false },
  { key: "avg_breaks_per_match", label: "Breaks / match", pct: false },
];

const QUICK_STARTS: { label: string; group_by: string; measure: string }[] = [
  { label: "Win rate by player type", group_by: "player_type", measure: "win_rate" },
  { label: "Serve hold by player type", group_by: "player_type", measure: "hold_rate" },
  { label: "Decider win % by player type", group_by: "player_type", measure: "decider_win_rate" },
  { label: "Serve hold by level", group_by: "level", measure: "hold_rate" },
  { label: "Serve hold by surface", group_by: "surface", measure: "hold_rate" },
];

// Real capture uses lowercase surface values (clay/hard; no grass this window).
const KEY_COLOR: Record<string, string> = {
  clay: "#d18f5a", hard: "#5aa6c9", grass: "#6fb38a",
  atp: "#7c8ce8", wta: "#c77dcf", atp_challenger: "#5aa6c9", wta_challenger: "#6fb38a",
  "all-court": "#7c8ce8", "serve-dominant": "#5aa6c9", "return-dominant": "#6fb38a", baseliner: "#d18f5a",
  field: "#55555e",
};
const KEY_LABEL: Record<string, string> = {
  clay: "Clay", hard: "Hard", grass: "Grass",
  atp: "ATP", wta: "WTA", atp_challenger: "ATP Challenger", wta_challenger: "WTA Challenger",
  "all-court": "All-court", "serve-dominant": "Serve-dom.", "return-dominant": "Return-dom.", baseliner: "Baseliner",
  field: "the field",
};
const prettyKey = (k: string): string => KEY_LABEL[k] ?? k;

function fmt(v: number | null, pct: boolean): string {
  if (v == null) return "—";
  return pct ? `${Math.round(v * 100)}%` : v.toFixed(1);
}

function BarChart({ agg }: { agg: TennisAggregate }) {
  const meas = MEASURES.find((m) => m.key === agg.measure);
  const pct = meas?.pct ?? false;
  const groups = agg.groups.filter((g) => g.value != null);
  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line/70 p-6 text-sm text-dim">
        No data for this pivot — the tennis profiles may not be built, or the local DB (:5433) is offline.
      </div>
    );
  }
  const W = 620;
  const H = 230;
  const PAD = { l: 44, r: 12, t: 18, b: 40 };
  const max = Math.max(...groups.map((g) => g.value as number)) * 1.12 || 1;
  const bw = Math.min(90, (W - PAD.l - PAD.r) / groups.length - 18);
  const step = (W - PAD.l - PAD.r) / groups.length;
  const y = (v: number): number => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const ticks = [0, max / 2, max];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="#1e1e24" strokeDasharray="2 4" />
          <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fill="#8a8a93" fontSize="9" fontFamily="monospace">
            {fmt(t, pct)}
          </text>
        </g>
      ))}
      {groups.map((g, i) => {
        const cx = PAD.l + i * step + step / 2;
        const top = y(g.value as number);
        const color = KEY_COLOR[g.key] ?? "#7c8ce8";
        return (
          <g key={g.key}>
            <rect x={cx - bw / 2} y={top} width={bw} height={H - PAD.b - top} rx="3" fill={color} opacity="0.85" />
            <text x={cx} y={top - 6} textAnchor="middle" fill={color} fontSize="11" fontFamily="monospace">
              {fmt(g.value, pct)}
            </text>
            <text x={cx} y={H - PAD.b + 15} textAnchor="middle" fill="#c9c9cf" fontSize="11">
              {prettyKey(g.key)}
            </text>
            <text x={cx} y={H - PAD.b + 28} textAnchor="middle" fill="#55555e" fontSize="8.5" fontFamily="monospace">
              {g.players} players · n={g.n.toLocaleString()}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function TennisExplore() {
  const [lens, setLens] = useState<"pivot" | "arc">("pivot");
  const [groupBy, setGroupBy] = useState("player_type"); // lead with the segment
  const [measure, setMeasure] = useState("win_rate");
  const [agg, setAgg] = useState<TennisAggregate | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);
  // custom cohorts (segments): list + the define panel
  const [cohorts, setCohorts] = useState<TennisCohort[]>([]);
  const [defining, setDefining] = useState(false);
  const [players, setPlayers] = useState<{ player_key: string; player_name: string; matches: number }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cohortName, setCohortName] = useState("");
  const [pQuery, setPQuery] = useState("");

  const loadCohorts = (): void => {
    void api.listCohorts().then(setCohorts).catch(() => undefined);
  };
  useEffect(loadCohorts, []);
  useEffect(() => {
    if (!defining || players.length) return;
    void api
      .listTennisProfiles({ level: "all", surface: "all", sort: "matches", limit: 120 })
      .then((rows) =>
        setPlayers(rows.map((r) => ({ player_key: r.player_key, player_name: r.player_name, matches: r.matches }))),
      )
      .catch(() => undefined);
  }, [defining, players.length]);

  const togglePick = (k: string): void =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const saveCohort = async (): Promise<void> => {
    const name = cohortName.trim();
    if (!name || picked.size === 0) return;
    const c = await api.createCohort(name, [...picked]).catch(() => null);
    if (c) {
      loadCohorts();
      setGroupBy(`cohort:${c.cohort_id}`);
      setDefining(false);
      setPicked(new Set());
      setCohortName("");
      setPQuery("");
    }
  };
  const removeCohort = async (id: string): Promise<void> => {
    await api.deleteCohort(id).catch(() => undefined);
    if (groupBy === `cohort:${id}`) setGroupBy("player_type");
    loadCohorts();
  };
  const activeCohort = groupBy.startsWith("cohort:")
    ? cohorts.find((c) => `cohort:${c.cohort_id}` === groupBy)
    : undefined;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(false);
    api
      .aggregateTennis(groupBy, measure)
      .then((a) => !cancelled && setAgg(a))
      .catch(() => !cancelled && setErr(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [groupBy, measure]);

  const measLabel = MEASURES.find((m) => m.key === measure)?.label ?? measure;
  const activeQuick = (q: (typeof QUICK_STARTS)[number]): boolean =>
    q.group_by === groupBy && q.measure === measure;

  const lensToggle = (
    <div className="inline-flex self-start overflow-hidden rounded-md border border-line font-mono text-[11px]">
      {(["pivot", "arc"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLens(l)}
          className={`px-3 py-0.5 transition-colors ${lens === l ? "bg-surface2 text-text" : "text-dim hover:text-text"}`}
        >
          {l === "pivot" ? "Pivot" : "Player arc"}
        </button>
      ))}
    </div>
  );

  if (lens === "arc") {
    return (
      <div className="flex flex-col gap-3 pb-6">
        {lensToggle}
        <TennisArcView />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 pb-6">
      {lensToggle}
      {/* pivot bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-dim">group by</span>
        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value)}
          className="rounded-md border bg-surface2 px-2 py-1 font-mono text-[11px] text-text focus:outline-none"
          style={{ borderColor: "#6fb38a" }}
        >
          <optgroup label="dimensions">
            {GROUP_BY.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
                {g.segment ? " · segment" : ""}
              </option>
            ))}
          </optgroup>
          {cohorts.length ? (
            <optgroup label="cohorts">
              {cohorts.map((c) => (
                <option key={c.cohort_id} value={`cohort:${c.cohort_id}`}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <span className="ml-1 font-mono text-[9px] uppercase tracking-wide text-dim">measure</span>
        <select
          value={measure}
          onChange={(e) => setMeasure(e.target.value)}
          className="rounded-md border border-accent bg-surface2 px-2 py-1 font-mono text-[11px] text-text focus:outline-none"
        >
          {MEASURES.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
        {activeCohort ? (
          <button
            type="button"
            onClick={() => void removeCohort(activeCohort.cohort_id)}
            className="font-mono text-[10px] text-dim transition-colors hover:text-dn"
          >
            delete cohort
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setDefining((v) => !v)}
          className="font-mono text-[10px] text-accent transition-colors hover:text-text"
        >
          {defining ? "close" : "＋ cohort"}
        </button>
        <span className="ml-auto font-mono text-[10px] text-dim">Ctrl+I to ask the agent to visualize anything</span>
      </div>

      {/* define a cohort — a hand-picked segment (owner: "a place to group players") */}
      {defining ? (
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <input
              value={cohortName}
              onChange={(e) => setCohortName(e.target.value)}
              placeholder="cohort name (e.g. Clay specialists)"
              className="w-52 rounded-md border border-line bg-bg px-2 py-1 text-xs text-text placeholder:text-dim focus:border-accent focus:outline-none"
            />
            <input
              value={pQuery}
              onChange={(e) => setPQuery(e.target.value)}
              placeholder="filter players…"
              className="w-40 rounded-md border border-line bg-bg px-2 py-1 text-xs text-text placeholder:text-dim focus:border-accent focus:outline-none"
            />
            <span className="font-mono text-[10px] text-dim">{picked.size} selected</span>
            <button
              type="button"
              onClick={() => void saveCohort()}
              disabled={!cohortName.trim() || picked.size === 0}
              className="ml-auto rounded-md bg-accent px-2.5 py-1 font-mono text-[11px] text-bg disabled:opacity-40"
            >
              save cohort
            </button>
          </div>
          <div className="grid max-h-52 grid-cols-2 gap-x-4 gap-y-0.5 overflow-y-auto md:grid-cols-3">
            {players
              .filter((p) => p.player_name.toLowerCase().includes(pQuery.trim().toLowerCase()))
              .map((p) => (
                <label key={p.player_key} className="flex cursor-pointer items-center gap-2 py-0.5 text-xs">
                  <input
                    type="checkbox"
                    checked={picked.has(p.player_key)}
                    onChange={() => togglePick(p.player_key)}
                    className="accent-accent"
                  />
                  <span className="min-w-0 flex-1 truncate text-text">{p.player_name}</span>
                  <span className="font-mono text-[9px] text-dim">{p.matches}m</span>
                </label>
              ))}
            {players.length === 0 ? <span className="text-xs text-dim">loading players…</span> : null}
          </div>
        </div>
      ) : null}

      {/* quick starts */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[9px] uppercase tracking-wide text-dim">quick starts</span>
        {QUICK_STARTS.map((q) => (
          <button
            key={q.label}
            type="button"
            onClick={() => {
              setGroupBy(q.group_by);
              setMeasure(q.measure);
            }}
            className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] transition-colors ${
              activeQuick(q) ? "" : "border-line text-dim hover:border-accent hover:text-text"
            }`}
            style={activeQuick(q) ? { borderColor: "#6fb38a", color: "#6fb38a" } : undefined}
          >
            {q.label}
          </button>
        ))}
      </div>

      {/* composed viz canvas */}
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="mb-1 flex items-baseline gap-2">
          <h3 className="text-sm font-medium text-text">
            {measLabel} by{" "}
            {activeCohort
              ? `${activeCohort.name} vs the field`
              : (GROUP_BY.find((g) => g.key === groupBy)?.label ?? groupBy).toLowerCase()}
          </h3>
          {groupBy === "player_type" ? (
            <span className="font-mono text-[10px]" style={{ color: "#6fb38a" }}>
              segment · computed from serve/return strength
            </span>
          ) : activeCohort ? (
            <span className="font-mono text-[10px]" style={{ color: "#6fb38a" }}>
              segment · your cohort vs the field
            </span>
          ) : null}
          <span className="ml-auto font-mono text-[10px] text-dim">sample-weighted · n≥3 matches</span>
        </div>
        {err ? (
          <div className="rounded-lg border border-dashed border-line/70 p-6 text-sm text-dim">
            Couldn't load — the local research DB (:5433) may be offline. Run{" "}
            <span className="font-mono text-text">pnpm db:historicals</span> and reopen.
          </div>
        ) : loading && !agg ? (
          <div className="h-40 animate-pulse rounded bg-surface2/60" />
        ) : agg ? (
          <BarChart agg={agg} />
        ) : null}
      </div>
      <div className="font-mono text-[10px] text-dim/70">
        Built from the tennis profiles · Feb–Apr capture. Deeper history (last ~2 yrs · results/prices, no
        microstructure) for richer scenarios is planned.
      </div>
    </div>
  );
}
