// VIEW data layer (SWIT-50, R4 — the gate): a view is a DECLARATION the
// shell renders, never code the agent wrote. The agent's `view` tool writes a
// spec (`threads/<id>/views/<viewId>.json`) naming a KIND and a SOURCE; this
// module parses the spec tolerantly, loads the rows (a JSON file inside the
// thread's working dir, read through the guarded IPC — or a local backend
// query), windows them for display, and owns the loading policy:
//
//   · the SPEC re-reads at the pins cadence while the tab is active, so an
//     agent's `view update` re-renders the open tab;
//   · FILE data reloads when the spec's builtAt moves (the agent re-showed);
//   · QUERY data loads ONCE per spec and then only on Eric's `re-run` — the
//     agent cannot make a view poll (R4 edge case).
//
// Same import-graph guarantee as pageStore: nothing here can reach the
// terminal machinery, so a view arriving mid-RUN repaints the panel only.
//
// T6 (SWIT-60) — a view EXPLAINS itself and OPENS DOWNWARD:
//   · `definition` is the rule that defines the rows, in the agent's words;
//     the toolbar's `spec` disclosure prints it beside kind/source/columns.
//   · `filters` are selectors over the view's OWN columns; values come from
//     the loaded rows (`filterValues`) and the slice is CLIENT-side
//     (`applyFilters`) — no re-fetch, the agent cannot make a view poll. The
//     active filter is part of the PIN SCOPE (`viewPinScope`): a pin dropped
//     on one date is filed under that date and is not drawn on another.
//   · `drill` declares what is BEHIND an anchor: a child source template whose
//     `{key}` is the anchor's key value. `resolveDrill` is pure and REFUSES a
//     key that could leave the thread cwd (`drillPathKey` — one path
//     component, closed alphabet); the Rust `read_view_data` guard stays the
//     last line. A drilled child is the SAME artifact kind with a `drill.key`
//     — its spec is derived from the parent's at render time, never written
//     to disk, so `useView` takes the key and resolves in place.

import { useCallback, useEffect, useRef, useState } from "react";
import { readThreadView, readViewData } from "./ipc";

