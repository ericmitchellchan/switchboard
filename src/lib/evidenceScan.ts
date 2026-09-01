// THE SCROLLBACK SCAN (SWIT-66) — Ky's ledger rescan, ours. The agent posts
// Evidence rows it CHOOSES to; the terminal is where the rest of the history
// actually went by — ticket keys, PR URLs, file paths mentioned in passing.
// This module reads a thread's live-terminal PLAIN TEXT (terminal.
// plainTextTerminal, the same buffer walk the transcript flush uses) and
// extracts addresses from it.
//
// The rules, straight from Ky's ledgerRescan (CC-592):
//   · UNION, never replace — the buffer is finite scrollback, so absence from
//     it must never drop a row. `recordScan` only ADDS; nothing here removes.
//   · A path candidate counts SYNTACTICALLY in v1 (tight charset, `/`-joined
//     segments, an extension, no `..`) — resolution to a real file is the
//     render seam's job (evidenceModel.resolveDocTarget), and Rust's read
//     guards stay the last line either way.
//   · A ticket-shaped hit counts only when its PREFIX is a known project key
//     (KNOWN_TICKET_PREFIXES) — the bare shape matches UTF-8 and SHA-256.
//   · The scan runs on App's EXISTING 5s inbox pass for LIVE threads only —
//     no new timer, gated on OUTPUT SINCE THE LAST SCAN (noteScanWriteCount
//     against the registry's per-session write counter, so an idle terminal
//     costs zero) — and a thread with no live terminal keeps whatever was
//     already scanned (the store is runtime-only, like threadStore's
//     `prepared` map: a restart starts empty, honestly, because the buffer
//     it would re-scan restarts too).
//
// Layout mirrors devServer.ts: PURE extraction first (exported for tests),
// then the per-thread module-singleton store + useSyncExternalStore hook.
// Nothing here touches the terminal grid, the fit queue, or page.json.

import { useSyncExternalStore } from "react";
import { stripAnsi } from "./devServer";
import { evidenceKindOf } from "./evidenceModel";
import type { EvidenceKind, ScannedEvidence } from "./evidenceModel";

// ── Pure: extraction ─────────────────────────────────────────────────────────

/** Ticket keys — Linear/Jira-style, uppercase project word + number. Bare
 *  numbers and lowercase lookalikes deliberately do not match — and a raw hit
 *  only COUNTS when its prefix is a known project key, because the bare shape
 *  also matches UTF-8, SHA-256, GPT-4, ISO-8601 and COVID-19. */
const TICKET_RE = /\b[A-Z]{2,10}-\d{1,6}\b/g;

/** The ticket prefixes the scan accepts, from the user's project registry
 *  (the table in ~/.claude/CLAUDE.md — the Linear team keys + the Cadence
 *  Jira keys). The registry.json the app reads carries no per-project ticket
 *  key (its tracker entry is team + repo label), so the set is hardcoded
 *  here; a prefix missing from it is a FILTER GAP — the row simply does not
 *  appear — never a crash. Callers may inject their own set. */
export const KNOWN_TICKET_PREFIXES: ReadonlySet<string> = new Set([
  "SWIT", "CAD", "ORB", "SC", "CR", "LODE", "KU", "CC",
]);

/** GitHub PR URLs. The scheme is required IN THE SCAN (a transcript prints
 *  real URLs); the stored address keeps it verbatim. */
const PR_RE = /\bhttps?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\b/g;

/** Path candidates: `/`- or `\`-separated segments in the tight charset, at
 *  least one separator, ending in an extension. Trailing sentence punctuation
 *  is not part of a path; `://` (URLs) and `..` never pass. `-` and `.` sit
 *  in the LOOKBEHIND class as well as the charset so a long dash/dot run has
 *  ONE match start position instead of one per character — the 1MB-of-dashes
 *  perf test is the regression guard. */
const PATH_RE = /(?<![\w:/\\.-])[A-Za-z0-9._-]+(?:[/\\][A-Za-z0-9._-]+)+\.[A-Za-z0-9]{1,8}(?![\w/\\])/g;

const scanKinds = new Set<EvidenceKind>(["doc", "file"]);

export type ScanHit = { address: string; kind: EvidenceKind };

/** Every address the transcript mentions — tickets, PR URLs, doc/file paths —
 *  deduped, first-seen order. Pure; tolerant of ANSI leftovers (the plain
 *  buffer walk has none, but a saved transcript might). */
