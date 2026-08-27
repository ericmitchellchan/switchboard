/**
 * Synthesize view (redesign · Stage 4): the case's report — where the findings
 * LAND. The thesis up top, a verdict, then an argument assembled from blocks:
 * `claim` prose you (or the agent) write, and `evidence` promoted up from the
 * case's pins. The top rung of the promotion ladder — conversation → evidence →
 * synthesis — and the thing that says whether the thesis held.
 */

import { useEffect, useState } from "react";
import { api, type Case, type CasePin, type CaseDisposition, type SynthesisBlock } from "../../api/client";
import { ALL_DISPOSITIONS, DISPOSITION_CHIP } from "./streamTheme";
import { parseAnalysisMeta } from "./ArtifactPane";

function ClaimBlock({
  block,
  onSave,
  onRemove,
}: {
  block: SynthesisBlock;
  onSave: (text: string) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState(block.text ?? "");
  // Resync only on identity change, never on poll — don't clobber typing.
  useEffect(() => setText(block.text ?? ""), [block.block_id]);
  return (
    <div className="group relative border-l-2 border-accent/40 pl-3.5">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = text.trim();
          if (v && v !== (block.text ?? "")) onSave(v);
        }}
        // grow with the content — a fixed 2-row box clipped long verdicts into a blob
        rows={Math.max(2, text.split("\n").reduce((n, l) => n + 1 + Math.floor(l.length / 90), 0))}
        placeholder="a point of the argument…"
        className="w-full resize-none bg-transparent text-sm leading-relaxed text-text placeholder:text-dim focus:outline-none"
      />
      <button
        type="button"
        onClick={onRemove}
        title="remove from synthesis"
        className="absolute -right-1 top-0 px-1 text-xs text-dim opacity-0 transition-opacity hover:text-dn group-hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}

function EvidenceBlock({
  pin,
  onRemove,
}: {
  pin: CasePin | undefined;
  onRemove: () => void;
}) {
  if (!pin) {
    return (
      <div className="group relative border-l-2 border-line/50 pl-3.5 text-xs text-dim">
        evidence no longer on the case
        <button
          type="button"
          onClick={onRemove}
          className="ml-2 text-dim opacity-0 hover:text-dn group-hover:opacity-100"
        >
          ×
        </button>
      </div>
    );
  }
  const { date, tournament, main, category } = parseAnalysisMeta(pin);
  return (
    <div className="group relative border-l-2 border-amber/50 pl-3.5" style={{ borderColor: "#d5a24a80" }}>
      <div className="font-mono text-[9px] uppercase tracking-wide text-dim">
        ◆ evidence{date ? ` · ${date}` : ""}{tournament ? ` · ${tournament}` : ""}
      </div>
      <div className="mt-0.5 text-sm font-medium leading-snug text-text">{main}</div>
      {category ? (
        <p
          className="mt-0.5 text-xs leading-relaxed text-dim"
          style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {category}
        </p>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        title="remove from synthesis"
        className="absolute -right-1 top-0 px-1 text-xs text-dim opacity-0 transition-opacity hover:text-dn group-hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}

export default function SynthesisView({
  c,
  onCaseChanged,
}: {
  c: Case;
  onCaseChanged: (updated: Case) => void;
}) {
  const [draft, setDraft] = useState("");
  const pinById = new Map(c.pins.map((p) => [p.pin_id, p]));

  const setDisposition = async (d: CaseDisposition): Promise<void> => {
    const updated = await api.patchCase(c.case_id, { disposition: d }).catch(() => null);
    if (updated) onCaseChanged(updated);
  };
  const addClaim = async (): Promise<void> => {
    const t = draft.trim();
    if (!t) return;
    setDraft("");
    const updated = await api.addSynthesisBlock(c.case_id, { kind: "claim", text: t }).catch(() => null);
    if (updated) onCaseChanged(updated);
  };
  const removeBlock = async (blockId: string): Promise<void> => {
    const updated = await api.deleteSynthesisBlock(c.case_id, blockId).catch(() => null);
    if (updated) onCaseChanged(updated);
  };
  const saveClaim = async (blockId: string, text: string): Promise<void> => {
    const updated = await api.updateSynthesisBlock(c.case_id, blockId, text).catch(() => null);
    if (updated) onCaseChanged(updated);
  };

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-col overflow-y-auto px-2 pb-6">
      {/* thesis */}
      <div className="font-mono text-[10px] uppercase tracking-wide text-accent">Thesis</div>
      <h2 className="mt-1.5 text-xl font-semibold leading-tight text-text">
        {c.hypothesis || <span className="text-dim">State the thesis in the case rail →</span>}
      </h2>

      {/* verdict */}
      <div className="mt-4 flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wide text-dim">Verdict</span>
        <select
          value={c.disposition}
          onChange={(e) => void setDisposition(e.target.value as CaseDisposition)}
          className="rounded-md border border-line/60 bg-bg px-2 py-0.5 font-mono text-[11px] focus:outline-none"
          style={{ color: DISPOSITION_CHIP[c.disposition].color }}
        >
          {ALL_DISPOSITIONS.map((d) => (
            <option key={d} value={d} className="text-text">
              {DISPOSITION_CHIP[d].label}
            </option>
          ))}
        </select>
      </div>

      <div className="my-5 h-px bg-line" />

      {/* the argument */}
      {c.synthesis.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line/60 p-4 text-sm leading-relaxed text-dim">
          Nothing synthesized yet. Promote a finding with{" "}
          <span className="font-mono text-[11px] text-accent">+ synthesis</span> on an evidence card, write a
          claim below, or ask the agent to “write up the synthesis.”
        </div>
      ) : (
        <div className="space-y-5">
          {c.synthesis.map((b) =>
            b.kind === "claim" ? (
              <ClaimBlock
                key={b.block_id}
                block={b}
                onSave={(text) => void saveClaim(b.block_id, text)}
                onRemove={() => void removeBlock(b.block_id)}
              />
            ) : (
              <EvidenceBlock
                key={b.block_id}
                pin={b.pin_id ? pinById.get(b.pin_id) : undefined}
                onRemove={() => void removeBlock(b.block_id)}
              />
            ),
          )}
        </div>
      )}

      {/* add a claim */}
      <div className="mt-6 flex items-end gap-2 border-t border-line pt-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void addClaim();
            }
          }}
          rows={2}
          placeholder="Write a claim — a point of the argument…"
          className="max-h-28 min-h-0 flex-1 resize-none bg-transparent text-sm text-text placeholder:text-dim focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void addClaim()}
          disabled={!draft.trim()}
          className="font-mono text-[11px] text-accent disabled:opacity-40"
        >
          + claim
        </button>
      </div>
    </div>
  );
}
