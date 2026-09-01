/**
 * Dedicated chart page (owner ask 2026-07-03): the FOCUS surface a case's
 * "chart →" lands on. Full-page canvas, no browse rail — "I need to talk
 * about this case and that view." The flow deep-dive (for anomaly-board
 * matches) or a full-size price/volume chart is the primary widget; the
 * anchoring case's WORKBENCH renders underneath — this page is where the
 * agent-composed widgets get their full stage. Annotations land on the
 * anchoring case; Ctrl+I sees {view: chart, ticker} as usual.
 */

import { useEffect, useMemo, useState } from "react";
// SWITCHBOARD: no router. The market to chart arrives through the project's
// own store (`pendingMarket`, the same intent a case's "view on chart" sets)
// and "back" is the shell's business — the page offers `→ markets` instead.
// T9 (SWIT-63): a DEEP LINK's params (`instrument`, `date`, `caseId`, via
// `useSurfaceParams`) take precedence over the store intent for those keys,
// and are re-read whenever they change; the store intent still serves
// in-project navigation (a case's "→ chart").
import { useSurfaceNav, useSurfaceParams } from "../../../surfaces/page-api";
import FlowDeepDive from "../components/research/FlowDeepDive";
import WorkbenchGrid from "../components/research/WorkbenchGrid";
import Spinner from "../components/Spinner";
import { useUiStore } from "../stores/uiStore";
import {
  api,
  type AnomalyMoment,
  type Case,
  type HistoricalDetail,
  type TennisMatchContext,
} from "../api/client";

/** The chart target a deep link names, or null when the link carries none of
 *  the three keys. `instrument` is the ticker; `date` joins the label (the
 *  historical series is what the backend has — the date is context for the
 *  reader, not a query); `caseId` alone anchors the current market to a case. */
function targetFromParams(
  instrument: string | undefined,
  date: string | undefined,
  caseId: string | undefined
): { ticker: string; label: string; caseId: string | null } | null {
  if (!instrument && !caseId) return null;
  const s = useUiStore.getState();
  const ticker = instrument ?? s.activeTicker ?? "";
  const label = `${instrument ?? s.activeTicker ?? ""}${date ? ` · ${date}` : ""}`;
  return { ticker, label, caseId: caseId ?? null };
}

