// Artifact picker (increment B) — the `+` on the panel's tab strip.
//
// "Open an artifact manually", which is the ask the tab strip subsumes: every
// other open path starts from a tree row, so a panel could only ever show what
// the side menu happened to be pointing at. This is the direct route.
//
// SHAPE — one filterable list, TWO sources with deliberately different depth:
//
//   · KB docs are offered IMMEDIATELY and filtered GLOBALLY. The KB doc list is
//     already one flat cached array (kb.useKbDocList — the side menu holds it
//     too), so a full-path fuzzy filter over it costs nothing.
//   · Repo files sit BEHIND A PROJECT, then behind directories. Listing every
//     file of every registry project eagerly is O(all repos) of IPC per open —
//     there is no recursive listing command, and building one would mean
//     walking node_modules-sized trees to populate a picker. So the root list
//     offers the projects, and picking one browses it with the same
//     `explorerList` call the Explorer tree uses, one directory at a time.
//
// That asymmetry is the honest one: the KB is a bounded set of documents Eric
// writes, a repo is an unbounded tree. Filtering applies to whatever level is
// on screen, so typing narrows the KB globally and narrows a directory locally.
//
// Keyboard: type to filter · ↑/↓ move · Enter opens (or descends) · Esc
// dismisses from any depth (the breadcrumb walks back up without leaving).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { docKind, useKbDocList } from "../lib/kb";
import { explorerList, explorerProjects } from "../lib/explorer";
import type { ExplorerEntry, ExplorerProject } from "../lib/explorer";
import { describeArtifact, type OpenableArtifact } from "../lib/panelStore";

/** Render cap. A KB with thousands of docs must not paint thousands of rows on
 *  every keystroke; the filter is how you reach the tail. */
const MAX_ROWS = 200;

type Row =
  /** A registry project — Enter descends into it. */
  | { kind: "project"; id: string; project: string; label: string; meta: string; dim: boolean }
  /** A directory inside the open project — Enter descends. */
  | { kind: "dir"; id: string; label: string; path: string }
  /** A KB doc — Enter opens it in the panel. */
  | { kind: "kb"; id: string; label: string; meta: string; path: string }
  /** A repo file — Enter opens it in the panel. */
  | { kind: "file"; id: string; label: string; path: string };

const KB_GLYPH = describeArtifact({ kind: "kb-doc", path: "x" }).glyph;
const REPO_GLYPH = describeArtifact({ kind: "repo-file", project: "x", path: "y" }).glyph;

