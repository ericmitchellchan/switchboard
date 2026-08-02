// Live HTML wireframe rendering + pin/note markup (T7).
//
// SURFACE-AGNOSTIC (increment C): this view knows nothing about the KB. It
// takes the CONTENT to render and the ARTIFACT that names it; the loading
// strategy is the HOST's business — DocView feeds it useKbDoc's 2500ms
// active-gated poll for KB docs, the Explorer screen and the artifact panel
// feed it a one-shot `explorerRead` for repo files (same cadence as every
// other repo-file read; explorer reads have never polled). Everything the
// view derives per document — display name, zoom key, pins sidecar, the
// `→ thread` reference — comes from the artifact, so a repo wireframe is not
// a special case anywhere below. Repo pins are MIRRORED into the KB
// (pins.pinTargetFor); the shared pinsStore is still the only writer.
//
// SANDBOX POSTURE — the three load-bearing lines (do not weaken any):
//   1. <iframe sandbox="allow-scripts"> — allow-scripts WITHOUT
//      allow-same-origin. The mockup runs as an opaque origin: it cannot
//      touch app storage/cookies or reach into the parent DOM. Never add
//      more sandbox tokens. NOTE what this does NOT do: an opaque origin is
//      still fully NETWORKED. That is what line 2 is for.
//   2. injectCsp (lib/sandbox.ts) plants a Content-Security-Policy into the
//      document: `connect-src 'none'` kills fetch/XHR/WebSocket/sendBeacon,
//      `script-src 'unsafe-inline'` stops remote code loading, and remote
//      fonts/styles/images stay allowed because Eric's real mockups use them.
//      Read that module for the honest limits — this reduces the surface, it
//      does not eliminate it.
//   3. Inbound messages pass `e.source === iframeRef.current?.contentWindow`
//      before anything else. The `source: "sb-wireframe"` payload tag is
//      forgeable and the workstation keeps multiple KB tabs MOUNTED
//      (keep-alive) — without the contentWindow identity check one mockup's
//      messages fan out to every mounted instance (the recorded multi-tab
//      cross-talk bug).
//
// srcDoc is memoized on the CONTENT string alone — pin/zoom/mode state never
// reloads the iframe. Live reload comes free: useKbDoc's poll hands DocView
// new content, the memo swaps srcDoc cleanly, and the instrument re-runs. On
// that reload the parent re-pushes pin-mode + badges when the instrument's
// "ready" message arrives, so pin-mode SURVIVES a live reload (an in-progress
// "click to place" stays armed — the mode lives in parent state).
//
// The toolbar's ⟳ is that same path, on demand: it calls the HOST's `onReload`
// (never a read of its own — the loading policy stays where it lives), the
// host's next read arrives as new `content`, and the memo does the rest. Shown
// for repo files AND KB docs — a repo read is one-shot and a KB poll pauses
// while its host is hidden, so both genuinely need it.
//
// What survives a reload, precisely — the first pass overstated this and the
// repo path did not hold:
//   · zoom is COMPONENT STATE, so it survives because the reload does not
//     REMOUNT this component. That is a property of the host's fold (kb's
//     mergeDocRead / explorer's mergeFileRead keep the previous content on
//     screen instead of blanking to null), not of this file. Across a genuine
//     remount or a doc switch it is the sessionStorage write-through that
//     carries zoom, which is a different mechanism with a different lifetime.
//   · pins survive because they live in the shared pinsStore, keyed by sidecar
//     path — that one IS by construction.
//   · pin-mode and the open note editor are component state like zoom: same
//     rule, same dependency on not being unmounted.
//
// Zoom: transform:scale(z) + width/height 100/z% virtual viewport — the box
// stays container-sized, scrolling stays inside the iframe, content reflows
// like browser zoom. Persisted per doc-path in sessionStorage WRITE-THROUGH
// at the moment of change — deliberately not an effect keyed on [path, zoom],
// which would clobber the stored zoom on doc switch (the recorded bug). This
// component is mounted with key={path}, so state initializers re-run per doc.
//
// Instrument protocol (plain-JS <script> appended to the doc):
//   out (iframe→parent), tagged {source:"sb-wireframe"}:
//     ready | pin-place{xPct,yPct,anchor?} | pin-click{id} | wheel-zoom{deltaY}
//   in (parent→iframe), tagged {target:"sb-wireframe"}:
//     set-pins{pins:[{id,xPct,yPct}]} | set-mode{pinMode}
//   Ctrl/Cmd+wheel is RELAYED out because wheel events do not cross the
//   iframe boundary (the recorded bug); the same gesture outside the iframe
//   is caught by a native non-passive listener on the container.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  addPin,
  clampZoom,
  createPin,
  docFileName,
  parseWireframeMessage,
  pinsForDoc,
  pinTargetFor,
  removePin,
  updatePinNote,
  zoomAfterWheel,
  zoomStorageKey,
  WIREFRAME_MSG_SOURCE,
} from "../../lib/pins";
import type { PinsFile } from "../../lib/pins";
import { injectCsp } from "../../lib/sandbox";
import type { FileArtifact } from "../../types";
import { mutatePins as mutateSharedPins, usePinsFile } from "../../lib/pinsStore";
import { artifactIdentity, sendToThread, useSendToThreadAvailable } from "../../lib/panelStore";
import { buildSendReference, refOptions } from "../../lib/agentContext";
import { PinsRail } from "./PinsRail";

