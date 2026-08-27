/**
 * Desk card for one research case (mockup Direction A `.tcard`): stream edge
 * color, subject chip, disposition status, title, hypothesis, labels, and a
 * footer with evidence counts + recency.
 */

import type { Case } from "../../api/client";
import { DISPOSITION_CHIP, STREAM_COLOR, subjectLine } from "./streamTheme";

/** Card eyebrow: SHORT subject only (owner pin 2026-07-31: raw "KXMLBKS…: model
 * K = PA x K-rate" word-salad is venue jargon duplicating the title). Markets
 * show the bare ticker code; verbose labels cut at the first colon. */
function compactSubject(subject: Case["subject"]): string {
  if (subject.kind === "market" && subject.ticker) return subject.ticker;
  const line = subjectLine(subject).split(":")[0].trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

export function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

export function DispositionChip({
  disposition,
  onClick,
}: {
  disposition: Case["disposition"];
  /** Optional (e.g. desk cards use it to filter by this disposition). */
  onClick?: () => void;
}) {
  const chip = DISPOSITION_CHIP[disposition];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
        onClick ? "cursor-pointer hover:brightness-125" : ""
      }`}
      style={{ color: chip.color, background: `${chip.color}1f` }}
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation(); // don't open the card underneath
              onClick();
            }
          : undefined
      }
    >
      <i
        className={`inline-block h-1.5 w-1.5 rounded-full ${chip.pulse ? "animate-pulse" : ""}`}
        style={{ background: chip.color }}
      />
      {chip.label}
    </span>
  );
}

export default function CaseCard({
  c,
  onOpen,
  onFilterDisposition,
}: {
  c: Case;
  onOpen: (id: string) => void;
  /** Desk: clicking the disposition chip filters the grid by it. */
  onFilterDisposition?: (d: Case["disposition"]) => void;
}) {
  const color = STREAM_COLOR[c.stream];
  return (
    <button
      type="button"
      onClick={() => onOpen(c.case_id)}
      className="group relative overflow-hidden rounded-lg border border-line bg-bg p-3 text-left transition-colors hover:border-accent"
    >
      {/* stream edge (mockup .edge) */}
      <div className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />
      <div className="mb-1 flex items-center gap-2 pl-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate font-mono text-[11px] text-dim" title={subjectLine(c.subject)}>
          {compactSubject(c.subject)}
        </span>
        <span className="ml-auto shrink-0">
          <DispositionChip
            disposition={c.disposition}
            onClick={onFilterDisposition ? () => onFilterDisposition(c.disposition) : undefined}
          />
        </span>
      </div>
      <div className="pl-1.5 text-sm text-text">{c.title}</div>
      {c.hypothesis ? (
        <div className="mt-1 line-clamp-1 pl-1.5 text-xs text-dim" title={c.hypothesis}>
          {c.hypothesis}
        </div>
      ) : null}
      {c.labels.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1 pl-1.5">
          {c.labels.slice(0, 3).map((l) => (
            <span key={l} className="rounded border border-line px-1 py-px font-mono text-[10px] text-dim">
              #{l}
            </span>
          ))}
          {c.labels.length > 3 ? (
            <span className="px-1 py-px font-mono text-[10px] text-dim">+{c.labels.length - 3}</span>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2 pl-1.5 font-mono text-[10px] text-dim">
        {/* zero counts are noise — show only what the case actually has */}
        {(
          [
            [c.pins.length, "pins"],
            [c.thread_ids.length, "threads"],
            [c.notes.length, "notes"],
          ] as const
        )
          .filter(([n]) => n > 0)
          .map(([n, label], i) => (
            <span key={label}>
              {i > 0 ? "· " : "◆ "}
              {n} {label}
            </span>
          ))}
        <span className="ml-auto">{ago(c.updated_at)}</span>
      </div>
      <div className="pointer-events-none absolute right-2 top-2 text-dim opacity-0 transition-opacity group-hover:opacity-100">
        →
      </div>
    </button>
  );
}
