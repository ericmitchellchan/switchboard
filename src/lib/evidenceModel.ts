// EVIDENCE AS A THREAD HISTORY (SWIT-66) — the pure rules under PageView's
// Evidence section, built Ky's way (ledgerModel's fixed kind groups + counts;
// no git in the app):
//
//   · `evidenceKindOf` names WHAT an address is — a ticket key, a PR URL, a
//     surface page, a decision, a doc, a file — from the address ALONE, so
//     the grouping never needs the network or the filesystem.
//   · `groupEvidence` folds rows into fixed, ordered kind groups with counts,
//     `recent` (the newest RECENT_CAP across kinds) first. Empty groups are
//     not rendered — the group list is the registration list, not a form.
//   · `mergeScannedEvidence` folds the scrollback-scanned rows (evidenceScan)
//     under the agent's own: an agent-posted row at the same address WINS
//     (label + status — the agent said what the thing IS; the scan only saw
//     it go by). Union semantics ride in evidenceScan's store; this merge is
//     where precedence lives. page.json is NEVER written by the app — the
//     scanned rows are synthesized at render time exactly like the
//     `decision:<id>` rows in pageStore.mergePage (one writer per file).
//   · `resolveDocTarget` is the doc/file row's link rule: a KB doc resolves
//     against the REAL doc list, a repo file resolves syntactically against
//     the thread's own project (v1 — the charset is tight and `..` never
//     passes, so a bad path opens an error card, never escapes a root).
//
// Pure — types only from pageStore/panelStore; no IO, no React.

import type { PageEvidence } from "./pageStore";
import type { OpenableArtifact } from "./panelStore";

// ── Kinds ────────────────────────────────────────────────────────────────────

export type EvidenceKind =
  | "ticket"
  | "pr"
  | "page"
  | "decision"
  | "doc"
  | "file"
  | "other";

/** Linear/Jira-style ticket key — the WHOLE address (`SWIT-64`, `CAD-1234`). */
const TICKET_ADDRESS = /^[A-Z]{2,10}-\d{1,6}$/;

