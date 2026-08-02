// Artifact panel store (workstation v2, phase A1; tabs in increment B) —
// per-TAB panel content.
//
// The panel is a right-side surface inside the terminal screen; what it shows
// is a STRIP of Artifact REFERENCES (see src/types.ts — `PanelState`) keyed by
// the owning session (tab) id. Two levels of "tab" meet here and must not be
// confused: the app's TERMINAL tabs are the store's KEYS, and each one owns a
// strip of ARTIFACT tabs. Width is GLOBAL — one width for every terminal tab,
// one less thing to restore per-tab.
//
// Layout mirrors threadStore.ts:
//   1. Pure helpers — unit-tested under Node: artifact sanitizing (the lean
//      gate every load path funnels through), the strip operations
//      (append-or-activate / close / activate), width clamping, tolerant
//      (de)serialization for the SavedWorkspace v4 blob, and the restore
//      remap rule.
//   2. Module-level store — same shape as route.ts / threadStore.ts (module
//      singletons + useSyncExternalStore), deliberately not zustand.
//
// Persistence rides INSIDE the SavedWorkspace v4 localStorage blob
// (`panels: Record<savedSessionId, PanelState>` + `panelWidth`) — no disk
// mirror: unlike threads, a panel binding is machine-local UI state whose key
// is a session id that dies with the workspace anyway. On restore, keys are
// remapped through the same session idMap threads use; unmapped keys are
// DROPPED (the tab didn't come back, so the binding is meaningless). Records
// stay LEAN (localStorage is one shared key): sanitizeArtifact keeps only
// schema fields.
//
// A3 adds the OPEN PATH on top of that state: `decideOpen` (pure, exhaustively
// unit-tested) + `openArtifact` (the thin effectful wrapper both tree sections
// call), the per-tab toggle memory that makes Ctrl+Shift+P a real toggle, and
// the active-TAB bridge those two need.
//
// INCREMENT B — one session holds MANY artifacts. The rules that come with
// that, all enforced here rather than in the host component:
//   - DEDUPE (acceptance 4): opening an artifact already in the strip
//     ACTIVATES its tab instead of appending a second copy. Comparison is by
//     `artifactIdentity` (kind + project + path), the same string the pins
//     store's "one document, one live record" lesson is about — two tabs
//     naming one document would mean two records of everything downstream.
//   - A strip is never EMPTY: closing the last tab removes the session's
//     entry, which is what "the panel collapsed" means everywhere else.
//   - `activeIndex` is always valid: clamped on load and re-derived on close.

import { useSyncExternalStore } from "react";
import type { Artifact, PanelState, Route, ScreenId } from "../types";
import { getNavState, navigate } from "./route";
// TYPE-ONLY, and deliberately so: the icon vocabulary is named here and DRAWN
// in components/icons.tsx, and a type import is erased at build time — this
// store keeps zero runtime dependency on React components (its tests import it
// in a plain node environment).
import type { IconName } from "../components/icons";

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

/** LAYOUT width the pane tree occupies. In overlay mode the tree keeps its
 *  full width — the panel floats ON TOP of it — so this is what the terminal
 *  is sized/fitted to, NOT what the user can see. Use `shellVisibleWidthFor`
 *  for the "is any shell still visible" question. */
export function paneTreeWidthFor(containerWidth: number, layout: PanelLayout): number {
  if (layout.mode === "overlay") return Math.round(containerWidth); // panel floats; tree keeps its width
  return Math.round(containerWidth) - DIVIDER_WIDTH - layout.width;
}

/** Shell the user can actually SEE — the invariant the requirements state
 *  ("below a sane minimum the panel OVERLAYS or collapses rather than
 *  crushing the terminal"). Docked and overlay differ here and only here:
 *  a docked panel takes space from the tree, an overlay COVERS it, so
 *  `paneTreeWidthFor` alone cannot see an overlay that hides the shell
 *  completely — which is exactly the regression this exists to make
 *  assertable. */
export function shellVisibleWidthFor(containerWidth: number, layout: PanelLayout): number {
  if (layout.mode === "overlay") return Math.round(containerWidth) - layout.width;
  return paneTreeWidthFor(containerWidth, layout);
}

/** Decide the panel's mode + painted width.
 *
 *  - Unmeasured container (0 / non-finite, e.g. the terminal screen sitting at
 *    display:none) → dock at the requested width; the ResizeObserver corrects
 *    it the moment the container is real.
 *  - Container narrower than OVERLAY_BREAKPOINT → OVERLAY, capped so a strip
 *    of shell stays UNCOVERED. Overlaying is meant to stop the panel crushing
 *    the terminal; a full-width overlay would hide it entirely, which is
 *    worse than the crushing it replaces. `panelWidth` is global, persisted
 *    and draggable to 960 on a wide monitor, so a snap-resize down to a 700px
 *    workspace really does arrive here with `want` bigger than the box.
 *    The panel's own readability floor still wins on a truly tiny container —
 *    there, the peek shrinks rather than the panel becoming unusable.
 *  - Otherwise DOCK, capped so the pane tree keeps MIN_TERMINAL_WIDTH *after*
 *    the divider's own 4px. (At the breakpoint that cap is 556px, comfortably
 *    above MIN_PANEL_WIDTH, so a docked panel is never squeezed below its own
 *    floor.)
 *
 *  Both branches therefore hold the same promise wherever the container can
 *  afford it — `shellVisibleWidthFor >= MIN_TERMINAL_WIDTH` — so crossing the
 *  breakpoint changes the panel's MODE, never whether the shell is visible. */
