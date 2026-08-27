// The PROJECT screen body (platform evolution, SWIT-30) — a project's page
// FULL WIDTH: the "open full" of a surface artifact, and where a page lands
// when opened from a reading screen (panelStore.decideOpen's navigate branch).
//
// Same chrome as ExplorerView: BackButton + a 36px breadcrumb over the
// content, nothing else — the side menu is the navigator. The breadcrumb
// reads `project / pages / Page`, the shape the tree and the panel header
// both use (describeArtifact), so the three never disagree about a page's
// name. The body is the SAME SurfaceHost the panel renders — one host, two
// hosts' worth of chrome — painted on `--bg-primary` because that is the
// full-width value (the panel paints the same host on `--bg-panel`).

import type { CSSProperties } from "react";
import { BackButton } from "./BackButton";
import { SurfaceHost } from "../surfaces/SurfaceHost";
import { surfaceLabel } from "../surfaces/registry";

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

export function ProjectView({
  project,
  page,
  active,
  menuHidden,
}: {
  project: string;
  page: string;
  /** The screen is on display — gates the surface's backend probe exactly as
   *  the panel's `active` does. */
  active: boolean;
  /** The side menu is closed — print the same way-back hint ExplorerView
   *  does, because with the navigator hidden nothing on this screen says
   *  how to reach the other pages. */
  menuHidden: boolean;
}) {
  const label = surfaceLabel(project, page);
  return (
    <div style={ROOT_STYLE}>
      <div style={HEAD_STYLE}>
        <BackButton />
        <span style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{project}</span>
        <span>/</span>
        <span>pages</span>
        <span>/</span>
        <span style={{ color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis" }}>
          {label}
        </span>
        {menuHidden && (
          <span style={{ marginLeft: "auto", color: "var(--text-faint)", fontSize: 10.5 }}>
            Ctrl+Shift+B (or click SWITCHBOARD) opens the navigator
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", background: "var(--bg-primary)" }}>
        <SurfaceHost
          key={`${project}:${page}`}
          artifact={{ kind: "surface", project, page }}
          active={active}
        />
      </div>
    </div>
  );
}
