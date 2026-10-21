/**
 * Kalshi Trading / Flow - the games table (SWIT-130). One row per game; for
 * each of ML / Spread / Total a cell that sets TICKETS against MONEY per side,
 * the way the public (many small tickets) separates from the sharps (few large
 * ones).
 *
 * Presentational and hook-free on purpose: props in, markup out. That is what
 * lets the render test call it as a plain function and read the element tree.
 *
 * Structure and keyboard: a list of games. The row (li) takes the mouse click;
 * the matchup is the row's real button (its click bubbles to the row), and each
 * line cell is its own button that stops the bubble. Nothing interactive is
 * nested inside another. A cell is role=button, so a screen reader reads its
 * aria-label (every number with its meaning), not the bars inside it.
 *
 * Dataviz choices. Each side is one labelled row holding two thin bars on a
 * shared 0..100 track: tickets (neutral ink) and money (the series tone). The
 * same metric keeps the same tone in every cell, so colour only ever says
 * "tickets vs money"; WHICH SIDE is always the row label, never a colour. A
 * gap between the two bars IS the finding, so both bars start at the same
 * left edge on the same scale and the percentages are printed. The lean and
 * the result are text chips, not a tint.
 */

import type { MouseEvent, ReactNode } from "react";
import type { NbaFlowGame, NbaFlowLine, NbaFlowLineKey, NbaFlowPhase, NbaFlowSide } from "../../api/client";
import {
  LINE_KEYS,
  LINE_LABEL,
  OUTAGE_CHIP,
  bigTotals,
  fmtBets,
  fmtGap,
  fmtMoney,
  fmtPct,
  fmtPriceMove,
  fmtTip,
  isHandleIncomplete,
  leanLabel,
  leanOutcome,
  leanOutcomeLabel,
  lineAriaLabel,
  resultLabel,
  rungText,
  scoreLabel,
  type FlowSelection,
} from "../../lib/kalshiFlow";
import { T } from "../../../../lib/typeScale";
import Chip from "./Chip";

export interface FlowGamesTableProps {
  games: readonly NbaFlowGame[];
  selected: FlowSelection | null;
  /** In pregame mode a line with no pregame bets may still have in-play bets,
   *  so its cell stays openable (the detail shows the whole tape). */
  phase: NbaFlowPhase;
  onRow: (g: NbaFlowGame) => void;
  onLine: (g: NbaFlowGame, line: NbaFlowLineKey) => void;
}

const TICKET_INK = "var(--dim2)";
const MONEY_INK = "var(--chart-1)";

function Track({ pct, ink }: { pct: number; ink: string }) {
  const w = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  return (
    <div className="h-1.5 rounded-sm bg-surface2" aria-hidden>
      <div className="h-full rounded-sm" style={{ width: `${w}%`, background: ink }} />
    </div>
  );
}

const SIDE_GRID = { gridTemplateColumns: "minmax(0,6rem) minmax(0,1fr) 2.5rem minmax(0,1fr) 2.5rem" } as const;

function SideRow({ s, leaning }: { s: NbaFlowSide; leaning: boolean }) {
  const title =
    `${s.side}: ${fmtBets(s.bets)}, ${fmtMoney(s.handle)} handle; ` +
    `$1k+ bets ${s.big_bets} (${fmtMoney(s.big_handle)}); ` +
    `price ${fmtPriceMove(s.price_first, s.price_last)}; money minus tickets ${fmtGap(s.gap)} pts`;
  return (
    <div className="grid items-center gap-x-2 gap-y-0.5" style={SIDE_GRID} title={title} data-side={s.side}>
      <span className="truncate" style={{ ...T.bodySm, color: leaning ? "var(--text)" : "var(--dim)", fontWeight: leaning ? 600 : 400 }}>
        {s.side}
      </span>
      <Track pct={s.ticket_pct} ink={TICKET_INK} />
      <span style={{ ...T.mono, color: "var(--dim)" }}>{fmtPct(s.ticket_pct)}</span>
      <Track pct={s.money_pct} ink={MONEY_INK} />
      <span style={{ ...T.mono, color: "var(--text)" }}>{fmtPct(s.money_pct)}</span>
    </div>
  );
}

const CELL = "min-w-0 flex-1 basis-[16rem] rounded-md border px-3 py-2 text-left";

function CellButton({
  g,
  lineKey,
  label,
  active,
  anchorSuffix,
  onLine,
  children,
}: {
  g: NbaFlowGame;
  lineKey: NbaFlowLineKey;
  label: string;
  active: boolean;
  anchorSuffix: string;
  onLine: FlowGamesTableProps["onLine"];
  children: ReactNode;
}) {
  return (
    // SWITCHBOARD: `data-anchor` makes the cell pinnable (surfaces/anchors.ts).
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={label}
      className={`${CELL} cursor-pointer hover:bg-surface2/40 ${active ? "border-accent bg-surface2/40" : "border-line"}`}
      data-line={lineKey}
      data-anchor={`line:${g.game}:${lineKey}`}
      data-anchor-label={`${g.away} @ ${g.home} · ${LINE_LABEL[lineKey]}${anchorSuffix}`}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onLine(g, lineKey);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onLine(g, lineKey);
        }
      }}
    >
      {children}
    </div>
  );
}

