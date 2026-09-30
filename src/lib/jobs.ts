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
// LATER (requirements-lanes, "Later"): a job may belong to a lane. Nothing
// here builds that; a job keeps its `threadId`, which is what a lane rolls up
// by.

import { useSyncExternalStore } from "react";
import type { PillTone } from "./statusPill";

// ── Caps, mirrored from src-tauri/src/jobs.rs and the MCP server ─────────────

export const JOB_NAME_MAX = 48;
export const JOB_NAME_RE = /^[A-Za-z0-9_.-]{1,48}$/;
/** Characters (code points), not bytes. */
export const JOB_COMMAND_CAP = 2000;
export const JOBS_RUNNING_PER_THREAD = 8;
export const JOB_LOG_LINES_DEFAULT = 40;
export const JOB_LOG_LINES_MAX = 400;
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

/** Rust's `jobs_snapshot` rows → JobRow[]. A malformed row drops alone; the
 *  state is RE-DERIVED here from the facts (Rust's own `state` word is not
 *  trusted over the rule). */
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
      state: deriveJobState({ stoppedAt, lostAt }, exit, alive),
      lastLine: typeof r.lastLine === "string" ? r.lastLine : "",
    });
  }
  return out;
}

export type JobRequest =
  | { op: "start"; id: string; threadId: string; name: string; command: string; cwd: string | null; at: string }
  | { op: "stop"; id: string; threadId: string; name: string; at: string };

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
  for (const line of raw.replace(/^﻿/, "").split(/\r?\n/)) {
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
    if (e.op === "stop") {
      out.push({ op: "stop", id, threadId, name, at });
    } else if (e.op === "start") {
      const command = typeof e.command === "string" ? e.command.trim() : "";
      if (command.length === 0 || chars(command) > JOB_COMMAND_CAP) continue;
      out.push({ op: "start", id, threadId, name, command, cwd: str(e.cwd), at });
    }
  }
  return out;
}

// ── What a row says ──────────────────────────────────────────────────────────

/** Not running, and not in a way that is fine: a non-zero exit, a timeout,
 *  a start that failed, or lost. A stop is the user's (or the agent's) act,
 *  not a failure. */
export function isJobFailure(row: Pick<JobRow, "state" | "exit">): boolean {
  if (row.state === "lost") return true;
  if (row.state !== "ended" || !row.exit) return false;
  return row.exit.timedOut || row.exit.code !== 0;
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
      if (exit?.code === -1) return { word: "did not start", tone: "amber" };
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

/** THE ONE LINE a job's end posts to its thread's inbox. A failure carries
 *  its last output line, so the agent reading it knows where to look. */
export function jobEndedLine(row: JobRow, now: number): string {
  const ranFor = jobDuration(jobStateAt(row) - row.startedAt);
  const last = row.lastLine.trim();
  const tail = last ? ` · last line: ${last}` : "";
  switch (row.state) {
    case "stopped":
      return capLine(`job ${row.name} stopped after ${ranFor}`);
    case "lost":
      return capLine(
        `job ${row.name} lost: its process is gone and left no exit code (started ${jobDuration(now - row.startedAt)} ago)${tail}`
      );
    case "ended": {
      const exit = row.exit;
      if (exit?.code === -1) return capLine(`job ${row.name} could not start: ${exit.error ?? (last || "unknown reason")}`);
      if (exit?.timedOut) return capLine(`job ${row.name} timed out after ${ranFor}${tail}`);
      const code = exit?.code === null || exit === null ? "no exit code" : `exit ${exit.code}`;
      return capLine(`job ${row.name} ended: ${code} after ${ranFor}${exit?.code === 0 ? "" : tail}`);
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

// ── The pass (effectful, IO injected so it is testable) ─────────────────────

export type JobsIO = {
  takeInbox: () => Promise<string>;
  start: (threadId: string, name: string, command: string, cwd: string | null) => Promise<unknown>;
  stop: (threadId: string, name: string) => Promise<unknown>;
  snapshot: () => Promise<string>;
  /** Post the one ended-line; false when it was already posted. */
  notify: (id: string, text: string) => Promise<boolean>;
  post: (threadId: string, text: string) => Promise<unknown>;
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
  for (const req of requests) {
    try {
      if (req.op === "start") await io.start(req.threadId, req.name, req.command, req.cwd);
      else await io.stop(req.threadId, req.name);
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
  return rows;
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

export function __resetJobsForTests(): void {
  jobs = [];
  listeners.clear();
}
