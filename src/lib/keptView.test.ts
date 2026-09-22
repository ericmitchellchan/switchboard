import { describe, expect, it } from "vitest";
import { parseKeptView } from "./keptView";

const VALID_SPEC = {
  id: "trades-daily",
  kind: "table",
  title: "Daily trades",
  source: { type: "file", path: "trades.json" },
  builtAt: "2026-09-20T12:00:00.000Z",
  builtBy: "agent",
};

function keptFile(overrides: Partial<{ spec: unknown; rows: unknown; meta: unknown }> = {}): string {
  const body: Record<string, unknown> = { spec: VALID_SPEC, rows: [{ a: 1 }, { a: 2 }] };
  if ("spec" in overrides) body.spec = overrides.spec;
  if ("rows" in overrides) body.rows = overrides.rows;
  if ("meta" in overrides) body.meta = overrides.meta;
  return JSON.stringify(body);
}

describe("parseKeptView", () => {
  it("parses the exact shape keep() writes — {spec, rows}, no meta", () => {
    const result = parseKeptView(keptFile());
    expect(result.error).toBeNull();
    expect(result.view?.spec.id).toBe("trades-daily");
    expect(result.view?.spec.kind).toBe("table");
    expect(result.view?.rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(result.view?.meta).toBeNull();
  });

  it("carries an optional meta object through, tolerantly", () => {
    const result = parseKeptView(keptFile({ meta: { coverage: "full tape" } }));
    expect(result.view?.meta).toEqual({ coverage: "full tape" });
  });

  it("defaults rows to [] when the key is absent (still renders — an empty view)", () => {
    const result = parseKeptView(JSON.stringify({ spec: VALID_SPEC }));
    expect(result.error).toBeNull();
    expect(result.view?.rows).toEqual([]);
  });

  it("empty content is a named error, never a throw", () => {
    expect(parseKeptView("").error).toMatch(/empty/);
    expect(parseKeptView("   ").error).toMatch(/empty/);
  });

  it("invalid JSON is a named error, never a throw", () => {
    expect(parseKeptView("{not json")?.error).toMatch(/not valid JSON/);
  });

  it("a report spec is refused by name — a document, not a snapshot", () => {
    const raw = JSON.stringify({
      spec: {
        id: "r1",
        kind: "report",
        title: "weekly",
        source: { type: "file", path: "weekly.md" },
        builtAt: "2026-09-22T00:00:00.000Z",
        builtBy: "agent",
      },
      rows: [],
    });
    const out = parseKeptView(raw);
    expect(out.view).toBeNull();
    expect(out.error).toMatch(/report cannot be kept/);
  });

  it("a non-object body is refused", () => {
    expect(parseKeptView("[1,2,3]").error).toMatch(/not an object/);
    expect(parseKeptView('"just a string"').error).toMatch(/not an object/);
  });

  it("a missing spec key is a named error", () => {
    expect(parseKeptView(JSON.stringify({ rows: [] })).error).toMatch(/missing "spec"/);
  });

  it("a malformed spec (bad kind) surfaces parseViewSpec's own error", () => {
    const result = parseKeptView(keptFile({ spec: { ...VALID_SPEC, kind: "not-a-kind" } }));
    expect(result.view).toBeNull();
    expect(result.error).toMatch(/unknown view kind/);
  });

  it("a spec with no id surfaces parseViewSpec's own error", () => {
    const { id: _id, ...noId } = VALID_SPEC;
    const result = parseKeptView(keptFile({ spec: noId }));
    expect(result.error).toMatch(/no id/);
  });

  it("rows that is not an array is refused, not silently emptied", () => {
    const result = parseKeptView(keptFile({ rows: "not-an-array" }));
    expect(result.view).toBeNull();
    expect(result.error).toMatch(/"rows" is not an array/);
  });

  it("non-object row entries drop, the rest survive (parseViewPayload's own rule)", () => {
    const result = parseKeptView(keptFile({ rows: [{ a: 1 }, "junk", 5, { a: 2 }] }));
    expect(result.view?.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("round-trips a real view spec's optional fields (filters, drill, tones)", () => {
    const rich = {
      ...VALID_SPEC,
      kind: "bar",
      valueColumn: "count",
      definition: "one bar per setup",
      filters: [{ column: "setup", kind: "select" }],
      tone: "sign",
    };
    const result = parseKeptView(keptFile({ spec: rich }));
    expect(result.error).toBeNull();
    expect(result.view?.spec.kind).toBe("bar");
    expect(result.view?.spec.valueColumn).toBe("count");
    expect(result.view?.spec.definition).toBe("one bar per setup");
    expect(result.view?.spec.filters).toEqual([{ column: "setup", kind: "select" }]);
    expect(result.view?.spec.tone).toBe("sign");
  });
});
