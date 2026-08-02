// THE LIVE LOCALHOST PREVIEW (increment F / architecture phase B).
//
// `pnpm dev` runs in the tab on the left; the app it serves renders here, on
// the right, in a real iframe. Switchboard never STARTS a server (explicit
// non-goal) — it watches the PTY, offers, and frames what you started.
//
// ── SANDBOX POSTURE — MEASURED, not reasoned, and CORRECTED once. Read the ───
// ── whole sequence before touching the `sandbox` attribute: the reason it ────
// ── carries `allow-same-origin` today is the reason it must not carry it ─────
// ── again if the IPC origin gate is ever removed. ────────────────────────────
//
// This frame is NOT WireframeView's srcDoc. `lib/sandbox.ts`'s CSP does not and
// cannot apply to it: that policy is planted into a document WE assemble, and
// this document is fetched from a server we do not control the content of.
//
// ── 1. INCREMENT F: `allow-same-origin` WAS a hole ───────────────────────────
// **Tauri injects `__TAURI_INTERNALS__` into EVERY frame, subframes included**,
// so a framed page really could call `invoke`. Measured in a production build
// at `http://tauri.localhost`, framing a plain `python -m http.server`:
//
//   sandbox attribute                          | invoke("kb_root")
//   -------------------------------------------|---------------------------
//   (none)                                     | RESOLVED — full IPC
//   allow-scripts allow-same-origin            | RESOLVED — full IPC
//   allow-scripts allow-same-origin allow-forms| RESOLVED — full IPC
//   allow-scripts                              | REJECTED "Origin header is
//                                              |   not a valid URL"
//
// RESOLVED was literal: the frame called `invoke("write_file", {path, content})`
// and a file appeared on disk. So F shipped `allow-scripts allow-forms` and
// WITHHELD `allow-same-origin`, because the opaque origin (`Origin: null`) was
// the only thing refusing those invokes.
//
// ── 2. INCREMENT G: the control MOVED off the sandbox attribute ──────────────
// Relying on one HTML attribute at one call site was the weakness, not the
// strength — any future frame added anywhere with `allow-same-origin` silently
// re-opened `write_file` and `create_session`. `src-tauri/src/ipc_guard.rs`
// wraps the invoke handler and REJECTS any invoke whose `Origin` is not one of
// the app's own document origins. G measured a cross-origin frame carrying
// `allow-scripts allow-same-origin`: `kb_root`/`write_file` REJECTED, no file
// written, `window.ipc.postMessage` unanswered — while the app's own window
// kept full IPC on both transports.
//
// ── 3. WHAT WITHHOLDING IT ACTUALLY COST (measured 2026-08-02) ───────────────
// The withheld token was not free, and the bill was a BLANK PREVIEW. Framing
// lodestar's real vite dev server (`http://127.0.0.1:5273/`) from a
// cross-origin parent, headless Chromium, Switchboard's exact attribute:
//
//   sandbox="allow-scripts allow-forms"
//     · the frame's `load` event FIRES and the HTML document arrives (200);
//     · then, console, three times over:
//         "Access to script at 'http://127.0.0.1:5273/@vite/client' from
//          origin 'null' has been blocked by CORS policy: No
//          'Access-Control-Allow-Origin' header is present."
//       — same for `/src/main.tsx` and `/@react-refresh`;
//     · `#root` is never populated. The frame renders ALL WHITE.
//
//   sandbox="allow-scripts allow-forms allow-same-origin"
//     · zero CORS errors, "[vite] connecting…" → "[vite] connected.", the app
//       renders exactly as it does in its own window.
//
// The mechanism is not exotic and not lodestar-specific: **`<script type=
// "module">` is always fetched in CORS mode**, and an opaque origin sends
// `Origin: null`. Vite ≥ 6.0.9 (CVE-2025-24010) defaults `server.cors.origin`
// to `defaultAllowedOrigins` — `/^https?:\/\/(?:(?:[^:]+\.)?localhost|
// 127\.0\.0\.1|\[::1\])(?::\d+)?$/` — which `null` cannot match, so the dev
// server answers with no `Access-Control-Allow-Origin` at all (verified with a
// header dump: `Vary: Origin` present, ACAO absent for `null`, present for
// every real localhost origin). EVERY modern bundler-driven dev app is
// module-based, so this is the default outcome, not an edge case.
//
// ── 4. THEREFORE: GRANTED, with the guard as the control ─────────────────────
//   GRANTED
//     · allow-scripts — it is an APP; without it there is nothing to preview.
//     · allow-forms — a form POST is not origin-gated, so this costs nothing
//       and lets you log into your own dev app.
//     · allow-same-origin — the frame is a NORMAL browsing context at the dev
//       server's own origin: its module scripts load, its API calls to itself
//       are same-origin, cookies/localStorage/IndexedDB work. What stops it
//       reaching Switchboard is `ipc_guard`, which is a server-side check on
//       every invoke and not an attribute a future edit can drop by accident.
//       RE-VERIFIED against this exact attribute before it shipped — see the
//       increment-H probe in the feature doc.
//
//   STILL WITHHELD
//     · allow-top-navigation / -by-user-activation — a preview must never
//       navigate the Switchboard window away from Switchboard. (Verified:
//       `top.location.href = …` throws SecurityError.)
//     · allow-popups / allow-popups-to-escape-sandbox — a preview spawning
//       windows in a desktop app is a bug, not a feature.
//     · allow-modals — an `alert()` in a subframe blocks the whole renderer,
//       i.e. the terminal beside it.
//     · allow-downloads, allow-pointer-lock, allow-presentation,
//       allow-orientation-lock — nothing a preview needs.
//
// IF THE GUARD EVER GOES, THIS TOKEN GOES WITH IT. `allow-same-origin` is safe
// here only because `ipc_guard.rs` exists; they are one decision recorded in
// two files, and `ipc_guard`'s tests assert the framed-origin denial precisely
// so this line cannot quietly become wrong.
//
// WHAT IT DOES *NOT* GRANT. `allow-same-origin` means "same origin as the
// document's own URL", NOT "same origin as the parent". Switchboard still
// cannot read into the frame: `contentDocument` reads back null with or without
// the token (measured in both probe runs above), because `tauri.localhost` and
// `127.0.0.1:5273` are different origins regardless of sandboxing. So the
// positional-pin design below is unchanged — nothing about it became possible.
//
// (Switchboard's OTHER frames — the wireframe srcDoc and the component preview
// — still run `allow-scripts` ALONE and must keep doing so. They execute
// untrusted markup we assembled, they have no server whose origin they need,
// and `lib/sandbox.ts`'s `connect-src 'none'` CSP is written on the assumption
// that they cannot reach app storage. That is a different frame with a
// different trade; do not "make it consistent" with this one.)
//
// ── PINS ARE POSITIONAL, and what that costs (Decision 3) ────────────────────
// A live pin is `{xPct, yPct, viewport, url, note}` against the FRAME'S OWN
// BOX. It is not DOM-anchored and never will be: anchoring needs a script
// injected into the dev server, which the original phase-B design rejected and
// this increment re-rejects. Two consequences, both deliberate:
//   1. a pin marks a place ON SCREEN, not a place in the document — scroll the
//      live app and the badge stays where it was put. The recorded `viewport`
//      is what makes the note interpretable later.
//   2. the frame is cross-origin, so IN-APP navigation is invisible to us
//      (`contentWindow.location` throws — probe-verified). Pins are therefore
//      scoped to the URL THE ARTIFACT NAMES (pins.routeScopeOf), the rail says
//      which route that is, and viewing another route means opening another
//      localhost artifact rather than us pretending to follow along.
// Storage is `<project>/live-pins.json` in the KB (repos stay clean) through
// the SAME shared pinsStore every other pin goes through — there is still
// exactly one pins writer.
//
// ── HEALTH ───────────────────────────────────────────────────────────────────
// A dead server otherwise renders WebView2's connection-refused page: a white
// void with no explanation. So the URL is polled and a plain card covers the
// frame when it goes away. The check is `fetch(url, { mode: "no-cors" })` and
// that mode is load-bearing, also from the probe: a normal fetch to a dev
// server REJECTS even while it is up, because dev servers send no CORS headers
// — "TypeError: Failed to fetch" means nothing. In no-cors mode a live server
// resolves an opaque response and a dead port rejects, which is exactly the
// up/down signal and nothing more.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Artifact } from "../../types";
import {
  addPin,
  createLivePin,
  livePinTargetFor,
  livePinViewport,
  pinsForDoc,
  removePin,
  updatePinNote,
} from "../../lib/pins";
import type { Pin, PinsFile } from "../../lib/pins";
import { mutatePins as mutateSharedPins, usePinsFile } from "../../lib/pinsStore";
import { artifactIdentity, sendToThread, useSendToThreadAvailable } from "../../lib/panelStore";
import { buildSendReference, refOptions } from "../../lib/agentContext";
import { PinsRail } from "./PinsRail";

