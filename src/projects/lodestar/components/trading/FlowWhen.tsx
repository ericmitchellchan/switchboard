/**
 * Kalshi Trading / Flow - "When the money came in" (SWIT-130): the same tape
 * cut by how far ahead of the tip each bet came in, with the left side's share
 * of bets and of money inside each window. Eric's question is whether early
 * bets carry a signal; this table only lays the numbers out and claims
 * nothing. Hook-free.
 */

import { fmtBets, fmtMoney, fmtPct, shortSide, type WhenRow } from "../../lib/kalshiFlow";
import { T } from "../../../../lib/typeScale";
import { HAIRLINE } from "./flowInk";

export default function FlowWhen({ rows, left }: { rows: readonly WhenRow[]; left: string }) {
  if (rows.length === 0) {
    return <div style={{ ...T.bodySm, color: "var(--text-faint)" }}>no bets on tape for this line</div>;
  }
  const th = { ...T.label, fontWeight: 400, letterSpacing: "normal", color: "var(--text-dim)", textAlign: "right", padding: "0 0 6px", borderBottom: HAIRLINE } as const;
  const td = { ...T.mono, color: "var(--text-secondary)", textAlign: "right", padding: "6px 0", borderBottom: "1px solid var(--bg-active)" } as const;
  return (
    <table aria-label="bets by how far ahead of the tip they came in" style={{ width: "100%", maxWidth: 760, borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th scope="col" style={{ ...th, textAlign: "left" }}>came in</th>
          <th scope="col" style={th}>bets</th>
          <th scope="col" style={th}>handle</th>
          <th scope="col" style={th}>{`${shortSide(left)} share of bets`}</th>
          <th scope="col" style={th}>{`${shortSide(left)} share of money`}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.bucket} data-when={r.bucket}>
            <th scope="row" style={{ ...T.bodySm, fontWeight: 400, color: "var(--text-secondary)", textAlign: "left", padding: "6px 0", borderBottom: "1px solid var(--bg-active)" }}>
              {r.label}
            </th>
            <td style={td}>{fmtBets(r.bets)}</td>
            <td style={td}>{fmtMoney(r.handle)}</td>
            <td style={td}>{fmtPct(r.leftBetPct)}</td>
            <td style={td}>{r.leftMoneyPct == null ? "-" : fmtPct(r.leftMoneyPct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
