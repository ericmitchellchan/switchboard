// THE icon vocabulary. One module, hand-written inline SVG, consumed by every
// surface that has to say "folder" / "file" / "panel": the side-menu KB tree,
// the side-menu Explorer tree, the `+` picker, the artifact panel header and
// the tab bar's panel button. Three surfaces used to share `panelStore`'s
// geometric-glyph vocabulary; they now share this one, and the semantic names
// still live in `panelStore` (FOLDER_ICON / FILE_ICON / describeArtifact) so
// nothing grows a second mapping.
//
// WHY SVG, when the kit said text-only (2026-08-02 convention, amended):
// Unicode geometric shapes cannot express folder/file semantics at 9-11px.
// `◧ ◆ ◈ ◇ ▪ ▫ ■` are all "a small filled shape" — Eric read every one of them
// as a dot, which is exactly what they are. Worse, they do not ALIGN: measured
// against the bundled JetBrains Mono (all four weights, 1000 upem, advance 600
// for every one of them), the ink inside that identical cell is not:
//
//     ◧ folder / ■ file      ink x 0…600   (fills the cell)
//     ◆ ◈ ◇ documents        ink x -10…610 (overhangs the cell)
//     ▪ ▫ code / data        ink x 150…450 (a 300-unit mark, centred)
//
// So a code file's mark started a quarter-cell (2.25px at 9px) to the RIGHT of
// its parent folder's and was half the size — a genuine, measurable
// misalignment that no amount of slot arithmetic could fix, because the offset
// lives inside the glyph. Vector paths put the ink where we say it goes.
//
// Rules for anything added here:
//   · ONE 16x16 viewBox, ink centred on (8, 8), so every icon optically aligns
//     in a fixed-width slot no matter which one a row uses;
//   · `currentColor` only — the caller owns the colour (dim/muted in trees), and
//     the soft palette means these are never a hue of their own;
//   · stroke-drawn silhouettes, no filled blobs except the panel glyph's right
//     pane (which IS the metaphor);
//   · no emoji, no icon font, no sprite sheet, no dependency. Still true.

import type { CSSProperties, ReactNode } from "react";

export type IconName =
  | "folder"
  | "folder-open"
  | "file"
  | "localhost"
  | "panel"
  | "chevron-right"
  | "chevron-down"
  // Thread row menu (increment E). Same rules as everything above: one 16x16
  // box, ink centred on (8,8), currentColor, stroke-drawn.
  | "ellipsis"
  | "open"
  | "rename"
  | "archive"
  | "unarchive"
  | "trash";

/** Default box for a content icon (folder / file / localhost / panel). Rows
 *  reserve exactly this much, so the icon column is identical at every depth
 *  and on every row whether or not it has an expander. */
export const ICON_SIZE = 12;

/** Default box for the tree expander chevron. Smaller than a content icon on
 *  purpose: it is a control, not a kind. */
export const EXPANDER_SIZE = 9;

/** Stroke weight per icon, in viewBox units (so it scales with `size`). The
 *  chevrons carry more because they are drawn smaller. */
const STROKE: Record<IconName, number> = {
  folder: 1.4,
  "folder-open": 1.4,
  file: 1.4,
  localhost: 1.3,
  panel: 1.4,
  "chevron-right": 2,
  "chevron-down": 2,
  ellipsis: 0,
  open: 1.4,
  rename: 1.4,
  archive: 1.4,
  unarchive: 1.4,
  trash: 1.4,
};

