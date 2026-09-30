// The agent's `show` (SWIT-102) — the shows.json parser, the absolute-path
// rule and the address → artifact resolution. The server's half (the op, its
// caps, the round trip) is in mcpServer.test.ts.

import { describe, it, expect } from "vitest";
import {
  SHOW_ADDRESS_CAP,
  SHOW_CAP,
  kbRelativePath,
  parseShowsFile,
  repoFileOpens,
  showTargetFor,
  showsPass,
  type ShowContext,
} from "./showIntent";

const KB_ROOT = "C:\\Users\\eric\\projects\\personal-kb";

function ctx(over: Partial<ShowContext> = {}): ShowContext {
  return { threadId: "t1", kbDocs: ["switchboard/features/x/requirements.md"], projectKey: "lodestar", kbRoot: KB_ROOT, ...over };
}

describe("parseShowsFile", () => {
  it("carries `where: cwd` (review of 49ebb20, #1); an unknown value is dropped, never the entry", () => {
    const raw = JSON.stringify({
      shows: [
        { id: "o3", address: "README.md", at: "", where: "cwd" },
        { id: "o2", address: "b.md", at: "", where: "elsewhere" },
        { id: "o1", address: "a.md", at: "" },
      ],
    });
    expect(parseShowsFile(raw)).toEqual([
      { id: "o3", address: "README.md", at: "", where: "cwd" },
      { id: "o2", address: "b.md", at: "" },
      { id: "o1", address: "a.md", at: "" },
    ]);
  });

  it("reads the server's shape, newest first", () => {
    const raw = JSON.stringify({
      version: 1,
      shows: [
        { id: "o2", address: "specs/sextant/gamma-metric-design.md", at: "2026-09-30T10:00:01.000Z" },
        { id: "o1", address: "view:v1", at: "2026-09-30T10:00:00.000Z" },
      ],
    });
    expect(parseShowsFile(raw)).toEqual([
      { id: "o2", address: "specs/sextant/gamma-metric-design.md", at: "2026-09-30T10:00:01.000Z" },
      { id: "o1", address: "view:v1", at: "2026-09-30T10:00:00.000Z" },
    ]);
  });

  it("junk is no shows — a missing file, torn JSON, the wrong shape", () => {
    expect(parseShowsFile("")).toEqual([]);
    expect(parseShowsFile("   ")).toEqual([]);
    expect(parseShowsFile("{")).toEqual([]);
    expect(parseShowsFile("[]")).toEqual([]);
    expect(parseShowsFile("null")).toEqual([]);
    expect(parseShowsFile(JSON.stringify({ version: 1 }))).toEqual([]);
    expect(parseShowsFile(JSON.stringify({ shows: "o1" }))).toEqual([]);
    expect(parseShowsFile(undefined as unknown as string)).toEqual([]);
  });

  it("a broken entry drops alone: a bad id, a repeated id, an empty or over-long address, a non-object", () => {
    const raw = JSON.stringify({
      shows: [
        null,
        "o9",
        { id: "bad id!", address: "a/b.md" },
        { id: "o3", address: "   " },
        { id: "o4", address: `docs/${"a".repeat(SHOW_ADDRESS_CAP)}.md` },
        { id: "o5", address: 7 },
        { id: "o6", address: "  a/b.md  " }, // trimmed, no stamp → ""
        { id: "o6", address: "c/d.md", at: "later" }, // the id is taken
        { address: "e/f.md" },
      ],
    });
    expect(parseShowsFile(raw)).toEqual([{ id: "o6", address: "a/b.md", at: "" }]);
  });

  it("keeps at most SHOW_CAP — a hand-grown file cannot open a hundred tabs' worth of intent", () => {
    const shows = Array.from({ length: SHOW_CAP + 15 }, (_, i) => ({ id: `o${100 - i}`, address: `docs/n${i}.md`, at: "" }));
    const parsed = parseShowsFile(JSON.stringify({ version: 1, shows }));
    expect(parsed).toHaveLength(SHOW_CAP);
    expect(parsed[0].id).toBe("o100");
    expect(SHOW_CAP).toBe(20);
  });
});

