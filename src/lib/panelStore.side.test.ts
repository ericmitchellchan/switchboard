// Panel SIDE per tab (SWIT-33): the one-bit store beside the strip — default,
// toggle, persistence record, tolerant parse, remap and removal.

import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetPanelStoreForTests,
  panelSideFor,
  setPanelSide,
  sideOnOpen,
  togglePanelSide,
  openInPanel,
  getPanelSidesRecord,
  parsePanelSides,
  initPanelSides,
  remapPanelSessions,
  removeSessionPanel,
  subscribeToPanelStore,
  panelWidthFromDrag,
  setPanelThreadResolver,
} from "./panelStore";

beforeEach(() => {
  __resetPanelStoreForTests();
});

describe("panel side", () => {
  it("defaults to the right, for a tab and for no tab", () => {
    expect(panelSideFor("t1")).toBe("right");
    expect(panelSideFor(null)).toBe("right");
  });

  it("toggles per tab; the workspace record holds THREAD-bound EXPLICIT sides, both values (SWIT-69)", () => {
    setPanelThreadResolver((s) => (s === "t1" ? "th1" : null));
    togglePanelSide("t1");
    expect(panelSideFor("t1")).toBe("left");
    expect(panelSideFor("t2")).toBe("right");
    expect(getPanelSidesRecord()).toEqual({ th1: "left" });
    // Toggling back records an EXPLICIT right — the user's ⇄ wins forever,
    // so the surfaces-left default may never re-flip this tab.
    togglePanelSide("t1");
    expect(panelSideFor("t1")).toBe("right");
    expect(getPanelSidesRecord()).toEqual({ th1: "right" });
    // A SHELL's side works live but is transient — never persisted.
    togglePanelSide("t2");
    expect(panelSideFor("t2")).toBe("left");
    expect(getPanelSidesRecord()).toEqual({ th1: "right" });
  });

  it("setting the side an explicit entry already holds does not notify", () => {
    let n = 0;
    const off = subscribeToPanelStore(() => (n += 1));
    setPanelSide("t1", "left");
    expect(n).toBe(1);
    setPanelSide("t1", "left");
    expect(n).toBe(1);
    setPanelSide("t1", "right");
    expect(n).toBe(2);
    setPanelSide("t1", "right");
    expect(n).toBe(2);
    off();
  });

  it("parsePanelSides keeps `left` and `right` entries and drops junk", () => {
    expect(parsePanelSides({ a: "left", b: "right", c: 1, "": "left" })).toEqual({
      a: "left",
      b: "right",
    });
    expect(parsePanelSides(undefined)).toEqual({});
    expect(parsePanelSides(["left"])).toEqual({});
  });

  it("sideOnOpen (pure): a surface into a never-set tab goes LEFT; explicit sides are untouched; other kinds never move it", () => {
    expect(sideOnOpen("surface", undefined)).toBe("left");
    expect(sideOnOpen("surface", "right")).toBeNull();
    expect(sideOnOpen("surface", "left")).toBeNull();
    expect(sideOnOpen("kb-doc", undefined)).toBeNull();
    expect(sideOnOpen("view", undefined)).toBeNull();
    expect(sideOnOpen("session", undefined)).toBeNull();
  });

  it("opening a surface defaults the tab's side LEFT and persists it; the user's ⇄ then wins", () => {
    setPanelThreadResolver((s) => (s === "s1" ? "th1" : null));
    openInPanel("s1", { kind: "surface", project: "lodestar", page: "trading" });
    expect(panelSideFor("s1")).toBe("left");
    expect(getPanelSidesRecord()).toEqual({ th1: "left" });
    togglePanelSide("s1"); // the user puts it back
    expect(panelSideFor("s1")).toBe("right");
    openInPanel("s1", { kind: "surface", project: "lodestar", page: "markets" });
    expect(panelSideFor("s1")).toBe("right"); // explicit right holds
    // A non-surface open into a fresh tab moves nothing.
    setPanelThreadResolver(() => null);
    openInPanel("s2", { kind: "kb-doc", path: "notes.md" });
    expect(panelSideFor("s2")).toBe("right");
  });

  it("seeds from a saved record (thread-keyed, SWIT-47) and survives restore with its thread", () => {
    initPanelSides({ th1: "left", th2: "left" });
    remapPanelSessions(new Map(), new Set(["th1"]));
    setPanelThreadResolver((s) => (s === "sess1" ? "th1" : s === "sess2" ? "th2" : null));
    expect(panelSideFor("sess1")).toBe("left");
    expect(panelSideFor("sess2")).toBe("right"); // its thread is gone → dropped
  });

  it("dies with the tab", () => {
    setPanelSide("t1", "left");
    removeSessionPanel("t1");
    expect(panelSideFor("t1")).toBe("right");
    expect(getPanelSidesRecord()).toEqual({});
  });
});

describe("panelWidthFromDrag by side", () => {
  it("right: width runs from the divider to the container's right edge", () => {
    // container [100, 1100], divider dragged to x=700 → panel = 1100-700-4
    expect(panelWidthFromDrag(100, 1000, 700, "right")).toBe(396);
    expect(panelWidthFromDrag(100, 1000, 700)).toBe(396); // default is right
  });

  it("left: width runs from the container's left edge to the divider, so dragging right widens", () => {
    expect(panelWidthFromDrag(100, 1000, 500, "left")).toBe(400);
    expect(panelWidthFromDrag(100, 1000, 700, "left")).toBe(600);
  });

  it("both sides respect the terminal's minimum width cap", () => {
    const right = panelWidthFromDrag(0, 800, 10, "right");
    const left = panelWidthFromDrag(0, 800, 790, "left");
    expect(right).toBe(left);
    expect(right).toBeLessThan(800);
  });
});
