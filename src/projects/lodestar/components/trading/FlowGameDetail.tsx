/**
 * Kalshi Trading / Flow - one game's detail (SWIT-130): the versus block, the
 * one-line read, ONE chart (money vs bets over time), when the money came in,
 * who bet what size, and the real $1k+ bets.
 *
 * Every number on the page is for the same rung and the same phase: the versus
 * block, the read and the tables come from the detail's own size mix and
 * timeline, so choosing another rung or Before tip / Whole game moves them
 * together. DraftKings sits beside Kalshi, never mixed in: its shares appear as
 * one mono line under each side and as a dotted line on the chart; it has no
 * dollars, so none are shown for it.
 *
 * Presentational and hook-free (state lives on the page): props in, markup out.
 * The page is an investigation tool. Nothing here says to bet.
 */

import type { ReactNode } from "react";
import type {
  NbaFlowBookGame,
  NbaFlowBookSeries,
  NbaFlowGame,
  NbaFlowGameDetail,
  NbaFlowGapBands,
  NbaFlowLineKey,
  NbaFlowPhase,
  NbaFlowSide,
} from "../../api/client";
import {
  BUCKET_MIN,
  LINE_KEYS,
  LINE_LABEL,
  OUTAGE_CHIP,
  avgBet,
  avgBetSentence,
  bandsFor,
  bigBetsFor,
  buildCell,
  fmtBets,
  fmtCount,
  fmtEt,
  fmtMoney,
  fmtPct,
  gameCodeTeams,
  gapRead,
  gapSentence,
  isHandleIncomplete,
  leanSentence,
  orderSides,
  fetchErrorText,
  parseIso,
  rungText,
  shortSide,
  sideStats,
  sizeMix,
  whenTheMoneyCame,
  type FlowSelection,
} from "../../lib/kalshiFlow";
import {
  RANGE_LABEL,
  bookPoints,
  bookWindow,
  buildSharePoints,
  chartWindow,
  type ChartRange,
} from "../../lib/kalshiFlowSeries";
import { T } from "../../../../lib/typeScale";
import Spinner from "../Spinner";
import Chip from "./Chip";
import FlowBigBets from "./FlowBigBets";
import FlowShareChart, { type ChartMode } from "./FlowShareChart";
import FlowSizes from "./FlowSizes";
import FlowWhen from "./FlowWhen";
import { HAIRLINE, SIDE_INK } from "./flowInk";
import Seg from "./Seg";

export interface FlowGameDetailProps {
  game: NbaFlowGame | undefined;
  /** DraftKings' latest split for this game, if it has one. */
  book: NbaFlowBookGame | undefined;
  /** DraftKings' snapshots for the open line, if loaded. */
  bookSeries: NbaFlowBookSeries | null;
  bands: NbaFlowGapBands | null;
  selection: FlowSelection;
  phase: NbaFlowPhase;
  /** The response for exactly this selection, or null while it loads. */
  detail: NbaFlowGameDetail | null;
  /** The last response for this game AND line, kept while a rung change loads
   *  so the rung select (its focus and width) does not disappear. Null after a
   *  line change: the old line's rungs must not stay selectable. */
  previous: NbaFlowGameDetail | null;
  error: string | null;
  range: ChartRange;
  mode: ChartMode;
  price: boolean;
  onRange: (r: ChartRange) => void;
  onMode: (m: ChartMode) => void;
  onPrice: (on: boolean) => void;
  onLine: (line: NbaFlowLineKey) => void;
  onRung: (rung: string | null) => void;
  onClose: () => void;
}

const SELECT_CLASS = "rounded border border-line bg-bg px-2 py-1 text-text focus:border-accent focus:outline-none";
const QUIET = { ...T.label, fontWeight: 400, letterSpacing: "normal", color: "var(--text-dim)" } as const;

/** Render `**bold**` spans from the read sentences. */
export function Emph({ text }: { text: string }) {
  return (
    <>
      {text.split("**").map((part, i) =>
        i % 2 === 1 ? (
          <b key={i} style={{ color: "var(--text-primary)", fontWeight: 600 }}>
            {part}
          </b>
        ) : (
          part
        ),
      )}
    </>
  );
}

