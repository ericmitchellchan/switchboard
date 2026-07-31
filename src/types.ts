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
  version: 1;
  sessions: SavedSession[];
  activeSessionId: string | null;
  paneLayout: unknown; // PaneNode serialized
  focusedPaneId: string | null;
  sessionCounter: number;
  savedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workstation navigation (T4) — the shell's screen/route vocabulary.
// Later tasks APPEND here (T5 threads, T6 knowledge base, T9 explorer,
// diagrams, board): extend ScreenId and add/extend a Route variant; the
// exhaustive switches in src/lib/route.ts then force the param plumbing at
// compile time. Do not disturb the existing types above.
// ─────────────────────────────────────────────────────────────────────────────

/** Every screen the workstation shell can show. "terminal" is the classic
 *  Switchboard workspace and the default route. */
export type ScreenId = "terminal" | "kb" | "explorer";

/** Discriminated route union keyed on `screen`. Param-carrying screens extend
 *  their variant inline (params are optional deep-link state, not identity —
 *  identity-bearing params like a future threadId are required fields). */
export type Route =
  | { screen: "terminal" }
  | { screen: "kb"; doc?: string }
  | { screen: "explorer"; project?: string };