// ── Instrument script (plain JS, appended to the mockup document) ────────────
// Badge positions are computed in PAGE px from percent-of-scroll-size, then
// corrected by the layer's own page offset (body margin etc). The pin-mode
// click capture ignores clicks on badges so a badge click always focuses its
// note instead of dropping a new pin.

const INSTRUMENT = `
<script>
(function () {
  var TAG = ${JSON.stringify(WIREFRAME_MSG_SOURCE)};
  var pins = [];
  var pinMode = false;
  var layer = null;

  function post(msg) { msg.source = TAG; parent.postMessage(msg, "*"); }

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement("div");
    layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;";
    document.body.appendChild(layer);
    return layer;
  }

  function renderPins() {
    var l = ensureLayer();
    l.textContent = "";
    var de = document.documentElement;
    var w = de.scrollWidth || 1, h = de.scrollHeight || 1;
    var r = l.getBoundingClientRect();
    var offX = r.left + window.scrollX, offY = r.top + window.scrollY;
    for (var i = 0; i < pins.length; i++) {
      (function (p, n) {
        var b = document.createElement("div");
        b.textContent = String(n);
        b.style.cssText = "position:absolute;transform:translate(-50%,-50%);min-width:18px;height:18px;line-height:18px;text-align:center;border-radius:9px;padding:0 4px;background:#E4E4E7;color:#0C0C0E;font:600 11px monospace;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.45);user-select:none;";
        b.style.left = (w * p.xPct / 100 - offX) + "px";
        b.style.top = (h * p.yPct / 100 - offY) + "px";
        b.addEventListener("click", function (e) {
          e.preventDefault(); e.stopPropagation();
          post({ type: "pin-click", id: p.id });
        });
        l.appendChild(b);
      })(pins[i], i + 1);
    }
  }

  document.addEventListener("click", function (e) {
    if (!pinMode) return;
    if (layer && layer.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    var de = document.documentElement;
    var w = de.scrollWidth || 1, h = de.scrollHeight || 1;
    var el = e.target, parts = [];
    while (el && el.nodeType === 1 && parts.length < 4) {
      if (el.id) { parts.unshift("#" + el.id); break; }
      var cls = (typeof el.className === "string" ? el.className : "").trim().split(/\\s+/).filter(Boolean).slice(0, 2).join(".");
      parts.unshift(cls ? el.tagName.toLowerCase() + "." + cls : el.tagName.toLowerCase());
      el = el.parentElement;
    }
    post({
      type: "pin-place",
      xPct: (e.pageX / w) * 100,
      yPct: (e.pageY / h) * 100,
      anchor: parts.join(" > ")
    });
  }, true);

  window.addEventListener("wheel", function (e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      post({ type: "wheel-zoom", deltaY: e.deltaY });
    }
  }, { passive: false });

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.target !== TAG) return;
    if (d.type === "set-pins" && Array.isArray(d.pins)) { pins = d.pins; renderPins(); }
    else if (d.type === "set-mode") {
      pinMode = !!d.pinMode;
      document.documentElement.style.cursor = pinMode ? "crosshair" : "";
    }
  });

  window.addEventListener("resize", renderPins);
  post({ type: "ready" });
})();
<\/script>
`;

