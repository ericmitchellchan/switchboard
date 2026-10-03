// THE TYPE SCALE (SWIT-116, 2026-10-03). Ky's scale, adopted as is (Eric:
// "Yes: 13px body, 16px docs, 11px minimum"), and Ky's face rule (Eric: "Yes,
// Ky's rule: sentences sans, ids/numbers mono"): the reading face carries
// every sentence — titles, rows, menus, buttons, prose — and mono carries
// what is read as a value: ids, counts, times, numbers, code, addresses.
//
// One place a size is written down. Each token is a style object a surface
// spreads (`style={{ ...T.body, color: … }}`); its size and line height read
// the `--t-<token>-size` / `--t-<token>-line` variables declared in
// global.css, and `TYPE_SCALE` below holds the same numbers so the guard test
// can check the two agree. A one-off weight or line height stays with the
// surface that needs it (spread the token, then override) — the token owns
// family, size, line height, base weight, tracking and case.
//
// Pure: no React, no DOM.

import type { CSSProperties } from "react";

export type TypeFace = "reading" | "mono";

export type TypeTokenName =
  | "display"
  | "title"
  | "heading"
  | "subheading"
  | "body"
  | "bodySm"
  | "caption"
  | "mono"
  | "label"
  | "kicker"
  | "metric"
  | "metricLg"
  | "doc";

export interface TypeTokenSpec {
  face: TypeFace;
  /** px */
  size: number;
  /** px */
  line: number;
  weight: 400 | 500 | 600;
  /** em */
  tracking?: number;
  uppercase?: boolean;
  /** The CSS variable stem: `--t-<css>-size` / `--t-<css>-line`. */
  css: string;
}

/** The floor, in both faces. Nothing on the scale is smaller. */
export const TYPE_FLOOR_PX = 11;

/** Ky's thirteen tokens over six sizes (the playbook's table, verbatim). */
export const TYPE_SCALE: Readonly<Record<TypeTokenName, Readonly<TypeTokenSpec>>> = Object.freeze({
  display: { face: "reading", size: 28, line: 36, weight: 600, tracking: -0.01, css: "display" },
  title: { face: "reading", size: 20, line: 28, weight: 600, css: "title" },
  heading: { face: "reading", size: 16, line: 24, weight: 600, css: "heading" },
  subheading: { face: "reading", size: 13, line: 20, weight: 600, css: "subheading" },
  body: { face: "reading", size: 13, line: 20, weight: 400, css: "body" },
  bodySm: { face: "reading", size: 12, line: 16, weight: 400, css: "body-sm" },
  caption: { face: "reading", size: 11, line: 16, weight: 400, css: "caption" },
  mono: { face: "mono", size: 12, line: 16, weight: 400, css: "mono" },
  label: { face: "mono", size: 11, line: 16, weight: 500, tracking: 0.02, css: "label" },
  kicker: { face: "mono", size: 11, line: 16, weight: 500, tracking: 0.06, uppercase: true, css: "kicker" },
  metric: { face: "mono", size: 20, line: 24, weight: 600, css: "metric" },
  metricLg: { face: "mono", size: 28, line: 36, weight: 600, css: "metric-lg" },
  doc: { face: "reading", size: 16, line: 24, weight: 400, css: "doc" },
});

function styleFor(spec: TypeTokenSpec): CSSProperties {
  const style: CSSProperties = {
    fontFamily: spec.face === "mono" ? "var(--font-mono)" : "var(--font-reading)",
    fontSize: `var(--t-${spec.css}-size)`,
    lineHeight: `var(--t-${spec.css}-line)`,
    fontWeight: spec.weight,
  };
  if (spec.tracking !== undefined) style.letterSpacing = `${spec.tracking}em`;
  if (spec.uppercase) style.textTransform = "uppercase";
  return style;
}

/** The tokens as style objects. Frozen: a surface spreads one and overrides
 *  on its own copy, never on the shared object. */
export const T: Readonly<Record<TypeTokenName, Readonly<CSSProperties>>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(TYPE_SCALE) as TypeTokenName[]).map((name) => [name, Object.freeze(styleFor(TYPE_SCALE[name]))]),
  ) as Record<TypeTokenName, CSSProperties>,
);
