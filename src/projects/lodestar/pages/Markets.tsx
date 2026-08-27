/**
 * Markets — browse REAL historical Kalshi markets (Shot Clock's TimescaleDB).
 * Selecting a market renders its price-over-time chart with volume + a scrubber
 * (price, bid/ask, volume, trades, OI at each moment).
 */

import { useEffect, useMemo, useState } from "react";
import Panel from "../components/Panel";
import MarketDetailChart from "../components/MarketDetailChart";
import NbaGameContextPanel from "../components/NbaGameContext";
import TennisMatchContextPanel from "../components/TennisMatchContext";
import ProfileDrawer from "../components/research/ProfileDrawer";
import FlowDeepDive from "../components/research/FlowDeepDive";
import TriageTable from "../components/research/TriageTable";
import ResearchStatusChip from "../components/research/ResearchStatusChip";
import MarketCard from "../components/research/MarketCard";
import SessionContextPanel from "../components/SessionContext";
// SWITCHBOARD: the shared lightweight-charts candle component replaces the
// SVG one (same props); it also publishes candle anchors for pins.
import CandleChart, { type PriceLevel } from "../../../surfaces/charts/CandleChart";
import Spinner from "../components/Spinner";
import { usePoll } from "../hooks/usePoll";
import { useUiStore } from "../stores/uiStore";
import {
  api,
  type Bar,
  type EdgeBoard,
  type HistoricalDetail,
  type HistoricalMarket,
  type MarketHistorySummary,
  type MarketSessionContext,
  type NbaGameContext,
  type RelatedMarkets,
  type SessionSummary,
  type AnomalyMatch,
  type AnomalyMoment,
  type Case,
  type TennisMatchContext,
} from "../api/client";

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Two-level filter (LODE-54): sport tabs on top, per-sport kind chips below.
// More sports/leagues (MLB, CBB) and deeper tennis levels slot in here later.
const SPORTS: { id: string; label: string; prefixes: string[] }[] = [
  { id: "all", label: "All", prefixes: [] },
  { id: "nba", label: "NBA", prefixes: ["KXNBA"] },
  { id: "tennis", label: "Tennis", prefixes: ["KXATP", "KXWTA"] },
  // Financial = Orbit-side trading sessions (LODE-58), not Kalshi markets — the
  // list pane swaps to sessions and the detail pane to the intraday chart.
  { id: "fin", label: "Financial", prefixes: [] },
];

const FIN_SYMBOLS = ["ES", "NQ"] as const;

// Short labels for the related-markets chips (LODE Phase 1).
const KIND_SHORT: Record<string, string> = {
  KXNBAGAME: "ML",
  KXNBASPREAD: "Spread",
  KXNBATOTAL: "Total",
};

// Chart overlay tones per gamma level (matches the Trade page).
const LEVEL_TONE: Record<string, string> = {
  zero_gamma: "accent",
  call_wall: "up",
  put_wall: "dn",
  vol_trigger: "liq",
};

const KINDS_BY_SPORT: Record<string, { k: string; label: string; prefixes: string[] }[]> = {
  all: [],
  nba: [
    { k: "all", label: "All", prefixes: [] },
    { k: "game", label: "ML", prefixes: ["KXNBAGAME"] },
    { k: "spread", label: "Spread", prefixes: ["KXNBASPREAD"] },
    { k: "total", label: "Total", prefixes: ["KXNBATOTAL"] },
  ],
  tennis: [
    { k: "all", label: "All", prefixes: [] },
    { k: "atp", label: "ATP", prefixes: ["KXATPMATCH"] },
    { k: "wta", label: "WTA", prefixes: ["KXWTAMATCH"] },
    { k: "chal", label: "Challenger", prefixes: ["KXATPCHALLENGERMATCH", "KXWTACHALLENGERMATCH"] },
  ],
  fin: [], // the Financial tab filters by symbol (FIN_SYMBOLS), not ticker prefixes
};

