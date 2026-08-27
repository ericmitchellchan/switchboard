// Explorer data layer (T9) — IPC wrappers + the pure live-thread annotation.
//
// Same layout rule as the repo's other lib modules: pure, unit-tested logic
// (path containment + annotateProjects) with the IPC surface re-exported from
// ipc.ts (all invoke() wrappers live there by convention). No cache and NO
// polling in v1 — the projects list refreshes on screen activation and dir
// listings are fetched on navigation; the live-thread annotation is the only
// dynamic signal and it derives from threadStore state already in memory.

export {
  explorerProjects,
  explorerList,
  explorerRead,
  explorerWrite,
} from "./ipc";
export type { ExplorerProject, ExplorerEntry } from "./ipc";
import { useCallback, useEffect, useMemo, useState } from "react";
// Aliased because the SAME name is re-exported above (the IPC surface lives in
// ipc.ts by convention) — `useSessionRepos` needs to CALL it, not just pass it
// through.
import { explorerRead, explorerProjects as explorerProjectsIpc } from "./ipc";
import type { ExplorerProject } from "./ipc";
import type { AgentStatus, RepoConfig } from "../types";

// ── Pure: live-thread annotation ─────────────────────────────────────────────

export interface AnnotatedProject extends ExplorerProject {
  /** True when a LIVE thread's workingDir sits inside one of the project's
   *  repo paths — the row shows the running status dot. */
  live: boolean;
}

/** Normalize a Windows-ish absolute path for containment comparison:
 *  backslashes → slashes, trailing slashes trimmed, lower-cased (Windows
 *  paths are case-insensitive; repo paths in the registry and thread
 *  workingDirs routinely differ in drive-letter/segment casing). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Is `child` the same directory as `parent` or nested inside it? Segment-
 *  boundary-safe: `C:/p/switch` is NOT inside `C:/p/switchboard`. Pure. */
export function isPathInside(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (p.length === 0) return false;
  return c === p || c.startsWith(`${p}/`);
}

/**
 * Mark each project whose repos contain a live thread's workingDir. Pure:
 * the caller derives `liveWorkingDirs` from threadStore's public view
 * (threads whose id is in the `launched` set). Object identity of the input
 * projects is preserved inside the returned wrappers.
 */
export function annotateProjects(
  projects: readonly ExplorerProject[],
  liveWorkingDirs: readonly string[]
): AnnotatedProject[] {
  return projects.map((project) => ({
    ...project,
    live: liveWorkingDirs.some((dir) =>
      project.repos.some((repo) => isPathInside(dir, repo))
    ),
  }));
}

// ── Pure: which PROJECT a live preview belongs to (increment F) ──────────────
// A localhost artifact carries a `project`, and that is not decoration: it is
// the folder its pins are filed under (`<project>/live-pins.json`). The dev
// server itself tells us nothing about a project, so the project comes from the
// SESSION the URL was detected in — its working directory, matched against the
// registry the same way annotateProjects matches a live thread's.
//
// ACCEPTANCE 6 lives in the fallback: "a project the registry has never seen
// still previews". A cwd that matches nothing yields its own folder NAME, which
// is a perfectly good bucket for pins and requires no setup anywhere. Detection
// is therefore not registry-bound — the registry only makes the label nicer.

/** The registry project whose repos contain `dir`, or null. Longest match
 *  wins: a repo nested inside another project's checkout belongs to the
 *  INNER one, which is the one you are actually working in. */
export function projectKeyForDir(
  projects: readonly ExplorerProject[],
  dir: string
): string | null {
  if (!dir) return null;
  let bestKey: string | null = null;
  let bestLength = -1;
  for (const project of projects) {
    for (const repo of project.repos) {
      if (!isPathInside(dir, repo)) continue;
      if (repo.length > bestLength) {
        bestLength = repo.length;
        bestKey = project.key;
      }
    }
  }
  return bestKey;
}

/** THE project label for a live preview started in `dir`: the registry key
 *  when there is one, the directory's own name when there is not, and a last
 *  resort of `local` for a session with no usable cwd. Total — a preview
 *  always has somewhere to file its pins. */
