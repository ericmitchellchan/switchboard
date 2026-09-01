// The `surface` artifact kind through panelStore's pure seams (SWIT-30):
// load gate, identity, header description, and the full-width route. Kept in
// its own file so the kind's contract reads in one place; the strip
// invariants it inherits (dedupe, activeIndex) are covered by panelStore.test.
// T9 (SWIT-63): the optional `params` (a page STATE) through the same seams,
// and the preview-slot-by-default open rule.

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
const tradingNQ: Artifact = {
  kind: "surface",
  project: "lodestar",
  page: "trading",
  params: { instrument: "NQ", date: "2026-06-05" },
};

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

describe("surface artifact — open decision (T9: preview slot by default)", () => {
  it("full width is the project screen, params carried", () => {
    expect(fullWidthRoute(trading)).toEqual({ screen: "project", project: "lodestar", page: "trading" });
    expect(fullWidthRoute(tradingNQ)).toEqual({
      screen: "project",
      project: "lodestar",
      page: "trading",
      params: { instrument: "NQ", date: "2026-06-05" },
    });
    expect(fullWidthRoute(trading)).not.toHaveProperty("params");
  });

  it("a plain click opens BESIDE the active thread from EVERY screen, revealing the terminal off it", () => {
    expect(decideOpen(trading, { screen: "terminal", sessionId: "s1", modifier: false })).toEqual({
      action: "panel",
      sessionId: "s1",
      artifact: trading,
      revealTerminal: false,
    });
    for (const screen of ["home", "kb", "explorer", "threads", "project"] as const) {
      expect(decideOpen(trading, { screen, sessionId: "s1", modifier: false })).toEqual({
        action: "panel",
        sessionId: "s1",
        artifact: trading,
        revealTerminal: true,
      });
    }
  });

  it("Ctrl+click inverts to full width, on every screen", () => {
    for (const screen of ["terminal", "home", "kb", "project"] as const) {
      expect(decideOpen(tradingNQ, { screen, sessionId: "s1", modifier: true })).toEqual({
        action: "navigate",
        route: { screen: "project", project: "lodestar", page: "trading", params: { instrument: "NQ", date: "2026-06-05" } },
      });
    }
  });

  it("with NO active thread the destination still opens full width — a preview slot needs a thread", () => {
    expect(decideOpen(trading, { screen: "home", sessionId: null, modifier: false })).toEqual({
      action: "navigate",
      route: { screen: "project", project: "lodestar", page: "trading" },
    });
    expect(decideOpen(trading, { screen: "terminal", sessionId: null, modifier: true })).toMatchObject({
      action: "navigate",
    });
  });

  it("a DOC keeps the reading-screen→navigate rule (the surface exception is the surface's)", () => {
    const doc: Artifact = { kind: "kb-doc", path: "notes/a.md" };
    expect(decideOpen(doc, { screen: "kb", sessionId: "s1", modifier: false })).toEqual({
      action: "navigate",
      route: { screen: "kb", doc: "notes/a.md" },
    });
    expect(decideOpen(doc, { screen: "terminal", sessionId: "s1", modifier: false })).toMatchObject({ action: "panel" });
  });
});

describe("surface artifact — params (T9)", () => {
  it("identity includes the params, sorted and encoded, so two states are two artifacts", () => {
    expect(artifactIdentity(trading)).toBe("surface:lodestar:trading");
    expect(artifactIdentity(tradingNQ)).toBe("surface:lodestar:trading?date=2026-06-05&instrument=NQ");
    expect(
      artifactIdentity({ kind: "surface", project: "lodestar", page: "trading", params: { date: "2026-06-05", instrument: "NQ" } })
    ).toBe(artifactIdentity(tradingNQ));
    expect(artifactIdentity(tradingNQ)).not.toBe(artifactIdentity(trading));
  });

  it("two states sit in one strip as two tabs; the same state re-activates", () => {
    const s1 = appendOrActivate(null, trading);
    const s2 = appendOrActivate(s1, tradingNQ);
    expect(s2.artifacts).toHaveLength(2);
    expect(s2.activeIndex).toBe(1);
    const s3 = appendOrActivate(s2, { ...tradingNQ, params: { date: "2026-06-05", instrument: "NQ" } });
    expect(s3.artifacts).toHaveLength(2);
    expect(s3.activeIndex).toBe(1);
  });

  it("the load gate keeps a lean params map and drops the field when nothing valid remains", () => {
    expect(
      sanitizeArtifact({
        kind: "surface",
        project: "lodestar",
        page: "trading",
        params: { instrument: "NQ", "Bad Key": "x", n: 1, extra: "" },
        junk: true,
      })
    ).toEqual({ kind: "surface", project: "lodestar", page: "trading", params: { instrument: "NQ" } });
    expect(sanitizeArtifact({ kind: "surface", project: "lodestar", page: "trading", params: {} })).toEqual(trading);
    expect(sanitizeArtifact({ kind: "surface", project: "lodestar", page: "trading", params: "instrument=NQ" })).toEqual(trading);
  });

  it("the load gate caps the key count at 8 and the value at 120 chars", () => {
    const params: Record<string, string> = {};
    for (let i = 0; i < 12; i++) params[`k${i}`] = "v";
    params.k0 = "x".repeat(200);
    const clean = sanitizeArtifact({ kind: "surface", project: "lodestar", page: "trading", params });
    expect(clean?.kind).toBe("surface");
    const kept = clean?.kind === "surface" ? clean.params ?? {} : {};
    expect(Object.keys(kept)).toHaveLength(8);
    expect(kept.k0).toHaveLength(120);
  });

  it("describe + short title append the VALUES as ` · NQ 2026-06-05` (no keys)", () => {
    const d = describeArtifact(tradingNQ);
    expect(d.crumbs[d.crumbs.length - 1]).toEqual({ text: "Trading · NQ 2026-06-05", tone: "bright" });
    expect(d.title).toBe("lodestar / pages / Trading · NQ 2026-06-05");
    expect(artifactShortTitle(tradingNQ)).toBe("Trading · NQ 2026-06-05");
    expect(artifactShortTitle(trading)).toBe("Trading");
  });

  it("the agent reference names the state in the address form the agent writes", () => {
    expect(artifactRef(tradingNQ)).toBe("surface lodestar/trading?date=2026-06-05&instrument=NQ");
    expect(artifactRef(trading)).toBe("surface lodestar/trading");
  });
});
