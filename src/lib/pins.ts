// Wireframe pins + notes (T7) — the PURE logic behind WireframeView.
//
// Storage (Decision 3: pin + text notes v1, stored IN the KB, committed with
// content): one `.pins.json` sidecar PER FOLDER, sitting next to the docs it
// annotates. Each pin carries `doc` (the doc's filename) so one sidecar
// serves every wireframe in that folder. Dot-prefixed files are excluded
// from the KB LISTING (kb.rs is_doc_file) but read/write fine — the sidecar
// is invisible in the tree yet versioned with the content.
//
// Sidecar shape (version 1):
//   { version: 1, pins: [{ id, doc, xPct, yPct, anchor?, note, createdAt }] }
//
// TOLERANT parse contract: the sidecar is hand-editable (it lives in a git
// checkout), so parsing preserves unknown fields — both top-level and
// per-pin — across a round-trip, drops only individually-invalid pin
// entries, and degrades to an empty v1 file when the JSON is unusable.
//
// Everything here is pure (no IPC, no DOM, no storage); WireframeView is the
// thin shell. The wireframe-view helpers (zoom clamp, iframe message
// validation) live at the bottom for the same reason — they guard the
// component's inputs and deserve direct unit tests.

// ── Types ────────────────────────────────────────────────────────────────────

// Type-only (erased at build): this module stays pure and importable in a
// plain node test, exactly like agentContext.ts, which takes the same type.
import type { Artifact, FileArtifact } from "../types";

export interface Pin {
  id: string;
  /** WHICH annotated thing this pin belongs to, inside its sidecar.
   *
   *  For a wireframe it is the doc's FILENAME (last path segment) — one
   *  sidecar serves every mockup in a folder. For a LIVE localhost preview
   *  (increment F) it is the ROUTE (`routeScopeOf`, e.g. `/` or
   *  `/cases?tab=open`) — one `live-pins.json` serves every route of a
   *  project's dev server. Same field, same filter (`pinsForDoc`), so the
   *  shared store and every pure op below are untouched by the new kind. */
  doc: string;
  /** Position as percent of the annotated surface: the mockup document's
   *  scroll size for a wireframe, the FRAME's own box for a live preview
   *  (which is all a cross-origin document lets us measure). */
  xPct: number;
  yPct: number;
  /** Best-effort DOM anchor (id / class chain) captured at placement.
   *  WIREFRAMES ONLY — a live pin is POSITIONAL and never DOM-anchored
   *  (Decision 3: anchoring a live app needs a script injected into the dev
   *  server, which stays rejected). */
  anchor?: string;
  note: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Unknown fields from hand-edits survive the round-trip. */
  [extra: string]: unknown;
}

/** A LIVE pin's extra fields (increment F, Decision 3). They ride in the same
 *  record as unknown-to-`sanitizePin` fields, which is exactly what the
 *  tolerant parse's round-trip guarantee is for — no second schema, no second
 *  writer, and a hand-edit still survives.
 *
 *  `viewport` is the frame size the percentages were taken against. It is
 *  RECORDED, never used to reposition: a percentage is already
 *  size-independent, and the viewport is what tells a reading agent (or Eric,
 *  months later) whether the note was about the desktop or the narrow layout.
 *  `url` is the full URL as loaded — `doc` holds only the route scope, so a
 *  server that comes back on a different port keeps its pins. */
export interface LivePinFields {
  url: string;
  viewport: { w: number; h: number };
}

export interface PinsFile {
  version: 1;
  pins: Pin[];
  [extra: string]: unknown;
}

export function emptyPinsFile(): PinsFile {
  return { version: 1, pins: [] };
}

// ── Sidecar path ─────────────────────────────────────────────────────────────

export const SIDECAR_NAME = ".pins.json";

/** `a/b/wire.html` → `a/b/.pins.json`; root-level docs → `.pins.json`. */
export function sidecarPathFor(docRelPath: string): string {
  const idx = docRelPath.lastIndexOf("/");
  return idx === -1 ? SIDECAR_NAME : `${docRelPath.slice(0, idx + 1)}${SIDECAR_NAME}`;
}

/** Last path segment — the `doc` key pins are filed under. */
export function docFileName(docRelPath: string): string {
  const idx = docRelPath.lastIndexOf("/");
  return idx === -1 ? docRelPath : docRelPath.slice(idx + 1);
}