function fmtTs(ts: string): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function ChartPage() {
  const nav = useSurfaceNav();
  const setPendingMarket = useUiStore((s) => s.setPendingMarket);
  const params = useSurfaceParams();
  const paramInstrument = params.instrument;
  const paramDate = params.date;
  const paramCaseId = params.caseId;
  // The market is captured ONCE, on mount: the deep link's params when it
  // has any, else an explicit "view on chart" intent (`pendingMarket`,
  // consumed and cleared exactly as Markets consumes it), else whatever
  // Markets last selected. Live-deriving the STORE half would let a Markets
  // unmount beside this page blank it, and a stale intent re-fire later; the
  // PARAMS half is re-applied below whenever the link changes.
  const [target, setTarget] = useState(() => {
    const fromParams = targetFromParams(paramInstrument, paramDate, paramCaseId);
    if (fromParams) return fromParams;
    const s = useUiStore.getState();
    return s.pendingMarket
      ? { ticker: s.pendingMarket.ticker, label: s.pendingMarket.label, caseId: s.pendingMarket.caseId ?? null }
      : { ticker: s.activeTicker ?? "", label: s.activeTicker ?? "", caseId: null as string | null };
  });
  useEffect(() => {
    const fromParams = targetFromParams(paramInstrument, paramDate, paramCaseId);
    if (!fromParams) return;
    setTarget((cur) =>
      cur.ticker === fromParams.ticker && cur.label === fromParams.label && cur.caseId === fromParams.caseId
        ? cur
        : fromParams
    );
  }, [paramInstrument, paramDate, paramCaseId]);
  useEffect(() => {
    if (useUiStore.getState().pendingMarket) setPendingMarket(null);
  }, [setPendingMarket]);
  const rawTicker = target.ticker;
  const caseId = target.caseId;
  const label = target.label || rawTicker;

  const [detail, setDetail] = useState<HistoricalDetail | null>(null);
  const [moments, setMoments] = useState<AnomalyMoment[] | null>(null);
  const [totalMoments, setTotalMoments] = useState<number | null>(null);
  const [openCase, setOpenCase] = useState<Case | null>(null);
  const [tennisCtx, setTennisCtx] = useState<TennisMatchContext | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const setView = useUiStore((s) => s.setView);

  // resolve a bare MATCH id to its tradeable market, then load everything
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setMoments(null);
    setErr(null);
    if (!rawTicker) {
      setErr("no ticker given");
      return;
    }
    const isTennis = /^KX(ATP|WTA)/.test(rawTicker);
    const matchId = isTennis ? rawTicker.split("-").slice(0, 2).join("-") : null;
    const load = async (): Promise<void> => {
      let tkr = rawTicker;
      if (matchId) {
        const r = await api.getMatchAnomaly(matchId).catch(() => null);
        if (r && !cancelled) {
          setMoments(r.moments);
          setTotalMoments(r.match?.n_moments ?? r.moments.length);
          if (rawTicker.split("-").length === 2) tkr = r.match?.ticker ?? rawTicker;
        }
      }
      // full-page canvas: ask for a DENSE series (the side-pane default of
      // ~150 points reads as "very basic" at this width — owner feedback)
      const d = await api.getHistoricalDetail(tkr, 800);
      if (!cancelled) setDetail(d);
      if (isTennis) {
        const ctx = await api.getTennisContext(tkr).catch(() => null);
        if (!cancelled) setTennisCtx(ctx);
      }
    };
    load().catch((e: unknown) => !cancelled && setErr(String((e as Error)?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [rawTicker]);

  // the anchoring case: workbench + annotation target; poll so agent-composed
  // widgets appear live while you talk about the case
  useEffect(() => {
    if (!caseId) return;
    let cancelled = false;
    const tick = (): void => {
      void api.getCase(caseId).then((c) => !cancelled && setOpenCase(c)).catch(() => {});
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [caseId]);

  // Agent screen context: the view name only. `activeTicker` is Markets'
  // to set — writing it from here (and nulling it on unmount) would fight a
  // Markets page open beside this one.
  useEffect(() => {
    setView("chart", `Chart · ${label}`);
  }, [label, setView]);

  const annotate = useMemo(() => {
    if (!caseId) return undefined;
    return async (text: string, m: AnomalyMoment): Promise<void> => {
      await api.addCaseNote(
        caseId,
        `[chart ${m.ts} · ${m.count} lots @ ${m.price}¢ · backs p${m.backs_player} · score ${m.score.toFixed(2)}] ${text}`,
      );
    };
  }, [caseId]);

  const stat = detail?.points.filter((p) => p.last_price != null).slice(-1)[0];

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-baseline gap-3">
        <button
          type="button"
          onClick={() => nav.openPage(caseId ? "playground" : "markets")}
          className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-dim hover:text-text"
        >
          {caseId ? "← case" : "← back"}
        </button>
        <h1 className="min-w-0 truncate font-mono text-lg font-medium tracking-tight">{label}</h1>
        {openCase ? (
          <span className="shrink-0 font-mono text-[10px] text-dim">
            case · {openCase.title}
          </span>
        ) : null}
        {detail ? (
          <span className="ml-auto shrink-0 font-mono text-[11px] text-dim">
            {detail.points.length.toLocaleString()} pts
            {stat?.last_price != null ? ` · last ${stat.last_price}¢` : ""}
            {detail.points.length > 0
              ? ` · ${fmtTs(detail.points[0].ts)} → ${fmtTs(detail.points[detail.points.length - 1].ts)}`
              : ""}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {err ? (
          /(DB unavailable|historical DB|-> 50\d)/i.test(err) ? (
            // Infra, not the subject: the local :5433 snapshot container is down
            // (it stops on a machine restart). Say so honestly and actionably —
            // don't blame the subject for a database that isn't running.
            <div className="rounded-lg border border-dashed border-dn/50 p-4 text-sm text-dn/90">
              <div className="font-medium">Historical database is offline.</div>
              <div className="mt-1 font-mono text-[11px] leading-relaxed text-dim">
                The local <span className="text-text">:5433</span> snapshot container isn’t running (it stops
                when the machine restarts). Start it with{" "}
                <span className="text-text">pnpm db:historicals</span>, then reopen this chart.
              </div>
            </div>
          ) : openCase?.workbench?.length ? (
            // A subject with no tradeable market (a player, a historical match)
            // still has the agent's composed views below — don't alarm, just note
            // the price chart is absent and let the workbench be the focus.
            <div className="rounded-lg border border-dashed border-line/70 p-3 font-mono text-[11px] text-dim">
              no price chart for this subject — the agent's composed views are below
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-line/70 p-4 text-sm text-dim">
              no market data for this subject
            </div>
          )
        ) : !detail ? (
          <div className="p-8"><Spinner label="loading chart…" /></div>
        ) : moments && moments.length > 0 ? (
          // anomaly-board match: the flow deep-dive IS the canvas
          <div className="rounded-lg border border-line/70 bg-surface p-4">
            <FlowDeepDive
              points={detail.points}
              moments={moments}
              breaks={tennisCtx?.breaks ?? []}
              sets={tennisCtx?.sets ?? []}
              totalMoments={totalMoments ?? undefined}
              onAnnotate={annotate}
            />
          </div>
        ) : (
          // any other market: full-size price/volume via the widget renderer
          <WorkbenchGrid widgets={[{ type: "price_chart", params: { ticker: detail.ticker }, title: label }]} />
        )}

        {/* the case's workbench — the agent's stage, full width */}
        {openCase?.workbench?.length ? (
          <>
            <div className="font-mono text-[10px] uppercase tracking-wide text-dim">
              case workbench · composed by the agent
            </div>
            <WorkbenchGrid widgets={openCase.workbench} />
          </>
        ) : caseId ? (
          <div className="rounded-lg border border-dashed border-line/70 p-4 font-mono text-[11px] text-dim">
            no workbench yet — hit Ctrl+I and ask: “build a workbench for this case”
          </div>
        ) : null}
      </div>
    </div>
  );
}
