// Tests for the workstation route model (T4): parse/write round-trips for
// every screen variant, ROUTE_PARAM_KEYS stale-param clearing, store history
// cap, lastByScreen restore, and malformed-URL fallbacks.
//
// Vitest runs in a Node environment (no window) — route.ts guards its window
// access, and the URL-facing tests stub a minimal window on globalThis.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Route } from "../types";
import {
  parseRoute,
  routeToParams,
  applyRouteToParams,
  readRouteFromUrl,
  writeRouteToUrl,
  ROUTE_PARAM_KEYS,
  HISTORY_CAP,
  navigate,
  navigateToScreen,
  navigateBack,
  getNavState,
  subscribeNav,
  __resetNavForTests,
} from "./route";

function roundTrip(route: Route): Route {
  return parseRoute(routeToParams(route));
}

// Minimal window stub for the URL-facing helpers. Returns a handle exposing
// the last URL passed to history.replaceState.
function stubWindow(search: string, pathname = "/") {
  let lastUrl: string | null = null;
  (globalThis as { window?: unknown }).window = {
    location: { search, pathname },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        lastUrl = url;
      },
    },
  };
  return {
    get lastUrl() {
      return lastUrl;
    },
  };
}

function lastUrlParams(handle: { lastUrl: string | null }): URLSearchParams {
  expect(handle.lastUrl).not.toBeNull();
  return new URLSearchParams((handle.lastUrl as unknown as string).split("?")[1] ?? "");
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("parseRoute / routeToParams round-trips", () => {
  it("round-trips the terminal route", () => {
    expect(roundTrip({ screen: "terminal" })).toEqual({ screen: "terminal" });
  });

  it("round-trips the threads history route (param-less)", () => {
    expect(roundTrip({ screen: "threads" })).toEqual({ screen: "threads" });
  });

  it("threads is deep-linkable from a bare screen param", () => {
    // The See-all screen must be reachable with the side menu hidden — it is a
    // route, so the URL alone gets you there.
    expect(parseRoute(new URLSearchParams("screen=threads"))).toEqual({ screen: "threads" });
  });

  it("threads carries no params of its own", () => {
    expect([...routeToParams({ screen: "threads" }).keys()]).toEqual(["screen"]);
  });

  it("navigating to threads clears another screen's stale params", () => {
    const existing = new URLSearchParams("screen=explorer&project=orbit&path=src/a.ts");
    const next = applyRouteToParams(existing, { screen: "threads" });
    expect(next.get("screen")).toBe("threads");
    expect(next.get("project")).toBeNull();
    expect(next.get("path")).toBeNull();
  });

  it("round-trips kb without a doc", () => {
    expect(roundTrip({ screen: "kb" })).toEqual({ screen: "kb" });
  });

  it("round-trips kb with a doc", () => {
    const route: Route = { screen: "kb", doc: "switchboard/personal-workstation/requirements.md" };
    expect(roundTrip(route)).toEqual(route);
  });

  it("round-trips explorer without a project", () => {
    expect(roundTrip({ screen: "explorer" })).toEqual({ screen: "explorer" });
  });

  it("round-trips explorer with a project", () => {
    const route: Route = { screen: "explorer", project: "lodestar" };
    expect(roundTrip(route)).toEqual(route);
  });

  it("round-trips explorer with a project and an open file path", () => {
    const route: Route = { screen: "explorer", project: "lodestar", path: "src/main.rs" };
    expect(roundTrip(route)).toEqual(route);
  });

  it("drops an explorer path without a project (orphaned param)", () => {
    expect(parseRoute(new URLSearchParams("screen=explorer&path=src/main.rs"))).toEqual({
      screen: "explorer",
    });
    // routeToParams likewise never emits an orphaned path.
    expect([...routeToParams({ screen: "explorer", path: "src/main.rs" }).keys()]).toEqual([
      "screen",
    ]);
  });

  it("emits only the params the route carries", () => {
    expect([...routeToParams({ screen: "terminal" }).keys()]).toEqual(["screen"]);
    expect([...routeToParams({ screen: "kb" }).keys()]).toEqual(["screen"]);
    expect([...routeToParams({ screen: "kb", doc: "a.md" }).keys()]).toEqual(["screen", "doc"]);
  });
});

describe("parseRoute fallbacks", () => {
  it("defaults to terminal when no screen param is present", () => {
    expect(parseRoute(new URLSearchParams(""))).toEqual({ screen: "terminal" });
  });

  it("falls back to terminal on an unknown screen", () => {
    expect(parseRoute(new URLSearchParams("screen=lab"))).toEqual({ screen: "terminal" });
    expect(parseRoute(new URLSearchParams("screen="))).toEqual({ screen: "terminal" });
  });

  it("ignores params that belong to a different screen", () => {
    expect(parseRoute(new URLSearchParams("screen=terminal&doc=x&project=y"))).toEqual({
      screen: "terminal",
    });
    expect(parseRoute(new URLSearchParams("screen=explorer&doc=x"))).toEqual({
      screen: "explorer",
    });
  });

  it("treats empty param values as absent", () => {
    expect(parseRoute(new URLSearchParams("screen=kb&doc="))).toEqual({ screen: "kb" });
    expect(parseRoute(new URLSearchParams("screen=explorer&project="))).toEqual({
      screen: "explorer",
    });
  });
});

describe("applyRouteToParams (router-owned key clearing)", () => {
  it("clears every stale router-owned param before applying the route", () => {
    const existing = new URLSearchParams("screen=kb&doc=old.md&project=stale&path=old/file.rs");
    const next = applyRouteToParams(existing, { screen: "explorer", project: "orbit" });
    expect(next.get("screen")).toBe("explorer");
    expect(next.get("project")).toBe("orbit");
    expect(next.get("doc")).toBeNull(); // stale kb param did not leak
    expect(next.get("path")).toBeNull(); // stale explorer file did not leak
  });

  it("preserves non-route params untouched", () => {
    const existing = new URLSearchParams("screen=kb&doc=old.md&zoom=2&debug=1");
    const next = applyRouteToParams(existing, { screen: "terminal" });
    expect(next.get("zoom")).toBe("2");
    expect(next.get("debug")).toBe("1");
    expect(next.get("doc")).toBeNull();
    expect(next.get("screen")).toBe("terminal");
  });

  it("does not mutate the input params", () => {
    const existing = new URLSearchParams("screen=kb&doc=old.md");
    applyRouteToParams(existing, { screen: "terminal" });
    expect(existing.get("doc")).toBe("old.md");
  });

  it("owns every key any route variant can emit", () => {
    // Guard: if a routeToParams case emits a key missing from
    // ROUTE_PARAM_KEYS, stale values of it would leak between routes.
    const variants: Route[] = [
      { screen: "terminal" },
      { screen: "kb", doc: "d.md" },
      { screen: "explorer", project: "p" },
      { screen: "explorer", project: "p", path: "src/a.ts" },
      { screen: "threads" },
    ];
    const owned = new Set<string>(ROUTE_PARAM_KEYS);
    for (const route of variants) {
      for (const key of routeToParams(route).keys()) {
        expect(owned.has(key)).toBe(true);
      }
    }
  });
});

describe("readRouteFromUrl / writeRouteToUrl", () => {
  it("readRouteFromUrl returns the terminal default without a window", () => {
    expect(readRouteFromUrl()).toEqual({ screen: "terminal" });
  });

  it("writeRouteToUrl is a no-op without a window", () => {
    expect(() => writeRouteToUrl({ screen: "kb", doc: "a.md" })).not.toThrow();
  });

  it("readRouteFromUrl parses the live window URL", () => {
    stubWindow("?screen=explorer&project=lodestar");
    expect(readRouteFromUrl()).toEqual({ screen: "explorer", project: "lodestar" });
  });

  it("writeRouteToUrl clears stale route params but keeps foreign ones", () => {
    const handle = stubWindow("?screen=kb&doc=old.md&keep=42");
    writeRouteToUrl({ screen: "terminal" });
    const params = lastUrlParams(handle);
    expect(params.get("screen")).toBe("terminal");
    expect(params.get("doc")).toBeNull();
    expect(params.get("keep")).toBe("42");
  });
});

describe("navigation store", () => {
  beforeEach(() => {
    __resetNavForTests();
  });

  it("boots on the terminal route with empty history", () => {
    const s = getNavState();
    expect(s.route).toEqual({ screen: "terminal" });
    expect(s.history).toEqual([]);
    expect(s.lastByScreen.terminal).toEqual({ screen: "terminal" });
  });

  it("navigate pushes the previous route onto history", () => {
    navigate({ screen: "kb" });
    navigate({ screen: "explorer" });
    const s = getNavState();
    expect(s.route).toEqual({ screen: "explorer" });
    expect(s.history).toEqual([{ screen: "terminal" }, { screen: "kb" }]);
  });

  it("navigateToScreen restores the screen's last full route", () => {
    navigate({ screen: "kb", doc: "spec.md" });
    navigateToScreen("explorer");
    expect(getNavState().route).toEqual({ screen: "explorer" });
    navigateToScreen("kb");
    expect(getNavState().route).toEqual({ screen: "kb", doc: "spec.md" });
  });

  it("navigateToScreen falls back to the bare screen when never visited", () => {
    navigateToScreen("explorer");
    expect(getNavState().route).toEqual({ screen: "explorer" });
  });

  it("caps history at HISTORY_CAP, dropping the oldest entries", () => {
    for (let i = 0; i < 60; i++) {
      navigate({ screen: "kb", doc: `doc-${i}.md` });
    }
    const s = getNavState();
    expect(s.history).toHaveLength(HISTORY_CAP);
    // 60 navigations push [terminal, doc-0 … doc-58]; the cap keeps the most
    // recent 50, so the oldest survivor is doc-9.
    expect(s.history[0]).toEqual({ screen: "kb", doc: "doc-9.md" });
    expect(s.history[HISTORY_CAP - 1]).toEqual({ screen: "kb", doc: "doc-58.md" });
  });

  it("navigateBack pops history; no-op when empty", () => {
    navigate({ screen: "kb", doc: "spec.md" });
    navigate({ screen: "explorer" });
    navigateBack();
    expect(getNavState().route).toEqual({ screen: "kb", doc: "spec.md" });
    navigateBack();
    expect(getNavState().route).toEqual({ screen: "terminal" });
    expect(getNavState().history).toEqual([]);
    navigateBack(); // empty history — must not throw or change state
    expect(getNavState().route).toEqual({ screen: "terminal" });
  });

  it("notifies subscribers on navigation and stops after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeNav(() => {
      calls++;
    });
    navigate({ screen: "kb" });
    expect(calls).toBe(1);
    unsubscribe();
    navigate({ screen: "explorer" });
    expect(calls).toBe(1);
  });

  it("syncs the URL on navigation when a window exists", () => {
    const handle = stubWindow("?screen=terminal&keep=1");
    navigate({ screen: "kb", doc: "spec.md" });
    const params = lastUrlParams(handle);
    expect(params.get("screen")).toBe("kb");
    expect(params.get("doc")).toBe("spec.md");
    expect(params.get("keep")).toBe("1");
  });
});
