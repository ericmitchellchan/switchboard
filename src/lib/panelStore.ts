// Artifact panel store (workstation v2, phase A1) — per-TAB panel content.
//
// The panel is a right-side surface inside the terminal screen; what it shows
// is an Artifact REFERENCE (see src/types.ts) keyed by the owning session
// (tab) id. Width is GLOBAL — one width for every tab, one less thing to
// restore per-tab.
//
// Layout mirrors threadStore.ts:
//   1. Pure helpers — unit-tested under Node: artifact sanitizing (the lean
//      gate every load path funnels through), width clamping, tolerant
//      (de)serialization for the SavedWorkspace v3 blob, and the restore
//      remap rule.
//   2. Module-level store — same shape as route.ts / threadStore.ts (module
//      singletons + useSyncExternalStore), deliberately not zustand.
//
// Persistence rides INSIDE the SavedWorkspace v3 localStorage blob
// (`panels: Record<savedSessionId, Artifact>` + `panelWidth`) — no disk
// mirror: unlike threads, a panel binding is machine-local UI state whose key
// is a session id that dies with the workspace anyway. On restore, keys are
// remapped through the same session idMap threads use; unmapped keys are
// DROPPED (the tab didn't come back, so the binding is meaningless). Records
// stay LEAN (localStorage is one shared key): sanitizeArtifact keeps only
// schema fields.
//
// NOTE: `openArtifact` — the open-in-panel vs navigate-full routing decision
// (architecture Decision 2) — is deliberately NOT here yet; it lands in phase
// A3. This module is pure state.

import { useSyncExternalStore } from "react";
import type { Artifact } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Default panel width (px). */
export const DEFAULT_PANEL_WIDTH = 420;
/** Clamp floor — below this the panel is unreadable chrome. */
export const MIN_PANEL_WIDTH = 260;
/** Clamp ceiling — beyond this the panel crushes the terminal on any sane
 *  window (extreme narrowness is handled by overlay mode, below). */
export const MAX_PANEL_WIDTH = 960;

/** Terminal-side floor (A2): the pane tree never narrows past this while the
 *  panel is DOCKED. Below it the shell stops being a shell. */
export const MIN_TERMINAL_WIDTH = 320;

/** Workspace-row width under which the panel OVERLAYS the pane tree instead of
 *  squeezing it (requirements: "below a sane minimum the panel overlays or
 *  collapses rather than crushing the terminal"). */
export const OVERLAY_BREAKPOINT = 880;

/** Clamp a width into the sane range; non-finite input → default. */
export function clampPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return DEFAULT_PANEL_WIDTH;
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(w)));
}

// ── Panel host layout policy (A2) ────────────────────────────────────────────
// Pure so the host component carries no layout math beyond "how wide is my
// row" — and so the two rules that actually matter (never crush the shell,
// overlay instead of squeezing when there's no room) are unit-testable.

/** How the panel occupies the workspace row for a given row width. */
export type PanelLayout = {
  /** "docked" = a real flex column beside the pane tree (divider draggable);
   *  "overlay" = absolutely positioned over it (pane tree keeps its width). */
  mode: "docked" | "overlay";
  /** Painted width in px. */
  width: number;
};

/** Decide the panel's mode + painted width.
 *
 *  - Unmeasured row (0 / non-finite, e.g. the terminal screen sitting at
 *    display:none) → dock at the requested width; the ResizeObserver corrects
 *    it the moment the row is real.
 *  - Row narrower than OVERLAY_BREAKPOINT → OVERLAY, capped at the row width.
 *  - Otherwise DOCK, capped so the pane tree keeps MIN_TERMINAL_WIDTH. (At the
 *    breakpoint that cap is 560px, comfortably above MIN_PANEL_WIDTH, so a
 *    docked panel is never squeezed below its own floor.) */
export function panelLayoutFor(rowWidth: number, requestedWidth: number): PanelLayout {
  const want = clampPanelWidth(requestedWidth);
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) return { mode: "docked", width: want };
  const row = Math.round(rowWidth);
  if (row < OVERLAY_BREAKPOINT) return { mode: "overlay", width: Math.min(want, row) };
  return { mode: "docked", width: Math.min(want, row - MIN_TERMINAL_WIDTH) };
}

/** Divider drag → new stored width. The panel is right-anchored, so the width
 *  is the distance from the pointer to the row's right edge, capped by the
 *  same terminal-side floor panelLayoutFor enforces and then clamped into
 *  [MIN_PANEL_WIDTH, MAX_PANEL_WIDTH]. */
