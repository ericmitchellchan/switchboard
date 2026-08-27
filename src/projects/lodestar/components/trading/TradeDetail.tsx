/**
 * One REAL trade, relived (LODE-26/60): the @NQ 1-minute chart around the trade with the
 * hold window shaded and entry/exit marked BY TIME, plus the entry-context card (what led
 * in) and the outcome. ← → steps through the filtered set; Esc closes.
 *
 * Markers are time-anchored, not price-anchored: bars are the CONTINUOUS @NQ series, which
 * carries a roll-basis offset vs the traded contract — drawing entry_vwap as a price line
 * would lie near rolls. Fill prices live in the header instead.
 */

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, type Bar, type TradeRow } from "../../api/client";
import { ptTime, ptWeekday } from "../../lib/time";
import CandleChart from "../../../../surfaces/charts/CandleChart";

const UP = "#4ea96a";
const DN = "#e0645b";


function utcMs(ts: string): string | number {
  const s = ts.replace(" ", "T");
  return Date.parse(s.endsWith("Z") ? s : `${s}Z`);
}

// SWITCHBOARD: the SVG candle renderer is gone — the shared lightweight-charts
// CandleChart draws the window, with ENTRY/EXIT as markers (and publishes
// `bar:<ts>` anchors, so a candle here is pinnable).

export default function TradeDetail({
  trades,
  index,
  setIndex,
  onClose,
}: {
  trades: TradeRow[];
  index: number;
  setIndex: (i: number) => void;
  onClose: () => void;
}) {
  const t = trades[index];
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [err, setErr] = useState(false);

  const entryMs = Number(utcMs(t.start_utc));
  const exitMs = Number(utcMs(t.end_utc));

  useEffect(() => {
    setBars(null);
    setErr(false);
    // lead-in ≥ the hold, so the setup that led in is visible; cap the window for long holds
    const holdMs = Math.max(exitMs - entryMs, 10 * 60000);
    const pre = Math.min(Math.max(holdMs, 60 * 60000), 4 * 3600000);
    const post = Math.min(Math.max(holdMs / 2, 30 * 60000), 2 * 3600000);
    const from = new Date(entryMs - pre).toISOString();
    const to = new Date(exitMs + post).toISOString();
    let cancelled = false;
    api
      .getPriceWindow("NQ", from, to, "1m")
      .then((w) => !cancelled && setBars(w.bars ?? []))
      .catch(() => !cancelled && setErr(true));
    return () => {
      cancelled = true;
    };
  }, [t.trade_id, entryMs, exitMs]);


  // SWITCHBOARD COPY: the keys are handled ON the overlay, not on `window`.
  // In Lodestar this page owned the window; here the drill-in sits beside a
  // live xterm, and a window listener would flip trades (or close this) from
  // arrow keys typed into the shell. The overlay is focusable and takes focus
  // on open, so the keys work immediately and stop the moment focus leaves.
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    overlayRef.current?.focus();
  }, []);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "ArrowRight" && index < trades.length - 1) setIndex(index + 1);
    else if (e.key === "ArrowLeft" && index > 0) setIndex(index - 1);
    else if (e.key === "Escape") onClose();
    else return;
    e.stopPropagation();
  };

  const won = t.pnl_usd > 0;
  const ctx: [string, string][] = [
    ["archetype", t.archetype != null ? `${t.archetype} (${t.act10 ?? "?"} last 10m · ${t.temp_bucket ?? "?"} tape)` : "—"],
    ["time", `${ptTime(t.start_utc)} PT · ${ptWeekday(t.start_utc)} (${t.tod})`],
    ["drift 30m", t.mom30_pts != null ? `${t.mom30_pts > 0 ? "+" : ""}${t.mom30_pts} pts → ${t.trend_align}-trend` : "—"],
    ["range pos", t.pos4h != null ? `${Math.round(t.pos4h * 100)}% of 4h (${t.sess_pos})` : "—"],
    ["ATR 5m", t.atr5_entry != null ? `${t.atr5_entry} pts (${t.vol_regime} vol)` : "—"],
    ["sequence", `trade #${t.trade_no} · after ${t.after} · day ${t.day_state}`],
    ["size", `${t.peak_contracts}× ${t.symbol}`],
  ];

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      onKeyDown={onKey}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 outline-none"
      onClick={onClose}
    >
      <div className="flex max-h-full w-full max-w-5xl flex-col gap-2 rounded-lg border border-line bg-bg p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px]">
          <span className="text-sm text-text">{t.symbol} {t.direction}</span>
          <span className="text-dim">{t.date}</span>
          <span className="rounded px-1.5" style={{ background: `${won ? UP : DN}22`, color: won ? UP : DN }}>
            {won ? "+" : "−"}${Math.abs(t.pnl_usd).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
          <span
            className="rounded px-1.5 font-mono text-[10px] uppercase"
            title="edge book = the entry pockets that beat random (quiet counter / fade pop / hot-or-cold knife, first 3h of session)"
            style={t.edge_book === "edge" ? { background: `${UP}22`, color: UP } : { background: "#8a8a9322", color: "#8a8a93" }}
          >
            {t.edge_book === "edge" ? "◆ edge book" : "cloud"}
          </span>
          <span><span className="text-dim">in </span>{t.entry_vwap}</span>
          <span><span className="text-dim">out </span>{t.exit_vwap}</span>
          <span><span className="text-dim">held </span>{Math.round(t.hold_min)}m</span>
          <span className="ml-auto text-dim">{index + 1} / {trades.length}</span>
          <button type="button" onClick={() => index > 0 && setIndex(index - 1)} disabled={index === 0} className="px-1 text-dim hover:text-text disabled:opacity-40">←</button>
          <button type="button" onClick={() => index < trades.length - 1 && setIndex(index + 1)} disabled={index === trades.length - 1} className="px-1 text-dim hover:text-text disabled:opacity-40">→</button>
          <button type="button" onClick={onClose} className="text-dim hover:text-text">✕</button>
        </div>

        {/* what led into the trade */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded border border-line bg-surface/40 px-3 py-1.5 font-mono text-[10px] sm:grid-cols-3">
          {ctx.map(([k, v]) => (
            <div key={k}><span className="text-dim">{k} </span>{v}</div>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded border border-line bg-surface/40 p-2">
          {err ? (
            <div className="p-6 text-sm text-dim">couldn't load bars for this window</div>
          ) : bars == null ? (
            <div className="h-72 animate-pulse rounded bg-surface2/60" />
          ) : (
            <CandleChart
              bars={bars}
              height={340}
              intraday
              fitOnLoad
              markers={[
                { ts: new Date(entryMs).toISOString(), label: "ENTRY", tone: "accent", position: "below" },
                { ts: new Date(exitMs).toISOString(), label: "EXIT", tone: "liq", position: "above" },
              ]}
            />
          )}
        </div>
        <div className="font-mono text-[9px] text-dim2">
          continuous @NQ 1m — entry/exit marked by TIME (fill prices in the header; the continuous series has roll-basis offset) · scroll to pan · ← → next/prev trade · Esc to close
        </div>
      </div>
    </div>
  );
}
