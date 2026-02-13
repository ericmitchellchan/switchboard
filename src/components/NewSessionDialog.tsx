import { useState, useRef, useEffect, useCallback } from "react";
import type { RepoConfig } from "../types";

interface NewSessionDialogProps {
  repos: RepoConfig[];
  onCreateSession: (name: string, repo: string, workingDir: string, repoColor?: string, group?: string) => void;
  onClose: () => void;
}

interface RepoOption {
  type: "plain" | "repo";
  name: string;
  path: string;
  color: string;
  group: string;
}

export function NewSessionDialog({ repos, onCreateSession, onClose }: NewSessionDialogProps) {
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build options list: plain shell + repos
  const allOptions: RepoOption[] = [
    { type: "plain", name: "Plain Shell", path: "C:\\Users\\ericm", color: "#6B7280", group: "" },
    ...repos.map((r) => {
      const parts = r.path.replace(/\//g, "\\").split("\\");
      const name = parts[parts.length - 1] || r.path;
      return { type: "repo" as const, name, path: r.path, color: r.color, group: r.group };
    }),
  ];

  const filtered = filter
    ? allOptions.filter(
        (o) =>
          o.name.toLowerCase().includes(filter.toLowerCase()) ||
          o.path.toLowerCase().includes(filter.toLowerCase()) ||
          o.group.toLowerCase().includes(filter.toLowerCase())
      )
    : allOptions;

  // Clamp selection
  useEffect(() => {
    setSelectedIndex((prev) => Math.max(0, Math.min(prev, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll selected into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const select = useCallback(
    (option: RepoOption) => {
      if (option.type === "plain") {
        onCreateSession("Shell", "", option.path);
      } else {
        onCreateSession(option.name, option.name, option.path, option.color, option.group);
      }
    },
    [onCreateSession]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[selectedIndex]) select(filtered[selectedIndex]);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  // Group tracking for dividers
  let lastGroup = "";

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 99,
        }}
      />
      {/* Dialog */}
      <div
        style={{
          position: "absolute",
          top: 44,
          left: "50%",
          transform: "translateX(-50%)",
          width: 380,
          maxHeight: 400,
          backgroundColor: "var(--bg-active)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          zIndex: 100,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        {/* Search input */}
        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Select repo or plain shell..."
            style={{
              width: "100%",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text-primary)",
              backgroundColor: "var(--bg-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              padding: "6px 8px",
              outline: "none",
            }}
          />
        </div>
        {/* Options list */}
        <div
          ref={listRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "4px 0",
          }}
        >
          {filtered.map((option, i) => {
            const showGroupDivider =
              option.type === "repo" && option.group !== lastGroup && option.group;
            if (option.type === "repo") lastGroup = option.group;

            return (
              <div key={option.path + option.type}>
                {showGroupDivider && (
                  <div
                    style={{
                      padding: "6px 12px 2px",
                      fontFamily: "var(--font-mono)",
                      fontSize: 9,
                      fontWeight: 600,
                      color: "var(--text-faint)",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {option.group.toUpperCase()}
                  </div>
                )}
                <div
                  onClick={() => select(option)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "6px 12px",
                    cursor: "pointer",
                    backgroundColor: i === selectedIndex ? "var(--bg-elevated)" : "transparent",
                    borderLeft: i === selectedIndex ? "2px solid var(--accent-purple)" : "2px solid transparent",
                  }}
                >
                  {/* Color dot */}
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      backgroundColor: option.color,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        color: i === selectedIndex ? "var(--text-primary)" : "var(--text-secondary)",
                        fontWeight: 500,
                      }}
                    >
                      {option.name}
                    </div>
                    {option.type === "repo" && (
                      <div
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 9.5,
                          color: "var(--text-dim)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {option.path}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div
              style={{
                padding: "16px 12px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--text-faint)",
                textAlign: "center",
              }}
            >
              No matches
            </div>
          )}
        </div>
      </div>
    </>
  );
}
