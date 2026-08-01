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
  paneTreeWidthFor,
  artifactIdentity,
  panelIdentityFor,
  MIN_TERMINAL_WIDTH,
  OVERLAY_BREAKPOINT,
  DIVIDER_WIDTH,
  // A3 open path: routing decision + toggle memory + active-tab bridge
  decideOpen,
  applyOpenDecision,
  openArtifact,
  fullWidthRoute,
  togglePanel,
  panelToggleAvailableFor,
  publishActiveTabSession,
  getActiveTabSession,
  activeTabArtifact,
  inheritPanel,
  type OpenableArtifact,
  type OpenContext,
} from "./panelStore";
import { __resetNavForTests, getNavState } from "./route";
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
  __resetNavForTests();
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
//
// GEOMETRY CONTRACT: every width below is the WORKSPACE CONTAINER
// `[pane tree | divider | panel]`, which App.tsx nests inside the
// terminal-screen row so the TaskSidebar sits OUTSIDE it. These tests encode
// that contract by deriving the container from a row width minus the sidebar,
// which is exactly the term the pre-review code was missing.

/** TaskSidebar widths (hidden / collapsed / full) — a sibling of the workspace
 *  container, so its width is subtracted BEFORE the panel does any math. */
const SIDEBAR_W = { hidden: 0, collapsed: 38, full: 280 } as const;
type SidebarWidthState = keyof typeof SIDEBAR_W;

const workspaceWidth = (rowWidth: number, sidebar: SidebarWidthState) =>
  rowWidth - SIDEBAR_W[sidebar];

const ROW_WIDTHS = [880, 1100, 1280, 1600];
const SIDEBAR_STATES: SidebarWidthState[] = ["hidden", "collapsed", "full"];

describe("panelLayoutFor (docked vs overlay)", () => {
  it("docks at the requested width on a roomy container", () => {
    expect(panelLayoutFor(1600, 420)).toEqual({ mode: "docked", width: 420 });
  });

  it("the docked cap reserves the divider's own 4px on top of the terminal floor", () => {
    expect(panelLayoutFor(1100, MAX_PANEL_WIDTH)).toEqual({
      mode: "docked",
      width: 1100 - MIN_TERMINAL_WIDTH - DIVIDER_WIDTH,
    });
  });

  it("overlays below the breakpoint instead of squeezing the shell", () => {
    const layout = panelLayoutFor(OVERLAY_BREAKPOINT - 1, 420);
    expect(layout.mode).toBe("overlay");
    expect(layout.width).toBe(420);
  });

  it("docks exactly AT the breakpoint, and the cap still clears the panel floor", () => {
    const layout = panelLayoutFor(OVERLAY_BREAKPOINT, MAX_PANEL_WIDTH);
    expect(layout.mode).toBe("docked");
    expect(layout.width).toBe(OVERLAY_BREAKPOINT - MIN_TERMINAL_WIDTH - DIVIDER_WIDTH); // 556
    expect(layout.width).toBeGreaterThanOrEqual(MIN_PANEL_WIDTH);
  });

  it("an overlay is never wider than the container it floats over", () => {
    expect(panelLayoutFor(300, 420)).toEqual({ mode: "overlay", width: 300 });
  });

  it("an unmeasured container (hidden screen / first paint) docks at the requested width", () => {
    expect(panelLayoutFor(0, 500)).toEqual({ mode: "docked", width: 500 });
    expect(panelLayoutFor(NaN, 500)).toEqual({ mode: "docked", width: 500 });
  });

  it("clamps a junk requested width through the same gate as the store", () => {
    expect(panelLayoutFor(1600, 10).width).toBe(MIN_PANEL_WIDTH);
    expect(panelLayoutFor(2400, 5000).width).toBe(MAX_PANEL_WIDTH);
    expect(panelLayoutFor(1600, NaN).width).toBe(DEFAULT_PANEL_WIDTH);
  });
});

