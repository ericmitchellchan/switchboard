// THE artifact BODY — "given an Artifact and whether it is visible, render it".
//
// It was ArtifactPanel's private `switch (artifact.kind)` until increment F
// gave the PiP window the ability to host an artifact too. Two copies of that
// switch would mean a kind rendered one way in the panel and another way (or
// not at all) floating — the exact drift ArtifactBody was extracted to end one
// layer down, for the same reason.
//
// It stays a level ABOVE ArtifactBody and does a different job. ArtifactBody
// maps a docKind to a RENDERER for content someone else loaded. This maps an
// ARTIFACT to its host + LOADING POLICY:
//
//   kb-doc     → DocView          (useKbDoc's 2500ms active-gated poll)
//   repo-file  → FileViewer       (one-shot explorerRead, folded not blanked)
//   localhost  → LocalhostView    (no read at all — a live frame + a health poll)
//
// `active` means "the tab is on screen AND its screen is showing", and every
// branch that polls anything takes it, so a panel on a hidden tab costs
// nothing. Nothing here renders chrome: the header, the tab strip and the
// pop-out action belong to whoever hosts this.

import type { Artifact } from "../../types";
import { useRepoFile } from "../../lib/explorer";
import { artifactIdentity } from "../../lib/panelStore";
import { DocView } from "./DocView";
import { FileViewer } from "../ExplorerView";
import { LocalhostView } from "./LocalhostView";

export function ArtifactSurface({
  artifact,
  active,
}: {
  artifact: Artifact;
  active: boolean;
}) {
  switch (artifact.kind) {
    case "kb-doc":
      return (
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <DocView path={artifact.path} active={active} />
        </div>
      );
    case "repo-file":
      return (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <RepoFileBody project={artifact.project} path={artifact.path} />
        </div>
      );
    case "localhost":
      return (
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* KEYED BY IDENTITY, the same rule ArtifactBody applies one layer
              down. Switching between two localhost tabs keeps the element TYPE
              the same, so without this React reuses the instance and the new
              URL inherits the previous one's pin mode, open note editor, health
              verdict and rail-collapse state — all of which are per-document. */}
          <LocalhostView key={artifactIdentity(artifact)} artifact={artifact} active={active} />
        </div>
      );
  }
}

/** Repo-file body: one read per (project, path) feeding the Explorer's own
 *  FileViewer — which since increment C routes by the SAME `docKind` switch a
 *  KB doc goes through, so an `.html` mockup in a repo renders here exactly as
 *  it does from the KB tree.
 *
 *  No `active` gate here, deliberately — explorer reads are ONE-SHOT (no poll
 *  to pause, unlike DocView's 2.5s doc poll), so gating on visibility would
 *  only buy a re-read on every screen switch back. Matches ExplorerView's
 *  read exactly. */
function RepoFileBody({ project, path }: { project: string; path: string }) {
  // ONE read implementation for both hosts (lib/explorer.useRepoFile) — a host
  // is chrome + lifecycle, and that includes not owning a second copy of the
  // Explorer screen's effect. It also carries the ⟳'s rule: a reload folds
  // into the existing state instead of blanking it, so the renderer is never
  // unmounted mid-edit.
  const { file, reload } = useRepoFile(project, path);

  if (!file) return null;
  return <FileViewer project={project} file={file} onReload={reload} />;
}
