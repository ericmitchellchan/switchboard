// KNOWLEDGE BASE section of the side menu — the KB doc tree rendered INLINE
// (IDE-style navigator). Adapted from the former kb/KbTree.tsx screen rail
// (deleted with this change): same buildKbTree/ancestorFolders data layer,
// same ▸/▾ expand rows and active-doc-ancestor force-expand; what changed is
// the host (218px side menu instead of an in-screen rail) and the indent
// (10px/level for the tighter column). Soft palette only.
//
// Rows carry IDE folder/file symbols (increment B, acceptance 5): the
// expander plus panelStore.FOLDER_GLYPH on folders, glyphForPath (docKind-
// aware) on docs. The vocabulary is panelStore's, shared with the panel
// header and the `+` picker.
//
// Clicking a DOC goes through panelStore.openArtifact (A3): on the terminal
// screen it opens IN THE PANEL beside the running shell, on the kb screen it
// navigates full-width as before, and Ctrl/⌘+click inverts either one. The
// decision itself lives in panelStore — this file only supplies the target and
// the modifier.
//
// Expansion state and the doc list live at MODULE level so hiding the menu
// (it unmounts) and reopening it keeps the tree where you left it — the same
// keep-alive feel the kb screen's rail got for free from the screen cache.

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Route } from "../types";
import { ancestorFolders, buildKbTree, useKbDocList } from "../lib/kb";
import type { KbNode } from "../lib/kb";
import { getNavState } from "../lib/route";
import {
  FOLDER_GLYPH,
  glyphForPath,
  openArtifact,
  useActiveTabArtifact,
} from "../lib/panelStore";

// Survives menu unmount (visibility toggle). Not persisted to disk — a fresh
// launch starts collapsed, matching the wireframe's ▸ project rows.
let expandedCache: ReadonlySet<string> = new Set<string>();

