/**
 * Kalshi Trading (SWIT-130 betting flow; SWIT-129 positions, later) - the first
 * piece of a trading area. Two tabs:
 *
 *   Flow       NBA betting trends from our own Kalshi tape: bets and handle
 *              per game and per line (moneyline, spread, total), which side,
 *              and over time - separating the public (many small tickets) from
 *              the sharps (few large ones). Games table, click a row or a line
 *              cell for the game detail.
 *   Positions  Reserved: the combo-desk positions view (demo / live).
 *
 * Reads GET /nba/flow/games and GET /nba/flow/game on the Lodestar backend.
 * Pin anchors: game:<game> a game row, line:<game>:<ml|spread|total> a line
 * cell, detail:<game>:<line> the open detail, pt:<iso> a point on its chart.
 *
 * Date, phase and the open game live on the page, not the Flow tab, so a trip
 * to Positions and back keeps them.
 */

import { useEffect, useReducer, useRef, useState, type Dispatch } from "react";
import { api, type NbaFlowGameDetail, type NbaFlowPhase } from "../api/client";
import Chip from "../components/trading/Chip";
import FlowGameDetail from "../components/trading/FlowGameDetail";
import FlowGamesTable from "../components/trading/FlowGamesTable";
import Panel from "../components/Panel";
import Spinner from "../components/Spinner";
import { usePoll } from "../hooks/usePoll";
import { useStableData } from "../hooks/useStableData";
import {
  BUCKET_MIN,
  HELP,
  detailMatches,
  fetchErrorText,
  selectionReducer,
  slateIsSettled,
  slateMatches,
  todayLocal,
  type FlowSelection,
  type SelectionAction,
} from "../lib/kalshiFlow";
import { T } from "../../../lib/typeScale";

const POLL_MS = 30_000;
/** Until the first answer lands, ask often so a real failure shows in seconds. */
const BOOT_POLL_MS = 3_000;

type Tab = "flow" | "positions";

/** One detail poll: the answer, tied to the request that asked for it. */
interface DetailPoll {
  key: string;
  /** The request started while the game was already final. */
  afterFinal: boolean;
  detail: NbaFlowGameDetail;
}

/** The one request a selected game/line/rung makes (exported for the test). */
export function loadFlowDetail(sel: FlowSelection): Promise<NbaFlowGameDetail> {
  return api.getNbaFlowGame({ game: sel.game, line: sel.line, rung: sel.rung, bucketMin: BUCKET_MIN });
}

