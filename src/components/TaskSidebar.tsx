import { useState } from "react";
import type { Task, SidebarState, TaskCategory } from "../types";

interface TaskSidebarProps {
  state: SidebarState;
  activeTasks: Task[];
  completedTasks: Task[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (text: string, priority: Task["priority"], source: Task["source"]) => void;
  onClearCompleted: () => void;
  onClearAll: () => void;
  onClearAutoTasks: () => void;
  onExpand: () => void;
  onSwitchToSession?: (sessionId: string) => void;
}

const PRIORITY_COLORS: Record<Task["priority"], string> = {
  high: "var(--accent-yellow)",
  med: "var(--text-muted)",
  low: "var(--text-faint)",
};

const CATEGORY_COLORS: Record<TaskCategory, string> = {
  build: "var(--accent-red)",
  test: "var(--accent-yellow)",
  git: "var(--accent-blue)",
  runtime: "var(--accent-purple)",
  note: "var(--text-muted)",
};

const CATEGORY_ICONS: Record<TaskCategory, string> = {
  build: "\u2692",   // hammer and pick
  test: "\u26A0",    // warning
  git: "\u2387",     // branch
  runtime: "\u26A1", // lightning
  note: "\u2709",    // envelope
};

export function TaskSidebar({
  state,
  activeTasks,
  completedTasks,
  onToggle,
  onRemove,
  onAdd,
  onClearCompleted,
  onClearAll,
  onClearAutoTasks,
  onExpand,
  onSwitchToSession,
}: TaskSidebarProps) {
  const [inputValue, setInputValue] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmClearActive, setConfirmClearActive] = useState(false);

  if (state === "hidden") return null;

  const autoTasks = activeTasks.filter((t) => t.source === "auto");
  const manualTasks = activeTasks.filter((t) => t.source === "manual");

