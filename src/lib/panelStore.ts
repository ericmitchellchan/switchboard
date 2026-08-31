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
import type { AgentStatus, Artifact, PanelState, Route, ScreenId } from "../types";
import { getNavState, navigate } from "./route";
// PURE helper only (no store state crosses this seam, and devServer imports
// nothing but React, so there is no cycle): "which server is this URL?" is
// decided in ONE place, and the panel's dedupe has to agree with the
// detector's or a URL that was not offered twice can still open twice.
import { serverKey } from "./devServer";
// TYPE-ONLY, and deliberately so: the icon vocabulary is named here and DRAWN
// in components/icons.tsx, and a type import is erased at build time — this
// store keeps zero runtime dependency on React components (its tests import it
// in a plain node environment).
import type { IconName } from "../components/icons";
import { log } from "./logger";
import { surfaceLabel } from "../surfaces/registry";

// ─────────────────────────────────────────────────────────────────────────────
// REMOVAL AUDIT (2026-08-02)
// ─────────────────────────────────────────────────────────────────────────────
// Eric watched a markdown doc leave the panel by itself a few times and then
// stop; he could not tie it to an action and it is NOT reproducible. A guess
// at the cause would have been a second defect plus false confidence, so the
// next occurrence is made SELF-EXPLAINING instead: every path that takes an
// artifact out of a strip, or drops a strip, says so with a REASON.
//
// The reason vocabulary is closed on purpose. "It closed" is what Eric can
// see; the whole value here is telling an INTENDED close (`user-close`) apart
// from a mystery one (`sanitize-dropped-invalid`, `remap-unmapped-tab`,
// `store-reseeded`) without having to reason backwards from a stack trace.
//
// STORE INSTANCE — the one thing a removal log alone could never catch.
// `panels` is a module singleton, so if this MODULE is ever evaluated twice
// the strip does not get emptied, it gets REPLACED by a fresh empty map, and
// no removal function runs at all. That is a real possibility in dev: a Vite
// HMR update to this file (or to anything below it in the graph) re-imports it
// under the running app, and every panel would appear to close at once with
// perfect silence. So each load stamps an instance id and every line carries
// it: two different instance ids in one session IS the diagnosis.
const STORE_INSTANCE = Math.random().toString(36).slice(2, 8);

/** Why an artifact left a strip, or why a strip went away. */
export type PanelRemovalReason =
  /** The strip's own `×` / middle-click on an artifact tab. */
  | "user-close"
  /** The panel header's `×` (closes the ACTIVE tab). */
  | "header-close"
  /** Ctrl+Shift+P (or the tab-bar button) hid the whole strip — recoverable. */
  | "toggle-hide"
  /** The host TAB was destroyed (App.destroySession). */
  | "session-destroyed"
  /** initPanelStore replaced the whole store (boot / re-seed). */
  | "store-reseeded"
  /** An entry failed `sanitizeArtifact` on a load/save path. */
  | "sanitize-dropped-invalid"
  /** A persisted strip was unusable and its whole entry was dropped. */
  | "parse-dropped-strip"
  /** A live strip failed re-sanitizing on the way OUT to the workspace blob. */
  | "serialize-dropped-strip"
  /** Workspace restore: the strip's tab has no restored counterpart. */
  | "remap-unmapped-tab"
  /** Workspace restore: a `session` artifact's session did not come back. */
  | "remap-unmapped-session"
  /** The last artifact left, so the strip itself went away. */
  | "strip-emptied"
  /** A panel terminal was opened in ANOTHER tab's strip, which takes it. */
  | "session-taken"
  /** `parkPanelSession` — the view is taken away, ownership retained. */
  | "session-parked"
  /** `releasePanelSession` — the panel stops owning the session entirely. */
  | "session-released"
  /** `promote to tab` — the SAME park+release pair, but a MOVE, not a loss. */
  | "promote-move"
  /** A plain open REPLACED the preview tab in place (SWIT-47, R3 rule 2).
   *  The replaced artifact went onto the strip's preview back stack. */
  | "preview-replace";

export interface PanelRemoval {
  reason: PanelRemovalReason;
  /** The TAB whose strip lost something ("" when the path is not per-tab). */
  tab: string;
  /** The artifact, named enough to recognize (kind + path/url/sessionId). */
  artifact: string;
  /** Anything else that distinguishes this occurrence. */
  note: string;
}

/** Name an artifact for a log line: KIND plus the one field that identifies it
 *  to a human reading the console. Tolerant of malformed input — this runs on
 *  the paths that exist BECAUSE input can be malformed. */
export function auditName(raw: unknown): string {
  if (!isRecord(raw)) return `<${typeof raw}>`;
  const kind = typeof raw.kind === "string" ? raw.kind : "?";
  const field =
    typeof raw.path === "string"
      ? raw.path
      : typeof raw.url === "string"
        ? raw.url
        : typeof raw.sessionId === "string"
          ? raw.sessionId
          : "?";
  const project = typeof raw.project === "string" ? `${raw.project}/` : "";
  return `${kind}:${project}${field}`;
}

/** THE one line format. Pure, so the wording is testable without a logger. */
export function formatPanelRemoval(r: PanelRemoval): string {
  const parts = [
    "panel-remove",
    `reason=${r.reason}`,
    `store=${STORE_INSTANCE}`,
    `tab=${r.tab.length > 0 ? r.tab : "-"}`,
    `artifact=${r.artifact.length > 0 ? r.artifact : "-"}`,
  ];
  if (r.note.length > 0) parts.push(`note=${r.note}`);
  return parts.join(" ");
}

/** Vitest transforms this module exactly as Vite does, so the mode flag is
 *  readable in both. Under test the audit is SILENT by default: several suites
 *  feed deliberately-invalid fixtures through `sanitizePanelState`, and a
 *  console line per rejected fixture is noise, not evidence. */
const UNDER_TEST = import.meta.env?.MODE === "test";

/** Where audit lines go. `null` = the app logger (info level: one line per
 *  removal, which is an ACTION, not a tick — it will not drown a dev console).
 *  Tests install their own via `__setPanelAuditSink`. */
let auditSink: ((line: string) => void) | null = UNDER_TEST ? () => {} : null;

/** Test-only: capture (or silence) audit lines. */
export function __setPanelAuditSink(sink: ((line: string) => void) | null): void {
  auditSink = sink;
}

function audit(
  reason: PanelRemovalReason,
  tab: string,
  artifact: unknown,
  note = ""
): void {
  const line = formatPanelRemoval({
    reason,
    tab,
    artifact: typeof artifact === "string" ? artifact : auditName(artifact),
    note,
  });
  if (auditSink) auditSink(line);
  else log.info(line);
}

/** Every artifact in a strip, named. Used when a WHOLE strip goes away — the
 *  point of the log is to say what was on screen, not merely that a panel
 *  vanished. */
function auditNames(state: PanelState | null | undefined): string {
  if (!state || state.artifacts.length === 0) return "-";
  return state.artifacts.map((a) => auditName(a)).join(",");
}

// This is the line that distinguishes "a strip was emptied" from "this module
// was evaluated again and took the whole store with it". One per load — a
// SECOND one inside a single app session is the diagnosis by itself.
if (!UNDER_TEST) log.info(`panel-store loaded instance=${STORE_INSTANCE}`);

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

/** Divider drag → new stored width. On the RIGHT side the panel is anchored
 *  to the workspace container's right edge with the divider immediately left
 *  of it, so the width that puts the divider's left edge under the cursor is
 *  `containerRight - clientX - DIVIDER_WIDTH`; on the LEFT side (SWIT-33) the
 *  panel spans from the container's left edge to the divider, so it is
 *  `clientX - containerLeft`. Capped by the same
 *  terminal-side floor panelLayoutFor enforces, then clamped into
 *  [MIN_PANEL_WIDTH, MAX_PANEL_WIDTH]. */
