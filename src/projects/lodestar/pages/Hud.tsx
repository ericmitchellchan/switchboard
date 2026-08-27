/**
 * The trading HUD — a small always-on-top window (Switchboard-style PiP) that runs over
 * NinjaTrader while trading. Shows the tilt-guardrail state live: session clock, trade
 * count, day P&L, open position, the loss cooldown countdown, and the latest nudge —
 * and fires a Windows toast when a new nudge lands. Advisory only (Stage A).
 *
 * SWITCHBOARD: a surface page that lives in its own always-on-top window
 * (page-api `openWindow("hud")` from the Trading page; the window frame
 * supplies the drag bar and its ×, so the page has none). Polls every 2s.
 */

import { useEffect, useRef, useState } from "react";
import { api, type LiveTradeState } from "../api/client";
import { useSurfaceActive, useSurfaceNav } from "../../../surfaces/page-api";

const UP = "#4ea96a";
const DN = "#e0645b";
const AMBER = "#d1a05a";

function hms(sinceIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(sinceIso)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

export default function Hud() {
  const [st, setSt] = useState<LiveTradeState | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [now, setNow] = useState(Date.now());
  const seen = useRef<number>(0);
  const nav = useSurfaceNav();
  // SWITCHBOARD: in its own window this is always on; as a panel page a hidden
  // tab must not poll or toast (the same rule every page follows).
  const active = useSurfaceActive();
  const opened = useRef<number>(Date.now());

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const poll = (): void => {
      api.getLiveTradeState().then((s) => {
        if (cancelled) return;
        setUnreachable(false);
        // backend restarted → nudge ids restart at 1; drop the high-water so new ones toast
        const maxId = s.nudges.reduce((m, n) => Math.max(m, n.id), 0);
        if (maxId < seen.current) seen.current = 0;
        setSt(s);
        // toast NEW nudges only (id beyond high-water AND raised after the HUD opened)
        for (const n of s.nudges) {
          if (n.id > seen.current) {
            seen.current = n.id;
            if (Date.parse(n.ts) >= opened.current - 60_000) {
              // SWITCHBOARD: the shell's notification plugin, not the web API.
              nav.notify(n.level === "warn" ? "⚠ Lodestar guardrail" : "Lodestar", n.text);
            }
          }
        }
      }).catch(() => {
        if (!cancelled) setUnreachable(true); // honest: down ≠ "waiting for fills"
      });
    };
    poll();
    const iv = setInterval(poll, 2000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(iv);
      clearInterval(tick);
    };
  }, [active, nav]);

  const sesHr = st?.session_start ? (now - Date.parse(st.session_start)) / 3600000 : 0;
  const sesColor = sesHr >= 3 ? DN : sesHr >= 2 ? AMBER : UP;
  const tradeColor = (st?.trade_no ?? 0) >= 7 ? DN : (st?.trade_no ?? 0) >= 4 ? AMBER : UP;
  const cooldownS = st?.cooldown_until ? Math.max(0, Math.floor((Date.parse(st.cooldown_until) - now) / 1000)) : 0;
  const lastNudge = st?.nudges?.length ? st.nudges[st.nudges.length - 1] : null;

  return (
    <div className="flex h-full min-h-[200px] flex-col font-mono text-text" style={{ fontSize: 12 }}>

      {unreachable ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px]" style={{ color: DN }}>
          backend unreachable — guardrails NOT active (is Lodestar running?)
        </div>
      ) : !st || !st.session_start ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[11px] text-dim">
          waiting for fills… (the NinjaTrader AddOn streams them here)
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-1.5 p-2.5">
          <div className="flex items-baseline gap-3">
            <span>
              <span className="text-dim">session </span>
              <span style={{ color: sesColor }}>{hms(st.session_start, now)}</span>
            </span>
            <span>
              <span className="text-dim">trade </span>
              <span style={{ color: tradeColor }}>#{st.trade_no}</span>
            </span>
            <span className="ml-auto">
              <span className="text-dim">day </span>
              <span style={{ color: st.day_pts >= 0 ? UP : DN }}>{st.day_pts >= 0 ? "+" : ""}{st.day_pts} pts</span>
            </span>
          </div>

          {st.position ? (
            <div className="text-[11px]">
              <span className="text-dim">open </span>
              {Math.abs(st.position.qty)}× {st.position.symbol} {st.position.direction} @ {st.position.avg_price}
            </div>
          ) : (
            <div className="text-[11px] text-dim2">flat</div>
          )}

          {cooldownS > 0 ? (
            <div className="rounded border px-2 py-1.5 text-center" style={{ borderColor: DN, color: DN }}>
              COOLDOWN {Math.floor(cooldownS / 60)}:{String(cooldownS % 60).padStart(2, "0")} — the 18-second re-entries flip coins
            </div>
          ) : null}

          {sesHr >= 3 ? (
            <div className="text-[10px]" style={{ color: DN }}>hour {Math.floor(sesHr)} — your edge lives in the first 3h</div>
          ) : null}

          {lastNudge ? (
            <div
              className="mt-auto rounded border border-line bg-surface/50 px-2 py-1.5 text-[10px] leading-snug"
              style={{ color: lastNudge.level === "warn" ? DN : undefined }}
            >
              {lastNudge.text}
            </div>
          ) : (
            <div className="mt-auto text-[10px] text-dim2">no nudges yet — good</div>
          )}
        </div>
      )}
    </div>
  );
}
