// Pins store tests — the SHARING and LIFETIME rules, not the file format
// (pins.test.ts owns that; this store consumes those pure ops unchanged).
//
// The bug this suite exists for: the artifact panel and the keep-alive KB
// screen can hold the same wireframe MOUNTED at the same time. Two private
// copies of one `.pins.json` meant the later writer clobbered the other's
// pins with no error. Every "mount" below is a `subscribeToPins` reference —
// the same call React's useSyncExternalStore makes — so two mounts here are
// exactly two mounted WireframeViews.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  configurePinsIO,
  getPinsFile,
  subscribeToPins,
  mutatePins,
  flushPins,
  hasPendingWrite,
  hasInFlightWrite,
  usePinsFile,
  PINS_WRITE_DEBOUNCE_MS,
  __resetPinsStoreForTests,
  type PinsIO,
} from "./pinsStore";
import { addPin, createPin, removePin, updatePinNote, serializePinsFile } from "./pins";
import type { PinsFile } from "./pins";

const SIDECAR = "switchboard/features/artifact-panel/.pins.json";
const DOC = "workstation-shell.html";

function pin(id: string, note = ""): ReturnType<typeof createPin> {
  return createPin({ doc: DOC, xPct: 10, yPct: 20, note }, id, "2026-08-02T00:00:00.000Z");
}

function fileWith(...ids: string[]): string {
  let file: PinsFile = { version: 1, pins: [] };
  for (const id of ids) file = addPin(file, pin(id));
  return serializePinsFile(file);
}

function idsIn(file: PinsFile | null): string[] {
  return (file?.pins ?? []).map((p) => p.id);
}

/** Records every write so "exactly once" and "coalesced" are assertable. */
type Recorder = { io: PinsIO; writes: Array<{ path: string; text: string }>; reads: string[] };

function recorder(contents: Record<string, string> = {}): Recorder {
  const writes: Array<{ path: string; text: string }> = [];
  const reads: string[] = [];
  return {
    writes,
    reads,
    io: {
      read: (path) => {
        reads.push(path);
        const text = contents[path];
        return text === undefined
          ? Promise.reject(new Error("no such file")) // kb_read_doc errors on missing
          : Promise.resolve(text);
      },
      write: (path, text) => {
        writes.push({ path, text });
        contents[path] = text;
        return Promise.resolve();
      },
    },
  };
}

/** Let the injected IO's already-resolved promises settle. */
function settle(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

let rec: Recorder;

beforeEach(() => {
  __resetPinsStoreForTests();
  vi.useFakeTimers();
  rec = recorder({ [SIDECAR]: fileWith("p1", "p2", "p3") });
  configurePinsIO(rec.io);
});

afterEach(() => {
  vi.useRealTimers();
  __resetPinsStoreForTests();
});

// ─── Sharing (the data-loss bug) ─────────────────────────────────────────────

describe("two mounts of the same sidecar", () => {
  it("read it ONCE and share one record", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    const b = subscribeToPins(SIDECAR, () => {});
    await settle();
    expect(rec.reads).toEqual([SIDECAR]);
    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1", "p2", "p3"]);
    a();
    b();
  });

  it("CONVERGE — the recorded clobber repro loses nothing now", async () => {
    // Panel mount + KB-screen mount, both live (display:none is not unmount).
    const panelSeen: Array<string[]> = [];
    const screenSeen: Array<string[]> = [];
    const panel = subscribeToPins(SIDECAR, () => panelSeen.push(idsIn(getPinsFile(SIDECAR))));
    const screen = subscribeToPins(SIDECAR, () => screenSeen.push(idsIn(getPinsFile(SIDECAR))));
    await settle();

    // Pin 4 placed in the PANEL.
    mutatePins(SIDECAR, (f) => addPin(f, pin("p4")));
    // …and pin 5 placed on the KB SCREEN, which under the old code still held
    // a stale [p1,p2,p3] and would have written exactly that plus p5.
    mutatePins(SIDECAR, (f) => addPin(f, pin("p5")));

    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    // BOTH mounts were told about BOTH edits (3 notifications each: the load,
    // then p4, then p5) — no stale copy exists for either to write from.
    expect(panelSeen).toHaveLength(3);
    expect(screenSeen).toHaveLength(3);
    expect(panelSeen[2]).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(screenSeen[2]).toEqual(["p1", "p2", "p3", "p4", "p5"]);

    vi.advanceTimersByTime(PINS_WRITE_DEBOUNCE_MS);
    expect(rec.writes).toHaveLength(1);
    expect(idsIn(JSON.parse(rec.writes[0].text) as PinsFile)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
    ]);
    panel();
    screen();
  });

  it("delete in one mount, add in the other — the delete is not resurrected", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    const b = subscribeToPins(SIDECAR, () => {});
    await settle();

    mutatePins(SIDECAR, (f) => removePin(f, "p2")); // mount A deletes
    mutatePins(SIDECAR, (f) => addPin(f, pin("p4"))); // mount B adds

    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1", "p3", "p4"]);
    vi.advanceTimersByTime(PINS_WRITE_DEBOUNCE_MS);
    expect(idsIn(JSON.parse(rec.writes[0].text) as PinsFile)).toEqual(["p1", "p3", "p4"]);
    a();
    b();
  });

  it("note edits from either mount land on the same record", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    const b = subscribeToPins(SIDECAR, () => {});
    await settle();
    mutatePins(SIDECAR, (f) => updatePinNote(f, "p1", "menu feels wide"));
    mutatePins(SIDECAR, (f) => updatePinNote(f, "p3", "CTA below the fold"));
    const notes = (getPinsFile(SIDECAR)?.pins ?? []).map((p) => p.note);
    expect(notes).toEqual(["menu feels wide", "", "CTA below the fold"]);
    a();
    b();
  });

  it("different sidecars stay completely independent", async () => {
    const other = "other/folder/.pins.json";
    rec = recorder({ [SIDECAR]: fileWith("p1"), [other]: fileWith("q1") });
    configurePinsIO(rec.io);
    const a = subscribeToPins(SIDECAR, () => {});
    const b = subscribeToPins(other, () => {});
    await settle();
    mutatePins(SIDECAR, (f) => addPin(f, pin("p2")));
    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1", "p2"]);
    expect(idsIn(getPinsFile(other))).toEqual(["q1"]);
    a();
    b();
  });

  it("a load resolving AFTER a mutation never clobbers it", async () => {
    // Slow read: the user places a pin before the sidecar comes back.
    let release: (text: string) => void = () => {};
    configurePinsIO({
      read: () => new Promise<string>((res) => (release = res)),
      write: () => Promise.resolve(),
    });
    const a = subscribeToPins(SIDECAR, () => {});
    // Nothing loaded yet → mutation is a no-op (the UI disables pinning here).
    mutatePins(SIDECAR, (f) => addPin(f, pin("early")));
    expect(getPinsFile(SIDECAR)).toBeNull();
    release(fileWith("p1"));
    await settle();
    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1"]);
    a();
  });
});

