// Candle data helpers (SWIT-39): the pure conversions CandleChart relies on.

import { describe, it, expect } from "vitest";
import {
  SERIES_PALETTE,
  barAnchorKey,
  drawableLevels,
  isoToUtcSeconds,
  levelColor,
  nearestCandle,
  seriesColor,
  toCandlePoints,
} from "./candles";

const bar = (ts: string, o = 1, h = 2, l = 0.5, c = 1.5) => ({ ts, open: o, high: h, low: l, close: c });

describe("isoToUtcSeconds", () => {
  it("floors to seconds and rejects garbage", () => {
    expect(isoToUtcSeconds("2026-08-12T16:02:30.900Z")).toBe(1786550550);
    expect(isoToUtcSeconds("not a date")).toBeNull();
  });

  it("reads a NAIVE stamp as UTC (the backend's ts_utc), not local time", () => {
    expect(isoToUtcSeconds("2026-08-12T16:02:30")).toBe(1786550550);
    expect(isoToUtcSeconds("2026-08-12 16:02:30")).toBe(1786550550);
    // An explicit offset is honoured as written.
    expect(isoToUtcSeconds("2026-08-12T09:02:30-07:00")).toBe(1786550550);
  });
});

describe("toCandlePoints", () => {
  it("sorts ascending, keeps the source stamp, drops bad bars and dedupes by second", () => {
    const pts = toCandlePoints([
      bar("2026-08-12T16:02:00Z"),
      bar("2026-08-12T16:01:00Z"),
      bar("bad"),
      { ts: "2026-08-12T16:03:00Z", open: NaN, high: 1, low: 1, close: 1 },
      bar("2026-08-12T16:02:00.400Z", 9, 9, 9, 9), // same second as the first → wins
    ]);
    expect(pts.map((p) => p.ts)).toEqual(["2026-08-12T16:01:00Z", "2026-08-12T16:02:00.400Z"]);
    expect(pts[1].open).toBe(9);
    expect(pts[0].time).toBeLessThan(pts[1].time);
  });

  it("empty in, empty out", () => {
    expect(toCandlePoints([])).toEqual([]);
  });
});

describe("anchors, highlight, levels", () => {
  it("barAnchorKey is the anchors grammar", () => {
    expect(barAnchorKey("2026-08-12T16:02:00Z")).toBe("bar:2026-08-12T16:02:00Z");
  });

  it("nearestCandle picks the closest second", () => {
    const pts = toCandlePoints([bar("2026-08-12T16:01:00Z"), bar("2026-08-12T16:02:00Z")]);
    expect(nearestCandle(pts, "2026-08-12T16:01:40Z")?.ts).toBe("2026-08-12T16:02:00Z");
    expect(nearestCandle(pts, null)).toBeNull();
    expect(nearestCandle([], "2026-08-12T16:01:40Z")).toBeNull();
  });

  it("levelColor maps tones and falls back to accent; drawableLevels filters junk", () => {
    expect(levelColor("up")).toBe("#4ea96a");
    expect(levelColor("nope")).toBe(levelColor("accent"));
    expect(levelColor(undefined)).toBe("#7c8ce8");
    expect(
      drawableLevels([
        { price: 5622, label: "gamma wall", tone: "accent" },
        { price: NaN, label: "x", tone: "up" },
        { price: 1, label: "  ", tone: "up" },
      ])
    ).toEqual([{ price: 5622, label: "gamma wall", tone: "accent" }]);
  });
});

// ── SWIT-70: the stable series palette ───────────────────────────────────────

describe("seriesColor — the stable per-name palette (SWIT-70)", () => {
  it("has eight tones, all hex, none of them --up/--dn (those carry meaning)", () => {
    expect(SERIES_PALETTE).toHaveLength(8);
    for (const c of SERIES_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(SERIES_PALETTE).not.toContain(levelColor("up"));
    expect(SERIES_PALETTE).not.toContain(levelColor("dn"));
  });

  it("is stable: the same name always gets the same colour, from the palette", () => {
    for (const name of ["close", "gamma", "net_gamma", "rsi", "volume", ""]) {
      const first = seriesColor(name);
      expect(seriesColor(name)).toBe(first);
      expect(SERIES_PALETTE).toContain(first);
    }
  });

  it("spreads realistic series names across the palette", () => {
    const names = ["close", "volume", "rsi", "delta", "gamma", "vega", "theta", "iv"];
    const distinct = new Set(names.map(seriesColor));
    // Eight names into eight tones will collide sometimes; what matters is
    // that four near-identical charts do not come out one colour.
    expect(distinct.size).toBeGreaterThanOrEqual(5);
    const more = ["price", "spread", "oi", "funding", "net_gamma", "call_oi", "put_oi", "vix"];
    expect(new Set([...names, ...more].map(seriesColor)).size).toBeGreaterThanOrEqual(6);
  });

  it("separates the pairs that ride one chart together", () => {
    expect(seriesColor("close")).not.toBe(seriesColor("volume"));
    expect(seriesColor("gamma")).not.toBe(seriesColor("vega"));
  });
});
