// The pins rail (increment F, Decision 4) — ONE collapsible rail, shared by
// every surface that annotates something: WireframeView's mockup pins and the
// live localhost preview's positional pins.
//
// It exists as its own component for the same reason ArtifactBody does: the
// rail was about to be written twice, and two copies of "how wide, what the
// header says, what collapsing means" drift. The CONTENTS differ per surface
// (a wireframe note card is not a live pin card), so the contents are
// `children`; the chrome, the width, the toggle and the preference are here.
//
// COLLAPSED IS A REAL EDGE, not a disappearance: 26px of clickable rail
// carrying the chevron and the count. A rail that vanished completely would
// take its own toggle with it.
//
// The rule for what "collapsed" defaults to lives in lib/pinsRail.ts (pure,
// unit-tested); this component owns only the sessionStorage read/write, in the
// same WRITE-THROUGH style as WireframeView's zoom — never an effect keyed on
// [identity, collapsed], which would clobber the stored value on a doc switch
// (the recorded bug).

import { useCallback, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  RAIL_COLLAPSED_WIDTH,
  RAIL_WIDTH,
  railStorageKey,
  railStorageValue,
  resolveRailCollapsed,
} from "../../lib/pinsRail";
import { Icon } from "../icons";

function loadStored(identity: string): string | null {
  try {
    return sessionStorage.getItem(railStorageKey(identity));
  } catch {
    return null;
  }
}

const BASE_STYLE: CSSProperties = {
  flexShrink: 0,
  borderLeft: "1px solid var(--border)",
  background: "var(--bg-secondary)",
  display: "flex",
  flexDirection: "column",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text-muted)",
  letterSpacing: 0.5,
  cursor: "pointer",
  userSelect: "none",
};

export function PinsRail({
  /** Artifact identity — the preference is PER DOCUMENT, like zoom. */
  identity,
  /** Pin count: shown in the header and, on first sight of a document, the
   *  thing that decides the default (zero pins → collapsed). */
  count,
  /** Optional second line under the header — the live preview uses it to say
   *  WHICH ROUTE these pins belong to, which a cross-origin frame makes
   *  worth stating out loud. */
  scopeNote,
  children,
}: {
  identity: string;
  count: number;
  scopeNote?: string;
  children: ReactNode;
}) {
  // Initializer, not an effect: this component is mounted with a per-document
  // key upstream, so the initializer re-runs per document and the stored
  // preference is read exactly once per mount.
  const [collapsed, setCollapsed] = useState(() => resolveRailCollapsed(loadStored(identity), count));

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        sessionStorage.setItem(railStorageKey(identity), railStorageValue(next));
      } catch {
        // storage unavailable — the toggle still works for this mount
      }
      return next;
    });
  }, [identity]);

  if (collapsed) {
    return (
      <div
        style={{ ...BASE_STYLE, width: RAIL_COLLAPSED_WIDTH, alignItems: "center", cursor: "pointer" }}
        onClick={toggle}
        title={count === 0 ? "Show pins" : `Show ${count} pin${count === 1 ? "" : "s"}`}
        aria-label="Expand pins"
        role="button"
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: 26,
            color: "var(--text-dim)",
          }}
        >
          <Icon name="chevron-left" />
        </div>
        {count > 0 && (
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontWeight: 600,
              color: "var(--text-secondary)",
            }}
          >
            {count}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ ...BASE_STYLE, width: RAIL_WIDTH, overflow: "hidden" }}>
      <div
        style={{ ...HEADER_STYLE, padding: "10px 8px 6px 10px" }}
        onClick={toggle}
        title="Hide pins"
        aria-label="Collapse pins"
        role="button"
      >
        <span>
          PINS <span style={{ color: "var(--text-primary)" }}>{count}</span>
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ display: "flex", alignItems: "center", color: "var(--text-dim)" }}>
          <Icon name="chevron-right" />
        </span>
      </div>
      {scopeNote && (
        <div
          style={{
            flexShrink: 0,
            padding: "0 10px 6px",
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            color: "var(--text-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={scopeNote}
        >
          {scopeNote}
        </div>
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "0 10px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {children}
      </div>
    </div>
  );
}
