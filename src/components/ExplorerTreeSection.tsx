// PROJECTS section of the side menu (SWIT-31 — was "Explorer"): registry
// projects rendered INLINE, each a folder whose children are what the project
// IS — `pages`, `knowledge`, repo shortcuts, `repo`, `terminals` (see the
// PROJECT NODE block below). The `repo` child is the IDE-style file tree this
// section used to draw at the top level (it replaced the former in-screen
// project rail + listing column of ExplorerView, which is viewer-only).
// Project rows keep the old rail's look: name + dim meta (open-tab count, else
// registry status), archived dimmed further, live-thread running dot
// (statusConfig color — the ONLY color here besides the terminals' dots).
// Expanding a project fetches its ROOT listing (for the repo shortcuts) and
// a dir its own, via explorerList (dirs-first, server-side skip-list);
// clicking a FILE goes through
// panelStore.openArtifact (A3) — the panel beside the running shell on the
// terminal screen, the explorer screen full-width when that's what's showing,
// Ctrl/⌘+click inverts. Directory/project rows only expand; they open nothing
// — except for the hover-revealed `>_` affordance, which creates a NEW
// terminal in that project's directory (never `cd`s a live one).
//
// Rows carry IDE folder/file ICONS: a chevron expander plus a folder icon
// (open/closed with the row) on directories, one file icon on files. Names
// from panelStore, paths from components/icons.tsx.
//
// Directory expansion state is side-menu-LOCAL by design (never routed);
// like the KB section it lives at module level so toggling the menu keeps
// the tree where you left it. Listings render from cache immediately and
// refresh in the background on every expand (stale-while-revalidate) — no
// polling.

import { useEffect, useMemo, useState } from "react";
import type { Route } from "../types";
import {
  annotateProjects,
  explorerList,
  explorerProjects,
  getExplorerActions,
} from "../lib/explorer";
import type { ExplorerEntry, ExplorerProject } from "../lib/explorer";
import { useThreadsView } from "../lib/threadStore";
import { getNavState } from "../lib/route";
import {
  FILE_ICON,
  folderIcon,
  openArtifact,
  useActiveTabArtifact,
} from "../lib/panelStore";
import { PulsingDot } from "./PulsingDot";
import { STATUS_CONFIGS } from "../lib/statusConfig";
import { KbTreeNode, TreeMessage, TreeRow } from "./KbTreeSection";
import { surfacePages } from "../surfaces/registry";
import { sessionsForProject } from "../lib/explorer";
import { useSessionLabels, usePanelOwnedSessions, type SessionLabel } from "../lib/panelStore";
import { ancestorFolders, buildKbTree, useKbDocList } from "../lib/kb";
import type { KbNode } from "../lib/kb";

// ── Module-level caches (survive menu unmount) ───────────────────────────────

let projectsCache: ExplorerProject[] | null = null;
/** node key: `project` for a project root, `project::dir/path` for a dir. */
let expandedCache: ReadonlySet<string> = new Set<string>();
const listingCache = new Map<string, ExplorerEntry[]>();
const listingErrors = new Map<string, string>();

function nodeKey(project: string, dir: string): string {
  return dir ? `${project}::${dir}` : project;
}

// ── The PROJECT node's children (SWIT-31, wireframe shell-v0 screen 1) ──────
// A project row expands into what the project IS, in this order:
//   pages      its live app surfaces (surfaces/registry) — when it has any
//   knowledge  its folder in the personal KB (`<kb>/<project>/`) — when it has docs
//   knowledge / specs / docs   shortcuts INTO the repo tree for those dirs — when present
//   repo       the whole file tree (what the Explorer section was)
//   terminals  the live sessions whose cwd is inside one of its repos, + `new terminal here`
// Each pseudo node has a name no real directory listing can produce (trailing
// slash), and its expansion lives in ITS OWN set so toggling one never fetches
// a directory; the shortcut nodes DO share the real dir's listing cache, so
// `specs` under a project and `specs` under `repo` show the same entries.
const PAGES_NODE = "pages/";
const KNOWLEDGE_NODE = "knowledge/";
const REPO_NODE = "repo/";
const TERMINALS_NODE = "terminals/";
/** Repo directories that get a shortcut node beside `repo` when they exist. */
const REPO_SHORTCUTS = ["knowledge", "specs", "docs"] as const;
function shortcutNode(dir: string): string {
  return `${dir}//`;
}
let pseudoExpanded: ReadonlySet<string> = new Set<string>();
/** Expansion of KB folders under a project's `knowledge` node — separate from
 *  the KB section's own set, so opening a folder here does not open it there. */
