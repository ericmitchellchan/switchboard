// REPORT lexical layer (SWIT-73): how a report's MARKDOWN is cut into
// segments before anything is parsed as a spec.
//
// A report is a `view` of kind `report` whose source is a markdown file in
// the thread's working directory. Inside it, a fenced code block whose info
// string is `view` embeds a view spec (the same fields the `view` tool takes,
// NO id — the block's POSITION indexes it) and one whose info string is
// `stat` embeds stat tiles ({label, value, n?} or an array of them). This
// module is purely LEXICAL: it finds the fences and hands back raw bodies;
// the SPEC semantics (JSON parse, kind rules, id derivation) live in
// viewStore's `parseInlineViewSpec`, which imports from here — never the
// other way round, so viewStore's import-graph tripwire stays honest.
//
// Fence grammar, deliberately narrow:
//   · a line that is exactly ```view or ```stat (trailing spaces tolerated)
//     OPENS a block; a line that is exactly ``` CLOSES it;
//   · any OTHER fence line — backtick or tilde, 3+ of either, per CommonMark —
//     opens an ordinary code fence, and a ```view line inside one is code,
//     not a block. The state machine tracks the opening fence's CHARACTER and
//     LENGTH and closes only on a matching-or-longer run of the same
//     character, so a ````markdown example quoting a full ```view block stays
//     narrative and a ~~~ fence is not blind to backticks inside it;
//   · CRLF is folded to LF before splitting, so a file written on Windows
//     cuts identically;
//   · an UNCLOSED view/stat fence at EOF is still that block (its body runs
//     to the end) — a torn write renders as one block error, not as a page
//     of raw JSON.
//
// Blocks are numbered 1-based across BOTH kinds in document order — the
// number an error card names, the `b<n>` in a derived spec id, the `#b<n>`
// pin-scope suffix and the `block` field on a drilled child's artifact all
// come from this one count. LIVE blocks are capped at REPORT_BLOCK_CAP:
// blocks past the cap fall back to plain code fences in the narrative, with
// ONE `overflow` segment (rendered as one error card) marking where the cap
// bit — a runaway generator degrades to code, never to an unbounded page of
// charts. The cap lives HERE only; the MCP server states it in the tool
// description but cannot see inside the file to enforce it.

import { isStatTone, STAT_TONES, type StatTone } from "./viewTone";

export type ReportSegment =
  | { kind: "markdown"; text: string }
  | { kind: "view"; block: number; body: string }
  | { kind: "stat"; block: number; body: string }
  | { kind: "facts"; block: number; body: string }
  | { kind: "overflow"; total: number };

/** Most view/stat/facts blocks one report renders LIVE; the rest render as code. */
export const REPORT_BLOCK_CAP = 24;

// SWIT-96 recognises a third live fence, ```facts — a dashboard's header
// card (see "Facts header" below). It is numbered and capped alongside
// view/stat, but never packs into a row (see `packRows`).
const OPEN_RE = /^```(view|stat|facts)\s*$/;
const CLOSE_RE = /^```\s*$/;
const FENCE_RE = /^(`{3,}|~{3,})/;

/** Cut a report's markdown into narrative and embedded blocks. Pure. */
export function splitReport(markdown: string): ReportSegment[] {
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: ReportSegment[] = [];
  let md: string[] = [];
  let body: string[] = [];
  let mode: "normal" | "code" | "view" | "stat" | "facts" = "normal";
  let codeClose: RegExp | null = null;
  let block = 0;
  const flushMd = () => {
    const text = md.join("\n");
    if (text.trim().length > 0) out.push({ kind: "markdown", text });
    md = [];
  };
  const flushBlock = (kind: "view" | "stat" | "facts") => {
    out.push({ kind, block: ++block, body: body.join("\n") });
    body = [];
  };
  for (const line of lines) {
    if (mode === "view" || mode === "stat" || mode === "facts") {
      if (CLOSE_RE.test(line)) {
        flushBlock(mode);
        mode = "normal";
      } else {
        body.push(line);
      }
      continue;
    }
    if (mode === "code") {
      md.push(line);
      if (codeClose !== null && codeClose.test(line)) {
        mode = "normal";
        codeClose = null;
      }
      continue;
    }
    const open = OPEN_RE.exec(line);
    if (open) {
      flushMd();
      mode = open[1] as "view" | "stat" | "facts";
      continue;
    }
    md.push(line);
    const fence = FENCE_RE.exec(line);
    if (fence) {
      mode = "code";
      const ch = fence[1][0];
      codeClose = new RegExp(`^${ch}{${fence[1].length},}\\s*$`);
    }
  }
  if (mode === "view" || mode === "stat" || mode === "facts") flushBlock(mode);
  else flushMd();
  return capReportBlocks(out);
}

/** Enforce REPORT_BLOCK_CAP: blocks past the cap become plain code fences in
 *  the narrative, and ONE `overflow` segment (carrying the TOTAL block count)
 *  takes the first over-cap block's place. Under the cap this is identity. */
function isLiveSegment(s: ReportSegment): s is Extract<ReportSegment, { block: number; body: string }> {
  return s.kind === "view" || s.kind === "stat" || s.kind === "facts";
}

function capReportBlocks(segs: ReportSegment[]): ReportSegment[] {
  const total = segs.reduce((n, s) => (isLiveSegment(s) ? n + 1 : n), 0);
  if (total <= REPORT_BLOCK_CAP) return segs;
  const out: ReportSegment[] = [];
  let marked = false;
  for (const seg of segs) {
    if (!isLiveSegment(seg) || seg.block <= REPORT_BLOCK_CAP) {
      out.push(seg);
      continue;
    }
    if (!marked) {
      out.push({ kind: "overflow", total });
      marked = true;
    }
    out.push({ kind: "markdown", text: `\`\`\`${seg.kind}\n${seg.body}\n\`\`\`` });
  }
  return out;
}

