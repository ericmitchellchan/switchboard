// Surface pins (SWIT-36): the sidecar target, the record shape, and the
// tolerant reads — all pure, all through the same parse/serialize the other
// pin kinds use, so a surface pin survives a hand-edit round-trip.

import { describe, it, expect } from "vitest";
import {
  SURFACE_PINS_NAME,
  addPin,
  createSurfacePin,
  emptyPinsFile,
  mergeForeignPins,
  parsePinsFile,
  pinsForDoc,
  serializePinsFile,
  splitPinRefs,
  surfacePinAnchor,
  surfacePinLabel,
  surfacePinOrigin,
  surfacePinTargetFor,
} from "./pins";
import type { Pin } from "./pins";

const trading = { kind: "surface" as const, project: "lodestar", page: "trading" };

describe("surfacePinTargetFor", () => {
  it("files under <project>/surface-pins.json keyed by the page id", () => {
    expect(surfacePinTargetFor(trading)).toEqual({
      sidecarPath: `lodestar/${SURFACE_PINS_NAME}`,
      docKey: "trading",
    });
  });

  it("normalizes a pathological project key rather than escaping the mirror", () => {
    expect(surfacePinTargetFor({ ...trading, project: "..\\..\\evil" }).sidecarPath).toBe(
      `evil/${SURFACE_PINS_NAME}`
    );
  });
});

describe("createSurfacePin", () => {
  it("records the anchor in the known field, the label as an extra, and the centre percentages", () => {
    const pin = createSurfacePin(
      { page: "trading", anchor: "trade:t1", anchorLabel: "NQ long 10:02", xPct: 12.5, yPct: 40, note: "hm" },
      "p1",
      "2026-08-27T00:00:00Z"
    );
    expect(pin).toEqual({
      id: "p1",
      doc: "trading",
      xPct: 12.5,
      yPct: 40,
      anchor: "trade:t1",
      anchorLabel: "NQ long 10:02",
      note: "hm",
      createdAt: "2026-08-27T00:00:00Z",
    });
    expect(surfacePinOrigin(pin)).toBe("user");
  });

  it("marks an agent-dropped pin", () => {
    const pin = createSurfacePin({ page: "trading", anchor: "bar:1", anchorLabel: "bar", xPct: 0, yPct: 0, origin: "thread" }, "p2");
    expect(pin.origin).toBe("thread");
    expect(surfacePinOrigin(pin)).toBe("thread");
  });
});

describe("surface pin round-trip + reads", () => {
  it("survives serialize → parse with anchor, label and origin intact", () => {
    const pin = createSurfacePin({ page: "trading", anchor: "row:setup:NQ long", anchorLabel: "setup · NQ long", xPct: 1, yPct: 2, origin: "thread" }, "p3", "t");
    const file = addPin(emptyPinsFile(), pin);
    const back = parsePinsFile(serializePinsFile(file));
    const [read] = pinsForDoc(back, "trading");
    expect(surfacePinAnchor(read)).toBe("row:setup:NQ long");
    expect(surfacePinLabel(read)).toBe("setup · NQ long");
    expect(surfacePinOrigin(read)).toBe("thread");
    expect(pinsForDoc(back, "markets")).toEqual([]);
  });

  it("tolerates hand-edits: missing label falls back to the key; a wrong-typed anchor reads as none", () => {
    const noLabel: Pin = { id: "a", doc: "trading", xPct: 0, yPct: 0, anchor: "tile:net", note: "", createdAt: "" };
    expect(surfacePinLabel(noLabel)).toBe("tile:net");
    const parsed = parsePinsFile(JSON.stringify({ version: 1, pins: [{ id: "b", doc: "trading", xPct: 0, yPct: 0, anchor: 42 }] }));
    expect(surfacePinAnchor(parsed.pins[0])).toBeNull();
    expect(surfacePinLabel(parsed.pins[0])).toBe("");
    expect(surfacePinOrigin({ ...noLabel, origin: "martian" })).toBe("user");
  });
});

describe("splitPinRefs (note cross-references, 3d)", () => {
  it("splits #n references out of a note, keeping the text around them", () => {
    expect(splitPinRefs("see #2 and #10 — not #0, not #x")).toEqual([
      { text: "see " },
      { ref: 2 },
      { text: " and " },
      { ref: 10 },
      { text: " — not #0, not #x" },
    ]);
  });

  it("a note with no references is one text segment; an empty note is none", () => {
    expect(splitPinRefs("plain")).toEqual([{ text: "plain" }]);
    expect(splitPinRefs("")).toEqual([]);
  });

  it("a reference at either end has no empty neighbours", () => {
    expect(splitPinRefs("#1")).toEqual([{ ref: 1 }]);
    expect(splitPinRefs("#1 x #2")).toEqual([{ ref: 1 }, { text: " x " }, { ref: 2 }]);
  });
});

describe("mergeForeignPins (write-side merge, 3d)", () => {
  const p = (id: string) => createSurfacePin({ page: "trading", anchor: `trade:${id}`, anchorLabel: id, xPct: 0, yPct: 0 }, id, "t");
  const file = (...ids: string[]) => ({ version: 1 as const, pins: ids.map(p) });

  it("keeps a pin the agent added on disk since the last read (appended after ours)", () => {
    const local = file("a", "mine");
    const disk = file("a", "agent");
    const out = mergeForeignPins(local, disk, new Set(["a"]));
    expect(out.pins.map((x) => x.id)).toEqual(["a", "mine", "agent"]);
  });

  it("drops a pin we deleted locally even though disk still has it", () => {
    const local = file("a");
    const disk = file("a", "b");
    expect(mergeForeignPins(local, disk, new Set(["a", "b"])).pins.map((x) => x.id)).toEqual(["a"]);
  });

  it("returns the local file itself when nothing foreign exists", () => {
    const local = file("a", "b");
    expect(mergeForeignPins(local, file("a"), new Set(["a"]))).toBe(local);
    expect(mergeForeignPins(local, file("a", "b"), new Set(["a", "b"]))).toBe(local);
  });

  it("a local edit of a pin wins over a concurrent foreign edit of the same pin", () => {
    const local = { version: 1 as const, pins: [{ ...p("a"), note: "mine" }] };
    const disk = { version: 1 as const, pins: [{ ...p("a"), note: "theirs" }] };
    expect(mergeForeignPins(local, disk, new Set(["a"])).pins[0].note).toBe("mine");
  });
});