describe("kbRelativePath — an absolute path inside the knowledge base", () => {
  it("strips the root, folding separators; drive paths compare case-insensitively and keep the address's casing", () => {
    expect(kbRelativePath("C:\\Users\\eric\\projects\\personal-kb\\switchboard\\Notes.md", KB_ROOT)).toBe("switchboard/Notes.md");
    expect(kbRelativePath("c:/users/ERIC/projects/personal-kb/switchboard/notes.md", KB_ROOT)).toBe("switchboard/notes.md");
    expect(kbRelativePath("C:/Users/eric/projects/personal-kb/a.md", "C:/Users/eric/projects/personal-kb/")).toBe("a.md");
    expect(kbRelativePath("/home/eric/kb/a/b.md", "/home/eric/kb")).toBe("a/b.md");
  });

  it("is null outside the root, for the root itself, for a prefix-sharing sibling, and with no known root", () => {
    expect(kbRelativePath("C:/Users/eric/projects/switchboard/README.md", KB_ROOT)).toBeNull();
    expect(kbRelativePath("C:/Users/eric/projects/personal-kb", KB_ROOT)).toBeNull();
    expect(kbRelativePath("C:/Users/eric/projects/personal-kb-old/a.md", KB_ROOT)).toBeNull();
    expect(kbRelativePath("/home/Eric/kb/a.md", "/home/eric/kb")).toBeNull(); // POSIX is case-sensitive
    expect(kbRelativePath("C:/Users/eric/projects/personal-kb/a.md", null)).toBeNull();
    expect(kbRelativePath("C:/Users/eric/projects/personal-kb/a.md", "")).toBeNull();
  });
});

describe("repoFileOpens — a show opens NOTHING for a repo file the viewer cannot render (review of 49ebb20, #3)", () => {
  it("is the viewer's own read: resolves → opens; rejects (missing, a folder, binary, over the cap) → nothing", async () => {
    expect(await repoFileOpens(() => Promise.resolve("# spec"))).toBe(true);
    expect(await repoFileOpens(() => Promise.resolve(""))).toBe(true); // an empty file is still a file
    expect(await repoFileOpens(() => Promise.reject(new Error("file too large for the inline viewer (600 KB > 512 KB limit)")))).toBe(false);
    expect(await repoFileOpens(() => Promise.reject(new Error("stream did not contain valid UTF-8")))).toBe(false);
    expect(await repoFileOpens(() => Promise.reject(new Error("not a file")))).toBe(false);
  });
});

describe("showsPass — a failed read is no listing, never a baseline (review of 49ebb20, #2)", () => {
  const raw = JSON.stringify({
    version: 1,
    shows: [
      { id: "o3", address: "c.md", at: "" },
      { id: "o2", address: "b.md", at: "" },
      { id: "o1", address: "a.md", at: "" },
    ],
  });

  it("a failed read SKIPS the tick — on the first tick too — so nothing is baselined and nothing replays later", () => {
    expect(showsPass(undefined, null)).toEqual({ kind: "skip" });
    expect(showsPass(new Set(["o1"]), null)).toEqual({ kind: "skip" });
    // The next good read is then the baseline — the stored shows are old news.
    expect(showsPass(undefined, raw)).toEqual({ kind: "baseline", ids: ["o3", "o2", "o1"] });
  });

  it("a missing file (\"\") is a real, empty listing: the baseline is empty and a later show opens", () => {
    expect(showsPass(undefined, "")).toEqual({ kind: "baseline", ids: [] });
    const pass = showsPass(new Set(), raw);
    expect(pass.kind === "open" && pass.shows.map((s) => s.id)).toEqual(["o1", "o2", "o3"]);
  });

  it("after the baseline: the unseen shows, oldest first", () => {
    const pass = showsPass(new Set(["o1"]), raw);
    expect(pass.kind === "open" && pass.shows.map((s) => s.id)).toEqual(["o2", "o3"]);
    expect(showsPass(new Set(["o1", "o2", "o3"]), raw)).toEqual({ kind: "open", shows: [] });
  });
});