export function panelWidthFromDrag(
  containerLeft: number,
  containerWidth: number,
  clientX: number,
  /** Which side the panel is on (SWIT-33): right = the panel spans from the
   *  divider to the container's right edge; left = from the container's left
   *  edge to the divider, so dragging RIGHT widens it. */
  side: PanelSide = "right"
): number {
  const raw =
    side === "left"
      ? clientX - containerLeft
      : containerLeft + containerWidth - clientX - DIVIDER_WIDTH;
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
    case "surface": {
      // `project › pages › Page` — the same shape the side-menu tree draws
      // (wireframe shell-v0, screen 1). The page LABEL comes from the surface
      // registry; an unregistered page prints its id so the strip still
      // names something honest.
      const label = surfaceLabel(artifact.project, artifact.page);
      return {
        icon: "surface",
        crumbs: [
          { text: artifact.project, tone: "lead" },
          { text: "pages", tone: "dim" },
          { text: label, tone: "bright" },
        ],
        title: `${artifact.project} / pages / ${label}`,
      };
    }
    case "session": {
      // A SESSION has no path — its name is the tab name Eric gave it, which
      // lives in App's session list, not here. `sessionLabelFor` is the
      // published view of that list (§Session labels): one lookup, so the tab
      // strip, the header and the picker all say the same word.
      const label = sessionLabelFor(artifact.sessionId);
      const name = label?.name ?? "terminal";
      return {
        icon: SESSION_ICON,
        crumbs: [
          { text: "terminal", tone: "dim" },
          { text: name, tone: "bright" },
        ],
        title: `terminal / ${name}`,
      };
    }
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

/** A LIVE SHELL hosted by the panel (increment H) — the tab strip, the panel
 *  header and the `+` picker's terminal rows. One vocabulary, one mark. */
export const SESSION_ICON: IconName = "terminal";

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
    case "surface":
      // SWIT-30. Two ids and nothing else — whether the pair still names a
      // registered page is the HOST's question at render time, not a load
      // gate: a strip must not lose a tab because a project renamed a page.
      return isNonEmptyString(raw.project) && isNonEmptyString(raw.page)
        ? { kind: "surface", project: raw.project, page: raw.page }
        : null;
    case "session":
      // Increment H. The id is the WHOLE record — everything else about the
      // session (name, cwd, status, scrollback) lives where sessions live, so
      // there is nothing here to go stale.
      return isNonEmptyString(raw.sessionId) ? { kind: "session", sessionId: raw.sessionId } : null;
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
      // BY SERVER, NOT BY URL STRING (2026-08-02). One dev server announces
      // itself in more than one spelling — lodestar's dev script prints
      // `http://localhost:5273` and vite then prints `http://127.0.0.1:5273/`
      // for that same vite — and two spellings of one server defeated every
      // dedupe downstream: the strip appended a second tab, the offer chip
      // came back for a server already framed. `serverKey` folds the loopback
      // host and nothing else, so two ROUTES on one server are still two
      // artifacts (which is what the positional-pin scoping requires).
      // The artifact keeps its own `url` — only the comparison folds.
      return `localhost:${artifact.project}:${serverKey(artifact.url)}`;
    case "surface":
      return `surface:${artifact.project}:${artifact.page}`;
    case "session":
      // The session id IS the identity. Two references to one session are one
      // artifact, which is what makes the dedupe rule enforce the one-live-view
      // invariant rather than merely coexist with it.
      return `session:${artifact.sessionId}`;
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
  // A session's short title is its SESSION NAME (the tab name), not a path —
  // read through the same published label the header uses so the strip and the
  // header can never disagree about what a terminal is called.
  if (artifact.kind === "session") return sessionLabelFor(artifact.sessionId)?.name ?? "terminal";
  // A surface's short title is its page LABEL (the same word the header's
  // last crumb prints), not a path — it has none.
  if (artifact.kind === "surface") return surfaceLabel(artifact.project, artifact.page);
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
export function sanitizePanelState(raw: unknown, tab = ""): PanelState | null {
  if (!isRecord(raw) || !Array.isArray(raw.artifacts)) return null;
  const wanted =
    typeof raw.activeIndex === "number" && Number.isFinite(raw.activeIndex)
      ? Math.trunc(raw.activeIndex)
      : 0;
  const artifacts: Artifact[] = [];
  let activeIndex = 0;
  raw.artifacts.forEach((entry, i) => {
    const clean = sanitizeArtifact(entry);
    if (!clean) {
      // An artifact that FAILED validation and silently disappeared is the
      // single most plausible shape of "it closed by itself" on a load path.
      audit("sanitize-dropped-invalid", tab, entry, `index=${i}`);
      return;
    }
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
    const state = sanitizePanelState(value, sessionId);
    if (state) out[sessionId] = state;
    else audit("parse-dropped-strip", sessionId, "-", "load=v4");
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
    else audit("sanitize-dropped-invalid", sessionId, value, "migrate=v3");
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
    const state = sanitizePanelState(value, sessionId);
    if (sessionId.length > 0 && state) out[sessionId] = state;
    else {
      // A LIVE strip that cannot survive its own serializer would come back
      // missing after the next restart, with nothing on screen to explain it.
      audit("serialize-dropped-strip", sessionId, auditNames(value), "save");
    }
  }
  return out;
}

/** Remap panel keys through the workspace-restore session idMap. A panel
 *  whose old sessionId has no restored counterpart is DROPPED — unlike a
 *  thread (which is severed and stays revivable), a panel binding without its
 *  tab is meaningless. Pass an empty map on fresh starts to drop everything.
 *
 *  INCREMENT H — the same idMap also rewrites the CONTENT of a `session`
 *  artifact. Its `sessionId` names a tab that was respawned under a fresh id
 *  exactly like the key was, and a session artifact pointing at a dead id would
 *  render an empty body forever. An entry whose session did not come back is
 *  dropped (same rule as an unmapped key), and a strip left with nothing is
 *  dropped whole — an empty strip is not a panel. */
export function remapPanels(
  panels: Record<string, PanelState>,
  idMap: Map<string, string>
): Record<string, PanelState> {
  const out: Record<string, PanelState> = {};
  for (const [oldId, state] of Object.entries(panels)) {
    const newId = idMap.get(oldId);
    if (!newId) {
      audit("remap-unmapped-tab", oldId, auditNames(state), "restore");
      continue;
    }
    const remapped = remapPanelState(state, idMap, oldId);
    if (remapped) out[newId] = remapped;
    else audit("strip-emptied", oldId, auditNames(state), "restore");
  }
  return out;
}

/** One strip through the idMap: session artifacts rewritten or dropped,
 *  everything else untouched, the active tab preserved BY CONTENT (same rule
 *  sanitizePanelState follows). Returns null when nothing survives. */
function remapPanelState(
  state: PanelState,
  idMap: Map<string, string>,
  tab = ""
): PanelState | null {
  const activeBefore = state.artifacts[clampActiveIndex(state.artifacts.length, state.activeIndex)];
  const artifacts: Artifact[] = [];
  let activeIndex = 0;
  for (const artifact of state.artifacts) {
    let next: Artifact | null = artifact;
    if (artifact.kind === "session") {
      const mapped = idMap.get(artifact.sessionId);
      next = mapped ? { kind: "session", sessionId: mapped } : null;
      if (!next) audit("remap-unmapped-session", tab, artifact, "restore");
    }
    if (!next) continue;
    if (artifact === activeBefore) activeIndex = artifacts.length;
    artifacts.push(next);
  }
  if (artifacts.length === 0) return null;
  return { artifacts, activeIndex: clampActiveIndex(artifacts.length, activeIndex) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/** Snapshot consumed by the panel UI (useSyncExternalStore). */
export type PanelsView = {
  panels: ReadonlyMap<string, PanelState>;
  panelWidth: number;
};

// ── OWNER KEYS — the panel is per-THREAD now (SWIT-47) ───────────────────────
// Every public function still takes a SESSION id (the tab is what callers
// hold), but the maps key on an OWNER KEY:
//
//   `t:<threadId>`  — the session is bound to a thread. The panel follows the
//                     THREAD: across an app restart (thread ids are durable,
//                     so workspace v6 needs no key remap at all) and across a
//                     revive into a fresh session.
//   `s:<sessionId>` — a plain shell. Its panel is TRANSIENT: never persisted,
//                     dies with the session (decided Q1/R1 — a shell is not a
//                     thread).
//
// The resolver is INJECTED (App wires findThreadBySessionId) so this store
// keeps importing nothing of threadStore. A null resolver (tests, boot before
// wiring) keys everything `s:` — exactly the pre-SWIT-47 behavior.
//
// A binding that forms MID-SESSION (a shell promoted on `claude`, a revive
// binding a fresh session) changes what a session's key RESOLVES to, so App
// calls `notePanelThreadBinding` at every bind site and the store MOVES the
// `s:` entries to the thread key. A binding that DISSOLVES (supersede) does
// not move anything back: the strip stays filed under the OLD thread — a
// panel is per-thread, and the superseded conversation keeps its context for
// its revive. The tab starts a fresh panel, which is what "a new conversation"
// means here.

let threadKeyResolver: ((sessionId: string) => string | null) | null = null;

/** App wires the session→thread lookup once, at module scope. */
export function setPanelThreadResolver(
  resolver: ((sessionId: string) => string | null) | null
): void {
  threadKeyResolver = resolver;
}

/** The map key a session's panel lives under. */
function ownerKeyFor(sessionId: string): string {
  const threadId = threadKeyResolver?.(sessionId) ?? null;
  return threadId ? `t:${threadId}` : `s:${sessionId}`;
}

function isThreadKey(key: string): boolean {
  return key.startsWith("t:");
}

/** Strip the prefix for persistence (only thread keys are persisted). */
function threadIdOfKey(key: string): string {
  return key.slice(2);
}

/** A session gained a thread binding — its transient `s:` entries follow it
 *  under the thread key, so the strip it accumulated as a shell survives the
 *  promotion. No-op when there is nothing to move or no binding resolves.
 *
 *  COLLISION (SWIT-47 review finding 2): the thread may ALREADY hold a strip
 *  (a severed thread's panel survives restarts now, and a `claude --resume`
 *  in a shell that opened its own artifacts rebinds exactly here). Doing
 *  nothing stranded the shell's strip under a key nothing reads again —
 *  silent artifact loss the removal audit could not see, and a stranded
 *  SESSION artifact kept a live shell panel-owned with no strip rendering it
 *  (unreachable). So the shell's artifacts MERGE into the thread's strip,
 *  one appendOrActivate each (dedupe holds; a session artifact keeps its
 *  one-home invariant because it existed in only one strip to begin with). */
export function notePanelThreadBinding(sessionId: string): void {
  const threadId = threadKeyResolver?.(sessionId) ?? null;
  if (!threadId) return;
  const from = `s:${sessionId}`;
  const to = `t:${threadId}`;
  let changed = false;
  const moveOrMerge = (
    getFrom: () => PanelState | undefined,
    getTo: () => PanelState | undefined,
    write: (key: string, state: PanelState | null) => void,
    note: string
  ) => {
    const source = getFrom();
    if (!source) return;
    const target = getTo();
    if (!target) {
      write(to, source);
      write(from, null);
      changed = true;
      return;
    }
    let merged = target;
    for (const a of source.artifacts) merged = appendOrActivate(merged, a);
    audit("strip-emptied", from, auditNames(source), `merged-into=${to} ${note}`.trim());
    write(to, merged);
    write(from, null);
    changed = true;
  };
  moveOrMerge(
    () => panels.get(from),
    () => panels.get(to),
    (key, state) => {
      panels = new Map(panels);
      if (state) panels.set(key, state);
      else panels.delete(key);
    },
    ""
  );
  moveOrMerge(
    () => lastPanelStates.get(from),
    () => lastPanelStates.get(to),
    (key, state) => {
      lastPanelStates = new Map(lastPanelStates);
      if (state) lastPanelStates.set(key, state);
      else lastPanelStates.delete(key);
    },
    "hidden"
  );
  if (panelSides.has(from)) {
    panelSides = new Map(panelSides);
    if (!panelSides.has(to)) panelSides.set(to, "left");
    panelSides.delete(from);
    changed = true;
  }
  // Preview marks: the thread's own mark wins a collision; either way the
  // shell's transient mark is consumed.
  if (previews.has(from)) {
    previews = new Map(previews);
    if (!previews.has(to)) previews.set(to, previews.get(from)!);
    previews.delete(from);
    changed = true;
  }
  if (previewBacks.has(from)) {
    previewBacks = new Map(previewBacks);
    if (!previewBacks.has(to)) previewBacks.set(to, previewBacks.get(from)!);
    previewBacks.delete(from);
    changed = true;
  }
  if (changed) bump();
}

let panels = new Map<string, PanelState>();
let panelWidth = DEFAULT_PANEL_WIDTH;

// ── The PREVIEW slot (SWIT-47, R3's rule 2) ─────────────────────────────────
// Per owner key: WHICH strip entry is the preview (by artifact identity), and
// the back stack of artifacts it replaced. A plain tree click opens INTO the
// preview slot — the next plain click REPLACES it in place — while a pinned
// tab (picker, offer chip, Ctrl-gesture, double-click) is permanent. VS
// Code's preview-tab pattern; what stops link clicks piling tabs up.
// Deliberately NOT persisted: a restored strip comes back all-pinned (nothing
// is lost — the conservative direction), and a revived thread's preview is
// gone by design (requirements §Revive).

/** Cap on a preview back stack — bounds memory; older history just falls off. */
export const PREVIEW_BACK_CAP = 20;

let previews = new Map<string, string>();
let previewBacks = new Map<string, Artifact[]>();

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

// ── Panel SIDE per tab (SWIT-33 — Ky's SplitView "Swap", in this panel) ──────
// Right is the default and is not stored; the map holds only the tabs whose
// panel sits on the LEFT of the pane tree. Per TAB, like the strip itself,
// and persisted with the workspace (`panelSides`) so a flipped tab comes back
// flipped. Not part of PanelState on purpose: every strip op builds a fresh
// PanelState literal, and threading a `side` field through all of them would
// be a dozen places to forget — while the side is one bit that outlives the
// strip (a tab keeps its side across close + Ctrl+Shift+P reopen).
export type PanelSide = "left" | "right";
let panelSides = new Map<string, "left">();

export function panelSideFor(sessionId: string | null): PanelSide {
  return sessionId && panelSides.has(ownerKeyFor(sessionId)) ? "left" : "right";
}

export function usePanelSide(sessionId: string | null): PanelSide {
  return useSyncExternalStore(subscribe, () => panelSideFor(sessionId));
}

export function setPanelSide(sessionId: string, side: PanelSide): void {
  if (panelSideFor(sessionId) === side) return;
  const key = ownerKeyFor(sessionId);
  panelSides = new Map(panelSides);
  if (side === "left") panelSides.set(key, "left");
  else panelSides.delete(key);
  bump();
}

export function togglePanelSide(sessionId: string): void {
  setPanelSide(sessionId, panelSideFor(sessionId) === "left" ? "right" : "left");
}

/** Lean record for the workspace blob: only the left-side THREAD panels,
 *  keyed by thread id (a shell's side is transient, like its strip). */
export function getPanelSidesRecord(): Record<string, "left"> {
  const out: Record<string, "left"> = {};
  for (const key of panelSides.keys()) {
    if (isThreadKey(key)) out[threadIdOfKey(key)] = "left";
  }
  return out;
}

/** Tolerant parse of a saved `panelSides` record: keeps `"left"` entries with
 *  non-empty keys, drops everything else — a stranger value is "right". */
export function parsePanelSides(raw: unknown): Record<string, "left"> {
  const out: Record<string, "left"> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (key.length > 0 && value === "left") out[key] = "left";
  }
  return out;
}

/** Seed at boot (with initPanelStore); a re-seed replaces the whole map. The
 *  blob's keys are THREAD ids (workspace v6), wrapped into thread owner keys
 *  here. */
export function initPanelSides(initial: unknown): void {
  panelSides = new Map(
    Object.keys(parsePanelSides(initial)).map((threadId) => [`t:${threadId}`, "left" as const])
  );
  bump();
}

/** The ACTIVE TAB's session id, published by App (§Active-tab bridge below). */
let activeTabSessionId: string | null = null;

/** PARKED panel terminals (increment H): sessions the panel OWNS that have no
 *  view right now.
 *
 *  Two things live here, and they are the same state:
 *   · "keep it running" from the close guard — the tab closes, the shell keeps
 *     going, and the `+` picker lists it under RUNNING TERMINALS so it can be
 *     brought back into any tab's panel; and
 *   · the ONE COMMIT in the middle of `promote to tab` / `kill`, during which
 *     the artifact is already out of the strip (the panel has unmounted the
 *     terminal) but ownership has NOT yet been released (so the pane tree
 *     cannot mount it). That is what makes "one live view throughout the move"
 *     structural rather than a matter of React's commit ordering.
 *
 *  Deliberately NOT persisted: after a restart every restored session is a
 *  FRESH shell (the process died with the app), so a parked one has nothing
 *  left to keep running and comes back as an ordinary tab. Persisting the set
 *  would hide a brand-new empty shell behind a picker row. */
let parkedSessions = new Set<string>();

const listeners = new Set<() => void>();

// THE SNAPSHOT CONTRACT — and the black window that came of breaking it.
//
// `useSyncExternalStore` compares the OLD and NEW snapshot with `Object.is`.
// A snapshot that is freshly ALLOCATED every time it is asked for is therefore
// a snapshot that CHANGED every time it is asked for, and the store reports a
// change on every bump whether or not anything moved.
//
// That was survivable while App only subscribed through snapshots that are
// VALUES (`usePanelIdentity` returns a string). Increment H added
// `usePanelOwnedSessions()` to App — a freshly built `Set` — at the same time
// as `handlePromotePanelTerminal`, a `useCallback` that depends on
// `usePaneLayout()`'s return object. The two closed a cycle:
//
//   render → new paneLayout object → the handler's identity changes →
//   App's `registerPanelActions` effect re-runs → its CLEANUP calls
//   `registerPanelActions(null)` → bump() → a brand-new owned-sessions Set →
//   App re-renders → …
//
// unbounded, until React threw "Maximum update depth exceeded" from App's own
// commit phase. That throw is ABOVE every `ScreenErrorBoundary` (they are
// per-screen, mounted inside App), so React unmounted the entire tree and the
// window painted nothing at all.
//
// `usePaneLayout` is memoized now, which breaks the cycle at the other end.
// This end is the one that has to hold anyway: a store is not allowed to say
// "something changed" when nothing did. So the caches below are INVALIDATED by
// bump but REBUILT THROUGH A CONTENT COMPARE — an unchanged derivation keeps
// its previous reference, and a bump that changed nothing is silent to React.
let cachedView: PanelsView | null = null;
let cachedOwnedSessions: ReadonlySet<string> | null = null;
let cachedParkedSessions: readonly string[] | null = null;
let viewDirty = true;
let ownedSessionsDirty = true;
let parkedSessionsDirty = true;

function bump(): void {
  viewDirty = true;
  ownedSessionsDirty = true;
  parkedSessionsDirty = true;
  for (const l of listeners) l();
}

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The raw subscription, beyond the hooks. Exported for the same reason
 *  pinsStore exports `subscribeToPins`: WHETHER a mutation notifies is part of
 *  the contract (a silent one leaves every subscriber painting stale state),
 *  and it is invisible from the accessors alone. Not used by app code — the
 *  hooks are. */
export function subscribeToPanelStore(listener: () => void): () => void {
  return subscribe(listener);
}

export function getPanelsView(): PanelsView {
  // No defensive copy: every mutator below REPLACES `panels` with a fresh
  // Map rather than mutating in place, so the map a cached view holds is
  // already frozen in practice — copying it again just doubled the
  // allocation on every store change. That copy-on-write discipline is also
  // what makes IDENTITY a faithful content test here (see the snapshot
  // contract above): a bump that did not touch the map or the width returns
  // the SAME view object, and React bails out of the re-render.
  const prev = cachedView;
  if (!prev) {
    viewDirty = false;
    cachedView = { panels, panelWidth };
    return cachedView;
  }
  if (viewDirty) {
    viewDirty = false;
    if (prev.panels !== panels || prev.panelWidth !== panelWidth) {
      cachedView = { panels, panelWidth };
      return cachedView;
    }
  }
  return prev;
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
  const state = panels.get(ownerKeyFor(sessionId));
  if (!state || state.artifacts.length === 0) return null;
  return state.artifacts[clampActiveIndex(state.artifacts.length, state.activeIndex)] ?? null;
}

/** A session's whole tab strip, or null when the panel is closed. The strip is
 *  frozen by convention (every mutator REPLACES it), so callers may hold it as
 *  a snapshot. */
export function panelStateFor(sessionId: string | null): PanelState | null {
  if (!sessionId) return null;
  return panels.get(ownerKeyFor(sessionId)) ?? null;
}

export function getPanelWidth(): number {
  return panelWidth;
}

/** Current panels as a lean plain record — buildSavedWorkspace's source.
 *  THREAD panels only, keyed by thread id (SWIT-47): a shell's strip is
 *  transient by rule and is deliberately not written. */
export function getPanelsRecord(): Record<string, PanelState> {
  const threadPanels = new Map<string, PanelState>();
  for (const [key, state] of panels) {
    if (isThreadKey(key)) threadPanels.set(threadIdOfKey(key), state);
  }
  return serializePanels(threadPanels);
}

/** Seed the store at boot from the migrated workspace blob (both arguments
 *  already tolerant-parsed by migrateSavedWorkspace, but the lean gate runs
 *  again here — every load path funnels through sanitizeArtifact). */
export function initPanelStore(
  initial: Record<string, PanelState>,
  width: number = DEFAULT_PANEL_WIDTH
): void {
  // A re-seed REPLACES every strip. Boot calls this once; anything else
  // calling it mid-session would look exactly like "everything closed".
  for (const [tab, state] of panels) audit("store-reseeded", tab, auditNames(state));
  for (const [tab, state] of lastPanelStates) {
    audit("store-reseeded", tab, auditNames(state), "hidden");
  }
  // The blob's keys are THREAD ids (workspace v6) — wrapped into thread owner
  // keys here. Thread ids are durable, so no key remap ever applies to them;
  // only the session ARTIFACTS inside the strips go through the restore idMap
  // (remapPanelSessions).
  panels = new Map(
    Object.entries(parsePanels(initial)).map(([threadId, state]) => [`t:${threadId}`, state])
  );
  // Seeding is a fresh start for the toggle memory too: `lastPanelStates` is
  // keyed by owner keys belonging to the workspace being replaced, so
  // carrying it across a re-seed could reopen an artifact into a stranger's
  // tab. (Boot calls this exactly once, before any open — this is a guard, not
  // a live path.)
  lastPanelStates = new Map();
  // Preview marks are session-lifetime UI state (a restored strip comes back
  // all-pinned — the conservative direction; a revived thread's preview is
  // gone by design).
  previews = new Map();
  previewBacks = new Map();
  // Parked terminals are session-lifetime state and are never persisted (see
  // `parkedSessions`) — a re-seed starts with none, so a restored blob can
  // never hide a fresh shell behind a picker row.
  parkedSessions = new Set();
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
export function openInPanel(
  sessionId: string,
  artifact: Artifact,
  opts: {
    /** SWIT-47 (R3 rule 2): open INTO the preview slot — the next plain open
     *  replaces it in place. Default false = a PINNED tab (the picker, the
     *  offer chip, inheritance, `+ → new terminal` all mean "keep this").
     *  Tree/link clicks pass true through applyOpenDecision. A `session`
     *  artifact is never a preview — a live shell is not a glance. */
    preview?: boolean;
  } = {}
): void {
  if (sessionId.length === 0) {
    // Every caller of this is a USER GESTURE. Returning silently on a bad
    // argument is how a click becomes "nothing happened" with no trace, which
    // is exactly the report the removal audit above was built for — the same
    // reasoning applies to the paths that fail to OPEN.
    log.warn(`panel-open refused reason=no-tab artifact=${auditName(artifact)}`);
    return;
  }
  // Picking an artifact ENDS the pick — including the case below where the
  // chosen artifact is already the active tab and nothing else changes. Left
  // to the component, that no-op branch would strand an open modal.
  closeArtifactPicker();
  const clean = sanitizeArtifact(artifact);
  if (!clean) {
    log.warn(`panel-open refused reason=invalid-artifact artifact=${auditName(artifact)}`);
    return;
  }
  const key = ownerKeyFor(sessionId);
  if (clean.kind === "session") {
    // ONE SESSION, ONE HOME (increment H). A live shell must not be listed in
    // two strips: only one panel renders at a time, so it would not produce two
    // simultaneous views — but a tab switch would then MOVE a running terminal
    // between hosts, and both strips would claim it. Opening it here takes it
    // out of wherever it was (and out of the parked set), which is exactly what
    // "the panel that holds it" should mean.
    dropSessionArtifact(clean.sessionId, key, "session-taken", `to=${key}`);
    if (parkedSessions.has(clean.sessionId)) {
      parkedSessions = new Set(parkedSessions);
      parkedSessions.delete(clean.sessionId);
    }
  }
  const wantsPreview = opts.preview === true && clean.kind !== "session";
  const live = panels.get(key) ?? null;
  const revived = live === null ? lastPanelStates.get(key) ?? null : null;
  const current = live ?? revived;

  // THE PREVIEW REPLACE (SWIT-47). Applies only when the artifact is NOT
  // already in the strip (an existing tab — pinned or preview — is activated,
  // never duplicated: the dedupe rule is senior) and the strip HAS a preview
  // to replace. Everything else falls through to append-or-activate, with the
  // appended tab marked as the preview when one was asked for.
  if (wantsPreview && current) {
    const already = indexOfArtifact(current.artifacts, clean);
    const previewId = previews.get(key) ?? null;
    const previewIndex =
      already < 0 && previewId !== null
        ? current.artifacts.findIndex((a) => artifactIdentity(a) === previewId)
        : -1;
    if (previewIndex >= 0) {
      const replaced = current.artifacts[previewIndex];
      audit("preview-replace", key, replaced, `by=${auditName(clean)}`);
      const artifacts = current.artifacts.map((a, i) => (i === previewIndex ? clean : a));
      const stack = [...(previewBacks.get(key) ?? []), replaced].slice(-PREVIEW_BACK_CAP);
      previewBacks = new Map(previewBacks);
      previewBacks.set(key, stack);
      previews = new Map(previews);
      previews.set(key, artifactIdentity(clean));
      if (revived !== null) forgetPanel(key);
      panels = new Map(panels);
      panels.set(key, { artifacts, activeIndex: previewIndex });
      bump();
      return;
    }
  }

  const next = appendOrActivate(current, clean);
  // `next === current` means "already the ACTIVE tab". For a live panel that
  // is a genuine no-op; for a revived one the panel must still come back on
  // screen, so only the live case returns early.
  if (next === current && revived === null) return;
  // A NEW tab that was asked for as a preview becomes the strip's preview
  // (there was none to replace, or the strip is fresh).
  if (wantsPreview && (!current || indexOfArtifact(current.artifacts, clean) < 0)) {
    previews = new Map(previews);
    previews.set(key, artifactIdentity(clean));
  }
  // The strip is live again — the memory is only ever for panels that are
  // currently hidden, and leaving a copy behind would let a later hide be
  // undone by a stale one.
  if (revived !== null) forgetPanel(key);
  panels = new Map(panels);
  panels.set(key, next);
  bump();
}

// ── Preview-slot accessors (SWIT-47) ─────────────────────────────────────────

/** Identity of the strip's preview tab, or "" when every tab is pinned. */
export function previewIdentityFor(sessionId: string | null): string {
  if (!sessionId) return "";
  const key = ownerKeyFor(sessionId);
  const id = previews.get(key);
  if (!id) return "";
  // The mark is honest only while the artifact is still IN the strip (a close
  // clears it, but a stale mark must read as "no preview", never dangle).
  const state = panels.get(key) ?? lastPanelStates.get(key);
  if (!state || !state.artifacts.some((a) => artifactIdentity(a) === id)) return "";
  return id;
}

export function usePreviewIdentity(sessionId: string | null): string {
  return useSyncExternalStore(subscribe, () => previewIdentityFor(sessionId));
}

/** PIN the preview tab (double-click it, per the wireframe): the tab stays,
 *  it just stops being replaceable. Clears the back stack — the lineage ended
 *  in a keep. */
export function pinPreview(sessionId: string): void {
  const key = ownerKeyFor(sessionId);
  if (!previews.has(key) && !previewBacks.has(key)) return;
  previews = new Map(previews);
  previews.delete(key);
  previewBacks = new Map(previewBacks);
  previewBacks.delete(key);
  bump();
}

/** Is there anywhere for the preview to go BACK to? */
export function previewBackAvailableFor(sessionId: string | null): boolean {
  if (!sessionId) return false;
  const key = ownerKeyFor(sessionId);
  return previewIdentityFor(sessionId) !== "" && (previewBacks.get(key)?.length ?? 0) > 0;
}

export function usePreviewBackAvailable(sessionId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => previewBackAvailableFor(sessionId));
}

/** Step the preview tab back to the artifact it replaced. The current preview
 *  is discarded (that is what a preview is); the restored one is the preview
 *  again, so forward-going plain clicks keep replacing. */
export function goPreviewBack(sessionId: string): void {
  const key = ownerKeyFor(sessionId);
  const stack = previewBacks.get(key);
  const currentId = previewIdentityFor(sessionId);
  if (!stack || stack.length === 0 || currentId === "") return;
  const state = panels.get(key);
  if (!state) return;
  const index = state.artifacts.findIndex((a) => artifactIdentity(a) === currentId);
  if (index < 0) return;
  const target = stack[stack.length - 1];
  audit("preview-replace", key, state.artifacts[index], `back-to=${auditName(target)}`);
  previewBacks = new Map(previewBacks);
  previewBacks.set(key, stack.slice(0, -1));
  previews = new Map(previews);
  previews.set(key, artifactIdentity(target));
  panels = new Map(panels);
  panels.set(key, {
    artifacts: state.artifacts.map((a, i) => (i === index ? target : a)),
    activeIndex: index,
  });
  bump();
}

/** Clear a strip's preview mark + stack (the preview tab was closed). */
function clearPreview(key: string): void {
  if (!previews.has(key) && !previewBacks.has(key)) return;
  previews = new Map(previews);
  previews.delete(key);
  previewBacks = new Map(previewBacks);
  previewBacks.delete(key);
}

/** Switch which tab of a session's strip is showing. Out-of-range indices and
 *  no-op activations are ignored (no snapshot churn). */
export function activateArtifact(sessionId: string, index: number): void {
  const key = ownerKeyFor(sessionId);
  const state = panels.get(key);
  if (!state) return;
  if (!Number.isInteger(index) || index < 0 || index >= state.artifacts.length) return;
  if (index === state.activeIndex) return;
  panels = new Map(panels);
  panels.set(key, { ...state, activeIndex: index });
  bump();
}

/** Close ONE tab of a session's strip (the strip's own `×`). Closing the last
 *  tab removes the session's panel entirely — and only THEN is the strip filed
 *  into the toggle memory, because only then is there a panel to bring back. */
export function closeArtifactAt(
  sessionId: string,
  index: number,
  reason: PanelRemovalReason = "user-close"
): void {
  const key = ownerKeyFor(sessionId);
  const state = panels.get(key);
  if (!state) return;
  const next = closeArtifactIn(state, index);
  if (next === state) return; // out of range — nothing happened
  const closed = state.artifacts[index];
  audit(reason, key, closed, `index=${index} of=${state.artifacts.length}`);
  // Closing the PREVIEW tab ends its lineage — mark and back stack go with it.
  if (closed && previews.get(key) === artifactIdentity(closed)) clearPreview(key);
  panels = new Map(panels);
  if (next === null) {
    audit("strip-emptied", key, auditNames(state), `after=${reason}`);
    rememberPanel(key, state);
    panels.delete(key);
  } else {
    panels.set(key, next);
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
  // A RUNNING TERMINAL IS NOT CONTEXT (increment H). Inheritance copies what
  // the user was LOOKING AT into a new tab's panel; a session artifact cannot
  // be copied — it names one live shell with one live view, and "inheriting" it
  // would MOVE Eric's dev server into a thread he just created. A new thread
  // launched beside a panel terminal simply starts with an empty panel.
  if (artifact.kind === "session") return false;
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
  const state = panels.get(ownerKeyFor(sessionId));
  if (!state) return;
  closeArtifactAt(
    sessionId,
    clampActiveIndex(state.artifacts.length, state.activeIndex),
    "header-close"
  );
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
  const key = ownerKeyFor(sessionId);
  const open = panels.get(key);
  if (open) {
    // RECOVERABLE — the whole strip goes into `lastPanelStates` and the same
    // chord brings it back. Logged anyway: from the screen it is identical to
    // a close, and telling the two apart is the entire point of this seam.
    audit("toggle-hide", key, auditNames(open));
    rememberPanel(key, open);
    panels = new Map(panels);
    panels.delete(key);
    bump();
    return;
  }
  const last = lastPanelStates.get(key);
  if (!last) return;
  // Same invariant openInPanel's revive keeps: a strip that is live again is
  // no longer "remembered".
  forgetPanel(key);
  panels = new Map(panels);
  panels.set(key, last);
  bump();
}

/** Would Ctrl+Shift+P do anything for this tab? (open panel → hides it; no
 *  panel but a remembered strip → brings it back). */
export function panelToggleAvailableFor(sessionId: string | null): boolean {
  if (!sessionId) return false;
  const key = ownerKeyFor(sessionId);
  return panels.has(key) || lastPanelStates.has(key);
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
  // Same for a pop-out: the tab it would return to is gone. The WINDOW is
  // App's to close (it owns the lifecycle); the record here just stops
  // claiming an artifact belongs to a dead tab.
  const hadPopOut = poppedOut?.sessionId === sessionId;
  if (hadPopOut) poppedOut = null;
  const key = ownerKeyFor(sessionId);

  // PANEL TERMINALS OUTLIVE THEIR HOST TAB (increment H). This tab is being
  // destroyed, and its strip may hold live shells — a dev server among them.
  // Killing them because their host tab closed is precisely the surprise the
  // close guard exists to prevent, so they are PARKED instead: still running,
  // still owned by the panel, listed under RUNNING TERMINALS in any tab's `+`.
  const orphans: string[] = [];
  for (const state of [panels.get(key), lastPanelStates.get(key)]) {
    if (state) for (const a of state.artifacts) if (a.kind === "session") orphans.push(a.sessionId);
  }

  let changed = hadPopOut;
  if (isThreadKey(key)) {
    // A THREAD's panel SURVIVES its tab (SWIT-47): the thread is severed, not
    // deleted, and its strip comes back when the thread revives — that is
    // what "the panel is per-thread" buys. Only the session ARTIFACTS leave
    // the strip (their shells are parked above and their session ids will die
    // or be respawned; a dead id in a revived strip would render a note
    // forever). The side and the preview mark stay with the thread too.
    for (const [map, setMap, note] of [
      [panels.get(key), (s: PanelState | null) => {
        panels = new Map(panels);
        if (s) panels.set(key, s);
        else panels.delete(key);
      }, ""],
      [lastPanelStates.get(key), (s: PanelState | null) => {
        lastPanelStates = new Map(lastPanelStates);
        if (s) lastPanelStates.set(key, s);
        else lastPanelStates.delete(key);
      }, "hidden"],
    ] as const) {
      if (!map) continue;
      let state: PanelState | null = map;
      for (const a of map.artifacts) {
        if (a.kind !== "session" || !state) continue;
        const idx = state.artifacts.findIndex(
          (x) => x.kind === "session" && x.sessionId === a.sessionId
        );
        if (idx >= 0) {
          audit("session-parked", key, a, `host-tab-closed ${note}`.trim());
          state = closeArtifactIn(state, idx);
        }
      }
      if (state !== map) {
        setMap(state);
        changed = true;
      }
    }
  } else {
    // A SHELL's panel is transient and dies with its tab, exactly as before.
    const hadPanel = panels.has(key);
    const hadMemory = lastPanelStates.has(key);
    const hadSide = panelSides.has(key);
    if (hadSide) {
      panelSides = new Map(panelSides);
      panelSides.delete(key);
      changed = true;
    }
    clearPreview(key);
    if (hadPanel) {
      audit("session-destroyed", key, auditNames(panels.get(key)));
      panels = new Map(panels);
      panels.delete(key);
      changed = true;
    }
    if (hadMemory) {
      audit("session-destroyed", key, auditNames(lastPanelStates.get(key)), "hidden");
      lastPanelStates = new Map(lastPanelStates);
      lastPanelStates.delete(key);
      changed = true;
    }
  }
  if (orphans.length > 0) {
    parkedSessions = new Set(parkedSessions);
    for (const id of orphans) parkedSessions.add(id);
    changed = true;
  }
  if (changed) bump();
}

/** Set the global panel width (clamped). */
export function setPanelWidth(w: number): void {
  const clamped = clampPanelWidth(w);
  if (clamped === panelWidth) return;
  panelWidth = clamped;
  bump();
}

/** Reconcile the restored store after workspace restore (SWIT-47).
 *
 *  KEYS need no session idMap any more — thread ids are durable, so a
 *  `t:<threadId>` strip is KEPT verbatim when its thread survived the merge
 *  (`threadIds`), dropped with an audit line when the thread is gone (deleted
 *  on disk between runs). A stray `s:` key cannot survive a restore (shell
 *  panels are never persisted) and is dropped defensively.
 *
 *  The session ARTIFACTS inside a strip still go through the idMap exactly as
 *  before: a panel terminal was respawned under a fresh id, and an entry whose
 *  session did not come back is dropped (a dead id would render a note
 *  forever). A strip left empty is dropped whole. */
export function remapPanelSessions(idMap: Map<string, string>, threadIds: ReadonlySet<string>): void {
  const next = new Map<string, PanelState>();
  for (const [key, state] of panels) {
    if (!isThreadKey(key)) {
      audit("remap-unmapped-tab", key, auditNames(state), "restore shell-transient");
      continue;
    }
    if (!threadIds.has(threadIdOfKey(key))) {
      audit("remap-unmapped-tab", key, auditNames(state), "restore thread-gone");
      continue;
    }
    const remapped = remapPanelState(state, idMap, key);
    if (remapped) next.set(key, remapped);
    else audit("strip-emptied", key, auditNames(state), "restore");
  }
  panels = next;
  // Sides: thread-keyed sides survive with their thread, everything else goes.
  {
    const sides = new Map<string, "left">();
    for (const key of panelSides.keys()) {
      if (isThreadKey(key) && threadIds.has(threadIdOfKey(key))) sides.set(key, "left");
    }
    panelSides = sides;
  }
  // Parked ids follow the idMap for completeness. In practice this set is
  // empty at restore time (it is never persisted), so this is a guard against a
  // future caller remapping mid-session, not a live path.
  if (parkedSessions.size > 0) {
    const nextParked = new Set<string>();
    for (const id of parkedSessions) {
      const mapped = idMap.get(id);
      if (mapped) nextParked.add(mapped);
    }
    parkedSessions = nextParked;
  }
  bump();
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel-owned sessions (increment H)
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE-LIVE-VIEW INVARIANT, stated once and enforced here.
//
// A session has exactly one live xterm view. The registry arbitrates a second
// mount by STEALING (last mount wins, the loser is severed) — correct, but a
// mechanism we should never have to exercise. So the panel does not compete
// for a session; it OWNS one:
//
//   A session is PANEL-OWNED when it appears in a live strip, in a hidden
//   strip (Ctrl+Shift+P files the whole strip into `lastPanelStates`, and a
//   hidden panel still owns its terminals), or in `parkedSessions`.
//
// App filters panel-owned sessions out of the TAB BAR and out of the pane
// tree — including the single-pane branch, which mounts EVERY session it is
// given — so a panel-owned session has no pane mount to steal from. Inside the
// panel, only the active tab of the active tab's panel renders a body, and
// `openInPanel` keeps a session artifact in AT MOST ONE strip. Those three
// facts leave exactly one possible mount at any moment.
//
// Moving between the two homes is therefore a two-step, never a swap:
//   park(id)    — the artifact leaves every strip (the panel unmounts the
//                 terminal, which parks in the keep-alive root) and ownership
//                 is RETAINED, so nothing else may mount it;
//   release(id) — ownership ends; only now can the pane tree take it.
// App runs the first inside `flushSync`, so the unmount is committed before
// the mount is even possible.

/** Every session the panel owns (see the section header). */
export function panelOwnedSessionIds(): ReadonlySet<string> {
  const prev = cachedOwnedSessions;
  if (prev && !ownedSessionsDirty) return prev;
  ownedSessionsDirty = false;
  const next = new Set<string>(parkedSessions);
  for (const state of panels.values()) collectSessionIds(state, next);
  for (const state of lastPanelStates.values()) collectSessionIds(state, next);
  // Same ids ⇒ same reference. App filters the tab bar and the pane tree
  // through this set, so handing back a new one per bump re-rendered App on
  // every store notification — see the snapshot contract above.
  if (prev && sameStringSet(prev, next)) return prev;
  cachedOwnedSessions = next;
  return next;
}

function collectSessionIds(state: PanelState, into: Set<string>): void {
  for (const artifact of state.artifacts) {
    if (artifact.kind === "session") into.add(artifact.sessionId);
  }
}

/** Is this session the panel's? (⇒ it must NOT appear in the tab bar or the
 *  pane tree.) Reads the module singleton, so it is true the instant a store
 *  mutation lands — before React has re-rendered anything. */
export function isPanelOwnedSession(sessionId: string | null | undefined): boolean {
  return typeof sessionId === "string" && panelOwnedSessionIds().has(sessionId);
}

/** React hook for App's tab-bar / pane-tree filter. */
export function usePanelOwnedSessions(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, panelOwnedSessionIds);
}

/** Panel terminals that are alive with NO view — what the `+` picker lists
 *  under RUNNING TERMINALS. Sorted for a stable row order. */
export function parkedPanelSessions(): readonly string[] {
  const prev = cachedParkedSessions;
  if (prev && !parkedSessionsDirty) return prev;
  parkedSessionsDirty = false;
  const next = Array.from(parkedSessions).sort();
  if (prev && prev.length === next.length && prev.every((id, i) => id === next[i])) return prev;
  cachedParkedSessions = next;
  return next;
}

export function useParkedPanelSessions(): readonly string[] {
  return useSyncExternalStore(subscribe, parkedPanelSessions);
}

/** Drop a session artifact from every strip (live AND remembered), except
 *  optionally one tab. Mutates the module maps WITHOUT bumping — callers bump
 *  once. Returns whether anything changed.
 *
 *  A strip left empty is DELETED rather than remembered: remembering it would
 *  keep the session panel-owned through `lastPanelStates`, which is exactly the
 *  ownership we are trying to end. */
function dropSessionArtifact(
  sessionId: string,
  exceptTab?: string,
  reason: PanelRemovalReason = "session-released",
  note = ""
): boolean {
  let changed = false;
  let panelsCloned = false;
  for (const [tab, state] of Array.from(panels)) {
    if (tab === exceptTab) continue;
    const next = withoutSession(state, sessionId);
    if (next === state) continue;
    if (!panelsCloned) {
      panels = new Map(panels);
      panelsCloned = true;
    }
    changed = true;
    audit(reason, tab, { kind: "session", sessionId }, note);
    if (next === null) {
      audit("strip-emptied", tab, auditNames(state), `after=${reason}`);
      panels.delete(tab);
    } else panels.set(tab, next);
  }
  let memoryCloned = false;
  for (const [tab, state] of Array.from(lastPanelStates)) {
    const next = withoutSession(state, sessionId);
    if (next === state) continue;
    if (!memoryCloned) {
      lastPanelStates = new Map(lastPanelStates);
      memoryCloned = true;
    }
    changed = true;
    audit(reason, tab, { kind: "session", sessionId }, `hidden ${note}`.trim());
    if (next === null) lastPanelStates.delete(tab);
    else lastPanelStates.set(tab, next);
  }
  return changed;
}

/** One strip without a session's tab. Returns the SAME object when it holds no
 *  such tab, and null when removing it empties the strip. */
function withoutSession(state: PanelState, sessionId: string): PanelState | null {
  const index = state.artifacts.findIndex(
    (a) => a.kind === "session" && a.sessionId === sessionId
  );
  if (index < 0) return state;
  return closeArtifactIn(state, index);
}

/** PARK a panel terminal: take its view away, keep ownership. This is "keep it
 *  running" from the close guard, and the middle step of promote/kill. */
export function parkPanelSession(
  sessionId: string,
  reason: PanelRemovalReason = "session-parked"
): void {
  if (sessionId.length === 0) return;
  const changed = dropSessionArtifact(sessionId, undefined, reason);
  if (parkedSessions.has(sessionId) && !changed) return;
  parkedSessions = new Set(parkedSessions);
  parkedSessions.add(sessionId);
  bump();
}

/** RELEASE a panel terminal: the panel stops owning it entirely. Used by
 *  `promote to tab` (the tab bar takes it) and by teardown (it is gone). Safe
 *  to call for a session the panel never owned. */
export function releasePanelSession(
  sessionId: string,
  reason: PanelRemovalReason = "session-released"
): void {
  if (sessionId.length === 0) return;
  let changed = dropSessionArtifact(sessionId, undefined, reason);
  if (parkedSessions.has(sessionId)) {
    parkedSessions = new Set(parkedSessions);
    parkedSessions.delete(sessionId);
    changed = true;
  }
  if (changed) bump();
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

/** What `+ → new terminal` picked: exactly the arguments App's EXISTING
 *  session-creation path takes (`doCreateSession`). The panel does not fork
 *  session creation — it chooses a working directory and hands it over. */
export type NewPanelTerminal = {
  name: string;
  repo: string;
  workingDir: string;
  repoColor?: string;
  group?: string;
};

export type PanelActions = {
  /** TYPE text into the focused terminal. The implementation MUST NOT append
   *  a trailing \r — the Enter that sends it is the user's keystroke. */
  sendToThread: (text: string) => void;
  /** POP OUT (increment F, Decision 2): hand this artifact to the floating PiP
   *  window. App owns the window lifecycle; the store owns only the record of
   *  WHICH artifact is out there, so the panel can say so instead of drawing a
   *  second live copy of it. */
  popOutArtifact: (artifact: Artifact) => void;
  // ── Increment H ────────────────────────────────────────────────────────────
  // Session lifecycle belongs to App (it owns `sessions`, the pane layout and
  // the confirm dialog); the panel owns only the artifact record. Same
  // module-singleton bridge, same reason.
  /** Spawn a shell through App's existing creation path and open it as a
   *  `session` artifact in THIS tab's panel. */
  createPanelTerminal: (tabSessionId: string, target: NewPanelTerminal) => void;
  /** MOVE a panel terminal to the tab bar — park, commit, release, focus. */
  promotePanelTerminal: (sessionId: string) => void;
  /** Close a panel terminal's tab. App asks first when the process is alive
   *  (keep running / promote / kill); the store never kills anything. */
  closePanelTerminal: (tabSessionId: string, sessionId: string) => void;
  /** Write a session's CURRENT scrollback to its mirror file, right now.
   *
   *  The linkage that makes `→ thread` mean something for a live shell: the
   *  reference names `<scrollbackRoot>/<id>.txt`, and that file is otherwise
   *  only as fresh as the periodic save. Called immediately BEFORE the
   *  reference is typed, so what the agent reads is what Eric was looking at
   *  when he clicked. Resolves even on failure — a stale transcript is worth
   *  more than a swallowed gesture, and the wording tells the agent to
   *  re-read anyway. */
  flushTerminalTranscript: (sessionId: string) => Promise<void>;
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

// ── Pop-out to the PiP window (increment F, Decision 2) ──────────────────────
// The floating window (pip.tsx) can host an ARTIFACT, not only a mirrored
// terminal — one window lifecycle instead of a second window type. There is
// exactly ONE PiP window, so this is one module-level record, not a map.
//
// WHY THE PANEL NEEDS TO KNOW: an artifact that is out in the floating window
// must not ALSO render in the panel. For a doc that would merely be wasteful;
// for a LIVE localhost preview it would be two frames hitting the dev server
// and two health polls, and for a wireframe two mounts of the same pin sidecar
// (which the shared pinsStore survives, but which is still two of everything).
// So the panel tab shows a "showing in the floating window" placeholder with a
// bring-it-back action, and closing the window returns it. Nothing is lost
// either way: the tab strip is untouched the whole time.

let poppedOut: { sessionId: string; artifact: Artifact } | null = null;

/** Record that an artifact is now hosted by the floating window. App calls
 *  this AFTER the window actually opens — a failed open must not leave the
 *  panel claiming the artifact is somewhere it is not. */
export function setPoppedOutArtifact(sessionId: string, artifact: Artifact): void {
  const clean = sanitizeArtifact(artifact);
  if (!clean || sessionId.length === 0) return;
  // A LIVE SHELL NEVER FLOATS (increment H). The floating window renders the
  // same ArtifactSurface, and a terminal there would be a SECOND live view of
  // one session — the exact case this increment is built to make impossible.
  // The panel header hides the `float` action for a session artifact; this is
  // the store-side half, so no future caller can route around it.
  if (clean.kind === "session") return;
  poppedOut = { sessionId, artifact: clean };
  bump();
}

/** The floating window closed (or gave the artifact back) — the panel renders
 *  it again. Idempotent. */
export function clearPoppedOutArtifact(): void {
  if (poppedOut === null) return;
  poppedOut = null;
  bump();
}

/** What the floating window is hosting, or null. */
export function getPoppedOutArtifact(): Artifact | null {
  return poppedOut?.artifact ?? null;
}

/** Identity of the popped-out artifact (`""` = nothing is out) — a primitive
 *  snapshot, so subscribers re-render on the transition and not on drags. */
export function poppedOutIdentity(): string {
  return poppedOut ? artifactIdentity(poppedOut.artifact) : "";
}

export function usePoppedOutIdentity(): string {
  return useSyncExternalStore(subscribe, poppedOutIdentity);
}

/** Is this URL already being previewed ANYWHERE — any tab's strip, or the
 *  floating window?
 *
 *  Deliberately across every panel rather than one session's: a dev server is
 *  a machine-wide thing, and "you are already looking at this" is true no
 *  matter which tab printed the banner. The popped-out artifact counts because
 *  while it is out there its panel tab holds a PLACEHOLDER — checking only the
 *  strips would call a preview that is visibly on screen "not open".
 *
 *  URL comparison is `serverKey`'s — the SAME fold `artifactIdentity` applies,
 *  so "the strip would activate an existing tab" and "the chip stays quiet"
 *  can never disagree. A plain string compare was the bug: vite's
 *  `http://127.0.0.1:5273/` did not match the dev script's
 *  `http://localhost:5273` that was already framed, so the offer came back for
 *  a server Eric was looking at. The PROJECT is deliberately not part of it —
 *  the same port filed under two projects is still one server. */
export function isLocalhostUrlOpen(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  const key = serverKey(url);
  const matches = (artifact: Artifact): boolean =>
    artifact.kind === "localhost" && serverKey(artifact.url) === key;
  const out = poppedOut?.artifact;
  if (out && matches(out)) return true;
  for (const state of panels.values()) {
    for (const artifact of state.artifacts) {
      if (matches(artifact)) return true;
    }
  }
  return false;
}

/** Send the panel's active artifact to the floating window. No-op when App has
 *  registered no handler (callers gate on `usePopOutAvailable` so the action is
 *  DISABLED rather than silently dead). */
export function popOutArtifact(artifact: Artifact): void {
  if (artifact.kind === "session") return; // one live view — see setPoppedOutArtifact
  panelActions?.popOutArtifact(artifact);
}

export function popOutAvailable(): boolean {
  return panelActions !== null;
}

export function usePopOutAvailable(): boolean {
  return useSyncExternalStore(subscribe, popOutAvailable);
}

// ── Panel-terminal actions (increment H) ─────────────────────────────────────
// Thin wrappers over the bridge, so the panel and the picker never reach for
// `panelActions` themselves. Each is a no-op when App has registered nothing
// (the affordances gate on `usePanelTerminalsAvailable`, so they are HIDDEN
// rather than silently dead).

export function createPanelTerminal(tabSessionId: string, target: NewPanelTerminal): void {
  panelActions?.createPanelTerminal(tabSessionId, target);
}

export function promotePanelTerminal(sessionId: string): void {
  panelActions?.promotePanelTerminal(sessionId);
}

export function closePanelTerminal(tabSessionId: string, sessionId: string): void {
  panelActions?.closePanelTerminal(tabSessionId, sessionId);
}

/** Flush a session's scrollback mirror. Resolves (never rejects) when App is
 *  not wired — the caller then types a reference to a file that is merely
 *  older, not wrong. */
export function flushTerminalTranscript(sessionId: string): Promise<void> {
  return panelActions?.flushTerminalTranscript(sessionId) ?? Promise.resolve();
}

export function panelTerminalsAvailable(): boolean {
  return panelActions !== null;
}

export function usePanelTerminalsAvailable(): boolean {
  return useSyncExternalStore(subscribe, panelTerminalsAvailable);
}

// ── Session labels (increment H) ─────────────────────────────────────────────
// A `session` artifact carries an id and nothing else, but the tab strip, the
// panel header and the picker all have to NAME it and show its live status
// dot. App publishes the (name, status) of every session here — the same
// module-singleton bridge threadStore.publishSessionStatuses uses, and for the
// same reason: no session list threaded through the panel into a tab.
//
// One published record per session, replaced only when its content actually
// changes, so the panel re-renders on a real status flip and not on every
// unrelated `sessions` array identity change.

/** `workingDir` joined in SWIT-31: the Projects section files a session
 *  under the project whose repo contains its cwd (explorer.sessionsForProject).
 *  It is the SPAWN cwd (SessionInfo.working_dir — always set: restore passes
 *  the saved one, quick sessions use the home dir), not the live one: a `cd`
 *  elsewhere is invisible to the shell, and only claude's cwd is discovered. */
export type SessionLabel = { name: string; status: AgentStatus; workingDir: string };

let sessionLabels: ReadonlyMap<string, SessionLabel> = new Map<string, SessionLabel>();

/** App publishes the live session list (id → name + status + cwd). */
export function publishSessionLabels(next: ReadonlyMap<string, SessionLabel>): void {
  if (next.size === sessionLabels.size) {
    let same = true;
    for (const [id, label] of next) {
      const prev = sessionLabels.get(id);
      if (
        !prev ||
        prev.name !== label.name ||
        prev.status !== label.status ||
        prev.workingDir !== label.workingDir
      ) {
        same = false;
        break;
      }
    }
    if (same) return;
  }
  sessionLabels = new Map(next);
  bump();
}

/** The WHOLE published list, for the Projects section's `terminals` rows.
 *  The snapshot is the map instance, replaced only on a real change, so a
 *  subscriber re-renders exactly when a session appears, leaves, renames,
 *  changes status or reports a cwd. */
export function useSessionLabels(): ReadonlyMap<string, SessionLabel> {
  return useSyncExternalStore(subscribe, () => sessionLabels);
}

/** Name + status for a session, or null when App knows no such session (a
 *  session artifact whose session is gone — the panel renders a note rather
 *  than a terminal). */
export function sessionLabelFor(sessionId: string): SessionLabel | null {
  return sessionLabels.get(sessionId) ?? null;
}

/** Narrow selector for one tab / one header. The snapshot is the stored record
 *  itself, which is replaced only on a real change. */
export function useSessionLabel(sessionId: string): SessionLabel | null {
  return useSyncExternalStore(subscribe, () => sessionLabelFor(sessionId));
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
export type OpenableArtifact = Extract<Artifact, { kind: "kb-doc" | "repo-file" | "surface" }>;

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
    case "surface":
      return { screen: "project", project: target.project, page: target.page };
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
  // A tree/link click is a PREVIEW open (SWIT-47, R3 rule 2): the next plain
  // click replaces it; the picker, the offer chip and Ctrl-gestures pin.
  openInPanel(decision.sessionId, decision.artifact, { preview: true });
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

/** Test-only: reset the store to a blank state. Also SILENCES the removal
 *  audit — most suites feed it deliberately-invalid input, and a console line
 *  per rejected fixture is noise. A test that wants the lines installs its own
 *  sink with `__setPanelAuditSink` after calling this. */
export function __resetPanelStoreForTests(): void {
  auditSink = () => {};
  panels = new Map();
  lastPanelStates = new Map();
  parkedSessions = new Set();
  previews = new Map();
  previewBacks = new Map();
  threadKeyResolver = null;
  sessionLabels = new Map();
  panelSides = new Map();
  activeTabSessionId = null;
  panelActions = null;
  pickerSessionId = null;
  poppedOut = null;
  panelWidth = DEFAULT_PANEL_WIDTH;
  cachedView = null;
  cachedOwnedSessions = null;
  cachedParkedSessions = null;
  viewDirty = true;
  ownedSessionsDirty = true;
  parkedSessionsDirty = true;
  listeners.clear();
}