export function panelWidthFromDrag(rowLeft: number, rowWidth: number, clientX: number): number {
  const raw = rowLeft + rowWidth - clientX;
  if (!Number.isFinite(rowWidth) || rowWidth <= 0) return clampPanelWidth(raw);
  const cap = Math.max(MIN_PANEL_WIDTH, Math.round(rowWidth) - MIN_TERMINAL_WIDTH);
  return clampPanelWidth(Math.min(raw, cap));
}

// ── Header presentation (A2) ─────────────────────────────────────────────────

/** One breadcrumb segment. `lead` = the root (kb / project) — emphasized;
 *  `dim` = intermediate ancestors; `bright` = the artifact itself. Mirrors the
 *  KB screen's breadcrumb tones so the panel header reads the same. */
export type ArtifactCrumb = { text: string; tone: "lead" | "dim" | "bright" };

export type ArtifactDescription = {
  /** Kind glyph shown left of the breadcrumb. */
  glyph: string;
  crumbs: ArtifactCrumb[];
  /** Flat one-line form for tooltips / aria labels. */
  title: string;
};

/** Build the panel header's glyph + breadcrumb for an artifact. Pure — the
 *  host just paints the tones. */
export function describeArtifact(artifact: Artifact): ArtifactDescription {
  switch (artifact.kind) {
    case "kb-doc": {
      const segments = artifact.path.split("/").filter((s) => s.length > 0);
      return {
        glyph: "◆",
        crumbs: [{ text: "kb", tone: "dim" }, ...toneSegments(segments)],
        title: `kb / ${artifact.path}`,
      };
    }
    case "repo-file": {
      const segments = artifact.path.split("/").filter((s) => s.length > 0);
      return {
        glyph: "■",
        crumbs: [{ text: artifact.project, tone: "lead" }, ...toneSegments(segments, false)],
        title: `${artifact.project} / ${artifact.path}`,
      };
    }
    case "localhost":
      return {
        glyph: "◉",
        crumbs: [
          { text: artifact.project, tone: "lead" },
          { text: artifact.url, tone: "bright" },
        ],
        title: `${artifact.project} / ${artifact.url}`,
      };
  }
}

/** Last segment bright, first `lead` (only when it is also the root of the
 *  path — repo-file's root is the PROJECT, so its first segment is a plain
 *  ancestor), everything else dim. */