describe("showTargetFor — the address resolver the Evidence rows use, plus the absolute-KB rule", () => {
  it("a KB doc in the list opens as the KB doc; a repo path opens against the thread's project", () => {
    expect(showTargetFor("switchboard/features/x/requirements.md", ctx())).toEqual({
      artifact: { kind: "kb-doc", path: "switchboard/features/x/requirements.md" },
      anchor: null,
    });
    // Eric, 2026-09-24: "can you open specs/sextant/gamma-metric-design.md in the panel"
    expect(showTargetFor("specs/sextant/gamma-metric-design.md", ctx())).toEqual({
      artifact: { kind: "repo-file", project: "lodestar", path: "specs/sextant/gamma-metric-design.md" },
      anchor: null,
    });
    expect(showTargetFor("mockups/cases-compact-v1.html", ctx())?.artifact).toEqual({
      kind: "repo-file",
      project: "lodestar",
      path: "mockups/cases-compact-v1.html",
    });
  });

  it("a TOP-LEVEL project file opens without the slash an Evidence row needs — a show address is never prose", () => {
    expect(showTargetFor("README.md", ctx())?.artifact).toEqual({ kind: "repo-file", project: "lodestar", path: "README.md" });
    expect(showTargetFor("package.json", ctx())?.artifact).toEqual({ kind: "repo-file", project: "lodestar", path: "package.json" });
    // The KB list is still asked first: a top-level KB doc wins, and a miss is reported.
    expect(showTargetFor("README.md", ctx({ kbDocs: ["README.md"] }))?.artifact).toEqual({ kind: "kb-doc", path: "README.md" });
    const misses: string[] = [];
    showTargetFor("README.md", ctx({ onKbMiss: (a) => misses.push(a) }));
    expect(misses).toEqual(["README.md"]);
    // Still nothing: a bare word, a ticket key, and any file with no project to read it from.
    expect(showTargetFor("refactor", ctx())).toBeNull();
    expect(showTargetFor("SWIT-102", ctx())).toBeNull();
    expect(showTargetFor("README.md", ctx({ projectKey: null }))).toBeNull();
  });

  it("a repo path is re-based from the thread's working directory onto the project root; a KB doc, a view and a page never are", () => {
    // A thread working in lodestar/apps/desktop names src/x.md; the project reads apps/desktop/src/x.md.
    const sub = ctx({ pathPrefix: "apps/desktop/" });
    expect(showTargetFor("src/x.md", sub)?.artifact).toEqual({ kind: "repo-file", project: "lodestar", path: "apps/desktop/src/x.md" });
    expect(showTargetFor("README.md", sub)?.artifact).toEqual({ kind: "repo-file", project: "lodestar", path: "apps/desktop/README.md" });
    // A multi-repo project addresses files as <repo>/….
    expect(showTargetFor("specs/a.md", ctx({ projectKey: "kyde", pathPrefix: "admin-panel/" }))?.artifact).toEqual({
      kind: "repo-file",
      project: "kyde",
      path: "admin-panel/specs/a.md",
    });
    expect(showTargetFor("switchboard/features/x/requirements.md", sub)?.artifact).toEqual({
      kind: "kb-doc",
      path: "switchboard/features/x/requirements.md",
    });
    expect(showTargetFor("view:v1", sub)?.artifact).toEqual({ kind: "view", threadId: "t1", viewId: "v1" });
    expect(showTargetFor("surface:lodestar/trading", sub)?.artifact).toEqual({ kind: "surface", project: "lodestar", page: "trading" });
  });

  it("a view (with a report heading) and a page state resolve as they do on the page", () => {
    expect(showTargetFor("view:v3", ctx())).toEqual({ artifact: { kind: "view", threadId: "t1", viewId: "v3" }, anchor: null });
    expect(showTargetFor("view:v3#h:net-gamma", ctx())).toEqual({
      artifact: { kind: "view", threadId: "t1", viewId: "v3" },
      anchor: "h:net-gamma",
    });
    expect(showTargetFor("surface:lodestar/trading?instrument=NQ&date=2026-06-05", ctx())?.artifact).toEqual({
      kind: "surface",
      project: "lodestar",
      page: "trading",
      params: { instrument: "NQ", date: "2026-06-05" },
    });
  });

  it("an absolute path inside the KB is that KB doc — and NEVER the repo fallback; anywhere else it is nothing", () => {
    const inside = "C:\\Users\\eric\\projects\\personal-kb\\switchboard\\features\\x\\requirements.md";
    expect(showTargetFor(inside, ctx())?.artifact).toEqual({ kind: "kb-doc", path: "switchboard/features/x/requirements.md" });
    // In the KB folder but not in the (known) list: nothing — a KB-relative
    // remainder must not be re-read as a path in the thread's project.
    const misses: string[] = [];
    expect(showTargetFor("C:/Users/eric/projects/personal-kb/switchboard/new.md", ctx({ onKbMiss: (a) => misses.push(a) }))).toBeNull();
    expect(misses).toEqual(["switchboard/new.md"]); // …and the miss is what asks for the refresh
    expect(showTargetFor("C:/Users/eric/projects/lodestar/specs/a.md", ctx())).toBeNull();
    expect(showTargetFor(inside, ctx({ kbRoot: null }))).toBeNull();
  });

  it("opens nothing for what is not an address: a ticket key, a URL, prose, `..`, an over-long string, no project for a repo path", () => {
    expect(showTargetFor("SWIT-102", ctx())).toBeNull();
    expect(showTargetFor("https://claude.ai/artifact/abc", ctx())).toBeNull();
    expect(showTargetFor("the gamma design doc", ctx())).toBeNull();
    expect(showTargetFor("../secrets/a.md", ctx())).toBeNull();
    expect(showTargetFor("", ctx())).toBeNull();
    expect(showTargetFor(`docs/${"a".repeat(SHOW_ADDRESS_CAP)}.md`, ctx())).toBeNull();
    expect(showTargetFor("specs/a.md", ctx({ projectKey: null }))).toBeNull();
    // A whole address, not tokens: prose that CONTAINS an address is still prose.
    expect(showTargetFor("see specs/a.md please", ctx())).toBeNull();
  });

  it("reports a KB miss before the repo fallback (SWIT-101), and none for a hit or a non-path", () => {
    const misses: string[] = [];
    const c = ctx({ onKbMiss: (a) => misses.push(a) });
    expect(showTargetFor("switchboard/features/y/new-spec.md", c)?.artifact.kind).toBe("repo-file");
    expect(misses).toEqual(["switchboard/features/y/new-spec.md"]);
    showTargetFor("switchboard/features/x/requirements.md", c);
    showTargetFor("view:v1", c);
    showTargetFor("surface:lodestar/trading", c);
    expect(misses).toHaveLength(1);
    // The same address against the refreshed list is the KB doc.
    expect(showTargetFor("switchboard/features/y/new-spec.md", ctx({ kbDocs: ["switchboard/features/y/new-spec.md"] }))?.artifact).toEqual({
      kind: "kb-doc",
      path: "switchboard/features/y/new-spec.md",
    });
  });

  it("`where: cwd` — the server FOUND the file under the thread's cwd: it opens as that file, and the KB is never asked (review of 49ebb20, #1)", () => {
    const misses: string[] = [];
    // personal-kb/README.md and registry.json exist — and must not shadow the repo's own.
    const c = ctx({ kbDocs: ["README.md", "registry.json", "specs/a.md"], onKbMiss: (a) => misses.push(a) });
    expect(showTargetFor("README.md", c, "cwd")?.artifact).toEqual({ kind: "repo-file", project: "lodestar", path: "README.md" });
    expect(showTargetFor("registry.json", c, "cwd")?.artifact).toEqual({ kind: "repo-file", project: "lodestar", path: "registry.json" });
    expect(showTargetFor("specs/a.md", c, "cwd")?.artifact).toEqual({ kind: "repo-file", project: "lodestar", path: "specs/a.md" });
    expect(misses).toEqual([]);
    // Re-based like every other repo path.
    expect(showTargetFor("README.md", ctx({ kbDocs: ["README.md"], pathPrefix: "apps/desktop/" }), "cwd")?.artifact).toEqual({
      kind: "repo-file",
      project: "lodestar",
      path: "apps/desktop/README.md",
    });
    // An old entry (no field) keeps the old order: the KB list first.
    expect(showTargetFor("README.md", c)?.artifact).toEqual({ kind: "kb-doc", path: "README.md" });
  });

  it("`where: cwd` in a folder no registry project holds: only a folder INSIDE the knowledge base opens it, as that KB doc", () => {
    const kbThread = ctx({
      projectKey: null,
      workingDir: "C:\\Users\\eric\\projects\\personal-kb\\switchboard",
      kbDocs: ["switchboard/features/x/requirements.md"],
    });
    expect(showTargetFor("features/x/requirements.md", kbThread, "cwd")?.artifact).toEqual({
      kind: "kb-doc",
      path: "switchboard/features/x/requirements.md",
    });
    expect(showTargetFor("README.md", ctx({ projectKey: null, workingDir: "C:/Users/eric/scratch" }), "cwd")).toBeNull();
    expect(showTargetFor("README.md", ctx({ projectKey: null, workingDir: null }), "cwd")).toBeNull();
  });
});
