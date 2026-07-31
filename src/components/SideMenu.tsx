// Left workstation side menu (T4) — NEW chrome, purely additive: hidden by
// default, Ctrl+Shift+B toggles (Ctrl+B stays the RIGHT task-sidebar cycle).
// Look follows the approved wireframe (personal-kb …/workstation-shell.html):
// 218px, bg --bg-secondary (#0A0A0B), border --border (#1E1E22), 9.5px
// uppercase section labels, active row = inset 2px WHITE left bar + #151518
// bg. Soft palette only — black/white/zinc; color is reserved for status dots.
//
// This is a declarative registry, not a hand-grown component tree:
// - TopScreenId is Exclude<ScreenId, …> so a new nav-worthy ScreenId FAILS TO
//   COMPILE until it gets an ICONS entry.
// - TOP_ITEMS order = render order within each section.
// Later tasks replace exactly the marked registration blocks below.

import { useCallback, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Route, ScreenId } from "../types";
import { navigateToScreen } from "../lib/route";
import { ThreadsSection } from "./ThreadsSection";

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

// ── Nav registry ─────────────────────────────────────────────────────────────

/** ScreenIds that get a nav row in the menu. "terminal" is excluded because it
 *  is reached through the session tab bar (clicking any tab returns to it),
 *  not through the menu. The Exclude<> keeps ICONS exhaustive: adding a
 *  nav-worthy ScreenId without an icon is a compile error. */
type TopScreenId = Exclude<ScreenId, "terminal">;

type SectionId = "threads" | "kb" | "explorer";

type TopItem = {
  id: TopScreenId;
  section: SectionId;
  label: string;
  icon: ReactNode;
};

const ICONS: Record<TopScreenId, ReactNode> = {
  kb: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
      <path d="M4 4h13a3 3 0 013 3v13H7a3 3 0 01-3-3V4zM4 17a3 3 0 013-3h13" />
    </svg>
  ),
  explorer: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    </svg>
  ),
};

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "threads", label: "Threads" },
  { id: "kb", label: "Knowledge Base" },
  { id: "explorer", label: "Explorer" },
];

const TOP_ITEMS: TopItem[] = [
  { id: "kb", section: "kb", label: "Browse docs", icon: ICONS.kb },
  { id: "explorer", section: "explorer", label: "By repo", icon: ICONS.explorer },
];

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
      {SECTIONS.map((section) => (
        <div key={section.id}>
          <SectionLabel>{section.label}</SectionLabel>
          {section.id === "threads" && (
            <>
              {/* Thread rows (T5): status dot + title + repo meta / revive
                  chip, plus the "+ new thread" affordance. Data comes from
                  the threadStore singleton; actions bridge back to App via
                  registerThreadActions — no prop plumbing through here. */}
              <ThreadsSection />
            </>
          )}
          {TOP_ITEMS.filter((item) => item.section === section.id).map(
            (item) => (
              <MenuItem
                key={item.id}
                item={item}
                active={route.screen === item.id}
              />
            )
          )}
        </div>
      ))}
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 12px 4px",
        color: "var(--text-dim)",
        fontSize: 9.5,
        textTransform: "uppercase",
        letterSpacing: 1,
      }}
    >
      {children}
    </div>
  );
}

function MenuItem({ item, active }: { item: TopItem; active: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigateToScreen(item.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "5px 12px",
        background: active ? "var(--bg-active)" : "none",
        border: "none",
        boxShadow: active ? "inset 2px 0 0 var(--text-primary)" : "none",
        color:
          active || hover ? "var(--text-primary)" : "var(--text-secondary)",
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          flex: "none",
          color: active ? "var(--text-primary)" : "var(--text-dim)",
        }}
      >
        {item.icon}
      </span>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {item.label}
      </span>
    </button>
  );
}
