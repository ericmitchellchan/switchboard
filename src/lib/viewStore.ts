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

import { useCallback, useEffect, useRef, useState } from "react";
import { readThreadView, readViewData } from "./ipc";

export const VIEW_KINDS = ["table", "candles", "dist"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export type ViewSource =
  | { type: "file"; path: string }
  | { type: "query"; url: string; body?: string };

export type ViewMarker = { ts: string; label: string; id?: string };

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
};

/** Display window: past this many rows the renderer shows the first slice
 *  and SAYS so (the Rust byte cap guards the read; this guards the DOM). */
export const VIEW_ROW_WINDOW = 500;

export type ViewRow = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
  const src = data.source;
  let source: ViewSource | null = null;
  if (isRecord(src) && src.type === "file" && typeof src.path === "string" && src.path.length > 0) {
    source = { type: "file", path: src.path };
  } else if (isRecord(src) && src.type === "query" && typeof src.url === "string" && src.url.length > 0) {
    // LOOPBACK-ONLY, re-checked HERE (review): the MCP server validates on
    // the write side, but the spec is a plain file an agent could write with
    // its own tools — the READER enforcing the same rule makes it structural
    // rather than one-sided. Same pattern the server uses.
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(src.url)) {
      return { spec: null, specError: "the view spec's query url is not a local backend" };
    }
    source = { type: "query", url: src.url };
    if (typeof src.body === "string" && src.body.length > 0) source.body = src.body;
  }
  if (!source) return { spec: null, specError: "the view spec's source is malformed" };
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

export function useView(threadId: string, viewId: string, active: boolean): ViewRead {
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
  }, [threadId, viewId]);

  useEffect(() => {
    if (!active || threadId.length === 0 || viewId.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const raw = await readThreadView(threadId, viewId);
        if (cancelled || raw === lastSpecRawRef.current) return;
        lastSpecRawRef.current = raw;
        const parsed = parseViewSpec(raw);
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
  }, [threadId, viewId, active]);

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