export const VIEW_KINDS = ["table", "candles", "dist"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export type ViewSource =
  | { type: "file"; path: string }
  | { type: "query"; url: string; body?: string };

export type ViewMarker = { ts: string; label: string; id?: string };

export const VIEW_FILTER_KINDS = ["select", "date"] as const;
export type ViewFilterKind = (typeof VIEW_FILTER_KINDS)[number];

/** A selector over one of the view's own columns (T6). `select` offers the
 *  column's distinct values; `date` offers the distinct DAYS of a date-ish
 *  column (ISO strings, epoch seconds). */
export type ViewFilter = { column: string; kind: ViewFilterKind; label?: string };

/** What is behind an anchor (T6): a child view whose source strings carry
 *  `{key}` — replaced by the anchor's key value at resolve time. */
export type ViewDrill = {
  kind: ViewKind;
  title: string;
  source: ViewSource;
  columns?: string[];
  keyColumn?: string;
  definition?: string;
};

export type ViewSpec = {
  id: string;
  kind: ViewKind;
  title: string;
  source: ViewSource;
  columns?: string[];
  keyColumn?: string;
  markers?: ViewMarker[];
  builtAt: string;
  builtBy: string;
  /** The rule that defines the rows, in plain words (<= VIEW_DEFINITION_CAP). */
  definition?: string;
  filters?: ViewFilter[];
  drill?: ViewDrill;
};

/** Caps, mirrored from the MCP server (the writer) — the reader trims to the
 *  same numbers so a hand-written spec cannot render more than the tool
 *  would have accepted. */
export const VIEW_DEFINITION_CAP = 600;
export const VIEW_FILTER_CAP = 4;
/** Longest anchor key value a drill accepts (rowAnchorId's own cap). */
export const DRILL_KEY_CAP = 120;

/** Display window: past this many rows the renderer shows the first slice
 *  and SAYS so (the Rust byte cap guards the read; this guards the DOM). */
export const VIEW_ROW_WINDOW = 500;

export type ViewRow = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** LOOPBACK-ONLY, re-checked at the READER (review): the MCP server validates
 *  on the write side, but the spec is a plain file an agent could write with
 *  its own tools — the reader enforcing the same rule makes it structural
 *  rather than one-sided.
 *
 *  A REAL PARSE, not a prefix regex (review, T4-T6): the old
 *  `^https?://(127.0.0.1|localhost|[::1])(:|/)` accepted
 *  `http://localhost:1234@evil.com/x` — `localhost:1234` is USERINFO there and
 *  the fetch goes to evil.com. So: `new URL` must succeed, the scheme is
 *  http(s), there is NO userinfo, and the parsed `hostname` is a literal
 *  loopback. WHATWG keeps the brackets on an IPv6 hostname (`[::1]`), so both
 *  spellings are listed.
 *
 *  PAIRED WITH `isLocalBackendUrl` in
 *  `src-tauri/resources/mcp/switchboard-mcp.cjs` — byte-identical body; the
 *  server is dependency-free and cannot import this module. Change one,
 *  change the other (the `TRANSCRIPT_SUFFIX` arrangement). */
export function isLocalBackendUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const host = parsed.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

function parseViewSource(src: unknown): { source: ViewSource } | { error: string } {
  if (isRecord(src) && src.type === "file" && typeof src.path === "string" && src.path.length > 0) {
    return { source: { type: "file", path: src.path } };
  }
  if (isRecord(src) && src.type === "query" && typeof src.url === "string" && src.url.length > 0) {
    if (!isLocalBackendUrl(src.url)) {
      return { error: "the view spec's query url is not a local backend" };
    }
    const source: ViewSource = { type: "query", url: src.url };
    if (typeof src.body === "string" && src.body.length > 0) source.body = src.body;
    return { source };
  }
  return { error: "the view spec's source is malformed" };
}

/** Tolerant filters parse: malformed entries drop alone; capped. Pure. */
export function parseViewFilters(raw: unknown): ViewFilter[] {
  if (!Array.isArray(raw)) return [];
  const out: ViewFilter[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    if (!isRecord(f)) continue;
    const column = typeof f.column === "string" ? f.column.trim() : "";
    const kind = f.kind;
    if (column.length === 0 || (kind !== "select" && kind !== "date") || seen.has(column)) continue;
    seen.add(column);
    const filter: ViewFilter = { column, kind };
    if (typeof f.label === "string" && f.label.trim().length > 0) filter.label = f.label.trim().slice(0, 40);
    out.push(filter);
    if (out.length >= VIEW_FILTER_CAP) break;
  }
  return out;
}

/** Tolerant drill parse: null = no drill (a malformed one is ABSENT, never a
 *  broken parent). The child's source TEMPLATE must already be a valid
 *  source with `{key}` standing in — a query whose host is not a literal
 *  loopback address is refused here, before any key exists. Pure. */
export function parseViewDrill(raw: unknown): ViewDrill | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (kind !== "table" && kind !== "candles" && kind !== "dist") return null;
  const src = parseViewSource(raw.source);
  if ("error" in src) return null;
  const drill: ViewDrill = {
    kind,
    title: typeof raw.title === "string" && raw.title.trim().length > 0 ? raw.title.trim() : "{key}",
    source: src.source,
  };
  if (Array.isArray(raw.columns)) {
    const columns = raw.columns.filter((c): c is string => typeof c === "string" && c.length > 0);
    if (columns.length > 0) drill.columns = columns;
  }
  if (typeof raw.keyColumn === "string" && raw.keyColumn.length > 0) drill.keyColumn = raw.keyColumn;
  if (typeof raw.definition === "string" && raw.definition.trim().length > 0) {
    drill.definition = raw.definition.trim().slice(0, VIEW_DEFINITION_CAP);
  }
  return drill;
}

