// The TOP BAR (SWIT-45). The tab strip is RETIRED — a thread IS the screen
// now, and switching between them is the side menu's job (plus Ctrl+[ ] /
// Ctrl+1–9). The 44px bar keeps its height and becomes three things:
// wordmark (side-menu toggle) · breadcrumb (where you are) · right actions
// (panel side ⇄, float, panel toggle). The file keeps its name so the git
// history of the bar stays in one place.
import { useEffect, useRef, useState } from "react";
import type { Route, Session } from "../types";
import { PulsingDot } from "./PulsingDot";
import { STATUS_CONFIGS } from "../lib/statusConfig";
import { tabRepoSuffix } from "../lib/tabLabel";
import { Icon } from "./icons";

interface TopBarProps {
  route: Route;
  /** The focused pane's session — what the breadcrumb names on the terminal
   *  screen. Null when no session exists. */
  activeSession: Session | null;
  /** Whether that session is bound to a thread record — `Thread /` vs
   *  `Shell /`. A plain Ctrl+T shell is not a thread (promote-on-claude). */
  isThread: boolean;
  waitingCount: number;
  /** Clicking the SWITCHBOARD wordmark toggles the left side menu — same
   *  action as Ctrl+Shift+B. */
  onToggleSideMenu?: () => void;
  /** Double-click rename on the breadcrumb name — the tab strip's inline
   *  rename, relocated. Goes through the same one-name path (App's
   *  handleRenameTab), so a bound thread's row renames with it. */
  onRename?: (id: string, newName: string) => void;
  /** `⇄` — flip the active tab's panel side (SWIT-33). Rendered only while
   *  the panel is OPEN: flipping an invisible panel is a dead affordance. */
  onTogglePanelSide?: () => void;
  panelSide?: "left" | "right";
  /** `float` — the floating window (Ctrl+Shift+O), same handler as the
   *  status-bar chip. Rendered whenever a session is focused. */
  onFloat?: () => void;
  /** RIGHT-END panel button, unchanged from the tab-bar era: toggles the
   *  panel, or opens the `+` picker on a tab whose panel is empty. */
  onPanelButton?: () => void;
  /** The active tab's panel is open right now → active treatment. */
  panelOpen?: boolean;
  /** The active tab has a panel open OR remembers one → the button toggles.
   *  False means it opens the picker. */
  panelToggleAvailable?: boolean;
}

const DIM: React.CSSProperties = { color: "#52525B" };
const BRIGHT: React.CSSProperties = { color: "#E4E4E7" };