/** GitHub PR URL — `github.com/<owner>/<repo>/pull/<n>`, scheme optional. */
const PR_ADDRESS = /^(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

/** A path-shaped address: `/`-separated segments in a tight charset, no `..`
 *  (a display charset, not a guard — Rust's read guards stay the last line). */
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function isPathShaped(address: string): boolean {
  if (address.length === 0 || address.length > 300) return false;
  const segments = address.split("/");
  return segments.every((s) => s.length > 0 && s !== ".." && PATH_SEGMENT.test(s));
}

/** What kind of thing an Evidence address names. Order matters only where the
 *  forms could collide — a ticket key is never path-shaped, a `.md` path is a
 *  doc before it is a file. */
export function evidenceKindOf(address: string): EvidenceKind {
  const a = address.trim();
  if (a.startsWith("decision:")) return "decision";
  if (a.startsWith("surface:")) return "page";
  if (TICKET_ADDRESS.test(a)) return "ticket";
  if (PR_ADDRESS.test(a)) return "pr";
  if (isPathShaped(a)) {
    if (/\.md$/i.test(a)) return "doc";
    // A path is a FILE only when it says so — a slash or an extension. A bare
    // word (`refactor`, `later`) is prose, not a path.
    if (a.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(a)) return "file";
  }
  return "other";
}

// ── Groups ───────────────────────────────────────────────────────────────────

export const RECENT_CAP = 8;

export type EvidenceGroupId =
  | "recent"
  | "tickets"
  | "prs"
  | "docs"
  | "files"
  | "pages"
  | "decisions"
  | "other";

export type EvidenceGroup = {
  id: EvidenceGroupId;
  /** The chip's word — the id, verbatim (lowercase, no narration). */
  label: EvidenceGroupId;
  count: number;
  rows: PageEvidence[];
};

const KIND_GROUP: Record<Exclude<EvidenceKind, never>, Exclude<EvidenceGroupId, "recent">> = {
  ticket: "tickets",
  pr: "prs",
  doc: "docs",
  file: "files",
  page: "pages",
  decision: "decisions",
  other: "other",
};

const GROUP_ORDER: EvidenceGroupId[] = [
  "recent",
  "tickets",
  "prs",
  "docs",
  "files",
  "pages",
  "decisions",
  "other",
];

/** Fold rows (already newest-first — mergePage's order) into the fixed group
 *  order, empty groups dropped. `recent` is the newest RECENT_CAP across
 *  kinds and exists whenever there is at least one row. */
export function groupEvidence(rows: readonly PageEvidence[]): EvidenceGroup[] {
  if (rows.length === 0) return [];
  const byGroup = new Map<EvidenceGroupId, PageEvidence[]>();
  byGroup.set("recent", rows.slice(0, RECENT_CAP));
  for (const row of rows) {
    const id = KIND_GROUP[evidenceKindOf(row.address)];
    const list = byGroup.get(id);
    if (list) list.push(row);
    else byGroup.set(id, [row]);
  }
  const out: EvidenceGroup[] = [];
  for (const id of GROUP_ORDER) {
    const groupRows = byGroup.get(id);
    if (!groupRows || groupRows.length === 0) continue;
    out.push({ id, label: id, count: groupRows.length, rows: groupRows });
  }
  return out;
}

// ── The scanned-row merge ────────────────────────────────────────────────────

/** The status a scrollback-scanned row renders with — plain words, the kit's
 *  outcome-state rule. */
export const SCANNED_STATUS = "seen in thread";

export type ScannedEvidence = {
  address: string;
  kind: EvidenceKind;
  /** First-seen ISO stamp — the scan's own clock, newest-first order. */
  at: string;
};

/** Newest first by `updatedAt`; an unparseable stamp sorts LAST, equal stamps
 *  keep input order (mergePage's byNewest rule, restated here because the
 *  scanned rows must interleave by the same clock). */
function byNewest(a: PageEvidence, b: PageEvidence): number {
  const ta = Date.parse(a.updatedAt);
  const tb = Date.parse(b.updatedAt);
  const na = Number.isFinite(ta) ? ta : -Infinity;
  const nb = Number.isFinite(tb) ? tb : -Infinity;
  return nb - na;
}

/** Fold scanned rows under the agent's: an agent-posted row with the same
 *  address WINS outright (label + status), a scanned-only address becomes a
 *  row with SCANNED_STATUS and no label. Newest-first overall (stable, so the
 *  agent's own order holds among equal stamps). */
export function mergeScannedEvidence(
  agentRows: readonly PageEvidence[],
  scanned: readonly ScannedEvidence[]
): PageEvidence[] {
  const posted = new Set(agentRows.map((r) => r.address));
  const extra: PageEvidence[] = [];
  for (const s of scanned) {
    if (posted.has(s.address)) continue;
    posted.add(s.address); // scan dedupe belt — the store already unions
    extra.push({ address: s.address, label: "", status: SCANNED_STATUS, updatedAt: s.at });
  }
  return [...agentRows, ...extra].sort(byNewest);
}

// ── Doc/file row → artifact (the link rule) ──────────────────────────────────

/** The artifact a doc/file Evidence address opens beside the thread, or null
 *  when it stays plain text. A KB doc must be IN the real doc list (exact
 *  path); a repo file needs the thread's project key and a syntactically
 *  clean relative path — v1's honest reach: the file's existence is the
 *  viewer's problem (explorerRead errors visibly), never a silent link. */
export function resolveDocTarget(
  address: string,
  kbDocs: readonly string[] | null,
  projectKey: string | null
): OpenableArtifact | null {
  const kind = evidenceKindOf(address);
  if (kind !== "doc" && kind !== "file") return null;
  const a = address.trim();
  if (kbDocs !== null && kbDocs.includes(a)) return { kind: "kb-doc", path: a };
  if (projectKey !== null && a.includes("/")) return { kind: "repo-file", project: projectKey, path: a };
  return null;
}