describe("terminal floor holds across row width x sidebar state", () => {
  // The regression matrix. Pre-review the panel measured the whole row (the
  // TaskSidebar included), so at row 1100 / sidebar full the pane tree was
  // left with 36px. Every cell below must leave the shell >= MIN_TERMINAL_WIDTH.
  for (const rowWidth of ROW_WIDTHS) {
    for (const sidebar of SIDEBAR_STATES) {
      it(`row ${rowWidth} / sidebar ${sidebar}: shell keeps >= ${MIN_TERMINAL_WIDTH}px at max drag`, () => {
        const container = workspaceWidth(rowWidth, sidebar);
        const layout = panelLayoutFor(container, MAX_PANEL_WIDTH);
        const paneTree = paneTreeWidthFor(container, layout);
        expect(paneTree).toBeGreaterThanOrEqual(MIN_TERMINAL_WIDTH);
        // Overlay leaves the tree untouched; docked hands back exactly the
        // floor whenever the cap binds.
        if (layout.mode === "overlay") expect(paneTree).toBe(container);
      });
    }
  }

  it("the specific cell the reviewer computed: row 1100, sidebar full", () => {
    const container = workspaceWidth(1100, "full"); // 820
    const layout = panelLayoutFor(container, MAX_PANEL_WIDTH);
    // 820 < 880 → the panel floats rather than leaving the shell 36px.
    expect(layout).toEqual({ mode: "overlay", width: 820 });
    expect(paneTreeWidthFor(container, layout)).toBe(820);
  });

  it("row 1100, sidebar collapsed/hidden: docked, shell lands exactly on the floor", () => {
    for (const sidebar of ["collapsed", "hidden"] as SidebarWidthState[]) {
      const container = workspaceWidth(1100, sidebar);
      const layout = panelLayoutFor(container, MAX_PANEL_WIDTH);
      expect(layout.mode).toBe("docked");
      expect(paneTreeWidthFor(container, layout)).toBe(MIN_TERMINAL_WIDTH);
    }
  });

  it("a wide row is unaffected by sidebar state beyond the width it consumes", () => {
    for (const sidebar of SIDEBAR_STATES) {
      const container = workspaceWidth(1600, sidebar);
      const layout = panelLayoutFor(container, 420);
      expect(layout).toEqual({ mode: "docked", width: 420 });
      expect(paneTreeWidthFor(container, layout)).toBe(container - DIVIDER_WIDTH - 420);
    }
  });
});

describe("panelWidthFromDrag", () => {
  it("puts the DIVIDER's left edge exactly under the cursor", () => {
    // Container spans x=218..1320 (1102 wide) — window 1600, side menu 218,
    // and a full 280px TaskSidebar that is OUTSIDE the container. Pre-review
    // the same drag was computed against the row's right edge (1600), so the
    // divider trailed the cursor by exactly the sidebar's 280px.
    // Cursor range kept inside the unclamped band ([260, 778] panel width).
    const left = 218;
    const width = 1102;
    for (const clientX of [600, 700, 900, 1000]) {
      const w = panelWidthFromDrag(left, width, clientX);
      const dividerLeft = left + width - w - DIVIDER_WIDTH;
      expect(dividerLeft).toBe(clientX); // no trailing, whatever the sidebar does
    }
  });

  it("dragging past the terminal-side floor stops at the cap", () => {
    // 1200px container: the floor (1200-320-4=876) binds before MAX_PANEL_WIDTH.
    expect(panelWidthFromDrag(100, 1200, 100)).toBe(1200 - MIN_TERMINAL_WIDTH - DIVIDER_WIDTH);
    // 1600px container: the floor would allow 1276, so MAX_PANEL_WIDTH binds.
    expect(panelWidthFromDrag(100, 1600, 100)).toBe(MAX_PANEL_WIDTH);
  });

  it("dragging past the panel floor stops at MIN_PANEL_WIDTH", () => {
    expect(panelWidthFromDrag(100, 1600, 1699)).toBe(MIN_PANEL_WIDTH);
  });

  it("never exceeds MAX_PANEL_WIDTH on a very wide container", () => {
    expect(panelWidthFromDrag(0, 3000, 0)).toBe(MAX_PANEL_WIDTH);
  });

  it("a drag result feeds panelLayoutFor without further clamping", () => {
    const w = panelWidthFromDrag(0, 1200, 0); // asks for everything → 876
    expect(w).toBe(1200 - MIN_TERMINAL_WIDTH - DIVIDER_WIDTH);
    expect(panelLayoutFor(1200, w)).toEqual({ mode: "docked", width: w });
    expect(paneTreeWidthFor(1200, panelLayoutFor(1200, w))).toBe(MIN_TERMINAL_WIDTH);
  });

  it("an unmeasured container still clamps (no NaN width reaches the store)", () => {
    expect(panelWidthFromDrag(0, 0, 0)).toBe(MIN_PANEL_WIDTH);
    expect(panelWidthFromDrag(0, NaN, 0)).toBe(DEFAULT_PANEL_WIDTH);
  });
});