// ── Repo mirror (increment C) ────────────────────────────────────────────────
// A wireframe can now live in a REPO, not just the KB, and pins must still
// work on it. They cannot be written NEXT to it: `kb_write_doc` is guarded to
// the KB root, and the architecture already settled the principle for the
// localhost case — MARKUP LIVES IN THE KB, REPOS STAY CLEAN. A repo file's
// annotations are therefore MIRRORED into the KB under one hidden tree:
//
//   repo `lodestar` + `specs/mockups/cases-compact-v1.html`
//     → `_repo-pins/lodestar/specs/mockups/.pins.json`, pin.doc = "cases-compact-v1.html"
//
// Properties of the scheme:
//   · HIDDEN — the top-level folder is `_`-prefixed, which both kb.rs
//     (skip_dir) and buildKbTree already exclude, so mirrored sidecars never
//     appear as KB documents. (A `<file>.pins.json` sidecar next to a mirrored
//     copy would NOT be hidden — `.json` is a KB doc extension — which is why
//     the whole tree is hidden at its root instead.)
//   · COLLISION-FREE — registry project keys are unique, and a repo-relative
//     path is unique within its project (multi-repo projects carry the repo
//     name as their first path component, per explorer.rs's virtual root).
//   · REVERSIBLE — strip `_repo-pins/`, the first segment is the project and
//     the rest is the repo-relative directory.
//   · SAME SHAPE as a KB sidecar — one `.pins.json` per FOLDER with `doc`
//     keyed by filename, so pins.ts's ops and pinsStore's one-record-per-
//     sidecar rule apply unchanged. There is still exactly ONE pins writer.

/** Hidden KB folder holding mirrored repo-file annotation sidecars. */
export const REPO_PINS_ROOT = "_repo-pins";

/** Where an artifact's pins live (KB-relative sidecar) and the `doc` key they
 *  are filed under inside it. */
export interface PinTarget {
  sidecarPath: string;
  docKey: string;
}

/** Normalize a path for use as KB-relative mirror segments: backslashes to
 *  forward slashes, and any component the KB write guard would reject (`.`,
 *  `..`, empty, or one containing `:`) dropped. Total by construction — a
 *  pathological input degrades to a shorter mirror path, never to an invalid
 *  one and never to a write outside the mirror tree. */
function mirrorSegments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== ".." && !seg.includes(":"));
}

/**
 * The sidecar + doc key for a file artifact. KB docs keep TODAY'S behaviour
 * exactly (sidecar next to the doc); repo files resolve into the hidden mirror
 * tree documented above. Total for both kinds — every file artifact has a
 * place for its pins, so no caller needs a null branch.
 */
export function pinTargetFor(artifact: FileArtifact): PinTarget {
  if (artifact.kind === "kb-doc") {
    return { sidecarPath: sidecarPathFor(artifact.path), docKey: docFileName(artifact.path) };
  }
  // COLLISION-FREE, and this is the assumption it rests on: a registry
  // project KEY is FLAT — one segment, no `/`. (explorer.rs reads keys as
  // registry.json object names and they title a project, never a route.) A key
  // containing `/` would split into several mirror segments and could land on
  // the same sidecar as a different project plus a leading directory:
  // `a/b` + `x.html` and `a` + `b/x.html` join identically. Nothing can
  // produce such a key today; if that ever changes this join needs an escape,
  // not a comment.
  const segments = [...mirrorSegments(artifact.project), ...mirrorSegments(artifact.path)];
  const mirrored = [REPO_PINS_ROOT, ...segments].join("/");
  return {
    sidecarPath: sidecarPathFor(mirrored),
    // The file's own name, exactly as a KB sidecar keys it. Falls back to the
    // raw path when normalization ate every segment (unreachable for a path
    // that came from the explorer backend).
    docKey: segments.length > 0 ? segments[segments.length - 1] : docFileName(artifact.path),
  };
}

