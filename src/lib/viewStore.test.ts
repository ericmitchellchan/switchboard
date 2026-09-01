// View data layer (SWIT-50): tolerant spec/row parses, windowing, anchor
// keys, the candle/dist row mappings — and the freeze-rule import tripwire
// (same guarantee as pageStore's).

import { describe, it, expect, afterEach } from "vitest";
// eslint-disable-next-line import/no-duplicates
import viewStoreSource from "./viewStore.ts?raw";
// @ts-expect-error — no @types/node in the frontend tsconfig; vitest's node
// runtime provides the real module (the T6 smoke test reads the repo's
// gitignored .sb-views/ through it).
import { createRequire } from "node:module";
import {
  parseViewSpec,
  parseViewRows,
  windowRows,
  rowAnchorId,
  tableColumns,
  toOhlcRows,
  toDistBins,
  VIEW_ROW_WINDOW,
  VIEW_DEFINITION_CAP,
  VIEW_FILTER_CAP,
  parseViewFilters,
  parseViewDrill,
  dateKeyOf,
  filterValues,
  applyFilters,
  viewPinScope,
  drillPathKey,
  drillKeyForAnchor,
  markerAtBar,
  resolveDrill,
  isLocalBackendUrl,
  drillFallbackSentence,
  specLines,
} from "./viewStore";
import type { ViewSpec } from "./viewStore";
import { viewPinTargetFor } from "./pins";

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

  it("a NON-loopback query url is refused at the READER too (review — the spec is a plain file)", () => {
    const { spec, specError } = parseViewSpec(
      JSON.stringify({
        id: "v9",
        kind: "table",
        title: "t",
        source: { type: "query", url: "https://evil.example/rows" },
      })
    );
    expect(spec).toBeNull();
    expect(specError).toMatch(/not a local backend/);
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

// ── T6 (SWIT-60): definition · filters · drill ───────────────────────────────

const T6_SPEC: ViewSpec = {
  id: "setups",
  kind: "table",
  title: "Setup table",
  source: { type: "file", path: "out/setups.json" },
  columns: ["situation", "day", "n", "net"],
  keyColumn: "situation",
  builtAt: "2026-08-31T10:00:00Z",
  builtBy: "agent",
  definition: "a setup is a 1m window whose close broke the prior 20-bar range",
  filters: [
    { column: "sym", kind: "select", label: "instrument" },
    { column: "day", kind: "date" },
  ],
  drill: {
    kind: "table",
    title: "{key} instances",
    source: { type: "file", path: "out/setups/{key}.json" },
    columns: ["ts", "ret"],
    keyColumn: "ts",
    definition: "each row is one window that matched the setup",
  },
};

const T6_ROWS = [
  { situation: "MNQ short flat", sym: "MNQ", day: "2026-06-05T09:31:00Z", n: 3, net: 12 },
  { situation: "MNQ long", sym: "MNQ", day: "2026-06-05T13:05:00Z", n: 5, net: -4 },
  { situation: "ES long", sym: "ES", day: 1781308800, n: 2, net: 7 }, // 2026-06-13 epoch seconds
  { situation: "no day", sym: "ES", n: 1, net: 0 },
];

describe("T6 — spec parse of definition / filters / drill", () => {
  it("round-trips the three fields, tolerantly (missing = none; malformed = absent)", () => {
    const { spec, specError } = parseViewSpec(JSON.stringify(T6_SPEC));
    expect(specError).toBeNull();
    expect(spec?.definition).toBe(T6_SPEC.definition);
    expect(spec?.filters).toEqual(T6_SPEC.filters);
    expect(spec?.drill).toEqual(T6_SPEC.drill);
    const bare = parseViewSpec(JSON.stringify({ ...T6_SPEC, definition: undefined, filters: undefined, drill: undefined }));
    expect(bare.spec?.definition).toBeUndefined();
    expect(bare.spec?.filters).toBeUndefined();
    expect(bare.spec?.drill).toBeUndefined();
    // A malformed drill must not take the parent with it.
    const bad = parseViewSpec(JSON.stringify({ ...T6_SPEC, drill: { kind: "pie", source: { type: "file", path: "x" } } }));
    expect(bad.specError).toBeNull();
    expect(bad.spec?.drill).toBeUndefined();
  });

  it("caps: definition trimmed to the cap; filters capped, deduped, bad kinds dropped", () => {
    const { spec } = parseViewSpec(JSON.stringify({ ...T6_SPEC, definition: "x".repeat(VIEW_DEFINITION_CAP + 50) }));
    expect(spec?.definition).toHaveLength(VIEW_DEFINITION_CAP);
    const filters = parseViewFilters([
      { column: "a", kind: "select" },
      { column: "a", kind: "date" }, // repeat → dropped
      { column: "b", kind: "range" }, // unknown kind → dropped
      { column: "c", kind: "date", label: "  day " },
      { column: "d", kind: "select" },
      { column: "e", kind: "select" },
      { column: "f", kind: "select" }, // past the cap
    ]);
    expect(filters.map((f) => f.column)).toEqual(["a", "c", "d", "e"]);
    expect(filters).toHaveLength(VIEW_FILTER_CAP);
    expect(filters[1].label).toBe("day");
  });

  it("a drill whose query template is not a literal loopback host is absent at the READER", () => {
    expect(parseViewDrill({ kind: "table", title: "t", source: { type: "query", url: "http://{key}/rows" } })).toBeNull();
    expect(parseViewDrill({ kind: "table", title: "t", source: { type: "query", url: "https://evil.example/{key}" } })).toBeNull();
    expect(
      parseViewDrill({ kind: "table", title: "t", source: { type: "query", url: "http://127.0.0.1:8799/setups/{key}" } })
    ).toMatchObject({ kind: "table", source: { type: "query", url: "http://127.0.0.1:8799/setups/{key}" } });
  });
});

describe("T6 — client-side filters", () => {
  it("dateKeyOf reads ISO strings, bare days and epoch seconds; anything else is null", () => {
    expect(dateKeyOf("2026-06-05T09:31:00Z")).toBe("2026-06-05");
    expect(dateKeyOf("2026-06-05")).toBe("2026-06-05");
    expect(dateKeyOf(1781308800)).toBe("2026-06-13");
    expect(dateKeyOf("MNQ")).toBeNull();
    expect(dateKeyOf(3)).toBe("1970-01-01"); // an epoch, honestly
    expect(dateKeyOf(null)).toBeNull();
  });

  it("distinct values come from the loaded rows: select = the cell, date = the day", () => {
    expect(filterValues(T6_ROWS, T6_SPEC.filters![0])).toEqual(["ES", "MNQ"]);
    expect(filterValues(T6_ROWS, T6_SPEC.filters![1])).toEqual(["2026-06-05", "2026-06-13"]);
  });

  it("applyFilters slices client-side, ANDs across filters, and is identity when nothing is active", () => {
    expect(applyFilters(T6_ROWS, T6_SPEC.filters, {})).toBe(T6_ROWS);
    expect(applyFilters(T6_ROWS, T6_SPEC.filters, { sym: "" })).toBe(T6_ROWS);
    expect(applyFilters(T6_ROWS, T6_SPEC.filters, { sym: "MNQ" }).map((r) => r.situation)).toEqual([
      "MNQ short flat",
      "MNQ long",
    ]);
    expect(applyFilters(T6_ROWS, T6_SPEC.filters, { day: "2026-06-13" }).map((r) => r.situation)).toEqual(["ES long"]);
    expect(applyFilters(T6_ROWS, T6_SPEC.filters, { sym: "ES", day: "2026-06-05" })).toEqual([]);
    // No declared filters → untouched, whatever is "active".
    expect(applyFilters(T6_ROWS, undefined, { sym: "MNQ" })).toBe(T6_ROWS);
  });

  it("the active filter is part of the PIN SCOPE — a pin on one date is filed under that date", () => {
    expect(viewPinScope({})).toBe("");
    expect(viewPinScope({ sym: "" })).toBe("");
    expect(viewPinScope({ day: "2026-06-05" })).toBe("?day=2026-06-05");
    // Stable regardless of insertion order; values encoded.
    expect(viewPinScope({ sym: "MNQ", day: "2026-06-05" })).toBe(viewPinScope({ day: "2026-06-05", sym: "MNQ" }));
    expect(viewPinScope({ sym: "MNQ short flat" })).toBe("?sym=MNQ%20short%20flat");
    // A drilled child scopes by its key first.
    expect(viewPinScope({ day: "2026-06-05" }, "MNQ long")).toBe("/MNQ%20long?day=2026-06-05");
    // ...and the pin target's doc key carries it verbatim; empty scope = the pre-T6 key.
    expect(viewPinTargetFor("lodestar", "t1", "v1").docKey).toBe("view:t1:v1");
    expect(viewPinTargetFor("lodestar", "t1", "v1", "?day=2026-06-05").docKey).toBe("view:t1:v1?day=2026-06-05");
  });
});

describe("isLocalBackendUrl — a real parse, not a prefix", () => {
  it("accepts the three loopback spellings, with or without a port, either scheme", () => {
    expect(isLocalBackendUrl("http://127.0.0.1:8799/api/bars")).toBe(true);
    expect(isLocalBackendUrl("http://localhost")).toBe(true);
    expect(isLocalBackendUrl("https://localhost:8443/x?k=v")).toBe(true);
    expect(isLocalBackendUrl("http://[::1]:8799/rows")).toBe(true);
  });

  it("REFUSES the userinfo bypass: `localhost:1234@evil.com` is a credential, not a host", () => {
    expect(isLocalBackendUrl("http://localhost:1234@evil.com/x")).toBe(false);
    expect(isLocalBackendUrl("http://127.0.0.1@evil.com/")).toBe(false);
    expect(isLocalBackendUrl("http://user:pw@localhost:8799/")).toBe(false);
  });

  it("refuses a non-loopback host, a look-alike, a non-http scheme and an unparseable string", () => {
    expect(isLocalBackendUrl("https://evil.example/x")).toBe(false);
    expect(isLocalBackendUrl("http://127.0.0.1.evil.com/")).toBe(false);
    expect(isLocalBackendUrl("http://localhost.evil.com/")).toBe(false);
    expect(isLocalBackendUrl("ws://localhost:8799/")).toBe(false);
    expect(isLocalBackendUrl("file:///C:/x")).toBe(false);
    expect(isLocalBackendUrl("localhost:8799")).toBe(false);
    expect(isLocalBackendUrl("not a url")).toBe(false);
    expect(isLocalBackendUrl("")).toBe(false);
  });

  it("the reader refuses a spec whose query url smuggles a host through userinfo", () => {
    const raw = JSON.stringify({
      id: "q", kind: "table", title: "q", builtAt: "2026-09-01T10:00:00Z", builtBy: "agent",
      source: { type: "query", url: "http://localhost:1234@evil.com/x" },
    });
    const r = parseViewSpec(raw);
    expect(r.spec).toBeNull();
    expect(r.specError).toMatch(/not a local backend/);
  });
});

describe("T6 — drill resolution", () => {
  it("drillPathKey makes ONE path component out of any key, and refuses what cannot be one", () => {
    expect(drillPathKey("MNQ short flat")).toBe("MNQ_short_flat");
    expect(drillPathKey("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(drillPathKey("C:\\Windows")).toBe("C__Windows");
    expect(drillPathKey("..")).toBeNull();
    expect(drillPathKey(".")).toBeNull();
    expect(drillPathKey("   ")).toBeNull();
    expect(drillPathKey("a/b")).toBe("a_b");
  });

  it("resolves a file template: {key} → the path component; title gets the raw key; child inherits build", () => {
    const r = resolveDrill(T6_SPEC, "MNQ short flat");
    expect(r.error).toBeNull();
    expect(r.spec).toMatchObject({
      id: "setups~MNQ_short_flat",
      kind: "table",
      title: "MNQ short flat instances",
      source: { type: "file", path: "out/setups/MNQ_short_flat.json" },
      columns: ["ts", "ret"],
      keyColumn: "ts",
      definition: "each row is one window that matched the setup",
      builtAt: T6_SPEC.builtAt,
    });
    // A child declares no drill of its own — one level down, then → thread.
    expect(r.spec?.drill).toBeUndefined();
  });

  it("REFUSES a key that would escape: the component form cannot carry a separator, and a bare .. is refused outright", () => {
    const dots = resolveDrill(T6_SPEC, "..");
    expect(dots.spec).toBeNull();
    expect(dots.error).toMatch(/cannot name a file/);
    // A traversal attempt is neutralised into a plain component, never a hop.
    const hop = resolveDrill(T6_SPEC, "../../secrets");
    expect(hop.spec?.source).toEqual({ type: "file", path: "out/setups/.._.._secrets.json" });
    expect(resolveDrill(T6_SPEC, "").error).toMatch(/empty/);
    expect(resolveDrill(T6_SPEC, "x".repeat(200)).error).toMatch(/too long/);
    expect(resolveDrill({ ...T6_SPEC, drill: undefined }, "k").error).toMatch(/declares no drill/);
  });

  it("resolves a query template: {key} URL-encoded in url and body; loopback re-checked", () => {
    const q: ViewSpec = {
      ...T6_SPEC,
      drill: {
        kind: "candles",
        title: "{key}",
        source: { type: "query", url: "http://127.0.0.1:8799/setups?k={key}", body: '{"setup":"{key}"}' },
      },
    };
    const r = resolveDrill(q, "MNQ short/flat&x");
    expect(r.spec?.source).toEqual({
      type: "query",
      url: "http://127.0.0.1:8799/setups?k=MNQ%20short%2Fflat%26x",
      body: '{"setup":"MNQ%20short%2Fflat%26x"}',
    });
  });

  it("drillKeyForAnchor: row → the key value; bin → the bin's label; bar → the marker on it, else the bar", () => {
    expect(drillKeyForAnchor("row:MNQ long", { rows: T6_ROWS, spec: T6_SPEC })).toEqual({ key: "MNQ long", label: "MNQ long" });
    const distSpec = { ...T6_SPEC, kind: "dist" as const, keyColumn: "hour", columns: undefined };
    const distRows = [
      { hour: "09", count: 4 },
      { hour: "10", count: 7 },
    ];
    expect(drillKeyForAnchor("bin:1", { rows: distRows, spec: distSpec })).toEqual({ key: "10", label: "10" });
    expect(drillKeyForAnchor("bin:9", { rows: distRows, spec: distSpec })).toBeNull();
    const bars = [
      { ts: "2026-08-31T10:34:00Z", open: 1, high: 2, low: 1, close: 2 },
      { ts: "2026-08-31T10:35:00Z", open: 1, high: 2, low: 1, close: 2 },
      { ts: "2026-08-31T10:36:00Z", open: 1, high: 2, low: 1, close: 2 },
    ];
    const candleSpec: ViewSpec = {
      ...T6_SPEC,
      kind: "candles",
      markers: [{ ts: "2026-08-31T10:35:20Z", label: "entry", id: "t-41" }],
    };
    expect(drillKeyForAnchor("bar:2026-08-31T10:35:00Z", { rows: bars, spec: candleSpec })).toEqual({ key: "t-41", label: "entry" });
    expect(drillKeyForAnchor("bar:2026-08-31T10:34:00Z", { rows: bars, spec: candleSpec })).toEqual({
      key: "2026-08-31T10:34:00Z",
      label: "2026-08-31T10:34:00Z",
    });
    expect(markerAtBar(bars, candleSpec.markers!, "2026-08-31T10:36:00Z")).toBeNull();
    expect(drillKeyForAnchor("trade:9", { rows: T6_ROWS, spec: T6_SPEC })).toBeNull();
  });

  it("the no-drill fallback sentence and the spec lines are plain text", () => {
    expect(drillFallbackSentence("Setup table", "MNQ long")).toBe("show me what is behind Setup table › MNQ long");
    const lines = specLines(T6_SPEC);
    expect(lines[0]).toBe("kind      table");
    expect(lines).toContainEqual(expect.stringMatching(/^source {4}file out\/setups\.json$/));
    expect(lines).toContainEqual(expect.stringMatching(/^filters {3}instrument \(select\) · day \(date\)$/));
    expect(lines).toContainEqual(expect.stringMatching(/^drill {5}table \{key\} instances ← out\/setups\/\{key\}\.json$/));
    expect(lines).toContainEqual(expect.stringMatching(/^defines {3}a setup is/));
  });
});

// ── T6 smoke: a REAL setup-table → per-setup child file resolves on disk ─────
// The repo's `.sb-views/` is gitignored; this writes a tiny parent + child
// there and proves the pure path end to end: parse → resolveDrill → the
// child's path → read → rows. The Rust guard is not exercised (no Tauri
// here) — it stays the last line, this is the resolver's honesty.
describe("T6 smoke — setup table → per-setup instances, from files in .sb-views/", () => {
  const nodeRequire = createRequire(import.meta.url);
  const fs = nodeRequire("node:fs") as {
    mkdirSync: (p: string, o: { recursive: boolean }) => void;
    writeFileSync: (p: string, c: string) => void;
    readFileSync: (p: string, e: string) => string;
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void;
  };
  const pathMod = nodeRequire("node:path") as { join: (...p: string[]) => string; resolve: (...p: string[]) => string };
  const cwd = pathMod.resolve(".sb-views", "t6-smoke");
  // Cleanup lives here, not at the end of the test body: a failing expect
  // must not strand `.sb-views/t6-smoke/` in the checkout.
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it("resolves and reads the child the agent would have written", () => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.mkdirSync(pathMod.join(cwd, "setups"), { recursive: true });
    const parentSpec = {
      id: "setups",
      kind: "table",
      title: "Setup table",
      source: { type: "file", path: "setups.json" },
      columns: ["situation", "n"],
      keyColumn: "situation",
      builtAt: "2026-09-01T10:00:00Z",
      builtBy: "agent",
      definition: "a setup is a 1m close outside the prior 20-bar range",
      drill: {
        kind: "table",
        title: "{key} — instances",
        source: { type: "file", path: "setups/{key}.json" },
        columns: ["ts", "ret"],
        keyColumn: "ts",
      },
    };
    fs.writeFileSync(pathMod.join(cwd, "views-setups.json"), JSON.stringify(parentSpec));
    fs.writeFileSync(
      pathMod.join(cwd, "setups.json"),
      JSON.stringify([
        { situation: "MNQ short flat", n: 2 },
        { situation: "ES long", n: 1 },
      ])
    );
    fs.writeFileSync(
      pathMod.join(cwd, "setups", "MNQ_short_flat.json"),
      JSON.stringify([
        { ts: "2026-06-05T09:31:00Z", ret: 0.4 },
        { ts: "2026-06-05T13:05:00Z", ret: -0.1 },
      ])
    );
    fs.writeFileSync(pathMod.join(cwd, "setups", "ES_long.json"), JSON.stringify([{ ts: "2026-06-13T10:00:00Z", ret: 1.2 }]));

    const parsed = parseViewSpec(fs.readFileSync(pathMod.join(cwd, "views-setups.json"), "utf8"));
    expect(parsed.specError).toBeNull();
    const parent = parsed.spec!;
    const rows = parseViewRows(fs.readFileSync(pathMod.join(cwd, parent.source.type === "file" ? parent.source.path : ""), "utf8"))!;
    // Open the first row the way the table does: its anchor → key → child.
    const anchor = `row:${rowAnchorId(rows[0], parent)}`;
    const hit = drillKeyForAnchor(anchor, { rows, spec: parent })!;
    expect(hit.key).toBe("MNQ short flat");
    const child = resolveDrill(parent, hit.key);
    expect(child.error).toBeNull();
    expect(child.spec!.source).toEqual({ type: "file", path: "setups/MNQ_short_flat.json" });
    const childRows = parseViewRows(fs.readFileSync(pathMod.join(cwd, "setups/MNQ_short_flat.json"), "utf8"));
    expect(childRows).toHaveLength(2);
    expect(tableColumns(childRows!, child.spec!)).toEqual(["ts", "ret"]);
    // The second row too, and the pin scope of the child names the key.
    const second = resolveDrill(parent, rowAnchorId(rows[1], parent)!);
    expect(parseViewRows(fs.readFileSync(pathMod.join(cwd, (second.spec!.source as { path: string }).path), "utf8"))).toHaveLength(1);
    expect(viewPinScope({}, hit.key)).toBe("/MNQ%20short%20flat");
  });
});