export function ArtifactPicker({
  onPick,
  onClose,
}: {
  /** Chosen artifact. The caller opens it in ITS panel — the picker never
   *  routes or navigates, so `+` always means "add a tab here". */
  onPick: (artifact: OpenableArtifact) => void;
  onClose: () => void;
}) {
  const [project, setProject] = useState<string | null>(null);
  const [dir, setDir] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ── Sources ────────────────────────────────────────────────────────────────
  const { docs, error: docsError } = useKbDocList(true);

  const [projects, setProjects] = useState<ExplorerProject[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    explorerProjects()
      .then((list) => !cancelled && setProjects(list))
      .catch((e) => !cancelled && setProjectsError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const [entries, setEntries] = useState<ExplorerEntry[] | null>(null);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  useEffect(() => {
    if (project === null) return;
    let cancelled = false;
    setEntries(null);
    setEntriesError(null);
    explorerList(project, dir)
      .then((list) => !cancelled && setEntries(list))
      .catch((e) => !cancelled && setEntriesError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [project, dir]);

  // ── Rows for the current level ─────────────────────────────────────────────
  const rows = useMemo<Row[]>(() => {
    const needle = filter.trim().toLowerCase();
    const hit = (haystack: string) => needle.length === 0 || haystack.toLowerCase().includes(needle);

    if (project !== null) {
      const out: Row[] = [];
      for (const entry of entries ?? []) {
        if (!hit(entry.name)) continue;
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        out.push(
          entry.is_dir
            ? { kind: "dir", id: `d:${path}`, label: entry.name, path }
            : { kind: "file", id: `f:${path}`, label: entry.name, path }
        );
        if (out.length >= MAX_ROWS) break;
      }
      return out;
    }

    const out: Row[] = [];
    // Projects first — few rows, and they are the gateway to everything the
    // flat KB list cannot reach.
    for (const p of projects ?? []) {
      if (!hit(p.key)) continue;
      out.push({
        kind: "project",
        id: `p:${p.key}`,
        project: p.key,
        label: p.key,
        meta: p.status,
        dim: p.status === "archived",
      });
    }
    for (const path of docs ?? []) {
      if (!hit(path)) continue;
      const segments = path.split("/");
      out.push({
        kind: "kb",
        id: `k:${path}`,
        label: segments[segments.length - 1],
        meta: segments.slice(0, -1).join("/"),
        path,
      });
      if (out.length >= MAX_ROWS) break;
    }
    return out;
  }, [project, dir, entries, projects, docs, filter]);

  // Keep the cursor on a real row as the list changes under it.
  useEffect(() => {
    setSelected((prev) => Math.max(0, Math.min(prev, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [project, dir]);

  useEffect(() => {
    const item = listRef.current?.children[selected] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const enter = useCallback(
    (row: Row) => {
      switch (row.kind) {
        case "project":
          setProject(row.project);
          setDir("");
          setFilter("");
          setSelected(0);
          return;
        case "dir":
          setDir(row.path);
          setFilter("");
          setSelected(0);
          return;
        case "kb":
          onPick({ kind: "kb-doc", path: row.path });
          return;
        case "file":
          if (project !== null) onPick({ kind: "repo-file", project, path: row.path });
      }
    },
    [onPick, project]
  );

  /** Breadcrumb navigation: `null` = back to the root list, a path = that
   *  ancestor directory. */
  const goTo = (nextDir: string | null) => {
    if (nextDir === null) {
      setProject(null);
      setDir("");
    } else {
      setDir(nextDir);
    }
    setFilter("");
    setSelected(0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected((prev) => Math.min(prev + 1, rows.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected((prev) => Math.max(prev - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (rows[selected]) enter(rows[selected]);
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  // ── Paint ──────────────────────────────────────────────────────────────────
  const dirSegments = dir.length > 0 ? dir.split("/") : [];
  const emptyNote =
    project !== null
      ? entriesError !== null
        ? `cannot list: ${entriesError}`
        : entries === null
          ? "loading…"
          : "no matches"
      : docsError !== null && projectsError !== null
        ? `KB unavailable: ${docsError}`
        : docs === null && projects === null
          ? "loading…"
          : "no matches";

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
      <div
        role="dialog"
        aria-label="Open artifact"
        style={{
          position: "fixed",
          top: 64,
          left: "50%",
          transform: "translateX(-50%)",
          width: 460,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: 460,
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
        <div style={LABEL_STYLE}>
          <Crumb onClick={() => goTo(null)} active={project === null}>
            open artifact
          </Crumb>
          {project !== null && (
            <>
              <span style={{ color: "var(--text-faint)" }}>/</span>
              <Crumb onClick={() => goTo("")} active={dir.length === 0}>
                {project}
              </Crumb>
            </>
          )}
          {dirSegments.map((segment, i) => (
            <span key={`${i}-${segment}`} style={{ display: "flex", gap: 6, minWidth: 0 }}>
              <span style={{ color: "var(--text-faint)" }}>/</span>
              <Crumb
                onClick={() => goTo(dirSegments.slice(0, i + 1).join("/"))}
                active={i === dirSegments.length - 1}
              >
                {segment}
              </Crumb>
            </span>
          ))}
        </div>

        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setSelected(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={
              project === null ? "Filter KB docs and projects…" : `Filter in ${project}…`
            }
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

        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {rows.map((row, i) => (
            <div
              key={row.id}
              onClick={() => enter(row)}
              onMouseEnter={() => setSelected(i)}
              title={row.kind === "kb" ? row.path : row.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "5px 12px",
                cursor: "pointer",
                backgroundColor: i === selected ? "var(--bg-elevated)" : "transparent",
                borderLeft:
                  i === selected ? "2px solid var(--text-primary)" : "2px solid transparent",
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
              }}
            >
              <span style={{ flex: "none", width: 10, color: "var(--text-faint)" }}>
                {glyphFor(row)}
              </span>
              <span
                style={{
                  flex: "none",
                  maxWidth: "60%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color:
                    row.kind === "project" && row.dim
                      ? "var(--text-dim)"
                      : i === selected
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                }}
              >
                {row.label}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  textAlign: "right",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 9.5,
                  color: "var(--text-dim)",
                }}
              >
                {metaFor(row)}
              </span>
            </div>
          ))}
          {rows.length === 0 && (
            <div
              style={{
                padding: "16px 12px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--text-faint)",
                textAlign: "center",
              }}
            >
              {emptyNote}
            </div>
          )}
          {rows.length >= MAX_ROWS && (
            <div
              style={{
                padding: "6px 12px",
                fontFamily: "var(--font-mono)",
                fontSize: 9.5,
                color: "var(--text-faint)",
                textAlign: "center",
              }}
            >
              first {MAX_ROWS} matches — keep typing to narrow
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const LABEL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 10px 0",
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: "var(--text-dim)",
  overflow: "hidden",
  whiteSpace: "nowrap",
};

function Crumb({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        fontFamily: "var(--font-mono)",
        fontSize: 9.5,
        textTransform: "uppercase",
        letterSpacing: 1,
        color: active ? "var(--text-secondary)" : "var(--text-dim)",
        cursor: "pointer",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {children}
    </button>
  );
}

/** Kind glyph — the artifact kinds reuse the panel header's own glyphs so a
 *  row and the tab it becomes read as the same thing. */
function glyphFor(row: Row): string {
  switch (row.kind) {
    case "project":
    case "dir":
      return "▸";
    case "kb":
      return KB_GLYPH;
    case "file":
      return REPO_GLYPH;
  }
}

/** Right-hand meta: a KB doc's folder, a project's registry status, a repo
 *  file's renderable kind (docKind — the same switch DocView routes on, so
 *  `md`/`html`/`mmd` here means "this really has a viewer"). */
function metaFor(row: Row): string {
  switch (row.kind) {
    case "project":
      return row.meta;
    case "dir":
      return "";
    case "kb":
      // Truncated from the LEFT: the deep end of a KB path
      // (…/artifact-panel) is what disambiguates two docs with the same file
      // name, and CSS ellipsis would eat exactly that end.
      return ellipsizeStart(row.meta, 34);
    case "file": {
      const kind = docKind(row.path);
      return kind === "unknown" ? "" : kind;
    }
  }
}

function ellipsizeStart(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-(max - 1))}`;
}
