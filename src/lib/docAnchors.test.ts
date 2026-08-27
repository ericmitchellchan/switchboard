// Doc anchors (SWIT-37): the pure key/label grammar for headings and table
// rows, and the stamp plan MarkdownDoc applies.

import { describe, it, expect } from "vitest";
import {
  DOC_ANCHOR_LABEL_MAX,
  anchorLabelText,
  headingAnchorKey,
  planHeading,
  planTableRow,
  stampAttributes,
  tableRowAnchorKey,
} from "./docAnchors";
import { isAnchorKey } from "../surfaces/anchors";

describe("doc anchor keys", () => {
  it("headings key by slug, and the key is a valid anchor key", () => {
    expect(headingAnchorKey("path-ladder")).toBe("h:path-ladder");
    expect(isAnchorKey(headingAnchorKey("path-ladder")!)).toBe(true);
    expect(headingAnchorKey("  ")).toBeNull();
    expect(headingAnchorKey("a\nb")).toBeNull();
  });

  it("table rows key by 1-based table and row position", () => {
    expect(tableRowAnchorKey(1, 2)).toBe("table:1:row:2");
    expect(tableRowAnchorKey(0, 1)).toBeNull();
    expect(tableRowAnchorKey(1, 0)).toBeNull();
    expect(tableRowAnchorKey(1.5, 1)).toBeNull();
  });
});

describe("labels", () => {
  it("collapses whitespace and caps the length", () => {
    expect(anchorLabelText("  Path\n  ladder   (30m) ")).toBe("Path ladder (30m)");
    const long = "x".repeat(DOC_ANCHOR_LABEL_MAX + 20);
    expect(anchorLabelText(long)).toHaveLength(DOC_ANCHOR_LABEL_MAX);
    expect(anchorLabelText(long).endsWith("…")).toBe(true);
  });
});

describe("stamp plans", () => {
  it("a heading with a slug gets its text as label, falling back to the key", () => {
    expect(planHeading("plain-english", "Plain English")).toEqual({ key: "h:plain-english", label: "Plain English" });
    expect(planHeading("x", "   ")).toEqual({ key: "h:x", label: "h:x" });
    expect(planHeading(null, "No id")).toBeNull();
  });

  it("a table row is labelled by its first cell with the table number", () => {
    expect(planTableRow(1, 2, " 30m ")).toEqual({ key: "table:1:row:2", label: "table 1 · 30m" });
    expect(planTableRow(2, 3, "")).toEqual({ key: "table:2:row:3", label: "table 2 · row 3" });
    expect(planTableRow(0, 3, "x")).toBeNull();
  });

  it("stampAttributes names the two data attributes", () => {
    expect(stampAttributes({ key: "h:a", label: "A" })).toEqual([
      ["data-anchor", "h:a"],
      ["data-anchor-label", "A"],
    ]);
  });
});
