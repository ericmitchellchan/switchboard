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
  componentFor,
} from "./registry";

describe("surface registry", () => {
  it("lodestar registers Trading against the :8799 backend", () => {
    expect(Object.keys(SURFACES)).toContain("lodestar");
    expect(surfacePages("lodestar").map((p) => p.id)).toEqual(["trading"]);
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
