// JOBS THAT OUTLIVE THE SESSION (SWIT-109) — the frontend's half. Pure rules
// first (tested in jobs.test.ts), then the one module store the 5s pass
// fills and the ✦ page's and Home's Jobs blocks read.
//
// THE APP STARTS JOBS, claude never does: the MCP `job` tool appends a
// request (`start` / `stop`) to `jobs-inbox.json` — append-only NDJSON with
// MANY appenders (one server per live thread) and ONE taker, the backlog
// inbox's pattern verbatim — and App's 5s pass TAKES it (`take_jobs_inbox`:
// rename away + read + delete), hands each request to Rust (`job_start` /
// `job_stop`, which hold every guard: name, command cap, cwd, a KNOWN thread,
// a unique running name, ≤ 8 running per thread) and posts ONE line back to
// the thread when Rust refuses. Rust spawns a detached, windowless wrapper
// (src-tauri/src/jobs.rs): nobody's child, so it survives the claude session,
// the terminal and the app itself.
//
// STATE IS DERIVED, never stored: exit.json → ended(code); stopped by us →
// stopped; lost once → lost forever; the pid alive with the creation time
// recorded at spawn → running; else lost. Rust probes (only it can open a
// process) and hands the facts over; `deriveJobState` is the rule, mirrored
// in Rust (`derive_state`) and in the MCP server (`jobState`) — change one,
// change all three.
//
// ONE LINE WHEN IT ENDS: the pass posts `job <name> ended: exit 0 after 42
// min` (or `stopped` / `lost` / `could not start`) to the thread's inbox
// through `job_notify`, which stamps `notifiedAt` in the index FIRST — once
// per job, across restarts (a missing line beats a duplicate). The existing
// inbox delivery then types it into the thread's live terminal and the page
// shows it under This turn.
//
// WATCHES (SWIT-110) ride the same inbox and the same pass — see the section
// below.
//
// LATER (requirements-lanes, "Later"): a job may belong to a lane. Nothing
// here builds that; a job keeps its `threadId`, which is what a lane rolls up
// by.

import { useSyncExternalStore } from "react";
import type { PillTone } from "./statusPill";

// ── Caps, mirrored from src-tauri/src/jobs.rs and the MCP server ─────────────

export const JOB_NAME_RE = /^[A-Za-z0-9_.-]{1,48}$/;
/** Characters (code points), not bytes. */
export const JOB_COMMAND_CAP = 2000;
export const JOBS_RUNNING_PER_THREAD = 8;
export const JOB_LOG_LINES_DEFAULT = 40;
export const JOB_LOG_LINES_MAX = 400;
/** A watch's cadence, minutes (SWIT-110) — mirrored in jobs.rs. */
export const WATCH_EVERY_MIN = 5;
export const WATCH_EVERY_MAX = 7 * 24 * 60;
/** Requests acted on per pass (review of 119bc6b); the rest are refused in
 *  ONE line per thread, never silently. */
export const JOB_REQUESTS_PER_PASS = 32;
/** Watch runs STARTED per pass (review M3): after an app start with many
 *  overdue watches they go four at a time, most overdue first — the stagger. */
export const WATCH_RUNS_PER_PASS = 4;
/** Home's Jobs block keeps an ended job this long. */
export const HOME_JOBS_ENDED_MS = 24 * 60 * 60 * 1000;
const THREAD_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** An inbox line is typed into a terminal: keep it one readable line. */
const LINE_CAP = 600;

// ── Types ────────────────────────────────────────────────────────────────────

export type JobState = "running" | "ended" | "stopped" | "lost";
export type JobKind = "job" | "watch-run";

export type JobExit = {
  code: number | null;
  endedAt: number | null;
  timedOut: boolean;
  /** Why the supervisor could not start the command (code -1). */
  error: string | null;
};

export type JobRow = {
  id: string;
  name: string;
  threadId: string;
  command: string;
  cwd: string;
  kind: JobKind;
  /** The watch a `watch-run` belongs to (SWIT-110). */
  watch: string | null;
  startedAt: number;
  stoppedAt: number | null;
  lostAt: number | null;
  notifiedAt: number | null;
  exit: JobExit | null;
  alive: boolean;
  state: JobState;
  lastLine: string;
};

// ── The state rule ───────────────────────────────────────────────────────────

/** THE rule. `alive` is read before `exit` by the prober (the supervisor
 *  writes exit.json and then exits), so "not alive and no exit" can only
 *  mean the job died without reaching its last line: lost. */
