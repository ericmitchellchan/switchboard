// New Thread dialog (T5) — mirrors NewSessionDialog's repo picker (same
// config.repos source, same look/keyboard model; NO new registry plumbing)
// plus an optional title field. Default title = repo name + date
// (threadStore.defaultThreadTitle), applied by App when the title is blank.

import { useState, useRef, useEffect, useCallback } from "react";
import type { RepoConfig } from "../types";

interface NewThreadDialogProps {
  repos: RepoConfig[];
  /** repoName = basename of the repo path (mirrors NewSessionDialog). */
  onCreate: (
    repoName: string,
    workingDir: string,
    repoColor: string | undefined,
    group: string | undefined,
    title: string
  ) => void;
  onClose: () => void;
}

interface RepoOption {
  name: string;
  path: string;
  color: string;
  group: string;
}

export function NewThreadDialog({ repos, onCreate, onClose }: NewThreadDialogProps) {
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allOptions: RepoOption[] = repos.map((r) => {
    // Cross-platform basename: split on / OR \ so both path styles work
    const parts = r.path.split(/[/\\]/);
    const name = parts[parts.length - 1] || r.path;
    return { name, path: r.path, color: r.color, group: r.group };
  });

  const filtered = filter
    ? allOptions.filter(
        (o) =>
          o.name.toLowerCase().includes(filter.toLowerCase()) ||
          o.path.toLowerCase().includes(filter.toLowerCase()) ||
          o.group.toLowerCase().includes(filter.toLowerCase())
      )
    : allOptions;

  useEffect(() => {
    setSelectedIndex((prev) => Math.max(0, Math.min(prev, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  // Single-shot submit: a double-Enter (or Enter + click) before the dialog
  // unmounts must not create two threads.
  const submittedRef = useRef(false);
  const select = useCallback(
    (option: RepoOption) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      onCreate(option.name, option.path, option.color, option.group, title.trim());
    },
    [onCreate, title]
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

  const inputStyle: React.CSSProperties = {
    width: "100%",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    color: "var(--text-primary)",
    backgroundColor: "var(--bg-primary)",
    border: "1px solid var(--border-subtle)",
    borderRadius: 4,
    padding: "6px 8px",
    outline: "none",
  };

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
      {/* Dialog */}
      <div
        style={{
          position: "absolute",
          top: 44,
          left: "50%",
          transform: "translateX(-50%)",
          width: 380,
          maxHeight: 440,
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
        <div
          style={{
            padding: "8px 10px 0",
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            textTransform: "uppercase",
            letterSpacing: 1,
            color: "var(--text-dim)",
          }}
        >
          New thread
        </div>
        {/* Title (optional) */}
        <div style={{ padding: "8px 10px 0" }}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Title (optional — defaults to repo · date)"
            style={inputStyle}
          />
        </div>
        {/* Repo filter */}
        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Select repo…"
            style={inputStyle}
          />
        </div>
        {/* Repo list */}
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {filtered.map((option, i) => (
            <div
              key={option.path}
              onClick={() => select(option)}
              onMouseEnter={() => setSelectedIndex(i)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 12px",
                cursor: "pointer",
                backgroundColor: i === selectedIndex ? "var(--bg-elevated)" : "transparent",
                borderLeft:
                  i === selectedIndex
                    ? "2px solid var(--accent-purple)"
                    : "2px solid transparent",
              }}
            >
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
                    color:
                      i === selectedIndex ? "var(--text-primary)" : "var(--text-secondary)",
                    fontWeight: 500,
                  }}
                >
                  {option.name}
                </div>
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
              </div>
            </div>
          ))}
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
              {repos.length === 0
                ? "No repos configured — add repos to %APPDATA%/switchboard/config.json"
                : "No matches"}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
