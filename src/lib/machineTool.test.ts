// The `machine` MCP tool (SWIT-92, the Docker piece) — pure core loaded from
// the shipped .cjs: the idle classification, the two answers' shape, and the
// op contract (unknown op / bad name / missing snapshot are visible errors;
// `stop` runs exactly `docker stop <name>` and records it).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
// @ts-expect-error — no @types/node in the frontend tsconfig; vitest's node runtime provides it.
import { createRequire } from "node:module";
// @ts-expect-error — same.
import fs from "node:fs";
// @ts-expect-error — same.
import os from "node:os";
// @ts-expect-error — same.
import path from "node:path";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require("../../src-tauri/resources/mcp/switchboard-mcp.cjs") as {
  classifyContainers: (rows: Row[], idleMinutes: number) => { running: Row[]; idle: Row[]; stopped: Row[] };
  formatContainers: (snapshot: Snapshot, nowMs: number) => string;
  formatWhy: (row: Row, ledger: Array<Record<string, unknown>>) => string;
  performMachineOp: (
    env: { machineDir?: string; selfThreadId?: string },
    args: Record<string, unknown>,
    now: number,
    deps?: { exec: (file: string, argv: string[]) => string }
  ) => { message: string };
  MACHINE_TOOL: { name: string; inputSchema: { properties: { op: { enum: string[] } } } };
  OpError: new (message: string) => Error;
};

type Row = {
  id: string; name: string; project: string; service: string; image: string; state: string; restart: string;
  startedAt: string; workdir: string; cpuPct: number; memMb: number; memLimitMb: number; movedBytes: number;
  trafficKnown: boolean; lastTrafficAt: string | null; idleMinutes: number | null; skipped: boolean; policy: string;
};
type Snapshot = { version: 1; sampledAt: string; idleMinutes: number; dryRun: boolean; holdUntil: number; containers: Row[] };

const NOW = Date.parse("2026-09-16T22:00:00Z");
function row(over: Partial<Row>): Row {
  return {
    id: "abc123456789", name: "x", project: "", service: "", image: "img:1", state: "running", restart: "no",
    startedAt: "2026-09-16T10:00:00Z", workdir: "", cpuPct: 0, memMb: 10, memLimitMb: 1000, movedBytes: 0,
    trafficKnown: true, lastTrafficAt: "2026-09-16T21:59:00Z", idleMinutes: 1, skipped: false, policy: "",
    ...over,
  };
}
function snapshot(containers: Row[], over: Partial<Snapshot> = {}): Snapshot {
  return { version: 1, sampledAt: "2026-09-16T21:59:30Z", idleMinutes: 120, dryRun: true, holdUntil: 0, containers, ...over };
}

describe("classifyContainers", () => {
  it("sorts running hottest first, applies the idle rule only where it may, puts come-back containers first among stopped", () => {
    const rows = [
      row({ name: "cool", cpuPct: 1 }),
      row({ name: "hot", cpuPct: 40 }),
      row({ name: "abandoned", idleMinutes: 300, policy: "would stop" }),
      row({ name: "kyde-db", project: "kyde-local", idleMinutes: 300, skipped: true }),
      row({ name: "mute", trafficKnown: false, idleMinutes: null }),
      row({ name: "gone", state: "exited", restart: "no" }),
      row({ name: "zombie", state: "exited", restart: "always" }),
    ];
    const c = server.classifyContainers(rows, 120);
    expect(c.running.map((r) => r.name)).toEqual(["hot", "cool", "abandoned", "kyde-db", "mute"]);
    // skipped (its own reaper) and traffic-unknown are never idle by the rule
    expect(c.idle.map((r) => r.name)).toEqual(["abandoned"]);
    expect(c.stopped.map((r) => r.name)).toEqual(["zombie", "gone"]);
  });
});

