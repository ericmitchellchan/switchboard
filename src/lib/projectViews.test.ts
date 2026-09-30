// PROJECT-LEVEL REPORTS (SWIT-107) — the TypeScript half: the owner key the
// view hooks read through, the `view:<project>/<id>` address form and its one
// resolver, the artifact's project arm at every registration site (the load
// gate, identity, describe, the full-width route, the open decision,
// inheritance, the agent ref, pins), the project route, and the KB band /
// Home listing rules over the project-view indexes. The server half (the
// project copy, the index, the id rule) is in mcpServer.test.ts; the Rust
// read guards in explorer.rs.

import { describe, it, expect, beforeEach } from "vitest";
import type { Artifact } from "../types";
import { parseViewOwnerKey, viewOwnerKey } from "./viewStore";
import { evidenceKindOf, projectViewAddress, projectViewOfAddress, viewAnchorOfAddress } from "./evidenceModel";
import { resolveAddress, resolveOpenable, type NextThingContext } from "./nextThing";
import {
  __resetPanelStoreForTests,
  artifactFor,
  artifactIdentity,
  artifactShortTitle,
  decideOpen,
  describeArtifact,
  fullWidthRoute,
  inheritPanel,
  sanitizeArtifact,
  type ProjectViewArtifact,
} from "./panelStore";
import { backTargetLabel, parseRoute, routeToParams, __resetNavForTests, navigate } from "./route";
import { artifactRef } from "./agentContext";
import { PROJECT_VIEW_PIN_OWNER, viewPinTargetFor } from "./pins";
import {
  PROJECT_VIEW_INDEX_CAP,
  mergeProjectViews,
  newestProjectViews,
  parseProjectViewIndex,
  reportProjects,
  type ProjectViewEntry,
} from "./repoListing";

const PVIEW: ProjectViewArtifact = { kind: "view", project: "lodestar", viewId: "v3" };
const TVIEW: Artifact = { kind: "view", threadId: "0f8fad5b-d9cb-469f-a165-70867728950e", viewId: "v3" };

beforeEach(() => {
  __resetPanelStoreForTests();
});

describe("the owner key — one string the view hooks read through", () => {
  it("a thread view keys on its thread id; a project view on project:<key>/<viewId>", () => {
    expect(viewOwnerKey(TVIEW as Extract<Artifact, { kind: "view" }>)).toBe("0f8fad5b-d9cb-469f-a165-70867728950e");
    expect(viewOwnerKey(PVIEW)).toBe("project:lodestar/v3");
    expect(parseViewOwnerKey("project:lodestar/v3")).toEqual({ kind: "project", project: "lodestar", viewId: "v3" });
    expect(parseViewOwnerKey("0f8fad5b-d9cb-469f-a165-70867728950e")).toEqual({
      kind: "thread",
      threadId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    });
  });

  it("no owner (a kept view's \"\") and a malformed key read as null — nothing loads", () => {
    for (const bad of ["", "project:", "project:lodestar", "project:/v3", "project:lo destar/v3", "project:lodestar/../x", "x:y"]) {
      expect(parseViewOwnerKey(bad)).toBeNull();
    }
  });
});

describe("the address form: view:<project>/<id>[#anchor]", () => {
  it("round-trips, keeps an anchor, and is a VIEW kind", () => {
    expect(projectViewAddress("lodestar", "v3")).toBe("view:lodestar/v3");
    expect(projectViewOfAddress("view:lodestar/v3")).toEqual({ project: "lodestar", viewId: "v3", anchor: null });
    expect(projectViewOfAddress(" view:lodestar/v3#h:net-gamma ")).toEqual({ project: "lodestar", viewId: "v3", anchor: "h:net-gamma" });
    expect(evidenceKindOf("view:lodestar/v3")).toBe("view");
  });

  it("a bare view:<id> keeps meaning the THREAD's view — and a malformed part makes the whole address plain", () => {
    expect(projectViewOfAddress("view:v3")).toBeNull();
    expect(viewAnchorOfAddress("view:lodestar/v3")).toBeNull();
    for (const bad of ["view:/v3", "view:lodestar/", "view:lo destar/v3", "view:a/b/c", "view:lodestar/v3#nope", "surface:lodestar/v3"]) {
      expect(projectViewOfAddress(bad)).toBeNull();
    }
  });

  it("ONE resolver: every surface (Evidence, start here, To do, show) opens the project's view, the anchor kept", () => {
    const ctx: NextThingContext = { threadId: "t1", kbDocs: [], projectKey: "switchboard" };
    expect(resolveAddress("view:lodestar/v3#h:results", ctx)).toEqual({ artifact: PVIEW, anchor: "h:results" });
    expect(resolveOpenable("view:lodestar/v3", ctx)).toEqual(PVIEW);
    // The thread's own view is unchanged.
    expect(resolveAddress("view:v3", ctx)?.artifact).toEqual({ kind: "view", threadId: "t1", viewId: "v3" });
  });
});

