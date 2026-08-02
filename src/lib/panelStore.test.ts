import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Artifact, PanelState, Thread } from "../types";
import {
  // pure helpers
  clampPanelWidth,
  sanitizeArtifact,
  sanitizePanelState,
  parsePanels,
  parsePanelsV3,
  parsePanelWidth,
  serializePanels,
  remapPanels,
  // 2026-08-02: icon vocabulary + `+` picker request
  FILE_ICON,
  FOLDER_ICON,
  FOLDER_OPEN_ICON,
  PANEL_ICON,
  folderIcon,
  openArtifactPicker,
  closeArtifactPicker,
  artifactPickerOpenFor,
  // increment B: pure strip ops
  sameArtifact,
  indexOfArtifact,
  clampActiveIndex,
  artifactShortTitle,
  appendOrActivate,
  closeArtifactIn,
  // increment F: pop-out to the floating window
  setPoppedOutArtifact,
  clearPoppedOutArtifact,
  getPoppedOutArtifact,
  poppedOutIdentity,
  popOutArtifact,
  popOutAvailable,
  subscribeToPanelStore,
  registerPanelActions,
  // store
  initPanelStore,
  openInPanel,
  closePanel,
  closeArtifactAt,
  isLocalhostUrlOpen,
  activateArtifact,
  panelStateFor,
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
  shellVisibleWidthFor,
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
// The pins-store convergence check at the bottom: two artifacts from ONE
// folder, open in two different tabs, must still be ONE sidecar record.
import {
  configurePinsIO,
  getPinsFile,
  mutatePins,
  subscribeToPins,
  __resetPinsStoreForTests,
} from "./pinsStore";
import { addPin, docFileName, pinsForDoc, sidecarPathFor } from "./pins";
import type { Pin } from "./pins";

const KB_DOC: Artifact = { kind: "kb-doc", path: "switchboard/features/artifact-panel/requirements.md" };
const REPO_FILE: Artifact = { kind: "repo-file", project: "switchboard", path: "src/App.tsx" };

/** A one-tab strip — the shape a v3 artifact migrates into and the shape a
 *  first open produces. */
const one = (artifact: Artifact): PanelState => ({ artifacts: [artifact], activeIndex: 0 });

/** An n-tab strip with an explicit active index. */
const strip = (artifacts: Artifact[], activeIndex = 0): PanelState => ({ artifacts, activeIndex });

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

describe("sanitizePanelState (strip invariants at every load path)", () => {
  it("keeps a well-formed strip and its active index", () => {
    expect(sanitizePanelState(strip([KB_DOC, REPO_FILE], 1))).toEqual(strip([KB_DOC, REPO_FILE], 1));
  });

  it("drops malformed artifacts INDIVIDUALLY and re-points the active tab by CONTENT", () => {
    const state = sanitizePanelState({
      artifacts: [{ kind: "nope" }, KB_DOC, null, REPO_FILE],
      activeIndex: 3, // REPO_FILE — index 1 after the junk is dropped
    });
    expect(state).toEqual(strip([KB_DOC, REPO_FILE], 1));
  });

  it("collapses duplicates on load (the dedupe invariant is not just a live rule)", () => {
    expect(sanitizePanelState({ artifacts: [KB_DOC, { ...KB_DOC }, REPO_FILE], activeIndex: 1 }))
      .toEqual(strip([KB_DOC, REPO_FILE], 0));
  });

  it("an out-of-range / junk activeIndex FALLS BACK to the first tab, entry kept", () => {
    // Not "clamped to the nearest valid index": the active tab is preserved by
    // CONTENT, and index 9 names no content, so there is nothing to clamp
    // toward — tab 0 is the honest answer, and 9 → 1 would be a guess.
    expect(sanitizePanelState(strip([KB_DOC, REPO_FILE], 9))).toEqual(strip([KB_DOC, REPO_FILE], 0));
    expect(sanitizePanelState(strip([KB_DOC, REPO_FILE], -4))).toEqual(strip([KB_DOC, REPO_FILE], 0));
    expect(
      sanitizePanelState({ artifacts: [KB_DOC, REPO_FILE], activeIndex: "1" })
    ).toEqual(strip([KB_DOC, REPO_FILE], 0));
    expect(sanitizePanelState({ artifacts: [KB_DOC, REPO_FILE] })).toEqual(
      strip([KB_DOC, REPO_FILE], 0)
    );
  });

  it("an EMPTY (or all-junk) strip is dropped — a panel showing nothing is no panel", () => {
    expect(sanitizePanelState({ artifacts: [], activeIndex: 0 })).toBeNull();
    expect(sanitizePanelState({ artifacts: [{ kind: "nope" }], activeIndex: 0 })).toBeNull();
  });

  it("rejects non-strip shapes, including a bare v3 Artifact", () => {
    expect(sanitizePanelState(KB_DOC)).toBeNull();
    expect(sanitizePanelState(null)).toBeNull();
    expect(sanitizePanelState([KB_DOC])).toBeNull();
    expect(sanitizePanelState({ artifacts: "kb" })).toBeNull();
  });

  it("keeps only the schema fields of each artifact (lean invariant)", () => {
    const state = sanitizePanelState({
      artifacts: [{ ...KB_DOC, scrollTop: 400, title: "cached" }],
      activeIndex: 0,
    })!;
    expect(state.artifacts[0]).toEqual(KB_DOC);
    expect("scrollTop" in state.artifacts[0]).toBe(false);
  });
});

describe("parsePanels / serializePanels", () => {
  it("round-trips through the workspace blob shape", () => {
    const record = { "sess-1": strip([KB_DOC, REPO_FILE], 1), "sess-2": one(REPO_FILE) };
    const parsed = parsePanels(JSON.parse(JSON.stringify(record)));
    expect(parsed).toEqual(record);
    expect(serializePanels(new Map(Object.entries(parsed)))).toEqual(record);
  });

  it("drops unknown fields on the way in AND out", () => {
    const parsed = parsePanels({
      "sess-1": { artifacts: [{ ...KB_DOC, note: "junk", pins: [1, 2] }], activeIndex: 0 },
    });
    expect(parsed["sess-1"]).toEqual(one(KB_DOC));
    const out = serializePanels(
      new Map([["sess-1", one({ ...KB_DOC, note: "junk" } as unknown as Artifact)]])
    );
    expect(out["sess-1"]).toEqual(one(KB_DOC));
    expect("note" in out["sess-1"].artifacts[0]).toBe(false);
  });

  it("skips malformed entries INDIVIDUALLY (a broken one must not eat the rest)", () => {
    const parsed = parsePanels({
      "sess-1": one(KB_DOC),
      "sess-2": { artifacts: [{ kind: "nope" }], activeIndex: 0 },
      "sess-3": null,
      "sess-4": KB_DOC, // a bare v3 artifact in a v4 blob is CORRUPT, not old
      "": one(KB_DOC), // empty key
      "sess-5": one(REPO_FILE),
    });
    expect(parsed).toEqual({ "sess-1": one(KB_DOC), "sess-5": one(REPO_FILE) });
  });

  it("non-object input → empty record", () => {
    expect(parsePanels(undefined)).toEqual({});
    expect(parsePanels(null)).toEqual({});
    expect(parsePanels("panels")).toEqual({});
    expect(parsePanels([one(KB_DOC)])).toEqual({});
  });

  it("serializePanels drops empty keys", () => {
    expect(serializePanels(new Map([["", one(KB_DOC)]]))).toEqual({});
  });
});

describe("parsePanelsV3 (a v3 artifact becomes a one-tab strip)", () => {
  it("wraps each entry, lossless and additive", () => {
    expect(parsePanelsV3({ "sess-1": KB_DOC, "sess-2": REPO_FILE })).toEqual({
      "sess-1": one(KB_DOC),
      "sess-2": one(REPO_FILE),
    });
  });

  it("keeps the tolerant per-entry posture (junk drops alone)", () => {
    expect(
      parsePanelsV3({ "sess-1": KB_DOC, "sess-2": { kind: "nope" }, "": KB_DOC, "sess-3": null })
    ).toEqual({ "sess-1": one(KB_DOC) });
    expect(parsePanelsV3("nope")).toEqual({});
  });
});

// ─── Workspace v1/v2/v3/v4 → v4 migration (panel half) ───────────────────────

describe("migrateSavedWorkspace (panels)", () => {
  it("v1 → v4: sessions/layout/counter preserved, panels default {} + default width", () => {
    const raw = mkWorkspaceV1();
    const ws = migrateSavedWorkspace(raw)!;
    expect(ws.version).toBe(4);
    expect(ws.sessions).toEqual(raw.sessions);
    expect(ws.paneLayout).toEqual(raw.paneLayout);
    expect(ws.activeSessionId).toBe("s1");
    expect(ws.focusedPaneId).toBe("pane-1");
    expect(ws.sessionCounter).toBe(3);
    expect(ws.threads).toEqual([]);
    expect(ws.panels).toEqual({});
    expect(ws.panelWidth).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("v2 → v4 is LOSSLESS for sessions AND threads, panels default {}", () => {
    const t = mkThread({ sessionId: "s1" });
    const raw = mkWorkspaceV1({ version: 2, threads: [t] });
    const ws = migrateSavedWorkspace(raw)!;
    expect(ws.version).toBe(4);
    expect(ws.sessions).toEqual(raw.sessions);
    expect(ws.threads).toEqual([t]);
    expect(ws.panels).toEqual({});
    expect(ws.panelWidth).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("a stray panels field on a PRE-v3 blob is ignored (the version gates it)", () => {
    const ws = migrateSavedWorkspace(mkWorkspaceV1({ version: 2, panels: { "s1": KB_DOC } }))!;
    expect(ws.panels).toEqual({});
  });

  it("v3 → v4 is ADDITIVE and LOSSLESS: each artifact becomes a one-tab strip", () => {
    const raw = mkWorkspaceV1({
      version: 3,
      threads: [mkThread({ sessionId: "s1" })],
      panels: { "s1": { ...KB_DOC, junk: 1 }, "s2": { kind: "broken" }, "s3": REPO_FILE },
      panelWidth: 500,
    });
    const ws = migrateSavedWorkspace(raw)!;
    expect(ws.version).toBe(4);
    expect(ws.sessions).toEqual(raw.sessions); // v3's other halves untouched
    expect(ws.threads).toHaveLength(1);
    expect(ws.panels).toEqual({ "s1": one(KB_DOC), "s3": one(REPO_FILE) });
    expect(ws.panelWidth).toBe(500);
  });

  it("v4 round-trip: strips tolerant-parsed, width clamped", () => {
    const raw = mkWorkspaceV1({
      version: 4,
      threads: [],
      panels: {
        "s1": { artifacts: [{ ...KB_DOC, junk: 1 }, REPO_FILE], activeIndex: 1 },
        "s2": { artifacts: [{ kind: "broken" }], activeIndex: 0 },
        "s3": one(REPO_FILE),
      },
      panelWidth: 5000,
    });
    const ws = migrateSavedWorkspace(raw)!;
    expect(ws.version).toBe(4);
    expect(ws.panels).toEqual({ "s1": strip([KB_DOC, REPO_FILE], 1), "s3": one(REPO_FILE) });
    expect(ws.panelWidth).toBe(MAX_PANEL_WIDTH);
  });

  it("a garbage panels blob degrades to {} rather than rejecting the workspace", () => {
    for (const version of [3, 4]) {
      const ws = migrateSavedWorkspace(mkWorkspaceV1({ version, panels: "nope" }))!;
      expect(ws).not.toBeNull();
      expect(ws.sessions).toHaveLength(1);
      expect(ws.panels).toEqual({});
    }
  });

  it("unknown versions are still rejected outright", () => {
    expect(migrateSavedWorkspace(mkWorkspaceV1({ version: 5 }))).toBeNull();
    expect(migrateSavedWorkspace(mkWorkspaceV1({ version: "4" }))).toBeNull();
  });
});

// ─── Staleness: panels expire WITH their sessions ────────────────────────────

describe("applyWorkspaceStaleness (panels)", () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  it("fresh workspace keeps its panels untouched", () => {
    const ws = migrateSavedWorkspace(
      mkWorkspaceV1({ version: 4, panels: { "s1": strip([KB_DOC, REPO_FILE], 1) }, panelWidth: 500 })
    )!;
    expect(applyWorkspaceStaleness(ws, ws.savedAt + WEEK, WEEK)).toBe(ws);
  });

  it("expired sessions take their PANELS with them — threads survive", () => {
    const t = mkThread({ sessionId: "s1" });
    const ws = migrateSavedWorkspace(
      mkWorkspaceV1({ version: 4, threads: [t], panels: { "s1": one(KB_DOC) }, panelWidth: 500 })
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
  it("full map: every binding follows its session to the new id, strip intact", () => {
    const out = remapPanels(
      { "old-1": strip([KB_DOC, REPO_FILE], 1), "old-2": one(REPO_FILE) },
      new Map([
        ["old-1", "new-1"],
        ["old-2", "new-2"],
      ])
    );
    expect(out).toEqual({ "new-1": strip([KB_DOC, REPO_FILE], 1), "new-2": one(REPO_FILE) });
  });

  it("PARTIAL map: orphans are DROPPED (unlike threads, which are severed)", () => {
    const out = remapPanels(
      { "old-1": one(KB_DOC), "old-2": one(REPO_FILE) },
      new Map([["old-1", "new-1"]])
    );
    expect(out).toEqual({ "new-1": one(KB_DOC) });
    expect("old-2" in out).toBe(false);
  });

  it("empty map (fresh start / all restores failed) drops everything", () => {
    expect(remapPanels({ "old-1": one(KB_DOC) }, new Map())).toEqual({});
  });
});

describe("remapPanelSessions (store)", () => {
  it("rewrites live keys and drops the unmapped ones", () => {
    initPanelStore({ "old-1": strip([KB_DOC, REPO_FILE], 1), "old-2": one(REPO_FILE) });
    remapPanelSessions(new Map([["old-1", "new-1"]]));
    expect(artifactFor("new-1")).toEqual(REPO_FILE); // the ACTIVE tab came back active
    expect(panelStateFor("new-1")).toEqual(strip([KB_DOC, REPO_FILE], 1));
    expect(artifactFor("old-1")).toBeNull();
    expect(artifactFor("old-2")).toBeNull();
    expect(getPanelsRecord()).toEqual({ "new-1": strip([KB_DOC, REPO_FILE], 1) });
  });

  it("empty map clears every binding but keeps the global width", () => {
    initPanelStore({ "old-1": one(KB_DOC) }, 500);
    remapPanelSessions(new Map());
    expect(getPanelsRecord()).toEqual({});
    expect(getPanelWidth()).toBe(500);
  });
});

// ─── Store behavior ──────────────────────────────────────────────────────────

describe("panel store", () => {
  it("open → artifactFor; opening ANOTHER appends a tab and activates it", () => {
    openInPanel("sess-1", KB_DOC);
    expect(artifactFor("sess-1")).toEqual(KB_DOC);
    openInPanel("sess-1", REPO_FILE);
    expect(artifactFor("sess-1")).toEqual(REPO_FILE);
    expect(panelStateFor("sess-1")).toEqual(strip([KB_DOC, REPO_FILE], 1));
    expect(getPanelsRecord()).toEqual({ "sess-1": strip([KB_DOC, REPO_FILE], 1) });
  });

  it("panels are PER-TAB — one tab's strip never leaks into another", () => {
    openInPanel("sess-1", KB_DOC);
    openInPanel("sess-2", REPO_FILE);
    expect(artifactFor("sess-1")).toEqual(KB_DOC);
    expect(artifactFor("sess-2")).toEqual(REPO_FILE);
    expect(artifactFor("sess-3")).toBeNull();
    expect(panelStateFor("sess-3")).toBeNull();
    expect(panelStateFor(null)).toBeNull();
  });

  it("open sanitizes at the gate and rejects junk / empty session ids", () => {
    openInPanel("sess-1", { ...KB_DOC, junk: true } as unknown as Artifact);
    expect(artifactFor("sess-1")).toEqual(KB_DOC);
    openInPanel("sess-2", { kind: "nope" } as unknown as Artifact);
    expect(artifactFor("sess-2")).toBeNull();
    openInPanel("", KB_DOC);
    expect(getPanelsRecord()).toEqual({ "sess-1": one(KB_DOC) });
  });

  it("close drops that tab's LAST artifact and with it the panel; twice is a no-op", () => {
    openInPanel("sess-1", KB_DOC);
    openInPanel("sess-2", REPO_FILE);
    closePanel("sess-1");
    expect(artifactFor("sess-1")).toBeNull();
    expect(artifactFor("sess-2")).toEqual(REPO_FILE);
    const view = getPanelsView();
    closePanel("sess-1"); // already closed — must not churn the snapshot
    expect(getPanelsView()).toBe(view);
  });

  it("tab close: removeSessionPanel drops the whole strip with the session", () => {
    openInPanel("sess-1", KB_DOC);
    openInPanel("sess-1", REPO_FILE);
    openInPanel("sess-2", REPO_FILE);
    removeSessionPanel("sess-1");
    expect(artifactFor("sess-1")).toBeNull();
    expect(getPanelsRecord()).toEqual({ "sess-2": one(REPO_FILE) });
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
      {
        "s1": { artifacts: [{ ...KB_DOC, junk: 1 }], activeIndex: 0 } as unknown as PanelState,
        "s2": { artifacts: [{ kind: "bad" }], activeIndex: 0 } as unknown as PanelState,
      },
      9999
    );
    expect(getPanelsRecord()).toEqual({ "s1": one(KB_DOC) });
    expect(getPanelWidth()).toBe(MAX_PANEL_WIDTH);

    initPanelStore({});
    expect(getPanelsRecord()).toEqual({});
    expect(getPanelWidth()).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("the view snapshot is stable between mutations (useSyncExternalStore contract)", () => {
    openInPanel("sess-1", KB_DOC);
    const v1 = getPanelsView();
    expect(getPanelsView()).toBe(v1);
    expect(v1.panels.get("sess-1")).toEqual(one(KB_DOC));
    openInPanel("sess-2", REPO_FILE);
    const v2 = getPanelsView();
    expect(v2).not.toBe(v1);
    expect(v1.panels.has("sess-2")).toBe(false); // old snapshot not mutated in place
    expect(v2.panels.size).toBe(2);
  });

  it("boot round-trip: store → workspace record → migrate → store (criterion 3)", () => {
    openInPanel("sess-1", KB_DOC);
    openInPanel("sess-1", REPO_FILE);
    openInPanel("sess-2", REPO_FILE);
    setPanelWidth(500);
    const blob = mkWorkspaceV1({
      version: 4,
      threads: [],
      panels: getPanelsRecord(),
      panelWidth: getPanelWidth(),
    });
    __resetPanelStoreForTests();
    const ws = migrateSavedWorkspace(JSON.parse(JSON.stringify(blob)))!;
    initPanelStore(ws.panels, ws.panelWidth);
    // WHICH artifacts and WHICH one is active both survive the restart.
    expect(panelStateFor("sess-1")).toEqual(strip([KB_DOC, REPO_FILE], 1));
    expect(artifactFor("sess-1")).toEqual(REPO_FILE);
    expect(panelStateFor("sess-2")).toEqual(one(REPO_FILE));
    expect(getPanelWidth()).toBe(500);
  });

  it("a v3 blob restores as one-tab strips, and the panel keeps working (upgrade path)", () => {
    const ws = migrateSavedWorkspace(
      mkWorkspaceV1({ version: 3, panels: { "sess-1": KB_DOC }, panelWidth: 480 })
    )!;
    initPanelStore(ws.panels, ws.panelWidth);
    expect(artifactFor("sess-1")).toEqual(KB_DOC);
    openInPanel("sess-1", REPO_FILE);
    expect(panelStateFor("sess-1")).toEqual(strip([KB_DOC, REPO_FILE], 1));
  });
});

// ─── Increment B: the pure strip operations ──────────────────────────────────

describe("strip identity helpers", () => {
  it("sameArtifact compares kind + project + path, not object identity", () => {
    expect(sameArtifact(KB_DOC, { ...KB_DOC })).toBe(true);
    expect(sameArtifact(KB_DOC, { kind: "kb-doc", path: "other.md" })).toBe(false);
    expect(sameArtifact(REPO_FILE, { ...REPO_FILE, project: "orbit" })).toBe(false);
    // The trap this rule exists for: the same relative path in two projects.
    expect(
      sameArtifact(
        { kind: "repo-file", project: "orbit", path: "src/App.tsx" },
        { kind: "repo-file", project: "switchboard", path: "src/App.tsx" }
      )
    ).toBe(false);
    // …and the same path under two KINDS.
    expect(sameArtifact({ kind: "kb-doc", path: "a/b.md" }, REPO_FILE)).toBe(false);
  });

  it("indexOfArtifact finds by content, -1 when absent", () => {
    expect(indexOfArtifact([KB_DOC, REPO_FILE], { ...REPO_FILE })).toBe(1);
    expect(indexOfArtifact([KB_DOC], REPO_FILE)).toBe(-1);
    expect(indexOfArtifact([], KB_DOC)).toBe(-1);
  });

  it("clampActiveIndex forces any input into range", () => {
    expect(clampActiveIndex(3, 5)).toBe(2);
    expect(clampActiveIndex(3, -1)).toBe(0);
    expect(clampActiveIndex(3, 1.7)).toBe(1);
    expect(clampActiveIndex(3, NaN)).toBe(0);
    expect(clampActiveIndex(0, 2)).toBe(0);
  });

  it("artifactShortTitle is the last path segment (what a 150px tab can show)", () => {
    expect(artifactShortTitle(KB_DOC)).toBe("requirements.md");
    expect(artifactShortTitle(REPO_FILE)).toBe("App.tsx");
    expect(artifactShortTitle({ kind: "kb-doc", path: "README.md" })).toBe("README.md");
    expect(artifactShortTitle({ kind: "kb-doc", path: "a//b.md" })).toBe("b.md");
    expect(
      artifactShortTitle({ kind: "localhost", project: "orbit", url: "http://localhost:5173" })
    ).toBe("localhost:5173");
  });
});

describe("appendOrActivate (acceptance 4 — one document, one live record)", () => {
  it("opens a panel when there is none", () => {
    expect(appendOrActivate(null, KB_DOC)).toEqual(one(KB_DOC));
  });

  it("appends a NEW artifact at the end and activates it", () => {
    expect(appendOrActivate(one(KB_DOC), REPO_FILE)).toEqual(strip([KB_DOC, REPO_FILE], 1));
  });

  it("an artifact already in the strip ACTIVATES its tab — no duplicate, no reorder", () => {
    const state = strip([KB_DOC, REPO_FILE], 1);
    const next = appendOrActivate(state, { ...KB_DOC });
    expect(next).toEqual(strip([KB_DOC, REPO_FILE], 0));
    expect(next.artifacts).toHaveLength(2);
  });

  it("re-opening the ALREADY ACTIVE artifact returns the same object (no churn)", () => {
    const state = strip([KB_DOC, REPO_FILE], 1);
    expect(appendOrActivate(state, { ...REPO_FILE })).toBe(state);
  });

  it("repeated opens of the same three docs never grow the strip past three", () => {
    let state: PanelState | null = null;
    for (const artifact of [KB_DOC, REPO_FILE, KB_DOC, { ...REPO_FILE }, KB_DOC]) {
      state = appendOrActivate(state, artifact);
    }
    expect(state!.artifacts).toHaveLength(2);
  });
});

describe("closeArtifactIn (`×` semantics)", () => {
  const THREE = [KB_DOC, REPO_FILE, { kind: "kb-doc", path: "x/y.md" } as Artifact];

  it("closing the LAST remaining tab returns null — the panel collapses", () => {
    expect(closeArtifactIn(one(KB_DOC), 0)).toBeNull();
  });

  it("closing a tab LEFT of the active one keeps the same content on screen", () => {
    const next = closeArtifactIn(strip(THREE, 2), 0)!;
    expect(next.artifacts).toEqual([THREE[1], THREE[2]]);
    expect(next.artifacts[next.activeIndex]).toEqual(THREE[2]);
  });

  it("closing a tab RIGHT of the active one leaves the active index alone", () => {
    expect(closeArtifactIn(strip(THREE, 0), 2)).toEqual(strip([THREE[0], THREE[1]], 0));
  });

  it("closing the ACTIVE tab activates its right neighbour", () => {
    const next = closeArtifactIn(strip(THREE, 1), 1)!;
    expect(next.artifacts[next.activeIndex]).toEqual(THREE[2]);
  });

  it("closing the ACTIVE RIGHTMOST tab activates the new last one", () => {
    const next = closeArtifactIn(strip(THREE, 2), 2)!;
    expect(next).toEqual(strip([THREE[0], THREE[1]], 1));
  });

  it("an out-of-range index changes NOTHING (never closes the wrong tab)", () => {
    const state = strip(THREE, 1);
    expect(closeArtifactIn(state, 3)).toBe(state);
    expect(closeArtifactIn(state, -1)).toBe(state);
    expect(closeArtifactIn(state, 1.5)).toBe(state);
  });

  it("closing every tab one at a time ends at null, never at an empty strip", () => {
    let state: PanelState | null = strip(THREE, 1);
    for (let i = 0; i < 3; i++) {
      expect(state).not.toBeNull();
      expect(state!.artifacts.length).toBe(3 - i);
      state = closeArtifactIn(state!, state!.activeIndex);
    }
    expect(state).toBeNull();
  });
});

// ─── Increment B: the strip through the store ────────────────────────────────

describe("multi-open, switching and × (acceptance 1 + 4)", () => {
  const THIRD: Artifact = { kind: "kb-doc", path: "switchboard/features/artifact-panel/mock.html" };

  it("several artifacts open in ONE session's panel, in open order", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    openInPanel("s1", THIRD);
    expect(panelStateFor("s1")).toEqual(strip([KB_DOC, REPO_FILE, THIRD], 2));
    expect(artifactFor("s1")).toEqual(THIRD);
  });

  it("re-opening an open artifact ACTIVATES its tab instead of duplicating it", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    openInPanel("s1", { ...KB_DOC }); // a different object, the same document
    expect(panelStateFor("s1")).toEqual(strip([KB_DOC, REPO_FILE], 0));
    expect(artifactFor("s1")).toEqual(KB_DOC);
  });

  it("activateArtifact switches tabs; out-of-range and no-op switches never churn", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    activateArtifact("s1", 0);
    expect(artifactFor("s1")).toEqual(KB_DOC);
    const view = getPanelsView();
    activateArtifact("s1", 0); // already active
    activateArtifact("s1", 7); // out of range
    activateArtifact("s1", -1);
    activateArtifact("nope", 0); // no such panel
    expect(getPanelsView()).toBe(view);
    expect(artifactFor("s1")).toEqual(KB_DOC);
  });

  it("× closes ONE tab and leaves the rest (acceptance 1)", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    openInPanel("s1", THIRD);
    closeArtifactAt("s1", 1);
    expect(panelStateFor("s1")).toEqual(strip([KB_DOC, THIRD], 1));
    expect(artifactFor("s1")).toEqual(THIRD);
  });

  it("closing the LAST tab collapses the panel entirely", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    closeArtifactAt("s1", 1);
    closeArtifactAt("s1", 0);
    expect(panelStateFor("s1")).toBeNull();
    expect(artifactFor("s1")).toBeNull();
    expect(getPanelsRecord()).toEqual({});
  });

  it("the header × closes the ACTIVE tab, not the strip", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    activateArtifact("s1", 0);
    closePanel("s1");
    expect(panelStateFor("s1")).toEqual(one(REPO_FILE));
  });

  it("closeArtifactAt on an unknown session or a bad index is inert", () => {
    openInPanel("s1", KB_DOC);
    const view = getPanelsView();
    closeArtifactAt("nope", 0);
    closeArtifactAt("s1", 4);
    expect(getPanelsView()).toBe(view);
    expect(artifactFor("s1")).toEqual(KB_DOC);
  });

  it("each tab keeps its OWN strip (per-TAB scope survives multi-open)", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    openInPanel("s2", THIRD);
    expect(panelStateFor("s1")).toEqual(strip([KB_DOC, REPO_FILE], 1));
    expect(panelStateFor("s2")).toEqual(one(THIRD));
    closeArtifactAt("s2", 0);
    expect(panelStateFor("s1")).toEqual(strip([KB_DOC, REPO_FILE], 1));
  });

  it("the whole strip persists per session (acceptance 3's source)", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    activateArtifact("s1", 0);
    openInPanel("s2", THIRD);
    expect(getPanelsRecord()).toEqual({
      s1: strip([KB_DOC, REPO_FILE], 0),
      s2: one(THIRD),
    });
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

  it("an overlay NEVER covers the whole shell — it reserves the terminal floor", () => {
    // The recorded regression: this used to cap at the container width, so a
    // 960px stored width on an 879px workspace hid the terminal completely —
    // inverting the "overlays RATHER THAN crushing" safeguard.
    const layout = panelLayoutFor(OVERLAY_BREAKPOINT - 1, MAX_PANEL_WIDTH);
    expect(layout).toEqual({
      mode: "overlay",
      width: OVERLAY_BREAKPOINT - 1 - MIN_TERMINAL_WIDTH,
    });
    expect(shellVisibleWidthFor(OVERLAY_BREAKPOINT - 1, layout)).toBe(MIN_TERMINAL_WIDTH);
  });

  it("crossing the breakpoint changes the MODE, not whether the shell is visible", () => {
    const docked = panelLayoutFor(OVERLAY_BREAKPOINT, MAX_PANEL_WIDTH);
    const overlaid = panelLayoutFor(OVERLAY_BREAKPOINT - 1, MAX_PANEL_WIDTH);
    expect(docked.mode).toBe("docked");
    expect(overlaid.mode).toBe("overlay");
    // 880 → 320 visible, 879 → 320 visible. Pre-fix this step was 320 → 0.
    expect(shellVisibleWidthFor(OVERLAY_BREAKPOINT, docked)).toBe(MIN_TERMINAL_WIDTH);
    expect(shellVisibleWidthFor(OVERLAY_BREAKPOINT - 1, overlaid)).toBe(MIN_TERMINAL_WIDTH);
  });

  it("on a container too small for both, the PANEL keeps its floor and the peek shrinks", () => {
    // 300px of workspace cannot hold 260 + 320. The panel stays readable and
    // a strip of shell survives — never zero, which is the actual invariant.
    const layout = panelLayoutFor(300, 420);
    expect(layout).toEqual({ mode: "overlay", width: MIN_PANEL_WIDTH });
    expect(shellVisibleWidthFor(300, layout)).toBe(40);
    expect(shellVisibleWidthFor(300, layout)).toBeGreaterThan(0);
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
        // …and the assertion that actually catches an occluding overlay:
        // paneTreeWidthFor reports LAYOUT space, which an overlay never takes,
        // so on its own it cannot tell a floating panel from a covered shell.
        // Every cell here can afford both floors, so every cell must keep a
        // real, VISIBLE shell.
        expect(container).toBeGreaterThanOrEqual(MIN_PANEL_WIDTH + MIN_TERMINAL_WIDTH);
        expect(shellVisibleWidthFor(container, layout)).toBeGreaterThanOrEqual(
          MIN_TERMINAL_WIDTH
        );
      });
    }
  }

  it("the specific cell the reviewer computed: row 1100, sidebar full", () => {
    const container = workspaceWidth(1100, "full"); // 820
    const layout = panelLayoutFor(container, MAX_PANEL_WIDTH);
    // 820 < 880 → the panel floats rather than leaving the shell 36px…
    expect(layout).toEqual({ mode: "overlay", width: 820 - MIN_TERMINAL_WIDTH });
    // …the pane tree keeps its full layout width (nothing was taken from it)…
    expect(paneTreeWidthFor(container, layout)).toBe(820);
    // …and 320px of it is genuinely on screen, not under the panel.
    expect(shellVisibleWidthFor(container, layout)).toBe(MIN_TERMINAL_WIDTH);
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

  it("panelIdentityFor names the ACTIVE tab, empty string when there is no panel", () => {
    expect(panelIdentityFor(null)).toBe("");
    expect(panelIdentityFor("sess-1")).toBe("");
    openInPanel("sess-1", KB_DOC);
    expect(panelIdentityFor("sess-1")).toBe(artifactIdentity(KB_DOC));
    openInPanel("sess-1", REPO_FILE);
    expect(panelIdentityFor("sess-1")).toBe(artifactIdentity(REPO_FILE));
    // Closing the active tab moves the identity to what is now on screen —
    // which is exactly what the boundary reset key must follow.
    closePanel("sess-1");
    expect(panelIdentityFor("sess-1")).toBe(artifactIdentity(KB_DOC));
    closePanel("sess-1");
    expect(panelIdentityFor("sess-1")).toBe("");
  });

  it("switching tabs changes the identity (the reset key follows the body)", () => {
    openInPanel("sess-1", KB_DOC);
    openInPanel("sess-1", REPO_FILE);
    expect(panelIdentityFor("sess-1")).toBe(artifactIdentity(REPO_FILE));
    activateArtifact("sess-1", 0);
    expect(panelIdentityFor("sess-1")).toBe(artifactIdentity(KB_DOC));
  });
});

// ─── A2: header presentation ─────────────────────────────────────────────────

describe("describeArtifact (icon + breadcrumb)", () => {
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

});

// ─── Tree/panel ICONS (2026-08-02 — the geometric glyphs are gone) ──────────

describe("icon vocabulary (folder vs file, one language for three surfaces)", () => {
  // The glyph set (◧ ◆ ◈ ◇ ▪ ▫ ■) and its cmap guard were REMOVED with this
  // change, not merely superseded: unicode geometric shapes cannot express
  // folder/file semantics at 9-11px, and their ink sits at different offsets
  // inside the identical mono cell (the misalignment Eric reported). The
  // vocabulary is now icon NAMES here + hand-written SVG paths in
  // components/icons.tsx, where `Record<IconName, ReactNode>` makes "a name
  // with no drawing" a type error rather than something a test has to catch.

  it("gives EVERY openable artifact the one file icon", () => {
    // Eric, on the running app: "just use a folder icon and then a file icon
    // instead of a dot for each file". Kind-awareness (markdown vs wireframe
    // vs code vs data) was the thing being read as dots — the picker still
    // prints docKind as TEXT, where it is legible.
    expect(describeArtifact(KB_DOC).icon).toBe(FILE_ICON);
    expect(describeArtifact(REPO_FILE).icon).toBe(FILE_ICON);
  });

  it("keeps localhost distinguishable — it is not a file", () => {
    const d = describeArtifact({ kind: "localhost", project: "p", url: "http://localhost:1" });
    expect(d.icon).not.toBe(FILE_ICON);
    expect(d.icon).not.toBe(FOLDER_ICON);
  });

  it("never collides a folder icon with the file icon, in either state", () => {
    expect(FOLDER_ICON).not.toBe(FILE_ICON);
    expect(FOLDER_OPEN_ICON).not.toBe(FILE_ICON);
    expect(FOLDER_OPEN_ICON).not.toBe(FOLDER_ICON);
  });

  it("folderIcon follows the row's expander state", () => {
    expect(folderIcon(true)).toBe(FOLDER_OPEN_ICON);
    expect(folderIcon(false)).toBe(FOLDER_ICON);
  });

  it("the panel button's icon is the panel's own, not a folder's", () => {
    // Eric: "the icon used for a folder should probably be for the panel".
    expect(PANEL_ICON).not.toBe(FOLDER_ICON);
    expect(PANEL_ICON).not.toBe(FILE_ICON);
  });
});

// ─── The `+` picker request (the tab-bar panel button's empty state) ─────────

describe("artifact picker request", () => {
  it("is closed by default and scoped to ONE tab", () => {
    expect(artifactPickerOpenFor("s1")).toBe(false);
    openArtifactPicker("s1");
    expect(artifactPickerOpenFor("s1")).toBe(true);
    // Another tab must not inherit an open modal.
    expect(artifactPickerOpenFor("s2")).toBe(false);
    expect(artifactPickerOpenFor(null)).toBe(false);
  });

  it("only ONE tab can be asking at a time", () => {
    openArtifactPicker("s1");
    openArtifactPicker("s2");
    expect(artifactPickerOpenFor("s1")).toBe(false);
    expect(artifactPickerOpenFor("s2")).toBe(true);
  });

  it("closes on a completed pick — including one that changes nothing", () => {
    openInPanel("s1", KB_DOC);
    openArtifactPicker("s1");
    // Re-picking the ALREADY ACTIVE artifact is openInPanel's no-op branch.
    // The modal must still go away; that is why the store owns dismissal.
    openInPanel("s1", KB_DOC);
    expect(artifactPickerOpenFor("s1")).toBe(false);
  });

  it("closes when the tab it belongs to is destroyed", () => {
    openInPanel("s1", KB_DOC);
    openArtifactPicker("s1");
    removeSessionPanel("s1");
    expect(artifactPickerOpenFor("s1")).toBe(false);
  });

  it("survives the panel being hidden — the request is not the panel", () => {
    // Ctrl+Shift+P while the picker is open leaves an empty panel; the picker
    // is a fixed-position overlay and ArtifactPanel still hosts it.
    openInPanel("s1", KB_DOC);
    openArtifactPicker("s1");
    togglePanel("s1");
    expect(panelStateFor("s1")).toBeNull();
    expect(artifactPickerOpenFor("s1")).toBe(true);
  });

  it("closing is idempotent", () => {
    openArtifactPicker("s1");
    closeArtifactPicker();
    closeArtifactPicker();
    expect(artifactPickerOpenFor("s1")).toBe(false);
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

  it("opening a second artifact ADDS a tab and shows it (increment B)", () => {
    publishActiveTabSession("s1");
    openArtifact(OPEN_DOC);
    openArtifact(OPEN_FILE);
    expect(artifactFor("s1")).toEqual(OPEN_FILE);
    expect(panelStateFor("s1")).toEqual(strip([OPEN_DOC, OPEN_FILE], 1));
  });

  it("a tree click on an ALREADY-OPEN doc activates its tab (acceptance 4, real path)", () => {
    publishActiveTabSession("s1");
    openArtifact(OPEN_DOC);
    openArtifact(OPEN_FILE);
    const decision = openArtifact({ ...OPEN_DOC });
    expect(decision.action).toBe("panel");
    expect(panelStateFor("s1")).toEqual(strip([OPEN_DOC, OPEN_FILE], 0));
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
    expect(getPanelsRecord()).toEqual({ s1: one(OPEN_DOC) });
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

// ─── A3/B: Ctrl+Shift+P true toggle (per-tab last-PanelState memory) ───────

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

  it("the memory is NOT persisted (workspace v4 holds only what is OPEN)", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    togglePanel("s1"); // the whole strip is remembered…
    expect(getPanelsRecord()).toEqual({}); // …and none of it is in the blob
    expect(getPanelsView().panels.size).toBe(0);
  });

  it("the chord hides the WHOLE strip and brings it ALL back, active tab included", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    activateArtifact("s1", 0);
    togglePanel("s1");
    expect(panelStateFor("s1")).toBeNull();
    togglePanel("s1");
    expect(panelStateFor("s1")).toEqual(strip([KB_DOC, REPO_FILE], 0));
  });

  it("closing tabs one by one and then toggling brings back only what was left", () => {
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    closeArtifactAt("s1", 0); // KB_DOC dismissed by hand
    closeArtifactAt("s1", 0); // the last one — panel collapses
    togglePanel("s1");
    expect(panelStateFor("s1")).toEqual(one(REPO_FILE));
  });

  // ── Regression: a HIDDEN strip must not be silently discarded ─────────────
  // The loss this suite's widened memory exists to prevent, reached through
  // the OPEN path instead of the chord:
  //   open A,B,C → Ctrl+Shift+P → click D in the tree → panel showed ONLY D
  //   → Ctrl+Shift+P filed {[D],0} OVER {[A,B,C],2} → A,B,C unreachable.
  // openInPanel read `panels` alone, and a hidden panel does not live there.
  const A = KB_DOC;
  const B = REPO_FILE;
  const C: Artifact = { kind: "kb-doc", path: "switchboard/features/artifact-panel/architecture.md" };
  const D: Artifact = { kind: "repo-file", project: "switchboard", path: "src/lib/panelStore.ts" };

  it("opening into a HIDDEN panel revives its strip instead of replacing it", () => {
    openInPanel("s1", A);
    openInPanel("s1", B);
    openInPanel("s1", C);
    expect(panelStateFor("s1")).toEqual(strip([A, B, C], 2));

    togglePanel("s1"); // hidden — the strip now lives only in the memory
    expect(panelStateFor("s1")).toBeNull();

    openInPanel("s1", D); // a click in the side-menu tree
    // The panel comes back with ALL FOUR, D active — not a fresh [D].
    expect(panelStateFor("s1")).toEqual(strip([A, B, C, D], 3));
  });

  it("…and the next hide/show round-trips all four, the old memory gone", () => {
    openInPanel("s1", A);
    openInPanel("s1", B);
    openInPanel("s1", C);
    togglePanel("s1");
    openInPanel("s1", D);

    togglePanel("s1"); // hide: files {[A,B,C,D],3}, NOT {[D],0}
    expect(panelStateFor("s1")).toBeNull();
    togglePanel("s1"); // show
    expect(panelStateFor("s1")).toEqual(strip([A, B, C, D], 3));
  });

  it("re-opening an ALREADY-OPEN tab of a hidden strip brings the panel back", () => {
    openInPanel("s1", A);
    openInPanel("s1", B);
    togglePanel("s1");
    // B is already the active tab of the hidden strip — appendOrActivate
    // returns the same object, which must NOT be read as "nothing to do".
    openInPanel("s1", B);
    expect(panelStateFor("s1")).toEqual(strip([A, B], 1));
  });

  it("re-opening a NON-active tab of a hidden strip activates it, no duplicate", () => {
    openInPanel("s1", A);
    openInPanel("s1", B);
    togglePanel("s1");
    openInPanel("s1", A);
    expect(panelStateFor("s1")).toEqual(strip([A, B], 0));
  });

  it("a revived strip leaves NO stale memory behind (chip gate stays honest)", () => {
    openInPanel("s1", A);
    togglePanel("s1");
    openInPanel("s1", B);
    // Panel is live, so the chord hides it…
    togglePanel("s1");
    expect(panelStateFor("s1")).toBeNull();
    // …and what comes back is the revived strip, never the pre-revive copy.
    togglePanel("s1");
    expect(panelStateFor("s1")).toEqual(strip([A, B], 1));
  });

  it("inheritPanel into a tab with a hidden panel appends rather than replacing", () => {
    openInPanel("s1", A);
    openInPanel("s1", B);
    togglePanel("s1");
    // Same store path (inheritPanel → openInPanel), so it must not be the
    // one caller that quietly drops the hidden strip.
    expect(inheritPanel(C, "s1")).toBe(true);
    expect(panelStateFor("s1")).toEqual(strip([A, B, C], 2));
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
    expect(getPanelsRecord()).toEqual({ s1: one(KB_DOC) });
  });

  it("inherits the ACTIVE artifact ONLY, never the whole strip (increment B)", () => {
    publishActiveTabSession("s1");
    openInPanel("s1", KB_DOC);
    openInPanel("s1", REPO_FILE);
    activateArtifact("s1", 0);
    expect(inheritPanel(activeTabArtifact(), "s2")).toBe(true);
    // The new thread starts on the doc he was LOOKING at — one tab, not two.
    expect(panelStateFor("s2")).toEqual(one(KB_DOC));
    expect(panelStateFor("s1")).toEqual(strip([KB_DOC, REPO_FILE], 0));
  });

  it("inherits through the same lean gate as any other open", () => {
    const decorated = { ...KB_DOC, scroll: 900, junk: true } as unknown as Artifact;
    expect(inheritPanel(decorated, "s2")).toBe(true);
    expect(artifactFor("s2")).toEqual(KB_DOC);
  });

  it("the inherited binding persists with the workspace like any other (criterion 5)", () => {
    openInPanel("s1", KB_DOC);
    inheritPanel(artifactFor("s1"), "s2");
    expect(getPanelsRecord()).toEqual({ s1: one(KB_DOC), s2: one(KB_DOC) });
  });
});

// ─── Increment B: the shared pins store still sees ONE record per sidecar ────
//
// The A5 data-loss class, made MUCH easier to hit: two artifacts from the SAME
// KB folder share one `.pins.json`, and with tabs they can now be open in two
// terminal tabs at once WITHOUT the panel ever replacing one with the other.
// The store must still hand both mounts the same record — component-local pin
// state would mean two copies and a silent last-writer-wins clobber.

describe("panel tabs x shared pins store (one record per sidecar)", () => {
  const WIRE_A: Artifact = { kind: "kb-doc", path: "switchboard/mocks/home.html" };
  const WIRE_B: Artifact = { kind: "kb-doc", path: "switchboard/mocks/detail.html" };

  const mkPin = (id: string, doc: string): Pin => ({
    id,
    doc,
    xPct: 10,
    yPct: 20,
    note: id,
    createdAt: "2026-08-02T00:00:00.000Z",
  });

  beforeEach(() => {
    __resetPinsStoreForTests();
  });

  it("two artifacts from one folder, open in two TABS, converge on one record", async () => {
    const writes: Array<[string, string]> = [];
    configurePinsIO({
      read: vi.fn(async () => JSON.stringify({ version: 1, pins: [] })),
      write: vi.fn(async (path: string, text: string) => {
        writes.push([path, text]);
      }),
    });

    // Tab 1 shows home.html, tab 2 shows detail.html — different documents,
    // same folder, so ONE sidecar.
    openInPanel("s1", WIRE_A);
    openInPanel("s2", WIRE_B);
    expect(artifactFor("s1")).toEqual(WIRE_A);
    expect(artifactFor("s2")).toEqual(WIRE_B);

    const sidecarA = sidecarPathFor(WIRE_A.kind === "kb-doc" ? WIRE_A.path : "");
    const sidecarB = sidecarPathFor(WIRE_B.kind === "kb-doc" ? WIRE_B.path : "");
    expect(sidecarA).toBe(sidecarB);

    // Both panels mount their viewer.
    const releaseA = subscribeToPins(sidecarA, () => {});
    const releaseB = subscribeToPins(sidecarB, () => {});
    await Promise.resolve();
    await Promise.resolve();

    // A pin placed on tab 1's wireframe…
    mutatePins(sidecarA, (file) => addPin(file, mkPin("p1", docFileName(WIRE_A.path))));
    // …is visible to tab 2's mount, because there is only ONE record.
    expect(getPinsFile(sidecarB)!.pins.map((p) => p.id)).toEqual(["p1"]);

    // And a pin placed on tab 2 does NOT clobber it (the pre-store bug).
    mutatePins(sidecarB, (file) => addPin(file, mkPin("p2", docFileName(WIRE_B.path))));
    const shared = getPinsFile(sidecarA)!;
    expect(shared.pins.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(pinsForDoc(shared, docFileName(WIRE_A.path)).map((p) => p.id)).toEqual(["p1"]);
    expect(pinsForDoc(shared, docFileName(WIRE_B.path)).map((p) => p.id)).toEqual(["p2"]);

    // One writer for the sidecar, not one per mount: the flush on last release
    // writes the merged file exactly once.
    releaseA();
    expect(writes).toHaveLength(0); // still mounted elsewhere — nothing owed yet
    releaseB();
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(sidecarA);
    expect(JSON.parse(writes[0][1]).pins.map((p: Pin) => p.id)).toEqual(["p1", "p2"]);
  });

  it("…and the same holds for two artifacts from one folder in ONE tab's strip", async () => {
    configurePinsIO({
      read: vi.fn(async () => JSON.stringify({ version: 1, pins: [] })),
      write: vi.fn(async () => {}),
    });
    openInPanel("s1", WIRE_A);
    openInPanel("s1", WIRE_B);
    expect(panelStateFor("s1")).toEqual(strip([WIRE_A, WIRE_B], 1));

    const sidecar = sidecarPathFor(WIRE_A.path);
    const release = subscribeToPins(sidecar, () => {});
    await Promise.resolve();
    await Promise.resolve();
    mutatePins(sidecar, (file) => addPin(file, mkPin("p1", docFileName(WIRE_A.path))));
    // Switching tabs is not a new record — the strip changed, the sidecar did
    // not.
    activateArtifact("s1", 0);
    expect(sidecarPathFor((artifactFor("s1") as { path: string }).path)).toBe(sidecar);
    expect(getPinsFile(sidecar)!.pins).toHaveLength(1);
    release();
  });
});


// ── Pop-out to the floating window (increment F, Decision 2) ─────────────────
// The store's whole job here is to record WHICH artifact is out of the panel,
// so the panel can show a placeholder instead of a second live copy of it. The
// WINDOW is App's; nothing below opens or closes one.

describe("popped-out artifact", () => {
  const DOC: Artifact = { kind: "kb-doc", path: "a/b.md" };
  const LIVE: Artifact = { kind: "localhost", project: "lodestar", url: "http://localhost:5173/" };

  beforeEach(() => {
    __resetPanelStoreForTests();
  });

  it("starts with nothing out", () => {
    expect(getPoppedOutArtifact()).toBeNull();
    expect(poppedOutIdentity()).toBe("");
  });

  it("records and clears", () => {
    setPoppedOutArtifact("s1", DOC);
    expect(getPoppedOutArtifact()).toEqual(DOC);
    expect(poppedOutIdentity()).toBe("kb-doc:a/b.md");
    clearPoppedOutArtifact();
    expect(getPoppedOutArtifact()).toBeNull();
    expect(poppedOutIdentity()).toBe("");
  });

  it("holds ONE artifact — there is one floating window", () => {
    setPoppedOutArtifact("s1", DOC);
    setPoppedOutArtifact("s2", LIVE);
    expect(getPoppedOutArtifact()).toEqual(LIVE);
  });

  it("runs the lean gate on the way in", () => {
    setPoppedOutArtifact("s1", { kind: "kb-doc", path: "a.md", junk: 1 } as unknown as Artifact);
    expect(getPoppedOutArtifact()).toEqual({ kind: "kb-doc", path: "a.md" });
    setPoppedOutArtifact("s1", { kind: "nope" } as unknown as Artifact);
    // Unusable input leaves the previous record alone rather than blanking it.
    expect(getPoppedOutArtifact()).toEqual({ kind: "kb-doc", path: "a.md" });
  });

  it("refuses an empty session id", () => {
    setPoppedOutArtifact("", DOC);
    expect(getPoppedOutArtifact()).toBeNull();
  });

  it("notifies subscribers on both transitions", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeToPanelStore(() => seen.push(poppedOutIdentity()));
    setPoppedOutArtifact("s1", DOC);
    clearPoppedOutArtifact();
    clearPoppedOutArtifact(); // idempotent: no third notification
    unsubscribe();
    expect(seen).toEqual(["kb-doc:a/b.md", ""]);
  });

  it("closing the TAB drops the record — there is no panel to return to", () => {
    openInPanel("s1", DOC);
    setPoppedOutArtifact("s1", DOC);
    removeSessionPanel("s1");
    expect(getPoppedOutArtifact()).toBeNull();
  });

  it("closing a DIFFERENT tab leaves it alone", () => {
    openInPanel("s2", DOC);
    setPoppedOutArtifact("s1", DOC);
    removeSessionPanel("s2");
    expect(getPoppedOutArtifact()).toEqual(DOC);
  });

  it("notifies even when the closed tab had no panel of its own", () => {
    setPoppedOutArtifact("s1", DOC);
    let notified = 0;
    const unsubscribe = subscribeToPanelStore(() => (notified += 1));
    removeSessionPanel("s1");
    unsubscribe();
    expect(getPoppedOutArtifact()).toBeNull();
    expect(notified).toBe(1);
  });

  it("the action is DISABLED rather than silently dead with no handler", () => {
    expect(popOutAvailable()).toBe(false);
    popOutArtifact(DOC); // must not throw
    const calls: Artifact[] = [];
    registerPanelActions({
      sendToThread: () => {},
      popOutArtifact: (a) => calls.push(a),
    });
    expect(popOutAvailable()).toBe(true);
    popOutArtifact(LIVE);
    expect(calls).toEqual([LIVE]);
  });
});

// ── "is this URL already framed?" ────────────────────────────────────────────
// The dev-server offer chip asks this before it offers, so a restarting server
// (or a second tab running the same one) does not re-offer a preview that is
// already on screen. It spans EVERY panel plus the floating window, because a
// dev server is machine-wide and a popped-out preview is very much open.

describe("isLocalhostUrlOpen", () => {
  const LIVE: Artifact = { kind: "localhost", project: "lodestar", url: "http://localhost:5173/" };
  const OTHER: Artifact = { kind: "localhost", project: "orbit", url: "http://localhost:5174/" };
  const DOC: Artifact = { kind: "kb-doc", path: "a/b.md" };

  beforeEach(() => {
    __resetPanelStoreForTests();
  });

  it("is false with nothing open", () => {
    expect(isLocalhostUrlOpen("http://localhost:5173/")).toBe(false);
  });

  it("finds a preview in a panel strip", () => {
    openInPanel("sess-1", LIVE);
    expect(isLocalhostUrlOpen("http://localhost:5173/")).toBe(true);
    expect(isLocalhostUrlOpen("http://localhost:5174/")).toBe(false);
  });

  it("finds one on a NON-active tab of a strip", () => {
    openInPanel("sess-1", LIVE);
    openInPanel("sess-1", DOC); // LIVE is no longer the active tab
    expect(isLocalhostUrlOpen("http://localhost:5173/")).toBe(true);
  });

  it("finds one in ANOTHER session's panel", () => {
    openInPanel("sess-2", LIVE);
    expect(isLocalhostUrlOpen("http://localhost:5173/")).toBe(true);
  });

  it("finds the POPPED-OUT preview, whose panel tab is only a placeholder", () => {
    setPoppedOutArtifact("sess-1", LIVE);
    expect(isLocalhostUrlOpen("http://localhost:5173/")).toBe(true);
  });

  it("ignores non-localhost artifacts and junk input", () => {
    openInPanel("sess-1", DOC);
    openInPanel("sess-1", OTHER);
    expect(isLocalhostUrlOpen("a/b.md")).toBe(false);
    expect(isLocalhostUrlOpen("")).toBe(false);
    expect(isLocalhostUrlOpen(null as unknown as string)).toBe(false);
  });

  it("matches the URL EXACTLY — a different path is a different preview", () => {
    openInPanel("sess-1", LIVE);
    expect(isLocalhostUrlOpen("http://localhost:5173")).toBe(false);
    expect(isLocalhostUrlOpen("http://localhost:5173/admin")).toBe(false);
  });

  it("goes false again once the preview is closed", () => {
    openInPanel("sess-1", LIVE);
    closeArtifactAt("sess-1", 0);
    expect(isLocalhostUrlOpen("http://localhost:5173/")).toBe(false);
  });
});