// ── Report layout: width + packed rows (SWIT-96) ───────────────────────────
// A dashboard needs blocks SIDE BY SIDE, not one per scroll-length row. Any
// ```view or ```stat block's JSON may carry a top-level `"width"` — read
// here, and STRIPPED before the body reaches parseInlineViewSpec /
// parseStatTiles (neither rejects an unknown key today, but `width` is
// report LAYOUT, not part of either grammar, and must not ride through as a
// spec field a future kind could collide with). A ```facts block never
// packs (see parseFactsBlock) and an array-shaped ```stat body (today's
// multi-tile ROW convention) has no syntactic top-level place for `width`
// in JSON — both simply read as `full`, which is the honest default.

export type ReportWidth = "full" | "half" | "third";
const REPORT_WIDTHS: readonly ReportWidth[] = ["full", "half", "third"];

function isReportWidth(v: unknown): v is ReportWidth {
  return typeof v === "string" && (REPORT_WIDTHS as readonly string[]).includes(v);
}

/** A view/stat block's requested column width, `full` on absence, malformed
 *  JSON (the block itself will render as an error card; layout must not
 *  throw over it) or a non-object body (an array of stat tiles). Pure. */
export function blockWidth(body: string): ReportWidth {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return "full";
  }
  if (!isRecord(data)) return "full";
  return isReportWidth(data.width) ? data.width : "full";
}

/** The same block's body with `width` removed — what parseInlineViewSpec /
 *  parseStatTiles actually parse. Malformed/non-object JSON passes through
 *  unchanged so the downstream parser reports the real error. Pure. */
export function stripBlockWidth(body: string): string {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isRecord(data) || !("width" in data)) return body;
  const { width: _width, ...rest } = data;
  return JSON.stringify(rest);
}

export type ReportRow = { columns: number; segments: ReportSegment[] };

/** Group CONSECUTIVE `view`/`stat` blocks of the SAME non-full width, with
 *  no narrative between them, into one grid row: two `half`s or three
 *  `third`s side by side. A `full` block, a `facts` block, an `overflow`
 *  card, a markdown segment, or a width change ENDS the open row and starts
 *  its own one-column one; a leftover (an odd `half`, a lone `third`) takes
 *  the rest of ITS row — `columns` is however many segments actually landed
 *  in it, never padded with an empty cell. Order is preserved throughout.
 *  Pure. */
export function packRows(segments: readonly ReportSegment[]): ReportRow[] {
  const rows: ReportRow[] = [];
  let current: ReportSegment[] = [];
  let currentWidth: ReportWidth | null = null;

  const flush = () => {
    if (current.length === 0) return;
    rows.push({ columns: current.length, segments: current });
    current = [];
    currentWidth = null;
  };

  for (const seg of segments) {
    const packable = seg.kind === "view" || seg.kind === "stat";
    const width = packable ? blockWidth(seg.body) : "full";
    if (!packable || width === "full") {
      flush();
      rows.push({ columns: 1, segments: [seg] });
      continue;
    }
    const maxCols = width === "half" ? 2 : 3;
    if (currentWidth !== width || current.length >= maxCols) flush();
    current.push(seg);
    currentWidth = width;
    if (current.length >= maxCols) flush();
  }
  flush();
  return rows;
}

// ── Stat tiles ───────────────────────────────────────────────────────────────

