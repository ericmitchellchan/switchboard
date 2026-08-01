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
 *  window (extreme narrowness is handled by overlay mode in A2, not here). */
export const MAX_PANEL_WIDTH = 960;

/** Clamp a width into the sane range; non-finite input → default. */
export function clampPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return DEFAULT_PANEL_WIDTH;
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(w)));
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