export function KbTreeSection({ route }: { route: Route }) {
  const { docs, error } = useKbDocList(true); // menu visible = section active
  const tree = buildKbTree(docs ?? []);

  // Active doc — the highlight must name what is ACTUALLY on screen (A3):
  //   · on the kb screen, that's the route's doc (full-width reading wins);
  //   · on the terminal screen, the PANEL is the visible doc surface, so its
  //     artifact wins when it holds a kb-doc;
  //   · otherwise fall back to the last kb route, so the doc you were reading
  //     stays highlighted while you work elsewhere (unchanged behavior).
  const panelArtifact = useActiveTabArtifact();
  const panelDoc =
    route.screen === "terminal" && panelArtifact?.kind === "kb-doc"
      ? panelArtifact.path
      : undefined;
  const lastKb = getNavState().lastByScreen.kb;
  const routeDoc =
    route.screen === "kb" ? route.doc : lastKb?.screen === "kb" ? lastKb.doc : undefined;
  const activeDoc = panelDoc ?? routeDoc;

  const [expanded, setExpandedState] = useState<ReadonlySet<string>>(() => {
    // Force-expand the active doc's ancestors at mount so a deep link /
    // restored route is revealed even in a fresh tree.
    if (!activeDoc) return expandedCache;
    const next = new Set(expandedCache);
    for (const p of ancestorFolders(activeDoc)) next.add(p);
    expandedCache = next;
    return next;
  });

  const setExpanded = (next: ReadonlySet<string>) => {
    expandedCache = next;
    setExpandedState(next);
  };

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };

  const select = (path: string, modifier: boolean) => {
    // Reveal the selection's ancestors (mirrors the old rail's force-expand
    // effect), then let the routing helper decide panel vs full-width.
    const needed = ancestorFolders(path);
    if (!needed.every((p) => expanded.has(p))) {
      const next = new Set(expanded);
      for (const p of needed) next.add(p);
      setExpanded(next);
    }
    openArtifact({ kind: "kb-doc", path }, { modifier });
  };

  return (
    <div>
      {error !== null && <TreeMessage>KB unavailable: {error}</TreeMessage>}
      {error === null && docs !== null && tree.length === 0 && (
        <TreeMessage>no docs in the knowledge base</TreeMessage>
      )}
      {tree.map((node) => (
        <KbTreeNode
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          activeDoc={activeDoc}
          onSelect={select}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

function KbTreeNode({
  node,
  depth,
  expanded,
  activeDoc,
  onSelect,
  onToggle,
}: {
  node: KbNode;
  depth: number;
  expanded: ReadonlySet<string>;
  activeDoc: string | undefined;
  onSelect: (path: string, modifier: boolean) => void;
  onToggle: (path: string) => void;
}) {
  if (node.type === "folder") {
    const isOpen = expanded.has(node.path);
    return (
      <>
        <TreeRow
          label={node.name}
          prefix={isOpen ? "▾" : "▸"}
          icon={FOLDER_GLYPH}
          depth={depth}
          active={false}
          onClick={() => onToggle(node.path)}
        />
        {isOpen &&
          node.children.map((child) => (
            <KbTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              activeDoc={activeDoc}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
      </>
    );
  }
  return (
    <TreeRow
      label={node.name}
      icon={glyphForPath(node.path)}
      depth={depth}
      active={node.path === activeDoc}
      // Ctrl/⌘+click inverts panel-vs-full-width (Decision 2); ⌘ so the chord
      // reads native on a Mac build.
      onClick={(e) => onSelect(node.path, e.ctrlKey || e.metaKey)}
    />
  );
}

// ── Shared side-menu tree row primitives (also used by ExplorerTreeSection) ──

export function TreeMessage({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "4px 12px",
        color: "var(--text-dim)",
        fontSize: 10.5,
        lineHeight: 1.5,
        wordBreak: "break-word",
      }}
    >
      {children}
    </div>
  );
}

/** The gutter: expander slot + kind glyph, in ONE flex child so the pair costs
 *  a single row gap instead of two (218px is the whole budget, and a deep
 *  nesting level spends 10px/level of it before this).
 *
 *  The expander slot is a FIXED 5px whether or not the row has an arrow, so a
 *  file's name lines up under its sibling folders' names the way an IDE tree
 *  does. `lineHeight: 1` keeps a 9px glyph from ever growing the 4px-padded
 *  row: height stays exactly what it was before the glyphs existed. */
const GUTTER_STYLE: CSSProperties = {
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 3,
  fontSize: 9,
  lineHeight: 1,
};

export function TreeRow({
  label,
  prefix,
  icon,
  depth,
  active,
  meta,
  dim,
  leading,
  hoverAction,
  onClick,
}: {
  label: string;
  /** ▸/▾ for expandable rows; undefined renders a blank expander slot. */
  prefix?: string;
  /** Kind glyph — panelStore.FOLDER_GLYPH on directories, glyphForPath on
   *  files (acceptance 5). Dim by construction: it must never compete with
   *  the row label. */
  icon?: string;
  depth: number;
  active: boolean;
  /** Right-aligned dim meta text (e.g. project status). */
  meta?: string;
  /** Dim the label (archived projects). */
  dim?: boolean;
  /** Leading inline element (e.g. the live-thread status dot). */
  leading?: ReactNode;
  /** Revealed on hover only, left of `meta` (the thread rows' `×` pattern).
   *  Must be a `role="button"` span, never a nested <button>. */
  hoverAction?: ReactNode;
  /** The event is passed so opening rows can read the Ctrl/⌘ modifier
   *  (Decision 2's inversion); expand rows ignore it. */
  onClick: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    width: "100%",
    padding: `4px 10px 4px ${12 + depth * 10}px`,
    background: active ? "var(--bg-active)" : hover ? "var(--bg-elevated)" : "none",
    border: "none",
    boxShadow: active ? "inset 2px 0 0 var(--text-primary)" : "none",
    color: dim
      ? "var(--text-dim)"
      : active || hover
        ? "var(--text-primary)"
        : "var(--text-secondary)",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
    textAlign: "left",
    cursor: "pointer",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={label}
      style={style}
    >
      {(prefix !== undefined || icon !== undefined) && (
        <span style={GUTTER_STYLE} aria-hidden="true">
          <span style={{ flex: "none", width: 5, color: "var(--text-dim)" }}>{prefix ?? ""}</span>
          {icon !== undefined && (
            <span style={{ flex: "none", color: "var(--text-muted)" }}>{icon}</span>
          )}
        </span>
      )}
      {leading}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      {hover && hoverAction}
      {meta !== undefined && (
        <span
          style={{
            flex: "none",
            fontSize: 9.5,
            color: dim ? "var(--text-faint)" : "var(--text-dim)",
          }}
        >
          {meta}
        </span>
      )}
    </button>
  );
}