let kbExpanded: ReadonlySet<string> = new Set<string>();

/** Count docs under a KB folder node (for the `knowledge` row's meta). */
function countDocs(node: KbNode): number {
  if (node.type === "doc") return 1;
  let n = 0;
  for (const child of node.children) n += countDocs(child);
  return n;
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
  //
  // ARCHIVING IS NOT FILTERED HERE, deliberately. `launched` means "a claude
  // process is running behind this record in this app run", and archiving does
  // not stop a process — it hides a ROW. Archiving a live thread (allowed, see
  // selectMenuThreads) therefore leaves this project's dot lit, which is
  // correct: the dot reports the shell, not the thread list. What archiving
  // guarantees is only that the thread is not on the rail; it cannot
  // retroactively make a running conversation stop running.
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

  // Projects section data (SWIT-31): the KB doc list (for each project's
  // `knowledge` node) and the live session list (for `terminals`). Both are
  // module-cached stores — cheap to subscribe to from here.
  const { docs: kbDocs } = useKbDocList(true);
  const kbTree = useMemo(() => buildKbTree(kbDocs ?? []), [kbDocs]);
  const sessionLabels = useSessionLabels();
  // PANEL-OWNED terminals (a `pnpm dev` living in a panel, or a parked one)
  // are NOT tabs and must not be listed as such: a `terminals` row is a tab
  // switch, and switching to a session that lives in a panel would swap a
  // pane onto it — the second live view the one-session-one-view rule
  // (increment H) exists to prevent. Filtered here, so the count on the
  // project row is honest too ("open tabs", not "shells").
  const panelOwned = usePanelOwnedSessions();
  const tabLabels = useMemo(() => {
    const out = new Map<string, SessionLabel>();
    for (const [id, label] of sessionLabels) if (!panelOwned.has(id)) out.set(id, label);
    return out;
  }, [sessionLabels, panelOwned]);
  // The KB doc ACTUALLY on screen — the same rule KbTreeSection applies, so a
  // doc opened from either tree highlights in both.
  const lastKb = getNavState().lastByScreen.kb;
  const activeKbDoc =
    route.screen === "terminal"
      ? panelArtifact?.kind === "kb-doc"
        ? panelArtifact.path
        : undefined
      : route.screen === "kb"
        ? route.doc
        : lastKb?.screen === "kb"
          ? lastKb.doc
          : undefined;
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
              expanded={isOpen}
              icon={folderIcon(isOpen)}
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
          icon={FILE_ICON}
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

  const togglePseudo = (key: string) => {
    const next = new Set(pseudoExpanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    pseudoExpanded = next;
    force();
  };

  /** The `pages` pseudo-folder (SWIT-30): a project's LIVE PAGES, listed
   *  first — drawn only when the surface registry has some for this project,
   *  so every other project's tree is unchanged. Expansion state is
   *  menu-local like directories; rows open through the same `openArtifact`
   *  decision a file does (panel beside a shell, full width from a reading
   *  screen, Ctrl+click inverts). Active = the page ACTUALLY on screen. */
  const renderPages = (project: string) => {
    const pages = surfacePages(project);
    if (pages.length === 0) return null;
    const key = nodeKey(project, PAGES_NODE);
    const open = pseudoExpanded.has(key);
    // Same "what is ACTUALLY on screen" rule as file rows: on the terminal
    // screen the panel's surface, otherwise the project route (live or last).
    const lastProject = getNavState().lastByScreen.project;
    const shown: { project: string; page: string } | undefined =
      route.screen === "terminal"
        ? panelArtifact?.kind === "surface"
          ? { project: panelArtifact.project, page: panelArtifact.page }
          : undefined
        : route.screen === "project"
          ? { project: route.project, page: route.page }
          : lastProject?.screen === "project"
            ? { project: lastProject.project, page: lastProject.page }
            : undefined;
    return (
      <div>
        <TreeRow
          label="pages"
          expanded={open}
          icon={folderIcon(open)}
          depth={1}
          active={false}
          onClick={() => togglePseudo(key)}
        />
        {open &&
          pages.map((page) => (
            <TreeRow
              key={page.id}
              label={page.label}
              icon="surface"
              depth={2}
              active={shown?.project === project && shown?.page === page.id}
              onClick={(e) =>
                openArtifact(
                  { kind: "surface", project, page: page.id },
                  { modifier: e.ctrlKey || e.metaKey }
                )
              }
            />
          ))}
      </div>
    );
  };

  /** `knowledge` — the project's folder in the personal KB, rendered with the
   *  KB section's own node component and its own expansion set. Omitted when
   *  the folder has no docs (a `.gitkeep` is not knowledge). */
  const renderKnowledge = (project: string) => {
    const folder = kbTree.find((n) => n.type === "folder" && n.name === project);
    if (!folder || folder.type !== "folder") return null;
    const count = countDocs(folder);
    if (count === 0) return null;
    const key = nodeKey(project, KNOWLEDGE_NODE);
    const open = pseudoExpanded.has(key);
    const toggleKb = (path: string) => {
      const next = new Set(kbExpanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      kbExpanded = next;
      force();
    };
    const selectKb = (path: string, modifier: boolean) => {
      const needed = ancestorFolders(path);
      if (!needed.every((p) => kbExpanded.has(p))) {
        const next = new Set(kbExpanded);
        for (const p of needed) next.add(p);
        kbExpanded = next;
      }
      openArtifact({ kind: "kb-doc", path }, { modifier });
    };
    return (
      <div>
        <TreeRow
          label="knowledge"
          expanded={open}
          icon={folderIcon(open)}
          depth={1}
          active={false}
          meta={String(count)}
          onClick={() => togglePseudo(key)}
        />
        {open &&
          folder.children.map((child) => (
            <KbTreeNode
              key={child.path}
              node={child}
              depth={2}
              expanded={kbExpanded}
              activeDoc={activeKbDoc}
              onSelect={selectKb}
              onToggle={toggleKb}
            />
          ))}
      </div>
    );
  };

  /** `knowledge` / `specs` / `docs` — shortcuts INTO the repo tree for the
   *  directories a project keeps its thinking in (Lodestar's `knowledge/` is
   *  24 reports the in-app KB tools write). Drawn only when the root listing
   *  has that directory, which the project row's expand already fetched. The
   *  meta says `repo` so it never reads as the KB folder above it. */
  const renderRepoShortcuts = (project: string) => {
    const root = listingCache.get(nodeKey(project, ""));
    if (!root) return null;
    return REPO_SHORTCUTS.filter((d) => root.some((e) => e.is_dir && e.name === d)).map((d) => {
      const key = nodeKey(project, shortcutNode(d));
      const open = pseudoExpanded.has(key);
      return (
        <div key={key}>
          <TreeRow
            label={d}
            expanded={open}
            icon={folderIcon(open)}
            depth={1}
            active={false}
            meta="repo"
            onClick={() => {
              if (!open) fetchListing(project, d); // stale-while-revalidate
              togglePseudo(key);
            }}
          />
          {open && renderDir(project, d, 2)}
        </div>
      );
    });
  };

  /** `repo` — the whole file tree, one level down from where the Explorer
   *  section used to draw it. Directory expansion inside is the SAME cache
   *  the shortcuts use, so a dir open under `specs` is open under `repo/specs`. */
  const renderRepo = (project: string) => {
    const key = nodeKey(project, REPO_NODE);
    const open = pseudoExpanded.has(key);
    return (
      <div>
        <TreeRow
          label="repo"
          expanded={open}
          icon={folderIcon(open)}
          depth={1}
          active={false}
          onClick={() => {
            if (!open) fetchListing(project, "");
            togglePseudo(key);
          }}
        />
        {open && renderDir(project, "", 2)}
      </div>
    );
  };

  /** `terminals` — the live sessions whose cwd is inside one of the project's
   *  repos (explorer.sessionsForProject), each with its statusConfig dot, plus
   *  `+ new terminal here` (the row form of the project row's hover `>_`).
   *  Clicking a session is a tab switch through the explorer actions bridge —
   *  nothing is typed into it. */
  const renderTerminals = (p: ExplorerProject, owned: ReturnType<typeof sessionsForProject>) => {
    const key = nodeKey(p.key, TERMINALS_NODE);
    const open = pseudoExpanded.has(key);
    const dir = p.repos[0];
    return (
      <div>
        <TreeRow
          label="terminals"
          expanded={open}
          icon={folderIcon(open)}
          depth={1}
          active={false}
          meta={owned.length > 0 ? String(owned.length) : undefined}
          onClick={() => togglePseudo(key)}
        />
        {open &&
          owned.map((s) => {
            const cfg = STATUS_CONFIGS[s.status];
            return (
              <TreeRow
                key={s.id}
                label={s.name}
                depth={2}
                active={false}
                meta={cfg.label.toLowerCase()}
                leading={<PulsingDot color={cfg.color} pulse={cfg.pulse} />}
                onClick={() => getExplorerActions()?.showSession(s.id)}
              />
            );
          })}
        {open && dir !== undefined && (
          <TreeRow
            label="+ new terminal here"
            depth={2}
            active={false}
            dim
            onClick={() => getExplorerActions()?.openTerminalHere(p.key, dir)}
          />
        )}
      </div>
    );
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
        const owned = sessionsForProject(tabLabels, p);
        return (
          <div key={p.key}>
            <TreeRow
              label={p.key}
              expanded={isOpen}
              icon={folderIcon(isOpen)}
              depth={0}
              active={activeRoute?.project === p.key}
              // How many of the open tabs live here beats the registry status
              // once there are any — the status still shows for a quiet or
              // archived project. Plain text: the hover `>_` affordance sits
              // right beside this meta, so a glyph here would read twice.
              meta={owned.length > 0 ? `${owned.length} open` : p.status}
              dim={archived}
              leading={
                p.live ? (
                  // Running status dot — live thread inside this project's
                  // repos. The one permitted color: functional status.
                  <PulsingDot color={STATUS_CONFIGS.running.color} pulse />
                ) : undefined
              }
              hoverAction={<OpenTerminalHere project={p} />}
              onClick={() => toggle(p.key, "")}
            />
            {isOpen && renderPages(p.key)}
            {isOpen && renderKnowledge(p.key)}
            {isOpen && renderRepoShortcuts(p.key)}
            {isOpen && renderRepo(p.key)}
            {isOpen && renderTerminals(p, owned)}
          </div>
        );
      })}
    </div>
  );
}

