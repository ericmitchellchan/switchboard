import { describe, expect, it } from "vitest";
import {
  DROP_AFTER_MS,
  LAUNCH_SKEW_MS,
  healthLaunchAt,
  nextToolsVerdict,
  type McpHealthReading,
} from "./toolsHealth";
import type { ThreadPrepared } from "./threadStore";

const LAUNCH = 1_000_000;
const ok: ThreadPrepared = { prepared: true, at: LAUNCH };
const dropped: ThreadPrepared = { prepared: false, reason: "r", dropped: true, at: LAUNCH };
const reading = (state: McpHealthReading["state"], startedAt = LAUNCH + 3000): McpHealthReading => ({ state, startedAt });

describe("healthLaunchAt — which prep records the health rule may speak for", () => {
  it("a prepared launch, or one it already marked dropped", () => {
    expect(healthLaunchAt(ok)).toBe(LAUNCH);
    expect(healthLaunchAt(dropped)).toBe(LAUNCH);
  });
  it("never a real prep failure, an outside conversation, or a record with no launch time", () => {
    expect(healthLaunchAt({ prepared: false, reason: "mcp dir unwritable" })).toBeNull();
    expect(healthLaunchAt({ prepared: false, reason: "started outside Switchboard" })).toBeNull();
    expect(healthLaunchAt({ prepared: true })).toBeNull();
    expect(healthLaunchAt(undefined)).toBeNull();
  });
});

describe("nextToolsVerdict — the chip only after 30s of THIS launch's server gone", () => {
  it("alive keeps a prepared launch and clears the watch", () => {
    const v = nextToolsVerdict(ok, LAUNCH, reading("alive"), { badSince: 5 }, LAUNCH + 60_000);
    expect(v).toEqual({ kind: "keep", watch: { badSince: null } });
  });

  it("gone or ended must last DROP_AFTER_MS before it says dropped", () => {
    const t0 = LAUNCH + 60_000;
    let v = nextToolsVerdict(ok, LAUNCH, reading("gone"), { badSince: null }, t0);
    expect(v).toEqual({ kind: "keep", watch: { badSince: t0 } });
    v = nextToolsVerdict(ok, LAUNCH, reading("ended"), v.watch, t0 + DROP_AFTER_MS - 1);
    expect(v.kind).toBe("keep");
    v = nextToolsVerdict(ok, LAUNCH, reading("gone"), v.watch, t0 + DROP_AFTER_MS);
    expect(v.kind).toBe("dropped");
  });

  it("a blip that recovers inside the window never chips (a /mcp reconnect)", () => {
    const t0 = LAUNCH + 60_000;
    let v = nextToolsVerdict(ok, LAUNCH, reading("ended"), { badSince: null }, t0);
    v = nextToolsVerdict(ok, LAUNCH, reading("alive", t0 + 1000), v.watch, t0 + 5000);
    expect(v).toEqual({ kind: "keep", watch: { badSince: null } });
    v = nextToolsVerdict(ok, LAUNCH, reading("gone"), v.watch, t0 + DROP_AFTER_MS + 1);
    expect(v.kind).toBe("keep"); // the clock started over
  });

  it("a record from the PREVIOUS launch's server says nothing", () => {
    const old = reading("ended", LAUNCH - LAUNCH_SKEW_MS - 1);
    const v = nextToolsVerdict(ok, LAUNCH, old, { badSince: LAUNCH }, LAUNCH + 10 * DROP_AFTER_MS);
    expect(v).toEqual({ kind: "keep", watch: { badSince: null } });
  });

  it("no record is no claim", () => {
    const v = nextToolsVerdict(ok, LAUNCH, { state: "none", startedAt: 0 }, { badSince: LAUNCH }, LAUNCH + 10 * DROP_AFTER_MS);
    expect(v.kind).toBe("keep");
  });

  it("a dropped launch recovers when its server is back, and does not re-drop while still gone", () => {
    expect(nextToolsVerdict(dropped, LAUNCH, reading("alive"), { badSince: LAUNCH }, LAUNCH + 99_000).kind).toBe("recovered");
    expect(nextToolsVerdict(dropped, LAUNCH, reading("gone"), { badSince: LAUNCH }, LAUNCH + 99_000).kind).toBe("keep");
  });
});
