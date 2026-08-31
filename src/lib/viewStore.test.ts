// View data layer (SWIT-50): tolerant spec/row parses, windowing, anchor
// keys, the candle/dist row mappings — and the freeze-rule import tripwire
// (same guarantee as pageStore's).

import { describe, it, expect } from "vitest";
// eslint-disable-next-line import/no-duplicates
import viewStoreSource from "./viewStore.ts?raw";
import {
  parseViewSpec,
  parseViewRows,
  windowRows,
  rowAnchorId,
  tableColumns,
  toOhlcRows,
  toDistBins,
  VIEW_ROW_WINDOW,
} from "./viewStore";
import type { ViewSpec } from "./viewStore";

const SPEC_RAW = JSON.stringify({
  id: "v1",
  kind: "table",
  title: "Setup table",
  source: { type: "file", path: "out/setups.json" },
  columns: ["situation", "n", "net"],
  keyColumn: "situation",
  builtAt: "2026-08-31T10:00:00Z",
  builtBy: "agent",
});

describe("parseViewSpec", () => {
  it("parses a well-formed spec", () => {
    const { spec, specError } = parseViewSpec(SPEC_RAW);
    expect(specError).toBeNull();
    expect(spec).toMatchObject({ id: "v1", kind: "table", keyColumn: "situation" });
  });

  it("names what is wrong instead of throwing", () => {
    expect(parseViewSpec("").specError).toMatch(/missing or empty/);
    expect(parseViewSpec("junk{").specError).toMatch(/not valid JSON/);
    expect(parseViewSpec('{"id":"v1","kind":"pie"}').specError).toMatch(/unknown view kind/);
    expect(parseViewSpec('{"kind":"table"}').specError).toMatch(/no id/);
    expect(parseViewSpec('{"id":"v1","kind":"table","source":{"type":"wat"}}').specError).toMatch(
      /source is malformed/
    );
  });

  it("query sources carry url + optional body", () => {
    const { spec } = parseViewSpec(
      JSON.stringify({
        id: "v2",
        kind: "candles",
        title: "t",
        source: { type: "query", url: "http://127.0.0.1:8799/api/bars", body: '{"symbol":"MNQ"}' },
      })
    );
    expect(spec?.source).toEqual({
      type: "query",
      url: "http://127.0.0.1:8799/api/bars",
      body: '{"symbol":"MNQ"}',
    });
  });
});

describe("parseViewRows / windowRows", () => {
  it("accepts a bare array and the common wrapper shapes; non-objects drop", () => {
    expect(parseViewRows('[{"a":1},2,null,{"b":3}]')).toEqual([{ a: 1 }, { b: 3 }]);
    expect(parseViewRows('{"rows":[{"a":1}]}')).toEqual([{ a: 1 }]);
    expect(parseViewRows('{"data":[{"a":1}]}')).toEqual([{ a: 1 }]);
    expect(parseViewRows('{"nope":1}')).toBeNull();
    expect(parseViewRows("junk")).toBeNull();
    expect(parseViewRows("")).toBeNull();
  });

  it("windows past the cap and says so", () => {
    const rows = Array.from({ length: VIEW_ROW_WINDOW + 20 }, (_, i) => ({ i }));
    const w = windowRows(rows);
    expect(w.rows).toHaveLength(VIEW_ROW_WINDOW);
    expect(w.total).toBe(VIEW_ROW_WINDOW + 20);
    expect(w.windowed).toBe(true);
    expect(windowRows([{ a: 1 }]).windowed).toBe(false);
  });
});

describe("anchors + columns", () => {
  const spec = parseViewSpec(SPEC_RAW).spec as ViewSpec;

  it("rowAnchorId uses the key column; falls back to the first column; null when unusable", () => {
    expect(rowAnchorId({ situation: "MNQ short flat", n: 73 }, spec)).toBe("MNQ short flat");
    const noKey: ViewSpec = { ...spec, keyColumn: undefined, columns: undefined };
    expect(rowAnchorId({ first: "x", second: 2 }, noKey)).toBe("x");
    expect(rowAnchorId({ situation: null }, spec)).toBeNull();
    expect(rowAnchorId({}, { ...spec, keyColumn: undefined, columns: undefined })).toBeNull();
  });

  it("tableColumns prefers the spec's order, else the first row's keys", () => {
    expect(tableColumns([{ z: 1, a: 2 }], spec)).toEqual(["situation", "n", "net"]);
    expect(tableColumns([{ z: 1, a: 2 }], { ...spec, columns: undefined })).toEqual(["z", "a"]);
    expect(tableColumns([], { ...spec, columns: undefined })).toEqual([]);
  });
});

describe("toOhlcRows / toDistBins", () => {
  it("maps ts|time (ISO or epoch seconds) + numeric/numeric-string OHLC; bad rows drop alone", () => {
    const bars = toOhlcRows([
      { ts: "2026-08-31T10:00:00Z", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { time: 1756608000, open: "1", high: "2", low: "0.5", close: "1.5" },
      { ts: "2026-08-31T10:02:00Z", open: "wat", high: 2, low: 1, close: 1 },
      { open: 1, high: 2, low: 1, close: 1 }, // no time
    ]);
    expect(bars).toHaveLength(2);
    expect(bars[0].volume).toBe(10);
    expect(bars[1].open).toBe(1);
  });

  it("toDistBins reads label from the key column and count from a named/first numeric column", () => {
    const spec = { keyColumn: "hour" } as unknown as ViewSpec;
    const bins = toDistBins(
      [
        { hour: "09", count: 4 },
        { hour: "10", n: 7 },
        { hour: "11", pnl: 250.5 },
        { hour: "12" }, // no numeric → drops
      ],
      spec
    );
    expect(bins).toEqual([
      { label: "09", count: 4 },
      { label: "10", count: 7 },
      { label: "11", count: 250.5 },
    ]);
  });
});

describe("the freeze rule is unreachable from here (import graph)", () => {
  it("viewStore imports nothing that can touch the terminal grid", () => {
    const imports = Array.from(
      String(viewStoreSource).matchAll(/^import[^"']*["']([^"']+)["']/gm),
      (m) => m[1]
    );
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(/fitQueue|terminal|resizePolicy|paneLayout/i);
    }
  });
});
