// Tests for the Explorer's pure logic (T9): path containment + the
// live-thread project annotation.

import { describe, expect, it } from "vitest";
import { annotateProjects, isPathInside } from "./explorer";
import type { ExplorerProject } from "./explorer";

function project(key: string, repos: string[]): ExplorerProject {
  return { key, status: "active", repos, note: null };
}

describe("isPathInside", () => {
  it("matches the directory itself and nested children", () => {
    expect(isPathInside("C:/Users/ericm/projects/switchboard", "C:/Users/ericm/projects/switchboard")).toBe(true);
    expect(isPathInside("C:/Users/ericm/projects/switchboard/src/lib", "C:/Users/ericm/projects/switchboard")).toBe(true);
  });

  it("is slash-style and case insensitive (Windows paths)", () => {
    expect(isPathInside("C:\\Users\\ericm\\projects\\Switchboard\\src", "c:/users/ericm/projects/switchboard")).toBe(true);
    expect(isPathInside("C:/Users/ericm/projects/switchboard/", "C:\\Users\\ericm\\projects\\switchboard")).toBe(true);
  });

  it("respects segment boundaries — no prefix-name false positives", () => {
    expect(isPathInside("C:/p/switchboard-extras", "C:/p/switchboard")).toBe(false);
    expect(isPathInside("C:/p/switch", "C:/p/switchboard")).toBe(false);
  });

  it("never matches outside or against an empty parent", () => {
    expect(isPathInside("C:/other/place", "C:/Users/ericm/projects/switchboard")).toBe(false);
    expect(isPathInside("C:/anything", "")).toBe(false);
  });
});

describe("annotateProjects", () => {
  const projects = [
    project("switchboard", ["C:/Users/ericm/projects/switchboard"]),
    project("chat-recall", [
      "C:/Users/ericm/projects/chat-recall-mcp",
      "C:/Users/ericm/projects/chat-recall-api",
    ]),
    project("empty", []),
  ];

  it("marks projects containing a live thread workingDir", () => {
    const out = annotateProjects(projects, ["C:\\Users\\ericm\\projects\\switchboard"]);
    expect(out.map((p) => [p.key, p.live])).toEqual([
      ["switchboard", true],
      ["chat-recall", false],
      ["empty", false],
    ]);
  });

  it("matches a workingDir nested in ANY of a multi-repo project's repos", () => {
    const out = annotateProjects(projects, [
      "C:/Users/ericm/projects/chat-recall-api/src",
    ]);
    expect(out.find((p) => p.key === "chat-recall")?.live).toBe(true);
    expect(out.find((p) => p.key === "switchboard")?.live).toBe(false);
  });

  it("marks nothing when no threads are live", () => {
    expect(annotateProjects(projects, []).every((p) => !p.live)).toBe(true);
  });

  it("preserves the project fields on the annotated wrappers", () => {
    const out = annotateProjects(projects, []);
    expect(out[1].repos).toEqual(projects[1].repos);
    expect(out[1].status).toBe("active");
  });
});
