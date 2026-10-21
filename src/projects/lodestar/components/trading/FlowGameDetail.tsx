/**
 * Kalshi Trading / Flow - one game's detail (SWIT-130): cumulative handle per
 * side over time with the tip marked, the price each side paid, and the size
 * mix (bets and handle by bet size) that separates the public from the sharps.
 *
 * The detail covers the WHOLE tape (pregame + in play) whatever the table's
 * Pregame / All toggle says; the caption says so.
 *
 * Chart choice: the shared LinePanel (uPlot), not a hand-drawn SVG like
 * FlowDeepDive. FlowDeepDive draws dots on a price axis it owns end to end;
 * this is two plain time series with a labelled vertical marker, which is
 * exactly LinePanel's job (markers, a time axis, a legend naming each series,
 * pan/zoom). The two panels share one x range, so the price strip reads
 * against the handle chart above it (their plot areas can still differ by a
 * few pixels, because the y-axis labels differ in width). Side identity is
 * never colour alone: the legend names each side, the second side is dashed,
 * and a one-line text summary sits under each chart. The two series tones are
 * ones the rest of the page does not use (blue is "money" in the table, amber
 * is the warning chip), and a side keeps its tone across rungs because sides
 * are put in a fixed order (away team first, Over first).
 */

import { useMemo } from "react";
import LinePanel, { type LineSeries } from "../../../../surfaces/charts/LinePanel";
import { SERIES_PALETTE } from "../../../../surfaces/charts/candles";
import type { NbaFlowGame, NbaFlowGameDetail, NbaFlowLineKey, NbaFlowPhase } from "../../api/client";
import {
  LINE_KEYS,
  LINE_LABEL,
  OUTAGE_CHIP,
  buildFlowSeries,
  fetchErrorText,
  flowSummary,
  fmtBets,
  fmtMoney,
  fmtPct,
  fmtTip,
  gameCodeTeams,
  isHandleIncomplete,
  orderSides,
  priceSummary,
  sideProfile,
  sizeMix,
  spansMoreThanADay,
  type FlowSelection,
} from "../../lib/kalshiFlow";
import { T } from "../../../../lib/typeScale";
import Panel from "../Panel";
import Spinner from "../Spinner";
import Chip from "./Chip";

export interface FlowGameDetailProps {
  game: NbaFlowGame | undefined;
  selection: FlowSelection;
  phase: NbaFlowPhase;
  /** The response for exactly this selection, or null while it loads. */
  detail: NbaFlowGameDetail | null;
  /** The last response for this game AND line, kept while a rung change loads
   *  so the rung select (its focus and width) does not disappear. Null after a
   *  line change: the old line's rungs must not stay selectable. */
  previous: NbaFlowGameDetail | null;
  error: string | null;
  onLine: (line: NbaFlowLineKey) => void;
  onRung: (rung: string | null) => void;
  onClose: () => void;
}

const SIDE_INK = [SERIES_PALETTE[1], SERIES_PALETTE[3]] as const;
const CHART_H = 220;
const PRICE_H = 130;

const formatMoneyAxis = (v: number): string => fmtMoney(v);
const formatCentsAxis = (v: number): string => `${Math.round(v)}c`;

const SELECT_CLASS = "rounded border border-line bg-bg px-2 py-1 text-text focus:border-accent focus:outline-none";

