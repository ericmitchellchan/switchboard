// Explorer screen body — the file VIEWER only (design correction,
// 2026-08-01): the side menu's EXPLORER section is the navigator now
// (registry projects + IDE-style inline file tree, ExplorerTreeSection.tsx),
// so this screen renders just a 36px breadcrumb over the open file. The old
// in-screen project rail and directory listing column were deleted with that
// change.
//
// Routing: BOTH the project and the open file are route state
// ({screen:"explorer", project, path}) so deep links and lastByScreen
// restoration land on the same file; directory EXPANSION stays side-menu-
// local (never routed). Breadcrumb segments stay clickable for up-navigation
// context — with no listing surface in the main area anymore, every crumb
// closes the file back to the project's empty state (the tree is where you
// go deeper). `.md` files render through DocView's EXACT markdown path
// (MarkdownDoc — same unified pipeline + typography); everything else is a
// read-only mono <pre>. Oversize (>512KB) and unreadable files surface the
// backend's error string dimly. Reads are one-shot per (project, path) — no
// polling, matching the old behavior.

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { explorerRead } from "../lib/explorer";
import { navigate } from "../lib/route";
import { MarkdownDoc } from "./kb/DocView";

const ROOT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "var(--font-mono)",
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

/** A read attempt for one repo file: `content` and `error` are both null while
 *  the read is in flight. Exported for the artifact panel, which hosts the
 *  same FileViewer over its own read. */
export type OpenFile = {
  path: string;
  content: string | null;
  error: string | null;
};

export function ExplorerView({
  project,
  path,
  menuHidden,
}: {
  /** Selected project key (route param); undefined = nothing selected. */
  project: string | undefined;
  /** Open file within the project (route param); undefined = none open. */
  path: string | undefined;
  /** Side menu hidden — the empty state hints how to open the navigator. */
  menuHidden: boolean;
}) {
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);

  useEffect(() => {
    if (!project || !path) {
      setOpenFile(null);
      return;
    }
    let cancelled = false;
    setOpenFile({ path, content: null, error: null });
    explorerRead(project, path)
      .then((content) => {
        if (!cancelled) setOpenFile({ path, content, error: null });
      })
      .catch((e) => {
        if (!cancelled) setOpenFile({ path, content: null, error: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [project, path]);

  const segments = path ? path.split("/") : [];
  const fileName = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);

  /** Up-navigation context: every crumb closes the open file back to the
   *  project's empty state — going deeper happens in the side-menu tree. */
  const closeFile = () => {
    if (project) navigate({ screen: "explorer", project });
  };

  return (
    <div style={ROOT_STYLE}>
      <div style={HEAD_STYLE}>
        {project ? (
          <>
            <button
              type="button"
              style={{ ...CRUMB_BTN_STYLE, color: "var(--text-secondary)", fontWeight: 600 }}
              onClick={closeFile}
              title={`Close file — back to ${project}`}
            >
              {project}
            </button>
            {dirSegments.map((seg, i) => (
              <span key={`${i}-${seg}`} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <span>/</span>
                <button
                  type="button"
                  style={{ ...CRUMB_BTN_STYLE, color: "var(--text-dim)" }}
                  onClick={closeFile}
                  title={`Close file — back to ${project}`}
                >
                  {seg}
                </button>
              </span>
            ))}
            {fileName !== undefined && (
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
        {openFile ? (
          <FileViewer file={openFile} />
        ) : (
          <CenteredNote>
            <span>select a file from the explorer tree</span>
            {menuHidden && (
              <span style={{ color: "var(--text-faint)" }}>
                Ctrl+Shift+B (or click SWITCHBOARD) opens the navigator
              </span>
            )}
          </CenteredNote>
        )}
      </div>
    </div>
  );
}

// ── Viewer ───────────────────────────────────────────────────────────────────

/** The repo-file rendering path (md → DocView's markdown pipeline, everything
 *  else → read-only mono <pre>). Exported so the artifact panel renders repo
 *  files through the EXACT same viewer this screen uses — the panel is chrome
 *  + lifecycle, never a second viewer. */
export function FileViewer({ file }: { file: OpenFile }) {
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

function CenteredNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
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