function SectionHead({ title, meta, children }: { title: string; meta?: string; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "28px 0 10px", flexWrap: "wrap" }}>
      <h3 style={{ ...T.heading, margin: 0, color: "var(--text-primary)" }}>{title}</h3>
      {meta ? <span style={QUIET}>{meta}</span> : null}
      {children}
    </div>
  );
}

function Fig({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div style={{ ...T.metric, color: "var(--text-primary)" }}>{value}</div>
      <div style={{ ...T.bodySm, color: "var(--text-muted)" }}>{label}</div>
    </div>
  );
}

function Versus({
  tone,
  name,
  won,
  stats,
  dk,
  phase,
}: {
  tone: "a" | "b";
  name: string;
  won: boolean;
  stats: NbaFlowSide | null;
  dk: { bets: number | null; money: number | null } | null;
  phase: NbaFlowPhase;
}) {
  return (
    <div data-versus={tone}>
      <div style={{ ...T.heading, display: "flex", alignItems: "center", gap: 8, color: "var(--text-primary)" }}>
        <i aria-hidden style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: SIDE_INK[tone] }} />
        {name}
        {won ? <span style={{ ...T.label, color: "var(--up)" }}>won</span> : null}
      </div>
      {stats ? (
        <div style={{ display: "flex", flexWrap: "wrap", columnGap: 28, rowGap: 8, marginTop: 6 }}>
          <Fig value={fmtPct(stats.ticket_pct)} label={`of bets · ${fmtCount(stats.bets)}`} />
          <Fig value={fmtPct(stats.money_pct)} label={`of money · ${fmtMoney(stats.handle)}`} />
          <Fig
            value={stats.price_last == null ? "-" : `${Math.round(stats.price_last)}¢`}
            label={phase === "pregame" ? "last price before tip" : "last price"}
          />
          <Fig value={fmtCount(stats.big_bets)} label={`$1k+ bets · ${fmtMoney(stats.big_handle)}`} />
        </div>
      ) : dk && dk.bets != null && dk.money != null ? (
        <div style={{ display: "flex", flexWrap: "wrap", columnGap: 28, rowGap: 8, marginTop: 6 }}>
          <Fig value={fmtPct(dk.bets)} label="of bets · DraftKings" />
          <Fig value={fmtPct(dk.money)} label="of money · DraftKings" />
        </div>
      ) : null}
      <div style={{ ...QUIET, marginTop: 6 }} data-dk-line={tone}>
        {dk && dk.bets != null && dk.money != null ? `DraftKings ${fmtPct(dk.bets)} bets · ${fmtPct(dk.money)} money` : "no DraftKings split"}
      </div>
    </div>
  );
}

function LegendItem({ children, swatch }: { children: ReactNode; swatch: ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {swatch}
      {children}
    </span>
  );
}

const line = (color: string, extra: object = {}) => (
  <i aria-hidden style={{ display: "inline-block", flexShrink: 0, width: 14, height: 0, borderTop: `2px solid ${color}`, ...extra }} />
);

