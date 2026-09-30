// View controls (SWIT-111): the pure rules — parse (tolerant), legality,
// the plain number format, substitution per source type, the pin-scope
// suffix, the artifact load gate.

import { describe, it, expect } from "vitest";
import {
  CONTROL_CAP,
  CONTROL_OPTION_CAP,
  CONTROL_OPTION_LEN,
  controlDefault,
  controlLine,
  controlPinScope,
  controlsAtValues,
  controlValuesKey,
  effectiveControlValues,
  formatControlNumber,
  isControlDate,
  normalizeControlValue,
  parseViewControls,
  placeholdersIn,
  sanitizeControlValues,
  substituteControls,
  jsonStringEscape,
  noteSettingKey,
  CONTROL_VALUE_CAP,
  clampControlNumber,
} from "./viewControls";
import type { ViewControl } from "./viewControls";
import { drillPathKey, isLocalBackendUrl, viewPinScope } from "./viewStore";

const DEPS = { pathComponent: drillPathKey, isLoopback: isLocalBackendUrl };

const EXPIRY: ViewControl = { name: "expiry", kind: "select", options: ["front", "all"], default: "front" };
const WIDTH: ViewControl = { name: "width", kind: "number", default: 5, min: 1, max: 10, step: 1 };
const DAY: ViewControl = { name: "day", kind: "date", default: "2026-06-05" };

describe("parseViewControls — the reader's tolerant half", () => {
  it("parses the three kinds and keeps labels", () => {
    const out = parseViewControls([
      { name: "expiry", kind: "select", options: ["front", "all"], default: "all", label: "Expiry" },
      { name: "width", kind: "number", default: 5, min: 1, max: 10, step: 1 },
      { name: "day", kind: "date", default: "2026-06-05" },
    ]);
    expect(out).toEqual([
      { name: "expiry", kind: "select", options: ["front", "all"], default: "all", label: "Expiry" },
      { name: "width", kind: "number", default: 5, min: 1, max: 10, step: 1 },
      { name: "day", kind: "date", default: "2026-06-05" },
    ]);
  });

  it("drops a malformed entry ALONE (bad name, reserved `key`, repeat, unknown kind, no options, bad date)", () => {
    const out = parseViewControls([
      { name: "Expiry", kind: "select", options: ["a"], default: "a" },
      { name: "key", kind: "select", options: ["a"], default: "a" },
      { name: "ok", kind: "select", options: ["a"], default: "a" },
      { name: "ok", kind: "select", options: ["b"], default: "b" },
      { name: "range", kind: "slider", default: 1 },
      { name: "empty", kind: "select", options: [], default: "" },
      { name: "d", kind: "date", default: "2026-02-30" },
      { name: "n", kind: "number", default: "x" },
      "junk",
    ]);
    expect(out.map((c) => c.name)).toEqual(["ok"]);
  });

  it("falls back to the first option, clamps a number default, drops a reversed range and a bad step", () => {
    const [sel, num, rev] = parseViewControls([
      { name: "e", kind: "select", options: [" front ", "all", "front", "", 3], default: "weekly" },
      { name: "w", kind: "number", default: 50, min: 1, max: 10, step: -1 },
      { name: "r", kind: "number", default: 3, min: 10, max: 1 },
    ]);
    expect(sel).toEqual({ name: "e", kind: "select", options: ["front", "all"], default: "front" });
    expect(num).toEqual({ name: "w", kind: "number", default: 10, min: 1, max: 10 });
    expect(rev).toEqual({ name: "r", kind: "number", default: 3 });
  });

  it("caps controls, options and option length", () => {
    const many = Array.from({ length: CONTROL_CAP + 2 }, (_, i) => ({
      name: `c${i}`,
      kind: "select",
      options: ["a"],
      default: "a",
    }));
    expect(parseViewControls(many)).toHaveLength(CONTROL_CAP);
    const opts = Array.from({ length: CONTROL_OPTION_CAP + 5 }, (_, i) => `o${i}`);
    const [c] = parseViewControls([
      { name: "e", kind: "select", options: ["x".repeat(CONTROL_OPTION_LEN + 1), ...opts], default: "o0" },
    ]);
    expect(c.kind === "select" && c.options.length).toBe(CONTROL_OPTION_CAP);
    expect(c.kind === "select" && c.options[0]).toBe("o0");
  });

  it("is [] for anything that is not an array", () => {
    expect(parseViewControls(undefined)).toEqual([]);
    expect(parseViewControls({ name: "e" })).toEqual([]);
  });
});

