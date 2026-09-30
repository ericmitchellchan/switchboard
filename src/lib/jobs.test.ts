import { describe, it, expect, beforeEach } from "vitest";
import {
  deriveJobState,
  parseJobsSnapshot,
  parseJobsInbox,
  isJobFailure,
  jobPill,
  jobDuration,
  jobEndedLine,
  jobRefusalLine,
  jobsToNotify,
  threadJobs,
  homeJobs,
  runJobsPass,
  useJobs,
  publishJobs,
  __resetJobsForTests,
  JOB_COMMAND_CAP,
  HOME_JOBS_ENDED_MS,
  type JobRow,
  type JobsIO,
} from "./jobs";
import { inboxTypedLine, parseInboxFile, APP_POST_FROM_ID } from "./pageStore";

const T = "3f1c2a9e-0b7d-4c1e-9a55-1234567890ab";
const NOW = Date.parse("2026-09-30T12:00:00Z");
const MIN = 60_000;

function row(over: Partial<JobRow> = {}): JobRow {
  const base: JobRow = {
    id: "j1",
    name: "capture",
    threadId: T,
    command: "python capture.py",
    cwd: "C:\\work",
    kind: "job",
    watch: null,
    startedAt: NOW - 42 * MIN,
    stoppedAt: null,
    lostAt: null,
    notifiedAt: null,
    exit: null,
    alive: true,
    state: "running",
    lastLine: "",
  };
  const r = { ...base, ...over };
  return { ...r, state: over.state ?? deriveJobState(r, r.exit, r.alive) };
}

const exit = (code: number | null, endedAt = NOW, timedOut = false, error: string | null = null) => ({ code, endedAt, timedOut, error });

describe("the state rule (mirrored in jobs.rs derive_state and the MCP server's jobState)", () => {
  it("exit.json wins, then a stop, then a loss (permanent), then liveness", () => {
    const rec = { stoppedAt: null, lostAt: null };
    expect(deriveJobState(rec, exit(0), true)).toBe("ended");
    expect(deriveJobState(rec, null, true)).toBe("running");
    expect(deriveJobState(rec, null, false)).toBe("lost");
    expect(deriveJobState({ stoppedAt: 5, lostAt: null }, null, false)).toBe("stopped");
    expect(deriveJobState({ stoppedAt: null, lostAt: 5 }, null, true)).toBe("lost");
    expect(deriveJobState({ stoppedAt: 5, lostAt: null }, exit(1), false)).toBe("ended");
  });
});

describe("parseJobsSnapshot — Rust's rows, the state re-derived", () => {
  it("reads the facts and derives the state; a malformed row drops alone", () => {
    const raw = JSON.stringify([
      { id: "ja", name: "a", threadId: T, command: "x", cwd: "C:\\", kind: "job", startedAt: 1, alive: false, exit: { code: 2, endedAt: 9, timedOut: false }, state: "running", lastLine: "boom" },
      { id: "jb", name: "b", threadId: T, kind: "watch-run", watch: "w", startedAt: 1, alive: true, exit: null },
      { id: "jc", name: "c", threadId: T, startedAt: 1, alive: false, lostAt: 7 },
      { name: "no id" },
      "junk",
    ]);
    const rows = parseJobsSnapshot(raw);
    expect(rows.map((r) => [r.id, r.state, r.kind])).toEqual([
      ["ja", "ended", "job"],
      ["jb", "running", "watch-run"],
      ["jc", "lost", "job"],
    ]);
    expect(rows[0].exit).toEqual({ code: 2, endedAt: 9, timedOut: false, error: null });
    expect(rows[0].lastLine).toBe("boom");
    expect(rows[1].watch).toBe("w");
    expect(parseJobsSnapshot("not json")).toEqual([]);
    expect(parseJobsSnapshot("{}")).toEqual([]);
  });
});

