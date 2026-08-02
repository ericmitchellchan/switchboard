// Tests for the Explorer's pure logic: path containment, the live-thread
// project annotation, the session-repo merge, and the repo-file read fold
// that keeps a ⟳ from unmounting the renderer.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPO_COLOR,
  annotateProjects,
  beginFileRead,
  fileKey,
  isPathInside,
  mergeFileRead,
  mergeSessionRepos,
} from "./explorer";
import type { ExplorerProject, OpenFile } from "./explorer";
import type { RepoConfig } from "../types";

function project(key: string, repos: string[], status = "active"): ExplorerProject {
  return { key, status, repos, note: null };
}

function repo(path: string, color = "#111111", group = ""): RepoConfig {
  return { path, color, group };
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

// ── Increment B: session repo merge (acceptance 7) ───────────────────────────

describe("mergeSessionRepos", () => {
  it("offers the registry's projects, each with its absolute working_dir", () => {
    const out = mergeSessionRepos([project("orbit", ["C:/p/orbit"])], []);
    expect(out).toEqual([
      {
        name: "orbit",
        path: "C:/p/orbit",
        color: DEFAULT_REPO_COLOR,
        group: "",
        status: "active",
        archived: false,
        source: "registry",
      },
    ]);
  });

  it("names a multi-repo project's entries `key/repo`, one per repo", () => {
    const out = mergeSessionRepos(
      [project("chat-recall", ["C:/p/chat-recall-mcp", "C:/p/chat-recall-api"])],
      []
    );
    expect(out.map((o) => [o.name, o.path])).toEqual([
      ["chat-recall/chat-recall-mcp", "C:/p/chat-recall-mcp"],
      ["chat-recall/chat-recall-api", "C:/p/chat-recall-api"],
    ]);
  });

  it("keeps config repos the registry does NOT cover", () => {
    const out = mergeSessionRepos(
      [project("orbit", ["C:/p/orbit"])],
      [repo("C:/work/legacy-thing", "#ABCDEF", "work")]
    );
    expect(out.map((o) => [o.name, o.source])).toEqual([
      ["orbit", "registry"],
      ["legacy-thing", "config"],
    ]);
    // Its colour and group survive verbatim — nothing Eric configured is lost.
    expect(out[1].color).toBe("#ABCDEF");
    expect(out[1].group).toBe("work");
  });

  it("dedupes by RESOLVED path across slash style, case and trailing slash", () => {
    const out = mergeSessionRepos(
      [project("switchboard", ["C:/Users/ericm/projects/switchboard"])],
      [repo("c:\\Users\\ericm\\projects\\Switchboard\\", "#FF0000")]
    );
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("registry");
    // The duplicate disappears but donates its colour.
    expect(out[0].color).toBe("#FF0000");
  });

  it("dedupes repeated paths inside the registry itself", () => {
    const out = mergeSessionRepos(
      [project("a", ["C:/p/shared"]), project("b", ["C:/p/shared", "C:/p/b"])],
      []
    );
    expect(out.map((o) => o.path)).toEqual(["C:/p/shared", "C:/p/b"]);
    // "b" no longer looks multi-repo once its duplicate is claimed, but the
    // name was decided from the project's OWN repo count — stable either way.
    expect(out.map((o) => o.name)).toEqual(["a", "b/b"]);
  });

  it("sorts archived projects last and flags them for dimming", () => {
    const out = mergeSessionRepos(
      [
        project("old", ["C:/p/old"], "archived"),
        project("live", ["C:/p/live"]),
        project("paused", ["C:/p/paused"], "paused"),
      ],
      [repo("C:/p/extra")]
    );
    expect(out.map((o) => o.name)).toEqual(["live", "paused", "extra", "old"]);
    expect(out.map((o) => o.archived)).toEqual([false, false, false, true]);
    expect(out.map((o) => o.status)).toEqual(["active", "paused", "", "archived"]);
  });

  it("degrades to exactly the config list when the registry is empty", () => {
    const out = mergeSessionRepos([], [repo("C:/p/one"), repo("C:/p/two")]);
    expect(out.map((o) => [o.name, o.path, o.source])).toEqual([
      ["one", "C:/p/one", "config"],
      ["two", "C:/p/two", "config"],
    ]);
  });

  it("drops empty paths from either side rather than offering a bad cwd", () => {
    const out = mergeSessionRepos([project("ghost", [""])], [repo("")]);
    expect(out).toEqual([]);
  });

  it("gives registry entries no group — their meta is the registry status", () => {
    const out = mergeSessionRepos(
      [project("orbit", ["C:/p/orbit"])],
      [repo("C:/p/orbit", "#123456", "personal")]
    );
    expect(out[0].group).toBe("");
    expect(out[0].status).toBe("active");
  });
});

// ── Repo-file read fold (the ⟳ must not unmount the renderer) ────────────────

describe("beginFileRead / mergeFileRead", () => {
  const KEY = fileKey("lodestar", "specs/mockups/cases.html");
  const PATH = "specs/mockups/cases.html";
  const loaded: OpenFile = { key: KEY, path: PATH, content: "<h1>a</h1>", error: null };

  it("blanks only when the DOCUMENT changes", () => {
    // A first read has nothing to show.
    expect(beginFileRead(null, KEY, PATH)).toEqual({
      key: KEY,
      path: PATH,
      content: null,
      error: null,
    });
    // A different document must not render the previous file's body under the
    // new file's name.
    const other = fileKey("orbit", "README.md");
    expect(beginFileRead(loaded, other, "README.md")!.content).toBeNull();
  });

  it("keeps the loaded file on screen across a RELOAD — the whole point", () => {
    // THE bug this closes: the reload effect used to setState({content:null})
    // before every read, so a ⟳ unmounted WireframeView/ComponentPreview —
    // losing in-mockup scroll, an armed pin placement, an open note editor, and
    // recompiling a preview from zero.
    expect(beginFileRead(loaded, KEY, PATH)).toBe(loaded);
  });

  it("preserves state identity when a reload finds the file unchanged", () => {
    // Identity-equal → React bails out of the re-render entirely, exactly as
    // mergeDocRead does for a KB poll tick.
    expect(mergeFileRead(loaded, KEY, PATH, { ok: true, content: "<h1>a</h1>" })).toBe(loaded);
  });

  it("swaps content when the file actually changed", () => {
    const next = mergeFileRead(loaded, KEY, PATH, { ok: true, content: "<h1>b</h1>" })!;
    expect(next.content).toBe("<h1>b</h1>");
    expect(next.error).toBeNull();
  });

  it("keeps the last good content when a RE-READ fails", () => {
    // A read racing an editor's atomic save must not blank the view.
    const next = mergeFileRead(loaded, KEY, PATH, { ok: false, error: "ENOENT" })!;
    expect(next.content).toBe("<h1>a</h1>");
    expect(next.error).toBe("ENOENT");
    // …and a repeat of the same failure is identity-stable.
    expect(mergeFileRead(next, KEY, PATH, { ok: false, error: "ENOENT" })).toBe(next);
  });

  it("has no content to keep when the FIRST read of a document fails", () => {
    const next = mergeFileRead(null, KEY, PATH, { ok: false, error: "too large" })!;
    expect(next.content).toBeNull();
    expect(next.error).toBe("too large");
  });

  it("never carries one document's content into another", () => {
    const other = fileKey("orbit", "README.md");
    const next = mergeFileRead(loaded, other, "README.md", { ok: false, error: "boom" })!;
    expect(next.content).toBeNull();
  });

  it("fileKey separates project from path — same path, different projects", () => {
    expect(fileKey("a", "x.html")).not.toBe(fileKey("b", "x.html"));
  });
});
