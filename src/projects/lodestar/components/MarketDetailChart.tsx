/**
 * Market detail chart — fully custom SVG. Price-over-time line (0–100¢ = implied
 * win %) with volume bars beneath, and a DVR scrubber: hover anywhere to read the
 * price, bid/ask, volume, trade count, open interest — and, when the market is
 * linked to a captured NBA game (LODE-14), the score, game clock, and the play
 * happening at that moment.
 */

import { useMemo, useRef, useState } from "react";
import type { GameLink, HistoricalDetailPoint } from "../api/client";

interface Props {
  points: HistoricalDetailPoint[];
  game?: GameLink | null;
  height?: number;
  /** Wall-clock ts of a moment to pin on the chart (from clicking a play/run/swing). */
  highlightTs?: string | null;
}

const W = 600;
const PAD = 8;

function fmtTime(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <span className="text-dim">{label} </span>
      <span className={`font-mono ${tone ?? "text-text"}`}>{value}</span>
    </div>
  );
}

export default function MarketDetailChart({ points, game, height = 300, highlightTs }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  // The point nearest a pinned moment (a clicked play/run/swing).
  const highlightIdx = useMemo(() => {
    if (!highlightTs || points.length === 0) return null;
    const target = new Date(highlightTs).getTime();
    if (Number.isNaN(target)) return null;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(new Date(points[i].ts).getTime() - target);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }, [highlightTs, points]);

  const priceTop = PAD;
  const priceBottom = height * 0.7;
  const volTop = height * 0.76;
  const volBottom = height - PAD;

  const maxVol = useMemo(() => Math.max(1, ...points.map((p) => p.volume)), [points]);

  const x = (i: number): number =>
    points.length <= 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (points.length - 1);
  const yPrice = (prob: number): number => priceTop + (1 - Math.max(0, Math.min(1, prob))) * (priceBottom - priceTop);

  const linePts = points.map((p, i) => ({ i, prob: p.prob })).filter((p): p is { i: number; prob: number } => p.prob != null);
  const path = linePts.map((p, k) => `${k === 0 ? "M" : "L"} ${x(p.i).toFixed(1)} ${yPrice(p.prob).toFixed(1)}`).join(" ");

  function onMove(e: React.MouseEvent<SVGSVGElement>): void {
    const svg = svgRef.current;
    if (!svg || points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const lx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(x(i) - lx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  }

  const sel =
    hover != null
      ? points[hover]
      : highlightIdx != null
        ? points[highlightIdx]
        : points.length
          ? points[points.length - 1]
          : null;
  const grid = [0, 0.25, 0.5, 0.75, 1];
  const barW = points.length > 1 ? Math.max(1, (W - PAD * 2) / points.length - 1) : 6;

  const awayCode = game?.away_team ?? "AWAY";
  const homeCode = game?.home_team ?? "HOME";

  return (
    <div className="w-full">
      {/* game header (LODE-14): final score when linked, or a flag when not */}
      {game &&
        (game.linked ? (
          <div className="mb-2 flex items-center gap-2 text-sm">
            <span className="font-mono text-text">
              {awayCode} {game.away_score} @ {homeCode} {game.home_score}
            </span>
            <span className="text-dim">·</span>
            <span className="text-dim">{game.status ?? ""}</span>
          </div>
        ) : (
          <div className="mb-2 text-xs text-dim">no play-by-play for this market ({game.reason})</div>
        ))}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        className="block"
      >
        {grid.map((g) => (
          <line key={g} className="stroke-line" x1={PAD} x2={W - PAD} y1={yPrice(g)} y2={yPrice(g)} strokeWidth={1} />
        ))}
        <line
          className="stroke-dim"
          x1={PAD}
          x2={W - PAD}
          y1={yPrice(0.5)}
          y2={yPrice(0.5)}
          strokeWidth={1}
          strokeOpacity={0.4}
          strokeDasharray="4 4"
        />

        {/* volume bars */}
        {points.map((p, i) =>
          p.volume > 0 ? (
            <rect
              key={i}
              className="fill-accent"
              fillOpacity={0.22}
              x={x(i) - barW / 2}
              width={barW}
              y={volBottom - (p.volume / maxVol) * (volBottom - volTop)}
              height={(p.volume / maxVol) * (volBottom - volTop)}
            />
          ) : null,
        )}

        {linePts.length > 1 && (
          <path d={path} className="stroke-accent" fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}

        {/* pinned moment (clicked play/run/swing) — persistent marker */}
        {highlightIdx != null && (
          <>
            <line
              className="stroke-liq"
              x1={x(highlightIdx)}
              x2={x(highlightIdx)}
              y1={priceTop}
              y2={volBottom}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
            {points[highlightIdx]?.prob != null && (
              <circle
                className="fill-liq"
                cx={x(highlightIdx)}
                cy={yPrice(points[highlightIdx].prob as number)}
                r={4}
              />
            )}
          </>
        )}

        {hover != null && points[hover]?.prob != null && (
          <>
            <line
              className="stroke-dim"
              x1={x(hover)}
              x2={x(hover)}
              y1={priceTop}
              y2={volBottom}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle className="fill-accent" cx={x(hover)} cy={yPrice(points[hover].prob as number)} r={3} />
          </>
        )}
      </svg>

      {/* time axis */}
      <div className="flex justify-between px-1 font-mono text-[11px] text-dim">
        <span>{points.length ? fmtTime(points[0].ts) : "—"}</span>
        <span>price ¢ / implied %</span>
        <span>{points.length ? fmtTime(points[points.length - 1].ts) : "—"}</span>
      </div>

      {/* scrubber readout */}
      {sel && (
        <div className="mt-3 space-y-1 rounded-md border border-line bg-bg px-3 py-2 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <Stat label="@" value={fmtTime(sel.ts)} />
            <Stat
              label="price"
              value={`${sel.last_price ?? Math.round((sel.prob ?? 0) * 100)}¢`}
              tone="text-accent"
            />
            <Stat label="implied" value={`${((sel.prob ?? 0) * 100).toFixed(1)}%`} />
            <Stat label="bid/ask" value={`${sel.yes_bid ?? "—"}/${sel.yes_ask ?? "—"}`} />
            <Stat label="vol" value={sel.volume.toLocaleString()} />
            <Stat label="trades" value={sel.trades.toLocaleString()} />
            <Stat label="OI" value={sel.open_interest != null ? sel.open_interest.toLocaleString() : "—"} />
            {sel.home_score != null && (
              <>
                <Stat label="score" value={`${awayCode} ${sel.away_score} – ${homeCode} ${sel.home_score}`} />
                {sel.clock && <Stat label="clock" value={sel.clock} />}
              </>
            )}
          </div>
          {sel.last_play && <div className="font-mono text-xs text-dim">▸ {sel.last_play}</div>}
        </div>
      )}
    </div>
  );
}
