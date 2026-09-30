import type { PageBrief } from "./lib/pageStore";

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
  /** Optional KB checkout override (T6). */
  kb_path?: string | null;
  /** Shell mode (SWIT-55): `"full"` restores the surfaces bare mode hides.
   *  Absent = bare. Read ONCE via lib/shellMode; `?shell=` on the URL wins. */
  shell_mode?: string | null;
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
  // No cols/rows since SWIT-103: every terminal is the pinned grid
  // (lib/terminalGrid.ts). An older blob that still carries them is read
  // tolerantly and the fields are ignored.
}

export interface SavedWorkspace {
  version: 7; // v7 (SWIT-90): ≤v6 `"left"` panelSides dropped once (the 2026-09-02..09 auto-writes). v6 (SWIT-47): panels + panelSides keyed by THREAD id. v1–v6 payloads are migrated on load.
  sessions: SavedSession[];
  activeSessionId: string | null;
  paneLayout: unknown; // PaneNode serialized
  focusedPaneId: string | null;
  sessionCounter: number;
  savedAt: number;
  /** Durable thread records (T5). Sessions expire after 7 days of staleness;
   *  threads NEVER expire with them — a thread is durable by definition. */
  threads: Thread[];
  /** Artifact panel content, keyed by THREAD id (v6, SWIT-47) — thread ids
   *  are durable, so keys need no restore remap at all; a strip is kept
   *  whenever its thread survived, and it survives staleness WITH the thread.
   *  A shell's panel is transient and is never written here.
   *
   *  v4: the value is a whole TAB STRIP (PanelState), not a single Artifact.
   *  A v3 blob's `Artifact` migrates to `{artifacts:[a], activeIndex:0}`.
   *
   *  v5: a strip entry may be a `session` artifact (increment H). The session
   *  ids INSIDE those entries still go through the restore idMap
   *  (panelStore.remapPanelSessions); an entry whose session did not come
   *  back is dropped.
   *
   *  v6: keys move saved-session-id → thread id; a ≤v5 blob re-keys through
   *  its own thread records on load and shell entries are dropped. */
  panels: Record<string, PanelState>;
  /** Global panel width (one width for all tabs — one less thing to restore). */
  panelWidth: number;
  /** PANEL SIDE per tab (SWIT-33): the tabs whose panel side the user set
   *  with ⇄, BOTH values recorded (SWIT-69). Right is the default (SWIT-90);
   *  an absent entry is "the default". Keys are thread ids (v6). Nothing
   *  writes an entry but the user's toggle since v7 — the surface auto-write
   *  is gone, and a ≤v6 blob's `"left"` entries are dropped on load. */
  panelSides?: Record<string, "left" | "right">;
  /** SWIT-108: the ARCHIVED lanes (the only lane state that is not a thread
   *  field). Optional and additive — an older blob has none, an older reader
   *  ignores it; no version bump. Disk (threads.json) wins like the threads. */
  lanes?: LaneRecord[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Workstation navigation (T4) — the shell's screen/route vocabulary.
// A new screen (e.g. a future diagrams or board surface) APPENDS here:
// extend ScreenId and add/extend a Route variant; the exhaustive switches in
// src/lib/route.ts then force the param plumbing at compile time. Do not
// disturb the existing types above.
// ─────────────────────────────────────────────────────────────────────────────

/** Every screen the workstation shell can show. "home" is the default route
 *  (SWIT-45 — the roll-up screen); "terminal" is the classic Switchboard
 *  workspace, where threads live. */
export type ScreenId = "home" | "terminal" | "kb" | "explorer" | "threads" | "project" | "lane";

/** Discriminated route union keyed on `screen`. Param-carrying screens extend
 *  their variant inline (params are optional deep-link state, not identity —
 *  identity-bearing params like a future threadId are required fields).
 *  explorer's `path` is the open FILE within the project (the side-menu
 *  tree's directory-expansion state is menu-local, never routed); it is
 *  meaningless without `project` and parseRoute drops it when orphaned. */
export type Route =
  // Home (SWIT-45) — the roll-up: what needs you across threads, what is
  // live, what is listening. Param-less and the DEFAULT route.
  | { screen: "home" }
  | { screen: "terminal" }
  | { screen: "kb"; doc?: string }
  | { screen: "explorer"; project?: string; path?: string }
  // The thread HISTORY screen (increment C's `See all (N)`). Param-less: its
  // filter box is screen-local UI state, not identity, so it joins the
  // keep-alive cache and the URL stays `?screen=threads` — deep-linkable and
  // reachable with the side menu hidden.
  | { screen: "threads" }
  // A project PAGE full width (SWIT-30) — the "open full" of a surface
  // artifact. Both params are IDENTITY (which page), hence required: a
  // project screen with no page is not a location, and parseRoute falls back
  // to the terminal when either is missing. T9 (SWIT-63): optional `params`
  // — the page STATE (surface artifact params), carried as `p.<key>` query
  // params so a deep link into `Trading · NQ 2026-06-05` survives an F5.
  | { screen: "project"; project: string; page: string; params?: Record<string, string>; view?: undefined }
  // SWIT-107: a PROJECT VIEW full width — the "open full" of a report the
  // project owns (`?screen=project&project=lodestar&view=v3`). Same screen,
  // the other identity: a view instead of a page. Exactly one of the two.
  | { screen: "project"; project: string; view: string; page?: undefined; params?: undefined }
  // SWIT-108: a LANE's page — a body of work inside one project
  // (`?screen=lane&project=lodestar&lane=Gamma%20model`). Both params are
  // identity; a half-specified lane route falls back to Home.
  | { screen: "lane"; project: string; lane: string };

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
  | { kind: "localhost"; project: string; url: string } // Phase B — declared, never constructed in Phase A
  // INCREMENT H — a real PTY session hosted BY the panel. The reference is a
  // session id and nothing else: the session record itself lives where every
  // other session lives (App's `sessions` + the keep-alive registry), so a
  // panel terminal inherits status detection, scrollback persistence,
  // workspace restore and thread promotion for free.
  //
  // THE INVARIANT THIS KIND EXISTS TO KEEP: a session has exactly ONE live
  // view. A panel terminal is CREATED in the panel and lives there — it is
  // never mirrored from a pane — and while the panel owns it, it is absent
  // from the tab bar and from the pane tree (panelStore.isPanelOwnedSession,
  // applied by App). `promote to tab` MOVES it (park → release), it never
  // duplicates it.
  | { kind: "session"; sessionId: string }
  // PLATFORM EVOLUTION (SWIT-30) — a LIVE APP SURFACE: a project's own React
  // page, rendered in THIS document (never an iframe) and fed by that
  // project's backend over HTTP/WS. `project` is a registry key and `page` a
  // surface id from src/surfaces/registry.ts; the reference is nothing more,
  // so a stale or unknown pair renders a note rather than breaking the strip.
  // This is what the localhost kind could never be: same-document content,
  // so pins hit real DOM, the agent sees real screen context, and one page
  // can sit in the panel, full width, or popped out without a second origin.
  //
  // T9 (SWIT-63): optional `params` — a flat string map naming a page STATE
  // (`{instrument, date, caseId}`), validated by lib/surfaceParams.ts (≤ 8
  // keys, `[a-z][a-zA-Z0-9_]*`, values ≤ 120). Part of the IDENTITY: two
  // params sets are two artifacts. A page reads its own set through
  // page-api's `useSurfaceParams()`; the agent writes one as an Evidence
  // address `surface:<project>/<page>?k=v`.
  | { kind: "surface"; project: string; page: string; params?: Record<string, string> }
  // THE ✦ PAGE (SWIT-48) — a thread's one living page: theme · needs you ·
  // to do · what happened · evidence · questions, written by the agent
  // through fixed operations (the MCP server, SWIT-49) and merge-rendered by
  // the shell from per-thread files (pageStore). The reference is the thread
  // id and nothing else — the content lives on disk, one writer per file.
  | { kind: "page"; threadId: string }
  // A VIEW (SWIT-50) — a rendered dataset the agent declared (table, candles,
  // distribution), drawn by the shell's own chart components. STUB in SWIT-48:
  // the kind exists so strips can hold one, the renderer lands in SWIT-50.
  //
  // T6 (SWIT-60): `drill` marks a DRILLED CHILD — the parent view's declared
  // drill resolved for one anchor key. The child's spec is derived from the
  // parent's file at render time (viewStore.resolveDrill), never written to
  // disk, so the record is the parent's two ids plus the key.
  //
  // SWIT-73: `block` marks a child drilled from an EMBEDDED view — the spec
  // file holds a REPORT, and the effective parent is fence block <n> of its
  // markdown (viewStore.inlineSpecAt). Always set together with `drill`;
  // derived at render time like the drill itself.
  //
  // SWIT-107: a view has an OWNER — a thread (`threadId`, as always) or a
  // registry PROJECT (`project`, the registry key). A project view's spec
  // lives in the project's repo at `.sb-views/_project/<viewId>.json` (the
  // MCP server writes it beside the thread copy for `scope: "project"`, the
  // report default) and Rust reads it by project KEY with the explorer's
  // guards — so a report outlives the thread that made it and opens with no
  // thread at all. Exactly one of the two owner fields is present.
  //
  // SWIT-111: a drilled child's `drill.controls` are the PARENT's control
  // values it was opened at (control name → value) — its template is
  // substituted with them, so they are part of its identity.
  | {
      kind: "view";
      threadId: string;
      project?: undefined;
      viewId: string;
      block?: number;
      drill?: { key: string; controls?: Record<string, string> };
    }
  | {
      kind: "view";
      project: string;
      threadId?: undefined;
      viewId: string;
      block?: number;
      drill?: { key: string; controls?: Record<string, string> };
    }
  // A QUESTION tab (SWIT-51, R3 rule 1) — LEGACY since SWIT-67 (nothing
  // creates it; kept for restored workspaces). Answering writes answers.json
  // and closes it; since SWIT-77 nothing is typed — the ✦ page sends every
  // decision as one message.
  | { kind: "question"; threadId: string; questionId: string }
  // A SET (SWIT-79, Ky's set tabs CC-677) — ONE tab for a collection of
  // same-kind artifacts the panel steps through (`← n / N →`, `[` / `]`)
  // instead of N tabs. IDENTITY IS MEMBERSHIP (artifactIdentity sorts the
  // member identities; the label is a caption, not a key). Members are
  // never sets (a nested set FLATTENS at the load gate) and never sessions
  // (one live view — a shell is not a glance), ≤ SET_ITEM_CAP of them. The
  // position inside a set is runtime-only: on reopen a set starts at its
  // first item, the reviewing posture.
  | { kind: "set"; label: string; items: Artifact[] };

/** The artifact kinds that name a FILE on disk — the ones with a readable
 *  `path` and therefore a renderable BODY (docKind switch, pins sidecar,
 *  zoom key). `localhost` is deliberately outside it: it has a url, not a
 *  path, and nothing in the rendering/annotation stack applies to it. Views
 *  that render content take THIS type, so "does this artifact have a body?"
 *  is answered by the type system rather than by a runtime kind check in
 *  every viewer. */
export type FileArtifact = Extract<Artifact, { path: string }>;

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
  /** The directory the CONVERSATION lives in — where revive spawns a shell,
   *  and what claude's transcript path is munged from. For an explicitly
   *  created thread that is also the tab's spawn dir; for a PROMOTED one it is
   *  claude's own cwd, which can differ (`Ctrl+T`, `cd repo`, `claude`), so
   *  revive checks before reusing a bound tab (App.handleReviveThread). */
  workingDir: string;
  /** ★ The claude conversation UUID. MINTED by us (`crypto.randomUUID()`)
   *  when the thread is created explicitly — `claude --session-id <uuid>` then
   *  pins it; DISCOVERED from claude's own session file when a plain tab is
   *  PROMOTED (increment C), because claude already chose one. Same field
   *  either way, which is why revive needs no special-casing: the `--resume`
   *  vs `--session-id` choice reads disk, not provenance. */
  chatSessionId: string;
  /** ★ UI hint: the first REAL user turn happened (Enter in the TUI, not a
   *  bracketed paste). The revive launch decision itself comes from disk
   *  ground truth (claude_session_exists), which also re-syncs this hint. */
  chatStarted: boolean;
  /** Current bound Switchboard session id — a TAB binding, null when none.
   *  Machine-local; remapped (or severed) on workspace restore.
   *
   *  Increment E, Decision 1: a claude restart in this tab under a DIFFERENT
   *  conversation uuid severs this binding rather than overwriting
   *  chatSessionId — the old conversation keeps its uuid and stays revivable,
   *  and the tab is taken by a NEW record. Nothing is ever forgotten. */
  sessionId: string | null;
  createdAt: number;
  lastActivityAt: number;
  /** ★ Archived (increment E, Decision 5) — the moment the user archived this
   *  thread; ABSENT (not 0/false) while it is active, so the lean record stays
   *  lean for the common case.
   *
   *  Archiving is a first-class state, and it is NOT deleting: an archived
   *  thread is hidden from the side menu and from the history screen's Active
   *  tab, listed under Archived, and otherwise entirely unchanged — still
   *  persisted (localStorage blob + disk mirror, through sanitizeThread like
   *  every other field), still revivable, unarchivable in one click.
   *
   *  This field was in T5's first draft and was cut in review as dead
   *  speculative surface. That was right then; it has behaviour now. */
  archivedAt?: number;
  /** ★ LANE (SWIT-108) — the body of work this thread belongs to, by NAME
   *  (unique, case-insensitively, within its project). ABSENT while the
   *  thread is in no lane, like `archivedAt`. Always paired with
   *  `laneProject`; `lib/lanes.ts` owns the name rule. */
  lane?: string;
  /** The registry project key the lane belongs to — resolved from the
   *  thread's working directory WHEN the lane was set and recorded here, so
   *  a lane's identity (project + name) needs no registry read to find its
   *  threads (the MCP server's `page read` roll-up included). */
  laneProject?: string;
  /** WHO set the lane (SWIT-108, "Eric's choice wins"): `user` from the
   *  row's `lane…`, `agent` from the page tool's `lane` op (copied by the
   *  app only onto a thread with no lane). ALSO present without `lane` —
   *  `user` only — when the user took the thread OUT of its lane, so the
   *  agent's page cannot put it back. */
  laneSetBy?: "user" | "agent";
}

/** A lane's own state that is not a fact about any one thread (SWIT-108). A
 *  lane is otherwise a roll-up of its threads — it appears when its first
 *  thread joins and goes when the last one leaves — so a record exists only
 *  while it holds something: the ARCHIVE, the lane's FORMER NAMES (a rename
 *  keeps them, so reports stamped with an old name and old routes still
 *  find it), and a CACHE of the lane's current brief — the newest brief a
 *  lane thread wrote FOR this lane, kept so it outlives the thread that
 *  holds it (moved away, deleted). Nothing in it is typed by anyone.
 *  Persisted beside the threads (threads.json's `lanes` + the workspace
 *  blob), one writer: the app. */
export interface LaneRecord {
  project: string;
  name: string;
  archivedAt?: number;
  aliases?: string[];
  brief?: LaneBriefCache;
}

/** The lane brief as last seen on a thread's page — the brief, and which
 *  thread wrote it (its title kept for when the thread is gone). */
export interface LaneBriefCache {
  brief: PageBrief;
  threadId: string;
  threadTitle: string;
}
