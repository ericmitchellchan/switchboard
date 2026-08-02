// THE kind switch (increment C) — one mapping from a file artifact to its
// renderer, for every surface that shows a document body.
//
// WHY IT EXISTS: there used to be two mappings. DocView routed KB docs by
// `docKind` (`.html`→wireframe, `.mmd`→diagram, `.md`→markdown), while the
// Explorer's FileViewer knew only `.md` and dumped everything else into a
// `<pre>` — so an HTML mockup that happened to live in a REPO rendered as
// source, in the panel and on the Explorer screen alike. The fix is not a
// second mapping in FileViewer; it is this component, which both call.
//
// `docKind` (lib/kb.ts) stays the single kind VOCABULARY — nothing here
// re-derives a kind from an extension. What differs between the two hosts is
// only the FALLBACK for kinds with no renderer: the KB screen shows its
// "rendered by a later task" placeholder, the Explorer shows the file's
// source. That is the one thing this component takes as a prop.
//
// Every renderer is keyed by `artifactIdentity`, not by path: a repo file and
// a KB doc can share a relative path, so a path key would let one document's
// zoom/pin/pan state survive a switch to a different document.

import type { ReactNode } from "react";
import type { FileArtifact } from "../../types";
import { docKind } from "../../lib/kb";
import { artifactIdentity } from "../../lib/panelStore";
import { MarkdownDoc } from "./MarkdownDoc";
import { WireframeView } from "./WireframeView";
import { DiagramView } from "./DiagramView";
import { ComponentPreview } from "./ComponentPreview";

export function ArtifactBody({
  artifact,
  content,
  fallback,
  onReload,
}: {
  /** WHICH document this is — identity for per-doc state, the pins sidecar,
   *  and the `→ thread` reference. */
  artifact: FileArtifact;
  /** The document's CURRENT text. The host owns loading and refresh policy
   *  (KB: useKbDoc's active-gated poll; repo: a one-shot explorerRead). */
  content: string;
  /** Rendered for kinds with no renderer (`data`, `unknown`). */
  fallback: ReactNode;
  /** Re-read this artifact from disk NOW. The HOST supplies it, exactly as it
   *  supplies `content` — a renderer still never loads a path itself. Passed
   *  through to the wireframe surface, which is the only renderer with a
   *  toolbar to put it on. */
  onReload?: () => void;
}) {
  const key = artifactIdentity(artifact);
  switch (docKind(artifact.path)) {
    case "markdown":
      return <MarkdownDoc content={content} />;
    case "wireframe":
      // Live sandboxed rendering for .html/.htm.
      return <WireframeView key={key} artifact={artifact} content={content} onReload={onReload} />;
    case "diagram":
      // Mermaid with pan/zoom (its own lazy chunk).
      return <DiagramView key={key} path={artifact.path} content={content} />;
    case "code":
      // .jsx/.tsx compiled into the same sandboxed frame (its own lazy chunk).
      return (
        <ComponentPreview key={key} artifact={artifact} content={content} onReload={onReload} />
      );
    default:
      return <>{fallback}</>;
  }
}
