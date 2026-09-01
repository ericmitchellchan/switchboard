// The surface-params shape (T9 — SWIT-63): the one validator every seam
// shares (load gate, identity, `p.*` routes, the Evidence address form).

import { describe, it, expect } from "vitest";
import {
  NO_SURFACE_PARAMS,
  SURFACE_PARAM_MAX_KEYS,
  SURFACE_PARAM_VALUE_MAX,
  encodeSurfaceParams,
  parseSurfaceAddress,
  parseSurfaceQuery,
  sameSurfaceParams,
  sanitizeSurfaceParams,
  surfaceAddress,
  surfaceParamsSuffix,
} from "./surfaceParams";

describe("sanitizeSurfaceParams (tolerant — a stored record)", () => {
  it("keeps valid string pairs and drops the rest one by one", () => {
    expect(
      sanitizeSurfaceParams({
        instrument: "NQ",
        "Bad-Key": "x",
        _leading: "x",
        Upper: "x",
        n: 5,
        empty: "",
        caseId: "c1",
        nested: { a: 1 },
      })
    ).toEqual({ instrument: "NQ", caseId: "c1" });
  });

  it("returns undefined for nothing valid, a non-object, or an array", () => {
    expect(sanitizeSurfaceParams({})).toBeUndefined();
    expect(sanitizeSurfaceParams({ "bad key": "x" })).toBeUndefined();
    expect(sanitizeSurfaceParams(null)).toBeUndefined();
    expect(sanitizeSurfaceParams("instrument=NQ")).toBeUndefined();
    expect(sanitizeSurfaceParams(["a"])).toBeUndefined();
  });

  it("caps the count at SURFACE_PARAM_MAX_KEYS in insertion order and the value length at the cap", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < SURFACE_PARAM_MAX_KEYS + 3; i++) many[`k${i}`] = String(i);
    const kept = sanitizeSurfaceParams(many);
    expect(Object.keys(kept ?? {})).toHaveLength(SURFACE_PARAM_MAX_KEYS);
    expect(Object.keys(kept ?? {})[0]).toBe("k0");
    const long = sanitizeSurfaceParams({ note: "x".repeat(SURFACE_PARAM_VALUE_MAX + 40) });
    expect(long?.note).toHaveLength(SURFACE_PARAM_VALUE_MAX);
  });
});

describe("parseSurfaceQuery (strict — an address)", () => {
  it("parses a plain query, with or without the leading `?`", () => {
    expect(parseSurfaceQuery("instrument=NQ&date=2026-06-05")).toEqual({ instrument: "NQ", date: "2026-06-05" });
    expect(parseSurfaceQuery("?caseId=abc")).toEqual({ caseId: "abc" });
  });

  it("decodes percent-encoding and treats an empty query as no params", () => {
    expect(parseSurfaceQuery("label=hello%20world")).toEqual({ label: "hello world" });
    expect(parseSurfaceQuery("")).toBeUndefined();
    expect(parseSurfaceQuery("?")).toBeUndefined();
  });

  it("is null — the whole thing — on a bad key, an empty value, a repeat, or too many", () => {
    expect(parseSurfaceQuery("instrument=NQ&Bad-Key=1")).toBeNull();
    expect(parseSurfaceQuery("instrument=")).toBeNull();
    expect(parseSurfaceQuery("instrument=NQ&instrument=ES")).toBeNull();
    expect(parseSurfaceQuery(`v=${"x".repeat(SURFACE_PARAM_VALUE_MAX + 1)}`)).toBeNull();
    const many = Array.from({ length: SURFACE_PARAM_MAX_KEYS + 1 }, (_, i) => `k${i}=${i}`).join("&");
    expect(parseSurfaceQuery(many)).toBeNull();
  });
});

describe("encode / suffix / equality", () => {
  it("encodes sorted and URL-safe, so insertion order does not change the identity", () => {
    expect(encodeSurfaceParams({ instrument: "NQ", date: "2026-06-05" })).toBe("date=2026-06-05&instrument=NQ");
    expect(encodeSurfaceParams({ date: "2026-06-05", instrument: "NQ" })).toBe("date=2026-06-05&instrument=NQ");
    expect(encodeSurfaceParams({ label: "a b&c" })).toBe("label=a+b%26c");
    expect(encodeSurfaceParams(undefined)).toBe("");
    expect(encodeSurfaceParams({})).toBe("");
    expect(sameSurfaceParams({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
    expect(sameSurfaceParams({ a: "1" }, undefined)).toBe(false);
    expect(sameSurfaceParams(undefined, NO_SURFACE_PARAMS)).toBe(true);
  });

  it("the suffix prints VALUES in the set's own order, no keys; empty when nothing", () => {
    expect(surfaceParamsSuffix({ instrument: "NQ", date: "2026-06-05" })).toBe(" · NQ 2026-06-05");
    expect(surfaceParamsSuffix(undefined)).toBe("");
    expect(surfaceParamsSuffix({})).toBe("");
  });
});

describe("the Evidence address form `surface:<project>/<page>[?query]`", () => {
  it("resolves to the artifact, params included", () => {
    expect(parseSurfaceAddress("surface:lodestar/trading?instrument=NQ&date=2026-06-05")).toEqual({
      kind: "surface",
      project: "lodestar",
      page: "trading",
      params: { instrument: "NQ", date: "2026-06-05" },
    });
    expect(parseSurfaceAddress("surface:lodestar/trading")).toEqual({
      kind: "surface",
      project: "lodestar",
      page: "trading",
    });
    expect(parseSurfaceAddress("  surface:lodestar/chart?caseId=c1  ")).toMatchObject({ params: { caseId: "c1" } });
  });

  it("is null for every non-surface address and for a surface address with an invalid query", () => {
    expect(parseSurfaceAddress("SWIT-63")).toBeNull();
    expect(parseSurfaceAddress("switchboard #61")).toBeNull();
    expect(parseSurfaceAddress("src/lib/route.ts")).toBeNull();
    expect(parseSurfaceAddress("surface:lodestar")).toBeNull();
    expect(parseSurfaceAddress("surface:lodestar/")).toBeNull();
    expect(parseSurfaceAddress("surface:lodestar/trading/extra")).toBeNull();
    expect(parseSurfaceAddress("surface:lode star/trading")).toBeNull();
    // A bad query makes the WHOLE address a non-link — no half-honoured state.
    expect(parseSurfaceAddress("surface:lodestar/trading?Bad-Key=1")).toBeNull();
    expect(parseSurfaceAddress("surface:lodestar/trading?instrument=")).toBeNull();
  });

  it("round-trips through surfaceAddress (canonical: sorted keys)", () => {
    const a = parseSurfaceAddress("surface:lodestar/trading?instrument=NQ&date=2026-06-05");
    expect(a && surfaceAddress(a)).toBe("surface:lodestar/trading?date=2026-06-05&instrument=NQ");
    expect(surfaceAddress({ kind: "surface", project: "lodestar", page: "trading" })).toBe("surface:lodestar/trading");
  });
});