describe("legality — select / number / date", () => {
  it("a select value must be one of its options", () => {
    expect(normalizeControlValue(EXPIRY, "all")).toBe("all");
    expect(normalizeControlValue(EXPIRY, " all ")).toBe("all");
    expect(normalizeControlValue(EXPIRY, "weekly")).toBeNull();
  });

  it("a number is clamped to min/max and printed plainly", () => {
    expect(normalizeControlValue(WIDTH, "7")).toBe("7");
    expect(normalizeControlValue(WIDTH, "0")).toBe("1");
    expect(normalizeControlValue(WIDTH, "99")).toBe("10");
    expect(normalizeControlValue(WIDTH, 2.5)).toBe("2.5");
    expect(normalizeControlValue(WIDTH, "abc")).toBeNull();
    expect(normalizeControlValue(WIDTH, "")).toBeNull();
    expect(clampControlNumber(5)).toBe(5);
  });

  it("a date must be a real YYYY-MM-DD day", () => {
    expect(normalizeControlValue(DAY, "2026-02-28")).toBe("2026-02-28");
    expect(normalizeControlValue(DAY, "2026-02-30")).toBeNull();
    expect(normalizeControlValue(DAY, "2026-6-5")).toBeNull();
    expect(isControlDate("2024-02-29")).toBe(true);
    expect(isControlDate("2025-02-29")).toBe(false);
  });

  it("formats numbers with no exponent and no float noise", () => {
    expect(formatControlNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatControlNumber(-0)).toBe("0");
    expect(formatControlNumber(5)).toBe("5");
    expect(formatControlNumber(-2.5)).toBe("-2.5");
    expect(formatControlNumber(1e21)).toBe("1000000000000000000000");
    expect(formatControlNumber(1e-7)).toBe("0.0000001");
    expect(formatControlNumber(-1.5e-7)).toBe("-0.00000015");
    expect(formatControlNumber(-1.5e21)).toBe("-1500000000000000000000");
    expect(formatControlNumber(Number.NaN)).toBe("0");
  });

  it("effectiveControlValues gives EVERY control a value — the legal given one, else the default", () => {
    expect(effectiveControlValues([EXPIRY, WIDTH, DAY], { expiry: "all", width: "99", day: "nope", junk: "x" })).toEqual({
      expiry: "all",
      width: "10",
      day: "2026-06-05",
    });
    expect(effectiveControlValues(undefined, { expiry: "all" })).toEqual({});
    expect(controlDefault(WIDTH)).toBe("5");
  });
});

