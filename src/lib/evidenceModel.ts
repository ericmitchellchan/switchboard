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
//   · `mergeViewEvidence` (SWIT-69, the tab budget) folds the thread's view
//     specs in as `view:<id>` rows — every view stays reachable from the
//     ledger even though only ONE preview tab is open at a time.
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
  | "view"
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
  if (a.startsWith("view:")) return "view";
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
  | "views"
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
  view: "views",
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
  "views",
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

// ── The thread's views as ledger rows (SWIT-69 — the tab budget) ─────────────
// Every view the agent ever showed stays reachable from the page: one row per
// spec on disk, address `view:<viewId>`, label = the view's title. Synthesized
// at render time like the scanned rows — page.json is never written — and an
// agent-posted row at the same address WINS (same precedence as the scan).

export type ThreadViewRow = {
  id: string;
  title: string;
  /** The spec's builtAt ISO stamp — the row's clock. */
  builtAt: string;
};

/** The address a view row carries (and the prefix `evidenceKindOf` reads). */
export function viewAddress(viewId: string): string {
  return `view:${viewId}`;
}

/** The bare view id behind a `view:` address, or null. */
export function viewIdOfAddress(address: string): string | null {
  const a = address.trim();
  if (!a.startsWith("view:")) return null;
  const id = a.slice("view:".length);
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/** A `view:` address with an optional ANCHOR fragment (SWIT-73): a report's
 *  heading is addressable as `view:<id>#h:<slug>` — opening it opens the
 *  view and scrolls the stamped heading into view. The fragment must be a
 *  well-formed anchor key (`<kind>:<id>`, no control chars — the
 *  surfaces/anchors grammar, restated here so this module stays
 *  import-light); a malformed one makes the WHOLE address plain (null),
 *  never a half-honoured link. Pure. */
export function viewAnchorOfAddress(address: string): { viewId: string; anchor: string | null } | null {
  const a = address.trim();
  if (!a.startsWith("view:")) return null;
  const rest = a.slice("view:".length);
  const hash = rest.indexOf("#");
  const id = hash === -1 ? rest : rest.slice(0, hash);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (hash === -1) return { viewId: id, anchor: null };
  const anchor = rest.slice(hash + 1);
  // eslint-disable-next-line no-control-regex
  if (!/^[a-z][a-z0-9-]*:.+$/s.test(anchor) || /[\x00-\x1f\x7f]/.test(anchor)) return null;
  return { viewId: id, anchor };
}

/** What the view poll LATCHES after a pass (SWIT-70 review fix, F2): only
 *  the ids whose spec actually read. A failed or torn read leaves the latched
 *  key UNEQUAL to the id list's key, so the next tick retries that spec
 *  instead of dropping its row until the id list happens to change. Pure. */
export function latchViewKey(ids: readonly string[], okIds: readonly string[]): string {
  return okIds.length === ids.length ? ids.join("\n") : okIds.join("\n");
}

/** Fold the thread's view specs under the evidence rows: one synthesized row
 *  per view NOT already addressed by the agent, newest-first overall (the
 *  same merge shape as `mergeScannedEvidence`). */
export function mergeViewEvidence(
  rows: readonly PageEvidence[],
  views: readonly ThreadViewRow[]
): PageEvidence[] {
  const posted = new Set(rows.map((r) => r.address));
  const extra: PageEvidence[] = [];
  for (const v of views) {
    const address = viewAddress(v.id);
    if (posted.has(address)) continue;
    posted.add(address);
    extra.push({ address, label: v.title, status: null, updatedAt: v.builtAt });
  }
  return [...rows, ...extra].sort(byNewest);
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
