// SURFACE PINS (platform evolution, Inc 3b — SWIT-36): the numbered marks on
// a live page and the rail beside it.
//
// The shape is LocalhostView's pin layer, with one difference that changes
// everything underneath: a surface pin is ANCHORED, not positional. The mark
// is not drawn at a stored percentage — it is drawn where the page says its
// anchor IS right now (`provider.locateAnchor`), and re-asked whenever the
// page could have moved: a resize of the surface, a mutation inside it (data
// arrived, a filter changed, a drill-in opened), or a nested scroll. A pin
// whose anchor the page cannot locate (a trade filtered out, a bar outside
// the window) draws NO mark and says "not on screen" in the rail — there is
// deliberately no positional fallback, because a mark drawn where the thing
// used to be is a lie with a number on it.
//
// Placement is single-shot, exactly like the wireframe and the live preview:
// arm pin mode, click the thing, pin mode disarms. A click that lands on
// nothing pinnable is refused with a note rather than pinning the void.
//
// The pins file is the shared refcounted store (pinsStore) — the same page
// open in the panel AND the floating window edits one record. Notes,
// deletion and the rail's collapse preference use the same PinsRail the other
// two hosts use; the row chrome is a deliberate local copy (see BTN_STYLE).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { Artifact } from "../types";
import {
  addPin,
  createSurfacePin,
  pinsForDoc,
  removePin,
  surfacePinAnchor,
  surfacePinLabel,
  surfacePinOrigin,
  splitPinRefs,
  surfacePinTargetFor,
  updatePinNote,
} from "../lib/pins";
import type { Pin } from "../lib/pins";
import { mutatePins as mutateSharedPins, refreshPins, usePinsFile } from "../lib/pinsStore";
import { artifactIdentity, sendToThread, useSendToThreadAvailable } from "../lib/panelStore";
import { buildSendReference, refOptions } from "../lib/agentContext";
import { PinsRail } from "../components/kb/PinsRail";
import { anchorSelector, isAnchorKey } from "./anchors";
import type { SurfaceAnchorProvider } from "./anchors";
import type { SurfaceArtifact } from "./registry";

/** How often an open rail re-reads its pins file from disk (Inc 3d): the
 *  agent adds a pin by WRITING the file, and this is what makes it appear.
 *  Cheap — a few hundred bytes — and skipped while a local write is owed. */
export const PINS_REFRESH_MS = 2500;

/** Mark geometry: a 16px numbered disc, its top-right corner tucked into the
 *  anchor's top-right corner. */
const MARK = 16;

const MARK_STYLE: CSSProperties = {
  position: "absolute",
  width: MARK,
  height: MARK,
  borderRadius: MARK / 2,
  background: "var(--text-primary)",
  color: "var(--bg-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 600,
  lineHeight: `${MARK}px`,
  textAlign: "center",
  boxShadow: "0 0 0 1.5px var(--bg-panel)",
  pointerEvents: "auto",
  cursor: "default",
  userSelect: "none",
};

// Mirrors LocalhostView's rail row chrome (same tokens, same sizes) — kept
// local rather than exported from there so a live-preview tweak does not
// silently restyle a surface's rail, and vice versa.
const BTN_STYLE: CSSProperties = {
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 3,
  color: "var(--text-dim)",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  lineHeight: "16px",
  padding: "0 5px",
  cursor: "pointer",
};

const NOTE_CARD_STYLE: CSSProperties = {
  border: "1px solid var(--border-subtle)",
  borderRadius: 4,
  background: "var(--bg-elevated)",
  padding: "6px 8px",
  marginBottom: 6,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-secondary)",
};

const NOTE_INPUT_STYLE: CSSProperties = {
  width: "100%",
  minHeight: 44,
  resize: "vertical",
  background: "var(--bg-primary)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 3,
  color: "var(--text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  lineHeight: 1.5,
  padding: "4px 6px",
  outline: "none",
};

/** WHERE anchored pins live and how the rail names them. A surface and a
 *  markdown document (3c) differ only here — the marks, the rail rows and
 *  the placement rule are one implementation. */
export type AnchoredPinTarget = {
  /** The artifact the pins belong to — what `→ thread` names (3d). */
  artifact: Artifact;
  sidecarPath: string;
  docKey: string;
  /** Artifact identity — the rail's collapse preference is per document. */
  identity: string;
  /** The rail's second header line. */
  scopeNote: string;
  /** What the rail says when there are no pins yet. */
  emptyHint: string;
};

