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
// INCREMENT H — the panel can host a LIVE PTY SESSION as an artifact, and it
// is the ONLY host that ever will. The terminal is CREATED here (`+ → new
// terminal`) and lives here; it is never mirrored from a pane, because one
// session with two live views is exactly the ownership-steal case
// terminalRegistry arbitrates. Three facts make that structural rather than
// arbitrated:
//   1. App renders ONE ArtifactPanel, for the ACTIVE tab, and only its ACTIVE
//      artifact has a body;
//   2. panelStore keeps a session artifact in AT MOST ONE strip (openInPanel);
//   3. App filters panel-OWNED sessions out of the tab bar and the pane tree
//      (panelStore.isPanelOwnedSession), including the single-pane branch,
//      which otherwise mounts every session it is handed.
// `promote to tab` therefore MOVES the session (park → commit → release) and
// `×` on a live one ASKS first. The terminal itself is App's `renderSession`
// prop: this file stays chrome + lifecycle and mounts no xterm of its own.
//
// ICONS (2026-08-02): the header's kind mark is an SVG from components/icons,
// like both trees and the picker. The TAB STRIP deliberately stays text-only —
// a tab caps at 150px and horizontal room is the scarce axis, so 14px spent on
// a mark that is identical on every tab (one file icon now) would buy nothing
// the header directly beneath it does not already say.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Artifact, PanelState, RepoConfig } from "../types";
import { navigate } from "../lib/route";
import {
  activateArtifact,
  artifactIdentity,
  closeArtifactPicker,
  openArtifactPicker,
  useArtifactPickerOpen,
  artifactShortTitle,
  flushTerminalTranscript,
  closeArtifactAt,
  closePanelTerminal,
  createPanelTerminal,
  describeArtifact,
  fullWidthRoute,
  openInPanel,
  panelLayoutFor,
  panelStateFor,
  panelWidthFromDrag,
  promotePanelTerminal,
  setPanelWidth,
  sendToThread,
  useSendToThreadAvailable,
  useSessionLabel,
  usePanelTerminalsAvailable,
  clearPoppedOutArtifact,
  popOutArtifact,
  usePopOutAvailable,
  usePoppedOutIdentity,
  DIVIDER_WIDTH,
  usePanelsView,
  type ArtifactCrumb,
} from "../lib/panelStore";
import { buildSendReference, refOptions } from "../lib/agentContext";
import { useDirtyKeys } from "../lib/editor";
import { STATUS_CONFIGS } from "../lib/statusConfig";
import { ArtifactPicker } from "./ArtifactPicker";
import { Icon } from "./icons";
import { PulsingDot } from "./PulsingDot";
import { ArtifactSurface } from "./kb/ArtifactSurface";

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
  onClose,
}: {
  sessionId: string;
  state: PanelState;
  onAdd: () => void;
  /** Closing a tab is NOT always `closeArtifactAt` any more (increment H): a
   *  live terminal's tab goes through App's guard first. One entry point, so
   *  the `×` and the middle-click cannot diverge. */
  onClose: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  // WHICH documents hold unsaved edits (increment G). A newline-joined string
  // snapshot, so the strip re-renders when the dirty SET changes and never on
  // a keystroke inside one buffer.
  const dirtyKeys = useDirtyKeys();

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
          const identity = artifactIdentity(artifact);
          // `\n`-delimited on both ends so `kb-doc:a.md` cannot match inside
          // `kb-doc:a.md.bak`.
          const isDirtyTab = `\n${dirtyKeys}\n`.includes(`\n${identity}\n`);
          return (
            <div
              // Keyed by CONTENT, not position: the dedupe invariant makes it
              // unique, and closing a middle tab then re-keys nothing (a
              // positional key would re-map every tab's DOM to its neighbour's).
              key={identity}
              role="tab"
              aria-selected={isActive}
              title={isDirtyTab ? `${title} — unsaved changes` : title}
              onClick={() => activateArtifact(sessionId, i)}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered((prev) => (prev === i ? null : prev))}
              // Middle-click closes, as everywhere else tabs exist.
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(i);
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
              {/* UNSAVED marker (increment G): the tab strip is where you see
                  that a document you switched away from still holds work. Same
                  dot the markdown surface's own toolbar draws, from the same
                  predicate. */}
              {isDirtyTab && (
                <span
                  aria-label="unsaved changes"
                  style={{
                    flex: "none",
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: isActive ? "var(--text-primary)" : "var(--text-muted)",
                  }}
                />
              )}
              {/* A LIVE SHELL gets a mark and a status dot (increment H) —
                  the one place the text-only rule bends, and it earns it: the
                  glyph says "this tab is a process, not a document" and the dot
                  is the same statusConfig colour the tab bar shows, so a dev
                  server going red is visible without opening the tab. */}
              {artifact.kind === "session" && (
                <SessionTabMark sessionId={artifact.sessionId} active={isActive} />
              )}
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                {artifactShortTitle(artifact)}
              </span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(i);
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

/** A session tab's leading mark: the terminal glyph plus its LIVE status dot.
 *  Subscribes narrowly (useSessionLabel) so a status flip repaints this span
 *  and nothing else — a strip with a running dev server in it must not re-render
 *  the whole panel every time the detector moves. */
function SessionTabMark({ sessionId, active }: { sessionId: string; active: boolean }) {
  const label = useSessionLabel(sessionId);
  // No label = App does not know this session (its record is gone). Grey
  // "exited" is the honest read; an idle dot would claim a shell that is not
  // there.
  const cfg = label ? STATUS_CONFIGS[label.status] : STATUS_CONFIGS.exited;
  return (
    <span style={{ flex: "none", display: "flex", alignItems: "center", gap: 3 }}>
      <Icon
        name="terminal"
        size={10}
        style={{ color: active ? "var(--text-secondary)" : "var(--text-muted)" }}
      />
      <PulsingDot color={cfg.color} pulse={cfg.pulse} size={5} />
    </span>
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
  /** Config repos, forwarded to the `+` picker's new-terminal level so it
   *  offers the SAME merged registry list Ctrl+T does. */
  repos,
  /** THE ONE LIVE VIEW of a panel terminal (increment H). App owns it — it has
   *  the session records and TerminalPane's whole callback set — and the panel
   *  renders it in exactly one place: the body of the ACTIVE tab of the ACTIVE
   *  tab's panel. Nothing else in the app may mount a panel-owned session
   *  (App filters them out of the tab bar and the pane tree), which is what
   *  makes "one session, one view" structural rather than arbitrated. */
  renderSession,
}: {
  sessionId: string | null;
  active: boolean;
  repos: RepoConfig[];
  renderSession: (sessionId: string) => ReactNode;
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
  // Pop-out (increment F, Decision 2). `canPopOut` is App's handler being
  // registered; `poppedIdentity` is WHICH artifact the floating window is
  // holding, so this tab can show a placeholder instead of a second live copy.
  const canPopOut = usePopOutAvailable();
  const poppedIdentity = usePoppedOutIdentity();
  // Are App's panel-terminal actions wired? (create / promote / guarded close.)
  // Gates the affordances so none of them is ever a silent no-op.
  const canHostTerminals = usePanelTerminalsAvailable();
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
    return pickerOpen && sessionId ? (
      <PickerOverlay sessionId={sessionId} repos={repos} />
    ) : null;
  }

  const layout = panelLayoutFor(containerWidth, panelWidth);
  const overlay = layout.mode === "overlay";
  const { icon, crumbs, title } = describeArtifact(artifact);

  // Crossover to the full-width screen. Shares panelStore's `fullWidthRoute`
  // with the routing helper's navigate branch, so "open full" and a
  // full-width click can never drift to different routes for the same
  // artifact. (localhost and session have no full-width screen — the button is
  // hidden for both below, and the type reflects that. For a session,
  // `promote to tab` IS the full-width move, and it is a different thing: it
  // relocates the live view rather than opening a second look at content.)
  const openFull = () => {
    if (artifact.kind !== "kb-doc" && artifact.kind !== "repo-file") return;
    navigate(fullWidthRoute(artifact));
  };

  // T8 seam 2 (explicit, visible): TYPE a reference to this artifact into the
  // terminal — no Enter. The user reviews/edits and sends it himself.
  //
  // A LIVE TERMINAL is referenceable now (2026-08-02): the ref names its
  // transcript mirror, and the FLUSH below is what makes that honest. Order
  // matters — flush, then type — so the file the agent is pointed at already
  // holds what Eric was looking at when he clicked. The flush resolves even on
  // failure, so the send is never swallowed.
  const reference = buildSendReference(artifact, null, {
    ...refOptions(),
    sessionName: artifactShortTitle(artifact),
  });
  const sendReference = () => {
    if (artifact.kind === "session") {
      void flushTerminalTranscript(artifact.sessionId).then(() => sendToThread(reference));
      return;
    }
    sendToThread(reference);
  };
  // A session with no resolvable scrollback root has no ref at all (the root
  // lookup failed at boot) — the action would type nothing, so it is hidden
  // rather than offered.
  const canReference = reference.length > 0;

  // Is THIS tab's active artifact the one in the floating window?
  const isPoppedOut = poppedIdentity === artifactIdentity(artifact);

  // ── Panel terminals (increment H) ──
  // A live shell is not a document: it cannot be opened full width, cannot be
  // referenced to an agent, and must never float (a second live view). What it
  // CAN do is move to the tab bar, and it always asks before it dies.
  const isSession = artifact.kind === "session";
  /** Closing a tab: a session's close goes through App's guard (which asks when
   *  the process is alive), everything else closes immediately. ONE function,
   *  used by the strip's `×`, the middle-click and the header's `×`. */
  const closeTabAt = (index: number) => {
    const target = state.artifacts[index];
    if (target?.kind === "session" && canHostTerminals) {
      closePanelTerminal(sessionId, target.sessionId);
      return;
    }
    closeArtifactAt(sessionId, index);
  };

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
          onClose={closeTabAt}
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
          {/* PROMOTE TO TAB (increment H, Decision 2) — the panel's escape
              hatch. It MOVES the session to the tab bar (park → commit →
              release, App side), so at no point are there two views of it;
              this tab strip loses the tab in the same gesture. Only ever shown
              for a session artifact, and only when App is there to do it. */}
          {isSession && canHostTerminals && (
            <button
              type="button"
              onClick={() => promotePanelTerminal(artifact.sessionId)}
              title={`Move ${title} to the tab bar — same session, same scrollback, full width`}
              style={ACTION_STYLE}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
            >
              promote to tab
            </button>
          )}
          {/* `→ thread` NOW APPLIES TO A LIVE SHELL TOO (2026-08-02). Eric put
              a `pnpm dev` in the panel beside a claude thread and asked the
              thread to look at it: "that's the whole point — seeing the same
              surface." It cannot see the process, but it can read the
              transcript this app already mirrors, and that is what the
              reference names. `float` and `open full` stay hidden for a
              session: one is a second live view, the other is what `promote to
              tab` already does. */}
          {canReference && (
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
          )}
          {!isSession && (
          <>
          {/* POP OUT (increment F, Decision 2) — hand this artifact to the
              floating PiP window. The same window the Ctrl+Shift+O terminal
              mirror uses: one window lifecycle, and it finally has a
              discoverable entry point (this button and the status bar's). */}
          <button
            type="button"
            onClick={() => (isPoppedOut ? clearPoppedOutArtifact() : popOutArtifact(artifact))}
            disabled={!canPopOut}
            title={
              !canPopOut
                ? "Floating window unavailable"
                : isPoppedOut
                  ? `Bring ${title} back into the panel`
                  : `Show ${title} in the floating window`
            }
            style={{
              ...ACTION_STYLE,
              color: isPoppedOut ? "var(--text-primary)" : "var(--text-dim)",
              opacity: canPopOut ? 1 : 0.35,
              cursor: canPopOut ? "pointer" : "default",
            }}
            onMouseEnter={(e) => {
              if (canPopOut) e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = isPoppedOut ? "var(--text-primary)" : "var(--text-dim)")
            }
          >
            {isPoppedOut ? "↙ back" : "↗ float"}
          </button>
          {artifact.kind !== "localhost" && (
            // OPEN FULL is an ICON now (increment G, Decision 5) — the `open`
            // mark from the shared module, which already means "go to it" in
            // the thread row menu. The words were the widest thing in a 36px
            // header on a 260px panel; the affordance is not.
            <button
              type="button"
              onClick={openFull}
              title={`Open ${title} full width`}
              aria-label={`Open ${title} full width`}
              style={{ ...ACTION_STYLE, display: "flex", alignItems: "center", padding: "0 3px" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
            >
              <Icon name="open" size={12} />
            </button>
          )}
          </>
          )}
          <button
            type="button"
            // The header `×` acts on the ACTIVE tab, and for a session that
            // means the guard, not a silent kill — same entry point the strip's
            // own `×` uses. (`closePanel` is exactly `closeArtifactAt` on the
            // active index, which is what this now spells out.)
            onClick={() => closeTabAt(state.artifacts.indexOf(artifact))}
            title={
              isSession
                ? `Close ${title} — asks what to do with the process`
                : state.artifacts.length > 1
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

        {/* Body by kind — the SAME components the screens render, through the
            SAME surface the floating window renders (kb/ArtifactSurface), so a
            popped-out artifact and a panelled one can never diverge.
            While it is popped out the panel deliberately renders a PLACEHOLDER
            rather than a second live copy: two frames on one dev server, two
            health polls and two mounts of one pin sidecar is not co-presence,
            it is duplication. */}
        {isPoppedOut ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <CenteredNote>
              showing in the floating window
              <br />
              <button
                type="button"
                onClick={clearPoppedOutArtifact}
                style={{ ...ACTION_STYLE, marginTop: 8, color: "var(--text-secondary)" }}
              >
                ↙ bring it back
              </button>
            </CenteredNote>
          </div>
        ) : isSession ? (
          // THE ONE LIVE VIEW. Rendered HERE and nowhere else — before
          // ArtifactSurface, which deliberately refuses to draw a terminal so
          // no other host (the floating window above all) can become a second
          // one. `minWidth: 0` is the LocalhostView lesson applied: this is a
          // flex item wrapping a terminal whose min-content width is its
          // columns, and without it the panel would overflow at the 260px
          // floor instead of letting the terminal scroll horizontally (which
          // the existing grow-only policy already handles — no resize code
          // lives here either).
          <div
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              background: "var(--bg-primary)",
            }}
          >
            {renderSession(artifact.sessionId)}
          </div>
        ) : (
          <ArtifactSurface artifact={artifact} active={active} />
        )}
      </aside>
      {/* The `+` picker. A SIBLING of the panel (position:fixed, out of flow)
          so an overflow:hidden column can never clip it, and so it survives an
          overlay/docked flip. It always ADDS TO THIS PANEL — openInPanel, not
          openArtifact: `+` is not a click on a tree row and must never navigate
          away from the shell it was pressed beside. */}
      {pickerOpen && <PickerOverlay sessionId={sessionId} repos={repos} />}
    </>
  );
}

/** The `+` picker, mounted for a specific tab. Rendered from TWO places in
 *  ArtifactPanel — beside a live panel, and INSTEAD of one when the tab has no
 *  artifacts yet — so the "always adds to THIS panel" rule is written once.
 *  `openInPanel`, never `openArtifact`: `+` is not a click on a tree row and
 *  must never navigate away from the shell it was pressed beside. */
function PickerOverlay({ sessionId, repos }: { sessionId: string; repos: RepoConfig[] }) {
  return (
    <ArtifactPicker
      // Dismissal is the store's (openInPanel clears the request), so a pick
      // that lands on the already-active tab still closes the modal.
      onPick={(target: Artifact) => openInPanel(sessionId, target)}
      // `new terminal` — App spawns through its EXISTING creation path and
      // opens the result here. Dismissal is App's in this branch (the spawn is
      // async and can fail), so the picker is closed up front: a modal left
      // hanging over a shell that is booting reads as a hang.
      onNewTerminal={(target) => {
        closeArtifactPicker();
        createPanelTerminal(sessionId, target);
      }}
      repos={repos}
      onClose={closeArtifactPicker}
    />
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