// ── Styles (kit tokens, mono, 11px scale) ────────────────────────────────────

const ROOT_STYLE: CSSProperties = {
  display: "flex",
  height: "100%",
  minHeight: 0,
  fontFamily: "var(--font-mono)",
};

const MAIN_COL_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
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

const FRAME_BOX_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
  position: "relative",
  // Letterbox around the sandboxed iframe — transparent so it takes the
  // HOST's surface (KB screen #0C0C0E, artifact panel #0F0F11). The wireframe
  // itself paints its own background inside the frame, so this only affects
  // the margin around it.
  background: "transparent",
};

// The approved wireframe's note card (workstation-shell.html row 2):
// bg-elevated chip, border-subtle, 2px text-secondary left edge, dim meta.
const NOTE_CARD_STYLE: CSSProperties = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-subtle)",
  borderLeft: "2px solid var(--text-secondary)",
  borderRadius: 3,
  padding: "8px 10px",
  fontSize: 11,
  color: "var(--text-secondary)",
};

const NOTE_INPUT_STYLE: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--bg-active)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 3,
  color: "var(--text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  lineHeight: 1.5,
  padding: "4px 6px",
  resize: "vertical",
  minHeight: 40,
};

function loadStoredZoom(identity: string): number {
  try {
    const raw = sessionStorage.getItem(zoomStorageKey(identity));
    return raw === null ? 1 : clampZoom(parseFloat(raw));
  } catch {
    return 1;
  }
}

function noteMeta(createdAt: string): string {
  const d = new Date(createdAt);
  const when = Number.isNaN(d.getTime()) ? "" : `, ${d.getMonth() + 1}/${d.getDate()}`;
  return `— eric${when}`;
}

/** Mounted by ArtifactBody with key={artifactIdentity} — all state is per-doc
 *  by construction. `content` is the HOST's (KB poll / explorer read). */
