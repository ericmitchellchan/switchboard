// EXPLORER section of the side menu — registry projects rendered INLINE with
// IDE-style file browsing (replaces the former in-screen project rail +
// listing column of ExplorerView, which is now viewer-only). Project rows
// keep the old rail's look: name + dim status meta, archived dimmed further,
// live-thread running dot (statusConfig color — the ONLY color here).
// Expanding a project/dir lazily fetches its listing via explorerList
// (dirs-first, server-side skip-list); clicking a FILE goes through
// panelStore.openArtifact (A3) — the panel beside the running shell on the
// terminal screen, the explorer screen full-width when that's what's showing,
// Ctrl/⌘+click inverts. Directory/project rows only expand; they open nothing.
//
// Directory expansion state is side-menu-LOCAL by design (never routed);
// like the KB section it lives at module level so toggling the menu keeps
// the tree where you left it. Listings render from cache immediately and
// refresh in the background on every expand (stale-while-revalidate) — no
// polling.

import { useEffect, useMemo, useState } from "react";
import type { Route } from "../types";
import { annotateProjects, explorerList, explorerProjects } from "../lib/explorer";
import type { ExplorerEntry, ExplorerProject } from "../lib/explorer";
import { useThreadsView } from "../lib/threadStore";
import { getNavState } from "../lib/route";
import { openArtifact, useActiveTabArtifact } from "../lib/panelStore";
import { PulsingDot } from "./PulsingDot";
import { STATUS_CONFIGS } from "../lib/statusConfig";
import { TreeMessage, TreeRow } from "./KbTreeSection";

// ── Module-level caches (survive menu unmount) ───────────────────────────────

let projectsCache: ExplorerProject[] | null = null;
/** node key: `project` for a project root, `project::dir/path` for a dir. */
let expandedCache: ReadonlySet<string> = new Set<string>();
const listingCache = new Map<string, ExplorerEntry[]>();
const listingErrors = new Map<string, string>();

function nodeKey(project: string, dir: string): string {
  return dir ? `${project}::${dir}` : project;
}

export function ExplorerTreeSection({ route }: { route: Route }) {
  // Cache-first render; bump forces a re-render after background fetches
  // land in the module caches.
  const [, setBump] = useState(0);
  const force = () => setBump((n) => n + 1);

  const [projects, setProjects] = useState<ExplorerProject[] | null>(projectsCache);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  // Projects refresh on every menu mount (the old rail refreshed on screen
  // activation; the menu opening is the equivalent moment now).
  useEffect(() => {
    let cancelled = false;
    explorerProjects()
      .then((list) => {
        if (cancelled) return;
        projectsCache = list;
        setProjects(list);
        setProjectsError(null);
      })
      .catch((e) => {
        if (!cancelled) setProjectsError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live-thread annotation (unchanged logic from the old rail).
  const { threads, launched } = useThreadsView();
  const liveDirs = useMemo(
    () => threads.filter((t) => launched.has(t.id)).map((t) => t.workingDir),
    [threads, launched]
  );
  const annotated = useMemo(
    () => annotateProjects(projects ?? [], liveDirs),
    [projects, liveDirs]
  );

  // Open file — the highlight names what is ACTUALLY on screen (A3):
  //   · on the explorer screen, the route's file;
  //   · on the terminal screen, the PANEL's file when it holds a repo-file
  //     (the panel IS the visible file surface there);
  //   · otherwise the last explorer route, so the file you were reading stays
  //     highlighted while you work elsewhere (same rule as the KB tree).
  const panelArtifact = useActiveTabArtifact();
  const panelFile =
    route.screen === "terminal" && panelArtifact?.kind === "repo-file"
      ? { project: panelArtifact.project, path: panelArtifact.path }
      : undefined;
  const lastExplorer = getNavState().lastByScreen.explorer;
  const routeTarget =
    route.screen === "explorer"
      ? route
      : lastExplorer?.screen === "explorer"
        ? lastExplorer
        : undefined;
  const activeRoute: { project?: string; path?: string } | undefined =
    panelFile ?? routeTarget;

  const fetchListing = (project: string, dir: string) => {
    const key = nodeKey(project, dir);
    explorerList(project, dir)
      .then((entries) => {
        listingCache.set(key, entries);
        listingErrors.delete(key);
        force();
      })
      .catch((e) => {
        listingErrors.set(key, String(e));
        force();
      });
  };

  const toggle = (project: string, dir: string) => {
    const key = nodeKey(project, dir);
    const next = new Set(expandedCache);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
      fetchListing(project, dir); // stale-while-revalidate
    }
    expandedCache = next;
    force();
  };

  const renderDir = (project: string, dir: string, depth: number) => {
    const key = nodeKey(project, dir);
    const entries = listingCache.get(key);
    const error = listingErrors.get(key);
    if (error !== undefined && entries === undefined) {
      return <TreeMessage key={`${key}#err`}>cannot list: {error}</TreeMessage>;
    }
    if (entries === undefined) {
      return <TreeMessage key={`${key}#load`}>loading…</TreeMessage>;
    }
    if (entries.length === 0) {
      return <TreeMessage key={`${key}#empty`}>empty</TreeMessage>;
    }
    return entries.map((entry) => {
      const childPath = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.is_dir) {
        const childKey = nodeKey(project, childPath);
        const isOpen = expandedCache.has(childKey);
        return (
          <div key={childKey}>
            <TreeRow
              label={entry.name}
              prefix={isOpen ? "▾" : "▸"}
              depth={depth}
              active={false}
              onClick={() => toggle(project, childPath)}
            />
            {isOpen && renderDir(project, childPath, depth + 1)}
          </div>
        );
      }
      const isActive =
        activeRoute?.project === project && activeRoute?.path === childPath;
      return (
        <TreeRow
          key={nodeKey(project, childPath)}
          label={entry.name}
          depth={depth}
          active={isActive}
          onClick={(e) =>
            openArtifact(
              { kind: "repo-file", project, path: childPath },
              { modifier: e.ctrlKey || e.metaKey }
            )
          }
        />
      );
    });
  };

  return (
    <div>
      {projectsError !== null && (
        <TreeMessage>registry unavailable: {projectsError}</TreeMessage>
      )}
      {projectsError === null && projects !== null && projects.length === 0 && (
        <TreeMessage>no projects in the registry</TreeMessage>
      )}
      {annotated.map((p) => {
        const isOpen = expandedCache.has(nodeKey(p.key, ""));
        const archived = p.status === "archived";
        return (
          <div key={p.key}>
            <TreeRow
              label={p.key}
              prefix={isOpen ? "▾" : "▸"}
              depth={0}
              active={activeRoute?.project === p.key}
              meta={p.status}
              dim={archived}
              leading={
                p.live ? (
                  // Running status dot — live thread inside this project's
                  // repos. The one permitted color: functional status.
                  <PulsingDot color={STATUS_CONFIGS.running.color} pulse />
                ) : undefined
              }
              onClick={() => toggle(p.key, "")}
            />
            {isOpen && renderDir(p.key, "", 1)}
          </div>
        );
      })}
    </div>
  );
}
