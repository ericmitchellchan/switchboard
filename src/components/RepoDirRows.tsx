// One repo directory's entries as side-menu tree rows (SWIT-97) — lifted out
// of ExplorerTreeSection so the Knowledge Base section can draw a project's
// repo `knowledge` / `specs` / `docs` folders with the SAME rows, the SAME
// listing cache (lib/repoListing) and the SAME open path. Each host keeps its
// OWN expansion set (a folder opened under the KB band does not open under
// Projects › repo) and passes it in; directories only expand, files open
// through panelStore.openArtifact as a `repo-file` (panel beside a shell,
// full width from a reading screen, Ctrl/⌘+click inverts).

import { FILE_ICON, folderIcon, openArtifact } from "../lib/panelStore";
import { getListing, getListingError, listingKey } from "../lib/repoListing";
import { TreeMessage, TreeRow } from "./KbTreeSection";

export function RepoDirRows({
  project,
  dir,
  depth,
  isExpanded,
  onToggleDir,
  active,
}: {
  project: string;
  dir: string;
  depth: number;
  /** Is the directory at this repo-relative path expanded in the host's set? */
  isExpanded: (path: string) => boolean;
  /** Toggle (and, on open, fetch) the directory at this repo-relative path. */
  onToggleDir: (path: string) => void;
  /** The repo file ACTUALLY on screen, for the highlight. */
  active: { project?: string; path?: string } | undefined;
}) {
  const key = listingKey(project, dir);
  const entries = getListing(project, dir);
  const error = getListingError(project, dir);
  if (error !== undefined && entries === undefined) {
    return <TreeMessage key={`${key}#err`}>cannot list: {error}</TreeMessage>;
  }
  if (entries === undefined) return <TreeMessage key={`${key}#load`}>loading…</TreeMessage>;
  if (entries.length === 0) return <TreeMessage key={`${key}#empty`}>empty</TreeMessage>;
  return (
    <>
      {entries.map((entry) => {
        const childPath = dir ? `${dir}/${entry.name}` : entry.name;
        const childKey = listingKey(project, childPath);
        if (entry.is_dir) {
          const isOpen = isExpanded(childPath);
          return (
            <div key={childKey}>
              <TreeRow
                label={entry.name}
                expanded={isOpen}
                icon={folderIcon(isOpen)}
                depth={depth}
                active={false}
                onClick={() => onToggleDir(childPath)}
              />
              {isOpen && (
                <RepoDirRows
                  project={project}
                  dir={childPath}
                  depth={depth + 1}
                  isExpanded={isExpanded}
                  onToggleDir={onToggleDir}
                  active={active}
                />
              )}
            </div>
          );
        }
        return (
          <TreeRow
            key={childKey}
            label={entry.name}
            icon={FILE_ICON}
            depth={depth}
            active={active?.project === project && active?.path === childPath}
            onClick={(e) =>
              openArtifact(
                { kind: "repo-file", project, path: childPath },
                { modifier: e.ctrlKey || e.metaKey }
              )
            }
          />
        );
      })}
    </>
  );
}
