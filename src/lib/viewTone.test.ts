// SWIT-81 — the three pure tone rules: bars/dist, table cells, stat tiles.

import { describe, it, expect } from "vitest";
import {
  BAR_TONES,
  isBarTone,
  defaultBarTone,
  barTone,
  TABLE_TONE_KINDS,
  isTableToneKind,
  TABLE_TONES_CAP,
  TABLE_TONE_COLUMN_CAP,
  parseTableTones,
  columnMinMax,
  tableCellTone,
  STAT_TONES,
  isStatTone,
  defaultStatTone,
  statTone,
} from "./viewTone";

describe("isBarTone / BAR_TONES", () => {
  it("accepts the three named tones and the eight chart tones, rejects junk", () => {
    expect(BAR_TONES).toEqual([
      "neutral",
      "sign",
      "accent",
      "chart-1",
      "chart-2",
      "chart-3",
      "chart-4",
      "chart-5",
      "chart-6",
      "chart-7",
      "chart-8",
    ]);
    for (const t of BAR_TONES) expect(isBarTone(t)).toBe(true);
    expect(isBarTone("chart-9")).toBe(false);
    expect(isBarTone("up")).toBe(false);
    expect(isBarTone(undefined)).toBe(false);
    expect(isBarTone(3)).toBe(false);
  });
});

describe("defaultBarTone", () => {
  it("is 'sign' only when the values hold BOTH a positive and a negative number", () => {
    expect(defaultBarTone([1, 2, 3])).toBe("neutral");
    expect(defaultBarTone([-1, -2])).toBe("neutral");
    expect(defaultBarTone([0, 0, 0])).toBe("neutral");
    expect(defaultBarTone([])).toBe("neutral");
    expect(defaultBarTone([0, 5])).toBe("neutral");
    expect(defaultBarTone([0, -5])).toBe("neutral");
    expect(defaultBarTone([1, -1])).toBe("sign");
    expect(defaultBarTone([0, 1, -1, 0])).toBe("sign");
    expect(defaultBarTone([NaN, 1, -1])).toBe("sign");
  });
});

describe("barTone", () => {
  it("neutral: a flat --text-secondary rest, --text-primary hover, for every bar", () => {
    const pairs = barTone({ tone: "neutral" }, [3, -2, 0]);
    for (const p of pairs) {
      expect(p).toEqual({ rest: "var(--text-secondary)", hover: "var(--text-primary)" });
    }
  });

  it("sign: --up for >=0, --dn for <0, resting at 85% via color-mix, hover at full opacity", () => {
    const pairs = barTone({ tone: "sign" }, [4, -4, 0]);
    expect(pairs[0]).toEqual({ rest: "color-mix(in srgb, var(--up) 85%, transparent)", hover: "var(--up)" });
    expect(pairs[1]).toEqual({ rest: "color-mix(in srgb, var(--dn) 85%, transparent)", hover: "var(--dn)" });
    expect(pairs[2].hover).toBe("var(--up)"); // zero is non-negative
  });

  it("accent and chart-n: the same base colour for every bar, 85% resting", () => {
    const accent = barTone({ tone: "accent" }, [1, 2]);
    expect(accent[0]).toEqual({ rest: "color-mix(in srgb, var(--accent) 85%, transparent)", hover: "var(--accent)" });
    expect(accent[1]).toEqual(accent[0]);
    const chart3 = barTone({ tone: "chart-3" }, [1]);
    expect(chart3[0]).toEqual({ rest: "color-mix(in srgb, var(--chart-3) 85%, transparent)", hover: "var(--chart-3)" });
  });

  it("no explicit tone falls back to the default rule (sign when mixed, else neutral)", () => {
    const mixed = barTone({}, [3, -1]);
    expect(mixed[0].hover).toBe("var(--up)");
    expect(mixed[1].hover).toBe("var(--dn)");
    const allPositive = barTone({}, [3, 1]);
    for (const p of allPositive) expect(p).toEqual({ rest: "var(--text-secondary)", hover: "var(--text-primary)" });
  });

  it("an invalid explicit tone is treated as absent (falls back to the default)", () => {
    const pairs = barTone({ tone: "rainbow" }, [1, -1]);
    expect(pairs[0].hover).toBe("var(--up)");
  });

  it("returns one pair per value, in order, even for an empty column", () => {
    expect(barTone({ tone: "neutral" }, [])).toEqual([]);
  });
});