type LocalhostArtifact = Extract<Artifact, { kind: "localhost" }>;

/** Poll cadence. Slow enough to be free against a loopback server, fast enough
 *  that stopping a dev server shows up before you wonder why. */
const HEALTH_POLL_MS = 4000;

/** Consecutive failures before the card is shown. A dev server RESTARTING
 *  (vite on a config change, uvicorn `--reload`) is briefly unreachable, and a
 *  card that flashed on every reload would be worse than the thing it fixes. */
const FAILURES_BEFORE_DOWN = 2;

type Health = "checking" | "up" | "down";

// ── Styles (kit tokens, mono, 11px scale — the wireframe toolbar's twins) ────

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
  background: "transparent",
};

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

const HEALTH_TONE: Record<Health, string> = {
  checking: "var(--text-dim)",
  up: "var(--status-running, #34D399)",
  down: "#EF4444",
};

/**
 * Is the server answering? `active` gates the poll exactly like DocView's —
 * a panel on a hidden tab, or on a non-terminal screen, must not keep hitting
 * the network.
 *
 * Returns the health AND a monotonically increasing `recoveredAt`, which the
 * caller uses to RELOAD the frame when a server comes back: the frame is
 * showing a connection-refused page at that point and nothing reloads it on
 * its own.
 */
