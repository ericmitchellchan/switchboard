// SHARED KY-SHAPED STYLE PRIMITIVES (SWIT-91) — pure style constants, no
// React. `PageView.tsx` (SWIT-90, the ✦ page's Ky pass) is the reference
// implementation for all of these; it keeps its own copies untouched (it is
// not in scope for this ticket) and this file is a second copy for the
// surfaces that needed the SAME shapes when they took their own Ky pass:
// Home (`Home.tsx`), the To-dos dropdown (`BacklogPanel.tsx`) and the
// confirm dialog (`ConfirmDialog.tsx`). Duplication over a cross-import from
// PageView, which would put three unrelated surfaces on one page's silent
// contract.

import type { CSSProperties } from "react";

export const MONO = "var(--font-mono)";
/** The reading face (Ky's `font-sans`): bodies, not chrome. */
export const READING = "var(--font-reading)";

/** Ky's section H2 (`PlanPanel.Section`): 14px semibold, a hairline under
 *  it, the count/meta 10px faint beside it. */
export const SECTION_TITLE: CSSProperties = {
  fontFamily: READING,
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.3,
  color: "var(--text-primary)",
  margin: 0,
  paddingBottom: 6,
  marginBottom: 4,
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "baseline",
  gap: 8,
};

export const SECTION_COUNT: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  fontWeight: 400,
  color: "var(--text-faint)",
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
  fontFamily: READING,
  fontSize: 12,
  lineHeight: 1.45,
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
  fontFamily: READING,
  fontSize: 12,
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
  fontFamily: READING,
  fontSize: 12,
  fontWeight: 400,
  padding: "4px 12px",
  cursor: "pointer",
};

/** Ky's text link button (`show all 12`, `clear done`): mono, faint →
 *  primary on hover. */
export const TEXT_LINK: CSSProperties = {
  background: "none",
  border: "none",
  padding: "0 2px",
  fontFamily: MONO,
  fontSize: 10,
  color: "var(--text-faint)",
  cursor: "pointer",
};
