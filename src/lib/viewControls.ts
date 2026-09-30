// VIEW CONTROLS (SWIT-111, 2026-09-30 — Eric, on the gamma thread: "visualize
// the gamma data better so I can view and tweak"; "the knobs… I need to keep
// scrolling back and forth"). A view's `filters` only slice the rows already
// loaded; a CONTROL re-asks the SOURCE with a different setting. The spec
// declares up to CONTROL_CAP knobs — `{name, kind: select | number | date,
// label?, default, options? | min/max/step?}` — and its source (a file path,
// a query url, a query body, a line view's panel sources, a drill template)
// names them as `{name}` placeholders. The toolbar draws the knobs; a change
// reloads the data with the new values substituted.
//
// SUBSTITUTION IS A DRILL'S `{key}` RULE, value by value:
//   · FILE path — the value is reduced to ONE path component by viewStore's
//     `drillPathKey` rule (`[A-Za-z0-9._-]`, everything else `_`; `.` / `..`
//     / empty REFUSED), so no value can add a separator or a parent hop. A
//     refused value is a plain error on the view; nothing is read.
//   · QUERY url — the value is URL-encoded, and the url is re-checked against
//     the loopback rule AFTER substitution (the caller passes that predicate
//     in, so this module imports nothing).
//   · QUERY body — the body is JSON, so the value is JSON-string-ESCAPED
//     (`jsonStringEscape`: quotes, backslashes, control characters), never
//     URL-encoded — `front month` arrives as `front month`, not
//     `front%20month` (review of 9605373, #2; a drill's `{key}` in a body
//     follows the same rule since the same review).
//   The Rust `read_view_data` / `read_project_view_data` guards stay the last
//   line for a file; nothing here widens what a view may read.
//
// VALUES ARE STRINGS, NORMALIZED: a select value must be one of its options, a
// number is clamped to min/max and printed plainly (no exponent, no float
// noise — `formatControlNumber`), a date is a real calendar day `YYYY-MM-DD`.
// A value that is not legal falls back to the control's default — so a
// hand-edited artifact or a stale value can never reach a source.
//
// PLACEHOLDERS: `{name}` where name matches CONTROL_NAME_RE is a placeholder;
// one that no control declares is a visible SERVER error, and at the reader
// (a hand-written spec, a control the tolerant parse dropped) a plain error on
// the view — never a literal `{x}` handed to a read. `{key}` is RESERVED for a
// drill template, so no control may be named `key`.
//
// PURE: no React, no IPC, no imports. Mirrored in the MCP server
// (`src-tauri/resources/mcp/switchboard-mcp.cjs` — `buildControls`,
// `CONTROL_*`); change one, change the other (mcpServer.test.ts asserts the
// caps match).

export const VIEW_CONTROL_KINDS = ["select", "number", "date"] as const;
export type ViewControlKind = (typeof VIEW_CONTROL_KINDS)[number];

export type ViewControl =
  | { name: string; kind: "select"; label?: string; options: string[]; default: string }
  | { name: string; kind: "number"; label?: string; default: number; min?: number; max?: number; step?: number }
  | { name: string; kind: "date"; label?: string; default: string };

/** Control name → its value as a string (the form every source takes). */
export type ControlValues = Record<string, string>;

/** Caps — mirrored in the MCP server. */
export const CONTROL_CAP = 4;
export const CONTROL_OPTION_CAP = 24;
export const CONTROL_OPTION_LEN = 60;
export const CONTROL_LABEL_CAP = 40;
/** A control's name: a lower-case letter, then up to 31 of `[a-zA-Z0-9_]`. */
export const CONTROL_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,31}$/;
/** `{key}` belongs to a drill template — never a control's name. */
export const RESERVED_CONTROL_NAMES: readonly string[] = ["key"];
/** A value longer than this is not a value (the longest legal one is an
 *  option ≤ 60 chars). A number whose PLAIN form is longer (1e70 prints 71
 *  digits) is refused the same way — its control drops at the parse, a typed
 *  one falls back to the default; the server refuses such a default, min or
 *  max by name (review of 9605373, #7). */
export const CONTROL_VALUE_CAP = 64;

/** A value as the inside of a JSON string literal (a query BODY is JSON):
 *  quotes, backslashes and control characters escaped. Pure. */
