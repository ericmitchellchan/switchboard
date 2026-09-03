import type { AgentStatus } from "../types";

export interface StatusConfig {
  color: string;
  pulse: boolean;
  icon: string;
  label: string;
}

// Hex, not var(--…), on purpose: these colors also reach non-CSS consumers
// (canvas-adjacent paths). Values mirror the SWIT-72 Ky tones in global.css —
// running = --tone-blue, waiting = --tone-amber, done = --accent, error =
// --tone-rose, idle/exited = --text-faint/--text-dim. Change one, change both.
export const STATUS_CONFIGS: Record<AgentStatus, StatusConfig> = {
  idle: { color: "#565656", pulse: false, icon: "○", label: "IDLE" },
  running: { color: "#7ab8e8", pulse: true, icon: "⟳", label: "RUNNING" },
  waiting: { color: "#e8b765", pulse: true, icon: "◉", label: "WAITING" },
  done: { color: "#7dd3a8", pulse: false, icon: "✔", label: "DONE" },
  error: { color: "#e88a8a", pulse: false, icon: "✕", label: "ERROR" },
  exited: { color: "#6e6e6e", pulse: false, icon: "○", label: "EXITED" },
};
