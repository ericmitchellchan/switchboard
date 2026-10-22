/**
 * Kalshi Trading / Flow - "Biggest splits" (SWIT-130): the few lines where one
 * side's money share sits furthest above its bet share, under the source on
 * screen. A strip of four, no boxes; each opens its game detail on that line.
 * Hook-free.
 */

import type { NbaFlowGame, NbaFlowLineKey, NbaFlowPhase } from "../../api/client";
import {
  LINE_LABEL,
  SPLITS_MIN_HANDLE,
  fmtBets,
  fmtMoney,
  fmtPct,
  type FlowSource,
  type SplitEntry,
} from "../../lib/kalshiFlow";
import { T } from "../../../../lib/typeScale";
import { SIDE_INK } from "./flowInk";
import { ShareRow } from "./SplitBars";

/** What the strip ranks, per source: Kalshi and Both only lines Kalshi has bets
 *  on (with the dollar gate); DraftKings ranks its own shares, no dollars. */
export function splitsMeta(source: FlowSource, phase: NbaFlowPhase): string {
  const what =
    source === "dk"
      ? "DraftKings shares, no dollar gate"
      : `Kalshi lines with ${fmtMoney(SPLITS_MIN_HANDLE)}+ · ${source === "both" ? "avg of Kalshi + DK" : "Kalshi"}`;
  return `Money share minus bet share · ${what} · ${phase === "pregame" ? "before tip" : "whole game"}`;
}

function Entry({ e, onOpen }: { e: SplitEntry; onOpen: (g: NbaFlowGame, line: NbaFlowLineKey) => void }) {
  const { cell, side, game } = e;
  const tone = side === cell.a ? "a" : "b";
  // a tick is stored as the LEFT side's share; the strip draws the featured side's
  const shareOf = (leftShare: number) => (tone === "a" ? leftShare : 100 - leftShare);
  const res = cell.result ? (cell.result === side.side ? "Won" : cell.result === "push" ? "Push" : "Lost") : null;
  const foot =
    cell.bets != null && cell.handle != null
      ? `+${Math.round(e.gap)} pts · ${fmtMoney(cell.handle)} · ${fmtBets(cell.bets)}`
      : `+${Math.round(e.gap)} pts · no dollar figures`;
  return (
    <div
      role="button"
      tabIndex={0}
      data-split={`${game.game}:${e.line}`}
      aria-label={`${game.away} at ${game.home}, ${LINE_LABEL[e.line]}: ${side.side} has ${fmtPct(side.moneyPct)} of the money from ${fmtPct(side.betsPct)} of the bets. Opens the game detail.`}
      onClick={() => onOpen(game, e.line)}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onOpen(game, e.line);
        }
      }}
      style={{ cursor: "pointer", borderRadius: 6, padding: "6px 8px", margin: "-6px -8px" }}
    >
      <div style={{ ...T.bodySm, color: "var(--text-muted)" }}>
        {game.away} @ {game.home} {"·"} {LINE_LABEL[e.line]}
      </div>
      <div style={{ ...T.subheading, display: "flex", justifyContent: "space-between", alignItems: "baseline", color: "var(--text-primary)" }}>
        <span>
          <span
            aria-hidden
            style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", marginRight: 5, verticalAlign: 1, background: SIDE_INK[tone] }}
          />
          {side.short}
          {side.price != null ? (
            <span style={{ ...T.mono, fontWeight: 400, color: "var(--text-muted)" }}>{` ${Math.round(side.price)}¢`}</span>
          ) : null}
        </span>
        {res ? (
          <span style={{ ...T.label, fontWeight: 400, letterSpacing: "normal", color: res === "Won" ? "var(--up)" : "var(--text-dim)" }}>
            {res}
          </span>
        ) : null}
      </div>
      <ShareRow label="Bets" pct={side.betsPct} tone={tone} faded tick={side.tickBetsPct != null ? shareOf(side.tickBetsPct) : null} />
      <ShareRow label="Money" pct={side.moneyPct} tone={tone} tick={side.tickMoneyPct != null ? shareOf(side.tickMoneyPct) : null} />
      <div style={{ ...T.label, fontWeight: 400, letterSpacing: "normal", color: "var(--text-dim)", marginTop: 5 }}>{foot}</div>
    </div>
  );
}

export default function FlowSplits({
  entries,
  source,
  phase,
  onOpen,
}: {
  entries: readonly SplitEntry[];
  source: FlowSource;
  phase: NbaFlowPhase;
  onOpen: (g: NbaFlowGame, line: NbaFlowLineKey) => void;
}) {
  return (
    <section aria-label="biggest splits" style={{ margin: "20px 0 30px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h3 style={{ ...T.heading, margin: 0, color: "var(--text-primary)" }}>Biggest splits</h3>
        <span style={{ ...T.label, fontWeight: 400, letterSpacing: "normal", color: "var(--text-dim)" }}>
          {splitsMeta(source, phase)}
        </span>
      </div>
      {entries.length === 0 ? (
        <div style={{ ...T.bodySm, color: "var(--text-faint)", marginTop: 10 }}>
          No line has money ahead of its bets yet
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 32, marginTop: 14 }}>
          {entries.map((e) => (
            <Entry key={`${e.game.game}:${e.line}`} e={e} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}