function useServerHealth(url: string, active: boolean): { health: Health; recoveredAt: number } {
  const [health, setHealth] = useState<Health>("checking");
  const [recoveredAt, setRecoveredAt] = useState(0);
  const failuresRef = useRef(0);
  const healthRef = useRef<Health>("checking");
  healthRef.current = health;

  useEffect(() => {
    // A new URL is a new question: forget the old server's verdict rather than
    // carrying "down" onto a server we have not asked yet.
    failuresRef.current = 0;
    setHealth("checking");
  }, [url]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const check = async () => {
      let ok = false;
      try {
        // no-cors: see the module header. The response is opaque and that is
        // fine — RESOLVING is the whole signal.
        await fetch(url, { mode: "no-cors", cache: "no-store" });
        ok = true;
      } catch {
        ok = false;
      }
      if (cancelled) return;
      if (ok) {
        failuresRef.current = 0;
        if (healthRef.current !== "up") {
          // down → up (or first success): the frame is stale, reload it.
          if (healthRef.current === "down") setRecoveredAt(Date.now());
          setHealth("up");
        }
        return;
      }
      failuresRef.current += 1;
      if (failuresRef.current >= FAILURES_BEFORE_DOWN && healthRef.current !== "down") {
        setHealth("down");
      }
    };

    void check();
    const timer = setInterval(() => void check(), HEALTH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, active]);

  return { health, recoveredAt };
}

