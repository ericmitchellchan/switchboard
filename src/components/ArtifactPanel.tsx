// Artifact panel host (workstation v2, phase A2) — the co-present right-side
// surface INSIDE the terminal screen. The WORKSPACE CONTAINER becomes
// `[pane tree | divider | ArtifactPanel]`; this component renders the divider
// and the panel as SIBLINGS of the pane tree (a Fragment of two flex children),
// never as a wrapper around it — the terminal screen's DOM has to stay
// structurally intact so the keep-alive registry never sees a remount.
//
// GEOMETRY: every measurement here is against that container, which App.tsx
// nests INSIDE the terminal-screen row so the TaskSidebar (0/38/280px) stays
// outside it. That is what makes the panel's right edge the container's right
// edge — the divider tracks the cursor, the MIN_TERMINAL_WIDTH floor is real,
// and overlay's `right: 0` lands on the pane tree instead of the sidebar.
//
// It is chrome + lifecycle, NOT a viewer: the body is the same DocView the KB
// screen renders (its internal switch already covers markdown / wireframe —
// pins included — / diagram) and the same FileViewer the Explorer screen
// renders. Nothing about content rendering is reimplemented here.
//
// Terminal interplay: opening/closing/dragging changes the pane tree's width
// and NOTHING else. v1's grow-only resize policy treats narrowing as
// no-re-wrap + horizontal scroll, so a running claude TUI is disturbed exactly
// as much as a divider drag disturbs it (i.e. not at all). No resize code
// lives here — the existing ResizeObserver → fitQueue path sees the new width
// on its own.
//
// Layout rules live in panelStore.ts (panelLayoutFor / panelWidthFromDrag) so
// they are pure and tested; this file only measures the container and paints.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Artifact } from "../types";
import { navigate } from "../lib/route";
import { explorerRead } from "../lib/explorer";
import {
  closePanel,
  describeArtifact,
  fullWidthRoute,
  panelLayoutFor,
  panelWidthFromDrag,
  setPanelWidth,
  sendToThread,
  useSendToThreadAvailable,
  DIVIDER_WIDTH,
  usePanelsView,
  type ArtifactCrumb,
} from "../lib/panelStore";
import { buildSendReference, refOptions } from "../lib/agentContext";
import { DocView } from "./kb/DocView";
import { FileViewer, type OpenFile } from "./ExplorerView";

const CRUMB_TONE: Record<ArtifactCrumb["tone"], CSSProperties> = {
  lead: { color: "var(--text-secondary)", fontWeight: 600 },
  dim: { color: "var(--text-dim)", fontWeight: 400 },
  bright: { color: "var(--text-primary)", fontWeight: 400 },
};

const HEAD_STYLE: CSSProperties = {
  height: 36,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 10px 0 12px",
  borderBottom: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  color: "var(--text-dim)",
  whiteSpace: "nowrap",
  overflow: "hidden",
};

const ACTION_STYLE: CSSProperties = {
  flex: "none",
  background: "none",
  border: "none",
  padding: "0 2px",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  lineHeight: 1,
  color: "var(--text-dim)",
  cursor: "pointer",
};

/** Panel-vs-pane-tree divider. Reuses PaneDivider's interaction pattern —
 *  document-level mousemove/mouseup, body cursor + userSelect lock, and the
 *  `data-pane-pointer-block` sweep that stops terminals from swallowing the
 *  drag — but writes a WIDTH (panelStore) instead of a pane ratio.
 *
 *  All of that global state is wired inside an EFFECT keyed on the drag, so
 *  its teardown runs on unmount too. This divider unmounts during ordinary
 *  interactions (Ctrl+Shift+P closes the panel, a resize flips to overlay, a
 *  tab switch lands on a panel-less tab) and a mouseup delivered outside the
 *  WebView2 window never arrives at all — an onMouseUp-only teardown would
 *  strand every pane at `pointer-events: none` with the cursor stuck at
 *  col-resize, permanently. */
