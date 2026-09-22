// KEPT VIEW (SWIT-53, half 1 — rendering only): the pure parse for a
// `.view.json` snapshot ViewChrome's `keep()` writes to
// `_scratch/<project>/<spec.id>-<stamp>.view.json` — `{spec, rows}`, no
// `meta` (verified by reading `keep()` in ViewSurface.tsx: it writes
// `JSON.stringify({spec, rows: rows ?? []}, null, 2)`; the ticket's "confirm
// whether meta rides along" — it does NOT today, but a hand-placed or future
// file carrying one is tolerated, never required).
//
// Reuses viewStore's own tolerant parsers rather than re-deriving the rules:
// `spec` round-trips through `parseViewSpec` (which takes a JSON STRING, so
// the nested object is re-stringified — the same trick `parseInlineViewSpec`
// uses for an embedded report block) and rows/meta through `parseViewPayload`.
// A malformed file never throws — every failure is a named string the caller
// shows as one inline error card, never a broken parent.

import { parseViewPayload, parseViewSpec, type ViewMeta, type ViewRow, type ViewSpec } from "./viewStore";

export interface KeptView {
  spec: ViewSpec;
  rows: ViewRow[];
  meta: ViewMeta | null;
}

export type KeptViewResult = { view: KeptView; error: null } | { view: null; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a kept view's file content. Pure. */
export function parseKeptView(raw: string): KeptViewResult {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { view: null, error: "the kept view file is empty" };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { view: null, error: "not valid JSON" };
  }
  if (!isPlainObject(data)) {
    return { view: null, error: "not an object — expected { spec, rows }" };
  }
  if (!("spec" in data)) {
    return { view: null, error: "missing \"spec\"" };
  }
  const { spec, specError } = parseViewSpec(JSON.stringify(data.spec));
  if (!spec) {
    return { view: null, error: specError ?? "malformed spec" };
  }
  // A report is a markdown file with live blocks — nothing about it is a
  // snapshot, and ViewChrome draws nothing for the kind. keep() never writes
  // one; a hand-placed file gets a named refusal instead of an empty frame.
  if (spec.kind === "report") {
    return { view: null, error: "a report cannot be kept — it is a document, not a snapshot" };
  }
  // Reuse parseViewPayload's rows/meta tolerance over the SAME two fields —
  // rows defaults to [] (keep() always writes the key, but an empty view is
  // still a renderable one), a non-array rows is refused outright rather than
  // silently emptied (that would hide a wrong file as a boring one).
  if ("rows" in data && !Array.isArray(data.rows)) {
    return { view: null, error: "\"rows\" is not an array" };
  }
  const payload = parseViewPayload(JSON.stringify({ rows: data.rows ?? [], meta: data.meta }));
  if (!payload) {
    return { view: null, error: "malformed rows" };
  }
  return { view: { spec, rows: payload.rows, meta: payload.meta }, error: null };
}
