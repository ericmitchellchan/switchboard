/**
 * Screenshot → pattern intake (research-streams T13, requirements Decided #1):
 * vision-ASSISTED with owner confirm. The pasted/dropped image is saved to
 * disk, the agent Reads it and proposes a structured descriptor (or asks a
 * clarifying question when the image isn't a readable chart), the owner
 * confirms/corrects — and only THEN is a case created, the similar-case search
 * run, and the case-set pinned. A case is never minted from an unconfirmed read.
 */

import { useEffect, useState } from "react";
import ResearchStatusChip from "./ResearchStatusChip";
import { api } from "../../api/client";
import { useSurfaceAgent } from "../../../../surfaces/page-api";

interface Proposal {
  readable: boolean;
  description?: string;
  symbol?: "ES" | "NQ" | null;
  timeframe?: "1m" | "5m" | "15m" | "1h" | null;
  shape?: number[];
  question?: string | null;
}

const VISION_PROMPT = (path: string): string =>
  [
    `Read the chart screenshot at ${path} with the Read tool and study it.`,
    "Reply with ONLY a fenced ```json block shaped exactly like:",
    '{"readable": true, "description": "one sentence describing the pattern",',
    '"symbol": "ES"|"NQ"|null, "timeframe": "1m"|"5m"|"15m"|"1h"|null,',
    '"shape": [24-64 numbers tracing the price path left to right]}',
    'If the image is NOT a readable price chart, reply {"readable": false,',
    '"question": "what you need clarified"} instead of guessing.',
    "Do NOT open cases, pin, or journal anything in this turn — reply with the JSON only;",
    "the owner confirms before anything is created.",
  ].join(" ");

/** Recency → the search date range (owner: presets AND a custom range). */
function rangeFor(
  r: "all" | "1y" | "3m" | "custom",
  cs: string,
  cu: string,
): { since?: string; until?: string } {
  if (r === "custom") return { since: cs || undefined, until: cu || undefined };
  if (r === "all") return {};
  const d = new Date();
  d.setMonth(d.getMonth() - (r === "1y" ? 12 : 3));
  return { since: d.toISOString().slice(0, 10) };
}

/** Exported for when the thread hands structured replies back (see the effect below). */
export function parseProposal(text: string): Proposal | null {
  const m = /```json\s*([\s\S]*?)```/.exec(text) ?? /(\{[\s\S]*\})/.exec(text);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    if (typeof obj.readable !== "boolean") return null;
    return obj as Proposal;
  } catch {
    return null;
  }
}

