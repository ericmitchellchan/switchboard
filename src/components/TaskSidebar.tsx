import { useState } from "react";
import type { Task, SidebarState, TaskCategory } from "../types";

interface TaskSidebarProps {
  state: SidebarState;
  activeTasks: Task[];
  completedTasks: Task[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (text: string, priority: Task["priority"], source: Task["source"]) => void;
  onExpand: () => void;
  onSwitchToSession?: (sessionId: string) => void;
}

const PRIORITY_COLORS: Record<Task["priority"], string> = {
  high: "#F59E0B",
  med: "#6B7280",
  low: "#3F3F46",
};

const CATEGORY_COLORS: Record<TaskCategory, string> = {
  build: "#EF4444",
  test: "#F59E0B",
  git: "#3B82F6",
  runtime: "#A78BFA",
  note: "#6B7280",
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
  onExpand,
  onSwitchToSession,
}: TaskSidebarProps) {
  const [inputValue, setInputValue] = useState("");

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
          backgroundColor: "#0A0A0B",
          borderLeft: "1px solid #1E1E22",
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
            color: "#71717A",
          }}
        >
          TASKS
        </span>
        {activeTasks.length > 0 && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: "#0A0A0B",
              backgroundColor: "#A78BFA",
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
        backgroundColor: "#0A0A0B",
        borderLeft: "1px solid #1E1E22",
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
          borderBottom: "1px solid #1E1E22",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 700,
              color: "#E4E4E7",
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
                color: "#0A0A0B",
                backgroundColor: "#A78BFA",
                borderRadius: 3,
                padding: "1px 5px",
                fontFamily: "var(--font-mono)",
              }}
            >
              {activeTasks.length}
            </span>
          )}
        </div>
        <button
          onClick={onExpand}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            color: "#52525B",
            padding: "0 2px",
          }}
        >
          {"\u203A"}
        </button>
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
                color: "#52525B",
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
            color: "#52525B",
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
              color: "#3F3F46",
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
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                fontWeight: 600,
                color: "#3F3F46",
                letterSpacing: "0.05em",
              }}
            >
              COMPLETED ({completedTasks.length})
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
          borderTop: "1px solid #1E1E22",
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
            color: "#E4E4E7",
            backgroundColor: "#151518",
            border: "1px solid #27272A",
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
  const catColor = task.category ? CATEGORY_COLORS[task.category] : "#6B7280";
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
            color: "#A1A1AA",
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
              color: "#52525B",
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
          color: "#27272A",
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
          border: `1.5px solid ${task.done ? "#3F3F46" : priorityColor}`,
          backgroundColor: task.done ? "#27272A" : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          marginTop: 1,
          fontSize: 8,
          color: "#52525B",
        }}
      >
        {task.done && "\u2713"}
      </span>
      {/* Text */}
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          color: task.done ? "#3F3F46" : "#A1A1AA",
          textDecoration: task.done ? "line-through" : "none",
          flex: 1,
          lineHeight: "15px",
          wordBreak: "break-word",
        }}
      >
        {task.text}
        {task.autoResolved && (
          <span style={{ color: "#3F3F46", fontSize: 9, marginLeft: 4 }}>
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
          color: "#27272A",
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