export function deriveJobState(
  rec: { stoppedAt: number | null; lostAt: number | null },
  exit: JobExit | null,
  alive: boolean
): JobState {
  if (exit) return "ended";
  if (rec.stoppedAt !== null) return "stopped";
  if (rec.lostAt !== null) return "lost";
  return alive ? "running" : "lost";
}

// ── Tolerant parses ──────────────────────────────────────────────────────────

function isJobState(v: unknown): v is JobState {
  return v === "running" || v === "ended" || v === "stopped" || v === "lost";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseExit(v: unknown): JobExit | null {
  if (!isRecord(v)) return null;
  return { code: num(v.code), endedAt: num(v.endedAt), timedOut: v.timedOut === true, error: str(v.error) };
}

/** Rust's `jobs_snapshot` rows → JobRow[]. A malformed row drops alone.
 *  RUST'S STATE WORD WINS when it is one of the four (only Rust probes, and
 *  only Rust counts misses — a first missed probe reads `running` there, a
 *  second `lost`); `deriveJobState` is the fallback for a row without one. */
export function parseJobsSnapshot(raw: string): JobRow[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: JobRow[] = [];
  for (const r of data) {
    if (!isRecord(r)) continue;
    const id = str(r.id);
    const name = str(r.name);
    const threadId = str(r.threadId);
    const startedAt = num(r.startedAt);
    if (!id || !name || !threadId || startedAt === null) continue;
    const kind: JobKind = r.kind === "watch-run" ? "watch-run" : "job";
    const exit = parseExit(r.exit);
    const stoppedAt = num(r.stoppedAt);
    const lostAt = num(r.lostAt);
    const alive = r.alive === true;
    out.push({
      id,
      name,
      threadId,
      command: str(r.command) ?? "",
      cwd: str(r.cwd) ?? "",
      kind,
      watch: str(r.watch),
      startedAt,
      stoppedAt,
      lostAt,
      notifiedAt: num(r.notifiedAt),
      exit,
      alive,
      state: isJobState(r.state) ? r.state : deriveJobState({ stoppedAt, lostAt }, exit, alive),
      lastLine: typeof r.lastLine === "string" ? r.lastLine : "",
    });
  }
  return out;
}

export type JobRequest =
  | { op: "start"; id: string; threadId: string; name: string; command: string; cwd: string | null; at: string }
  | { op: "stop"; id: string; threadId: string; name: string; at: string }
  | { op: "watch"; id: string; threadId: string; name: string; command: string; cwd: string | null; every: number; at: string }
  | { op: "unwatch"; id: string; threadId: string; name: string; at: string };

/** Code points, as the caps count. */
function chars(s: string): number {
  return [...s].length;
}

/** The request inbox: APPEND-ONLY NDJSON, parsed LINE-WISE so a torn last
 *  line (an append cut by the take) drops alone. The guards run here too so
 *  a malformed request never reaches an IPC call; Rust re-checks all of
 *  them — this is the mirror, not the gate. */
export function parseJobsInbox(raw: string): JobRequest[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  const out: JobRequest[] = [];
  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0) continue;
    let e: unknown;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    if (!isRecord(e)) continue;
    const threadId = str(e.threadId);
    const name = str(e.name);
    if (!threadId || !THREAD_ID_RE.test(threadId) || !name || !JOB_NAME_RE.test(name)) continue;
    const id = str(e.id) ?? "";
    const at = str(e.at) ?? "";
    if (e.op === "stop" || e.op === "unwatch") {
      out.push({ op: e.op, id, threadId, name, at });
    } else if (e.op === "start" || e.op === "watch") {
      const command = typeof e.command === "string" ? e.command.trim() : "";
      if (command.length === 0 || chars(command) > JOB_COMMAND_CAP) continue;
      if (e.op === "start") {
        out.push({ op: "start", id, threadId, name, command, cwd: str(e.cwd), at });
        continue;
      }
      const every = num(e.every);
      if (every === null || !Number.isInteger(every) || every < WATCH_EVERY_MIN || every > WATCH_EVERY_MAX) continue;
      out.push({ op: "watch", id, threadId, name, command, cwd: str(e.cwd), every, at });
    }
  }
  return out;
}

// ── What a row says ──────────────────────────────────────────────────────────

/** Did the SUPERVISOR fail to start the command? Keyed on the supervisor's
 *  `error`, never on the code — a real program may exit -1 (review M2). */
function didNotStart(exit: JobExit | null): boolean {
  return exit !== null && exit.error !== null;
}

