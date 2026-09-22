// SWIT-81 — colour carries meaning, never decoration (Ky's "no green
// furniture" rule): bar/dist, table and stat-tile renderers drew in greys
// only. Three pure rules, each unit-tested; the renderers (ViewSurface,
// ReportView) only CALL them — no tone logic lives in a component.
//
//   · BARS (bar/dist): a spec-level `tone` — explicit, or the default
//     (`defaultBarTone`): 'sign' when the value column holds BOTH a
//     positive and a negative value, else 'neutral'. `barTone` resolves it
//     into a CSS colour PAIR per bar — the resting fill (0.85 opacity via
//     `color-mix`, so hover has somewhere to go) and the hover fill (the
//     same tone at full opacity for 'sign'/'accent'/'chart-n', or the
//     brighter neutral text token for 'neutral'). The anchor a bar stamps
//     and the hover STATE are unchanged — only the fill this module hands
//     back moves.
//   · TABLE CELLS: an optional `tones` array (<=6) of {column, tone}.
//     `sign` colours the cell TEXT by the parsed number's sign; `heat`
//     tints the cell BACKGROUND toward `--accent` by the value's position
//     between the column's min and max over the loaded rows
//     (`columnMinMax`). A non-numeric cell is untouched (null out). Header
//     cells are never touched — the renderer never calls this for `<th>`.
//   · STAT TILES: an optional `tone` per tile — explicit, or the default
//     (`defaultStatTone`): the value string's leading sign (`+`/`-`/`−`
//     followed by a digit) picks up/dn, else neutral. Colours the FIGURE
//     only; label/note/tag are untouched by the caller.
//
// Caps and enums here are the READER's copy — mirrored in the MCP server
// (`src-tauri/resources/mcp/switchboard-mcp.cjs`, the writer for bar/dist
// `tone` and table `tones`) so a hand-written spec cannot render past what
// the tool would have accepted. A stat tile's `tone` is validated by
// reportStore's `parseTile` alone (STAT blocks are never seen by the
// server — they are rendered from markdown the agent wrote with its own
// file tools, exactly like every other report field).

/** THE eight chart tones (mirroring `--chart-1`…`--chart-8` in
 *  styles/surfaces.css) plus the three named ones a bar/dist view may pick.
 *  `--up`/`--dn` stay reserved for sign; a bar drawn with them is an
 *  explicit or DEFAULTED sign choice, never a decoration. */
export const BAR_TONES = [
  "neutral",
  "sign",
  "accent",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-7",
  "chart-8",
] as const;
export type BarTone = (typeof BAR_TONES)[number];

export function isBarTone(v: unknown): v is BarTone {
  return typeof v === "string" && (BAR_TONES as readonly string[]).includes(v);
}

/** A resting/hover CSS colour pair for one bar. Both are plain CSS colour
 *  strings (a `var(...)` or a `color-mix(...)` expression) — the renderer
 *  plugs one straight into `background`. */
export type BarColor = { rest: string; hover: string };

/** The rest-state opacity a non-neutral tone draws at, baked into the
 *  colour via `color-mix` (canvas-free — these renderers are DOM, so a CSS
 *  var reaches them directly; no hex mirroring needed here, unlike
 *  candles.ts). Hover is the same tone at 100%, i.e. "has somewhere to
 *  go". `neutral` does not use this — it swaps token instead. */
const BAR_REST_OPACITY_PCT = 85;

function toneBase(tone: BarTone): string {
  if (tone === "accent") return "var(--accent)";
  if (tone.startsWith("chart-")) return `var(--${tone})`;
  // "sign" is resolved per-value by the caller; "neutral" never reaches here.
  return "var(--accent)";
}

/** The default bar tone from the value column: 'sign' when the values hold
 *  BOTH a positive (`> 0`) and a negative (`< 0`) number — zeros count as
 *  neither and do not by themselves trigger it — else 'neutral'. Pure. */
export function defaultBarTone(values: readonly number[]): "sign" | "neutral" {
  let hasPos = false;
  let hasNeg = false;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v > 0) hasPos = true;
    else if (v < 0) hasNeg = true;
    if (hasPos && hasNeg) return "sign";
  }
  return "neutral";
}

function colorFor(tone: BarTone, value: number): BarColor {
  if (tone === "neutral") {
    return { rest: "var(--text-secondary)", hover: "var(--text-primary)" };
  }
  if (tone === "sign") {
    const base = value >= 0 ? "var(--up)" : "var(--dn)";
    return { rest: `color-mix(in srgb, ${base} ${BAR_REST_OPACITY_PCT}%, transparent)`, hover: base };
  }
  const base = toneBase(tone);
  return { rest: `color-mix(in srgb, ${base} ${BAR_REST_OPACITY_PCT}%, transparent)`, hover: base };
}

/** The resting/hover colour PAIR for every bar, in the same order as
 *  `values` — the explicit `spec.tone` when valid, else `defaultBarTone`'s
 *  rule over the whole column. Pure. */