// ── Live preview pins (increment F, Decision 3) ──────────────────────────────
// A localhost artifact has a URL, not a path, so it has no folder to put a
// sidecar next to. It files into ONE per-project file in the KB:
//
//   project `lodestar`, url http://localhost:5173/cases
//     → `lodestar/live-pins.json`, pin.doc = "/cases"
//
// Same principle as the repo mirror above — MARKUP LIVES IN THE KB, REPOS STAY
// CLEAN — and the same shape as every other sidecar, so `pinsForDoc`,
// `addPin`, `removePin`, `updatePinNote` and the ONE shared pinsStore writer
// all apply unchanged. Deliberately NOT dot-prefixed and NOT under `_`: unlike
// a wireframe's sidecar this file is a first-class artefact Eric (and an agent)
// is meant to find, and `<project>/live-pins.json` is where the spec put it.
// One consequence, accepted rather than worked around: `.json` IS a KB doc
// extension (kb.rs DOC_EXTENSIONS) and this file is not dot-prefixed, so it
// SHOWS UP in the KB tree as a document. That is the visible half of
// "agent-readable"; hiding it would mean either a dot prefix (making it as
// invisible as the wireframe sidecars this one is deliberately unlike) or a
// second `_` tree, which the spec did not ask for.
//
// SCOPING, and its honest limit. `doc` is the ROUTE, so pins placed on `/cases`
// do not appear on `/`. The route we can know is the one the ARTIFACT names:
// the frame is a real cross-origin document, so navigation INSIDE the live app
// is invisible to us (reading `contentWindow.location` throws — proven by the
// phase-1 probe). Changing route is therefore an explicit act — open another
// URL — and the rail says which route its pins belong to rather than pretending
// to follow along.

/** The per-project live-pin file name. */
export const LIVE_PINS_NAME = "live-pins.json";

/** The pin SCOPE for a live URL: path + query, normalized to at least `/`.
 *  The origin is deliberately dropped — a dev server that comes back on 5174
 *  after 5173 was taken is the same app, and its pins must survive that. */
export function routeScopeOf(url: string): string {
  try {
    const parsed = new URL(url);
    const scope = `${parsed.pathname}${parsed.search}`;
    return scope.length === 0 ? "/" : scope;
  } catch {
    // Not a parseable URL (hand-edited artifact, older blob) — scope by the
    // raw string rather than silently merging it with `/`.
    return url.length === 0 ? "/" : url;
  }
}

/** Where a LIVE artifact's pins live, and the `doc` key they file under.
 *  Total, like `pinTargetFor`: every localhost artifact has a place for pins. */
export function livePinTargetFor(artifact: Extract<Artifact, { kind: "localhost" }>): PinTarget {
  const segments = mirrorSegments(artifact.project);
  const dir = segments.join("/");
  return {
    sidecarPath: dir.length > 0 ? `${dir}/${LIVE_PINS_NAME}` : LIVE_PINS_NAME,
    docKey: routeScopeOf(artifact.url),
  };
}

/** Build a live pin. Same `createPin` shape plus the two live-only fields;
 *  `anchor` is structurally absent — a live pin is positional, always. */
export function createLivePin(
  args: {
    route: string;
    xPct: number;
    yPct: number;
    url: string;
    viewport: { w: number; h: number };
    note?: string;
  },
  id?: string,
  createdAt?: string
): Pin & LivePinFields {
  const base = createPin(
    { doc: args.route, xPct: args.xPct, yPct: args.yPct, note: args.note },
    id,
    createdAt
  );
  return {
    ...base,
    url: args.url,
    viewport: { w: Math.round(args.viewport.w), h: Math.round(args.viewport.h) },
  };
}

/** A pin's recorded viewport, when it has one (live pins do, wireframe pins
 *  don't). Reads through the tolerant `[extra: string]: unknown` index, so a
 *  hand-edited or older record degrades to null instead of throwing. */
export function livePinViewport(pin: Pin): { w: number; h: number } | null {
  const raw = pin.viewport;
  if (!isRecord(raw)) return null;
  return isFiniteNumber(raw.w) && isFiniteNumber(raw.h) ? { w: raw.w, h: raw.h } : null;
}

// ── Parse / serialize (tolerant) ─────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** A pin entry is valid when its REQUIRED fields are usable; everything else
 *  rides along untouched. */
function sanitizePin(v: unknown): Pin | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== "string" || v.id.length === 0) return null;
  if (typeof v.doc !== "string" || v.doc.length === 0) return null;
  if (!isFiniteNumber(v.xPct) || !isFiniteNumber(v.yPct)) return null;
  const pin: Pin = {
    ...v,
    id: v.id,
    doc: v.doc,
    xPct: v.xPct,
    yPct: v.yPct,
    note: typeof v.note === "string" ? v.note : "",
    createdAt: typeof v.createdAt === "string" ? v.createdAt : "",
  };
  // `anchor` is a KNOWN optional field — a wrong-typed value is repaired by
  // removal (unlike UNKNOWN fields, which ride along untouched).
  if (typeof v.anchor !== "string") delete pin.anchor;
  return pin;
}

