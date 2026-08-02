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
// go deeper).
//
// RENDERING (increment C): a repo file goes through the SAME kind switch a KB
// doc does — `ArtifactBody`. It used to route only `.md` and dump everything
// else into a `<pre>`, which is why an HTML mockup living in a repo showed its
// source instead of the mockup. Now `.html/.htm` renders in the sandboxed
// wireframe frame, `.mmd` as a diagram, `.jsx/.tsx` as a compiled preview,
// `.md` through the shared markdown pipeline — and the `<pre>` is what is
// LEFT when no renderer claims the extension, which for a repo (unlike the
// KB) is still the right answer. Oversize (>512KB) and unreadable files
// surface the backend's error string dimly. Reads are one-shot per
// (project, path) — no polling, matching the old behavior — plus an explicit
// ⟳ on the wireframe toolbar, which re-runs the read WITHOUT unmounting the
// renderer (lib/explorer.useRepoFile / mergeFileRead own that rule for this
// screen and the artifact panel alike).

import { useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { FileArtifact } from "../types";
import { useRepoFile } from "../lib/explorer";
import type { OpenFile } from "../lib/explorer";
import { navigate } from "../lib/route";
import { ArtifactBody } from "./kb/ArtifactBody";

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
  // The read (and its ⟳) lives in lib/explorer.useRepoFile — the SAME hook the
  // artifact panel uses, so the two hosts cannot drift and a reload never
  // unmounts the renderer.
  const { file: openFile, reload } = useRepoFile(project, path);

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
        {openFile && project ? (
          <FileViewer project={project} file={openFile} onReload={reload} />
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

/** The repo-file rendering path. Exported so the artifact panel renders repo
 *  files through the EXACT same viewer this screen uses — the panel is chrome
 *  + lifecycle, never a second viewer. Both hosts pass the PROJECT separately
 *  from the read: the artifact identity is derived from `file.path`, not from
 *  the route/props path, so the identity and the content on screen always
 *  name the same file even in the render where a new read is still in flight
 *  (the same rule DocView's `ready` gate enforces for the KB poll). */
export function FileViewer({
  project,
  file,
  onReload,
}: {
  project: string;
  file: OpenFile;
  /** Re-read this file from disk (the wireframe toolbar's ⟳). Supplied by the
   *  HOST — both hosts get it from the same `useRepoFile`. */
  onReload?: () => void;
}) {
  const artifact = useMemo<FileArtifact>(
    () => ({ kind: "repo-file", project, path: file.path }),
    [project, file.path]
  );
  // ERROR ONLY WHEN THERE IS NOTHING TO SHOW — DocView's rule, and now
  // reachable here: a FAILED RE-READ keeps the last good content (mergeFileRead)
  // and reporting the error over a perfectly good document would blank the
  // renderer for a transient failure, which is exactly what the ⟳ must not do.
  // A first read that fails has no content and still shows the note.
  if (file.content === null && file.error !== null) {
    // Includes the backend's >512KB refusal — shown dimly, per spec.
    return <CenteredNote>cannot read {file.path}: {file.error}</CenteredNote>;
  }
  if (file.content === null) {
    return <CenteredNote>reading {file.path}…</CenteredNote>;
  }
  return (
    <ArtifactBody
      artifact={artifact}
      content={file.content}
      fallback={<SourcePre content={file.content} />}
      onReload={onReload}
    />
  );
}

/** What a repo file falls back to when no renderer claims its extension: its
 *  own text, read-only. */
function SourcePre({ content }: { content: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: "14px 18px",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        lineHeight: 1.6,
        color: "var(--text-secondary)",
        // Transparent: FileViewer is shared with the artifact panel, which
        // paints its own --bg-panel surface (increment B). The explorer
        // SCREEN's scroller still paints --bg-primary above.
        background: "transparent",
        whiteSpace: "pre",
        overflowX: "auto",
      }}
    >
      {content}
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
