import type { Session, AgentStatus } from "../types";
import { STATUS_CONFIGS } from "../lib/statusConfig";

interface StatusBarProps {
  sessions: Session[];
  taskCount?: number;
  onToggleSidebar?: () => void;
}

const DISPLAY_ORDER: AgentStatus[] = ["running", "waiting", "idle", "error", "exited"];

export function StatusBar({ sessions, taskCount, onToggleSidebar }: StatusBarProps) {
  const counts = new Map<AgentStatus, number>();
  for (const s of sessions) {
    counts.set(s.status, (counts.get(s.status) || 0) + 1);
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "4px 14px",
        backgroundColor: "#0A0A0B",
        borderTop: "1px solid #1E1E22",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: "#52525B",
        flexShrink: 0,
        height: 26,
      }}
    >
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <span>{sessions.length} sessions</span>
        {DISPLAY_ORDER.map((status) => {
          const count = counts.get(status);
          if (!count) return null;
          const cfg = STATUS_CONFIGS[status];
          return (
            <span key={status} style={{ color: cfg.color }}>
              {count} {status}
            </span>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span>Ctrl+T new</span>
        <span style={{ color: "#3F3F46" }}>{"\u2502"}</span>
        <span>Ctrl+W close</span>
        <span style={{ color: "#3F3F46" }}>{"\u2502"}</span>
        <span>Ctrl+[ ] switch</span>
        <span style={{ color: "#3F3F46" }}>{"\u2502"}</span>
        <span>Ctrl+1-9 jump</span>
        {onToggleSidebar && (
          <>
            <span style={{ color: "#3F3F46" }}>{"\u2502"}</span>
            <button
              onClick={onToggleSidebar}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "#71717A",
                padding: "0 2px",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span>Ctrl+B tasks</span>
              {taskCount !== undefined && taskCount > 0 && (
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    color: "#0A0A0B",
                    backgroundColor: "#A78BFA",
                    borderRadius: 3,
                    padding: "0 4px",
                  }}
                >
                  {taskCount}
                </span>
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