export function panelLayoutFor(containerWidth: number, requestedWidth: number): PanelLayout {
  const want = clampPanelWidth(requestedWidth);
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return { mode: "docked", width: want };
  }
  const box = Math.round(containerWidth);
  if (box < OVERLAY_BREAKPOINT) {
    return { mode: "overlay", width: Math.max(MIN_PANEL_WIDTH, Math.min(want, box - MIN_TERMINAL_WIDTH)) };
  }
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
  /** Kind icon shown left of the breadcrumb (drawn by components/icons). */
  icon: IconName;
  crumbs: ArtifactCrumb[];
  /** Flat one-line form for tooltips / aria labels. */
  title: string;
};

/** Build the panel header's icon + breadcrumb for an artifact. Pure — the
 *  host just draws the icon and paints the tones. */
export function describeArtifact(artifact: Artifact): ArtifactDescription {
  switch (artifact.kind) {
    case "kb-doc": {
      const segments = artifact.path.split("/").filter((s) => s.length > 0);
      return {
        icon: FILE_ICON,
        crumbs: [{ text: "kb", tone: "dim" }, ...toneSegments(segments)],
        title: `kb / ${artifact.path}`,
      };
    }
    case "repo-file": {
      const segments = artifact.path.split("/").filter((s) => s.length > 0);
      return {
        icon: FILE_ICON,
        crumbs: [{ text: artifact.project, tone: "lead" }, ...toneSegments(segments, false)],
        title: `${artifact.project} / ${artifact.path}`,
      };
    }
    case "localhost":
      return {
        icon: "localhost",
        crumbs: [
          { text: artifact.project, tone: "lead" },
          { text: artifact.url, tone: "bright" },
        ],
        title: `${artifact.project} / ${artifact.url}`,
      };
  }
}

// ── Tree icons (2026-08-02 — Eric, driving the app) ──────────────────────────
// Folder-vs-file marks for the side-menu trees (KbTreeSection /
// ExplorerTreeSection) and the `+` picker. The NAMES live here, next to
// describeArtifact, so the trees, the picker and the panel header keep
// speaking ONE language; the DRAWING lives in components/icons.tsx.
//
// This replaces the geometric-glyph vocabulary (◧ ◆ ◈ ◇ ▪ ▫ ■). Two things
// were wrong with it and only one was fixable:
//   1. it did not read — every mark was "a small filled shape", which is why
//      Eric called them dots; and
//   2. the marks did not ALIGN, because their ink sits at different offsets
//      inside the identical 600/1000 mono cell (▪ occupies x 150…450 of the
//      cell, ◧ occupies 0…600). See the measurements in components/icons.tsx.
// A vector path puts its ink exactly where we say, so the alignment problem
// stops existing rather than being compensated for.
//
// Kind-awareness is GONE on purpose: one file icon for every file, per Eric's
// "just use a folder icon and then a file icon". Nothing is lost that was
// legible at 12px — the picker still prints the docKind as text, and DocView
// still routes on it.

/** File rows in BOTH trees, rows in the `+` picker, and the panel header for
 *  every openable artifact (kb-doc and repo-file alike). */
export const FILE_ICON: IconName = "file";

/** Directory rows — project roots and plain folders alike, in BOTH trees, plus
 *  the picker's project/dir rows (which are always collapsed). */
export const FOLDER_ICON: IconName = "folder";

/** Expanded directory rows. Matches the expander chevron, IDE-style. */
export const FOLDER_OPEN_ICON: IconName = "folder-open";

/** The tab bar's panel button. */
export const PANEL_ICON: IconName = "panel";