function LineCell({
  g,
  lineKey,
  line,
  active,
  phase,
  onLine,
}: {
  g: NbaFlowGame;
  lineKey: NbaFlowLineKey;
  line: NbaFlowLine | null;
  active: boolean;
  phase: NbaFlowPhase;
  onLine: FlowGamesTableProps["onLine"];
}) {
  if (!line) {
    if (phase === "pregame") {
      // Nothing before the tip - but the line may have in-play bets, and the
      // detail covers the whole tape, so the cell still opens it.
      return (
        <CellButton
          g={g}
          lineKey={lineKey}
          label={`${LINE_LABEL[lineKey]}: no pregame bets. Opens the game detail for the whole tape.`}
          active={active}
          anchorSuffix=""
          onLine={onLine}
        >
          <span style={{ ...T.kicker, color: "var(--dim2)" }}>{LINE_LABEL[lineKey]}</span>
          <div style={{ ...T.bodySm, color: "var(--dim2)" }}>no pregame bets</div>
        </CellButton>
      );
    }
    return (
      <div className={`${CELL} border-dashed border-line`} data-line={lineKey}>
        <span style={{ ...T.kicker, color: "var(--dim2)" }}>{LINE_LABEL[lineKey]}</span>
        <div style={{ ...T.bodySm, color: "var(--dim2)" }}>no bets on tape</div>
      </div>
    );
  }
  const rung = rungText(line);
  const lean = leanLabel(line);
  const outcome = leanOutcome(line);
  const outcomeText = leanOutcomeLabel(outcome);
  const result = resultLabel(line);
  const big = bigTotals(line);
  return (
    <CellButton
      g={g}
      lineKey={lineKey}
      label={lineAriaLabel(lineKey, line)}
      active={active}
      anchorSuffix={rung ? ` ${rung}` : ""}
      onLine={onLine}
    >
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span style={{ ...T.kicker, color: "var(--dim)" }}>{LINE_LABEL[lineKey]}</span>
        <span style={{ ...T.mono, color: "var(--text)" }}>{rung}</span>
      </div>
      <div className="grid gap-x-2" style={{ ...SIDE_GRID, ...T.caption, color: "var(--dim2)" }} aria-hidden>
        <span />
        <span style={{ gridColumn: "span 2" }}>% of bets</span>
        <span style={{ gridColumn: "span 2" }}>% of money</span>
      </div>
      <div className="flex flex-col gap-1">
        {line.sides.map((s) => (
          <SideRow key={s.side} s={s} leaning={s.side === line.lean} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span style={{ ...T.mono, color: "var(--dim)" }}>
          {fmtBets(line.bets)} · {fmtMoney(line.handle)}
        </span>
        {big.bets > 0 ? (
          <span style={{ ...T.mono, color: "var(--dim)" }} title="bets of $1,000 or more">
            $1k+ {fmtBets(big.bets)} · {fmtMoney(big.handle)}
          </span>
        ) : null}
        {lean ? <Chip tone="accent" title="money share beats ticket share by 10+ points">{lean}</Chip> : null}
        {result ? (
          <Chip tone={outcome === "won" ? "up" : outcome === "lost" ? "dn" : "dim"}>
            {outcomeText ? `${result} · ${outcomeText}` : result}
          </Chip>
        ) : null}
      </div>
    </CellButton>
  );
}

function statusChip(g: NbaFlowGame) {
  if (g.status === "live") return <Chip tone="accent">live</Chip>;
  if (g.status === "final") return <Chip>final</Chip>;
  return <Chip>scheduled</Chip>;
}

export default function FlowGamesTable({ games, selected, phase, onRow, onLine }: FlowGamesTableProps) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="NBA games by line">
      {games.map((g) => {
        const open = selected?.game === g.game;
        const score = scoreLabel(g);
        return (
          // SWITCHBOARD: `data-anchor` makes the row pinnable (surfaces/anchors.ts).
          // The click handler is the mouse convenience; the keyboard way in is
          // the matchup button, whose click bubbles up to it.
          <li
            key={g.game}
            className={`flex cursor-pointer flex-wrap gap-2 rounded-lg border p-2 hover:bg-surface2/30 ${open ? "border-accent" : "border-line"}`}
            data-game={g.game}
            data-anchor={`game:${g.game}`}
            data-anchor-label={`${g.away} @ ${g.home}`}
            onClick={() => onRow(g)}
          >
            <div className="flex w-40 shrink-0 flex-col items-start gap-1 px-1 py-1">
              <button
                type="button"
                aria-expanded={open}
                className="text-left"
                style={{ ...T.subheading, color: "var(--text)" }}
                title="open the game detail"
              >
                {g.away} @ {g.home}
              </button>
              <span style={{ ...T.mono, color: "var(--dim)" }}>{fmtTip(g.tip_utc)}</span>
              <div className="flex flex-wrap items-center gap-1">
                {statusChip(g)}
                {score ? <span style={{ ...T.mono, color: "var(--text)" }}>{score}</span> : null}
              </div>
              {isHandleIncomplete(g.price_zero_share) ? <Chip tone="warn">{OUTAGE_CHIP}</Chip> : null}
            </div>
            {LINE_KEYS.map((k) => (
              <LineCell
                key={k}
                g={g}
                lineKey={k}
                line={g.lines[k]}
                active={open && selected?.line === k}
                phase={phase}
                onLine={onLine}
              />
            ))}
          </li>
        );
      })}
    </ul>
  );
}