export function TopBar({
  route,
  activeSession,
  isThread,
  waitingCount,
  onToggleSideMenu,
  onRename,
  onTogglePanelSide,
  panelSide = "right",
  onFloat,
  onPanelButton,
  panelOpen = false,
  panelToggleAvailable = false,
}: TopBarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        backgroundColor: "#0A0A0B",
        borderBottom: "1px solid #1E1E22",
        height: 44,
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {/* Wordmark = side-menu toggle (same as Ctrl+Shift+B). */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          gap: 7,
          borderRight: "1px solid #1E1E22",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={onToggleSideMenu}
          title="Toggle side menu (Ctrl+Shift+B)"
          style={{
            background: "none",
            border: "none",
            padding: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            fontWeight: 700,
            color: "#E4E4E7",
            letterSpacing: "0.02em",
            cursor: "pointer",
          }}
        >
          SWITCHBOARD
        </button>
        {waitingCount > 0 && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#0A0A0B",
              backgroundColor: "#F59E0B",
              borderRadius: 4,
              padding: "1px 5px",
              fontFamily: "var(--font-mono)",
            }}
          >
            {waitingCount}
          </span>
        )}
      </div>

      {/* Breadcrumb — where you are. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 14px",
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
        }}
      >
        <Breadcrumb route={route} activeSession={activeSession} isThread={isThread} onRename={onRename} />
      </div>

      {/* Right actions: ⇄ side · float · panel. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 6px",
          borderLeft: "1px solid #1E1E22",
          flexShrink: 0,
        }}
      >
        {panelOpen && onTogglePanelSide && (
          <TextAction
            label={`⇄ ${panelSide === "left" ? "right" : "left"}`}
            title={`Move the artifact panel to the ${panelSide === "left" ? "right" : "left"} side of this tab`}
            onClick={onTogglePanelSide}
          />
        )}
        {onFloat && (
          <TextAction
            label="float"
            title="Open or close the floating always-on-top window (Ctrl+Shift+O)"
            onClick={onFloat}
          />
        )}
        {onPanelButton && (
          <PanelButton onClick={onPanelButton} open={panelOpen} toggles={panelToggleAvailable} />
        )}
      </div>
    </div>
  );
}

/** Where you are, as one line. The terminal screen names the focused session
 *  (`Thread / <name> · <repo>`, the suffix under tabLabel's de-duplication
 *  rule); every other screen names itself — the full-width screens carry
 *  their own detailed breadcrumb headers already, so this stays coarse. */
function Breadcrumb({
  route,
  activeSession,
  isThread,
  onRename,
}: {
  route: Route;
  activeSession: Session | null;
  isThread: boolean;
  onRename?: (id: string, newName: string) => void;
}) {
  switch (route.screen) {
    case "home":
      return <span style={BRIGHT}>Home</span>;
    case "kb":
      return <span style={BRIGHT}>Knowledge base</span>;
    case "explorer":
      return <span style={BRIGHT}>Explorer</span>;
    case "threads":
      return <span style={BRIGHT}>Threads</span>;
    case "project":
      return (
        <>
          <span style={DIM}>{route.project} /</span>
          <span style={BRIGHT}>{route.page}</span>
        </>
      );
    case "terminal": {
      if (!activeSession) return <span style={DIM}>No session</span>;
      const cfg = STATUS_CONFIGS[activeSession.status] || STATUS_CONFIGS.running;
      const suffix = tabRepoSuffix(activeSession.name, activeSession.repo);
      return (
        <>
          <span style={DIM}>{isThread ? "Thread /" : "Shell /"}</span>
          <PulsingDot color={cfg.color} pulse={cfg.pulse} size={7} />
          <SessionName session={activeSession} onRename={onRename} />
          {suffix && <span style={{ ...DIM, fontSize: 10.5 }}>{suffix}</span>}
        </>
      );
    }
  }
}

/** The session's name, double-click to rename in place — the tab strip's
 *  inline editor, relocated onto the breadcrumb. */
function SessionName({
  session,
  onRename,
}: {
  session: Session;
  onRename?: (id: string, newName: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(session.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    if (value.trim() && value.trim() !== session.name) {
      onRename?.(session.id, value.trim());
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "#E4E4E7",
          backgroundColor: "#27272A",
          border: "1px solid #3F3F46",
          borderRadius: 3,
          padding: "1px 4px",
          outline: "none",
          width: Math.max(80, value.length * 7.5),
        }}
      />
    );
  }
  return (
    <span
      style={{ ...BRIGHT, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}
      title={onRename ? "Double-click to rename" : undefined}
      onDoubleClick={() => {
        if (!onRename) return;
        setValue(session.name);
        setEditing(true);
      }}
    >
      {session.name}
    </span>
  );
}

/** Small text action in the bar's right end — same soft treatment as the
 *  status bar's chips; no new hue. */
function TextAction({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        background: hover ? "var(--bg-elevated)" : "transparent",
        border: "none",
        borderRadius: 4,
        padding: "4px 8px",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        color: hover ? "var(--text-primary)" : "#71717A",
        cursor: "pointer",
        transition: "background-color 0.15s ease, color 0.15s ease",
      }}
    >
      {label}
    </button>
  );
}

/** The artifact panel's button — right end of the bar, mirroring the
 *  wordmark's side-menu toggle at the left end. Unchanged from the tab-bar
 *  era: it toggles the panel, or opens the `+` picker when the panel is
 *  empty (a toggle with nothing to show would be a dead affordance). */
function PanelButton({
  onClick,
  open,
  toggles,
}: {
  onClick: () => void;
  open: boolean;
  toggles: boolean;
}) {
  const [hover, setHover] = useState(false);
  const title = open
    ? "Hide the artifact panel (Ctrl+Shift+P)"
    : toggles
      ? "Show the artifact panel (Ctrl+Shift+P)"
      : "Open an artifact in the panel — Ctrl+Shift+P toggles it once something is open";
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      aria-label={title}
      aria-pressed={open}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 24,
        height: 24,
        padding: 0,
        borderRadius: 4,
        border: "none",
        background: open
          ? "var(--bg-active)"
          : hover
            ? "var(--bg-elevated)"
            : "transparent",
        color: open || hover ? "var(--text-primary)" : "#71717A",
        cursor: "pointer",
        transition: "background-color 0.15s ease, color 0.15s ease",
      }}
    >
      <Icon name="panel" size={14} />
    </button>
  );
}