export function jsonStringEscape(v: string): string {
  return JSON.stringify(v).slice(1, -1);
}

/** Every `{name}` in a template, in order, duplicates kept once. */
const PLACEHOLDER_RE = /\{([a-z][a-zA-Z0-9_]{0,31})\}/g;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finite(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A real calendar day as `YYYY-MM-DD` (Feb 30 is not one). Pure. */
export function isControlDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** A number printed PLAINLY: no exponent, no float noise (0.1 + 0.2 → `0.3`
 *  — 15 significant digits), no trailing zeros, `-0` → `0`. Pure. */
export function formatControlNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Number(n.toPrecision(15));
  if (r === 0) return "0";
  let s = String(r);
  // String() switches to an exponent past 1e21 and under 1e-6 — expand it
  // by moving the decimal point in the digits it printed (never through
  // toFixed, which would print the binary expansion's noise).
  const exp = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (exp) {
    const [, sign, lead, frac = "", e] = exp;
    const digits = `${lead}${frac}`;
    const point = 1 + Number(e);
    s =
      point <= 0
        ? `${sign}0.${"0".repeat(-point)}${digits}`
        : `${sign}${digits.padEnd(point, "0").slice(0, point)}${digits.length > point ? `.${digits.slice(point)}` : ""}`;
  }
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/** A number clamped into the control's [min, max] (either may be absent). */
export function clampControlNumber(n: number, min?: number, max?: number): number {
  let v = n;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

/** Tolerant parse of a spec's `controls` (the READER's half — the server is
 *  strict): a malformed entry drops ALONE, a repeated or reserved name drops,
 *  capped at CONTROL_CAP. A select keeps its legal options (≤ 24, each ≤ 60
 *  chars, unique) and needs at least one; a default that is not an option
 *  becomes the first option. A number needs a finite default; a reversed
 *  min/max drops both; a non-positive step drops; the default is clamped. A
 *  date needs a real `YYYY-MM-DD` default. Pure; [] when absent. */
export function parseViewControls(raw: unknown): ViewControl[] {
  if (!Array.isArray(raw)) return [];
  const out: ViewControl[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (!isRecord(c)) continue;
    const name = typeof c.name === "string" ? c.name.trim() : "";
    if (!CONTROL_NAME_RE.test(name) || RESERVED_CONTROL_NAMES.includes(name) || seen.has(name)) continue;
    const label =
      typeof c.label === "string" && c.label.trim().length > 0 ? c.label.trim().slice(0, CONTROL_LABEL_CAP) : undefined;
    let control: ViewControl | null = null;
    if (c.kind === "select") {
      const options: string[] = [];
      if (Array.isArray(c.options)) {
        for (const o of c.options) {
          if (typeof o !== "string") continue;
          const t = o.trim();
          if (t.length === 0 || t.length > CONTROL_OPTION_LEN || options.includes(t)) continue;
          options.push(t);
          if (options.length >= CONTROL_OPTION_CAP) break;
        }
      }
      if (options.length === 0) continue;
      const d = typeof c.default === "string" ? c.default.trim() : "";
      control = { name, kind: "select", options, default: options.includes(d) ? d : options[0] };
    } else if (c.kind === "number") {
      const d = finite(c.default);
      if (d === null) continue;
      let min = c.min === undefined || c.min === null ? undefined : finite(c.min) ?? undefined;
      let max = c.max === undefined || c.max === null ? undefined : finite(c.max) ?? undefined;
      if (min !== undefined && max !== undefined && min > max) {
        min = undefined;
        max = undefined;
      }
      const stepRaw = c.step === undefined || c.step === null ? null : finite(c.step);
      const step = stepRaw !== null && stepRaw > 0 ? stepRaw : undefined;
      const clamped = clampControlNumber(d, min, max);
      // A number whose plain form cannot be a value (> CONTROL_VALUE_CAP)
      // drops the control — its default could never reach a source.
      if ([clamped, min, max].some((v) => v !== undefined && formatControlNumber(v).length > CONTROL_VALUE_CAP)) continue;
      const num: ViewControl = { name, kind: "number", default: clamped };
      if (min !== undefined) num.min = min;
      if (max !== undefined) num.max = max;
      if (step !== undefined) num.step = step;
      control = num;
    } else if (c.kind === "date") {
      const d = typeof c.default === "string" ? c.default.trim() : "";
      if (!isControlDate(d)) continue;
      control = { name, kind: "date", default: d };
    }
    if (control === null) continue;
    if (label !== undefined) control.label = label;
    seen.add(name);
    out.push(control);
    if (out.length >= CONTROL_CAP) break;
  }
  return out;
}

/** A control's default as the string a source takes. Pure. */
export function controlDefault(control: ViewControl): string {
  return control.kind === "number" ? formatControlNumber(control.default) : control.default;
}

/** A raw value made legal for its control, or null when it cannot be: a
 *  select value must be an option; a number is parsed, clamped and printed
 *  plainly; a date must be a real day. Pure. */
export function normalizeControlValue(control: ViewControl, raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  if (s.length === 0 || s.length > CONTROL_VALUE_CAP) return null;
  switch (control.kind) {
    case "select":
      return control.options.includes(s) ? s : null;
    case "number": {
      const n = finite(s);
      if (n === null) return null;
      const out = formatControlNumber(clampControlNumber(n, control.min, control.max));
      // 1e70 is a finite number and 71 characters — not a value.
      return out.length > CONTROL_VALUE_CAP ? null : out;
    }
    case "date":
      return isControlDate(s) ? s : null;
  }
}

/** The value of EVERY declared control: the given one when it is legal,
 *  else the default. Undeclared names drop. Sorted by nothing — keyed by
 *  name, so it compares by `controlValuesKey`. Pure. */
export function effectiveControlValues(
  controls: readonly ViewControl[] | undefined,
  given: ControlValues | null | undefined
): ControlValues {
  const out: ControlValues = {};
  for (const c of controls ?? []) {
    const v = given && Object.prototype.hasOwnProperty.call(given, c.name) ? normalizeControlValue(c, given[c.name]) : null;
    out[c.name] = v ?? controlDefault(c);
  }
  return out;
}

/** A stable string for a set of values (sorted by name) — an effect key, a
 *  memo key, and the identity suffix of a drilled child. Pure. */
export function controlValuesKey(values: ControlValues | null | undefined): string {
  if (!values) return "";
  return Object.keys(values)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(values[k])}`)
    .join("&");
}

/** The PIN-SCOPE suffix for the values the rows on screen were loaded at —
 *  appended AFTER the filter suffix (viewStore.viewPinScope): `|expiry=front`.
 *  EVERY declared control's value is included (defaults too), so a pin names
 *  the setting it was dropped at; `""` for a view with no controls, so every
 *  pin filed before SWIT-111 keeps its doc key. Pure. */
export function controlPinScope(values: ControlValues | null | undefined): string {
  const key = controlValuesKey(values);
  return key.length > 0 ? `|${key}` : "";
}

/** THE SETTING a deck note is filed under (review of 9605373, #3): `""`
 *  when every value is its control's default — so a notes.json written
 *  before controls existed, or a deck with no controls, reads exactly as it
 *  did — else `controlValuesKey(values)` (`expiry=all`). Values whose name no
 *  control declares are ignored. Pure. */
export function noteSettingKey(values: ControlValues | null | undefined, controls: readonly ViewControl[] | undefined): string {
  if (!values) return "";
  const byName = new Map((controls ?? []).map((c) => [c.name, c]));
  const known: ControlValues = {};
  let differs = false;
  for (const k of Object.keys(values)) {
    const c = byName.get(k);
    if (!c) continue;
    known[k] = values[k];
    if (values[k] !== controlDefault(c)) differs = true;
  }
  return differs ? controlValuesKey(known) : "";
}

/** Tolerant load-gate for values riding on an ARTIFACT (a drilled child's
 *  inherited values): names by the name rule, string values ≤ the value cap,
 *  at most CONTROL_CAP entries. null when nothing survives. Legality against
 *  the declared controls is checked later (`effectiveControlValues`), where
 *  the spec is known. Pure. */
export function sanitizeControlValues(raw: unknown): ControlValues | null {
  if (!isRecord(raw)) return null;
  const out: ControlValues = {};
  let n = 0;
  for (const k of Object.keys(raw).sort()) {
    const v = raw[k];
    if (!CONTROL_NAME_RE.test(k) || RESERVED_CONTROL_NAMES.includes(k)) continue;
    if (typeof v !== "string" || v.trim().length === 0 || v.length > CONTROL_VALUE_CAP) continue;
    out[k] = v.trim();
    if (++n >= CONTROL_CAP) break;
  }
  return n > 0 ? out : null;
}

/** Every `{name}` placeholder in a template (duplicates once, in order). */
export function placeholdersIn(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** A source, as the three shapes this module substitutes into. */
export type ControlSource = { type: "file"; path: string } | { type: "query"; url: string; body?: string };

/** One template with `{name}` replaced by `encode(value)` for every name in
 *  `values`. Pure. */
function fill(template: string, values: ControlValues, encode: (v: string) => string): string {
  return template.replace(PLACEHOLDER_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? encode(values[name]) : whole
  );
}

/** Substitute control values into a source — THE rule, per source type:
 *  a FILE path value through `pathComponent` (viewStore passes
 *  `drillPathKey`; null = refused), a QUERY url value URL-encoded and the url
 *  then re-checked with `isLoopback` (viewStore's `isLocalBackendUrl`), a
 *  query BODY value JSON-string-escaped (the body is JSON).
 *  `values` must already be normalized (`effectiveControlValues`). A
 *  placeholder left over — one no value names, `{key}` in a main source
 *  included — is an ERROR, never a literal read. `allowed` names
 *  placeholders to leave in place (a drill template's `key`, substituted by
 *  the caller). Pure. */
export function substituteControls(
  source: ControlSource,
  values: ControlValues,
  deps: { pathComponent: (v: string) => string | null; isLoopback: (url: string) => boolean },
  allowed: readonly string[] = []
): { source: ControlSource; error: null } | { source: null; error: string } {
  const leftovers = (template: string) =>
    placeholdersIn(template).filter((p) => !Object.prototype.hasOwnProperty.call(values, p) && !allowed.includes(p));
  if (source.type === "file") {
    const missing = leftovers(source.path);
    if (missing.length > 0) {
      return { source: null, error: `the source names {${missing[0]}}, which no control declares` };
    }
    for (const name of placeholdersIn(source.path)) {
      if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
      if (deps.pathComponent(values[name]) === null) {
        return {
          source: null,
          error: `the value "${values[name]}" for ${name} cannot name a file inside the working directory`,
        };
      }
    }
    return { source: { type: "file", path: fill(source.path, values, (v) => deps.pathComponent(v) as string) }, error: null };
  }
  const missing = leftovers(`${source.url}${source.body ?? ""}`);
  if (missing.length > 0) {
    return { source: null, error: `the source names {${missing[0]}}, which no control declares` };
  }
  const url = fill(source.url, values, encodeURIComponent);
  if (!deps.isLoopback(url)) return { source: null, error: "the view's query url is not a local backend with these settings" };
  const out: ControlSource = { type: "query", url };
  if (source.body) out.body = fill(source.body, values, jsonStringEscape);
  return { source: out, error: null };
}

/** The spec's controls with each DEFAULT set to the given value — what
 *  `keep` writes, so a kept snapshot records the setting its rows were
 *  loaded at (the frozen view prints it in `spec`). Pure. */
export function controlsAtValues(controls: readonly ViewControl[], values: ControlValues): ViewControl[] {
  return controls.map((c) => {
    const v = normalizeControlValue(c, values[c.name]);
    if (v === null) return c;
    return c.kind === "number" ? { ...c, default: Number(v) } : { ...c, default: v };
  });
}

/** One control for the `spec` disclosure: `expiry = front [front · all]`,
 *  `width = 5 [1–10 step 1]`, `day = 2026-06-05 [date]`. Pure. */
export function controlLine(control: ViewControl, value?: string): string {
  const v = value ?? controlDefault(control);
  const name = control.label ? `${control.label} (${control.name})` : control.name;
  if (control.kind === "select") return `${name} = ${v} [${control.options.join(" · ")}]`;
  if (control.kind === "date") return `${name} = ${v} [date]`;
  const range =
    control.min !== undefined || control.max !== undefined
      ? `${control.min !== undefined ? formatControlNumber(control.min) : "…"}–${
          control.max !== undefined ? formatControlNumber(control.max) : "…"
        }`
      : "number";
  return `${name} = ${v} [${range}${control.step !== undefined ? ` step ${formatControlNumber(control.step)}` : ""}]`;
}