// Every path below is centred on (8, 8) in the 16x16 box:
//   folder      ink x 2…14,   y 4…12    (landscape container)
//   file        ink x 3.5…12.5, y 2…14  (portrait document)
//   panel       ink x 2…14,   y 3.25…12.75
// A folder row and a file row therefore share an optical centre, which is what
// "aligned" means for two silhouettes of different aspect.
const PATHS: Record<IconName, ReactNode> = {
  // Closed folder: back panel, tab on the left, front edge across the bottom.
  folder: <path d="M2 12V4h4.2l1.5 1.7H14V12z" />,
  // Open folder: the back panel stays put and the front face swings down and
  // out, the way every IDE draws an expanded directory.
  "folder-open": (
    <>
      <path d="M2 12V4h4.2l1.5 1.7H13v1.9" />
      <path d="M2.2 12 4 7.8h10.4L12.6 12z" />
    </>
  ),
  // Document with a folded corner. Deliberately ONE file icon for every kind
  // (Eric: "just use a folder icon and then a file icon") — the picker still
  // prints the kind as text, where it is actually readable.
  file: (
    <>
      <path d="M3.5 2h6l3 3v9h-9z" />
      <path d="M9.5 2v3h3" />
    </>
  ),
  // Globe — the localhost artifact kind (phase B).
  localhost: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M2.25 8h11.5" />
      <path d="M8 2.25c-2.4 2.05-2.4 9.45 0 11.5 2.4-2.05 2.4-9.45 0-11.5z" />
    </>
  ),
  // THE panel glyph: a frame split with its right portion filled — the shape
  // U+25E7 was standing in for on folder rows, which is where Eric said it
  // actually belonged ("the icon used for a folder should probably be for the
  // panel"). Filled on the RIGHT because that is the side the panel is on.
  panel: (
    <>
      <path d="M2 3.25h12v9.5H2z" />
      <path d="M9.25 4.15h3.85v7.7H9.25z" fill="currentColor" stroke="none" />
    </>
  ),
  "chevron-right": <path d="m6.25 3.5 4.5 4.5-4.5 4.5" />,
  "chevron-down": <path d="M3.5 6.25 8 10.75l4.5-4.5" />,
  // ⋯ — the row menu's trigger. Three FILLED dots (stroke 0): at 12px a
  // stroked circle of this radius is a grey smudge, and the trigger has to
  // read as a control at a glance in an 11.5px rail.
  ellipsis: (
    <>
      <circle cx="3.1" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12.9" cy="8" r="1.15" fill="currentColor" stroke="none" />
    </>
  ),
  // Open / reveal: an arrow leaving a frame — the same "go to it" metaphor the
  // panel header's `open full` spells out in words.
  open: (
    <>
      <path d="M12.75 9.4v3.35H3.25V3.25H6.6" />
      <path d="M9.4 3.25h3.35V6.6" />
      <path d="M12.75 3.25 7.8 8.2" />
    </>
  ),
  // Rename: a pencil over a baseline.
  rename: (
    <>
      <path d="m9.9 2.9 3.2 3.2-6.1 6.1-3.9.7.7-3.9z" />
      <path d="M2.75 14.4h10.5" />
    </>
  ),
  // Archive: a lidded box — the "put it away, it still exists" metaphor.
  // Unarchive is the same box with the arrow reversed, so the pair reads as
  // one action and its undo rather than as two unrelated marks.
  archive: (
    <>
      <path d="M2.6 3.1h10.8v2.6H2.6z" />
      <path d="M3.6 5.7v7.2h8.8V5.7" />
      <path d="M8 7.6v3.4" />
      <path d="M6.4 9.4 8 11l1.6-1.6" />
    </>
  ),
  unarchive: (
    <>
      <path d="M2.6 3.1h10.8v2.6H2.6z" />
      <path d="M3.6 5.7v7.2h8.8V5.7" />
      <path d="M8 11V7.6" />
      <path d="M6.4 9.2 8 7.6l1.6 1.6" />
    </>
  ),
  // Delete: a bin with a lid and two staves.
  trash: (
    <>
      <path d="M2.9 4.3h10.2" />
      <path d="M6.3 4.3V2.8h3.4v1.5" />
      <path d="M4.3 4.3v8.9h7.4V4.3" />
      <path d="M6.7 6.6v4.4M9.3 6.6v4.4" />
    </>
  ),
};

/** Draw an icon. `display:block` + `flex:none` by construction: these live in
 *  flex rows next to text, and an inline SVG would otherwise pick up a
 *  baseline strut and grow the row. */
export function Icon({
  name,
  size = ICON_SIZE,
  style,
}: {
  name: IconName;
  size?: number;
  /** Colour (and nothing else, normally) — the paths are `currentColor`. */
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE[name]}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flex: "none", ...style }}
    >
      {PATHS[name]}
    </svg>
  );
}
