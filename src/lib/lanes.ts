// LANES (SWIT-108) — a named body of work inside one registry project: gamma
// model, Kalshi MLB, tennis. Eric thinks in bodies of work; Switchboard was
// organised by thread, so "refresh my memory… where everything is" came up
// five times in three weeks and a report, a finding or a decision was
// reachable only through the thread that made it.
//
// A LANE IS A ROLL-UP, NEVER A STORE (requirements principle 1): nothing is
// typed into a lane. Its brief is the NEWEST brief among its threads, its
// findings / decisions / reports are what its threads wrote, and it exists
// exactly while at least one thread (archived ones included — principle 4)
// carries its name. The one lane-level fact that is not about a thread is
// its ARCHIVE (hidden from Home and the side menu), kept as a LaneRecord
// beside the threads (threads.json's `lanes`, the app its one writer).
//
// Everything here is PURE and tested: the name rule, the user-wins copy of
// the agent's `page` op `lane`, rename collisions, the archive records, and
// the roll-ups Home, the side menu and the lane page draw. Components only
// draw; App applies. The MCP server (switchboard-mcp.cjs) mirrors the name
// rule and its own read-side roll-up — change one, change the other.

import type { LaneRecord, Thread } from "../types";
import type { PageBrief, PageFinding, PageQuestion, RenderedPage, SettledQuestion } from "./pageStore";
import type { ProjectViewEntry } from "./repoListing";
import { threadLastActive } from "./homeModel";

// ── The name ─────────────────────────────────────────────────────────────────

/** A lane name is a few words (`Gamma model`, `Kalshi MLB`). Mirrored in the
 *  MCP server's LANE_NAME_CAP. Counted in code points. */
export const LANE_NAME_MAX = 48;

/** Letters and digits first, then words and a little punctuation. None of
 *  the characters the typed-line sanitizer strips (`" \ $ % \``) — the name
 *  rides on the launch line (agentContext's lane clause) and must arrive
 *  there unchanged. Mirrored in the MCP server's LANE_NAME_RE. */
const LANE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.,&+'()/:#-]*$/u;

export type LaneNameResult = { ok: true; name: string } | { ok: false; reason: string };

/** THE name rule: NFC, whitespace folded, trimmed; 1..LANE_NAME_MAX code
 *  points; the charset above. A refusal says why, in words the editor can
 *  put in its `title`. Pure. */
export function normalizeLaneName(raw: unknown): LaneNameResult {
  if (typeof raw !== "string") return { ok: false, reason: "a lane name is text" };
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (name.length === 0) return { ok: false, reason: "a lane needs a name" };
  if (Array.from(name).length > LANE_NAME_MAX) {
    return { ok: false, reason: `a lane name is at most ${LANE_NAME_MAX} characters` };
  }
  if (!LANE_NAME_RE.test(name)) {
    return { ok: false, reason: "a lane name starts with a letter or digit and holds letters, digits, spaces and - _ . , & + ' ( ) / : #" };
  }
  return { ok: true, name };
}

/** The comparison key: two spellings that differ only in case or spacing
 *  are ONE lane (`Gamma model` = `gamma  model`). Pure. */
