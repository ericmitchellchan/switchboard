/**
 * Trading — the owner's REAL trading record as a live surface (LODE-26, grounded by the
 * LODE-60 audit): relive days and trades, slice by the look-ahead-free entry context, and
 * work it side-by-side with the ambient agent (^I — it has get_trading_audit / query_trades /
 * sim_exit_policy over the same store).
 *
 * Three faces: AUDIT (situation tables — what worked/didn't, by what led into the trade),
 * TRADES (filterable table → click → the trade relived on the chart), EXITS (the tweakable
 * exit-policy sandbox).
 */

import { useEffect, useMemo, useState } from "react";
import { api, type ContextTables, type TradeRow } from "../api/client";
import ExitSandbox from "../components/trading/ExitSandbox";
import TradeDetail from "../components/trading/TradeDetail";
import { ptTime } from "../lib/time";
import { useSurfaceNav, useSurfaceParams } from "../../../surfaces/page-api";

const UP = "#4ea96a";
const DN = "#e0645b";

const DIM_LABEL: Record<string, string> = {
  edge_book: "Edge book vs the cloud",
  archetype: "Entry archetype (the report card)",
  temp_bucket: "Tape temperature at entry",
  setup: "Setup (symbol × direction × trend)",
  trend_align: "Trend alignment at entry",
  tod: "Time of day (PT)",
  seq_bucket: "Trade # of day",
  after: "After previous trade",
  sess_pos: "Position in trailing 4h range",
  vol_regime: "Volatility regime",
  day_state: "Day P&L before entry",
};

const FILTER_DIMS: { key: keyof TradeRow; label: string; opts: string[] }[] = [
  { key: "symbol", label: "symbol", opts: ["NQ", "MNQ"] },
  { key: "direction", label: "dir", opts: ["long", "short"] },
  { key: "edge_book", label: "book", opts: ["edge", "cloud"] },
  { key: "archetype", label: "archetype", opts: ["quiet counter", "knife catch", "fade pop", "join pop", "reversal ride", "dip buy", "chase", "quiet with", "quiet drift"] },
  { key: "temp_bucket", label: "temp", opts: ["cold", "warm", "hot"] },
  { key: "trend_align", label: "trend", opts: ["with", "against", "flat"] },
  { key: "tod", label: "tod", opts: ["pre", "open", "morning", "noon", "afternoon", "late"] },
  { key: "seq_bucket", label: "seq", opts: ["1", "2-3", "4-6", "7+"] },
  { key: "after", label: "after", opts: ["first", "win", "loss"] },
  { key: "vol_regime", label: "vol", opts: ["low", "normal", "high"] },
  { key: "sess_pos", label: "range", opts: ["near_low", "mid", "near_high"] },
];

