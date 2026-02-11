import type { Session } from "../types";

interface StatusBarProps {
  sessions: Session[];
}

export function StatusBar({ sessions }: StatusBarProps) {
  const runningCount = sessions.filter((s) => s.status === "running").length;
  const exitedCount = sessions.filter((s) => s.status === "exited").length;

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
        <span style={{ color: "#3B82F6" }}>{runningCount} running</span>
        {exitedCount > 0 && (
          <span style={{ color: "#6B7280" }}>{exitedCount} exited</span>
        )}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <span>Ctrl+T new</span>
        <span style={{ color: "#3F3F46" }}>{"\u2502"}</span>
        <span>Ctrl+W close</span>
        <span style={{ color: "#3F3F46" }}>{"\u2502"}</span>
        <span>Ctrl+[ ] switch</span>
        <span style={{ color: "#3F3F46" }}>{"\u2502"}</span>
        <span>Ctrl+1-9 jump</span>
      </div>
    </div>
  );
}
