/**
 * Kalshi Trading / Flow — one game's detail (SWIT-130): cumulative handle per
 * side over time with the tip marked, the price each side paid, and the size
 * mix (bets and handle by bet size) that separates the public from the sharps.
 *
 * Chart choice: the shared LinePanel (uPlot), not a hand-drawn SVG like
 * FlowDeepDive. FlowDeepDive draws dots on a price axis it owns end to end;
 * this is two plain time series with a labelled vertical marker, which is
 * exactly LinePanel's job (markers, a time axis, a legend naming each series,
 * pan/zoom) — and two LinePanels given the same x range line up, so the price
 * strip reads against the handle chart above it. Side identity is never colour
 * alone: the legend names each side, and the second side is dashed.
 */

import { useMemo } from "react";
import LinePanel, { type LineSeries } from "../../../../surfaces/charts/LinePanel";
import { SERIES_PALETTE } from "../../../../surfaces/charts/candles";
import type { NbaFlowGame, NbaFlowGameDetail, NbaFlowLineKey } from "../../api/client";
import {
  LINE_KEYS,
  LINE_LABEL,
  OUTAGE_CHIP,
  buildFlowSeries,
  fmtCount,
  fmtMoney,
  fmtPct,
  fmtTip,
  isHandleIncomplete,
  sideProfile,
  sizeMix,
  type FlowSelection,
} from "../../lib/kalshiFlow";
import { T } from "../../../../lib/typeScale";
import Panel from "../Panel";
import Spinner from "../Spinner";
import { Chip } from "./FlowGamesTable";

export interface FlowGameDetailProps {
  game: NbaFlowGame | undefined;
  selection: FlowSelection;
  detail: NbaFlowGameDetail | null;
  error: string | null;
  onLine: (line: NbaFlowLineKey) => void;
  onRung: (rung: string | null) => void;
  onClose: () => void;
}

const SIDE_INK = [SERIES_PALETTE[0], SERIES_PALETTE[2]] as const;
const CHART_H = 220;
const PRICE_H = 130;

const formatMoneyAxis = (v: number): string => fmtMoney(v);
const formatCentsAxis = (v: number): string => `${Math.round(v)}c`;

const SELECT_CLASS = "rounded border border-line bg-bg px-2 py-1 text-text focus:border-accent focus:outline-none";

function SeriesCharts({ detail }: { detail: NbaFlowGameDetail }) {
  const { series, price, xs, isos, markers, xRange } = useMemo(() => {
    const f = buildFlowSeries(detail.timeline, detail.sides, detail.tip_utc);
    const mk = (values: Record<string, (number | null)[]>): LineSeries[] =>
      detail.sides.map((s, i) => ({
        label: s,
        values: values[s],
        color: SIDE_INK[i % SIDE_INK.length],
        dashed: i % 2 === 1,
        width: 1.75,
      }));
    return {
      series: mk(f.handle),
      price: mk(f.price),
      xs: f.xs,
      isos: f.isos,
      markers: detail.tip_utc ? [{ ts: detail.tip_utc, label: "tip" }] : [],
      xRange: [f.xs[0], f.xs[f.xs.length - 1]] as [number, number],
    };
  }, [detail]);

  if (xs.length < 2) {
    return <div style={{ ...T.bodySm, color: "var(--dim)" }}>not enough bets on tape to draw a timeline yet</div>;
  }
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1" style={{ ...T.kicker, color: "var(--dim)" }}>cumulative handle by side</div>
        <LinePanel
          xs={xs}
          series={series}
          height={CHART_H}
          formatY={formatMoneyAxis}
          points={isos}
          markers={markers}
          xRange={xRange}
        />
      </div>
      <div>
        <div className="mb-1" style={{ ...T.kicker, color: "var(--dim)" }}>
          price paid per $1 (cents) - last price carried forward between bets
        </div>
        <LinePanel
          xs={xs}
          series={price}
          height={PRICE_H}
          formatY={formatCentsAxis}
          markers={markers}
          xRange={xRange}
        />
      </div>
    </div>
  );
}

