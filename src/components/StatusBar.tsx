import type { Session, AgentStatus } from "../types";
import { STATUS_CONFIGS } from "../lib/statusConfig";
import { UpdateChip } from "./UpdateChip";

interface StatusBarProps {
  sessions: Session[];
  taskCount?: number;
  onToggleSidebar?: () => void;
  onToggleSideMenu?: () => void;
  /** Ctrl+Shift+P — toggles the active tab's artifact panel (close what's
   *  open, or reopen what it last showed). Passed ONLY when the chord would
   *  actually do something for this tab: advertising a dead chord is a lie. */
  onTogglePanel?: () => void;
  /** Ctrl+Shift+M — toggles the FOCUSED pane's composer (increment D). Unlike
   *  the panel chip this is live whenever a session is focused: the toggle
   *  always does something, because forcing a composer onto a plain shell is a
   *  supported state, not a no-op. */
  onToggleComposer?: () => void;
  /** Ctrl+Shift+O — the floating window (increment F). It has existed since v1
   *  and was reachable ONLY by that undocumented chord; a standing gripe, and
   *  now that the window can also host a popped-out ARTIFACT it needed a real
   *  entry point. Passed whenever a session is focused, which is exactly when
   *  the chord does something. */
  onTogglePip?: () => void;
}

const DISPLAY_ORDER: AgentStatus[] = ["running", "waiting", "done", "error", "idle", "exited"];

export function StatusBar({ sessions, taskCount, onToggleSidebar, onToggleSideMenu, onTogglePanel, onToggleComposer, onTogglePip }: StatusBarProps) {
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
        backgroundColor: "var(--bg-secondary)",
        borderTop: "1px solid var(--border)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: "var(--text-dim)",
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
        <UpdateChip />
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        {onToggleSideMenu && (
          <>
            <button
              onClick={onToggleSideMenu}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--text-dim)",
                padding: 0,
              }}
            >
              <span>Ctrl+Shift+B menu</span>
            </button>
            <span style={{ color: "var(--text-faint)" }}>{"│"}</span>
          </>
        )}
        {onTogglePanel && (
          <>
            <button
              onClick={onTogglePanel}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--text-dim)",
                padding: 0,
              }}
            >
              <span>Ctrl+Shift+P panel</span>
            </button>
            <span style={{ color: "var(--text-faint)" }}>{"│"}</span>
          </>
        )}
        {onTogglePip && (
          <>
            <button
              onClick={onTogglePip}
              title="Open or close the floating always-on-top window — it mirrors the focused terminal, or hosts an artifact popped out of the panel"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--text-dim)",
                padding: 0,
              }}
            >
              <span>Ctrl+Shift+O float</span>
            </button>
            <span style={{ color: "var(--text-faint)" }}>{"│"}</span>
          </>
        )}
        {onToggleComposer && (
          <>
            <button
              onClick={onToggleComposer}
              title="Show or hide the prose composer at the bottom of the focused pane"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--text-dim)",
                padding: 0,
              }}
            >
              <span>Ctrl+Shift+M composer</span>
            </button>
            <span style={{ color: "var(--text-faint)" }}>{"│"}</span>
          </>
        )}
        <span>Ctrl+T new</span>
        <span style={{ color: "var(--text-faint)" }}>{"\u2502"}</span>
        <span>Ctrl+W close</span>
        <span style={{ color: "var(--text-faint)" }}>{"\u2502"}</span>
        <span>Ctrl+[ ] switch</span>
        <span style={{ color: "var(--text-faint)" }}>{"\u2502"}</span>
        <span>Ctrl+F find</span>
        <span style={{ color: "var(--text-faint)" }}>{"\u2502"}</span>
        <span>Ctrl+1-9 thread</span>
        {onToggleSidebar && (
          <>
            <span style={{ color: "var(--text-faint)" }}>{"\u2502"}</span>
            <button
              onClick={onToggleSidebar}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--text-muted)",
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
                    color: "var(--text-primary)",
                    backgroundColor: "var(--bg-active)",
                    border: "1px solid var(--border-subtle)",
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
