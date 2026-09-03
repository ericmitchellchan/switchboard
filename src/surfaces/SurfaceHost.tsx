// THE SURFACE HOST (platform evolution, SWIT-30) — renders a `surface`
// artifact: a project's own React page, in THIS document, fed by that
// project's backend.
//
// It is the one place a foreign page touches the shell, so it owns what the
// shell must guarantee about it and the page cannot — three render-time
// guarantees below, plus (5a/5b) the page-facing contexts: `active`, `nav`,
// the focusable root that scopes a page's shortcuts, and the agent seam
// (type a line into the thread beside the page):
//
//   1. CRASH ISOLATION. A class boundary around the page. A throwing surface
//      shows a crash card naming itself and offering a retry; the terminal
//      beside it never notices. (ScreenErrorBoundary does this per screen;
//      this does it per PAGE, because a panel strip can hold several and one
//      bad chart must not take the doc next to it.)
//   2. THE BACKEND CARD. The page needs its backend; the shell does not start
//      servers (the localhost-preview rule). So the host probes the backend's
//      health while the surface is ACTIVE and, after two consecutive misses,
//      swaps the page for a card that names the project, the URL and the
//      start HINT — prose, never a command it runs. Two misses, not one: a
//      restarting backend is briefly unreachable and a card that flashed on
//      every reload would be worse than the blank it replaces. Recovery is
//      automatic on the next successful probe — and it REMOUNTS the page:
//      the card replaces the page rather than overlaying it, so a page's own
//      state (filters, an open drill-in) is lost across a backend outage.
//      Accepted for now: an outage is rare, the page's own retry loop stops
//      with it (no double-polling), and keeping a dead page mounted under an
//      opaque card would need a host-colour the transparent root cannot know.
//   3. THE TOKEN SCOPE. `.sb-surface` (styles/surfaces.css) defines the
//      project's CSS variables and the type defaults preflight would have
//      supplied, so copied code renders as designed without Tailwind's reset
//      ever touching the shell. The root paints TRANSPARENT: a surface takes
//      its host's value (panel #1e1e1e, full width #0f0f0f), the same rule
//      every other viewer follows.
//
// `active` gates the probe exactly as it gates DocView's poll — a surface on
// a hidden tab costs nothing.

import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ErrorInfo, ReactNode } from "react";
import { componentFor, findSurface, surfaceBackend, surfaceLabel, surfaceWindowLabel } from "./registry";
import { notify, openSurfaceWindow } from "../lib/ipc";
import type { SurfaceArtifact, SurfaceBackend } from "./registry";
import { SurfaceAnchorContext, composeAnchorProviders, domAnchorProvider } from "./anchors";
import type { SurfaceAnchorProvider, SurfaceAnchorRegistry } from "./anchors";
import { useSurfacePins } from "./SurfacePins";
import {
  SurfaceActiveContext,
  SurfaceAgentContext,
  SurfaceNavContext,
  SurfaceParamsContext,
  SurfaceRootContext,
} from "./page-api";
import type { SurfaceAgent, SurfaceNav, SurfaceParams } from "./page-api";
import { NO_SURFACE_PARAMS, encodeSurfaceParams, sanitizeSurfaceParams } from "../lib/surfaceParams";
import { openArtifact, sendToThread, useSendToThreadAvailable } from "../lib/panelStore";
import { sanitizeForTypedLine, SEND_REFERENCE_MAX } from "../lib/agentContext";
import { log } from "../lib/logger";

export type { SurfaceArtifact } from "./registry";

/** Probe cadence while active, and the miss count that flips the card. */
export const SURFACE_HEALTH_POLL_MS = 5000;
export const SURFACE_HEALTH_MISSES = 2;

const ROOT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "auto",
  padding: "12px 14px",
  background: "transparent",
};

const NOTE_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: 24,
  textAlign: "center",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-dim)",
  lineHeight: 1.6,
};

