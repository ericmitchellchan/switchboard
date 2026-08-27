/**
 * Trading desk dashboard (desk-dashboards epic phase 1, owner pin 20260731-140628):
 * the top-level answer to "what kind of day is it?" — composed ENTIRELY from
 * existing lanes (sessions, futures-scale gamma, archetype edge book). All of it
 * is snapshot data and says so: last-session tiles, never a live pretense
 * (decision 2026-07-31; live waits for the real feed). No movers widget — no
 * financial Kalshi series in the capture set.
 */

import { api, type ContextTables, type GammaLevels, type SessionSummary } from "../../api/client";
import { useCachedFetch } from "../../lib/queryCache";

/** July-2026 audit rules — standing guardrails, rendered as chips. */
const GUARDRAILS = ["fuse always-on", "late = half-size or zero", "warm knives banned"];

function pct(r: number | null): string {
  return r == null ? "—" : `${r >= 0 ? "+" : ""}${(r * 100).toFixed(2)}%`;
}

function Tile({ k, v, d, tone }: { k: string; v: string; d: string; tone?: "up" | "dn" }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3.5 py-2.5">
      <div className="font-mono text-[9.5px] uppercase tracking-wider text-dim">{k}</div>
      <div className="mt-0.5 font-mono text-lg text-text">{v}</div>
      <div className={`font-mono text-[10px] ${tone === "up" ? "text-up" : tone === "dn" ? "text-dn" : "text-dim"}`}>{d}</div>
    </div>
  );
}

/** Exported so the Overview can compose the same lanes under the SAME cache key —
 *  landing on either surface warms the other (that shared key IS the fluidity). */
export type TradingDashData = {
  es: SessionSummary | null;
  nq: SessionSummary | null;
  gamma: GammaLevels | null;
  tables: ContextTables | null;
};

/** allSettled, not all: one dead lane must still render the other three (the
 *  pre-existing behaviour — preserved now that the four share a cache entry). */
export async function fetchTradingDash(): Promise<TradingDashData> {
  const [esR, nqR, gR, tR] = await Promise.allSettled([
    api.getMarketSessions("ES", 1),
    api.getMarketSessions("NQ", 1),
    api.getGammaFuture("ES"),
    api.getTradeContextTables(),
  ]);
  // Everything failing is an ERROR, not a value. Returning `allFailed: true`
  // looked like a SUCCESS to useCachedFetch, which cached that empty dashboard
  // at module scope and never revalidated it — so the surface kept rendering
  // "backend unreachable" long after the backend was healthy (owner-reported
  // 2026-08-02). Throwing hands it to the hook's retry instead.
  if ([esR, nqR, gR, tR].every((r) => r.status === "rejected")) {
    throw new Error(String(esR.status === "rejected" ? esR.reason : "all lanes failed"));
  }
  return {
    es: esR.status === "fulfilled" ? esR.value[0] ?? null : null,
    nq: nqR.status === "fulfilled" ? nqR.value[0] ?? null : null,
    gamma: gR.status === "fulfilled" ? gR.value : null,
    tables: tR.status === "fulfilled" ? tR.value : null,
  };
}

