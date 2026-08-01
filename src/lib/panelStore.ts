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
// container" — and so the rules that actually matter (never crush the shell,
// overlay instead of squeezing when there's no room) are unit-testable.
//
// GEOMETRY CONTRACT — every width below is measured against the WORKSPACE
// container `[pane tree | divider | panel]`, NOT the whole terminal-screen
// row. The TaskSidebar is a sibling of that container, outside it, so its
// width (0 hidden / 38 collapsed / 280 full) never enters this arithmetic and
// the panel's right edge IS the container's right edge. App.tsx owns that
// nesting; if the panel is ever re-parented next to the sidebar again, these
// functions become wrong by exactly the sidebar's width.

/** Divider thickness in px — real layout space between the pane tree and the
 *  panel, so it counts against the terminal-side floor. */
export const DIVIDER_WIDTH = 4;

/** How the panel occupies the workspace container for a given container width. */
export type PanelLayout = {
  /** "docked" = a real flex column beside the pane tree (divider draggable);
   *  "overlay" = absolutely positioned over it (pane tree keeps its width). */
  mode: "docked" | "overlay";
  /** Painted width in px. */
  width: number;
};

/** Space the pane tree is left with for a given container width + layout.
 *  The inverse of panelLayoutFor's cap, exported so the invariant "the shell
 *  never drops below MIN_TERMINAL_WIDTH" is assertable directly. */
export function paneTreeWidthFor(containerWidth: number, layout: PanelLayout): number {
  if (layout.mode === "overlay") return Math.round(containerWidth); // panel floats; tree keeps its width
  return Math.round(containerWidth) - DIVIDER_WIDTH - layout.width;
}

/** Decide the panel's mode + painted width.
 *
 *  - Unmeasured container (0 / non-finite, e.g. the terminal screen sitting at
 *    display:none) → dock at the requested width; the ResizeObserver corrects
 *    it the moment the container is real.
 *  - Container narrower than OVERLAY_BREAKPOINT → OVERLAY, capped at the
 *    container width.
 *  - Otherwise DOCK, capped so the pane tree keeps MIN_TERMINAL_WIDTH *after*
 *    the divider's own 4px. (At the breakpoint that cap is 556px, comfortably
 *    above MIN_PANEL_WIDTH, so a docked panel is never squeezed below its own
 *    floor.) */
export function panelLayoutFor(containerWidth: number, requestedWidth: number): PanelLayout {
  const want = clampPanelWidth(requestedWidth);
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return { mode: "docked", width: want };
  }
  const box = Math.round(containerWidth);
  if (box < OVERLAY_BREAKPOINT) return { mode: "overlay", width: Math.min(want, box) };
  return { mode: "docked", width: Math.min(want, box - MIN_TERMINAL_WIDTH - DIVIDER_WIDTH) };
}

/** Divider drag → new stored width. The panel is right-anchored to the
 *  workspace container, and the divider sits immediately left of it, so the
 *  width that puts the divider's left edge under the cursor is
 *  `containerRight - clientX - DIVIDER_WIDTH`. Capped by the same
 *  terminal-side floor panelLayoutFor enforces, then clamped into
 *  [MIN_PANEL_WIDTH, MAX_PANEL_WIDTH]. */
export function panelWidthFromDrag(
  containerLeft: number,
  containerWidth: number,
  clientX: number
): number {
  const raw = containerLeft + containerWidth - clientX - DIVIDER_WIDTH;
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return clampPanelWidth(raw);
  const cap = Math.max(
    MIN_PANEL_WIDTH,
    Math.round(containerWidth) - MIN_TERMINAL_WIDTH - DIVIDER_WIDTH
  );
  return clampPanelWidth(Math.min(raw, cap));
}

// ── Header presentation (A2) ─────────────────────────────────────────────────

/** One breadcrumb segment tone, mirroring the KB screen's breadcrumb exactly:
 *  `bright` = the artifact itself (always the last crumb) · `lead` = the
 *  emphasized OWNER of the path — for repo-file that's the project, for kb-doc
 *  it's the first path segment (the kb project), NOT the literal `kb` prefix,
 *  which stays `dim` · `dim` = the literal `kb` prefix and every intermediate
 *  ancestor. */
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
    // No defensive copy: every mutator below REPLACES `panels` with a fresh
    // Map rather than mutating in place, so the map a cached view holds is
    // already frozen in practice — copying it again just doubled the
    // allocation on every store change.
    cachedView = { panels, panelWidth };
  }
  return cachedView;
}

/** React hook: the panel view, re-rendering on any store change. */
export function usePanelsView(): PanelsView {
  return useSyncExternalStore(subscribe, getPanelsView);
}

/** Stable identity string for an artifact — equal strings mean "the same
 *  content is open". Used as a React reset key and as a narrow-selector
 *  snapshot (primitives compare by value under Object.is, so a subscriber
 *  re-renders only when the CONTENT changes). */
export function artifactIdentity(artifact: Artifact): string {
  switch (artifact.kind) {
    case "kb-doc":
      return `kb-doc:${artifact.path}`;
    case "repo-file":
      return `repo-file:${artifact.project}:${artifact.path}`;
    case "localhost":
      return `localhost:${artifact.project}:${artifact.url}`;
  }
}

/** A session's panel identity, or `""` when the tab has no panel open. */
export function panelIdentityFor(sessionId: string | null): string {
  if (!sessionId) return "";
  const artifact = panels.get(sessionId);
  return artifact ? artifactIdentity(artifact) : "";
}

/** Narrow selector: WHAT is open in this session's (tab's) panel, as an
 *  identity string (`""` = nothing). App subscribes through this so it
 *  re-renders when the content changes or the panel opens/closes — but NOT on
 *  every divider-drag frame, which mutates panelWidth ~60x/sec. */
export function usePanelIdentity(sessionId: string | null): string {
  return useSyncExternalStore(subscribe, () => panelIdentityFor(sessionId));
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