export function SurfaceHost({
  artifact,
  active,
  onCloseHost,
}: {
  artifact: SurfaceArtifact;
  active: boolean;
  /** What the page's `closeHost()` does — a surface WINDOW passes its own
   *  close; the panel passes nothing (its × is the panel's). */
  onCloseHost?: () => void;
}) {
  const page = findSurface(artifact.project, artifact.page);
  const backend = surfaceBackend(artifact.project);
  const health = useBackendHealth(backend, active);
  const anchors = useSurfaceAnchors();

  // Pins (3b). Every hook runs before the early returns below (hook order);
  // the rail and toolbar themselves render only on the main branch — an
  // unknown page or a down backend shows its card and nothing else.
  const [pinMode, setPinMode] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);
  const onPlaced = useCallback((outcome: "pinned" | "nothing-here") => {
    setPinMode(false); // single-shot, like the wireframe and the live preview
    if (outcome === "nothing-here") setFlash("nothing pinnable there — click a row, tile or bar");
  }, []);
  const pins = useSurfacePins(artifact, anchors.provider, anchors.rootEl, pinMode, onPlaced, active);
  // The page-facing API (5a): where a page's "go to page X" lands is the
  // shell's decision — the same open rule a tree click follows.
  const nav = useMemo<SurfaceNav>(
    () => ({
      openPage: (page, params) => {
        const clean = sanitizeSurfaceParams(params);
        openArtifact(
          clean
            ? { kind: "surface", project: artifact.project, page, params: clean }
            : { kind: "surface", project: artifact.project, page }
        );
      },
      openWindow: (page) => {
        const target = findSurface(artifact.project, page);
        const win = target?.window;
        const label = surfaceWindowLabel(artifact.project, page);
        const json = JSON.stringify({ kind: "surface", project: artifact.project, page });
        openSurfaceWindow(label, json, {
          title: win?.title ?? `${artifact.project} · ${target?.label ?? page}`,
          width: win?.width ?? 480,
          height: win?.height ?? 320,
        }).catch((e) => log.warn(`openWindow(${page}) failed: ${e}`));
      },
      closeHost: onCloseHost ?? (() => {}),
      notify: (title, body) => void notify(title, body),
    }),
    [artifact.project, onCloseHost]
  );
  // The params (T9): the artifact's own set, or THE frozen empty object. Keyed
  // on the encoded form so a re-render with an equal map hands the page the
  // same reference and its `useEffect([params])` stays quiet.
  const paramsKey = encodeSurfaceParams(artifact.params);
  const params = useMemo<SurfaceParams>(
    () => (paramsKey ? Object.freeze({ ...(artifact.params ?? {}) }) : NO_SURFACE_PARAMS),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paramsKey is the map's identity
    [paramsKey]
  );
  // The agent = the thread beside this surface (page-api §The agent). The
  // page's text goes through the same sanitizer a pin reference does — one
  // typed line, no Enter — so a page can never send on the user's behalf.
  const canSend = useSendToThreadAvailable();
  const agent = useMemo<SurfaceAgent>(
    () => ({
      available: canSend,
      send: (text) => {
        if (!canSend) return { sent: false, truncated: false };
        // Backslashes are on the sanitizer's drop list (a POSIX escape), and a
        // page's most common backslash is a Windows PATH — turn it into the
        // forward slashes the agent's Read tool takes, as artifactRef does.
        const forwardSlashed = text.replace(/\\/g, "/");
        const line = sanitizeForTypedLine(forwardSlashed, SEND_REFERENCE_MAX);
        if (line.length === 0) return { sent: false, truncated: false };
        sendToThread(line);
        // The sanitizer collapses whitespace before it caps, so measure what
        // it would have kept: a cap hit ends the line in `…`.
        const truncated = Array.from(forwardSlashed.trim()).length > SEND_REFERENCE_MAX && line.endsWith("…");
        return { sent: true, truncated };
      },
    }),
    [canSend]
  );

  if (!page) {
    return (
      <div style={NOTE_STYLE}>
        <span style={{ color: "var(--text-muted)" }}>
          no such page: {artifact.project} / {artifact.page}
        </span>
        <span style={{ color: "var(--text-faint)" }}>
          not in src/surfaces/registry.ts — the project may have renamed it
        </span>
      </div>
    );
  }

  if (backend && health === "down") {
    return <BackendCard project={artifact.project} backend={backend} />;
  }

  const Page = componentFor(page);
  const title = `${artifact.project} / ${surfaceLabel(artifact.project, artifact.page)}`;
  return (
    <SurfaceErrorBoundary title={title}>
      <SurfaceAnchorContext.Provider value={anchors.registry}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* The surface toolbar: pin mode, and the one-line refusal when an
              armed click lands on nothing pinnable. Soft palette, 26px, the
              same chrome LocalhostView puts above its frame. Hidden in a
              page's OWN window (5d): a 380px HUD has nothing to pin and the
              window frame already carries its title. */}
          {!onCloseHost && (
          <div style={TOOLBAR_STYLE}>
            <span style={{ flex: 1, minWidth: 0, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {flash ?? (pinMode ? "pin mode — click a row, tile or bar" : "")}
            </span>
            <button
              type="button"
              style={{
                ...TOOL_BTN_STYLE,
                ...(pinMode ? { color: "var(--text-primary)", borderColor: "var(--text-secondary)" } : {}),
              }}
              onClick={() => setPinMode((m) => !m)}
              title={`Pin mode: click a pinnable thing on the page to drop a numbered pin. Pins follow the THING (its anchor), and are stored in the KB (${artifact.project}/surface-pins.json), never in the repo.`}
            >
              {"\u{1F4CC}"} pin{pins.count > 0 ? ` ${pins.count}` : ""}
            </button>
          </div>
          )}
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <div className="sb-surface" style={ROOT_STYLE}>
              {/* The content WRAPPER is the anchor root (DOM provider scope), the
                  mark overlay's coordinate space, and the armed-click capture
                  target. `position: relative` so marks scroll with the page. */}
              <div
                ref={anchors.setRootEl}
                onClickCapture={pins.onCapture}
                // FOCUSABLE root (page-api useSurfaceKeydown): a click inside
                // the page parks focus here unless a control already has it,
                // so the page's own shortcuts work and the terminal's never
                // leak in. `outline: none` — the focus is functional, not a
                // visible ring around the whole page.
                tabIndex={-1}
                onMouseDownCapture={() => {
                  const el = anchors.rootEl;
                  const focused = document.activeElement;
                  if (el && (focused === null || focused === document.body || !el.contains(focused))) {
                    el.focus({ preventScroll: true });
                  }
                }}
                // A click that UNMOUNTS the control it focused (a judge button
                // that swaps to a correction row) leaves focus on <body> by
                // the browser's fixup, and the page's shortcuts would go
                // silent. After the click settles, focus comes back to the
                // root unless something inside the page took it.
                onClick={() => {
                  const el = anchors.rootEl;
                  if (!el) return;
                  queueMicrotask(() => {
                    const focused = document.activeElement;
                    if (focused === null || focused === document.body) el.focus({ preventScroll: true });
                  });
                }}
                style={{
                  position: "relative",
                  minHeight: "100%",
                  outline: "none",
                  cursor: pinMode ? "crosshair" : undefined,
                  background: pinMode ? "rgba(228, 228, 231, 0.04)" : "transparent",
                }}
              >
                <SurfaceRootContext.Provider value={anchors.rootEl}>
                <SurfaceActiveContext.Provider value={active}>
                  <SurfaceNavContext.Provider value={nav}>
                    <SurfaceAgentContext.Provider value={agent}>
                      <SurfaceParamsContext.Provider value={params}>
                        <Suspense fallback={<div style={NOTE_STYLE}>loading {title}…</div>}>
                          <Page />
                        </Suspense>
                      </SurfaceParamsContext.Provider>
                    </SurfaceAgentContext.Provider>
                  </SurfaceNavContext.Provider>
                </SurfaceActiveContext.Provider>
                </SurfaceRootContext.Provider>
                <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>{pins.marks}</div>
              </div>
            </div>
            {pins.rail}
          </div>
        </div>
      </SurfaceAnchorContext.Provider>
    </SurfaceErrorBoundary>
  );
}

