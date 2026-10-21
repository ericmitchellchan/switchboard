/**
 * Kalshi Trading / Flow - "Who bet what size" (SWIT-130): for each bet-size
 * bucket, how many bets and how many dollars each side took. Bars grow out from
 * the size label, left side to the left (blue), right side to the right
 * (amber), on one scale. Hook-free.
 */

import { fmtCount, fmtMoney, shortSide, type SizeMixRow } from "../../lib/kalshiFlow";
import { T } from "../../../../lib/typeScale";
import { SIDE_INK } from "./flowInk";

const CELL = { ...T.label, fontWeight: 400, letterSpacing: "normal" } as const;

export default function FlowSizes({ rows, a, b }: { rows: readonly SizeMixRow[]; a: string; b: string }) {
  const maxH = Math.max(1, ...rows.flatMap((r) => [r.a.handle, r.b.handle]));
  const bar = (handle: number, tone: "a" | "b") => (
    <i
      aria-hidden
      style={{ display: "block", height: 10, borderRadius: 2, width: `${(handle / maxH) * 100}%`, minWidth: handle > 0 ? 2 : 0, background: SIDE_INK[tone] }}
    />
  );
  return (
    <div
      role="table"
      aria-label="bets and dollars by bet size"
      style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 70px minmax(0,1fr)", rowGap: 8, columnGap: 10, alignItems: "center" }}
    >
      <span role="columnheader" style={{ ...CELL, textAlign: "right", color: "var(--text-dim)" }}>{shortSide(a)}</span>
      <span role="columnheader" style={{ ...CELL, textAlign: "center", color: "var(--text-dim)" }}>bet size</span>
      <span role="columnheader" style={{ ...CELL, color: "var(--text-dim)" }}>{shortSide(b)}</span>
      {rows.map((r) => (
        <div key={r.bucket} role="row" data-size-bucket={r.bucket} style={{ display: "contents" }}>
          <span role="cell" style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6 }}>
            <span style={{ ...CELL, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              {fmtCount(r.a.bets)} {"·"} {fmtMoney(r.a.handle)}
            </span>
            <span style={{ display: "flex", justifyContent: "flex-end", flex: "0 1 55%" }}>{bar(r.a.handle, "a")}</span>
          </span>
          <span role="rowheader" style={{ ...CELL, textAlign: "center", color: "var(--text-secondary)" }}>{r.bucket}</span>
          <span role="cell" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ display: "flex", flex: "0 1 55%" }}>{bar(r.b.handle, "b")}</span>
            <span style={{ ...CELL, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              {fmtMoney(r.b.handle)} {"·"} {fmtCount(r.b.bets)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
