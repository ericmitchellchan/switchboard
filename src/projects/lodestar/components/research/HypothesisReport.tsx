/**
 * The "Generate report" full-page view (owner ask, built out). A trading report that means
 * something: the idea → the PATTERN DECOMPOSITION and why we think that way → the rules and
 * how they GENERALIZE → levels & execution with the expected move justified → SUPPORTING
 * EVIDENCE (the real historical instances and how they played out) → a SIMULATION + a clear
 * VERDICT (worth pursuing? why / why not) → risks & confidence.
 *
 * Reads only what the hypothesis + the instance analysis + the backtest provide — every
 * number traces to a rule, a bar, or a backtest column.
 */

import { useEffect, useMemo, useState } from "react";
import { useSurfaceKeydown } from "../../../../surfaces/page-api";
import { api } from "../../api/client";
import type { BacktestResult, HypLevels, Hypothesis, InstanceAnalysis } from "../../api/client";
import InstanceAnalysisView from "./InstanceAnalysisView";
import SetupDetail from "./SetupDetail";

const UP = "#4ea96a";
const DN = "#e0645b";
const AC = "#6ea8d8";
const AMBER = "#d1a05a";

// $ per point per contract (the ACTUAL traded symbol, incl. micros)
const POINT_VALUE: Record<string, number> = {
  ES: 50, MES: 5, NQ: 20, MNQ: 2, YM: 5, MYM: 0.5, RTY: 50, M2K: 5,
};
function pointValue(symbol: string): number {
  return POINT_VALUE[symbol.replace("@", "").toUpperCase()] ?? 1;
}

function pct(v: number | null | undefined, d = 2): string {
  return v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
}

function confidence(bt: BacktestResult | null): { level: string; color: string; fill: number } {
  if (!bt || bt.n === 0) return { level: "UNKNOWN", color: AMBER, fill: 0.15 };
  const e = bt.expectancy_r;
  if (e == null) return { level: "LOW · exploratory", color: AMBER, fill: 0.3 };
  if (e > 0.15 && bt.n >= 100) return { level: "MEDIUM", color: UP, fill: 0.62 };
  if (e > 0) return { level: "LOW+ · promising", color: AMBER, fill: 0.45 };
  return { level: "LOW · exploratory", color: AMBER, fill: 0.3 };
}

/** The verdict — worth pursuing? Always backed by the real numbers (spec §9). */
function verdict(bt: BacktestResult | null): { label: string; color: string; body: string } {
  if (!bt || bt.n === 0)
    return { label: "Can't judge yet", color: AMBER, body: "No setups in this window — widen it or loosen the trigger before deciding." };
  if (bt.metric !== "first_touch_atr" || bt.expectancy_r == null || bt.win_rate == null || bt.stop_rate == null)
    return { label: "Needs an ATR target", color: AMBER, body: "Set an ATR target/stop for a first-touch verdict — close-at-horizon can't price the trade." };
  const e = bt.expectancy_r;
  const rr = bt.rr ?? 1;
  const be = Math.round((100 / (1 + rr)));
  const w = Math.round(bt.win_rate * 100);
  const s = Math.round(bt.stop_rate * 100);
  if (e > 0.15 && bt.n >= 100)
    return { label: "Worth pursuing", color: UP, body: `Positive expectancy (${e}R) over ${bt.n} setups. Validate on a held-out window, then paper-trade at size.` };
  if (e > 0)
    return { label: "Promising — tune it", color: AMBER, body: `Slightly positive (${e}R). Tune the R:R or add a filter for the failure cluster, then re-run before committing.` };
  return {
    label: "Not yet — as parameterised",
    color: DN,
    body: `Negative expectancy (${e}R): a ${w}% win vs ${s}% stop at ${rr}:1 doesn't clear the ${be}% breakeven. Widen the target, tighten the entry (a vol-z / regime filter for the failure cluster), or drop it.`,
  };
}

/** A readable Markdown snapshot of the report — what lands in the knowledge base
 *  (the rich page stays live in-platform; this is the durable, commentable copy). */
