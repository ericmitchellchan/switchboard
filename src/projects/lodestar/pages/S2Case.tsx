/**
 * S2 Case — failed-touch break continuation (SWIT-16), visualized.
 *
 * Centerpiece: the ERA-DECAY CURVE — continuation rate vs target size, one line per era.
 * The finding it draws: "short the break" was a 2009-18 edge that has largely decayed at
 * trade scale (modern ES ~25% @0.2u), while the small first push survives everywhere.
 * Same labeling discipline as S1: slope + prior-defense are CAUSAL, regime is HINDSIGHT.
 * Every conditioning table carries a modern-era column so era-honesty is on-screen.
 *
 * Hand-rolled SVG, no chart libs (project convention).
 */

import { useEffect, useMemo, useState } from "react";
import { getJson } from "../api/client";

const OK = "#4ea96a";
const FAIL = "#e0645b";
const WARN = "#d9a441";
const SEL = "#8ab4f8";
const ERA_TONE: Record<string, string> = {
  all: "#9aa3b2", "09-13": "#8ab4f8", "14-18": "#d9a441", "19-23": "#e0645b",
};

interface Rate { cont: number; n: number }
interface SplitRow { key: string; cont: number; n: number; cont_big: number | null; cont_big_modern: number | null }
interface S2Summary {
  available: boolean;
  instrument: string;
  fracs: number[];
  events_total: number;
  curves: Record<string, (Rate | null)[]>;
  slope: SplitRow[];
  prior_defense: SplitRow[];
  regime: SplitRow[];
  era_strip: { year: number; unit_pts: number; holdout: boolean; cont: number | null; n: number }[];
  definitions: { event: string; entry: string; continue: string; headline_frac: number };
}

interface ExampleEvent {
  session: string; side: string; test_no: number; outcome: string; regime: string;
  event_idx: number; break_idx: number; target_idx: number | null; reverse_idx: number | null;
  bars: { ts: string; o: number; h: number; l: number; c: number; ema: number | null }[];
}

/** One real break event: candles + ema + touch/break/reverse markers. */
function ExampleChart({ ev }: { ev: ExampleEvent }) {
  const W = 570, H = 240, PAD_L = 44;
  const bars = ev.bars;
  const lo = Math.min(...bars.map((b) => b.l));
  const hi = Math.max(...bars.map((b) => b.h));
  const span = hi - lo || 1;
  const bw = (W - PAD_L - 6) / bars.length;
  const x = (i: number) => PAD_L + i * bw + bw / 2;
  const y = (p: number) => 8 + (1 - (p - lo) / span) * (H - 30);
  const emaPath = bars
    .map((b, i) => (b.ema != null ? `${i === 0 || bars[i - 1].ema == null ? "M" : "L"}${x(i)},${y(b.ema)}` : ""))
    .join(" ");
  const ok = ev.outcome === "CONTINUE";
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="select-none">
      {[0.25, 0.75].map((f) => (
        <text key={f} x={2} y={y(lo + f * span) + 3} fill="#6b7280" fontFamily="monospace" fontSize={8.5}>
          {(lo + f * span).toFixed(1)}
        </text>
      ))}
      {bars.map((b, i) => {
        const up = b.c >= b.o;
        return (
          <g key={b.ts} opacity={i === ev.break_idx ? 1 : 0.8}>
            <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} stroke={up ? OK : FAIL} strokeWidth={Math.min(bw * 0.5, 1)} />
            <line x1={x(i)} x2={x(i)} y1={y(Math.max(b.o, b.c))} y2={y(Math.min(b.o, b.c))}
                  stroke={up ? OK : FAIL} strokeWidth={Math.max(Math.min(bw * 0.8, 2.4), 0.7)} />
          </g>
        );
      })}
      <path d={emaPath} fill="none" stroke={SEL} strokeWidth={1.6} opacity={0.9} />
      <line x1={x(ev.event_idx)} x2={x(ev.event_idx)} y1={6} y2={H - 22} stroke={WARN} strokeWidth={1.2} strokeDasharray="4 3" />
      <text x={x(ev.event_idx) + 3} y={16} fill={WARN} fontFamily="monospace" fontSize={9}>touch #{ev.test_no}</text>
      <line x1={x(ev.break_idx)} x2={x(ev.break_idx)} y1={6} y2={H - 22} stroke={FAIL} strokeWidth={1.2} strokeDasharray="4 3" />
      <text x={x(ev.break_idx) + 3} y={28} fill={FAIL} fontFamily="monospace" fontSize={9}>break = entry</text>
      {ev.target_idx != null && ev.target_idx < bars.length && (
        <>
          <line x1={x(ev.target_idx)} x2={x(ev.target_idx)} y1={6} y2={H - 22} stroke={OK} strokeWidth={1.2} strokeDasharray="4 3" />
          <text x={x(ev.target_idx) + 3} y={40} fill={OK} fontFamily="monospace" fontSize={9}>target hit</text>
        </>
      )}
      {ev.reverse_idx != null && ev.reverse_idx < bars.length && (
        <>
          <line x1={x(ev.reverse_idx)} x2={x(ev.reverse_idx)} y1={6} y2={H - 22} stroke={SEL} strokeWidth={1.1} strokeDasharray="2 3" />
          <text x={x(ev.reverse_idx) + 3} y={52} fill={SEL} fontFamily="monospace" fontSize={9}>
            {ev.outcome === "CONTINUE" ? "reverse (after target)" : "reverse = exit"}
          </text>
        </>
      )}
      <text x={W - 4} y={16} textAnchor="end" fill={ok ? OK : FAIL} fontFamily="monospace" fontSize={11}>
        {ev.outcome}
      </text>
      <text x={PAD_L} y={H - 8} fill="#6b7280" fontFamily="monospace" fontSize={9}>
        {ev.session} · {ev.side}-side touch failed · {ev.regime.replace("_", " ")} · blue = ema_avg
      </text>
    </svg>
  );
}

