/**
 * Flow deep-dive chart (owner ask 2026-07-02): the ONE view for judging an
 * unusual-flow candidate — market price over the match, game events (breaks,
 * set ends) as muted vertical markers, and every scored trade as a dot ON THE
 * SAME price axis (size = contracts; flagged moments in the status hue with a
 * surface ring). Single y-axis by design; identity never rides on color alone
 * (flagged dots are bigger + ringed; a legend row names everything).
 *
 * Dataviz method: price line = accent (#7c8ce8), flagged = status dn (#e0645b)
 * — CVD ΔE 27.9 protan / 60.5 normal on the dark surface (validated);
 * unflagged trades are deliberately recessive muted ink (context, not a series).
 */

import { useMemo, useState } from "react";
import type {
  AnomalyMoment,
  BreakMoment,
  HistoricalDetailPoint,
  SetLine,
} from "../../api/client";

const W = 860;
const H = 300;                       // price pane + pressure band
const BAND_H = 54;                   // cumulative backing pressure strip
const PAD = { l: 34, r: 10, t: 10, b: 22 + BAND_H };
const FLAG_SCORE = 3.0;

interface Props {
  points: HistoricalDetailPoint[];      // price series (market detail)
  moments: AnomalyMoment[];             // scored trades (anomaly board)
  breaks: BreakMoment[];                // game events from match context
  sets: SetLine[];
  /** Chart annotation (owner ask): comment on a moment; lands where the agent
   * can read it (a case note). Absent = dots are hover-only. */
  onAnnotate?: (text: string, m: AnomalyMoment) => Promise<void> | void;
  /** Total scored moments for the match — the API caps what it returns to the
   * top-scored subset, and the captions must say so. */
  totalMoments?: number;
}

function ts(v: string): number {
  return new Date(v).getTime();
}

