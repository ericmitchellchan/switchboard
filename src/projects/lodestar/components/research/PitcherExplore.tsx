/**
 * Pitcher / matchup explorer (LODE case-69 follow-on) — the deep-dive the owner asked
 * for: browse by season · team · pitcher, then click a pitcher to see game-by-game
 * strikeout history, K-rate/form over time, opponent matchups, and — where the market
 * existed — how the Kalshi K-prop LINES actually settled.
 *
 * Two honest layers: PERFORMANCE (StatsAPI parquet, every pitcher, 2026 so far) and
 * LINES (Kalshi KXMLBKS, ~218 pitchers Apr-Jul 2026). A pitcher never priced shows a
 * blank lines panel, stated plainly — the market is new, not the data missing.
 *
 * Backend: /research/mlb/pitchers* (mlb_pitching.py). Charts are custom SVG in the app's
 * house palette. "+ start a case" anchors an MLB case to the pitcher (mirrors ProfileDrawer).
 */

import { useEffect, useMemo, useState } from "react";
import {
  api,
  type MlbPitcherRow,
  type MlbPitcherDetail,
  type MlbGameLogEntry,
} from "../../api/client";

const PALETTE = { home: "#7c8ce8", away: "#5aa6c9", roll: "#c9a75a", yes: "#4ea96a", no: "#e0645b" };

function num(v: number | null | undefined, d = 2): string {
  return v == null ? "—" : v.toFixed(d);
}

