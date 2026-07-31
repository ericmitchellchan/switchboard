// Mermaid diagram surface (T9) — renders `.mmd` KB docs with hand-rolled
// pan/zoom and the verified/unverified status strip. Pattern proven in the
// sibling ky-desktop app, reimplemented here against DocView's kind switch.
//
// mermaid is a ~2MB dependency: it is loaded LAZILY exactly once via a
// module-level dynamic import promise, so it lands in its own build chunk and
// never touches the main bundle. First DiagramView mount pays the load; every
// later render reuses the initialized instance.
//
// TRUST ASSUMPTION (securityLevel "loose", matching the sibling app): our
// `.mmd` files are SELF-AUTHORED KB content in the personal-kb checkout —
// the same trust class as the wireframes T7 renders with scripts enabled.
// "loose" keeps classDef styling and click/href definitions working;
// `theme: "base"` lets a diagram's own classDef token block survive instead
// of being overridden by a built-in theme. Revisit both if the KB ever holds
// third-party diagrams.
//
// Render lifecycle: mermaid.render is async and content swaps arrive on the
// KB poll, so every render call takes a monotonic `renderSeq` ticket (also
// used for the unique element id mermaid.render requires) and an `alive`
// flag — a stale completion can never stomp a newer SVG or write into an
// unmounted host. On a syntax error the LAST GOOD SVG stays up with the error
// message shown dimly alongside (live-editing a diagram must not blank it).
//
// The Transform survives content swaps by construction — it is component
// state keyed off nothing; DocView mounts this component with key={path}, so
// pan/zoom resets on doc SWITCH but never on a live reload of the same doc.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  IDENTITY,
  panBy,
  transformToCss,
  wheelZoomFactor,
  zoomToPoint,
} from "../../lib/diagramZoom";
import type { Transform } from "../../lib/diagramZoom";
import { parseDiagramMeta } from "../../lib/diagramMeta";
import { log } from "../../lib/logger";

type MermaidApi = typeof import("mermaid").default;

// Module-level: ONE dynamic import + ONE initialize for the app's lifetime.
let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      // securityLevel/theme rationale: TRUST ASSUMPTION block in the header.
      mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: "base" });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/** Toolbar/button zoom step (matches WireframeView's 1.2 step feel). */
const BUTTON_ZOOM_STEP = 1.2;

// ── Styles (kit tokens — same slim-toolbar shape as T7's WireframeView) ──────

const ROOT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-mono)",
};

const TOOLBAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 32,
  flexShrink: 0,
  padding: "0 10px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg-secondary)",
  fontSize: 11,
  color: "var(--text-muted)",
};

const BTN_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  lineHeight: "18px",
  padding: "0 8px",
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 4,
  cursor: "pointer",
};

const STRIP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexShrink: 0,
  padding: "4px 12px",
  borderBottom: "1px solid var(--border)",
  fontSize: 10.5,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const CANVAS_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
  position: "relative",
  background: "var(--bg-primary)",
  cursor: "grab",
  // Pointer-drag pans; without this, drags select SVG text instead.
  userSelect: "none",
  touchAction: "none",
};

/** Mounted by DocView with key={path} — all state is per-doc by construction.
 *  `content` comes from DocView's useKbDoc, so live edits re-render here. */