describe("parseJobsInbox — append-only NDJSON, the guards mirrored", () => {
  const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
  it("reads start and stop line-wise; a torn or malformed line drops alone", () => {
    const raw =
      "\uFEFF" +
      line({ id: "r1", op: "start", threadId: T, name: "capture", command: "  python x.py  ", cwd: "C:\\w", at: "t" }) +
      line({ id: "r2", op: "stop", threadId: T, name: "capture" }) +
      line({ op: "start", threadId: T, name: "bad name", command: "x" }) +
      line({ op: "start", threadId: "../x", name: "a", command: "x" }) +
      line({ op: "start", threadId: T, name: "a", command: "   " }) +
      line({ op: "start", threadId: T, name: "a", command: "é".repeat(JOB_COMMAND_CAP + 1) }) +
      line({ op: "delete", threadId: T, name: "a" }) +
      '{"op":"start","threadId":"' + T + '","na';
    expect(parseJobsInbox(raw)).toEqual([
      { op: "start", id: "r1", threadId: T, name: "capture", command: "python x.py", cwd: "C:\\w", at: "t" },
      { op: "stop", id: "r2", threadId: T, name: "capture", at: "" },
    ]);
    expect(parseJobsInbox(line({ op: "start", threadId: T, name: "a", command: "é".repeat(JOB_COMMAND_CAP) }))).toHaveLength(1);
    expect(parseJobsInbox("")).toEqual([]);
  });
});

describe("what a row says", () => {
  it("pills: running blue, exit 0 green, a failure amber, a stop dim", () => {
    expect(jobPill(row())).toEqual({ word: "running", tone: "blue" });
    expect(jobPill(row({ exit: exit(0) }))).toEqual({ word: "exit 0", tone: "green" });
    expect(jobPill(row({ exit: exit(3) }))).toEqual({ word: "exit 3", tone: "amber" });
    expect(jobPill(row({ exit: exit(124, NOW, true) }))).toEqual({ word: "timed out", tone: "amber" });
    expect(jobPill(row({ exit: exit(-1, NOW, false, "no dir") }))).toEqual({ word: "did not start", tone: "amber" });
    expect(jobPill(row({ alive: false, lostAt: NOW }))).toEqual({ word: "lost", tone: "amber" });
    expect(jobPill(row({ alive: false, stoppedAt: NOW }))).toEqual({ word: "stopped", tone: "dim" });
    expect(isJobFailure(row({ exit: exit(0) }))).toBe(false);
    expect(isJobFailure(row({ exit: exit(1) }))).toBe(true);
    expect(isJobFailure(row({ alive: false }))).toBe(true);
    expect(isJobFailure(row({ alive: false, stoppedAt: NOW }))).toBe(false);
  });

  it("durations in words", () => {
    expect(jobDuration(12_000)).toBe("12 s");
    expect(jobDuration(42 * MIN)).toBe("42 min");
    expect(jobDuration(185 * MIN)).toBe("3 h 5 min");
    expect(jobDuration(120 * MIN)).toBe("2 h");
    expect(jobDuration(52 * 60 * MIN)).toBe("2 d 4 h");
    expect(jobDuration(-5)).toBe("0 s");
  });

  it("THE ONE LINE a job's end posts", () => {
    expect(jobEndedLine(row({ exit: exit(0) }), NOW)).toBe("job capture ended: exit 0 after 42 min");
    expect(jobEndedLine(row({ exit: exit(2), lastLine: "Traceback: boom" }), NOW)).toBe(
      "job capture ended: exit 2 after 42 min · last line: Traceback: boom"
    );
    expect(jobEndedLine(row({ exit: exit(124, NOW, true) }), NOW)).toBe("job capture timed out after 42 min");
    expect(jobEndedLine(row({ exit: exit(-1, NOW, false, "cwd gone") }), NOW)).toBe("job capture could not start: cwd gone");
    expect(jobEndedLine(row({ alive: false, stoppedAt: NOW - 2 * MIN }), NOW)).toBe("job capture stopped after 40 min");
    expect(jobEndedLine(row({ alive: false, lostAt: NOW }), NOW)).toBe(
      "job capture lost: its process is gone and left no exit code (started 42 min ago)"
    );
    const long = jobEndedLine(row({ exit: exit(1), lastLine: "x\n".repeat(900) }), NOW);
    expect([...long].length).toBeLessThanOrEqual(600);
    expect(long).not.toContain("\n");
    expect(jobRefusalLine({ op: "start", id: "", threadId: T, name: "a", command: "x", cwd: null, at: "" }, new Error("a job named a is already running"))).toBe(
      "job a: start refused — a job named a is already running"
    );
  });
});