export function liveProjectFor(projects: readonly ExplorerProject[], dir: string): string {
  const key = projectKeyForDir(projects, dir);
  if (key) return key;
  // A drive root (`C:\`) basenames to the drive SPEC (`C:`), which is not a
  // project name — and a colon is a segment the KB write guard rejects, so
  // filing pins under it would silently land them at the KB root. `local` is
  // the last resort for that and for a session with no cwd at all.
  //
  // (`basename` returns its INPUT when a path has no usable segment at all —
  // `/` basenames to `/` — so separators are rejected here too.)
  const name = basename(dir ?? "");
  const usable = name.length > 0 && !name.endsWith(":") && !/[/\\]/.test(name);
  return usable ? name : "local";
}

// ── Pure: session repo list (Increment B, acceptance 7) ──────────────────────
// NewSessionDialog used to offer `config.repos` — the hand-maintained
// config.json list — while the side menu already knew the registry's twelve
// projects. This merges the two into ONE list the picker can offer:
//
//   · the REGISTRY is primary (one entry per repo path, so a multi-repo
//     project offers each of its repos and every entry has an absolute
//     `working_dir` to hand `createSession`);
//   · a config repo the registry already covers DISAPPEARS as a duplicate but
//     donates its colour, so Eric's repo-identity dots survive;
//   · a config repo the registry does NOT cover is kept verbatim — nothing he
//     configured is allowed to vanish behind a registry rollout;
//   · archived projects sort LAST and are flagged for dimming.
//
// Dedupe is by RESOLVED path (the same normalization isPathInside uses), not
// by name: `C:\...\orbit` and `c:/.../orbit/` are one repo.

/** Repo-identity fallback for a registry project with no configured colour —
 *  the one surviving use of the brand purple outside the terminal theme
 *  (see SessionHeader, which falls back to the same value). */
export const DEFAULT_REPO_COLOR = "#A78BFA";

