// Left workstation side menu — THE navigator (IDE-style). Hidden by default;
// Ctrl+Shift+B or clicking the SWITCHBOARD wordmark toggles (Ctrl+B stays
// the RIGHT task-sidebar cycle). 218px, bg --bg-secondary (#0A0A0B), border
// --border (#1E1E22), 9.5px uppercase section labels, active row = inset 2px
// WHITE left bar + #151518 bg. Soft palette only — black/white/zinc; color
// is reserved for status dots.
//
// THREE BANDS (SWIT-46, the coaching-platform reorg):
//   1. DESTINATIONS — Home · Trading · Research ▸ · Knowledge base ▸. The
//      expandables open INLINE; Research groups by project and renders ONLY
//      projects with research pages (registry `section: "research"` — an
//      empty group never draws, decided Q5).
//   2. THREADS — grouped by project, live first within each group, plus the
//      `shells` group (sessions no thread claims). ThreadsSection owns it.
//   3. EXPLORER — pinned at the bottom, FOLDED by default: the SWIT-31
//      Projects tree, unchanged inside.
// Bands 1–2 share one scroll area; band 3 scrolls inside its own cap so an
// expanded tree cannot push the destinations off screen.

import { useCallback, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Route } from "../types";
import { navigate, navigateToScreen } from "../lib/route";
import { projectsWithResearch, researchPages } from "../surfaces/registry";
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

// ── Band expansion (per-band, persisted like visibility) ─────────────────────

function useBandOpen(key: string, initial: boolean): [boolean, () => void] {
  const storageKey = `switchboard:sidemenu:${key}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? initial : stored === "open";
    } catch {
      return initial;
    }
  });
  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? "open" : "closed");
      } catch {
        // ignore
      }
      return next;
    });
  }, [storageKey]);
  return [open, toggle];
}

// ── Component ────────────────────────────────────────────────────────────────

const MENU_STYLE: CSSProperties = {
  width: 218,
  flex: "none",
  background: "var(--bg-secondary)",
  borderRight: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
};

const DEST_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 10px",
  background: "none",
  border: "none",
  color: "var(--text-secondary)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  textAlign: "left",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export function SideMenu({ route }: { route: Route }) {
  const [researchOpen, toggleResearch] = useBandOpen("research", false);
  const [kbOpen, toggleKb] = useBandOpen("kb", false);
  const [explorerOpen, toggleExplorer] = useBandOpen("explorer", false);

  return (
    <div style={MENU_STYLE}>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 8 }}>
        {/* ── Band 1: destinations ── */}
        <div style={{ paddingTop: 6 }}>
          <DestRow
            label="Home"
            glyph="⌂"
            active={route.screen === "home"}
            onClick={() => navigateToScreen("home")}
          />
          {/* Trading is lodestar's cockpit as a first-class destination (the
              2026-08-30 decision: full-width, and "Lodestar" is not a nav
              word — the row says what it IS). */}
          <DestRow
            label="Trading"
            glyph="▦"
            active={route.screen === "project" && route.project === "lodestar" && route.page === "trading"}
            onClick={() => navigate({ screen: "project", project: "lodestar", page: "trading" })}
          />
          <DestRow
            label="Research"
            glyph={researchOpen ? "▾" : "▸"}
            active={false}
            onClick={toggleResearch}
          />
          {researchOpen && <ResearchGroups route={route} />}
          <DestRow
            label="Knowledge base"
            glyph={kbOpen ? "▾" : "▸"}
            active={route.screen === "kb" && !kbOpen}
            onClick={toggleKb}
          />
          {kbOpen && <KbTreeSection route={route} />}
        </div>

        <div style={{ height: 1, background: "var(--border)", margin: "8px 0 2px" }} />

        {/* ── Band 2: threads by project ── */}
        {/* The label jumps to the full history screen — reachable even when
            the inline list is short enough that no `See all (N)` row shows. */}
        <SectionLabel onClick={() => navigateToScreen("threads")}>Threads</SectionLabel>
        <ThreadsSection />
      </div>

      {/* ── Band 3: Explorer, pinned at the bottom, folded by default ── */}
      <div
        style={{
          flex: "none",
          borderTop: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          maxHeight: explorerOpen ? "45%" : undefined,
        }}
      >
        <SectionLabel onClick={toggleExplorer}>
          Explorer <span style={{ float: "right", letterSpacing: 0 }}>{explorerOpen ? "▾" : "▸"}</span>
        </SectionLabel>
        {explorerOpen && (
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 8 }}>
            <ExplorerTreeSection route={route} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The Research band's inline groups: one per project WITH research pages
 *  (registry-driven; empty groups never render), each page a click to its
 *  full-width project route. */
function ResearchGroups({ route }: { route: Route }) {
  const projects = projectsWithResearch();
  if (projects.length === 0) {
    return (
      <div style={{ padding: "2px 12px 4px 31px", fontSize: 10, color: "var(--text-faint)" }}>
        no research pages yet
      </div>
    );
  }
  return (
    <>
      {projects.map((project) => (
        <div key={project}>
          <div
            style={{
              padding: "4px 12px 1px 31px",
              color: "var(--text-muted)",
              fontSize: 10.5,
              whiteSpace: "nowrap",
            }}
          >
            {project}
          </div>
          {researchPages(project).map((page) => {
            const isActive =
              route.screen === "project" && route.project === project && route.page === page.id;
            return (
              <DestRow
                key={page.id}
                label={page.label}
                indent={41}
                active={isActive}
                onClick={() => navigate({ screen: "project", project, page: page.id })}
              />
            );
          })}
        </div>
      ))}
    </>
  );
}

function DestRow({
  label,
  glyph,
  active,
  onClick,
  indent,
}: {
  label: string;
  glyph?: string;
  active: boolean;
  onClick: () => void;
  indent?: number;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...DEST_ROW,
        paddingLeft: indent ?? 10,
        background: active ? "var(--bg-active)" : "none",
        boxShadow: active ? "inset 2px 0 0 var(--text-primary)" : "none",
        color: active || hover ? "var(--text-primary)" : "var(--text-secondary)",
      }}
    >
      {glyph && (
        <span style={{ width: 14, flex: "none", color: "var(--text-muted)", fontSize: 11 }}>
          {glyph}
        </span>
      )}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
    </button>
  );
}

function SectionLabel({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      title={onClick ? "Open" : undefined}
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