function Legend({
  mode,
  a,
  b,
  hasDk,
  price,
  onPrice,
  zones,
  dkOnly,
}: {
  dkOnly: boolean;
  mode: ChartMode;
  a: string;
  b: string;
  hasDk: boolean;
  price: boolean;
  onPrice: (on: boolean) => void;
  zones: { z1: number; z2: number } | null;
}) {
  return (
    <div style={{ ...T.bodySm, display: "flex", flexWrap: "wrap", gap: "4px 16px", color: "var(--text-muted)", margin: "-2px 0 8px" }}>
      {dkOnly ? (
        <>
          <LegendItem swatch={line(SIDE_INK.a, { borderTopStyle: "dotted" })}>{`DK money on ${shortSide(a)}`}</LegendItem>
          <LegendItem swatch={line(SIDE_INK.a, { borderTopStyle: "dashed" })}>{`DK bets on ${shortSide(a)}`}</LegendItem>
        </>
      ) : mode === "share" ? (
        <>
          <LegendItem swatch={line(SIDE_INK.a)}>{`money on ${shortSide(a)}`}</LegendItem>
          <LegendItem swatch={line(SIDE_INK.a, { borderTopStyle: "dashed" })}>{`bets on ${shortSide(a)}`}</LegendItem>
          {hasDk ? <LegendItem swatch={line(SIDE_INK.a, { borderTopStyle: "dotted" })}>{`DK money on ${shortSide(a)}`}</LegendItem> : null}
          <button
            type="button"
            aria-pressed={price}
            onClick={() => onPrice(!price)}
            style={{ ...T.bodySm, background: "transparent", border: 0, padding: 0, cursor: "pointer", color: price ? "var(--text-muted)" : "var(--text-faint)" }}
          >
            <LegendItem swatch={line("var(--text-muted)", { borderTopWidth: 1 })}>{`${shortSide(a)} price (${price ? "on" : "off"})`}</LegendItem>
          </button>
          <LegendItem swatch={line("var(--text-primary)", { borderTopWidth: 1 })}>gap without $1k+ bets</LegendItem>
        </>
      ) : (
        <>
          <LegendItem swatch={line(SIDE_INK.a)}>{`$ ${shortSide(a)}`}</LegendItem>
          <LegendItem swatch={line(SIDE_INK.b)}>{`$ ${shortSide(b)}`}</LegendItem>
          <LegendItem swatch={line("var(--text-muted)", { borderTopStyle: "dashed" })}>bets, dashed (right scale)</LegendItem>
        </>
      )}
      {dkOnly ? null : (
        <LegendItem swatch={<i aria-hidden style={{ display: "inline-block", flexShrink: 0, width: 8, height: 8, borderRadius: "50%", background: SIDE_INK.b }} />}>
          $1k+ bet, size = $
        </LegendItem>
      )}
      <LegendItem swatch={<i aria-hidden style={{ display: "inline-block", flexShrink: 0, width: 1, height: 10, background: "var(--text-muted)" }} />}>tip</LegendItem>
      {mode === "share" && zones ? (
        <span style={{ color: "var(--text-dim)" }}>
          {`gap stripe: shaded = ordinary (inside last season's middle half, ±${zones.z1}), dashed = widest fifth (±${zones.z2})`}
        </span>
      ) : null}
    </div>
  );
}

