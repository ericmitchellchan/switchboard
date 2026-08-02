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
} from "./ipc";
export type { ExplorerProject, ExplorerEntry } from "./ipc";
import type { ExplorerProject } from "./ipc";
import type { RepoConfig } from "../types";

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
};

let explorerActions: ExplorerActions | null = null;

export function registerExplorerActions(actions: ExplorerActions | null): void {
  explorerActions = actions;
}

export function getExplorerActions(): ExplorerActions | null {
  return explorerActions;
}
