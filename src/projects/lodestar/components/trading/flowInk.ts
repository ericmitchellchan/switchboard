/** Kalshi Trading / Flow - the shared ink (SWIT-130). One place says which
 *  tone is which side, so the board, the strip, the detail and the chart agree:
 *  the LEFT side (away team / Over) is blue, the RIGHT side (home / Under) is
 *  amber, on every surface. */

import type { CSSProperties } from "react";
import { T } from "../../../../lib/typeScale";

export const SIDE_INK = { a: "var(--chart-1)", b: "var(--chart-3)" } as const;

/** Numbers and times drawn inside the SVG chart: the mono label at its
 *  regular weight, untracked. */
export const SVG_TEXT: CSSProperties = { ...T.label, fontWeight: 400, letterSpacing: "normal", fill: "var(--text-dim)" };

/** A hairline between rows: the one border a data page draws. */
export const HAIRLINE = "1px solid var(--border)";
