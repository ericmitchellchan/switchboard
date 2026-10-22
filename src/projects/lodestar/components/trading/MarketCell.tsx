/**
 * Kalshi Trading / Flow - one market cell on the board (SWIT-130): the two
 * sides with their price, a faded bets bar over a solid money bar, and a foot
 * with the counts and the quiet "$ -> side" chip. No box: the board draws one
 * hairline between games and nothing else.
 *
 * Hook-free on purpose: props in, markup out, so the render test can call it
 * as a plain function and read the element tree. The cell is one button whose
 * aria-label says every number with its meaning; the bars inside are
 * presentational.
 */

import type { MouseEvent } from "react";
import type { NbaFlowGame, NbaFlowLineKey } from "../../api/client";
import {
  LINE_LABEL,
  cellAriaLabel,
  dkLine,
  fmtBets,
  fmtMoney,
  kalshiLine,
  leanChip,
  type CellModel,
  type CellSide,
} from "../../lib/kalshiFlow";
import { T } from "../../../../lib/typeScale";
import { SIDE_INK } from "./flowInk";
import { SplitRow, splitTitle } from "./SplitBars";

export interface MarketCellProps {
  game: NbaFlowGame;
  lineKey: NbaFlowLineKey;
  /** Null: no source has the market. */
  cell: CellModel | null;
  active: boolean;
  /** Pregame: a market with no bets BEFORE the tip may still have in-game bets. */
  pregame: boolean;
  onLine: (g: NbaFlowGame, line: NbaFlowLineKey) => void;
}

function SideLabel({ s, tone, flip }: { s: CellSide; tone: "a" | "b"; flip?: boolean }) {
  const price =
    s.price != null ? (
      <span style={{ ...T.mono, color: "var(--text-muted)" }}>{`${Math.round(s.price)}¢`}</span>
    ) : null;
  const name = (
    <span style={{ ...T.bodySm, color: "var(--text-primary)" }} data-side={s.side}>
      <span
        aria-hidden
        style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", marginRight: 5, verticalAlign: 1, background: SIDE_INK[tone] }}
      />
      {s.short}
      {s.won ? <span style={{ color: "var(--up)" }}>{" ✓"}</span> : null}
    </span>
  );
  return (
    <span style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
      {flip ? price : name}
      {flip ? name : price}
    </span>
  );
}

export function LeanChip({ cell }: { cell: CellModel }) {
  const chip = leanChip(cell);
  if (!chip) return null;
  return (
    <span
      title={`money share beats bet share by ${Math.round(cell.lean?.gap ?? 0)} points`}
      style={{
        ...T.label,
        fontWeight: 400,
        letterSpacing: "normal",
        padding: chip.loud ? "0 6px" : 0,
        borderRadius: 4,
        color: chip.loud ? "var(--accent)" : "var(--text-muted)",
        background: chip.loud ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
      }}
    >
      {chip.text}
    </span>
  );
}

export default function MarketCell({ game, lineKey, cell, active, pregame, onLine }: MarketCellProps) {
  if (!cell) {
    return (
      <div data-line={lineKey} style={{ ...T.bodySm, color: "var(--text-faint)" }}>
        {pregame ? "No bets before the tip" : "No bets recorded"}
      </div>
    );
  }
  const open = () => onLine(game, lineKey);
  const quiet = [dkLine(cell) ?? kalshiLine(cell), cell.note, cell.dkLine ? `DK line ${cell.dkLine}` : null].filter(Boolean);
  const foot =
    cell.bets != null && cell.handle != null ? `${fmtBets(cell.bets)} · ${fmtMoney(cell.handle)}` : "No dollar figures";
  return (
    // SWITCHBOARD: `data-anchor` makes the cell pinnable (surfaces/anchors.ts).
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={cellAriaLabel(cell)}
      data-line={lineKey}
      data-drawn={cell.drawn}
      data-anchor={`line:${game.game}:${lineKey}`}
      data-anchor-label={`${game.away} @ ${game.home} · ${LINE_LABEL[lineKey]}${cell.rung ? ` ${cell.rung}` : ""}`}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        open();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          open();
        }
      }}
      style={{
        cursor: "pointer",
        borderRadius: 6,
        padding: "4px 8px",
        margin: "-4px -8px",
        background: active ? "var(--bg-hover)" : undefined,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <SideLabel s={cell.a} tone="a" />
        <SideLabel s={cell.b} tone="b" flip />
      </div>
      <SplitRow label="Bets" a={cell.a.betsPct} faded tick={cell.a.tickBetsPct} title={splitTitle(cell, "bets")} />
      <SplitRow label="Money" a={cell.a.moneyPct} tick={cell.a.tickMoneyPct} title={splitTitle(cell, "money")} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
        <span style={{ ...T.label, fontWeight: 400, letterSpacing: "normal", color: "var(--text-dim)" }}>{foot}</span>
        <LeanChip cell={cell} />
      </div>
      {quiet.length > 0 ? (
        <div style={{ ...T.label, fontWeight: 400, letterSpacing: "normal", color: "var(--text-dim)", marginTop: 4 }}>
          {quiet.join(" · ")}
        </div>
      ) : null}
    </div>
  );
}
