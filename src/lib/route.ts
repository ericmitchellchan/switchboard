// Workstation navigation (T4) — URL-backed route model for the shell.
//
// The route is a discriminated union keyed on `screen` (see src/types.ts).
// State lives in the URL (Tauri's webview supports history/search params), so
// reloads land back on the same screen and no new persistence is needed.
//
// Layout of this file matters: the pure helpers (parseRoute / routeToParams /
// applyRouteToParams / read/write) are declared BEFORE the store section — the
// store initializer reads the URL at module load, and const bindings would hit
// a TDZ error if referenced before their declaration runs.
//
// A new screen (e.g. a future diagrams or board surface) APPENDS:
//   1. a ScreenId + Route variant in src/types.ts,
//   2. its param keys to ROUTE_PARAM_KEYS below,
//   3. cases in parseRoute / routeToParams (exhaustive switches make a missed
//      registration a compile error).

import { useSyncExternalStore } from "react";
import type { Route, ScreenId } from "../types";

/** History stack cap — bounds memory for navigateBack(). */
export const HISTORY_CAP = 50;

const VALID_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>([
  "terminal",
  "kb",
  "explorer",
  "threads",
]);

/** Every query-param key the router owns. applyRouteToParams deletes ALL of
 *  these before applying a route, so stale values from a prior route can never
 *  leak into the next one — while non-route params survive untouched.
 *  New screens append their param keys here (must stay in sync with the
 *  Route union in src/types.ts — currently screen + kb's doc + explorer's
 *  project/path). A PARAM-LESS screen (terminal, threads) adds nothing: it is
 *  already covered by the shared `screen` key. */
export const ROUTE_PARAM_KEYS = ["screen", "doc", "project", "path"] as const;

/** Parse a route from query params. Pure: unknown screens and malformed or
 *  cross-screen params fall back to the terminal / undefined — never throws. */
export function parseRoute(params: URLSearchParams): Route {
  const raw = params.get("screen") ?? "terminal";
  if (!VALID_SCREENS.has(raw as ScreenId)) return { screen: "terminal" };
  const screen = raw as ScreenId;
  switch (screen) {
    case "terminal":
      return { screen: "terminal" };
    case "threads":
      return { screen: "threads" };
    case "kb": {
      const doc = params.get("doc");
      return { screen: "kb", doc: doc ? doc : undefined };
    }
    case "explorer": {
      const project = params.get("project");
      const path = params.get("path");
      // `path` (the open file) is meaningless without a project — an
      // orphaned path param is dropped rather than carried.
      return {
        screen: "explorer",
        project: project ? project : undefined,
        path: project && path ? path : undefined,
      };
    }
  }
}

/** Read the current route from the window URL. Thin wrapper over parseRoute;
 *  in non-browser contexts (tests) it returns the default terminal route. */
export function readRouteFromUrl(): Route {
  if (typeof window === "undefined") return { screen: "terminal" };
  return parseRoute(new URLSearchParams(window.location.search));
}

/** Serialize a route to query params — the inverse of parseRoute. Pure: emits
 *  ONLY the params the route carries, no window state. */
export function routeToParams(route: Route): URLSearchParams {
  const params = new URLSearchParams();
  params.set("screen", route.screen);
  switch (route.screen) {
    case "terminal":
    case "threads":
      break;
    case "kb":
      if (route.doc) params.set("doc", route.doc);
      break;
    case "explorer":
      if (route.project) {
        params.set("project", route.project);
        if (route.path) params.set("path", route.path);
      }
      break;
  }
  return params;
}

/** Pure core of writeRouteToUrl (unit-testable without a window): clears every
 *  router-owned key from `existing`, then applies the route's params. */
export function applyRouteToParams(
  existing: URLSearchParams,
  route: Route
): URLSearchParams {
  const params = new URLSearchParams(existing);
  for (const key of ROUTE_PARAM_KEYS) params.delete(key);
  for (const [key, value] of routeToParams(route)) params.set(key, value);
  return params;
}

/** A route's identity — two routes with the same key are the same LOCATION.
 *  Used to keep `navigate` from pushing a history entry for a navigation that
 *  goes nowhere (clicking the doc you are already reading), which is what made
 *  the stack unusable as a back affordance: `back` popped an entry identical to
 *  where you were standing and read as a dead button. Pure. */
export function routeKey(route: Route): string {
  return routeToParams(route).toString();
}

export function sameRoute(a: Route, b: Route): boolean {
  return routeKey(a) === routeKey(b);
}

/** Sync a route into the window URL via replaceState. Non-route params on the
 *  live URL survive; stale router-owned params do not.
 *
 *  DELIBERATELY still replaceState (increment G revisited this): the BACK
 *  affordance is the store's own `history` stack, which `navigate` pushes to
 *  and `navigateBack` pops. Mirroring that into `pushState` as well would give
 *  the webview's Alt+Left a second, independent stack — and App's popstate
 *  listener resyncs by calling `navigate`, so a browser-level back would push a
 *  fresh entry while consuming a native one, and the two stacks would drift
 *  apart within a few navigations. One stack, one back button. */
