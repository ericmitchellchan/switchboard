// Surface anchors (SWIT-35): the pure key grammar, the ancestor walk with
// element fakes (no DOM), the selector escaping, and provider composition.

import { describe, it, expect } from "vitest";
import {
  ANCHOR_ATTR,
  ANCHOR_LABEL_ATTR,
  anchorKey,
  anchorSelector,
  composeAnchorProviders,
  isAnchorKey,
  nearestAnchor,
  parseAnchorKey,
} from "./anchors";
import type { AnchorElementLike, SurfaceAnchorProvider } from "./anchors";

function el(attrs: Record<string, string>, parent: AnchorElementLike | null = null): AnchorElementLike {
  return {
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    parentElement: parent,
  };
}

describe("anchor keys", () => {
  it("accepts <kind>:<id> with a lowercase kind and any printable id", () => {
    expect(isAnchorKey("trade:2026-08-12T16:02:00Z-NQ-1")).toBe(true);
    expect(isAnchorKey("row:archetype:knife catch")).toBe(true);
    expect(isAnchorKey("bar:1723478460000")).toBe(true);
    expect(isAnchorKey("tile:win rate")).toBe(true);
  });

  it("rejects malformed keys", () => {
    expect(isAnchorKey("")).toBe(false);
    expect(isAnchorKey("trade")).toBe(false);
    expect(isAnchorKey("trade:")).toBe(false);
    expect(isAnchorKey("Trade:1")).toBe(false);
    expect(isAnchorKey("1trade:1")).toBe(false);
    expect(isAnchorKey("row:a\nb")).toBe(false);
    expect(isAnchorKey(42)).toBe(false);
    expect(isAnchorKey(null)).toBe(false);
  });

  it("parses kind and id, keeping colons inside the id", () => {
    expect(parseAnchorKey("row:archetype:knife catch")).toEqual({ kind: "row", id: "archetype:knife catch" });
    expect(parseAnchorKey("nope")).toBeNull();
    expect(anchorKey("trade", "t1")).toBe("trade:t1");
  });
});

describe("nearestAnchor", () => {
  it("finds the nearest marked ancestor and uses its label", () => {
    const row = el({ [ANCHOR_ATTR]: "trade:t1", [ANCHOR_LABEL_ATTR]: "NQ long 10:02" });
    const cell = el({}, row);
    const text = el({}, cell);
    expect(nearestAnchor(text)).toEqual({ key: "trade:t1", label: "NQ long 10:02" });
  });

  it("falls back to the key as the label, trimmed", () => {
    const row = el({ [ANCHOR_ATTR]: "tile:net", [ANCHOR_LABEL_ATTR]: "   " });
    expect(nearestAnchor(row)).toEqual({ key: "tile:net", label: "tile:net" });
  });

  it("skips a malformed inner key and keeps walking", () => {
    const row = el({ [ANCHOR_ATTR]: "trade:t1" });
    const bad = el({ [ANCHOR_ATTR]: "TYPO" }, row);
    expect(nearestAnchor(bad)?.key).toBe("trade:t1");
  });

  it("stops at the root: nothing outside the page is an anchor", () => {
    const outside = el({ [ANCHOR_ATTR]: "tile:outside" });
    const root = el({}, outside);
    const inner = el({}, root);
    expect(nearestAnchor(inner, root)).toBeNull();
    // The root itself may carry an anchor.
    const rootAnchored = el({ [ANCHOR_ATTR]: "page:root" }, outside);
    expect(nearestAnchor(el({}, rootAnchored), rootAnchored)?.key).toBe("page:root");
  });

  it("null start → null", () => {
    expect(nearestAnchor(null)).toBeNull();
  });
});

describe("anchorSelector", () => {
  it("quotes and escapes the value", () => {
    expect(anchorSelector("row:archetype:knife catch")).toBe('[data-anchor="row:archetype:knife catch"]');
    expect(anchorSelector('tile:say "hi"')).toBe('[data-anchor="tile:say \\"hi\\""]');
    expect(anchorSelector("tile:a\\b")).toBe('[data-anchor="tile:a\\\\b"]');
  });
});

describe("composeAnchorProviders", () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 } as DOMRect;
  const fallback: SurfaceAnchorProvider = {
    getAnchor: () => ({ key: "row:fallback", label: "fallback" }),
    locateAnchor: (key) => (key === "row:fallback" ? rect : null),
  };
  const primary: SurfaceAnchorProvider = {
    getAnchor: (t) => (t === null ? { key: "bar:1", label: "bar" } : null),
    locateAnchor: (key) => (key === "bar:1" ? rect : null),
  };

  it("with no primary, the fallback is returned as-is", () => {
    expect(composeAnchorProviders(null, fallback)).toBe(fallback);
  });

  it("primary answers first; the fallback covers what it declines", () => {
    const p = composeAnchorProviders(primary, fallback);
    expect(p.getAnchor(null)?.key).toBe("bar:1");
    expect(p.getAnchor({} as EventTarget)?.key).toBe("row:fallback");
    expect(p.locateAnchor("bar:1")).toBe(rect);
    expect(p.locateAnchor("row:fallback")).toBe(rect);
    expect(p.locateAnchor("row:nope")).toBeNull();
  });
});
