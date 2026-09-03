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

// ── python-backed smoke/parity helpers ───────────────────────────────────────
// A fallback (synthetic data, a skipped parity check) is honest ONLY when the
// tooling is absent. Everything else — a traceback, a bad exit, a timeout —
// is a real failure and is rethrown WITH stderr, so it reads as one instead
// of silently becoming synthetic data. (Review finding F2 on T7/T8.)

type SpawnFailure = { code?: unknown; status?: unknown; signal?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown };

/** python itself is missing: spawn ENOENT, or the Windows store-alias stub
 *  (exit 9009, which is also what cmd prints for "not recognized"). */
function isPythonMissing(err: unknown): boolean {
  const e = (err ?? {}) as SpawnFailure;
  return e.code === "ENOENT" || e.status === 9009;
}

/** The DuckDB-backed smokes may also fall back on a
 *  `ModuleNotFoundError: No module named 'duckdb'` on stderr — duckdb is the
 *  one import those scripts need beyond the standard library. */
function isPythonUnavailable(err: unknown): boolean {
  if (isPythonMissing(err)) return true;
  const stderr = typeof (err as SpawnFailure)?.stderr === "string" ? ((err as SpawnFailure).stderr as string) : "";
  return /ModuleNotFoundError: No module named 'duckdb'/.test(stderr);
}