describe("substitution — the drill-key rule, per source type", () => {
  it("a FILE value is one safe path component", () => {
    const r = substituteControls({ type: "file", path: ".sb-views/gamma/book-{expiry}.json" }, { expiry: "all" }, DEPS);
    expect(r).toEqual({ source: { type: "file", path: ".sb-views/gamma/book-all.json" }, error: null });
    const spaced = substituteControls({ type: "file", path: "x/{e}.json" }, { e: "front month/2" }, DEPS);
    expect(spaced.source).toEqual({ type: "file", path: "x/front_month_2.json" });
  });

  it("REFUSES a value that cannot be a component — nothing is read, the error names it", () => {
    for (const bad of ["..", ".", "   "]) {
      const r = substituteControls({ type: "file", path: "x/{e}.json" }, { e: bad }, DEPS);
      expect(r.source).toBeNull();
      expect(r.error).toMatch(/cannot name a file/);
    }
  });

  it("a QUERY value is URL-encoded in the url, JSON-escaped in the body, and the loopback rule is re-checked after", () => {
    const r = substituteControls(
      { type: "query", url: "http://127.0.0.1:8799/book?expiry={expiry}", body: '{"e":"{expiry}"}' },
      { expiry: 'front month & "x"\\' },
      DEPS
    );
    expect(r.source).toEqual({
      type: "query",
      url: "http://127.0.0.1:8799/book?expiry=front%20month%20%26%20%22x%22%5C",
      // Review of 9605373, #2: the body is JSON — `front month`, not `front%20month`.
      body: '{"e":"front month & \\"x\\"\\\\"}',
    });
    expect(JSON.parse(r.source?.type === "query" ? r.source.body ?? "" : "")).toEqual({ e: 'front month & "x"\\' });
    expect(jsonStringEscape('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    // A value in the authority slot: encoded, so it cannot become userinfo —
    // and the re-check refuses what is not a literal loopback.
    const hop = substituteControls({ type: "query", url: "http://{host}/rows" }, { host: "evil.com" }, DEPS);
    expect(hop.error).toMatch(/not a local backend/);
  });

  it("a placeholder no value names is an ERROR, never a literal read — `{key}` in a main source included", () => {
    expect(substituteControls({ type: "file", path: "x/{nope}.json" }, {}, DEPS).error).toMatch(/\{nope\}/);
    expect(substituteControls({ type: "file", path: "x/{key}.json" }, {}, DEPS).error).toMatch(/\{key\}/);
    expect(substituteControls({ type: "query", url: "http://127.0.0.1/x?a={b}" }, {}, DEPS).error).toMatch(/\{b\}/);
    // …unless the caller leaves it for itself (a drill template's key).
    const kept = substituteControls({ type: "file", path: "x/{key}-{e}.json" }, { e: "all" }, DEPS, ["key"]);
    expect(kept.source).toEqual({ type: "file", path: "x/{key}-all.json" });
  });

  it("a source with no placeholders resolves to itself", () => {
    expect(substituteControls({ type: "file", path: "rows.json" }, {}, DEPS).source).toEqual({ type: "file", path: "rows.json" });
  });

  it("placeholdersIn reads the name grammar only", () => {
    expect(placeholdersIn('a/{expiry}/{expiry}-{w}.json {"x":1} {2026} {Upper}')).toEqual(["expiry", "w"]);
  });
});

describe("review of 9605373 — the value cap and the note setting", () => {
  it("#7: a number whose PLAIN form exceeds the value cap is not a value", () => {
    const big: ViewControl = { name: "n", kind: "number", default: 1 };
    expect(normalizeControlValue(big, "1e70")).toBeNull(); // 71 digits
    expect(normalizeControlValue(big, "1e20")).toBe("100000000000000000000");
    expect(normalizeControlValue(big, "1e-70")).toBeNull();
    // A control whose default (or bound) cannot print within the cap drops.
    expect(parseViewControls([{ name: "n", kind: "number", default: 1e70 }])).toEqual([]);
    expect(parseViewControls([{ name: "n", kind: "number", default: 1, max: 1e70 }])).toEqual([]);
    expect(parseViewControls([{ name: "n", kind: "number", default: 1, max: 1e60 }])).toHaveLength(1);
    // A clamp keeps a huge typed value inside the fitting bound.
    const bounded: ViewControl = { name: "n", kind: "number", default: 1, max: 100 };
    expect(normalizeControlValue(bounded, "1e60")).toBe("100");
    expect(formatControlNumber(1e60).length).toBeLessThanOrEqual(CONTROL_VALUE_CAP);
  });

  it("#3: a note's setting is empty at the defaults (old notes.json reads as before), else the values", () => {
    expect(noteSettingKey({ expiry: "front" }, [EXPIRY])).toBe("");
    expect(noteSettingKey(null, [EXPIRY])).toBe("");
    expect(noteSettingKey({ expiry: "all" }, [EXPIRY])).toBe("expiry=all");
    expect(noteSettingKey({ expiry: "all", width: "5" }, [EXPIRY, WIDTH])).toBe("expiry=all&width=5");
    // A name no control declares is ignored.
    expect(noteSettingKey({ expiry: "front", junk: "x" }, [EXPIRY])).toBe("");
  });
});

describe("the pin scope and the artifact gate", () => {
  it("control values join the scope AFTER the filter suffix, sorted, defaults included", () => {
    const scope = `${viewPinScope({ day: "2026-06-05" }, "MNQ")}${controlPinScope({ width: "5", expiry: "all" })}`;
    expect(scope).toBe("/MNQ?day=2026-06-05|expiry=all&width=5");
    // A view with no controls keeps its pre-SWIT-111 key.
    expect(controlPinScope({})).toBe("");
    expect(controlPinScope(null)).toBe("");
    // Two settings, two scopes.
    expect(controlPinScope({ expiry: "front" })).not.toBe(controlPinScope({ expiry: "all" }));
  });

  it("controlValuesKey is stable under insertion order", () => {
    expect(controlValuesKey({ b: "2", a: "1" })).toBe(controlValuesKey({ a: "1", b: "2" }));
  });

  it("sanitizeControlValues keeps names by the rule and short string values, capped", () => {
    expect(sanitizeControlValues({ expiry: "all", key: "x", Bad: "y", n: 3, long: "x".repeat(65) })).toEqual({ expiry: "all" });
    expect(sanitizeControlValues({})).toBeNull();
    expect(sanitizeControlValues("nope")).toBeNull();
    const five = sanitizeControlValues({ a: "1", b: "2", c: "3", d: "4", e: "5" });
    expect(Object.keys(five ?? {})).toHaveLength(CONTROL_CAP);
  });
});

describe("keep and the spec disclosure", () => {
  it("controlsAtValues writes the applied value as each default (a number stays a number)", () => {
    expect(controlsAtValues([EXPIRY, WIDTH, DAY], { expiry: "all", width: "8", day: "bad" })).toEqual([
      { ...EXPIRY, default: "all" },
      { ...WIDTH, default: 8 },
      DAY,
    ]);
  });

  it("controlLine prints the value in force and the range", () => {
    expect(controlLine(EXPIRY, "all")).toBe("expiry = all [front · all]");
    expect(controlLine(WIDTH)).toBe("width = 5 [1–10 step 1]");
    expect(controlLine({ ...DAY, label: "Session" })).toBe("Session (day) = 2026-06-05 [date]");
    expect(controlLine({ name: "n", kind: "number", default: 2 })).toBe("n = 2 [number]");
  });
});
