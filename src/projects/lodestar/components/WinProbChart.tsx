/**
 * Custom win-probability chart — fully hand-rendered SVG (no chart library), per
 * the Lodestar "charts are fully custom" decision. Plots a 0–100% probability
 * line over time with a DVR scrubber cursor (hover to read the value at any point).
 */

import { useRef, useState } from "react";

export interface ChartPoint {
  /** x label (e.g. a time string). */
  label: string;
  /** win probability 0..1. */
  prob: number;
}

interface Props {
  points: ChartPoint[];
  height?: number;
}

const W = 600; // logical width; SVG scales to the container
const PAD = 8;

export default function WinProbChart({ points, height = 160 }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const h = height;
  const innerH = h - PAD * 2;

  const x = (i: number): number =>
    points.length <= 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (points.length - 1);
  const y = (prob: number): number => PAD + (1 - Math.max(0, Math.min(1, prob))) * innerH;

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.prob).toFixed(1)}`).join(" ");

  function onMove(e: React.MouseEvent<SVGSVGElement>): void {
    const svg = svgRef.current;
    if (!svg || points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const logicalX = ((e.clientX - rect.left) / rect.width) * W;
    // nearest point index
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(x(i) - logicalX);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  }

  const gridYs = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${h}`}
        preserveAspectRatio="none"
        width="100%"
        height={h}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        className="block"
      >
        {/* gridlines */}
        {gridYs.map((g) => (
          <line key={g} className="stroke-line" x1={PAD} x2={W - PAD} y1={y(g)} y2={y(g)} strokeWidth={1} />
        ))}
        {/* 50% reference */}
        <line
          className="stroke-dim"
          x1={PAD}
          x2={W - PAD}
          y1={y(0.5)}
          y2={y(0.5)}
          strokeWidth={1}
          strokeOpacity={0.5}
          strokeDasharray="4 4"
        />

        {points.length > 1 && (
          <path d={path} className="stroke-accent" fill="none" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        )}

        {/* DVR cursor */}
        {hover !== null && points[hover] && (
          <>
            <line
              className="stroke-dim"
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD}
              y2={h - PAD}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle className="fill-accent" cx={x(hover)} cy={y(points[hover].prob)} r={3} />
          </>
        )}
      </svg>

      <div className="mt-1 flex justify-between font-mono text-xs text-dim">
        <span>{points.length ? points[0].label : "—"}</span>
        <span className="text-text">
          {hover !== null && points[hover]
            ? `${points[hover].label} · ${(points[hover].prob * 100).toFixed(1)}% YES`
            : points.length
              ? `${(points[points.length - 1].prob * 100).toFixed(1)}% YES`
              : "no data"}
        </span>
        <span>{points.length ? points[points.length - 1].label : "—"}</span>
      </div>
    </div>
  );
}