function PanelDivider() {
  const [dragBox, setDragBox] = useState<{ left: number; width: number } | null>(null);
  const dragging = dragBox !== null;
  const dividerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dragBox) return;

    const onMouseMove = (ev: MouseEvent) => {
      setPanelWidth(panelWidthFromDrag(dragBox.left, dragBox.width, ev.clientX));
    };
    const onMouseUp = () => setDragBox(null);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.querySelectorAll("[data-pane-pointer-block]").forEach((el) => {
      (el as HTMLElement).style.pointerEvents = "none";
    });

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Re-query rather than reusing the mousedown NodeList: panes can mount
      // or unmount mid-drag, and a node that appeared during the drag would
      // otherwise keep whatever pointerEvents it inherited.
      document.querySelectorAll("[data-pane-pointer-block]").forEach((el) => {
        (el as HTMLElement).style.pointerEvents = "";
      });
    };
  }, [dragBox]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    // The workspace container — `[pane tree | divider | panel]`, TaskSidebar
    // excluded by construction (App.tsx). Snapshotting it at mousedown is
    // safe: nothing resizes the container mid-drag.
    const parent = dividerRef.current?.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    setDragBox({ left: rect.left, width: rect.width });
  }, []);

  return (
    <div
      ref={dividerRef}
      onMouseDown={handleMouseDown}
      style={{
        flexShrink: 0,
        width: DIVIDER_WIDTH,
        height: "100%",
        cursor: "col-resize",
        backgroundColor: dragging ? "#E4E4E766" : "var(--border)",
        transition: dragging ? "none" : "background-color 0.15s",
        position: "relative",
        zIndex: 5,
      }}
    >
      {/* Larger hit area */}
      <div style={{ position: "absolute", top: 0, left: -2, width: 8, height: "100%" }} />
      {/* Drag shield. The `data-pane-pointer-block` sweep above only covers
          SPLIT panes (PaneContainer marks its leaves); a single-pane tab has no
          such node, and an unshielded xterm starts a text selection the moment
          the pointer crosses it. A viewport-wide transparent layer during the
          drag makes both cases behave identically. */}
      {dragging && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            cursor: "col-resize",
          }}
        />
      )}
    </div>
  );
}