export function LocalhostView({
  artifact,
  active,
}: {
  artifact: LocalhostArtifact;
  /** Tab active && the hosting screen visible — gates the health poll the same
   *  way DocView's gates its doc poll. */
  active: boolean;
}) {
  const { url, project } = artifact;
  const identity = artifactIdentity(artifact);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  const { health, recoveredAt } = useServerHealth(url, active);

  // NAVIGATION IS IMPERATIVE, not a `src` prop. React would only re-navigate
  // when the string CHANGES, and ⟳ means "load this same URL again"; assigning
  // `src` is also the only way to reload a cross-origin frame at all
  // (`contentWindow.location.reload()` throws). No cache-busting query is
  // appended — that would change the URL the dev app sees and, for an SPA
  // router, the route it renders.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    frame.src = url;
  }, [url, reloadNonce]);

  // A server that came back is showing an error page until something reloads
  // it. This is the "recovers when the server returns" half of acceptance 2.
  useEffect(() => {
    if (recoveredAt === 0) return;
    const frame = frameRef.current;
    if (frame) frame.src = url;
  }, [recoveredAt, url]);

  // ── Pins ──
  // `<project>/live-pins.json`, keyed by ROUTE, through the ONE shared store.
  const { sidecarPath, docKey: route } = useMemo(() => livePinTargetFor(artifact), [artifact]);
  const pinsFile = usePinsFile(sidecarPath);
  const [pinMode, setPinMode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const mutatePins = useCallback(
    (fn: (file: PinsFile) => PinsFile) => mutateSharedPins(sidecarPath, fn),
    [sidecarPath]
  );

  const routePins = useMemo(
    () => (pinsFile ? pinsForDoc(pinsFile, route) : []),
    [pinsFile, route]
  );

  const placePin = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const box = overlayRef.current?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) return;
      const pin = createLivePin({
        route,
        xPct: ((e.clientX - box.left) / box.width) * 100,
        yPct: ((e.clientY - box.top) / box.height) * 100,
        url,
        viewport: { w: box.width, h: box.height },
      });
      mutatePins((f) => addPin(f, pin));
      setPinMode(false); // single-shot placement, exactly like the wireframe
      setEditingId(pin.id);
    },
    [route, url, mutatePins]
  );

  const canSend = useSendToThreadAvailable();
  const sendPin = useCallback(
    (number: number, note: string) => {
      sendToThread(buildSendReference(artifact, { number, note }, refOptions()));
    },
    [artifact]
  );

  const down = health === "down";

  return (
    <div style={ROOT_STYLE}>
      <div style={MAIN_COL_STYLE}>
        <div style={TOOLBAR_STYLE}>
          <span
            // What the frame CAN do is worth stating once, because the previous
            // answer ("nothing, it is opaque") was visible as a blank preview
            // and is no longer true. See the module header for the sequence.
            title={
              `${project} — ${url}\n` +
              `${health === "down" ? "not responding" : health === "up" ? "responding" : "checking…"}\n\n` +
              `Framed here, not opened in a browser. The frame runs at the dev ` +
              `server's own origin, so its scripts, API calls and storage work ` +
              `normally; it still cannot navigate this window, open popups, or ` +
              `reach Switchboard's backend (every invoke is origin-checked).`
            }
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            <span
              style={{
                flex: "none",
                width: 6,
                height: 6,
                borderRadius: 3,
                background: HEALTH_TONE[health],
              }}
            />
            <span
              style={{
                color: "var(--text-dim)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {url}
            </span>
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            style={{
              ...BTN_STYLE,
              ...(pinMode ? { color: "var(--text-primary)", borderColor: "var(--text-secondary)" } : {}),
            }}
            disabled={pinsFile === null}
            onClick={() => setPinMode((m) => !m)}
            title={`Pin mode: click on the preview to drop a numbered pin — notes are stored in the KB (${sidecarPath}), never in the repo. A live pin marks a place on SCREEN, not in the document.`}
          >
            {"\u{1F4CC}"} pin
          </button>
          <button
            type="button"
            style={BTN_STYLE}
            onClick={reload}
            title="Reload the preview"
            aria-label="Reload"
          >
            ⟳
          </button>
        </div>

        <div style={FRAME_BOX_STYLE}>
          {/* SANDBOX: read the module header before changing a single token.
              `allow-same-origin` is PRESENT deliberately — without it the frame
              is an opaque origin, its `<script type="module">` requests are
              CORS-blocked by every modern dev server, and the preview renders
              blank. What keeps the framed app out of Switchboard's command
              surface is `src-tauri/src/ipc_guard.rs`, not this attribute.
              `src` is assigned imperatively (the effect above), never as a
              prop, so ⟳ can re-navigate to the same URL. */}
          <iframe
            ref={frameRef}
            title={`${project} live preview`}
            sandbox="allow-scripts allow-forms allow-same-origin"
            style={{
              border: "none",
              display: "block",
              width: "100%",
              height: "100%",
              background: "#FFFFFF",
            }}
          />

          {/* PIN OVERLAY — a transparent layer ABOVE the live app.
              `pointer-events: none` normally, so the app underneath stays
              FULLY interactive (click, scroll, type: the layer is not there as
              far as the pointer is concerned). It captures only in pin mode.
              Badges opt pointer events back ON individually, so a badge is
              always clickable without the layer ever swallowing anything else. */}
          <div
            ref={overlayRef}
            onClick={pinMode ? placePin : undefined}
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: pinMode ? "auto" : "none",
              cursor: pinMode ? "crosshair" : "default",
              // A whisper of a tint while armed — otherwise "am I in pin mode?"
              // is answered only by the toolbar button, and the click is
              // destructive-ish (it drops a pin).
              background: pinMode ? "rgba(228, 228, 231, 0.06)" : "transparent",
            }}
          >
            {routePins.map((pin, i) => (
              <div
                key={pin.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingId(pin.id);
                }}
                title={pin.note || "click to add note"}
                style={{
                  position: "absolute",
                  left: `${pin.xPct}%`,
                  top: `${pin.yPct}%`,
                  transform: "translate(-50%, -50%)",
                  pointerEvents: "auto",
                  minWidth: 18,
                  height: 18,
                  lineHeight: "18px",
                  padding: "0 4px",
                  borderRadius: 9,
                  textAlign: "center",
                  background: editingId === pin.id ? "var(--text-primary)" : "#E4E4E7",
                  color: "#0C0C0E",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  boxShadow: "0 1px 4px rgba(0, 0, 0, 0.45)",
                  userSelect: "none",
                }}
              >
                {i + 1}
              </div>
            ))}
          </div>

          {/* SERVER GONE — a plain card OVER the frame, never a white void.
              Covering rather than unmounting is deliberate: a restart that
              recovers in seconds keeps the frame (and its position in the
              stack) instead of tearing it down and rebuilding it. */}
          {down && <ServerGone url={url} project={project} onRetry={reload} />}
        </div>
      </div>

      <PinsRail
        identity={identity}
        count={routePins.length}
        scopeNote={`route ${route}`}
      >
        {routePins.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
            {pinsFile === null
              ? "loading pins…"
              : "no pins yet — toggle \u{1F4CC} pin, then click on the preview to mark a spot. Live pins are positional: they mark a place on screen, not in the page."}
          </div>
        ) : (
          routePins.map((pin, i) => (
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
                {pinMeta(pin)}
              </div>
            </div>
          ))
        )}
      </PinsRail>
    </div>
  );
}

