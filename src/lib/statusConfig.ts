import type { AgentStatus } from "../types";

export interface StatusConfig {
  color: string;
  pulse: boolean;
  icon: string;
  label: string;
}

export const STATUS_CONFIGS: Record<AgentStatus, StatusConfig> = {
  running: { color: "#3B82F6", pulse: true, icon: "\u27F3", label: "RUNNING" },
  waiting: { color: "#F59E0B", pulse: true, icon: "\u25C9", label: "WAITING" },
  idle: { color: "#6B7280", pulse: false, icon: "\u25CB", label: "IDLE" },
  error: { color: "#EF4444", pulse: false, icon: "\u2715", label: "ERROR" },
  exited: { color: "#52525B", pulse: false, icon: "\u25CB", label: "EXITED" },
};
