// The machine watcher's sampler (watcher/docker-watch.sh, SWIT-92) run FOR
// REAL inside docker:28-cli — the image it ships in, with busybox sh + awk —
// against a fake `docker` (watcher/test/docker) that answers from fixtures.
// This is where every bug so far has lived (awk escaping, Go's `<no value>`,
// busybox %d clamping at 2^31-1), so the assertions pin each one. Skips with
// a note when Docker is not reachable, like the tennis exporter test does
// without python.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
// @ts-expect-error — no @types/node in the frontend tsconfig; vitest's node runtime provides it.
import { execFileSync } from "node:child_process";
// @ts-expect-error — same.
import fs from "node:fs";
// @ts-expect-error — same.
import os from "node:os";
// @ts-expect-error — same.
import path from "node:path";
// @ts-expect-error — same.
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const watcherDir = path.resolve(here, "../../watcher");
const fixtureDir = path.join(watcherDir, "test");
const IMAGE = "docker:28-cli";

/** A daemon that runs LINUX containers. GitHub's Windows runners have Docker in
 *  Windows-container mode: `docker version` succeeds there but no Linux image
 *  can run ("no matching manifest for windows/amd64"). */
function dockerReachable(): boolean {
  try {
    const os = execFileSync("docker", ["version", "--format", "{{.Server.Os}}"], { stdio: "pipe", timeout: 15000, encoding: "utf-8" });
    return os.trim() === "linux";
  } catch {
    return false;
  }
}

type Row = Record<string, unknown> & { name: string };
type Snapshot = { sampledAt: string; idleMinutes: number; dryRun: boolean; holdUntil: number; containers: Row[] };

/** Run the sampler for ~3 s (three ticks at MW_CHECK_SECONDS=1) and return the state dir's files.
 *  Grace (the idle window after a watcher start) is OFF unless asked, so the seeded idle rows are
 *  actually idle to the rule. */
function runWatcher(opts: { dryRun: boolean; holdSeconds?: number; grace?: boolean; traffic: string; requests?: string[]; staleRequests?: string[] }) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "sb-watch-"));
  const cleanup = () => fs.rmSync(state, { recursive: true, force: true });
  fs.writeFileSync(path.join(state, "traffic.tsv"), opts.traffic);
  if (opts.holdSeconds) fs.writeFileSync(path.join(state, "hold-until"), String(Math.floor(Date.now() / 1000) + opts.holdSeconds));
  if (opts.requests || opts.staleRequests) {
    fs.mkdirSync(path.join(state, "requests"));
    const write = (name: string, ageMs: number) => {
      const f = path.join(state, "requests", `${name}.stop`);
      fs.writeFileSync(f, JSON.stringify({ at: new Date(Date.now() - ageMs).toISOString(), name, action: "stop", by: "page" }) + "\n");
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(f, t, t); // the watcher judges staleness by the file's age
    };
    for (const name of opts.requests || []) write(name, 0);
    for (const name of opts.staleRequests || []) write(name, 10 * 60 * 1000);
  }
  const script = [
    "mkdir -p /fakebin",
    "tr -d '\\r' < /fake/docker > /fakebin/docker && chmod +x /fakebin/docker",
    "tr -d '\\r' < /mw/docker-watch.sh > /tmp/w.sh",
    "export PATH=/fakebin:$PATH",
    "timeout 3 sh /tmp/w.sh; true",
  ].join(" && ");
  let log: string;
  try {
    log = execFileSync(
      "docker",
      [
        "run", "--rm",
        "-v", `${watcherDir}:/mw:ro`,
        "-v", `${fixtureDir}:/fake:ro`,
        "-v", `${state}:/state`,
        "-e", "MW_CHECK_SECONDS=1",
        "-e", "MW_REQUEST_POLL_SECONDS=1",
        "-e", `MW_START_GRACE=${opts.grace ? 1 : 0}`,
        "-e", "MW_IDLE_MINUTES=120",
        "-e", `MW_DRY_RUN=${opts.dryRun}`,
        IMAGE, "sh", "-c", script,
      ],
      { encoding: "utf-8", timeout: 60000 }
    );
  } catch (err) {
    cleanup();
    throw err;
  }
  const read = (f: string) => (fs.existsSync(path.join(state, f)) ? fs.readFileSync(path.join(state, f), "utf-8") : null);
  const snapshot = JSON.parse(read("containers.json") || "null") as Snapshot | null;
  const lines = (s: string | null) => (s || "").split("\n").filter(Boolean);
  return {
    log,
    snapshot,
    ledger: lines(read("ledger.jsonl")).map((l) => JSON.parse(l) as Row),
    actions: lines(read("actions.jsonl")).map((l) => JSON.parse(l) as Row),
    stopped: lines(read("stopped")),
    traffic: read("traffic.tsv") || "",
    requestsLeft: fs.existsSync(path.join(state, "requests")) ? fs.readdirSync(path.join(state, "requests")) : [],
    cleanup,
  };
}