const TOOLBAR_STYLE: CSSProperties = {
  height: 26,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 8px 0 12px",
  borderBottom: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
};

const TOOL_BTN_STYLE: CSSProperties = {
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 3,
  color: "var(--text-dim)",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  lineHeight: "16px",
  padding: "0 6px",
  cursor: "pointer",
};

// ── Anchors (Inc 3a — SWIT-35) ───────────────────────────────────────────────

/** The host's anchor plumbing: the content root ELEMENT (held as state via a
 *  callback ref, so a remount after the backend card or a crash card hands
 *  the pins layer a fresh element and its observers re-attach — an object
 *  ref would keep observing the detached node), a registry a page may publish
 *  a programmatic provider into, and the COMPOSED provider (page first, DOM
 *  attributes as the fallback) that pins (3b) resolve through. The registry
 *  object is stable for the host's lifetime so a page effect that publishes
 *  on mount does not re-run per render. */
function useSurfaceAnchors(): {
  rootEl: HTMLDivElement | null;
  setRootEl: (el: HTMLDivElement | null) => void;
  registry: SurfaceAnchorRegistry;
  provider: SurfaceAnchorProvider;
} {
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  rootRef.current = rootEl;
  const [published, setPublished] = useState<SurfaceAnchorProvider | null>(null);
  const publish = useCallback((p: SurfaceAnchorProvider) => {
    setPublished(p);
    return () => setPublished((cur) => (cur === p ? null : cur));
  }, []);
  const registry = useMemo<SurfaceAnchorRegistry>(() => ({ publish }), [publish]);
  const dom = useMemo(() => domAnchorProvider(() => rootRef.current), []);
  const provider = useMemo(() => composeAnchorProviders(published, dom), [published, dom]);
  return { rootEl, setRootEl, registry, provider };
}

