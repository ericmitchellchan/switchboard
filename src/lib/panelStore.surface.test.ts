// The `surface` artifact kind through panelStore's pure seams (SWIT-30):
// load gate, identity, header description, and the full-width route. Kept in
// its own file so the kind's contract reads in one place; the strip
// invariants it inherits (dedupe, activeIndex) are covered by panelStore.test.

import { describe, it, expect, beforeEach } from "vitest";
import type { Artifact } from "../types";
import {
  __resetPanelStoreForTests,
  sanitizeArtifact,
  artifactIdentity,
  describeArtifact,
  fullWidthRoute,
  decideOpen,
  appendOrActivate,
  artifactShortTitle,
} from "./panelStore";
import { artifactRef } from "./agentContext";

const trading: Artifact = { kind: "surface", project: "lodestar", page: "trading" };

beforeEach(() => {
  __resetPanelStoreForTests();
});

describe("surface artifact — load gate", () => {
  it("keeps only project + page, and accepts an UNREGISTERED page (render-time concern, not a load gate)", () => {
    expect(sanitizeArtifact({ kind: "surface", project: "lodestar", page: "trading", extra: 1 })).toEqual(trading);
    expect(sanitizeArtifact({ kind: "surface", project: "lodestar", page: "renamed" })).toEqual({
      kind: "surface",
      project: "lodestar",
      page: "renamed",
    });
  });

  it("rejects a half-specified surface", () => {
    expect(sanitizeArtifact({ kind: "surface", project: "lodestar" })).toBeNull();
    expect(sanitizeArtifact({ kind: "surface", page: "trading" })).toBeNull();
    expect(sanitizeArtifact({ kind: "surface", project: "", page: "trading" })).toBeNull();
  });
});

describe("surface artifact — identity + strip", () => {
  it("identity is kind + project + page", () => {
    expect(artifactIdentity(trading)).toBe("surface:lodestar:trading");
    expect(artifactIdentity({ kind: "surface", project: "lodestar", page: "markets" })).not.toBe(
      artifactIdentity(trading)
    );
  });

  it("appending the same page twice activates the existing tab (dedupe by identity)", () => {
    const once = appendOrActivate(null, trading);
    const twice = appendOrActivate(once, { ...trading });
    expect(twice.artifacts).toHaveLength(1);
    expect(twice.activeIndex).toBe(0);
  });
});

describe("surface artifact — header + naming", () => {
  it("describes as `project › pages › Label` with the surface icon", () => {
    const d = describeArtifact(trading);
    expect(d.icon).toBe("surface");
    expect(d.crumbs).toEqual([
      { text: "lodestar", tone: "lead" },
      { text: "pages", tone: "dim" },
      { text: "Trading", tone: "bright" },
    ]);
    expect(d.title).toBe("lodestar / pages / Trading");
  });

  it("an unregistered page still names itself by id", () => {
    const d = describeArtifact({ kind: "surface", project: "lodestar", page: "renamed" });
    expect(d.crumbs[2]).toEqual({ text: "renamed", tone: "bright" });
  });

  it("has a short title for the strip tab", () => {
    expect(artifactShortTitle(trading)).toBeTruthy();
  });

  it("the agent reference names project/page", () => {
    expect(artifactRef(trading)).toBe("surface lodestar/trading");
  });
});

describe("surface artifact — open decision", () => {
  it("full width is the project screen", () => {
    expect(fullWidthRoute(trading)).toEqual({ screen: "project", project: "lodestar", page: "trading" });
  });

  it("obeys the same terminal→panel / reading-screen→navigate rule as a doc", () => {
    expect(decideOpen(trading, { screen: "terminal", sessionId: "s1", modifier: false })).toMatchObject({
      action: "panel",
      sessionId: "s1",
      revealTerminal: false,
    });
    expect(decideOpen(trading, { screen: "explorer", sessionId: "s1", modifier: false })).toEqual({
      action: "navigate",
      route: { screen: "project", project: "lodestar", page: "trading" },
    });
    expect(decideOpen(trading, { screen: "project", sessionId: "s1", modifier: true })).toMatchObject({
      action: "panel",
      revealTerminal: true,
    });
  });
});
