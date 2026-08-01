import { describe, it, expect, beforeEach } from "vitest";
import type { Artifact, Thread } from "../types";
import {
  // pure helpers
  clampPanelWidth,
  sanitizeArtifact,
  parsePanels,
  parsePanelWidth,
  serializePanels,
  remapPanels,
  // store
  initPanelStore,
  openInPanel,
  closePanel,
  removeSessionPanel,
  artifactFor,
  getPanelWidth,
  setPanelWidth,
  getPanelsRecord,
  getPanelsView,
  remapPanelSessions,
  DEFAULT_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  __resetPanelStoreForTests,
  // A2 host layout + header presentation (pure)
  panelLayoutFor,
  panelWidthFromDrag,
  describeArtifact,
  MIN_TERMINAL_WIDTH,
  OVERLAY_BREAKPOINT,
} from "./panelStore";
// The workspace migration + staleness rules live in threadStore.ts (so tests
// can import them without dragging in the xterm-backed terminal facade); the
// PANEL half of those rules is owned here.
import { migrateSavedWorkspace, applyWorkspaceStaleness, newThread } from "./threadStore";

const KB_DOC: Artifact = { kind: "kb-doc", path: "switchboard/features/artifact-panel/requirements.md" };
const REPO_FILE: Artifact = { kind: "repo-file", project: "switchboard", path: "src/App.tsx" };

function mkThread(overrides: Partial<Thread> = {}): Thread {
  return { ...newThread({ title: "t", workingDir: "C:/repo" }), ...overrides };
}

function mkWorkspaceV1(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    sessions: [
      { id: "s1", name: "shell", repo: "repo", working_dir: "C:/repo", cols: 120, rows: 30 },
    ],
    activeSessionId: "s1",
    paneLayout: { type: "leaf", id: "pane-1", sessionId: "s1" },
    focusedPaneId: "pane-1",
    sessionCounter: 3,
    savedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  __resetPanelStoreForTests();
});

// ─── Lean-record invariant ───────────────────────────────────────────────────

describe("sanitizeArtifact (lean-record invariant)", () => {
  it("keeps only the schema fields of each kind", () => {
    expect(sanitizeArtifact({ ...KB_DOC, scrollTop: 400, title: "cached" })).toEqual(KB_DOC);
    expect(sanitizeArtifact({ ...REPO_FILE, contents: "x".repeat(10000) })).toEqual(REPO_FILE);
  });

  it("tolerates the Phase B localhost kind on load (declared, never constructed here)", () => {
    expect(sanitizeArtifact({ kind: "localhost", project: "orbit", url: "http://localhost:5173" })).toEqual({
      kind: "localhost",
      project: "orbit",
      url: "http://localhost:5173",
    });
  });

  it("rejects unknown kinds, missing fields and non-records", () => {
    expect(sanitizeArtifact({ kind: "wat", path: "a.md" })).toBeNull();
    expect(sanitizeArtifact({ kind: "kb-doc" })).toBeNull();
    expect(sanitizeArtifact({ kind: "kb-doc", path: "" })).toBeNull();
    expect(sanitizeArtifact({ kind: "repo-file", path: "src/App.tsx" })).toBeNull(); // no project
    expect(sanitizeArtifact({ kind: "localhost", project: "orbit" })).toBeNull(); // no url
    expect(sanitizeArtifact(null)).toBeNull();
    expect(sanitizeArtifact("kb-doc")).toBeNull();
    expect(sanitizeArtifact([KB_DOC])).toBeNull();
  });
});

// ─── Width clamping ──────────────────────────────────────────────────────────

