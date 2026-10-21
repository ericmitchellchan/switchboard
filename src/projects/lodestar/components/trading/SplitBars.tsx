/**
 * Kalshi Trading / Flow - the pair of bars that IS the finding (SWIT-130): one
 * for the share of bets (faded), one for the share of money (solid). Each bar
 * is the two sides end to end - left side blue from the left, right side amber
 * - so a money bar longer than its bets bar on one side reads at a glance.
 *
 * A thin white tick marks the OTHER source's share (DraftKings on a Kalshi bar,
 * Kalshi on a DraftKings bar). Hook-free.
 */

import type { CSSProperties } from "react";
import { fmtPct } from "../../lib/kalshiFlow";
import { T } from "../../../../lib/typeScale";
import { SIDE_INK } from "./flowInk";

const ROW: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "44px 30px minmax(0,1fr) 30px",
  alignItems: "center",
  columnGap: 6,
  marginTop: 5,
};

/** One bar: `a` is the left side's share (0..100), the right side gets the rest. */
export function SplitBar({ a, faded, tick }: { a: number; faded?: boolean; tick?: number | null }) {
  const left = Math.max(0, Math.min(100, Number.isFinite(a) ? a : 0));
  const seg = { display: "block", height: "100%", opacity: faded ? 0.45 : 1 } as const;
  return (
    <span
      aria-hidden
      style={{ position: "relative", display: "flex", gap: 2, height: 6, borderRadius: 3, overflow: "visible" }}
    >
      <span style={{ display: "flex", flex: 1, gap: 2, borderRadius: 3, overflow: "hidden" }}>
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

/** "bets  47%  [bar]  53%" - the label, the left share, the bar, the right share. */
export function SplitRow({
  label,
  a,
  faded,
  tick,
}: {
  label: string;
  a: number;
  faded?: boolean;
  tick?: number | null;
}) {
  // The two printed shares always add to 100: round the left, the right is the rest.
  const left = Number.isFinite(a) ? Math.max(0, Math.min(100, Math.round(a))) : NaN;
  return (
    <div style={{ ...ROW, ...T.label, fontWeight: 400, letterSpacing: "normal" }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>{fmtPct(left)}</span>
      <SplitBar a={a} faded={faded} tick={tick} />
      <span style={{ color: "var(--text-secondary)" }}>{fmtPct(100 - left)}</span>
    </div>
  );
}

/** "bets  [bar]  47%" - ONE side's share on its own tone: the strip's bar,
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
