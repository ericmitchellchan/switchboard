// SURFACE PARAMS (T9 — SWIT-63): a `surface` artifact may carry a flat string
// map naming a page STATE (`{instrument: "NQ", date: "2026-06-05"}`), so an
// Evidence row, a drill or the agent can point Eric at "Trading, NQ, that
// day" instead of "Trading". Two params sets are TWO artifacts — the map is
// part of the identity, so opening `?date=2026-06-05` beside `?date=2026-06-04`
// is two tabs, and a page reads its own set through page-api's
// `useSurfaceParams()`.
//
// This module is the ONE place the shape is enforced — the load gate
// (`sanitizeArtifact`), the identity, the route (`p.<key>` query params) and
// the Evidence address form all validate through it, so a map that passes one
// seam passes them all:
//   ≤ SURFACE_PARAM_MAX_KEYS keys · key `[a-z][a-zA-Z0-9_]*` · value ≤ 120 chars
//
// Tolerant where a RECORD is read back (a stored artifact keeps its valid keys
// and drops the rest — a strip must never lose a tab to one bad key), strict
// where an ADDRESS is parsed (`surface:lodestar/trading?bad key=1` is not a
// link at all: the row prints as plain text). Pure; imports nothing but types.

import type { Artifact } from "../types";

export type SurfaceParams = Readonly<Record<string, string>>;

export const SURFACE_PARAM_MAX_KEYS = 8;
export const SURFACE_PARAM_VALUE_MAX = 120;
/** A key: lower-case start, then word characters. `caseId`, `instrument`. */
export const SURFACE_PARAM_KEY = /^[a-z][a-zA-Z0-9_]*$/;

/** The frozen empty set every host hands a page with no params — ONE object,
 *  so a `useEffect([params])` in a page never re-fires on a fresh literal. */
export const NO_SURFACE_PARAMS: SurfaceParams = Object.freeze({});

export function isValidSurfaceParamKey(key: string): boolean {
  return SURFACE_PARAM_KEY.test(key);
}

/** TOLERANT read of a stored record: keep every valid `key: string` pair (a
 *  too-long value is cut to the cap, like a drill key), drop the rest, cap the
 *  count in insertion order. `undefined` when nothing valid remains, so a
 *  sanitized artifact carries no empty `params: {}`. */
export function sanitizeSurfaceParams(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidSurfaceParamKey(key) || typeof value !== "string" || value.length === 0) continue;
    if (n >= SURFACE_PARAM_MAX_KEYS) break;
    out[key] = value.length > SURFACE_PARAM_VALUE_MAX ? value.slice(0, SURFACE_PARAM_VALUE_MAX) : value;
    n += 1;
  }
  return n > 0 ? out : undefined;
}

/** STRICT parse of a query string (`instrument=NQ&date=2026-06-05`, with or
 *  without a leading `?`): every key must be valid, every value non-empty and
 *  within the cap, at most SURFACE_PARAM_MAX_KEYS pairs, no repeats. Null on
 *  any violation — an address is a link or it is not. An EMPTY query is a
 *  valid "no params". */
export function parseSurfaceQuery(query: string): Record<string, string> | undefined | null {
  const q = query.startsWith("?") ? query.slice(1) : query;
  if (q.length === 0) return undefined;
  let pairs: URLSearchParams;
  try {
    pairs = new URLSearchParams(q);
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  let n = 0;
  for (const [key, value] of pairs) {
    if (!isValidSurfaceParamKey(key)) return null;
    if (value.length === 0 || value.length > SURFACE_PARAM_VALUE_MAX) return null;
    if (key in out) return null;
    if (n >= SURFACE_PARAM_MAX_KEYS) return null;
    out[key] = value;
    n += 1;
  }
  return n > 0 ? out : undefined;
}

/** Canonical encoding for IDENTITY: keys sorted, URL-encoded, `k=v&k=v`. The
 *  same set in a different insertion order is the same artifact. */
export function encodeSurfaceParams(params: SurfaceParams | undefined): string {
  if (!params) return "";
  const keys = Object.keys(params).sort();
  if (keys.length === 0) return "";
  const pairs = new URLSearchParams();
  for (const key of keys) pairs.set(key, params[key]);
  return pairs.toString();
}

/** The compact suffix the strip tab and the header print — VALUES only, in
 *  the set's own order (` · NQ 2026-06-05`); the keys are the page's business.
 *  Empty string when there is nothing to say, so callers can concatenate. */
export function surfaceParamsSuffix(params: SurfaceParams | undefined): string {
  if (!params) return "";
  const values = Object.values(params).filter((v) => v.length > 0);
  return values.length > 0 ? ` · ${values.join(" ")}` : "";
}

/** Do two sets name the same state? (Order-insensitive.) */
export function sameSurfaceParams(a: SurfaceParams | undefined, b: SurfaceParams | undefined): boolean {
  return encodeSurfaceParams(a) === encodeSurfaceParams(b);
}

// ── The Evidence address form ────────────────────────────────────────────────
// `surface:<project>/<page>[?query]` — what the agent writes as an Evidence
// row's address to point Eric at a page state; the row becomes a link that
// opens that artifact in the preview slot. Project and page ids are the
// registry's `[A-Za-z0-9_-]` words (the same alphabet the surface-window
// label validates in lib.rs).

export type SurfaceArtifactRef = Extract<Artifact, { kind: "surface" }>;

const SURFACE_ADDRESS = /^surface:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(\?.*)?$/;

/** The artifact an Evidence address names, or null when it is not a (valid)
 *  surface address — a malformed query makes the WHOLE address a non-link. */
export function parseSurfaceAddress(address: string): SurfaceArtifactRef | null {
  const m = SURFACE_ADDRESS.exec(address.trim());
  if (!m) return null;
  const [, project, page, query] = m;
  const params = query ? parseSurfaceQuery(query) : undefined;
  if (params === null) return null;
  return params ? { kind: "surface", project, page, params } : { kind: "surface", project, page };
}

/** The inverse: the address the agent would write for an artifact. */
export function surfaceAddress(artifact: SurfaceArtifactRef): string {
  const query = encodeSurfaceParams(artifact.params);
  return `surface:${artifact.project}/${artifact.page}${query ? `?${query}` : ""}`;
}