/** One tile: the label, the figure, an optional n, and (2026-09-09, Ky's
 *  report cards) an optional `note` — one plain line under the figure
 *  ("4 – 7% is called good on ChatGPT Ads") — and an optional `tag`, a few
 *  words drawn as an accent chip ("2 – 3× benchmark"). SWIT-81: an optional
 *  `tone` colours the FIGURE only — see lib/viewTone.ts's `statTone`.
 *  SWIT-96: an optional `series` (a sparkline over up to STAT_SERIES_CAP
 *  points) and `delta` (one line under the figure, e.g. "+2 vs prior 30d")
 *  — Ky's headline-tile pair (StatusViz's Sparkline, UserOverviewTab's
 *  Stat). */
export type StatTile = {
  label: string;
  value: string;
  n?: number;
  note?: string;
  tag?: string;
  tone?: StatTone;
  series?: number[];
  delta?: string;
};

/** Most tiles one ```stat block renders (a row, not a dashboard). */
export const STAT_TILE_CAP = 8;
export const STAT_LABEL_CAP = 60;
export const STAT_VALUE_CAP = 40;
export const STAT_NOTE_CAP = 120;
export const STAT_TAG_CAP = 32;
/** A sparkline reads the most recent STAT_SERIES_CAP points; an over-cap
 *  series is trimmed to its TAIL (the trend that is still visible at 72px
 *  wide is the recent one), not an error — unlike STAT_TILE_CAP, this is a
 *  display-width limit, the same kind of cap as STAT_LABEL_CAP/STAT_VALUE_CAP. */
export const STAT_SERIES_CAP = 60;
export const STAT_DELTA_CAP = 40;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTile(raw: unknown, at: string): { tile: StatTile } | { error: string } {
  if (!isRecord(raw)) return { error: `${at} must be {label, value, n?, note?, tag?}` };
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (label.length === 0) return { error: `${at} has no label` };
  const v = raw.value;
  const value =
    typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  if (value.length === 0) return { error: `${at} has no value (a string or a finite number)` };
  const tile: StatTile = { label: label.slice(0, STAT_LABEL_CAP), value: value.slice(0, STAT_VALUE_CAP) };
  if (raw.n !== undefined && raw.n !== null) {
    if (typeof raw.n !== "number" || !Number.isFinite(raw.n)) return { error: `${at}.n must be a number` };
    tile.n = raw.n;
  }
  for (const [key, cap] of [["note", STAT_NOTE_CAP], ["tag", STAT_TAG_CAP], ["delta", STAT_DELTA_CAP]] as const) {
    const v2 = raw[key];
    if (v2 === undefined || v2 === null) continue;
    if (typeof v2 !== "string") return { error: `${at}.${key} must be a string` };
    const clean = v2.trim();
    if (clean.length > 0) tile[key] = clean.slice(0, cap);
  }
  // SWIT-81: strict, like `n` — a bad tone errors the whole block rather
  // than silently falling back, so a typo is visible instead of guessed at.
  if (raw.tone !== undefined && raw.tone !== null) {
    if (!isStatTone(raw.tone)) return { error: `${at}.tone must be one of ${STAT_TONES.join(", ")}` };
    tile.tone = raw.tone as StatTone;
  }
  // SWIT-96: `series` is STRICT too — a non-array or a non-numeric entry
  // errors the tile rather than silently dropping the sparkline, matching
  // `n`/`tone`. An over-cap array is trimmed, not an error (see the cap's
  // own comment).
  if (raw.series !== undefined && raw.series !== null) {
    if (!Array.isArray(raw.series)) return { error: `${at}.series must be an array of finite numbers` };
    const nums: number[] = [];
    for (const n of raw.series) {
      if (typeof n !== "number" || !Number.isFinite(n)) {
        return { error: `${at}.series must hold only finite numbers` };
      }
      nums.push(n);
    }
    tile.series = nums.length > STAT_SERIES_CAP ? nums.slice(nums.length - STAT_SERIES_CAP) : nums;
  }
  return { tile };
}

/** A ```stat block's body → tiles, STRICT per block: one bad entry errors the
 *  whole block (the error card names it), because a half-drawn tile row is a
 *  wrong number wearing a confident face. Pure. */
export function parseStatTiles(body: string): { tiles: StatTile[]; error: null } | { tiles: null; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { tiles: null, error: "not valid JSON — expected {label, value, n?} or an array of them" };
  }
  const list = Array.isArray(data) ? data : [data];
  if (list.length === 0) return { tiles: null, error: "an empty array renders nothing" };
  if (list.length > STAT_TILE_CAP) {
    return { tiles: null, error: `${list.length} tiles; the cap is ${STAT_TILE_CAP}` };
  }
  const tiles: StatTile[] = [];
  for (let i = 0; i < list.length; i++) {
    const parsed = parseTile(list[i], list.length === 1 ? "the tile" : `tiles[${i}]`);
    if ("error" in parsed) return { tiles: null, error: parsed.error };
    tiles.push(parsed.tile);
  }
  return { tiles, error: null };
}