export function laneNameKey(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function sameLaneName(a: string, b: string): boolean {
  return laneNameKey(a) === laneNameKey(b);
}

// ── A thread's lane ──────────────────────────────────────────────────────────

/** A lane's identity: its project and its name. */
export type LaneRef = { project: string; name: string };

/** The identity as one string — `project/name-key`. */
export function laneId(lane: LaneRef): string {
  return `${lane.project}/${laneNameKey(lane.name)}`;
}

type LaneFields = Pick<Thread, "lane" | "laneProject">;

/** The lane a thread is in, or null. Both fields must be present (the
 *  sanitize gate keeps them paired). */
export function threadLane(thread: LaneFields): LaneRef | null {
  return typeof thread.lane === "string" && thread.lane.length > 0 && typeof thread.laneProject === "string" && thread.laneProject.length > 0
    ? { project: thread.laneProject, name: thread.lane }
    : null;
}

/** Is `thread` in `lane`? Case-insensitive on the name, exact on the
 *  project key. */
export function isInLane(thread: LaneFields, lane: LaneRef): boolean {
  const own = threadLane(thread);
  return own !== null && own.project === lane.project && sameLaneName(own.name, lane.name);
}

/** The lane names in use in a project — archived threads included (a lane
 *  exists while any thread carries it) — one spelling each (the most
 *  recently active thread's), alphabetical. What the `lane…` editor offers.
 *  Pure. */
export function projectLaneNames(threads: readonly Thread[], project: string): string[] {
  const byKey = new Map<string, { name: string; at: number }>();
  for (const t of threads) {
    const lane = threadLane(t);
    if (!lane || lane.project !== project) continue;
    const key = laneNameKey(lane.name);
    const at = t.lastActivityAt || t.createdAt || 0;
    const prev = byKey.get(key);
    if (!prev || at > prev.at) byKey.set(key, { name: lane.name, at });
  }
  return [...byKey.values()].map((v) => v.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** The spelling a joining thread takes: an existing lane's when the name
 *  matches one in the project (case/spacing-insensitively), else its own. */
export function canonicalLaneName(threads: readonly Thread[], project: string, name: string): string {
  return projectLaneNames(threads, project).find((n) => sameLaneName(n, name)) ?? name;
}

/** The lane names in a project that START with (or contain) what the editor
 *  holds — the suggestion list under the `lane…` box, current lane first
 *  excluded by the caller. Empty query = every lane. Pure. */
export function suggestLaneNames(names: readonly string[], query: string): string[] {
  const q = laneNameKey(query);
  if (q.length === 0) return [...names];
  const starts = names.filter((n) => laneNameKey(n).startsWith(q));
  const contains = names.filter((n) => !laneNameKey(n).startsWith(q) && laneNameKey(n).includes(q));
  return [...starts, ...contains];
}

// ── Eric's choice wins (requirement 1.4, acceptance 7) ───────────────────────

/** The AGENT'S route into a lane: its `page` op `lane {name}` writes
 *  `page.lane` (the server's file); the app copies it onto the thread record
 *  through THIS rule, which returns the lane to set or null (leave the
 *  record alone). The agent never moves a thread:
 *    · the thread already has a lane (the user's or an earlier agent's) → null;
 *    · the USER took the thread out of its lane (`laneSetBy: "user"` with no
 *      lane) → null — clearing is a choice too;
 *    · the thread has no registry project → null (a lane belongs to one);
 *    · the page's name is not a lane name → null.
 *  Otherwise the lane, spelled as the project already spells it. Pure. */
export function laneFromPage(
  thread: Pick<Thread, "lane" | "laneProject" | "laneSetBy">,
  pageLane: string | null | undefined,
  projectKey: string | null,
  threads: readonly Thread[]
): LaneRef | null {
  if (typeof pageLane !== "string" || pageLane.length === 0) return null;
  if (threadLane(thread) !== null) return null;
  if (thread.laneSetBy === "user") return null;
  if (!projectKey) return null;
  const n = normalizeLaneName(pageLane);
  if (!n.ok) return null;
  return { project: projectKey, name: canonicalLaneName(threads, projectKey, n.name) };
}

// ── Rename (requirement 1.6, edge case 5) ────────────────────────────────────

/** Can lane `from` in `project` be renamed to `to`? Every thread follows a
 *  rename; a name another lane in the project already has is REFUSED with
 *  the reason (merging two lanes is out of scope for V1). A case-only
 *  rename of the lane itself is fine. Pure. */
export function planLaneRename(
  threads: readonly Thread[],
  project: string,
  from: string,
  to: string
): LaneNameResult {
  const n = normalizeLaneName(to);
  if (!n.ok) return n;
  if (!threads.some((t) => isInLane(t, { project, name: from }))) {
    return { ok: false, reason: `there is no lane named ${from} in ${project}` };
  }
  if (sameLaneName(from, n.name)) return n;
  const clash = projectLaneNames(threads, project).find((x) => sameLaneName(x, n.name));
  if (clash !== undefined) {
    return { ok: false, reason: `${clash} is already a lane in ${project} — merging two lanes is not possible yet` };
  }
  return n;
}

// ── Archive records (requirement 1.6) ────────────────────────────────────────

/** Records kept at most — a lane is archived rarely; the cap only bounds a
 *  hand-edited file. */
export const LANE_RECORD_CAP = 200;

/** Tolerant parse of the persisted lane records: a malformed entry drops
 *  alone, a repeat of a lane keeps its first, capped. Not an array → none. */
export function sanitizeLaneRecords(raw: unknown): LaneRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: LaneRecord[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (out.length >= LANE_RECORD_CAP) break;
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.project !== "string" || rec.project.length === 0) continue;
    const n = normalizeLaneName(rec.name);
    if (!n.ok) continue;
    if (typeof rec.archivedAt !== "number" || !(rec.archivedAt > 0)) continue;
    const id = laneId({ project: rec.project, name: n.name });
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ project: rec.project, name: n.name, archivedAt: rec.archivedAt });
  }
  return out;
}