function reportToMarkdown(
  h: Hypothesis,
  levels: HypLevels | null | undefined,
  bt: BacktestResult | null,
  symbol: string,
  timeframe: string,
  note: string | null | undefined,
  win: { start: string; end: string } | null | undefined,
): string {
  const v = verdict(bt);
  const L = (n: number | null | undefined): string => (n == null ? "—" : n.toLocaleString());
  const pct = (x: number | null | undefined): string => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const lines: string[] = [`# ${h.title}`, "", `\`${symbol} · ${timeframe} · ${h.leg} · ${h.target.direction}\` — ${h.trigger}`, ""];
  if (h.rationale) lines.push("## The idea", "", h.rationale, "");
  lines.push("## The rules — the live trigger", "");
  for (const c of h.conditions) lines.push(`- ${c.label}`);
  lines.push("");
  if (levels) {
    lines.push(
      "## Levels & execution",
      "",
      `- swing low: **${L(levels.swing_low)}**`,
      `- bounce est: ${L(levels.bounce_est)}`,
      `- retest zone: ${L(levels.retest_low)}–${L(levels.retest_high)}`,
      `- invalidation: ${L(levels.invalidation)}`,
    );
    if (h.target.tp_atr != null || h.target.stop_atr != null)
      lines.push(`- target ${h.target.tp_atr ?? "—"} ATR · stop ${h.target.stop_atr ?? "—"} ATR${bt?.rr != null ? ` · R:R ${bt.rr}` : ""}`);
    lines.push("");
  }
  if (bt && bt.n > 0) {
    lines.push(
      `## Simulation — ${bt.n} setups`,
      "",
      `- win ${pct(bt.win_rate)} · stop ${pct(bt.stop_rate)}${bt.rr != null ? ` · R:R ${bt.rr}` : ""}${bt.expectancy_r != null ? ` · expectancy ${bt.expectancy_r}R` : ""}`,
    );
    if (bt.note) lines.push(`- ${bt.note}`);
    lines.push("");
  }
  lines.push(`## Verdict — ${v.label}`, "", v.body, "");
  if (note) lines.push("## Your note", "", note, "");
  const w = win ? ` · window ${win.start.slice(0, 16).replace("T", " ")} → ${win.end.slice(0, 16).replace("T", " ")}` : "";
  lines.push("---", `*Snapshot from a Lodestar hypothesis report · ${symbol} ${timeframe}${w}*`);
  return lines.join("\n");
}

function Loading({ label, tall }: { label: string; tall?: boolean }) {
  return (
    <div className={`flex items-center gap-3 rounded border border-line bg-surface/30 px-4 ${tall ? "h-40" : "py-4"}`}>
      <span className="inline-flex gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: AC, animationDelay: `${i * 160}ms` }} />
        ))}
      </span>
      <span className="font-mono text-[11px] text-dim">{label}</span>
    </div>
  );
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-dim">
        <span className="mr-2 text-dim2">{n}</span>
        {title}
      </div>
      {children}
    </section>
  );
}

const OUT_COLOR: Record<string, string> = { win: UP, stop: DN, open: "#8a8a93" };