export function WireframeView({
  artifact,
  content,
  onReload,
}: {
  artifact: FileArtifact;
  content: string;
  /** Re-read this artifact from disk, supplied by the HOST (DocView's
   *  useKbDoc.reload for KB docs, the explorerRead effect's for repo files).
   *  The view does not load anything itself — it asks, new `content` arrives
   *  as a prop, and the srcDoc memo swaps exactly as it does for a poll tick,
   *  so zoom, pins and pin-mode all survive untouched. */
  onReload?: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const frameBoxRef = useRef<HTMLDivElement>(null);

  // srcDoc depends on CONTENT ONLY — pin/zoom/mode churn never reloads the
  // iframe (the srcDoc-memoization rule in the module header).
  //
  // injectCsp plants the frame policy as early in the document as a policy can
  // legally take effect (lib/sandbox.ts owns the policy and the placement).
  // `allow-scripts` alone gives an opaque origin, NOT a network block — a
  // mockup could otherwise `fetch` anywhere, which matters now that repo HTML
  // executes instead of rendering as source.
  const srcDoc = useMemo(() => injectCsp(content) + INSTRUMENT, [content]);

  const path = artifact.path;
  const identity = artifactIdentity(artifact);

  // ── Zoom (write-through persistence, no [identity, zoom] effect) ──
  const [zoom, setZoomState] = useState<number>(() => loadStoredZoom(identity));
  const zoomRef = useRef(zoom);
  const applyZoom = useCallback(
    (fn: (z: number) => number) => {
      const next = clampZoom(fn(zoomRef.current));
      zoomRef.current = next;
      try {
        sessionStorage.setItem(zoomStorageKey(identity), String(next));
      } catch {
        // storage unavailable — zoom still works for the session in memory
      }
      setZoomState(next);
    },
    [identity]
  );

  // ── Pins ──
  // KB docs file pins in the sidecar NEXT TO the doc; repo files mirror into
  // the hidden `_repo-pins/` KB tree (pins.ts documents the scheme). Either
  // way it is one `.pins.json` path handed to the ONE shared store.
  const displayName = docFileName(path);
  const { sidecarPath, docKey: docName } = useMemo(() => pinTargetFor(artifact), [artifact]);
  // The sidecar lives in a SHARED store keyed by its path, not in component
  // state: this same wireframe can be mounted twice at once (artifact panel on
  // the terminal screen + the keep-alive KB screen), and two private copies
  // meant the later writer silently clobbered the other's pins. See
  // pinsStore.ts — it owns loading, sharing and the ONE debounced write per
  // sidecar; pins.ts still owns every rule about the file's contents.
  const pinsFile = usePinsFile(sidecarPath);
  const [pinMode, setPinMode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const mutatePins = useCallback(
    (fn: (file: PinsFile) => PinsFile) => mutateSharedPins(sidecarPath, fn),
    [sidecarPath]
  );

  const docPins = useMemo(
    () => (pinsFile ? pinsForDoc(pinsFile, docName) : []),
    [pinsFile, docName]
  );

  // T8 seam 2 (A4): per-pin `→ thread` TYPES `Look at "kb <doc>", pin N: "<note>"`
  // (or `"repo <project>/<path>"`) into the terminal — no Enter, ever.
  // Disabled (not silently inert) when there is no session to type into.
  // Works from the panel AND from the full-width KB/Explorer screens; App
  // reveals the terminal before writing. artifactRef already speaks both
  // kinds, so the repo case needed nothing new here.
  const canSend = useSendToThreadAvailable();
  const sendPin = useCallback(
    (number: number, note: string) => {
      sendToThread(buildSendReference(artifact, { number, note }, refOptions()));
    },
    [artifact]
  );

  // ── Iframe messaging ──
  const postToFrame = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ target: WIREFRAME_MSG_SOURCE, ...msg }, "*");
  }, []);

  // Push current badge set + mode into the instrument. Runs on every change
  // AND on instrument "ready" (fresh srcDoc after a live reload) — badges and
  // pin-mode re-render from parent state across reloads.
  const pushFrameState = useCallback(() => {
    postToFrame({
      type: "set-pins",
      pins: docPins.map((p) => ({ id: p.id, xPct: p.xPct, yPct: p.yPct })),
    });
    postToFrame({ type: "set-mode", pinMode });
  }, [postToFrame, docPins, pinMode]);

  useEffect(() => {
    pushFrameState();
  }, [pushFrameState]);

  const pushRef = useRef(pushFrameState);
  pushRef.current = pushFrameState;
  const pinModeRef = useRef(pinMode);
  pinModeRef.current = pinMode;
  const docNameRef = useRef(docName);
  docNameRef.current = docName;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // ORIGIN GUARD (sandbox contract, module header): identity check against
      // THIS instance's contentWindow — the payload tag alone is forgeable and
      // other mounted WireframeViews receive the same window message events.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const msg = parseWireframeMessage(e.data);
      if (!msg) return;
      switch (msg.type) {
        case "ready":
          pushRef.current();
          break;
        case "pin-place": {
          if (!pinModeRef.current) break;
          const pin = createPin({
            doc: docNameRef.current,
            xPct: msg.xPct,
            yPct: msg.yPct,
            anchor: msg.anchor,
          });
          mutatePins((f) => addPin(f, pin));
          setPinMode(false); // single-shot placement
          setEditingId(pin.id);
          break;
        }
        case "pin-click":
          setEditingId(msg.id);
          break;
        case "wheel-zoom":
          applyZoom((z) => zoomAfterWheel(z, msg.deltaY));
          break;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [mutatePins, applyZoom]);

  // Ctrl/Cmd+wheel OUTSIDE the iframe (toolbar, box padding). Native
  // non-passive listener — React's synthetic wheel can't preventDefault.
  useEffect(() => {
    const box = frameBoxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      applyZoom((z) => zoomAfterWheel(z, e.deltaY));
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

  // ── Render ──
  const iframeStyle: CSSProperties = {
    border: "none",
    display: "block",
    background: "#FFFFFF",
    // Virtual viewport: the iframe lays out at 1/z size and scales up to fill
    // the container exactly — scrollbars stay inside, content reflows.
    width: `${100 / zoom}%`,
    height: `${100 / zoom}%`,
    transform: `scale(${zoom})`,
    transformOrigin: "0 0",
  };

  return (
    <div style={ROOT_STYLE}>
      <div style={MAIN_COL_STYLE}>
        <div style={TOOLBAR_STYLE}>
          <span style={{ color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {displayName}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            style={{
              ...BTN_STYLE,
              ...(pinMode
                ? { color: "var(--text-primary)", borderColor: "var(--text-secondary)" }
                : {}),
            }}
            disabled={pinsFile === null}
            onClick={() => setPinMode((m) => !m)}
            // Where a repo file's notes LAND is worth saying once, quietly:
            // they are mirrored into the KB, never written into the repo.
            title={
              artifact.kind === "repo-file"
                ? `Pin mode: click in the mockup to drop a numbered pin — notes are stored in the KB (${sidecarPath}), never in the repo`
                : "Pin mode: click in the mockup to drop a numbered pin"
            }
          >
            {"\u{1F4CC}"} pin
          </button>
          <button type="button" style={BTN_STYLE} onClick={() => applyZoom((z) => z / 1.2)} title="Zoom out">
            −
          </button>
          <span style={{ minWidth: 38, textAlign: "center", color: "var(--text-secondary)" }}>
            {Math.round(zoom * 100)}%
          </span>
          <button type="button" style={BTN_STYLE} onClick={() => applyZoom((z) => z * 1.2)} title="Zoom in">
            +
          </button>
          <button type="button" style={BTN_STYLE} onClick={() => applyZoom(() => 1)} title="Reset zoom">
            100%
          </button>
          {/* RELOAD — for BOTH artifact kinds, deliberately. A repo file has
              no other refresh path at all (its read is one-shot), and a KB doc
              polls only while its host is VISIBLE; an affordance that appeared
              or behaved differently depending on which tree a file happens to
              live in would be its own confusion. It costs no vertical space:
              the toolbar is already here. */}
          {onReload && (
            <button
              type="button"
              style={BTN_STYLE}
              onClick={onReload}
              title="Re-read this file from disk"
              aria-label="Reload"
            >
              ⟳
            </button>
          )}
        </div>
        <div ref={frameBoxRef} style={FRAME_BOX_STYLE}>
          {/* SANDBOX: allow-scripts ONLY — never add allow-same-origin (module header). */}
          <iframe
            ref={iframeRef}
            title={displayName}
            sandbox="allow-scripts"
            srcDoc={srcDoc}
            style={iframeStyle}
            onLoad={() => pushRef.current()}
          />
        </div>
      </div>
      {/* Increment F, Decision 4: the rail COLLAPSES, and starts collapsed on
          a doc with no pins — its worst case was being permanently 260px wide
          with nothing in it. The chrome + the preference live in PinsRail (one
          rail, shared with the live-preview surface); only the cards are ours. */}
      <PinsRail identity={identity} count={docPins.length}>
        {docPins.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
            {pinsFile === null
              ? "loading pins…"
              : "no pins yet — toggle \u{1F4CC} pin, then click in the mockup to drop a numbered pin with a note."}
          </div>
        ) : (
          docPins.map((pin, i) => (
            <div key={pin.id} style={NOTE_CARD_STYLE}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span
                  style={{
                    minWidth: 16,
                    height: 16,
                    lineHeight: "16px",
                    textAlign: "center",
                    borderRadius: 8,
                    background: "var(--text-primary)",
                    color: "var(--bg-primary)",
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "0 3px",
                  }}
                >
                  {i + 1}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  style={{
                    ...BTN_STYLE,
                    padding: "0 5px",
                    color: "var(--text-dim)",
                    opacity: canSend ? 1 : 0.35,
                    cursor: canSend ? "pointer" : "default",
                  }}
                  disabled={!canSend}
                  title={
                    canSend
                      ? "Type this pin's reference into the terminal — you press Enter"
                      : "No terminal session to type into"
                  }
                  onClick={() => sendPin(i + 1, pin.note)}
                >
                  → thread
                </button>
                <button
                  type="button"
                  style={{ ...BTN_STYLE, padding: "0 5px", color: "var(--text-dim)" }}
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
                    pin.note
                  ) : (
                    <span style={{ color: "var(--text-dim)" }}>click to add note</span>
                  )}
                </div>
              )}
              <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-dim)" }}>
                {noteMeta(pin.createdAt)}
              </div>
            </div>
          ))
        )}
      </PinsRail>
    </div>
  );
}