interface TapeBar { ts: string; o: number; h: number; l: number; c: number; e20: number | null; e50: number | null; e100: number | null; e200: number | null; vwap: number | null }
interface TapeDeal {
  instrument: string; session: string; side: string; test_no: number;
  cut_idx: number;
  context: { et_time: string; weekday: string; session_chg_pct: number | null };
  visible_bars: TapeBar[];
  reveal: {
    hidden_bars: TapeBar[]; date: string; regime: string; outcome: string;
    break_dir: string; score_long_u: number | null; score_short_u: number | null;
  };
}

interface TapeTally {
  n: number;
  counts: { long: number; short: number; flat: number };
  traded_mean_u: number | null;
  traded_win_rate: number | null;
  agree_break_rate: number | null;
}

const TAPE_LINES: { key: "e20" | "e50" | "e100" | "e200" | "vwap"; color: string; dash?: string; label: string }[] = [
  { key: "e20", color: "#d9a441", label: "ema20" },
  { key: "e50", color: "#4ea96a", label: "ema50" },
  { key: "e100", color: "#8ab4f8", label: "ema100" },
  { key: "e200", color: "#c07bd8", label: "ema200" },
  { key: "vwap", color: "#e8e8e8", dash: "5 4", label: "vwap" },
];

/** The blind chart: Eric's real screen (4 EMAs + session VWAP, 1m), frozen at the cut. */
function TapeChart({ deal, revealed }: { deal: TapeDeal; revealed: boolean }) {
  const W = 1180, H = 300, PAD_L = 44;
  const bars: TapeBar[] = revealed ? [...deal.visible_bars, ...deal.reveal.hidden_bars] : deal.visible_bars;
  const total = deal.visible_bars.length + deal.reveal.hidden_bars.length;
  const lo = Math.min(...bars.map((b) => b.l));
  const hi = Math.max(...bars.map((b) => b.h));
  const span = hi - lo || 1;
  const bw = (W - PAD_L - 6) / total;  // fixed x-scale: the reveal extends, nothing rescales
  const x = (i: number) => PAD_L + i * bw + bw / 2;
  const y = (p: number) => 8 + (1 - (p - lo) / span) * (H - 30);
  const linePath = (key: "e20" | "e50" | "e100" | "e200" | "vwap") => bars
    .map((b, i) => (b[key] != null ? `${i === 0 || bars[i - 1][key] == null ? "M" : "L"}${x(i)},${y(b[key] as number)}` : ""))
    .join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="select-none">
      {[0.25, 0.75].map((f) => (
        <text key={f} x={2} y={y(lo + f * span) + 3} fill="#6b7280" fontFamily="monospace" fontSize={8.5}>
          {(lo + f * span).toFixed(1)}
        </text>
      ))}
      {bars.map((b, i) => {
        const up = b.c >= b.o;
        return (
          <g key={b.ts} opacity={0.85}>
            <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} stroke={up ? OK : FAIL} strokeWidth={Math.min(bw * 0.5, 1)} />
            <line x1={x(i)} x2={x(i)} y1={y(Math.max(b.o, b.c))} y2={y(Math.min(b.o, b.c))}
                  stroke={up ? OK : FAIL} strokeWidth={Math.max(Math.min(bw * 0.8, 2.2), 0.6)} />
          </g>
        );
      })}
      {TAPE_LINES.map((ln) => (
        <path key={ln.key} d={linePath(ln.key)} fill="none" stroke={ln.color} strokeWidth={1.2}
              strokeDasharray={ln.dash} opacity={0.85} />
      ))}
      {TAPE_LINES.map((ln, k) => (
        <g key={ln.key}>
          <rect x={W - 420 + k * 78} y={10} width={10} height={3} fill={ln.color} />
          <text x={W - 406 + k * 78} y={16} fill="#9aa3b2" fontFamily="monospace" fontSize={9}>{ln.label}</text>
        </g>
      ))}
      {revealed && (
        <>
          <line x1={x(deal.cut_idx)} x2={x(deal.cut_idx)} y1={6} y2={H - 22} stroke={WARN} strokeWidth={1.2} strokeDasharray="4 3" />
          <text x={x(deal.cut_idx) + 3} y={30} fill={WARN} fontFamily="monospace" fontSize={9}>your moment</text>
          <text x={W - 6} y={H - 8} textAnchor="end"
                fill={deal.reveal.outcome === "CONTINUE" ? OK : FAIL} fontFamily="monospace" fontSize={10}>
            {deal.reveal.date} · mechanical break-trade dir: {deal.reveal.break_dir} · {deal.reveal.outcome}
          </text>
        </>
      )}
      {!revealed && (
        <text x={W - 6} y={H - 8} textAnchor="end" fill="#6b7280" fontFamily="monospace" fontSize={10}>
          future hidden — what would you do at the last bar?
        </text>
      )}
    </svg>
  );
}

