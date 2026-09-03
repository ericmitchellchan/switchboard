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

export type ReportSegment =
  | { kind: "markdown"; text: string }
  | { kind: "view"; block: number; body: string }
  | { kind: "stat"; block: number; body: string }
  | { kind: "overflow"; total: number };

/** Most view/stat blocks one report renders LIVE; the rest render as code. */
export const REPORT_BLOCK_CAP = 24;

const OPEN_RE = /^```(view|stat)\s*$/;
const CLOSE_RE = /^```\s*$/;
const FENCE_RE = /^(`{3,}|~{3,})/;

/** Cut a report's markdown into narrative and embedded blocks. Pure. */
export function splitReport(markdown: string): ReportSegment[] {
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: ReportSegment[] = [];
  let md: string[] = [];
  let body: string[] = [];
  let mode: "normal" | "code" | "view" | "stat" = "normal";
  let codeClose: RegExp | null = null;
  let block = 0;
  const flushMd = () => {
    const text = md.join("\n");
    if (text.trim().length > 0) out.push({ kind: "markdown", text });
    md = [];
  };
  const flushBlock = (kind: "view" | "stat") => {
    out.push({ kind, block: ++block, body: body.join("\n") });
    body = [];
  };
  for (const line of lines) {
    if (mode === "view" || mode === "stat") {
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
      mode = open[1] as "view" | "stat";
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
  if (mode === "view" || mode === "stat") flushBlock(mode);
  else flushMd();
  return capReportBlocks(out);
}

/** Enforce REPORT_BLOCK_CAP: blocks past the cap become plain code fences in
 *  the narrative, and ONE `overflow` segment (carrying the TOTAL block count)
 *  takes the first over-cap block's place. Under the cap this is identity. */
function capReportBlocks(segs: ReportSegment[]): ReportSegment[] {
  const total = segs.reduce((n, s) => (s.kind === "view" || s.kind === "stat" ? n + 1 : n), 0);
  if (total <= REPORT_BLOCK_CAP) return segs;
  const out: ReportSegment[] = [];
  let marked = false;
  for (const seg of segs) {
    if (seg.kind === "markdown" || seg.kind === "overflow" || seg.block <= REPORT_BLOCK_CAP) {
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

// ── Stat tiles ───────────────────────────────────────────────────────────────

export type StatTile = { label: string; value: string; n?: number };

/** Most tiles one ```stat block renders (a row, not a dashboard). */
export const STAT_TILE_CAP = 8;
export const STAT_LABEL_CAP = 60;
export const STAT_VALUE_CAP = 40;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseTile(raw: unknown, at: string): { tile: StatTile } | { error: string } {
  if (!isRecord(raw)) return { error: `${at} must be {label, value, n?}` };
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