describe("isTableToneKind / TABLE_TONE_KINDS", () => {
  it("is exactly sign and heat", () => {
    expect(TABLE_TONE_KINDS).toEqual(["sign", "heat"]);
    expect(isTableToneKind("sign")).toBe(true);
    expect(isTableToneKind("heat")).toBe(true);
    expect(isTableToneKind("accent")).toBe(false);
  });
});

describe("parseTableTones", () => {
  it("parses well-formed entries, trims the column, caps at TABLE_TONES_CAP", () => {
    expect(TABLE_TONES_CAP).toBe(6);
    const raw = [
      { column: " pnl ", tone: "sign" },
      { column: "vol", tone: "heat" },
    ];
    expect(parseTableTones(raw)).toEqual([
      { column: "pnl", tone: "sign" },
      { column: "vol", tone: "heat" },
    ]);
    const many = Array.from({ length: 9 }, (_, i) => ({ column: `c${i}`, tone: "sign" as const }));
    expect(parseTableTones(many)).toHaveLength(6);
  });

  it("drops malformed entries alone: no column, too-long column, bad tone kind", () => {
    expect(parseTableTones([{ tone: "sign" }])).toEqual([]);
    expect(parseTableTones([{ column: "x".repeat(TABLE_TONE_COLUMN_CAP + 1), tone: "sign" }])).toEqual([]);
    expect(parseTableTones([{ column: "x", tone: "rainbow" }])).toEqual([]);
    expect(
      parseTableTones([{ column: "ok", tone: "sign" }, { tone: "sign" }, { column: "also", tone: "heat" }])
    ).toEqual([
      { column: "ok", tone: "sign" },
      { column: "also", tone: "heat" },
    ]);
  });

  it("keeps the FIRST rule for a repeated column", () => {
    expect(
      parseTableTones([
        { column: "pnl", tone: "sign" },
        { column: "pnl", tone: "heat" },
      ])
    ).toEqual([{ column: "pnl", tone: "sign" }]);
  });

  it("not an array → []", () => {
    expect(parseTableTones(null)).toEqual([]);
    expect(parseTableTones("nope")).toEqual([]);
    expect(parseTableTones(undefined)).toEqual([]);
  });
});

describe("columnMinMax", () => {
  it("the numeric min/max of a column over the rows, string numbers included", () => {
    expect(columnMinMax([{ pnl: 3 }, { pnl: -2 }, { pnl: "7" }], "pnl")).toEqual({ min: -2, max: 7 });
  });

  it("null cells and non-numeric cells drop alone; null when nothing numeric remains", () => {
    expect(columnMinMax([{ pnl: null }, { pnl: "abc" }, { pnl: "" }], "pnl")).toBeNull();
    expect(columnMinMax([], "pnl")).toBeNull();
    expect(columnMinMax([{ other: 1 }], "pnl")).toBeNull();
  });

  it("a single numeric value gives min === max", () => {
    expect(columnMinMax([{ pnl: 5 }], "pnl")).toEqual({ min: 5, max: 5 });
  });
});