describe("formatContainers", () => {
  it("names the snapshot age, the dry-run state and each list with a headline count", () => {
    const text = server.formatContainers(
      snapshot([row({ name: "hot", cpuPct: 12.34, memMb: 512, project: "cloud" }), row({ name: "zombie", state: "exited", restart: "always" })]),
      NOW
    );
    expect(text).toContain("(1 min ago)");
    expect(text).toContain("DRY RUN");
    expect(text).toContain("Running (1, hottest first):");
    expect(text).toContain("- hot · cloud: 12.3% cpu · 512 MB · 1m quiet");
    expect(text).toContain("Idle by the rule (0):");
    expect(text).toContain("Not running (1;");
    expect(text).toContain("- zombie: exited · restart always");
  });

  it("prints a hold when one is in force, and the idle list says held rather than would-be-stopped", () => {
    const text = server.formatContainers(
      snapshot([row({ name: "abandoned", idleMinutes: 300 })], { holdUntil: Math.floor(NOW / 1000) + 3600 }),
      NOW
    );
    expect(text).toContain("HOLD until 2026-09-16T23:00:00.000Z (the clock is paused)");
    expect(text).toContain("- abandoned: 5h 0m quiet — held, not stopped");
    expect(text).not.toContain("would be stopped");
  });

  it("an unreadable sampledAt is 'age unknown', never NaN", () => {
    const text = server.formatContainers(snapshot([], { sampledAt: "garbage" }), NOW);
    expect(text).toContain("(age unknown)");
    expect(text).not.toContain("NaN");
  });
});

describe("formatWhy", () => {
  it("explains a restart policy and prints the ledger tail", () => {
    const text = server.formatWhy(
      row({ name: "clickhouse", project: "lc-data-collector", restart: "always", workdir: "C:\\old\\lc-data-collector", cpuPct: 3.5, memMb: 1008, idleMinutes: 2000 }),
      [{ at: "2026-09-16T21:58:00Z", cpuPct: 3.4, memMb: 1008, movedBytes: 120 }]
    );
    expect(text).toContain("compose project lc-data-collector");
    expect(text).toContain("started from C:\\old\\lc-data-collector");
    expect(text).toContain("restart policy always — it comes back every time Docker starts; `docker update --restart no clickhouse` ends that");
    expect(text).toContain("33h 20m quiet");
    expect(text).toContain("- 2026-09-16T21:58:00Z: 3.4 · 1008 · 120");
  });
});