// ─── A2: panel identity (boundary reset key + narrow-selector snapshot) ───────

describe("artifactIdentity / panelIdentityFor", () => {
  it("distinguishes kind, project and path", () => {
    expect(artifactIdentity(KB_DOC)).not.toBe(artifactIdentity(REPO_FILE));
    expect(artifactIdentity({ kind: "kb-doc", path: "a.md" })).not.toBe(
      artifactIdentity({ kind: "kb-doc", path: "b.md" })
    );
    expect(artifactIdentity({ kind: "repo-file", project: "x", path: "a" })).not.toBe(
      artifactIdentity({ kind: "repo-file", project: "y", path: "a" })
    );
  });

  it("is stable for equal content, so a reset key does not churn per render", () => {
    expect(artifactIdentity({ ...KB_DOC })).toBe(artifactIdentity(KB_DOC));
  });

  it("panelIdentityFor: empty string when the tab has no panel", () => {
    expect(panelIdentityFor(null)).toBe("");
    expect(panelIdentityFor("sess-1")).toBe("");
    openInPanel("sess-1", KB_DOC);
    expect(panelIdentityFor("sess-1")).toBe(artifactIdentity(KB_DOC));
    openInPanel("sess-1", REPO_FILE);
    expect(panelIdentityFor("sess-1")).toBe(artifactIdentity(REPO_FILE));
    closePanel("sess-1");
    expect(panelIdentityFor("sess-1")).toBe("");
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

// ─── A3: open-in-panel routing decision (architecture Decision 2) ────────────

const OPEN_DOC: OpenableArtifact = { kind: "kb-doc", path: "switchboard/features/x.md" };
const OPEN_FILE: OpenableArtifact = {
  kind: "repo-file",
  project: "switchboard",
  path: "src/App.tsx",
};

function ctx(over: Partial<OpenContext> = {}): OpenContext {
  return { screen: "terminal", sessionId: "s1", modifier: false, ...over };
}

describe("decideOpen — every screen x modifier x active-session cell", () => {
  // The full truth table, spelled out rather than derived: the derivation IS
  // the code under test.
  const CELLS: Array<{
    screen: OpenContext["screen"];
    modifier: boolean;
    session: string | null;
    action: "panel" | "navigate";
  }> = [
    { screen: "terminal", modifier: false, session: "s1", action: "panel" },
    { screen: "terminal", modifier: false, session: null, action: "navigate" },
    { screen: "terminal", modifier: true, session: "s1", action: "navigate" },
    { screen: "terminal", modifier: true, session: null, action: "navigate" },
    { screen: "kb", modifier: false, session: "s1", action: "navigate" },
    { screen: "kb", modifier: false, session: null, action: "navigate" },
    { screen: "kb", modifier: true, session: "s1", action: "panel" },
    { screen: "kb", modifier: true, session: null, action: "navigate" },
    { screen: "explorer", modifier: false, session: "s1", action: "navigate" },
    { screen: "explorer", modifier: false, session: null, action: "navigate" },
    { screen: "explorer", modifier: true, session: "s1", action: "panel" },
    { screen: "explorer", modifier: true, session: null, action: "navigate" },
  ];

  for (const cell of CELLS) {
    const label = `${cell.screen} + modifier:${cell.modifier ? "on" : "off"} + session:${
      cell.session ? "yes" : "no"
    } -> ${cell.action}`;
    it(label, () => {
      const d = decideOpen(
        OPEN_DOC,
        ctx({ screen: cell.screen, modifier: cell.modifier, sessionId: cell.session })
      );
      expect(d.action).toBe(cell.action);
    });
  }

  it("the same table holds for repo-file targets", () => {
    for (const cell of CELLS) {
      const d = decideOpen(
        OPEN_FILE,
        ctx({ screen: cell.screen, modifier: cell.modifier, sessionId: cell.session })
      );
      expect([cell.screen, cell.modifier, cell.session, d.action]).toEqual([
        cell.screen,
        cell.modifier,
        cell.session,
        cell.action,
      ]);
    }
  });

  it("a panel decision carries the hosting tab and the target verbatim", () => {
    const d = decideOpen(OPEN_DOC, ctx({ sessionId: "tab-7" }));
    expect(d).toEqual({
      action: "panel",
      sessionId: "tab-7",
      artifact: OPEN_DOC,
      revealTerminal: false,
    });
  });

  it("a forced panel open from a reading screen also reveals the terminal", () => {
    for (const screen of ["kb", "explorer"] as const) {
      const d = decideOpen(OPEN_DOC, ctx({ screen, modifier: true }));
      expect(d).toMatchObject({ action: "panel", revealTerminal: true });
    }
  });

  it("no active session NEVER yields a panel decision (nothing could host it)", () => {
    for (const screen of ["terminal", "kb", "explorer"] as const) {
      for (const modifier of [false, true]) {
        expect(decideOpen(OPEN_DOC, ctx({ screen, modifier, sessionId: null })).action).toBe(
          "navigate"
        );
      }
    }
  });

  it("navigate decisions carry the artifact's full-width route", () => {
    expect(decideOpen(OPEN_DOC, ctx({ screen: "kb" }))).toEqual({
      action: "navigate",
      route: { screen: "kb", doc: OPEN_DOC.path },
    });
    expect(decideOpen(OPEN_FILE, ctx({ screen: "explorer" }))).toEqual({
      action: "navigate",
      route: { screen: "explorer", project: "switchboard", path: "src/App.tsx" },
    });
  });

  it("fullWidthRoute maps each openable kind to its screen", () => {
    expect(fullWidthRoute(OPEN_DOC)).toEqual({ screen: "kb", doc: OPEN_DOC.path });
    expect(fullWidthRoute(OPEN_FILE)).toEqual({
      screen: "explorer",
      project: "switchboard",
      path: "src/App.tsx",
    });
  });
});

// ─── A3: the effectful wrapper (store + navigation) ─────────────────────────

describe("openArtifact / applyOpenDecision (effects)", () => {
  it("terminal screen + active tab: writes the panel, leaves the route alone", () => {
    publishActiveTabSession("s1");
    const d = openArtifact(OPEN_DOC);
    expect(d.action).toBe("panel");
    expect(artifactFor("s1")).toEqual(OPEN_DOC);
    expect(getNavState().route).toEqual({ screen: "terminal" });
  });

  it("kb screen: navigates full-width and opens NO panel", () => {
    publishActiveTabSession("s1");
    __resetNavForTests({ screen: "kb", doc: "other.md" });
    const d = openArtifact(OPEN_DOC);
    expect(d.action).toBe("navigate");
    expect(getNavState().route).toEqual({ screen: "kb", doc: OPEN_DOC.path });
    expect(artifactFor("s1")).toBeNull();
  });

  it("Ctrl+click on the terminal screen navigates full-width instead", () => {
    publishActiveTabSession("s1");
    openArtifact(OPEN_FILE, { modifier: true });
    expect(artifactFor("s1")).toBeNull();
    expect(getNavState().route).toEqual({
      screen: "explorer",
      project: "switchboard",
      path: "src/App.tsx",
    });
  });

  it("Ctrl+click on the kb screen opens the panel AND switches to the terminal", () => {
    publishActiveTabSession("s1");
    __resetNavForTests({ screen: "kb", doc: "other.md" });
    openArtifact(OPEN_DOC, { modifier: true });
    expect(artifactFor("s1")).toEqual(OPEN_DOC);
    expect(getNavState().route).toEqual({ screen: "terminal" });
  });

  it("no tabs open: a terminal-screen click still navigates full-width", () => {
    publishActiveTabSession(null);
    openArtifact(OPEN_DOC);
    expect(getNavState().route).toEqual({ screen: "kb", doc: OPEN_DOC.path });
  });

  it("opening a second artifact REPLACES the tab's panel content", () => {
    publishActiveTabSession("s1");
    openArtifact(OPEN_DOC);
    openArtifact(OPEN_FILE);
    expect(artifactFor("s1")).toEqual(OPEN_FILE);
  });

  it("each tab keeps its own artifact (criterion 3)", () => {
    publishActiveTabSession("s1");
    openArtifact(OPEN_DOC);
    publishActiveTabSession("s2");
    expect(activeTabArtifact()).toBeNull(); // s2 has nothing yet
    openArtifact(OPEN_FILE);
    publishActiveTabSession("s1");
    expect(activeTabArtifact()).toEqual(OPEN_DOC);
    publishActiveTabSession("s2");
    expect(activeTabArtifact()).toEqual(OPEN_FILE);
  });

  it("applyOpenDecision performs a decision it was not asked to make", () => {
    applyOpenDecision({
      action: "panel",
      sessionId: "s9",
      artifact: OPEN_DOC,
      revealTerminal: true,
    });
    expect(artifactFor("s9")).toEqual(OPEN_DOC);
    expect(getNavState().route).toEqual({ screen: "terminal" });
  });

  it("opened artifacts land in the persisted record (criterion 5's source)", () => {
    publishActiveTabSession("s1");
    openArtifact(OPEN_DOC);
    expect(getPanelsRecord()).toEqual({ s1: OPEN_DOC });
  });
});

// ─── A3: active-tab bridge ──────────────────────────────────────────────────

describe("active-tab bridge", () => {
  it("starts empty and reports whatever App published", () => {
    expect(getActiveTabSession()).toBeNull();
    publishActiveTabSession("s1");
    expect(getActiveTabSession()).toBe("s1");
    publishActiveTabSession(null);
    expect(getActiveTabSession()).toBeNull();
  });

  it("republishing the same tab does not invalidate the view snapshot", () => {
    publishActiveTabSession("s1");
    const v1 = getPanelsView();
    publishActiveTabSession("s1");
    expect(getPanelsView()).toBe(v1);
  });

  it("a tab switch DOES invalidate it (the trees re-resolve their highlight)", () => {
    publishActiveTabSession("s1");
    const v1 = getPanelsView();
    publishActiveTabSession("s2");
    expect(getPanelsView()).not.toBe(v1);
  });
});

// ─── A3: Ctrl+Shift+P true toggle (per-tab lastArtifact memory) ─────────────

describe("togglePanel (true toggle)", () => {
  it("closes an open panel, then reopens exactly what it showed", () => {
    openInPanel("s1", KB_DOC);
    togglePanel("s1");
    expect(artifactFor("s1")).toBeNull();
    togglePanel("s1");
    expect(artifactFor("s1")).toEqual(KB_DOC);
  });

  it("toggles repeatedly without drifting", () => {
    openInPanel("s1", REPO_FILE);
    for (let i = 0; i < 3; i++) {
      togglePanel("s1");
      expect(artifactFor("s1")).toBeNull();
      togglePanel("s1");
      expect(artifactFor("s1")).toEqual(REPO_FILE);
    }
  });

  it("reopens the LAST artifact, not the first", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    togglePanel("s1");
    togglePanel("s1");
    expect(artifactFor("s1")).toEqual(REPO_FILE);
  });

  it("the × button (closePanel) feeds the same memory as the chord", () => {
    openInPanel("s1", KB_DOC);
    closePanel("s1");
    togglePanel("s1");
    expect(artifactFor("s1")).toEqual(KB_DOC);
  });

  it("is a no-op on a tab that never had a panel", () => {
    togglePanel("s1");
    expect(artifactFor("s1")).toBeNull();
    expect(getPanelsRecord()).toEqual({});
  });

  it("is a no-op with no active tab", () => {
    expect(() => togglePanel(null)).not.toThrow();
    expect(getPanelsRecord()).toEqual({});
  });

  it("memory is PER TAB — one tab's toggle never reopens another's artifact", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s2", REPO_FILE);
    closePanel("s1");
    closePanel("s2");
    togglePanel("s1");
    expect(artifactFor("s1")).toEqual(KB_DOC);
    expect(artifactFor("s2")).toBeNull();
  });

  it("closing the TAB forgets the memory (no resurrection on a reused id)", () => {
    openInPanel("s1", KB_DOC);
    closePanel("s1");
    removeSessionPanel("s1");
    togglePanel("s1");
    expect(artifactFor("s1")).toBeNull();
  });

  it("closing a tab with the panel still OPEN also forgets it", () => {
    openInPanel("s1", KB_DOC);
    removeSessionPanel("s1");
    expect(artifactFor("s1")).toBeNull();
    togglePanel("s1");
    expect(artifactFor("s1")).toBeNull();
  });

  it("the memory is NOT persisted (workspace v3 holds only what is OPEN)", () => {
    openInPanel("s1", KB_DOC);
    closePanel("s1");
    expect(getPanelsRecord()).toEqual({});
  });

  it("a restart starts with no memory to reopen", () => {
    openInPanel("s1", KB_DOC);
    closePanel("s1");
    // Same process: the memory is still there (that IS the toggle).
    togglePanel("s1");
    expect(artifactFor("s1")).toEqual(KB_DOC);
    // A real restart is a fresh module — nothing carried over.
    __resetPanelStoreForTests();
    initPanelStore({}, DEFAULT_PANEL_WIDTH);
    togglePanel("s1");
    expect(artifactFor("s1")).toBeNull();
  });
});

describe("panelToggleAvailableFor (status-bar chip gate)", () => {
  it("false with no tab, no panel and no memory", () => {
    expect(panelToggleAvailableFor(null)).toBe(false);
    expect(panelToggleAvailableFor("s1")).toBe(false);
  });

  it("true while a panel is open", () => {
    openInPanel("s1", KB_DOC);
    expect(panelToggleAvailableFor("s1")).toBe(true);
  });

  it("stays true after closing (the chord can reopen)", () => {
    openInPanel("s1", KB_DOC);
    closePanel("s1");
    expect(panelToggleAvailableFor("s1")).toBe(true);
  });

  it("false again once the tab is gone", () => {
    openInPanel("s1", KB_DOC);
    closePanel("s1");
    removeSessionPanel("s1");
    expect(panelToggleAvailableFor("s1")).toBe(false);
  });

  it("is per tab", () => {
    openInPanel("s1", KB_DOC);
    expect(panelToggleAvailableFor("s2")).toBe(false);
  });
});

// ─── A5: create-path panel inheritance (closes the seam-1 context gap) ───────

describe("inheritPanel (a new thread inherits the panel it was launched from)", () => {
  it("the new tab really shows the artifact the source tab showed", () => {
    publishActiveTabSession("s1");
    openInPanel("s1", KB_DOC);
    // Captured BEFORE the create (the active tab flips as soon as it exists).
    const captured = activeTabArtifact();
    publishActiveTabSession("s2"); // the new tab is now active
    expect(inheritPanel(captured, "s2")).toBe(true);
    expect(artifactFor("s2")).toEqual(KB_DOC);
    // …which is exactly what resolveSpawnContext reads, so the flag's
    // "panel shows X" is a fact about s2, not a claim about a closed panel.
    expect(activeTabArtifact()).toEqual(KB_DOC);
  });

  it("the source tab keeps its own panel (a copy, not a move)", () => {
    openInPanel("s1", REPO_FILE);
    inheritPanel(artifactFor("s1"), "s2");
    expect(artifactFor("s1")).toEqual(REPO_FILE);
    expect(artifactFor("s2")).toEqual(REPO_FILE);
  });

  it("the inherited panel is INDEPENDENTLY closable", () => {
    openInPanel("s1", KB_DOC);
    inheritPanel(artifactFor("s1"), "s2");
    closePanel("s2");
    expect(artifactFor("s2")).toBeNull();
    expect(artifactFor("s1")).toEqual(KB_DOC);
    // …and it is a normal panel: the chord reopens it like any other.
    togglePanel("s2");
    expect(artifactFor("s2")).toEqual(KB_DOC);
  });

  it("nothing open → the new thread starts clean (no flag, no claim)", () => {
    publishActiveTabSession("s1");
    expect(inheritPanel(activeTabArtifact(), "s2")).toBe(false);
    expect(artifactFor("s2")).toBeNull();
    expect(getPanelsRecord()).toEqual({});
  });

  it("an empty target session id is a no-op (create failed before an id existed)", () => {
    openInPanel("s1", KB_DOC);
    expect(inheritPanel(KB_DOC, "")).toBe(false);
    expect(getPanelsRecord()).toEqual({ s1: KB_DOC });
  });

  it("inherits through the same lean gate as any other open", () => {
    const decorated = { ...KB_DOC, scroll: 900, junk: true } as unknown as Artifact;
    expect(inheritPanel(decorated, "s2")).toBe(true);
    expect(artifactFor("s2")).toEqual(KB_DOC);
  });

  it("the inherited binding persists with the workspace like any other (criterion 5)", () => {
    openInPanel("s1", KB_DOC);
    inheritPanel(artifactFor("s1"), "s2");
    expect(getPanelsRecord()).toEqual({ s1: KB_DOC, s2: KB_DOC });
  });
});
