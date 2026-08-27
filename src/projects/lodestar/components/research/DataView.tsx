/**
 * Human-readable rendering for pinned payloads (owner rule: raw JSON is never
 * acceptable UI). Structured records get a deliberate reading order (owner ask
 * 2026-07-03): summary prose up top, a metrics strip, prose/bullet sections,
 * and record-arrays as REAL tables at the bottom. Arrays of objects → table;
 * anything else falls back to a readable default. Kind-agnostic on purpose.
 */

import { useState, type ReactNode } from "react";
import PatternMatchDetail, { describeSignature, type PatternMatch } from "./PatternMatchDetail";
import InstanceAnalysisView from "./InstanceAnalysisView";
import HypothesesView from "./HypothesesView";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const UP = "#6fb38a";
const DN = "#e0645b";

/** A tiny normalized-shape line — so a pattern match is VISUAL, not a row of numbers. */
function Sparkline({ shape, stroke = "#7c8ce8", w = 128, h = 38 }: { shape?: number[]; stroke?: string; w?: number; h?: number }) {
  const pts = (shape ?? []).filter((n) => Number.isFinite(n));
  if (pts.length < 2) return <div style={{ height: h }} className="text-[9px] text-dim/60">no shape</div>;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const x = (i: number): number => (i / (pts.length - 1)) * w;
  const y = (v: number): number => (hi === lo ? h / 2 : (1 - (v - lo) / (hi - lo)) * (h - 6) + 3);
  const d = pts.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="block w-full">
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.3" />
    </svg>
  );
}

/** A find_similar_patterns / pattern_outcomes result: the RULES it matched on
 * (signature + query shape), what happened next, and the matches as thumbnails so
 * you can eyeball "does this actually match?". */
