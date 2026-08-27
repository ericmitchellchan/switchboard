/**
 * Market card (Markets redesign, mockup Direction A): a glanceable unit for
 * the browse grid — label, sport dot, open→close move, swing, and a lazy
 * sparkline (win-prob arc) fetched from the TTL-cached summary endpoint only
 * when the card mounts. Single accent hue, no axes (sparkline spec).
 */

import { useEffect, useState } from "react";
import { api, type HistoricalMarket, type MarketHistorySummary } from "../../api/client";

function sportColor(ticker: string): string {
  if (ticker.startsWith("KXNBA")) return "#d18f5a";
  if (ticker.startsWith("KXMLB")) return "#c9a75a";
  if (/^KX(ATP|WTA)/.test(ticker)) return "#6fb38a";
  return "#a78bcf";
}

function fmtDay(ts: string): string {
  const d = new Date(ts);
  return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`;
}

export default function MarketCard({
  m,
  onOpen,
}: {
  m: HistoricalMarket;
  onOpen: (m: HistoricalMarket) => void;
}) {
  const [summary, setSummary] = useState<MarketHistorySummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getMarketHistorySummary(m.ticker)
      .then((s) => !cancelled && setSummary(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [m.ticker]);

  const color = sportColor(m.ticker);
  const pts = (summary?.points ?? []).filter((p) => p.prob != null);
  // Normalize to the series' OWN range: a market living between 14c and 16c
  // must still show its shape, not a flat line on a 0..100c axis. When the
  // series is truly flat we say so instead of drawing a fake line.
  const probs = pts.map((p) => p.prob as number);
  const lo = probs.length ? Math.min(...probs) : 0;
  const hi = probs.length ? Math.max(...probs) : 1;
  const isFlat = probs.length >= 2 && hi - lo < 0.005;
  const spark =
    pts.length >= 2 && !isFlat
      ? pts
          .map((p, i) => {
            const x = (i / (pts.length - 1)) * 116 + 2;
            const y = 29 - (((p.prob as number) - lo) / (hi - lo)) * 26;
            return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")
      : null;
  const openC = summary?.open_prob != null ? Math.round(summary.open_prob * 100) : null;
  const closeC = summary?.close_prob != null ? Math.round(summary.close_prob * 100) : null;
  const delta = openC != null && closeC != null ? closeC - openC : null;
  const rangeLo = Math.round(lo * 100);
  const rangeHi = Math.round(hi * 100);

  return (
    <button
      type="button"
      onClick={() => onOpen(m)}
      className="group relative overflow-hidden rounded-lg border border-line bg-bg p-3 text-left transition-colors hover:border-accent"
    >
      <div className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />
      <div className="flex items-baseline gap-2 pl-1.5">
        <span className="min-w-0 flex-1 truncate text-sm text-text">{m.label}</span>
        {closeC != null ? (
          <span className="shrink-0 font-mono text-base text-text">{closeC}¢</span>
        ) : null}
        {delta != null ? (
          <span
            className={`shrink-0 font-mono text-[11px] ${
              delta > 0 ? "text-up" : delta < 0 ? "text-dn" : "text-dim"
            }`}
          >
            {delta > 0 ? `+${delta}¢` : delta < 0 ? `${delta}¢` : "unch"}
          </span>
        ) : null}
      </div>
      <div className="mt-1 flex items-end gap-3 pl-1.5">
        <div className="min-w-0 flex-1">
          {summary == null ? (
            <div className="h-8 w-[120px] animate-pulse rounded bg-surface2/60" />
          ) : spark ? (
            <svg width="120" height="32" viewBox="0 0 120 32" className="block">
              <path d={spark} fill="none" stroke={color} strokeWidth="1.4" />
            </svg>
          ) : (
            <div className="flex h-8 items-center font-mono text-[10px] text-dim">
              flat at {closeC ?? "?"}¢ over the capture
            </div>
          )}
        </div>
        <div className="shrink-0 text-right font-mono text-[10px] text-dim">
          {probs.length >= 2 && !isFlat ? <div>range {rangeLo}–{rangeHi}¢</div> : null}
          <div>
            {m.rows.toLocaleString()} ticks · {fmtDay(m.last_ts)}
          </div>
        </div>
      </div>
      <div className="pointer-events-none absolute right-2 top-2 text-dim opacity-0 transition-opacity group-hover:opacity-100">
        →
      </div>
    </button>
  );
}
