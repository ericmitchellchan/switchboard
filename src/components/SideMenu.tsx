// Left workstation side menu — THE navigator (IDE-style). Hidden by default;
// Ctrl+Shift+B or clicking the SWITCHBOARD wordmark toggles (Ctrl+B stays
// the RIGHT task-sidebar cycle). 218px, bg --bg-secondary (#0A0A0B), border
// --border (#1E1E22), 9.5px uppercase section labels, active row = inset 2px
// WHITE left bar + #151518 bg. Soft palette only — black/white/zinc; color
// is reserved for status dots.
//
// Sections are TREES, not nav items (design correction, 2026-08-01): the
// KNOWLEDGE BASE section IS the doc tree and the PROJECTS section (SWIT-31,
// formerly Explorer) IS the registry-projects tree — each project a folder of
// pages / knowledge / repo / terminals — no intermediate "Browse docs"/"By
// repo" rows, and the screens themselves render content only (breadcrumb +
// viewer). "terminal" has no row: the session tab bar is its navigation.

import { useCallback, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Route } from "../types";
import { navigateToScreen } from "../lib/route";
import { ThreadsSection } from "./ThreadsSection";
import { KbTreeSection } from "./KbTreeSection";
import { ExplorerTreeSection } from "./ExplorerTreeSection";

// ── Visibility (hidden by default) ───────────────────────────────────────────
// Chosen default: HIDDEN — the app boots exactly as today and the menu is
// opt-in chrome. Persisted to localStorage (mirrors useSidebarState) so a
// toggled-on menu survives reloads. Config-file wiring comes later.

const STORAGE_KEY = "switchboard:sidemenu";

function loadVisible(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "visible";
  } catch {
    return false;
  }
}

export function useSideMenuVisibility(): [boolean, () => void] {
  const [visible, setVisible] = useState<boolean>(loadVisible);

  const toggle = useCallback(() => {
    setVisible((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "visible" : "hidden");
      } catch {
        // ignore — visibility just won't persist
      }
      return next;
    });
  }, []);

  return [visible, toggle];
}

// ── Component ────────────────────────────────────────────────────────────────

const MENU_STYLE: CSSProperties = {
  width: 218,
  flex: "none",
  background: "var(--bg-secondary)",
  borderRight: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  overflowY: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  paddingBottom: 8,
};

export function SideMenu({ route }: { route: Route }) {
  return (
    <div style={MENU_STYLE}>
      {/* Thread rows (T5): status dot + title + repo meta / revive chip,
          plus the "+ new thread" affordance. Data comes from the threadStore
          singleton; actions bridge back to App via registerThreadActions —
          no prop plumbing through here. */}
      {/* The label jumps to the full history screen, exactly as the KB and
          Explorer labels jump to theirs — so the history is reachable even
          when the inline list is short enough that no `See all (N)` row is
          shown (a "See all (3)" over 3 visible rows would be dead chrome). */}
      <SectionLabel onClick={() => navigateToScreen("threads")}>Threads</SectionLabel>
      <ThreadsSection />

      {/* The KB doc tree, inline — clicking a doc navigates the kb screen.
          The section label itself jumps back to the kb screen (lastByScreen
          restores the last open doc) — interim affordance until the artifact
          panel makes docs co-present with shells. */}
      <SectionLabel onClick={() => navigateToScreen("kb")}>Knowledge Base</SectionLabel>
      <KbTreeSection route={route} />

      {/* PROJECTS (platform evolution, SWIT-31 — was "Explorer"): each registry
          project is a folder whose children are what the project IS — its live
          `pages`, its `knowledge` (the KB folder + the repo's knowledge/specs/
          docs), its `repo` file tree, and its `terminals`. Clicking a file
          navigates the explorer screen as before; the label jumps back likewise. */}
      <SectionLabel onClick={() => navigateToScreen("explorer")}>Projects</SectionLabel>
      <ExplorerTreeSection route={route} />
    </div>
  );
}

function SectionLabel({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      title={onClick ? "Open this screen (restores your last selection)" : undefined}
      style={{
        padding: "10px 12px 4px",
        color: "var(--text-dim)",
        fontSize: 9.5,
        textTransform: "uppercase",
        letterSpacing: 1,
        cursor: onClick ? "pointer" : undefined,
      }}
    >
      {children}
    </div>
  );
}