/** The state pill: running blue, a clean exit green, a failure amber, a stop
 *  dim. */
export function jobPill(row: Pick<JobRow, "state" | "exit">): { word: string; tone: PillTone } {
  switch (row.state) {
    case "running":
      return { word: "running", tone: "blue" };
    case "stopped":
      return { word: "stopped", tone: "dim" };
    case "lost":
      return { word: "lost", tone: "amber" };
    case "ended": {
      const exit = row.exit;
      if (exit?.timedOut) return { word: "timed out", tone: "amber" };
      if (didNotStart(exit)) return { word: "did not start", tone: "amber" };
      if (exit?.code === 0) return { word: "exit 0", tone: "green" };
      return { word: exit?.code === null || exit === null ? "ended" : `exit ${exit.code}`, tone: "amber" };
    }
  }
}

/** When the row last changed state: its end, its stop, its loss — or, while
 *  running, its start. */
export function jobStateAt(row: Pick<JobRow, "state" | "startedAt" | "stoppedAt" | "lostAt" | "exit">): number {
  if (row.state === "running") return row.startedAt;
  return row.exit?.endedAt ?? row.stoppedAt ?? row.lostAt ?? row.startedAt;
}

/** A duration in words: `12 s`, `42 min`, `3 h 5 min`, `2 d 4 h`. */
export function jobDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

function capLine(s: string): string {
  const one = s.replace(/[\r\n]+/g, " ").trim();
  return [...one].length > LINE_CAP ? `${[...one].slice(0, LINE_CAP - 1).join("")}…` : one;
}

/** Where a failure's output is — the line says so instead of quoting it. */
const OUTPUT_ON_PAGE = " — its last output is on the page (`job log` reads more)";

/** THE ONE LINE a job's end posts to its thread's inbox. It is TYPED into
 *  the thread under the app's `[switchboard]` voice, so it carries only what
 *  the app itself knows — name, exit code, duration — and NEVER the job's
 *  output (review M1: output is the job's text, and it stays on the page and
 *  in `log`). The one supervisor-written reason (`could not start`) is capped. */
export function jobEndedLine(row: JobRow, now: number): string {
  const ranFor = jobDuration(jobStateAt(row) - row.startedAt);
  switch (row.state) {
    case "stopped":
      return capLine(`job ${row.name} stopped after ${ranFor}`);
    case "lost":
      return capLine(`job ${row.name} lost: its process is gone and left no exit code (started ${jobDuration(now - row.startedAt)} ago)${OUTPUT_ON_PAGE}`);
    case "ended": {
      const exit = row.exit;
      if (didNotStart(exit)) return capLine(`job ${row.name} could not start: ${[...(exit?.error ?? "")].slice(0, 160).join("")}`);
      if (exit?.timedOut) return capLine(`job ${row.name} timed out after ${ranFor}${OUTPUT_ON_PAGE}`);
      const code = exit?.code === null || exit === null ? "no exit code" : `exit ${exit.code}`;
      return capLine(`job ${row.name} ended: ${code} after ${ranFor}${exit?.code === 0 ? "" : OUTPUT_ON_PAGE}`);
    }
    case "running":
      return capLine(`job ${row.name} is running`);
  }
}

/** The line a REFUSED request posts back (Rust's reason, verbatim). */
export function jobRefusalLine(req: JobRequest, err: unknown): string {
  const why = String(err instanceof Error ? err.message : err).trim() || "refused";
  return capLine(`job ${req.name}: ${req.op} refused — ${why}`);
}

/** Which rows still owe their one ended-line: agent jobs (a watch run speaks
 *  through its watch, SWIT-110), settled, not yet posted. */
export function jobsToNotify(rows: readonly JobRow[]): JobRow[] {
  return rows.filter((r) => r.kind === "job" && r.state !== "running" && r.notifiedAt === null);
}

/** A thread's jobs for the ✦ page: running first (newest start first), then
 *  the settled ones, most recently changed first. Watch runs are not listed
 *  (their watch is the row, SWIT-110). */
export function threadJobs(rows: readonly JobRow[], threadId: string): JobRow[] {
  return orderJobs(rows.filter((r) => r.kind === "job" && r.threadId === threadId));
}

function orderJobs(rows: JobRow[]): JobRow[] {
  const running = rows.filter((r) => r.state === "running").sort((a, b) => b.startedAt - a.startedAt);
  const settled = rows.filter((r) => r.state !== "running").sort((a, b) => jobStateAt(b) - jobStateAt(a));
  return [...running, ...settled];
}