function SessionRow({
  s,
  selected,
  onSelect,
}: {
  s: SessionSummary;
  selected: SessionSummary | null;
  onSelect: (s: SessionSummary) => void;
}) {
  const chg = s.change_pct == null ? null : s.change_pct * 100;
  const day = new Date(`${s.date}T00:00:00`).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const active = selected?.date === s.date && selected?.symbol === s.symbol;
  return (
    <button
      type="button"
      onClick={() => onSelect(s)}
      className={`block w-full rounded-md px-2 py-1.5 text-left transition-colors ${
        active ? "bg-surface2 text-text" : "text-dim hover:text-text"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm">{day}</span>
        {chg != null && (
          <span className={`shrink-0 font-mono text-[11px] ${chg >= 0 ? "text-up" : "text-dn"}`}>
            {chg > 0 ? "+" : ""}
            {chg.toFixed(2)}%
          </span>
        )}
      </div>
      <div className="truncate font-mono text-[11px] text-dim">
        {s.date}
        {s.range_pct != null && ` · rng ${(s.range_pct * 100).toFixed(1)}%`}
        {s.has_options && " · γ"}
        {s.has_flow && " · flow"}
      </div>
    </button>
  );
}

export default function Markets() {
  const [search, setSearch] = useState("");
  const [sport, setSport] = useState("all");
  // Poll (not one-shot) so the list self-heals after the backend finishes
  // booting. Scoped to the sport tab SERVER-SIDE: the recency cap applies
  // within the sport, so quiet families (tennis) can't be flooded out by loud
  // ones (NBA props) — owner-reported 2026-07-02.
  const sportPrefixes = SPORTS.find((s) => s.id === sport)?.prefixes ?? [];
  const { data: markets, error } = usePoll(
    () => api.getHistoricalMarkets(sportPrefixes.length ? sportPrefixes : undefined),
    10000,
    sport,
  );
  const [kind, setKind] = useState("all");
  const [selected, setSelected] = useState<HistoricalMarket | null>(null);
  const [detail, setDetail] = useState<HistoricalDetail | null>(null);
  const [ctx, setCtx] = useState<NbaGameContext | null>(null);
  const [tennisCtx, setTennisCtx] = useState<TennisMatchContext | null>(null);
  // research surfaces (research-streams T9)
  const [anomalies, setAnomalies] = useState<AnomalyMatch[] | null>(null);
  const [profilePlayer, setProfilePlayer] =
    useState<{ name: string; key: string | null } | null>(null);
  // Flow deep-dive (owner ask 2026-07-02): scored trades for the SELECTED match.
  const [flowMoments, setFlowMoments] = useState<AnomalyMoment[] | null>(null);
  const [flowTotalMoments, setFlowTotalMoments] = useState<number | null>(null);
  const [triageOpen, setTriageOpen] = useState(false);
  // Grid view (Markets redesign, mockup Direction A): browse-first card grid.
  const [cardSort, setCardSort] = useState<"recent" | "ticks" | "movers">("recent");

  const [caseStartMsg, setCaseStartMsg] = useState<string | null>(null);
  const [caseStarting, setCaseStarting] = useState(false);
  const startCaseFromSelected = async (): Promise<void> => {
    if (!selected || caseStarting) return; // double-click guard (review F10)
    setCaseStarting(true);
    const stream = /^KX(ATP|WTA)/.test(selected.ticker)
      ? ("tennis" as const)
      : selected.ticker.startsWith("KXMLB")
        ? ("mlb" as const)
        : ("generic" as const);
    const c = await api
      .createCase({
        title: `${selected.label} — investigation`,
        stream,
        subject: { kind: "market", ticker: selected.ticker, label: selected.label },
      })
      .catch(() => null);
    setCaseStarting(false);
    setCaseStartMsg(c ? `case created (${c.case_id}) — open the Playground` : "case creation failed");
  };

  // Chart annotations land as CASE NOTES (the agent reads cases; the journal
  // isn't on its read surface). Reuses the match's case or creates one.
  const annotateMoment = async (text: string, m: AnomalyMoment): Promise<void> => {
    const matchId = m.match_id;
    const label = selected?.label ?? matchId;
    // NOT .catch(()=>[]) — a transient listCases failure must fail the save,
    // not silently mint a duplicate case (review finding).
    const existing: Case | undefined = (await api.listCases({ stream: "tennis" }))
      .find((c) => c.subject.ticker === matchId);
    const target =
      existing ??
      (await api.createCase({
        title: `${label} — flow annotations`,
        stream: "tennis",
        subject: { kind: "market", ticker: matchId, label },
      }));
    const stamp = `[chart ${m.ts} · ${m.count ?? "?"} lots @ ${m.price}¢ · backs p${m.backs_player} · score ${m.score}]`;
    await api.addCaseNote(target.case_id, `${stamp} ${text}`);
  };
  const [loading, setLoading] = useState(false);
  // Polled (not one-shot): a fetch that races the backend boot must self-heal,
  // not leave the census tiles at em-dashes forever (owner-reported).
  const { data: overview } = usePoll(() => api.getMarketOverview(), 30000);
  const [movers, setMovers] = useState<MarketHistorySummary[] | null>(null);
  const [highlightTs, setHighlightTs] = useState<string | null>(null);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [ctxLoading, setCtxLoading] = useState(false);
  // Cross-market (LODE Phase 1): an NBA market's siblings + the edge leaderboard.
  const [related, setRelated] = useState<RelatedMarkets | null>(null);
  const [edges, setEdges] = useState<EdgeBoard | null>(null);
  const setActiveTicker = useUiStore((s) => s.setActiveTicker);
  const pendingMarket = useUiStore((s) => s.pendingMarket);
  const setPendingMarket = useUiStore((s) => s.setPendingMarket);

  // "View on chart" handoff from a case (owner ask 2026-07-03): land on the
  // right sport tab with the market selected — the deep-dive overlay then
  // loads via the normal detail path when the match is on the anomaly board.
  useEffect(() => {
    if (!pendingMarket) return;
    const tkr = pendingMarket.ticker;
    setSport(/^KX(ATP|WTA)/.test(tkr) ? "tennis" : tkr.startsWith("KXNBA") ? "nba" : "all");
    if (tkr.split("-").length === 2 && /^KX(ATP|WTA)/.test(tkr)) {
      // a MATCH id (no side suffix) — resolve the tradeable market via the
      // anomaly endpoint (its top-scored moment names the real ticker)
      api
        .getMatchAnomaly(tkr)
        .then((r) => selectTicker(r.match?.ticker ?? `${tkr}`, pendingMarket.label))
        .catch(() => selectTicker(tkr, pendingMarket.label));
    } else {
      selectTicker(tkr, pendingMarket.label);
    }
    setPendingMarket(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMarket]);

  const isNba = selected?.ticker.startsWith("KXNBA") ?? false;
  const isTennis = /^KX(ATP|WTA)/.test(selected?.ticker ?? "");
  const isFin = sport === "fin";

  // Financial sessions (LODE-58) — a separate lane from the Kalshi list.
  const [finSymbol, setFinSymbol] = useState<(typeof FIN_SYMBOLS)[number]>("ES");
  const [finSessions, setFinSessions] = useState<SessionSummary[] | null>(null);
  const [finTop, setFinTop] = useState<SessionSummary[] | null>(null);
  const [finSelected, setFinSelected] = useState<SessionSummary | null>(null);
  const [finBars, setFinBars] = useState<Bar[] | null>(null);
  const [finCtx, setFinCtx] = useState<MarketSessionContext | null>(null);
  const [finLoading, setFinLoading] = useState(false);
  const [finCtxLoading, setFinCtxLoading] = useState(false);

  // Analysis tier (LODE-24): one-shot census.

  // Biggest movers, scoped to the selected sport tab (LODE-54). Tennis spans two
  // prefixes (ATP + WTA), so fetch both and merge by win-prob range.
  useEffect(() => {
    if (sport === "fin") return; // movers are a Kalshi-lane concept
    let cancelled = false;
    setMovers(null);
    const prefixes = SPORTS.find((s) => s.id === sport)?.prefixes ?? [];
    const fetches =
      prefixes.length === 0 ? [api.getMovers(6, "KX")] : prefixes.map((p) => api.getMovers(6, p));
    Promise.all(fetches)
      .then((lists) => {
        if (cancelled) return;
        const merged = lists
          .flat()
          .sort((a, b) => ((b.max_prob ?? 0) - (b.min_prob ?? 0)) - ((a.max_prob ?? 0) - (a.min_prob ?? 0)))
          .slice(0, 6);
        setMovers(merged);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sport]);

  // Edge leaderboard (LODE Phase 1): Kalshi-vs-book edges across NBA moneylines.
  // Often sparse locally (book odds are forward-only) — the panel says why.
  useEffect(() => {
    if (sport !== "nba") {
      setEdges(null);
      return;
    }
    let cancelled = false;
    setEdges(null);
    api.getEdges(8, "KXNBAGAME").then((b) => !cancelled && setEdges(b)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sport]);

  // Scored-trade moments for the selected tennis match (deep-dive overlay).
  useEffect(() => {
    setFlowMoments(null);
    setCaseStartMsg(null); // stale "case created" must not follow a new market
    const tkr = selected?.ticker;
    if (!tkr || !/^KX(ATP|WTA)/.test(tkr)) return;
    const matchId = tkr.split("-").slice(0, 2).join("-");
    let cancelled = false;
    api
      .getMatchAnomaly(matchId)
      .then((r) => {
        if (cancelled) return;
        setFlowMoments(r.moments);
        setFlowTotalMoments(r.match?.n_moments ?? r.moments.length);
      })
      .catch(() => {}); // 404 = match not on the board; overlay simply absent
    return () => {
      cancelled = true;
    };
  }, [selected?.ticker]);

  // Flow-vs-state anomaly board (research-streams T9) — tennis tab only.
  useEffect(() => {
    if (sport !== "tennis") {
      setAnomalies(null);
      return;
    }
    let cancelled = false;
    api.topAnomalies(8).then((a) => !cancelled && setAnomalies(a)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sport]);

  // Select a market by ticker (from the movers list), reusing the loaded row when present.
  function selectTicker(ticker: string, label: string): void {
    const found = markets?.find((m) => m.ticker === ticker);
    setSelected(
      found ?? { ticker, label, title: null, rows: 0, first_ts: "", last_ts: "" },
    );
  }

  // Tell the ambient agent which market is active (drives sport-aware framing).
  useEffect(() => {
    if (isFin) {
      setActiveTicker(finSelected ? `${finSelected.contract} session ${finSelected.date}` : null);
    } else {
      setActiveTicker(selected?.ticker ?? null);
    }
    return () => setActiveTicker(null);
  }, [selected, isFin, finSelected, setActiveTicker]);

  // Financial: sessions list + wildest days for the active symbol (LODE-58).
  useEffect(() => {
    if (!isFin) return;
    let cancelled = false;
    setFinSessions(null);
    setFinTop(null);
    Promise.all([
      api.getMarketSessions(finSymbol, 60, "recent"),
      api.getMarketSessions(finSymbol, 6, "range"),
    ])
      .then(([recent, top]) => {
        if (cancelled) return;
        setFinSessions(recent);
        setFinTop(top);
      })
      .catch(() => !cancelled && setFinSessions([]));
    return () => {
      cancelled = true;
    };
  }, [isFin, finSymbol]);

  // Financial: selecting a session loads its intraday bars + bundled context.
  useEffect(() => {
    if (!finSelected) return;
    let cancelled = false;
    setFinLoading(true);
    setFinCtxLoading(true);
    setFinBars(null);
    setFinCtx(null);
    setHighlightTs(null);
    api
      .getSessionBars(finSelected.symbol, finSelected.date)
      .then((b) => !cancelled && setFinBars(b))
      .catch(() => !cancelled && setFinBars(null))
      .finally(() => !cancelled && setFinLoading(false));
    api
      .getSessionContext(finSelected.symbol, finSelected.date)
      .then((c) => !cancelled && setFinCtx(c))
      .catch(() => !cancelled && setFinCtx(null))
      .finally(() => !cancelled && setFinCtxLoading(false));
    return () => {
      cancelled = true;
    };
  }, [finSelected]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setCtx(null);
    setTennisCtx(null);
    setRelated(null);
    setHighlightTs(null);
    const ticker = selected.ticker;
    api
      .getHistoricalDetail(ticker)
      .then((d) => !cancelled && setDetail(d))
      .catch(() => !cancelled && setDetail(null))
      .finally(() => !cancelled && setLoading(false));
    // NBA markets get the bundled game context (score, runs, quarters, book lines)
    // and their sibling markets (ML / spread / total) for quick comparison.
    if (ticker.startsWith("KXNBA")) {
      setCtxLoading(true);
      api
        .getNbaContext(ticker)
        .then((g) => !cancelled && setCtx(g))
        .catch(() => !cancelled && setCtx(null))
        .finally(() => !cancelled && setCtxLoading(false));
      api
        .getRelatedMarkets(ticker)
        .then((r) => !cancelled && setRelated(r))
        .catch(() => !cancelled && setRelated(null));
    }
    // Tennis markets get the bundled match context (sets, breaks, stats, H2H).
    if (/^KX(ATP|WTA)/.test(ticker)) {
      setCtxLoading(true);
      api
        .getTennisContext(ticker)
        .then((t) => !cancelled && setTennisCtx(t))
        .catch(() => !cancelled && setTennisCtx(null))
        .finally(() => !cancelled && setCtxLoading(false));
    }
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const filtered = useMemo(() => {
    if (!markets) return [];
    const q = search.trim().toLowerCase();
    const sportPfxs = SPORTS.find((s) => s.id === sport)?.prefixes ?? [];
    const kindPfxs = KINDS_BY_SPORT[sport]?.find((x) => x.k === kind)?.prefixes ?? [];
    return markets.filter((m) => {
      if (sportPfxs.length > 0 && !sportPfxs.some((p) => m.ticker.startsWith(p))) return false;
      if (kindPfxs.length > 0 && !kindPfxs.some((p) => m.ticker.startsWith(p))) return false;
      if (!q) return true;
      return (
        m.label.toLowerCase().includes(q) ||
        m.ticker.toLowerCase().includes(q) ||
        (m.title ?? "").toLowerCase().includes(q)
      );
    });
  }, [markets, search, sport, kind]);


  // Back-to-grid: clear the selection; detail effects key off `selected`.
  const clearSelection = (): void => {
    setSelected(null);
    setDetail(null);
  };

  const pageHeader = (
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-5">
          <h1 className="font-mono text-lg font-medium tracking-tight">Markets</h1>
          {selected && !isFin ? (
            <>
              <button
                type="button"
                onClick={clearSelection}
                className="rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-dim hover:text-text"
              >
                ← grid
              </button>
              {/* entry point Decided #7a: ANY market view can start a case,
                  auto-anchored to what's on screen */}
              <button
                type="button"
                onClick={() => void startCaseFromSelected()}
                disabled={caseStarting}
                className="rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-dim hover:border-accent hover:text-text disabled:opacity-40"
              >
                + case
              </button>
              {caseStartMsg ? (
                <span className="font-mono text-[10px] text-accent">{caseStartMsg}</span>
              ) : null}
            </>
          ) : null}
          {/* page-level sport tabs (LODE-55) */}
          <div className="flex gap-1">
            {SPORTS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setSport(s.id);
                  setKind("all");
                  // Lane-local state: a pin or search from one lane must not
                  // leak onto the other lane's chart/list (pre-PR review).
                  setHighlightTs(null);
                  setSearch("");
                  setProfilePlayer(null); // tennis drawer must not overlay other lanes
                }}
                className={`-mb-px border-b-2 px-2 py-1 font-mono text-xs uppercase tracking-wide transition-colors ${
                  sport === s.id ? "border-accent text-text" : "border-transparent text-dim hover:text-text"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        {overview && (
          <div className="font-mono text-xs text-dim">
            {overview.markets.toLocaleString()} markets
            {Object.entries(overview.by_kind)
              .slice(0, 4)
              .map(([k, n]) => ` · ${k.replace("KX", "")} ${n}`)
              .join("")}
            {overview.first_ts && ` · ${fmtDate(overview.first_ts)}→${fmtDate(overview.last_ts!)}`}
          </div>
        )}
      </div>
  );

  // ───────────────────────── GRID VIEW (browse-first) ─────────────────────────
  if (!isFin && !selected) {
    const kindPrefixes = KINDS_BY_SPORT[sport]?.find((x) => x.k === kind)?.prefixes ?? [];
    const q = search.trim().toLowerCase();
    const moverRank = new Map((movers ?? []).map((m, i) => [m.ticker, i]));
    const cards = (markets ?? [])
      .filter((m) => kindPrefixes.length === 0 || kindPrefixes.some((pfx) => m.ticker.startsWith(pfx)))
      .filter((m) => !q || m.label.toLowerCase().includes(q) || m.ticker.toLowerCase().includes(q))
      .sort((a, b) => {
        if (cardSort === "ticks") return b.rows - a.rows;
        if (cardSort === "movers") {
          const ra = moverRank.get(a.ticker) ?? 999;
          const rb = moverRank.get(b.ticker) ?? 999;
          if (ra !== rb) return ra - rb;
        }
        return a.last_ts < b.last_ts ? 1 : -1; // recent (default + tiebreak)
      });
    const shown = cards.slice(0, 24);
    return (
      <div className="flex h-full flex-col">
        {pageHeader}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {/* census (mockup hero) */}
          <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="rounded-lg border border-line/70 bg-surface p-4">
              <div className="font-mono text-[10px] uppercase text-dim">markets captured</div>
              <div className="font-mono text-xl text-text">{overview ? overview.markets.toLocaleString() : "—"}</div>
              <div className="font-mono text-[10px] text-dim">{markets ? `${markets.length} in this lane` : "loading lane…"}</div>
            </div>
            <div className="rounded-lg border border-line/70 bg-surface p-4">
              <div className="font-mono text-[10px] uppercase text-dim">capture window</div>
              <div className="font-mono text-xl text-text">
                {overview?.first_ts ? `${fmtDate(overview.first_ts).split(",")[0]}` : "—"}
              </div>
              <div className="font-mono text-[10px] text-dim">
                {overview?.first_ts ? `${fmtDate(overview.first_ts)} → ${fmtDate(overview.last_ts!)}` : ""}
              </div>
            </div>
            <div className="rounded-lg border border-line/70 bg-surface p-4">
              <div className="font-mono text-[10px] uppercase text-dim">top families</div>
              <div className="mt-1 space-y-0.5 font-mono text-[11px] text-text">
                {overview
                  ? Object.entries(overview.by_kind).slice(0, 3).map(([k, n]) => (
                      <div key={k} className="flex justify-between">
                        <span className="text-dim">{k.replace("KX", "")}</span>
                        <span>{n.toLocaleString()}</span>
                      </div>
                    ))
                  : "—"}
              </div>
            </div>
            <div className="rounded-lg border border-line/70 bg-surface p-4">
              <div className="font-mono text-[10px] uppercase text-dim">research boards</div>
              <div className="mt-1 space-y-0.5 font-mono text-[11px] text-text">
                <div className="flex justify-between">
                  <span className="text-dim">unusual flow</span>
                  <span>{sport === "tennis" && anomalies ? anomalies.length : "tennis tab"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-dim">book edges</span>
                  <span>{sport === "nba" && edges?.configured ? edges.rows.length : "nba tab"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* boards row — the lane's research surfaces, front and center */}
          {((sport === "tennis" && anomalies && anomalies.length > 0) ||
            (sport === "nba" && edges?.configured && edges.rows.length > 0)) && (
            <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
              {sport === "tennis" && anomalies && anomalies.length > 0 ? (
                <div className="rounded-lg border border-line/70 bg-surface p-4">
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-dim">
                      unusual flow · vs match state
                    </span>
                    <button type="button" onClick={() => setTriageOpen(true)} className="font-mono text-[10px] text-accent hover:underline">
                      triage →
                    </button>
                  </div>
                  {anomalies.slice(0, 6).map((a) => (
                    <button
                      key={a.match_id}
                      type="button"
                      onClick={() => a.ticker && selectTicker(a.ticker, `${a.player1_name ?? "?"} v ${a.player2_name ?? "?"}`)}
                      disabled={!a.ticker}
                      className="flex w-full items-baseline justify-between gap-2 rounded-md px-1 py-0.5 text-left text-dim transition-colors hover:text-text disabled:opacity-50"
                    >
                      <span className="truncate text-sm">{a.player1_name} v {a.player2_name}</span>
                      <span className="shrink-0 font-mono text-[11px] text-accent">×{a.score_ratio.toFixed(2)}</span>
                    </button>
                  ))}
                  <div className="pt-0.5 font-mono text-[9px] text-dim">ranked by calibrated score — unusual ≠ wrongdoing</div>
                </div>
              ) : null}
              {sport === "nba" && edges?.configured && edges.rows.length > 0 ? (
                <div className="rounded-lg border border-line/70 bg-surface p-4">
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-dim">edges · Kalshi vs books</div>
                  {edges.rows.slice(0, 6).map((e) => (
                    <button
                      key={e.ticker}
                      type="button"
                      onClick={() => selectTicker(e.ticker, e.label)}
                      className="flex w-full items-baseline justify-between gap-2 rounded-md px-1 py-0.5 text-left text-dim transition-colors hover:text-text"
                    >
                      <span className="truncate text-sm">{e.label}</span>
                      {e.edge_cents != null && (
                        <span className={`shrink-0 font-mono text-[11px] ${e.edge_cents >= 0 ? "text-up" : "text-dn"}`}>
                          {e.edge_cents > 0 ? "+" : ""}{e.edge_cents}¢
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          {/* controls: kind chips · search · sort */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {(KINDS_BY_SPORT[sport] ?? []).map((x) => (
              <button
                key={x.k}
                type="button"
                onClick={() => setKind(x.k)}
                className={`rounded-full px-2 py-0.5 font-mono text-[11px] transition-colors ${
                  kind === x.k ? "bg-surface2 text-text" : "text-dim hover:text-text"
                }`}
              >
                {x.label}
              </button>
            ))}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search team, player, market, or ticker…"
              className="min-w-[220px] flex-1 rounded-md border border-line bg-bg px-2 py-1 text-xs text-text placeholder:text-dim focus:border-accent focus:outline-none"
            />
            <div className="flex gap-1">
              {([["recent", "Recent"], ["movers", "Movers"], ["ticks", "Liquidity"]] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setCardSort(id)}
                  className={`rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                    cardSort === id ? "border-accent text-accent" : "border-line text-dim hover:text-text"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* card grid */}
          {markets == null && error ? (
            <div className="rounded-lg border border-line p-4 text-sm text-dn">
              backend unreachable — {error}
            </div>
          ) : markets == null ? (
            <div className="p-6"><Spinner label="loading markets…" /></div>
          ) : shown.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line p-4 text-sm text-dim">no matches in this lane</div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 pb-3 xl:grid-cols-3">
                {shown.map((m) => (
                  <MarketCard key={m.ticker} m={m} onOpen={(mm) => setSelected(mm)} />
                ))}
              </div>
              {cards.length > shown.length ? (
                <div className="pb-4 text-center font-mono text-[11px] text-dim">
                  showing {shown.length} of {cards.length} — narrow with search or kind
                </div>
              ) : null}
            </>
          )}
        </div>
        {triageOpen && <TriageTable onClose={() => setTriageOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {pageHeader}

      <div className={`grid min-h-0 flex-1 gap-4 ${listCollapsed ? "grid-cols-[40px_1fr]" : "grid-cols-[340px_1fr]"}`}>
        {/* collapsed: a thin rail that re-expands; gives the chart the width (LODE-55) */}
        {listCollapsed ? (
          <button
            type="button"
            onClick={() => setListCollapsed(false)}
            title="Expand the market list"
            aria-label="Expand the market list"
            className="flex min-h-0 flex-col items-center gap-3 rounded-xl border border-line bg-surface pt-3 text-dim transition-colors hover:text-text"
          >
            <span className="font-mono text-xs">»</span>
            <span className="font-mono text-[10px] uppercase tracking-wider [writing-mode:vertical-rl]">
              markets
            </span>
          </button>
        ) : isFin ? (
        <Panel title="trading sessions" className="min-h-0" bodyClassName="flex min-h-0 flex-col p-0">
          <div className="shrink-0 space-y-2 border-b border-line p-3">
            <div className="flex gap-2">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="filter by date… (e.g. 2026-03)"
                className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm text-text placeholder:text-dim focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setListCollapsed(true)}
                title="Collapse the session list"
                aria-label="Collapse the session list"
                className="shrink-0 rounded-md border border-line px-2 font-mono text-xs text-dim transition-colors hover:text-text"
              >
                «
              </button>
            </div>
            <div className="flex gap-1">
              {FIN_SYMBOLS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setFinSymbol(s);
                    // Don't leave the other symbol's session in the detail pane.
                    setFinSelected(null);
                    setFinBars(null);
                    setFinCtx(null);
                    setHighlightTs(null);
                  }}
                  className={`rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors ${
                    finSymbol === s ? "bg-surface2 text-text" : "text-dim hover:text-text"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
            {finSessions == null ? (
              <div className="p-2">
                <Spinner label="loading sessions…" />
              </div>
            ) : (
              <>
                {!search && finTop && finTop.length > 0 && (
                  <div className="mb-2">
                    <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-dim">
                      wildest sessions
                    </div>
                    {finTop.map((s) => (
                      <SessionRow key={`top-${s.date}`} s={s} selected={finSelected} onSelect={setFinSelected} />
                    ))}
                    <div className="mt-2 mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-dim">
                      recent sessions
                    </div>
                  </div>
                )}
                {finSessions
                  .filter((s) => !search || s.date.includes(search.trim()))
                  .map((s) => (
                    <SessionRow key={s.date} s={s} selected={finSelected} onSelect={setFinSelected} />
                  ))}
                {finSessions.length === 0 && (
                  <div className="px-1 text-sm text-dim">
                    no sessions — Orbit's DuckDB must be reachable (read-only)
                  </div>
                )}
              </>
            )}
          </div>
        </Panel>
        ) : (
        <Panel title="historical markets" className="min-h-0" bodyClassName="flex min-h-0 flex-col p-0">
          {!markets && error ? (
            <div className="p-4 text-sm text-dn">
              historical DB not reachable. Run <span className="font-mono text-text">pnpm db:historicals</span>.
              <div className="mt-1 text-xs text-dim">{error}</div>
            </div>
          ) : !markets ? (
            <div className="p-4">
              <Spinner label="loading markets…" />
            </div>
          ) : (
            <>
              <div className="shrink-0 space-y-2 border-b border-line p-3">
                <div className="flex gap-2">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="search team, player, market, or ticker…"
                    className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-sm text-text placeholder:text-dim focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setListCollapsed(true)}
                    title="Collapse the market list"
                    aria-label="Collapse the market list"
                    className="shrink-0 rounded-md border border-line px-2 font-mono text-xs text-dim transition-colors hover:text-text"
                  >
                    «
                  </button>
                </div>
                {(KINDS_BY_SPORT[sport] ?? []).length > 0 && (
                  <div className="flex gap-1">
                    {KINDS_BY_SPORT[sport].map((x) => (
                      <button
                        key={x.k}
                        type="button"
                        onClick={() => setKind(x.k)}
                        className={`rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors ${
                          kind === x.k ? "bg-surface2 text-text" : "text-dim hover:text-text"
                        }`}
                      >
                        {x.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
                {/* edge leaderboard — Kalshi vs sportsbook fair, ranked (LODE Phase 1) */}
                {sport === "nba" && kind === "all" && !search && edges && edges.configured && (
                  <div className="mb-2">
                    <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-dim">
                      edges · Kalshi vs books
                    </div>
                    {edges.rows.length === 0 ? (
                      <div className="px-1 pb-1 text-[11px] leading-snug text-dim">
                        {edges.reason ?? "no edges"}
                      </div>
                    ) : (
                      edges.rows.slice(0, 6).map((e) => (
                        <button
                          key={e.ticker}
                          type="button"
                          onClick={() => selectTicker(e.ticker, e.label)}
                          className="flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left text-dim transition-colors hover:text-text"
                        >
                          <span className="truncate text-sm">{e.label}</span>
                          {e.edge_cents != null && (
                            <span
                              className={`shrink-0 font-mono text-[11px] ${e.edge_cents >= 0 ? "text-up" : "text-dn"}`}
                            >
                              {e.edge_cents > 0 ? "+" : ""}
                              {e.edge_cents}¢
                            </span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                )}
                {/* flow-vs-state anomaly board (research-streams T9) — statistical
                    ranking only; score_ratio is liquidity-calibrated */}
                {sport === "tennis" && kind === "all" && !search && anomalies && anomalies.length > 0 && (
                  <div className="mb-2">
                    <div className="mb-1 flex items-baseline justify-between px-1">
                      <span className="text-[11px] font-medium uppercase tracking-wide text-dim">
                        unusual flow · vs match state
                      </span>
                      <ResearchStatusChip dataset="tennis-anomalies" />
                      <button
                        type="button"
                        onClick={() => setTriageOpen(true)}
                        className="font-mono text-[10px] text-accent hover:underline"
                      >
                        triage →
                      </button>
                    </div>
                    {anomalies.map((a) => {
                      const label = `${a.player1_name ?? "?"} v ${a.player2_name ?? "?"}`;
                      return (
                        <button
                          key={a.match_id}
                          type="button"
                          onClick={() => a.ticker && selectTicker(a.ticker, label)}
                          disabled={!a.ticker}
                          title={`n_sized=${a.n_sized_trades} · flags=${a.n_flagged} (${Math.round(a.flag_rate * 100)}%)`}
                          className="flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left text-dim transition-colors hover:text-text disabled:opacity-50"
                        >
                          <span className="truncate text-sm">
                            {a.player1_name} v {a.player2_name}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-accent">
                            ×{a.score_ratio.toFixed(2)}
                          </span>
                        </button>
                      );
                    })}
                    <div className="px-2 pt-0.5 text-[10px] leading-snug text-dim">
                      ranked by calibrated score — unusual ≠ wrongdoing
                    </div>
                  </div>
                )}
                {kind === "all" && !search && movers == null && (
                  <div className="p-2">
                    <Spinner label="loading top movers…" />
                  </div>
                )}
                {kind === "all" && !search && movers && movers.length > 0 && (
                  <div className="mb-2">
                    <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-dim">top movers</div>
                    {movers.map((m) => {
                      const swing = m.max_swing == null ? null : Math.round(m.max_swing * 100);
                      return (
                        <button
                          key={m.ticker}
                          type="button"
                          onClick={() => selectTicker(m.ticker, m.label)}
                          className="flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left text-dim transition-colors hover:text-text"
                        >
                          <span className="truncate text-sm">{m.label}</span>
                          {swing != null && (
                            <span className="shrink-0 font-mono text-[11px] text-accent">{swing}pt</span>
                          )}
                        </button>
                      );
                    })}
                    <div className="mt-2 mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-dim">
                      all markets
                    </div>
                  </div>
                )}
                {filtered.map((m) => (
                  <button
                    key={m.ticker}
                    type="button"
                    onClick={() => setSelected(m)}
                    className={`block w-full rounded-md px-2 py-1.5 text-left transition-colors ${
                      selected?.ticker === m.ticker ? "bg-surface2 text-text" : "text-dim hover:text-text"
                    }`}
                  >
                    <div className="truncate text-sm">{m.label}</div>
                    <div className="truncate font-mono text-[11px] text-dim">
                      {m.ticker} · {m.rows.toLocaleString()} ticks
                    </div>
                  </button>
                ))}
                {filtered.length === 0 && <div className="px-1 text-sm text-dim">no matches</div>}
              </div>
            </>
          )}
        </Panel>
        )}

        {/* market detail — scrolls within the card */}
        <Panel
          title={
            isFin
              ? finSelected
                ? `${finSelected.contract} · ${finSelected.date}`
                : "session detail"
              : selected
                ? selected.label
                : "market detail"
          }
          className="min-h-0"
          bodyClassName="min-h-0 flex-1 overflow-y-auto p-4"
        >
          {isFin ? (
            !finSelected ? (
              <div className="text-sm text-dim">
                Pick a trading session to see its intraday chart, dealer-positioning levels, and flow.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-6 font-mono text-xs text-dim">
                  <span>{finSelected.contract} · 5m bars</span>
                  {finCtx?.levels_source && <span>gamma {finCtx.levels_source}</span>}
                </div>
                {finLoading ? (
                  <Spinner label="loading session bars…" />
                ) : finBars && finBars.length > 0 ? (
                  <CandleChart
                    bars={finBars}
                    levels={
                      (finCtx?.levels ?? []).map(
                        (l): PriceLevel => ({ price: l.price, label: l.label, tone: LEVEL_TONE[l.key] ?? "accent" }),
                      )
                    }
                    height={300}
                    intraday
                    highlightTs={highlightTs}
                  />
                ) : (
                  <div className="text-sm text-dim">no intraday bars for this session</div>
                )}
                {finCtxLoading && <Spinner label="loading session context…" />}
                {finCtx && (
                  <SessionContextPanel ctx={finCtx} onSelectMoment={setHighlightTs} selectedTs={highlightTs} />
                )}
              </div>
            )
          ) : !selected ? (
            <div className="text-sm text-dim">Pick a market to see its price history, volume, and trades.</div>
          ) : (
            <div className="space-y-3">
              <div className="font-mono text-xs text-dim">{selected.ticker}</div>
              <div className="flex flex-wrap gap-6 font-mono text-xs text-dim">
                <span>{(detail?.n_ticks ?? selected.rows).toLocaleString()} ticks</span>
                <span>{fmtDate(detail?.first_ts ?? selected.first_ts)} → {fmtDate(detail?.last_ts ?? selected.last_ts)}</span>
                {detail && (
                  <span>
                    {detail.total_trades.toLocaleString()} trades · {detail.total_contracts.toLocaleString()} contracts
                  </span>
                )}
              </div>
              {/* sibling markets for the same game — ML / spread / total (LODE Phase 1) */}
              {isNba && related && related.related.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] uppercase tracking-wide text-dim">related:</span>
                  {related.related.map((r) => (
                    <button
                      key={r.ticker}
                      type="button"
                      title={r.label}
                      onClick={() => selectTicker(r.ticker, r.label)}
                      className="rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-dim transition-colors hover:border-accent hover:text-text"
                    >
                      {KIND_SHORT[r.kind] ?? r.kind.replace("KX", "")}
                    </button>
                  ))}
                </div>
              )}
              {loading ? (
                <Spinner label="loading price history…" />
              ) : detail && detail.points.length > 0 ? (
                <MarketDetailChart
                  points={detail.points}
                  game={detail.game}
                  height={300}
                  highlightTs={highlightTs}
                />
              ) : (
                <div className="text-sm text-dim">no data for this market</div>
              )}
              {ctxLoading && <Spinner label={isTennis ? "loading match context…" : "loading game context…"} />}
              {isNba && ctx && (
                <NbaGameContextPanel ctx={ctx} onSelectMoment={setHighlightTs} selectedTs={highlightTs} />
              )}
              {isTennis && tennisCtx && (
                <div className="mb-1 flex items-center gap-1.5">
                  {tennisCtx.players?.map((pl) =>
                    pl.name ? (
                      <button
                        key={pl.num}
                        type="button"
                        onClick={() => setProfilePlayer({ name: pl.name!, key: pl.player_key })}
                        className="rounded-full border border-line px-2 py-0.5 text-[11px] text-dim hover:border-accent hover:text-text"
                      >
                        profile · {pl.name}
                      </button>
                    ) : null,
                  )}
                </div>
              )}
              {isTennis && tennisCtx && flowMoments && flowMoments.length > 0 && detail && (
                <FlowDeepDive
                  points={detail.points}
                  moments={flowMoments}
                  breaks={tennisCtx.breaks}
                  sets={tennisCtx.sets}
                  onAnnotate={annotateMoment}
                  totalMoments={flowTotalMoments ?? undefined}
                />
              )}
              {isTennis && tennisCtx && (
                <TennisMatchContextPanel ctx={tennisCtx} onSelectMoment={setHighlightTs} selectedTs={highlightTs} />
              )}
            </div>
          )}
        </Panel>
      </div>
      {triageOpen && <TriageTable onClose={() => setTriageOpen(false)} />}
      {profilePlayer && (
        <ProfileDrawer
          playerName={profilePlayer.name}
          playerKey={profilePlayer.key}
          onClose={() => setProfilePlayer(null)}
        />
      )}
    </div>
  );
}