describe("ordering", () => {
  const running1 = row({ id: "r1", name: "r1", startedAt: NOW - 60 * MIN });
  const running2 = row({ id: "r2", name: "r2", startedAt: NOW - 5 * MIN });
  const endedRecent = row({ id: "e1", name: "e1", exit: exit(0, NOW - 2 * 60 * MIN) });
  const endedFresh = row({ id: "e2", name: "e2", exit: exit(1, NOW - MIN) });
  const endedOld = row({ id: "e3", name: "e3", startedAt: NOW - 3 * 86_400_000, exit: exit(0, NOW - HOME_JOBS_ENDED_MS - MIN) });
  const run = row({ id: "w1", name: "w", kind: "watch-run", watch: "w" });
  const other = row({ id: "o1", name: "o", threadId: "other" });
  const all = [endedOld, running1, endedRecent, run, running2, endedFresh, other];

  it("Home: running first (newest start first), then ended in the last 24 h, newest first; no watch runs", () => {
    expect(homeJobs(all, NOW).map((r) => r.id)).toEqual(["r2", "o1", "r1", "e2", "e1"]);
  });

  it("the page: this thread's jobs, running first, then every settled one", () => {
    expect(threadJobs(all, T).map((r) => r.id)).toEqual(["r2", "r1", "e2", "e1", "e3"]);
  });

  it("owed lines: settled agent jobs not yet posted", () => {
    const posted = row({ id: "p", exit: exit(0), notifiedAt: 5 });
    const wr = row({ id: "wr", kind: "watch-run", exit: exit(1) });
    expect(jobsToNotify([running1, endedFresh, posted, wr]).map((r) => r.id)).toEqual(["e2"]);
  });
});

describe("runJobsPass — one tick, IO injected", () => {
  beforeEach(() => __resetJobsForTests());

  function fakeIO(over: Partial<JobsIO> = {}): JobsIO & { calls: string[] } {
    const calls: string[] = [];
    const io: JobsIO = {
      takeInbox: async () => "",
      start: async (t, n, c, cwd) => calls.push(`start ${t} ${n} ${c} ${cwd}`),
      stop: async (t, n) => calls.push(`stop ${t} ${n}`),
      snapshot: async () => "[]",
      notify: async (id, text) => {
        calls.push(`notify ${id} ${text}`);
        return true;
      },
      post: async (t, text) => calls.push(`post ${t} ${text}`),
      ...over,
    };
    return Object.assign(io, { calls });
  }

  it("acts on each request, posts a refusal back, publishes, and posts each owed ended-line", async () => {
    const inbox =
      JSON.stringify({ op: "start", threadId: T, name: "a", command: "x" }) +
      "\n" +
      JSON.stringify({ op: "stop", threadId: T, name: "b" }) +
      "\n";
    const snap = JSON.stringify([
      { id: "j1", name: "a", threadId: T, kind: "job", startedAt: NOW - 42 * MIN, alive: false, exit: { code: 0, endedAt: NOW, timedOut: false } },
      { id: "j2", name: "c", threadId: T, kind: "job", startedAt: NOW, alive: true },
    ]);
    const io = fakeIO({
      takeInbox: async () => inbox,
      stop: async () => {
        throw new Error("no running job named b in this thread");
      },
      snapshot: async () => snap,
    });
    const rows = await runJobsPass(io, NOW);
    expect(rows?.map((r) => r.state)).toEqual(["ended", "running"]);
    expect(io.calls).toEqual([
      `start ${T} a x null`,
      `post ${T} job b: stop refused — no running job named b in this thread`,
      "notify j1 job a ended: exit 0 after 42 min",
    ]);
  });

  it("a failed snapshot publishes nothing and never throws", async () => {
    publishJobs([row()]);
    const io = fakeIO({
      takeInbox: async () => {
        throw new Error("disk");
      },
      snapshot: async () => {
        throw new Error("jobs.json is unreadable");
      },
    });
    const warnings: string[] = [];
    expect(await runJobsPass(io, NOW, (m) => warnings.push(m))).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(typeof useJobs).toBe("function");
  });
});

describe("the app's own inbox line is typed as the app's (SWIT-109)", () => {
  it("fromId survives the parse and picks the typed prefix", () => {
    const posts = parseInboxFile(
      JSON.stringify({
        posts: [
          { id: "job-j1", from: "jobs", fromId: APP_POST_FROM_ID, kind: "update", text: "job a ended: exit 0 after 1 min", at: "t" },
          { id: "p1", from: "gamma", fromId: "t2", kind: "request", text: "look", at: "t" },
        ],
      })
    );
    expect(inboxTypedLine(posts[0])).toBe("[switchboard] job a ended: exit 0 after 1 min");
    expect(inboxTypedLine(posts[1])).toBe('[from thread "gamma"] look');
  });
});
