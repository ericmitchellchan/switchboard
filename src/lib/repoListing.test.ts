// Repo listings shared by the two side-menu trees (SWIT-97) — the PURE rules:
// which repo dirs a project gets in the KB band, which projects qualify, and
// how a project with no KB docs gets its top-level folder.

import { describe, it, expect } from "vitest";
import {
  REFRESH_MIN_MS,
  listingKey,
  repoKbProjects,
  repoShortcutDirs,
  shouldRefresh,
  withRepoProjects,
} from "./repoListing";
import { buildKbTree } from "./kb";
import type { ExplorerEntry, ExplorerProject } from "./explorer";

const dir = (name: string): ExplorerEntry => ({ name, is_dir: true });
const file = (name: string): ExplorerEntry => ({ name, is_dir: false });
const project = (key: string, over: Partial<ExplorerProject> = {}): ExplorerProject => ({
  key,
  status: "active",
  repos: [`C:/Users/ericm/projects/${key}`],
  note: null,
  ...over,
});

describe("listingKey", () => {
  it("is the project for a root and project::dir below it", () => {
    expect(listingKey("lodestar", "")).toBe("lodestar");
    expect(listingKey("lodestar", "specs/sextant")).toBe("lodestar::specs/sextant");
  });
});

describe("repoShortcutDirs", () => {
  it("keeps knowledge/specs/docs order, dirs only", () => {
    expect(
      repoShortcutDirs([dir("apps"), dir("specs"), dir("docs"), dir("knowledge"), file("README.md")])
    ).toEqual(["knowledge", "specs", "docs"]);
  });

  it("a FILE named specs is not a folder; no listing = none", () => {
    expect(repoShortcutDirs([file("specs"), dir("src")])).toEqual([]);
    expect(repoShortcutDirs(undefined)).toEqual([]);
  });
});

describe("repoKbProjects", () => {
  const roots: Record<string, ExplorerEntry[]> = {
    lodestar: [dir("docs"), dir("knowledge"), dir("specs")],
    switchboard: [dir("src"), dir("design")],
    old: [dir("specs")],
    multi: [dir("specs")],
  };
  const get = (k: string) => roots[k];

  it("maps each qualifying project to its dirs", () => {
    const out = repoKbProjects(
      [
        project("lodestar"),
        project("switchboard"),
        project("old", { status: "archived" }),
        project("multi", { repos: ["C:/a", "C:/b"] }),
        project("unlisted"),
      ],
      get
    );
    expect([...out.entries()]).toEqual([["lodestar", ["knowledge", "specs", "docs"]]]);
  });
});

describe("withRepoProjects", () => {
  it("adds a top-level folder for a repo project with no KB docs, folders first by name", () => {
    const tree = buildKbTree(["switchboard/features/a.md", "README.md"]);
    const out = withRepoProjects(tree, ["lodestar"]);
    expect(out.map((n) => `${n.type}:${n.name}`)).toEqual([
      "folder:lodestar",
      "folder:switchboard",
      "doc:README.md",
    ]);
    const lode = out[0];
    expect(lode.type === "folder" && lode.children).toEqual([]);
  });

  it("returns the same array when every project already has a folder", () => {
    const tree = buildKbTree(["lodestar/notes.md"]);
    expect(withRepoProjects(tree, ["lodestar"])).toBe(tree);
  });

  it("never collides with a top-level DOC of the same name", () => {
    const out = withRepoProjects(buildKbTree(["lodestar"]), ["lodestar"]);
    expect(out.map((n) => `${n.type}:${n.name}`)).toEqual(["folder:lodestar", "doc:lodestar"]);
  });
});

describe("shouldRefresh", () => {
  it("always runs the first time, then at most once per window", () => {
    expect(shouldRefresh(null, 0)).toBe(true);
    expect(shouldRefresh(1_000, 1_000 + REFRESH_MIN_MS - 1)).toBe(false);
    expect(shouldRefresh(1_000, 1_000 + REFRESH_MIN_MS)).toBe(true);
  });
});
