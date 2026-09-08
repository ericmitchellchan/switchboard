// THE DOC TICK RAIL (SWIT-79, Ky's TocTickRail): the pure geometry.

import { describe, it, expect } from "vitest";
import {
  activeHeadingKey,
  tickShape,
  railTicks,
  countByAnchor,
  TICK_WIDE,
  TICK_NARROW,
  TICK_INDENT,
  RAIL_WIDTH,
  RAIL_OVERLAY_WIDTH,
  type DocHeading,
} from "./docRail";

const headings: DocHeading[] = [
  { key: "h:title", level: 1, text: "Title", top: 0 },
  { key: "h:why", level: 2, text: "Why", top: 300 },
  { key: "h:what", level: 2, text: "What", top: 700 },
  { key: "h:detail", level: 3, text: "Detail", top: 720 },
];

describe("geometry", () => {
  it("Ky's measurements: a 34px rail, a 220px overlay, H1 wide and flush, deeper narrow and indented", () => {
    expect(RAIL_WIDTH).toBe(34);
    expect(RAIL_OVERLAY_WIDTH).toBe(220);
    expect(tickShape(1)).toEqual({ width: TICK_WIDE, indent: 0 });
    expect(tickShape(2)).toEqual({ width: TICK_NARROW, indent: TICK_INDENT });
    expect(tickShape(6)).toEqual({ width: TICK_NARROW, indent: TICK_INDENT });
    expect(TICK_WIDE).toBe(14);
    expect(TICK_NARROW).toBe(8);
  });

  it("the active heading is the last one at or above the scroll top (with tolerance), else the first", () => {
    expect(activeHeadingKey(headings, 0)).toBe("h:title");
    expect(activeHeadingKey(headings, 299)).toBe("h:why"); // within 8px tolerance
    expect(activeHeadingKey(headings, 500)).toBe("h:why");
    expect(activeHeadingKey(headings, 710)).toBe("h:what");
    expect(activeHeadingKey(headings, 5000)).toBe("h:detail");
    expect(activeHeadingKey([], 10)).toBeNull();
    // Scrolled above the first heading (an intro): the first is current.
    expect(activeHeadingKey([{ key: "h:a", level: 1, text: "A", top: 400 }], 0)).toBe("h:a");
  });

  it("railTicks folds shape, activity and pin counts per heading", () => {
    const pins = countByAnchor(["h:why", "h:why", "table:1:row:2", null, "h:detail"]);
    const ticks = railTicks(headings, 320, pins);
    expect(ticks.map((t) => t.active)).toEqual([false, true, false, false]);
    expect(ticks.map((t) => t.pins)).toEqual([0, 2, 0, 1]);
    expect(ticks[0]).toMatchObject({ key: "h:title", width: TICK_WIDE, indent: 0, text: "Title" });
    expect(ticks[3]).toMatchObject({ key: "h:detail", width: TICK_NARROW, indent: TICK_INDENT });
  });
});
