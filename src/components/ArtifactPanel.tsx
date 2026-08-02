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
//
// INCREMENT B — the panel holds a STRIP of artifacts, not one. Chrome is two
// rows, in IDE order:
//   1. the TAB STRIP (24px): one tab per open artifact, short title + `×`,
//      plus a trailing `+` that opens the ArtifactPicker. It sits ON TOP
//      because that is what a tab strip means everywhere else — the row below
//      it describes the SELECTED tab, rather than a title the tabs contradict.
//   2. the existing 36px header, unchanged in behaviour: its breadcrumb,
//      `open full`, `→ thread` and `×` all act on the ACTIVE artifact.
// The header is kept rather than replaced: it carries the full breadcrumb and
// the three actions, none of which fit a 150px tab. 60px of vertical chrome is
// affordable in a full-height column; horizontal room is the scarce axis, and
// the strip spends none of it (the `+` lives OUTSIDE the scroller, so it stays
// reachable at the 260px floor no matter how many tabs are open).
//
// ICONS (2026-08-02): the header's kind mark is an SVG from components/icons,
// like both trees and the picker. The TAB STRIP deliberately stays text-only —
// a tab caps at 150px and horizontal room is the scarce axis, so 14px spent on
// a mark that is identical on every tab (one file icon now) would buy nothing
// the header directly beneath it does not already say.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Artifact, PanelState } from "../types";
import { navigate } from "../lib/route";
import { explorerRead } from "../lib/explorer";
import {
  activateArtifact,
  artifactIdentity,
  closeArtifactPicker,
  openArtifactPicker,
  useArtifactPickerOpen,
  artifactShortTitle,
  closeArtifactAt,
  closePanel,
  describeArtifact,
  fullWidthRoute,
  openInPanel,
  panelLayoutFor,
  panelStateFor,
  panelWidthFromDrag,
  setPanelWidth,
  sendToThread,
  useSendToThreadAvailable,
  DIVIDER_WIDTH,
  usePanelsView,
  type ArtifactCrumb,
  type OpenableArtifact,
} from "../lib/panelStore";
import { buildSendReference, refOptions } from "../lib/agentContext";
import { ArtifactPicker } from "./ArtifactPicker";
import { Icon } from "./icons";
import { DocView } from "./kb/DocView";
import { FileViewer, type OpenFile } from "./ExplorerView";

/** Tone → paint. Exported because the KB SCREEN's breadcrumb renders the same
 *  crumbs from the same `describeArtifact` — panel and screen must not drift
 *  (that drift is exactly what the "mirrors the KB screen exactly" comment on
 *  describeArtifact used to promise by hand). */
export const CRUMB_TONE: Record<ArtifactCrumb["tone"], CSSProperties> = {
  lead: { color: "var(--text-secondary)", fontWeight: 600 },
  dim: { color: "var(--text-dim)", fontWeight: 400 },
  bright: { color: "var(--text-primary)", fontWeight: 400 },
};

/** The panel's surface value (Increment B, Decision 4 / acceptance 6).
 *
 *  The terminal side is `--bg-primary` #0C0C0E; the panel is `--bg-panel`
 *  #1A1A1D — several steps up the SAME zinc ramp, measured at **1.126:1**.
 *  The first pass used `--bg-elevated` #0F0F11, which is 3/255 per channel
 *  and **1.021:1** — arithmetically a step, visually nothing; acceptance 6
 *  was being carried entirely by the divider, and in OVERLAY mode (no
 *  divider) by a single hairline. #1A1A1D is a difference you can see without
 *  looking for it, and still sits BELOW `--border` #1E1E22 so the 4px divider
 *  keeps reading against the panel.
 *
 *  Still no new hue, no tinted text, no status colour touched: same neutral
 *  zinc, +3 blue like every other value in the ramp. The soft palette holds
 *  (2026-08-01 convention).
 *
 *  Applied to the STRIP, the header (by inheritance) and the body together —
 *  the panel's own viewers paint `transparent` so they take whichever surface
 *  hosts them (#1A1A1D here, #0C0C0E on the full-width screens). Anything
 *  painting `--bg-primary` inside the panel punches a terminal-coloured hole
 *  in it. */
const PANEL_SURFACE = "var(--bg-panel)";

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

/** Tab strip — one row of artifact tabs plus the `+`.
 *
 *  The tab list SCROLLS horizontally; the `+` is its sibling, not its last
 *  child, so it never scrolls out of reach on a 260px panel with eight tabs
 *  open.
 *
 *  Tab ramp (raised with the panel surface): an INACTIVE tab is recessed to
 *  `--bg-primary` — deliberately the terminal's value, i.e. "not this
 *  document" — hover lifts it to `--bg-active`, and the ACTIVE tab is the
 *  panel surface itself, continuous with the header and body beneath it, plus
 *  a 2px zinc rule on top and weight 600. That is the IDE reading (the active
 *  tab belongs to the document) and it keeps the whole panel one surface. No
 *  new accent (Decision 4 keeps colour functional-only). */