// ─── Write scheduling ────────────────────────────────────────────────────────

describe("debounced write (ONE writer per sidecar)", () => {
  it("coalesces a burst into a single write", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    await settle();
    for (const id of ["p4", "p5", "p6"]) {
      mutatePins(SIDECAR, (f) => addPin(f, pin(id)));
      vi.advanceTimersByTime(PINS_WRITE_DEBOUNCE_MS - 50); // keeps resetting
    }
    expect(rec.writes).toHaveLength(0);
    vi.advanceTimersByTime(PINS_WRITE_DEBOUNCE_MS);
    expect(rec.writes).toHaveLength(1);
    expect(idsIn(JSON.parse(rec.writes[0].text) as PinsFile)).toHaveLength(6);
    a();
  });

  it("coalesces across MOUNTS too — two mounts do not write twice", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    const b = subscribeToPins(SIDECAR, () => {});
    await settle();
    mutatePins(SIDECAR, (f) => addPin(f, pin("p4")));
    mutatePins(SIDECAR, (f) => addPin(f, pin("p5")));
    vi.advanceTimersByTime(PINS_WRITE_DEBOUNCE_MS);
    expect(rec.writes).toHaveLength(1);
    a();
    b();
    expect(rec.writes).toHaveLength(1); // releases owe nothing
  });

  it("a no-op edit schedules nothing (pins.ts signals it by identity)", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    await settle();
    mutatePins(SIDECAR, (f) => removePin(f, "nope")); // id not present
    mutatePins(SIDECAR, (f) => updatePinNote(f, "p1", "")); // already empty
    expect(hasPendingWrite(SIDECAR)).toBe(false);
    vi.advanceTimersByTime(PINS_WRITE_DEBOUNCE_MS * 2);
    expect(rec.writes).toHaveLength(0);
    a();
  });

  it("the write is the serialized SHARED record, git-shaped", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    await settle();
    mutatePins(SIDECAR, (f) => addPin(f, pin("p4")));
    vi.advanceTimersByTime(PINS_WRITE_DEBOUNCE_MS);
    expect(rec.writes[0].path).toBe(SIDECAR);
    expect(rec.writes[0].text.endsWith("\n")).toBe(true);
    expect(rec.writes[0].text).toBe(serializePinsFile(getPinsFile(SIDECAR) as PinsFile));
    a();
  });
});

