// REPO LISTINGS, SHARED (SWIT-97) — the one module-level cache of repo
// directory listings (`explorer_list`) and of the registry project list
// (`explorer_projects`), read by BOTH side-menu trees: the Projects section
// (full shell mode) and the Knowledge Base section, which now shows each
// project's repo `knowledge` / `specs` / `docs` folders LIVE beside its KB
// folder (Eric, 2026-09-23: "get all the Lodestar stuff in the knowledge
// base" — decided: show the project's own folders, never a copy).
//
// One cache, so a directory expanded under the KB band and the same directory
// under Projects › repo show the same entries from the same fetch. Listings
// render from cache and refresh in the background on every expand
// (stale-while-revalidate) — no polling, exactly the Projects section's rule.
//
// The registry project list lives here too, so both trees read ONE copy from
// ONE `explorer_projects` call. The menu unmounts when hidden, so "refresh on
// mount" would re-list the registry and every project's root on each
// Ctrl+Shift+B; `refreshRepoKb` is therefore throttled to REFRESH_MIN_MS.
//
// The pure parts (`repoShortcutDirs`, `repoKbProjects`, `withRepoProjects`,
// `shouldRefresh`) are tested; the store is a thin notify-on-write singleton.
//
// PROJECT REPORTS (SWIT-107) ride the same store: each registry project's
// `.sb-views/_project/index.json` (one per repo — `list_project_views`),
// parsed tolerantly (`parseProjectViewIndex`), merged newest first
// (`mergeProjectViews`), cached per project and refreshed with the registry
// — no polling. The KB band draws them as a `reports` folder under the
// project; Home's Kept views block lists the newest across projects
// (`newestProjectViews`).

import { useSyncExternalStore } from "react";
import { explorerList, explorerProjects } from "./explorer";
import { listProjectViews, type ProjectViewIndexFile } from "./ipc";
import type { ExplorerEntry, ExplorerProject } from "./explorer";
import type { KbNode } from "./kb";

/** Repo directories a project keeps its thinking in — shown as folders in the
 *  KB band and as shortcuts in the Projects section, when they exist. */
export const REPO_SHORTCUTS = ["knowledge", "specs", "docs"] as const;

/** Cache key: `project` for a repo root, `project::dir/path` for a dir. */
export function listingKey(project: string, dir: string): string {
  return dir ? `${project}::${dir}` : project;
}

// ── Pure rules ───────────────────────────────────────────────────────────────

/** Which of REPO_SHORTCUTS a repo root listing actually holds, in
 *  REPO_SHORTCUTS order. A FILE named `specs` is not a folder. */
export function repoShortcutDirs(root: readonly ExplorerEntry[] | undefined): string[] {
  if (!root) return [];
  return REPO_SHORTCUTS.filter((d) => root.some((e) => e.is_dir && e.name === d));
}

/** The projects whose repo folders the KB band shows: not archived, exactly
 *  ONE repo (a multi-repo project's root listing is its repo NAMES, so
 *  `specs` would be one level down — out of scope for v1), and a root
 *  listing that holds at least one shortcut dir. Map: project key → dirs. */
export function repoKbProjects(
  projects: readonly ExplorerProject[],
  rootListing: (project: string) => readonly ExplorerEntry[] | undefined
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of projects) {
    if (p.status === "archived" || p.repos.length !== 1) continue;
    const dirs = repoShortcutDirs(rootListing(p.key));
    if (dirs.length > 0) out.set(p.key, dirs);
  }
  return out;
}

/** A mount-time refresh runs at most once per this window. A new `specs/`
 *  in a repo therefore shows within half a minute of the next menu open. */
export const REFRESH_MIN_MS = 30_000;

/** Pure: may a refresh run now? Never-run (`null`) always may. */
export function shouldRefresh(lastAt: number | null, now: number, minMs = REFRESH_MIN_MS): boolean {
  return lastAt === null || now - lastAt >= minMs;
}

/** The KB tree with a top-level folder for every repo project that has none
 *  yet (`personal-kb/lodestar/` holds no docs, so buildKbTree never makes a
 *  `lodestar` folder — but its repo does have specs). Keeps buildKbTree's
 *  order (folders first, then by name). Returns the SAME array when nothing
 *  is added. */
export function withRepoProjects(tree: KbNode[], projectKeys: Iterable<string>): KbNode[] {
  const have = new Set(tree.filter((n) => n.type === "folder").map((n) => n.name));
  const added: KbNode[] = [];
  for (const key of projectKeys) {
    if (have.has(key)) continue;
    have.add(key);
    added.push({ type: "folder", name: key, path: key, children: [] });
  }
  if (added.length === 0) return tree;
  return [...tree, ...added].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1
  );
}

// ── Project views (SWIT-107) ─────────────────────────────────────────────────

/** Rows kept per project index — mirrors the server's PROJECT_VIEW_INDEX_CAP. */
export const PROJECT_VIEW_INDEX_CAP = 200;

/** One project view as its index lists it. `repo` = the repo's name in a
 *  multi-repo project, `""` otherwise. */
export type ProjectViewEntry = {
  project: string;
  id: string;
  title: string;
  kind: string;
  builtAt: string;
  threadId: string;
  repo: string;
};

const VIEW_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Tolerant parse of one index.json: junk → none; a broken row drops alone
 *  (a bad or repeated id); a missing title reads as the id. Order is the
 *  file's (newest first), capped. */