export interface SessionRepoOption {
  /** Session name AND repo label: the registry PROJECT KEY (suffixed with the
   *  repo's folder name when the project has several), or the folder name for
   *  a config-only entry. The `openTerminalHere` affordance produces the same
   *  convention. */
  name: string;
  /** Absolute path handed to `createSession` as `working_dir` — this is what
   *  makes the new session START in the repo. */
  path: string;
  color: string;
  /** Config group (divider label). Registry entries carry none: their meta is
   *  the registry STATUS, and inheriting groups would scatter dividers across
   *  a list that is no longer ordered by group. */
  group: string;
  /** Registry status ("active"/"paused"/"archived"); "" for config-only
   *  entries, which the registry knows nothing about. */
  status: string;
  archived: boolean;
  source: "registry" | "config";
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function mergeSessionRepos(
  projects: readonly ExplorerProject[],
  configRepos: readonly RepoConfig[]
): SessionRepoOption[] {
  const configByPath = new Map<string, RepoConfig>();
  for (const repo of configRepos) configByPath.set(normalizePath(repo.path), repo);

  const claimed = new Set<string>();
  const live: SessionRepoOption[] = [];
  const archived: SessionRepoOption[] = [];

  for (const project of projects) {
    const multi = project.repos.length > 1;
    const isArchived = project.status === "archived";
    for (const repo of project.repos) {
      const key = normalizePath(repo);
      if (key.length === 0 || claimed.has(key)) continue;
      claimed.add(key);
      const option: SessionRepoOption = {
        name: multi ? `${project.key}/${basename(repo)}` : project.key,
        path: repo,
        color: configByPath.get(key)?.color ?? DEFAULT_REPO_COLOR,
        group: "",
        status: project.status,
        archived: isArchived,
        source: "registry",
      };
      (isArchived ? archived : live).push(option);
    }
  }

  const extras: SessionRepoOption[] = [];
  for (const repo of configRepos) {
    const key = normalizePath(repo.path);
    if (key.length === 0 || claimed.has(key)) continue;
    claimed.add(key);
    extras.push({
      name: basename(repo.path),
      path: repo.path,
      color: repo.color,
      group: repo.group,
      status: "",
      archived: false,
      source: "config",
    });
  }

  return [...live, ...extras, ...archived];
}

// ── THE repo source both dialogs use ─────────────────────────────────────────
// `+ new thread` (NewThreadDialog) still read `config.repos` alone long after
// increment B moved `Ctrl+T` (NewSessionDialog) onto the registry — Eric's
// config.json holds no repos, so the thread dialog matched NOTHING he typed
// and its empty state told him to go edit a file that is not the source of
// truth any more. Two dialogs that mean "pick a repo" must not have two
// answers, so the fetch AND the merge live here and both of them call it.
//
// FAILURE POSTURE, the same one NewSessionDialog already had: a registry that
// does not answer degrades to the config list (`sessionRepoOptions(null, …)`
// is exactly `mergeSessionRepos([], …)`), never to an empty dialog and never
// to a throw.

/** Merge a registry answer that may not have arrived (`null`) or may have
 *  failed (`null`) with the config list. PURE — the hook below is the only
 *  effectful half. */
export function sessionRepoOptions(
  projects: readonly ExplorerProject[] | null,
  configRepos: readonly RepoConfig[]
): SessionRepoOption[] {
  return mergeSessionRepos(projects ?? [], configRepos);
}

export interface SessionReposState {
  /** The browsable list: registry projects merged with config repos. */
  options: SessionRepoOption[];
  /** Registry projects as fetched (`null` until the fetch settles) — callers
   *  that need to name a project for a DIRECTORY (`liveProjectFor`) need the
   *  raw list, not the merged one. */
  projects: ExplorerProject[] | null;
  /** The registry fetch has not settled yet. */
  loading: boolean;
  /** The registry fetch REJECTED — the list below is config-only. */
  failed: boolean;
}

/** THE registry fetch + merge, shared by NewThreadDialog and NewSessionDialog.
 *  One fetch per mount, cancelled on unmount; a rejection is recorded and
 *  degrades to the config list rather than propagating. */
export function useSessionRepos(configRepos: readonly RepoConfig[]): SessionReposState {
  const [projects, setProjects] = useState<ExplorerProject[] | null>(null);
  const [settled, setSettled] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    explorerProjectsIpc()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        setSettled(true);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setSettled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(() => sessionRepoOptions(projects, configRepos), [projects, configRepos]);
  return { options, projects, loading: !settled, failed };
}

// ── Quick create: a thread with NO repo chosen ───────────────────────────────
// The escape hatch for "just give me a thread". It never asks a question it
// cannot answer honestly: the directory comes from the tab Eric is looking at,
// and the dialog SAYS which directory it is, so the shell's cwd is never a
// surprise.

export interface QuickThreadTarget {
  /** Absolute directory the thread's shell starts in ("" when nothing is
   *  known — createSession then falls back to the process default). */
  path: string;
  /** The REGISTRY PROJECT this directory belongs to, or "" when it belongs to
   *  none. Distinct from `name` on purpose, and the distinction is the whole
   *  point: `name` comes from `liveProjectFor`, which is TOTAL by design (it
   *  labels a pins bucket, so it always answers — falling back to the folder's
   *  own name). Passing that answer on as the session's REPO made a home
   *  directory look like a project called "ericm": the tab grew a dim `ericm`
   *  badge, and TabBar — whose group key is `session.group || session.repo` —
   *  opened a GROUP DIVIDER reading "ERICM" in front of it, for a repo the user
   *  never chose and a row that says "no repo". A label and an identity are
   *  different things, so they are different fields. */
  project: string;
  /** Display label for the row and the default thread title. */
  name: string;
  /** WHERE the directory came from — the label states this verbatim. */
  source: "tab" | "home" | "unknown";
}

/**
 * The directory a repo-less thread starts in: the ACTIVE TAB's working
 * directory when there is one, else the user's home directory, else nothing.
 * Pure — callers supply the tab's cwd (devServer.sessionDirFor) and the home
 * dir (ipc.getHomeDir).
 */
export function quickThreadTarget(
  projects: readonly ExplorerProject[] | null,
  tabDir: string,
  homeDir: string
): QuickThreadTarget {
  const tab = (tabDir ?? "").trim();
  if (tab.length > 0) {
    return {
      path: tab,
      project: projectKeyForDir(projects ?? [], tab) ?? "",
      name: liveProjectFor(projects ?? [], tab),
      source: "tab",
    };
  }
  const home = (homeDir ?? "").trim();
  if (home.length > 0) {
    return {
      path: home,
      project: projectKeyForDir(projects ?? [], home) ?? "",
      name: liveProjectFor(projects ?? [], home),
      source: "home",
    };
  }
  return { path: "", project: "", name: "shell", source: "unknown" };
}

// ── Repo file reads: the fold, and the hook both hosts share ─────────────────
// The Explorer SCREEN and the artifact panel each own a read of the same shape.
// They used to be two copies of the same effect, and the reload button exposed
// what that costs: both blanked `content` to null before every read, so a ⟳ on
// a repo file UNMOUNTED the renderer — in-mockup scroll lost, pin-mode reset
// (an armed click-to-place dropped), an open note editor closed, a component
// preview back to "compiling…" and recompiled from zero. The KB path never had
// that bug because `mergeDocRead` folds a result into the previous state and
// keeps the old content until the new one resolves.
//
// So: the same discipline, in one pure function plus one hook.
//   · blank ONLY when the DOCUMENT changes (project+path), never for a re-read;
//   · on a re-read, swap content only when it actually differs — identity is
//     preserved otherwise, so React bails out of the re-render exactly as it
//     does for a KB poll tick;
//   · a failed re-read keeps the last good content and surfaces the error
//     alongside (a read racing an editor's atomic save must not blank the
//     view) — the same rule mergeDocRead applies.

/** One repo file read attempt. `content` and `error` are both null only while
 *  the FIRST read of a document is in flight. `key` is the document identity
 *  (project + path): `path` alone is not enough, since two projects can hold
 *  the same relative path. */
export type OpenFile = {
  key: string;
  path: string;
  content: string | null;
  error: string | null;
};

export type FileReadResult = { ok: true; content: string } | { ok: false; error: string };

/** Document identity for a repo file. */
export function fileKey(project: string, path: string): string {
  return `${project}\0${path}`;
}

/** State to show while a read for `key` is in flight. A re-read of the SAME
 *  document returns the previous state untouched (identity-equal → no
 *  re-render, no unmount); a different document blanks, because showing the
 *  previous file's body under the new file's name is a lie. */
export function beginFileRead(
  prev: OpenFile | null,
  key: string,
  path: string
): OpenFile | null {
  if (prev && prev.key === key) return prev;
  return { key, path, content: null, error: null };
}

/** Fold one read result into the previous state — the repo-file twin of
 *  kb.mergeDocRead, including its return-the-previous-object rule. */
export function mergeFileRead(
  prev: OpenFile | null,
  key: string,
  path: string,
  result: FileReadResult
): OpenFile | null {
  if (result.ok) {
    if (prev && prev.key === key && prev.content === result.content && prev.error === null) {
      return prev;
    }
    return { key, path, content: result.content, error: null };
  }
  // Keep the last good content of the SAME document; a first read has none.
  const content = prev && prev.key === key ? prev.content : null;
  if (prev && prev.key === key && prev.error === result.error && prev.content === content) {
    return prev;
  }
  return { key, path, content, error: result.error };
}

/** Re-read cadence while a repo file has an OPEN EDIT BUFFER. Matches the KB's
 *  `KB_POLL_MS` so "the agent changed this under me" is noticed at the same
 *  speed wherever the document lives. */
export const REPO_EDIT_POLL_MS = 2500;

/** THE repo-file read, for both hosts. One-shot per document (repo reads have
 *  never polled) plus an explicit `reload` for the wireframe toolbar's ⟳ —
 *  which re-runs this read WITHOUT unmounting anything, per the fold above.
 *
 *  `pollMs > 0` adds a repeat, and there is exactly ONE caller-side reason to
 *  pass it (increment G): the document has an open edit buffer. A KB doc polls
 *  already, so an agent writing under a dirty buffer raises the conflict banner
 *  within 2.5s; a repo file would otherwise not notice until the save-time
 *  re-read. Never silently overwriting is guaranteed either way — this is about
 *  telling you EARLY rather than at the moment you press Ctrl+S. Off by default,
 *  so a repo file you are only reading costs exactly what it always did. */
export function useRepoFile(
  project: string | undefined,
  path: string | undefined,
  pollMs = 0
): { file: OpenFile | null; reload: () => void } {
  const [file, setFile] = useState<OpenFile | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!project || !path) {
      setFile(null);
      return;
    }
    const key = fileKey(project, path);
    let cancelled = false;
    setFile((prev) => beginFileRead(prev, key, path));
    const read = () =>
      explorerRead(project, path)
        .then((content) => {
          if (!cancelled) setFile((prev) => mergeFileRead(prev, key, path, { ok: true, content }));
        })
        .catch((e) => {
          if (!cancelled)
            setFile((prev) => mergeFileRead(prev, key, path, { ok: false, error: String(e) }));
        });
    void read();
    if (pollMs <= 0) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(() => void read(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [project, path, nonce, pollMs]);

  return { file, reload };
}

// ── Actions bridge: "open terminal here" (Increment B, acceptance 7) ─────────
// ExplorerTreeSection renders deep inside SideMenu and App owns session
// creation. Same module-singleton bridge as threadStore.registerThreadActions,
// for the same reason: no callback threaded through SideMenu's props.
//
// CONTRACT — the implementation MUST create a NEW session and nothing else.
// It may not type into, `cd`, or otherwise touch an EXISTING terminal: that
// shell may be mid-command, running claude, or sitting in a REPL, and a
// helpful `cd` is exactly the magic Decision 2 rules out.

export type ExplorerActions = {
  /** Spawn a NEW terminal session whose cwd is `workingDir`, reveal it, and
   *  leave every existing session untouched. */
  openTerminalHere: (name: string, workingDir: string) => void;
  /** Show an EXISTING session's tab (the Projects section's `terminals` rows,
   *  SWIT-31). A plain tab switch — nothing is typed, nothing is spawned. */
  showSession: (sessionId: string) => void;
};

/** One row of a project's `terminals` node: a live session whose cwd sits
 *  inside one of the project's repos. */
export type ProjectSession = { id: string; name: string; status: AgentStatus; workingDir: string };

/** The sessions that BELONG to a project — cwd inside one of its repos, by
 *  the same segment-safe containment `annotateProjects` uses for threads.
 *  Pure: the caller hands in panelStore's published labels (id → name, status,
 *  workingDir). Order is the map's order, i.e. App's session order — the tab
 *  bar's order — so the tree and the bar agree. ANY-match, not longest-match
 *  (`liveProjectFor`): a repo checked out inside another project's checkout
 *  would list its sessions under both — the registry is flat today, so no
 *  project nests in another. The caller filters panel-owned sessions first. */
export function sessionsForProject(
  labels: ReadonlyMap<string, { name: string; status: AgentStatus; workingDir: string }>,
  project: ExplorerProject
): ProjectSession[] {
  const out: ProjectSession[] = [];
  for (const [id, label] of labels) {
    if (!label.workingDir) continue;
    if (project.repos.some((repo) => isPathInside(label.workingDir, repo))) {
      out.push({ id, name: label.name, status: label.status, workingDir: label.workingDir });
    }
  }
  return out;
}

let explorerActions: ExplorerActions | null = null;

export function registerExplorerActions(actions: ExplorerActions | null): void {
  explorerActions = actions;
}

export function getExplorerActions(): ExplorerActions | null {
  return explorerActions;
}
