// LANES (SWIT-108) — a named body of work inside one registry project: gamma
// model, Kalshi MLB, tennis. Eric thinks in bodies of work; Switchboard was
// organised by thread, so "refresh my memory… where everything is" came up
// five times in three weeks and a report, a finding or a decision was
// reachable only through the thread that made it.
//
// A LANE IS A ROLL-UP, NEVER A STORE (requirements principle 1): nothing is
// typed into a lane. Its brief is the NEWEST brief written FOR it by one of
// its threads (the server stamps each brief with the lane it was written for),
// its findings / decisions / reports are what its threads wrote, and it exists
// exactly while at least one thread (archived ones included — principle 4)
// carries its name. The lane-level facts that are not about one thread live
// in a LaneRecord beside the threads (threads.json's `lanes`, the app its one
// writer): the ARCHIVE, the FORMER NAMES after a rename, and a CACHE of the
// lane's brief — what keeps the brief when the thread that holds it moves
// away or is deleted (review of ec319c7, #1).
//
// Everything here is PURE and tested: the name rule (laneName.ts), the
// user-wins copy of the agent's `page` op `lane`, rename collisions, the
// records, which brief counts for which lane, and the roll-ups Home, the side
// menu and the lane page draw. Components only draw; App applies. The MCP
// server (switchboard-mcp.cjs) mirrors the name rule, the brief rule and its
// own read-side roll-up — change one, change the other.

import type { AgentStatus, LaneBriefCache, LaneRecord, Thread } from "../types";
import type { PageBrief, PageFinding, PageQuestion, RenderedPage, SettledQuestion } from "./pageStore";
import { parseBrief } from "./pageStore";
import type { ProjectViewEntry } from "./repoListing";
import { threadLastActive } from "./homeModel";
import { laneNameKey, normalizeLaneName, sameLaneName } from "./laneName";

export { LANE_NAME_MAX, laneNameKey, normalizeLaneName, sameLaneName } from "./laneName";
import type { LaneNameResult } from "./laneName";
export type { LaneNameResult };

// ── A thread's lane ──────────────────────────────────────────────────────────

/** A lane's identity: its project and its name. */
export type LaneRef = { project: string; name: string };

/** The identity as one string — `project/name-key`. */
export function laneId(lane: LaneRef): string {
  return `${lane.project}/${laneNameKey(lane.name)}`;
}

type LaneFields = Pick<Thread, "lane" | "laneProject">;

function isArchivedThread(t: Pick<Thread, "archivedAt">): boolean {
  return typeof t.archivedAt === "number" && t.archivedAt > 0;
}

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
 *  holds — the suggestion list under the `lane…` box. Empty query = every
 *  lane. Pure. */
export function suggestLaneNames(names: readonly string[], query: string): string[] {
  const q = laneNameKey(query);
  if (q.length === 0) return [...names];
  const starts = names.filter((n) => laneNameKey(n).startsWith(q));
  const contains = names.filter((n) => !laneNameKey(n).startsWith(q) && laneNameKey(n).includes(q));
  return [...starts, ...contains];
}

/** The project a thread's `lane…` works in (review of ec319c7, #4): the
 *  project its CURRENT lane belongs to — frozen when the lane was set, so a
 *  re-committed name never moves the thread to a same-named lane of another
 *  project — else the project its folder resolves to. Pure. */
export function laneEditProject(thread: LaneFields, resolved: string | null): string | null {
  return threadLane(thread)?.project ?? resolved;
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

// ── Lane records (requirement 1.6; review of ec319c7, #1 and #5) ─────────────

/** Records kept at most — only bounds a hand-edited file. */
export const LANE_RECORD_CAP = 200;
/** Former names a lane remembers (the newest kept). */
export const LANE_ALIAS_CAP = 8;

function isEmptyRecord(r: LaneRecord): boolean {
  return !(typeof r.archivedAt === "number" && r.archivedAt > 0) && !(r.aliases && r.aliases.length > 0) && !r.brief;
}

/** Tolerant parse of one cached lane brief (its brief through pageStore's
 *  own parser); null when any part is unusable. */
function sanitizeBriefCache(raw: unknown): LaneBriefCache | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const brief = parseBrief(r.brief);
  if (!brief || typeof r.threadId !== "string" || r.threadId.length === 0) return null;
  return { brief, threadId: r.threadId, threadTitle: typeof r.threadTitle === "string" ? r.threadTitle.slice(0, 200) : "" };
}

