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
//
// T7 (SWIT-61) — two more kinds and the hover's data:
//   · `line` — rows `{time|ts, <series>…}` over one time axis; `series` is the
//     spec's list or, inferred, every numeric non-time column
//     (`lineSeriesColumns`). `toLinePoints` aligns them for uPlot (UTC seconds,
//     ascending, duplicate seconds collapse last-wins like candles) and keeps
//     the source ISO per point so the anchor is `pt:<iso>` — by time, like
//     `bar:<iso>`, so markers and pins do not move when the axis re-scales.
//   · `bar` — rows `{<keyColumn>, <valueColumn>}` by CATEGORY; `toBarRows` is
//     the dist mapping under another name (label + one number), the anchor is
//     `bar:<key>`. That prefix collides with the candle `bar:<iso>` on purpose
//     — an anchor key is scoped to its view — and `drillKeyForAnchor` reads
//     the SPEC's kind to tell them apart.
//   · The hover tooltip prints EVERY field of the hovered row, so the
//     bin/bar mappings carry the SOURCE ROW (`row`) and `rowFields` is the one
//     formatter (key · value, in the row's own order).
//
// T8 (SWIT-62) — `timeline`, the first real drill target (a tennis match):
//   · rows `{ts, price, <sizeColumn>, backs_player?, sets_p1?, sets_p2?,
//     games_p1?, games_p2?}` — ONE row per moment. `toTimelinePoints` keeps
//     every row as a MARK at its own millisecond (x = fractional seconds, so
//     two trades a second apart stay two marks; the same millisecond
//     collapses last-wins like every other kind), the price as the line,
//     the radius from `sizeColumn` (default `size_z`) through `markRadius` —
//     sqrt of the value's share of the column's max, clamped to a readable
//     range — and the score as STEPS (`steps`: null when the rows carry no
//     score columns; the renderer draws them stepped, never interpolated).
//     The anchor is `trade:<iso>` — by time, like `pt:`/`bar:` — and
//     `rowForAnchor` answers it, so the T7 tooltip prints the trade's fields.
//   · The data file may carry a `meta` object beside `rows`
//     (`parseViewPayload`); `timelineNote` turns `meta.coverage` +
//     `meta.n_trades` into the toolbar's honesty line — `flagged moments only
//     · N of M trades` — because a drilled child's spec is a TEMPLATE and
//     cannot know a per-match total. No meta → `N moments`, which claims
//     nothing about the tape.

// SWIT-70 — line charts tell the story:
//   · `seriesLabels` (column → plain words) names the legend; the COLOUR
//     stays keyed on the column (charts/candles.ts `seriesColor`), so a
//     label never moves a tone.
//   · `regions` [{from, to, label?}] shade time bands on the chart.
//   · `panels` [{title, source}] are SMALL MULTIPLES: mini line charts in a
//     2-up grid with the main chart, each with its own source (validated
//     like the main one; `{key}` refused — a panel is fixed, not a drill
//     template), loaded once per build (`useViewPanels`), sharing the union
//     time domain and — when every chart draws the same series set — one
//     value domain (`lineDomains`). Anchors and pins publish from the MAIN
//     chart only in v1; the multiples are read-only.

import { useCallback, useEffect, useRef, useState } from "react";
import { readThreadView, readViewData } from "./ipc";

