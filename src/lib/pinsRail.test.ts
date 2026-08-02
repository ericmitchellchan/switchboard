import { describe, it, expect } from "vitest";
import {
  RAIL_COLLAPSED_WIDTH,
  RAIL_WIDTH,
  railStorageKey,
  railStorageValue,
  resolveRailCollapsed,
} from "./pinsRail";

describe("resolveRailCollapsed", () => {
  it("defaults to COLLAPSED when the doc has no pins (acceptance 5)", () => {
    expect(resolveRailCollapsed(null, 0)).toBe(true);
  });

  it("defaults to EXPANDED when the doc has pins", () => {
    expect(resolveRailCollapsed(null, 1)).toBe(false);
    expect(resolveRailCollapsed(null, 12)).toBe(false);
  });

  it("a stored preference wins in BOTH directions", () => {
    expect(resolveRailCollapsed("1", 5)).toBe(true); // collapsed despite notes
    expect(resolveRailCollapsed("0", 0)).toBe(false); // expanded despite emptiness
  });

  it("treats an unrecognised stored value as no preference, never as a guess", () => {
    expect(resolveRailCollapsed("yes", 0)).toBe(true);
    expect(resolveRailCollapsed("", 3)).toBe(false);
  });

  it("tolerates a nonsense pin count", () => {
    expect(resolveRailCollapsed(null, NaN)).toBe(true);
    expect(resolveRailCollapsed(null, -4)).toBe(true);
    expect(resolveRailCollapsed(null, 1.9)).toBe(false);
  });
});

describe("railStorageKey", () => {
  it("is namespaced and keyed by artifact identity, not by path", () => {
    expect(railStorageKey("kb-doc:a/b.html")).toBe("sb-pins-rail:kb-doc:a/b.html");
    expect(railStorageKey("repo-file:lodestar:a/b.html")).not.toBe(
      railStorageKey("kb-doc:a/b.html")
    );
  });

  it("round-trips through resolveRailCollapsed", () => {
    expect(resolveRailCollapsed(railStorageValue(true), 9)).toBe(true);
    expect(resolveRailCollapsed(railStorageValue(false), 0)).toBe(false);
  });
});

describe("rail widths", () => {
  it("a collapsed rail still occupies a clickable edge", () => {
    expect(RAIL_COLLAPSED_WIDTH).toBeGreaterThan(0);
    expect(RAIL_COLLAPSED_WIDTH).toBeLessThan(RAIL_WIDTH);
  });
});