describe("the artifact's project arm at every registration site", () => {
  it("the load gate: exactly one owner; a project key in the registry alphabet; drill and block ride through", () => {
    expect(sanitizeArtifact({ ...PVIEW, extra: 1 })).toEqual(PVIEW);
    expect(sanitizeArtifact({ ...PVIEW, drill: { key: "2026-06-05" }, block: 2 })).toEqual({ ...PVIEW, drill: { key: "2026-06-05" }, block: 2 });
    expect(sanitizeArtifact({ kind: "view", project: "lodestar", threadId: "t1", viewId: "v3" })).toBeNull();
    expect(sanitizeArtifact({ kind: "view", project: "../x", viewId: "v3" })).toBeNull();
    expect(sanitizeArtifact({ kind: "view", viewId: "v3" })).toBeNull();
    expect(sanitizeArtifact(TVIEW)).toEqual(TVIEW);
  });

  it("identity: a project's view and a thread's view of the same id are two tabs", () => {
    expect(artifactIdentity(PVIEW)).toBe("view:@lodestar:v3");
    expect(artifactIdentity(PVIEW)).not.toBe(artifactIdentity(TVIEW));
    expect(artifactIdentity({ ...PVIEW, drill: { key: "k" } })).toBe("view:@lodestar:v3/k");
  });

  it("describe / short title name the project", () => {
    expect(describeArtifact(PVIEW).crumbs[0].text).toBe("lodestar · report");
    expect(describeArtifact(TVIEW).crumbs[0].text).toBe("view");
    expect(artifactShortTitle(PVIEW)).toBe("v3");
  });

  it("the full-width route and the open decision: beside the thread by default, full width with Ctrl or no thread", () => {
    expect(fullWidthRoute(PVIEW)).toEqual({ screen: "project", project: "lodestar", view: "v3" });
    expect(decideOpen(PVIEW, { screen: "kb", sessionId: "s1", modifier: false })).toEqual({
      action: "panel",
      sessionId: "s1",
      artifact: PVIEW,
      revealTerminal: true,
    });
    expect(decideOpen(PVIEW, { screen: "terminal", sessionId: "s1", modifier: true })).toEqual({
      action: "navigate",
      route: { screen: "project", project: "lodestar", view: "v3" },
    });
    expect(decideOpen(PVIEW, { screen: "home", sessionId: null, modifier: false }).action).toBe("navigate");
  });

  it("a PROJECT view rides into a new thread's panel (it needs no thread); a thread's view never does", () => {
    expect(inheritPanel(PVIEW, "s-new")).toBe(true);
    expect(artifactFor("s-new")).toEqual(PVIEW);
    expect(inheritPanel(TVIEW, "s-other")).toBe(false);
  });

  it("the agent's ref names the project copy the way a repo file is named", () => {
    expect(artifactRef(PVIEW)).toBe("view lodestar/.sb-views/_project/v3.json");
    expect(artifactRef({ ...PVIEW, block: 2, drill: { key: "NQ" } })).toBe("view lodestar/.sb-views/_project/v3.json block 2 drill NQ");
  });

  it("pins file under the PROJECT with an owner word that can never be a thread id", () => {
    expect(PROJECT_VIEW_PIN_OWNER).toBe("project");
    expect(viewPinTargetFor("lodestar", PROJECT_VIEW_PIN_OWNER, "v3", "#b2")).toEqual({
      sidecarPath: "lodestar/surface-pins.json",
      docKey: "view:project:v3#b2",
    });
  });
});

