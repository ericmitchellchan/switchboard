/**
 * Portfolio — fetches GET /portfolio from the T2 backend and renders positions
 * with the shared max-loss column plus the gross/concentration risk summary.
 */

import Panel from "../components/Panel";
import { usePoll } from "../hooks/usePoll";
import { api, type Portfolio as PortfolioData } from "../api/client";

function fmtMoney(value: string | null): string {
  if (value === null) return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function Portfolio() {
  // SWITCHBOARD: a 5s poll (active-gated, page-api) instead of one fetch on
  // mount — in a keep-alive host a one-shot page never saw a sim fill.
  const { data, error } = usePoll<PortfolioData>(api.getPortfolio, 5000);
  const loading = data === null && error === null;

  return (
    <div className="space-y-4">
      <h1 className="font-mono text-lg font-medium tracking-tight">Portfolio</h1>

      <Panel title="risk">
        {data ? (
          <div className="flex flex-wrap gap-6 font-mono text-sm">
            <div>
              <div className="text-dim text-xs">gross max-loss</div>
              <div className="text-text">{fmtMoney(data.risk.gross_max_loss)}</div>
            </div>
            <div>
              <div className="text-dim text-xs">fully computable</div>
              <div className={data.risk.fully_computable ? "text-up" : "text-dn"}>
                {data.risk.fully_computable ? "yes" : "no"}
              </div>
            </div>
            <div>
              <div className="text-dim text-xs">undefined</div>
              <div className="text-text">{data.risk.undefined_positions.length}</div>
            </div>
            <div>
              <div className="text-dim text-xs">concentration flags</div>
              <div className={data.risk.concentration_flags.length ? "text-dn" : "text-text"}>
                {data.risk.concentration_flags.length}
              </div>
            </div>
          </div>
        ) : (
          <span className="text-sm text-dim">—</span>
        )}
      </Panel>

      <Panel title="positions">
        {loading ? (
          <div className="text-sm text-dim">loading…</div>
        ) : error ? (
          <div className="text-sm text-dn">
            backend unreachable ({error}). Start the T2 backend on 127.0.0.1:8799.
          </div>
        ) : data && data.positions.length > 0 ? (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left font-mono text-xs uppercase text-dim">
                <th className="border-b border-line py-2 pr-3 font-normal">Symbol</th>
                <th className="border-b border-line py-2 pr-3 font-normal">Class</th>
                <th className="border-b border-line py-2 pr-3 font-normal">Side</th>
                <th className="border-b border-line py-2 pr-3 text-right font-normal">Qty</th>
                <th className="border-b border-line py-2 pr-3 text-right font-normal">Entry</th>
                <th className="border-b border-line py-2 pr-3 text-right font-normal">Max loss</th>
                <th className="border-b border-line py-2 pr-3 font-normal">Risk kind</th>
                <th className="border-b border-line py-2 font-normal">Source</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {data.positions.map((p) => (
                <tr key={p.position_id} className="text-text">
                  <td className="border-b border-line/50 py-1.5 pr-3">{p.symbol}</td>
                  <td className="border-b border-line/50 py-1.5 pr-3 text-dim">{p.asset_class}</td>
                  <td className="border-b border-line/50 py-1.5 pr-3 text-dim">
                    {p.venue_side ?? "—"}
                  </td>
                  <td className="border-b border-line/50 py-1.5 pr-3 text-right">{p.quantity}</td>
                  <td className="border-b border-line/50 py-1.5 pr-3 text-right">
                    {p.avg_entry_price}
                  </td>
                  <td className="border-b border-line/50 py-1.5 pr-3 text-right text-dn">
                    {fmtMoney(p.max_loss)}
                  </td>
                  <td className="border-b border-line/50 py-1.5 pr-3 text-dim">{p.risk_kind}</td>
                  <td className="border-b border-line/50 py-1.5 text-dim">{p.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-sm text-dim">no positions</div>
        )}
      </Panel>
    </div>
  );
}
