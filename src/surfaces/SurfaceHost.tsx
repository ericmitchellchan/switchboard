// THE SURFACE HOST (platform evolution, SWIT-30) — renders a `surface`
// artifact: a project's own React page, in THIS document, fed by that
// project's backend.
//
// It is the one place a foreign page touches the shell, so it owns the three
// things the shell must guarantee about it and the page cannot:
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
//      its host's value (panel #1A1A1D, full width #0C0C0E), the same rule
//      every other viewer follows.
//
// `active` gates the probe exactly as it gates DocView's poll — a surface on
// a hidden tab costs nothing.

import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ErrorInfo, ReactNode } from "react";
import type { Artifact } from "../types";
import { componentFor, findSurface, surfaceBackend, surfaceLabel } from "./registry";
import type { SurfaceBackend } from "./registry";
import { SurfaceAnchorContext, composeAnchorProviders, domAnchorProvider } from "./anchors";
import type { SurfaceAnchorProvider, SurfaceAnchorRegistry } from "./anchors";
import { log } from "../lib/logger";

export type SurfaceArtifact = Extract<Artifact, { kind: "surface" }>;

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
}: {
  artifact: SurfaceArtifact;
  active: boolean;
}) {
  const page = findSurface(artifact.project, artifact.page);
  const backend = surfaceBackend(artifact.project);
  const health = useBackendHealth(backend, active);
  const anchors = useSurfaceAnchors();

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
        <div ref={anchors.rootRef} className="sb-surface" style={ROOT_STYLE}>
          <Suspense fallback={<div style={NOTE_STYLE}>loading {title}…</div>}>
            <Page />
          </Suspense>
        </div>
      </SurfaceAnchorContext.Provider>
    </SurfaceErrorBoundary>
  );
}

// ── Anchors (Inc 3a — SWIT-35) ───────────────────────────────────────────────

/** The host's anchor plumbing: a root ref for the DOM provider, a registry a
 *  page may publish a programmatic provider into, and the COMPOSED provider
 *  (page first, DOM attributes as the fallback) that pins (3b) resolve
 *  through. The registry object is stable for the host's lifetime so a page
 *  effect that publishes on mount does not re-run per render. */
function useSurfaceAnchors(): {
  rootRef: React.RefObject<HTMLDivElement>;
  registry: SurfaceAnchorRegistry;
  provider: SurfaceAnchorProvider;
} {
  const rootRef = useRef<HTMLDivElement>(null);
  const [published, setPublished] = useState<SurfaceAnchorProvider | null>(null);
  const publish = useCallback((p: SurfaceAnchorProvider) => {
    setPublished(p);
    return () => setPublished((cur) => (cur === p ? null : cur));
  }, []);
  const registry = useMemo<SurfaceAnchorRegistry>(() => ({ publish }), [publish]);
  const dom = useMemo(() => domAnchorProvider(() => rootRef.current), []);
  const provider = useMemo(() => composeAnchorProviders(published, dom), [published, dom]);
  return { rootRef, registry, provider };
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
