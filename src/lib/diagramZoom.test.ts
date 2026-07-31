// Tests for the diagram pan/zoom math (T9) and the diagram verification-meta
// parser (diagramMeta.ts — its tests live here per the task's file plan).

import { describe, expect, it } from "vitest";
import {
  IDENTITY,
  SCALE_MAX,
  SCALE_MIN,
  clampScale,
  panBy,
  transformToCss,
  wheelZoomFactor,
  zoomToPoint,
} from "./diagramZoom";
import type { Transform } from "./diagramZoom";
import { parseDiagramMeta } from "./diagramMeta";

/** Container point the content point c is painted at under transform t. */
function project(t: Transform, cx: number, cy: number): { x: number; y: number } {
  return { x: cx * t.scale + t.tx, y: cy * t.scale + t.ty };
}

/** Content point currently under the container point (px, py). */
function unproject(t: Transform, px: number, py: number): { x: number; y: number } {
  return { x: (px - t.tx) / t.scale, y: (py - t.ty) / t.scale };
}

describe("clampScale", () => {
  it("clamps into [SCALE_MIN, SCALE_MAX]", () => {
    expect(clampScale(0.01)).toBe(SCALE_MIN);
    expect(clampScale(50)).toBe(SCALE_MAX);
    expect(clampScale(1.5)).toBe(1.5);
    expect(clampScale(SCALE_MIN)).toBe(SCALE_MIN);
    expect(clampScale(SCALE_MAX)).toBe(SCALE_MAX);
  });

  it("maps non-finite input to identity scale", () => {
    expect(clampScale(NaN)).toBe(1);
    expect(clampScale(Infinity)).toBe(1);
    expect(clampScale(-Infinity)).toBe(1);
  });
});