function SizeMix({ detail }: { detail: NbaFlowGameDetail }) {
  const rows = useMemo(() => sizeMix(detail.sizes, detail.sides), [detail]);
  const profile = useMemo(() => sideProfile(detail.sizes, detail.sides), [detail]);
  const maxBets = Math.max(1, ...rows.map((r) => r.bets));
  const maxHandle = Math.max(1, ...rows.map((r) => r.handle));
  const cols = { gridTemplateColumns: "5.5rem minmax(0,7rem) minmax(0,1fr) minmax(0,1fr) 4rem" } as const;
  return (
    <div>
      <div className="mb-1" style={{ ...T.kicker, color: "var(--dim)" }}>size mix - many small tickets is the public, few large ones the sharps</div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
        {profile.map((p, i) => (
          <span key={p.side} style={{ ...T.mono, color: "var(--dim)" }}>
            <span style={{ color: SIDE_INK[i % SIDE_INK.length] }} aria-hidden>{i % 2 === 1 ? "- -" : "---"} </span>
            {p.side}: avg bet {fmtMoney(p.avg)} · {fmtPct(p.bigShare)} of handle in $1k+ bets
          </span>
        ))}
      </div>
      <div className="grid items-center gap-x-3 gap-y-1" style={cols} role="table" aria-label="bets and handle by bet size">
        {["bet size", "side", "bets", "handle", "avg bet"].map((h) => (
          <span key={h} style={{ ...T.caption, color: "var(--dim2)" }}>{h}</span>
        ))}
        {rows.map((r) => {
          const si = Math.max(0, detail.sides.indexOf(r.side));
          const ink = SIDE_INK[si % SIDE_INK.length];
          const first = si === 0;
          return (
            <div key={`${r.bucket}|${r.side}`} className="contents" role="row" data-size-bucket={r.bucket}>
              <span style={{ ...T.mono, color: "var(--text)" }}>{first ? r.bucket : ""}</span>
              <span className="truncate" style={{ ...T.bodySm, color: "var(--dim)" }}>{r.side}</span>
              <Bar value={r.bets} max={maxBets} ink={ink} label={fmtCount(r.bets)} />
              <Bar value={r.handle} max={maxHandle} ink={ink} label={fmtMoney(r.handle)} />
              <span style={{ ...T.mono, color: "var(--dim)" }}>{r.bets > 0 ? fmtMoney(r.avg) : "-"}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-1" style={{ ...T.caption, color: "var(--dim2)" }}>
        bar lengths share one scale per column across every bucket and side; the side is the row label.
      </div>
    </div>
  );
}

function Bar({ value, max, ink, label }: { value: number; max: number; ink: string; label: string }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 rounded-sm bg-surface2" aria-hidden>
        <div className="h-full rounded-sm" style={{ width: `${w}%`, background: ink }} />
      </div>
      <span className="w-14 shrink-0 text-right" style={{ ...T.mono, color: "var(--text)" }}>{label}</span>
    </div>
  );
}

export default function FlowGameDetail({ game, selection, detail, error, onLine, onRung, onClose }: FlowGameDetailProps) {
  const title = game ? `${game.away} @ ${game.home}` : selection.game;
  const rungs = detail?.rungs ?? [];
  const outage = isHandleIncomplete(detail?.price_zero_share ?? game?.price_zero_share);
  return (
    <Panel
      title={`game detail · ${title}`}
      headerRight={
        <button type="button" onClick={onClose} className="rounded border border-line px-2 py-0.5 text-dim hover:text-text" style={T.label}>
          close
        </button>
      }
    >
      <div className="flex flex-col gap-4" data-anchor={`game:${selection.game}`} data-anchor-label={`${title} · detail`}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="tablist" aria-label="line">
            {LINE_KEYS.map((k) => {
              const exists = !game || !!game.lines[k];
              const on = selection.line === k;
              return (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  disabled={!exists}
                  onClick={() => onLine(k)}
                  className={`rounded-full border px-3 py-0.5 transition-colors disabled:opacity-40 ${on ? "border-accent text-accent" : "border-line text-dim hover:text-text"}`}
                  style={T.label}
                >
                  {LINE_LABEL[k]}
                </button>
              );
            })}
          </div>
          {rungs.length > 1 ? (
            <label className="flex items-center gap-2" style={{ ...T.bodySm, color: "var(--dim)" }}>
              rung
              <select
                className={SELECT_CLASS}
                style={T.mono}
                value={detail?.rung ?? ""}
                onChange={(e) => onRung(e.target.value || null)}
              >
                {rungs.map((r) => (
                  <option key={r.rung} value={r.rung}>
                    {r.rung} · {fmtCount(r.bets)} bets · {fmtMoney(r.handle)}
                  </option>
                ))}
              </select>
            </label>
          ) : detail?.rung ? (
            <span style={{ ...T.mono, color: "var(--text)" }}>{detail.rung}</span>
          ) : null}
          {detail ? <span style={{ ...T.mono, color: "var(--dim)" }}>tip {fmtTip(detail.tip_utc)}</span> : null}
          {outage ? <Chip tone="warn">{OUTAGE_CHIP}</Chip> : null}
        </div>

        {error && !detail ? (
          <div className="rounded-lg border border-line p-4 text-dn" style={T.bodySm}>
            backend unreachable - {error}
          </div>
        ) : !detail ? (
          <Spinner label="loading game flow…" />
        ) : detail.timeline.length === 0 && detail.sizes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line p-4 text-dim" style={T.bodySm}>
            no bets on tape for this line
          </div>
        ) : (
          <>
            <SeriesCharts detail={detail} />
            <SizeMix detail={detail} />
          </>
        )}
      </div>
    </Panel>
  );
}
