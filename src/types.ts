export interface SessionInfo {
  id: string;
  name: string;
  repo: string;
  working_dir: string;
}

export interface Session extends SessionInfo {
  status: "running" | "exited";
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
