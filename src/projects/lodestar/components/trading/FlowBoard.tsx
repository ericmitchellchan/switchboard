/**
 * Kalshi Trading / Flow - the board (SWIT-130): one row per game, three market
 * cells across (moneyline, spread, total), one hairline between rows. Nothing
 * is boxed. A row opens the game's first line; a cell opens its own line.
 *
 * Hook-free: props in, markup out (the render test reads the element tree).
 * A row is a list item whose matchup is a real button; cells are buttons that
 * stop the click so they do not also open the row.
 */

import type { NbaFlowBookGame, NbaFlowGame, NbaFlowLineKey, NbaFlowPhase } from "../../api/client";
import {
  LINE_KEYS,
  LINE_LABEL,
  OUTAGE_CHIP,
  bookGame,
  buildCell,
  fmtEt,
  isHandleIncomplete,
  type BoardSort,
  type FlowSelection,
  type FlowSource,
} from "../../lib/kalshiFlow";
import { T } from "../../../../lib/typeScale";
import Chip from "./Chip";
import { HAIRLINE } from "./flowInk";
import MarketCell from "./MarketCell";
import Seg from "./Seg";

export interface FlowBoardProps {
  games: readonly NbaFlowGame[];
  books: { games: readonly NbaFlowBookGame[] } | null;
  source: FlowSource;
  phase: NbaFlowPhase;
  selected: FlowSelection | null;
  sort: BoardSort;
  onSort: (s: BoardSort) => void;
  onRow: (g: NbaFlowGame, book: NbaFlowBookGame | undefined) => void;
  onLine: (g: NbaFlowGame, line: NbaFlowLineKey) => void;
}

const GRID = { display: "grid", gridTemplateColumns: "176px repeat(3, minmax(0,1fr))", columnGap: 28 } as const;

function Teams({ g }: { g: NbaFlowGame }) {
  const fin = g.status === "final" && g.away_score != null && g.home_score != null;
  const awayWon = fin && (g.away_score as number) > (g.home_score as number);
  const line = (code: string, score: number | null, won: boolean) => (
    <span
      style={{
        ...T.body,
        display: "flex",
        justifyContent: "space-between",
        fontWeight: fin && !won ? 400 : 500,
        color: fin && !won ? "var(--text-muted)" : "var(--text-primary)",
      }}
    >
      <span>{code}</span>
      {fin ? <span style={{ ...T.mono, color: "var(--text-secondary)" }}>{score}</span> : null}
    </span>
  );
  const when = g.status === "final" ? `final · tip ${fmtEt(g.tip_utc)}` : g.status === "live" ? `live · tip ${fmtEt(g.tip_utc)}` : `tip ${fmtEt(g.tip_utc)}`;
  return (
    <span style={{ display: "block" }}>
      {line(g.away, g.away_score, awayWon)}
      {line(g.home, g.home_score, !awayWon)}
      <span style={{ ...T.label, fontWeight: 400, letterSpacing: "normal", display: "block", color: "var(--text-dim)", marginTop: 4 }}>
        {when}
      </span>
    </span>
  );
}

export default function FlowBoard({ games, books, source, phase, selected, sort, onSort, onRow, onLine }: FlowBoardProps) {
  return (
    <div aria-label="NBA games by line">
      <div
        style={{
          ...GRID,
          ...T.kicker,
          color: "var(--text-dim)",
          padding: "0 10px 8px",
          borderBottom: HAIRLINE,
          alignItems: "end",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6, textTransform: "none", letterSpacing: 0 }}>
          sort
          <Seg
            label="sort games"
            value={sort}
            onChange={onSort}
            options={[
              { key: "tip", label: "tip" },
              { key: "handle", label: "handle" },
              { key: "gap", label: "gap" },
            ]}
          />
        </span>
        {LINE_KEYS.map((k) => (
          <span key={k}>{LINE_LABEL[k]}</span>
        ))}
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {games.map((g) => {
          const bg = bookGame(books, g.game);
          const open = selected?.game === g.game;
          return (
            // SWITCHBOARD: `data-anchor` makes the row pinnable (surfaces/anchors.ts).
            <li
              key={g.game}
              data-game={g.game}
              data-anchor={`game:${g.game}`}
              data-anchor-label={`${g.away} @ ${g.home}`}
              onClick={() => onRow(g, bg)}
              style={{
                ...GRID,
                padding: "14px 10px",
                borderBottom: HAIRLINE,
                cursor: "pointer",
                background: open ? "var(--bg-active)" : undefined,
              }}
            >
              <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
                <button
                  type="button"
                  aria-expanded={open}
                  title="open the game detail"
                  style={{ display: "block", width: "100%", textAlign: "left", background: "transparent", border: 0, padding: 0, color: "inherit" }}
                >
                  <Teams g={g} />
                </button>
                {isHandleIncomplete(g.price_zero_share) ? <Chip tone="warn">{OUTAGE_CHIP}</Chip> : null}
              </span>
              {LINE_KEYS.map((k) => (
                <MarketCell
                  key={k}
                  game={g}
                  lineKey={k}
                  cell={buildCell(g, k, g.lines[k], bg?.lines[k], source)}
                  active={open && selected?.line === k}
                  pregame={phase === "pregame"}
                  onLine={onLine}
                />
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
