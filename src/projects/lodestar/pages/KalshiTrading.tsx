/**
 * Kalshi Trading (SWIT-130 betting flow; SWIT-129 positions; SWIT-139 portfolio) -
 * the first piece of a trading area. Three tabs:
 *
 *   Flow       NBA betting trends as a BOARD: one row per game, three market
 *              cells across, bets bar over money bar, the "Biggest splits"
 *              strip above. The numbers come from our own Kalshi tape and from
 *              DraftKings' public splits (percentages only); a Source switch
 *              draws either or their plain average. Click a cell for the game
 *              detail: the versus block, ONE chart of money vs bets over time,
 *              when the money came in, who bet what size, and the $1k+ bets.
 *   Positions  The combo desk (SWIT-129): the ledger against Kalshi, the
 *              exposure against each cap, requests, fills, settlements and
 *              the kill switch, for the Demo or the Live account.
 *   Portfolio  The desk's money over time (SWIT-139): cash balance and
 *              cumulative realized P&L on one chart, daily P&L bars, and the
 *              by-strategy table, for the same Demo or Live account.
 *
 * Reads GET /nba/flow/games, /game, /books, /books/game and /gap_bands, and
 * /combos/desk (30 s) and /combos/portfolio (60 s) on the Lodestar backend. Pin anchors: game:<game> a game row, line:<game>:<line> a
 * market cell, detail:<game>:<line> the open detail, pt:<iso> a point on its
 * chart. An investigation tool: it lays numbers out and never says to bet.
 *
 * Date, phase, source, the open game and the desk's Demo/Live live on the page,
 * not the tabs, so a trip to Positions and back keeps them. When the date is today the games,
 * the book splits and the open detail refresh every minute.
 */

import { useEffect, useReducer, useRef, useState, type Dispatch } from "react";
import {
  api,
  type ComboDeskEnv,
  type ComboDeskView,
  type ComboPortfolio,
  type NbaFlowBookSeries,
  type NbaFlowBooks,
  type NbaFlowGameDetail,
  type NbaFlowGapBands,
  type NbaFlowPhase,
} from "../api/client";
import Chip from "../components/trading/Chip";
import DeskPortfolio from "../components/trading/DeskPortfolio";
import DeskPositions, { type KillState } from "../components/trading/DeskPositions";
import FlowBoard from "../components/trading/FlowBoard";
import FlowGameDetail from "../components/trading/FlowGameDetail";
import type { ChartMode } from "../components/trading/FlowShareChart";
import FlowSplits from "../components/trading/FlowSplits";
import Seg from "../components/trading/Seg";
import Spinner from "../components/Spinner";
import { usePoll } from "../hooks/usePoll";
import { useStableData } from "../hooks/useStableData";
import {
  BUCKET_MIN,
  SOURCES,
  biggestSplits,
  booksMatch,
  bookGame,
  detailMatches,
  fetchErrorText,
  fmtDateLabel,
  selectionReducer,
  shiftDate,
  slateIsSettled,
  slateMatches,
  sortGames,
  todayEt,
  type BoardSort,
  type FlowSelection,
  type FlowSource,
  type SelectionAction,
} from "../lib/kalshiFlow";
import { killErrorText } from "../lib/comboDesk";
import type { ChartRange } from "../lib/kalshiFlowSeries";
import { T } from "../../../lib/typeScale";

/** The refresh cadence while the date is today. */
const POLL_MS = 60_000;
/** Until the first answer lands, ask often so a real failure shows in seconds. */
const BOOT_POLL_MS = 3_000;
/** Last season's gap bands change once a season. */
const BANDS_POLL_MS = 3_600_000;
/** The combo desk's refresh cadence. */
const DESK_POLL_MS = 30_000;
/** The portfolio moves with settlements and balance samples, not ticks. */
const PORTFOLIO_POLL_MS = 60_000;

type Tab = "flow" | "positions" | "portfolio";

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

/** What each source switch position draws (the Source switch's hover text). */
const SOURCE_HELP: Record<FlowSource, string> = {
  kalshi: "Kalshi bets and dollars; white ticks mark DraftKings' shares",
  dk: "DraftKings percentages (no dollars); white ticks mark Kalshi's shares",
  both: "simple average of the Kalshi and DraftKings shares, no weighting",
};

/** A quiet text button: no box, no border. */
function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ...T.bodySm, background: "transparent", border: 0, padding: 0, marginLeft: 8, cursor: "pointer", color: "var(--accent)" }}
    >
      Retry
    </button>
  );
}

/** The chart range a phase opens on: the whole game when it is in, else everything before the tip. */
const defaultRange = (phase: NbaFlowPhase): ChartRange => (phase === "all" ? "all" : "pre");