export default function FlowDeepDive({ points, moments, breaks, sets, onAnnotate, totalMoments }: Props) {
  const [hover, setHover] = useState<{ x: number; label: string[] } | null>(null);
  // Crosshair scanning (owner ask 2026-07-03): hover ANYWHERE reads out time,
  // price, and the nearest important events — not just the trade dots.
  const [cross, setCross] = useState<{ px: number; lines: string[] } | null>(null);
  const [annot, setAnnot] = useState<{ m: AnomalyMoment; x: number } | null>(null);
  const [annotText, setAnnotText] = useState("");
  const [annotMsg, setAnnotMsg] = useState<string | null>(null);
  // Zoom (owner ask 2026-07-03): pre-game hours flatten the chart and shove the
  // in-play action into the right edge. "game" clips to the window the scored
  // moments + set/break events span (padded); "all" is the full capture.
  const [range, setRange] = useState<"game" | "all">("game");

  const gameWindow = useMemo(() => {
    const stamps = [
      ...moments.map((m) => ts(m.ts)),
      ...breaks.map((b) => (b.ts ? ts(b.ts) : NaN)),
      ...sets.map((s) => (s.ts ? ts(s.ts) : NaN)),
    ].filter((n) => Number.isFinite(n));
    if (stamps.length < 2) return null;
    const lo = Math.min(...stamps);
    const hi = Math.max(...stamps);
    if (hi <= lo) return null;
    const pad = (hi - lo) * 0.06;
    return { lo: lo - pad, hi: hi + pad };
  }, [moments, breaks, sets]);

  const model = useMemo(() => {
    let priced = points.filter((p) => p.last_price != null);
    if (range === "game" && gameWindow) {
      const clipped = priced.filter((p) => {
        const n = ts(p.ts);
        return n >= gameWindow.lo && n <= gameWindow.hi;
      });
      if (clipped.length >= 2) priced = clipped;
    }
    if (priced.length < 2) return null;
    const t0 = ts(priced[0].ts);
    const t1 = ts(priced[priced.length - 1].ts);
    if (t1 <= t0) return null;
    const x = (t: number): number =>
      PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (cents: number): number =>
      PAD.t + (1 - cents / 100) * (H - PAD.t - PAD.b);
    const path = priced
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(ts(p.ts)).toFixed(1)},${y(p.last_price!).toFixed(1)}`)
      .join(" ");
    const inRange = (t: number): boolean => t >= t0 && t <= t1;
    const dots = moments
      .filter((m) => m.price != null && inRange(ts(m.ts)))
      .map((m) => ({
        m,
        cx: x(ts(m.ts)),
        cy: y(m.price!),
        r: Math.max(3, Math.min(9, 3 + Math.log10(Math.max(m.count ?? 1, 1)) * 2)),
        flagged: m.score >= FLAG_SCORE,
      }));
    // Net contracts (+p1 / -p2) across the moments the API returns — which is
    // the TOP-SCORED subset (capped server-side), NOT the full tape. Labeled
    // accordingly; a full-flow band needs an uncapped endpoint (follow-up).
    const sorted = [...moments]
      .filter((m) => inRange(ts(m.ts)))
      .sort((a, b) => ts(a.ts) - ts(b.ts));
    let net = 0;
    const pressure = sorted.map((m) => {
      net += (m.backs_player === 1 ? 1 : -1) * (m.count ?? 0);
      return { t: ts(m.ts), net };
    });
    const maxAbs = Math.max(1, ...pressure.map((pp) => Math.abs(pp.net)));
    const bandTop = H - PAD.b + 8;
    const yBand = (v: number): number => bandTop + (BAND_H - 12) / 2 - (v / maxAbs) * ((BAND_H - 12) / 2);
    const pressurePath = pressure
      .map((pp, i) => `${i === 0 ? "M" : "L"}${x(pp.t).toFixed(1)},${yBand(pp.net).toFixed(1)}`)
      .join(" ");
    const events = [
      ...sets
        .filter((s) => s.ts && inRange(ts(s.ts)))
        .map((s) => ({ t: ts(s.ts!), label: `set ${s.set_no}` })),
      ...breaks
        .filter((b) => b.ts && inRange(ts(b.ts)))
        .map((b) => ({ t: ts(b.ts!), label: "brk" })),
    ];
    const pricedTimes = priced.map((p) => ts(p.ts));
    return { priced, pricedTimes, x, y, path, dots, events, t0, t1, pressurePath, yBand, maxAbs };
  }, [points, moments, breaks, sets, range, gameWindow]);

  if (!model) {
    return (
      <div className="rounded-lg border border-line p-3 text-xs text-dim">
        Not enough priced ticks to draw the flow view for this market.
      </div>
    );
  }
  const { priced, pricedTimes, x, y, path, dots, events, t0, t1, pressurePath, yBand, maxAbs } = model;

  const fmtT = (n: number): string =>
    new Date(n).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });

  const onScan = (e: React.MouseEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < PAD.l || px > W - PAD.r) {
      setCross(null);
      return;
    }
    const tAt = t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (t1 - t0);
    // nearest priced point (binary-search-free: series is small enough)
    let pi = 0;
    for (let i = 1; i < pricedTimes.length; i++) {
      if (Math.abs(pricedTimes[i] - tAt) < Math.abs(pricedTimes[pi] - tAt)) pi = i;
    }
    const pt = priced[pi];
    const lines = [`${fmtT(tAt)} · ${pt.last_price}¢`];
    // nearest event within ~2.5% of the visible window
    const near = (t1 - t0) * 0.025;
    const ev = events
      .filter((ee) => Math.abs(ee.t - tAt) <= near)
      .sort((a, b) => Math.abs(a.t - tAt) - Math.abs(b.t - tAt))[0];
    if (ev) lines.push(`event: ${ev.label} @ ${fmtT(ev.t)}`);
    const dot = dots
      .filter((d) => Math.abs(ts(d.m.ts) - tAt) <= near)
      .sort((a, b) => Math.abs(ts(a.m.ts) - tAt) - Math.abs(ts(b.m.ts) - tAt))[0];
    if (dot) {
      lines.push(
        `${dot.flagged ? "⚑ " : ""}${dot.m.count} lots @ ${dot.m.price}¢ backs p${dot.m.backs_player} · score ${dot.m.score.toFixed(2)}`,
      );
    }
    setCross({ px, lines });
  };

  return (
    <div className="rounded-lg border border-line bg-bg p-2">
      {/* legend row — identity is never color-alone */}
      <div className="mb-1 flex items-center gap-3 px-1 font-mono text-[10px] text-dim">
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 bg-accent" /> last price (¢)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-dim/60" /> trade (size = contracts)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full ring-2 ring-bg" style={{ background: "#e0645b" }} />
          flagged flow (score ≥ {FLAG_SCORE})
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-px bg-line" /> set / break
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-4" style={{ background: "#5aa6c9" }} /> net of top-scored trades (p1 up / p2 down)
        </span>
        {gameWindow ? (
          <span className="flex gap-1">
            {(["game", "all"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                  range === r ? "border-accent text-accent" : "border-line text-dim hover:text-text"
                }`}
              >
                {r === "game" ? "game only" : "all history"}
              </button>
            ))}
          </span>
        ) : null}
        <span className="ml-auto">
          {totalMoments != null && totalMoments > dots.length
            ? `top ${dots.length} of ${totalMoments} scored trades`
            : `${dots.length} scored trades`}
          {onAnnotate ? " · click a dot to annotate" : ""}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        onMouseMove={onScan}
        onMouseLeave={() => {
          setHover(null);
          setCross(null);
        }}
      >
        {/* y gridlines at 0/50/100¢ — recessive */}
        {[0, 50, 100].map((c) => (
          <g key={c}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(c)} y2={y(c)} stroke="#1e1e22" strokeDasharray="2 4" />
            <text x={4} y={y(c) + 3} fill="#57575f" fontSize="9" fontFamily="monospace">
              {c}¢
            </text>
          </g>
        ))}
        {/* game events */}
        {events.map((e, i) => (
          <g key={i}>
            <line x1={x(e.t)} x2={x(e.t)} y1={PAD.t} y2={H - PAD.b} stroke="#1e1e22" />
            <text
              x={x(e.t) + 2}
              y={H - PAD.b - 3}
              fill="#57575f"
              fontSize="8"
              fontFamily="monospace"
            >
              {e.label}
            </text>
          </g>
        ))}
        {/* price line */}
        <path d={path} fill="none" stroke="#7c8ce8" strokeWidth="1.6" />
        {/* cumulative backing pressure band */}
        <line x1={PAD.l} x2={W - PAD.r} y1={yBand(0)} y2={yBand(0)} stroke="#1e1e22" strokeDasharray="2 4" />
        <text x={4} y={yBand(0) + 3} fill="#57575f" fontSize="8" fontFamily="monospace">±{maxAbs}</text>
        <path d={pressurePath} fill="none" stroke="#5aa6c9" strokeWidth="1.4" />
        {/* trade dots: unflagged first (recessive), flagged on top with ring */}
        {dots
          .filter((d) => !d.flagged)
          .map((d, i) => (
            <circle key={`u${i}`} cx={d.cx} cy={d.cy} r={d.r} fill="#8a8a93" opacity="0.35" />
          ))}
        {dots
          .filter((d) => d.flagged)
          .map((d, i) => (
            <circle
              key={`f${i}`}
              cx={d.cx}
              cy={d.cy}
              r={d.r + 1}
              fill="#e0645b"
              stroke="#000000"
              strokeWidth="2"
            />
          ))}
        {/* hover hit targets (bigger than the marks) + tooltip */}
        {dots.map((d, i) => (
          <circle
            key={`h${i}`}
            cx={d.cx}
            cy={d.cy}
            r={Math.max(d.r + 4, 8)}
            fill="transparent"
            style={onAnnotate ? { cursor: "pointer" } : undefined}
            onClick={() => {
              if (onAnnotate) {
                setAnnot({ m: d.m, x: d.cx });
                setAnnotText("");
                setAnnotMsg(null);
              }
            }}
            onMouseEnter={() =>
              setHover({
                x: d.cx,
                label: [
                  `${new Date(d.m.ts).toLocaleTimeString()} · ${d.m.count ?? "?"} lots @ ${d.m.price}¢`,
                  `backs p${d.m.backs_player} · state ${d.m.sets_p1 ?? "?"}-${d.m.sets_p2 ?? "?"} sets, ${d.m.games_p1 ?? "?"}-${d.m.games_p2 ?? "?"}`,
                  `size_z ${d.m.size_z} · disagreement ${d.m.disagreement} · score ${d.m.score}${d.m.side_inferred ? " · side inferred" : ""}`,
                ],
              })
            }
          />
        ))}
        {hover ? (
          <g pointerEvents="none">
            <line x1={hover.x} x2={hover.x} y1={PAD.t} y2={H - PAD.b} stroke="#7c8ce8" strokeWidth="0.6" opacity="0.5" />
            <rect
              x={Math.min(hover.x + 6, W - 320)}
              y={PAD.t + 2}
              width={314}
              height={44}
              rx={4}
              fill="#131316"
              stroke="#1e1e22"
            />
            {hover.label.map((ln, i) => (
              <text
                key={i}
                x={Math.min(hover.x + 12, W - 314)}
                y={PAD.t + 15 + i * 12}
                fill="#e6e6ea"
                fontSize="9"
                fontFamily="monospace"
              >
                {ln}
              </text>
            ))}
          </g>
        ) : null}
        {/* crosshair readout — scan anywhere */}
        {cross ? (
          <g pointerEvents="none">
            <line x1={cross.px} x2={cross.px} y1={PAD.t} y2={H - PAD.b} stroke="#8a8a93" strokeDasharray="3 3" opacity="0.7" />
            {(() => {
              const bw = 232;
              const bx = Math.min(Math.max(cross.px + 8, PAD.l), W - PAD.r - bw);
              const bh = 12 + cross.lines.length * 11;
              return (
                <g transform={`translate(${bx}, ${PAD.t + 2})`}>
                  <rect width={bw} height={bh} rx="4" fill="#131316" stroke="#1e1e22" />
                  {cross.lines.map((ln, i) => (
                    <text key={i} x="7" y={14 + i * 11} fill={i === 0 ? "#e6e6ea" : "#8a8a93"} fontSize="8.5" fontFamily="monospace">
                      {ln}
                    </text>
                  ))}
                </g>
              );
            })()}
          </g>
        ) : null}
      </svg>
      {annot ? (
        <div className="mt-1 flex items-center gap-2 rounded-md border border-line bg-surface2 px-2 py-1.5">
          <span className="shrink-0 font-mono text-[10px] text-dim">
            annotate {new Date(annot.m.ts).toLocaleTimeString()} · {annot.m.count ?? "?"} lots @ {annot.m.price}¢
          </span>
          <input
            autoFocus
            value={annotText}
            onChange={(e) => setAnnotText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAnnot(null);
              if (e.key === "Enter" && annotText.trim() && onAnnotate) {
                void Promise.resolve(onAnnotate(annotText.trim(), annot.m))
                  .then(() => {
                    setAnnotMsg("noted — the agent will see it on the case");
                    setAnnot(null);
                  })
                  .catch(() => {
                    // keep the input open with the text — nothing was saved
                    setAnnotMsg("save failed — your note is still here, retry");
                  });
              }
            }}
            placeholder="what do you see here? (Enter saves · Esc cancels)"
            className="flex-1 bg-transparent text-xs text-text placeholder:text-dim focus:outline-none"
          />
        </div>
      ) : annotMsg ? (
        <div className="mt-1 px-2 font-mono text-[10px] text-accent">{annotMsg}</div>
      ) : null}
    </div>
  );
}