// ── Facts header (SWIT-96) ───────────────────────────────────────────────────
// A dashboard's opening card — Ky's FactsRow re-cut for a REPORT rather than
// a doc's front matter (`lib/facts.ts`, which this does not touch: that rule
// reads a `**Key:** value` paragraph out of arbitrary markdown; this one
// reads a fenced ```facts block, a report-only grammar). A raised card of
// label/value pairs, always full width — see `packRows`.

export const FACTS_ITEM_CAP = 8;
export const FACTS_LABEL_CAP = 40;
export const FACTS_VALUE_CAP = 60;

export const FACTS_TONES = ["accent", "amber", "neutral"] as const;
export type FactsTone = (typeof FACTS_TONES)[number];

export function isFactsTone(v: unknown): v is FactsTone {
  return typeof v === "string" && (FACTS_TONES as readonly string[]).includes(v);
}

/** One fact: a label and a value, optionally toned. */
export type FactsItem = { label: string; value: string; tone?: FactsTone };

function parseFactsItem(raw: unknown, at: string): { item: FactsItem } | { error: string } {
  if (!isRecord(raw)) return { error: `${at} must be {label, value, tone?}` };
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (label.length === 0) return { error: `${at} has no label` };
  const v = raw.value;
  const value =
    typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  if (value.length === 0) return { error: `${at} has no value (a string or a finite number)` };
  const item: FactsItem = { label: label.slice(0, FACTS_LABEL_CAP), value: value.slice(0, FACTS_VALUE_CAP) };
  if (raw.tone !== undefined && raw.tone !== null) {
    if (!isFactsTone(raw.tone)) return { error: `${at}.tone must be one of ${FACTS_TONES.join(", ")}` };
    item.tone = raw.tone;
  }
  return { item };
}

/** A ```facts block's body → items, STRICT per block (one bad entry errors
 *  the whole card) — the same rule `parseStatTiles` applies, over an array
 *  ONLY: a facts header is a row of pairs, never a lone object shorthand.
 *  Pure. */
export function parseFactsBlock(body: string): { items: FactsItem[]; error: null } | { items: null; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { items: null, error: "not valid JSON — expected an array of {label, value, tone?}" };
  }
  if (!Array.isArray(data)) return { items: null, error: "must be an array of {label, value, tone?}" };
  if (data.length === 0) return { items: null, error: "an empty array renders nothing" };
  if (data.length > FACTS_ITEM_CAP) {
    return { items: null, error: `${data.length} items; the cap is ${FACTS_ITEM_CAP}` };
  }
  const items: FactsItem[] = [];
  for (let i = 0; i < data.length; i++) {
    const parsed = parseFactsItem(data[i], data.length === 1 ? "the item" : `items[${i}]`);
    if ("error" in parsed) return { items: null, error: parsed.error };
    items.push(parsed.item);
  }
  return { items, error: null };
}

// ── Evidence → heading handoff (one-shot) ────────────────────────────────────
// An evidence address `view:<id>#h:<slug>` opens the report AND names a
// heading. The open goes through the ordinary artifact path (panelStore),
// which carries no anchor — so the anchor rides this module-level one-shot:
// PageView requests it just before opening, ReportView takes it once its
// markdown is on screen and scrolls the stamped heading into view. RUNTIME
// ONLY, single slot: a second request replaces the first (the newer click is
// the intent), and a take for the wrong report answers null and leaves it.
// The slot is OBSERVABLE: each request bumps a nonce and notifies listeners
// (useSyncExternalStore shape), so a ReportView that is ALREADY on screen
// (a floated ✦ page clicking an address at the open report) takes the anchor
// now instead of parking it until some unrelated re-render minutes later.
// Taking is quiet — consumption changes nothing a subscriber renders from.

let pendingAnchor: { threadId: string; viewId: string; anchor: string } | null = null;
let anchorNonce = 0;
const anchorListeners = new Set<() => void>();

export function requestReportAnchor(threadId: string, viewId: string, anchor: string): void {
  pendingAnchor = { threadId, viewId, anchor };
  anchorNonce += 1;
  for (const listener of anchorListeners) listener();
}

/** Subscribe to anchor REQUESTS (useSyncExternalStore's subscribe half). */
export function subscribeReportAnchor(listener: () => void): () => void {
  anchorListeners.add(listener);
  return () => {
    anchorListeners.delete(listener);
  };
}

/** The request counter (useSyncExternalStore's snapshot half). */
export function reportAnchorNonce(): number {
  return anchorNonce;
}

export function takeReportAnchor(threadId: string, viewId: string): string | null {
  if (!pendingAnchor || pendingAnchor.threadId !== threadId || pendingAnchor.viewId !== viewId) return null;
  const anchor = pendingAnchor.anchor;
  pendingAnchor = null;
  return anchor;
}