describe("tableCellTone", () => {
  const tones = [
    { column: "pnl", tone: "sign" as const },
    { column: "vol", tone: "heat" as const },
  ];

  it("sign: --up for >=0, --dn for <0, on the declared column only", () => {
    expect(tableCellTone(tones, "pnl", 4, null)).toEqual({ color: "var(--up)" });
    expect(tableCellTone(tones, "pnl", -4, null)).toEqual({ color: "var(--dn)" });
    expect(tableCellTone(tones, "pnl", 0, null)).toEqual({ color: "var(--up)" });
    expect(tableCellTone(tones, "other", 4, null)).toBeNull();
  });

  it("sign on a non-numeric cell is untouched (null)", () => {
    expect(tableCellTone(tones, "pnl", "n/a", null)).toBeNull();
    expect(tableCellTone(tones, "pnl", null, null)).toBeNull();
  });

  it("heat: a color-mix background scaled by position in minmax, capped at 22%", () => {
    expect(tableCellTone(tones, "vol", 0, { min: 0, max: 10 })).toEqual({
      background: "color-mix(in srgb, var(--accent) 0%, transparent)",
    });
    expect(tableCellTone(tones, "vol", 10, { min: 0, max: 10 })).toEqual({
      background: "color-mix(in srgb, var(--accent) 22%, transparent)",
    });
    expect(tableCellTone(tones, "vol", 5, { min: 0, max: 10 })).toEqual({
      background: "color-mix(in srgb, var(--accent) 11%, transparent)",
    });
  });

  it("heat clamps a value outside the given minmax rather than exceeding the ceiling", () => {
    expect(tableCellTone(tones, "vol", -5, { min: 0, max: 10 })).toEqual({
      background: "color-mix(in srgb, var(--accent) 0%, transparent)",
    });
    expect(tableCellTone(tones, "vol", 50, { min: 0, max: 10 })).toEqual({
      background: "color-mix(in srgb, var(--accent) 22%, transparent)",
    });
  });

  it("heat with no minmax, or a degenerate one (min === max), is untouched", () => {
    expect(tableCellTone(tones, "vol", 5, null)).toBeNull();
    expect(tableCellTone(tones, "vol", 5, { min: 3, max: 3 })).toBeNull();
  });

  it("no tones, or no rule for the column, is untouched", () => {
    expect(tableCellTone(undefined, "pnl", 4, null)).toBeNull();
    expect(tableCellTone([], "pnl", 4, null)).toBeNull();
    expect(tableCellTone(tones, "untuned", 4, null)).toBeNull();
  });
});

describe("isStatTone / STAT_TONES", () => {
  it("is exactly up, dn, accent, neutral", () => {
    expect(STAT_TONES).toEqual(["up", "dn", "accent", "neutral"]);
    for (const t of STAT_TONES) expect(isStatTone(t)).toBe(true);
    expect(isStatTone("sign")).toBe(false);
  });
});

describe("defaultStatTone", () => {
  it("an explicit leading + or -/− followed by a digit picks up/dn", () => {
    expect(defaultStatTone("+4%")).toBe("up");
    expect(defaultStatTone("+12.5")).toBe("up");
    expect(defaultStatTone("-4%")).toBe("dn");
    expect(defaultStatTone("−3.2×")).toBe("dn"); // unicode minus
  });

  it("an unsigned or non-numeric-looking value is neutral", () => {
    expect(defaultStatTone("4%")).toBe("neutral");
    expect(defaultStatTone("n/a")).toBe("neutral");
    expect(defaultStatTone("2 – 3×")).toBe("neutral");
    expect(defaultStatTone("-")).toBe("neutral"); // no digit follows
    expect(defaultStatTone("+")).toBe("neutral");
  });
});

describe("statTone", () => {
  it("colours the figure by the explicit tone when valid", () => {
    expect(statTone({ tone: "up", value: "n/a" })).toBe("var(--up)");
    expect(statTone({ tone: "dn", value: "+4%" })).toBe("var(--dn)");
    expect(statTone({ tone: "accent", value: "4%" })).toBe("var(--accent)");
    expect(statTone({ tone: "neutral", value: "-4%" })).toBe("var(--text-primary)");
  });

  it("falls back to defaultStatTone when tone is absent or invalid", () => {
    expect(statTone({ value: "+4%" })).toBe("var(--up)");
    expect(statTone({ value: "-4%" })).toBe("var(--dn)");
    expect(statTone({ value: "4%" })).toBe("var(--text-primary)");
    expect(statTone({ tone: "rainbow", value: "+4%" })).toBe("var(--up)");
  });
});