export function scanTranscript(
  text: string,
  knownTicketPrefixes: ReadonlySet<string> = KNOWN_TICKET_PREFIXES
): ScanHit[] {
  const clean = stripAnsi(text);
  const out: ScanHit[] = [];
  const seen = new Set<string>();
  const add = (address: string, kind: EvidenceKind) => {
    if (seen.has(address)) return;
    seen.add(address);
    out.push({ address, kind });
  };
  for (const m of clean.match(TICKET_RE) ?? []) {
    if (!knownTicketPrefixes.has(m.slice(0, m.indexOf("-")))) continue;
    add(m, "ticket");
  }
  for (const m of clean.match(PR_RE) ?? []) add(m, "pr");
  for (const m of clean.match(PATH_RE) ?? []) {
    // Backslash transcripts (Windows tools print `src\lib\x.ts`) fold to the
    // address form everything downstream speaks; `..` is re-checked after the
    // fold because the charset alone admits it as a segment.
    const address = m.replace(/\\/g, "/");
    if (address.split("/").some((s) => s === "..")) continue;
    const kind = evidenceKindOf(address);
    if (!scanKinds.has(kind)) continue;
    add(address, kind);
  }
  return out;
}

// ── The per-thread runtime store ─────────────────────────────────────────────

/** Newest-first cap per thread — mirrors pageStore's EVIDENCE_CAP posture. */
export const SCAN_CAP = 60;

const EMPTY_ROWS: ScannedEvidence[] = Object.freeze([]) as unknown as ScannedEvidence[];

let scannedByThread = new Map<string, ScannedEvidence[]>();
const seenByThread = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Union NEW hits into a thread's scanned rows. Adds only — an address the
 *  scan saw once stays until the app restarts (Ky's rule: absence from the
 *  finite buffer never drops a row). Newest first, capped at SCAN_CAP (the
 *  OLDEST rows fall off). Returns whether anything changed — re-scans of an
 *  unchanged buffer are a no-op, no re-render. */
export function recordScan(threadId: string, hits: readonly ScanHit[], now: Date = new Date()): boolean {
  let seen = seenByThread.get(threadId);
  if (!seen) {
    seen = new Set();
    seenByThread.set(threadId, seen);
  }
  const fresh: ScannedEvidence[] = [];
  const at = now.toISOString();
  for (const hit of hits) {
    if (seen.has(hit.address)) continue;
    seen.add(hit.address);
    fresh.push({ address: hit.address, kind: hit.kind, at });
  }
  if (fresh.length === 0) return false;
  const prev = scannedByThread.get(threadId) ?? [];
  const merged = [...fresh, ...prev];
  // An evicted address leaves the seen-set too, so a LATER re-mention can
  // come back as a fresh (newest) row instead of being unrepresentable for
  // the rest of the app run. Addresses are unique across rows (the seen-set
  // gates every add), so deleting by evicted row is exact.
  for (const dropped of merged.slice(SCAN_CAP)) seen.delete(dropped.address);
  scannedByThread.set(threadId, merged.slice(0, SCAN_CAP));
  notify();
  return true;
}

/** A thread's scanned rows, newest first. Stable reference while unchanged
 *  (useSyncExternalStore's contract). */
export function scannedEvidenceFor(threadId: string): ScannedEvidence[] {
  return scannedByThread.get(threadId) ?? EMPTY_ROWS;
}

export function useScannedEvidence(threadId: string): ScannedEvidence[] {
  return useSyncExternalStore(subscribe, () => scannedEvidenceFor(threadId));
}

/** The effectful half's one entry point: scan a live thread's transcript text
 *  and union the hits. The CALLER produces the text (App's 5s pass, through
 *  terminal.plainTextTerminal) and skips threads with no live terminal. */
export function scanThreadTranscript(threadId: string, text: string, now: Date = new Date()): void {
  recordScan(threadId, scanTranscript(text), now);
}

/** The 5s pass's dirty gate: the caller hands the session's monotonic output
 *  counter (terminal.getSessionWriteCount) and scans only when it moved since
 *  the last scan — an idle terminal costs zero buffer walks and zero regex
 *  passes. Keyed by THREAD (the store's key); noting the count is the
 *  commitment to scan, so call it only when about to scan. */
const scannedAtWriteCount = new Map<string, number>();

export function noteScanWriteCount(threadId: string, writeCount: number): boolean {
  if (scannedAtWriteCount.get(threadId) === writeCount) return false;
  scannedAtWriteCount.set(threadId, writeCount);
  return true;
}

/** Drop a DELETED thread's scan state. The store is runtime-only, so this is
 *  hygiene (memory + a recycled id starting clean), not persistence. */
export function pruneThreadScan(threadId: string): void {
  scannedByThread.delete(threadId);
  seenByThread.delete(threadId);
  scannedAtWriteCount.delete(threadId);
  notify();
}

export function __resetEvidenceScanForTests(): void {
  scannedByThread = new Map();
  seenByThread.clear();
  scannedAtWriteCount.clear();
  listeners.clear();
}
