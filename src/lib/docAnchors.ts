// DOC ANCHORS (platform evolution, Inc 3c — SWIT-37): how a pin on a
// MARKDOWN document names what it is pinned to.
//
// The same idea as a surface anchor (surfaces/anchors.ts) applied to the
// one document shape the shell renders itself: a heading is `h:<slug>` (the
// id rehype-slug already gives it — stable across edits that do not rename
// the heading), a table row is `table:<n>:row:<m>` (1-based, document order —
// stable across edits that do not reorder tables). That is Ky's doc-pin
// model, and it is what makes a pin survive a re-render, a poll refresh and
// a reload where a positional pin would drift.
//
// PURE: the key/label grammar and the decoration PLAN. MarkdownDoc walks its
// rendered DOM, hands each candidate element's facts in, and stamps the
// `data-anchor` attributes this module tells it to — after which the generic
// DOM anchor provider treats a doc exactly like a page.

import { ANCHOR_ATTR, ANCHOR_LABEL_ATTR, isAnchorKey } from "../surfaces/anchors";

export const HEADING_KIND = "h";
export const TABLE_KIND = "table";

/** Max label length stamped on an element (the rail truncates anyway; this
 *  keeps a 400-word heading from riding into the pins file). */
export const DOC_ANCHOR_LABEL_MAX = 80;

export function headingAnchorKey(slug: string): string | null {
  const s = slug.trim();
  if (s.length === 0) return null;
  const key = `${HEADING_KIND}:${s}`;
  return isAnchorKey(key) ? key : null;
}

export function tableRowAnchorKey(table: number, row: number): string | null {
  if (!Number.isInteger(table) || !Number.isInteger(row) || table < 1 || row < 1) return null;
  return `${TABLE_KIND}:${table}:row:${row}`;
}

/** Collapse whitespace and cap — a label is one line in the rail. */
export function anchorLabelText(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > DOC_ANCHOR_LABEL_MAX ? `${one.slice(0, DOC_ANCHOR_LABEL_MAX - 1)}…` : one;
}

/** One stamp: which attributes to set on which element index. The DOM side
 *  applies these in order; nothing here touches an element. */
export type AnchorStamp = { key: string; label: string };

/** Plan for a heading: its slug is its key, its text its label. */
export function planHeading(slug: string | null, text: string): AnchorStamp | null {
  const key = slug ? headingAnchorKey(slug) : null;
  if (!key) return null;
  const label = anchorLabelText(text);
  return { key, label: label.length > 0 ? label : key };
}

/** Plan for a table body row: keyed by position, labelled by its first
 *  cell (the row's own name in almost every table Eric writes — "30m",
 *  "signed MFE", a ticker) with the table's number for context. */
export function planTableRow(table: number, row: number, firstCell: string): AnchorStamp | null {
  const key = tableRowAnchorKey(table, row);
  if (!key) return null;
  const cell = anchorLabelText(firstCell);
  return { key, label: cell.length > 0 ? `table ${table} · ${cell}` : `table ${table} · row ${row}` };
}

/** The attribute pair a stamp writes — kept here so the DOM side and any
 *  test agree on the names without importing the surfaces module twice. */
export function stampAttributes(stamp: AnchorStamp): Array<[string, string]> {
  return [
    [ANCHOR_ATTR, stamp.key],
    [ANCHOR_LABEL_ATTR, stamp.label],
  ];
}