const now = () => Math.floor(Date.now() / 1000);
/** busy-db seen a minute ago at 1000 bytes; idle-old and the kyde-local one quiet for 300 min; reset-me's counter was higher. */
const seeded = () =>
  [`aaaaaaaaaaa1 1000 ${now() - 60}`, `aaaaaaaaaaa2 500 ${now() - 18000}`, `aaaaaaaaaaa3 700 ${now() - 18000}`, `aaaaaaaaaaa6 9000 ${now() - 60}`, ""].join("\n");

const reachable = dockerReachable();
const maybe = reachable ? describe : describe.skip;
if (!reachable) console.warn("dockerWatch.test.ts: Docker is not reachable — the sampler test is skipped");

maybe("docker-watch.sh in docker:28-cli against a fake docker", () => {
  let dry: ReturnType<typeof runWatcher>;
  beforeAll(() => {
    dry = runWatcher({ dryRun: true, traffic: seeded() });
  }, 90000);
  afterAll(() => dry && dry.cleanup());

  it("writes a snapshot that parses, one row per container, with every field JSON-safe", () => {
    expect(dry.snapshot).not.toBeNull();
    const s = dry.snapshot!;
    expect(s.containers.map((r) => r.name)).toEqual(["busy-db", "idle-old", "kyde-local-timescaledb-1", "mute", "weird-one", "reset-me", "gone"]);
    expect(s.dryRun).toBe(true);
    expect(s.idleMinutes).toBe(120);
    const weird = s.containers[4];
    // a quote, a tab and backslashes in a compose label came through as ' , space and /
    expect(weird.workdir).toBe("C:/a 'b' c");
    expect(s.containers[0].workdir).toBe("C:/Users/ericm/projects/ky-lanes/jira/apps/cloud");
    // Go's `<no value>` for a missing label is blank, not the literal
    expect(s.containers[1].project).toBe("");
    expect(JSON.stringify(s)).not.toContain("<no value>");
  });

  it("keeps a byte counter past 2^31 exact (busybox %d would clamp it) so a busy DB is not busy forever", () => {
    const busy = dry.snapshot!.containers[0];
    expect(busy.trafficKnown).toBe(true);
    // first tick: 5,000,030,000 now vs 1,000 seeded → moved 5,000,029,000; later ticks: 0
    expect(dry.ledger.filter((l) => l.name === "busy-db").map((l) => l.movedBytes)).toEqual(expect.arrayContaining([5000029000, 0]));
    expect(dry.traffic).toMatch(/^aaaaaaaaaaa1 5000030000 \d+$/m);
    expect(busy.movedBytes).toBe(0); // the last tick's delta
    expect(busy.idleMinutes).toBe(0);
  });

  it("applies the idle rule only where it may: not to a skipped project, not to traffic-unknown, and dry means logged not stopped", () => {
    const [, idleOld, kyde, mute] = dry.snapshot!.containers;
    expect(idleOld.restart).toBe("always");
    expect(idleOld.idleMinutes as number).toBeGreaterThanOrEqual(299);
    expect(idleOld.policy).toBe("would stop");
    expect(kyde.skipped).toBe(true);
    expect(kyde.policy).toBe("");
    expect(mute.trafficKnown).toBe(false);
    expect(mute.idleMinutes).toBeNull();
    expect(mute.policy).toBe("");
    expect(dry.stopped).toEqual([]);
    // three ticks, ONE line: a dry-run "would stop" is reported once per idle spell, not every minute
    expect(dry.actions.map((a) => `${a.name}:${a.action}`)).toEqual(["idle-old:would stop"]);
    expect(dry.actions[0].rule).toBe("idle > 120m");
    expect(dry.ledger.filter((l) => l.name === "idle-old").length).toBeGreaterThanOrEqual(2);
  });

  it("treats a counter that went backwards as a restart (the whole reading counts, and clears the 4096-byte floor) and a stopped container as load-free", () => {
    const reset = dry.snapshot!.containers[5];
    // seeded at 9000, now reads 6400: not a negative delta but a fresh 6400 → real use
    expect(dry.ledger.find((l) => l.name === "reset-me")?.movedBytes).toBe(6400);
    expect(reset.idleMinutes).toBe(0);
    // docker prints small memory as "884KiB" (capital K) — that is under a megabyte, not 884 MB
    expect(reset.memMb).toBe(0);
    expect(dry.snapshot!.containers[0].memMb).toBe(302);
    expect(dry.snapshot!.containers[1].memMb).toBe(1032);
    const gone = dry.snapshot!.containers[6];
    expect(gone.state).toBe("exited");
    expect(gone.cpuPct).toBe(0);
    expect(gone.memMb).toBe(0);
    // the ledger holds running containers only
    expect(new Set(dry.ledger.map((l) => l.name))).toEqual(new Set(["busy-db", "idle-old", "kyde-local-timescaledb-1", "mute", "weird-one", "reset-me"]));
  });

  it("live: stops exactly the idle one and records it", () => {
    const live = runWatcher({ dryRun: false, traffic: seeded() });
    try {
      expect(new Set(live.stopped)).toEqual(new Set(["idle-old"]));
      expect(live.snapshot!.containers[1].policy).toBe("stop");
      expect(new Set(live.actions.map((a) => `${a.name}:${a.action}`))).toEqual(new Set(["idle-old:stopped"]));
    } finally {
      live.cleanup();
    }
  }, 90000);

  it("a (re)start gives every container a full idle window: with grace on, the 300-min-idle one is not touched", () => {
    const startedAt = now();
    const graced = runWatcher({ dryRun: false, grace: true, traffic: seeded() });
    try {
      expect(graced.stopped).toEqual([]);
      expect(graced.actions).toEqual([]);
      const idleOld = graced.snapshot!.containers[1];
      expect(idleOld.policy).toBe("");
      expect(idleOld.idleMinutes).toBe(0);
      // the floor is persisted: its clock now starts at the watcher's boot, not 300 min ago
      const m = graced.traffic.match(/^aaaaaaaaaaa2 500 (\d+)$/m);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(startedAt);
    } finally {
      graced.cleanup();
    }
  }, 90000);

  it("serves the page's stop requests: a real name is stopped and logged; a skipped name, a skipped project, an invalid name and a stale request are refused; a docker failure is logged; every file is consumed", () => {
    const req = runWatcher({
      dryRun: true,
      traffic: seeded(),
      requests: ["busy-db", "machine-watcher", "kyde-local-timescaledb-1", "bad name", "no-such"],
      staleRequests: ["idle-old"],
    });
    try {
      // dry run: the IDLE RULE stops nothing, but an explicit page request is a human decision and goes through
      expect(req.stopped).toEqual(["busy-db"]);
      const pageActions = req.actions.filter((a) => a.rule === "page stop").map((a) => `${a.name}:${a.action}${a.reason ? ":" + a.reason : ""}`);
      expect(new Set(pageActions)).toEqual(
        new Set([
          "busy-db:stopped",
          "machine-watcher:refused:skipped container",
          "kyde-local-timescaledb-1:refused:skipped project",
          "invalid:refused:not a container name",
          "no-such:stop failed",
          "idle-old:refused:stale request",
        ])
      );
      expect(req.requestsLeft).toEqual([]);
      // a served request ends the wait early: more than one snapshot happened inside the 3 s window even though
      // the request poll is 1 s and the tick 1 s (the early-tick path is what the page relies on)
      expect(req.ledger.filter((l) => l.name === "busy-db").length).toBeGreaterThanOrEqual(2);
    } finally {
      req.cleanup();
    }
  }, 90000);

  it("a hold pauses the clock: nothing is stopped and the idle one reads as just used", () => {
    const held = runWatcher({ dryRun: false, holdSeconds: 3600, traffic: seeded() });
    try {
      expect(held.stopped).toEqual([]);
      expect(held.actions).toEqual([]);
      const idleOld = held.snapshot!.containers[1];
      expect(idleOld.policy).toBe("");
      expect(idleOld.idleMinutes).toBe(0);
      expect(held.snapshot!.holdUntil).toBeGreaterThan(now());
    } finally {
      held.cleanup();
    }
  }, 90000);
});