export default function PatternIntake({
  imagePath,
  imageDataUrl,
  onDone,
  onCancel,
}: {
  imagePath: string;
  imageDataUrl: string;
  onDone: (caseId: string) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<"reading" | "confirm" | "unreadable" | "saving">("reading");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [live, setLive] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState("");                 // optional focus note (owner ask)
  const [recency, setRecency] = useState<"all" | "1y" | "3m" | "custom">("all");  // search window
  const [customSince, setCustomSince] = useState("");
  const [customUntil, setCustomUntil] = useState("");

  // SWITCHBOARD: there is no in-page agent stream to parse a proposal from.
  // The vision read goes to the thread beside this page (page-api); the
  // pattern is then entered here from its reply. Honest, until the thread can
  // hand structured results back.
  const agent = useSurfaceAgent();
  useEffect(() => {
    setLive("");
    if (agent.send(VISION_PROMPT(imagePath)).sent) {
      setErr("sent the read to the thread beside this page — press Enter there, then enter the proposed shape here");
    } else {
      setErr("no thread beside this page to read the image — open a terminal running claude in this tab");
    }
    setPhase("unreadable");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagePath]);

  const confirm = async (): Promise<void> => {
    if (
      !proposal?.shape ||
      proposal.shape.length < 8 ||
      !proposal.shape.every((v) => Number.isFinite(v))
    ) {
      setErr("no usable numeric shape in the read — correct it or retry");
      return;
    }
    setPhase("saving");
    try {
      const c = await api.createCase({
        title: proposal.description?.slice(0, 80) || "Chart pattern case",
        stream: "trading",
        subject: {
          kind: "pattern",
          descriptor: {
            description: proposal.description,
            symbol: proposal.symbol ?? null,
            timeframe: proposal.timeframe ?? null,
            shape: proposal.shape,
            confirmed_at: new Date().toISOString(),
          },
          image_path: imagePath,
          label: proposal.description?.slice(0, 40) ?? "chart pattern",
        },
        hypothesis: note.trim() || null,
        labels: ["pattern-intake"],
      });
      const { since, until } = rangeFor(recency, customSince, customUntil);
      const result = await api.patternSearch({
        shape: proposal.shape,
        symbol: proposal.symbol ?? undefined,
        timeframe: proposal.timeframe ?? undefined,
        limit: 20,
        since,
        until,
      });
      await api.pinToCase(c.case_id, {
        kind: "case_set",
        title: `Similar historical windows (${result.matches.length})`,
        payload: result as unknown as Record<string, unknown>,
        provenance: {
          tool: "find_similar_patterns",
          params: { symbol: proposal.symbol, timeframe: proposal.timeframe, shape_points: proposal.shape.length },
          data_window: result.data_window ?? "pattern-windows index (window unknown)",
          sample_size: result.matches.length,
          computed_at: new Date().toISOString(),
        },
      });
      // Stage 2: analyze the top instance + propose hypotheses using the note, so the
      // owner sees HYPOTHESES immediately (not just the shape-match). Best-effort — a
      // failure here still leaves the case + the search evidence intact.
      const top = result.matches[0] as
        | { symbol?: string; timeframe?: string; start_ts?: string; end_ts?: string }
        | undefined;
      if (top?.start_ts && top?.end_ts) {
        try {
          const hyp = await api.proposeHypotheses(
            (top.symbol ?? proposal.symbol ?? "ES").replace("@", ""),
            top.start_ts,
            top.end_ts,
            top.timeframe ?? proposal.timeframe ?? "5m",
            note.trim() || undefined,
          );
          await api.pinToCase(c.case_id, {
            kind: "case_set",
            title: `Hypotheses (${hyp.hypotheses.length})`,
            payload: hyp as unknown as Record<string, unknown>,
            provenance: {
              tool: "propose_hypotheses",
              params: { symbol: hyp.symbol, timeframe: hyp.timeframe, note: note.trim() || null },
              data_window: `instance ${top.start_ts} → ${top.end_ts}`,
              sample_size: hyp.hypotheses.length,
              computed_at: new Date().toISOString(),
            },
          });
        } catch {
          /* hypotheses are best-effort; the search + case still stand */
        }
      }
      onDone(c.case_id);
    } catch (e) {
      setErr(`search/pin failed: ${String(e)}`);
      setPhase("confirm");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onCancel}>
      <div
        className="flex max-h-full w-full max-w-2xl flex-col gap-2 rounded-lg border border-line bg-bg p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-base text-text">Pattern intake</span>
          <span className="font-mono text-[10px] text-dim">
            vision-assisted · nothing is saved until you confirm
          </span>
          <button type="button" onClick={onCancel} className="ml-auto text-dim hover:text-text">✕</button>
        </div>
        <img src={imageDataUrl} alt="pattern screenshot" className="max-h-56 rounded border border-line object-contain" />

        {phase === "reading" && (
          <div className="text-xs text-dim">
            agent is reading the chart…
            {live ? <div className="mt-1 max-h-24 overflow-y-auto font-mono text-[10px]">{live}</div> : null}
          </div>
        )}

        {phase === "unreadable" && (
          <div className="rounded border border-line p-2 text-xs text-dim">
            {proposal?.question ?? "The agent couldn't read this as a price chart."}
            <div className="mt-1 font-mono text-[10px]">try a clearer screenshot, or cancel.</div>
          </div>
        )}

        {(phase === "confirm" || phase === "saving") && proposal ? (
          <div className="space-y-2 rounded border border-line p-2.5">
            <div className="text-sm text-text">{proposal.description}</div>
            <div className="flex gap-3 text-[11px] text-dim">
              <label className="flex items-center gap-1">
                symbol
                <select
                  value={proposal.symbol ?? ""}
                  onChange={(e) => setProposal({ ...proposal, symbol: (e.target.value || null) as Proposal["symbol"] })}
                  className="rounded border border-line bg-bg px-1 py-0.5 font-mono text-xs text-text"
                >
                  <option value="">any</option>
                  <option value="ES">ES</option>
                  <option value="NQ">NQ</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                timeframe
                <select
                  value={proposal.timeframe ?? ""}
                  onChange={(e) => setProposal({ ...proposal, timeframe: (e.target.value || null) as Proposal["timeframe"] })}
                  className="rounded border border-line bg-bg px-1 py-0.5 font-mono text-xs text-text"
                >
                  <option value="">any</option>
                  <option value="1m">1m</option>
                  <option value="5m">5m</option>
                  <option value="15m">15m</option>
                  <option value="1h">1h</option>
                </select>
              </label>
              <span className="ml-auto font-mono text-[10px]">
                shape: {proposal.shape?.length ?? 0} pts · <ResearchStatusChip dataset="pattern-windows" />
              </span>
            </div>
            {/* shape preview */}
            {proposal.shape && proposal.shape.length >= 8 ? (
              <svg width="100%" height="40" viewBox="0 0 200 40" preserveAspectRatio="none">
                <path
                  d={proposal.shape
                    .map((v, i, a) => {
                      const min = Math.min(...a);
                      const max = Math.max(...a);
                      const x = (i / (a.length - 1)) * 198 + 1;
                      const y = max === min ? 20 : 38 - ((v - min) / (max - min)) * 36;
                      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
                    })
                    .join(" ")}
                  fill="none"
                  stroke="#7c8ce8"
                  strokeWidth="1.5"
                />
              </svg>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-dim">
              <label className="flex items-center gap-1">
                search
                <select
                  value={recency}
                  onChange={(e) => setRecency(e.target.value as typeof recency)}
                  className="rounded border border-line bg-bg px-1 py-0.5 font-mono text-xs text-text"
                >
                  <option value="all">all history</option>
                  <option value="1y">last year</option>
                  <option value="3m">last 3 months</option>
                  <option value="custom">custom range…</option>
                </select>
              </label>
              {recency === "custom" ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={customSince}
                    onChange={(e) => setCustomSince(e.target.value)}
                    title="from"
                    className="rounded border border-line bg-bg px-1 py-0.5 font-mono text-[11px] text-text focus:border-accent focus:outline-none"
                  />
                  <span className="text-dim">→</span>
                  <input
                    type="date"
                    value={customUntil}
                    onChange={(e) => setCustomUntil(e.target.value)}
                    title="to (optional)"
                    className="rounded border border-line bg-bg px-1 py-0.5 font-mono text-[11px] text-text focus:border-accent focus:outline-none"
                  />
                </div>
              ) : (
                <span className="font-mono text-[9px] text-dim/70">
                  ES/NQ · matched by shape across the indexed frames (1m/5m/15m/1h)
                </span>
              )}
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="optional note to focus the case — e.g. “the V-bottom near the open, ignore the pre-market”"
              className="w-full resize-none rounded border border-line bg-bg px-2 py-1 text-xs text-text placeholder:text-dim focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={phase === "saving"}
              className="w-full rounded-md bg-accent px-2 py-1.5 text-sm font-medium text-bg disabled:opacity-40"
            >
              {phase === "saving" ? "creating case + searching…" : "confirm — create case & find similar"}
            </button>
          </div>
        ) : null}

        {err ? <div className="font-mono text-[10px] text-dn">{err}</div> : null}
      </div>
    </div>
  );
}
