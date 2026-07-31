// KB doc tree (T6) — the left rail INSIDE the kb screen body (the SideMenu is
// separate T4 chrome and is not touched here). Look follows the approved
// wireframe row 2 (personal-kb …/wireframes/workstation-shell.html): ~220px
// column, project groups expandable (▸/▾), 11.5px doc rows, active row =
// --bg-active + 2px white inset bar. Soft palette only — black/white/zinc;
// no color here.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ancestorFolders, buildKbTree } from "../../lib/kb";
import type { KbNode } from "../../lib/kb";

const RAIL_STYLE: CSSProperties = {
  width: 220,
  flex: "none",
  background: "var(--bg-secondary)",
  borderRight: "1px solid var(--border)",
  overflowY: "auto",
  overflowX: "hidden",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  paddingTop: 6,
  paddingBottom: 10,
};

export function KbTree({
  docs,
  error,
  activeDoc,
  onSelect,
}: {
  /** Flat relative-path list (null = never loaded). */
  docs: string[] | null;
  error: string | null;
  activeDoc: string | undefined;
  onSelect: (path: string) => void;
}) {
  const tree = useMemo(() => buildKbTree(docs ?? []), [docs]);

  // Expanded folder paths. Starts collapsed (matches the wireframe's ▸
  // project rows); the open doc's ancestors are force-expanded so navigation
  // (deep link, restored route) always reveals the selection.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!activeDoc) return;
    const needed = ancestorFolders(activeDoc);
    setExpanded((prev) => {
      if (needed.every((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      for (const p of needed) next.add(p);
      return next;
    });
  }, [activeDoc]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div style={RAIL_STYLE}>
      {error !== null && <RailMessage>KB unavailable: {error}</RailMessage>}
      {error === null && docs !== null && tree.length === 0 && (
        <RailMessage>no docs in the knowledge base</RailMessage>
      )}
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          activeDoc={activeDoc}
          onSelect={onSelect}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

function RailMessage({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 10.5, lineHeight: 1.5, wordBreak: "break-word" }}>
      {children}
    </div>
  );
}

function TreeNode({
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
            <TreeNode
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

function TreeRow({
  label,
  prefix,
  depth,
  active,
  onClick,
}: {
  label: string;
  prefix?: string;
  depth: number;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={label}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        padding: `4px 10px 4px ${12 + depth * 12}px`,
        background: active ? "var(--bg-active)" : hover ? "var(--bg-elevated)" : "none",
        border: "none",
        boxShadow: active ? "inset 2px 0 0 var(--text-primary)" : "none",
        color: active || hover ? "var(--text-primary)" : "var(--text-secondary)",
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      {prefix !== undefined && (
        <span style={{ flex: "none", fontSize: 9, color: "var(--text-dim)" }}>{prefix}</span>
      )}
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
    </button>
  );
}
