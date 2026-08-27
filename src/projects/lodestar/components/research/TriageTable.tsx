/**
 * Anomaly triage (H1 industrialized, owner ask 2026-07-02): the annotate-fast
 * surface. One row per board candidate; judge each plausible / interesting /
 * noise — every judgment lands as a note on the "Anomaly calibration" case
 * (agent-readable), stamped with the match context, so the calibration corpus
 * accumulates where the detector's future tuning can read it.
 *
 * Language discipline: judgments describe the FLOW's look, never a person.
 */

import { useEffect, useRef, useState } from "react";
import ResearchStatusChip from "./ResearchStatusChip";
import { api, type AnomalyMatch, type Case } from "../../api/client";

const JUDGMENTS = [
  { id: "plausible", label: "plausible", color: "#e0645b" },
  { id: "interesting", label: "interesting", color: "#c9a75a" },
  { id: "noise", label: "noise", color: "#57575f" },
] as const;

const CALIBRATION_TITLE = "Anomaly calibration";

async function ensureCalibrationCase(): Promise<Case> {
  const existing = (await api.listCases({ stream: "tennis" }).catch(() => []))
    .find((c) => c.title === CALIBRATION_TITLE);
  if (existing) return existing;
  return api.createCase({
    title: CALIBRATION_TITLE,
    stream: "tennis",
    subject: { kind: "situation", label: "flow-anomaly calibration", params: {} },
    hypothesis: "owner judgments teach the detector what 'suspicious flow' means",
    labels: ["calibration"],
  });
}

export default function TriageTable({ onClose }: { onClose: () => void }) {
  const [board, setBoard] = useState<AnomalyMatch[] | null>(null);
  const [judged, setJudged] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  // One-shot data load (deps []): the parent re-renders every poll tick with a
  // fresh onClose identity — refetching then would race a just-clicked judgment
  // with a pre-write hydration snapshot and visually revert it (review finding).
  useEffect(() => {
    let cancelled = false;
    api.topAnomalies(50).then((b) => !cancelled && setBoard(b)).catch(() => !cancelled && setBoard([]));
    void api.listCases({ stream: "tennis" }).then((cs) => {
      const cal = cs.find((c) => c.title === CALIBRATION_TITLE);
      if (!cal || cancelled) return;
      const seen: Record<string, string> = {};
      for (const n of cal.notes) {
        const m = /^\[triage (\S+)[^\]]*\] (\w+)/.exec(n.text);
        if (m) seen[m[1]] = m[2]; // latest note wins (notes are chronological)
      }
      // merge UNDER local judgments — never clobber optimistic clicks
      setJudged((j) => ({ ...seen, ...j }));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SWITCHBOARD: Escape closes this overlay only while focus is INSIDE it —
  // a window-level listener would fire from the terminal beside the page.
  const overlayRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const root = overlayRef.current;
      if (e.key === "Escape" && root && e.target instanceof Node && root.contains(e.target)) onClose();
    };
    const root = overlayRef.current;
    root?.addEventListener("keydown", onKey);
    root?.focus();
    return () => root?.removeEventListener("keydown", onKey);
  }, [onClose]);

  const judge = async (row: AnomalyMatch, judgment: string): Promise<void> => {
    if (saving) return;
    setSaving(row.match_id);
    try {
      const cal = await ensureCalibrationCase();
      await api.addCaseNote(
        cal.case_id,
        `[triage ${row.match_id} · ${row.player1_name} v ${row.player2_name} · ×${row.score_ratio.toFixed(2)} · n=${row.n_sized_trades}] ${judgment}`,
      );
      setJudged((j) => ({ ...j, [row.match_id]: judgment }));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div ref={overlayRef} tabIndex={-1} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 outline-none" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-4xl flex-col rounded-lg border border-line bg-bg p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-base text-text">Anomaly triage</span>
          <span className="font-mono text-[10px] text-dim">
            judgments file to “{CALIBRATION_TITLE}” · unusual ≠ wrongdoing — you're rating the flow's look
          </span>
          <ResearchStatusChip dataset="tennis-anomalies" />
          <button type="button" onClick={onClose} className="ml-auto text-dim hover:text-text">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {board == null ? (
            <div className="p-3 text-sm text-dim">loading the board…</div>
          ) : board.length === 0 ? (
            <div className="p-3 text-sm text-dim">board empty — build tennis-anomalies first</div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="font-mono text-[10px] uppercase text-dim">
                <tr>
                  <th className="px-2 py-1 font-normal">#</th>
                  <th className="px-2 py-1 font-normal">match</th>
                  <th className="px-2 py-1 font-normal">level</th>
                  <th className="px-2 py-1 text-right font-normal">×ratio</th>
                  <th className="px-2 py-1 text-right font-normal">n sized</th>
                  <th className="px-2 py-1 text-right font-normal">flag %</th>
                  <th className="px-2 py-1 font-normal">judgment</th>
                </tr>
              </thead>
              <tbody>
                {board.map((r, i) => (
                  <tr key={r.match_id} className="border-t border-line/50">
                    <td className="px-2 py-1.5 font-mono text-dim">{i + 1}</td>
                    <td className="px-2 py-1.5 text-text">
                      {r.player1_name} v {r.player2_name}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[10px] text-dim">{r.level}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-accent">×{r.score_ratio.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-dim">{r.n_sized_trades}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-dim">
                      {Math.round(r.flag_rate * 100)}%
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex gap-1">
                        {JUDGMENTS.map((j) => {
                          const active = judged[r.match_id] === j.id;
                          return (
                            <button
                              key={j.id}
                              type="button"
                              disabled={saving === r.match_id}
                              onClick={() => void judge(r, j.id)}
                              className={`rounded-full px-2 py-0.5 font-mono text-[10px] transition-colors ${
                                active ? "" : "opacity-40 hover:opacity-80"
                              }`}
                              style={{ color: j.color, background: `${j.color}${active ? "2e" : "14"}` }}
                            >
                              {j.label}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
