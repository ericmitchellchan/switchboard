// THE SURFACE REGISTRY (platform evolution, SWIT-30) — which projects have
// live app PAGES, and how to load each one.
//
// A `surface` artifact is a reference `{project, page}`; this module is the
// only place that turns the pair into something renderable. Pages are LAZY:
// `load` is a dynamic import, so a project's code (its API client, its
// components) is a separate chunk that never lands in the shell bundle until
// the page is first opened — and a save inside it under HMR replaces that
// chunk's modules only, which is what keeps the terminal registry out of the
// update chain (architecture.md §HMR-while-busy).
//
// PURE + a memo: no React imports beyond the ComponentType TYPE, no store, so
// the tree, the picker, describeArtifact and the host all ask the same
// questions of the same table. `componentFor` memoizes the `lazy()` wrapper
// per page — a fresh `lazy()` on every render would remount the page each
// time (React compares element types by identity), so the wrapper is created
// once and cached here rather than in any component.
//
// Adding a project: one entry below. Adding a page: one row in its `pages`.
// Nothing else in the shell needs to change — the tree, the picker and the
// routes all read this table.

import type { ComponentType, LazyExoticComponent } from "react";
import { lazy } from "react";

export type SurfacePage = {
  /** Stable id — the `page` half of a surface artifact and of the project
   *  route. Renaming one orphans saved strips (they render the unknown-page
   *  note), so treat it like a URL. */
  id: string;
  /** What the tree row, the strip tab and the breadcrumb print. */
  label: string;
  /** The page's module. `default` must be a component taking no props: a
   *  surface is a self-contained page, not a parameterised widget — params
   *  come later with pins (Inc 3), and will travel in the artifact. */
  load: () => Promise<{ default: ComponentType }>;
};

export type SurfaceBackend = {
  /** Origin the page fetches — also what the host probes. */
  url: string;
  /** Health path under `url`, e.g. `/health`. A 2xx means up. */
  health: string;
  /** How the backend is STARTED, for the "not running" card. Read as prose
   *  by a person ("`pnpm backend` in the lodestar repo"), never executed —
   *  Switchboard reads output and starts nothing (localhost-preview rule). */
  hint: string;
};

export type ProjectSurfaces = {
  backend?: SurfaceBackend;
  pages: SurfacePage[];
};

/** Keyed by REGISTRY project key (`personal-kb/registry.json` → `projects`),
 *  so the explorer tree can ask "does this project have pages?" with the key
 *  it already holds. */
export const SURFACES: Readonly<Record<string, ProjectSurfaces>> = {
  lodestar: {
    backend: {
      url: "http://127.0.0.1:8799",
      health: "/health",
      hint: "`pnpm backend` (or `pnpm dev`) in the lodestar repo starts it on :8799",
    },
    pages: [
      {
        id: "trading",
        label: "Trading",
        load: () => import("../projects/lodestar/pages/Trading"),
      },
    ],
  },
};

/** Pages a project offers, in display order. Empty for a project with none —
 *  the tree draws no `pages` folder for it and the picker lists no rows. */
export function surfacePages(project: string): readonly SurfacePage[] {
  return SURFACES[project]?.pages ?? [];
}

/** The page a `{project, page}` pair names, or null when either half is
 *  unknown. Null is a RENDER-TIME outcome (a note in the host), never a load
 *  gate — see panelStore.sanitizeArtifact. */
export function findSurface(project: string, page: string): SurfacePage | null {
  return surfacePages(project).find((p) => p.id === page) ?? null;
}

/** A project's backend descriptor, if it declares one. */
export function surfaceBackend(project: string): SurfaceBackend | null {
  return SURFACES[project]?.backend ?? null;
}

/** What to PRINT for a page: its label when registered, its id otherwise —
 *  the strip tab and the breadcrumb must always say something. */
export function surfaceLabel(project: string, page: string): string {
  return findSurface(project, page)?.label ?? page;
}

// ── Lazy component memo ──────────────────────────────────────────────────────

const lazyCache = new Map<SurfacePage, LazyExoticComponent<ComponentType>>();

/** The renderable component for a page — ONE `lazy()` wrapper per page for
 *  the life of the module, so React keeps the mounted instance across
 *  re-renders of its host. */
export function componentFor(page: SurfacePage): LazyExoticComponent<ComponentType> {
  let c = lazyCache.get(page);
  if (!c) {
    c = lazy(page.load);
    lazyCache.set(page, c);
  }
  return c;
}
