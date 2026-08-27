/**
 * Kalshi cockpit — the P0 venue surface. Order ticket (YES/NO + size + price)
 * drives SIM trades via the backend /sim endpoints; shows live positions (with
 * close) and a custom win-probability chart. Stage A: sim only, human-driven.
 */

import { useEffect, useRef, useState } from "react";
import { useSurfaceActive } from "../../../surfaces/page-api";
import Panel from "../components/Panel";
import WinProbChart, { type ChartPoint } from "../components/WinProbChart";
import { usePoll } from "../hooks/usePoll";
import { api } from "../api/client";

function fmtMoney(v: string | null): string {
  if (v === null) return "—";
  const n = Number(v);
  return Number.isNaN(n) ? v : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function KalshiCockpit() {
  const active = useSurfaceActive();
  const [ticker, setTicker] = useState("KXNBAGAME-LAL");
  const [side, setSide] = useState<"YES" | "NO">("YES");
  const [qty, setQty] = useState(50);
  const [price, setPrice] = useState(50);
  const [bid, setBid] = useState(44);
  const [ask, setAsk] = useState(46);
  const [status, setStatus] = useState<string | null>(null);
  const [series, setSeries] = useState<ChartPoint[]>([]);

  const { data: positions } = usePoll(api.getPositions, 2000);

  // Accumulate a win-prob series from the selected market's mid (reset per ticker).
  // SWITCHBOARD: split like usePoll — a TICKER change resets the series and
  // takes one quote; the INTERVAL runs only while the surface is on screen
  // (page-api useSurfaceActive) and going off-screen keeps the last points.
  // A GENERATION per ticker: a late quote for the previous ticker (its request
  // resolving after the reset) is dropped instead of landing in the new series.
  const genRef = useRef(0);
  const tick = (gen: number): void => {
    api
      .getQuote(ticker)
      .then((q) => {
        if (genRef.current !== gen) return;
        const prob = (q.best_bid + q.best_ask) / 2 / 100;
        setSeries((prev) => [...prev, { label: new Date().toLocaleTimeString(), prob }].slice(-60));
      })
      .catch(() => {
        /* no quote for this ticker yet */
      });
  };
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    genRef.current += 1;
    setSeries([]);
    tickRef.current(genRef.current);
    return () => {
      genRef.current += 1; // anything still in flight for this ticker is stale
    };
  }, [ticker]);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => tickRef.current(genRef.current), 2000);
    return () => clearInterval(id);
  }, [ticker, active]);

  async function setMarket(): Promise<void> {
    setStatus("setting market…");
    try {
      await api.setQuote({ ticker, best_bid: bid, best_ask: ask });
      setStatus(`market set ${bid}/${ask}`);
    } catch (err) {
      setStatus(`error: ${String(err)}`);
    }
  }

  async function placeOrder(): Promise<void> {
    setStatus("placing…");
    try {
      const res = await api.submitIntent({ ticker, venue_side: side, quantity: qty, limit_price: price });
      setStatus(
        res.filled
          ? `filled ${qty} ${side} @ ${res.order.fills[0]?.price}c`
          : `not filled: ${res.reject_reason ?? "unknown"}`,
      );
    } catch (err) {
      setStatus(`error: ${String(err)}`);
    }
  }

  async function close(positionId: string): Promise<void> {
    setStatus("closing…");
    try {
      const res = await api.closePosition(positionId);
      setStatus(`closed ${positionId} · realized ${fmtMoney(res.realized_pnl)}`);
    } catch (err) {
      setStatus(`error: ${String(err)}`);
    }
  }

  const numCls =
    "w-20 rounded border border-line bg-bg px-2 py-1 font-mono text-sm text-text focus:border-accent focus:outline-none";

  return (
    <div className="space-y-4">
      <h1 className="font-mono text-lg font-medium tracking-tight">Kalshi</h1>

      <Panel title={`win probability — ${ticker}`}>
        <WinProbChart points={series} />
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="order ticket (sim)">
          <div className="space-y-3 text-sm">
            <label className="flex items-center justify-between gap-2">
              <span className="text-dim">ticker</span>
              <input
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                className="flex-1 rounded border border-line bg-bg px-2 py-1 font-mono text-sm text-text focus:border-accent focus:outline-none"
              />
            </label>

            <div className="flex items-center gap-2">
              <span className="text-dim">side</span>
              {(["YES", "NO"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  className={`rounded px-3 py-1 font-mono text-xs ${
                    side === s ? (s === "YES" ? "bg-up text-bg" : "bg-dn text-bg") : "border border-line text-dim"
                  }`}
                >
                  {s}
                </button>
              ))}
              <span className="ml-auto text-dim">qty</span>
              <input
                type="number"
                value={qty}
                onChange={(e) => setQty(Number(e.target.value))}
                className={numCls}
              />
              <span className="text-dim">limit¢</span>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(Number(e.target.value))}
                className={numCls}
              />
            </div>

            <button
              type="button"
              onClick={() => void placeOrder()}
              className="w-full rounded bg-accent px-3 py-2 text-sm font-medium text-bg"
            >
              Buy {qty} {side} @ {price}¢ (sim)
            </button>

            <div className="flex items-center gap-2 border-t border-line pt-3">
              <span className="text-dim text-xs">set market</span>
              <span className="text-dim">bid</span>
              <input type="number" value={bid} onChange={(e) => setBid(Number(e.target.value))} className={numCls} />
              <span className="text-dim">ask</span>
              <input type="number" value={ask} onChange={(e) => setAsk(Number(e.target.value))} className={numCls} />
              <button
                type="button"
                onClick={() => void setMarket()}
                className="ml-auto rounded border border-line px-3 py-1 text-xs text-dim"
              >
                Set
              </button>
            </div>

            {status ? <div className="font-mono text-xs text-liq">{status}</div> : null}
          </div>
        </Panel>

        <Panel title="positions">
          {positions && positions.length > 0 ? (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left font-mono text-xs uppercase text-dim">
                  <th className="border-b border-line py-1.5 pr-2 font-normal">Sym</th>
                  <th className="border-b border-line py-1.5 pr-2 font-normal">Side</th>
                  <th className="border-b border-line py-1.5 pr-2 text-right font-normal">Qty</th>
                  <th className="border-b border-line py-1.5 pr-2 text-right font-normal">Entry</th>
                  <th className="border-b border-line py-1.5 pr-2 text-right font-normal">Max loss</th>
                  <th className="border-b border-line py-1.5 font-normal" />
                </tr>
              </thead>
              <tbody className="font-mono">
                {positions.map((p) => (
                  <tr key={p.position_id} className="text-text">
                    <td className="border-b border-line/50 py-1.5 pr-2">{p.symbol}</td>
                    <td className="border-b border-line/50 py-1.5 pr-2 text-dim">{p.venue_side ?? "—"}</td>
                    <td className="border-b border-line/50 py-1.5 pr-2 text-right">{p.quantity}</td>
                    <td className="border-b border-line/50 py-1.5 pr-2 text-right">{p.avg_entry_price}</td>
                    <td className="border-b border-line/50 py-1.5 pr-2 text-right text-dn">{fmtMoney(p.max_loss)}</td>
                    <td className="border-b border-line/50 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => void close(p.position_id)}
                        className="rounded border border-line px-2 py-0.5 text-xs text-dim hover:text-text"
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-sm text-dim">no positions — place a sim order</div>
          )}
        </Panel>
      </div>
    </div>
  );
}