function money(v: number): string {
  return `${v < 0 ? "−" : "+"}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function Tile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    // SWITCHBOARD: `data-anchor` marks make the tile pinnable (surfaces/anchors.ts).
    <div className="rounded-lg border border-line bg-surface/40 px-4 py-2.5" data-anchor={`tile:${label}`} data-anchor-label={`tile · ${label}`}>
      <div className="font-mono text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className="mt-0.5 font-mono text-xl" style={{ color: color ?? "var(--tw-text)" }}>{value}</div>
    </div>
  );
}

export default function Trading() {
  const [tab, setTab] = useState<"audit" | "trades" | "exits">("audit");
  const nav = useSurfaceNav();
  const [rows, setRows] = useState<TradeRow[]>([]);
  const [tables, setTables] = useState<ContextTables | null>(null);
  const [noData, setNoData] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "waiting">("loading");
  const [dim, setDim] = useState("setup");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sortDesc, setSortDesc] = useState(true);
  const [sortKey, setSortKey] = useState<"start" | "pnl_usd" | "hold_min">("start");
  const [detailIdx, setDetailIdx] = useState<number | null>(null);

  // SWITCHBOARD (T9 — SWIT-63): a deep link's params. `instrument` and `date`
  // are TradeRow columns, so they become filters (the generic filter path
  // compares `String(row[key]) === value`) and the TRADES face opens on them
  // — `surface:lodestar/trading?instrument=NQ&date=2026-06-05` lands on that
  // day's NQ trades. Re-applied whenever the params change (the host keeps the
  // page mounted across a route params change). `caseId` has no meaning on
  // this page and is ignored; the chart page reads it.
  const params = useSurfaceParams();
  const paramInstrument = params.instrument;
  const paramDate = params.date;
  useEffect(() => {
    if (!paramInstrument && !paramDate) return;
    const next: Record<string, string> = {};
    if (paramInstrument) next.symbol = paramInstrument;
    if (paramDate) next.date = paramDate;
    setFilters(next);
    setTab("trades");
  }, [paramInstrument, paramDate]);

  // Load with retry: a failed request is NOT "no trades" — the backend may still be
  // booting when the window opens. Keep trying; only has_data=false means empty.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryLoad = (): void => {
      api.getTradeContextEpisodes()
        .then((r) => {
          if (cancelled) return;
          setRows(r.episodes);
          setNoData(!r.has_data);
          setLoadState("ready");
          api.getTradeContextTables().then((t) => !cancelled && setTables(t)).catch(() => {});
        })
        .catch(() => {
          if (cancelled) return;
          setLoadState("waiting");
          timer = setTimeout(tryLoad, 3000);
        });
    };
    tryLoad();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const filtered = useMemo(() => {
    let out = rows;
    for (const [k, v] of Object.entries(filters)) out = out.filter((r) => String(r[k as keyof TradeRow]) === v);
    return [...out].sort((a, b) => {
      const va = a[sortKey] as number | string;
      const vb = b[sortKey] as number | string;
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDesc ? -c : c;
    });
  }, [rows, filters, sortKey, sortDesc]);

  const stats = useMemo(() => {
    const s = filtered.map((r) => r.pnl_usd);
    const net = s.reduce((a, b) => a + b, 0);
    const wins = s.filter((v) => v > 0);
    const losses = s.filter((v) => v <= 0);
    // concentration: net without the 5 best DAYS — the honest "typical run" number
    const byDay = new Map<string, number>();
    for (const r of filtered) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.pnl_usd);
    const dayNets = [...byDay.values()].sort((a, b) => b - a);
    const exTop5 = net - dayNets.slice(0, 5).reduce((a, b) => a + b, 0);
    return {
      n: s.length,
      net,
      exTop5,
      win: s.length ? wins.length / s.length : 0,
      avg: s.length ? net / s.length : 0,
      payoff: wins.length && losses.length
        ? (wins.reduce((a, b) => a + b, 0) / wins.length) / Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length)
        : null,
    };
  }, [filtered]);

  // audit row → that scenario's trades (dim keys are TradeRow columns 1:1)
  const openScenario = (bucket: string): void => {
    setFilters({ [dim]: bucket });
    setTab("trades");
  };

  // the drill-in indexes into `filtered` — close it when the list re-shapes so it can't
  // silently re-point at a different trade (review 2026-07-11 nit)
  useEffect(() => {
    setDetailIdx(null);
  }, [filters, sortKey, sortDesc]);

  if (loadState !== "ready") {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-xl text-text">Trading</h1>
        <p className="mt-3 font-mono text-[12px] text-dim">
          {loadState === "waiting"
            ? "waiting for the backend… (retrying — it may still be starting)"
            : "loading trading data…"}
        </p>
      </div>
    );
  }
  if (noData) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <h1 className="text-xl text-text">Trading</h1>
        <p className="mt-3 font-mono text-[12px] text-dim">
          no trades imported yet — run<br />
          <code className="text-accent">python -m lodestar_backend.scripts.analyze_ninjatrader *.csv</code><br />
          or ask the agent (^I) to import the latest NinjaTrader exports.
        </p>
      </div>
    );
  }

  const TabBtn = ({ id, label }: { id: typeof tab; label: string }) => (
    <button type="button" onClick={() => setTab(id)} className={`px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wide transition-colors ${tab === id ? "bg-surface2 text-text" : "text-dim hover:text-text"}`}>
      {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-lg text-text">Trading</h1>
        <div className="inline-flex overflow-hidden rounded-md border border-line">
          <TabBtn id="audit" label="audit" />
          <TabBtn id="trades" label="trades" />
          <TabBtn id="exits" label="exits" />
        </div>
        {/* SWITCHBOARD: the HUD is the `hud` page in its own always-on-top
            window (page-api openWindow, Inc 5d) — it stays over NinjaTrader. */}
        <button
          type="button"
          onClick={() => nav.openWindow("hud")}
          title="open the always-on-top guardrail HUD (runs over NinjaTrader while you trade)"
          className="rounded-md border border-line px-2.5 py-0.5 font-mono text-[11px] text-dim hover:text-accent"
        >
          ⧉ HUD
        </button>
        <span className="ml-auto font-mono text-[10px] text-dim2">the thread beside this view can slice, query and sim this data with you</span>
      </div>

      {/* headline tiles always reflect the ACTIVE filter set */}
      <div className="mb-1 grid grid-cols-2 gap-3 sm:grid-cols-6">
        <Tile label="trades" value={String(stats.n)} />
        <Tile label="net (gross, reconstr.)" value={money(stats.net)} color={stats.net >= 0 ? UP : DN} />
        <Tile label="excl. best 5 days" value={money(stats.exTop5)} color={stats.exTop5 >= 0 ? UP : DN} />
        <Tile label="win rate" value={`${Math.round(stats.win * 100)}%`} />
        <Tile label="avg / trade" value={money(stats.avg)} color={stats.avg >= 0 ? UP : DN} />
        <Tile label="payoff" value={stats.payoff != null ? stats.payoff.toFixed(2) : "—"} />
      </div>
      <p className="mb-4 font-mono text-[10px] leading-relaxed text-dim2">
        net = the reconstructed guide-account stream, GROSS — before commissions, eval fees/resets and payout splits, mixing account sizes.
        it is a <span className="text-dim">behavior</span> metric, not take-home; the "excl. best 5 days" tile shows how concentrated it is.
      </p>

      {tab === "exits" ? (
        <div className="min-h-0 flex-1 overflow-y-auto"><ExitSandbox /></div>
      ) : tab === "audit" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mb-2 flex flex-wrap gap-1">
            {Object.keys(DIM_LABEL).map((d) => (
              <button key={d} type="button" onClick={() => setDim(d)} className={`rounded px-2 py-0.5 font-mono text-[10px] ${dim === d ? "bg-surface2 text-text" : "text-dim hover:text-text"}`}>
                {DIM_LABEL[d]}
              </button>
            ))}
          </div>
          {tables?.[dim] ? (
            <table className="w-full max-w-3xl text-left font-mono text-[12px]">
              <thead>
                <tr className="border-b border-line text-[10px] uppercase tracking-wider text-dim">
                  <th className="py-1.5 pr-3">situation</th><th className="pr-3 text-right">n</th>
                  <th className="pr-3 text-right">net</th><th className="pr-3 text-right">win</th>
                  <th className="pr-3 text-right">avg</th><th className="text-right">worst</th>
                </tr>
              </thead>
              <tbody>
                {tables[dim].map((b) => (
                  <tr key={b.bucket} onClick={() => openScenario(b.bucket)} title="see this scenario's trades" className="cursor-pointer border-b border-line/40 hover:bg-surface2/30" data-anchor={`row:${dim}:${b.bucket}`} data-anchor-label={`${DIM_LABEL[dim] ?? dim} · ${b.bucket}`}>
                    <td className="py-1.5 pr-3 text-text">{b.bucket} <span className="text-dim2">→</span></td>
                    <td className="pr-3 text-right text-dim">{b.n}</td>
                    <td className="pr-3 text-right" style={{ color: b.net_usd >= 0 ? UP : DN }}>{money(b.net_usd)}</td>
                    <td className="pr-3 text-right text-dim">{Math.round(b.win_rate * 100)}%</td>
                    <td className="pr-3 text-right" style={{ color: b.avg_usd >= 0 ? UP : DN }}>{money(b.avg_usd)}</td>
                    <td className="text-right text-dim">{money(b.worst_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="font-mono text-[11px] text-dim">situation tables unavailable (bars not reachable?)</div>
          )}
          <p className="mt-4 max-w-3xl font-mono text-[10px] leading-relaxed text-dim2">
            every situation is computed from bars that closed BEFORE the entry and trades that finished before it started — no forward-looking bias.
            dollar totals mix eval-account sizes; lean on rates, ratios and ranking. the written verdict lives in the Knowledge Base (Reports).
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {Object.keys(filters).length > 0 ? (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wider text-dim">scenario</span>
              {Object.entries(filters).map(([k, v]) => (
                <span key={k} className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent">
                  {k}={v}
                  <button
                    type="button"
                    onClick={() => setFilters((cur) => { const n = { ...cur }; delete n[k]; return n; })}
                    className="hover:text-text"
                    aria-label={`remove ${k} filter`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {FILTER_DIMS.map((f) => (
              <select
                key={String(f.key)}
                value={filters[String(f.key)] ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setFilters((cur) => {
                    const n = { ...cur };
                    if (v) n[String(f.key)] = v; else delete n[String(f.key)];
                    return n;
                  });
                }}
                className="rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[10px] text-dim focus:border-accent focus:outline-none"
              >
                <option value="">{f.label}: all</option>
                {f.opts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ))}
            {Object.keys(filters).length > 0 ? (
              <button type="button" onClick={() => setFilters({})} className="font-mono text-[10px] text-dim hover:text-accent">clear</button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto rounded border border-line">
            <table className="w-full text-left font-mono text-[11px]">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-[10px] uppercase tracking-wider text-dim">
                  {([["start", "when"], ["pnl_usd", "p&l"], ["hold_min", "held"]] as const).map(([k, lab]) => (
                    <th key={k} className="cursor-pointer py-1.5 pl-3 pr-3 hover:text-text" onClick={() => { if (sortKey === k) setSortDesc(!sortDesc); else { setSortKey(k); setSortDesc(true); } }}>
                      {lab}{sortKey === k ? (sortDesc ? " ↓" : " ↑") : ""}
                    </th>
                  ))}
                  <th className="pr-3">trade</th><th className="pr-3">archetype</th><th className="pr-3">temp</th>
                  <th className="pr-3">tod</th><th className="pr-3">seq</th><th className="pr-3">after</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={r.trade_id} onClick={() => setDetailIdx(i)} className="cursor-pointer border-t border-line/40 hover:bg-surface2/40" data-anchor={`trade:${r.trade_id}`} data-anchor-label={`${r.date} ${ptTime(r.start_utc)} · ${r.symbol} ${r.direction}`}>
                    <td className="py-1 pl-3 pr-3 text-dim">{r.date} · {ptTime(r.start_utc)} PT</td>
                    <td className="pr-3" style={{ color: r.pnl_usd >= 0 ? UP : DN }}>{money(r.pnl_usd)}</td>
                    <td className="pr-3 text-dim">{Math.round(r.hold_min)}m</td>
                    <td className="pr-3 text-text">{r.peak_contracts}× {r.symbol} {r.direction}</td>
                    <td className="pr-3 text-dim">{r.archetype ?? "—"}</td>
                    <td className="pr-3 text-dim">{r.temp_bucket ?? "—"}</td>
                    <td className="pr-3 text-dim">{r.tod}</td>
                    <td className="pr-3 text-dim">#{r.trade_no}</td>
                    <td className="pr-3 text-dim">{r.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length === 0 ? <div className="p-6 text-center font-mono text-[11px] text-dim">no trades match these filters</div> : null}
          </div>
          <div className="mt-1 font-mono text-[9px] text-dim2">click a trade to relive it on the chart · filters drive the tiles above</div>
        </div>
      )}

      {detailIdx != null && filtered[detailIdx] ? (
        <TradeDetail trades={filtered} index={detailIdx} setIndex={setDetailIdx} onClose={() => setDetailIdx(null)} />
      ) : null}
    </div>
  );
}
