/**
 * Kalshi Trading / Portfolio - the combo desk's money over time (SWIT-139) as a
 * BOARD: one row of figures, ONE chart (cash balance and cumulative realized
 * P&L), a row of daily realized P&L bars, and the by-strategy table (one quiet
 * line when nothing is tagged). No box per cell; a section with nothing in it
 * folds to one quiet line. Hook-free: the page owns the poll, the chart owns
 * its cursor and width.
 */

import type { CSSProperties } from "react";
import type { ComboDeskEnv, ComboPortfolio } from "../../api/client";
import { fetchErrorText } from "../../lib/kalshiFlow";
import {
  buildSeries,
  dailyBars,
  portfolioFigures,
  strategyFold,
  strategyRows,
} from "../../lib/comboPortfolio";
import { T } from "../../../../lib/typeScale";
import PortfolioChart, { CASH_INK, DailyBars, PNL_INK } from "./PortfolioChart";
import Seg from "./Seg";
import { HAIRLINE } from "./flowInk";

export interface DeskPortfolioProps {
  portfolio: ComboPortfolio | null;
  /** The poll's last failure (any shape; drawn through fetchErrorText). */
  error: unknown;
  env: ComboDeskEnv;
  onEnv: (env: ComboDeskEnv) => void;
}

const MONO: CSSProperties = { ...T.mono, color: "var(--text-primary)" };
const QUIET: CSSProperties = { ...T.label, fontWeight: 400, letterSpacing: "normal", color: "var(--text-dim)" };
const AMBER: CSSProperties = { ...T.bodySm, color: "var(--tone-amber)" };
const INK = { up: "var(--up)", dn: "var(--dn)" } as const;

const STRAT_COLS = "minmax(0,1fr) 80px 60px 60px 100px";

const row = (cols: string): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: cols,
  columnGap: 12,
  alignItems: "baseline",
  padding: "8px 0",
  borderBottom: HAIRLINE,
});

function SectionHead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "28px 0 10px", flexWrap: "wrap" }}>
      <h3 style={{ ...T.heading, margin: 0, color: "var(--text-primary)" }}>{title}</h3>
      {meta ? <span style={QUIET}>{meta}</span> : null}
    </div>
  );
}

function Fig({ value, label, ink }: { value: string; label: string; ink?: string }) {
  return (
    <div>
      <div style={{ ...T.metric, color: ink ?? "var(--text-primary)" }}>{value}</div>
      <div style={{ ...T.bodySm, color: "var(--text-muted)" }}>{label}</div>
    </div>
  );
}

const Empty = ({ children }: { children: string }) => <div style={{ ...QUIET, padding: "4px 0" }}>{children}</div>;

/** A swatch and a name: what a line on the chart is. */
function Key({ ink, dashed, children }: { ink: string; dashed?: boolean; children: string }) {
  return (
    <span style={{ ...T.bodySm, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 6 }}>
      <i aria-hidden style={{ display: "inline-block", width: 18, height: 0, borderTop: `2px ${dashed ? "dashed" : "solid"} ${ink}` }} />
      {children}
    </span>
  );
}

export default function DeskPortfolio({ portfolio, error, env, onEnv }: DeskPortfolioProps) {
  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <Seg
        label="account"
        value={env}
        onChange={onEnv}
        options={[
          { key: "demo", label: "Demo" },
          { key: "live", label: "Live" },
        ]}
      />
    </div>
  );
  const failure = error ? <div style={{ ...AMBER, marginTop: 12 }}>{fetchErrorText(String(error))}</div> : null;

  if (!portfolio) {
    return (
      <div>
        {header}
        {failure ?? <div style={{ ...QUIET, marginTop: 14 }}>loading the portfolio</div>}
      </div>
    );
  }

  const figures = portfolioFigures(portfolio);
  const series = buildSeries(portfolio);
  const bars = dailyBars(portfolio);
  const fold = strategyFold(portfolio);
  const strategies = fold ? [] : strategyRows(portfolio);
  const nothing = !series && bars.length === 0;

  return (
    <div>
      {header}
      {failure}

      <div style={{ display: "flex", gap: 44, flexWrap: "wrap", marginTop: 18 }}>
        {figures.map((f) => (
          <Fig key={f.key} value={f.value} label={f.label} ink={f.tone ? INK[f.tone] : undefined} />
        ))}
      </div>

      {nothing ? (
        <div style={{ marginTop: 22 }}>
          <Empty>no settled tickets yet</Empty>
        </div>
      ) : (
        <>
          {series ? (
            <>
              <SectionHead title="Balance and P&L" meta="cash on the left axis, realized P&L on the right" />
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 6 }}>
                {series.cash.length ? <Key ink={CASH_INK}>Cash balance</Key> : null}
                {series.pnl.length ? <Key ink={PNL_INK}>Cumulative realized P&amp;L</Key> : null}
                {series.pnl.length ? (
                  <Key ink={PNL_INK} dashed>
                    P&amp;L zero
                  </Key>
                ) : null}
              </div>
              <PortfolioChart series={series} />
            </>
          ) : null}

          <SectionHead title="Daily P&L" meta="realized, by settlement day" />
          {bars.length ? <DailyBars bars={bars} /> : <Empty>no settled tickets yet</Empty>}
        </>
      )}

      <SectionHead title="By strategy" />
      {fold ? (
        <Empty>{fold}</Empty>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: STRAT_COLS, columnGap: 12, padding: "0 0 4px", borderBottom: HAIRLINE }}>
            {["strategy", "tickets", "won", "lost", "P&L"].map((l, i) => (
              <span key={l} style={{ ...QUIET, textAlign: i === 4 ? "right" : undefined }}>
                {l}
              </span>
            ))}
          </div>
          {strategies.map((r) => (
            <div key={r.key} style={row(STRAT_COLS)} data-strategy={r.tag}>
              <span style={{ ...T.body, color: r.tagged ? "var(--text-primary)" : "var(--text-dim)" }}>{r.tag}</span>
              <span style={MONO}>{r.tickets}</span>
              <span style={MONO}>{r.won}</span>
              <span style={MONO}>{r.lost}</span>
              <span style={{ ...T.mono, textAlign: "right", color: r.pnlTone ? INK[r.pnlTone] : "var(--text-primary)" }}>{r.pnl}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
