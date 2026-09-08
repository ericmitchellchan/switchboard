// THE DOC TICK RAIL (SWIT-79, Ky's TocTickRail CC-702) — the pure geometry.
//
// A 34px column left of a markdown document: one 2px tick per heading (H1
// wider), the ACTIVE tick — the heading nearest the scroll top — in accent,
// the rest faint. Hovering (or tabbing into) the rail slides a 220px overlay
// listing the heading names with their pin counts; a click scroll-jumps.
//
// This module is the RULE: which tick is active for a scroll position, what
// each tick's width is, how the pin counts fold per heading. The component
// (components/kb/DocTickRail) measures the stamped `h:` anchors and draws.

export const RAIL_WIDTH = 34;
export const RAIL_OVERLAY_WIDTH = 220;
export const TICK_HEIGHT = 2;
export const TICK_GAP = 7;
/** H1 (Ky `w-3.5`) vs deeper (`w-2 ml-1`) — width and indent in px. */
export const TICK_WIDE = 14;
export const TICK_NARROW = 8;
export const TICK_INDENT = 4;

export type DocHeading = {
  /** The stamped anchor key — `h:<slug>`. */
  key: string;
  level: number;
  text: string;
  /** Offset of the heading's top from the document's top, px. */
  top: number;
};

export type RailTick = {
  key: string;
  level: number;
  text: string;
  width: number;
  indent: number;
  active: boolean;
  pins: number;
};

/** Which heading is "current" for a scroll offset: the LAST heading whose
 *  top is at or above the scroll top (+ a small tolerance so a heading the
 *  reader scrolled exactly onto counts), else the first. Null with none. */
export function activeHeadingKey(headings: readonly DocHeading[], scrollTop: number, tolerance = 8): string | null {
  if (headings.length === 0) return null;
  let active = headings[0].key;
  for (const h of headings) {
    if (h.top <= scrollTop + tolerance) active = h.key;
    else break;
  }
  return active;
}

/** Tick width + indent by level: H1 wide and flush, deeper narrow and
 *  indented — Ky's two shapes, nothing per level beyond that. */
export function tickShape(level: number): { width: number; indent: number } {
  return level <= 1 ? { width: TICK_WIDE, indent: 0 } : { width: TICK_NARROW, indent: TICK_INDENT };
}

/** The rail's rows for a heading list, a scroll position and the pins per
 *  anchor key. Pure; headings are assumed in document order. */
export function railTicks(
  headings: readonly DocHeading[],
  scrollTop: number,
  pinsByAnchor: ReadonlyMap<string, number>
): RailTick[] {
  const active = activeHeadingKey(headings, scrollTop);
  return headings.map((h) => {
    const shape = tickShape(h.level);
    return {
      key: h.key,
      level: h.level,
      text: h.text,
      width: shape.width,
      indent: shape.indent,
      active: h.key === active,
      pins: pinsByAnchor.get(h.key) ?? 0,
    };
  });
}

/** Fold anchor keys into a count per key (the pins rail's per-heading
 *  number). Keys that are not headings are ignored by the rail anyway. */
export function countByAnchor(anchors: readonly (string | null)[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of anchors) {
    if (!a) continue;
    out.set(a, (out.get(a) ?? 0) + 1);
  }
  return out;
}