export function PatternResultView({ result }: { result: Record<string, unknown> }) {
  const sig = result.signature as Record<string, number> | undefined;
  const agg = (result.what_happened_next ?? result.outcomes) as Record<string, unknown> | undefined;
  const matches = (result.matches ?? result.sample ?? []) as Record<string, unknown>[];
  const queryShape = result.query_shape as number[] | undefined;
  const window = result.data_window as string | undefined;
  const [view, setView] = useState<"cards" | "table">("cards");
  const [detail, setDetail] = useState<PatternMatch | null>(null);
  const chip = (lbl: string, v: unknown): ReactNode =>
    v == null ? null : (
      <span key={lbl} className="rounded-md border border-line bg-surface2/50 px-2 py-1 font-mono text-[10px]">
        <span className="text-dim">{lbl} </span>
        <span className="text-text">{typeof v === "number" && !Number.isInteger(v) ? v.toFixed(3) : String(v)}</span>
      </span>
    );
  return (
    <div className="space-y-3">
      {/* the rules it's using — surfaced, not hidden */}
      {sig || queryShape ? (
        <div className="flex items-center gap-4 rounded-lg border border-line bg-surface2/40 p-3">
          {queryShape ? (
            <div className="shrink-0">
              <div className="mb-0.5 font-mono text-[9px] uppercase tracking-wide text-dim">the pattern</div>
              <Sparkline shape={queryShape} stroke="#eaeaed" w={120} h={44} />
            </div>
          ) : null}
          {sig ? (
            <div className="min-w-0">
              <div className="mb-1 font-mono text-[9px] uppercase tracking-wide text-dim">matched on (signature)</div>
              <div className="flex flex-wrap gap-1.5">
                {(["net_move", "volatility", "path_range"] as const).map((k) =>
                  sig[k] == null ? null : (
                    <span key={k} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px]">
                      <span className="text-dim">{k.replace(/_/g, " ")} </span>
                      <span className="text-text">{Number(sig[k]).toFixed(3)}</span>
                    </span>
                  ),
                )}
              </div>
              {describeSignature(sig) ? (
                <div className="mt-1 font-mono text-[9.5px] text-dim/80">criteria — {describeSignature(sig)}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {/* what happened next */}
      {agg ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-[10px] uppercase tracking-wide text-dim">what happened next</span>
          {chip("n", agg.n)}
          {chip("up rate", agg.continued_up_rate ?? agg.up_rate)}
          {chip("avg fwd %", agg.avg_fwd_ret_pct)}
          {chip("median fwd %", agg.median_fwd_ret_pct)}
        </div>
      ) : null}
      {/* the matches — thumbnails or a table; click any to drill into its candlesticks */}
      {matches.length ? (
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wide text-dim">matches · {matches.length}</span>
            <div className="ml-auto inline-flex overflow-hidden rounded-md border border-line font-mono text-[9px]">
              {(["cards", "table"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`px-2 py-0.5 transition-colors ${view === v ? "bg-surface2 text-text" : "text-dim hover:text-text"}`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          {view === "cards" ? (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {matches.slice(0, 24).map((m, i) => {
                const fwd = m.fwd_ret_pct as number | null;
                const up = (fwd ?? 0) >= 0;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setDetail(m as PatternMatch)}
                    className="rounded-md border border-line bg-surface/40 p-2 text-left transition-colors hover:border-accent"
                  >
                    <Sparkline shape={m.shape as number[] | undefined} stroke={up ? UP : DN} />
                    <div className="mt-1 flex items-baseline justify-between font-mono text-[9px]">
                      <span className="text-dim">
                        {String(m.symbol ?? "").replace("@", "")} · {String(m.timeframe ?? "")}
                      </span>
                      {fwd != null ? (
                        <span style={{ color: up ? UP : DN }}>
                          {up ? "+" : ""}
                          {Number(fwd).toFixed(2)}%
                        </span>
                      ) : null}
                    </div>
                    <div className="font-mono text-[8.5px] text-dim/70">{String(m.start_ts ?? "").slice(0, 10)}</div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full text-left font-mono text-[10px]">
                <thead>
                  <tr className="border-b border-line bg-surface2/60 text-dim">
                    {["sym", "tf", "start", "net move", "vol", "range", "fwd %"].map((c) => (
                      <th key={c} className="whitespace-nowrap px-2 py-1 font-normal uppercase tracking-wide">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matches.slice(0, 60).map((m, i) => {
                    const fwd = m.fwd_ret_pct as number | null;
                    return (
                      <tr
                        key={i}
                        onClick={() => setDetail(m as PatternMatch)}
                        className={`cursor-pointer text-text hover:bg-surface2/40 ${i % 2 ? "bg-surface2/20" : ""}`}
                      >
                        <td className="px-2 py-1">{String(m.symbol ?? "").replace("@", "")}</td>
                        <td className="px-2 py-1 text-dim">{String(m.timeframe ?? "")}</td>
                        <td className="px-2 py-1 text-dim">{String(m.start_ts ?? "").slice(0, 16).replace("T", " ")}</td>
                        <td className="px-2 py-1">{fmtCell(m.net_move)}</td>
                        <td className="px-2 py-1">{fmtCell(m.volatility)}</td>
                        <td className="px-2 py-1">{fmtCell(m.path_range)}</td>
                        <td className="px-2 py-1" style={{ color: fwd == null ? undefined : (fwd >= 0 ? UP : DN) }}>
                          {fwd == null ? "—" : `${fwd >= 0 ? "+" : ""}${fwd.toFixed(2)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
      {detail ? <PatternMatchDetail match={detail} signature={sig} onClose={() => setDetail(null)} /> : null}
      {window ? (
        <div className="font-mono text-[9px] text-dim/60">index {window} · shape-descriptor match, ES/NQ</div>
      ) : null}
    </div>
  );
}

/** Detect a pattern-search result payload (find_similar_patterns / pattern_outcomes). */
export function isPatternResult(p: unknown): p is Record<string, unknown> {
  return (
    isRecord(p) &&
    (Array.isArray(p.matches) || Array.isArray(p.sample)) &&
    (isRecord(p.what_happened_next) || isRecord(p.outcomes) || isRecord(p.signature))
  );
}

export function isInstanceAnalysis(p: unknown): p is Record<string, unknown> {
  return (
    isRecord(p) &&
    Array.isArray(p.legs) &&
    typeof p.instance_start === "number" &&
    isRecord(p.requested) &&
    p.legs.every((l) => isRecord(l) && "config" in l && "decision" in l)
  );
}

export function isHypotheses(p: unknown): p is Record<string, unknown> {
  return (
    isRecord(p) &&
    Array.isArray(p.hypotheses) &&
    p.hypotheses.length > 0 &&
    p.hypotheses.every((h) => isRecord(h) && "trigger" in h && Array.isArray(h.conditions) && "target" in h)
  );
}

function fmtCell(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return `${v.length} items`;
  if (isRecord(v)) {
    const ks = Object.keys(v);
    return ks.length <= 3 ? ks.map((k) => `${k}: ${fmtCell(v[k])}`).join(" · ") : `${ks.length} fields`;
  }
  return String(v);
}

function label(k: string): string {
  return k.replace(/_/g, " ");
}

function Table({ rows }: { rows: Record<string, unknown>[] }) {
  // union of keys across rows, first-seen order, capped for readability
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const shown = cols.slice(0, 8);
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full text-left font-mono text-[11px]">
        <thead>
          <tr className="border-b border-line bg-surface2/60 text-dim">
            {shown.map((c) => (
              <th key={c} className="whitespace-nowrap px-2.5 py-1.5 text-[10px] font-normal uppercase tracking-wide">
                {label(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 30).map((r, i) => (
            <tr key={i} className={`text-text ${i % 2 === 1 ? "bg-surface2/25" : ""}`}>
              {shown.map((c) => (
                <td key={c} className="max-w-[420px] px-2.5 py-1.5 align-top" title={fmtCell(r[c])}>
                  <span className="break-words">{fmtCell(r[c])}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 30 ? (
        <div className="border-t border-line px-2.5 py-1 font-mono text-[10px] text-dim">
          … {rows.length - 30} more rows
        </div>
      ) : null}
      {cols.length > 8 ? (
        <div className="px-2.5 py-1 font-mono text-[10px] text-dim">({cols.length - 8} more columns hidden)</div>
      ) : null}
    </div>
  );
}

/** Deliberate reading order for a structured record:
 * 1. summary prose (headline/summary field), 2. metrics chips (numbers + short
 * strings), 3. prose + bullet sections, 4. record-arrays as titled tables. */
function StructuredRecord({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  const summaryKey = entries.find(([k, v]) => ["headline", "summary"].includes(k) && typeof v === "string")?.[0];
  const metrics = entries.filter(
    ([k, v]) =>
      k !== summaryKey &&
      (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 28)),
  );
  const prose = entries.filter(([k, v]) => k !== summaryKey && typeof v === "string" && v.length > 28);
  const bullets = entries.filter(
    ([, v]) => Array.isArray(v) && v.length > 0 && (v as unknown[]).every((x) => !isRecord(x)),
  );
  const tables = entries.filter(([, v]) => Array.isArray(v) && v.length > 0 && (v as unknown[]).every(isRecord));
  const nested = entries.filter(([, v]) => isRecord(v));

  return (
    <div className="space-y-3">
      {summaryKey ? (
        <p className="text-sm leading-relaxed text-text">{String(obj[summaryKey])}</p>
      ) : null}
      {metrics.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {metrics.map(([k, v]) => (
            <span key={k} className="rounded-md border border-line bg-surface2/50 px-2 py-1">
              <span className="mr-1.5 font-mono text-[9px] uppercase text-dim">{label(k)}</span>
              <span className="font-mono text-[11px] text-text">{fmtCell(v)}</span>
            </span>
          ))}
        </div>
      ) : null}
      {prose.map(([k, v]) => (
        <div key={k}>
          <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-dim">{label(k)}</div>
          <p className="text-xs leading-relaxed text-text">{String(v)}</p>
        </div>
      ))}
      {bullets.map(([k, v]) => (
        <div key={k}>
          <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-dim">{label(k)}</div>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-text">
            {(v as unknown[]).slice(0, 12).map((item, i) => (
              <li key={i} className="break-words">{fmtCell(item)}</li>
            ))}
            {(v as unknown[]).length > 12 ? (
              <li className="text-dim">… {(v as unknown[]).length - 12} more</li>
            ) : null}
          </ul>
        </div>
      ))}
      {nested.map(([k, v]) => (
        <div key={k}>
          <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-dim">{label(k)}</div>
          <div className="rounded-md border border-line p-2 text-[11px]">
            <StructuredRecord obj={v as Record<string, unknown>} />
          </div>
        </div>
      ))}
      {tables.map(([k, v]) => (
        <div key={k}>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-dim">{label(k)}</div>
          <Table rows={v as Record<string, unknown>[]} />
        </div>
      ))}
    </div>
  );
}

export default function DataView({ payload }: { payload: unknown }) {
  if (payload == null) return <div className="text-[11px] text-dim">no data</div>;
  if (isHypotheses(payload)) {
    const lv = payload.levels as { swing_low?: number } | undefined;
    return <HypothesesView key={`hyp-${String(payload.symbol)}-${String(payload.timeframe)}-${lv?.swing_low ?? ""}`} result={payload} />;
  }
  if (isInstanceAnalysis(payload)) return <InstanceAnalysisView result={payload} />;
  if (isPatternResult(payload)) return <PatternResultView result={payload} />;
  if (Array.isArray(payload)) {
    if (payload.length > 0 && payload.every(isRecord)) {
      return <Table rows={payload as Record<string, unknown>[]} />;
    }
    return (
      <ul className="list-disc space-y-1 pl-4 font-mono text-[11px] text-text">
        {payload.slice(0, 30).map((v, i) => (
          <li key={i}>{fmtCell(v)}</li>
        ))}
      </ul>
    );
  }
  if (isRecord(payload)) return <StructuredRecord obj={payload} />;
  return <div className="font-mono text-[11px] text-text">{fmtCell(payload)}</div>;
}
