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
