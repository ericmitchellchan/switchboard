export type AgentStatus = "running" | "waiting" | "idle" | "error" | "exited";

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