function TabStrip({
  sessionId,
  state,
  onAdd,
}: {
  sessionId: string;
  state: PanelState;
  onAdd: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  // Follow the active tab when it changes or the strip grows past the edge —
  // an opened artifact whose tab is off-screen reads as "nothing happened".
  useEffect(() => {
    const item = listRef.current?.children[state.activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.activeIndex, state.artifacts.length]);

  return (
    <div
      role="tablist"
      aria-label="Open artifacts"
      style={{
        height: 24,
        flex: "none",
        display: "flex",
        alignItems: "stretch",
        borderBottom: "1px solid var(--border)",
        // The strip, the header and the body are ONE surface (--bg-elevated):
        // the panel is distinguished from the terminal side by its own value
        // in the zinc ramp, not by internal banding. See PANEL_SURFACE.
        background: PANEL_SURFACE,
      }}
    >
      <div
        ref={listRef}
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "stretch",
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none",
        }}
      >
        {state.artifacts.map((artifact, i) => {
          const isActive = i === state.activeIndex;
          const isHovered = hovered === i;
          const { title } = describeArtifact(artifact);
          return (
            <div
              // Keyed by CONTENT, not position: the dedupe invariant makes it
              // unique, and closing a middle tab then re-keys nothing (a
              // positional key would re-map every tab's DOM to its neighbour's).
              key={artifactIdentity(artifact)}
              role="tab"
              aria-selected={isActive}
              title={title}
              onClick={() => activateArtifact(sessionId, i)}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered((prev) => (prev === i ? null : prev))}
              // Middle-click closes, as everywhere else tabs exist.
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeArtifactAt(sessionId, i);
                }
              }}
              style={{
                flex: "none",
                maxWidth: 150,
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "0 4px 0 9px",
                borderRight: "1px solid var(--border)",
                boxShadow: isActive ? "inset 0 2px 0 var(--text-muted)" : "none",
                // active = the panel surface (transparent over the strip);
                // inactive recesses to the terminal value; hover lifts halfway.
                background: isActive
                  ? "transparent"
                  : isHovered
                    ? "var(--bg-active)"
                    : "var(--bg-primary)",
                color: isActive
                  ? "var(--text-primary)"
                  : isHovered
                    ? "var(--text-secondary)"
                    : "var(--text-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                fontWeight: isActive ? 600 : 400,
                cursor: "pointer",
                whiteSpace: "nowrap",
                transition: "background-color 0.15s ease, color 0.15s ease",
              }}
            >
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                {artifactShortTitle(artifact)}
              </span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  closeArtifactAt(sessionId, i);
                }}
                title={`Close ${title}`}
                style={{
                  flex: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 13,
                  height: 13,
                  borderRadius: 2,
                  fontSize: 11,
                  lineHeight: 1,
                  color: "var(--text-dim)",
                  // Reserved space, not conditional rendering: a tab must not
                  // resize under the cursor as you sweep the strip.
                  visibility: isActive || isHovered ? "visible" : "hidden",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--border-subtle)";
                  e.currentTarget.style.color = "var(--text-primary)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--text-dim)";
                }}
              >
                ×
              </span>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onAdd}
        title="Open another artifact"
        aria-label="Open another artifact"
        style={{
          flex: "none",
          width: 24,
          background: "none",
          border: "none",
          borderLeft: "1px solid var(--border)",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          lineHeight: 1,
          color: "var(--text-dim)",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
      >
        +
      </button>
    </div>
  );
}

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
  // usePanelsView is the SUBSCRIPTION (re-render on any store change, and the
  // panel does want the width); `panelStateFor` is the documented accessor for
  // the strip itself, so the lookup rule lives in exactly one place.
  const { panelWidth } = usePanelsView();
  const state: PanelState | null = panelStateFor(sessionId);
  // The ACTIVE tab is what the header, the body and every header action mean by
  // "the artifact". The strip invariants (non-empty, in-range index) are the
  // store's, so this index is trusted — but read defensively anyway, since a
  // null here is the difference between an empty panel and a crash.
  const artifact: Artifact | null = state?.artifacts[state.activeIndex] ?? null;
  const open = artifact !== null && state !== null;
  // T8 seam 2 gate — no terminal to type into means the `→ thread` action is
  // DISABLED, never a silent no-op. Hook order: before the early return below.
  const canSend = useSendToThreadAvailable();
  // The picker request lives in panelStore, keyed by TAB (see
  // §"`+` picker request"): the tab bar's panel button opens it for a tab whose
  // panel is EMPTY, and an empty panel renders nothing that could hold a
  // component-local flag.
  const pickerOpen = useArtifactPickerOpen(sessionId);

  // The picker belongs to the panel that opened it: a TAB SWITCH dismisses it
  // rather than leaving a modal that would open into a different tab. (A
  // completed pick is dismissed by the store, inside openInPanel.)
  useEffect(() => {
    return () => closeArtifactPicker();
  }, [sessionId]);

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

  if (!open || !sessionId || !state || !artifact) {
    // Nothing to draw — EXCEPT the picker, which this tab may have asked for
    // with an empty panel (the tab bar's panel button). It is `position:
    // fixed`, so it needs no panel behind it; picking builds the panel.
    return pickerOpen && sessionId ? <PickerOverlay sessionId={sessionId} /> : null;
  }

  const layout = panelLayoutFor(containerWidth, panelWidth);
  const overlay = layout.mode === "overlay";
  const { icon, crumbs, title } = describeArtifact(artifact);

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
          background: PANEL_SURFACE,
          // A hairline at the panel's own edge, in BOTH modes. Docked, it sits
          // just inside the 4px divider and gives the surface change a crisp
          // boundary instead of letting two near-blacks meet on a soft edge;
          // `--border-subtle` #27272A is the brighter of the two hairline
          // tokens, which is the "slightly stronger border" this needs. The
          // global border-box means it costs 1px of `layout.width`, not an
          // extra pixel of layout.
          borderLeft: "1px solid var(--border-subtle)",
          width: layout.width,
          ...(overlay
            ? {
                position: "absolute",
                top: 0,
                right: 0,
                bottom: 0,
                zIndex: 6,
                boxShadow: "-10px 0 28px rgba(0, 0, 0, 0.55)",
              }
            : { flex: "none", minWidth: 0 }),
        }}
      >
        <TabStrip
          sessionId={sessionId}
          state={state}
          onAdd={() => openArtifactPicker(sessionId)}
        />
        <header style={HEAD_STYLE}>
          <Icon name={icon} style={{ color: "var(--text-faint)" }} />
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
            title={
              state.artifacts.length > 1
                ? `Close ${title} (Ctrl+Shift+P hides the panel)`
                : "Close panel (Ctrl+Shift+P)"
            }
            aria-label="Close artifact"
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
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <RepoFileBody project={artifact.project} path={artifact.path} />
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <CenteredNote>live localhost artifacts land in phase B</CenteredNote>
          </div>
        )}
      </aside>
      {/* The `+` picker. A SIBLING of the panel (position:fixed, out of flow)
          so an overflow:hidden column can never clip it, and so it survives an
          overlay/docked flip. It always ADDS TO THIS PANEL — openInPanel, not
          openArtifact: `+` is not a click on a tree row and must never navigate
          away from the shell it was pressed beside. */}
      {pickerOpen && <PickerOverlay sessionId={sessionId} />}
    </>
  );
}