export type AnchoredPins = {
  marks: ReactNode;
  rail: ReactNode;
  count: number;
  onCapture: (e: ReactMouseEvent) => void;
};

/** The surface flavour: target derived from the artifact. */
export function useSurfacePins(
  artifact: SurfaceArtifact,
  provider: SurfaceAnchorProvider,
  wrapperEl: HTMLDivElement | null,
  pinMode: boolean,
  onPlaced: (outcome: "pinned" | "nothing-here") => void,
  active = true
): AnchoredPins {
  const target = useMemo<AnchoredPinTarget>(() => {
    const { sidecarPath, docKey } = surfacePinTargetFor(artifact);
    return {
      artifact,
      sidecarPath,
      docKey,
      identity: artifactIdentity(artifact),
      scopeNote: `page ${artifact.project} / ${docKey}`,
      emptyHint:
        "no pins yet — toggle \u{1F4CC} pin, then click a row, tile or bar. A surface pin follows the THING, not the spot: it moves with the page and hides when the page can't show it.",
    };
  }, [artifact]);
  return useAnchoredPins(target, provider, wrapperEl, pinMode, onPlaced, active);
}

/** What a host needs from this layer: the placement handler (bound to the
 *  content wrapper's capture phase while armed), the marks (rendered inside
 *  the wrapper's overlay) and the rail. Split so the host owns layout — the
 *  wrapper, the toolbar, the row — and this module owns pins. */