/** Tolerant parse of the persisted lane records: a malformed entry drops
 *  alone, a repeat of a lane keeps its first, the parts that are junk drop
 *  alone (a bad alias, a bad brief), a record left holding nothing is no
 *  record; capped. Not an array → none. */
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
    const id = laneId({ project: rec.project, name: n.name });
    if (seen.has(id)) continue;
    const next: LaneRecord = { project: rec.project, name: n.name };
    if (typeof rec.archivedAt === "number" && rec.archivedAt > 0) next.archivedAt = rec.archivedAt;
    if (Array.isArray(rec.aliases)) {
      const aliases: string[] = [];
      for (const a of rec.aliases) {
        const an = normalizeLaneName(a);
        if (an.ok && !sameLaneName(an.name, n.name) && !aliases.some((x) => sameLaneName(x, an.name))) aliases.push(an.name);
      }
      if (aliases.length > 0) next.aliases = aliases.slice(-LANE_ALIAS_CAP);
    }
    const brief = sanitizeBriefCache(rec.brief);
    if (brief) next.brief = brief;
    if (isEmptyRecord(next)) continue;
    seen.add(id);
    out.push(next);
  }
  return out;
}

/** The lane's record, or null. */
export function laneRecordFor(records: readonly LaneRecord[], lane: LaneRef): LaneRecord | null {
  const id = laneId(lane);
  return records.find((r) => laneId(r) === id) ?? null;
}

/** When the lane was archived, or null (it is not). */
export function laneArchivedAt(records: readonly LaneRecord[], lane: LaneRef): number | null {
  const a = laneRecordFor(records, lane)?.archivedAt;
  return typeof a === "number" && a > 0 ? a : null;
}

/** Replace one lane's record through `edit` (created when missing, dropped
 *  when it ends up holding nothing). The SAME array when nothing changed. */
function editRecord(
  records: readonly LaneRecord[],
  lane: LaneRef,
  edit: (r: LaneRecord) => LaneRecord
): readonly LaneRecord[] {
  const id = laneId(lane);
  const index = records.findIndex((r) => laneId(r) === id);
  const before = index >= 0 ? records[index] : { project: lane.project, name: lane.name };
  const after = edit(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return records;
  const rest = records.filter((_, i) => i !== index);
  return isEmptyRecord(after) ? rest : index >= 0 ? records.map((r, i) => (i === index ? after : r)) : [...records, after];
}

/** Archive or restore a lane. A no-op returns the SAME array. Pure. */
export function setLaneArchivedIn(
  records: readonly LaneRecord[],
  lane: LaneRef,
  archived: boolean,
  now: number
): readonly LaneRecord[] {
  if ((laneArchivedAt(records, lane) !== null) === archived) return records;
  return editRecord(records, lane, (r) => {
    const { archivedAt: _gone, ...rest } = r;
    return archived ? { ...rest, archivedAt: now } : rest;
  });
}

/** A rename carries the lane's record with it and REMEMBERS the old name
 *  (review of ec319c7, #5): a report stamped with it, a brief written for it
 *  and a route naming it still find the lane. The newest LANE_ALIAS_CAP
 *  names are kept; the new name is never its own alias. Pure. */
export function renameLaneRecords(records: readonly LaneRecord[], lane: LaneRef, to: string): readonly LaneRecord[] {
  const id = laneId(lane);
  const index = records.findIndex((r) => laneId(r) === id);
  const before: LaneRecord = index >= 0 ? records[index] : { project: lane.project, name: lane.name };
  const aliases = [...(before.aliases ?? []), before.name].filter((a, i, all) => !sameLaneName(a, to) && all.findIndex((x) => sameLaneName(x, a)) === i);
  const after: LaneRecord = { ...before, name: to, ...(aliases.length > 0 ? { aliases: aliases.slice(-LANE_ALIAS_CAP) } : {}) };
  if (aliases.length === 0) delete after.aliases;
  const rest = records.filter((_, i) => i !== index);
  return isEmptyRecord(after) ? rest : [...rest, after];
}

/** Records whose lane no thread carries any more are dropped — clearing the
 *  lane from every thread is how a lane goes away, its record included.
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
  /** The lane's former names (a rename keeps them). */
  aliases: string[];
  /** The last lane brief the app saw — kept when its thread goes. */
  cachedBrief: LaneBriefCache | null;
};

