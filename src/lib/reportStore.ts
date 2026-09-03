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
//   · any OTHER ``` line opens an ordinary code fence — a ```view line inside
//     one is code, not a block (the state machine tracks it);
//   · CRLF is folded to LF before splitting, so a file written on Windows
//     cuts identically;
//   · an UNCLOSED view/stat fence at EOF is still that block (its body runs
//     to the end) — a torn write renders as one block error, not as a page
//     of raw JSON.
//
// Blocks are numbered 1-based across BOTH kinds in document order — the
// number an error card names, the `b<n>` in a derived spec id, the `#b<n>`
// pin-scope suffix and the `block` field on a drilled child's artifact all
// come from this one count.

export type ReportSegment =
  | { kind: "markdown"; text: string }
  | { kind: "view"; block: number; body: string }
  | { kind: "stat"; block: number; body: string };

const OPEN_RE = /^```(view|stat)\s*$/;
const CLOSE_RE = /^```\s*$/;
const FENCE_RE = /^```/;

/** Cut a report's markdown into narrative and embedded blocks. Pure. */
export function splitReport(markdown: string): ReportSegment[] {
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: ReportSegment[] = [];
  let md: string[] = [];
  let body: string[] = [];
  let mode: "normal" | "code" | "view" | "stat" = "normal";
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
      if (CLOSE_RE.test(line)) mode = "normal";
      continue;
    }
    const open = OPEN_RE.exec(line);
    if (open) {
      flushMd();
      mode = open[1] as "view" | "stat";
      continue;
    }
    md.push(line);
    if (FENCE_RE.test(line)) mode = "code";
  }
  if (mode === "view" || mode === "stat") flushBlock(mode);
  else flushMd();
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

let pendingAnchor: { threadId: string; viewId: string; anchor: string } | null = null;

export function requestReportAnchor(threadId: string, viewId: string, anchor: string): void {
  pendingAnchor = { threadId, viewId, anchor };
}

export function takeReportAnchor(threadId: string, viewId: string): string | null {
  if (!pendingAnchor || pendingAnchor.threadId !== threadId || pendingAnchor.viewId !== viewId) return null;
  const anchor = pendingAnchor.anchor;
  pendingAnchor = null;
  return anchor;
}
