// The surface registry (SWIT-30): the pure lookups every host, tree row and
// picker row rely on, and the one memo whose failure mode is silent (a fresh
// lazy() per render remounts the page on every keystroke).

import { describe, it, expect } from "vitest";
import {
  SURFACES,
  surfacePages,
  findSurface,
  surfaceBackend,
  surfaceLabel,
  surfaceWindowLabel,
  componentFor,
} from "./registry";

describe("surface registry", () => {
  it("lodestar registers its pages against the :8799 backend", () => {
    expect(Object.keys(SURFACES)).toContain("lodestar");
    const ids = surfacePages("lodestar").map((p) => p.id);
    expect(ids.slice(0, 3)).toEqual(["trading", "markets", "chart"]);
    // 5b research + 5c cockpit + 5d HUD surfaces
    for (const id of ["playground", "answer-key", "s1-case", "s2-case", "k1-case", "path-case", "data-health", "library-cases", "library-threads", "knowledge", "overview", "command", "kalshi", "portfolio", "journal", "hud"]) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length); // ids are unique — they are URLs
    expect(surfaceBackend("lodestar")).toMatchObject({
      url: "http://127.0.0.1:8799",
      health: "/health",
    });
  });

  it("a project with no surfaces yields an empty page list and no backend", () => {
    expect(surfacePages("orbit")).toEqual([]);
    expect(surfaceBackend("orbit")).toBeNull();
    expect(findSurface("orbit", "anything")).toBeNull();
  });

  it("findSurface resolves a registered pair and rejects an unknown page", () => {
    expect(findSurface("lodestar", "trading")?.label).toBe("Trading");
    expect(findSurface("lodestar", "renamed")).toBeNull();
  });

  it("surfaceLabel prints the label when known and the id otherwise", () => {
    expect(surfaceLabel("lodestar", "trading")).toBe("Trading");
    expect(surfaceLabel("lodestar", "renamed")).toBe("renamed");
    expect(surfaceLabel("nope", "x")).toBe("x");
  });

  it("componentFor returns ONE lazy wrapper per page (identity-stable across calls)", () => {
    const page = findSurface("lodestar", "trading")!;
    const a = componentFor(page);
    const b = componentFor(page);
    expect(a).toBe(b);
  });

  it("the backend hint is prose, never a bare command the shell would run", () => {
    // The card prints it for a person to read; it must name the repo context.
    expect(surfaceBackend("lodestar")?.hint).toMatch(/lodestar repo/);
  });
});

describe("surface windows (5d)", () => {
  it("labels a page's own window from its two ids, folded to Tauri's label alphabet", () => {
    expect(surfaceWindowLabel("lodestar", "hud")).toBe("surface-lodestar-hud");
    expect(surfaceWindowLabel("my project", "a/b:c")).toBe("surface-my-project-a-b-c");
  });

  it("the HUD declares its own window size", () => {
    const hud = findSurface("lodestar", "hud");
    expect(hud?.window).toEqual({ width: 380, height: 310, title: "lodestar · guardrails" });
    expect(findSurface("lodestar", "trading")?.window).toBeUndefined();
  });
});