/** Tolerant spec parse: null = nothing renderable (the cannot-render card's
 *  "malformed spec" case names what was wrong via `specError`). */
export function parseViewSpec(raw: string): { spec: ViewSpec | null; specError: string | null } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { spec: null, specError: "no spec — the view file is missing or empty" };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { spec: null, specError: "the view spec is not valid JSON" };
  }
  if (!isRecord(data)) return { spec: null, specError: "the view spec is not an object" };
  const kind = data.kind;
  if (kind !== "table" && kind !== "candles" && kind !== "dist") {
    return { spec: null, specError: `unknown view kind: ${String(data.kind)}` };
  }
  const id = typeof data.id === "string" && data.id.length > 0 ? data.id : null;
  if (!id) return { spec: null, specError: "the view spec has no id" };
  const parsedSource = parseViewSource(data.source);
  if ("error" in parsedSource) return { spec: null, specError: parsedSource.error };
  const source = parsedSource.source;
  const spec: ViewSpec = {
    id,
    kind,
    title: typeof data.title === "string" && data.title.length > 0 ? data.title : id,
    source,
    builtAt: typeof data.builtAt === "string" ? data.builtAt : "",
    builtBy: typeof data.builtBy === "string" ? data.builtBy : "agent",
  };
  if (Array.isArray(data.columns)) {
    spec.columns = data.columns.filter((c): c is string => typeof c === "string" && c.length > 0);
  }
  if (typeof data.keyColumn === "string" && data.keyColumn.length > 0) spec.keyColumn = data.keyColumn;
  // T6 — the three optional fields, each tolerated as ABSENT when malformed
  // (a bad drill must not take the parent view with it; the spec is still a
  // renderable declaration without them).
  if (typeof data.definition === "string" && data.definition.trim().length > 0) {
    spec.definition = data.definition.trim().slice(0, VIEW_DEFINITION_CAP);
  }
  const filters = parseViewFilters(data.filters);
  if (filters.length > 0) spec.filters = filters;
  const drill = parseViewDrill(data.drill);
  if (drill) spec.drill = drill;
  if (Array.isArray(data.markers)) {
    spec.markers = data.markers
      .filter((m): m is Record<string, unknown> => isRecord(m) && typeof m.ts === "string")
      .map((m) => ({
        ts: m.ts as string,
        label: typeof m.label === "string" ? m.label : "",
        ...(typeof m.id === "string" && m.id.length > 0 ? { id: m.id } : {}),
      }));
  }
  return { spec, specError: null };
}

/** Rows out of a data payload: a JSON array of flat objects (non-objects
 *  drop alone). null = not rows at all — the card's case. */
export function parseViewRows(raw: string): ViewRow[] | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  // Tolerate the common wrapper shapes a backend answers with.
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.rows)
      ? data.rows
      : isRecord(data) && Array.isArray(data.data)
        ? data.data
        : null;
  if (!list) return null;
  return list.filter(isRecord);
}

/** Window rows for display. Pure. */
export function windowRows(rows: ViewRow[]): { rows: ViewRow[]; total: number; windowed: boolean } {
  if (rows.length <= VIEW_ROW_WINDOW) return { rows, total: rows.length, windowed: false };
  return { rows: rows.slice(0, VIEW_ROW_WINDOW), total: rows.length, windowed: true };
}

/** The table's row-anchor value: the key column's value (or the first
 *  column's), as a string — `row:<value>`. Pure; null when the row has no
 *  usable key (that row is simply unpinnable). */
export function rowAnchorId(row: ViewRow, spec: ViewSpec): string | null {
  const key = spec.keyColumn ?? spec.columns?.[0] ?? Object.keys(row)[0];
  if (!key) return null;
  const v = row[key];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s.slice(0, 120) : null;
}

/** Table column order: the spec's list when given, else the union of the
 *  first row's keys. Pure. */
