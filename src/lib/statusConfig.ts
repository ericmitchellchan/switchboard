import type { AgentStatus } from "../types";

export interface StatusConfig {
  color: string;
  pulse: boolean;
  icon: string;
  label: string;
}

export const STATUS_CONFIGS: Record<AgentStatus, StatusConfig> = {
  idle: { color: "#3F3F46", pulse: false, icon: "\u25CB", label: "IDLE" },
  running: { color: "#3B82F6", pulse: true, icon: "\u27F3", label: "RUNNING" },
  waiting: { color: "#F59E0B", pulse: true, icon: "\u25C9", label: "WAITING" },
  done: { color: "#10B981", pulse: false, icon: "\u2714", label: "DONE" },
  error: { color: "#EF4444", pulse: false, icon: "\u2715", label: "ERROR" },
  exited: { color: "#52525B", pulse: false, icon: "\u25CB", label: "EXITED" },
};