export default function FlowGameDetail(p: FlowGameDetailProps) {
  const { game, book, bookSeries, selection, phase, detail, previous, error } = p;
  const key = selection.line;
  const title = game ? `${game.away} @ ${game.home}` : selection.game;
  const teams = game ?? gameCodeTeams(selection.game);
  const ctl = detail ?? previous;
  const rungs = ctl?.rungs ?? [];
  const outage = isHandleIncomplete((detail ?? ctl)?.price_zero_share ?? game?.price_zero_share);
  const kLine = game?.lines[key] ?? null;
  const dkLine = book?.lines[key] ?? null;
  const tipIso = detail?.tip_utc ?? game?.tip_utc ?? ctl?.tip_utc ?? null;
  const tipMs = tipIso ? parseIso(tipIso) : NaN;
  const fin = game?.status === "final" && game.away_score != null && game.home_score != null;
  const includeLive = phase === "all";

  // The two sides, left (away / Over) first: the detail's own spelling when it
  // has answered, else the slate's, else DraftKings'.
  const awayRef = teams ? { away: teams.away } : undefined;
  const names: [string, string] | null = (() => {
    // The detail's own spelling when it has two sides (a game with no Kalshi bets answers []).
    const src = [detail?.sides, kLine?.sides.map((s) => s.side), dkLine?.sides.map((s) => s.side)].find((x) => x && x.length >= 2);
    if (!src) return null;
    const o = orderSides(src, key, awayRef);
    return [o[0], o[1]];
  })();

  const cell = game ? buildCell(game, key, kLine, dkLine, "kalshi") : null;
  const pregameSizes = detail?.sizes_pregame;
  const sizesRows = detail ? (phase === "pregame" ? (pregameSizes ?? detail.sizes) : detail.sizes) : null;
  const sizesNote = !detail ? "" : phase === "pregame" ? (pregameSizes ? "before tip" : "whole game (before-tip split not available)") : "whole game";
  const stats: [NbaFlowSide, NbaFlowSide] | null =
    detail && names && sizesRows && sizesRows.length > 0
      ? sideStats(sizesRows, detail.timeline, names, tipMs, includeLive)
      : kLine && names
        ? (() => {
            const f = (n: string) => kLine.sides.find((s) => s.side === n);
            const x = f(names[0]);
            const y = f(names[1]);
            return x && y ? ([x, y] as [NbaFlowSide, NbaFlowSide]) : null;
          })()
        : null;
  const bandTable = bandsFor(p.bands, key);
  const dkSide = (i: 0 | 1) => {
    const s = i === 0 ? cell?.a : cell?.b;
    return s && s.dkBetsPct != null && s.dkMoneyPct != null ? { bets: s.dkBetsPct, money: s.dkMoneyPct } : null;
  };

  const result = kLine?.result ?? null;
  const left = names?.[0] ?? "";
  const right = names?.[1] ?? "";

  // The chart.
  const dkPts = names ? bookPoints(bookSeries, key, names[0]) : [];
  const points = detail && names ? buildSharePoints(detail.timeline, names[0], names[1], { tipMs, includeLive: p.range === "all" }) : [];
  const win = (points.length > 0 ? chartWindow(points, p.range, tipMs, BUCKET_MIN) : null) ?? bookWindow(dkPts, tipMs);
  const bigAll = detail ? bigBetsFor(detail.big_bets, p.range === "all") : [];
  const bigTable = detail ? bigBetsFor(detail.big_bets, includeLive) : [];
  const hasTape = !!detail && (detail.timeline.length > 0 || (sizesRows ?? []).some((r) => r.bets > 0));
  const when = detail && names ? whenTheMoneyCame(detail.timeline, names[0], tipMs, includeLive) : [];
  const zones = bandTable ? { z1: Math.round(bandTable[50]), z2: Math.round(bandTable[80]) } : null;

  const lineTab = (k: NbaFlowLineKey) => {
    const slateLine = game?.lines[k] ?? null;
    const dk = book?.lines[k] ?? null;
    const exists = !game || !!slateLine || !!dk;
    const sub = slateLine ? rungText(slateLine) : (dk?.line_label ?? "");
    const on = key === k;
    return (
      <button
        key={k}
        type="button"
        aria-pressed={on}
        disabled={!exists}
        data-line-tab={k}
        onClick={() => p.onLine(k)}
        style={{
          ...T.body,
          background: "transparent",
          border: 0,
          borderBottom: `2px solid ${on ? "var(--text-primary)" : "transparent"}`,
          marginBottom: -1,
          padding: "6px 0",
          cursor: exists ? "pointer" : "default",
          color: on ? "var(--text-primary)" : exists ? "var(--text-muted)" : "var(--text-faint)",
        }}
      >
        {LINE_LABEL[k]}
        {sub ? <span style={{ ...T.mono, color: "var(--text-dim)" }}>{` ${sub}`}</span> : null}
      </button>
    );
  };

  return (
    <div
      data-anchor={`detail:${selection.game}:${key}`}
      data-anchor-label={`${title} · ${LINE_LABEL[key]} detail`}
      style={{ paddingBottom: 24 }}
    >
      <button
        type="button"
        onClick={p.onClose}
        style={{ ...T.body, background: "transparent", border: 0, padding: 0, margin: "18px 0 6px", cursor: "pointer", color: "var(--text-muted)" }}
      >
        {"← All games"}
      </button>
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <span style={{ ...T.title, color: "var(--text-primary)" }}>{title}</span>
        <span style={{ ...T.mono, color: "var(--text-muted)" }}>
          {fin ? `final ${game?.away_score}–${game?.home_score} · ` : ""}
          {tipIso ? `tip ${fmtEt(tipIso, true)} ET` : "tip unknown"}
        </span>
        {outage ? <Chip tone="warn">{OUTAGE_CHIP}</Chip> : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 18, margin: "12px 0 18px", borderBottom: HAIRLINE }}>
        {LINE_KEYS.map(lineTab)}
        {rungs.length > 1 ? (
          <label style={{ ...T.bodySm, marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)" }}>
            rung
            <select
              className={SELECT_CLASS}
              style={T.mono}
              value={(detail ? detail.rung : (selection.rung ?? ctl?.rung)) ?? ""}
              aria-busy={!detail}
              onChange={(e) => p.onRung(e.target.value || null)}
            >
              {rungs.map((r) => (
                <option key={r.rung} value={r.rung}>
                  {r.label ?? r.rung} {"·"} {fmtBets(r.bets)} {"·"} {fmtMoney(r.handle)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {!names ? (
        <div style={{ ...T.bodySm, color: "var(--text-faint)" }}>
          {error && !detail ? fetchErrorText(error) : detail ? "no bets or splits recorded on this line" : <Spinner label="loading game flow…" />}
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 28 }}>
            <Versus tone="a" name={left} won={!!result && result === left} stats={stats?.[0] ?? null} dk={dkSide(0)} phase={phase} />
            <Versus tone="b" name={right} won={!!result && result === right} stats={stats?.[1] ?? null} dk={dkSide(1)} phase={phase} />
          </div>

          <p
            data-read
            style={{ ...T.body, margin: "18px 0 0", padding: "10px 0", borderTop: HAIRLINE, borderBottom: HAIRLINE, color: "var(--text-secondary)" }}
          >
            {stats ? (
              <>
                <Emph text={leanSentence(stats[0], stats[1])} /> <Emph text={gapSentence(gapRead(stats[0], stats[1], bandTable), key)} />{" "}
                <Emph text={avgBetSentence(avgBet(stats[0], stats[1]))} />
                {result ? <span style={{ color: "var(--text-muted)" }}>{` Result: ${result}.`}</span> : null}
              </>
            ) : (
              "No Kalshi bets on this line, so there is no dollar figure, no big-bet breakdown and no gap zone: only DraftKings' percentages (above) and its snapshots (below)."
            )}
          </p>

          <SectionHead title="Money vs bets over time">
            <Seg
              label="chart mode"
              value={p.mode}
              onChange={p.onMode}
              options={[
                { key: "share", label: "share" },
                { key: "totals", label: "totals" },
              ]}
            />
            <Seg
              label="chart range"
              value={p.range}
              onChange={p.onRange}
              options={(["6h", "pre", "all"] as const).map((k) => ({ key: k, label: RANGE_LABEL[k] }))}
            />
          </SectionHead>
          {win ? (
            <>
              <Legend dkOnly={points.length === 0} mode={p.mode} a={left} b={right} hasDk={dkPts.length > 0} price={p.price} onPrice={p.onPrice} zones={points.length > 0 ? zones : null} />
              <FlowShareChart
                mode={p.mode}
                points={points}
                window={win}
                a={left}
                b={right}
                bigBets={bigAll}
                dk={dkPts}
                showPrice={p.price}
                bands={bandTable}
                tipMs={tipMs}
                bucketMin={BUCKET_MIN}
              />
            </>
          ) : (
            <div style={{ ...T.bodySm, color: "var(--text-faint)" }}>
              {!detail && !error ? (
                <Spinner label="loading game flow…" />
              ) : error && !detail ? (
                fetchErrorText(error)
              ) : (
                "fewer than 20 bets on this line so far - too few to chart a share"
              )}
            </div>
          )}

          {detail && hasTape ? (
            <>
              <SectionHead title="When the money came in" meta={`${shortSide(left)} share inside each window · ${includeLive ? "whole game" : "before tip"}`} />
              <FlowWhen rows={when} left={left} />
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.1fr) minmax(0,1fr)", gap: 36 }}>
                <div>
                  <SectionHead title="Who bet what size" meta={sizesNote} />
                  <FlowSizes rows={sizeMix(sizesRows ?? [], left, right)} a={left} b={right} />
                </div>
                <div>
                  <SectionHead title="$1k+ bets" meta={`${bigTable.length} bets, ${includeLive ? "whole game" : "before tip"}`} />
                  <FlowBigBets bets={bigTable} a={left} />
                </div>
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
