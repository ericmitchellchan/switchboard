/**
 * Command — the morning-brief surface: live session metrics, firing triggers
 * (the agent's nudge signals), and current opportunities. Read-only.
 */

import Panel from "../components/Panel";
import { usePoll } from "../hooks/usePoll";
import { api } from "../api/client";

function fmtMoney(v: string): string {
  const n = Number(v);
  return Number.isNaN(n) ? v : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const sevColor: Record<string, string> = { ALERT: "text-dn", WARN: "text-accent", INFO: "text-dim" };

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-dim text-xs">{label}</div>
      <div className={`font-mono text-lg ${tone ?? "text-text"}`}>{value}</div>
    </div>
  );
}

export default function Command() {
  const { data: m, error } = usePoll(api.getMetrics, 2000);
  const { data: triggers } = usePoll(api.getTriggers, 2000);
  const { data: opps } = usePoll(api.getOpportunities, 4000);

  const net = m ? Number(m.net_pnl) : 0;

  return (
    <div className="space-y-4">
      <h1 className="font-mono text-lg font-medium tracking-tight">Command</h1>

      <Panel title="session">
        {error ? (
          <div className="text-sm text-dn">backend unreachable — run the backend ({String(error)})</div>
        ) : m ? (
          <div className="flex flex-wrap gap-8">
            <Tile label="positions" value={String(m.position_count)} />
            <Tile label="gross max-loss" value={fmtMoney(m.gross_max_loss)} tone="text-dn" />
            <Tile label="net P&L" value={fmtMoney(m.net_pnl)} tone={net >= 0 ? "text-up" : "text-dn"} />
            <Tile label={`orders / ${m.window_seconds}s`} value={String(m.orders_in_window)} />
            <Tile label="journal" value={String(m.journal_count)} />
          </div>
        ) : (
          <div className="text-sm text-dim">loading…</div>
        )}
      </Panel>

      <Panel title="triggers (nudges)">
        {triggers && triggers.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {triggers.map((t) => (
              <li key={t.rule_id} className="flex items-baseline gap-2">
                <span className={`font-mono text-xs uppercase ${sevColor[t.severity] ?? "text-dim"}`}>
                  {t.severity}
                </span>
                <span className="text-text">{t.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-dim">no active triggers</div>
        )}
      </Panel>

      <Panel title="opportunities">
        {opps && opps.length > 0 ? (
          <ul className="space-y-1.5 text-sm">
            {opps.map((o) => (
              <li key={o.opportunity_id} className="flex items-baseline gap-2 font-mono">
                <span className="text-dim text-xs uppercase">{o.kind}</span>
                {o.direction && <span className="text-text">{o.direction}</span>}
                {o.score != null && <span className="text-liq">{o.score.toFixed(2)}</span>}
                <span className="text-dim">{o.rationale}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-dim">no opportunities</div>
        )}
      </Panel>
    </div>
  );
}