function SegButton({ on, onClick, children, disabled }: { on: boolean; onClick?: () => void; children: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-full border px-3 py-0.5 transition-colors disabled:opacity-40 ${on ? "border-accent text-accent" : "border-line text-dim hover:text-text"}`}
      style={T.label}
    >
      {children}
    </button>
  );
}

function HelpText() {
  return (
    <details className="rounded-md border border-line px-3 py-2" style={T.bodySm}>
      <summary className="cursor-pointer text-dim">how to read this</summary>
      <ul className="mt-2 flex flex-col gap-1 text-dim">
        {HELP.map((h) => (
          <li key={h.term}>
            <span style={{ ...T.mono, color: "var(--text)" }}>{h.term}</span> - {h.text}
          </li>
        ))}
        <li>
          Each side shows two bars, labelled % of bets and % of money. A side whose money bar is much longer than its
          bets bar is being bet by fewer, larger tickets.
        </li>
      </ul>
    </details>
  );
}

interface FlowTabProps {
  date: string;
  phase: NbaFlowPhase;
  selection: FlowSelection | null;
  setDate: (d: string) => void;
  setPhase: (p: NbaFlowPhase) => void;
  dispatch: Dispatch<SelectionAction>;
}

function FlowTab({ date, phase, selection, setDate, setPhase, dispatch }: FlowTabProps) {
  const today = todayLocal();

  // A finished past slate no longer changes: stop its interval (the data stays).
  const [settled, setSettled] = useState(false);
  const { data: slateRaw, error } = usePoll(
    () => api.getNbaFlowGames(date, phase),
    POLL_MS,
    `${date}|${phase}`,
    "kalshi-flow-games",
    { bootIntervalMs: BOOT_POLL_MS, paused: settled },
  );
  // Only an answer for the date and phase on screen is drawn.
  const slate = slateMatches(slateRaw, date, phase) ? slateRaw : null;
  const slateSettled = slateIsSettled(slate, today);
  useEffect(() => setSettled(slateSettled), [slateSettled]);

  const selectedGame = selection ? slate?.games.find((g) => g.game === selection.game) : undefined;
  const selKey = selection ? `${selection.game}|${selection.line}|${selection.rung ?? ""}` : "";
  // A game that has just turned final gets one more fetch - a request STARTED
  // after it was final - before its detail stops polling.
  const finalNow = selectedGame?.status === "final";
  const [detailDone, setDetailDone] = useState(false);
  const { data: detailRaw, error: detailError } = usePoll<DetailPoll | null>(
    () =>
      selection
        ? loadFlowDetail(selection).then((d) => ({ key: selKey, afterFinal: finalNow, detail: d }))
        : Promise.resolve(null),
    POLL_MS,
    selKey,
    "kalshi-flow-game",
    { bootIntervalMs: BOOT_POLL_MS, paused: detailDone },
  );
  // Identical polls keep one object, so the charts keep their zoom.
  const polled = useStableData(detailRaw);
  // Drawn only if it answers THIS selection (its own key) for this game and line.
  const answered = !!selection && polled?.key === selKey && detailMatches(selection, polled.detail);
  const detail = answered ? polled!.detail : null;
  const done = finalNow && answered && polled!.afterFinal;
  useEffect(() => setDetailDone(done), [done]);

  // The last answer for this game AND line, kept while a rung change loads so
  // the rung select stays mounted (focus and layout hold). A line change keeps
  // nothing: the old line's rungs must not stay selectable.
  const lastRef = useRef<NbaFlowGameDetail | null>(null);
  if (detail) lastRef.current = detail;
  const previous =
    selection && lastRef.current?.game === selection.game && lastRef.current.line === selection.line
      ? lastRef.current
      : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2" style={{ ...T.bodySm, color: "var(--dim)" }}>
          date
          <input
            type="date"
            value={date}
            onChange={(e) => {
              if (!e.target.value) return;
              setDate(e.target.value);
              dispatch({ type: "close" });
            }}
            className="rounded border border-line bg-bg px-2 py-1 text-text focus:border-accent focus:outline-none"
            style={T.mono}
          />
        </label>
        <div className="flex gap-1" role="tablist" aria-label="phase">
          <SegButton on={phase === "pregame"} onClick={() => setPhase("pregame")}>Pregame</SegButton>
          <SegButton on={phase === "all"} onClick={() => setPhase("all")}>All</SegButton>
        </div>
        <span style={{ ...T.caption, color: "var(--dim2)" }}>
          {phase === "pregame" ? "table: bets placed before the tip" : "table: every bet, including in-game"}
        </span>
      </div>

      <HelpText />

      {slate == null && error ? (
        <div className="rounded-lg border border-line p-4 text-dn" style={T.bodySm}>
          {fetchErrorText(error)}
        </div>
      ) : slate == null ? (
        <div className="p-6"><Spinner label="loading NBA flow…" /></div>
      ) : slate.games.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-4 text-dim" style={T.bodySm}>
          no NBA games with Kalshi bets on tape for {slate.date}
        </div>
      ) : (
        <>
          {error ? (
            <div className="flex items-center gap-2" style={{ ...T.bodySm, color: "var(--dim)" }}>
              <Chip tone="warn">refresh failing</Chip>
              {fetchErrorText(error)} - showing the last data
            </div>
          ) : null}
          <FlowGamesTable
            games={slate.games}
            selected={selection}
            phase={phase}
            onRow={(game) => dispatch({ type: "row", game })}
            onLine={(game, line) => dispatch({ type: "line", game, line })}
          />
        </>
      )}

      {selection ? (
        <FlowGameDetail
          game={selectedGame}
          selection={selection}
          phase={phase}
          detail={detail}
          previous={previous}
          error={detailError}
          onLine={(line) => dispatch({ type: "setLine", line })}
          onRung={(rung) => dispatch({ type: "rung", rung })}
          onClose={() => dispatch({ type: "close" })}
        />
      ) : null}
    </div>
  );
}

function PositionsTab() {
  return (
    <Panel title="positions">
      <div className="flex flex-col gap-3">
        <div className="flex gap-1" role="tablist" aria-label="account (not available yet)">
          <SegButton on disabled>Demo</SegButton>
          <SegButton on={false} disabled>Live</SegButton>
        </div>
        <p className="text-dim" style={T.bodySm}>
          The combo-desk positions view (demo and live) is coming - SWIT-129. This tab holds its place so the layout
          does not move when it lands.
        </p>
      </div>
    </Panel>
  );
}

export default function KalshiTrading() {
  const [tab, setTab] = useState<Tab>("flow");
  // Lifted so Flow -> Positions -> Flow keeps the day, the phase and the open game.
  const [date, setDate] = useState(() => todayLocal());
  const [phase, setPhase] = useState<NbaFlowPhase>("pregame");
  const [selection, dispatch] = useReducer(selectionReducer, null);
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4">
      <div className="flex items-center gap-3">
        <h1 style={{ ...T.heading, color: "var(--text)" }}>Kalshi Trading</h1>
        <div className="flex gap-1" role="tablist" aria-label="view">
          <SegButton on={tab === "flow"} onClick={() => setTab("flow")}>Flow</SegButton>
          <SegButton on={tab === "positions"} onClick={() => setTab("positions")}>Positions</SegButton>
        </div>
      </div>
      {tab === "flow" ? (
        <FlowTab date={date} phase={phase} selection={selection} setDate={setDate} setPhase={setPhase} dispatch={dispatch} />
      ) : (
        <PositionsTab />
      )}
    </div>
  );
}