/** The `+` picker, mounted for a specific tab. Rendered from TWO places in
 *  ArtifactPanel — beside a live panel, and INSTEAD of one when the tab has no
 *  artifacts yet — so the "always adds to THIS panel" rule is written once.
 *  `openInPanel`, never `openArtifact`: `+` is not a click on a tree row and
 *  must never navigate away from the shell it was pressed beside. */
function PickerOverlay({ sessionId }: { sessionId: string }) {
  return (
    <ArtifactPicker
      // Dismissal is the store's (openInPanel clears the request), so a pick
      // that lands on the already-active tab still closes the modal.
      onPick={(target: OpenableArtifact) => openInPanel(sessionId, target)}
      onClose={closeArtifactPicker}
    />
  );
}

/** Repo-file body: one read per (project, path) feeding the Explorer's own
 *  FileViewer — which since increment C routes by the SAME `docKind` switch a
 *  KB doc goes through, so an `.html` mockup in a repo renders here exactly as
 *  it does from the KB tree.
 *
 *  No `active` gate here, deliberately — explorer reads are ONE-SHOT (no poll
 *  to pause, unlike DocView's 2.5s doc poll), so gating on visibility would
 *  only buy a re-read on every screen switch back. Matches ExplorerView's
 *  read exactly. */
function RepoFileBody({ project, path }: { project: string; path: string }) {
  const [file, setFile] = useState<OpenFile | null>(null);
  // One-shot reads need an explicit way to run again — the wireframe toolbar's
  // ⟳ (see WireframeView). Re-running THIS effect keeps the panel's read and
  // the Explorer screen's read identical, which is the whole point of them
  // being the same two lines.
  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

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
  }, [project, path, reloadNonce]);

  if (!file) return null;
  return <FileViewer project={project} file={file} onReload={reload} />;
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