export default function TradingDash() {
  const { data, error, refreshing, reload } = useCachedFetch<TradingDashData>(
    "dashboard:trading",
    fetchTradingDash,
  );
  const es = data?.es ?? null;
  const nq = data?.nq ?? null;
  const gamma = data?.gamma ?? null;
  const tables = data?.tables ?? null;
  const err = error ? "backend unreachable" : null;

  const flipDelta = es && gamma?.zero_gamma != null ? es.close - gamma.zero_gamma : null;
  const ladder = gamma
    ? (
        [
          ["call wall", gamma.call_wall],
          ["gamma flip", gamma.zero_gamma],
          ["vol trigger", gamma.vol_trigger],
          ["put wall", gamma.put_wall],
        ] as const
      ).filter(([, price]) => price != null)
    : [];
  const edgeBook = tables?.edge_book ?? [];
  const archetypes = (tables?.archetype ?? []).slice(0, 6);

  return (
    <div className="max-w-5xl">
      <div className="mb-3 flex items-center gap-3">
        <span className="font-mono text-[10px] text-dim">
          last session{es ? ` · ${es.date}` : ""} · snapshot data, not live
        </span>
        <button type="button" onClick={() => reload()} className="ml-auto font-mono text-[10px] uppercase text-dim hover:text-text">
          {refreshing ? "refreshing…" : "refresh"}
        </button>
      </div>
      {err ? <div className="rounded-lg border border-dashed border-line p-4 text-sm text-dim">{err}</div> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          k="ES · last close"
          v={es ? es.close.toFixed(2) : "—"}
          d={es ? pct(es.change_pct) : "no session data"}
          tone={es?.change_pct != null ? (es.change_pct >= 0 ? "up" : "dn") : undefined}
        />
        <Tile
          k="NQ · last close"
          v={nq ? nq.close.toFixed(2) : "—"}
          d={nq ? pct(nq.change_pct) : "no session data"}
          tone={nq?.change_pct != null ? (nq.change_pct >= 0 ? "up" : "dn") : undefined}
        />
        <Tile
          k="ES gamma flip"
          v={gamma?.zero_gamma != null ? gamma.zero_gamma.toFixed(0) : "—"}
          d={flipDelta != null ? `close ${flipDelta >= 0 ? "+" : ""}${flipDelta.toFixed(0)} ${flipDelta >= 0 ? "above · positive-γ" : "below · negative-γ"}` : gamma?.reason ?? "no gamma data"}
        />
        <Tile
          k="ES day range"
          v={es ? `${es.low.toFixed(0)}–${es.high.toFixed(0)}` : "—"}
          d={es?.range_pct != null ? `${(es.range_pct * 100).toFixed(2)}% range` : ""}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface p-3.5">
          <div className="text-xs font-medium text-text">Gamma ladder · ES (futures scale)</div>
          <div className="mb-2 font-mono text-[9.5px] text-dim">
            {gamma?.date ?? ""} {gamma?.source ? `· ${gamma.source}` : ""}
          </div>
          {ladder.length === 0 ? (
            <div className="text-xs text-dim">{gamma?.reason ?? "no gamma levels for the latest session"}</div>
          ) : (
            ladder.map(([label, price]) => {
              const delta = es && price != null ? es.close - price : null;
              return (
                <div key={label} className="flex items-center gap-2 border-b border-dashed border-line py-1.5 last:border-b-0">
                  <span className="w-24 font-mono text-[10px] uppercase tracking-wide text-dim">{label}</span>
                  <span className="font-mono text-xs text-text">{price!.toFixed(0)}</span>
                  <span className="ml-auto font-mono text-[10px] text-dim">
                    {delta != null ? `close ${delta >= 0 ? "+" : ""}${delta.toFixed(0)}` : ""}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="rounded-lg border border-line bg-surface p-3.5">
          <div className="text-xs font-medium text-text">Edge book</div>
          <div className="mb-2 font-mono text-[9.5px] text-dim">historical archetype performance · July-audit guardrails standing</div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {GUARDRAILS.map((g) => (
              <span key={g} className="rounded border border-line px-1.5 py-px font-mono text-[9px] text-dim">{g}</span>
            ))}
          </div>
          {edgeBook.map((b) => (
            <div key={b.bucket} className="flex items-center gap-2 border-b border-dashed border-line py-1.5">
              <span className="w-14 font-mono text-[10px] uppercase text-dim">{b.bucket}</span>
              <span className="font-mono text-[10px] text-dim">n={b.n}</span>
              <span className={`ml-auto font-mono text-xs ${b.net_usd >= 0 ? "text-up" : "text-dn"}`}>
                {b.net_usd >= 0 ? "+" : "−"}${Math.abs(b.net_usd).toFixed(0)}
              </span>
              <span className="w-12 text-right font-mono text-[10px] text-dim">{(b.win_rate * 100).toFixed(0)}%</span>
            </div>
          ))}
          {archetypes.map((a) => (
            <div key={a.bucket} className="flex items-center gap-2 py-1">
              <span className="truncate text-[11.5px] text-text">{a.bucket}</span>
              <span className="font-mono text-[9.5px] text-dim">n={a.n}</span>
              <span className={`ml-auto font-mono text-[10.5px] ${a.net_usd >= 0 ? "text-up" : "text-dn"}`}>
                {a.net_usd >= 0 ? "+" : "−"}${Math.abs(a.net_usd).toFixed(0)}
              </span>
              <span className="w-12 text-right font-mono text-[9.5px] text-dim">{(a.win_rate * 100).toFixed(0)}%</span>
            </div>
          ))}
          {!tables ? <div className="text-xs text-dim">no trading-audit data loaded</div> : null}
        </div>
      </div>
    </div>
  );
}