export function useAnchoredPins(
  target: AnchoredPinTarget,
  provider: SurfaceAnchorProvider,
  /** The content wrapper ELEMENT (state from a callback ref, not an object
   *  ref): a remount hands this layer a new element and the observers below
   *  re-attach to it. */
  wrapperEl: HTMLDivElement | null,
  pinMode: boolean,
  onPlaced: (outcome: "pinned" | "nothing-here") => void,
  /** The host is on screen. Gates the disk re-read exactly as DocView's poll
   *  and SurfaceHost's probe are gated: a hidden tab re-reads nothing. */
  active = true
): AnchoredPins {
  const { sidecarPath, docKey, identity } = target;
  const pinsFile = usePinsFile(sidecarPath);
  // Re-read from disk while ON SCREEN so a pin the AGENT wrote shows up (3d).
  // Two mounts of one sidecar tick twice, and the store's `refreshing` flag
  // collapses them to one read in flight.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => refreshPins(sidecarPath), PINS_REFRESH_MS);
    return () => clearInterval(t);
  }, [sidecarPath, active]);
  // The pin a jump (`#n`, or the rail's number) just pointed at — a short
  // highlight on its row and mark, so "activate" means something visible.
  const [litId, setLitId] = useState<string | null>(null);
  useEffect(() => {
    if (litId === null) return;
    const t = setTimeout(() => setLitId(null), 1600);
    return () => clearTimeout(t);
  }, [litId]);
  const canSend = useSendToThreadAvailable();
  const sendPin = useCallback(
    (number: number, pin: Pin) => {
      sendToThread(
        buildSendReference(
          target.artifact,
          { number, note: pin.note, anchor: surfacePinAnchor(pin) ?? undefined, label: surfacePinLabel(pin) },
          refOptions()
        )
      );
    },
    [target.artifact]
  );
  const mutatePins = useCallback(
    (fn: (f: Parameters<typeof addPin>[0]) => Parameters<typeof addPin>[0]) => mutateSharedPins(sidecarPath, fn),
    [sidecarPath]
  );
  const pins = useMemo(() => (pinsFile ? pinsForDoc(pinsFile, docKey) : []), [pinsFile, docKey]);

  // ── Placement ──────────────────────────────────────────────────────────────
  const onCapture = useCallback(
    (e: ReactMouseEvent) => {
      if (!pinMode) return;
      // Armed: this click is OURS whatever it landed on — the page must not
      // also act on it (open a drill-in, change a tab).
      e.preventDefault();
      e.stopPropagation();
      const anchor = provider.getAnchor(e.target);
      const wrapper = wrapperEl;
      if (!anchor || !wrapper) {
        onPlaced("nothing-here");
        return;
      }
      const rect = provider.locateAnchor(anchor.key);
      const box = wrapper.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : e.clientX;
      const cy = rect ? rect.top + rect.height / 2 : e.clientY;
      const pin = createSurfacePin({
        page: docKey,
        anchor: anchor.key,
        anchorLabel: anchor.label,
        xPct: box.width > 0 ? Math.round(((cx - box.left) / box.width) * 1000) / 10 : 0,
        yPct: box.height > 0 ? Math.round(((cy - box.top) / box.height) * 1000) / 10 : 0,
      });
      mutatePins((f) => addPin(f, pin));
      onPlaced("pinned");
    },
    [pinMode, provider, wrapperEl, docKey, mutatePins, onPlaced]
  );

  // ── Mark positions: re-asked on any signal the page might have moved ───────
  const positions = useAnchorPositions(pins, provider, wrapperEl);

  const [editingId, setEditingId] = useState<string | null>(null);

  const reveal = useCallback(
    (pin: Pin) => {
      setLitId(pin.id);
      const key = surfacePinAnchor(pin);
      const wrapper = wrapperEl;
      // Guarded like locateAnchor: a hand-edited or agent-written key with a
      // newline would otherwise reach querySelector unescaped and throw.
      if (!key || !wrapper || !isAnchorKey(key)) return;
      // DOM anchors can be scrolled to; a programmatic provider's anchor has
      // no element, and the rail row's "not on screen" already says so.
      wrapper.querySelector(anchorSelector(key))?.scrollIntoView({ block: "center", inline: "nearest" });
    },
    [wrapperEl]
  );

  const marks = (
    <>
      {pins.map((pin, i) => {
        const pos = positions.get(pin.id);
        if (!pos) return null;
        return (
          <div
            key={pin.id}
            style={{
              ...MARK_STYLE,
              left: pos.x,
              top: pos.y,
              ...(litId === pin.id ? { boxShadow: "0 0 0 3px var(--text-secondary)" } : {}),
            }}
            title={`${i + 1} · ${surfacePinLabel(pin)}${pin.note ? ` — ${pin.note}` : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setEditingId(pin.id);
            }}
          >
            {i + 1}
          </div>
        );
      })}
    </>
  );

  const rail = (
    <PinsRail identity={identity} count={pins.length} scopeNote={target.scopeNote}>
      {pins.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
          {pinsFile === null ? "loading pins…" : target.emptyHint}
        </div>
      ) : (
        pins.map((pin, i) => {
          const onScreen = positions.has(pin.id);
          return (
            <div
              key={pin.id}
              style={{
                ...NOTE_CARD_STYLE,
                ...(litId === pin.id ? { borderColor: "var(--text-secondary)" } : {}),
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span
                  role="button"
                  title={onScreen ? "Scroll to this pin" : "Not on screen right now"}
                  onClick={() => reveal(pin)}
                  style={{
                    minWidth: 16,
                    height: 16,
                    lineHeight: "16px",
                    textAlign: "center",
                    borderRadius: 8,
                    background: onScreen ? "var(--text-primary)" : "transparent",
                    border: onScreen ? "none" : "1px solid var(--text-dim)",
                    color: onScreen ? "var(--bg-primary)" : "var(--text-dim)",
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "0 3px",
                    cursor: onScreen ? "pointer" : "default",
                  }}
                >
                  {i + 1}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--text-muted)",
                    fontSize: 10.5,
                  }}
                  title={surfacePinAnchor(pin) ?? undefined}
                >
                  {surfacePinLabel(pin)}
                </span>
                <button
                  type="button"
                  style={{ ...BTN_STYLE, opacity: canSend ? 1 : 0.35, cursor: canSend ? "pointer" : "default" }}
                  disabled={!canSend}
                  title={
                    canSend
                      ? "Type this pin's reference into the terminal — you press Enter"
                      : "No terminal session to type into"
                  }
                  onClick={() => sendPin(i + 1, pin)}
                >
                  → thread
                </button>
                <button
                  type="button"
                  style={{ ...BTN_STYLE, padding: "0 5px" }}
                  title="Delete pin"
                  onClick={() => {
                    if (editingId === pin.id) setEditingId(null);
                    mutatePins((f) => removePin(f, pin.id));
                  }}
                >
                  ×
                </button>
              </div>
              {editingId === pin.id ? (
                <textarea
                  style={NOTE_INPUT_STYLE}
                  autoFocus
                  value={pin.note}
                  placeholder="note…"
                  onChange={(e) => mutatePins((f) => updatePinNote(f, pin.id, e.target.value))}
                  onBlur={() => setEditingId(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) {
                      e.preventDefault();
                      setEditingId(null);
                    }
                  }}
                />
              ) : (
                <div
                  style={{ cursor: "text", whiteSpace: "pre-wrap", lineHeight: 1.5 }}
                  onClick={() => setEditingId(pin.id)}
                >
                  {pin.note !== "" ? (
                    renderNote(pin.note, (n) => {
                      const other = pins[n - 1];
                      if (other) reveal(other);
                    })
                  ) : (
                    <span style={{ color: "var(--text-dim)" }}>click to add note</span>
                  )}
                </div>
              )}
              <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-dim)" }}>
                {surfacePinOrigin(pin) === "thread" ? "from thread · " : ""}
                {onScreen ? "" : "not on screen · "}
                {pin.createdAt ? pin.createdAt.slice(0, 16).replace("T", " ") : ""}
              </div>
            </div>
          );
        })
      )}
    </PinsRail>
  );

  return { marks, rail, count: pins.length, onCapture };
}

/** Where each pin's mark goes, in the content wrapper's coordinate space —
 *  or absent when the page cannot locate the anchor right now. Recomputed on
 *  one animation frame after any of: the pin list changing, the wrapper
 *  resizing, ANY mutation inside it, or a nested scroll. Coalesced by rAF so
 *  a burst of mutations (a table re-rendering) costs one measurement pass. */
function useAnchorPositions(
  pins: readonly Pin[],
  provider: SurfaceAnchorProvider,
  wrapperEl: HTMLDivElement | null
): Map<string, { x: number; y: number }> {
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const frame = useRef<number | null>(null);

  const measure = useCallback(() => {
    frame.current = null;
    const wrapper = wrapperEl;
    if (!wrapper) {
      // No element (unmounted view, backend card): no mark may be drawn at
      // the previous element's coordinates when one comes back.
      setPositions((prev) => (prev.size > 0 ? new Map() : prev));
      return;
    }
    const box = wrapper.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number }>();
    for (const pin of pins) {
      const key = surfacePinAnchor(pin);
      if (!key) continue;
      const rect = provider.locateAnchor(key);
      if (!rect) continue;
      next.set(pin.id, {
        x: Math.round(rect.right - box.left - MARK + 4),
        y: Math.round(rect.top - box.top - 4),
      });
    }
    setPositions((prev) => (samePositions(prev, next) ? prev : next));
  }, [pins, provider, wrapperEl]);

  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(measure);
  }, [measure]);

  useEffect(() => {
    schedule();
    const wrapper = wrapperEl;
    if (!wrapper) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(wrapper);
    const mo = new MutationObserver(schedule);
    mo.observe(wrapper, { subtree: true, childList: true, attributes: true, characterData: true });
    wrapper.addEventListener("scroll", schedule, true);
    return () => {
      ro.disconnect();
      mo.disconnect();
      wrapper.removeEventListener("scroll", schedule, true);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [schedule, wrapperEl]);

  return positions;
}

/** A note with its `#n` cross-references (pins.splitPinRefs) rendered as
 *  jumps to the referenced pin in this rail. */
function renderNote(note: string, onJump: (n: number) => void): ReactNode {
  return splitPinRefs(note).map((seg, i) =>
    "ref" in seg ? (
      <span
        key={i}
        role="button"
        title={`Go to pin ${seg.ref}`}
        onClick={(e) => {
          e.stopPropagation();
          onJump(seg.ref);
        }}
        style={{ color: "var(--text-primary)", textDecoration: "underline dotted", cursor: "pointer" }}
      >
        #{seg.ref}
      </span>
    ) : (
      <span key={i}>{seg.text}</span>
    )
  );
}

function samePositions(
  a: Map<string, { x: number; y: number }>,
  b: Map<string, { x: number; y: number }>
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, p] of b) {
    const q = a.get(id);
    if (!q || q.x !== p.x || q.y !== p.y) return false;
  }
  return true;
}
