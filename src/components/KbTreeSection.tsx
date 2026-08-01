// KNOWLEDGE BASE section of the side menu — the KB doc tree rendered INLINE
// (IDE-style navigator). Adapted from the former kb/KbTree.tsx screen rail
// (deleted with this change): same buildKbTree/ancestorFolders data layer,
// same ▸/▾ expand rows and active-doc-ancestor force-expand; what changed is
// the host (218px side menu instead of an in-screen rail) and the indent
// (10px/level for the tighter column). Clicking a DOC navigates
// ({screen:"kb", doc}) exactly as the rail did. Soft palette only.
//
// Expansion state and the doc list live at MODULE level so hiding the menu
// (it unmounts) and reopening it keeps the tree where you left it — the same
// keep-alive feel the kb screen's rail got for free from the screen cache.

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Route } from "../types";
import { ancestorFolders, buildKbTree, useKbDocList } from "../lib/kb";
import type { KbNode } from "../lib/kb";
import { navigate, getNavState } from "../lib/route";

// Survives menu unmount (visibility toggle). Not persisted to disk — a fresh
// launch starts collapsed, matching the wireframe's ▸ project rows.
let expandedCache: ReadonlySet<string> = new Set<string>();

export function KbTreeSection({ route }: { route: Route }) {
  const { docs, error } = useKbDocList(true); // menu visible = section active
  const tree = buildKbTree(docs ?? []);

  // Active doc: the route's doc while on kb, else the last kb route's — the
  // open doc stays highlighted while you work in the terminal (keep-alive
  // keeps it mounted; the tree is the one place that shows where you are).
  const lastKb = getNavState().lastByScreen.kb;
  const activeDoc =
    route.screen === "kb" ? route.doc : lastKb?.screen === "kb" ? lastKb.doc : undefined;

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

  const select = (path: string) => {
    // Reveal the selection's ancestors (mirrors the old rail's force-expand
    // effect) and navigate.
    const needed = ancestorFolders(path);
    if (!needed.every((p) => expanded.has(p))) {
      const next = new Set(expanded);
      for (const p of needed) next.add(p);
      setExpanded(next);
    }
    navigate({ screen: "kb", doc: path });
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
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  if (node.type === "folder") {
    const isOpen = expanded.has(node.path);
    return (
      <>
        <TreeRow
          label={node.name}
          prefix={isOpen ? "▾" : "▸"}
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
      depth={depth}
      active={node.path === activeDoc}
      onClick={() => onSelect(node.path)}
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

export function TreeRow({
  label,
  prefix,
  depth,
  active,
  meta,
  dim,
  leading,
  onClick,
}: {
  label: string;
  /** ▸/▾ for expandable rows; undefined renders no arrow slot. */
  prefix?: string;
  depth: number;
  active: boolean;
  /** Right-aligned dim meta text (e.g. project status). */
  meta?: string;
  /** Dim the label (archived projects). */
  dim?: boolean;
  /** Leading inline element (e.g. the live-thread status dot). */
  leading?: ReactNode;
  onClick: () => void;
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
      {prefix !== undefined && (
        <span style={{ flex: "none", fontSize: 9, color: "var(--text-dim)" }}>{prefix}</span>
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
