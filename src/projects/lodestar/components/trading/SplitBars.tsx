/**
 * Kalshi Trading / Flow - the pair of bars that IS the finding (SWIT-130): one
 * for the share of bets (faded), one for the share of money (solid). Each bar
 * is the two sides end to end - left side blue from the left, right side amber
 * - so a money bar longer than its bets bar on one side reads at a glance.
 *
 * A thin white tick marks the OTHER source's share (DraftKings on a Kalshi bar,
 * Kalshi on a DraftKings bar). The 3px gap between the two segments is the
 * split itself, a divider and not a stray line. Each bar carries a native
 * tooltip with both sources' numbers (`splitTitle`). Hook-free.
 */

import type { CSSProperties } from "react";
import { fmtPct, type CellModel } from "../../lib/kalshiFlow";
import { T } from "../../../../lib/typeScale";
import { SIDE_INK } from "./flowInk";

const ROW: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "44px 30px minmax(0,1fr) 30px",
  alignItems: "center",
  columnGap: 6,
  marginTop: 7,
};

/** The gap between a bar's two side segments, px. */
const SPLIT_GAP = 3;

/** "61% / 39%": the left side's share, then the right side's, always adding to 100. */
const pair = (leftShare: number): string => {
  const l = Math.max(0, Math.min(100, Math.round(leftShare)));
  return `${l}% / ${100 - l}%`;
};

/**
 * The hover text of one bar of a cell, both sources' numbers: "Kalshi 61% /
 * 39% · DraftKings 58% / 42%". `kind` picks the bets or the money bar. The
 * second half is the white tick's source and is left out when there is no tick
 * (a lone source, or the average).
 */
export function splitTitle(cell: CellModel, kind: "bets" | "money"): string {
  const mine = kind === "bets" ? cell.a.betsPct : cell.a.moneyPct;
  const other = kind === "bets" ? cell.a.tickBetsPct : cell.a.tickMoneyPct;
  const drawnName = cell.drawn === "kalshi" ? "Kalshi" : cell.drawn === "dk" ? "DraftKings" : "Average of Kalshi and DraftKings";
  const otherName = cell.tickSource === "dk" ? "DraftKings" : "Kalshi";
  return `${drawnName} ${pair(mine)}${other != null && cell.tickSource ? ` · ${otherName} ${pair(other)}` : ""}`;
}

/** One bar: `a` is the left side's share (0..100), the right side gets the rest. */
export function SplitBar({ a, faded, tick, title }: { a: number; faded?: boolean; tick?: number | null; title?: string }) {
  const left = Math.max(0, Math.min(100, Number.isFinite(a) ? a : 0));
  const seg = { display: "block", height: "100%", opacity: faded ? 0.45 : 1 } as const;
  return (
    <span
      aria-hidden
      title={title}
      style={{ position: "relative", display: "flex", gap: SPLIT_GAP, height: 6, borderRadius: 3, overflow: "visible" }}
    >
      <span style={{ display: "flex", flex: 1, gap: SPLIT_GAP, borderRadius: 3, overflow: "hidden" }}>
        <i style={{ ...seg, width: `${left}%`, background: SIDE_INK.a }} />
        <i style={{ ...seg, width: `${100 - left}%`, background: SIDE_INK.b }} />
      </span>
      {tick != null && Number.isFinite(tick) ? (
        <span
          data-tick={Math.round(tick)}
          style={{
            position: "absolute",
            left: `${Math.max(0, Math.min(100, tick))}%`,
            top: -3,
            bottom: -3,
            width: 2,
            marginLeft: -1,
            borderRadius: 1,
            background: "var(--text-primary)",
          }}
        />
      ) : null}
    </span>
  );
}

/** "Bets  47%  [bar]  53%" - the label, the left share, the bar, the right share. */
export function SplitRow({
  label,
  a,
  faded,
  tick,
  title,
}: {
  label: string;
  a: number;
  faded?: boolean;
  tick?: number | null;
  /** Hover text for the bar (both sources' numbers). */
  title?: string;
}) {
  // The two printed shares always add to 100: round the left, the right is the rest.
  const left = Number.isFinite(a) ? Math.max(0, Math.min(100, Math.round(a))) : NaN;
  return (
    <div style={{ ...ROW, ...T.label, fontWeight: 400, letterSpacing: "normal" }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>{fmtPct(left)}</span>
      <SplitBar a={a} faded={faded} tick={tick} title={title} />
      <span style={{ color: "var(--text-secondary)" }}>{fmtPct(100 - left)}</span>
    </div>
  );
}

/** "Bets  [bar]  47%" - ONE side's share on its own tone: the strip's bar,
 *  where the side on show may be either of the two. */
export function ShareRow({
  label,
  pct,
  tone,
  faded,
  tick,
}: {
  label: string;
  pct: number;
  tone: "a" | "b";
  faded?: boolean;
  tick?: number | null;
}) {
  const w = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div style={{ ...T.label, fontWeight: 400, letterSpacing: "normal", display: "grid", gridTemplateColumns: "44px minmax(0,1fr) 34px", alignItems: "center", columnGap: 6, marginTop: 4 }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span aria-hidden style={{ position: "relative", display: "block", height: 6, borderRadius: 3, background: "var(--bg-hover)" }}>
        <i style={{ display: "block", height: "100%", width: `${w}%`, borderRadius: 3, background: SIDE_INK[tone], opacity: faded ? 0.45 : 1 }} />
        {tick != null && Number.isFinite(tick) ? (
          <span
            data-tick={Math.round(tick)}
            style={{ position: "absolute", left: `${Math.max(0, Math.min(100, tick))}%`, top: -3, bottom: -3, width: 2, marginLeft: -1, borderRadius: 1, background: "var(--text-primary)" }}
          />
        ) : null}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>{fmtPct(pct)}</span>
    </div>
  );
}
