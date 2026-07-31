// Explorer screen body (T9) — registry-driven repo browser per the approved
// wireframe row 3 (personal-kb …/wireframes/workstation-shell.html).
//
// Left rail: project rows straight from registry.json (via explorer_projects)
// — name + dim status meta; archived entries dimmed further; projects with a
// LIVE thread (threadStore `launched` + workingDir containment, pure logic in
// lib/explorer.annotateProjects) show the running status dot — the ONLY color
// on this surface, and it's functional status.
//
// Right: 36px breadcrumb (`<project> / path / …`, segments navigate up) over
// the file listing (dirs-first rows, dim extension right-aligned) or the
// inline viewer. `.md` files render through DocView's EXACT markdown path
// (MarkdownDoc — same unified pipeline + typography, not a duplicate);
// everything else is a read-only mono <pre>. Oversize (>512KB) and unreadable
// files surface the backend's error string dimly.
//
// Routing: the SELECTED PROJECT is route state ({screen:"explorer", project})
// so deep links and lastByScreen restoration work; the path WITHIN the
// project is component state on purpose — the route param surface stays
// as-is, and the keep-alive mount preserves the path across screen switches
// anyway. No polling and no git integration in v1: listings fetch on
// navigation, the projects list refreshes on screen activation, and the
// live-thread dot is the only dynamic signal.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { annotateProjects, explorerList, explorerProjects, explorerRead } from "../lib/explorer";
import type { ExplorerEntry, ExplorerProject } from "../lib/explorer";
import { useThreadsView } from "../lib/threadStore";
import { navigate } from "../lib/route";
import { MarkdownDoc } from "./kb/DocView";
import { PulsingDot } from "./PulsingDot";
import { STATUS_CONFIGS } from "../lib/statusConfig";

// ── Styles (kit tokens — rail mirrors KbTree, head mirrors the KB screen) ────

const ROOT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  overflow: "hidden",
  fontFamily: "var(--font-mono)",
};

const RAIL_STYLE: CSSProperties = {
  width: 220,
  flex: "none",
  background: "var(--bg-secondary)",
  borderRight: "1px solid var(--border)",
  overflowY: "auto",
  overflowX: "hidden",
  fontSize: 11.5,
  paddingTop: 6,
  paddingBottom: 10,
};

const HEAD_STYLE: CSSProperties = {
  height: 36,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 14px",
  borderBottom: "1px solid var(--border)",
  fontSize: 11.5,
  color: "var(--text-dim)",
  whiteSpace: "nowrap",
  overflow: "hidden",
};

const CRUMB_BTN_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  cursor: "pointer",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
}

type OpenFile = {
  path: string;
  content: string | null;
  error: string | null;
};