// ───────────────────────── K-over-time chart ─────────────────────────
/** Game-by-game strikeout bars (home/away colored) + a rolling-5-start form line. */
function KChart({ series }: { series: MlbPitcherDetail["k_series"]; }) {
  const W = 760, H = 210, PAD = { t: 14, r: 14, b: 26, l: 26 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const maxK = Math.max(6, ...series.map((p) => p.K));
  const n = series.length;
  const bw = n > 0 ? (iw / n) * 0.62 : 0;
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (k: number) => PAD.t + ih - (k / maxK) * ih;
  const rollPath = series
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.roll5_K).toFixed(1)}`)
    .join(" ");
  const yTicks = [0, Math.round(maxK / 2), maxK];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 230 }}>
      {yTicks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="currentColor" className="text-line" strokeWidth={0.5} opacity={0.5} />
          <text x={PAD.l - 4} y={y(t) + 3} textAnchor="end" className="fill-dim font-mono" fontSize={8}>{t}</text>
        </g>
      ))}
      {series.map((p, i) => {
        const h = PAD.t + ih - y(p.K);
        return (
          <rect
            key={i}
            x={x(i) - bw / 2}
            y={y(p.K)}
            width={bw}
            height={Math.max(0, h)}
            rx={1}
            style={{ fill: PALETTE.home }}
            opacity={0.85}
          >
            <title>{`${p.x} — ${p.K} K (rate ${(p.krate * 100).toFixed(0)}%)`}</title>
          </rect>
        );
      })}
      {n > 1 ? <path d={rollPath} fill="none" stroke={PALETTE.roll} strokeWidth={1.5} /> : null}
      {/* first + last date ticks */}
      {n > 0 ? (
        <>
          <text x={x(0)} y={H - 8} textAnchor="start" className="fill-dim font-mono" fontSize={8}>{series[0].x.slice(5)}</text>
          <text x={x(n - 1)} y={H - 8} textAnchor="end" className="fill-dim font-mono" fontSize={8}>{series[n - 1].x.slice(5)}</text>
        </>
      ) : null}
    </svg>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <div className="font-mono text-[9px] uppercase tracking-wider text-dim">{label}</div>
      <div className="font-mono text-lg text-text">{value}</div>
      {sub ? <div className="font-mono text-[10px] text-dim">{sub}</div> : null}
    </div>
  );
}

// ───────────────────────── game-log row (expands to the line ladder) ─────────────────────────
function GameRow({ g }: { g: MlbGameLogEntry }) {
  const [open, setOpen] = useState(false);
  const priced = !!g.lines?.length;
  return (
    <>
      <tr
        className={`border-t border-line/60 ${priced ? "cursor-pointer hover:bg-surface2/40" : ""}`}
        onClick={priced ? () => setOpen((o) => !o) : undefined}
      >
        <td className="py-1 pr-2 font-mono text-[11px] text-dim">{g.date.slice(5)}</td>
        <td className="py-1 pr-2 text-xs text-text">
          <span className="text-dim">{g.is_home ? "vs" : "@"}</span> {g.opp}
        </td>
        <td className="py-1 pr-2 text-right font-mono text-xs text-text">{g.K}</td>
        <td className="py-1 pr-2 text-right font-mono text-[11px] text-dim">{g.ip}</td>
        <td className="py-1 pr-2 text-right font-mono text-[11px] text-dim">{g.bf}</td>
        <td className="py-1 pr-2 text-right font-mono text-[11px] text-dim">{(g.krate * 100).toFixed(0)}%</td>
        <td className="py-1 text-right font-mono text-[10px]">
          {priced ? <span className="text-accent">{open ? "▾" : "▸"} {g.lines!.length} lines</span> : <span className="text-dim/50">—</span>}
        </td>
      </tr>
      {open && priced ? (
        <tr className="bg-surface/40">
          <td colSpan={7} className="px-3 py-2">
            <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-dim">
              Kalshi K-prop ladder · he threw {g.K} → green = YES hit
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.lines!.map((ln) => (
                <div
                  key={ln.line}
                  title={`${ln.line}+ Ks · opening implied ${(ln.implied * 100).toFixed(0)}% · ask ${ln.yes_ask}c · spread ${ln.spread}c`}
                  className="rounded border px-1.5 py-0.5 font-mono text-[10px]"
                  style={{
                    borderColor: ln.settled_yes ? PALETTE.yes : PALETTE.no,
                    color: ln.settled_yes ? PALETTE.yes : PALETTE.no,
                  }}
                >
                  {ln.line}+ · {(ln.implied * 100).toFixed(0)}%
                </div>
              ))}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ───────────────────────── pitcher deep-dive ─────────────────────────
function PitcherDetail({ pitcherId, inCase, onBack }: { pitcherId: number; inCase?: boolean; onBack: () => void }) {
  const [d, setD] = useState<MlbPitcherDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [caseMsg, setCaseMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setD(null);
    setErr(null);
    api.getMlbPitcher(pitcherId)
      .then((r) => !cancelled && setD(r))
      .catch((e) => !cancelled && setErr(String(e?.message ?? e)));
    return () => { cancelled = true; };
  }, [pitcherId]);

  const startCase = async (): Promise<void> => {
    if (!d || creating) return;
    setCreating(true);
    const c = await api.createCase({
      title: `${d.pitcher} — pitcher deep-dive`,
      stream: "mlb",
      subject: { kind: "player", label: d.pitcher, params: { pitcher_id: d.pitcher_id, team: d.team } },
    }).catch(() => null);
    setCreating(false);
    setCaseMsg(c ? `case created (${c.case_id}) — open it from the rail` : "case creation failed");
  };

  if (err) return <div className="p-4 text-sm text-dn">Could not load pitcher: {err}</div>;
  if (!d) return <div className="p-4 text-sm text-dim">loading…</div>;

  const s = d.summary;
  const ls = d.lines_summary;
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      {/* header */}
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} className="flex h-7 items-center rounded-md px-2.5 font-mono text-[11px] text-dim transition-colors hover:bg-surface hover:text-text">
          ← pitchers
        </button>
        <div className="min-w-0">
          <div className="truncate font-mono text-lg text-text">{d.pitcher}</div>
          <div className="font-mono text-[11px] text-dim">
            {d.team} · {d.hand || "?"}HP · {d.seasons.join(", ")}
          </div>
        </div>
        {!inCase ? (
          <button
            type="button"
            onClick={() => void startCase()}
            disabled={creating}
            className="ml-auto flex h-7 items-center rounded-md px-2.5 font-mono text-[11px] text-dim transition-colors hover:bg-surface hover:text-accent disabled:opacity-40"
          >
            + start a case
          </button>
        ) : null}
      </div>
      {caseMsg ? <div className="font-mono text-[11px] text-accent">{caseMsg}</div> : null}

      {/* summary stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="starts" value={String(s.starts)} sub={`${s.home.starts}H / ${s.away.starts}A`} />
        <Stat label="avg K / start" value={num(s.avg_K)} sub={`best ${s.best_K}`} />
        <Stat label="K-rate (K/BF)" value={`${(s.krate * 100).toFixed(0)}%`} sub={`${s.K_total} total K`} />
        <Stat label="avg IP" value={num(s.avg_ip)} sub={`${num(s.avg_pitches, 0)} pitches`} />
      </div>

      {/* K over time */}
      <div className="rounded-lg border border-line p-3">
        <div className="mb-1 flex items-center justify-between">
          <div className="font-mono text-[10px] uppercase tracking-wider text-dim">strikeouts per start</div>
          <div className="flex items-center gap-3 font-mono text-[9px] text-dim">
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: PALETTE.home }} /> K</span>
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-3" style={{ background: PALETTE.roll }} /> 5-start form</span>
          </div>
        </div>
        <KChart series={d.k_series} />
        <div className="text-right font-mono text-[9px] text-dim">
          home avg {num(s.home.avg_K)} · away avg {num(s.away.avg_K)}
        </div>
      </div>

      {/* the lines — how the market's K-props settled */}
      <div className="rounded-lg border border-line p-3">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-dim">the lines (Kalshi K-props)</div>
        {ls.games_priced > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-text">
            <span><span className="text-dim">priced starts</span> {ls.games_priced}</span>
            <span><span className="text-dim">thresholds</span> {ls.thresholds_priced}</span>
            <span><span className="text-dim">YES hit rate</span> {ls.yes_hit_rate != null ? `${(ls.yes_hit_rate * 100).toFixed(0)}%` : "—"}</span>
            <span className="font-mono text-[10px] text-dim">expand a priced start in the game log to see its ladder →</span>
          </div>
        ) : (
          <div className="text-xs text-dim">Never priced on Kalshi. {ls.note}</div>
        )}
      </div>

      {/* game log */}
      <div className="rounded-lg border border-line p-3">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-dim">game log · {d.game_log.length} starts</div>
        <table className="w-full">
          <thead>
            <tr className="font-mono text-[9px] uppercase tracking-wider text-dim">
              <th className="pb-1 pr-2 text-left font-normal">date</th>
              <th className="pb-1 pr-2 text-left font-normal">opp</th>
              <th className="pb-1 pr-2 text-right font-normal">K</th>
              <th className="pb-1 pr-2 text-right font-normal">IP</th>
              <th className="pb-1 pr-2 text-right font-normal">BF</th>
              <th className="pb-1 pr-2 text-right font-normal">rate</th>
              <th className="pb-1 text-right font-normal">lines</th>
            </tr>
          </thead>
          <tbody>
            {[...d.game_log].reverse().map((g) => <GameRow key={g.date + g.opp} g={g} />)}
          </tbody>
        </table>
      </div>

      {/* matchups — opponent splits */}
      <div className="rounded-lg border border-line p-3">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-dim">matchups · avg K by opponent</div>
        <div className="flex flex-wrap gap-1.5">
          {d.opponent_splits.map((o) => (
            <div key={o.opp} title={`${o.starts} start(s) · ${o.K_total} total K`} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-text">
              <span className="text-dim">{o.opp}</span> {num(o.avg_K)}{o.starts > 1 ? <span className="text-dim/70"> ·{o.starts}</span> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── browse (filters + sortable table) ─────────────────────────
const SORTS: { key: string; label: string }[] = [
  { key: "K_total", label: "total K" },
  { key: "avg_K", label: "avg K" },
  { key: "krate", label: "K-rate" },
  { key: "starts", label: "starts" },
  { key: "best_K", label: "best" },
];

/** `inCase`: rendered inside a case's Study view — hide "+ start a case"
 *  (spawning a second case from inside one is the wrong door). */
export default function PitcherExplore({ inCase = false }: { inCase?: boolean }) {
  const [facets, setFacets] = useState<{ seasons: number[]; teams: string[] } | null>(null);
  const [season, setSeason] = useState<number | undefined>(undefined);
  const [team, setTeam] = useState<string>("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("K_total");
  const [rows, setRows] = useState<MlbPitcherRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    api.mlbPitcherFacets()
      .then((f) => { setFacets(f); setSeason(f.seasons[f.seasons.length - 1]); })
      .catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr(null);
    const h = setTimeout(() => {
      api.listMlbPitchers({ season, team: team || undefined, q: q || undefined, sort, limit: 300 })
        .then((r) => !cancelled && setRows(r))
        .catch((e) => !cancelled && setErr(String(e?.message ?? e)));
    }, q ? 220 : 0); // debounce the search box
    return () => { cancelled = true; clearTimeout(h); };
  }, [season, team, q, sort]);

  const total = useMemo(() => rows?.length ?? 0, [rows]);

  if (openId != null) return <PitcherDetail pitcherId={openId} inCase={inCase} onBack={() => setOpenId(null)} />;

  return (
    <div className="min-h-0 flex-1 space-y-3">
      {/* filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search pitcher…"
          className="w-44 rounded-md bg-surface px-2 py-1 text-xs text-text placeholder:text-dim focus:outline-none"
        />
        <select value={season ?? ""} onChange={(e) => setSeason(Number(e.target.value))}
          className="h-7 rounded-md bg-surface px-2 font-mono text-[11px] text-dim hover:text-text focus:outline-none">
          {(facets?.seasons ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={team} onChange={(e) => setTeam(e.target.value)}
          className="h-7 rounded-md bg-surface px-2 font-mono text-[11px] text-dim hover:text-text focus:outline-none">
          <option value="">all teams</option>
          {(facets?.teams ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="inline-flex h-7 items-center rounded-md bg-surface p-0.5 font-mono text-[11px]">
          {SORTS.map((so) => (
            <button key={so.key} type="button" onClick={() => setSort(so.key)}
              className={`flex h-6 items-center rounded px-2 transition-colors ${sort === so.key ? "bg-surface2 text-text" : "text-dim hover:text-text"}`}>
              {so.label}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[11px] text-dim">{total} pitcher{total === 1 ? "" : "s"}</span>
      </div>

      {err ? <div className="rounded-md border border-dashed border-line p-3 text-sm text-dn">{err}</div> : null}

      {/* table */}
      {rows == null && !err ? (
        <div className="p-4 text-sm text-dim">loading…</div>
      ) : rows && rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[560px]">
            <thead>
              <tr className="border-b border-line font-mono text-[9px] uppercase tracking-wider text-dim">
                <th className="px-3 py-2 text-left font-normal">pitcher</th>
                <th className="px-2 py-2 text-left font-normal">team</th>
                <th className="px-2 py-2 text-right font-normal">starts</th>
                <th className="px-2 py-2 text-right font-normal">K</th>
                <th className="px-2 py-2 text-right font-normal">avg</th>
                <th className="px-2 py-2 text-right font-normal">rate</th>
                <th className="px-2 py-2 text-right font-normal">best</th>
                <th className="px-3 py-2 text-right font-normal">lines</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.pitcher_id}
                  onClick={() => setOpenId(r.pitcher_id)}
                  className="cursor-pointer border-b border-line/40 last:border-0 hover:bg-surface2/40">
                  <td className="px-3 py-1.5 text-xs text-text">{r.pitcher}</td>
                  <td className="px-2 py-1.5 font-mono text-[11px] text-dim">{r.team}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-[11px] text-dim">{r.starts}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-xs text-text">{r.K_total}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-[11px] text-dim">{num(r.avg_K)}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-[11px] text-dim">{(r.krate * 100).toFixed(0)}%</td>
                  <td className="px-2 py-1.5 text-right font-mono text-[11px] text-dim">{r.best_K}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[10px]">
                    {r.has_lines ? <span style={{ color: PALETTE.yes }}>●</span> : <span className="text-dim/40">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : rows ? (
        <div className="rounded-md border border-dashed border-line p-4 text-sm text-dim">
          No pitchers match. {season && facets && !facets.seasons.includes(season) ? "No data for that season yet." : ""}
        </div>
      ) : null}

      <div className="font-mono text-[10px] leading-relaxed text-dim">
        Performance = MLB StatsAPI (every starter, 2026 so far). <span style={{ color: PALETTE.yes }}>●</span> = the
        pitcher had Kalshi K-prop lines (~218 pitchers, Apr–Jul 2026). Click a pitcher for the deep-dive.
      </div>
    </div>
  );
}