interface FlowTabProps {
  date: string;
  phase: NbaFlowPhase;
  source: FlowSource;
  sort: BoardSort;
  selection: FlowSelection | null;
  dispatch: Dispatch<SelectionAction>;
  setSort: (s: BoardSort) => void;
}

function FlowTab({ date, phase, source, sort, selection, dispatch, setSort }: FlowTabProps) {
  const today = todayEt();
  // A manual retry (after a failure on a day that is no longer refreshing itself).
  const [retry, setRetry] = useState(0);
  const again = () => setRetry((n) => n + 1);
  // Past days do not change once played: the book splits and the open detail
  // stop refreshing (they still load once).
  const live = date >= today;

  // A finished past slate no longer changes: stop its interval (the data stays).
  const [settled, setSettled] = useState(false);
  const { data: slateRaw, error } = usePoll(
    () => api.getNbaFlowGames(date, phase),
    POLL_MS,
    `${date}|${phase}|${retry}`,
    "kalshi-flow-games",
    { bootIntervalMs: BOOT_POLL_MS, paused: settled },
  );
  // Only an answer for the date and phase on screen is drawn.
  const slate = slateMatches(slateRaw, date, phase) ? slateRaw : null;
  const slateSettled = slateIsSettled(slate, today);
  useEffect(() => {
    setSettled(slateSettled);
  }, [slateSettled]);

  // DraftKings' splits for the day: a nice-to-have, so a failure only dims the source switch.
  const { data: booksRaw, error: booksError } = usePoll<NbaFlowBooks>(
    () => api.getNbaFlowBooks(date),
    POLL_MS,
    `${date}|${retry}`,
    "kalshi-flow-books",
    { bootIntervalMs: BOOT_POLL_MS, paused: !live },
  );
  const books = booksMatch(booksRaw, date) ? booksRaw : null;
  const { data: bands } = usePoll<NbaFlowGapBands>(
    () => api.getNbaFlowGapBands(),
    BANDS_POLL_MS,
    "bands",
    "kalshi-flow-bands",
    { bootIntervalMs: BOOT_POLL_MS },
  );

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
    { bootIntervalMs: BOOT_POLL_MS, paused: detailDone || !live || !selection },
  );
  // Identical polls keep one object, so the chart keeps its identity.
  const polled = useStableData(detailRaw);
  // Drawn only if it answers THIS selection (its own key) for this game and line.
  const answered = !!selection && polled?.key === selKey && detailMatches(selection, polled.detail);
  const detail = answered ? polled!.detail : null;
  const done = finalNow && answered && polled!.afterFinal;
  useEffect(() => {
    setDetailDone(done);
  }, [done]);

  // DraftKings' snapshots for the open line.
  const seriesKey = selection ? `${selection.game}|${selection.line}` : "";
  const { data: seriesRaw } = usePoll<NbaFlowBookSeries | null>(
    () => (selection ? api.getNbaFlowBookSeries(selection.game, selection.line) : Promise.resolve(null)),
    POLL_MS,
    seriesKey,
    "kalshi-flow-book-series",
    { bootIntervalMs: BOOT_POLL_MS, paused: !live || !selection },
  );
  const bookSeries = selection && detailMatches(selection, seriesRaw) ? seriesRaw : null;

  // The last answer for this game AND line, kept while a rung change loads so
  // the rung select stays mounted (focus and layout hold). A line change keeps
  // nothing: the old line's rungs must not stay selectable.
  const lastRef = useRef<NbaFlowGameDetail | null>(null);
  if (detail) lastRef.current = detail;
  const previous =
    selection && lastRef.current?.game === selection.game && lastRef.current.line === selection.line
      ? lastRef.current
      : null;

  // The chart's own switches; a new game opens on the range its phase implies.
  const [range, setRange] = useState<ChartRange>(defaultRange(phase));
  const [mode, setMode] = useState<ChartMode>("share");
  const [price, setPrice] = useState(true);
  const gameOpen = selection?.game ?? "";
  useEffect(() => {
    setRange(defaultRange(phase));
  }, [phase, gameOpen]);

  const games = slate ? sortGames(slate.games, books, source, sort) : [];
  const splits = slate ? biggestSplits(slate.games, books, source) : [];

  if (selection) {
    return (
      <FlowGameDetail
        game={selectedGame}
        book={bookGame(books, selection.game)}
        bookSeries={bookSeries}
        bands={bands}
        selection={selection}
        phase={phase}
        detail={detail}
        previous={previous}
        error={detailError}
        range={range}
        mode={mode}
        price={price}
        onRange={setRange}
        onMode={setMode}
        onPrice={setPrice}
        onLine={(line) => dispatch({ type: "setLine", line })}
        onRung={(rung) => dispatch({ type: "rung", rung })}
        onClose={() => dispatch({ type: "close" })}
      />
    );
  }

  return (
    <div>
      {books && books.games.length === 0 && source !== "kalshi" ? (
        <div style={{ ...T.bodySm, color: "var(--text-dim)", marginTop: 14 }}>
          No DraftKings splits recorded for this day - showing Kalshi only
        </div>
      ) : null}
      {booksError && !books ? (
        <div style={{ ...T.bodySm, color: "var(--text-dim)", marginTop: 14 }}>
          DraftKings splits unavailable ({fetchErrorText(booksError)}) - showing Kalshi only
          <RetryButton onClick={again} />
        </div>
      ) : null}
      {slate == null && error ? (
        <div className="text-dn" style={{ ...T.bodySm, marginTop: 14 }}>
          {fetchErrorText(error)}
          <RetryButton onClick={again} />
        </div>
      ) : slate == null ? (
        <div className="p-6"><Spinner label="Loading NBA flow…" /></div>
      ) : slate.games.length === 0 ? (
        <div style={{ ...T.bodySm, color: "var(--text-dim)", marginTop: 14 }}>
          No NBA games on tape for {slate.date}
        </div>
      ) : (
        <>
          {error ? (
            <div className="flex items-center gap-2" style={{ ...T.bodySm, color: "var(--text-dim)", marginTop: 14 }}>
              <Chip tone="warn">refresh failing</Chip>
              {fetchErrorText(error)} - showing the last data
            </div>
          ) : null}
          <FlowSplits entries={splits} source={source} phase={phase} onOpen={(g, line) => dispatch({ type: "line", game: g, line })} />
          <FlowBoard
            games={games}
            books={books}
            source={source}
            phase={phase}
            selected={selection}
            sort={sort}
            onSort={setSort}
            onRow={(g, book) => dispatch({ type: "row", game: g, book })}
            onLine={(g, line) => dispatch({ type: "line", game: g, line })}
          />
        </>
      )}
    </div>
  );
}