function SeriesCharts({ detail, sides }: { detail: NbaFlowGameDetail; sides: readonly string[] }) {
  const m = useMemo(() => {
    const f = buildFlowSeries(detail.timeline, sides, detail.tip_utc);
    const mk = (values: Record<string, (number | null)[]>): LineSeries[] =>
      sides.map((s, i) => ({
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
      intraday: !spansMoreThanADay(f.xs),
      handleText: flowSummary(f.totals, sides),
      priceText: priceSummary(f.price, sides),
    };
  }, [detail, sides]);

  if (m.xs.length < 2) {
    return <div style={{ ...T.bodySm, color: "var(--dim)" }}>not enough bets on tape to draw a timeline yet</div>;
  }
  return (
    <div className="flex flex-col gap-3">
      <figure className="m-0">
        <figcaption className="mb-1" style={{ ...T.kicker, color: "var(--dim)" }}>cumulative handle by side</figcaption>
        <div className="mb-1" style={{ ...T.caption, color: "var(--dim2)" }}>
          each 15-minute bucket is drawn at its end, so bets in the bucket the tip falls inside appear after the marker
        </div>
        <LinePanel
          xs={m.xs}
          series={m.series}
          height={CHART_H}
          formatY={formatMoneyAxis}
          points={m.isos}
          markers={m.markers}
          xRange={m.xRange}
          intraday={m.intraday}
        />
        <p className="m-0 mt-1" style={{ ...T.bodySm, color: "var(--dim)" }}>{m.handleText}</p>
      </figure>
      <figure className="m-0">
        <figcaption className="mb-1" style={{ ...T.kicker, color: "var(--dim)" }}>
          price paid per $1 (cents) - last price carried forward between bets
        </figcaption>
        <LinePanel
          xs={m.xs}
          series={m.price}
          height={PRICE_H}
          formatY={formatCentsAxis}
          markers={m.markers}
          xRange={m.xRange}
          intraday={m.intraday}
        />
        <p className="m-0 mt-1" style={{ ...T.bodySm, color: "var(--dim)" }}>{m.priceText}</p>
      </figure>
    </div>
  );
}

function SizeMix({ detail, sides }: { detail: NbaFlowGameDetail; sides: readonly string[] }) {
  const rows = useMemo(() => sizeMix(detail.sizes, sides), [detail, sides]);
  const profile = useMemo(() => sideProfile(detail.sizes, sides), [detail, sides]);
  const maxBets = Math.max(1, ...rows.map((r) => r.bets));
  const maxHandle = Math.max(1, ...rows.map((r) => r.handle));
  const th = { ...T.caption, color: "var(--dim2)", fontWeight: 400 } as const;
  return (
    <div>
      <div className="mb-1" style={{ ...T.kicker, color: "var(--dim)" }}>size mix - many small tickets is the public, few large ones the sharps</div>
      <ul className="m-0 mb-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
        {profile.map((p, i) => (
          <li key={p.side} style={{ ...T.mono, color: "var(--dim)" }}>
            <span style={{ color: SIDE_INK[i % SIDE_INK.length] }} aria-hidden>{i % 2 === 1 ? "- - " : "--- "}</span>
            {p.side}: avg bet {fmtMoney(p.avg)} · {fmtPct(p.bigShare)} of handle in $1k+ bets
          </li>
        ))}
      </ul>
      <table className="w-full border-collapse text-left" aria-label="bets and handle by bet size">
        <thead>
          <tr>
            <th scope="col" className="pr-3 text-left" style={th}>bet size</th>
            <th scope="col" className="pr-3 text-left" style={th}>side</th>
            <th scope="col" className="pr-3 text-left" style={th}>bets</th>
            <th scope="col" className="pr-3 text-left" style={th}>handle</th>
            <th scope="col" className="text-left" style={th}>avg bet</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const si = Math.max(0, sides.indexOf(r.side));
            const ink = SIDE_INK[si % SIDE_INK.length];
            return (
              <tr key={`${r.bucket}|${r.side}`} data-size-bucket={r.bucket}>
                <th scope="row" className={`pr-3 py-0.5 text-left ${si === 0 ? "" : "sr-only"}`} style={{ ...T.mono, color: "var(--text)", fontWeight: 400 }}>
                  {r.bucket}
                </th>
                <td className="truncate pr-3" style={{ ...T.bodySm, color: "var(--dim)" }}>{r.side}</td>
                <td className="pr-3"><Bar value={r.bets} max={maxBets} ink={ink} label={String(r.bets)} /></td>
                <td className="pr-3"><Bar value={r.handle} max={maxHandle} ink={ink} label={fmtMoney(r.handle)} /></td>
                <td style={{ ...T.mono, color: "var(--dim)" }}>{r.bets > 0 ? fmtMoney(r.avg) : "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
      <div className="h-2 min-w-12 flex-1 rounded-sm bg-surface2" aria-hidden>
        <div className="h-full rounded-sm" style={{ width: `${w}%`, background: ink }} />
      </div>
      <span className="w-14 shrink-0 text-right" style={{ ...T.mono, color: "var(--text)" }}>{label}</span>
    </div>
  );
}

export default function FlowGameDetail({ game, selection, phase, detail, previous, error, onLine, onRung, onClose }: FlowGameDetailProps) {
  const title = game ? `${game.away} @ ${game.home}` : selection.game;
  const ctl = detail ?? previous;
  const rungs = ctl?.rungs ?? [];
  const outage = isHandleIncomplete((detail ?? ctl)?.price_zero_share ?? game?.price_zero_share);
  // The away team from the slate row, or from the game code while the slate is
  // changing, so a side keeps its colour either way.
  const away = game?.away ?? gameCodeTeams(selection.game)?.away;
  const sides = useMemo(
    () => (detail ? orderSides(detail.sides, detail.line, away ? { away } : undefined) : []),
    [detail, away],
  );
  return (
    <Panel
      title={`game detail · ${title}`}
      headerRight={
        <button type="button" onClick={onClose} className="rounded border border-line px-2 py-0.5 text-dim hover:text-text" style={T.label}>
          close
        </button>
      }
    >
      <div
        className="flex flex-col gap-4"
        data-anchor={`detail:${selection.game}:${selection.line}`}
        data-anchor-label={`${title} · ${LINE_LABEL[selection.line]} detail`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="tablist" aria-label="line">
            {LINE_KEYS.map((k) => {
              // In pregame mode a line with no pregame bets can still have an
              // in-play tape, so it stays openable.
              const exists = !game || !!game.lines[k] || phase === "pregame";
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
                value={(detail ? detail.rung : (selection.rung ?? ctl?.rung)) ?? ""}
                aria-busy={!detail}
                onChange={(e) => onRung(e.target.value || null)}
              >
                {rungs.map((r) => (
                  <option key={r.rung} value={r.rung}>
                    {r.label ?? r.rung} · {fmtBets(r.bets)} · {fmtMoney(r.handle)}
                  </option>
                ))}
              </select>
            </label>
          ) : ctl?.rung ? (
            <span style={{ ...T.mono, color: "var(--text)" }}>{ctl.rung_label ?? ctl.rung}</span>
          ) : null}
          {ctl ? <span style={{ ...T.mono, color: "var(--dim)" }}>tip {fmtTip(ctl.tip_utc)}</span> : null}
          {outage ? <Chip tone="warn">{OUTAGE_CHIP}</Chip> : null}
        </div>
        <div style={{ ...T.caption, color: "var(--dim2)" }}>whole tape: pregame + in play</div>

        {error && !detail ? (
          <div className="rounded-lg border border-line p-4 text-dn" style={T.bodySm}>
            {fetchErrorText(error)}
          </div>
        ) : !detail ? (
          <Spinner label="loading game flow…" />
        ) : detail.timeline.length === 0 && detail.sizes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line p-4 text-dim" style={T.bodySm}>
            no bets on tape for this line
          </div>
        ) : (
          <>
            <SeriesCharts detail={detail} sides={sides} />
            <SizeMix detail={detail} sides={sides} />
          </>
        )}
      </div>
    </Panel>
  );
}