export function ExplorerView({
  active,
  project,
}: {
  active: boolean;
  /** Selected project key (route param); undefined = nothing selected. */
  project: string | undefined;
}) {
  // ── Projects (left rail) — refreshed on every screen ACTIVATION ──
  const [projects, setProjects] = useState<ExplorerProject[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    explorerProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        setProjectsError(null);
      })
      .catch((e) => {
        if (!cancelled) setProjectsError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  // Live-thread annotation: liveness = threadStore's transient `launched` set
  // (public view); the containment match itself is pure (annotateProjects).
  const { threads, launched } = useThreadsView();
  const liveDirs = useMemo(
    () => threads.filter((t) => launched.has(t.id)).map((t) => t.workingDir),
    [threads, launched]
  );
  const annotated = useMemo(
    () => annotateProjects(projects ?? [], liveDirs),
    [projects, liveDirs]
  );

  // ── Path within the selected project (component state, not route) ──
  const [dirPath, setDirPath] = useState("");
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [entries, setEntries] = useState<ExplorerEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  // Project switch resets the browse position (per-project state).
  useEffect(() => {
    setDirPath("");
    setOpenFile(null);
  }, [project]);

  useEffect(() => {
    if (!project) {
      setEntries(null);
      setListError(null);
      return;
    }
    let cancelled = false;
    explorerList(project, dirPath)
      .then((list) => {
        if (cancelled) return;
        setEntries(list);
        setListError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setEntries(null);
        setListError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project, dirPath]);

  const openDir = (name: string) => {
    setOpenFile(null);
    setDirPath((prev) => (prev ? `${prev}/${name}` : name));
  };

  const openFileAt = (name: string) => {
    if (!project) return;
    const path = dirPath ? `${dirPath}/${name}` : name;
    setOpenFile({ path, content: null, error: null });
    explorerRead(project, path)
      .then((content) =>
        setOpenFile((prev) => (prev?.path === path ? { path, content, error: null } : prev))
      )
      .catch((e) =>
        setOpenFile((prev) => (prev?.path === path ? { path, content: null, error: String(e) } : prev))
      );
  };

  /** Breadcrumb navigation: jump to the first `count` dir segments. */
  const jumpTo = (count: number) => {
    setOpenFile(null);
    setDirPath(dirPath.split("/").slice(0, count).join("/"));
  };

  const dirSegments = dirPath ? dirPath.split("/") : [];
  const fileName = openFile?.path.split("/").pop();

  return (
    <div style={ROOT_STYLE}>
      {/* ── Left rail: registry projects ── */}
      <div style={RAIL_STYLE}>
        {projectsError !== null && (
          <RailMessage>registry unavailable: {projectsError}</RailMessage>
        )}
        {projectsError === null && projects !== null && projects.length === 0 && (
          <RailMessage>no projects in the registry</RailMessage>
        )}
        {annotated.map((p) => (
          <ProjectRow
            key={p.key}
            project={p}
            active={p.key === project}
            onSelect={() => navigate({ screen: "explorer", project: p.key })}
          />
        ))}
      </div>

      {/* ── Right: breadcrumb + listing / viewer ── */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={HEAD_STYLE}>
          {project ? (
            <>
              <button
                type="button"
                style={{ ...CRUMB_BTN_STYLE, color: "var(--text-secondary)", fontWeight: 600 }}
                onClick={() => jumpTo(0)}
              >
                {project}
              </button>
              {dirSegments.map((seg, i) => (
                <span key={`${i}-${seg}`} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <span>/</span>
                  <button
                    type="button"
                    style={{
                      ...CRUMB_BTN_STYLE,
                      color:
                        !openFile && i === dirSegments.length - 1
                          ? "var(--text-primary)"
                          : "var(--text-dim)",
                    }}
                    onClick={() => jumpTo(i + 1)}
                  >
                    {seg}
                  </button>
                </span>
              ))}
              {openFile && fileName && (
                <>
                  <span>/</span>
                  <span style={{ color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {fileName}
                  </span>
                </>
              )}
            </>
          ) : (
            <span>/</span>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg-primary)" }}>
          {!project ? (
            <CenteredNote>select a project from the registry rail</CenteredNote>
          ) : openFile ? (
            <FileViewer file={openFile} />
          ) : listError !== null ? (
            <CenteredNote>cannot list {dirPath || "repo root"}: {listError}</CenteredNote>
          ) : entries === null ? null : entries.length === 0 ? (
            <CenteredNote>empty directory</CenteredNote>
          ) : (
            <div style={{ padding: "8px 0" }}>
              {entries.map((entry) => (
                <FileRow
                  key={entry.name}
                  entry={entry}
                  onClick={() => (entry.is_dir ? openDir(entry.name) : openFileAt(entry.name))}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function ProjectRow({
  project,
  active,
  onSelect,
}: {
  project: ReturnType<typeof annotateProjects>[number];
  active: boolean;
  onSelect: () => void;
}) {
  const [hover, setHover] = useState(false);
  const archived = project.status === "archived";
  // Base row color: archived dims furthest; non-archived follow the KbTree
  // hover/active ramp.
  const nameColor = archived
    ? "var(--text-dim)"
    : active || hover
      ? "var(--text-primary)"
      : "var(--text-secondary)";
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={project.note ?? project.key}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        padding: "5px 12px",
        background: active ? "var(--bg-active)" : hover ? "var(--bg-elevated)" : "none",
        border: "none",
        boxShadow: active ? "inset 2px 0 0 var(--text-primary)" : "none",
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        textAlign: "left",
        cursor: "pointer",
        color: nameColor,
      }}
    >
      {project.live && (
        // Running status dot (statusConfig color) — live thread inside this
        // project's repos. The one permitted color: functional status.
        <PulsingDot color={STATUS_CONFIGS.running.color} pulse />
      )}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {project.key}
      </span>
      <span style={{ flex: "none", fontSize: 9.5, color: archived ? "var(--text-faint)" : "var(--text-dim)" }}>
        {project.status}
      </span>
    </button>
  );
}

function FileRow({ entry, onClick }: { entry: ExplorerEntry; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "4px 14px",
        background: hover ? "var(--bg-elevated)" : "none",
        border: "none",
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        textAlign: "left",
        cursor: "pointer",
        color: entry.is_dir ? "var(--text-primary)" : hover ? "var(--text-primary)" : "var(--text-secondary)",
      }}
    >
      {entry.is_dir && <span style={{ flex: "none", fontSize: 9, color: "var(--text-dim)" }}>▸</span>}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {entry.name}
      </span>
      <span style={{ flex: "none", fontSize: 9.5, color: "var(--text-dim)" }}>
        {entry.is_dir ? "dir" : extOf(entry.name)}
      </span>
    </button>
  );
}

// ── Viewer ───────────────────────────────────────────────────────────────────

function FileViewer({ file }: { file: OpenFile }) {
  if (file.error !== null) {
    // Includes the backend's >512KB refusal — shown dimly, per spec.
    return <CenteredNote>cannot read {file.path}: {file.error}</CenteredNote>;
  }
  if (file.content === null) {
    return <CenteredNote>reading {file.path}…</CenteredNote>;
  }
  if (extOf(file.path) === "md") {
    // The SAME markdown path DocView uses — shared pipeline + typography.
    return <MarkdownDoc content={file.content} />;
  }
  return (
    <pre
      style={{
        margin: 0,
        padding: "14px 18px",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        lineHeight: 1.6,
        color: "var(--text-secondary)",
        background: "var(--bg-primary)",
        whiteSpace: "pre",
        overflowX: "auto",
      }}
    >
      {file.content}
    </pre>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

function RailMessage({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 10.5, lineHeight: 1.5, wordBreak: "break-word" }}>
      {children}
    </div>
  );
}

function CenteredNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text-dim)",
        padding: 24,
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}