describe("unmount with a pending write", () => {
  it("the LAST release flushes it exactly once", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    const b = subscribeToPins(SIDECAR, () => {});
    await settle();
    mutatePins(SIDECAR, (f) => addPin(f, pin("p4")));

    a(); // one mount left — the timer keeps running, nothing written yet
    expect(rec.writes).toHaveLength(0);
    expect(hasPendingWrite(SIDECAR)).toBe(true);

    b(); // last one out → flush now
    expect(rec.writes).toHaveLength(1);
    expect(hasPendingWrite(SIDECAR)).toBe(false);

    // The cancelled timer must not fire a SECOND write.
    vi.advanceTimersByTime(PINS_WRITE_DEBOUNCE_MS * 2);
    expect(rec.writes).toHaveLength(1);
  });

  it("a release with nothing owed writes nothing", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    await settle();
    a();
    vi.advanceTimersByTime(PINS_WRITE_DEBOUNCE_MS * 2);
    expect(rec.writes).toHaveLength(0);
  });

  it("timer-fire then release also writes exactly once", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    await settle();
    mutatePins(SIDECAR, (f) => addPin(f, pin("p4")));
    vi.advanceTimersByTime(PINS_WRITE_DEBOUNCE_MS);
    expect(rec.writes).toHaveLength(1);
    a();
    expect(rec.writes).toHaveLength(1);
  });

  it("explicit flushPins is idempotent", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    await settle();
    mutatePins(SIDECAR, (f) => addPin(f, pin("p4")));
    flushPins(SIDECAR);
    flushPins(SIDECAR);
    expect(rec.writes).toHaveLength(1);
    a();
  });

  it("flushing an unknown sidecar is harmless", () => {
    expect(() => flushPins("never/seen/.pins.json")).not.toThrow();
    expect(rec.writes).toHaveLength(0);
  });
});

// ─── Load lifecycle ──────────────────────────────────────────────────────────

describe("load lifecycle", () => {
  it("a missing sidecar starts as an empty v1 file", async () => {
    const empty = "brand/new/.pins.json";
    const a = subscribeToPins(empty, () => {});
    await settle();
    expect(getPinsFile(empty)).toEqual({ version: 1, pins: [] });
    a();
  });

  it("re-mounting an IDLE record re-reads (hand-edits / agent edits land)", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    await settle();
    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1", "p2", "p3"]);
    a();

    // Something outside the app rewrote the sidecar.
    rec.io.write(SIDECAR, fileWith("z1"));
    const b = subscribeToPins(SIDECAR, () => {});
    await settle();
    expect(rec.reads).toEqual([SIDECAR, SIDECAR]);
    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["z1"]);
    b();
  });

  it("a mount arriving while one is already live does NOT re-read", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    await settle();
    mutatePins(SIDECAR, (f) => addPin(f, pin("p4")));
    const b = subscribeToPins(SIDECAR, () => {});
    await settle();
    expect(rec.reads).toEqual([SIDECAR]);
    // …and the unflushed edit is still there for the newcomer to see.
    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1", "p2", "p3", "p4"]);
    a();
    b();
  });

  it("getPinsFile does not create a record or start IO", () => {
    expect(getPinsFile("untouched/.pins.json")).toBeNull();
    expect(rec.reads).toHaveLength(0);
  });

  it("the snapshot reference is stable between changes (useSyncExternalStore)", async () => {
    const a = subscribeToPins(SIDECAR, () => {});
    await settle();
    const first = getPinsFile(SIDECAR);
    expect(getPinsFile(SIDECAR)).toBe(first);
    mutatePins(SIDECAR, (f) => addPin(f, pin("p4")));
    const second = getPinsFile(SIDECAR);
    expect(second).not.toBe(first);
    expect(getPinsFile(SIDECAR)).toBe(second);
    a();
  });

  it("mutating an unknown sidecar is a no-op", () => {
    expect(() => mutatePins("nope/.pins.json", (f) => addPin(f, pin("x")))).not.toThrow();
    expect(getPinsFile("nope/.pins.json")).toBeNull();
  });

  it("unconfigured IO stays INERT and retries on the next mount", async () => {
    __resetPinsStoreForTests(); // clears the injected IO too
    const a = subscribeToPins(SIDECAR, () => {});
    await settle();
    // No empty file was invented over a real sidecar we could not read.
    expect(getPinsFile(SIDECAR)).toBeNull();
    a();

    const live = recorder({ [SIDECAR]: fileWith("p1") });
    configurePinsIO(live.io);
    const b = subscribeToPins(SIDECAR, () => {});
    await settle();
    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1"]);
    b();
  });

  it("exports the hook the views consume", () => {
    expect(typeof usePinsFile).toBe("function");
  });
});