// ── Backend probe ────────────────────────────────────────────────────────────

type Health = "unknown" | "up" | "down";

/** Polls `<url><health>` while active. Starts OPTIMISTIC ("unknown" renders
 *  the page): the page's own loading state is the right first paint, and the
 *  card only replaces it once the backend has demonstrably not answered
 *  twice. Any 2xx is "up"; a rejection or non-2xx is a miss. Plain fetch —
 *  the backend sends CORS headers for the webview's origins (that is the
 *  Lodestar-side half of SWIT-30), so unlike the iframe-era `no-cors` probe
 *  this one can actually read the status. */
function useBackendHealth(backend: SurfaceBackend | null, active: boolean): Health {
  const [health, setHealth] = useState<Health>("unknown");

  useEffect(() => {
    if (!backend || !active) return;
    let cancelled = false;
    let misses = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const probe = async () => {
      let ok = false;
      try {
        const res = await fetch(`${backend.url}${backend.health}`, { cache: "no-store" });
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (cancelled) return;
      if (ok) {
        misses = 0;
        setHealth("up");
      } else {
        misses += 1;
        if (misses >= SURFACE_HEALTH_MISSES) setHealth("down");
      }
      timer = setTimeout(probe, SURFACE_HEALTH_POLL_MS);
    };
    void probe();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [backend, active]);

  return health;
}

function BackendCard({ project, backend }: { project: string; backend: SurfaceBackend }) {
  return (
    <div style={NOTE_STYLE}>
      <span style={{ color: "var(--text-secondary)" }}>
        {project}'s backend is not answering
      </span>
      <span>{backend.url}</span>
      {/* The hint is PROSE for a person — Switchboard never starts servers,
          so it names the command without dressing it up as a button. */}
      <span style={{ color: "var(--text-faint)", maxWidth: 360 }}>{backend.hint}</span>
      <span style={{ color: "var(--text-faint)" }}>
        this view resumes by itself once it answers
      </span>
    </div>
  );
}

// ── Crash isolation ──────────────────────────────────────────────────────────

type BoundaryProps = { title: string; children: ReactNode };
type BoundaryState = { error: Error | null };

/** Per-PAGE boundary. `retry` clears the error and remounts the page; the
 *  host above it (panel strip, screen, PiP) is never unmounted. */
class SurfaceErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error(`Surface crashed (${this.props.title}): ${error}${info.componentStack ?? ""}`);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={NOTE_STYLE}>
          <span style={{ color: "var(--text-secondary)" }}>{this.props.title} crashed</span>
          <span style={{ color: "var(--text-muted)", maxWidth: 420, wordBreak: "break-word" }}>
            {String(this.state.error.message || this.state.error)}
          </span>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 4,
              background: "var(--bg-active)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 3,
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              padding: "3px 10px",
              cursor: "pointer",
            }}
          >
            retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