export const VIEW_KINDS = ["table", "candles", "dist", "line", "bar", "timeline"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export function isViewKind(v: unknown): v is ViewKind {
  return typeof v === "string" && (VIEW_KINDS as readonly string[]).includes(v);
}

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

/** A shaded time band on a line chart (SWIT-70): ISO from/to, an optional
 *  small label at the band's top. */
export type ViewRegion = { from: string; to: string; label?: string };

/** A SMALL MULTIPLE (SWIT-70): one mini line chart with its own source and
 *  title, drawn in a 2-up grid with the main chart, sharing its time domain.
 *  A panel is a FIXED source — `{key}` is a drill's affordance, not a
 *  panel's, and is refused. */
export type ViewPanel = { title: string; source: ViewSource };

/** What is behind an anchor (T6): a child view whose source strings carry
 *  `{key}` — replaced by the anchor's key value at resolve time. */
export type ViewDrill = {
  kind: ViewKind;
  title: string;
  source: ViewSource;
  columns?: string[];
  keyColumn?: string;
  /** line: the series columns; bar: the value column (T7). */
  series?: string[];
  valueColumn?: string;
  /** timeline: the column a mark's radius comes from (T8). */
  sizeColumn?: string;
  definition?: string;
};

export type ViewSpec = {
  id: string;
  kind: ViewKind;
  title: string;
  source: ViewSource;
  columns?: string[];
  keyColumn?: string;
  /** line (T7): the columns drawn as series; absent = inferred (every
   *  numeric non-time column, `lineSeriesColumns`). */
  series?: string[];
  /** bar (T7): the column holding the bar's value; absent = the dist rule
   *  (`count`/`n`/`value` by name, else the first numeric non-key column). */
  valueColumn?: string;
  /** timeline (T8): the column a mark's radius comes from; absent =
   *  `size_z` (`TIMELINE_SIZE_DEFAULT`). */
  sizeColumn?: string;
  markers?: ViewMarker[];
  builtAt: string;
  builtBy: string;
  /** The rule that defines the rows, in plain words (<= VIEW_DEFINITION_CAP). */
  definition?: string;
  filters?: ViewFilter[];
  drill?: ViewDrill;
  /** line (SWIT-70): legend labels in plain words, by series column. */
  seriesLabels?: Record<string, string>;
  /** line (SWIT-70): shaded time bands. */
  regions?: ViewRegion[];
  /** line (SWIT-70): small multiples beside the main chart. */
  panels?: ViewPanel[];
};

/** Caps, mirrored from the MCP server (the writer) — the reader trims to the
 *  same numbers so a hand-written spec cannot render more than the tool
 *  would have accepted. */
export const VIEW_DEFINITION_CAP = 600;
export const VIEW_FILTER_CAP = 4;
/** SWIT-70: the line kind's story caps — mirrored in the MCP server. */
export const VIEW_REGION_CAP = 12;
export const VIEW_PANEL_CAP = 6;
export const VIEW_SERIES_LABEL_CAP = 24;
/** Longest anchor key value a drill accepts (rowAnchorId's own cap). */
export const DRILL_KEY_CAP = 120;

/** Display window: past this many rows the renderer shows the first slice
 *  and SAYS so (the Rust byte cap guards the read; this guards the DOM). */
export const VIEW_ROW_WINDOW = 500;

export type ViewRow = Record<string, unknown>;
/** The optional `meta` object a data file carries beside its rows (T8). */
export type ViewMeta = Record<string, unknown>;

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

/** Tolerant seriesLabels parse (SWIT-70): a record of non-empty strings,
 *  capped; anything else is ABSENT (null). Keys are series COLUMNS — the
 *  colour hash keys on the column, so a label never moves a colour. Pure. */
export function parseSeriesLabels(raw: unknown): Record<string, string> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || v.trim().length === 0 || k.trim().length === 0) continue;
    out[k.trim()] = v.trim().slice(0, 40);
    if (++n >= VIEW_SERIES_LABEL_CAP) break;
  }
  return n > 0 ? out : null;
}

/** Tolerant regions parse (SWIT-70): malformed entries drop alone — both
 *  ends must be parseable times (the candle rule: naive = UTC); capped.
 *  Reversed ends are kept as written (the renderer swaps). Pure. */
export function parseViewRegions(raw: unknown): ViewRegion[] {
  if (!Array.isArray(raw)) return [];
  const out: ViewRegion[] = [];
  for (const r of raw) {
    if (!isRecord(r) || typeof r.from !== "string" || typeof r.to !== "string") continue;
    if (isoToSeconds(r.from) === null || isoToSeconds(r.to) === null) continue;
    const region: ViewRegion = { from: r.from, to: r.to };
    if (typeof r.label === "string" && r.label.trim().length > 0) region.label = r.label.trim().slice(0, 40);
    out.push(region);
    if (out.length >= VIEW_REGION_CAP) break;
  }
  return out;
}

/** Tolerant panels parse (SWIT-70): each panel needs a title and a valid
 *  source (same loopback rule as the main one); a source carrying `{key}`
 *  drops — a panel is a fixed source, never a drill template, so no key
 *  substitution (and no path surprise) can reach it. Capped. Pure. */