/** Home's Jobs block: every running job, then the ones that settled in the
 *  last 24 h (a failure among them reads amber by its pill). */
export function homeJobs(rows: readonly JobRow[], now: number): JobRow[] {
  return orderJobs(
    rows.filter((r) => r.kind === "job" && (r.state === "running" || now - jobStateAt(r) <= HOME_JOBS_ENDED_MS))
  );
}

// ── Watches (SWIT-110) ───────────────────────────────────────────────────────
// Eric: the Kalshi capture wrote zero prices for a month unnoticed; "Are we
// now collecting ITF?". A WATCH is a job on a schedule with a pass/fail
// reading. `watch {name, command, every, cwd?}` / `unwatch {name}` ride the
// same inbox; `watches.json` is app-owned (Rust writes it). While the app
// runs, this pass starts each DUE watch as a short `watch-run` job (120 s,
// the supervisor's timeout), judges each finished run ONCE (exit 0 = pass;
// anything else — a non-zero exit, a timeout, a lost run, a start that
// failed — is fail), and posts ONE line to the watch's thread on an EDGE
// only: into failing, and back out of it. A failing watch is one Needs-you
// row on Home; every watch folds under `Watching N` at Home's bottom.

export type WatchStatus = "unknown" | "pass" | "fail";

export type Watch = {
  name: string;
  threadId: string;
  command: string;
  cwd: string;
  everyMin: number;
  createdAt: number;
  lastRunAt: number | null;
  lastJobId: string | null;
  judgedJobId: string | null;
  status: WatchStatus;
  lastLine: string;
  changedAt: number | null;
};

/** Rust's `watches_read` (the file's `watches` array). Tolerant. */
export function parseWatches(raw: string): Watch[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: Watch[] = [];
  for (const w of data) {
    if (!isRecord(w)) continue;
    const name = str(w.name);
    const threadId = str(w.threadId);
    const everyMin = num(w.everyMin);
    if (!name || !threadId || everyMin === null) continue;
    out.push({
      name,
      threadId,
      command: str(w.command) ?? "",
      cwd: str(w.cwd) ?? "",
      everyMin,
      createdAt: num(w.createdAt) ?? 0,
      lastRunAt: num(w.lastRunAt),
      lastJobId: str(w.lastJobId),
      judgedJobId: str(w.judgedJobId),
      status: w.status === "pass" || w.status === "fail" ? w.status : "unknown",
      lastLine: typeof w.lastLine === "string" ? w.lastLine : "",
      changedAt: num(w.changedAt),
    });
  }
  return out;
}

/** A finished run's reading: exit 0 and no timeout passes; everything else
 *  fails. Null while it runs. */
export function watchOutcome(run: Pick<JobRow, "state" | "exit">): "pass" | "fail" | null {
  if (run.state === "running") return null;
  return run.state === "ended" && run.exit?.code === 0 && !run.exit.timedOut ? "pass" : "fail";
}

/** THE EDGE: into failing (from passing OR from a first reading — a watch
 *  whose very first run fails is news), or back out of it. Everything else
 *  — pass after pass, fail after fail, a first pass — says nothing. */
export function watchEdge(prev: WatchStatus, next: "pass" | "fail"): "failing" | "recovered" | null {
  if (next === "fail" && prev !== "fail") return "failing";
  if (next === "pass" && prev === "fail") return "recovered";
  return null;
}

/** Why a run failed, in two words. */
function failWord(run: Pick<JobRow, "state" | "exit">): string {
  if (run.state === "lost") return "lost";
  if (run.state === "stopped") return "stopped";
  if (run.exit?.timedOut) return "timed out";
  if (didNotStart(run.exit)) return "could not start";
  return run.exit?.code === null || !run.exit ? "no exit code" : `exit ${run.exit.code}`;
}

/** The ONE line an edge posts to the watch's thread — what the app knows
 *  (the reason in two words), never the run's output (review M1: that is on
 *  Home's row and in `log`). */
export function watchEdgeLine(name: string, edge: "failing" | "recovered", why: string): string {
  if (edge === "recovered") return capLine(`watch ${name} passing again`);
  return capLine(`watch ${name} failing: ${why} — its last output is on Home (\`job log ${name}\` reads more)`);
}

/** Which due watches start THIS pass: the most overdue first, at most
 *  WATCH_RUNS_PER_PASS (a never-run watch is the most overdue). */