describe("performMachineOp", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-machine-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an unknown op, a missing wiring and a missing snapshot with a sentence each", () => {
    expect(() => server.performMachineOp({ machineDir: dir }, { op: "dance" }, NOW)).toThrow(/`op` must be one of containers \| why \| stop/);
    expect(() => server.performMachineOp({}, { op: "containers" }, NOW)).toThrow(/not wired/);
    expect(() => server.performMachineOp({ machineDir: dir }, { op: "containers" }, NOW)).toThrow(/mw\.sh ensure/);
  });

  it("stop runs exactly `docker stop <name>`, records the action with the thread id, and names a restart policy", () => {
    fs.writeFileSync(path.join(dir, "containers.json"), JSON.stringify(snapshot([row({ name: "clickhouse", restart: "always" })])));
    const calls: Array<[string, string[]]> = [];
    const r = server.performMachineOp(
      { machineDir: dir, selfThreadId: "t1" },
      { op: "stop", name: "clickhouse" },
      NOW,
      { exec: (f, a) => (calls.push([f, a]), "") }
    );
    expect(calls).toEqual([["docker", ["stop", "clickhouse"]]]);
    expect(r.message).toContain("Stopped clickhouse");
    expect(r.message).toContain("restart policy is always");
    const actions = fs.readFileSync(path.join(dir, "actions.jsonl"), "utf-8").trim().split("\n").map((l: string) => JSON.parse(l));
    expect(actions).toEqual([{ at: "2026-09-16T22:00:00.000Z", name: "clickhouse", action: "stopped", rule: "mcp stop", threadId: "t1" }]);
  });

  it("stop refuses a name outside Docker's grammar and does nothing for a container already down", () => {
    fs.writeFileSync(path.join(dir, "containers.json"), JSON.stringify(snapshot([row({ name: "gone", state: "exited" })])));
    const calls: unknown[] = [];
    const exec = (f: string, a: string[]) => (calls.push([f, a]), "");
    expect(() => server.performMachineOp({ machineDir: dir }, { op: "stop", name: "a; rm -rf /" }, NOW, { exec })).toThrow(/container name/);
    expect(server.performMachineOp({ machineDir: dir }, { op: "stop", name: "gone" }, NOW, { exec }).message).toContain("already exited");
    expect(calls).toEqual([]);
  });

  it("why reads the ledger tail for that name only", () => {
    fs.writeFileSync(path.join(dir, "containers.json"), JSON.stringify(snapshot([row({ name: "a" }), row({ name: "b" })])));
    fs.writeFileSync(
      path.join(dir, "ledger.jsonl"),
      [
        JSON.stringify({ at: "2026-09-16T21:57:00Z", name: "a", cpuPct: 1, memMb: 5, movedBytes: 10 }),
        JSON.stringify({ at: "2026-09-16T21:58:00Z", name: "b", cpuPct: 9, memMb: 5, movedBytes: 10 }),
        "{torn",
        "",
      ].join("\n")
    );
    const r = server.performMachineOp({ machineDir: dir }, { op: "why", name: "a" }, NOW);
    expect(r.message).toContain("last 1 samples");
    expect(r.message).toContain("2026-09-16T21:57:00Z: 1.0 · 5 · 10");
    expect(r.message).not.toContain("21:58:00Z");
    expect(() => server.performMachineOp({ machineDir: dir }, { op: "why", name: "zzz" }, NOW)).toThrow(/no container named zzz/);
  });

  it("containers reads the snapshot on disk", () => {
    fs.writeFileSync(path.join(dir, "containers.json"), JSON.stringify(snapshot([row({ name: "hot", cpuPct: 3 })])));
    const r = server.performMachineOp({ machineDir: dir }, { op: "containers" }, NOW);
    expect(r.message).toContain("Running (1, hottest first):");
    expect(r.message).toContain("- hot: 3.0% cpu");
  });

  it("stop records nothing when docker fails, and names a missing docker binary plainly", () => {
    fs.writeFileSync(path.join(dir, "containers.json"), JSON.stringify(snapshot([row({ name: "x" })])));
    const boom = Object.assign(new Error("Command failed: docker stop x"), { stderr: "Error response from daemon: No such container: x\n" });
    expect(() => server.performMachineOp({ machineDir: dir }, { op: "stop", name: "x" }, NOW, { exec: () => { throw boom; } })).toThrow(
      /docker stop x failed: Error response from daemon: No such container: x/
    );
    const enoent = Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" });
    expect(() => server.performMachineOp({ machineDir: dir }, { op: "stop", name: "x" }, NOW, { exec: () => { throw enoent; } })).toThrow(
      /docker is not on this app's PATH/
    );
    expect(fs.existsSync(path.join(dir, "actions.jsonl"))).toBe(false);
  });

  it("stop for a name the last snapshot does not know still runs docker stop (the snapshot can be a minute old) and records it", () => {
    fs.writeFileSync(path.join(dir, "containers.json"), JSON.stringify(snapshot([])));
    const calls: unknown[] = [];
    const r = server.performMachineOp({ machineDir: dir }, { op: "stop", name: "brand-new" }, NOW, { exec: (f, a) => (calls.push([f, a]), "") });
    expect(calls).toEqual([["docker", ["stop", "brand-new"]]]);
    expect(r.message).toBe("Stopped brand-new and recorded it.");
    expect(fs.readFileSync(path.join(dir, "actions.jsonl"), "utf-8")).toContain('"name":"brand-new"');
  });

  it("why trims Docker's nanosecond start stamp", () => {
    fs.writeFileSync(path.join(dir, "containers.json"), JSON.stringify(snapshot([row({ name: "a", startedAt: "2026-09-15T14:16:40.6204692Z" })])));
    expect(server.performMachineOp({ machineDir: dir }, { op: "why", name: "a" }, NOW).message).toContain("up since 2026-09-15T14:16:40Z");
  });

  it("the tool's schema enumerates exactly the ops the dispatcher accepts", () => {
    expect(server.MACHINE_TOOL.name).toBe("machine");
    expect(server.MACHINE_TOOL.inputSchema.properties.op.enum).toEqual(["containers", "why", "stop"]);
  });
});
