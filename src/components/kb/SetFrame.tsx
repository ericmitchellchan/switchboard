// THE SET FRAME (SWIT-79, Ky's SetFrame CC-677): a switcher — `← n / N →`
// with the showing member's name and a list of them — above the member's
// ORDINARY surface. The body is whatever renders that member on its own tab
// (ArtifactSurface, recursively), so nothing about a view, a doc or a page
// changes because it is inside a set. `split` (the panel header's action, not
// this frame's — the header acts on the strip) turns the set back into tabs.
//
// Keys: `[` / `]` step, scoped to the frame's root (focusable, takes focus on
// a click that lands on nothing focusable — SurfaceHost's rule); a deck child
// inside handles the same keys first and marks the event handled, so a set
// of drilled charts steps the CHART, not the set. Enter opens nothing.
// The position lives in panelStore's per-set map (runtime-only).

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Artifact } from "../../types";
import { stepPosition, type SetArtifact } from "../../lib/artifactSets";
import { artifactIdentity, artifactShortTitle, describeArtifact, setSetPosition, useSetPosition } from "../../lib/panelStore";
import { ArtifactSurface } from "./ArtifactSurface";

const MONO = "var(--font-mono)";

/** kit: the toolbar row — 24px, hairline under, 10.5px `--text-dim`. */
const BAR: CSSProperties = {
  height: 24,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 8px 0 10px",
  borderBottom: "1px solid var(--border)",
  fontFamily: MONO,
  fontSize: 10.5,
  color: "var(--text-dim)",
  whiteSpace: "nowrap",
  overflow: "visible",
  position: "relative",
  background: "transparent",
};

/** kit: text glyph button — `--text-dim` → `--text-primary` on hover. */
const STEP: CSSProperties = {
  flex: "none",
  background: "none",
  border: "none",
  padding: "0 3px",
  fontFamily: MONO,
  fontSize: 12,
  lineHeight: 1,
  color: "var(--text-dim)",
  cursor: "pointer",
};

/** kit: list row (dense, 5px 8px, hover `--bg-active`). */
const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 8px",
  background: "none",
  border: "none",
  textAlign: "left",
  fontFamily: MONO,
  fontSize: 11,
  color: "var(--text-secondary)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

export function SetFrame({ set, active }: { set: SetArtifact; active: boolean }) {
  const size = set.items.length;
  const pos = useSetPosition(set);
  const item: Artifact | undefined = set.items[pos];
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The list closes when the membership or the position moves under it.
  useEffect(() => setOpen(false), [pos, size]);

  const go = useCallback(
    (i: number) => {
      setSetPosition(set, i);
    },
    [set]
  );
  const step = useCallback((dir: 1 | -1) => go(stepPosition(pos, dir, size)), [go, pos, size]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        step(e.key === "]" ? 1 : -1);
      }
    },
    [step]
  );
  const onMouseDown = useCallback(() => {
    const el = rootRef.current;
    const focused = document.activeElement;
    if (el && (focused === null || focused === document.body || !el.contains(focused))) {
      el.focus({ preventScroll: true });
    }
  }, []);

  if (!item) {
    return (
      <div style={{ flex: 1, padding: 24, textAlign: "center", fontFamily: MONO, fontSize: 11, color: "var(--text-dim)" }}>
        This set is empty.
      </div>
    );
  }

  const current = describeArtifact(item);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      data-testid="set-frame"
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", outline: "none" }}
    >
      <div style={BAR}>
        <button type="button" style={STEP} onClick={() => step(-1)} title="Previous in the set ([)" aria-label="Previous item">
          ←
        </button>
        <span style={{ flex: "none", color: "var(--text-secondary)" }} data-testid="set-counter">
          {pos + 1} / {size}
        </span>
        <button type="button" style={STEP} onClick={() => step(1)} title="Next in the set (])" aria-label="Next item">
          →
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={current.title}
          style={{
            flex: "0 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            background: "none",
            border: "none",
            padding: 0,
            fontFamily: MONO,
            fontSize: 11,
            color: "var(--text-primary)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          {artifactShortTitle(item)} <span style={{ color: "var(--text-dim)", fontSize: 10 }}>▾</span>
        </button>
        <span style={{ marginLeft: "auto", flex: "none", color: "var(--text-faint)", fontSize: 9.5 }}>{set.label}</span>
        {open && (
          <ul
            role="listbox"
            style={{
              position: "absolute",
              left: 0,
              top: 24,
              zIndex: 20,
              margin: 0,
              padding: "4px 0",
              listStyle: "none",
              width: "100%",
              maxHeight: "50vh",
              overflowY: "auto",
              background: "var(--bg-active)",
              border: "1px solid var(--border)",
              borderTop: "none",
            }}
          >
            {set.items.map((it, i) => (
              <li key={artifactIdentity(it)}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === pos}
                  onClick={() => go(i)}
                  title={describeArtifact(it).title}
                  style={{ ...ROW, color: i === pos ? "var(--text-primary)" : "var(--text-secondary)" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-elevated)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ flex: "none", width: 16, fontSize: 10, color: "var(--text-dim)" }}>{i + 1}</span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{artifactShortTitle(it)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* Keyed by the member's identity, so stepping remounts the member's
          own surface (its state is per-document, not per-slot). */}
      <div key={artifactIdentity(item)} style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
        <ArtifactSurface artifact={item} active={active} />
      </div>
    </div>
  );
}
