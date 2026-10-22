/**
 * Kalshi Trading / Flow - the $1k+ bets (SWIT-130): the real individual bets,
 * oldest first, each with its side, dollars, contracts and the price it paid.
 * One hairline under the head, a faint one between rows. Hook-free.
 */

import type { NbaFlowBigBet } from "../../api/client";
import { fmtCount, fmtEt, fmtMoney, shortSide } from "../../lib/kalshiFlow";
import { T } from "../../../../lib/typeScale";
import { HAIRLINE, SIDE_INK } from "./flowInk";

export default function FlowBigBets({ bets, a }: { bets: readonly NbaFlowBigBet[]; a: string }) {
  if (bets.length === 0) {
    return <div style={{ ...T.bodySm, color: "var(--text-faint)" }}>no $1k+ bets on this line</div>;
  }
  const th = { ...T.label, fontWeight: 400, letterSpacing: "normal", color: "var(--text-dim)", textAlign: "left", padding: "0 0 6px", borderBottom: HAIRLINE } as const;
  const td = { ...T.mono, color: "var(--text-secondary)", padding: "6px 0", borderBottom: "1px solid var(--bg-active)" } as const;
  return (
    <div style={{ maxHeight: 420, overflowY: "auto" }}>
      <table aria-label="$1k+ bets" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th scope="col" style={th}>Time (ET)</th>
            <th scope="col" style={th}>Side</th>
            <th scope="col" style={{ ...th, textAlign: "right" }}>Bet</th>
            <th scope="col" style={{ ...th, textAlign: "right" }}>Contracts</th>
            <th scope="col" style={{ ...th, textAlign: "right" }}>Price</th>
          </tr>
        </thead>
        <tbody>
          {bets.map((z) => (
            <tr key={`${z.ts}|${z.side}|${z.dollars}|${z.contracts}`} data-big-bet={z.phase}>
              <td style={td}>
                {fmtEt(z.ts, true)}
                {z.phase === "live" ? " · live" : ""}
              </td>
              <td style={td}>
                <span
                  aria-hidden
                  style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", marginRight: 6, verticalAlign: 1, background: z.side === a ? SIDE_INK.a : SIDE_INK.b }}
                />
                {shortSide(z.side)}
              </td>
              <td style={{ ...td, textAlign: "right", color: "var(--text-primary)" }}>{fmtMoney(z.dollars)}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtCount(z.contracts)}</td>
              <td style={{ ...td, textAlign: "right" }}>{z.price == null ? "-" : `${Math.round(z.price)}¢`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