describe("the project route's view identity", () => {
  it("parses and serializes ?screen=project&project=<key>&view=<id>; a page wins when both are present", () => {
    const params = routeToParams({ screen: "project", project: "lodestar", view: "v3" });
    expect(params.toString()).toBe("screen=project&project=lodestar&view=v3");
    expect(parseRoute(params)).toEqual({ screen: "project", project: "lodestar", view: "v3" });
    expect(parseRoute(new URLSearchParams("screen=project&project=lodestar&page=trading&view=v3"))).toEqual({
      screen: "project",
      project: "lodestar",
      page: "trading",
    });
    // A view id outside the alphabet is not a location.
    expect(parseRoute(new URLSearchParams("screen=project&project=lodestar&view=a%20b"))).toEqual({ screen: "home" });
  });

  it("back names it", () => {
    __resetNavForTests({ screen: "project", project: "lodestar", view: "v3" });
    navigate({ screen: "home" });
    expect(backTargetLabel()).toBe("lodestar / reports / v3");
  });
});

describe("the project-view indexes (the KB band's `reports`, Home's Kept views)", () => {
  const index = (views: unknown[]) => JSON.stringify({ version: 1, views });

  it("parse is tolerant: junk is none; a bad or repeated id drops alone; a missing title reads as the id; capped", () => {
    expect(parseProjectViewIndex("{", "lodestar")).toEqual([]);
    expect(parseProjectViewIndex(JSON.stringify({ views: "x" }), "lodestar")).toEqual([]);
    const rows = parseProjectViewIndex(
      index([
        { id: "v2", title: "gamma", kind: "report", builtAt: "2026-09-30T10:00:00.000Z", threadId: "t1" },
        { id: "bad id" },
        { id: "v2", title: "dupe" },
        { id: "v1" },
        null,
      ]),
      "lodestar",
      "api"
    );
    expect(rows).toEqual([
      { project: "lodestar", id: "v2", title: "gamma", kind: "report", builtAt: "2026-09-30T10:00:00.000Z", threadId: "t1", repo: "api" },
      { project: "lodestar", id: "v1", title: "v1", kind: "view", builtAt: "", threadId: "", repo: "api" },
    ]);
    const many = Array.from({ length: PROJECT_VIEW_INDEX_CAP + 5 }, (_, i) => ({ id: `v${i}` }));
    expect(parseProjectViewIndex(index(many), "p")).toHaveLength(PROJECT_VIEW_INDEX_CAP);
  });

  it("a multi-repo project's indexes merge newest first, an id listed twice kept once (the first repo — Rust's read order)", () => {
    const merged = mergeProjectViews("kyde", [
      { repo: "admin-panel", content: index([{ id: "a", builtAt: "2026-09-01T00:00:00Z" }, { id: "dup", title: "first", builtAt: "2026-09-02T00:00:00Z" }]) },
      { repo: "api", content: index([{ id: "b", builtAt: "2026-09-03T00:00:00Z" }, { id: "dup", title: "second", builtAt: "2026-09-04T00:00:00Z" }]) },
    ]);
    expect(merged.map((e) => `${e.repo}:${e.id}`)).toEqual(["api:b", "admin-panel:dup", "admin-panel:a"]);
    expect(merged.find((e) => e.id === "dup")?.title).toBe("first");
  });

  it("Home lists the newest across projects; the KB band draws a `reports` folder only where a project owns one", () => {
    const e = (project: string, id: string, builtAt: string): ProjectViewEntry => ({
      project,
      id,
      title: id,
      kind: "report",
      builtAt,
      threadId: "",
      repo: "",
    });
    const views: Record<string, ProjectViewEntry[]> = {
      lodestar: [e("lodestar", "l2", "2026-09-30T00:00:00Z"), e("lodestar", "l1", "2026-09-01T00:00:00Z")],
      tennis: [e("tennis", "t1", "2026-09-15T00:00:00Z")],
      empty: [],
    };
    expect(newestProjectViews(Object.keys(views), (p) => views[p], 2).map((v) => v.id)).toEqual(["l2", "t1"]);
    const projects = ["lodestar", "tennis", "empty", "unfetched"].map((key) => ({ key, status: "active", repos: [`C:/r/${key}`], note: null }));
    expect([...reportProjects(projects, (p) => views[p]).keys()]).toEqual(["lodestar", "tennis"]);
  });
});