  // Collapsed mode
  if (state === "collapsed") {
    return (
      <div
        onClick={onExpand}
        style={{
          width: 38,
          backgroundColor: "var(--bg-secondary)",
          borderLeft: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 14,
          gap: 10,
          cursor: "pointer",
          flexShrink: 0,
          userSelect: "none",
        }}
      >
        <span
          style={{
            writingMode: "vertical-rl",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.1em",
            color: "var(--text-muted)",
          }}
        >
          TASKS
        </span>
        {activeTasks.length > 0 && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: "var(--text-primary)",
              backgroundColor: "var(--bg-active)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 3,
              padding: "1px 4px",
              fontFamily: "var(--font-mono)",
            }}
          >
            {activeTasks.length}
          </span>
        )}
        {/* Priority dots */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
          {activeTasks.slice(0, 8).map((t) => (
            <span
              key={t.id}
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                backgroundColor: t.source === "auto" && t.category
                  ? CATEGORY_COLORS[t.category]
                  : PRIORITY_COLORS[t.priority],
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  // Full mode
  const handleSubmit = () => {
    const text = inputValue.trim();
    if (!text) return;
    onAdd(text, "med", "manual");
    setInputValue("");
  };

  return (
    <div
      style={{
        width: 280,
        backgroundColor: "var(--bg-secondary)",
        borderLeft: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 700,
              color: "var(--text-primary)",
              letterSpacing: "0.03em",
            }}
          >
            TASKS
          </span>
          {activeTasks.length > 0 && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: "var(--text-primary)",
                backgroundColor: "var(--bg-active)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 3,
                padding: "1px 5px",
                fontFamily: "var(--font-mono)",
              }}
            >
              {activeTasks.length}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {activeTasks.length > 0 && !confirmClearActive && (
            <button
              onClick={() => setConfirmClearActive(true)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                color: "var(--text-faint)",
                padding: "0 2px",
              }}
            >
              Clear
            </button>
          )}
          {confirmClearActive && (
            <span style={{ display: "flex", gap: 3, alignItems: "center" }}>
              {autoTasks.length > 0 && (
                <button
                  onClick={() => {
                    onClearAutoTasks();
                    setConfirmClearActive(false);
                  }}
                  style={{
                    background: "none",
                    border: "1px solid var(--accent-yellow)",
                    borderRadius: 3,
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: 8,
                    color: "var(--accent-yellow)",
                    padding: "1px 4px",
                    whiteSpace: "nowrap",
                  }}
                >
                  Auto
                </button>
              )}
              <button
                onClick={() => {
                  onClearAll();
                  setConfirmClearActive(false);
                }}
                style={{
                  background: "none",
                  border: "1px solid var(--accent-red)",
                  borderRadius: 3,
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                  fontSize: 8,
                  color: "var(--accent-red)",
                  padding: "1px 4px",
                  whiteSpace: "nowrap",
                }}
              >
                All
              </button>
              <button
                onClick={() => setConfirmClearActive(false)}
                style={{
                  background: "none",
                  border: "1px solid var(--text-faint)",
                  borderRadius: 3,
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                  fontSize: 8,
                  color: "var(--text-dim)",
                  padding: "1px 4px",
                }}
              >
                {"\u00D7"}
              </button>
            </span>
          )}
          <button
            onClick={onExpand}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              color: "var(--text-dim)",
              padding: "0 2px",
            }}
          >
            {"\u203A"}
          </button>
        </div>
      </div>

      {/* Task list */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px 0",
        }}
      >
        {/* Auto-detected section */}
        {autoTasks.length > 0 && (
          <>
            <div
              style={{
                padding: "4px 12px 4px",
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                fontWeight: 600,
                color: "var(--text-dim)",
                letterSpacing: "0.05em",
              }}
            >
              AUTO-DETECTED
            </div>
            {autoTasks.map((task) => (
              <AutoTaskRow
                key={task.id}
                task={task}
                onRemove={onRemove}
                onSwitchToSession={onSwitchToSession}
              />
            ))}
          </>
        )}

        {/* Manual/notes section */}
        <div
          style={{
            padding: `${autoTasks.length > 0 ? 8 : 4}px 12px 4px`,
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            fontWeight: 600,
            color: "var(--text-dim)",
            letterSpacing: "0.05em",
          }}
        >
          NOTES
        </div>
        {manualTasks.map((task) => (
          <ManualTaskRow
            key={task.id}
            task={task}
            onToggle={onToggle}
            onRemove={onRemove}
          />
        ))}

        {manualTasks.length === 0 && (
          <div
            style={{
              padding: "12px 12px",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--text-faint)",
              textAlign: "center",
            }}
          >
            No notes
          </div>
        )}

        {/* Completed section */}
        {completedTasks.length > 0 && (
          <>
            <div
              style={{
                padding: "8px 12px 4px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                  fontWeight: 600,
                  color: "var(--text-faint)",
                  letterSpacing: "0.05em",
                }}
              >
                COMPLETED ({completedTasks.length})
              </span>
              {confirmClear ? (
                <span style={{ display: "flex", gap: 4 }}>
                  <button
                    onClick={() => {
                      onClearCompleted();
                      setConfirmClear(false);
                    }}
                    style={{
                      background: "none",
                      border: "1px solid var(--accent-red)",
                      borderRadius: 3,
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      color: "var(--accent-red)",
                      padding: "1px 6px",
                    }}
                  >
                    Yes, clear
                  </button>
                  <button
                    onClick={() => setConfirmClear(false)}
                    style={{
                      background: "none",
                      border: "1px solid var(--text-faint)",
                      borderRadius: 3,
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      color: "var(--text-dim)",
                      padding: "1px 6px",
                    }}
                  >
                    No
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirmClear(true)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: 9,
                    color: "var(--text-faint)",
                    padding: 0,
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            {completedTasks.map((task) => (
              <ManualTaskRow
                key={task.id}
                task={task}
                onToggle={onToggle}
                onRemove={onRemove}
              />
            ))}
          </>
        )}
      </div>

      {/* Quick-add input */}
      <div
        style={{
          padding: "8px 10px",
          borderTop: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
          placeholder="Add note..."
          style={{
            width: "100%",
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--text-primary)",
            backgroundColor: "var(--bg-active)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 4,
            padding: "5px 8px",
            outline: "none",
          }}
        />
      </div>
    </div>
  );
}

function AutoTaskRow({
  task,
  onRemove,
  onSwitchToSession,
}: {
  task: Task;
  onRemove: (id: string) => void;
  onSwitchToSession?: (sessionId: string) => void;
}) {
  const catColor = task.category ? CATEGORY_COLORS[task.category] : "var(--text-muted)";
  const catIcon = task.category ? CATEGORY_ICONS[task.category] : "\u2022";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        padding: "5px 12px",
        borderLeft: `3px solid ${catColor}`,
        marginLeft: 0,
      }}
    >
      {/* Category icon */}
      <span
        style={{
          fontSize: 10,
          color: catColor,
          flexShrink: 0,
          marginTop: 1,
          width: 12,
          textAlign: "center",
        }}
      >
        {catIcon}
      </span>
      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--text-secondary)",
            lineHeight: "15px",
            wordBreak: "break-word",
            display: "block",
          }}
        >
          {task.text}
        </span>
        {task.sessionId && onSwitchToSession && (
          <button
            onClick={() => onSwitchToSession(task.sessionId!)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              color: "var(--text-dim)",
              padding: 0,
              marginTop: 1,
            }}
          >
            {"\u2192"} go to session
          </button>
        )}
      </div>
      {/* Remove */}
      <button
        onClick={() => onRemove(task.id)}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--border-subtle)",
          padding: 0,
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        {"\u2715"}
      </button>
    </div>
  );
}

function ManualTaskRow({
  task,
  onToggle,
  onRemove,
}: {
  task: Task;
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const priorityColor = PRIORITY_COLORS[task.priority];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "5px 12px",
        cursor: "pointer",
      }}
      onClick={() => onToggle(task.id)}
    >
      {/* Checkbox */}
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 3,
          border: `1.5px solid ${task.done ? "var(--text-faint)" : priorityColor}`,
          backgroundColor: task.done ? "var(--border-subtle)" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          marginTop: 1,
          fontSize: 8,
          color: "var(--text-dim)",
        }}
      >
        {task.done && "\u2713"}
      </span>
      {/* Text */}
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          color: task.done ? "var(--text-faint)" : "var(--text-secondary)",
          textDecoration: task.done ? "line-through" : "none",
          flex: 1,
          lineHeight: "15px",
          wordBreak: "break-word",
        }}
      >
        {task.text}
        {task.autoResolved && (
          <span style={{ color: "var(--text-faint)", fontSize: 9, marginLeft: 4 }}>
            (auto-resolved)
          </span>
        )}
      </span>
      {/* Remove */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove(task.id);
        }}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--border-subtle)",
          padding: 0,
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        {"\u2715"}
      </button>
    </div>
  );
}
