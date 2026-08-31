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
// PURE + a memo: no store, no DOM — React appears only as `lazy` (the memo
// below) and `createElement` (binding a prop at load time for a page that
// takes one), so the tree, the picker, describeArtifact and the host all ask
// the same questions of the same table. `componentFor` memoizes the `lazy()` wrapper
// per page — a fresh `lazy()` on every render would remount the page each
// time (React compares element types by identity), so the wrapper is created
// once and cached here rather than in any component.
//
// Adding a project: one entry below. Adding a page: one row in its `pages`.
// Nothing else in the shell needs to change — the tree, the picker and the
// routes all read this table.

import type { ComponentType, LazyExoticComponent } from "react";
import { createElement, lazy } from "react";
import type { Artifact } from "../types";

/** The artifact kind this module serves — defined ONCE here so the host, the
 *  pins layer and the anchors module import one name. */
export type SurfaceArtifact = Extract<Artifact, { kind: "surface" }>;

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
  /** The page's ANCHOR vocabulary, in one line, for the agent (Inc 3d): what
   *  `<kind>:<id>` keys it may pin. Printed into the spawn context; the shell
   *  itself never interprets it. */
  pinHint?: string;
  /** A page that also lives in ITS OWN always-on-top window (Inc 5d — the
   *  trading HUD over NinjaTrader): its default size and title there. Absent
   *  = the page opens in the panel / full width like any other; `openWindow`
   *  on it falls back to a generic size. */
  window?: { width: number; height: number; title?: string };
  /** Which side-menu band lists the page (SWIT-46): "research" pages appear
   *  under the Research ▸ destination, grouped by project. Untagged pages are
   *  reachable through the Projects tree / their own destinations (Trading's
   *  cockpit tabs) and draw no Research row. */
  section?: "research";
};

/** The Tauri window label for a page's own window: `surface-<project>-<page>`
 *  with anything outside `[A-Za-z0-9_-]` folded to `-` (Rust re-validates).
 *  Pure, so the window can be found again from the same two ids. */
export function surfaceWindowLabel(project: string, page: string): string {
  const fold = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-");
  return `surface-${fold(project)}-${fold(page)}`;
}

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
        pinHint: "trade:<trade_id> a trade row, row:<dim>:<bucket> an audit row, tile:<label> a headline tile, bar:<iso ts> a candle",
      },
      {
        id: "markets",
        label: "Markets",
        load: () => import("../projects/lodestar/pages/Markets"),
        pinHint: "bar:<iso ts> a candle on the open market's chart",
      },
      {
        id: "chart",
        label: "Chart",
        load: () => import("../projects/lodestar/pages/ChartPage"),
        pinHint: "bar:<iso ts> a candle",
      },
      // Research surfaces (Inc 5b — SWIT-40). Their pin vocabularies grow as
      // the pages mark elements; headings/rows inside their markdown are
      // covered by the shared doc anchors already.
      { id: "playground", label: "Playground", section: "research", load: () => import("../projects/lodestar/pages/Playground") },
      { id: "answer-key", label: "Answer Key", section: "research", load: () => import("../projects/lodestar/pages/AnswerKey") },
      { id: "s1-case", label: "S1 Case", section: "research", load: () => import("../projects/lodestar/pages/S1Case") },
      { id: "s2-case", label: "S2 Case", section: "research", load: () => import("../projects/lodestar/pages/S2Case") },
      { id: "k1-case", label: "K1 Case", section: "research", load: () => import("../projects/lodestar/pages/K1Case") },
      { id: "path-case", label: "Path Case", section: "research", load: () => import("../projects/lodestar/pages/PathCase") },
      { id: "data-health", label: "Data Health", section: "research", load: () => import("../projects/lodestar/pages/DataHealth") },
      // Library takes a `kind` prop in Lodestar (two routes); here it is two
      // pages, each binding the prop at load time.
      {
        id: "library-cases",
        label: "Library · cases",
        section: "research",
        load: () =>
          import("../projects/lodestar/pages/Library").then((m) => ({
            default: () => createElement(m.default, { kind: "cases" }),
          })),
      },
      {
        id: "library-threads",
        label: "Library · threads",
        section: "research",
        load: () =>
          import("../projects/lodestar/pages/Library").then((m) => ({
            default: () => createElement(m.default, { kind: "threads" }),
          })),
      },
      { id: "knowledge", label: "Knowledge", section: "research", load: () => import("../projects/lodestar/pages/Knowledge") },
      // Stage-A cockpit (Inc 5c — SWIT-41). Sim-only: every write goes through
      // the backend; the shell learns nothing about orders.
      { id: "overview", label: "Overview", load: () => import("../projects/lodestar/pages/Overview") },
      { id: "command", label: "Command", load: () => import("../projects/lodestar/pages/Command") },
      { id: "kalshi", label: "Kalshi", load: () => import("../projects/lodestar/pages/KalshiCockpit") },
      { id: "portfolio", label: "Portfolio", load: () => import("../projects/lodestar/pages/Portfolio") },
      { id: "journal", label: "Journal", load: () => import("../projects/lodestar/pages/Journal") },
      // The trading HUD (Inc 5d — SWIT-42): tilt guardrails over NinjaTrader.
      // Opens in its own always-on-top window from the Trading page; also a
      // plain page if you want it in the panel.
      {
        id: "hud",
        label: "HUD",
        load: () => import("../projects/lodestar/pages/Hud"),
        window: { width: 380, height: 310, title: "lodestar · guardrails" },
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

/** A project's RESEARCH pages (SWIT-46) — what its Research ▸ group lists. */
export function researchPages(project: string): SurfacePage[] {
  return surfacePages(project).filter((p) => p.section === "research");
}

/** Projects with at least one research page, in registry order. The Research
 *  band renders one group per entry and NOTHING for an empty result — a repo
 *  without research never draws an empty group (decided Q5). */
export function projectsWithResearch(): string[] {
  return Object.keys(SURFACES).filter((project) => researchPages(project).length > 0);
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