function toneSegments(segments: string[], firstIsLead = true): ArtifactCrumb[] {
  return segments.map((text, i) => ({
    text,
    tone:
      i === segments.length - 1
        ? ("bright" as const)
        : i === 0 && firstIsLead
          ? ("lead" as const)
          : ("dim" as const),
  }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Lean-record gate: rebuild an Artifact from unknown input keeping ONLY the
 *  schema fields of its kind, or reject it. Every load path — workspace
 *  migration and store seeding — funnels through here. */
export function sanitizeArtifact(raw: unknown): Artifact | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case "kb-doc":
      return isNonEmptyString(raw.path) ? { kind: "kb-doc", path: raw.path } : null;
    case "repo-file":
      return isNonEmptyString(raw.project) && isNonEmptyString(raw.path)
        ? { kind: "repo-file", project: raw.project, path: raw.path }
        : null;
    case "localhost":
      // Phase B kind — declared in the schema, tolerated on load, never
      // constructed by Phase A code paths.
      return isNonEmptyString(raw.project) && isNonEmptyString(raw.url)
        ? { kind: "localhost", project: raw.project, url: raw.url }
        : null;
    default:
      return null;
  }
}

/** Tolerant parse of a persisted panels record (like pins: a broken entry
 *  must not eat the rest). Non-record input → empty; entries with an empty
 *  key or an invalid artifact are dropped individually. */
export function parsePanels(raw: unknown): Record<string, Artifact> {
  if (!isRecord(raw)) return {};
  const out: Record<string, Artifact> = {};
  for (const [sessionId, value] of Object.entries(raw)) {
    if (sessionId.length === 0) continue;
    const artifact = sanitizeArtifact(value);
    if (artifact) out[sessionId] = artifact;
  }
  return out;
}

/** Tolerant parse of a persisted width: finite number → clamped, else default. */
export function parsePanelWidth(raw: unknown): number {
  return clampPanelWidth(typeof raw === "number" ? raw : NaN);
}

/** Store map → lean plain record for the SavedWorkspace blob. Re-sanitizes on
 *  the way out — the lean invariant holds even if a caller ever hands us
 *  decorated records (same posture as serializeThreadsForDisk). */
export function serializePanels(
  panels: ReadonlyMap<string, Artifact>
): Record<string, Artifact> {
  const out: Record<string, Artifact> = {};
  for (const [sessionId, value] of panels) {
    const artifact = sanitizeArtifact(value);
    if (sessionId.length > 0 && artifact) out[sessionId] = artifact;
  }
  return out;
}

/** Remap panel keys through the workspace-restore session idMap. A panel
 *  whose old sessionId has no restored counterpart is DROPPED — unlike a
 *  thread (which is severed and stays revivable), a panel binding without its
 *  tab is meaningless. Pass an empty map on fresh starts to drop everything. */
export function remapPanels(
  panels: Record<string, Artifact>,
  idMap: Map<string, string>
): Record<string, Artifact> {
  const out: Record<string, Artifact> = {};
  for (const [oldId, artifact] of Object.entries(panels)) {
    const newId = idMap.get(oldId);
    if (newId) out[newId] = artifact;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/** Snapshot consumed by the panel UI (useSyncExternalStore). */
export type PanelsView = {
  panels: ReadonlyMap<string, Artifact>;
  panelWidth: number;
};

let panels = new Map<string, Artifact>();
let panelWidth = DEFAULT_PANEL_WIDTH;

const listeners = new Set<() => void>();
let cachedView: PanelsView | null = null;

function bump(): void {
  cachedView = null;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPanelsView(): PanelsView {
  if (!cachedView) {
    cachedView = { panels: new Map(panels), panelWidth };
  }
  return cachedView;
}

/** React hook: the panel view, re-rendering on any store change. */
export function usePanelsView(): PanelsView {
  return useSyncExternalStore(subscribe, getPanelsView);
}

/** Narrow selector: does this session (tab) have a panel open? Boolean
 *  snapshot, so a subscriber re-renders only when the answer FLIPS — App uses
 *  it for the status-bar hint without re-rendering the whole shell on every
 *  divider-drag frame (which mutates panelWidth ~60x/sec). */
export function useHasPanel(sessionId: string | null): boolean {
  return useSyncExternalStore(subscribe, () =>
    sessionId !== null && sessionId.length > 0 ? panels.has(sessionId) : false
  );
}

/** The artifact open in a session's (tab's) panel, or null when closed. */
export function artifactFor(sessionId: string): Artifact | null {
  return panels.get(sessionId) ?? null;
}

export function getPanelWidth(): number {
  return panelWidth;
}

/** Current panels as a lean plain record — buildSavedWorkspace's source. */
export function getPanelsRecord(): Record<string, Artifact> {
  return serializePanels(panels);
}

/** Seed the store at boot from the migrated workspace blob (both arguments
 *  already tolerant-parsed by migrateSavedWorkspace, but the lean gate runs
 *  again here — every load path funnels through sanitizeArtifact). */
export function initPanelStore(
  initial: Record<string, Artifact>,
  width: number = DEFAULT_PANEL_WIDTH
): void {
  panels = new Map(Object.entries(parsePanels(initial)));
  panelWidth = clampPanelWidth(width);
  bump();
}

/** Open (or replace) the artifact in a session's panel. */
export function openInPanel(sessionId: string, artifact: Artifact): void {
  if (sessionId.length === 0) return;
  const clean = sanitizeArtifact(artifact);
  if (!clean) return;
  panels = new Map(panels);
  panels.set(sessionId, clean);
  bump();
}

/** Close a session's panel (user action — the × / toggle). No-op when the
 *  session has no panel. */
export function closePanel(sessionId: string): void {
  if (!panels.has(sessionId)) return;
  panels = new Map(panels);
  panels.delete(sessionId);
  bump();
}

/** Tab-close cleanup: the session was destroyed, its panel binding goes with
 *  it (called beside unbindThreadsForSession in App.destroySession). */
export function removeSessionPanel(sessionId: string): void {
  closePanel(sessionId);
}

/** Set the global panel width (clamped). */
export function setPanelWidth(w: number): void {
  const clamped = clampPanelWidth(w);
  if (clamped === panelWidth) return;
  panelWidth = clamped;
  bump();
}

/** Remap all panel keys after workspace restore through the same session
 *  idMap the thread remap uses; unmapped keys are dropped (pass an empty map
 *  on fresh starts to drop every binding). */
export function remapPanelSessions(idMap: Map<string, string>): void {
  panels = new Map(Object.entries(remapPanels(Object.fromEntries(panels), idMap)));
  bump();
}

/** Test-only: reset the store to a blank state. */
export function __resetPanelStoreForTests(): void {
  panels = new Map();
  panelWidth = DEFAULT_PANEL_WIDTH;
  cachedView = null;
  listeners.clear();
}
