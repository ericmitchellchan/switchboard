// Pins module tests (T7) — sidecar pathing, the TOLERANT parse contract
// (hand-edits survive round-trips; broken JSON degrades to empty v1), the
// pure pin ops, and the wireframe-view helpers (zoom clamp, iframe message
// validation). WireframeView itself is a thin shell over these.

import { describe, it, expect } from "vitest";
import {
  SIDECAR_NAME,
  WIREFRAME_MSG_SOURCE,
  ZOOM_MAX,
  ZOOM_MIN,
  addPin,
  clampZoom,
  createPin,
  docFileName,
  emptyPinsFile,
  parsePinsFile,
  parseWireframeMessage,
  pinTargetFor,
  pinsForDoc,
  LIVE_PINS_NAME,
  createLivePin,
  livePinTargetFor,
  livePinViewport,
  routeScopeOf,
  removePin,
  REPO_PINS_ROOT,
  serializePinsFile,
  sidecarPathFor,
  updatePinNote,
  zoomAfterWheel,
  zoomStorageKey,
} from "./pins";
import type { Pin, PinsFile } from "./pins";

function pin(overrides: Partial<Pin> = {}): Pin {
  return {
    id: "p1",
    doc: "shell.html",
    xPct: 25,
    yPct: 50,
    note: "a note",
    createdAt: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
}

describe("sidecarPathFor / docFileName", () => {
  it("puts the sidecar in the same folder as the doc", () => {
    expect(sidecarPathFor("switchboard/features/pw/wireframes/shell.html")).toBe(
      "switchboard/features/pw/wireframes/.pins.json"
    );
    expect(sidecarPathFor("a/b.html")).toBe("a/.pins.json");
  });

  it("root-level docs get a root-level sidecar", () => {
    expect(sidecarPathFor("shell.html")).toBe(SIDECAR_NAME);
  });

  it("docFileName returns the last segment", () => {
    expect(docFileName("a/b/shell.html")).toBe("shell.html");
    expect(docFileName("shell.html")).toBe("shell.html");
  });
});

describe("pinTargetFor — KB sidecar vs repo mirror", () => {
  it("keeps a KB doc's pins in the sidecar NEXT TO it (unchanged behaviour)", () => {
    expect(pinTargetFor({ kind: "kb-doc", path: "switchboard/wireframes/shell.html" })).toEqual({
      sidecarPath: "switchboard/wireframes/.pins.json",
      docKey: "shell.html",
    });
    expect(pinTargetFor({ kind: "kb-doc", path: "shell.html" })).toEqual({
      sidecarPath: SIDECAR_NAME,
      docKey: "shell.html",
    });
  });

  it("mirrors a repo file's pins into the hidden KB tree", () => {
    // Eric's case: lodestar / specs / mockups / cases-compact-v1.html
    expect(
      pinTargetFor({
        kind: "repo-file",
        project: "lodestar",
        path: "specs/mockups/cases-compact-v1.html",
      })
    ).toEqual({
      sidecarPath: `${REPO_PINS_ROOT}/lodestar/specs/mockups/.pins.json`,
      docKey: "cases-compact-v1.html",
    });
  });

  it("mirrors a repo-ROOT file into the project's own mirror folder", () => {
    expect(pinTargetFor({ kind: "repo-file", project: "orbit", path: "index.html" })).toEqual({
      sidecarPath: `${REPO_PINS_ROOT}/orbit/.pins.json`,
      docKey: "index.html",
    });
  });

  it("hides every mirrored sidecar from the KB tree (leading `_` segment)", () => {
    // kb.rs skip_dir and buildKbTree both drop `_`-prefixed segments, which is
    // what keeps `<file>.pins.json` mirrors out of the doc list.
    const { sidecarPath } = pinTargetFor({ kind: "repo-file", project: "p", path: "a/b.html" });
    expect(sidecarPath.split("/")[0].startsWith("_")).toBe(true);
  });

  it("is collision-free across projects and repos within a project", () => {
    const a = pinTargetFor({ kind: "repo-file", project: "orbit", path: "docs/x.html" });
    const b = pinTargetFor({ kind: "repo-file", project: "lodestar", path: "docs/x.html" });
    expect(a.sidecarPath).not.toBe(b.sidecarPath);
    // multi-repo projects carry the repo name as the first path component
    const r1 = pinTargetFor({ kind: "repo-file", project: "cr", path: "mcp/w.html" });
    const r2 = pinTargetFor({ kind: "repo-file", project: "cr", path: "web/w.html" });
    expect(r1.sidecarPath).not.toBe(r2.sidecarPath);
  });

  it("is reversible — strip the root, first segment is the project", () => {
    const { sidecarPath } = pinTargetFor({
      kind: "repo-file",
      project: "lodestar",
      path: "specs/mockups/cases-compact-v1.html",
    });
    const rest = sidecarPath.slice(`${REPO_PINS_ROOT}/`.length).split("/");
    expect(rest[0]).toBe("lodestar");
    expect(rest.slice(1, -1).join("/")).toBe("specs/mockups");
  });

  it("normalizes separators and drops components the KB write guard rejects", () => {
    expect(
      pinTargetFor({ kind: "repo-file", project: "p", path: "a\\b\\c.html" }).sidecarPath
    ).toBe(`${REPO_PINS_ROOT}/p/a/b/.pins.json`);
    // `..`, `.`, empty and `:`-bearing components can never reach the joined
    // path — a traversal attempt degrades to a shorter mirror path, never to a
    // write outside the mirror tree.
    const escaped = pinTargetFor({ kind: "repo-file", project: "p", path: "../../x/y.html" });
    expect(escaped.sidecarPath).toBe(`${REPO_PINS_ROOT}/p/x/.pins.json`);
    expect(escaped.sidecarPath).not.toContain("..");
    expect(
      pinTargetFor({ kind: "repo-file", project: "p", path: "a/b.html:ads" }).sidecarPath
    ).not.toContain(":");
  });
});

describe("parsePinsFile — tolerant parse", () => {
  it("parses a well-formed v1 file", () => {
    const file = parsePinsFile(
      JSON.stringify({ version: 1, pins: [pin(), pin({ id: "p2", doc: "other.html" })] })
    );
    expect(file.version).toBe(1);
    expect(file.pins).toHaveLength(2);
    expect(file.pins[0]).toMatchObject({ id: "p1", doc: "shell.html", xPct: 25, yPct: 50 });
  });

  it("invalid JSON → empty v1", () => {
    expect(parsePinsFile("not json {")).toEqual({ version: 1, pins: [] });
    expect(parsePinsFile("")).toEqual({ version: 1, pins: [] });
  });

  it("non-object roots → empty v1", () => {
    expect(parsePinsFile("[1,2,3]")).toEqual({ version: 1, pins: [] });
    expect(parsePinsFile("null")).toEqual({ version: 1, pins: [] });
    expect(parsePinsFile('"str"')).toEqual({ version: 1, pins: [] });
  });

  it("missing/non-array pins → empty pins, other fields kept", () => {
    const file = parsePinsFile('{"custom": "kept", "pins": "oops"}');
    expect(file.pins).toEqual([]);
    expect(file.custom).toBe("kept");
    expect(file.version).toBe(1);
  });

  it("drops individually-invalid pin entries without eating the rest", () => {
    const file = parsePinsFile(
      JSON.stringify({
        version: 1,
        pins: [
          pin(),
          { id: "", doc: "shell.html", xPct: 1, yPct: 1 }, // empty id
          { doc: "shell.html", xPct: 1, yPct: 1 }, // missing id
          { id: "x", xPct: 1, yPct: 1 }, // missing doc
          { id: "y", doc: "shell.html", xPct: "5", yPct: 1 }, // non-numeric
          { id: "z", doc: "shell.html", xPct: NaN, yPct: 1 }, // non-finite
          "not an object",
          pin({ id: "p2" }),
        ],
      })
    );
    expect(file.pins.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("defaults missing note/createdAt and keeps anchor only when a string", () => {
    const file = parsePinsFile(
      JSON.stringify({
        version: 1,
        pins: [
          { id: "a", doc: "d.html", xPct: 1, yPct: 2 },
          { id: "b", doc: "d.html", xPct: 1, yPct: 2, anchor: 42 },
          { id: "c", doc: "d.html", xPct: 1, yPct: 2, anchor: "#hero" },
        ],
      })
    );
    expect(file.pins[0].note).toBe("");
    expect(file.pins[0].createdAt).toBe("");
    expect("anchor" in file.pins[1]).toBe(false);
    expect(file.pins[2].anchor).toBe("#hero");
  });

  it("normalizes a hand-edited version field back to 1", () => {
    const file = parsePinsFile('{"version": 99, "pins": []}');
    expect(file.version).toBe(1);
  });
});

describe("round-trip preservation (hand-edits survive)", () => {
  it("preserves unknown top-level AND per-pin fields", () => {
    const original = {
      version: 1,
      generator: "hand-edit",
      pins: [{ ...pin(), color: "red", tags: ["ui", "spacing"] }],
    };
    const roundTripped = parsePinsFile(serializePinsFile(parsePinsFile(JSON.stringify(original))));
    expect(roundTripped.generator).toBe("hand-edit");
    expect(roundTripped.pins[0].color).toBe("red");
    expect(roundTripped.pins[0].tags).toEqual(["ui", "spacing"]);
    expect(roundTripped.pins[0]).toMatchObject(pin());
  });

  it("serializes with 2-space indent and a trailing newline", () => {
    const text = serializePinsFile(emptyPinsFile());
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('  "version": 1');
    expect(parsePinsFile(text)).toEqual({ version: 1, pins: [] });
  });
});

describe("pure ops", () => {
  it("addPin appends without mutating the input", () => {
    const before = emptyPinsFile();
    const after = addPin(before, pin());
    expect(before.pins).toHaveLength(0);
    expect(after.pins).toEqual([pin()]);
  });

  it("removePin drops by id, keeps order, no-ops (identity) on unknown id", () => {
    const file: PinsFile = { version: 1, pins: [pin(), pin({ id: "p2" }), pin({ id: "p3" })] };
    const after = removePin(file, "p2");
    expect(after.pins.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(file.pins).toHaveLength(3);
    expect(removePin(file, "nope")).toBe(file);
  });

  it("updatePinNote replaces only the target's note; identity when unchanged", () => {
    const file: PinsFile = { version: 1, pins: [pin(), pin({ id: "p2", color: "red" } as Partial<Pin>)] };
    const after = updatePinNote(file, "p2", "new text");
    expect(after.pins[1].note).toBe("new text");
    expect(after.pins[1].color).toBe("red"); // extras preserved
    expect(after.pins[0]).toBe(file.pins[0]); // untouched pin keeps identity
    expect(updatePinNote(file, "p2", "a note")).toBe(file); // same note → no-op
    expect(updatePinNote(file, "missing", "x")).toBe(file);
  });

  it("pinsForDoc filters by doc in file order (display numbers = indexes)", () => {
    const file: PinsFile = {
      version: 1,
      pins: [pin(), pin({ id: "p2", doc: "other.html" }), pin({ id: "p3" })],
    };
    expect(pinsForDoc(file, "shell.html").map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(pinsForDoc(file, "missing.html")).toEqual([]);
  });

  it("createPin fills id/createdAt and omits an empty anchor", () => {
    const p = createPin({ doc: "shell.html", xPct: 10, yPct: 20 }, "fixed-id", "2026-07-31T00:00:00Z");
    expect(p).toEqual({
      id: "fixed-id",
      doc: "shell.html",
      xPct: 10,
      yPct: 20,
      note: "",
      createdAt: "2026-07-31T00:00:00Z",
    });
    const withAnchor = createPin({ doc: "d", xPct: 0, yPct: 0, anchor: "#hero" });
    expect(withAnchor.anchor).toBe("#hero");
    expect(withAnchor.id).not.toBe("");
    const auto = createPin({ doc: "d", xPct: 0, yPct: 0 });
    expect(auto.id).not.toBe(withAnchor.id); // ids are unique
  });
});

describe("clampZoom / zoomAfterWheel", () => {
  it("clamps into [ZOOM_MIN, ZOOM_MAX] and maps non-finite to 1", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(50)).toBe(ZOOM_MAX);
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(1);
  });

  it("wheel up (negative deltaY) zooms in, wheel down zooms out, clamped", () => {
    expect(zoomAfterWheel(1, -100)).toBeGreaterThan(1);
    expect(zoomAfterWheel(1, 100)).toBeLessThan(1);
    expect(zoomAfterWheel(ZOOM_MAX, -500)).toBe(ZOOM_MAX);
    expect(zoomAfterWheel(ZOOM_MIN, 500)).toBe(ZOOM_MIN);
    // symmetric: in-then-out returns to start (within float noise)
    expect(zoomAfterWheel(zoomAfterWheel(1, -120), 120)).toBeCloseTo(1, 10);
  });

  it("zoomStorageKey is per artifact identity, not per path", () => {
    expect(zoomStorageKey("kb-doc:a/b.html")).not.toBe(zoomStorageKey("kb-doc:a/c.html"));
    expect(zoomStorageKey("kb-doc:a/b.html")).toContain("a/b.html");
    // the reason it takes an identity: same path, different document
    expect(zoomStorageKey("kb-doc:a/b.html")).not.toBe(zoomStorageKey("repo-file:p:a/b.html"));
  });
});

describe("parseWireframeMessage", () => {
  const src = WIREFRAME_MSG_SOURCE;

  it("accepts the four instrument message types", () => {
    expect(parseWireframeMessage({ source: src, type: "ready" })).toEqual({ type: "ready" });
    expect(
      parseWireframeMessage({ source: src, type: "pin-place", xPct: 12.5, yPct: 80, anchor: "#x" })
    ).toEqual({ type: "pin-place", xPct: 12.5, yPct: 80, anchor: "#x" });
    expect(parseWireframeMessage({ source: src, type: "pin-click", id: "p1" })).toEqual({
      type: "pin-click",
      id: "p1",
    });
    expect(parseWireframeMessage({ source: src, type: "wheel-zoom", deltaY: -53 })).toEqual({
      type: "wheel-zoom",
      deltaY: -53,
    });
  });

  it("rejects wrong/missing source tag and unknown types", () => {
    expect(parseWireframeMessage({ type: "ready" })).toBeNull();
    expect(parseWireframeMessage({ source: "evil", type: "ready" })).toBeNull();
    expect(parseWireframeMessage({ source: src, type: "self-destruct" })).toBeNull();
  });

  it("rejects non-object payloads", () => {
    expect(parseWireframeMessage(null)).toBeNull();
    expect(parseWireframeMessage("ready")).toBeNull();
    expect(parseWireframeMessage(42)).toBeNull();
    expect(parseWireframeMessage([{ source: src, type: "ready" }])).toBeNull();
  });

  it("rejects malformed fields per type", () => {
    expect(parseWireframeMessage({ source: src, type: "pin-place", xPct: "5", yPct: 1 })).toBeNull();
    expect(parseWireframeMessage({ source: src, type: "pin-place", xPct: NaN, yPct: 1 })).toBeNull();
    expect(parseWireframeMessage({ source: src, type: "pin-click", id: "" })).toBeNull();
    expect(parseWireframeMessage({ source: src, type: "pin-click" })).toBeNull();
    expect(parseWireframeMessage({ source: src, type: "wheel-zoom", deltaY: "fast" })).toBeNull();
  });

  it("drops a non-string anchor instead of failing the message", () => {
    expect(parseWireframeMessage({ source: src, type: "pin-place", xPct: 1, yPct: 2, anchor: 9 })).toEqual({
      type: "pin-place",
      xPct: 1,
      yPct: 2,
    });
  });
});

// ── Live preview pins (increment F, Decision 3) ──────────────────────────────
// The same sidecar shape, the same pure ops, the same ONE writer — the only new
// things are WHERE the file lives (`<project>/live-pins.json`), what `doc`
// means (the route, not a filename) and the two live-only fields that ride in
// the record's tolerant tail.

describe("routeScopeOf", () => {
  it("scopes by path, dropping the origin so a port change keeps the pins", () => {
    expect(routeScopeOf("http://localhost:5173/cases")).toBe("/cases");
    expect(routeScopeOf("http://localhost:5174/cases")).toBe("/cases");
  });

  it("keeps the query (two tabs of one route are two surfaces)", () => {
    expect(routeScopeOf("http://localhost:5173/cases?tab=open")).toBe("/cases?tab=open");
  });

  it("normalizes the bare origin to /", () => {
    expect(routeScopeOf("http://localhost:5173")).toBe("/");
    expect(routeScopeOf("http://localhost:5173/")).toBe("/");
  });

  it("drops the hash — a fragment is a position, not a route", () => {
    expect(routeScopeOf("http://localhost:5173/cases#row-4")).toBe("/cases");
  });

  it("degrades to the raw string for an unparseable url instead of merging into /", () => {
    expect(routeScopeOf("not a url")).toBe("not a url");
    expect(routeScopeOf("")).toBe("/");
  });
});

describe("livePinTargetFor", () => {
  it("files under <project>/live-pins.json, keyed by route", () => {
    expect(
      livePinTargetFor({ kind: "localhost", project: "lodestar", url: "http://localhost:5173/cases" })
    ).toEqual({ sidecarPath: `lodestar/${LIVE_PINS_NAME}`, docKey: "/cases" });
  });

  it("two routes of one project share the file and split by doc key", () => {
    const a = livePinTargetFor({ kind: "localhost", project: "orbit", url: "http://localhost:3000/" });
    const b = livePinTargetFor({ kind: "localhost", project: "orbit", url: "http://localhost:3000/flow" });
    expect(a.sidecarPath).toBe(b.sidecarPath);
    expect(a.docKey).not.toBe(b.docKey);
  });

  it("a pathological project key cannot escape the KB root", () => {
    expect(
      livePinTargetFor({ kind: "localhost", project: "../../etc", url: "http://localhost:1/" })
        .sidecarPath
    ).toBe(`etc/${LIVE_PINS_NAME}`);
    expect(
      livePinTargetFor({ kind: "localhost", project: "..", url: "http://localhost:1/" }).sidecarPath
    ).toBe(LIVE_PINS_NAME);
  });
});

describe("createLivePin", () => {
  const args = {
    route: "/cases",
    xPct: 42.5,
    yPct: 61.25,
    url: "http://localhost:5173/cases",
    viewport: { w: 1204.4, h: 812.6 },
  };

  it("carries url + rounded viewport and files under the route", () => {
    const pin = createLivePin(args, "pin-1", "2026-08-02T00:00:00.000Z");
    expect(pin).toEqual({
      id: "pin-1",
      doc: "/cases",
      xPct: 42.5,
      yPct: 61.25,
      note: "",
      createdAt: "2026-08-02T00:00:00.000Z",
      url: "http://localhost:5173/cases",
      viewport: { w: 1204, h: 813 },
    });
  });

  it("is never DOM-anchored", () => {
    expect("anchor" in createLivePin(args)).toBe(false);
  });

  it("survives a serialize → parse round trip with its live fields intact", () => {
    const pin = createLivePin(args, "pin-1", "2026-08-02T00:00:00.000Z");
    const file = addPin(emptyPinsFile(), pin);
    const back = parsePinsFile(serializePinsFile(file));
    expect(back.pins).toHaveLength(1);
    expect(back.pins[0].url).toBe("http://localhost:5173/cases");
    expect(livePinViewport(back.pins[0])).toEqual({ w: 1204, h: 813 });
    expect(pinsForDoc(back, "/cases")).toHaveLength(1);
    expect(pinsForDoc(back, "/")).toHaveLength(0);
  });

  it("the ordinary pin ops apply unchanged", () => {
    const pin = createLivePin(args, "pin-1");
    let file = addPin(emptyPinsFile(), pin);
    file = updatePinNote(file, "pin-1", "the empty state is wrong");
    expect(pinsForDoc(file, "/cases")[0].note).toBe("the empty state is wrong");
    expect(pinsForDoc(file, "/cases")[0].url).toBe("http://localhost:5173/cases");
    file = removePin(file, "pin-1");
    expect(file.pins).toHaveLength(0);
  });
});

describe("livePinViewport", () => {
  it("returns null for a wireframe pin", () => {
    expect(livePinViewport(createPin({ doc: "a.html", xPct: 1, yPct: 2 }))).toBeNull();
  });

  it("returns null for a malformed hand-edited viewport", () => {
    const pin = { ...createPin({ doc: "/", xPct: 1, yPct: 2 }), viewport: { w: "wide" } };
    expect(livePinViewport(pin)).toBeNull();
  });
});