/** "Open terminal here" — hover-revealed on a PROJECT row, exactly like the
 *  thread rows' `×`. A `role="button"` span, not a <button>: TreeRow is
 *  itself a button and nesting one is invalid HTML.
 *
 *  It creates a BRAND-NEW session whose cwd is the project's repo (Decision
 *  2's useful half) and reveals the terminal screen. It NEVER types into a
 *  live shell — no `cd`, no keystroke, no touching an existing session; that
 *  shell may be mid-command, running claude, or in a REPL. The whole effect
 *  goes through App's own creation path via the explorer actions bridge.
 *
 *  Multi-repo projects open their FIRST repo — the same one `explorer_list`
 *  treats as the project's head; a project with no repos gets no affordance.
 *  The session NAME is the project key, matching what the repo picker
 *  produces for the same project. */
function OpenTerminalHere({ project }: { project: ExplorerProject }) {
  const dir = project.repos[0];
  // Rendered on repo presence ALONE — never on `getExplorerActions() !== null`.
  // The bridge is a plain module singleton with no subscription, and App
  // registers it in an effect that runs AFTER first render, so gating the
  // markup on it made the affordance's appearance depend on an unrelated
  // re-render happening to follow. The click no-ops (`?.`) in the window
  // before registration, which is the honest fallback.
  if (dir === undefined) return null;
  return (
    <span
      role="button"
      aria-label={`Open a new terminal in ${project.key}`}
      title={`Open a NEW terminal in ${dir} (no existing terminal is changed)`}
      onClick={(e) => {
        e.stopPropagation();
        getExplorerActions()?.openTerminalHere(project.key, dir);
      }}
      style={{
        flex: "none",
        fontSize: 9,
        lineHeight: 1,
        letterSpacing: -0.5,
        color: "var(--text-dim)",
        padding: "0 2px",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.color = "var(--text-dim)";
      }}
    >
      &gt;_
    </span>
  );
}