/** The Positions tab: polls the combo desk and owns the kill button's state. */
function PositionsTab({ env, onEnv }: { env: ComboDeskEnv; onEnv: (e: ComboDeskEnv) => void }) {
  // A kill or unkill bumps this so the desk is read again at once (the view on
  // screen stays until the new answer lands).
  const [refresh, setRefresh] = useState(0);
  const [killState, setKillState] = useState<KillState>("idle");
  const { data, error } = usePoll<ComboDeskView>(
    () => api.getComboDesk(env),
    DESK_POLL_MS,
    `${env}|${refresh}`,
    "combo-desk",
    { bootIntervalMs: BOOT_POLL_MS },
  );
  // The last answer for THIS account, held across a refresh and drawn only for the account on screen.
  const lastRef = useRef<ComboDeskView | null>(null);
  if (data && data.env === env) lastRef.current = data;
  const view = data && data.env === env ? data : lastRef.current?.env === env ? lastRef.current : null;

  // A switch of account forgets the other account's confirm or error.
  useEffect(() => {
    setKillState("idle");
  }, [env]);

  const act = (call: (e: ComboDeskEnv) => Promise<unknown>) => {
    setKillState("busy");
    call(env).then(
      () => {
        setKillState("idle");
        setRefresh((n) => n + 1);
      },
      (e: unknown) => setKillState({ error: killErrorText(String(e)) }),
    );
  };
  return (
    <DeskPositions
      view={view}
      error={error}
      env={env}
      onEnv={onEnv}
      onKill={() => act(api.comboDeskKill)}
      onUnkill={() => act(api.comboDeskUnkill)}
      killState={killState}
      onKillState={setKillState}
    />
  );
}

/** The Portfolio tab: polls the desk's money over time for the account on screen. */
function PortfolioTab({ env, onEnv }: { env: ComboDeskEnv; onEnv: (e: ComboDeskEnv) => void }) {
  const { data, error } = usePoll<ComboPortfolio>(
    () => api.getComboPortfolio(env),
    PORTFOLIO_POLL_MS,
    env,
    "combo-portfolio",
    { bootIntervalMs: BOOT_POLL_MS },
  );
  // The last answer for THIS account, held across a refresh and drawn only for the account on screen.
  const lastRef = useRef<ComboPortfolio | null>(null);
  if (data && data.env === env) lastRef.current = data;
  const portfolio = data && data.env === env ? data : lastRef.current?.env === env ? lastRef.current : null;
  return <DeskPortfolio portfolio={portfolio} error={error} env={env} onEnv={onEnv} />;
}

