export type AgentStatus = "idle" | "running" | "waiting" | "done" | "error" | "exited";

export interface SessionInfo {
  id: string;
  name: string;
  repo: string;
  working_dir: string;
}

export interface Session extends SessionInfo {
  status: AgentStatus;
  repoColor?: string;
  group?: string;
  restoredFromId?: string;
  cols?: number;
  rows?: number;
}

export interface RepoConfig {
  path: string;
  color: string;
  group: string;
}

export interface Config {
  font: string;
  font_size: number;
  shell: string;
  repos: RepoConfig[];
}

export type SidebarState = "full" | "collapsed" | "hidden";

export type TaskCategory = "build" | "test" | "git" | "runtime" | "note";

export interface Task {
  id: string;
  text: string;
  done: boolean;
  priority: "high" | "med" | "low";
  source: "manual" | "auto";
  repo?: string;
  createdAt: number;
  sessionId?: string;
  category?: TaskCategory;
  fingerprint?: string;
  autoResolved?: boolean;
}

export interface SavedSession {
  id: string;
  name: string;
  repo: string;
  working_dir: string;
  repoColor?: string;
  group?: string;
  cols?: number;
  rows?: number;
}

export interface SavedWorkspace {
  version: 4; // v4 (panel tabs): `panels` values become PanelState. v1/v2/v3 payloads are migrated on load.
  sessions: SavedSession[];
  activeSessionId: string | null;
  paneLayout: unknown; // PaneNode serialized
  focusedPaneId: string | null;
  sessionCounter: number;
  savedAt: number;
  /** Durable thread records (T5). Sessions expire after 7 days of staleness;
   *  threads NEVER expire with them — a thread is durable by definition. */
  threads: Thread[];
  /** Per-tab artifact panel content, keyed by SAVED session id; keys are
   *  remapped through the restore idMap exactly like thread bindings. Unlike
   *  threads, panels expire WITH their sessions — a panel binding to an
   *  expired session is meaningless (see applyWorkspaceStaleness).
   *
   *  v4: the value is a whole TAB STRIP (PanelState), not a single Artifact.
   *  A v3 blob's `Artifact` migrates to `{artifacts:[a], activeIndex:0}`. */
  panels: Record<string, PanelState>;
  /** Global panel width (one width for all tabs — one less thing to restore). */
  panelWidth: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workstation navigation (T4) — the shell's screen/route vocabulary.
// A new screen (e.g. a future diagrams or board surface) APPENDS here:
// extend ScreenId and add/extend a Route variant; the exhaustive switches in
// src/lib/route.ts then force the param plumbing at compile time. Do not
// disturb the existing types above.
// ─────────────────────────────────────────────────────────────────────────────

/** Every screen the workstation shell can show. "terminal" is the classic
 *  Switchboard workspace and the default route. */
export type ScreenId = "terminal" | "kb" | "explorer";

/** Discriminated route union keyed on `screen`. Param-carrying screens extend
 *  their variant inline (params are optional deep-link state, not identity —
 *  identity-bearing params like a future threadId are required fields).
 *  explorer's `path` is the open FILE within the project (the side-menu
 *  tree's directory-expansion state is menu-local, never routed); it is
 *  meaningless without `project` and parseRoute drops it when orphaned. */
export type Route =
  | { screen: "terminal" }
  | { screen: "kb"; doc?: string }
  | { screen: "explorer"; project?: string; path?: string };

// ─────────────────────────────────────────────────────────────────────────────
// Threads (T5) — an agent session that survives app/machine restarts.
// A thread = a Switchboard session bound to a Claude Code conversation via
// `chatSessionId` (the claude conversation UUID, minted by US at thread
// creation) plus `chatStarted`, a UI HINT that the first real turn happened.
// The `--resume` vs `--session-id` choice at revive time is decided by disk
// GROUND TRUTH (claude_session_exists — does the transcript .jsonl exist?),
// not by chatStarted: a claude session doesn't exist on disk until a real
// user turn happens, and resuming an unstarted one errors.
//
// NOTE (recorded from the Ky bug): machine-local fields on this record —
// chatSessionId / chatStarted especially — must NEVER be bulk-replaced by any
// wholesale record overwrite (a cloud-sync once wiped chatSessionId exactly
// that way). We have no sync today; if one ever arrives, merge field-by-field.
//
// Records must stay LEAN: localStorage persistence is one shared key and quota
// overflow silently halts persistence. No scrollback, no messages, no derived
// UI state in here — sanitizeThread() in threadStore.ts enforces this shape.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Artifact panel (workstation v2) — the right-side co-present surface inside
// the terminal screen. An Artifact is a lean REFERENCE to content rendered by
// the existing viewers (DocView / explorer FileViewer) — never the content
// itself. Panel state is per-TAB (keyed by sessionId in panelStore) and rides
// in SavedWorkspace v4; sanitizeArtifact() in panelStore.ts enforces this
// shape at every load path (lean-record invariant, same as sanitizeThread).
// ─────────────────────────────────────────────────────────────────────────────

export type Artifact =
  | { kind: "kb-doc"; path: string } // KB rel path (md/html/mmd/…)
  | { kind: "repo-file"; project: string; path: string } // registry project + rel path
  | { kind: "localhost"; project: string; url: string }; // Phase B — declared, never constructed in Phase A

/** Increment B — ONE session's panel holds MANY artifacts (a tab strip), not
 *  one. `activeIndex` names the tab whose body is rendered and which the
 *  header's breadcrumb / `open full` / `→ thread` / `×` act on.
 *
 *  INVARIANTS (enforced by panelStore, asserted in its tests):
 *   - `artifacts` is never empty — a strip with no tabs is no panel at all, so
 *     closing the last tab REMOVES the session's entry entirely.
 *   - no two entries name the same content (artifactIdentity): re-opening an
 *     open artifact activates its tab instead of appending a duplicate.
 *   - `activeIndex` is always a valid index into `artifacts` (clamped on every
 *     load and after every close). */
export type PanelState = { artifacts: Artifact[]; activeIndex: number };

export interface Thread {
  /** Switchboard thread id (uuid). */
  id: string;
  title: string;
  /** Repo working directory the thread's sessions spawn in. */
  workingDir: string;
  /** ★ The claude conversation UUID — WE mint it (`crypto.randomUUID()`). */
  chatSessionId: string;
  /** ★ UI hint: the first REAL user turn happened (Enter in the TUI, not a
   *  bracketed paste). The revive launch decision itself comes from disk
   *  ground truth (claude_session_exists), which also re-syncs this hint. */
  chatStarted: boolean;
  /** Current bound Switchboard session id — a TAB binding, null when none.
   *  Machine-local; remapped (or severed) on workspace restore. */
  sessionId: string | null;
  createdAt: number;
  lastActivityAt: number;
}