/** One line of what went wrong, stderr included (it was piped, not ignored). */
function describeSpawnError(err: unknown): string {
  const e = (err ?? {}) as SpawnFailure;
  const parts = [
    typeof e.message === "string" ? e.message : String(err),
    e.status !== undefined && e.status !== null ? `exit ${String(e.status)}` : "",
    e.signal ? `signal ${String(e.signal)}` : "",
    typeof e.stderr === "string" && e.stderr.trim() ? `stderr:\n${e.stderr.trim()}` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

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
    // T7: each bin also carries its source `row` (the hover tooltip); the
    // label/count rule is what this asserts.
    expect(bins).toMatchObject([
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

  it("SWIT-73: a report is never a drill target — the drill is ABSENT, not a broken parent", () => {
    expect(
      parseViewDrill({ kind: "report", title: "{key}", source: { type: "file", path: "per/{key}.md" } })
    ).toBeNull();
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
    // A prefix none of the renderers stamp (`trade:` became the timeline's in T8).
    expect(drillKeyForAnchor("nope:9", { rows: T6_ROWS, spec: T6_SPEC })).toBeNull();
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

// ── T7 (SWIT-61): line + bar kinds, the hover's row, the anchors ─────────────

import {
  isViewKind,
  lineSeriesColumns,
  toLinePoints,
  toBarRows,
  barKey,
  pointKey,
  rowForAnchor,
  rowFields,
  isoToSeconds,
  VIEW_KINDS,
  // T8 (SWIT-62)
  parseViewPayload,
  toTimelinePoints,
  markRadius,
  tradeKey,
  timelineNote,
  timelineSide,
  isoToMillis,
  MARK_RADIUS_MIN,
  MARK_RADIUS_MAX,
  TIMELINE_SIZE_DEFAULT,
} from "./viewStore";

const T7_LINE_SPEC: ViewSpec = {
  id: "nq",
  kind: "line",
  title: "NQ daily close",
  source: { type: "file", path: "out/nq.json" },
  builtAt: "2026-09-01T10:00:00Z",
  builtBy: "agent",
  markers: [{ ts: "2026-06-02T00:00:10Z", label: "fomc", id: "m-1" }],
};

const T7_LINE_ROWS = [
  { time: "2026-06-03T00:00:00Z", close: 20100, rsi: "55.5", note: "b" },
  { time: "2026-06-01T00:00:00Z", close: 20000, rsi: 50, note: "a" },
  { time: "2026-06-02T00:00:00Z", close: null, rsi: 52, note: "gap" },
  { time: "2026-06-02T00:00:00Z", close: 20050, rsi: 51, note: "dup wins" },
  { time: 1780704000, close: 20200, rsi: 60 }, // 2026-06-06 epoch seconds
  { close: 1, rsi: 2 }, // no time — drops alone
];

const T7_BAR_SPEC: ViewSpec = {
  id: "setups",
  kind: "bar",
  title: "Windows by setup",
  source: { type: "file", path: "out/setups.json" },
  keyColumn: "setup",
  valueColumn: "n",
  builtAt: "2026-09-01T10:00:00Z",
  builtBy: "agent",
};

const T7_BAR_ROWS = [
  { setup: "@NQ 1m", n: 25733, avg_fwd: 0.01 },
  { setup: "@ES 1m", n: 26074, avg_fwd: -0.02 },
  { setup: "@NQ 1m", n: 1, avg_fwd: 9 }, // duplicate category
  { setup: "bad", n: "not a number" },
];

describe("T7 — kinds + spec round-trip", () => {
  it("line and bar are kinds; unknown is not; the parse round-trips series / valueColumn on spec AND drill", () => {
    expect(VIEW_KINDS).toEqual(["table", "candles", "dist", "line", "bar", "timeline", "report"]);
    expect(isViewKind("line") && isViewKind("bar")).toBe(true);
    expect(isViewKind("pie")).toBe(false);
    const raw = JSON.stringify({
      ...JSON.parse(SPEC_RAW),
      kind: "line",
      series: ["close", 7, ""],
      valueColumn: "n",
      drill: { kind: "bar", title: "{key}", source: { type: "file", path: "per/{key}.json" }, series: ["x"], valueColumn: "v" },
    });
    const { spec, specError } = parseViewSpec(raw);
    expect(specError).toBeNull();
    expect(spec!.kind).toBe("line");
    expect(spec!.series).toEqual(["close"]);
    expect(spec!.valueColumn).toBe("n");
    expect(spec!.drill).toMatchObject({ kind: "bar", series: ["x"], valueColumn: "v" });
    // The child inherits both; specLines prints both.
    const child = resolveDrill(spec!, "k");
    expect(child.spec).toMatchObject({ kind: "bar", series: ["x"], valueColumn: "v" });
    expect(specLines(spec!)).toContainEqual(expect.stringMatching(/^series {4}close$/));
    expect(specLines(spec!)).toContainEqual(expect.stringMatching(/^value {5}n$/));
    // Malformed = absent, never a broken spec.
    const loose = parseViewSpec(JSON.stringify({ ...JSON.parse(SPEC_RAW), kind: "bar", series: "close", valueColumn: 3 }));
    expect(loose.spec!.kind).toBe("bar");
    expect("series" in loose.spec!).toBe(false);
    expect("valueColumn" in loose.spec!).toBe(false);
    expect(parseViewSpec(JSON.stringify({ ...JSON.parse(SPEC_RAW), kind: "pie" })).specError).toMatch(/unknown view kind/);
  });
});

describe("T7 — line: series inference + aligned points", () => {
  it("infers every numeric non-time column (first non-empty cell decides); the spec's list wins", () => {
    expect(lineSeriesColumns(T7_LINE_ROWS, T7_LINE_SPEC)).toEqual(["close", "rsi"]);
    expect(lineSeriesColumns(T7_LINE_ROWS, { ...T7_LINE_SPEC, series: ["rsi"] })).toEqual(["rsi"]);
    expect(lineSeriesColumns([{ ts: "2026-01-01T00:00:00Z", label: "x" }], T7_LINE_SPEC)).toEqual([]);
  });

  it("toLinePoints: ascending unique seconds, ISO kept per point, gaps as null, duplicates last-wins, no-time rows drop", () => {
    const p = toLinePoints(T7_LINE_ROWS, T7_LINE_SPEC);
    expect(p.xs).toEqual([
      isoToSeconds("2026-06-01T00:00:00Z"),
      isoToSeconds("2026-06-02T00:00:00Z"),
      isoToSeconds("2026-06-03T00:00:00Z"),
      1780704000,
    ]);
    expect(p.ts[1]).toBe("2026-06-02T00:00:00Z");
    expect(p.ts[3]).toBe("2026-06-06T00:00:00.000Z");
    expect(p.series.map((s) => s.label)).toEqual(["close", "rsi"]);
    expect(p.series[0].values).toEqual([20000, 20050, 20100, 20200]);
    expect(p.series[1].values).toEqual([50, 51, 55.5, 60]);
    expect(p.rows[1].note).toBe("dup wins");
    // A gap stays a gap when the last row for that second has none.
    const gapped = toLinePoints([T7_LINE_ROWS[1], T7_LINE_ROWS[2]], T7_LINE_SPEC);
    expect(gapped.series[0].values).toEqual([20000, null]);
    // A naive stamp (DuckDB's TIMESTAMP → "YYYY-MM-DD HH:MM:SS") is UTC, like candles.
    expect(isoToSeconds("2026-06-01 00:00:00")).toBe(isoToSeconds("2026-06-01T00:00:00Z"));
    expect(isoToSeconds("nope")).toBeNull();
  });

  it("pt:<iso> resolves like bar:<iso>: the marker on the point, else the point; pointKey builds it", () => {
    expect(pointKey("2026-06-02T00:00:00Z")).toBe("pt:2026-06-02T00:00:00Z");
    const ctx = { rows: T7_LINE_ROWS, spec: T7_LINE_SPEC };
    expect(drillKeyForAnchor("pt:2026-06-02T00:00:00Z", ctx)).toEqual({ key: "m-1", label: "fomc" });
    expect(drillKeyForAnchor("pt:2026-06-03T00:00:00Z", ctx)).toEqual({
      key: "2026-06-03T00:00:00Z",
      label: "2026-06-03T00:00:00Z",
    });
    expect(drillKeyForAnchor("pt:", ctx)).toBeNull();
    // Canvas anchors carry their own readout — no tooltip row.
    expect(rowForAnchor("pt:2026-06-02T00:00:00Z", ctx)).toBeNull();
  });
});

describe("T7 — bar: rows → category bars → anchors", () => {
  it("toBarRows keys on the key column, reads valueColumn, keeps the source row; bad values drop", () => {
    const bars = toBarRows(T7_BAR_ROWS, T7_BAR_SPEC);
    expect(bars.map((b) => [b.key, b.value])).toEqual([
      ["@NQ 1m", 25733],
      ["@ES 1m", 26074],
      ["@NQ 1m", 1],
    ]);
    expect(bars[0].row).toBe(T7_BAR_ROWS[0]);
    expect(barKey("@NQ 1m")).toBe("bar:@NQ 1m");
    // Without valueColumn the dist rule applies (count/n/value by name).
    expect(toBarRows(T7_BAR_ROWS, { ...T7_BAR_SPEC, valueColumn: undefined })[0].value).toBe(25733);
    // valueColumn also steers dist bins now.
    expect(toDistBins(T7_BAR_ROWS, { ...T7_BAR_SPEC, kind: "dist", valueColumn: "avg_fwd" })[0]).toMatchObject({
      label: "@NQ 1m",
      count: 0.01,
    });
  });

  it("bar:<key> is the CATEGORY on a bar view and the CANDLE on candles — the spec's kind decides", () => {
    const ctx = { rows: T7_BAR_ROWS, spec: T7_BAR_SPEC };
    expect(drillKeyForAnchor("bar:@ES 1m", ctx)).toEqual({ key: "@ES 1m", label: "@ES 1m" });
    expect(drillKeyForAnchor("bar:nope", ctx)).toBeNull();
    expect(rowForAnchor("bar:@ES 1m", ctx)).toBe(T7_BAR_ROWS[1]);
    // The FIRST duplicate is the row behind the anchor (the renderer's rule).
    expect(rowForAnchor("bar:@NQ 1m", ctx)).toBe(T7_BAR_ROWS[0]);
    const candleCtx = {
      rows: [{ ts: "2026-08-31T10:34:00Z", open: 1, high: 2, low: 1, close: 2 }],
      spec: { ...T7_BAR_SPEC, kind: "candles" as const },
    };
    expect(drillKeyForAnchor("bar:2026-08-31T10:34:00Z", candleCtx)).toEqual({
      key: "2026-08-31T10:34:00Z",
      label: "2026-08-31T10:34:00Z",
    });
    // The pin scope is kind-agnostic: a bar view's scope is the same string.
    expect(viewPinScope({ setup: "@ES 1m" }, null)).toBe("?setup=%40ES%201m");
  });
});

describe("T7 — the hover tooltip's data", () => {
  it("rowForAnchor finds the row behind row:/bin: anchors; rowFields prints every field in order", () => {
    expect(rowForAnchor("row:MNQ long", { rows: T6_ROWS, spec: T6_SPEC })).toBe(T6_ROWS[1]);
    expect(rowForAnchor("row:nope", { rows: T6_ROWS, spec: T6_SPEC })).toBeNull();
    const distSpec = { ...T6_SPEC, kind: "dist" as const, keyColumn: "hour", columns: undefined };
    const distRows = [
      { hour: "09", count: 4, pct: 0.3 },
      { hour: "10", count: 7, pct: 0.7 },
    ];
    expect(rowForAnchor("bin:1", { rows: distRows, spec: distSpec })).toBe(distRows[1]);
    expect(rowForAnchor("bin:x", { rows: distRows, spec: distSpec })).toBeNull();
    expect(rowFields({ a: 1, b: null, c: "x", d: { k: [1, 2] } })).toEqual([
      ["a", "1"],
      ["b", ""],
      ["c", "x"],
      ["d", '{"k":[1,2]}'],
    ]);
    expect(rowFields({ long: "y".repeat(100) }, 10)[0][1]).toBe("yyyyyyyyy…");
  });
});

// ── T7 smoke: a REAL line + bar from research.duckdb, through the pure path ──
// NQ daily close (from the 1h bars) as a line, pattern-window count by
// symbol·timeframe as bars, written into the gitignored .sb-views/ exactly as
// an agent would write them and read back through parseViewRows + the new
// helpers. DuckDB is reached through python; when python or duckdb or the
// file is missing the rows are SYNTHESISED and the test says so.
describe("T7 smoke — NQ daily close as a line, windows by setup as bars, from research.duckdb", () => {
  const nodeRequire = createRequire(import.meta.url);
  const fs = nodeRequire("node:fs") as {
    mkdirSync: (p: string, o: { recursive: boolean }) => void;
    writeFileSync: (p: string, c: string) => void;
    readFileSync: (p: string, e: string) => string;
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void;
    existsSync: (p: string) => boolean;
  };
  const pathMod = nodeRequire("node:path") as { join: (...p: string[]) => string; resolve: (...p: string[]) => string };
  const cp = nodeRequire("node:child_process") as {
    execFileSync: (f: string, a: string[], o: { encoding: string; timeout: number; stdio: unknown }) => string;
  };
  const cwd = pathMod.resolve(".sb-views", "t7-smoke");
  const DB = "C:/Users/ericm/projects/lodestar/data/research.duckdb";
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  type Payload = { line: Record<string, unknown>[]; bar: Record<string, unknown>[] };
  const fromDuckdb = (): Payload | null => {
    if (!fs.existsSync(DB)) return null;
    const script = [
      "import duckdb, json",
      `c = duckdb.connect(${JSON.stringify(DB)}, read_only=True)`,
      "line = c.execute(\"select strftime(cast(date_trunc('day', ts) as timestamp), '%Y-%m-%d %H:%M:%S') as ts, last(close order by ts) as close, coalesce(avg(rsi), 0) as rsi from bar_features where symbol='@NQ' and timeframe='1h' group by 1 order by 1\").fetchall()",
      "bar = c.execute(\"select symbol || ' ' || timeframe as setup, count(*) as n, coalesce(round(avg(fwd_ret_pct), 4), 0) as avg_fwd from pattern_windows group by 1 order by 1\").fetchall()",
      "print(json.dumps({'line': [{'ts': r[0], 'close': float(r[1]), 'rsi': float(r[2])} for r in line], 'bar': [{'setup': r[0], 'n': int(r[1]), 'avg_fwd': float(r[2])} for r in bar]}))",
    ].join("\n");
    let out: string;
    try {
      out = cp.execFileSync("python", ["-c", script], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      // Synthetic ONLY when the tooling is absent; anything else is a real failure.
      if (isPythonUnavailable(err)) return null;
      throw new Error(`[t7 smoke] python failed: ${describeSpawnError(err)}`);
    }
    const parsed = JSON.parse(out) as Payload;
    if (parsed.line.length === 0 || parsed.bar.length === 0) {
      throw new Error(`[t7 smoke] research.duckdb answered with no rows (line ${parsed.line.length}, bar ${parsed.bar.length})`);
    }
    return parsed;
  };
  const synthetic = (): Payload => ({
    line: Array.from({ length: 30 }, (_, i) => ({
      ts: `2026-06-${String(i + 1).padStart(2, "0")} 00:00:00`,
      close: 20000 + i * 12.5,
      rsi: 50 + (i % 7),
    })),
    bar: ["@ES 15m", "@ES 1h", "@NQ 15m", "@NQ 1h"].map((setup, i) => ({ setup, n: 1000 + i * 137, avg_fwd: 0.01 * i })),
  });

  it("the files an agent would write parse as rows and map to points / bars with anchors", () => {
    const real = fromDuckdb();
    const payload = real ?? synthetic();
    console.info(
      `[t7 smoke] rows from ${real ? "research.duckdb" : "SYNTHETIC data (python/duckdb/db unavailable)"}: line ${payload.line.length}, bar ${payload.bar.length}`
    );
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(pathMod.join(cwd, "nq-daily.json"), JSON.stringify(payload.line));
    fs.writeFileSync(pathMod.join(cwd, "windows-by-setup.json"), JSON.stringify(payload.bar));
    const lineSpecRaw = JSON.stringify({
      id: "nq-daily",
      kind: "line",
      title: "NQ daily close",
      source: { type: "file", path: "nq-daily.json" },
      series: ["close"],
      builtAt: "2026-09-01T10:00:00Z",
      builtBy: "agent",
    });
    const barSpecRaw = JSON.stringify({
      id: "windows",
      kind: "bar",
      title: "Pattern windows by setup",
      source: { type: "file", path: "windows-by-setup.json" },
      keyColumn: "setup",
      valueColumn: "n",
      builtAt: "2026-09-01T10:00:00Z",
      builtBy: "agent",
    });
    fs.writeFileSync(pathMod.join(cwd, "views-nq-daily.json"), lineSpecRaw);
    fs.writeFileSync(pathMod.join(cwd, "views-windows.json"), barSpecRaw);

    const line = parseViewSpec(fs.readFileSync(pathMod.join(cwd, "views-nq-daily.json"), "utf8"));
    expect(line.specError).toBeNull();
    const lineRows = parseViewRows(fs.readFileSync(pathMod.join(cwd, "nq-daily.json"), "utf8"))!;
    expect(lineRows.length).toBe(payload.line.length);
    const points = toLinePoints(lineRows, line.spec!);
    expect(points.xs.length).toBe(lineRows.length);
    for (let i = 1; i < points.xs.length; i++) expect(points.xs[i]).toBeGreaterThan(points.xs[i - 1]);
    expect(points.series.map((s) => s.label)).toEqual(["close"]);
    expect(points.series[0].values.every((v) => typeof v === "number")).toBe(true);
    // Inference without `series` picks close + rsi and nothing else.
    expect(lineSeriesColumns(lineRows, { ...line.spec!, series: undefined })).toEqual(["close", "rsi"]);
    // A point's anchor resolves back to its own day (no markers declared).
    const anchor = pointKey(points.ts[0]);
    expect(drillKeyForAnchor(anchor, { rows: lineRows, spec: line.spec! })).toEqual({ key: points.ts[0], label: points.ts[0] });

    const bar = parseViewSpec(fs.readFileSync(pathMod.join(cwd, "views-windows.json"), "utf8"));
    expect(bar.specError).toBeNull();
    const barRows = parseViewRows(fs.readFileSync(pathMod.join(cwd, "windows-by-setup.json"), "utf8"))!;
    const bars = toBarRows(barRows, bar.spec!);
    expect(bars.length).toBe(payload.bar.length);
    expect(bars.every((b) => Number.isInteger(b.value) && b.value > 0)).toBe(true);
    const first = bars[0];
    expect(drillKeyForAnchor(barKey(first.key), { rows: barRows, spec: bar.spec! })).toEqual({ key: first.key, label: first.key });
    expect(rowFields(rowForAnchor(barKey(first.key), { rows: barRows, spec: bar.spec! })!).map(([k]) => k)).toEqual([
      "setup",
      "n",
      "avg_fwd",
    ]);
    if (real) {
      // Ground truth of the checkout's data: NQ 1h bars span Dec 2022 → Jul 2026.
      expect(points.ts[0].startsWith("2022-12-14")).toBe(true);
      expect(bars.map((b) => b.key)).toContain("@NQ 1m");
    }
  });
});

// ── T8 (SWIT-62): the tennis match timeline ──────────────────────────────────

const T8_SPEC: ViewSpec = {
  id: "match",
  kind: "timeline",
  title: "KXATPCHALLENGERMATCH-26MAR03DIASAI",
  source: { type: "file", path: ".sb-views/tennis/KXATPCHALLENGERMATCH-26MAR03DIASAI.json" },
  builtAt: "2026-09-01T10:00:00Z",
  builtBy: "agent",
};

const T8_ROWS = [
  { ts: "2026-03-03T13:26:17.103", price: 3, size_z: 3.649, count: 1560, backs_player: 2, sets_p1: 1, sets_p2: 0, games_p1: 2, games_p2: 0 },
  { ts: "2026-03-03T13:26:17.503", price: 4, size_z: 1.0, count: 200, backs_player: 1, sets_p1: 1, sets_p2: 0, games_p1: 2, games_p2: 0 },
  { ts: "2026-03-03T13:48:13.467", price: "6", size_z: null, count: 1610, backs_player: "2", sets_p1: 1, sets_p2: 0, games_p1: 2, games_p2: 1 },
  { ts: "2026-03-03T14:07:22.039", price: "n/a", size_z: 4.324, count: 3333, backs_player: 3, sets_p1: 1, sets_p2: 1, games_p1: 0, games_p2: 0 },
  { ts: "2026-03-03T14:07:22.039", price: 1, size_z: 4.324, count: 3333, backs_player: 3, sets_p1: 1, sets_p2: 1, games_p1: 0, games_p2: 0 }, // same ms — last wins
  { ts: "not a time", price: 50, size_z: 9, count: 9 },
];

describe("T8 — timeline: the kind, sizeColumn, the spec lines", () => {
  it("timeline is a kind; sizeColumn parses on spec AND drill, the child inherits it, specLines prints the default", () => {
    expect(isViewKind("timeline")).toBe(true);
    const raw = JSON.stringify({
      ...JSON.parse(SPEC_RAW),
      kind: "table",
      keyColumn: "match_id",
      drill: {
        kind: "timeline",
        title: "{key}",
        source: { type: "file", path: ".sb-views/tennis/{key}.json" },
        sizeColumn: "count",
      },
    });
    const { spec, specError } = parseViewSpec(raw);
    expect(specError).toBeNull();
    expect(spec!.drill).toMatchObject({ kind: "timeline", sizeColumn: "count" });
    const child = resolveDrill(spec!, "KXATPMATCH-26MAR03LANSHI");
    expect(child.spec).toMatchObject({
      kind: "timeline",
      sizeColumn: "count",
      source: { type: "file", path: ".sb-views/tennis/KXATPMATCH-26MAR03LANSHI.json" },
      title: "KXATPMATCH-26MAR03LANSHI",
    });
    expect(specLines(child.spec!)).toContainEqual(expect.stringMatching(/^size {6}count$/));
    // No sizeColumn → the default is printed (the reader's rule is visible).
    expect(specLines(T8_SPEC)).toContainEqual(expect.stringMatching(new RegExp(`^size {6}${TIMELINE_SIZE_DEFAULT}$`)));
    // Not a timeline → no size line at all.
    expect(specLines(spec!).some((l) => l.startsWith("size"))).toBe(false);
    // Malformed sizeColumn = absent.
    const loose = parseViewSpec(JSON.stringify({ ...JSON.parse(SPEC_RAW), kind: "timeline", sizeColumn: 4 }));
    expect(loose.spec!.kind).toBe("timeline");
    expect("sizeColumn" in loose.spec!).toBe(false);
  });

  it("parseViewPayload keeps a meta object beside the rows; a bare array or a non-object meta is meta null", () => {
    const withMeta = parseViewPayload(JSON.stringify({ meta: { coverage: "flagged moments only", n_trades: 6117 }, rows: T8_ROWS }))!;
    expect(withMeta.meta).toEqual({ coverage: "flagged moments only", n_trades: 6117 });
    expect(withMeta.rows.length).toBe(T8_ROWS.length);
    expect(parseViewPayload(JSON.stringify(T8_ROWS))!.meta).toBeNull();
    expect(parseViewPayload(JSON.stringify({ rows: T8_ROWS, meta: "x" }))!.meta).toBeNull();
    expect(parseViewPayload(JSON.stringify({ data: T8_ROWS, meta: { a: 1 } }))!.meta).toEqual({ a: 1 });
    expect(parseViewPayload("{}")).toBeNull();
    // The old entry point is the same parse without the meta.
    expect(parseViewRows(JSON.stringify({ meta: {}, rows: T8_ROWS }))!.length).toBe(T8_ROWS.length);
  });

  it("timelineNote: coverage + total → `N of M trades`; coverage alone → moments; nothing → a bare count that claims nothing", () => {
    expect(timelineNote({ coverage: "flagged moments only", n_trades: 6117 }, 12)).toBe("flagged moments only · 12 of 6117 trades");
    expect(timelineNote({ coverage: " flagged moments only ", n_trades: "6117" }, 12)).toBe("flagged moments only · 12 of 6117 trades");
    expect(timelineNote({ coverage: "flagged moments only" }, 12)).toBe("flagged moments only · 12 moments");
    expect(timelineNote({ n_trades: 6117 }, 12)).toBe("12 moments");
    expect(timelineNote(null, 0)).toBe("0 moments");
  });
});

describe("T8 — timeline: rows → marks, radii, steps, anchors", () => {
  it("toTimelinePoints keeps MILLISECONDS (two trades 400ms apart are two marks), sorts, collapses the same ms last-wins, drops no-time rows", () => {
    const pts = toTimelinePoints(T8_ROWS, T8_SPEC);
    expect(pts.xs.length).toBe(4);
    for (let i = 1; i < pts.xs.length; i++) expect(pts.xs[i]).toBeGreaterThan(pts.xs[i - 1]);
    expect(pts.xs[1] - pts.xs[0]).toBeCloseTo(0.4, 6);
    expect(pts.ts).toEqual([
      "2026-03-03T13:26:17.103",
      "2026-03-03T13:26:17.503",
      "2026-03-03T13:48:13.467",
      "2026-03-03T14:07:22.039",
    ]);
    // A naive stamp is UTC (the candle rule), at millisecond precision.
    expect(isoToMillis("2026-03-03T13:26:17.103")).toBe(Date.parse("2026-03-03T13:26:17.103Z"));
    expect(isoToMillis("garbage")).toBeNull();
    // Price: numeric or numeric string; the same-ms duplicate's LAST row won (price 1, not "n/a").
    expect(pts.price).toEqual([3, 4, 6, 1]);
    expect(pts.rows[3]).toBe(T8_ROWS[4]);
    // Side: 1 → 1, "2" → 2, anything else → null.
    expect(pts.side).toEqual([2, 1, 2, null]);
    expect(timelineSide({ backs_player: "1" })).toBe(1);
    expect(timelineSide({})).toBeNull();
  });

  it("the size column defaults to size_z and follows the spec; radii are clamped to [MIN, MAX] and grow with the value", () => {
    const pts = toTimelinePoints(T8_ROWS, T8_SPEC);
    expect(pts.size).toEqual([3.649, 1.0, null, 4.324]);
    expect(pts.sizeMax).toBe(4.324);
    expect(pts.radius[3]).toBe(MARK_RADIUS_MAX); // the max value draws the largest mark
    expect(pts.radius[2]).toBe(MARK_RADIUS_MIN); // null draws the smallest, never no mark
    expect(pts.radius[1]).toBeLessThan(pts.radius[0]);
    expect(pts.radius[0]).toBeLessThan(pts.radius[3]);
    for (const r of pts.radius) {
      expect(r).toBeGreaterThanOrEqual(MARK_RADIUS_MIN);
      expect(r).toBeLessThanOrEqual(MARK_RADIUS_MAX);
    }
    const byCount = toTimelinePoints(T8_ROWS, { ...T8_SPEC, sizeColumn: "count" });
    expect(byCount.size).toEqual([1560, 200, 1610, 3333]);
    expect(byCount.sizeMax).toBe(3333);
    // markRadius alone: the clamp holds for garbage and for values past the max.
    expect(markRadius(null, 10)).toBe(MARK_RADIUS_MIN);
    expect(markRadius(0, 10)).toBe(MARK_RADIUS_MIN);
    expect(markRadius(-3, 10)).toBe(MARK_RADIUS_MIN);
    expect(markRadius(5, 0)).toBe(MARK_RADIUS_MIN);
    expect(markRadius(10, 10)).toBe(MARK_RADIUS_MAX);
    expect(markRadius(1e9, 10)).toBe(MARK_RADIUS_MAX);
    // sqrt of the share: a quarter of the max sits halfway up the range.
    expect(markRadius(2.5, 10)).toBeCloseTo(MARK_RADIUS_MIN + (MARK_RADIUS_MAX - MARK_RADIUS_MIN) / 2, 9);
  });

  it("the score is STEPS: the four columns per x, gamesMax for the band; absent columns → steps null", () => {
    const pts = toTimelinePoints(T8_ROWS, T8_SPEC);
    expect(pts.steps).not.toBeNull();
    expect(pts.steps!.setsP1).toEqual([1, 1, 1, 1]);
    expect(pts.steps!.setsP2).toEqual([0, 0, 0, 1]);
    expect(pts.steps!.gamesP1).toEqual([2, 2, 2, 0]);
    expect(pts.steps!.gamesP2).toEqual([0, 0, 1, 0]);
    expect(pts.steps!.gamesMax).toBe(2);
    const bare = toTimelinePoints(
      T8_ROWS.map(({ ts, price, size_z }) => ({ ts, price, size_z })),
      T8_SPEC
    );
    expect(bare.steps).toBeNull();
    expect(bare.xs.length).toBe(4);
  });

  it("trade:<iso> anchors: the key is the stamp, the row behind it is the LAST with that ms, and its fields print", () => {
    const iso = "2026-03-03T14:07:22.039";
    expect(tradeKey(iso)).toBe(`trade:${iso}`);
    expect(drillKeyForAnchor(tradeKey(iso), { rows: T8_ROWS, spec: T8_SPEC })).toEqual({ key: iso, label: iso });
    expect(drillKeyForAnchor("trade:", { rows: T8_ROWS, spec: T8_SPEC })).toBeNull();
    const row = rowForAnchor(tradeKey(iso), { rows: T8_ROWS, spec: T8_SPEC });
    expect(row).toBe(T8_ROWS[4]);
    expect(rowFields(row!).map(([k]) => k)).toEqual([
      "ts",
      "price",
      "size_z",
      "count",
      "backs_player",
      "sets_p1",
      "sets_p2",
      "games_p1",
      "games_p2",
    ]);
    // A stamp spelled differently but naming the same ms still resolves (by time, not by string).
    expect(rowForAnchor("trade:2026-03-03T14:07:22.039Z", { rows: T8_ROWS, spec: T8_SPEC })).toBe(T8_ROWS[4]);
    expect(rowForAnchor("trade:2026-01-01T00:00:00Z", { rows: T8_ROWS, spec: T8_SPEC })).toBeNull();
    expect(rowForAnchor("trade:garbage", { rows: T8_ROWS, spec: T8_SPEC })).toBeNull();
    // The pin scope is kind-agnostic: a drilled timeline's pins file under its key.
    expect(viewPinScope({}, "KXATPMATCH-26MAR03LANSHI")).toBe("/KXATPMATCH-26MAR03LANSHI");
  });
});

// ── T8: the exporter's Python port of drillPathKey must agree with the JS ────
describe("T8 — drillPathKey parity: scripts/export-tennis-match.py --path-key", () => {
  const nodeRequire = createRequire(import.meta.url);
  const cp = nodeRequire("node:child_process") as {
    execFileSync: (f: string, a: string[], o: { encoding: string; timeout: number; stdio: unknown }) => string;
  };
  const KEYS = [
    "KXATPMATCH-26MAR03LANSHI",
    "Diaz Acosta / Sanchez Izquierdo",
    "  spaced  ",
    "..\\x",
    "../../etc",
    "café ☕",
    "😀x", // astral: TWO utf-16 units → two underscores
    ".",
    "..",
    "...",
    "",
    "\u00a0nb\u00a0", // JS trim() strips NBSP
    "\ufeffbom", // and the BOM (Python's strip() would not)
    "\x1fctl", // JS trim() does NOT strip U+001F (Python's strip() would)
    "a".repeat(130), // the cap
    `${"b".repeat(119)}😀`, // the cut lands on a surrogate pair
    "C:\\Users\\x.json",
    "match id with tab\tinside",
  ];

  it("agrees with drillPathKey on every awkward key (skips with a note when python is unavailable)", () => {
    let out: string;
    try {
      out = cp.execFileSync("python", ["scripts/export-tennis-match.py", "--path-key", ...KEYS], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      // Skip ONLY when python itself is missing (ENOENT, or the Windows
      // store-alias stub's exit 9009). A traceback, a bad exit or a timeout
      // is a parity FAILURE and must read as one — stderr included.
      if (isPythonMissing(err)) {
        console.info("[t8 parity] python unavailable — the JS↔Python drillPathKey parity check was SKIPPED");
        return;
      }
      throw new Error(`[t8 parity] the exporter failed: ${describeSpawnError(err)}`);
    }
    const py = JSON.parse(out) as (string | null)[];
    expect(py.length).toBe(KEYS.length);
    KEYS.forEach((k, i) => {
      expect({ key: k, py: py[i] }).toEqual({ key: k, py: drillPathKey(k) });
    });
    // Sanity on the values themselves, so the test is not two agreeing bugs.
    expect(py[0]).toBe("KXATPMATCH-26MAR03LANSHI");
    expect(py[1]).toBe("Diaz_Acosta___Sanchez_Izquierdo");
    expect(py[6]).toBe("__x");
    expect(py[7]).toBeNull();
    expect(py[12]).toBe("bom");
    expect(py[13]).toBe("_ctl");
    expect(py[14]).toBe("a".repeat(120));
    expect(py[15]).toBe(`${"b".repeat(119)}_`);
  });
});

// ── T8 smoke: the REAL tennis drill — table → exporter's file → timeline ─────
// Runs the exporter against research.duckdb for the top match by anomaly
// score with n_trades > 500, into `.sb-views/tennis/` (the path the canonical
// drill template names), then proves the pure path: the parent table's drill
// resolves to EXACTLY the file the exporter wrote, and that file parses into
// a timeline with marks, radii inside the clamp, steps and trade: anchors.
// Without python / duckdb / the db the file is SYNTHESISED in the exporter's
// shape and the test says so. Cleanup removes only what this test wrote.
describe("T8 smoke — the tennis table's drill opens the exporter's timeline file", () => {
  const nodeRequire = createRequire(import.meta.url);
  const fs = nodeRequire("node:fs") as {
    mkdirSync: (p: string, o: { recursive: boolean }) => void;
    writeFileSync: (p: string, c: string) => void;
    readFileSync: (p: string, e: string) => string;
    rmSync: (p: string, o: { recursive?: boolean; force: boolean }) => void;
    existsSync: (p: string) => boolean;
    readdirSync: (p: string) => string[];
    rmdirSync: (p: string) => void;
  };
  const pathMod = nodeRequire("node:path") as {
    join: (...p: string[]) => string;
    resolve: (...p: string[]) => string;
    basename: (p: string) => string;
  };
  const cp = nodeRequire("node:child_process") as {
    execFileSync: (f: string, a: string[], o: { encoding: string; timeout: number; stdio: unknown }) => string;
  };
  const DB = "C:/Users/ericm/projects/lodestar/data/research.duckdb";
  const dir = pathMod.resolve(".sb-views", "tennis");
  const written: string[] = [];
  afterEach(() => {
    for (const f of written) fs.rmSync(f, { force: true });
    written.length = 0;
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      // another writer's files stay
    }
  });

  const runExporter = (): { path: string; rows: number; trades: number } | null => {
    if (!fs.existsSync(DB)) return null;
    let out: string;
    try {
      out = cp.execFileSync(
        "python",
        ["scripts/export-tennis-match.py", "--top", "--min-trades", "500", dir],
        { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (err) {
      // Synthetic ONLY when the tooling is absent; anything else is a real failure.
      if (isPythonUnavailable(err)) return null;
      throw new Error(`[t8 smoke] the exporter failed: ${describeSpawnError(err)}`);
    }
    const m = out.match(/^wrote (.+) \((\d+) rows, (\d+) trades\)\s*$/m);
    if (!m) throw new Error(`[t8 smoke] the exporter ran but printed no "wrote …" line:\n${out}`);
    return { path: m[1], rows: Number(m[2]), trades: Number(m[3]) };
  };
  const synthesize = (): { path: string; rows: number; trades: number } => {
    const matchId = "KXSYNTH-26SEP01AAABBB";
    const rows = Array.from({ length: 12 }, (_, i) => ({
      ts: `2026-09-01T12:${String(i * 4).padStart(2, "0")}:00.${String(i * 37).padStart(3, "0")}`,
      price: 40 + i * 3,
      price_raw: i % 2 ? 60 - i * 3 : 40 + i * 3,
      ticker: i % 2 ? `${matchId}-BBB` : `${matchId}-AAA`,
      count: 100 * (i + 1),
      size_z: 0.5 + i * 0.3,
      backs_player: (i % 2) + 1,
      side_inferred: false,
      tilt: 0,
      disagreement: 0,
      score: 1,
      sets_p1: i < 8 ? 0 : 1,
      sets_p2: 0,
      games_p1: i < 8 ? Math.min(6, i) : i - 8,
      games_p2: i < 8 ? Math.floor(i / 2) : 0,
    }));
    const payload = {
      meta: { coverage: "flagged moments only", match_id: matchId, player1: "Aaa", player2: "Bbb", price_of: "Aaa", n_trades: 900, n_flagged: 40 },
      rows,
    };
    fs.mkdirSync(dir, { recursive: true });
    const p = pathMod.join(dir, `${drillPathKey(matchId)}.json`);
    fs.writeFileSync(p, JSON.stringify(payload));
    return { path: p, rows: rows.length, trades: 900 };
  };

  it("the parent's drill resolves to the exporter's file, which parses into marks + steps + trade: anchors", () => {
    const real = runExporter();
    const exported = real ?? synthesize();
    written.push(exported.path);
    console.info(
      `[t8 smoke] ${real ? "research.duckdb via scripts/export-tennis-match.py" : "SYNTHETIC file (python/duckdb/db unavailable)"}: ${pathMod.basename(exported.path)} — ${exported.rows} rows of ${exported.trades} trades`
    );
    const payload = parseViewPayload(fs.readFileSync(exported.path, "utf8"))!;
    expect(payload).not.toBeNull();
    const meta = payload.meta!;
    expect(meta).not.toBeNull();
    expect(meta.coverage).toBe("flagged moments only");
    const matchId = String(meta.match_id);

    // The tennis TABLE's spec, as the tool description's canonical example has it.
    const parent = parseViewSpec(
      JSON.stringify({
        id: "tennis",
        kind: "table",
        title: "Tennis flow anomalies",
        source: { type: "file", path: ".sb-views/tennis/matches.json" },
        columns: ["match_id", "player1_name", "player2_name", "score", "n_trades", "n_flagged"],
        keyColumn: "match_id",
        builtAt: "2026-09-01T10:00:00Z",
        builtBy: "agent",
        drill: {
          kind: "timeline",
          title: "{key}",
          source: { type: "file", path: ".sb-views/tennis/{key}.json" },
          sizeColumn: "size_z",
        },
      })
    );
    expect(parent.specError).toBeNull();
    // Opening the row: its key is the match_id, the drill resolves to the file the exporter named.
    const hit = drillKeyForAnchor(`row:${matchId}`, { rows: [{ match_id: matchId }], spec: parent.spec! });
    expect(hit).toEqual({ key: matchId, label: matchId });
    const child = resolveDrill(parent.spec!, matchId);
    expect(child.error).toBeNull();
    expect(child.spec!.kind).toBe("timeline");
    expect(child.spec!.sizeColumn).toBe("size_z");
    const childPath = child.spec!.source.type === "file" ? child.spec!.source.path : "";
    expect(pathMod.resolve(childPath)).toBe(pathMod.resolve(exported.path));
    expect(fs.existsSync(pathMod.resolve(childPath))).toBe(true);

    // The timeline itself.
    const pts = toTimelinePoints(payload.rows, child.spec!);
    expect(pts.xs.length).toBe(exported.rows);
    expect(pts.xs.length).toBeGreaterThan(0);
    for (let i = 1; i < pts.xs.length; i++) expect(pts.xs[i]).toBeGreaterThan(pts.xs[i - 1]);
    expect(pts.price.every((p) => p !== null && p >= 0 && p <= 100)).toBe(true);
    expect(pts.radius.every((r) => r >= MARK_RADIUS_MIN && r <= MARK_RADIUS_MAX)).toBe(true);
    expect(pts.radius).toContain(MARK_RADIUS_MAX); // the biggest moment draws the biggest mark
    expect(pts.side.every((s) => s === 1 || s === 2)).toBe(true);
    expect(pts.steps).not.toBeNull();
    expect(pts.steps!.gamesMax).toBeGreaterThan(0);
    expect(pts.steps!.gamesP1.every((g) => g !== null)).toBe(true);
    // Every mark is an anchor whose row comes back with its fields.
    for (const ts of pts.ts) {
      const key = tradeKey(ts);
      expect(drillKeyForAnchor(key, { rows: payload.rows, spec: child.spec! })).toEqual({ key: ts, label: ts });
      const row = rowForAnchor(key, { rows: payload.rows, spec: child.spec! })!;
      expect(row).not.toBeNull();
      expect(rowFields(row).map(([k]) => k)).toContain("price");
      expect(rowFields(row).map(([k]) => k)).toContain("games_p1");
    }
    // The toolbar's honesty line.
    expect(timelineNote(meta, pts.xs.length)).toBe(`flagged moments only · ${exported.rows} of ${exported.trades} trades`);
    if (real) {
      // Ground truth of the checkout's data: the moment table holds 12 per match;
      // the top match by score with > 500 trades is Diaz Acosta v Sanchez Izquierdo.
      expect(exported.rows).toBe(12);
      expect(matchId).toBe("KXATPCHALLENGERMATCH-26MAR03DIASAI");
      expect(meta.price_of).toBe("Diaz Acosta");
      expect(exported.trades).toBe(6117);
      // Folded to player 1's yes-price: player 1 is the match id's FIRST code (DIA — the
      // match row's own `ticker` column is -SAI here, which is why the exporter does not
      // trust it). A moment on the p2 ticker carries 100 - price_raw; on p1's, price_raw.
      expect(meta.ticker_p1).toBe("KXATPCHALLENGERMATCH-26MAR03DIASAI-DIA");
      expect(meta.unfolded).toBe(0);
      const p2 = payload.rows.find((r) => String(r.ticker).endsWith("-SAI"))!;
      expect(Number(p2.price)).toBe(100 - Number(p2.price_raw));
      const p1 = payload.rows.find((r) => String(r.ticker).endsWith("-DIA"))!;
      expect(Number(p1.price)).toBe(Number(p1.price_raw));
      // Every fold lands inside 0..100 and the line reads as ONE player's odds.
      expect(payload.rows.every((r) => Number(r.price) >= 0 && Number(r.price) <= 100)).toBe(true);
    }
  });
});

// ── SWIT-70: line charts tell the story ──────────────────────────────────────

import {
  parseSeriesLabels,
  parseViewRegions,
  parseViewPanels,
  lineDomains,
  VIEW_REGION_CAP,
  VIEW_PANEL_CAP,
  VIEW_SERIES_LABEL_CAP,
} from "./viewStore";
import type { LinePoints } from "./viewStore";

const S70_SPEC: ViewSpec = {
  id: "v70",
  kind: "line",
  title: "gamma story",
  source: { type: "file", path: "out/gamma.json" },
  builtAt: "2026-09-01T10:00:00Z",
  builtBy: "agent",
};

describe("SWIT-70 — seriesLabels / regions / panels parse (tolerant)", () => {
  it("seriesLabels keeps non-empty string entries, trims, caps value length and entry count", () => {
    expect(parseSeriesLabels(undefined)).toBeNull();
    expect(parseSeriesLabels("words")).toBeNull();
    expect(parseSeriesLabels({})).toBeNull();
    expect(parseSeriesLabels({ net_gamma: " net gamma ($bn) ", bad: 3, "": "x", blank: "  " })).toEqual({
      net_gamma: "net gamma ($bn)",
    });
    expect(parseSeriesLabels({ a: "x".repeat(80) })).toEqual({ a: "x".repeat(40) });
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`c${i}`, `label ${i}`]));
    expect(Object.keys(parseSeriesLabels(many) ?? {})).toHaveLength(VIEW_SERIES_LABEL_CAP);
  });

  it("regions drop malformed entries alone (both ends must parse), keep order, cap at 12", () => {
    expect(parseViewRegions(undefined)).toEqual([]);
    expect(
      parseViewRegions([
        { from: "2026-06-05T13:30:00Z", to: "2026-06-05T14:00:00Z", label: " open drive " },
        { from: "not a time", to: "2026-06-05T14:00:00Z" },
        { from: "2026-06-05 15:00:00", to: "2026-06-05 15:30:00" },
        "junk",
        { from: "2026-06-05T16:00:00Z" },
      ])
    ).toEqual([
      { from: "2026-06-05T13:30:00Z", to: "2026-06-05T14:00:00Z", label: "open drive" },
      { from: "2026-06-05 15:00:00", to: "2026-06-05 15:30:00" },
    ]);
    const many = Array.from({ length: 20 }, (_, i) => ({
      from: `2026-06-05T0${i % 9}:00:00Z`,
      to: `2026-06-05T0${i % 9}:30:00Z`,
    }));
    expect(parseViewRegions(many)).toHaveLength(VIEW_REGION_CAP);
  });

  it("panels need a title and a valid source; {key} and bad sources drop the panel; cap 6", () => {
    expect(parseViewPanels(undefined)).toEqual([]);
    expect(
      parseViewPanels([
        { title: " net gamma ", source: { type: "file", path: "out/a.json" } },
        { title: "templated", source: { type: "file", path: "out/{key}.json" } },
        // A ../ file path is tolerated HERE like the main source's — the Rust
        // read guard is the containment line; the server refuses it earlier.
        { title: "off box", source: { type: "query", url: "https://evil.example/x" } },
        { source: { type: "file", path: "out/b.json" } },
        { title: "local query", source: { type: "query", url: "http://127.0.0.1:8799/rows" } },
      ])
    ).toEqual([
      { title: "net gamma", source: { type: "file", path: "out/a.json" } },
      { title: "local query", source: { type: "query", url: "http://127.0.0.1:8799/rows" } },
    ]);
    const many = Array.from({ length: 9 }, (_, i) => ({
      title: `p${i}`,
      source: { type: "file", path: `out/${i}.json` },
    }));
    expect(parseViewPanels(many)).toHaveLength(VIEW_PANEL_CAP);
  });

  it("round-trips through parseViewSpec, and specLines names them", () => {
    const raw = JSON.stringify({
      ...S70_SPEC,
      seriesLabels: { net_gamma: "net gamma ($bn)" },
      regions: [{ from: "2026-06-05T13:30:00Z", to: "2026-06-05T14:00:00Z", label: "open" }],
      panels: [
        { title: "vol", source: { type: "file", path: "out/vol.json" } },
        { title: "oi", source: { type: "file", path: "out/oi.json" } },
      ],
    });
    const { spec } = parseViewSpec(raw);
    expect(spec?.seriesLabels).toEqual({ net_gamma: "net gamma ($bn)" });
    expect(spec?.regions).toHaveLength(1);
    expect(spec?.panels?.map((p) => p.title)).toEqual(["vol", "oi"]);
    const lines = specLines(spec as ViewSpec).join("\n");
    expect(lines).toContain("labels    net_gamma = net gamma ($bn)");
    expect(lines).toContain("regions   1");
    expect(lines).toContain("panels    vol · oi");
  });

  it("malformed story fields are ABSENT, never a broken spec", () => {
    const raw = JSON.stringify({
      ...S70_SPEC,
      seriesLabels: ["not", "a", "record"],
      regions: { from: "x" },
      panels: "nope",
    });
    const { spec, specError } = parseViewSpec(raw);
    expect(specError).toBeNull();
    expect(spec?.seriesLabels).toBeUndefined();
    expect(spec?.regions).toBeUndefined();
    expect(spec?.panels).toBeUndefined();
  });
});

describe("SWIT-70 — lineDomains (shared axes for small multiples)", () => {
  const chart = (xs: number[], series: { label: string; values: (number | null)[] }[]): LinePoints => ({
    xs,
    ts: xs.map((x) => new Date(x * 1000).toISOString()),
    rows: xs.map(() => ({})),
    series,
  });

  it("x is the union across every chart; empty charts do not shrink it", () => {
    const a = chart([100, 200], [{ label: "close", values: [1, 2] }]);
    const b = chart([50, 150], [{ label: "close", values: [3, 4] }]);
    const none = chart([], []);
    expect(lineDomains([a, b, none]).x).toEqual([50, 200]);
    expect(lineDomains([none]).x).toBeNull();
    expect(lineDomains([]).x).toBeNull();
  });

  it("y is shared only when every drawn chart has the SAME series set, padded past the extremes", () => {
    const a = chart([100], [{ label: "close", values: [10] }, { label: "rsi", values: [30] }]);
    const b = chart([200], [{ label: "rsi", values: [70] }, { label: "close", values: [-10] }]);
    const y = lineDomains([a, b]).y;
    expect(y).not.toBeNull();
    const [lo, hi] = y as [number, number];
    expect(lo).toBeLessThan(-10);
    expect(hi).toBeGreaterThan(70);
  });

  it("different series sets (different units) mean per-panel auto — y is null", () => {
    const a = chart([100], [{ label: "gamma", values: [1] }]);
    const b = chart([200], [{ label: "volume", values: [1e9] }]);
    expect(lineDomains([a, b]).y).toBeNull();
  });

  it("a single chart never shares y (auto is already right), and null cells are ignored", () => {
    const a = chart([100, 200], [{ label: "close", values: [null, 5] }]);
    expect(lineDomains([a]).y).toBeNull();
    const b = chart([300], [{ label: "close", values: [null] }]);
    expect(lineDomains([a, b]).y).not.toBeNull();
  });
});