/** Blind tape test v2: long / short / nothing at a frozen moment (Eric's spec). */
function TapePanel({ instrument }: { instrument: string }) {
  const [deal, setDeal] = useState<TapeDeal | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [lastScore, setLastScore] = useState<number | null>(null);
  const [tally, setTally] = useState<TapeTally | null>(null);
  const [busy, setBusy] = useState(false);

  const dealOne = () => {
    setBusy(true);
    setRevealed(false);
    setLastScore(null);
    const seed = Math.floor(Math.random() * 1_000_000);
    getJson<TapeDeal>(`/sextant/s2/${instrument}/tape?seed=${seed}`)
      .then((d) => setDeal(d))
      .finally(() => setBusy(false));
  };

  const answer = (choice: "long" | "short" | "flat") => {
    if (!deal || revealed) return;
    const score = choice === "flat" ? 0
      : choice === "long" ? deal.reveal.score_long_u : deal.reveal.score_short_u;
    setLastScore(score);
    setRevealed(true);
    getJson<TapeTally>("/sextant/s2/tape/answer", {
      method: "POST",
      body: JSON.stringify({
        instrument: deal.instrument, session: deal.session, side: deal.side,
        test_no: deal.test_no, choice, score_u: score,
        agree_break: choice === "flat" ? null : choice === deal.reveal.break_dir,
        outcome: deal.reveal.outcome,
      }),
    }).then(setTally).catch(() => undefined);
  };

  return (
    <div className="rounded-lg border border-line bg-surface/20 p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="font-mono text-[11px] uppercase tracking-wider">
          blind tape test <span className="text-dim normal-case">— your screen, a frozen random moment, three choices. graded by a symmetric bracket (0.05u target/stop, net) in your chosen direction</span>
        </div>
        <button onClick={dealOne} disabled={busy}
                className="rounded-md border border-line px-2 py-0.5 font-mono text-[10px] text-dim hover:text-fg">
          {deal ? "next ↻" : "deal"}
        </button>
      </div>
      {!deal && <div className="p-4 font-mono text-xs text-dim">hit deal — a random 1m moment with your indicators (ema 20/50/100/200 + vwap), future hidden, date hidden. Call it: long, short, or nothing.</div>}
      {deal && (
        <>
          <div className="mb-1 flex gap-3 font-mono text-[11px]">
            <span className="rounded border border-line px-2 py-0.5">{deal.context.weekday} · {deal.context.et_time}</span>
            {deal.context.session_chg_pct != null && (
              <span className="rounded border border-line px-2 py-0.5"
                    style={{ color: deal.context.session_chg_pct >= 0 ? OK : FAIL }}>
                session {deal.context.session_chg_pct >= 0 ? "+" : ""}{deal.context.session_chg_pct}% vs prior close
              </span>
            )}
            <span className="rounded border border-line px-2 py-0.5 text-dim">{instrument} · 1m</span>
          </div>
          <TapeChart deal={deal} revealed={revealed} />
          <div className="mt-2 flex items-center gap-2">
            <button onClick={() => answer("long")} disabled={revealed}
                    className="rounded-md border border-emerald-800 px-3 py-1 font-mono text-xs text-emerald-400 disabled:opacity-40 hover:bg-emerald-950/40">
              LONG
            </button>
            <button onClick={() => answer("flat")} disabled={revealed}
                    className="rounded-md border border-line px-3 py-1 font-mono text-xs text-dim disabled:opacity-40 hover:text-fg">
              nothing
            </button>
            <button onClick={() => answer("short")} disabled={revealed}
                    className="rounded-md border border-red-900 px-3 py-1 font-mono text-xs text-red-400 disabled:opacity-40 hover:bg-red-950/40">
              SHORT
            </button>
            {revealed && lastScore != null && (
              <span className="font-mono text-xs text-dim">
                this call: <span style={{ color: lastScore >= 0 ? OK : FAIL }}>
                  {lastScore >= 0 ? "+" : ""}{lastScore.toFixed(4)}u
                </span>
              </span>
            )}
            {tally && (
              <span className="ml-auto font-mono text-[11px] text-dim">
                n={tally.n} · L/–/S {tally.counts.long}/{tally.counts.flat}/{tally.counts.short}
                {tally.traded_mean_u != null && <> · traded avg <span className="text-fg">{tally.traded_mean_u >= 0 ? "+" : ""}{tally.traded_mean_u.toFixed(4)}u</span></>}
                {tally.traded_win_rate != null && <> · {(tally.traded_win_rate * 100).toFixed(0)}%w</>}
              </span>
            )}
          </div>
          <div className="mt-1.5 text-[10px] leading-snug text-dim">
            the mechanical baseline on these same moments is ~zero net. if your traded average
            runs positive over 30+ calls, your eye carries entry-time information no feature has
            captured — and it becomes the spec for the regime detectors. decision 2 (in-position
            management after an entry) is a separate deal type, later.
          </div>
        </>
      )}
    </div>
  );
}

