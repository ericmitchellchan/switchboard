import { useState } from "react";
import type { Task, SidebarState } from "../types";

interface TaskSidebarProps {
  state: SidebarState;
  activeTasks: Task[];
  completedTasks: Task[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (text: string, priority: Task["priority"], source: Task["source"]) => void;
  onExpand: () => void;
}

const PRIORITY_COLORS: Record<Task["priority"], string> = {
  high: "#F59E0B",
  med: "#6B7280",
  low: "#3F3F46",
};

export function TaskSidebar({
  state,
  activeTasks,
  completedTasks,
  onToggle,
  onRemove,
  onAdd,
  onExpand,
}: TaskSidebarProps) {
  const [inputValue, setInputValue] = useState("");

  if (state === "hidden") return null;

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
                backgroundColor: PRIORITY_COLORS[t.priority],
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
        {/* Active tasks */}
        {activeTasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onToggle={onToggle}
            onRemove={onRemove}
          />
        ))}

        {activeTasks.length === 0 && (
          <div
            style={{
              padding: "16px 12px",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "#3F3F46",
              textAlign: "center",
            }}
          >
            No active tasks
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
              <TaskRow
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
          placeholder="Add task..."
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

function TaskRow({
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
      </span>
      {/* Source badge */}
      {task.source === "claude" && !task.done && (
        <span
          style={{
            fontSize: 8,
            fontWeight: 700,
            color: "#A78BFA",
            fontFamily: "var(--font-mono)",
            flexShrink: 0,
            marginTop: 2,
          }}
        >
          AI
        </span>
      )}
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
