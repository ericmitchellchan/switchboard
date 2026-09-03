// Left workstation side menu — THE navigator (IDE-style). Hidden by default;
// Ctrl+Shift+B or clicking the SWITCHBOARD wordmark toggles (Ctrl+B stays
// the RIGHT task-sidebar cycle). 218px, bg --bg-secondary (#0a0a0a), border
// --border (#2e2e2e), 9.5px uppercase section labels, active row = inset 2px
// WHITE left bar + --bg-active bg. Soft palette only — black/white/zinc; color
// is reserved for status dots.
//
// THREE BANDS (SWIT-46, the coaching-platform reorg):
//   1. DESTINATIONS — Home · Trading · Research ▸ · Knowledge base ▸. The
//      expandables open INLINE; Research groups by project and renders ONLY
//      projects with research pages (registry `section: "research"` — an
//      empty group never draws, decided Q5).
//   2. THREADS — ThreadsSection owns the whole band INCLUDING its header
//      (`THREADS · SEE ALL · +`, SWIT-56): flat, live first, then recency in
//      bare mode; the SWIT-46 project grouping + `shells` group in full mode.
//   3. EXPLORER — pinned at the bottom, FOLDED by default: the SWIT-31
//      Projects tree, unchanged inside.
// Bands 1–2 share one scroll area; band 3 scrolls inside its own cap so an
// expanded tree cannot push the destinations off screen.
//
// SHELL MODE (SWIT-55): in BARE mode (the default) the Research band and the
// Explorer band do not render — the menu is `Home · Trading · Knowledge base
// ▸` then THREADS. `?shell=full` / config `shell_mode` brings them back. The
// gate is a render check here (`useShellMode`), never a code-path removal:
// their routes still resolve and their code stays built and tested.

import { useCallback, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { Artifact, Route } from "../types";
import { navigateToScreen } from "../lib/route";
import { openArtifact, useActiveTabArtifact } from "../lib/panelStore";
import { useShellMode } from "../lib/shellMode";
import { projectsWithResearch, researchPages } from "../surfaces/registry";
import { ThreadsSection } from "./ThreadsSection";
import type { RepoConfig } from "../types";
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

export function SideMenu({ route, repos }: { route: Route; repos: readonly RepoConfig[] }) {
  const [researchOpen, toggleResearch] = useBandOpen("research", false);
  const [kbOpen, toggleKb] = useBandOpen("kb", false);
  const [explorerOpen, toggleExplorer] = useBandOpen("explorer", false);
  const bare = useShellMode() === "bare";
  const shown = useActiveTabArtifact();

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
          {/* Trading is lodestar's cockpit as a first-class destination ("Lodestar"
              is not a nav word — the row says what it IS). T9 (SWIT-63, R8): it
              opens BESIDE the active thread, in its preview slot — the 2026-08-30
              full-width rule is dropped; `decideOpen` owns the rule (Ctrl+click
              = full width; no thread = full width), so the row cannot drift from
              the tree's pages. Lit when the page is on screen EITHER way. */}
          <DestRow
            label="Trading"
            glyph="▦"
            active={isSurfaceShown(route, shown, "lodestar", "trading")}
            onClick={(e) =>
              openArtifact(
                { kind: "surface", project: "lodestar", page: "trading" },
                { modifier: e.ctrlKey || e.metaKey }
              )
            }
          />
          {!bare && (
            <DestRow
              label="Research"
              glyph={researchOpen ? "▾" : "▸"}
              active={false}
              onClick={toggleResearch}
            />
          )}
          {!bare && researchOpen && <ResearchGroups route={route} shown={shown} />}
          <DestRow
            label="Knowledge base"
            glyph={kbOpen ? "▾" : "▸"}
            active={route.screen === "kb" && !kbOpen}
            onClick={toggleKb}
          />
          {kbOpen && <KbTreeSection route={route} />}
        </div>

        <div style={{ height: 1, background: "var(--border)", margin: "8px 0 2px" }} />

        {/* ── Band 2: threads ── header + rows, all ThreadsSection's (SWIT-56) */}
        <ThreadsSection repos={repos} />
      </div>

      {/* ── Band 3: Explorer, pinned at the bottom, folded by default ── */}
      {!bare && (
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
      )}
    </div>
  );
}

/** Is this page ON SCREEN — full width (the project route) OR in the active
 *  thread's panel, which renders on the TERMINAL screen only? One predicate
 *  for every destination row, so the two homes light the same row. The
 *  screen gate is what keeps the word "shown" true: the panel's artifact is
 *  per-tab state that navigation never touches, so without it a row stayed
 *  lit on Home / KB for a page nobody could see. */
function isSurfaceShown(route: Route, shown: Artifact | null, project: string, page: string): boolean {
  if (route.screen === "project") return route.project === project && route.page === page;
  if (route.screen !== "terminal") return false;
  return shown?.kind === "surface" && shown.project === project && shown.page === page;
}

/** The Research band's inline groups: one per project WITH research pages
 *  (registry-driven; empty groups never render), each page a click through
 *  the same open rule as Trading (preview slot; Ctrl+click full width). */
function ResearchGroups({ route, shown }: { route: Route; shown: Artifact | null }) {
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
          {researchPages(project).map((page) => (
            <DestRow
              key={page.id}
              label={page.label}
              indent={41}
              active={isSurfaceShown(route, shown, project, page.id)}
              onClick={(e) =>
                openArtifact(
                  { kind: "surface", project, page: page.id },
                  { modifier: e.ctrlKey || e.metaKey }
                )
              }
            />
          ))}
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
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
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