describe("clampPanelWidth / parsePanelWidth", () => {
  it("clamps at BOTH bounds and rounds", () => {
    expect(clampPanelWidth(MIN_PANEL_WIDTH - 500)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(MAX_PANEL_WIDTH + 5000)).toBe(MAX_PANEL_WIDTH);
    expect(clampPanelWidth(500.4)).toBe(500);
  });

  it("non-finite input falls back to the default", () => {
    expect(clampPanelWidth(NaN)).toBe(DEFAULT_PANEL_WIDTH);
    expect(clampPanelWidth(Infinity)).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("parsePanelWidth: non-numbers → default, numbers → clamped", () => {
    expect(parsePanelWidth(undefined)).toBe(DEFAULT_PANEL_WIDTH);
    expect(parsePanelWidth("500")).toBe(DEFAULT_PANEL_WIDTH);
    expect(parsePanelWidth(null)).toBe(DEFAULT_PANEL_WIDTH);
    expect(parsePanelWidth(10)).toBe(MIN_PANEL_WIDTH);
    expect(parsePanelWidth(520)).toBe(520);
  });
});

// ─── Tolerant (de)serialization ──────────────────────────────────────────────

describe("parsePanels / serializePanels", () => {
  it("round-trips through the workspace blob shape", () => {
    const record = { "sess-1": KB_DOC, "sess-2": REPO_FILE };
    const parsed = parsePanels(JSON.parse(JSON.stringify(record)));
    expect(parsed).toEqual(record);
    expect(serializePanels(new Map(Object.entries(parsed)))).toEqual(record);
  });

  it("drops unknown fields on the way in AND out", () => {
    const parsed = parsePanels({ "sess-1": { ...KB_DOC, note: "junk", pins: [1, 2] } });
    expect(parsed["sess-1"]).toEqual(KB_DOC);
    const out = serializePanels(
      new Map([["sess-1", { ...KB_DOC, note: "junk" } as unknown as Artifact]])
    );
    expect(out["sess-1"]).toEqual(KB_DOC);
    expect("note" in out["sess-1"]).toBe(false);
  });

  it("skips malformed entries INDIVIDUALLY (a broken one must not eat the rest)", () => {
    const parsed = parsePanels({
      "sess-1": KB_DOC,
      "sess-2": { kind: "nope" },
      "sess-3": null,
      "": KB_DOC, // empty key
      "sess-4": REPO_FILE,
    });
    expect(parsed).toEqual({ "sess-1": KB_DOC, "sess-4": REPO_FILE });
  });

  it("non-object input → empty record", () => {
    expect(parsePanels(undefined)).toEqual({});
    expect(parsePanels(null)).toEqual({});
    expect(parsePanels("panels")).toEqual({});
    expect(parsePanels([KB_DOC])).toEqual({});
  });

  it("serializePanels drops empty keys", () => {
    expect(serializePanels(new Map([["", KB_DOC]]))).toEqual({});
  });
});

// ─── Workspace v1/v2/v3 → v3 migration (panel half) ──────────────────────────

describe("migrateSavedWorkspace (panels)", () => {
  it("v1 → v3: sessions/layout/counter preserved, panels default {} + default width", () => {
    const raw = mkWorkspaceV1();
    const ws = migrateSavedWorkspace(raw)!;
    expect(ws.version).toBe(3);
    expect(ws.sessions).toEqual(raw.sessions);
    expect(ws.paneLayout).toEqual(raw.paneLayout);
    expect(ws.activeSessionId).toBe("s1");
    expect(ws.focusedPaneId).toBe("pane-1");
    expect(ws.sessionCounter).toBe(3);
    expect(ws.threads).toEqual([]);
    expect(ws.panels).toEqual({});
    expect(ws.panelWidth).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("v2 → v3 is LOSSLESS for sessions AND threads, panels default {}", () => {
    const t = mkThread({ sessionId: "s1" });
    const raw = mkWorkspaceV1({ version: 2, threads: [t] });
    const ws = migrateSavedWorkspace(raw)!;
    expect(ws.version).toBe(3);
    expect(ws.sessions).toEqual(raw.sessions);
    expect(ws.threads).toEqual([t]);
    expect(ws.panels).toEqual({});
    expect(ws.panelWidth).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("a stray panels field on a PRE-v3 blob is ignored (the version gates it)", () => {
    const ws = migrateSavedWorkspace(mkWorkspaceV1({ version: 2, panels: { "s1": KB_DOC } }))!;
    expect(ws.panels).toEqual({});
  });

  it("v3 round-trip: panels tolerant-parsed, width clamped", () => {
    const raw = mkWorkspaceV1({
      version: 3,
      threads: [],
      panels: { "s1": { ...KB_DOC, junk: 1 }, "s2": { kind: "broken" }, "s3": REPO_FILE },
      panelWidth: 5000,
    });
    const ws = migrateSavedWorkspace(raw)!;
    expect(ws.version).toBe(3);
    expect(ws.panels).toEqual({ "s1": KB_DOC, "s3": REPO_FILE });
    expect(ws.panelWidth).toBe(MAX_PANEL_WIDTH);
  });

  it("v3 with a garbage panels blob degrades to {} rather than rejecting the workspace", () => {
    const ws = migrateSavedWorkspace(mkWorkspaceV1({ version: 3, panels: "nope" }))!;
    expect(ws).not.toBeNull();
    expect(ws.sessions).toHaveLength(1);
    expect(ws.panels).toEqual({});
  });

  it("unknown versions are still rejected outright", () => {
    expect(migrateSavedWorkspace(mkWorkspaceV1({ version: 4 }))).toBeNull();
    expect(migrateSavedWorkspace(mkWorkspaceV1({ version: "3" }))).toBeNull();
  });
});

// ─── Staleness: panels expire WITH their sessions ────────────────────────────

describe("applyWorkspaceStaleness (panels)", () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  it("fresh workspace keeps its panels untouched", () => {
    const ws = migrateSavedWorkspace(
      mkWorkspaceV1({ version: 3, panels: { "s1": KB_DOC }, panelWidth: 500 })
    )!;
    expect(applyWorkspaceStaleness(ws, ws.savedAt + WEEK, WEEK)).toBe(ws);
  });

  it("expired sessions take their PANELS with them — threads survive", () => {
    const t = mkThread({ sessionId: "s1" });
    const ws = migrateSavedWorkspace(
      mkWorkspaceV1({ version: 3, threads: [t], panels: { "s1": KB_DOC }, panelWidth: 500 })
    )!;
    const stale = applyWorkspaceStaleness(ws, ws.savedAt + WEEK + 1, WEEK);
    expect(stale.sessions).toEqual([]);
    expect(stale.paneLayout).toBeNull();
    expect(stale.panels).toEqual({}); // binding to an expired session is meaningless
    expect(stale.threads).toEqual([t]); // durable by definition
    expect(stale.panelWidth).toBe(500); // width is global, not session-bound
  });
});

// ─── Restore remap ───────────────────────────────────────────────────────────

describe("remapPanels", () => {
  it("full map: every binding follows its session to the new id", () => {
    const out = remapPanels(
      { "old-1": KB_DOC, "old-2": REPO_FILE },
      new Map([
        ["old-1", "new-1"],
        ["old-2", "new-2"],
      ])
    );
    expect(out).toEqual({ "new-1": KB_DOC, "new-2": REPO_FILE });
  });

  it("PARTIAL map: orphans are DROPPED (unlike threads, which are severed)", () => {
    const out = remapPanels({ "old-1": KB_DOC, "old-2": REPO_FILE }, new Map([["old-1", "new-1"]]));
    expect(out).toEqual({ "new-1": KB_DOC });
    expect("old-2" in out).toBe(false);
  });

  it("empty map (fresh start / all restores failed) drops everything", () => {
    expect(remapPanels({ "old-1": KB_DOC }, new Map())).toEqual({});
  });
});

describe("remapPanelSessions (store)", () => {
  it("rewrites live keys and drops the unmapped ones", () => {
    initPanelStore({ "old-1": KB_DOC, "old-2": REPO_FILE });
    remapPanelSessions(new Map([["old-1", "new-1"]]));
    expect(artifactFor("new-1")).toEqual(KB_DOC);
    expect(artifactFor("old-1")).toBeNull();
    expect(artifactFor("old-2")).toBeNull();
    expect(getPanelsRecord()).toEqual({ "new-1": KB_DOC });
  });

  it("empty map clears every binding but keeps the global width", () => {
    initPanelStore({ "old-1": KB_DOC }, 500);
    remapPanelSessions(new Map());
    expect(getPanelsRecord()).toEqual({});
    expect(getPanelWidth()).toBe(500);
  });
});

// ─── Store behavior ──────────────────────────────────────────────────────────

describe("panel store", () => {
  it("open → artifactFor; opening again REPLACES (one artifact per tab)", () => {
    openInPanel("sess-1", KB_DOC);
    expect(artifactFor("sess-1")).toEqual(KB_DOC);
    openInPanel("sess-1", REPO_FILE);
    expect(artifactFor("sess-1")).toEqual(REPO_FILE);
    expect(getPanelsRecord()).toEqual({ "sess-1": REPO_FILE });
  });

  it("panels are PER-TAB — one tab's panel never leaks into another", () => {
    openInPanel("sess-1", KB_DOC);
    openInPanel("sess-2", REPO_FILE);
    expect(artifactFor("sess-1")).toEqual(KB_DOC);
    expect(artifactFor("sess-2")).toEqual(REPO_FILE);
    expect(artifactFor("sess-3")).toBeNull();
  });

  it("open sanitizes at the gate and rejects junk / empty session ids", () => {
    openInPanel("sess-1", { ...KB_DOC, junk: true } as unknown as Artifact);
    expect(artifactFor("sess-1")).toEqual(KB_DOC);
    openInPanel("sess-2", { kind: "nope" } as unknown as Artifact);
    expect(artifactFor("sess-2")).toBeNull();
    openInPanel("", KB_DOC);
    expect(getPanelsRecord()).toEqual({ "sess-1": KB_DOC });
  });

  it("close drops only that tab's panel; closing twice is a no-op", () => {
    openInPanel("sess-1", KB_DOC);
    openInPanel("sess-2", REPO_FILE);
    closePanel("sess-1");
    expect(artifactFor("sess-1")).toBeNull();
    expect(artifactFor("sess-2")).toEqual(REPO_FILE);
    const view = getPanelsView();
    closePanel("sess-1"); // already closed — must not churn the snapshot
    expect(getPanelsView()).toBe(view);
  });

  it("tab close: removeSessionPanel drops the binding with the session", () => {
    openInPanel("sess-1", KB_DOC);
    openInPanel("sess-2", REPO_FILE);
    removeSessionPanel("sess-1");
    expect(artifactFor("sess-1")).toBeNull();
    expect(getPanelsRecord()).toEqual({ "sess-2": REPO_FILE });
  });

  it("width is GLOBAL and clamped at both bounds; a no-op set does not churn", () => {
    expect(getPanelWidth()).toBe(DEFAULT_PANEL_WIDTH);
    setPanelWidth(520);
    expect(getPanelWidth()).toBe(520);
    setPanelWidth(MIN_PANEL_WIDTH - 200);
    expect(getPanelWidth()).toBe(MIN_PANEL_WIDTH);
    setPanelWidth(MAX_PANEL_WIDTH + 200);
    expect(getPanelWidth()).toBe(MAX_PANEL_WIDTH);
    const view = getPanelsView();
    setPanelWidth(MAX_PANEL_WIDTH);
    expect(getPanelsView()).toBe(view);
  });

  it("boot seed: initPanelStore sanitizes and clamps, missing width → default", () => {
    initPanelStore(
      { "s1": { ...KB_DOC, junk: 1 } as unknown as Artifact, "s2": { kind: "bad" } as unknown as Artifact },
      9999
    );
    expect(getPanelsRecord()).toEqual({ "s1": KB_DOC });
    expect(getPanelWidth()).toBe(MAX_PANEL_WIDTH);

    initPanelStore({});
    expect(getPanelsRecord()).toEqual({});
    expect(getPanelWidth()).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("the view snapshot is stable between mutations (useSyncExternalStore contract)", () => {
    openInPanel("sess-1", KB_DOC);
    const v1 = getPanelsView();
    expect(getPanelsView()).toBe(v1);
    expect(v1.panels.get("sess-1")).toEqual(KB_DOC);
    openInPanel("sess-2", REPO_FILE);
    const v2 = getPanelsView();
    expect(v2).not.toBe(v1);
    expect(v1.panels.has("sess-2")).toBe(false); // old snapshot not mutated in place
    expect(v2.panels.size).toBe(2);
  });

  it("boot round-trip: store → workspace record → migrate → store", () => {
    openInPanel("sess-1", KB_DOC);
    setPanelWidth(500);
    const blob = mkWorkspaceV1({
      version: 3,
      threads: [],
      panels: getPanelsRecord(),
      panelWidth: getPanelWidth(),
    });
    __resetPanelStoreForTests();
    const ws = migrateSavedWorkspace(JSON.parse(JSON.stringify(blob)))!;
    initPanelStore(ws.panels, ws.panelWidth);
    expect(artifactFor("sess-1")).toEqual(KB_DOC);
    expect(getPanelWidth()).toBe(500);
  });
});

// ─── A2: host layout policy ──────────────────────────────────────────────────

describe("panelLayoutFor (docked vs overlay)", () => {
  it("docks at the requested width on a roomy row", () => {
    expect(panelLayoutFor(1600, 420)).toEqual({ mode: "docked", width: 420 });
  });

  it("never lets the pane tree fall below MIN_TERMINAL_WIDTH while docked", () => {
    // 1100px row, user dragged the panel to its 960 ceiling → capped at 780.
    expect(panelLayoutFor(1100, MAX_PANEL_WIDTH)).toEqual({
      mode: "docked",
      width: 1100 - MIN_TERMINAL_WIDTH,
    });
  });

  it("overlays below the breakpoint instead of squeezing the shell", () => {
    const layout = panelLayoutFor(OVERLAY_BREAKPOINT - 1, 420);
    expect(layout.mode).toBe("overlay");
    expect(layout.width).toBe(420);
  });

  it("docks exactly AT the breakpoint (and the cap still clears the panel floor)", () => {
    const layout = panelLayoutFor(OVERLAY_BREAKPOINT, MAX_PANEL_WIDTH);
    expect(layout.mode).toBe("docked");
    expect(layout.width).toBe(OVERLAY_BREAKPOINT - MIN_TERMINAL_WIDTH);
    expect(layout.width).toBeGreaterThanOrEqual(MIN_PANEL_WIDTH);
  });

  it("an overlay is never wider than the row it floats over", () => {
    expect(panelLayoutFor(300, 420)).toEqual({ mode: "overlay", width: 300 });
  });

  it("an unmeasured row (hidden screen / first paint) docks at the requested width", () => {
    expect(panelLayoutFor(0, 500)).toEqual({ mode: "docked", width: 500 });
    expect(panelLayoutFor(NaN, 500)).toEqual({ mode: "docked", width: 500 });
  });

  it("clamps a junk requested width through the same gate as the store", () => {
    expect(panelLayoutFor(1600, 10).width).toBe(MIN_PANEL_WIDTH);
    expect(panelLayoutFor(2400, 5000).width).toBe(MAX_PANEL_WIDTH);
    expect(panelLayoutFor(1600, NaN).width).toBe(DEFAULT_PANEL_WIDTH);
  });
});

describe("panelWidthFromDrag", () => {
  // Row spans x=100..1700 (1600 wide).
  it("width is the distance from the pointer to the row's right edge", () => {
    expect(panelWidthFromDrag(100, 1600, 1300)).toBe(400);
  });

  it("dragging past the terminal-side floor stops at the cap", () => {
    // 1200px row: the floor (1200-320=880) binds BEFORE MAX_PANEL_WIDTH, so a
    // pointer at the row's left edge — asking for the whole row — yields 880.
    expect(panelWidthFromDrag(100, 1200, 100)).toBe(1200 - MIN_TERMINAL_WIDTH);
    // 1600px row: the floor would allow 1280, so MAX_PANEL_WIDTH binds first.
    expect(panelWidthFromDrag(100, 1600, 100)).toBe(MAX_PANEL_WIDTH);
  });

  it("dragging past the panel floor stops at MIN_PANEL_WIDTH", () => {
    expect(panelWidthFromDrag(100, 1600, 1699)).toBe(MIN_PANEL_WIDTH);
  });

  it("never exceeds MAX_PANEL_WIDTH on a very wide row", () => {
    expect(panelWidthFromDrag(0, 3000, 0)).toBe(MAX_PANEL_WIDTH);
  });

  it("a drag result feeds panelLayoutFor without further clamping (docked)", () => {
    const w = panelWidthFromDrag(0, 1200, 0); // asks for everything → 880
    expect(w).toBe(1200 - MIN_TERMINAL_WIDTH);
    expect(panelLayoutFor(1200, w)).toEqual({ mode: "docked", width: w });
  });
});

// ─── A2: header presentation ─────────────────────────────────────────────────

describe("describeArtifact (glyph + breadcrumb)", () => {
  it("kb-doc: `kb` root, ancestors dim, the doc bright", () => {
    const d = describeArtifact(KB_DOC);
    expect(d.crumbs).toEqual([
      { text: "kb", tone: "dim" },
      { text: "switchboard", tone: "lead" },
      { text: "features", tone: "dim" },
      { text: "artifact-panel", tone: "dim" },
      { text: "requirements.md", tone: "bright" },
    ]);
    expect(d.title).toBe("kb / switchboard/features/artifact-panel/requirements.md");
    expect(d.glyph.length).toBeGreaterThan(0);
  });

  it("repo-file: the PROJECT is the lead crumb, path segments are plain ancestors", () => {
    const d = describeArtifact(REPO_FILE);
    expect(d.crumbs).toEqual([
      { text: "switchboard", tone: "lead" },
      { text: "src", tone: "dim" },
      { text: "App.tsx", tone: "bright" },
    ]);
    expect(d.title).toBe("switchboard / src/App.tsx");
  });

  it("a single-segment path is bright, not lead (the file always wins)", () => {
    expect(describeArtifact({ kind: "kb-doc", path: "README.md" }).crumbs).toEqual([
      { text: "kb", tone: "dim" },
      { text: "README.md", tone: "bright" },
    ]);
  });

  it("tolerates stray slashes without emitting empty crumbs", () => {
    expect(describeArtifact({ kind: "kb-doc", path: "a//b.md" }).crumbs).toEqual([
      { text: "kb", tone: "dim" },
      { text: "a", tone: "lead" },
      { text: "b.md", tone: "bright" },
    ]);
  });

  it("localhost (phase B) still describes cleanly", () => {
    const d = describeArtifact({ kind: "localhost", project: "lodestar", url: "http://localhost:5173" });
    expect(d.crumbs).toEqual([
      { text: "lodestar", tone: "lead" },
      { text: "http://localhost:5173", tone: "bright" },
    ]);
  });

  it("kb-doc and repo-file are visually distinguishable by glyph", () => {
    expect(describeArtifact(KB_DOC).glyph).not.toBe(describeArtifact(REPO_FILE).glyph);
  });
});
