/**
 * Edge-engine Stage 2 UI (spec: pattern-edge-engine.md §8; mockup: hypotheses-in-platform).
 * One tab per hypothesis. Shared instance-context strip (note + level estimates) on top,
 * then sub-tabs (A/B/C + "+ new"). The selected hypothesis shows its SUMMARY CARD above —
 * live trigger + editable condition chips + target — and its EVIDENCE below (the aggregate
 * backtest + instances, populated by Stage 3; here a "run backtest" affordance).
 *
 * Editing is local (v1): tune a condition value, rename, change the target, add a blank
 * hypothesis. Edits flag the hypothesis `edited_by_human` so the agent treats it as the
 * owner's working idea. Persistence + re-backtest arrive with Stage 3.
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { BacktestResult, Hypothesis, HypCondition, HypLevels } from "../../api/client";
import { useUiStore } from "../../stores/uiStore";

const LEG_COLOR: Record<string, string> = { dump: "#e0645b", base: "#d1a05a", rip: "#4ea96a", whole: "#5aa6c9" };
const OP_SYM: Record<string, string> = { ">=": "≥", "<=": "≤", "<": "<", ">": ">", "==": "=", between: "in", cross_up: "↑" };

function condLabel(c: HypCondition): string {
  const feat = c.feature.replace(/_/g, " ");
  if (c.op === "between") return `${feat} ${c.value}–${c.value2 ?? ""}${c.unit ?? ""}`;
  return `${feat} ${OP_SYM[c.op] ?? c.op} ${c.value}${c.unit ?? ""}`;
}

let BLANK_SEQ = 0;
function blankHypothesis(symbol: string, timeframe: string): Hypothesis {
  BLANK_SEQ += 1;
  return {
    id: `human-${BLANK_SEQ}`,
    title: "New hypothesis",
    leg: "whole",
    symbol,
    timeframe,
    trigger: "Describe the live trigger — the conditions that fire in the moment, using only past data.",
    conditions: [],
    target: { direction: "up", horizon_bars: 30, tp_pct: null, stop_label: null },
    origin: "human",
    from_note: false,
    edited_by_human: true,
    status: "draft",
  };
}

function Levels({ levels }: { levels: HypLevels }) {
  const cells: [string, number, string?][] = [
    ["swing low", levels.swing_low],
    ["bounce est.", levels.bounce_est, "var(--accent, #6ea8d8)"],
    ["retest low", levels.retest_low],
    ["retest high", levels.retest_high],
    ["invalidation", levels.invalidation, "#e0645b"],
  ];
  return (
    <div className="flex flex-wrap gap-4">
      {cells.map(([k, v, color]) => (
        <div key={k} className="font-mono">
          <div className="text-[9px] uppercase tracking-wide text-dim">{k}</div>
          <div className="text-[13px]" style={{ color: color ?? undefined }}>
            {v.toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function HypothesesView({ result }: { result: Record<string, unknown> }) {
  const symbol = String(result.symbol ?? "ES");
  const timeframe = String(result.timeframe ?? "5m");
  const note = (result.note as string | null) ?? null;
  const levels = (result.levels as HypLevels | null) ?? null;
  const win = (result.window as { start: string; end: string } | null) ?? null;
  const seed = useMemo(() => (result.hypotheses ?? []) as Hypothesis[], [result.hypotheses]);

  const [hyps, setHyps] = useState<Hypothesis[]>(seed);
  const [activeId, setActiveId] = useState<string>(seed[0]?.id ?? "");
  const [editing, setEditing] = useState<number | null>(null); // condition index being edited
  const [instView, setInstView] = useState<"chart" | "table">("chart");
  const [results, setResults] = useState<Record<string, BacktestResult>>({});
  const [running, setRunning] = useState<string | null>(null);
  const openReport = useUiStore((s) => s.openReport);

  // Re-seed when a DIFFERENT proposal is rendered into the same component instance (the
  // id-set changes) — otherwise the local edit state would show the previous menu. Stable
  // ids => this doesn't run, so in-progress edits survive re-renders.
  const seedKey = seed.map((h) => h.id).join(",");
  useEffect(() => {
    setHyps(seed);
    setActiveId(seed[0]?.id ?? "");
    setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const active = hyps.find((h) => h.id === activeId) ?? hyps[0];

  const patch = (id: string, up: (h: Hypothesis) => Hypothesis): void =>
    setHyps((list) => list.map((h) => (h.id === id ? { ...up(h), edited_by_human: true } : h)));

  const addBlank = (): void => {
    const h = blankHypothesis(symbol, timeframe);
    setHyps((list) => [...list, h]);
    setActiveId(h.id);
  };

  const runBacktest = async (h: Hypothesis): Promise<void> => {
    setRunning(h.id);
    try {
      // score the CURRENT (possibly edited) hypothesis against the feature store
      const r = await api.backtestHypothesis(h as unknown as Record<string, unknown>, h.symbol, h.timeframe);
      setResults((m) => ({ ...m, [h.id]: r }));
    } catch (e) {
      setResults((m) => ({ ...m, [h.id]: { error: String(e), n: 0 } as BacktestResult }));
    } finally {
      setRunning(null);
    }
  };

  if (!active) return <div className="text-[11px] text-dim">no hypotheses</div>;
  const legColor = LEG_COLOR[active.leg] ?? LEG_COLOR.whole;

  return (
    <div className="flex flex-col gap-3">
      {/* shared instance context */}
      <div className="rounded-lg border border-line bg-surface/40 p-3">
        {note ? (
          <div className="border-l-2 border-accent pl-3 text-[12px] text-text">
            <div className="mb-1 font-mono text-[9px] uppercase tracking-wide text-dim">
              Instance · your note drove the decomposition
            </div>
            {note}
          </div>
        ) : (
          <div className="font-mono text-[10px] text-dim">Instance · {symbol} · {timeframe}</div>
        )}
        {levels ? <div className="mt-3">{<Levels levels={levels} />}</div> : null}
      </div>

      {/* one tab per hypothesis — plain underline tabs */}
      <div className="flex flex-wrap items-center gap-1 border-b border-line">
        {hyps.map((h) => {
          const on = h.id === active.id;
          const col = LEG_COLOR[h.leg] ?? LEG_COLOR.whole;
          return (
            <button
              key={h.id}
              type="button"
              onClick={() => {
                setActiveId(h.id);
                setEditing(null);
              }}
              className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-1.5 font-mono text-[11px] transition-colors ${
                on ? "text-text" : "border-transparent text-dim hover:text-text"
              }`}
              style={on ? { borderColor: col } : undefined}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: col }} />
              {h.title.split(" — ")[0]}
            </button>
          );
        })}
        <button type="button" onClick={addBlank} className="-mb-px border-b-2 border-transparent px-3 py-1.5 font-mono text-[11px] text-dim2 hover:text-text">
          + new
        </button>
      </div>

      {/* summary card */}
      <div className="rounded-lg border p-4" style={{ borderColor: `${legColor}66`, background: `linear-gradient(180deg, ${legColor}0f, transparent)` }}>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: legColor }} />
          <input
            value={active.title}
            onChange={(e) => patch(active.id, (h) => ({ ...h, title: e.target.value }))}
            className="min-w-0 flex-1 bg-transparent text-[14px] font-semibold text-text focus:outline-none"
          />
          <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase" style={{ color: legColor }}>
            {active.leg}
          </span>
          {active.from_note ? (
            <span className="rounded border border-accent/50 px-1.5 py-0.5 font-mono text-[9px] uppercase text-accent">from your note</span>
          ) : null}
          <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase text-dim">{active.origin}</span>
          {active.edited_by_human ? (
            <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase" style={{ color: "#d1a05a" }}>edited</span>
          ) : null}
          <button
            type="button"
            onClick={() =>
              openReport({
                hypothesis: active,
                levels,
                note,
                symbol,
                timeframe,
                window: win,
                backtest: results[active.id] ?? null,
                caseId: null,
              })
            }
            className="rounded border border-accent/40 px-2 py-0.5 font-mono text-[9px] uppercase text-accent hover:bg-accent/10"
            title="open the full report as a page"
          >
            ⧉ report
          </button>
          {hyps.length > 1 ? (
            <button
              type="button"
              title="remove hypothesis"
              onClick={() => {
                setHyps((list) => list.filter((h) => h.id !== active.id));
                setActiveId(hyps.find((h) => h.id !== active.id)?.id ?? "");
              }}
              className="font-mono text-[12px] text-dim2 hover:text-dn"
            >
              ✕
            </button>
          ) : null}
        </div>

        <div className="mb-1 mt-3 font-mono text-[9px] uppercase tracking-wide text-dim">Trigger · live (never “the low”)</div>
        <textarea
          value={active.trigger}
          onChange={(e) => patch(active.id, (h) => ({ ...h, trigger: e.target.value }))}
          rows={2}
          className="w-full resize-none rounded border border-transparent bg-transparent text-[12.5px] text-text hover:border-line focus:border-line focus:outline-none"
        />

        {/* editable condition chips */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {active.conditions.map((c, i) =>
            editing === i ? (
              <span key={i} className="inline-flex items-center gap-1 rounded border border-accent bg-surface2 px-2 py-0.5 font-mono text-[10.5px]">
                <span className="text-dim">{c.feature.replace(/_/g, " ")}</span>
                <input
                  type="number"
                  defaultValue={c.value}
                  autoFocus
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    patch(active.id, (h) => {
                      const conds = h.conditions.slice();
                      conds[i] = { ...conds[i], value: v, label: condLabel({ ...conds[i], value: v }) };
                      return { ...h, conditions: conds };
                    });
                    setEditing(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  className="w-14 bg-transparent text-text focus:outline-none"
                />
                <span className="text-dim">{c.unit}</span>
              </span>
            ) : (
              <button
                key={i}
                type="button"
                onClick={() => setEditing(i)}
                className="rounded border border-dashed border-line bg-surface2 px-2 py-0.5 font-mono text-[10.5px] text-text hover:border-accent"
              >
                {c.label || condLabel(c)}
              </button>
            ),
          )}
          {active.conditions.length === 0 ? (
            <span className="font-mono text-[10.5px] text-dim2">no conditions yet — add leading rules (Stage 3 evaluates them)</span>
          ) : null}
        </div>

        {/* why this hypothesis */}
        {active.rationale ? (
          <>
            <div className="mb-1 mt-3 font-mono text-[9px] uppercase tracking-wide text-dim">Why this</div>
            <div className="text-[12px] leading-relaxed text-dim">{active.rationale}</div>
          </>
        ) : null}

        {/* target */}
        <div className="mb-1 mt-3 font-mono text-[9px] uppercase tracking-wide text-dim">Target</div>
        <div className="flex flex-wrap items-center gap-3 font-mono text-[11.5px]">
          <button
            type="button"
            onClick={() => patch(active.id, (h) => ({ ...h, target: { ...h.target, direction: h.target.direction === "up" ? "down" : "up" } }))}
            style={{ color: active.target.direction === "up" ? "#4ea96a" : "#e0645b" }}
          >
            {active.target.direction === "up" ? "▲ long" : "▼ short"}
          </button>
          {active.target.tp_atr != null ? (
            <span>
              <span className="text-dim">tp </span>+{active.target.tp_atr} ATR
            </span>
          ) : active.target.tp_pct != null ? (
            <span>
              <span className="text-dim">tp </span>
              {active.target.tp_pct > 0 ? "+" : ""}
              {active.target.tp_pct}%
            </span>
          ) : null}
          {active.target.stop_atr != null ? (
            <span>
              <span className="text-dim">stop </span>
              {active.target.stop_atr} ATR
            </span>
          ) : active.target.stop_label ? (
            <span>
              <span className="text-dim">stop </span>
              {active.target.stop_label}
            </span>
          ) : null}
          <span>
            <span className="text-dim">horizon </span>
            {active.target.horizon_bars} bars
          </span>
        </div>
      </div>

      {/* evidence — the backtest against the feature store */}
      {(() => {
        const res = results[active.id];
        const done = res && !res.error;
        return (
          <div className="rounded-lg border border-line bg-surface/40 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wide text-dim">Backtest · {active.title.split(" — ")[0]}</span>
              {done ? (
                <button type="button" onClick={() => void runBacktest(active)} className="font-mono text-[9px] text-dim hover:text-text" title="re-run with the current conditions">
                  ↻ re-run
                </button>
              ) : null}
              {done ? (
                <div className="ml-auto inline-flex overflow-hidden rounded-md border border-line font-mono text-[9px]">
                  {(["chart", "table"] as const).map((v) => (
                    <button key={v} type="button" onClick={() => setInstView(v)} className={`px-2 py-0.5 ${instView === v ? "bg-surface2 text-text" : "text-dim hover:text-text"}`}>
                      {v}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {res == null ? (
              <div className="flex items-center gap-3 rounded border border-dashed border-line p-4">
                <button
                  type="button"
                  disabled={running === active.id}
                  onClick={() => void runBacktest(active)}
                  className="rounded border border-accent/40 px-2.5 py-1 font-mono text-[10.5px] text-accent hover:bg-accent/10 disabled:opacity-50"
                >
                  {running === active.id ? "running…" : "▷ run backtest"}
                </button>
                <span className="font-mono text-[10.5px] text-dim2">every historical bar where this trigger fired → the forward distribution + setups</span>
              </div>
            ) : res.error ? (
              <div className="rounded border border-dashed border-line p-4 font-mono text-[10.5px] text-dim">{res.error}</div>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-5">
                  {(res.metric === "first_touch_atr"
                    ? ([
                        ["setups", res.n, ""],
                        ["win-rate", res.win_rate != null ? Math.round(res.win_rate * 100) : null, "%"],
                        ["stop-rate", res.stop_rate != null ? Math.round(res.stop_rate * 100) : null, "%"],
                        ["R:R", res.rr, ""],
                        ["expectancy", res.expectancy_r, "R"],
                        ["avg max-up", res.avg_max_up, "%"],
                      ] as [string, number | null, string][])
                    : ([
                        ["setups", res.n, ""],
                        ["hit-rate", res.hit_rate != null ? Math.round(res.hit_rate * 100) : null, "%"],
                        ["avg fwd", res.avg_fwd, "%"],
                        ["median", res.median_fwd, "%"],
                        ["avg max-up", res.avg_max_up, "%"],
                        ["avg max-dn", res.avg_max_dn, "%"],
                      ] as [string, number | null, string][])
                  ).map(([k, v, u]) => {
                    const color = k === "expectancy" && v != null ? (v >= 0 ? "#4ea96a" : "#e0645b") : undefined;
                    return (
                      <div key={k} className="font-mono">
                        <div className="text-[15px]" style={{ color: color ?? "var(--text, #dcdce0)" }}>{v == null ? "—" : `${v}${u}`}</div>
                        <div className="text-[8.5px] uppercase tracking-wide text-dim">{k}</div>
                      </div>
                    );
                  })}
                  <div className="ml-auto font-mono text-[9px] text-dim">
                    {res.metric === "first_touch_atr" ? "first-touch · " : ""}
                    {res.direction} · {res.horizon_bars} bars · {res.timeframe}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[9px]">
                  {res.applied.map((a, i) => (
                    <span key={`a${i}`} className="rounded px-1.5 py-0.5" style={{ border: "1px solid #4ea96a55", color: "#4ea96a" }}>
                      {a}
                    </span>
                  ))}
                  {res.skipped.map((s, i) => (
                    <span key={`s${i}`} className="rounded border border-line px-1.5 py-0.5 text-dim2" title="needs the multi-bar sequence detector (next increment)">
                      skipped: {s}
                    </span>
                  ))}
                </div>
                <div className="mt-3">
                  {res.n === 0 ? (
                    <div className="font-mono text-[10.5px] text-dim">{res.note || "no bars matched — loosen the conditions"}</div>
                  ) : instView === "table" ? (
                    <div className="overflow-x-auto rounded border border-line">
                      <table className="w-full text-left font-mono text-[10px]">
                        <thead>
                          <tr className="border-b border-line bg-surface2/60 text-dim">
                            {["date", "close", "fwd%", "rsi", "sess-low", "vwapΔ", "run"].map((h) => (
                              <th key={h} className="px-2 py-1 font-normal uppercase">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {res.setups.map((s, i) => (
                            <tr key={i} className={i % 2 ? "bg-surface2/20" : ""}>
                              <td className="px-2 py-1 text-dim">{s.ts.slice(0, 16).replace("T", " ")}</td>
                              <td className="px-2 py-1">{s.close}</td>
                              <td className="px-2 py-1" style={{ color: s.fwd_ret_pct == null ? undefined : s.fwd_ret_pct >= 0 ? "#4ea96a" : "#e0645b" }}>
                                {s.fwd_ret_pct == null ? "—" : `${s.fwd_ret_pct >= 0 ? "+" : ""}${s.fwd_ret_pct.toFixed(2)}%`}
                              </td>
                              <td className="px-2 py-1">{s.rsi ?? "—"}</td>
                              <td className="px-2 py-1">{s.session_low_dist ?? "—"}</td>
                              <td className="px-2 py-1">{s.vwap_dist ?? "—"}</td>
                              <td className="px-2 py-1">{s.run}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="grid grid-cols-6 gap-1.5 md:grid-cols-8">
                      {res.setups.slice(0, 48).map((s, i) => {
                        const up = (s.fwd_ret_pct ?? 0) >= 0;
                        return (
                          <div key={i} title={`${s.ts.slice(0, 16)} · ${s.fwd_ret_pct}%`} className="rounded border p-1 text-center font-mono text-[8px]" style={{ borderColor: up ? "#4ea96a55" : "#e0645b55" }}>
                            <div style={{ color: up ? "#4ea96a" : "#e0645b" }}>{s.fwd_ret_pct == null ? "—" : `${up ? "+" : ""}${s.fwd_ret_pct.toFixed(1)}`}</div>
                            <div className="text-dim2">{s.ts.slice(5, 10)}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {res.setups.length < res.n ? (
                    <div className="mt-1 font-mono text-[9px] text-dim2">showing {res.setups.length} of {res.n}</div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        );
      })()}

    </div>
  );
}