export function ArtifactPanel({
  /** The ACTIVE tab's session id — the panel is per-TAB state (Decision 1). */
  sessionId,
  /** tab active && terminal screen visible — forwarded to the hosted viewer so
   *  its polling pauses exactly like the keep-alive screens' does. */
  active,
}: {
  sessionId: string | null;
  active: boolean;
}) {
  const { panels, panelWidth } = usePanelsView();
  const artifact: Artifact | null = sessionId ? panels.get(sessionId) ?? null : null;
  const open = artifact !== null;
  // T8 seam 2 gate — no terminal to type into means the `→ thread` action is
  // DISABLED, never a silent no-op. Hook order: before the early return below.
  const canSend = useSendToThreadAvailable();

  // Measure the WORKSPACE CONTAINER (our flex parent — pane tree + divider +
  // panel, TaskSidebar excluded by construction in App.tsx) to decide docked
  // vs overlay. A hidden terminal screen (display:none on a non-terminal
  // route) measures 0 — keep the last non-zero width so a screen switch never
  // flips the mode and re-lays out the panel behind the user's back.
  //
  // useLayoutEffect, not useEffect: the first paint would otherwise use the
  // initial 0 (→ docked) and flip to overlay a frame later on a narrow window.
  const asideRef = useRef<HTMLElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  useLayoutEffect(() => {
    const parent = asideRef.current?.parentElement;
    if (!parent) return;
    const update = () => {
      const w = parent.getBoundingClientRect().width;
      if (w > 0) setContainerWidth((prev) => (prev === w ? prev : w));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [open]);

  if (!open || !sessionId) return null;

  const layout = panelLayoutFor(containerWidth, panelWidth);
  const overlay = layout.mode === "overlay";
  const { glyph, crumbs, title } = describeArtifact(artifact);

  // Crossover to the full-width screen. Shares panelStore's `fullWidthRoute`
  // with the routing helper's navigate branch, so "open full" and a
  // full-width click can never drift to different routes for the same
  // artifact. (localhost has no full-width screen — the button is hidden for
  // it below, and the type reflects that.)
  const openFull = () => {
    if (artifact.kind === "localhost") return;
    navigate(fullWidthRoute(artifact));
  };

  // T8 seam 2 (explicit, visible): TYPE a reference to this artifact into the
  // terminal — no Enter. The user reviews/edits and sends it himself.
  const reference = buildSendReference(artifact, null, refOptions());
  const sendReference = () => sendToThread(reference);

  return (
    <>
      {/* Docked only: in overlay mode the panel floats above the pane tree, so
          there is no boundary to drag. */}
      {!overlay && <PanelDivider />}
      <aside
        ref={asideRef}
        aria-label="Artifact panel"
        style={{
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "var(--bg-primary)",
          width: layout.width,
          ...(overlay
            ? {
                position: "absolute",
                top: 0,
                right: 0,
                bottom: 0,
                zIndex: 6,
                borderLeft: "1px solid var(--border-subtle)",
                boxShadow: "-10px 0 28px rgba(0, 0, 0, 0.55)",
              }
            : { flex: "none", minWidth: 0 }),
        }}
      >
        <header style={HEAD_STYLE}>
          <span style={{ flex: "none", color: "var(--text-faint)" }}>{glyph}</span>
          <span
            title={title}
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
              overflow: "hidden",
            }}
          >
            {crumbs.map((crumb, i) => (
              <span
                key={`${i}-${crumb.text}`}
                style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}
              >
                {i > 0 && <span style={{ flex: "none", color: "var(--text-faint)" }}>/</span>}
                <span style={{ ...CRUMB_TONE[crumb.tone], overflow: "hidden", textOverflow: "ellipsis" }}>
                  {crumb.text}
                </span>
              </span>
            ))}
          </span>
          <button
            type="button"
            onClick={sendReference}
            disabled={!canSend}
            title={
              canSend
                ? `Type “${reference}” into the terminal — you press Enter`
                : "No terminal session to type into"
            }
            style={{
              ...ACTION_STYLE,
              opacity: canSend ? 1 : 0.35,
              cursor: canSend ? "pointer" : "default",
            }}
            onMouseEnter={(e) => {
              if (canSend) e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
          >
            → thread
          </button>
          {artifact.kind !== "localhost" && (
            <button
              type="button"
              onClick={openFull}
              title={`Open ${title} full width`}
              style={ACTION_STYLE}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
            >
              open full
            </button>
          )}
          <button
            type="button"
            onClick={() => closePanel(sessionId)}
            title="Close panel (Ctrl+Shift+P)"
            aria-label="Close panel"
            style={{ ...ACTION_STYLE, fontSize: 13, padding: "0 2px 2px" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
          >
            ×
          </button>
        </header>

        {/* Body by kind — the SAME components the screens render. */}
        {artifact.kind === "kb-doc" ? (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <DocView path={artifact.path} active={active} />
          </div>
        ) : artifact.kind === "repo-file" ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg-primary)" }}>
            <RepoFileBody project={artifact.project} path={artifact.path} />
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <CenteredNote>live localhost artifacts land in phase B</CenteredNote>
          </div>
        )}
      </aside>
    </>
  );
}

/** Repo-file body: one read per (project, path) feeding the Explorer's own
 *  FileViewer.
 *
 *  No `active` gate here, deliberately — explorer reads are ONE-SHOT (no poll
 *  to pause, unlike DocView's 2.5s doc poll), so gating on visibility would
 *  only buy a re-read on every screen switch back. Matches ExplorerView's
 *  read exactly. */
function RepoFileBody({ project, path }: { project: string; path: string }) {
  const [file, setFile] = useState<OpenFile | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFile({ path, content: null, error: null });
    explorerRead(project, path)
      .then((content) => {
        if (!cancelled) setFile({ path, content, error: null });
      })
      .catch((e) => {
        if (!cancelled) setFile({ path, content: null, error: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [project, path]);

  if (!file) return null;
  return <FileViewer file={file} />;
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
