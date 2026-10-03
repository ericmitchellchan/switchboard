// SHARED KY-SHAPED STYLE PRIMITIVES (SWIT-91) — pure style constants, no
// React. `PageView.tsx` (SWIT-90, the ✦ page's Ky pass) is the reference
// implementation for all of these; it keeps its own copies untouched (it is
// not in scope for this ticket) and this file is a second copy for the
// surfaces that needed the SAME shapes when they took their own Ky pass:
// Home (`Home.tsx`), the To-dos dropdown (`BacklogPanel.tsx`) and the
// confirm dialog (`ConfirmDialog.tsx`). Duplication over a cross-import from
// PageView, which would put three unrelated surfaces on one page's silent
// contract.
//
// TYPE (SWIT-116): every size here is a token from `lib/typeScale.ts` — the
// shared kit is the first batch of the type-scale sweep, so its sizes moved on
// EVERY importer: Home, BacklogPanel, ConfirmDialog, LaneView, JobsBlock,
// views/FindingAction and kb/PageView (TEXT_LINK only — PageView keeps its own
// copies of the rest). A surface that spreads one of these and then sets its
// own `fontSize` keeps that size until its own batch.

import type { CSSProperties } from "react";
import { T } from "../lib/typeScale";

export const MONO = "var(--font-mono)";
/** The reading face (Ky's `font-sans`): bodies, not chrome. */
export const READING = "var(--font-reading)";

/** Ky's section H2 (`PlanPanel.Section`), on the scale: subheading (Ky's
 *  precedent — a 14px semibold section head is a subheading), a hairline
 *  under it. */
export const SECTION_TITLE: CSSProperties = {
  ...T.subheading,
  color: "var(--text-primary)",
  margin: 0,
  paddingBottom: 6,
  marginBottom: 4,
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "baseline",
  gap: 8,
};

/** Ky's row: a hairline under each, baseline-aligned, `padding: 6px 0`. */
export const DENSE_ROW: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  padding: "6px 0",
  borderBottom: "1px solid var(--border)",
};

/** Ky's checkbox on a row (`w-3 h-3 rounded-[3px] border`): an empty
 *  bordered square, filled with a ✓ when done. */
export function checkboxStyle(done: boolean): CSSProperties {
  return {
    flex: "none",
    width: 12,
    height: 12,
    marginTop: 3,
    borderRadius: 3,
    border: "1px solid var(--text-primary)",
    background: done ? "var(--text-primary)" : "transparent",
    color: "var(--bg-primary)",
    // off-scale: the ✓ glyph is sized to sit inside the 12px box, not read as text
    fontSize: 9,
    lineHeight: "10px",
    textAlign: "center",
  };
}

/** Ky's input (`TodoPanel`: `bg-bg border-line-soft rounded-md px-2.5
 *  py-1.5 text-[12px]`): the deepest ground, a hairline, radius 6. */
export const FIELD: CSSProperties = {
  width: "100%",
  maxWidth: 480,
  background: "var(--bg-secondary)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-primary)",
  ...T.bodySm,
  padding: "6px 10px",
  outline: "none",
};

/** Ky's PrimaryButton (`Buttons.tsx`: `bg-accent text-[12px] font-semibold
 *  rounded-md px-3 py-1`) — one per surface. */
export const PRIMARY: CSSProperties = {
  background: "var(--accent)",
  border: "none",
  borderRadius: 6,
  color: "var(--bg-primary)",
  ...T.bodySm,
  fontWeight: 600,
  padding: "4px 12px",
  cursor: "pointer",
};

/** The quiet/cancel shape beside a PRIMARY button: transparent, a hairline,
 *  `--text-secondary`, the same radius as PRIMARY. */
export const QUIET_BUTTON: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border-subtle)",
  borderRadius: 6,
  color: "var(--text-secondary)",
  ...T.bodySm,
  padding: "4px 12px",
  cursor: "pointer",
};

/** Ky's text link button (`show all 12`, `clear done`): faint → primary on
 *  hover. A caption, not mono — the words are a control, not a value (the
 *  face rule). */
export const TEXT_LINK: CSSProperties = {
  background: "none",
  border: "none",
  padding: "0 2px",
  marginTop: 4, // PageView's copy carries it; the two must not drift
  ...T.caption,
  color: "var(--text-faint)",
  cursor: "pointer",
};