/** The date stepper: back a day, the day, forward a day, and a way home. */
function DateStepper({ date, onDate }: { date: string; onDate: (d: string) => void }) {
  const today = todayEt();
  const step = { ...T.body, background: "transparent", border: 0, padding: "0 6px", cursor: "pointer", color: "var(--text-muted)" } as const;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button type="button" aria-label="previous day" style={step} onClick={() => onDate(shiftDate(date, -1))}>
        {"‹"}
      </button>
      <label style={{ ...T.mono, position: "relative", color: "var(--text-primary)", cursor: "pointer" }}>
        {fmtDateLabel(date)}
        <input
          type="date"
          aria-label="date"
          value={date}
          onClick={(e) => (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.()}
          onChange={(e) => e.target.value && onDate(e.target.value)}
          style={{ position: "absolute", inset: 0, width: "100%", opacity: 0, cursor: "pointer" }}
        />
      </label>
      <button type="button" aria-label="next day" style={step} onClick={() => onDate(shiftDate(date, 1))}>
        {"›"}
      </button>
      {date !== today ? (
        <button type="button" style={{ ...T.bodySm, background: "transparent", border: 0, padding: 0, cursor: "pointer", color: "var(--accent)" }} onClick={() => onDate(today)}>
          Today
        </button>
      ) : null}
    </div>
  );
}

export default function KalshiTrading() {
  const [tab, setTab] = useState<Tab>("flow");
  // The desk's account lives here too, so Flow -> Positions -> Portfolio keeps it.
  const [deskEnv, setDeskEnv] = useState<ComboDeskEnv>("demo");
  // Lifted so Flow -> Positions -> Flow keeps the day, the phase, the source and the open game.
  const [date, setDate] = useState(() => todayEt());
  const [phase, setPhase] = useState<NbaFlowPhase>("pregame");
  const [source, setSource] = useState<FlowSource>("kalshi");
  const [sort, setSort] = useState<BoardSort>("tip");
  const [selection, dispatch] = useReducer(selectionReducer, null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo?.(0, 0);
  }, [selection?.game]);
  const tabStyle = (on: boolean) =>
    ({
      ...T.body,
      background: "transparent",
      border: 0,
      borderBottom: `2px solid ${on ? "var(--text-primary)" : "transparent"}`,
      padding: "4px 0",
      cursor: "pointer",
      color: on ? "var(--text-primary)" : "var(--text-muted)",
    }) as const;
  return (
    <div ref={scroller} className="flex h-full min-h-0 flex-col overflow-auto" style={{ padding: "20px 24px 40px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
        <h1 style={{ ...T.title, margin: 0, color: "var(--text-primary)" }}>Kalshi Trading</h1>
        {/* The Flow controls belong to the Flow tab; the desk has its own Demo / Live switch. */}
        {tab === "flow" ? (
          <>
            <Seg
              label="sport"
              value="nba"
              options={[
                { key: "nba", label: "NBA" },
                { key: "nfl", label: "NFL", disabled: true, title: "later" },
                { key: "props", label: "Props", disabled: true, title: "later" },
              ]}
            />
            <DateStepper
              date={date}
              onDate={(d) => {
                setDate(d);
                dispatch({ type: "close" });
              }}
            />
            <Seg
              label="phase"
              value={phase}
              onChange={setPhase}
              options={[
                { key: "pregame", label: "Before tip" },
                { key: "all", label: "Whole game" },
              ]}
            />
            <Seg
              label="source"
              title={SOURCE_HELP[source]}
              value={source}
              onChange={setSource}
              options={SOURCES.map((s) => ({ key: s.key, label: s.label }))}
            />
          </>
        ) : null}
        <div style={{ display: "flex", gap: 18, marginLeft: "auto" }} role="tablist" aria-label="view">
          <button type="button" role="tab" aria-selected={tab === "flow"} style={tabStyle(tab === "flow")} onClick={() => setTab("flow")}>
            Flow
          </button>
          <button type="button" role="tab" aria-selected={tab === "positions"} style={tabStyle(tab === "positions")} onClick={() => setTab("positions")}>
            Positions
          </button>
          <button type="button" role="tab" aria-selected={tab === "portfolio"} style={tabStyle(tab === "portfolio")} onClick={() => setTab("portfolio")}>
            Portfolio
          </button>
        </div>
      </div>
      {tab === "flow" ? (
        <FlowTab date={date} phase={phase} source={source} sort={sort} selection={selection} dispatch={dispatch} setSort={setSort} />
      ) : (
        <div style={{ marginTop: 18 }}>
          {tab === "positions" ? <PositionsTab env={deskEnv} onEnv={setDeskEnv} /> : <PortfolioTab env={deskEnv} onEnv={setDeskEnv} />}
        </div>
      )}
    </div>
  );
}