export function parseViewPanels(raw: unknown): ViewPanel[] {
  if (!Array.isArray(raw)) return [];
  const out: ViewPanel[] = [];
  for (const p of raw) {
    if (!isRecord(p)) continue;
    const title = typeof p.title === "string" && p.title.trim().length > 0 ? p.title.trim().slice(0, 80) : null;
    if (title === null) continue;
    const src = parseViewSource(p.source);
    if ("error" in src) continue;
    const template =
      src.source.type === "file" ? src.source.path : `${src.source.url}${src.source.body ?? ""}`;
    if (template.includes("{key}")) continue;
    out.push({ title, source: src.source });
    if (out.length >= VIEW_PANEL_CAP) break;
  }
  return out;
}

/** A list of column names, or null when absent/empty (non-strings drop). */
function parseColumnList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const list = raw.filter((c): c is string => typeof c === "string" && c.length > 0);
  return list.length > 0 ? list : null;
}

/** Tolerant drill parse: null = no drill (a malformed one is ABSENT, never a
 *  broken parent). The child's source TEMPLATE must already be a valid
 *  source with `{key}` standing in — a query whose host is not a literal
 *  loopback address is refused here, before any key exists. Pure. */
export function parseViewDrill(raw: unknown): ViewDrill | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (!isViewKind(kind)) return null;
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
  const series = parseColumnList(raw.series);
  if (series) drill.series = series;
  if (typeof raw.valueColumn === "string" && raw.valueColumn.length > 0) drill.valueColumn = raw.valueColumn;
  if (typeof raw.sizeColumn === "string" && raw.sizeColumn.length > 0) drill.sizeColumn = raw.sizeColumn;
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
  if (!isViewKind(kind)) {
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
  // T7 — line series / bar value column, tolerated as ABSENT (inferred).
  const series = parseColumnList(data.series);
  if (series) spec.series = series;
  if (typeof data.valueColumn === "string" && data.valueColumn.length > 0) spec.valueColumn = data.valueColumn;
  // T8 — the timeline's size column, tolerated as ABSENT (the default).
  if (typeof data.sizeColumn === "string" && data.sizeColumn.length > 0) spec.sizeColumn = data.sizeColumn;
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
  // SWIT-70 — the line kind's story fields, each tolerated as ABSENT.
  const seriesLabels = parseSeriesLabels(data.seriesLabels);
  if (seriesLabels) spec.seriesLabels = seriesLabels;
  const regions = parseViewRegions(data.regions);
  if (regions.length > 0) spec.regions = regions;
  const panels = parseViewPanels(data.panels);
  if (panels.length > 0) spec.panels = panels;
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

/** Rows AND the optional `meta` object out of a data payload (T8): a JSON
 *  array of flat objects, or `{rows | data, meta?}` (non-object rows drop
 *  alone; a non-object meta is absent). null = not rows at all — the card's
 *  case. Pure. */
export function parseViewPayload(raw: string): { rows: ViewRow[]; meta: ViewMeta | null } | null {
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
  const meta = isRecord(data) && isRecord(data.meta) ? (data.meta as ViewMeta) : null;
  return { rows: list.filter(isRecord), meta };
}

/** Rows out of a data payload — `parseViewPayload` without the meta. */
export function parseViewRows(raw: string): ViewRow[] | null {
  return parseViewPayload(raw)?.rows ?? null;
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

export type DistBin = { label: string; count: number; row: ViewRow };

/** Rows → PRE-BINNED distribution bars: the agent aggregates (that is its
 *  job); the renderer draws. Label = the key column; count = the spec's
 *  `valueColumn` when declared, else the first numeric column that is not
 *  the label (or `count`/`n`/`value` by name). Each bin keeps its SOURCE ROW
 *  for the hover tooltip (T7). */
export function toDistBins(rows: ViewRow[], spec: ViewSpec): DistBin[] {
  const out: DistBin[] = [];
  for (const row of rows) {
    const label = rowAnchorId(row, spec);
    if (label === null) continue;
    let count: number | null = null;
    if (spec.valueColumn) {
      const raw = row[spec.valueColumn];
      const n = Number(raw);
      count = raw !== null && raw !== undefined && raw !== "" && Number.isFinite(n) ? n : null;
    } else {
      const named = ["count", "n", "value"].find((k) => Number.isFinite(Number(row[k])));
      count = named !== undefined ? Number(row[named]) : null;
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
    }
    if (count === null || !Number.isFinite(count)) continue;
    out.push({ label, count, row });
  }
  return out;
}

export type BarRow = { key: string; value: number; row: ViewRow };

/** Rows → CATEGORY bars (T7): the dist mapping under the bar kind's names —
 *  `key` = the key column's value (the anchor, `bar:<key>`), `value` = the
 *  spec's `valueColumn` else the dist rule. Pure. */
export function toBarRows(rows: ViewRow[], spec: ViewSpec): BarRow[] {
  return toDistBins(rows, spec).map((b) => ({ key: b.label, value: b.count, row: b.row }));
}

/** The anchor key for a category bar (T7). */
export function barKey(key: string): string {
  return `bar:${key}`;
}

/** The anchor key for a line point (T7): by time, like a candle's. */
export function pointKey(ts: string): string {
  return `pt:${ts}`;
}

const TIME_COLUMNS: readonly string[] = ["time", "ts"];

/** The time cell of a row as an ISO string: `ts` or `time`, ISO or epoch
 *  seconds (the same two forms toOhlcRows takes). Pure; null when absent. */
export function rowTimeIso(row: ViewRow): string | null {
  const raw = row.ts ?? row.time;
  if (typeof raw === "string") return raw.trim().length > 0 ? raw : null;
  if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw * 1000).toISOString();
  return null;
}

/** ISO → UTC seconds with the candle rule (a stamp with NO zone is UTC —
 *  Lodestar serialises naive `ts_utc` columns exactly like that); null when
 *  unparseable. Same body as surfaces/charts/candles.ts's `isoToUtcSeconds`,
 *  kept here so this module's import graph stays its own. */
export function isoToSeconds(ts: string): number | null {
  const t = ts.trim().replace(" ", "T");
  const zoned = /(Z|[+-]\d\d:?\d\d)$/i.test(t) ? t : `${t}Z`;
  const ms = Date.parse(zoned);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function numericCell(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The line kind's series columns (T7): the spec's `series` when declared,
 *  else every non-time column whose FIRST non-empty cell is numeric, in
 *  first-seen order. Pure; [] when nothing qualifies. */
export function lineSeriesColumns(rows: ViewRow[], spec: ViewSpec): string[] {
  if (spec.series && spec.series.length > 0) return spec.series;
  const out: string[] = [];
  const decided = new Set<string>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (decided.has(k) || TIME_COLUMNS.includes(k)) continue;
      if (v === null || v === undefined || v === "") continue;
      decided.add(k);
      if (numericCell(v) !== null) out.push(k);
    }
  }
  return out;
}

export type LinePoints = {
  /** UTC seconds, ascending, unique. */
  xs: number[];
  /** The source ISO per x — the `pt:<iso>` anchor is built from it. */
  ts: string[];
  series: { label: string; values: (number | null)[] }[];
  /** The source row per x (the hover tooltip's fields). */
  rows: ViewRow[];
};

/** Rows → aligned line series (T7): a row missing a parseable time drops
 *  alone; a non-numeric cell is a GAP (null), not a dropped row; duplicate
 *  seconds collapse last-wins (uPlot wants a strictly ascending x, and a
 *  duplicate is a data bug we render past). Pure. */
export function toLinePoints(rows: ViewRow[], spec: ViewSpec): LinePoints {
  const columns = lineSeriesColumns(rows, spec);
  const byTime = new Map<number, { ts: string; row: ViewRow }>();
  for (const row of rows) {
    const iso = rowTimeIso(row);
    if (iso === null) continue;
    const t = isoToSeconds(iso);
    if (t === null) continue;
    byTime.set(t, { ts: iso, row });
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);
  const at = (t: number) => byTime.get(t) as { ts: string; row: ViewRow };
  return {
    xs: times,
    ts: times.map((t) => at(t).ts),
    rows: times.map((t) => at(t).row),
    series: columns.map((label) => ({ label, values: times.map((t) => numericCell(at(t).row[label])) })),
  };
}

export type LineDomains = {
  /** The UNION time domain across every chart, UTC seconds; null when no
   *  chart has a point. */
  x: [number, number] | null;
  /** One shared value domain — only when every chart draws the SAME series
   *  set (same units by declaration); null means per-panel auto. */
  y: [number, number] | null;
};

/** Shared axes for small multiples (SWIT-70). X is always the union — the
 *  whole point of multiples is reading the same moment down a column. Y is
 *  shared only when every chart's series LABEL SET matches (the honest proxy
 *  for "same units"; gamma next to volume must not share a scale), padded 4%
 *  so the extremes are not on the frame. Pure. */
export function lineDomains(charts: readonly LinePoints[]): LineDomains {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  for (const c of charts) {
    if (c.xs.length === 0) continue;
    if (c.xs[0] < xMin) xMin = c.xs[0];
    if (c.xs[c.xs.length - 1] > xMax) xMax = c.xs[c.xs.length - 1];
  }
  const x: [number, number] | null = xMin <= xMax ? [xMin, xMax] : null;
  const drawn = charts.filter((c) => c.series.length > 0);
  const setOf = (c: LinePoints) => c.series.map((s) => s.label).sort().join(" ");
  const sameUnits = drawn.length > 1 && drawn.every((c) => setOf(c) === setOf(drawn[0]));
  let y: [number, number] | null = null;
  if (sameUnits) {
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;
    for (const c of drawn) {
      for (const s of c.series) {
        for (const v of s.values) {
          if (v === null || !Number.isFinite(v)) continue;
          if (v < yMin) yMin = v;
          if (v > yMax) yMax = v;
        }
      }
    }
    if (yMin <= yMax) {
      const pad = (yMax - yMin) * 0.04 || Math.abs(yMax) * 0.04 || 1;
      y = [yMin - pad, yMax + pad];
    }
  }
  return { x, y };
}

/** Every field of a row as `[key, printed value]` in the row's own order —
 *  the hover tooltip's lines (T7). Objects print as compact JSON, null/
 *  undefined as an empty string; long values are cut so the tooltip stays a
 *  card. Pure. */
export function rowFields(row: ViewRow, cap = 80): [string, string][] {
  return Object.entries(row).map(([k, v]) => {
    let s: string;
    if (v === null || v === undefined) s = "";
    else if (typeof v === "object") {
      try {
        s = JSON.stringify(v);
      } catch {
        s = String(v);
      }
    } else s = String(v);
    return [k, s.length > cap ? `${s.slice(0, cap - 1)}…` : s];
  });
}

// ── Timeline (T8): price over a match, sized marks, score steps ──────────────

/** The column a mark's radius comes from when the spec names none. */
export const TIMELINE_SIZE_DEFAULT = "size_z";
/** The readable range a mark's radius is clamped to (CSS px). */
export const MARK_RADIUS_MIN = 3;
export const MARK_RADIUS_MAX = 12;
/** The four score columns a timeline draws as steps, when present. */
export const SCORE_COLUMNS = ["sets_p1", "sets_p2", "games_p1", "games_p2"] as const;

/** The anchor key for a timeline mark (T8): by time, like `pt:`/`bar:`. */
export function tradeKey(ts: string): string {
  return `trade:${ts}`;
}

/** A mark's radius from its size value and the column's max: the sqrt of
 *  its SHARE of the max (area reads as size, and it flattens a heavy tail
 *  like `count`), scaled onto [MIN, MAX] and clamped there — a null or
 *  non-positive value draws the smallest mark, never no mark. Pure. */
export function markRadius(value: number | null, max: number): number {
  if (value === null || !Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) {
    return MARK_RADIUS_MIN;
  }
  const share = Math.min(1, value / max);
  const r = MARK_RADIUS_MIN + (MARK_RADIUS_MAX - MARK_RADIUS_MIN) * Math.sqrt(share);
  return Math.min(MARK_RADIUS_MAX, Math.max(MARK_RADIUS_MIN, r));
}

/** Which player a moment backs — `backs_player` 1 | 2 (number or string),
 *  else null: the renderer tones a mark `--up` for 1 (pushes player 1's
 *  price up), `--dn` for 2, accent otherwise. Pure. */
export function timelineSide(row: ViewRow): 1 | 2 | null {
  const n = numericCell(row.backs_player);
  return n === 1 ? 1 : n === 2 ? 2 : null;
}

export type TimelineSteps = {
  setsP1: (number | null)[];
  setsP2: (number | null)[];
  gamesP1: (number | null)[];
  gamesP2: (number | null)[];
  /** The largest games count seen — the band's scale. */
  gamesMax: number;
};

export type TimelinePoints = {
  /** UTC seconds, FRACTIONAL (millisecond precision), ascending, unique. */
  xs: number[];
  /** The source ISO per x — the `trade:<iso>` anchor is built from it. */
  ts: string[];
  /** The source row per x (the hover tooltip's fields). */
  rows: ViewRow[];
  /** The price per x; a row without a parseable price is a GAP. */
  price: (number | null)[];
  /** The size value per x (null when absent) and the column's max. */
  size: (number | null)[];
  sizeMax: number;
  /** The mark radius per x — `markRadius` applied, already clamped. */
  radius: number[];
  side: (1 | 2 | null)[];
  /** The score as steps; null when the rows carry none of the four columns. */
  steps: TimelineSteps | null;
};

/** ISO → UTC MILLISECONDS with the candle rule (naive = UTC); null when
 *  unparseable. The timeline keys on this rather than seconds because two
 *  flagged trades a second apart are two moments, not one. Pure. */
export function isoToMillis(ts: string): number | null {
  const t = ts.trim().replace(" ", "T");
  const zoned = /(Z|[+-]\d\d:?\d\d)$/i.test(t) ? t : `${t}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? ms : null;
}

/** Rows → the timeline's aligned arrays (T8). A row without a parseable
 *  time drops alone; the same millisecond collapses last-wins; a
 *  non-numeric price is a gap; the size column is the spec's `sizeColumn`
 *  else `size_z`; the score arrays exist only when at least one row carries
 *  one of the four score columns. Pure. */
export function toTimelinePoints(rows: ViewRow[], spec: ViewSpec): TimelinePoints {
  const sizeColumn = spec.sizeColumn ?? TIMELINE_SIZE_DEFAULT;
  const byMs = new Map<number, { ts: string; row: ViewRow }>();
  for (const row of rows) {
    const iso = rowTimeIso(row);
    if (iso === null) continue;
    const ms = isoToMillis(iso);
    if (ms === null) continue;
    byMs.set(ms, { ts: iso, row });
  }
  const times = [...byMs.keys()].sort((a, b) => a - b);
  const at = (t: number) => byMs.get(t) as { ts: string; row: ViewRow };
  const ordered = times.map((t) => at(t).row);
  const size = ordered.map((r) => numericCell(r[sizeColumn]));
  const sizeMax = size.reduce<number>((m, v) => (v !== null && v > m ? v : m), 0);
  const hasScore = ordered.some((r) => SCORE_COLUMNS.some((c) => numericCell(r[c]) !== null));
  let steps: TimelineSteps | null = null;
  if (hasScore) {
    const col = (c: (typeof SCORE_COLUMNS)[number]) => ordered.map((r) => numericCell(r[c]));
    const gamesP1 = col("games_p1");
    const gamesP2 = col("games_p2");
    const gamesMax = [...gamesP1, ...gamesP2].reduce<number>((m, v) => (v !== null && v > m ? v : m), 0);
    steps = { setsP1: col("sets_p1"), setsP2: col("sets_p2"), gamesP1, gamesP2, gamesMax };
  }
  return {
    xs: times.map((t) => t / 1000),
    ts: times.map((t) => at(t).ts),
    rows: ordered,
    price: ordered.map((r) => numericCell(r.price)),
    size,
    sizeMax,
    radius: size.map((v) => markRadius(v, sizeMax)),
    side: ordered.map(timelineSide),
    steps,
  };
}

/** The toolbar's coverage line for a timeline (T8): `meta.coverage` (the
 *  exporter's words for what the rows ARE — "flagged moments only") with
 *  `N of M trades` when `meta.n_trades` is a number; coverage alone with
 *  the shown count when it is not; `N moments` with no meta at all, which
 *  claims nothing about the tape. Pure. */
export function timelineNote(meta: ViewMeta | null, shown: number): string {
  const coverage =
    meta && typeof meta.coverage === "string" && meta.coverage.trim().length > 0 ? meta.coverage.trim() : null;
  const total = meta ? numericCell(meta.n_trades) : null;
  if (coverage && total !== null) return `${coverage} · ${shown} of ${total} trades`;
  if (coverage) return `${coverage} · ${shown} moments`;
  return `${shown} moments`;
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
 *  label), `bar:<iso>` on candles / `pt:<iso>` on a line (the marker sitting
 *  on that bar or point — its id, else its ts — or the bar's own ts when no
 *  marker does), `bar:<key>` on a BAR view (the category — the spec's kind
 *  decides which `bar:` this is). Pure; null when the anchor is not one of
 *  ours. */
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
  if (anchorKey.startsWith("bar:") && ctx.spec.kind === "bar") {
    const key = anchorKey.slice(4);
    return key.length > 0 && toBarRows(ctx.rows, ctx.spec).some((b) => b.key === key) ? { key, label: key } : null;
  }
  if (anchorKey.startsWith("trade:")) {
    // T8: the moment's own stamp is the key — a timeline has no markers of
    // its own (every mark IS a moment).
    const iso = anchorKey.slice(6);
    return iso.length > 0 ? { key: iso, label: iso } : null;
  }
  if (anchorKey.startsWith("bar:") || anchorKey.startsWith("pt:")) {
    const iso = anchorKey.slice(anchorKey.indexOf(":") + 1);
    if (iso.length === 0) return null;
    const bars: { ts: string }[] = anchorKey.startsWith("pt:")
      ? toLinePoints(ctx.rows, ctx.spec).ts.map((ts) => ({ ts }))
      : toOhlcRows(ctx.rows);
    const marker = markerAtBar(bars, ctx.spec.markers ?? [], iso);
    if (marker) return { key: marker.id ?? marker.ts, label: marker.label || marker.ts };
    return { key: iso, label: iso };
  }
  return null;
}

/** The SOURCE ROW behind an anchor the DOM renderers stamp — what the hover
 *  tooltip prints (T7): `row:<key>` → the first row whose key value is that
 *  key (the table's own dedupe rule), `bin:<n>` → that bin's row, `bar:<key>`
 *  on a bar view → that category's row. Canvas anchors (`bar:<iso>` on
 *  candles, `pt:<iso>`) answer null — those charts carry their own readout.
 *  Pure. */
export function rowForAnchor(anchorKey: string, ctx: { rows: ViewRow[]; spec: ViewSpec }): ViewRow | null {
  if (anchorKey.startsWith("row:")) {
    const key = anchorKey.slice(4);
    return ctx.rows.find((r) => rowAnchorId(r, ctx.spec) === key) ?? null;
  }
  if (anchorKey.startsWith("bin:")) {
    const n = Number(anchorKey.slice(4));
    if (!Number.isInteger(n) || n < 0) return null;
    return toDistBins(ctx.rows, ctx.spec)[n]?.row ?? null;
  }
  if (anchorKey.startsWith("bar:") && ctx.spec.kind === "bar") {
    const key = anchorKey.slice(4);
    return toBarRows(ctx.rows, ctx.spec).find((b) => b.key === key)?.row ?? null;
  }
  if (anchorKey.startsWith("trade:")) {
    // T8: the timeline's marks are canvas anchors that DO answer — a mark is
    // a row, and the tooltip is the point of hovering one. The same
    // millisecond collapses last-wins in toTimelinePoints, so the LAST row
    // with that stamp is the one drawn.
    const iso = anchorKey.slice(6);
    const want = isoToMillis(iso);
    if (want === null) return null;
    let found: ViewRow | null = null;
    for (const r of ctx.rows) {
      const t = rowTimeIso(r);
      if (t !== null && isoToMillis(t) === want) found = r;
    }
    return found;
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
  if (drill.series) spec.series = drill.series;
  if (drill.valueColumn) spec.valueColumn = drill.valueColumn;
  if (drill.sizeColumn) spec.sizeColumn = drill.sizeColumn;
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
  if (spec.series && spec.series.length > 0) lines.push(`series    ${spec.series.join(" · ")}`);
  if (spec.valueColumn) lines.push(`value     ${spec.valueColumn}`);
  if (spec.kind === "timeline") lines.push(`size      ${spec.sizeColumn ?? TIMELINE_SIZE_DEFAULT}`);
  if (spec.markers && spec.markers.length > 0) lines.push(`markers   ${spec.markers.length}`);
  if (spec.filters && spec.filters.length > 0) {
    lines.push(`filters   ${spec.filters.map((f) => `${f.label ?? f.column} (${f.kind})`).join(" · ")}`);
  }
  if (spec.seriesLabels) {
    lines.push(`labels    ${Object.entries(spec.seriesLabels).map(([k, v]) => `${k} = ${v}`).join(" · ")}`);
  }
  if (spec.regions && spec.regions.length > 0) lines.push(`regions   ${spec.regions.length}`);
  if (spec.panels && spec.panels.length > 0) {
    lines.push(`panels    ${spec.panels.map((p) => p.title).join(" · ")}`);
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
  /** The data file's `meta` object, when it carries one (T8). */
  meta: ViewMeta | null;
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
  const [meta, setMeta] = useState<ViewMeta | null>(null);
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
    setMeta(null);
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
        const parsed = parseViewPayload(raw);
        if (parsed === null) {
          setDataError("the source did not contain rows (expected a JSON array of objects)");
          setRows(null);
          setMeta(null);
        } else {
          setRows(parsed.rows);
          setMeta(parsed.meta);
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
    meta,
    loading,
    rerun,
  };
}

// ── Small multiples (SWIT-70): each panel's rows ─────────────────────────────

export type PanelData = { title: string; rows: ViewRow[] | null; error: string | null };

const NO_PANELS: PanelData[] = [];

/** Load each panel's source ONCE per spec build, like the main load: an
 *  agent `update` moves builtAt and every panel re-reads; between builds a
 *  panel never refetches (v1: the toolbar's `re-run` re-reads the MAIN
 *  source only — a panel is a companion chart, not a live feed). Same
 *  loading rules as the main source: file through the guarded IPC, query
 *  against a loopback URL the parse already vetted. */
export function useViewPanels(threadId: string, spec: ViewSpec | null, active: boolean): PanelData[] {
  const [data, setData] = useState<PanelData[]>(NO_PANELS);
  const loadedForRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  useEffect(() => {
    const panels = spec?.panels;
    if (!spec || !panels || panels.length === 0) {
      loadedForRef.current = null;
      setData((prev) => (prev.length === 0 ? prev : NO_PANELS));
      return;
    }
    if (!active) return;
    const buildKey = `${spec.id}:${spec.builtAt}:${panels
      .map((p) => (p.source.type === "file" ? p.source.path : p.source.url))
      .join("|")}`;
    if (loadedForRef.current === buildKey) return;
    loadedForRef.current = buildKey;
    const seq = ++seqRef.current;
    setData(panels.map((p) => ({ title: p.title, rows: null, error: null })));
    panels.forEach((p, i) => {
      void (async () => {
        let next: PanelData;
        try {
          let raw: string;
          if (p.source.type === "file") {
            raw = await readViewData(threadId, p.source.path);
          } else {
            const init: RequestInit = p.source.body
              ? { method: "POST", headers: { "content-type": "application/json" }, body: p.source.body }
              : { method: "GET" };
            const res = await fetch(p.source.url, init);
            if (!res.ok) throw new Error(`the backend answered ${res.status}`);
            raw = await res.text();
          }
          const parsed = parseViewPayload(raw);
          next =
            parsed === null
              ? { title: p.title, rows: null, error: "not rows (expected a JSON array of objects)" }
              : { title: p.title, rows: parsed.rows, error: null };
        } catch (err) {
          next = { title: p.title, rows: null, error: String(err instanceof Error ? err.message : err) };
        }
        if (seq !== seqRef.current) return;
        setData((prev) => prev.map((d, j) => (j === i ? next : d)));
      })();
    });
  }, [threadId, spec, active]);
  return data;
}