export function tableColumns(rows: ViewRow[], spec: ViewSpec): string[] {
  if (spec.columns && spec.columns.length > 0) return spec.columns;
  return rows.length > 0 ? Object.keys(rows[0]) : [];
}

/** Rows → OHLC bars for the candle renderer. Accepts `ts` or `time` (ISO or
 *  epoch seconds) and numeric or numeric-string OHLC; a row missing any of
 *  them drops alone. Pure. */
export function toOhlcRows(
  rows: ViewRow[]
): { ts: string; open: number; high: number; low: number; close: number; volume?: number }[] {
  const out: { ts: string; open: number; high: number; low: number; close: number; volume?: number }[] = [];
  for (const row of rows) {
    const tsRaw = row.ts ?? row.time;
    const ts =
      typeof tsRaw === "string"
        ? tsRaw
        : typeof tsRaw === "number"
          ? new Date(tsRaw * 1000).toISOString()
          : null;
    if (!ts) continue;
    const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
    const open = num(row.open);
    const high = num(row.high);
    const low = num(row.low);
    const close = num(row.close);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    const bar: { ts: string; open: number; high: number; low: number; close: number; volume?: number } = {
      ts,
      open,
      high,
      low,
      close,
    };
    const volume = num(row.volume);
    if (Number.isFinite(volume)) bar.volume = volume;
    out.push(bar);
  }
  return out;
}

export type DistBin = { label: string; count: number };

/** Rows → PRE-BINNED distribution bars: the agent aggregates (that is its
 *  job); the renderer draws. Label = the key column; count = the first
 *  numeric column that is not the label (or `count`/`n`/`value` by name). */
export function toDistBins(rows: ViewRow[], spec: ViewSpec): DistBin[] {
  const out: DistBin[] = [];
  for (const row of rows) {
    const label = rowAnchorId(row, spec);
    if (label === null) continue;
    const named = ["count", "n", "value"].find((k) => Number.isFinite(Number(row[k])));
    let count: number | null = named !== undefined ? Number(row[named]) : null;
    if (count === null) {
      for (const [k, v] of Object.entries(row)) {
        if (String(row[spec.keyColumn ?? ""] ?? "") === String(v) && k === (spec.keyColumn ?? "")) continue;
        const n = Number(v);
        if (Number.isFinite(n) && String(v).trim() !== label) {
          count = n;
          break;
        }
      }
    }
    if (count === null || !Number.isFinite(count)) continue;
    out.push({ label, count });
  }
  return out;
}

// ── Filters (T6): client-side slices over the loaded rows ────────────────────

/** Active filter values by column; a column absent or "" means "all". */
export type ActiveFilters = Record<string, string>;

/** A date-ish cell → its DAY (`YYYY-MM-DD`), or null when it is not one.
 *  ISO strings and epoch seconds (the same two forms toOhlcRows takes);
 *  a bare `YYYY-MM-DD` passes through. Pure. */
export function dateKeyOf(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : s.slice(0, 10);
}

/** The value a row shows a filter: the cell as a string for `select`, its
 *  day for `date`; null when the row has nothing there. Pure. */