export function parseProjectViewIndex(raw: string, project: string, repo = ""): ProjectViewEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = typeof data === "object" && data !== null ? (data as { views?: unknown }).views : null;
  if (!Array.isArray(list)) return [];
  const out: ProjectViewEntry[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    if (out.length >= PROJECT_VIEW_INDEX_CAP) break;
    if (typeof v !== "object" || v === null) continue;
    const e = v as Record<string, unknown>;
    if (typeof e.id !== "string" || !VIEW_ID.test(e.id) || seen.has(e.id)) continue;
    seen.add(e.id);
    const title = typeof e.title === "string" && e.title.trim().length > 0 ? e.title.trim().slice(0, 200) : e.id;
    out.push({
      project,
      id: e.id,
      title,
      kind: typeof e.kind === "string" ? e.kind : "view",
      builtAt: typeof e.builtAt === "string" ? e.builtAt : "",
      threadId: typeof e.threadId === "string" ? e.threadId : "",
      repo,
    });
  }
  return out;
}

function stampOf(e: ProjectViewEntry): number {
  const t = Date.parse(e.builtAt);
  return Number.isFinite(t) ? t : -Infinity;
}

/** A project's indexes (one per repo) as ONE list: newest first by builtAt
 *  (an unparseable stamp sorts last, ties keep file order), an id listed by
 *  two repos kept once (the first — Rust reads the first repo holding it). */
export function mergeProjectViews(project: string, files: readonly ProjectViewIndexFile[]): ProjectViewEntry[] {
  const seen = new Set<string>();
  const all: ProjectViewEntry[] = [];
  for (const f of files) {
    for (const e of parseProjectViewIndex(f.content, project, f.repo)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      all.push(e);
    }
  }
  return all.map((e, i) => ({ e, i })).sort((a, b) => stampOf(b.e) - stampOf(a.e) || a.i - b.i).map(({ e }) => e);
}

/** The newest `n` project views across every project — Home's list. */
export function newestProjectViews(
  projectKeys: Iterable<string>,
  viewsOf: (project: string) => readonly ProjectViewEntry[] | undefined,
  n = 8
): ProjectViewEntry[] {
  const all: ProjectViewEntry[] = [];
  for (const key of projectKeys) all.push(...(viewsOf(key) ?? []));
  return all.sort((a, b) => stampOf(b) - stampOf(a)).slice(0, n);
}

/** The projects with at least one project view — the KB band's `reports`
 *  folders. Map: project key → views (newest first). */
export function reportProjects(
  projects: readonly ExplorerProject[],
  viewsOf: (project: string) => readonly ProjectViewEntry[] | undefined
): Map<string, readonly ProjectViewEntry[]> {
  const out = new Map<string, readonly ProjectViewEntry[]>();
  for (const p of projects) {
    const views = viewsOf(p.key);
    if (views && views.length > 0) out.set(p.key, views);
  }
  return out;
}

// ── The store ────────────────────────────────────────────────────────────────

const listings = new Map<string, ExplorerEntry[]>();
const projectViews = new Map<string, ProjectViewEntry[]>();
const listingErrors = new Map<string, string>();
let projects: ExplorerProject[] | null = null;
let projectsError: string | null = null;
let lastRefreshAt: number | null = null;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version++;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getListing(project: string, dir: string): ExplorerEntry[] | undefined {
  return listings.get(listingKey(project, dir));
}

export function getListingError(project: string, dir: string): string | undefined {
  return listingErrors.get(listingKey(project, dir));
}

/** Fetch (or re-fetch) one listing; the cached entries keep rendering until
 *  it lands. A failed re-fetch keeps the last good entries. */
export function fetchListing(project: string, dir: string): void {
  const key = listingKey(project, dir);
  explorerList(project, dir)
    .then((entries) => {
      listings.set(key, entries);
      listingErrors.delete(key);
      notify();
    })
    .catch((e) => {
      listingErrors.set(key, String(e));
      notify();
    });
}

/** A project's views (SWIT-107), newest first; undefined until fetched. */
export function getProjectViews(project: string): ProjectViewEntry[] | undefined {
  return projectViews.get(project);
}

/** Fetch (or re-fetch) a project's view indexes. A failed fetch keeps the
 *  last good list (a project with no index resolves to an empty list). */
export function fetchProjectViews(project: string): void {
  listProjectViews(project)
    .then((files) => {
      projectViews.set(project, mergeProjectViews(project, files));
      notify();
    })
    .catch(() => {
      // keep what we had — the next refresh retries
    });
}

/** Re-render on any listing or project-list change. Returns the store
 *  version (callers read through the getters). */
export function useRepoListings(): number {
  return useSyncExternalStore(subscribe, () => version);
}

export function getRegistryProjects(): { projects: ExplorerProject[] | null; error: string | null } {
  return { projects, error: projectsError };
}

/** Refresh the registry project list, then every single-repo project's ROOT
 *  listing (what decides which KB folders get repo folders and which repo
 *  shortcuts the Projects section draws). Called when either tree mounts —
 *  the moment the old rail refreshed on — at most once per REFRESH_MIN_MS.
 *  A FAILED list call does not count, so the next mount retries it. */
export function refreshRepoKb(now: number = Date.now()): void {
  if (!shouldRefresh(lastRefreshAt, now)) return;
  lastRefreshAt = now;
  explorerProjects()
    .then((list) => {
      projects = list;
      projectsError = null;
      notify();
      for (const p of list) {
        if (p.status !== "archived" && p.repos.length === 1) fetchListing(p.key, "");
        // SWIT-107: every live project's reports, multi-repo ones included.
        if (p.status !== "archived") fetchProjectViews(p.key);
      }
    })
    .catch((e) => {
      projectsError = String(e);
      lastRefreshAt = null;
      notify();
    });
}

/** Test-only. */
export function __resetRepoListingsForTests(): void {
  listings.clear();
  projectViews.clear();
  listingErrors.clear();
  projects = null;
  projectsError = null;
  lastRefreshAt = null;
  version = 0;
}