export function DiagramView({ path, content }: { path: string; content: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const [renderError, setRenderError] = useState<string | null>(null);
  const [hasSvg, setHasSvg] = useState(false);

  // ── Transform (pure math in diagramZoom.ts) ──
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  const meta = useMemo(() => parseDiagramMeta(content), [content]);
  const docName = path.split("/").pop() ?? path;

  // Apply the transform to the rendered SVG element. Runs on every transform
  // change AND right after a fresh SVG lands (the new element starts
  // untransformed — content swaps must PRESERVE the current pan/zoom).
  const applyTransform = useCallback((t: Transform) => {
    const svg = hostRef.current?.querySelector("svg");
    if (!svg) return;
    svg.style.transform = transformToCss(t);
    svg.style.transformOrigin = "0 0";
  }, []);

  useEffect(() => {
    applyTransform(transform);
  }, [transform, applyTransform]);

  // ── Async render with stale-drop ──
  const renderSeq = useRef(0);
  useEffect(() => {
    const seq = ++renderSeq.current;
    let alive = true;
    loadMermaid()
      .then((mermaid) =>
        // Unique element id per call — mermaid renders into a temp element
        // keyed by it; reuse across concurrent calls corrupts the output.
        mermaid.render(`sb-diagram-${seq}`, content)
      )
      .then(({ svg }) => {
        if (!alive || renderSeq.current !== seq || !hostRef.current) return;
        hostRef.current.innerHTML = svg;
        // mermaid sizes the SVG via max-width; pin it to its intrinsic size
        // so the transform is the ONLY scaling in play.
        const el = hostRef.current.querySelector("svg");
        if (el) {
          el.style.maxWidth = "none";
          el.style.display = "block";
        }
        setHasSvg(true);
        setRenderError(null);
        applyTransform(transformRef.current);
      })
      .catch((e) => {
        // mermaid.render can leave its temp error element (`d<id>`) in the
        // body on a parse failure — remove it regardless of staleness.
        document.getElementById(`dsb-diagram-${seq}`)?.remove();
        if (!alive || renderSeq.current !== seq) return;
        // Keep the last good SVG (if any) — only surface the message.
        setRenderError(String(e instanceof Error ? e.message : e));
        log.warn(`diagram render failed for ${path}: ${String(e)}`);
      });
    return () => {
      alive = false;
    };
  }, [content, path, applyTransform]);

  // ── Wheel: plain = pan both axes; Ctrl/Cmd (incl. pinch) = zoom-to-cursor.
  // Native NON-PASSIVE listener — React's synthetic wheel is passive-by-
  // default in the webview and preventDefault would be ignored (the T7 bug).
  useEffect(() => {
    const box = canvasRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = box.getBoundingClientRect();
        setTransform((t) =>
          zoomToPoint(
            t,
            e.clientX - rect.left,
            e.clientY - rect.top,
            wheelZoomFactor(e.deltaY)
          )
        );
      } else {
        setTransform((t) => panBy(t, -e.deltaX, -e.deltaY));
      }
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, []);

  // ── Pointer drag = pan (with pointer capture so the drag survives leaving
  // the canvas). Last position lives in a ref; no re-render per move beyond
  // the transform update itself.
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    setTransform((t) => panBy(t, dx, dy));
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  // Toolbar zoom buttons zoom about the canvas CENTER (no cursor to anchor).
  const zoomAtCenter = useCallback((factor: number) => {
    const box = canvasRef.current;
    const cx = box ? box.clientWidth / 2 : 0;
    const cy = box ? box.clientHeight / 2 : 0;
    setTransform((t) => zoomToPoint(t, cx, cy, factor));
  }, []);

  return (
    <div style={ROOT_STYLE}>
      <div style={TOOLBAR_STYLE}>
        <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {docName}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={BTN_STYLE} onClick={() => zoomAtCenter(1 / BUTTON_ZOOM_STEP)} title="Zoom out">
          −
        </button>
        <span style={{ minWidth: 38, textAlign: "center", color: "var(--text-secondary)" }}>
          {Math.round(transform.scale * 100)}%
        </span>
        <button type="button" style={BTN_STYLE} onClick={() => zoomAtCenter(BUTTON_ZOOM_STEP)} title="Zoom in">
          +
        </button>
        <button type="button" style={BTN_STYLE} onClick={() => setTransform(IDENTITY)} title="Reset pan/zoom">
          {"⟲"}
        </button>
      </div>

      {/* Verification status strip — dim mono line; --accent-yellow ONLY for
          a nonzero unverified count (functional status, the one permitted
          color on this surface). */}
      <div style={STRIP_STYLE}>
        {meta.verifiedAgainst !== null && (
          <span style={{ color: "var(--text-secondary)" }}>
            verified against {meta.verifiedAgainst}
          </span>
        )}
        {meta.unverifiedCount > 0 && (
          <span style={{ color: "var(--accent-yellow)" }}>
            {meta.unverifiedCount} unverified edge{meta.unverifiedCount === 1 ? "" : "s"}
          </span>
        )}
        {meta.verifiedAgainst === null && meta.unverifiedCount === 0 && (
          <span style={{ color: "var(--text-dim)" }}>no verification stamp</span>
        )}
        {renderError !== null && (
          <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis" }}>
            render error: {renderError}
          </span>
        )}
      </div>

      <div
        ref={canvasRef}
        style={CANVAS_STYLE}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setTransform(IDENTITY)}
      >
        {/* mermaid's SVG is injected imperatively (innerHTML) — React renders
            no children into this node, so the two never fight. */}
        <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
        {!hasSvg && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: "var(--text-dim)",
            }}
          >
            {renderError !== null ? "diagram failed to render" : "rendering diagram…"}
          </div>
        )}
      </div>
    </div>
  );
}
