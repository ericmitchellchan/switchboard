import type { Session } from "../types";
import { STATUS_CONFIGS } from "../lib/statusConfig";

interface SessionHeaderProps {
  session: Session;
}

export function SessionHeader({ session }: SessionHeaderProps) {
  const cfg = STATUS_CONFIGS[session.status] || STATUS_CONFIGS.running;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 16px",
        backgroundColor: "#0F0F11",
        borderBottom: "1px solid #1E1E22",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: cfg.color,
            fontWeight: 600,
            letterSpacing: "0.05em",
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <span>{cfg.icon}</span>
          {cfg.label}
        </span>
        <span style={{ color: "#3F3F46", fontSize: 11 }}>{"\u2502"}</span>
        {session.repo && (
          <>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "#A78BFA",
                opacity: 0.7,
                fontWeight: 500,
              }}
            >
              {session.repo}
            </span>
            <span style={{ color: "#3F3F46", fontSize: 11 }}>{"\u2502"}</span>
          </>
        )}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "#A1A1AA",
          }}
        >
          {session.name}
        </span>
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9.5,
          color: "#52525B",
        }}
      >
        {session.working_dir}
      </div>
    </div>
  );
}
