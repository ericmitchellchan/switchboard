// THE PAGE-FACING API (platform evolution, Inc 5a — SWIT-39): the ONE module
// a project page may import from the shell.
//
// A surface is a chunk, not a dependency (CLAUDE.md §Project surfaces): the
// shell reaches a page only through the registry's `import()`, and a page
// reaches the shell only through THIS file. Everything here is a React
// context + a hook, provided by SurfaceHost; a page rendered anywhere else (a
// test, a future standalone build) sees the null/default and keeps working.
//
//   useSurfaceActive()        — "is this surface on screen?" Pages gate their
//                                polling on it (a hidden tab's page must not
//                                fetch at 2s beside a live terminal).
//   useSurfaceNav()           — open another page of the SAME project (the
//                                react-router `useNavigate` replacement): the
//                                shell decides panel vs full width.
//   useSurfaceAnchorRegistry  — publish a programmatic anchor provider
//                                (canvas charts); see anchors.ts.

import { createContext, useContext } from "react";

export { SurfaceAnchorContext, useSurfaceAnchorRegistry } from "./anchors";
export type { SurfaceAnchor, SurfaceAnchorProvider, SurfaceAnchorRegistry } from "./anchors";

// Shared UI a page may render with: THE markdown path (one pipeline, one
// link policy — CLAUDE.md) is re-exported here; the chart components are
// imported from `surfaces/charts/*` directly (they themselves depend on this
// module for the anchor registry, so re-exporting them here would be a
// cycle). Both are the sanctioned page-side imports; nothing else in
// `src/` is.
export { MarkdownDoc } from "../components/kb/MarkdownDoc";

// ── Active ───────────────────────────────────────────────────────────────────

/** Default TRUE: a page outside a host (tests, storybook-style previews) is
 *  as good as visible. The host sets it from the panel's / screen's `active`. */
export const SurfaceActiveContext = createContext<boolean>(true);

export function useSurfaceActive(): boolean {
  return useContext(SurfaceActiveContext);
}

// ── Navigation ───────────────────────────────────────────────────────────────

export type SurfaceNav = {
  /** Open a page of this project. Where it opens (this panel's strip, or full
   *  width) is the shell's decision — the same rule a tree click follows. A
   *  page id the registry does not know renders the host's "no such page"
   *  note rather than throwing. */
  openPage: (page: string) => void;
};

const NOOP_NAV: SurfaceNav = { openPage: () => {} };

export const SurfaceNavContext = createContext<SurfaceNav>(NOOP_NAV);

export function useSurfaceNav(): SurfaceNav {
  return useContext(SurfaceNavContext);
}
