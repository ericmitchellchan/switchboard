// THE TYPE-SCALE GUARD (SWIT-116). Three checks, Ky's playbook's three:
//   1. the scale itself — every token's size/line in typeScale.ts agrees with
//      the variable global.css declares, the style object reads that
//      variable, and nothing is under the 11px floor in either face;
//   2. the swept files — no hand-set size (a `fontSize:` number or px/em/rem
//      string, a `font-size:` in a CSS string) unless the line, or the line
//      above, carries `off-scale: <reason>`;
//   3. the markers — one that excuses nothing fails, so markers cannot rot.
// Each sweep batch adds its files to SWEPT; that is the whole widening.

import { describe, it, expect } from "vitest";
// @ts-expect-error — no @types/node in the frontend tsconfig; vitest's node
// runtime provides the real module (facts.test.ts's convention).
import { createRequire } from "node:module";
import { T, TYPE_FLOOR_PX, TYPE_SCALE, type TypeTokenName } from "./typeScale";

const require = createRequire(import.meta.url);
const fs = require("fs") as { readFileSync: (p: string, enc: string) => string };
const path = require("path") as { join: (...p: string[]) => string };

// vitest runs from the repo root; `process` is read off globalThis because
// the frontend tsconfig carries no node types.
const root = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

/** The files the sweep has reached. Batch 1: the token module + the kit. */
const SWEPT = ["src/lib/typeScale.ts", "src/components/kit.ts"];

/** A line that SETS a font size at all — an object key or an assignment
 *  (`fontSize: …`, `fontSize = …`), a JSX/SVG attribute (`fontSize={…}`,
 *  `fontSize="…"`), a CSS property (`font-size: …`) or the `font:` shorthand.
 *  It is on the scale only when it reads a token variable; anything else — a
 *  number, a unit string, a variable, a conditional, a value on the next line —
 *  is flagged and must be marked. Deliberately over-broad: a false alarm costs
 *  a marker, a miss costs the scale. */
