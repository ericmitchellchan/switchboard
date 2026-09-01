// New Thread dialog (T5) — the repo picker for creating a thread, plus an
// optional title field. A blank title becomes `New thread`
// (threadStore.NEW_THREAD_TITLE, applied by App.handleCreateThread — SWIT-56;
// `repo · date` is the PROMOTED thread's default now). Since SWIT-56 the rail's
// header `+` creates directly and this dialog has no rail entry point; it
// stays built and reachable through the `newThread` action.
//
// THE REPO SOURCE IS THE REGISTRY, exactly as `Ctrl+T`'s dialog reads it
// (`explorer.useSessionRepos` = `mergeSessionRepos(explorerProjects(),
// config.repos)`). Increment B moved NewSessionDialog onto the registry and
// this dialog was missed, so it went on offering `config.repos` alone — an
// EMPTY list on Eric's machine, which made the field look like a search that
// never matched anything and pointed him at a config.json that stopped being
// the source of truth. A registry failure degrades to the config list, never
// to an empty dialog.
//
// It is a BROWSABLE LIST, not a search box: with twelve projects the options
// are on screen before a key is pressed, and typing filters what is already
// visible. And there is a QUICK CREATE row — a thread with no repo chosen at
// all, in the directory the active tab is already working in (else home),
// which the row NAMES so the shell's cwd is never a mystery.

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { RepoConfig } from "../types";
import { getHomeDir } from "../lib/ipc";
import { useSessionRepos, quickThreadTarget } from "../lib/explorer";
import type { QuickThreadTarget } from "../lib/explorer";
import { sessionDirFor } from "../lib/devServer";
import { getActiveTabSession } from "../lib/panelStore";

interface NewThreadDialogProps {
  /** config.json repos — MERGED with the registry here, never the whole
   *  source. Kept as a prop because App owns the config load. */
  repos: RepoConfig[];
  /** repoName = the registry project key (or the folder name for a
   *  config-only entry), mirroring NewSessionDialog. */
  onCreate: (
    repoName: string,
    workingDir: string,
    repoColor: string | undefined,
    group: string | undefined,
    title: string
  ) => void;
  onClose: () => void;
}

type Option =
  | { type: "quick"; name: string; path: string; meta: string; target: QuickThreadTarget }
  | {
      type: "repo";
      name: string;
      path: string;
      color: string;
      group: string;
      status: string;
      archived: boolean;
    };

/** What the quick-create row SAYS about where it will run. Never a bare path
 *  with no provenance: the point of the row is that it asks nothing, so it has
 *  to volunteer everything. */
function quickMeta(target: QuickThreadTarget): string {
  switch (target.source) {
    case "tab":
      return "this tab's directory";
    case "home":
      return "your home directory";
    case "unknown":
      return "the default directory";
  }
}

export function NewThreadDialog({ repos, onCreate, onClose }: NewThreadDialogProps) {
  const [title, setTitle] = useState("");
  const [filter, setFilter] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [homeDir, setHomeDir] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // THE shared source (see the header) — one fetch, the same merge Ctrl+T uses.
  const { options: repoOptions, projects, failed } = useSessionRepos(repos);

  useEffect(() => {
    getHomeDir()
      .then(setHomeDir)
      .catch(() => setHomeDir(""));
  }, []);

  // The tab's cwd is read ONCE, on mount: the dialog is modal, so nothing can
  // change the active tab under it, and re-reading per render would make the
  // row's label depend on render timing.
  const tabDir = useMemo(() => sessionDirFor(getActiveTabSession()), []);
  const quick = useMemo(
    () => quickThreadTarget(projects, tabDir, homeDir),
    [projects, tabDir, homeDir]
  );

  const allOptions: Option[] = useMemo(
    () => [
      {
        type: "quick" as const,
        name: "Quick create — no repo",
        path: quick.path,
        meta: quickMeta(quick),
        target: quick,
      },
      ...repoOptions.map((o) => ({
        type: "repo" as const,
        name: o.name,
        path: o.path,
        color: o.color,
        group: o.group,
        status: o.status,
        archived: o.archived,
      })),
    ],
    [quick, repoOptions]
  );

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return allOptions;
    return allOptions.filter(
      (o) =>
        o.name.toLowerCase().includes(needle) ||
        o.path.toLowerCase().includes(needle) ||
        (o.type === "repo" && o.group.toLowerCase().includes(needle))
    );
  }, [allOptions, filter]);

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
    (option: Option) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      if (option.type === "quick") {
        // The row says "no repo", so it must not invent one — see
        // QuickThreadTarget.project. A blank title is App's `New thread`
        // default like every other row (SWIT-56); the directory's label no
        // longer leaks into the title either.
        onCreate(option.target.project, option.target.path, undefined, undefined, title.trim());
        return;
      }
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

  const repoCount = repoOptions.length;

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
          maxHeight: 520,
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
        {/* Repo filter — a filter over a visible list, not a search that has to
            be typed into before anything appears. */}
        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              repoCount > 0 ? `Filter ${repoCount} repos…` : "Filter repos…"
            }
            style={inputStyle}
          />
        </div>
        {/* Options list */}
        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {filtered.map((option, i) => {
            const selected = i === selectedIndex;
            const dim = option.type === "repo" && option.archived;
            return (
              <div
                key={option.type === "quick" ? "quick" : `repo:${option.path}`}
                onClick={() => select(option)}
                onMouseEnter={() => setSelectedIndex(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 12px",
                  cursor: "pointer",
                  backgroundColor: selected ? "var(--bg-elevated)" : "transparent",
                  borderLeft: selected
                    ? "2px solid var(--text-primary)"
                    : "2px solid transparent",
                  // The escape hatch reads as one: a hairline under it separates
                  // "no repo" from the repo list without a second header row.
                  ...(option.type === "quick"
                    ? { borderBottom: "1px solid var(--border-subtle)", marginBottom: 2 }
                    : null),
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor:
                      option.type === "quick" ? "transparent" : option.color,
                    border:
                      option.type === "quick"
                        ? "1px dashed var(--text-faint)"
                        : "none",
                    flexShrink: 0,
                    opacity: dim ? 0.4 : 1,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      color: dim
                        ? "var(--text-dim)"
                        : selected
                          ? "var(--text-primary)"
                          : "var(--text-secondary)",
                      fontWeight: 500,
                    }}
                  >
                    {option.name}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 9.5,
                      color: dim ? "var(--text-faint)" : "var(--text-dim)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {/* WHERE IT WILL RUN, always — for the quick row that is the
                        whole promise of the row, so the provenance rides along
                        with the path. */}
                    {option.type === "quick"
                      ? option.path.length > 0
                        ? `${option.path} · ${option.meta}`
                        : option.meta
                      : option.path}
                  </div>
                </div>
                {option.type === "repo" && option.status !== "" && (
                  <span
                    style={{
                      flexShrink: 0,
                      fontFamily: "var(--font-mono)",
                      fontSize: 9.5,
                      color: dim ? "var(--text-faint)" : "var(--text-dim)",
                    }}
                  >
                    {option.status}
                  </span>
                )}
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
          {repoCount === 0 && filtered.length > 0 && (
            <div
              style={{
                padding: "10px 12px",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                lineHeight: 1.5,
                color: "var(--text-faint)",
                textAlign: "center",
              }}
            >
              {failed
                ? "Couldn't read the project registry — quick create still works."
                : "No repos found in the project registry or config.json — quick create still works."}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