export function barTone(spec: { tone?: unknown }, values: readonly number[]): BarColor[] {
  const resolved = isBarTone(spec.tone) ? spec.tone : defaultBarTone(values);
  return values.map((v) => colorFor(resolved, v));
}

// ── Table cells ───────────────────────────────────────────────────────────

export const TABLE_TONE_KINDS = ["sign", "heat"] as const;
export type TableToneKind = (typeof TABLE_TONE_KINDS)[number];

export function isTableToneKind(v: unknown): v is TableToneKind {
  return typeof v === "string" && (TABLE_TONE_KINDS as readonly string[]).includes(v);
}

export type TableTone = { column: string; tone: TableToneKind };

/** Caps, mirrored from the MCP server (the writer). */
export const TABLE_TONES_CAP = 6;
export const TABLE_TONE_COLUMN_CAP = 64;

/** Tolerant `tones` parse: malformed entries drop alone, duplicate columns
 *  keep the FIRST rule, capped at TABLE_TONES_CAP. Pure. */
export function parseTableTones(raw: unknown): TableTone[] {
  if (!Array.isArray(raw)) return [];
  const out: TableTone[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (typeof t !== "object" || t === null || Array.isArray(t)) continue;
    const rec = t as Record<string, unknown>;
    const column = typeof rec.column === "string" ? rec.column.trim() : "";
    if (column.length === 0 || column.length > TABLE_TONE_COLUMN_CAP) continue;
    if (!isTableToneKind(rec.tone)) continue;
    if (seen.has(column)) continue;
    seen.add(column);
    out.push({ column, tone: rec.tone });
    if (out.length >= TABLE_TONES_CAP) break;
  }
  return out;
}

function toneNumeric(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length === 0) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** The min/max of a column's numeric cells over the given rows; null when
 *  fewer than one numeric cell exists (nothing to position against). Pure. */
export function columnMinMax(rows: readonly Record<string, unknown>[], column: string): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const n = toneNumeric(row[column]);
    if (n === null) continue;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return min <= max ? { min, max } : null;
}

/** The heat tint's alpha ceiling (percent) — "transparent to --accent at
 *  22%", per the design. */
const HEAT_MAX_ALPHA_PCT = 22;

export type CellTone = { color?: string; background?: string };

/** The cell style for one (column, value) under the spec's `tones`: `sign`
 *  colours the TEXT `--up`/`--dn` by the parsed number's sign (a
 *  non-numeric cell is untouched — null); `heat` tints the BACKGROUND from
 *  transparent to `--accent` at HEAT_MAX_ALPHA_PCT by the value's position
 *  in `minmax` (no minmax, or a degenerate one, is untouched too). null
 *  when the column carries no rule, or the cell cannot be toned. Pure. */
export function tableCellTone(
  tones: readonly TableTone[] | undefined,
  column: string,
  value: unknown,
  minmax: { min: number; max: number } | null
): CellTone | null {
  if (!tones || tones.length === 0) return null;
  const rule = tones.find((t) => t.column === column);
  if (!rule) return null;
  const n = toneNumeric(value);
  if (n === null) return null;
  if (rule.tone === "sign") {
    return { color: n >= 0 ? "var(--up)" : "var(--dn)" };
  }
  // "heat"
  if (!minmax || !(minmax.max > minmax.min)) return null;
  const pct = Math.min(1, Math.max(0, (n - minmax.min) / (minmax.max - minmax.min)));
  const alpha = Math.round(pct * HEAT_MAX_ALPHA_PCT);
  return { background: `color-mix(in srgb, var(--accent) ${alpha}%, transparent)` };
}

// ── Stat tiles ────────────────────────────────────────────────────────────

export const STAT_TONES = ["up", "dn", "accent", "neutral"] as const;
export type StatTone = (typeof STAT_TONES)[number];

export function isStatTone(v: unknown): v is StatTone {
  return typeof v === "string" && (STAT_TONES as readonly string[]).includes(v);
}

/** A leading explicit sign followed by a digit: `+4%`, `-12`, `−3.2×`. An
 *  unsigned value (`4%`, `n/a`) is neutral — no sign was stated. Pure. */
export function defaultStatTone(value: string): "up" | "dn" | "neutral" {
  const s = value.trim();
  if (/^[+]\d/.test(s)) return "up";
  if (/^[-−]\d/.test(s)) return "dn";
  return "neutral";
}

/** The figure's colour for one stat tile: the explicit `tone` when valid,
 *  else `defaultStatTone` over the tile's own value string. Colours the
 *  figure ONLY — label/note/tag are the caller's business. Pure. */
export function statTone(tile: { tone?: unknown; value: string }): string {
  const resolved = isStatTone(tile.tone) ? tile.tone : defaultStatTone(tile.value);
  switch (resolved) {
    case "up":
      return "var(--up)";
    case "dn":
      return "var(--dn)";
    case "accent":
      return "var(--accent)";
    default:
      return "var(--text-primary)";
  }
}