/** The dead-server state. It names the URL and the PROJECT and nothing else:
 *  Switchboard never observes the COMMAND that started the server (it reads the
 *  server's OUTPUT, and it deliberately does not start servers), so printing
 *  `pnpm dev` here would be a guess dressed up as instruction. What it can say
 *  truthfully is which URL stopped answering, where it lives, and that nothing
 *  further is required once it comes back. */
function ServerGone({
  url,
  project,
  onRetry,
}: {
  url: string;
  project: string;
  onRetry: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--bg-primary)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: 24,
        textAlign: "center",
        fontFamily: "var(--font-mono)",
      }}
    >
      <div style={{ fontSize: 12, color: "#EF4444", fontWeight: 600 }}>server gone</div>
      <div style={{ fontSize: 11.5, color: "var(--text-secondary)", wordBreak: "break-all" }}>
        {url}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7, maxWidth: 380 }}>
        Nothing is answering on that port. Start the dev server again in{" "}
        <span style={{ color: "var(--text-secondary)" }}>{project}</span> — this preview reconnects
        on its own within a few seconds.
      </div>
      <button type="button" style={{ ...BTN_STYLE, marginTop: 2 }} onClick={onRetry}>
        retry now
      </button>
    </div>
  );
}

/** Card footer: author + date, plus the VIEWPORT the pin was placed against —
 *  the one piece of context a percentage on a live app cannot carry by itself. */
function pinMeta(pin: Pin): string {
  const d = new Date(pin.createdAt);
  const when = Number.isNaN(d.getTime()) ? "" : `, ${d.getMonth() + 1}/${d.getDate()}`;
  const viewport = livePinViewport(pin);
  const size = viewport ? ` · ${viewport.w}×${viewport.h}` : "";
  return `— eric${when}${size}`;
}