// ─── Ordering: flush → re-read must never serve pre-write content ────────────
// The REAL mount lifecycle on increment B's headline path. Two wireframes in
// ONE folder share a sidecar; switching between their panel TABS unmounts one
// WireframeView and mounts the other in a single commit — React destroys
// BEFORE it creates. So:
//
//   release → mounts 1→0 → pending → flushEntry issues a write
//           → subscribe → wasIdle → loadStarted=false → ensureLoaded reads
//
// No mutation happens between the two, so `mutations !== at` cannot save it,
// and kb_read_doc / kb_write_doc are independent async tokio commands with no
// ordering guarantee (the write does strictly more work — create_dir_all). If
// the read is served first, the just-placed pin is overwritten in memory and
// the NEXT edit persists that loss.
//
// The IO below forces exactly that ordering: the write is held open while the
// read resolves instantly against still-stale disk contents.

describe("a tab switch that flushes and immediately re-reads", () => {
  /** IO whose write is held until `land()` is called, and whose read always
   *  resolves IMMEDIATELY from whatever is on "disk" right now. */
  function racingIO(initial: string) {
    let disk = initial;
    const order: string[] = [];
    let land: () => void = () => {};
    const landed = new Promise<void>((resolve) => {
      land = resolve;
    });
    const io: PinsIO = {
      read: async () => {
        order.push("read");
        return disk;
      },
      write: async (_path, text) => {
        order.push("write-issued");
        await landed;
        disk = text;
        order.push("write-landed");
      },
    };
    return { io, order, land: () => land(), disk: () => disk };
  }

  it("does NOT clobber the in-memory record with pre-write disk content", async () => {
    const race = racingIO(fileWith("p1", "p2", "p3"));
    configurePinsIO(race.io);

    // Tab A mounts and loads.
    const releaseA = subscribeToPins(SIDECAR, () => {});
    await settle();
    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1", "p2", "p3"]);

    // A pin is placed on tab A's wireframe.
    mutatePins(SIDECAR, (f) => addPin(f, pin("p4")));
    expect(hasPendingWrite(SIDECAR)).toBe(true);

    // THE SWITCH, in one commit: A unmounts (flushing the write) …
    releaseA();
    expect(hasPendingWrite(SIDECAR)).toBe(false);
    expect(hasInFlightWrite(SIDECAR)).toBe(true);
    // … and B mounts, which re-reads because the record went idle.
    const releaseB = subscribeToPins(SIDECAR, () => {});

    // Let every already-resolvable promise run. The read is GATED behind the
    // unacknowledged write, so it has not even been issued — and p4 survives.
    await settle();
    await settle();
    await settle();
    // THE assertion: p4 is still there. Without the gate the read lands here
    // with stale disk contents and silently drops it.
    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1", "p2", "p3", "p4"]);
    expect(race.order).toEqual(["read", "write-issued"]); // no second read yet

    // Now let the write land; the gated read follows and agrees with it.
    race.land();
    await settle();
    await settle();
    await settle();
    expect(race.order).toEqual(["read", "write-issued", "write-landed", "read"]);
    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1", "p2", "p3", "p4"]);
    // …and the pin is on disk, not just in memory.
    expect(idsIn(JSON.parse(race.disk()))).toEqual(["p1", "p2", "p3", "p4"]);
    releaseB();
  });

  it("still re-reads external edits when no write is owed", async () => {
    // The gate must not disable the idle re-read — an agent or a rebase can
    // change the sidecar while the app runs, and that is why it exists.
    const race = racingIO(fileWith("p1"));
    configurePinsIO(race.io);
    const a = subscribeToPins(SIDECAR, () => {});
    await settle();
    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1"]);
    a(); // nothing owed — no write issued

    expect(hasInFlightWrite(SIDECAR)).toBe(false);
    const b = subscribeToPins(SIDECAR, () => {});
    await settle();
    expect(race.order).toEqual(["read", "read"]); // issued straight away
    b();
  });

  it("a mutation DURING the gated read still wins (mutations guard holds)", async () => {
    const race = racingIO(fileWith("p1"));
    configurePinsIO(race.io);
    const a = subscribeToPins(SIDECAR, () => {});
    await settle();
    mutatePins(SIDECAR, (f) => addPin(f, pin("p2")));
    a(); // flush → write in flight

    const b = subscribeToPins(SIDECAR, () => {}); // read gated
    mutatePins(SIDECAR, (f) => addPin(f, pin("p3"))); // local edit meanwhile
    race.land();
    await settle();
    await settle();
    await settle();
    // The read resolved against [p1,p2] and was DISCARDED — p3 is newer.
    expect(idsIn(getPinsFile(SIDECAR))).toEqual(["p1", "p2", "p3"]);
    b();
  });
});