const SETS_SIZE = /\bfontSize\s*[:=]|\bfont-size\s*:|\bfont\s*:\s*["'`]?\s*[\d.]/;
const READS_TOKEN = /var\(--t-[a-z-]+-(?:size|line)\)|var\(--t-\$\{/;
const MARKER = /off-scale:\s*\S/;

function isRawSize(text: string): boolean {
  return SETS_SIZE.test(text) && !READS_TOKEN.test(text);
}

function offScaleLines(source: string): { line: number; text: string }[] {
  const lines = source.split(/\r?\n/);
  const out: { line: number; text: string }[] = [];
  lines.forEach((text, i) => {
    if (!isRawSize(text)) return;
    // A marker excuses its own line, or the NEXT line only when the marker
    // line sets no size itself — one marker never covers two sizes.
    const above = i > 0 ? lines[i - 1] : "";
    if (MARKER.test(text) || (MARKER.test(above) && !isRawSize(above))) return;
    out.push({ line: i + 1, text: text.trim() });
  });
  return out;
}

function idleMarkers(source: string): { line: number; text: string }[] {
  const lines = source.split(/\r?\n/);
  const out: { line: number; text: string }[] = [];
  lines.forEach((text, i) => {
    if (!MARKER.test(text)) return;
    const excuses = isRawSize(text) || (i + 1 < lines.length && isRawSize(lines[i + 1]));
    if (!excuses) out.push({ line: i + 1, text: text.trim() });
  });
  return out;
}

describe("the type scale", () => {
  const css = read("src/styles/global.css");
  const declared = (name: string): number | null => {
    const m = css.match(new RegExp(`--t-${name}:\\s*(\\d+(?:\\.\\d+)?)px`));
    return m ? Number(m[1]) : null;
  };

  it("every token's size and line agree with the variable global.css declares", () => {
    for (const name of Object.keys(TYPE_SCALE) as TypeTokenName[]) {
      const spec = TYPE_SCALE[name];
      expect(declared(`${spec.css}-size`), `${name} size`).toBe(spec.size);
      expect(declared(`${spec.css}-line`), `${name} line`).toBe(spec.line);
    }
  });

  it("every style object reads its variables and its face", () => {
    for (const name of Object.keys(TYPE_SCALE) as TypeTokenName[]) {
      const spec = TYPE_SCALE[name];
      expect(T[name].fontSize).toBe(`var(--t-${spec.css}-size)`);
      expect(T[name].lineHeight).toBe(`var(--t-${spec.css}-line)`);
      expect(T[name].fontFamily).toBe(spec.face === "mono" ? "var(--font-mono)" : "var(--font-reading)");
      expect(T[name].fontWeight).toBe(spec.weight);
    }
  });

  it("nothing is under the 11px floor, in either face — and both faces reach it", () => {
    const specs = Object.values(TYPE_SCALE);
    for (const spec of specs) expect(spec.size).toBeGreaterThanOrEqual(TYPE_FLOOR_PX);
    expect(specs.some((s) => s.face === "reading" && s.size === TYPE_FLOOR_PX)).toBe(true);
    expect(specs.some((s) => s.face === "mono" && s.size === TYPE_FLOOR_PX)).toBe(true);
  });

  it("Ky's anchors: body 13, docs 16, kicker uppercase, the label tracked", () => {
    expect(TYPE_SCALE.body.size).toBe(13);
    expect(TYPE_SCALE.doc.size).toBe(16);
    expect(T.kicker.textTransform).toBe("uppercase");
    expect(T.label.letterSpacing).toBe("0.02em");
  });

  it("the shared style objects and the scale are frozen — a surface overrides on its own copy", () => {
    expect(Object.isFrozen(T)).toBe(true);
    expect(Object.isFrozen(TYPE_SCALE)).toBe(true);
    for (const name of Object.keys(T) as TypeTokenName[]) expect(Object.isFrozen(T[name]), name).toBe(true);
  });
});

describe("the guard", () => {
  it("flags the hand-set forms a sweep will meet, and spares a token", () => {
    const flagged = [
      "a = { fontSize: 12 };",
      "a = { fontSize: \"12px\" };",
      "a = { fontSize: '0.9em' };",
      "a = { fontSize: .9 };",
      "a = { fontSize: size };",
      "a = { fontSize: compact ? 11 : 13 };",
      "a = { fontSize: `${n}px` };",
      "el.style.fontSize = \"12px\";",
      "<text fontSize={12}>",
      "<text fontSize=\"11\">",
      ".doc { font-size: 12.5px; }",
      "a = { font: \"12px/1.4 var(--font-mono)\" };",
      "a = { fontSize:",
    ];
    for (const line of flagged) expect(offScaleLines(line), line).toHaveLength(1);
    expect(offScaleLines("a = { fontSize: \"var(--t-body-size)\" };")).toHaveLength(0);
    expect(offScaleLines("fontSize: `var(--t-${spec.css}-size)`,")).toHaveLength(0);
    expect(offScaleLines("a = { ...T.body };")).toHaveLength(0);
  });

  it("a marker on the line or the line above excuses it; an idle marker is caught", () => {
    expect(offScaleLines("// off-scale: glyph in a box\nfontSize: 9,")).toHaveLength(0);
    expect(offScaleLines("fontSize: 9, // off-scale: glyph in a box")).toHaveLength(0);
    expect(idleMarkers("// off-scale: nothing here\nconst a = 1;")).toHaveLength(1);
    expect(idleMarkers("// off-scale: glyph\nfontSize: 9,")).toHaveLength(0);
  });

  it("one marker never excuses two sizes", () => {
    expect(offScaleLines("fontSize: 9, // off-scale: a\nfontSize: 10,")).toHaveLength(1);
  });

  for (const rel of SWEPT) {
    it(`${rel} sets no size by hand`, () => {
      expect(offScaleLines(read(rel))).toEqual([]);
    });
    it(`${rel} carries no marker that excuses nothing`, () => {
      expect(idleMarkers(read(rel))).toEqual([]);
    });
  }
});