interface ScrubBar extends TapeBar { et: string }
interface ScrubDeal {
  instrument: string; session: string; weekday: string; prior_close: number | null;
  rth_start_idx: number; offset: number; bars: ScrubBar[];
}
interface ScrubResult {
  scores: Record<string, number>;
  tally: { days: number; passed: number; traded: number; mean_T05_S05: number | null; win_rate: number | null };
}

/** Pick-your-spot: the day up to the cursor; after firing, the whole day. */
function ScrubChart({ deal, cursor, entryIdx }: { deal: ScrubDeal; cursor: number; entryIdx: number | null }) {
  const W = 1180, H = 300, PAD_L = 44;
  const shown = deal.bars.slice(0, cursor + 1);
  const lo = Math.min(...shown.map((b) => b.l));
  const hi = Math.max(...shown.map((b) => b.h));
  const span = hi - lo || 1;
  const bw = (W - PAD_L - 6) / deal.bars.length;  // full-day x-scale; right side stays blank until earned
  const x = (i: number) => PAD_L + i * bw + bw / 2;
  const y = (p: number) => 8 + (1 - (p - lo) / span) * (H - 30);
  const linePath = (key: "e20" | "e50" | "e100" | "e200" | "vwap") => shown
    .map((b, i) => (b[key] != null ? `${i === 0 || shown[i - 1][key] == null ? "M" : "L"}${x(i)},${y(b[key] as number)}` : ""))
    .join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="select-none">
      {[0.25, 0.75].map((f) => (
        <text key={f} x={2} y={y(lo + f * span) + 3} fill="#6b7280" fontFamily="monospace" fontSize={8.5}>
          {(lo + f * span).toFixed(1)}
        </text>
      ))}
      {shown.map((b, i) => {
        const up = b.c >= b.o;
        return (
          <g key={b.ts} opacity={i < deal.rth_start_idx ? 0.55 : 0.85}>
            <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} stroke={up ? OK : FAIL} strokeWidth={Math.min(bw * 0.5, 1)} />
            <line x1={x(i)} x2={x(i)} y1={y(Math.max(b.o, b.c))} y2={y(Math.min(b.o, b.c))}
                  stroke={up ? OK : FAIL} strokeWidth={Math.max(Math.min(bw * 0.8, 2.2), 0.6)} />
          </g>
        );
      })}
      {TAPE_LINES.map((ln) => (
        <path key={ln.key} d={linePath(ln.key)} fill="none" stroke={ln.color} strokeWidth={1.2}
              strokeDasharray={ln.dash} opacity={0.85} />
      ))}
      {TAPE_LINES.map((ln, k) => (
        <g key={ln.key}>
          <rect x={W - 420 + k * 78} y={10} width={10} height={3} fill={ln.color} />
          <text x={W - 406 + k * 78} y={16} fill="#9aa3b2" fontFamily="monospace" fontSize={9}>{ln.label}</text>
        </g>
      ))}
      <line x1={x(deal.rth_start_idx)} x2={x(deal.rth_start_idx)} y1={6} y2={H - 22} stroke="#3a4152" strokeWidth={1} strokeDasharray="2 4" />
      <text x={x(deal.rth_start_idx) + 3} y={H - 26} fill="#6b7280" fontFamily="monospace" fontSize={8.5}>RTH open</text>
      {entryIdx != null && entryIdx <= cursor && (
        <>
          <line x1={x(entryIdx)} x2={x(entryIdx)} y1={6} y2={H - 22} stroke={WARN} strokeWidth={1.3} strokeDasharray="4 3" />
          <text x={x(entryIdx) + 3} y={30} fill={WARN} fontFamily="monospace" fontSize={9}>your entry</text>
        </>
      )}
    </svg>
  );
}