describe("panBy", () => {
  it("shifts translation and never touches scale", () => {
    const t = panBy({ tx: 10, ty: -4, scale: 2.5 }, 5, 7);
    expect(t).toEqual({ tx: 15, ty: 3, scale: 2.5 });
  });

  it("composes additively", () => {
    const start: Transform = { tx: 3, ty: 9, scale: 0.7 };
    expect(panBy(panBy(start, 4, -2), -1, 10)).toEqual(panBy(start, 3, 8));
  });

  it("does not mutate its input", () => {
    const start: Transform = { ...IDENTITY };
    panBy(start, 100, 100);
    expect(start).toEqual(IDENTITY);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in on wheel-up (negative deltaY) and out on wheel-down", () => {
    expect(wheelZoomFactor(-120)).toBeGreaterThan(1);
    expect(wheelZoomFactor(120)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it("is symmetric: in then out by the same delta round-trips to 1", () => {
    expect(wheelZoomFactor(90) * wheelZoomFactor(-90)).toBeCloseTo(1, 12);
  });
});

describe("zoomToPoint", () => {
  // THE invariant that makes zoom feel anchored: the content point under the
  // cursor before the zoom is still under the cursor after it.
  it("keeps the content point under the cursor fixed (numeric invariant)", () => {
    const cases: Array<{ t: Transform; cx: number; cy: number; f: number }> = [
      { t: { ...IDENTITY }, cx: 200, cy: 150, f: 1.25 },
      { t: { tx: -40, ty: 60, scale: 2 }, cx: 333, cy: 12, f: 0.5 },
      { t: { tx: 500, ty: -900, scale: 0.3 }, cx: 0, cy: 0, f: 3 },
      { t: { tx: 13.7, ty: 42.1, scale: 1.61 }, cx: 87.3, cy: 411.9, f: 0.77 },
    ];
    for (const { t, cx, cy, f } of cases) {
      const before = unproject(t, cx, cy);
      const after = zoomToPoint(t, cx, cy, f);
      const reprojected = project(after, before.x, before.y);
      expect(reprojected.x).toBeCloseTo(cx, 9);
      expect(reprojected.y).toBeCloseTo(cy, 9);
      expect(after.scale).toBeCloseTo(t.scale * f, 12);
    }
  });

  it("the invariant survives a PARTIAL clamp (factor overshoots the max)", () => {
    const t: Transform = { tx: -10, ty: 20, scale: 6 };
    const before = unproject(t, 100, 80);
    const after = zoomToPoint(t, 100, 80, 10); // 60 → clamps to 8
    expect(after.scale).toBe(SCALE_MAX);
    const reprojected = project(after, before.x, before.y);
    expect(reprojected.x).toBeCloseTo(100, 9);
    expect(reprojected.y).toBeCloseTo(80, 9);
  });

  it("returns the transform UNCHANGED when the clamp makes zoom a no-op", () => {
    const atMax: Transform = { tx: 5, ty: 6, scale: SCALE_MAX };
    expect(zoomToPoint(atMax, 50, 50, 2)).toBe(atMax);
    const atMin: Transform = { tx: 5, ty: 6, scale: SCALE_MIN };
    expect(zoomToPoint(atMin, 50, 50, 0.5)).toBe(atMin);
    // and factor 1 is always identity
    const t: Transform = { tx: 1, ty: 2, scale: 3 };
    expect(zoomToPoint(t, 9, 9, 1)).toBe(t);
  });

  it("clamps scale into [SCALE_MIN, SCALE_MAX]", () => {
    expect(zoomToPoint(IDENTITY, 0, 0, 100).scale).toBe(SCALE_MAX);
    expect(zoomToPoint(IDENTITY, 0, 0, 0.0001).scale).toBe(SCALE_MIN);
  });

  it("zoom about the content origin with identity pan keeps the origin fixed", () => {
    const after = zoomToPoint(IDENTITY, 0, 0, 2);
    expect(after).toEqual({ tx: 0, ty: 0, scale: 2 });
  });
});

describe("transformToCss", () => {
  it("emits translate3d + scale (transform-origin 0 0 contract)", () => {
    expect(transformToCss({ tx: 10.5, ty: -3, scale: 2 })).toBe(
      "translate3d(10.5px, -3px, 0) scale(2)"
    );
    expect(transformToCss(IDENTITY)).toBe("translate3d(0px, 0px, 0) scale(1)");
  });
});

// ── diagramMeta ──────────────────────────────────────────────────────────────

describe("parseDiagramMeta", () => {
  it("extracts the verified-against stamp from a %% comment line", () => {
    const mmd = [
      "%% verified-against: 6d227f8 @ 2026-07-31",
      "graph LR",
      "  A --> B",
    ].join("\n");
    const meta = parseDiagramMeta(mmd);
    expect(meta.verifiedAgainst).toBe("6d227f8 @ 2026-07-31");
    expect(meta.unverifiedCount).toBe(0);
  });

  it("matches case-insensitively and trims the captured value", () => {
    expect(parseDiagramMeta("%% Verified-Against:   abc123   ").verifiedAgainst).toBe(
      "abc123"
    );
  });

  it("returns null when no stamp exists", () => {
    expect(parseDiagramMeta("graph TD\n A-->B").verifiedAgainst).toBeNull();
    expect(parseDiagramMeta("").verifiedAgainst).toBeNull();
  });

  it("counts (unverified) edge markers case-insensitively", () => {
    const mmd = [
      "graph LR",
      "  A -->|writes (unverified)| B",
      "  B -->|reads (UNVERIFIED)| C",
      "  C -->|verified edge| D",
    ].join("\n");
    expect(parseDiagramMeta(mmd).unverifiedCount).toBe(2);
  });

  it("reports zero unverified markers for a fully verified diagram", () => {
    expect(parseDiagramMeta("graph LR\n A-->B").unverifiedCount).toBe(0);
  });

  it("handles a stamped diagram that ALSO has unverified edges", () => {
    const mmd = "%% verified-against: deadbeef\ngraph LR\n A -->|x (unverified)| B";
    expect(parseDiagramMeta(mmd)).toEqual({
      verifiedAgainst: "deadbeef",
      unverifiedCount: 1,
    });
  });
});