/** Folder icon for a row's expansion state. Pure. */
export function folderIcon(open: boolean): IconName {
  return open ? FOLDER_OPEN_ICON : FOLDER_ICON;
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

// ── Strip operations (pure — increment B) ────────────────────────────────────
// Every mutation of a session's tab strip is one of these three, so the
// invariants (non-empty, no duplicates, valid activeIndex) live in ONE place
// and are asserted without a store.

/** Stable identity string for an artifact — equal strings mean "the same
 *  content". THE DEDUPE KEY (kind + project + path) and also a React reset key
 *  and a narrow-selector snapshot (primitives compare by value under
 *  Object.is, so a subscriber re-renders only when the CONTENT changes). */
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

/** Do two references name the same content? (kind + project + path.) */
export function sameArtifact(a: Artifact, b: Artifact): boolean {
  return artifactIdentity(a) === artifactIdentity(b);
}

/** Position of an artifact in a strip, or -1. */
export function indexOfArtifact(artifacts: readonly Artifact[], artifact: Artifact): number {
  const id = artifactIdentity(artifact);
  return artifacts.findIndex((a) => artifactIdentity(a) === id);
}

/** Force an index into `[0, length)`; a length of 0 has no valid index and
 *  yields 0 (callers drop the strip in that case). */
export function clampActiveIndex(length: number, index: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(length - 1, Math.max(0, Math.trunc(index)));
}

/** The tab strip's label for an artifact: the LAST path segment (the file
 *  name), which is what distinguishes co-open artifacts at a glance. The full
 *  breadcrumb stays in the header — this is the 140px version of it. */
export function artifactShortTitle(artifact: Artifact): string {
  const raw = artifact.kind === "localhost" ? artifact.url : artifact.path;
  const segments = raw.split("/").filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? raw;
}

/** ACCEPTANCE 4 — append-or-activate. An artifact already in the strip
 *  ACTIVATES its tab (no duplicate, no reordering: the strip stays where the
 *  user's muscle memory left it); a new one lands at the END and becomes
 *  active. `null` state = the session has no panel yet, so this opens one. */
export function appendOrActivate(state: PanelState | null, artifact: Artifact): PanelState {
  if (!state || state.artifacts.length === 0) {
    return { artifacts: [artifact], activeIndex: 0 };
  }
  const existing = indexOfArtifact(state.artifacts, artifact);
  if (existing >= 0) {
    return existing === state.activeIndex ? state : { ...state, activeIndex: existing };
  }
  return { artifacts: [...state.artifacts, artifact], activeIndex: state.artifacts.length };
}

/** Close one tab. Returns the new state, or NULL when that was the last tab —
 *  "no panel" and "a panel showing nothing" are the same thing and only one of
 *  them is representable.
 *
 *  Index rule (the editor convention): closing a tab LEFT of the active one
 *  shifts the active one left so the same content stays on screen; closing the
 *  ACTIVE one activates its right neighbour, or the new last tab when it was
 *  rightmost. Out-of-range indices are a no-op (the state is returned
 *  unchanged), never a silent close of the wrong tab. */
export function closeArtifactIn(state: PanelState, index: number): PanelState | null {
  if (!Number.isInteger(index) || index < 0 || index >= state.artifacts.length) return state;
  if (state.artifacts.length === 1) return null;
  const artifacts = state.artifacts.filter((_, i) => i !== index);
  const next =
    index < state.activeIndex
      ? state.activeIndex - 1
      : state.activeIndex;
  return { artifacts, activeIndex: clampActiveIndex(artifacts.length, next) };
}

// ── Tolerant (de)serialization (SavedWorkspace v4) ───────────────────────────

/** Rebuild a PanelState from unknown input: every entry through the lean
 *  artifact gate, duplicates collapsed (the invariant holds for RESTORED
 *  strips too, not just live ones).
 *
 *  Returns null — i.e. DROP this session's entry — when nothing survives:
 *  an empty strip is not a panel. The active tab is preserved by CONTENT, not
 *  by number, so a dropped-out neighbour cannot silently change which artifact
 *  comes back active.
 *
 *  An `activeIndex` that names no surviving entry FALLS BACK TO THE FIRST TAB
 *  — it is not clamped to the nearest valid index. `{[A,B], activeIndex: 9}`
 *  yields 0, not 1: 9 names no content, so clamping toward B would be a guess
 *  dressed up as a rule. (The in-range `clampActiveIndex` below is a different
 *  job: keeping a LIVE index inside a strip that changed under it.) */
export function sanitizePanelState(raw: unknown): PanelState | null {
  if (!isRecord(raw) || !Array.isArray(raw.artifacts)) return null;
  const wanted =
    typeof raw.activeIndex === "number" && Number.isFinite(raw.activeIndex)
      ? Math.trunc(raw.activeIndex)
      : 0;
  const artifacts: Artifact[] = [];
  let activeIndex = 0;
  raw.artifacts.forEach((entry, i) => {
    const clean = sanitizeArtifact(entry);
    if (!clean) return;
    const existing = indexOfArtifact(artifacts, clean);
    const at = existing >= 0 ? existing : artifacts.push(clean) - 1;
    if (i === wanted) activeIndex = at;
  });
  if (artifacts.length === 0) return null;
  return { artifacts, activeIndex: clampActiveIndex(artifacts.length, activeIndex) };
}

/** Tolerant parse of a persisted v4 panels record (like pins: a broken entry
 *  must not eat the rest). Non-record input → empty; entries with an empty key
 *  or an unusable state are dropped individually. */
export function parsePanels(raw: unknown): Record<string, PanelState> {
  if (!isRecord(raw)) return {};
  const out: Record<string, PanelState> = {};
  for (const [sessionId, value] of Object.entries(raw)) {
    if (sessionId.length === 0) continue;
    const state = sanitizePanelState(value);
    if (state) out[sessionId] = state;
  }
  return out;
}

/** v3 → v4, additive and lossless: a v3 entry is a single `Artifact` and
 *  becomes a one-tab strip. Same tolerance as parsePanels — a garbage entry is
 *  dropped alone. (Kept as its own function rather than folded into
 *  parsePanels: a v4 blob whose entry is somehow a bare Artifact is CORRUPT,
 *  not old, and silently accepting both shapes forever would hide that.) */
export function parsePanelsV3(raw: unknown): Record<string, PanelState> {
  if (!isRecord(raw)) return {};
  const out: Record<string, PanelState> = {};
  for (const [sessionId, value] of Object.entries(raw)) {
    if (sessionId.length === 0) continue;
    const artifact = sanitizeArtifact(value);
    if (artifact) out[sessionId] = { artifacts: [artifact], activeIndex: 0 };
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
  panels: ReadonlyMap<string, PanelState>
): Record<string, PanelState> {
  const out: Record<string, PanelState> = {};
  for (const [sessionId, value] of panels) {
    const state = sanitizePanelState(value);
    if (sessionId.length > 0 && state) out[sessionId] = state;
  }
  return out;
}

/** Remap panel keys through the workspace-restore session idMap. A panel
 *  whose old sessionId has no restored counterpart is DROPPED — unlike a
 *  thread (which is severed and stays revivable), a panel binding without its
 *  tab is meaningless. Pass an empty map on fresh starts to drop everything. */
export function remapPanels(
  panels: Record<string, PanelState>,
  idMap: Map<string, string>
): Record<string, PanelState> {
  const out: Record<string, PanelState> = {};
  for (const [oldId, state] of Object.entries(panels)) {
    const newId = idMap.get(oldId);
    if (newId) out[newId] = state;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/** Snapshot consumed by the panel UI (useSyncExternalStore). */
export type PanelsView = {
  panels: ReadonlyMap<string, PanelState>;
  panelWidth: number;
};

let panels = new Map<string, PanelState>();
let panelWidth = DEFAULT_PANEL_WIDTH;

/** Per-tab memory of the LAST STRIP a panel showed, written when the panel
 *  goes away so Ctrl+Shift+P can bring it back (A3 — the chord is a real
 *  toggle now that an open path exists). Increment B widens it from one
 *  artifact to the whole PanelState: the chord hides and restores the PANEL,
 *  so restoring one tab of the three that were open would be a lossy toggle.
 *
 *  Deliberately NOT persisted: it is session-lifetime UI memory, not workspace
 *  state. `panels` already restores what was OPEN at quit (workspace v4);
 *  restoring what was closed hours ago would resurrect content the user
 *  explicitly dismissed. Dies with the tab (removeSessionPanel) and with the
 *  process. (Verify with `serializePanels` / `getPanelsRecord` — neither
 *  reads this map.) */
let lastPanelStates = new Map<string, PanelState>();

/** The ACTIVE TAB's session id, published by App (§Active-tab bridge below). */
let activeTabSessionId: string | null = null;

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

/** A session's ACTIVE panel identity, or `""` when the tab has no panel open. */
export function panelIdentityFor(sessionId: string | null): string {
  const artifact = sessionId ? artifactFor(sessionId) : null;
  return artifact ? artifactIdentity(artifact) : "";
}

/** Narrow selector: WHAT is open in this session's (tab's) panel, as an
 *  identity string (`""` = nothing). App subscribes through this so it
 *  re-renders when the content changes or the panel opens/closes — but NOT on
 *  every divider-drag frame, which mutates panelWidth ~60x/sec. */
export function usePanelIdentity(sessionId: string | null): string {
  return useSyncExternalStore(subscribe, () => panelIdentityFor(sessionId));
}

/** The ACTIVE artifact in a session's (tab's) panel, or null when the panel is
 *  closed. Unchanged name and shape on purpose: agentContext's spawn line, the
 *  side-menu highlighting and `usePanelIdentity` all mean "what the panel is
 *  SHOWING", which is exactly the active tab. Use `panelStateFor` for the
 *  whole strip. */
export function artifactFor(sessionId: string): Artifact | null {
  const state = panels.get(sessionId);
  if (!state || state.artifacts.length === 0) return null;
  return state.artifacts[clampActiveIndex(state.artifacts.length, state.activeIndex)] ?? null;
}

/** A session's whole tab strip, or null when the panel is closed. The strip is
 *  frozen by convention (every mutator REPLACES it), so callers may hold it as
 *  a snapshot. */
export function panelStateFor(sessionId: string | null): PanelState | null {
  if (!sessionId) return null;
  return panels.get(sessionId) ?? null;
}

export function getPanelWidth(): number {
  return panelWidth;
}

/** Current panels as a lean plain record — buildSavedWorkspace's source. */
export function getPanelsRecord(): Record<string, PanelState> {
  return serializePanels(panels);
}

/** Seed the store at boot from the migrated workspace blob (both arguments
 *  already tolerant-parsed by migrateSavedWorkspace, but the lean gate runs
 *  again here — every load path funnels through sanitizeArtifact). */
export function initPanelStore(
  initial: Record<string, PanelState>,
  width: number = DEFAULT_PANEL_WIDTH
): void {
  panels = new Map(Object.entries(parsePanels(initial)));
  // Seeding is a fresh start for the toggle memory too: `lastPanelStates` is
  // keyed by session ids belonging to the workspace being replaced, so
  // carrying it across a re-seed could reopen an artifact into a stranger's
  // tab. (Boot calls this exactly once, before any open — this is a guard, not
  // a live path.)
  lastPanelStates = new Map();
  panelWidth = clampPanelWidth(width);
  bump();
}

/** Open an artifact in a session's panel: APPEND a tab, or ACTIVATE the tab
 *  that already holds this content (acceptance 4 — one document, one live
 *  record). Opening into a session with no panel opens the panel.
 *
 *  Name and signature are unchanged from Phase A because every caller means
 *  the same thing by it ("show me this, here"); only the "one artifact per
 *  tab, replace" half of the old contract is gone.
 *
 *  A HIDDEN panel still owns its strip. Ctrl+Shift+P files the whole strip
 *  into `lastPanelStates` and deletes the live entry, so a tab with a hidden
 *  panel is ABSENT from `panels` while very much still having one. Reading
 *  only `panels` here started a fresh one-tab strip on top of it — and the
 *  next Ctrl+Shift+P then filed THAT over the memory, destroying the hidden
 *  tabs for good:
 *
 *    open A,B,C → Ctrl+Shift+P (memory {[A,B,C],2}) → click D in the tree
 *    (panel shows ONLY D) → Ctrl+Shift+P (memory := {[D],0}) → A,B,C gone.
 *
 *  That is exactly the loss the widened memory (see `lastPanelStates`) exists
 *  to prevent, so opening into a hidden panel REVIVES its strip and appends
 *  to it — the same strip the chord would have brought back. */
export function openInPanel(sessionId: string, artifact: Artifact): void {
  if (sessionId.length === 0) return;
  // Picking an artifact ENDS the pick — including the case below where the
  // chosen artifact is already the active tab and nothing else changes. Left
  // to the component, that no-op branch would strand an open modal.
  closeArtifactPicker();
  const clean = sanitizeArtifact(artifact);
  if (!clean) return;
  const live = panels.get(sessionId) ?? null;
  const revived = live === null ? lastPanelStates.get(sessionId) ?? null : null;
  const current = live ?? revived;
  const next = appendOrActivate(current, clean);
  // `next === current` means "already the ACTIVE tab". For a live panel that
  // is a genuine no-op; for a revived one the panel must still come back on
  // screen, so only the live case returns early.
  if (next === current && revived === null) return;
  // The strip is live again — the memory is only ever for panels that are
  // currently hidden, and leaving a copy behind would let a later hide be
  // undone by a stale one.
  if (revived !== null) forgetPanel(sessionId);
  panels = new Map(panels);
  panels.set(sessionId, next);
  bump();
}

/** Switch which tab of a session's strip is showing. Out-of-range indices and
 *  no-op activations are ignored (no snapshot churn). */
export function activateArtifact(sessionId: string, index: number): void {
  const state = panels.get(sessionId);
  if (!state) return;
  if (!Number.isInteger(index) || index < 0 || index >= state.artifacts.length) return;
  if (index === state.activeIndex) return;
  panels = new Map(panels);
  panels.set(sessionId, { ...state, activeIndex: index });
  bump();
}

/** Close ONE tab of a session's strip (the strip's own `×`). Closing the last
 *  tab removes the session's panel entirely — and only THEN is the strip filed
 *  into the toggle memory, because only then is there a panel to bring back. */
export function closeArtifactAt(sessionId: string, index: number): void {
  const state = panels.get(sessionId);
  if (!state) return;
  const next = closeArtifactIn(state, index);
  if (next === state) return; // out of range — nothing happened
  panels = new Map(panels);
  if (next === null) {
    rememberPanel(sessionId, state);
    panels.delete(sessionId);
  } else {
    panels.set(sessionId, next);
  }
  bump();
}

/** Create-path inheritance (A5): a thread created while an artifact was on
 *  screen starts with THAT artifact in its OWN panel.
 *
 *  Why this exists: the spawn-time context flag (agentContext seam 1) describes
 *  the TARGET tab's panel, and a fresh tab has none — so `+ new thread` carried
 *  no context at all while revive carried the rich case. The honest fix is to
 *  make the sentence TRUE rather than to let it claim a panel that isn't open:
 *  the new thread inherits the panel you launched it from, so "panel shows X"
 *  is a fact about the new tab.
 *
 *  It is a plain per-tab open, not a link: the new tab's panel is
 *  independently closable (×, Ctrl+Shift+P) and closing either tab's panel
 *  never touches the other. `null` (nothing was open) → no-op, so a thread
 *  launched from a bare shell still starts clean.
 *
 *  Callers capture the source artifact SYNCHRONOUSLY before creating the
 *  session — the active tab flips to the new one as soon as it exists.
 *
 *  INCREMENT B: it inherits the source tab's ACTIVE artifact ONLY, never the
 *  whole strip. What the user was LOOKING AT is the honest thing to carry (and
 *  the only thing the spawn one-liner claims); cloning a six-tab strip into a
 *  brand-new thread would be a surprise, not context.
 *
 *  Returns whether the new tab now shows the inherited artifact. */
export function inheritPanel(artifact: Artifact | null, newSessionId: string): boolean {
  if (!artifact || newSessionId.length === 0) return false;
  openInPanel(newSessionId, artifact);
  const now = artifactFor(newSessionId);
  return now !== null && sameArtifact(now, artifact);
}

/** File a strip into the per-tab toggle memory (see `lastPanelStates`). */
function rememberPanel(sessionId: string, state: PanelState): void {
  lastPanelStates = new Map(lastPanelStates);
  lastPanelStates.set(sessionId, state);
}

/** Drop a tab's remembered strip. Called whenever that strip becomes LIVE
 *  again, so the invariant holds: `lastPanelStates` holds a strip only for
 *  tabs whose panel is currently hidden. */
function forgetPanel(sessionId: string): void {
  if (!lastPanelStates.has(sessionId)) return;
  lastPanelStates = new Map(lastPanelStates);
  lastPanelStates.delete(sessionId);
}

/** Close the ACTIVE tab of a session's panel (the header `×`). When it was the
 *  last tab the panel is removed entirely, REMEMBERING the strip so the toggle
 *  can bring it back. No-op when the session has no panel. */
export function closePanel(sessionId: string): void {
  const state = panels.get(sessionId);
  if (!state) return;
  closeArtifactAt(sessionId, clampActiveIndex(state.artifacts.length, state.activeIndex));
}

/** Ctrl+Shift+P — the true toggle (A3): hide the WHOLE panel (remembering the
 *  strip), or bring back the last strip this TAB showed. A no-op on a tab that
 *  has neither (which is why the status-bar chip renders only when
 *  `panelToggleAvailableFor` is true — never advertise a dead chord).
 *
 *  NOT expressed via closePanel: the chord toggles the panel, and with three
 *  artifacts open, closing one tab is not "the panel went away". */
export function togglePanel(sessionId: string | null): void {
  if (!sessionId) return;
  const open = panels.get(sessionId);
  if (open) {
    rememberPanel(sessionId, open);
    panels = new Map(panels);
    panels.delete(sessionId);
    bump();
    return;
  }
  const last = lastPanelStates.get(sessionId);
  if (!last) return;
  // Same invariant openInPanel's revive keeps: a strip that is live again is
  // no longer "remembered".
  forgetPanel(sessionId);
  panels = new Map(panels);
  panels.set(sessionId, last);
  bump();
}

/** Would Ctrl+Shift+P do anything for this tab? (open panel → hides it; no
 *  panel but a remembered strip → brings it back). */
export function panelToggleAvailableFor(sessionId: string | null): boolean {
  if (!sessionId) return false;
  return panels.has(sessionId) || lastPanelStates.has(sessionId);
}

/** Narrow selector for the status-bar chip — a boolean snapshot, so App
 *  re-renders on open/close but not on divider drags. */
export function usePanelToggleAvailable(sessionId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => panelToggleAvailableFor(sessionId));
}

/** Tab-close cleanup: the session was destroyed, its panel binding AND its
 *  toggle memory go with it (called beside unbindThreadsForSession in
 *  App.destroySession). Not expressed via closePanel — that would file the
 *  strip into `lastPanelStates` on the way out, i.e. resurrect the memory of
 *  a tab that no longer exists. */
export function removeSessionPanel(sessionId: string): void {
  // A picker asking on behalf of a tab that no longer exists would open its
  // pick into a dead session id.
  if (pickerSessionId === sessionId) closeArtifactPicker();
  const hadPanel = panels.has(sessionId);
  const hadMemory = lastPanelStates.has(sessionId);
  if (!hadPanel && !hadMemory) return;
  if (hadPanel) {
    panels = new Map(panels);
    panels.delete(sessionId);
  }
  if (hadMemory) {
    lastPanelStates = new Map(lastPanelStates);
    lastPanelStates.delete(sessionId);
  }
  bump();
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

// ─────────────────────────────────────────────────────────────────────────────
// Active-tab bridge (A3)
// ─────────────────────────────────────────────────────────────────────────────
// The side-menu trees live deep inside SideMenu and need to know WHICH TAB
// would host a panel, and what that tab currently shows. Rather than thread a
// prop through SideMenu, App publishes the active tab here — the same
// module-singleton bridge ThreadsSection gets from
// threadStore.publishSessionStatuses / registerThreadActions.
//
// It is the TAB's session id (App's `activeSessionId`), NOT the focused pane's
// (`effectiveActiveSessionId`): panel state is per-TAB (Decision 1), so a
// split "just shares the width" and moving pane focus never swaps the panel.

/** App publishes the active TAB's session id (null = no tabs open). */
export function publishActiveTabSession(sessionId: string | null): void {
  if (sessionId === activeTabSessionId) return;
  activeTabSessionId = sessionId;
  bump();
}

/** The active TAB's session id — the panel host `openArtifact` targets. */
export function getActiveTabSession(): string | null {
  return activeTabSessionId;
}

/** What the ACTIVE tab's panel currently shows — its ACTIVE artifact (null =
 *  nothing / no tab). */
export function activeTabArtifact(): Artifact | null {
  return activeTabSessionId ? artifactFor(activeTabSessionId) : null;
}

// ── Send-to-thread bridge (A4 / T8 seam 2) ───────────────────────────────────
// The `→ thread` affordances live in the panel header and — deeper still — in
// WireframeView's pin rail, while the effect (an IPC write into the terminal
// the user is focused in, plus revealing that terminal) belongs to App. Same
// module-singleton bridge as threadStore.registerThreadActions, for the same
// reason: no callback threaded through DocView into a rail row.

export type PanelActions = {
  /** TYPE text into the focused terminal. The implementation MUST NOT append
   *  a trailing \r — the Enter that sends it is the user's keystroke. */
  sendToThread: (text: string) => void;
};

let panelActions: PanelActions | null = null;

export function registerPanelActions(actions: PanelActions | null): void {
  panelActions = actions;
  bump();
}

/** Perform a send. No-op when nothing is registered (App unmounted) — callers
 *  gate on `useSendToThreadAvailable` so the affordance is DISABLED rather
 *  than silently doing nothing. */
export function sendToThread(text: string): void {
  panelActions?.sendToThread(text);
}

/** Is there anything to type into? Requires both the App-side handler and an
 *  active TAB (no tabs open ⇒ no terminal, so the affordance is dead). */
export function sendToThreadAvailable(): boolean {
  return panelActions !== null && activeTabSessionId !== null;
}

/** React hook for the `→ thread` affordances' disabled state. Boolean
 *  snapshot — no re-render on divider drags. */
export function useSendToThreadAvailable(): boolean {
  return useSyncExternalStore(subscribe, sendToThreadAvailable);
}

// ── `+` picker request (2026-08-02) ──────────────────────────────────────────
// WHICH TAB is currently asking for the artifact picker. It lives in the store
// rather than in ArtifactPanel's local state because the picker now has TWO
// callers with different starting conditions:
//
//   · the tab strip's `+`, which by definition has a panel behind it; and
//   · the TAB BAR's panel button, pressed on a tab with NO artifacts — where
//     the panel renders nothing at all, so a component-local flag inside it
//     could never be set from outside.
//
// Keyed by session so the request is per-TAB like everything else here: a tab
// switch cannot inherit another tab's open modal, and picking always adds to
// the panel that asked. The picker itself is `position: fixed`, so it needs no
// panel behind it to be visible.
let pickerSessionId: string | null = null;

/** Ask this tab's panel to show the `+` picker. */
export function openArtifactPicker(sessionId: string): void {
  if (sessionId.length === 0 || pickerSessionId === sessionId) return;
  pickerSessionId = sessionId;
  bump();
}

/** Dismiss the picker (Esc, backdrop click, tab switch, or a completed pick).
 *  No-op when nothing is asking. */
export function closeArtifactPicker(): void {
  if (pickerSessionId === null) return;
  pickerSessionId = null;
  bump();
}

/** Is the picker open FOR THIS TAB? */
export function artifactPickerOpenFor(sessionId: string | null): boolean {
  return sessionId !== null && pickerSessionId === sessionId;
}

/** Narrow selector — a boolean snapshot, so no re-render per divider frame. */
export function useArtifactPickerOpen(sessionId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => artifactPickerOpenFor(sessionId));
}

/** React hook: the active tab's panel artifact. The side-menu trees subscribe
 *  through this so their active-row highlight follows the PANEL (what's
 *  actually on screen beside the shell) and re-resolves on a tab switch.
 *
 *  Snapshot identity is stable — an artifact is a frozen record living inside
 *  a strip that mutators REPLACE rather than edit, so reading it out of the
 *  array twice yields the same reference and useSyncExternalStore never
 *  loops. */
export function useActiveTabArtifact(): Artifact | null {
  return useSyncExternalStore(subscribe, activeTabArtifact);
}

// ─────────────────────────────────────────────────────────────────────────────
// Open-in-panel routing (A3 — architecture §"Open-in-panel routing", Decision 2)
// ─────────────────────────────────────────────────────────────────────────────
// ONE helper owns "does this click open a panel or navigate full-width", and
// both tree sections call it. The DECISION is pure (a discriminated result,
// unit-tested across every screen × modifier × active-session cell); the
// effects — store write, navigation — live in the thin wrapper below.

/** The artifact kinds a Phase A click can open. `localhost` is excluded by
 *  type: it has no full-width screen to navigate to (Phase B), so including it
 *  would make `fullWidthRoute` partial for no gain. */
export type OpenableArtifact = Extract<Artifact, { kind: "kb-doc" | "repo-file" }>;

/** Everything the decision depends on. Passed explicitly so the rule is
 *  testable without a route store, a window, or a session list. */
export type OpenContext = {
  /** The route screen currently on display. */
  screen: ScreenId;
  /** The ACTIVE TAB's session id — the panel's host. null = no tabs open. */
  sessionId: string | null;
  /** Ctrl (or ⌘) held during the click — inverts whatever would happen. */
  modifier: boolean;
};

export type OpenDecision =
  | {
      action: "panel";
      sessionId: string;
      artifact: OpenableArtifact;
      /** The panel only renders on the terminal screen, so a forced
       *  (Ctrl+click) open from kb/explorer must ALSO switch screens —
       *  otherwise the click writes into a surface the user cannot see and
       *  reads as a no-op. False on the common terminal-screen path. */
      revealTerminal: boolean;
    }
  | { action: "navigate"; route: Route };

/** The full-width screen route for an artifact — the "open full" crossover and
 *  the navigate branch of the decision both mean exactly this. */
export function fullWidthRoute(target: OpenableArtifact): Route {
  switch (target.kind) {
    case "kb-doc":
      return { screen: "kb", doc: target.path };
    case "repo-file":
      return { screen: "explorer", project: target.project, path: target.path };
  }
}

/** PURE decision (Decision 2):
 *
 *  | screen         | modifier | active session | result            |
 *  |----------------|----------|----------------|-------------------|
 *  | terminal       | off      | yes            | panel             |
 *  | terminal       | off      | no             | navigate          |
 *  | terminal       | on       | either         | navigate          |
 *  | kb / explorer  | off      | either         | navigate          |
 *  | kb / explorer  | on       | yes            | panel (+ reveal)  |
 *  | kb / explorer  | on       | no             | navigate          |
 *
 *  In words: the terminal screen opens in the panel (the co-present common
 *  case), the reading screens navigate full-width (today's behavior), the
 *  modifier inverts either one, and NO active session always means navigate —
 *  a panel with no tab to host it is impossible, not a silent no-op. */
export function decideOpen(target: OpenableArtifact, ctx: OpenContext): OpenDecision {
  const wantsPanel = ctx.screen === "terminal" ? !ctx.modifier : ctx.modifier;
  if (wantsPanel && ctx.sessionId) {
    return {
      action: "panel",
      sessionId: ctx.sessionId,
      artifact: target,
      revealTerminal: ctx.screen !== "terminal",
    };
  }
  return { action: "navigate", route: fullWidthRoute(target) };
}

/** Effects for a decision. Split out so the decision can be asserted without
 *  performing it (and so a caller with its own context — a future command
 *  palette — can reuse the executor). */
export function applyOpenDecision(decision: OpenDecision): void {
  if (decision.action === "navigate") {
    navigate(decision.route);
    return;
  }
  // Content first, screen second: the terminal screen paints with the panel
  // already holding the right artifact instead of flashing the previous one.
  openInPanel(decision.sessionId, decision.artifact);
  if (decision.revealTerminal) navigate({ screen: "terminal" });
}

/** THE open path (both tree sections call this): decide from the live route +
 *  active tab, then perform it. Returns the decision so callers can react to
 *  it (and so it reads honestly in tests). */
export function openArtifact(
  target: OpenableArtifact,
  opts: { modifier?: boolean } = {}
): OpenDecision {
  const decision = decideOpen(target, {
    screen: getNavState().route.screen,
    sessionId: getActiveTabSession(),
    modifier: opts.modifier ?? false,
  });
  applyOpenDecision(decision);
  return decision;
}

/** Test-only: reset the store to a blank state. */
export function __resetPanelStoreForTests(): void {
  panels = new Map();
  lastPanelStates = new Map();
  activeTabSessionId = null;
  panelActions = null;
  pickerSessionId = null;
  panelWidth = DEFAULT_PANEL_WIDTH;
  cachedView = null;
  listeners.clear();
}
