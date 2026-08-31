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
//   session    → a NOTE, never a terminal (increment H — read on)
//
// THE SESSION ARM IS DELIBERATELY NOT A TERMINAL. A `session` artifact has
// exactly one live view, and that view is mounted by the PANEL, which hosts it
// directly (ArtifactPanel's body renders App's `renderSession` before it
// reaches this switch). This surface is also what the FLOATING WINDOW renders,
// and a terminal there would be the second live view of one session — the
// steal case this whole increment is shaped to avoid. So every OTHER host says
// so plainly instead of drawing one. (panelStore refuses to pop a session out
// at all; this arm covers a `pip.html?artifact=` URL typed by hand.)
//
// `active` means "the tab is on screen AND its screen is showing", and every
// branch that polls anything takes it, so a panel on a hidden tab costs
// nothing. Nothing here renders chrome: the header, the tab strip and the
// pop-out action belong to whoever hosts this.

import type { Artifact } from "../../types";
import { REPO_EDIT_POLL_MS, useRepoFile } from "../../lib/explorer";
import { useHasBuffer } from "../../lib/editor";
import { artifactIdentity } from "../../lib/panelStore";
import { DocView } from "./DocView";
import { FileViewer } from "../ExplorerView";
import { LocalhostView } from "./LocalhostView";
import { PageView } from "./PageView";
import { SurfaceHost } from "../../surfaces/SurfaceHost";

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
    case "surface":
      return (
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* Keyed by identity for the same reason localhost is: two surfaces
              share an element type, and a page's own state (open drill-in,
              filters) is per-page, not per-slot. SurfaceHost owns the error
              boundary, the backend card and the token scope — this switch
              stays a host+policy map, not a renderer. */}
          <SurfaceHost key={artifactIdentity(artifact)} artifact={artifact} active={active} />
        </div>
      );
    case "page":
      return (
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {/* Keyed by identity like localhost/surface: two threads' pages
              share an element type, and the seen-stamp + fold state are
              per-thread. Loading policy is pageStore's (2.5s active-gated). */}
          <PageView key={artifactIdentity(artifact)} threadId={artifact.threadId} active={active} />
        </div>
      );
    case "view":
      // SWIT-48 stub — the renderer is SWIT-50. The tab exists so nothing is
      // lost; the body says what it will become rather than drawing nothing.
      return (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            textAlign: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-dim)",
          }}
        >
          A rendered view lands here — table, candles, distribution — once the
          view renderer ships.
        </div>
      );
    case "session":
      return (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            textAlign: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--text-dim)",
          }}
        >
          This terminal is live in the panel that created it — one session, one
          view.
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
  //
  // The ONE case where a repo file polls (increment G): it has an open edit
  // buffer, so an agent writing under it must raise the conflict banner within
  // the same 2.5s a KB doc would, rather than waiting for the save-time
  // re-read. Loading policy stays the HOST's decision — the editor store only
  // answers "is there a buffer".
  const editing = useHasBuffer(artifactIdentity({ kind: "repo-file", project, path }));
  const { file, reload } = useRepoFile(project, path, editing ? REPO_EDIT_POLL_MS : 0);

  if (!file) return null;
  return <FileViewer project={project} file={file} onReload={reload} />;
}