/**
 * Parse sidecar text. Unusable JSON / non-object → fresh empty v1 file.
 * Otherwise: unknown TOP-LEVEL fields are preserved, `version` is normalized
 * to 1, invalid pin entries are dropped individually (a hand-edit typo in one
 * pin must not eat the rest).
 */
export function parsePinsFile(text: string): PinsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyPinsFile();
  }
  if (!isRecord(raw)) return emptyPinsFile();
  const pins = Array.isArray(raw.pins)
    ? raw.pins.map(sanitizePin).filter((p): p is Pin => p !== null)
    : [];
  return { ...raw, version: 1, pins };
}

/** Committed alongside content → stable 2-space indent + trailing newline so
 *  git diffs stay minimal and hand-edits feel native. */
export function serializePinsFile(file: PinsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ── Pure ops ─────────────────────────────────────────────────────────────────

/** Pins for one doc, in file order — display numbers are 1-based indexes into
 *  THIS list, so deleting renumbers automatically while ids stay stable. */
export function pinsForDoc(file: PinsFile, doc: string): Pin[] {
  return file.pins.filter((p) => p.doc === doc);
}

export function addPin(file: PinsFile, pin: Pin): PinsFile {
  return { ...file, pins: [...file.pins, pin] };
}

export function removePin(file: PinsFile, id: string): PinsFile {
  const pins = file.pins.filter((p) => p.id !== id);
  return pins.length === file.pins.length ? file : { ...file, pins };
}

export function updatePinNote(file: PinsFile, id: string, note: string): PinsFile {
  let changed = false;
  const pins = file.pins.map((p) => {
    if (p.id !== id || p.note === note) return p;
    changed = true;
    return { ...p, note };
  });
  return changed ? { ...file, pins } : file;
}

export function createPin(
  args: { doc: string; xPct: number; yPct: number; anchor?: string; note?: string },
  id: string = newPinId(),
  createdAt: string = new Date().toISOString()
): Pin {
  return {
    id,
    doc: args.doc,
    xPct: args.xPct,
    yPct: args.yPct,
    ...(args.anchor ? { anchor: args.anchor } : {}),
    note: args.note ?? "",
    createdAt,
  };
}

function newPinId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Wireframe view helpers (zoom, message validation) ────────────────────────

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 3;

/** Non-finite → 1 (identity zoom); otherwise clamped to [ZOOM_MIN, ZOOM_MAX]. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Exponential wheel zoom — symmetric in/out, smooth across devices. */
export function zoomAfterWheel(zoom: number, deltaY: number): number {
  return clampZoom(zoom * Math.exp(-deltaY * 0.0015));
}

/** sessionStorage key for the per-doc zoom level. Takes the artifact's
 *  IDENTITY (panelStore.artifactIdentity), not a bare path: a repo file and a
 *  KB doc can share a relative path, and two projects certainly can, so a
 *  path-keyed store would leak one document's zoom into another's. */
export function zoomStorageKey(artifactIdentity: string): string {
  return `sb-wf-zoom:${artifactIdentity}`;
}

/** Messages the INSTRUMENT script posts out of the iframe. NOTE: the
 *  `source: "sb-wireframe"` tag is forgeable — the component's identity check
 *  (`e.source === iframe.contentWindow`) is the real guard; this validator
 *  only establishes SHAPE. */
export type WireframeMessage =
  | { type: "ready" }
  | { type: "pin-place"; xPct: number; yPct: number; anchor?: string }
  | { type: "pin-click"; id: string }
  | { type: "wheel-zoom"; deltaY: number };

export const WIREFRAME_MSG_SOURCE = "sb-wireframe";

export function parseWireframeMessage(data: unknown): WireframeMessage | null {
  if (!isRecord(data) || data.source !== WIREFRAME_MSG_SOURCE) return null;
  switch (data.type) {
    case "ready":
      return { type: "ready" };
    case "pin-place": {
      if (!isFiniteNumber(data.xPct) || !isFiniteNumber(data.yPct)) return null;
      const anchor = typeof data.anchor === "string" && data.anchor ? data.anchor : undefined;
      return { type: "pin-place", xPct: data.xPct, yPct: data.yPct, ...(anchor ? { anchor } : {}) };
    }
    case "pin-click":
      return typeof data.id === "string" && data.id ? { type: "pin-click", id: data.id } : null;
    case "wheel-zoom":
      return isFiniteNumber(data.deltaY) ? { type: "wheel-zoom", deltaY: data.deltaY } : null;
    default:
      return null;
  }
}
