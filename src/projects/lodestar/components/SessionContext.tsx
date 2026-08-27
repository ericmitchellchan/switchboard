/**
 * Financial session context panel — server-computed `get_market_session_context`
 * (LODE-58), the financial analog of NbaGameContext/TennisMatchContext: a
 * persistent session header + tabs (Overview / Levels / Dealer Flow / Swings /
 * Regimes). All numbers come precomputed from the backend — nothing is
 * calculated here. Crossing/swing/flip rows with a wall-clock ts pin that
 * moment on the session chart.
 */

import { useState } from "react";
import type { LevelCross, MarketSessionContext, SessionSwing } from "../api/client";

function pctSigned(p: number | null | undefined): string {
  if (p == null) return "—";
  const v = p * 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function px(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Big dollar magnitudes (GEX/HIRO/premium) — compact $1.2B / -$340M style. */
function usd(n: number | null | undefined): string {
  if (n == null) return "—";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function fmtTime(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

interface MomentRowProps {
  label: string;
  detail: string;
  tone?: string; // text color class for the detail accent
  ts: string | null;
  onSelect?: (ts: string) => void;
  activeTs?: string | null;
}

function MomentRow({ label, detail, tone = "text-dim", ts, onSelect, activeTs }: MomentRowProps) {
  const clickable = !!(ts && onSelect);
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => ts && onSelect?.(ts)}
      className={`flex w-full items-baseline justify-between gap-3 rounded px-1 py-0.5 text-left text-sm ${
        clickable ? "hover:bg-surface2" : "cursor-default"
      } ${ts && activeTs === ts ? "bg-surface2" : ""}`}
    >
      <span className="text-text">{label}</span>
      <span className={`shrink-0 font-mono text-xs ${tone}`}>{detail}</span>
    </button>
  );
}

interface PanelProps {
  ctx: MarketSessionContext;
  onSelectMoment?: (ts: string) => void;
  selectedTs?: string | null;
}

export default function SessionContextPanel({ ctx, onSelectMoment, selectedTs }: PanelProps) {
  const day = ctx.day;

  const tabs = [
    { id: "overview", label: "Overview", show: !!day || !!ctx.flow },
    { id: "levels", label: "Levels", show: ctx.levels.length > 0 || ctx.crossings.length > 0 },
    { id: "flow", label: "Dealer Flow", show: !!ctx.gex || !!ctx.hiro },
    { id: "swings", label: "Swings", show: ctx.swings.length > 0 },
    { id: "regimes", label: "Regimes", show: ctx.regimes.length > 0 },
  ].filter((t) => t.show);

  const [tab, setTab] = useState("overview");
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id;

  const crossRow = (c: LevelCross, i: number) => (
    <MomentRow
      key={`x-${i}`}
      label={`${c.direction === "up" ? "↑ crossed above" : "↓ crossed below"} ${c.label}`}
      detail={`${px(c.price)} · ${fmtTime(c.ts)}`}
      tone={c.direction === "up" ? "text-up" : "text-dn"}
      ts={c.ts}
      onSelect={onSelectMoment}
      activeTs={selectedTs}
    />
  );

  const swingRow = (s: SessionSwing, i: number) => (
    <MomentRow
      key={`sw-${i}`}
      label={`${fmtTime(s.ts)} · ${px(s.open)} → ${px(s.close)}`}
      detail={`${s.move > 0 ? "+" : ""}${px(s.move)} pts${s.move_pct != null ? ` · ${pctSigned(s.move_pct)}` : ""}`}
      tone={s.move > 0 ? "text-up" : "text-dn"}
      ts={s.ts}
      onSelect={onSelectMoment}
      activeTs={selectedTs}
    />
  );

  return (
    <div className="space-y-3 rounded-md border border-line bg-bg p-3">
      {/* persistent session header */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-base text-text">
          {ctx.contract} · {ctx.date ?? "—"}
        </span>
        {day && (
          <>
            <span className={`font-mono text-sm ${(day.change_pct ?? 0) >= 0 ? "text-up" : "text-dn"}`}>
              {pctSigned(day.change_pct)}
            </span>
            <span className="text-dim">·</span>
            <span className="text-sm text-dim">range {pctSigned(day.range_pct).replace("+", "")}</span>
          </>
        )}
        {ctx.etf && <span className="text-xs text-dim">options via {ctx.etf}</span>}
      </div>

      {/* tab bar */}
      {tabs.length > 0 && (
        <div className="flex gap-1 border-b border-line">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-2 py-1 font-mono text-[11px] uppercase tracking-wide transition-colors ${
                active === t.id ? "border-accent text-text" : "border-transparent text-dim hover:text-text"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* OVERVIEW */}
      {active === "overview" && (
        <div className="space-y-3">
          {day && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-sm">
              <span className="text-dim">O <span className="text-text">{px(day.open)}</span></span>
              <span className="text-dim">H <span className="text-text">{px(day.high)}</span></span>
              <span className="text-dim">L <span className="text-text">{px(day.low)}</span></span>
              <span className="text-dim">C <span className="text-text">{px(day.close)}</span></span>
              <span className="text-dim">gap <span className="text-text">{pctSigned(day.gap_pct)}</span></span>
              <span className="text-dim">prev close <span className="text-text">{px(day.prev_close)}</span></span>
            </div>
          )}
          {ctx.flow && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs">
              <span className="text-dim">NOPE close <span className="text-text">{ctx.flow.nope_last?.toFixed(2) ?? "—"}</span></span>
              <span className="text-dim">NOPE range <span className="text-text">{ctx.flow.nope_min?.toFixed(1) ?? "—"}…{ctx.flow.nope_max?.toFixed(1) ?? "—"}</span></span>
              <span className="text-dim">net call prem <span className="text-text">{usd(ctx.flow.net_call_premium)}</span></span>
              <span className="text-dim">net put prem <span className="text-text">{usd(ctx.flow.net_put_premium)}</span></span>
              <span className="text-dim">
                call/put vol{" "}
                <span className="text-text">
                  {ctx.flow.call_volume?.toLocaleString() ?? "—"} / {ctx.flow.put_volume?.toLocaleString() ?? "—"}
                </span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* LEVELS + CROSSINGS */}
      {active === "levels" && (
        <div className="space-y-3">
          {ctx.levels.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-dim">
                dealer positioning ({ctx.contract} scale)
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-sm">
                {ctx.levels.map((l) => (
                  <span key={l.key} className="text-dim">
                    {l.label} <span className="text-text">{px(l.price)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {ctx.crossings.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-dim">
                level crossings ({ctx.crossings.length})
              </div>
              {ctx.crossings.map(crossRow)}
            </div>
          )}
          {ctx.levels.length === 0 && <div className="text-sm text-dim">no gamma levels for this date</div>}
        </div>
      )}

      {/* DEALER FLOW (GEX + HIRO) */}
      {active === "flow" && (
        <div className="space-y-3">
          {ctx.gex && (
            <div className="space-y-0.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-dim">
                spot GEX ({ctx.etf ?? "ETF"})
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs">
                <span className="text-dim">open <span className="text-text">{usd(ctx.gex.open_gex)}</span></span>
                <span className="text-dim">close <span className="text-text">{usd(ctx.gex.close_gex)}</span></span>
                <span className="text-dim">range <span className="text-text">{usd(ctx.gex.min_gex)}…{usd(ctx.gex.max_gex)}</span></span>
                <span className="text-dim">sign flips <span className="text-text">{ctx.gex.sign_flips}</span></span>
              </div>
              {ctx.gex.first_flip_ts && (
                <MomentRow
                  label="first gamma sign flip"
                  detail={fmtTime(ctx.gex.first_flip_ts)}
                  tone="text-accent"
                  ts={ctx.gex.first_flip_ts}
                  onSelect={onSelectMoment}
                  activeTs={selectedTs}
                />
              )}
            </div>
          )}
          {ctx.hiro && (
            <div className="space-y-0.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-dim">
                HIRO — dealer hedging flow
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs">
                <span className="text-dim">cumulative <span className="text-text">{usd(ctx.hiro.cum_end)}</span></span>
                <span className="text-dim">day range <span className="text-text">{usd(ctx.hiro.cum_min)}…{usd(ctx.hiro.cum_max)}</span></span>
              </div>
              {ctx.hiro.burst_ts && (
                <MomentRow
                  label="biggest 5-min flow burst"
                  detail={`${usd(ctx.hiro.burst_value)} · ${fmtTime(ctx.hiro.burst_ts)}`}
                  tone={(ctx.hiro.burst_value ?? 0) >= 0 ? "text-up" : "text-dn"}
                  ts={ctx.hiro.burst_ts}
                  onSelect={onSelectMoment}
                  activeTs={selectedTs}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* BIGGEST 5-MIN MOVES */}
      {active === "swings" && <div className="space-y-0.5">{ctx.swings.map(swingRow)}</div>}

      {/* REGIMES (populated once Orbit computes labels) */}
      {active === "regimes" && (
        <div className="space-y-0.5">
          {ctx.regimes.map((r, i) => (
            <MomentRow
              key={`rg-${i}`}
              label={`${r.regime ?? "?"}${r.timeframe ? ` · ${r.timeframe}` : ""}`}
              detail={`${fmtTime(r.ts)}${r.confidence != null ? ` · ${Math.round(r.confidence * 100)}%` : ""}`}
              ts={r.ts}
              onSelect={onSelectMoment}
              activeTs={selectedTs}
            />
          ))}
        </div>
      )}

      {ctx.note && <div className="text-xs text-dim">{ctx.note}</div>}
    </div>
  );
}
