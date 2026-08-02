// The pins rail's collapse rule (increment F, Decision 4).
//
// The 260px rail is permanent today even when the doc has NO pins — its worst
// case, and Eric's complaint: "you want to see more of the wireframe at times".
// So it collapses, and the DEFAULT is derived rather than fixed:
//
//   · no stored preference + zero pins → COLLAPSED (the empty rail is pure
//     cost; the toggle is right there when you want to place one);
//   · no stored preference + at least one pin → EXPANDED (notes exist and are
//     the reason the rail exists at all);
//   · a stored preference always wins, in BOTH directions — collapsing a rail
//     that has notes is a legitimate "show me the mockup" and must stick, and
//     so must expanding an empty one you are about to pin into.
//
// The preference is PER DOCUMENT (artifact identity, exactly like the zoom
// key: a repo file and a KB doc can share a relative path) and lasts THE
// SESSION — sessionStorage, the same lifetime and the same write-through
// discipline zoom uses. It is deliberately not in the workspace blob: which
// rail was open is view state, not workspace state.
//
// Pure here, IO in the component — same split as clampZoom / zoomStorageKey.

/** Expanded rail width. Unchanged: this is the rail today. */
export const RAIL_WIDTH = 260;

/** Collapsed rail width — a real, clickable edge rather than nothing at all.
 *  A rail that vanished entirely would have no affordance to bring it back
 *  (the toggle lives ON it), which is how a collapsed panel becomes a lost
 *  feature. */
export const RAIL_COLLAPSED_WIDTH = 26;

/** sessionStorage key for one document's rail preference. Takes the artifact's
 *  IDENTITY (panelStore.artifactIdentity), never a bare path — same reason
 *  zoomStorageKey does. */
export function railStorageKey(artifactIdentity: string): string {
  return `sb-pins-rail:${artifactIdentity}`;
}

/** Serialized form of the preference (kept next to the parser so the two
 *  cannot drift). */
export function railStorageValue(collapsed: boolean): string {
  return collapsed ? "1" : "0";
}

/** THE rule. `stored` is whatever sessionStorage returned (null = never set,
 *  and any unrecognised value is treated as never set rather than as a guess). */
export function resolveRailCollapsed(stored: string | null, pinCount: number): boolean {
  if (stored === "1") return true;
  if (stored === "0") return false;
  const count = Number.isFinite(pinCount) ? Math.max(0, Math.trunc(pinCount)) : 0;
  return count === 0;
}
