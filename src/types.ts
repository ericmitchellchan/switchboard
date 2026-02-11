export type AgentStatus = "running" | "waiting" | "idle" | "error" | "exited";

export interface SessionInfo {
  id: string;
  name: string;
  repo: string;
  working_dir: string;
}

export interface Session extends SessionInfo {
  status: AgentStatus;
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

export interface Task {
  id: string;
  text: string;
  done: boolean;
  priority: "high" | "med" | "low";
  source: "manual" | "claude";
  repo?: string;
  createdAt: number;
}