export default function HypothesisReport({
  hypothesis,
  levels,
  note,
  symbol,
  timeframe,
  window: win,
  backtest,
  caseId,
  variant = "overlay",
  onClose,
}: {
  hypothesis: Hypothesis;
  levels?: HypLevels | null;
  note?: string | null;
  symbol: string;
  timeframe: string;
  window?: { start: string; end: string } | null;
  backtest?: BacktestResult | null;
  caseId?: string | null;
  variant?: "overlay" | "page";
  onClose: () => void;
}) {
  const isPage = variant === "page";
  const [bt, setBt] = useState<BacktestResult | null>(backtest ?? null);
  const [loading, setLoading] = useState(!backtest);
  const [analysis, setAnalysis] = useState<InstanceAnalysis | null>(null);
  const [full, setFull] = useState(false); // whole-page vs centered modal
  const [selIdx, setSelIdx] = useState<number | null>(null); // the setup being inspected on a chart
  const [savedId, setSavedId] = useState<string | null>(null); // knowledge-base doc once saved
  const [savingKb, setSavingKb] = useState(false);

  const saveToKnowledge = async (): Promise<void> => {
    if (savingKb) return;
    setSavingKb(true);
    try {
      const doc = await api.createKnowledge({
        title: `${hypothesis.title} — ${symbol} ${timeframe}`,
        body: reportToMarkdown(hypothesis, levels, bt, symbol, timeframe, note, win),
        type: "report",
        tags: [symbol, timeframe, hypothesis.leg].filter(Boolean),
        case_id: caseId ?? null,
      });
      setSavedId(doc.id);
    } catch {
      setSavedId(null);
    } finally {
      setSavingKb(false);
    }
  };

  useEffect(() => {
    if (backtest) return;
    let cancelled = false;
    api
      .backtestHypothesis(hypothesis as unknown as Record<string, unknown>, symbol, timeframe)
      .then((r) => !cancelled && setBt(r))
      .catch(() => !cancelled && setBt(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [hypothesis, symbol, timeframe, backtest]);

  useEffect(() => {
    if (!win?.start || !win?.end) return;
    let cancelled = false;
    api.getInstanceAnalysis(symbol, win.start, win.end, timeframe).then((a) => !cancelled && setAnalysis(a)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe, win?.start, win?.end]);

  // SWITCHBOARD: surface-scoped, not window-scoped (page-api).
  useSurfaceKeydown((e) => {
    if (e.key === "Escape" && selIdx == null) onClose(); // when a setup detail is open, Esc closes that first
  });

  const conf = confidence(bt);
  const vd = verdict(bt);
  const t = hypothesis.target;
  const isATR = bt?.metric === "first_touch_atr";
  const setups = bt?.setups ?? [];

  // expected move: ATR multiples → % and points, using the instance's real ATR%
  const atrPct = analysis?.legs.find((l) => l.name === hypothesis.leg)?.config.atr_pct ?? analysis?.legs.find((l) => l.name === "rip")?.config.atr_pct ?? null;
  const px = levels?.swing_low ?? null;
  const move = (mult?: number | null): { p: number; pts: number } | null =>
    mult != null && atrPct != null && px != null ? { p: mult * atrPct, pts: (mult * atrPct / 100) * px } : null;
  const tpMove = move(t.tp_atr);
  const stopMove = move(t.stop_atr);
  const pv = pointValue(symbol); // $/pt for the actual contract (MNQ=$2 etc.)
  const stopDollar = stopMove ? stopMove.pts * pv : null; // 1R in $
  const tpDollar = tpMove ? tpMove.pts * pv : null;
  const expDollar = stopDollar != null && bt?.expectancy_r != null ? bt.expectancy_r * stopDollar : null;

  // evidence by first-touch outcome (falls back to fwd-return sign for close-horizon)
  const wins = useMemo(() => setups.filter((s) => (isATR ? s.outcome === "win" : (s.fwd_ret_pct ?? 0) > 0)), [setups, isATR]);
  const stops = useMemo(() => setups.filter((s) => (isATR ? s.outcome === "stop" : (s.fwd_ret_pct ?? 0) < 0)), [setups, isATR]);

  return (
    <div className={isPage ? "h-full overflow-y-auto bg-bg" : `fixed inset-0 z-50 overflow-y-auto ${full ? "bg-bg" : "bg-black/70"}`}>
      {isPage ? (
        <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-bg/95 px-8 py-2.5 backdrop-blur">
          <button type="button" onClick={onClose} className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-dim hover:text-text">
            ← back to case
          </button>
          <span className="font-mono text-[11px] text-dim2">{hypothesis.title}</span>
          {savedId ? (
            <span className="ml-auto font-mono text-[11px]" style={{ color: UP }}>✓ saved to knowledge</span>
          ) : (
            <button
              type="button"
              onClick={() => void saveToKnowledge()}
              disabled={savingKb || loading}
              title="snapshot this report into your knowledge base (a living, commentable copy)"
              className="ml-auto rounded-md border border-accent/40 px-2.5 py-1 font-mono text-[11px] text-accent hover:bg-accent/10 disabled:opacity-40"
            >
              {savingKb ? "saving…" : "＋ save to knowledge"}
            </button>
          )}
          <span className="font-mono text-[10px] text-dim2">^I to work on this report</span>
        </div>
      ) : null}
      <div className={isPage || full ? "mx-auto w-full max-w-5xl p-8" : "mx-auto my-8 w-full max-w-3xl rounded-lg border border-line bg-bg p-8 shadow-2xl"}>
        {/* masthead */}
        <div className="flex items-start gap-4 border-b border-line pb-5">
          <div className="min-w-0 flex-1">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: UP }}>
              Hypothesis report · Stage A · sim
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-text">{hypothesis.title}</h1>
            <div className="mt-1 font-mono text-[12px] text-dim">
              {symbol} · {timeframe} · {hypothesis.leg}
              {levels ? ` · swing low ${levels.swing_low.toLocaleString()}` : ""}
            </div>
          </div>
          <div className="text-right font-mono">
            <div className="text-[9px] uppercase tracking-wide text-dim">Confidence</div>
            <div className="text-[13px]" style={{ color: conf.color }}>{conf.level}</div>
            <div className="mt-1 h-1.5 w-28 overflow-hidden rounded bg-surface2">
              <div className="h-full" style={{ width: `${conf.fill * 100}%`, background: conf.color }} />
            </div>
          </div>
          {!isPage ? (
            <>
              <button type="button" onClick={() => setFull((f) => !f)} title={full ? "collapse" : "whole page"} className="ml-2 font-mono text-base text-dim hover:text-text">
                {full ? "⤡" : "⤢"}
              </button>
              <button type="button" onClick={onClose} className="font-mono text-lg text-dim hover:text-text">✕</button>
            </>
          ) : null}
        </div>

        {/* 01 idea */}
        <Section n="01" title="The idea">
          <p className="text-[15px] leading-relaxed text-text">{hypothesis.rationale || hypothesis.trigger}</p>
          {note ? <p className="mt-2 border-l-2 border-accent pl-3 text-[13px] text-dim">Your note: {note}</p> : null}
        </Section>

        {/* 02 decomposition */}
        <Section n="02" title="Pattern decomposition & the logic">
          <p className="mb-3 text-[13.5px] leading-relaxed text-text">
            The instance breaks into three legs — <span style={{ color: DN }}>dump</span> (the decline),{" "}
            <span style={{ color: AMBER }}>base</span> (the low that may hold), <span style={{ color: UP }}>rip</span>{" "}
            (the recovery). This hypothesis targets the <b>{hypothesis.leg}</b>: the reasoning is that a completed pattern is
            hindsight, so we decompose it to find the point you could act LIVE — here, the confirmed retest-hold after the low,
            not the low itself. Each leg's leading configuration is read from data up to its decision bar only.
          </p>
          {analysis ? (
            <InstanceAnalysisView
              result={{ symbol, timeframe, requested: win ?? { start: "", end: "" }, legs: analysis.legs, instance_start: analysis.instance_start, n_bars: analysis.n_bars, note: analysis.note, bars: analysis.bars } as unknown as Record<string, unknown>}
            />
          ) : win ? (
            <Loading label="loading the instance decomposition…" tall />
          ) : (
            <div className="rounded border border-dashed border-line p-4 font-mono text-[11px] text-dim">instance window unavailable — re-propose to see the decomposition</div>
          )}
        </Section>

        {/* 03 rules + generalization */}
        <Section n="03" title="The rules — and how they generalize">
          <div className="rounded-lg border border-line bg-surface/40 p-4">
            <p className="text-[13.5px] text-text">{hypothesis.trigger}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {hypothesis.conditions.map((c, i) => (
                <span key={i} className="rounded border border-line bg-surface2 px-2 py-0.5 font-mono text-[10.5px] text-text">{c.label}</span>
              ))}
            </div>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-dim">
            <b className="text-text">Generalization:</b> these are instance-independent conditions — they fire on ANY {symbol} bar
            where the same shape recurs (a decline into a swing low, a bounce, a retest that holds), not just this one screenshot.
            That's what makes it testable: the backtest below runs this exact trigger across history.
          </p>
        </Section>

        {/* 04 levels & execution */}
        <Section n="04" title="Levels & execution — with the expected move">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {levels ? (
              <div className="rounded-lg border border-line bg-surface/40 p-4 font-mono text-[12px]">
                <div className="mb-2 text-[10px] uppercase tracking-wide text-dim">Price levels</div>
                {([
                  ["swing low", levels.swing_low, undefined],
                  ["bounce est.", levels.bounce_est, AC],
                  ["retest zone", `${levels.retest_low.toLocaleString()}–${levels.retest_high.toLocaleString()}`, undefined],
                  ["invalidation", levels.invalidation, DN],
                ] as [string, number | string, string | undefined][]).map(([k, v, col]) => (
                  <div key={k} className="flex justify-between py-0.5">
                    <span className="text-dim">{k}</span>
                    <span style={{ color: col }}>{typeof v === "number" ? v.toLocaleString() : v}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="rounded-lg border border-line bg-surface/40 p-4 font-mono text-[12px]">
              <div className="mb-2 text-[10px] uppercase tracking-wide text-dim">The trade (volatility-aware)</div>
              <div className="flex justify-between py-0.5">
                <span className="text-dim">direction</span>
                <span style={{ color: t.direction === "up" ? UP : DN }}>{t.direction === "up" ? "▲ long" : "▼ short"}</span>
              </div>
              <div className="flex justify-between py-0.5">
                <span className="text-dim">target</span>
                <span style={{ color: UP }}>
                  {t.tp_atr != null ? `+${t.tp_atr} ATR` : pct(t.tp_pct)}
                  {tpMove ? <span className="text-dim"> ≈ {Math.round(tpMove.pts)} pts{tpDollar != null ? ` ≈ +$${tpDollar.toFixed(0)}` : ""}</span> : null}
                </span>
              </div>
              <div className="flex justify-between py-0.5">
                <span className="text-dim">stop</span>
                <span style={{ color: DN }}>
                  {t.stop_atr != null ? `${t.stop_atr} ATR` : t.stop_label ?? "—"}
                  {stopMove ? <span className="text-dim"> ≈ {Math.round(stopMove.pts)} pts{stopDollar != null ? ` ≈ -$${stopDollar.toFixed(0)}` : ""}</span> : null}
                </span>
              </div>
              <div className="flex justify-between py-0.5">
                <span className="text-dim">R : R</span>
                <span>{t.tp_atr != null && t.stop_atr ? `1 : ${(t.tp_atr / t.stop_atr).toFixed(2)}` : "—"}</span>
              </div>
              <div className="flex justify-between py-0.5">
                <span className="text-dim">per-trade</span>
                <span>
                  {stopDollar != null ? <span style={{ color: DN }}>risk ${stopDollar.toFixed(0)}</span> : "—"}
                  {tpDollar != null ? <span style={{ color: UP }}> / reward ${tpDollar.toFixed(0)}</span> : ""}
                  <span className="text-dim"> · 1 contract</span>
                </span>
              </div>
            </div>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-dim">
            Why ATR-sized: a fixed % target is too tight in a volatile session and too wide in a quiet one. The stop sits below the
            swing low (the trigger's invalidation), and the target is a multiple of it — so risk is one unit and the expected move
            scales with the instance's own volatility{atrPct != null ? ` (ATR ≈ ${atrPct.toFixed(2)}%)` : ""}.
          </p>
        </Section>

        {/* 05 supporting evidence */}
        <Section n="05" title="Supporting evidence — the real instances">
          {loading ? (
            <Loading label="running the backtest — finding every historical instance…" />
          ) : !bt || bt.error ? (
            <div className="rounded border border-dashed border-line p-4 font-mono text-[11px] text-dim">{bt?.error ?? "backtest unavailable"}</div>
          ) : bt.n === 0 ? (
            <div className="rounded border border-dashed border-line p-4 font-mono text-[11px] text-dim">{bt.note || "no setups matched — loosen the conditions"}</div>
          ) : (
            <>
              <div className="mb-2 font-mono text-[11px] text-dim">
                {bt.n} historical instances of this exact trigger
                {isATR ? <> · <span style={{ color: UP }}>{wins.length}</span> won / <span style={{ color: DN }}>{stops.length}</span> stopped</> : null}
                {setups.length < bt.n ? ` · showing the ${setups.length} most recent` : ""} · <span style={{ color: AC }}>click a row to see entry → exit on the chart</span>
              </div>
              <div className="max-h-[440px] overflow-auto rounded border border-line">
                <table className="w-full text-left font-mono text-[10.5px]">
                  <thead>
                    <tr className="sticky top-0 border-b border-line bg-surface2 text-dim">
                      {["date", "entry", "outcome", "fwd", "max-up", "max-dn", "RSI", ""].map((h) => (
                        <th key={h} className="whitespace-nowrap px-2.5 py-1 font-normal uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {setups.map((s, i) => (
                      <tr key={i} onClick={() => setSelIdx(i)} className={`cursor-pointer hover:bg-surface2/50 ${i % 2 ? "bg-surface2/20" : ""}`}>
                        <td className="px-2.5 py-1 text-dim">{s.ts.slice(0, 16).replace("T", " ")}</td>
                        <td className="px-2.5 py-1 text-text">{s.close}</td>
                        <td className="px-2.5 py-1 uppercase" style={{ color: s.outcome ? OUT_COLOR[s.outcome] : undefined }}>{s.outcome ?? "—"}</td>
                        <td className="px-2.5 py-1" style={{ color: (s.fwd_ret_pct ?? 0) >= 0 ? UP : DN }}>{pct(s.fwd_ret_pct)}</td>
                        <td className="px-2.5 py-1" style={{ color: UP }}>{pct(s.fwd_up_pct)}</td>
                        <td className="px-2.5 py-1" style={{ color: DN }}>{pct(s.fwd_dn_pct)}</td>
                        <td className="px-2.5 py-1 text-dim">{s.rsi ?? "—"}</td>
                        <td className="px-2.5 py-1 text-dim2">→</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Section>

        {/* 06 simulation & verdict */}
        <Section n="06" title="Simulation & verdict — is it worth pursuing?">
          {loading ? (
            <Loading label="simulating the trade across history…" />
          ) : bt && bt.n > 0 ? (
            <>
              <div className="flex flex-wrap items-end gap-6">
                {(isATR
                  ? ([
                      ["setups", String(bt.n)],
                      ["win-rate", bt.win_rate != null ? `${Math.round(bt.win_rate * 100)}%` : "—"],
                      ["stop-rate", bt.stop_rate != null ? `${Math.round(bt.stop_rate * 100)}%` : "—"],
                      ["R:R", bt.rr != null ? `${bt.rr}` : "—"],
                      ["expectancy", bt.expectancy_r != null ? `${bt.expectancy_r}R` : "—"],
                      ["exp $/trade", expDollar != null ? `${expDollar >= 0 ? "+" : "-"}$${Math.abs(expDollar).toFixed(0)}` : "—"],
                    ] as [string, string][])
                  : ([
                      ["setups", String(bt.n)],
                      ["hit-rate", bt.hit_rate != null ? `${Math.round(bt.hit_rate * 100)}%` : "—"],
                      ["avg fwd", pct(bt.avg_fwd)],
                    ] as [string, string][])
                ).map(([k, v]) => {
                  const col = (k === "expectancy" || k === "exp $/trade") && bt.expectancy_r != null ? (bt.expectancy_r >= 0 ? UP : DN) : undefined;
                  return (
                    <div key={k} className="font-mono">
                      <div className="text-[20px]" style={{ color: col ?? "var(--text,#dcdce0)" }}>{v}</div>
                      <div className="text-[8.5px] uppercase tracking-wide text-dim">{k}</div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 rounded-lg border p-4" style={{ borderColor: `${vd.color}66`, background: `linear-gradient(180deg, ${vd.color}0f, transparent)` }}>
                <div className="font-mono text-[13px] font-semibold" style={{ color: vd.color }}>Verdict: {vd.label}</div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-text">{vd.body}</p>
              </div>
            </>
          ) : (
            <div className="rounded border border-dashed border-line p-4 font-mono text-[11px] text-dim">{bt?.note || "no simulation — no setups to score"}</div>
          )}
        </Section>

        {/* 07 risks */}
        <Section n="07" title="Risks, what's untested, and confidence">
          <div className="rounded-lg border border-line bg-surface/40 p-4" style={{ borderLeft: `3px solid ${AMBER}` }}>
            <ul className="ml-4 list-disc space-y-1.5 text-[13px] text-text">
              {bt?.skipped?.length ? <li><span className="font-mono text-[10px] uppercase" style={{ color: AMBER }}>untested </span>{bt.skipped.length} condition(s) not yet evaluable: {bt.skipped.join(", ")}.</li> : null}
              <li><span className="font-mono text-[10px] uppercase" style={{ color: AMBER }}>metric </span>First-touch counts both-extremes-hit as a stop (order unknown) — conservative; a bar-path model would refine it.</li>
              <li><span className="font-mono text-[10px] uppercase" style={{ color: AMBER }}>overlap </span>n counts setups, not independent events; clustered triggers near one low can inflate it.</li>
              <li><span className="font-mono text-[10px] uppercase" style={{ color: AMBER }}>regime </span>No trend / volatility-regime split yet — a filter for the failure cluster is untested.</li>
            </ul>
          </div>
        </Section>

        <div className="mt-8 border-t border-line pt-4 font-mono text-[9.5px] leading-relaxed text-dim2">
          Generated from the hypothesis + the instance analysis + the bar_features backtest (look-ahead-disciplined). Every claim
          traces to a rule, a bar, or a backtest column — nothing after the fact. Press Esc to close.
        </div>
      </div>

      {selIdx != null && bt && t.tp_atr != null && t.stop_atr != null ? (
        <SetupDetail
          setups={setups}
          index={selIdx}
          setIndex={setSelIdx}
          symbol={bt.symbol}
          timeframe={timeframe}
          tpAtr={t.tp_atr}
          stopAtr={t.stop_atr}
          direction={t.direction}
          pointValue={pv}
          onClose={() => setSelIdx(null)}
        />
      ) : null}
    </div>
  );
}