/** When the lane was archived, or null (it is not). */
export function laneArchivedAt(records: readonly LaneRecord[], lane: LaneRef): number | null {
  const id = laneId(lane);
  return records.find((r) => laneId(r) === id)?.archivedAt ?? null;
}

/** Archive or restore a lane. A no-op returns the SAME array. Pure. */
export function setLaneArchivedIn(
  records: readonly LaneRecord[],
  lane: LaneRef,
  archived: boolean,
  now: number
): readonly LaneRecord[] {
  const id = laneId(lane);
  const has = records.some((r) => laneId(r) === id);
  if (archived === has) return records;
  return archived
    ? [...records, { project: lane.project, name: lane.name, archivedAt: now }]
    : records.filter((r) => laneId(r) !== id);
}

/** A rename carries the lane's archive record with it. Pure. */
export function renameLaneRecords(records: readonly LaneRecord[], lane: LaneRef, to: string): readonly LaneRecord[] {
  const id = laneId(lane);
  if (!records.some((r) => laneId(r) === id)) return records;
  return records.map((r) => (laneId(r) === id ? { ...r, name: to } : r));
}

/** Records whose lane no thread carries any more are dropped — clearing the
 *  lane from every thread is how a lane goes away, archive state included.
 *  Returns the SAME array when nothing goes. Pure. */
export function pruneLaneRecords(records: readonly LaneRecord[], threads: readonly Thread[]): readonly LaneRecord[] {
  const live = new Set<string>();
  for (const t of threads) {
    const lane = threadLane(t);
    if (lane) live.add(laneId(lane));
  }
  const kept = records.filter((r) => live.has(laneId(r)));
  return kept.length === records.length ? records : kept;
}

// ── The lanes themselves ─────────────────────────────────────────────────────

export type Lane = {
  project: string;
  name: string;
  /** Every thread in the lane, archived ones included, most recent first. */
  threads: Thread[];
  /** Null while the lane is not archived. */
  archivedAt: number | null;
};

/** The lanes the threads make (principle 1: a lane is its threads), with
 *  their archive state; ordered by project, then name. One spelling per
 *  lane — the most recently active thread's. Pure. */