export function watchesToRun<W extends Pick<Watch, "name" | "lastRunAt" | "lastJobId" | "everyMin">>(
  watches: readonly W[],
  rows: readonly JobRow[],
  now: number,
  cap: number = WATCH_RUNS_PER_PASS
): W[] {
  const dueAt = (w: W) => (w.lastRunAt === null ? -Infinity : w.lastRunAt + w.everyMin * 60_000);
  return watches.filter((w) => isWatchDue(w, rows, now)).sort((a, b) => dueAt(a) - dueAt(b)).slice(0, Math.max(0, cap));
}

/** The requests this pass acts on: identical requests (same op, thread and
 *  name — an agent that asked twice within one drain) collapse to the first,
 *  then at most `cap`; the overflow is counted per thread so each thread
 *  hears ONE line about it. Pure. */
export function planJobRequests(
  requests: readonly JobRequest[],
  cap: number = JOB_REQUESTS_PER_PASS
): { act: JobRequest[]; dropped: Map<string, number> } {
  const seen = new Set<string>();
  const unique: JobRequest[] = [];
  for (const r of requests) {
    const key = `${r.op}\u0000${r.threadId}\u0000${r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  const dropped = new Map<string, number>();
  for (const r of unique.slice(cap)) dropped.set(r.threadId, (dropped.get(r.threadId) ?? 0) + 1);
  return { act: unique.slice(0, cap), dropped };
}

/** Due = no run of it in flight, and never run or `every` minutes since the
 *  last run STARTED. */
export function isWatchDue(w: Pick<Watch, "lastRunAt" | "lastJobId" | "everyMin">, rows: readonly JobRow[], now: number): boolean {
  if (w.lastJobId && rows.some((r) => r.id === w.lastJobId && r.state === "running")) return false;
  return w.lastRunAt === null || now >= w.lastRunAt + w.everyMin * 60_000;
}

/** Home's Needs-you rows: the failing watches. */
export function failingWatches(watches: readonly Watch[]): Watch[] {
  return watches.filter((w) => w.status === "fail").sort((a, b) => (b.changedAt ?? 0) - (a.changedAt ?? 0));
}

/** Home's `Watching N` fold: failing first, then by name. */
export function orderWatches(watches: readonly Watch[]): Watch[] {
  return [...watches].sort((a, b) => Number(b.status === "fail") - Number(a.status === "fail") || a.name.localeCompare(b.name));
}

/** A watch's row, in words: `failing · every 15 min · ran 3 min ago`. */
export function watchSummary(w: Watch, now: number): string {
  const state = w.status === "fail" ? "failing" : w.status === "pass" ? "passing" : "not run yet";
  const ran = w.lastRunAt === null ? "" : ` · ran ${jobDuration(now - w.lastRunAt)} ago`;
  return `${state} · every ${w.everyMin} min${ran}`;
}

// ── The pass (effectful, IO injected so it is testable) ─────────────────────

export type JobsIO = {
  takeInbox: () => Promise<string>;
  start: (threadId: string, name: string, command: string, cwd: string | null) => Promise<unknown>;
  stop: (threadId: string, name: string) => Promise<unknown>;
  snapshot: () => Promise<string>;
  /** Post the one ended-line; false when it was already posted. */
  notify: (id: string, text: string) => Promise<boolean>;
  post: (threadId: string, text: string) => Promise<unknown>;
  watch: (threadId: string, name: string, command: string, cwd: string | null, everyMin: number) => Promise<unknown>;
  unwatch: (threadId: string, name: string) => Promise<unknown>;
  readWatches: () => Promise<string>;
  /** Start one run now; rejects (and Rust records it failing) when it cannot start. */
  runWatch: (name: string) => Promise<unknown>;
  recordWatch: (name: string, jobId: string, status: "pass" | "fail", lastLine: string) => Promise<unknown>;
};

/** One tick of App's 5s pass: act on the requests, read the snapshot,
 *  publish it, post the ended-lines owed. Never throws — a failed step is
 *  logged through `warn` and the next tick tries again. */
export async function runJobsPass(io: JobsIO, now: number, warn: (msg: string) => void = () => {}): Promise<JobRow[] | null> {
  let requests: JobRequest[] = [];
  try {
    requests = parseJobsInbox(await io.takeInbox());
  } catch (err) {
    warn(`jobs inbox take failed: ${err}`);
  }
  const plan = planJobRequests(requests);
  for (const [threadId, n] of plan.dropped) {
    warn(`jobs: ${n} request(s) from thread ${threadId} over the per-pass cap`);
    await io
      .post(threadId, capLine(`${n} job request${n === 1 ? "" : "s"} not acted on (cap ${JOB_REQUESTS_PER_PASS} per pass) — send ${n === 1 ? "it" : "them"} again`))
      .catch((e) => warn(`job overflow post failed: ${e}`));
  }
  for (const req of plan.act) {
    try {
      if (req.op === "start") await io.start(req.threadId, req.name, req.command, req.cwd);
      else if (req.op === "stop") await io.stop(req.threadId, req.name);
      else if (req.op === "watch") await io.watch(req.threadId, req.name, req.command, req.cwd, req.every);
      else await io.unwatch(req.threadId, req.name);
    } catch (err) {
      warn(`job ${req.op} ${req.name} refused: ${err}`);
      await io.post(req.threadId, jobRefusalLine(req, err)).catch((e) => warn(`job refusal post failed: ${e}`));
    }
  }
  let rows: JobRow[];
  try {
    rows = parseJobsSnapshot(await io.snapshot());
  } catch (err) {
    warn(`jobs snapshot failed: ${err}`);
    return null;
  }
  publishJobs(rows);
  for (const row of jobsToNotify(rows)) {
    await io.notify(row.id, jobEndedLine(row, now)).catch((e) => warn(`job ${row.name} ended-line failed: ${e}`));
  }
  await runWatchesPass(io, rows, now, warn);
  return rows;
}

/** The watches half of the tick: judge each finished run once (posting a
 *  line on an edge), start each due watch, publish. */
async function runWatchesPass(io: JobsIO, rows: readonly JobRow[], now: number, warn: (msg: string) => void): Promise<void> {
  let watches: Watch[];
  try {
    watches = parseWatches(await io.readWatches());
  } catch (err) {
    warn(`watches read failed: ${err}`);
    return;
  }
  let changed = false;
  for (const w of watches) {
    const run = w.lastJobId ? rows.find((r) => r.id === w.lastJobId) : undefined;
    if (run && run.id !== w.judgedJobId) {
      const outcome = watchOutcome(run);
      if (outcome) {
        try {
          await io.recordWatch(w.name, run.id, outcome, run.lastLine);
          changed = true;
          const edge = watchEdge(w.status, outcome);
          if (edge) await io.post(w.threadId, watchEdgeLine(w.name, edge, failWord(run)));
          w.status = outcome;
        } catch (err) {
          warn(`watch ${w.name} record failed: ${err}`);
        }
      }
    }
  }
  // Start what is due — at most WATCH_RUNS_PER_PASS, most overdue first. A
  // run already in flight is Rust's SKIP (resolves, records nothing); a run
  // that cannot start is recorded failing by Rust on EVERY path, with
  // lastRunAt moved (so it is retried at its next due time, not next tick)
  // and the previous run marked judged (so it never reads "passing" again).
  for (const w of watchesToRun(watches, rows, now)) {
    changed = true;
    try {
      await io.runWatch(w.name);
    } catch (err) {
      const why = String(err instanceof Error ? err.message : err);
      const edge = watchEdge(w.status, "fail");
      if (edge) await io.post(w.threadId, watchEdgeLine(w.name, edge, "could not start")).catch(() => {});
      w.status = "fail";
      warn(`watch ${w.name} could not start: ${why}`);
    }
  }
  if (changed) {
    try {
      watches = parseWatches(await io.readWatches());
    } catch {
      // publish what we have
    }
  }
  publishWatches(watches);
}

// ── The store ────────────────────────────────────────────────────────────────

let jobs: JobRow[] = [];
const listeners = new Set<() => void>();

export function publishJobs(rows: JobRow[]): void {
  jobs = rows;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function getJobs(): JobRow[] {
  return jobs;
}

/** Every job the last snapshot saw (App's 5s pass publishes). */
export function useJobs(): JobRow[] {
  return useSyncExternalStore(subscribe, getJobs);
}

let watchList: Watch[] = [];
const watchListeners = new Set<() => void>();

export function publishWatches(next: Watch[]): void {
  watchList = next;
  for (const l of watchListeners) l();
}

function subscribeWatches(l: () => void): () => void {
  watchListeners.add(l);
  return () => watchListeners.delete(l);
}

function getWatches(): Watch[] {
  return watchList;
}

/** Every watch as the last pass read it. */
export function useWatches(): Watch[] {
  return useSyncExternalStore(subscribeWatches, getWatches);
}

export function __resetJobsForTests(): void {
  jobs = [];
  listeners.clear();
  watchList = [];
  watchListeners.clear();
}