export function writeRouteToUrl(route: Route): void {
  if (typeof window === "undefined") return;
  const params = applyRouteToParams(
    new URLSearchParams(window.location.search),
    route
  );
  const newUrl = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, "", newUrl);
}

// ── Store ────────────────────────────────────────────────────────────────────
// Module-level state + subscriber set + useSyncExternalStore hook — the same
// shape as the repo's other module-level singletons (terminalRegistry etc.);
// zustand is deliberately not a dependency here.

export type NavState = {
  route: Route;
  /** Visited-route stack (most recent last) powering navigateBack(). Capped at
   *  HISTORY_CAP to bound memory. */
  history: Route[];
  /** Last full route seen per screen, so returning to a screen from the side
   *  menu restores where you were (KB → same doc) instead of resetting. */
  lastByScreen: Partial<Record<ScreenId, Route>>;
};

function initState(route: Route): NavState {
  return { route, history: [], lastByScreen: { [route.screen]: route } };
}

let navState: NavState = initState(readRouteFromUrl());

const navListeners = new Set<() => void>();

function setNavState(next: NavState): void {
  navState = next;
  writeRouteToUrl(next.route);
  for (const listener of navListeners) listener();
}

export function getNavState(): NavState {
  return navState;
}

export function subscribeNav(listener: () => void): () => void {
  navListeners.add(listener);
  return () => {
    navListeners.delete(listener);
  };
}

/** Navigate to an explicit route. Pushes the previous route onto history and
 *  records the new route as the screen's last-known sub-state.
 *
 *  Navigating to the location you are ALREADY on is a NO-OP (increment G): the
 *  history entry would be a duplicate, and `back` returning you to where you
 *  are standing is the shape of a broken button. Nothing else changes either —
 *  `lastByScreen` already records this location, and skipping the state swap
 *  keeps the `useRoute` snapshot identity-stable, so App's defensive popstate
 *  resync costs no re-render at all. */
export function navigate(next: Route): void {
  const s = navState;
  if (sameRoute(s.route, next)) return;
  setNavState({
    route: next,
    history: [...s.history, s.route].slice(-HISTORY_CAP),
    lastByScreen: { ...s.lastByScreen, [next.screen]: next },
  });
}

/** Navigate to a top-level screen, restoring its last sub-state if we've been
 *  there (the side menu uses this so switching away + back doesn't lose the
 *  doc/project you were on). */
export function navigateToScreen(screen: ScreenId): void {
  navigate(navState.lastByScreen[screen] ?? ({ screen } as Route));
}

/** Pop the previous route off the history stack. No-op on empty history.
 *
 *  Also records the restored route as its screen's last-known sub-state: back
 *  is a real navigation, so a later side-menu return to that screen must land
 *  where BACK left you, not where you were before it.
 *
 *  Going back to `{screen:"terminal"}` restores the panel by construction — the
 *  artifact panel is per-TAB state in `panelStore`, which navigation never
 *  touches. */
export function navigateBack(): void {
  const s = navState;
  if (s.history.length === 0) return;
  const target = s.history[s.history.length - 1];
  setNavState({
    route: target,
    history: s.history.slice(0, -1),
    lastByScreen: { ...s.lastByScreen, [target.screen]: target },
  });
}

/** Is there anywhere to go back TO? */
export function canNavigateBack(): boolean {
  return navState.history.length > 0;
}

/** Where `back` would take you, for the control's tooltip — a location the user
 *  can recognize, not a route object. Null when the stack is empty. */
export function backTargetLabel(): string | null {
  const s = navState;
  if (s.history.length === 0) return null;
  const target = s.history[s.history.length - 1];
  switch (target.screen) {
    case "terminal":
      return "the terminal";
    case "threads":
      return "threads";
    case "kb":
      return target.doc ? `kb / ${target.doc}` : "the knowledge base";
    case "explorer":
      return target.path
        ? `${target.project} / ${target.path}`
        : target.project
          ? target.project
          : "the explorer";
  }
}

/** React hook: the current route, re-rendering on navigation. */
export function useRoute(): Route {
  return useSyncExternalStore(subscribeNav, () => navState.route);
}

/** React hook: can we go back? A boolean snapshot — the control re-renders when
 *  the answer flips, not on every navigation. */
export function useCanNavigateBack(): boolean {
  return useSyncExternalStore(subscribeNav, canNavigateBack);
}

/** React hook: the back control's label. A string snapshot. */
export function useBackTargetLabel(): string | null {
  return useSyncExternalStore(subscribeNav, backTargetLabel);
}

/** Test-only: reset the store to a known state. */
export function __resetNavForTests(route: Route = { screen: "terminal" }): void {
  navState = initState(route);
}
