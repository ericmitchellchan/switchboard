/**
 * Cases ledger (mockup cases-compact-v1 Direction A, owner-picked 2026-07-31):
 * one dense row per case — a ledger you scan, not a wall you read. ACTIVE
 * (live/watch/open) leads; everything else sits dimmed under SHELVED. The
 * hypothesis only appears on row hover; zero counts render nothing.
 *
 * Stream is a short TEXT label, not a colored dot — owner: "the colored dots…
 * it doesnt tell me anything, we should use real labels". Color reinforces the
 * label; it is never the sole carrier.
 */

import type { Case } from "../../api/client";
import { ago, DispositionChip } from "./CaseCard";
import { STREAM_COLOR, STREAM_LABEL } from "./streamTheme";

const ACTIVE: Case["disposition"][] = ["live", "watch", "open"];

function Row({
  c,
  onOpen,
  onFilterDisposition,
}: {
  c: Case;
  onOpen: (id: string) => void;
  onFilterDisposition?: (d: Case["disposition"]) => void;
}) {
  const counts = [
    c.pins.length > 0 ? `${c.pins.length}◆` : null,
    c.notes.length > 0 ? `${c.notes.length}✎` : null,
  ].filter(Boolean);
  return (
    <button
      type="button"
      onClick={() => onOpen(c.case_id)}
      className="group flex w-full items-center gap-2.5 rounded-md border border-transparent px-2.5 py-1.5 text-left hover:border-line hover:bg-surface"
    >
      <span
        className="w-14 shrink-0 truncate font-mono text-[9px] uppercase tracking-wider"
        style={{ color: STREAM_COLOR[c.stream] }}
      >
        {STREAM_LABEL[c.stream]}
      </span>
      <span className="shrink-0 truncate text-sm text-text" style={{ maxWidth: "55%" }}>
        {c.title}
      </span>
      {c.hypothesis ? (
        <span className="min-w-0 flex-1 truncate text-xs italic text-dim opacity-0 transition-opacity group-hover:opacity-100">
          {c.hypothesis}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <span className="ml-auto flex shrink-0 items-center gap-3 font-mono text-[10px] text-dim">
        <DispositionChip
          disposition={c.disposition}
          onClick={onFilterDisposition ? () => onFilterDisposition(c.disposition) : undefined}
        />
        <span className="min-w-[44px] text-right">{counts.length > 0 ? counts.join(" ") : "—"}</span>
        <span className="min-w-[48px] text-right">{ago(c.updated_at)}</span>
      </span>
    </button>
  );
}

export default function CaseLedger({
  cases,
  onOpen,
  onFilterDisposition,
}: {
  cases: Case[];
  onOpen: (id: string) => void;
  onFilterDisposition?: (d: Case["disposition"]) => void;
}) {
  const byUpdated = (a: Case, b: Case) => (a.updated_at < b.updated_at ? 1 : -1);
  const active = cases.filter((c) => ACTIVE.includes(c.disposition)).sort(byUpdated);
  const shelved = cases.filter((c) => !ACTIVE.includes(c.disposition)).sort(byUpdated);
  return (
    <div className="max-w-5xl">
      {active.length > 0 ? (
        <div>
          <div className="px-2.5 pb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-dim">
            active <span className="text-dim/60">— live · watch · open ({active.length})</span>
          </div>
          {active.map((c) => (
            <Row key={c.case_id} c={c} onOpen={onOpen} onFilterDisposition={onFilterDisposition} />
          ))}
        </div>
      ) : null}
      {shelved.length > 0 ? (
        <div className={active.length > 0 ? "mt-4" : undefined}>
          <div className="px-2.5 pb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-dim">
            shelved <span className="text-dim/60">— supported · refuted · parked · traded ({shelved.length})</span>
          </div>
          <div className="opacity-60 transition-opacity hover:opacity-100">
            {shelved.map((c) => (
              <Row key={c.case_id} c={c} onOpen={onOpen} onFilterDisposition={onFilterDisposition} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