/** The lanes the threads make (principle 1: a lane is its threads), with
 *  their records; ordered by project, then name. One spelling per lane — the
 *  most recently active thread's. Pure. */
export function deriveLanes(threads: readonly Thread[], records: readonly LaneRecord[]): Lane[] {
  const byId = new Map<string, Lane>();
  const ordered = [...threads].sort((a, b) => (b.lastActivityAt || b.createdAt || 0) - (a.lastActivityAt || a.createdAt || 0));
  for (const t of ordered) {
    const ref = threadLane(t);
    if (!ref) continue;
    const id = laneId(ref);
    let lane = byId.get(id);
    if (!lane) {
      const rec = laneRecordFor(records, ref);
      lane = {
        project: ref.project,
        name: ref.name,
        threads: [],
        archivedAt: laneArchivedAt(records, ref),
        aliases: rec?.aliases ?? [],
        cachedBrief: rec?.brief ?? null,
      };
      byId.set(id, lane);
    }
    lane.threads.push(t);
  }
  return [...byId.values()].sort(
    (a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

/** Does `name` name this lane — its name, or (a rename ago) a former one? */
export function namesLane(lane: Pick<Lane, "name" | "aliases">, name: string): boolean {
  return sameLaneName(lane.name, name) || lane.aliases.some((a) => sameLaneName(a, name));
}

/** The lane a route names, or null (emptied). A FORMER name finds the lane
 *  it became (review of ec319c7, #5) — an exact current name wins first. */
export function findLane(lanes: readonly Lane[], ref: LaneRef): Lane | null {
  const inProject = lanes.filter((l) => l.project === ref.project);
  return inProject.find((l) => sameLaneName(l.name, ref.name)) ?? inProject.find((l) => namesLane(l, ref.name)) ?? null;
}

/** Is the thread in a lane that is NOT archived? On Home such a thread shows
 *  through its lane; a thread whose lane was archived shows as a thread
 *  again (review of ec319c7, #3 — an archived lane must not swallow a live
 *  thread's question). Pure. */
export function inVisibleLane(thread: LaneFields, records: readonly LaneRecord[]): boolean {
  const lane = threadLane(thread);
  return lane !== null && laneArchivedAt(records, lane) === null;
}

/** The threads whose page files the roll-ups read: every active thread, and
 *  an ARCHIVED one only when it is in a lane that is not archived itself
 *  (principle 4 — archived is not gone — and review of ec319c7, #7: nothing
 *  read is thrown away). App's 5s pass, Home's poll share it. Pure. */
export function rollupThreads(threads: readonly Thread[], records: readonly LaneRecord[] = []): Thread[] {
  return threads.filter((t) => !isArchivedThread(t) || inVisibleLane(t, records));
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

// ── Which brief is the lane's (review of ec319c7, #1) ────────────────────────

function stamp(iso: string | null | undefined): number {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : -Infinity;
}

/** Does this brief count toward `lane`? A brief STAMPED for a lane counts for
 *  that lane only (its name or a former one), wherever its thread is now — so
 *  a thread that joins with a brief written for its own corner (stamped for
 *  no lane, or another) never takes the lane over, and a thread that moved
 *  away keeps counting for the lane it wrote for. A brief from before the
 *  stamp (absent) counts for its thread's CURRENT lane, as it always did.
 *  Pure. */
export function briefCountsFor(
  brief: Pick<PageBrief, "lane">,
  thread: LaneFields,
  lane: Pick<Lane, "project" | "name" | "aliases">
): boolean {
  if (brief.lane === undefined) {
    const own = threadLane(thread);
    return own !== null && own.project === lane.project && namesLane(lane, own.name);
  }
  if (brief.lane === null) return false;
  return brief.lane.project === lane.project && namesLane(lane, brief.lane.name);
}

/** The lane brief as a surface draws it: the brief, its thread when it still
 *  exists (null = deleted), the title to print, and whether it came from the
 *  cache (the thread no longer holds it). */
export type LaneBriefView = { brief: PageBrief; thread: Thread | null; threadTitle: string; fromCache: boolean };

/** THE LANE BRIEF: the newest (by the brief's own stamp) of every brief that
 *  counts for the lane among the threads read, and the cached one — so a
 *  newer rewrite wins (edge case 1), an older joiner never does (edge case
 *  2), and the brief outlives a thread that moved or was deleted. A tie goes
 *  to the live page. Pure. */
export function pickLaneBrief(
  lane: Pick<Lane, "project" | "name" | "aliases" | "cachedBrief">,
  threads: readonly Thread[],
  briefOf: (threadId: string) => PageBrief | null | undefined
): LaneBriefView | null {
  let best: LaneBriefView | null = null;
  for (const t of threads) {
    const b = briefOf(t.id);
    if (!b || !briefCountsFor(b, t, lane)) continue;
    if (best === null || stamp(b.updatedAt) > stamp(best.brief.updatedAt)) best = { brief: b, thread: t, threadTitle: t.title, fromCache: false };
  }
  const cached = lane.cachedBrief;
  if (cached && (best === null || stamp(cached.brief.updatedAt) > stamp(best.brief.updatedAt))) {
    const thread = threads.find((t) => t.id === cached.threadId) ?? null;
    best = { brief: cached.brief, thread, threadTitle: thread?.title ?? cached.threadTitle, fromCache: true };
  }
  return best;
}

/** The cache update App's 5s pass makes: for each lane, the newest counting
 *  brief it read, when it is NEWER than the cached one (or there is none),
 *  becomes the cache. Returns the SAME array when nothing moved. Pure. */
export function nextLaneBriefCaches(
  records: readonly LaneRecord[],
  lanes: readonly Lane[],
  threads: readonly Thread[],
  briefOf: (threadId: string) => PageBrief | null | undefined
): readonly LaneRecord[] {
  let next = records;
  for (const lane of lanes) {
    const live = pickLaneBrief({ ...lane, cachedBrief: null }, threads, briefOf);
    if (!live || !live.thread) continue;
    const cached = lane.cachedBrief;
    if (cached && stamp(cached.brief.updatedAt) >= stamp(live.brief.updatedAt)) continue;
    const cache: LaneBriefCache = { brief: live.brief, threadId: live.thread.id, threadTitle: live.thread.title };
    next = editRecord(next, lane, (r) => ({ ...r, brief: cache }));
  }
  return next;
}

// ── The roll-up (requirement 2, 3.1) ─────────────────────────────────────────

export type LaneWaiting = {
  /** Open questions across the lane's threads (archived ones too). */
  questions: number;
  /** Decided on a page, not sent to the agent yet (archived ones too). */
  unsent: number;
  /** Requests other threads posted — NOT-archived threads only. */
  requests: number;
  /** To-do items waiting on the user — NOT-archived threads only. */
  items: number;
};

/** How many recently answered decisions the lane lists under the open ones. */
export const LANE_ANSWERED_LIMIT = 6;

export type LaneRollup = {
  brief: LaneBriefView | null;
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

/** The newest sign of life for one lane thread: homeModel's (record stamps,
 *  latest turn, open questions) plus its brief and findings; `now` when it
 *  is live. Pure. */
export function laneThreadLastActive(d: { thread: Thread; page: RenderedPage }, live: boolean, now: number): number {
  if (live) return now;
  let last = threadLastActive(d.thread, d.page);
  for (const s of [d.page.brief?.updatedAt, ...d.page.findings.map((f) => f.updatedAt)]) {
    const t = stamp(s);
    if (t > last) last = t;
  }
  return last;
}

/** THE WAITING RULE, one for Home's pill and the side menu's `· N` (review of
 *  ec319c7, #8): open questions and unsent answers count from EVERY lane
 *  thread (a question does not go away because its thread was archived —
 *  edge case 4), requests and items only from threads that are NOT archived
 *  (a stale item on a put-away thread must not pin the lane to the top).
 *  Over per-thread counts — the pass's maps or a digest's lengths. Pure. */
export function laneWaitingFromCounts(
  laneThreads: readonly Pick<Thread, "id" | "archivedAt">[],
  counts: {
    questions: Readonly<Record<string, number>>;
    unsent: Readonly<Record<string, number>>;
    requests: Readonly<Record<string, number>>;
    items: Readonly<Record<string, number>>;
  }
): LaneWaiting {
  const w: LaneWaiting = { questions: 0, unsent: 0, requests: 0, items: 0 };
  for (const t of laneThreads) {
    w.questions += counts.questions[t.id] ?? 0;
    w.unsent += counts.unsent[t.id] ?? 0;
    if (isArchivedThread(t)) continue;
    w.requests += counts.requests[t.id] ?? 0;
    w.items += counts.items[t.id] ?? 0;
  }
  return w;
}

/** THE LANE ROLL-UP, over the merged pages read. `allThreads` are the
 *  threads whose briefs may count (a thread that moved away still counts for
 *  the lane it wrote for); the rest reads the lane's own threads. Threads
 *  with no digest contribute their record stamps to `lastActive` only.
 *  Pure. */
export function laneRollup(
  lane: Lane,
  allThreads: readonly Thread[],
  digests: ReadonlyMap<string, RenderedPage>,
  live: ReadonlySet<string>,
  now: number
): LaneRollup {
  const ds: { thread: Thread; page: RenderedPage }[] = [];
  let lastActive = 0;
  for (const thread of lane.threads) {
    const page = digests.get(thread.id);
    if (page) {
      const d = { thread, page };
      ds.push(d);
      lastActive = Math.max(lastActive, laneThreadLastActive(d, live.has(thread.id), now));
    } else {
      lastActive = Math.max(lastActive, live.has(thread.id) ? now : thread.lastActivityAt || thread.createdAt || 0);
    }
  }
  const brief = pickLaneBrief(lane, allThreads, (id) => digests.get(id)?.brief);
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
  const per = (f: (p: RenderedPage) => number) => Object.fromEntries(ds.map((d) => [d.thread.id, f(d.page)]));
  const waiting = laneWaitingFromCounts(lane.threads, {
    questions: per((p) => p.openQuestions.length),
    unsent: per((p) => p.unsentDecisions.length),
    requests: per((p) => p.requests.length),
    items: per((p) => p.userItems.length),
  });
  return { brief, findings, openQuestions, unsent, answered, waiting, lastActive };
}

/** Does the lane wait on Eric? Pure. */
export function isLaneWaiting(w: LaneWaiting): boolean {
  return waitingTotal(w) > 0;
}

/** The side menu's `· N`. */
export function waitingTotal(w: LaneWaiting): number {
  return w.questions + w.unsent + w.requests + w.items;
}

/** What the lane waits on, in words (Home's pill, the band's tooltip):
 *  `3 questions`, `2 unsent`, `1 request`, `1 item for you`, joined with
 *  ` · `; null when nothing waits. Pure. */
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

/** The lane's liveliest thread status for Home's dot (review of ec319c7,
 *  #3): waiting on Eric beats running beats an error beats done beats idle;
 *  null when no thread of it is live. Pure. */
export function liveliestStatus(statuses: readonly (AgentStatus | undefined)[]): AgentStatus | null {
  const order: AgentStatus[] = ["waiting", "running", "error", "done", "idle"];
  for (const s of order) if (statuses.includes(s)) return s;
  return statuses.length > 0 ? "idle" : null;
}

export type LaneRow = { lane: Lane; rollup: LaneRollup };

/** Home's lane order (requirement 3.1, edge case 4): lanes waiting on Eric
 *  first, then by last activity, newest first; then by name. Pure. */
export function orderLaneRows(rows: readonly LaneRow[]): LaneRow[] {
  return [...rows].sort((a, b) => {
    const wa = isLaneWaiting(a.rollup.waiting) ? 1 : 0;
    const wb = isLaneWaiting(b.rollup.waiting) ? 1 : 0;
    if (wa !== wb) return wb - wa;
    if (b.rollup.lastActive !== a.rollup.lastActive) return b.rollup.lastActive - a.rollup.lastActive;
    return a.lane.name.localeCompare(b.lane.name, undefined, { sensitivity: "base" });
  });
}

/** The lane's REPORTS (requirement 2.5, edge case 6): the project's reports
 *  (SWIT-107's index rows, newest first) built by one of the lane's threads —
 *  by the index row's `threadId` — plus a report whose thread no longer
 *  exists but whose row was stamped with this lane (its name or a former
 *  one) when it was built. A report whose thread still exists follows THAT
 *  thread's lane (edge case 3). Pure. */
export function laneReports(
  views: readonly ProjectViewEntry[],
  lane: Pick<Lane, "name" | "aliases" | "threads">,
  knownThreadIds: ReadonlySet<string>
): ProjectViewEntry[] {
  const mine = new Set(lane.threads.map((t) => t.id));
  return views.filter(
    (v) =>
      mine.has(v.threadId) ||
      (!knownThreadIds.has(v.threadId) && typeof v.lane === "string" && v.lane.length > 0 && namesLane(lane, v.lane))
  );
}