export function filterValueOf(row: ViewRow, filter: ViewFilter): string | null {
  const v = row[filter.column];
  if (v === null || v === undefined) return null;
  if (filter.kind === "date") return dateKeyOf(v);
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/** DISTINCT values a filter offers, from the loaded rows, sorted. Pure. */
export function filterValues(rows: ViewRow[], filter: ViewFilter): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const v = filterValueOf(row, filter);
    if (v !== null) set.add(v);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** Slice rows by every active filter (AND across filters). A filter that
 *  names a column the rows do not have matches nothing — an honest empty
 *  rather than a silent "all". Pure; returns the SAME array when nothing is
 *  active so React bails out. */
export function applyFilters(rows: ViewRow[], filters: ViewFilter[] | undefined, active: ActiveFilters): ViewRow[] {
  if (!filters || filters.length === 0) return rows;
  const live = filters.filter((f) => (active[f.column] ?? "").length > 0);
  if (live.length === 0) return rows;
  return rows.filter((row) => live.every((f) => filterValueOf(row, f) === active[f.column]));
}

/** The pin-scope suffix for a view: the drill key when this is a child, then
 *  the active filters as a stable query string. `""` for a bare parent with
 *  nothing active — so every pin filed before T6 keeps its doc key. Pure.
 *  Sorted by column so the same slice always yields the same scope. */
export function viewPinScope(active: ActiveFilters, drillKey: string | null = null): string {
  const parts = Object.keys(active)
    .filter((k) => (active[k] ?? "").length > 0)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(active[k])}`);
  const drill = drillKey !== null && drillKey.length > 0 ? `/${encodeURIComponent(drillKey)}` : "";
  return `${drill}${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
}

// ── Drill (T6): what is behind an anchor ─────────────────────────────────────

/** The key value as ONE path component: every character outside
 *  `[A-Za-z0-9._-]` becomes `_` (spaces included — the agent can predict the
 *  file name), then `.`/`..`/empty are refused. A key can therefore never
 *  add a separator, a drive or a parent hop to the template. Pure. */
export function drillPathKey(key: string): string | null {
  const cleaned = key.trim().slice(0, DRILL_KEY_CAP).replace(/[^A-Za-z0-9._-]/g, "_");
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return null;
  return cleaned;
}

/** The anchor's key VALUE + label for the drill / the `→ thread` sentence,
 *  from an anchor key the renderers stamp: `row:<value>`, `bin:<n>` (the bin's
 *  label), `bar:<iso>` (the marker sitting on that bar — its id, else its
 *  ts — or the bar's own ts when no marker does). Pure; null when the anchor
 *  is not one of ours. */
export function drillKeyForAnchor(
  anchorKey: string,
  ctx: { rows: ViewRow[]; spec: ViewSpec }
): { key: string; label: string } | null {
  if (anchorKey.startsWith("row:")) {
    const key = anchorKey.slice(4);
    return key.length > 0 ? { key, label: key } : null;
  }
  if (anchorKey.startsWith("bin:")) {
    const n = Number(anchorKey.slice(4));
    if (!Number.isInteger(n) || n < 0) return null;
    const bin = toDistBins(ctx.rows, ctx.spec)[n];
    return bin ? { key: bin.label, label: bin.label } : null;
  }
  if (anchorKey.startsWith("bar:")) {
    const iso = anchorKey.slice(4);
    if (iso.length === 0) return null;
    const marker = markerAtBar(toOhlcRows(ctx.rows), ctx.spec.markers ?? [], iso);
    if (marker) return { key: marker.id ?? marker.ts, label: marker.label || marker.ts };
    return { key: iso, label: iso };
  }
  return null;
}

/** The marker whose NEAREST bar is the given bar — the same nearest rule the
 *  chart draws with, re-derived from the bars so a click on a bar names the
 *  marker drawn on it. Pure; null when none sits there. */
export function markerAtBar(
  bars: readonly { ts: string }[],
  markers: readonly ViewMarker[],
  barTs: string
): ViewMarker | null {
  const target = Date.parse(barTs);
  if (!Number.isFinite(target) || bars.length === 0) return null;
  const times = bars.map((b) => Date.parse(b.ts)).filter(Number.isFinite);
  for (const m of markers) {
    const t = Date.parse(m.ts);
    if (!Number.isFinite(t)) continue;
    let best = Number.POSITIVE_INFINITY;
    let bestAt = Number.NaN;
    for (const bt of times) {
      const d = Math.abs(bt - t);
      if (d < best) {
        best = d;
        bestAt = bt;
      }
    }
    if (bestAt === target) return m;
  }
  return null;
}

/** Resolve the parent's drill for a key into the CHILD spec. Pure. `{key}`
 *  in a file path takes the path-component form (refused when it cannot be
 *  made one); in a query url/body it is URL-encoded; in the title it is the
 *  raw key. The child's query url is re-checked against the loopback rule
 *  after substitution — the encoding keeps a key out of the host and the
 *  userinfo slot, and the re-check is what holds if that ever stops being
 *  true (a template with `{key}` in the authority is refused either way). */
export function resolveDrill(
  parent: ViewSpec,
  key: string
): { spec: ViewSpec; error: null } | { spec: null; error: string } {
  const drill = parent.drill;
  if (!drill) return { spec: null, error: `${parent.title} declares no drill` };
  const raw = key.trim();
  if (raw.length === 0 || raw.length > DRILL_KEY_CAP) return { spec: null, error: "the drill key is empty or too long" };
  const fill = (s: string, v: string) => s.split("{key}").join(v);
  let source: ViewSource;
  if (drill.source.type === "file") {
    const component = drillPathKey(raw);
    if (component === null) {
      return { spec: null, error: `the key "${raw}" cannot name a file inside the thread's working directory` };
    }
    source = { type: "file", path: fill(drill.source.path, component) };
  } else {
    const url = fill(drill.source.url, encodeURIComponent(raw));
    if (!isLocalBackendUrl(url)) return { spec: null, error: "the drill's query url is not a local backend" };
    source = { type: "query", url };
    if (drill.source.body) source.body = fill(drill.source.body, encodeURIComponent(raw));
  }
  const spec: ViewSpec = {
    id: `${parent.id}~${drillPathKey(raw) ?? "key"}`,
    kind: drill.kind,
    title: fill(drill.title, raw),
    source,
    builtAt: parent.builtAt,
    builtBy: parent.builtBy,
  };
  if (drill.columns) spec.columns = drill.columns;
  if (drill.keyColumn) spec.keyColumn = drill.keyColumn;
  if (drill.definition) spec.definition = drill.definition;
  return { spec, error: null };
}

/** The `→ thread` sentence when a view declares NO drill (R6). Pure. */
export function drillFallbackSentence(viewTitle: string, anchorLabel: string): string {
  return `show me what is behind ${viewTitle} › ${anchorLabel}`;
}

/** The lines the toolbar's `spec` disclosure prints — plain text, no
 *  narration. Pure. */
export function specLines(spec: ViewSpec): string[] {
  const lines: string[] = [`kind      ${spec.kind}`];
  lines.push(
    `source    ${spec.source.type === "file" ? `file ${spec.source.path}` : `query ${spec.source.url}`}`
  );
  if (spec.source.type === "query" && spec.source.body) lines.push(`body      ${spec.source.body}`);
  if (spec.columns && spec.columns.length > 0) lines.push(`columns   ${spec.columns.join(" · ")}`);
  if (spec.keyColumn) lines.push(`key       ${spec.keyColumn}`);
  if (spec.markers && spec.markers.length > 0) lines.push(`markers   ${spec.markers.length}`);
  if (spec.filters && spec.filters.length > 0) {
    lines.push(`filters   ${spec.filters.map((f) => `${f.label ?? f.column} (${f.kind})`).join(" · ")}`);
  }
  if (spec.drill) {
    lines.push(
      `drill     ${spec.drill.kind} ${spec.drill.title} ← ${
        spec.drill.source.type === "file" ? spec.drill.source.path : spec.drill.source.url
      }`
    );
  }
  if (spec.definition) lines.push(`defines   ${spec.definition}`);
  if (spec.builtAt) lines.push(`built     ${spec.builtAt.slice(0, 16).replace("T", " ")} · ${spec.builtBy}`);
  return lines;
}

// ── The hook ─────────────────────────────────────────────────────────────────

export const VIEW_SPEC_POLL_MS = 2_500;

export type ViewRead = {
  spec: ViewSpec | null;
  /** Why there is no spec / no rows — the cannot-render card's copy. */
  error: string | null;
  rows: ViewRow[] | null;
  /** Rows are loading right now (first load or a re-run). */
  loading: boolean;
  /** Eric's re-run (query sources; a file source re-reads the file). */
  rerun: () => void;
};

export function useView(
  threadId: string,
  viewId: string,
  active: boolean,
  /** T6: a drilled CHILD — the parent's drill resolved for this key. */
  drillKey: string | null = null
): ViewRead {
  const [spec, setSpec] = useState<ViewSpec | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);
  const [rows, setRows] = useState<ViewRow[] | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastSpecRawRef = useRef<string | null>(null);
  // WHICH spec build the loaded rows belong to — file data reloads when the
  // agent re-shows (builtAt moves); query data does not (re-run is Eric's).
  const loadedForRef = useRef<string | null>(null);
  const loadSeqRef = useRef(0);

  // Spec poll (pins cadence, active-gated, no-op on unchanged raw).
  useEffect(() => {
    lastSpecRawRef.current = null;
    loadedForRef.current = null;
    setSpec(null);
    setSpecError(null);
    setRows(null);
    setDataError(null);
  }, [threadId, viewId, drillKey]);

  useEffect(() => {
    if (!active || threadId.length === 0 || viewId.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const raw = await readThreadView(threadId, viewId);
        if (cancelled || raw === lastSpecRawRef.current) return;
        lastSpecRawRef.current = raw;
        const parsed = parseViewSpec(raw);
        // A DRILLED child (T6): the file holds the PARENT; the child is the
        // parent's drill resolved for this key, re-derived on every spec
        // change so an agent `update` of the parent re-shapes the child too.
        if (parsed.spec && drillKey !== null) {
          const child = resolveDrill(parsed.spec, drillKey);
          setSpec(child.spec);
          setSpecError(child.error);
          return;
        }
        setSpec(parsed.spec);
        setSpecError(parsed.specError);
      } catch (err) {
        if (!cancelled && lastSpecRawRef.current === null) {
          setSpecError(String(err));
        }
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), VIEW_SPEC_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [threadId, viewId, active, drillKey]);

  const load = useCallback(
    async (target: ViewSpec) => {
      const seq = ++loadSeqRef.current;
      setLoading(true);
      setDataError(null);
      try {
        let raw: string;
        if (target.source.type === "file") {
          raw = await readViewData(threadId, target.source.path);
        } else {
          const init: RequestInit = target.source.body
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: target.source.body,
              }
            : { method: "GET" };
          const res = await fetch(target.source.url, init);
          if (!res.ok) throw new Error(`the backend answered ${res.status}`);
          raw = await res.text();
        }
        if (seq !== loadSeqRef.current) return;
        const parsed = parseViewRows(raw);
        if (parsed === null) {
          setDataError("the source did not contain rows (expected a JSON array of objects)");
          setRows(null);
        } else {
          setRows(parsed);
        }
      } catch (err) {
        if (seq !== loadSeqRef.current) return;
        setDataError(String(err instanceof Error ? err.message : err));
        // Keep the last good rows if any — degraded beats blanked.
      } finally {
        if (seq === loadSeqRef.current) setLoading(false);
      }
    },
    [threadId]
  );

  // Load data once per BUILD (id + builtAt + source): an agent `update`
  // moves builtAt (millisecond ISO), so the open tab reloads — file and
  // query alike, since the update IS a fresh declaration. Between builds a
  // query never refetches (re-run is Eric's); a file re-reads only through
  // re-run too.
  useEffect(() => {
    if (!spec) return;
    const buildKey = `${spec.id}:${spec.builtAt}:${spec.source.type === "file" ? spec.source.path : spec.source.url}`;
    if (loadedForRef.current === buildKey) return;
    loadedForRef.current = buildKey;
    void load(spec);
  }, [spec, load]);

  const rerun = useCallback(() => {
    if (spec) void load(spec);
  }, [spec, load]);

  return {
    spec,
    error: specError ?? dataError,
    rows,
    loading,
    rerun,
  };
}