export function deriveLanes(threads: readonly Thread[], records: readonly LaneRecord[]): Lane[] {
  const byId = new Map<string, Lane>();
  const ordered = [...threads].sort((a, b) => (b.lastActivityAt || b.createdAt || 0) - (a.lastActivityAt || a.createdAt || 0));
  for (const t of ordered) {
    const ref = threadLane(t);
    if (!ref) continue;
    const id = laneId(ref);
    let lane = byId.get(id);
    if (!lane) {
      lane = { project: ref.project, name: ref.name, threads: [], archivedAt: laneArchivedAt(records, ref) };
      byId.set(id, lane);
    }
    lane.threads.push(t);
  }
  return [...byId.values()].sort(
    (a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

/** The lane named by a route, or null (renamed away, emptied). */
export function findLane(lanes: readonly Lane[], ref: LaneRef): Lane | null {
  const id = laneId(ref);
  return lanes.find((l) => laneId(l) === id) ?? null;
}

/** The threads whose page files the roll-ups read: every active thread,
 *  and an ARCHIVED one only when it is in a lane (principle 4 — archived is
 *  not gone; its findings, reports and decisions still count). App's 5s
 *  pass and Home's poll both read this set. Pure. */
export function rollupThreads(threads: readonly Thread[]): Thread[] {
  return threads.filter((t) => !(typeof t.archivedAt === "number" && t.archivedAt > 0) || threadLane(t) !== null);
}

/** Where `+ Thread in this lane` puts the new thread (requirement 4.1): the
 *  working directory of the lane's most recently active thread, when it is
 *  inside one of the project's repos, else the project's first repo; null
 *  when the project has no repo. Pure. */
export function laneThreadDir(
  laneThreads: readonly Pick<Thread, "workingDir" | "lastActivityAt" | "createdAt">[],
  projectRepos: readonly string[],
  isInside: (dir: string, repo: string) => boolean
): string | null {
  const recent = [...laneThreads].sort((a, b) => (b.lastActivityAt || b.createdAt || 0) - (a.lastActivityAt || a.createdAt || 0));
  for (const t of recent) {
    if (t.workingDir && projectRepos.some((r) => isInside(t.workingDir, r))) return t.workingDir;
  }
  return projectRepos[0] ?? null;
}

// ── The roll-up (requirement 2, 3.1) ─────────────────────────────────────────

/** One lane thread with its merged page (pageStore.mergePage). */
export type LaneDigest = { thread: Thread; page: RenderedPage };

export type LaneWaiting = {
  /** Open questions across the lane's threads. */
  questions: number;
  /** Decided on a page, not sent to the agent yet. */
  unsent: number;
  /** Requests other threads posted to a lane thread. */
  requests: number;
  /** To-do items waiting on the user. */
  items: number;
};

/** How many recently answered decisions the lane lists under the open ones. */
export const LANE_ANSWERED_LIMIT = 6;

export type LaneRollup = {
  /** THE LANE BRIEF — the most recently written brief among the lane's
   *  threads, and which thread wrote it (edge case 1: the newer rewrite
   *  wins; edge case 2: a brief OLDER than the current one never becomes
   *  the lane brief — it is not the newest). Null = no thread has one. */
  brief: { brief: PageBrief; thread: Thread } | null;
  /** Every finding of every lane thread, newest first (a dropped finding is
   *  gone from its page, so it is not here). */
  findings: { thread: Thread; finding: PageFinding }[];
  /** Open questions, newest asked first. */
  openQuestions: { thread: Thread; question: PageQuestion }[];
  /** Threads with decisions saved and not sent — one entry per thread. */
  unsent: { thread: Thread; count: number }[];
  /** Recently settled decisions, newest first, capped. */
  answered: { thread: Thread; settled: SettledQuestion }[];
  waiting: LaneWaiting;
  /** The newest sign of life in the lane, ms (live = now). */
  lastActive: number;
};

function stamp(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : -Infinity;
}

/** The newest sign of life for one lane thread: homeModel's (record stamps,
 *  latest turn, open questions) plus its brief and findings; `now` when it
 *  is live. Pure. */
export function laneThreadLastActive(d: LaneDigest, live: boolean, now: number): number {
  if (live) return now;
  let last = threadLastActive(d.thread, d.page);
  for (const s of [d.page.brief?.updatedAt, ...d.page.findings.map((f) => f.updatedAt)]) {
    const t = stamp(s);
    if (t > last) last = t;
  }
  return last;
}

/** THE LANE ROLL-UP, over its threads' merged pages. Threads with no digest
 *  (unread yet) contribute their record stamps to `lastActive` only.
 *  Pure. */
export function laneRollup(
  laneThreads: readonly Thread[],
  digests: ReadonlyMap<string, RenderedPage>,
  live: ReadonlySet<string>,
  now: number
): LaneRollup {
  const ds: LaneDigest[] = [];
  let lastActive = 0;
  for (const thread of laneThreads) {
    const page = digests.get(thread.id);
    if (page) {
      const d = { thread, page };
      ds.push(d);
      lastActive = Math.max(lastActive, laneThreadLastActive(d, live.has(thread.id), now));
    } else {
      lastActive = Math.max(lastActive, live.has(thread.id) ? now : thread.lastActivityAt || thread.createdAt || 0);
    }
  }
  let brief: LaneRollup["brief"] = null;
  for (const d of ds) {
    if (!d.page.brief) continue;
    if (brief === null || stamp(d.page.brief.updatedAt) > stamp(brief.brief.updatedAt)) {
      brief = { brief: d.page.brief, thread: d.thread };
    }
  }
  const findings = ds
    .flatMap((d) => d.page.findings.map((finding) => ({ thread: d.thread, finding })))
    .sort((a, b) => stamp(b.finding.updatedAt) - stamp(a.finding.updatedAt));
  const openQuestions = ds
    .flatMap((d) => d.page.openQuestions.map((question) => ({ thread: d.thread, question })))
    .sort((a, b) => stamp(b.question.askedAt) - stamp(a.question.askedAt));
  const unsent = ds
    .filter((d) => d.page.unsentDecisions.length > 0)
    .map((d) => ({ thread: d.thread, count: d.page.unsentDecisions.length }));
  const answered = ds
    .flatMap((d) => d.page.settledQuestions.map((settled) => ({ thread: d.thread, settled })))
    .sort((a, b) => stamp(b.settled.at) - stamp(a.settled.at))
    .slice(0, LANE_ANSWERED_LIMIT);
  const waiting: LaneWaiting = {
    questions: openQuestions.length,
    unsent: unsent.reduce((n, u) => n + u.count, 0),
    requests: ds.reduce((n, d) => n + d.page.requests.length, 0),
    items: ds.reduce((n, d) => n + d.page.userItems.length, 0),
  };
  return { brief, findings, openQuestions, unsent, answered, waiting, lastActive };
}

/** Does the lane wait on Eric? Any open question, unsent answer, request or
 *  item of his. Pure. */
export function isLaneWaiting(w: LaneWaiting): boolean {
  return w.questions + w.unsent + w.requests + w.items > 0;
}

/** What the lane waits on, in words (Home's pill): `3 questions`,
 *  `2 unsent`, `1 request`, `1 item for you`, joined with ` · `; null when
 *  nothing waits. Pure. */
export function laneWaitsLabel(w: LaneWaiting): string | null {
  const parts: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (w.questions > 0) parts.push(plural(w.questions, "question", "questions"));
  if (w.unsent > 0) parts.push(`${w.unsent} unsent`);
  if (w.requests > 0) parts.push(plural(w.requests, "request", "requests"));
  if (w.items > 0) parts.push(plural(w.items, "item for you", "items for you"));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Home's second line for a lane (requirement 3.1): its latest finding,
 *  else the lane brief's goal, else null. Pure. */
export function laneHomeLine(r: Pick<LaneRollup, "findings" | "brief">): string | null {
  const f = r.findings[0];
  if (f) return f.finding.claim;
  return r.brief?.brief.goal ?? null;
}

export type LaneRow = { lane: Lane; rollup: LaneRollup };

/** Home's lane order (requirement 3.1, edge case 4): lanes waiting on Eric
 *  first, then by last activity, newest first; then by name. A lane whose
 *  only live thread was archived stays up while it has open decisions and
 *  otherwise sinks with its last activity — the same rule, no special case.
 *  Pure; returns a new array. */
export function orderLaneRows(rows: readonly LaneRow[]): LaneRow[] {
  return [...rows].sort((a, b) => {
    const wa = isLaneWaiting(a.rollup.waiting) ? 1 : 0;
    const wb = isLaneWaiting(b.rollup.waiting) ? 1 : 0;
    if (wa !== wb) return wb - wa;
    if (b.rollup.lastActive !== a.rollup.lastActive) return b.rollup.lastActive - a.rollup.lastActive;
    return a.lane.name.localeCompare(b.lane.name, undefined, { sensitivity: "base" });
  });
}

/** The side menu's `· N` for a lane (requirement 3.3): the lane threads' open
 *  questions + unsent answers, from the SAME counts App's 5s pass publishes
 *  for the thread rows (threadStore's openQuestions / unsentDecisions). 0 =
 *  no marker. Pure. */
export function laneMarkerCount(
  lane: Pick<Lane, "threads">,
  openQuestions: Readonly<Record<string, number>>,
  unsentDecisions: Readonly<Record<string, number>>
): number {
  return lane.threads.reduce((n, t) => n + (openQuestions[t.id] ?? 0) + (unsentDecisions[t.id] ?? 0), 0);
}

/** The lane's REPORTS (requirement 2.5, edge case 6): the project's reports
 *  (SWIT-107's index rows, newest first) built by one of the lane's threads —
 *  by the index row's `threadId` — plus a report whose thread no longer
 *  exists (deleted) but whose row was stamped with this lane when it was
 *  built. A report whose thread still exists follows THAT thread's lane
 *  (edge case 3: a thread that moves takes its reports along). Pure. */
export function laneReports(
  views: readonly ProjectViewEntry[],
  lane: Pick<Lane, "name" | "threads">,
  knownThreadIds: ReadonlySet<string>
): ProjectViewEntry[] {
  const mine = new Set(lane.threads.map((t) => t.id));
  return views.filter(
    (v) =>
      mine.has(v.threadId) ||
      (!knownThreadIds.has(v.threadId) && typeof v.lane === "string" && v.lane.length > 0 && sameLaneName(v.lane, lane.name))
  );
}