/** Pick-your-spot deck (tape v3): measures moment-SELECTION, the real discretionary skill. */
function ScrubPanel({ instrument }: { instrument: string }) {
  const [deal, setDeal] = useState<ScrubDeal | null>(null);
  const [cursor, setCursor] = useState(0);
  const [entryIdx, setEntryIdx] = useState<number | null>(null);
  const [result, setResult] = useState<ScrubResult | null>(null);
  const [busy, setBusy] = useState(false);

  const dealDay = () => {
    setBusy(true);
    setResult(null);
    setEntryIdx(null);
    const seed = Math.floor(Math.random() * 1_000_000);
    getJson<ScrubDeal>(`/sextant/s2/${instrument}/scrub?seed=${seed}`)
      .then((d) => { setDeal(d); setCursor(d.rth_start_idx); })
      .finally(() => setBusy(false));
  };

  const advance = (mins: number) => {
    if (!deal || result) return;
    setCursor((c) => Math.min(c + mins, deal.bars.length - 1));
  };

  const fire = (choice: "long" | "short" | "pass") => {
    if (!deal || result || busy) return;
    setBusy(true);  // in-flight guard: a fast double-click double-counted the tally (review)
    const barI = choice === "pass" ? -1 : cursor + deal.offset;
    if (choice !== "pass") {
      setEntryIdx(cursor);
      setCursor(deal.bars.length - 1);  // reveal the rest of the day
    }
    getJson<ScrubResult>("/sextant/s2/scrub/answer", {
      method: "POST",
      body: JSON.stringify({ instrument: deal.instrument, session: deal.session, bar_i: barI, choice }),
    }).then((r) => {
      // pass: deal the next day only AFTER the POST resolves — a synchronous dealDay()
      // raced the response and left the fresh day gated behind a stale non-null result
      if (choice === "pass") dealDay();
      else { setResult(r); setBusy(false); }
    }).catch(() => setBusy(false));
  };

  const atEnd = deal ? cursor >= deal.bars.length - 1 : false;
  const cur = deal ? deal.bars[Math.min(cursor, deal.bars.length - 1)] : null;
  const pct = deal && cur && deal.prior_close ? (100 * (cur.c / deal.prior_close - 1)) : null;

  return (
    <div className="rounded-lg border border-line bg-surface/20 p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="font-mono text-[11px] uppercase tracking-wider">
          pick your spot <span className="text-dim normal-case">— a random day, date hidden. step forward; fire only when YOU would. passing the day is a scored, respected call</span>
        </div>
        <button onClick={dealDay} disabled={busy}
                className="rounded-md border border-line px-2 py-0.5 font-mono text-[10px] text-dim hover:text-fg">
          {deal ? "next day ↻" : "deal a day"}
        </button>
      </div>
      {!deal && <div className="p-4 font-mono text-xs text-dim">deal a day — you start at the RTH open with the overnight visible. Walk forward and engage only where your eye says so. This measures the skill the forced-moment deck stripped: choosing WHEN.</div>}
      {deal && cur && (
        <>
          <div className="mb-1 flex gap-3 font-mono text-[11px]">
            <span className="rounded border border-line px-2 py-0.5">{deal.weekday} · {cur.et} ET</span>
            {pct != null && (
              <span className="rounded border border-line px-2 py-0.5" style={{ color: pct >= 0 ? OK : FAIL }}>
                session {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
              </span>
            )}
            <span className="rounded border border-line px-2 py-0.5 text-dim">{instrument} · 1m</span>
          </div>
          <ScrubChart deal={deal} cursor={cursor} entryIdx={entryIdx} />
          <div className="mt-2 flex items-center gap-2">
            {!result && (
              <>
                {[5, 15, 30].map((m) => (
                  <button key={m} onClick={() => advance(m)} disabled={atEnd}
                          className="rounded-md border border-line px-2.5 py-1 font-mono text-xs text-dim disabled:opacity-40 hover:text-fg">
                    +{m}m
                  </button>
                ))}
                <span className="mx-1 text-line">|</span>
                <button onClick={() => fire("long")}
                        className="rounded-md border border-emerald-800 px-3 py-1 font-mono text-xs text-emerald-400 hover:bg-emerald-950/40">
                  LONG here
                </button>
                <button onClick={() => fire("short")}
                        className="rounded-md border border-red-900 px-3 py-1 font-mono text-xs text-red-400 hover:bg-red-950/40">
                  SHORT here
                </button>
                <button onClick={() => fire("pass")}
                        className="rounded-md border border-line px-3 py-1 font-mono text-xs text-dim hover:text-fg">
                  pass the day
                </button>
              </>
            )}
            {result && result.scores && Object.keys(result.scores).length > 0 && (
              <span className="font-mono text-[11px] text-dim">
                {Object.entries(result.scores).map(([k, v]) => (
                  <span key={k} className="mr-3">{k.replace("_", "/")}: <span style={{ color: v >= 0 ? OK : FAIL }}>{v >= 0 ? "+" : ""}{v.toFixed(4)}u</span></span>
                ))}
              </span>
            )}
            {result && (
              <span className="ml-auto font-mono text-[11px] text-dim">
                days {result.tally.days} · passed {result.tally.passed} · traded {result.tally.traded}
                {result.tally.mean_T05_S05 != null && <> · avg <span className="text-fg">{result.tally.mean_T05_S05 >= 0 ? "+" : ""}{result.tally.mean_T05_S05.toFixed(4)}u</span></>}
                {result.tally.win_rate != null && <> · {(result.tally.win_rate * 100).toFixed(0)}%w</>}
              </span>
            )}
            {result && (
              <button onClick={dealDay}
                      className="rounded-md border border-line px-2.5 py-1 font-mono text-xs text-dim hover:text-fg">
                next day ↻
              </button>
            )}
          </div>
          <div className="mt-1.5 text-[10px] leading-snug text-dim">
            graded across the whole template ladder at once (brackets, 30m close, end-of-day close) so
            the ruler can never be the excuse again. selection rate matters as much as accuracy: the
            best discretionary result may be trading 2 days in 10.
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-line bg-surface/40 px-3 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-wider text-dim">{label}</div>
      <div className="font-mono text-sm" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );
}

/** Continuation rate vs target size — one line per era. The decay IS the finding. */
function EraDecayCurve({ d, tradableFrac }: { d: S2Summary; tradableFrac: number | null }) {
  const W = 1180, H = 360, PAD_L = 46, PAD_B = 34;
  const x = (i: number) => PAD_L + (i / (d.fracs.length - 1)) * (W - PAD_L - 12);
  const y = (v: number) => 10 + (1 - v) * (H - PAD_B - 14);
  const order = ["09-13", "14-18", "19-23", "all"];
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="select-none">
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={W - 4} y1={y(t)} y2={y(t)} stroke="#2a2f3a" strokeWidth={1} opacity={0.6} />
          <text x={2} y={y(t) + 3} fill="#6b7280" fontFamily="monospace" fontSize={9}>{(t * 100).toFixed(0)}%</text>
        </g>
      ))}
      <line x1={PAD_L} x2={W - 4} y1={y(0.5)} y2={y(0.5)} stroke="#6b7280" strokeWidth={1} strokeDasharray="3 4" />
      {d.fracs.map((f, i) => (
        <text key={f} x={x(i)} y={H - 18} textAnchor="middle" fill="#6b7280" fontFamily="monospace" fontSize={9}>
          {f}
        </text>
      ))}
      <text x={(PAD_L + W) / 2} y={H - 4} textAnchor="middle" fill="#6b7280" fontFamily="monospace" fontSize={9}>
        continuation target — fraction of a typical day's range (vol units, fixed at the touch)
      </text>
      {tradableFrac != null && tradableFrac >= d.fracs[0] && tradableFrac <= d.fracs[d.fracs.length - 1] && (() => {
        let i = 0;
        while (i < d.fracs.length - 1 && d.fracs[i + 1] < tradableFrac) i++;
        const t = (tradableFrac - d.fracs[i]) / (d.fracs[i + 1] - d.fracs[i]);
        const xv = x(i) + t * (x(i + 1) - x(i));
        return (
          <g>
            <line x1={xv} x2={xv} y1={8} y2={H - PAD_B} stroke={SEL} strokeWidth={1.2} strokeDasharray="6 4" />
            <text x={xv + 4} y={18} fill={SEL} fontFamily="monospace" fontSize={9}>
              ≥{d.instrument === "NQ" ? 10 : 3} pts at the last train year's vol (execution lens)
            </text>
          </g>
        );
      })()}
      {order.map((era) => {
        const pts = d.curves[era];
        if (!pts) return null;
        const path = pts
          .map((p, i) => (p ? `${i === 0 || !pts[i - 1] ? "M" : "L"}${x(i)},${y(p.cont)}` : ""))
          .join(" ");
        return (
          <g key={era}>
            <path d={path} fill="none" stroke={ERA_TONE[era]} strokeWidth={era === "all" ? 1.2 : 1.9}
                  strokeDasharray={era === "all" ? "3 4" : undefined} opacity={era === "all" ? 0.7 : 1} />
            {pts.map((p, i) => p && (
              <circle key={i} cx={x(i)} cy={y(p.cont)} r={era === "all" ? 1.8 : 2.4} fill={ERA_TONE[era]}>
                <title>{`${era} · target ${d.fracs[i]}u · continue ${(p.cont * 100).toFixed(1)}% · n=${p.n.toLocaleString()}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
      {order.map((era, k) => (
        <g key={era}>
          <rect x={W - 150} y={16 + k * 16} width={10} height={3} fill={ERA_TONE[era]} />
          <text x={W - 134} y={22 + k * 16} fill="#9aa3b2" fontFamily="monospace" fontSize={10}>
            {era === "all" ? "pooled" : era}
          </text>
        </g>
      ))}
    </svg>
  );
}

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}

function SplitTable({ title, tone, tag, rows, note }: { title: string; tone: string; tag: string; rows: SplitRow[]; note: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface/20 p-3">
      <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider">
        {title} <span className="normal-case" style={{ color: tone }}>{tag}</span>
      </div>
      <table className="w-full font-mono text-[11px]">
        <thead>
          <tr className="text-left text-[9px] uppercase tracking-wider text-dim">
            <th className="py-0.5"></th><th>cont @0.05u</th><th>@0.2u</th><th className="text-right">@0.2u · 19-23</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-line/40">
              <td className="py-1">{r.key.replace("_", " ")}</td>
              <td>{pct(r.cont)} <span className="text-dim">n={r.n.toLocaleString()}</span></td>
              <td>{pct(r.cont_big)}</td>
              <td className="text-right" style={{ color: WARN }}>{pct(r.cont_big_modern)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1.5 text-[10px] leading-snug text-dim">{note}</div>
    </div>
  );
}

export default function S2Case() {
  const [data, setData] = useState<S2Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [instrument, setInstrument] = useState("ES");
  const [seed, setSeed] = useState(0);
  const [exCont, setExCont] = useState<ExampleEvent | null>(null);
  const [exRev, setExRev] = useState<ExampleEvent | null>(null);

  useEffect(() => {
    setExCont(null);
    setExRev(null);
    getJson<{ examples: ExampleEvent[] }>(`/sextant/s2/${instrument}/examples?outcome=CONTINUE&seed=${seed}`)
      .then((r) => setExCont(r.examples[0] ?? null)).catch(() => setExCont(null));
    getJson<{ examples: ExampleEvent[] }>(`/sextant/s2/${instrument}/examples?outcome=REVERSE&seed=${seed}`)
      .then((r) => setExRev(r.examples[0] ?? null)).catch(() => setExRev(null));
  }, [instrument, seed]);

  useEffect(() => {
    setData(null);
    setErr(null);
    getJson<S2Summary>(`/sextant/s2/${instrument}`)
      .then((d) => { setData(d); setErr(null); })
      .catch((e) => setErr(String(e)));
  }, [instrument]);

  // execution lens off the LAST TRAIN year's vol unit (never holdout-era vol)
  const tradableFrac = useMemo(() => {
    if (!data) return null;
    const latest = [...data.era_strip].reverse().find((e) => !e.holdout && e.unit_pts > 0);
    if (!latest) return null;
    const pts = instrument === "NQ" ? 10 : 3;
    return pts / latest.unit_pts;
  }, [data, instrument]);

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 font-mono text-sm uppercase tracking-wider">S2 · the failed-touch break</h1>
        {["ES", "NQ"].map((s) => (
          <button key={s} onClick={() => setInstrument(s)}
                  className={`rounded-md border px-2.5 py-1 font-mono text-xs ${instrument === s ? "border-accent text-accent" : "border-line text-dim hover:text-fg"}`}>
            {s}
          </button>
        ))}
        {data && <>
          <Tile label="break events" value={data.events_total.toLocaleString()} />
          <Tile label="arm" value="ema_avg · S1 v5 touches" />
          <Tile label="registered" value="2026-08-09 · pre-outcome" tone={OK} />
          <Tile label="split" value="train only · holdout locked" tone={OK} />
        </>}
        <div className="ml-auto max-w-lg text-right font-mono text-[10px] leading-tight text-dim">
          the question: when the defense of the average fails, is the break itself a trade?
          entry = the close that punches through · CONTINUE = it keeps going · REVERSE = it snaps back
        </div>
      </div>

      {err && <div className="rounded-md border border-red-900/60 bg-red-950/30 p-2 font-mono text-xs text-red-300">{err}</div>}
      {!data && !err && <div className="p-6 font-mono text-xs text-dim">computing…</div>}

      {data && (
        <>
          <div className="rounded-lg border border-line bg-surface/20 p-3">
            <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider">
              does the break keep going? <span className="text-dim normal-case">— by distance asked (left = a little, right = a real trade) and by years. the gap between the lines IS the finding</span>
            </div>
            <EraDecayCurve d={data} tradableFrac={tradableFrac} />
            <div className="mt-1 text-[11px] leading-snug text-dim">
              Plainly: when a dip-buy (or rally-short) at the average fails and price punches
              through, how often does it KEEP GOING that way before coming all the way back?
              Left side of the chart = small follow-through, right side = a full trade-sized move.
              Each line is a different stretch of years. The read: the small first lurch after a
              break still happens in every era — but the full-sized move mostly stopped happening
              in recent years (<span style={{ color: ERA_TONE["19-23"] }}>red line</span>): today
              roughly 3 of 4 breaks snap all the way back. Breaks still lurch; they no longer
              travel. The grey dashed line is what you'd wrongly conclude if you blended all the
              years together — an edge that no longer exists.
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <SplitTable
              title="ema slope" tone={OK} tag="you can see this live" rows={data.slope}
              note="Was the average line itself moving when the defense failed? A break of a moving line carries further than a break of a flat one. Real but modest — a few points, in every era."
            />
            <SplitTable
              title="prior defense" tone={OK} tag="you can see this live" rows={data.prior_defense}
              note="Had this level already proven itself? If earlier touches bounced hard (the level was genuinely defended) and THEN it broke, the break means something and travels further. If nobody ever really defended it, the break is noise. Eric's double-bottom read. Strong in the older years, faint recently."
            />
            <SplitTable
              title="regime at the touch" tone={FAIL} tag="only knowable after the fact" rows={data.regime}
              note="Looking back with full knowledge of what the market was truly doing: when the failed touch was AGAINST the real trend (a dip-buy inside what was actually a downtrend), its failure travels hardest — the trend simply resumes. The catch: 'what the market was truly doing' is only visible afterward, so this table is the prize for a future real-time regime detector, not something to act on today. Same bottleneck S1 found."
            />
          </div>

          <div className="rounded-lg border border-line bg-surface/20 p-3">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="font-mono text-[11px] uppercase tracking-wider">
                real examples <span className="text-dim normal-case">— SAME strategy both sides (take the break), sorted by OUTCOME only — unlike the S1 page, whose columns were sorted by trend context. Both columns mix regimes; a left chart is a winner because it won, not because it was a better class of entry.</span>
              </div>
              <button onClick={() => setSeed((s) => s + 1)}
                      className="rounded-md border border-line px-2 py-0.5 font-mono text-[10px] text-dim hover:text-fg">
                resample ↻
              </button>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <div className="mb-1 font-mono text-[10px]" style={{ color: OK }}>
                  CONTINUED — the break kept going; taking it paid
                </div>
                {exCont ? <ExampleChart ev={exCont} /> : <div className="p-6 font-mono text-xs text-dim">loading…</div>}
              </div>
              <div>
                <div className="mb-1 font-mono text-[10px]" style={{ color: FAIL }}>
                  REVERSED — it snapped back; chasing it shook you out (the modern majority)
                </div>
                {exRev ? <ExampleChart ev={exRev} /> : <div className="p-6 font-mono text-xs text-dim">loading…</div>}
              </div>
            </div>
            <div className="mt-1.5 text-[11px] leading-snug text-dim">
              left: the defenders gave up, price punched through the line and kept going — the
              green "target hit" marker is where the trade-sized move was banked; any "reverse"
              line after it is just where the ride officially ended, NOT a missed stop-out.
              right: the break happened but snapped straight back through the line (blue marker)
              before reaching any target — chasing it got you shaken out, though note how fast
              the exit fires: failures die quickly (median ~23 min ES / ~14 min NQ), which caps the damage.
              REVERSED means OUR strict exit rule fired, not that no trade was possible — a
              managed trade with a stop and a re-entry is a different, later study. hit resample
              for more.
            </div>
          </div>

          <ScrubPanel instrument={instrument} />
          <TapePanel instrument={instrument} />
        </>
      )}
    </div>
  );
}
