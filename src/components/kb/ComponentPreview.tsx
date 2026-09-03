// `.jsx` / `.tsx` preview (increment C) — the LAZY-LOADING shell.
//
// Ky's pattern, ported: a component SOURCE is compiled to a self-contained
// HTML document and handed to the SAME sandboxed iframe wireframes use, so
// untrusted disk code never runs in the privileged webview and the preview
// inherits the zoom, pin and `→ thread` affordances for free. The compiler
// itself (TypeScript + React's UMD builds) is heavy and lives behind ONE
// module-level `import()` — the mermaid shape — so it lands in its own build
// chunk and the main bundle never carries it.
//
// Failure is always VISIBLE and never fatal: a compile error, a throwing
// module body, a missing export and a component that throws mid-render all
// end as a dim note inside the frame (lib/componentPreview.ts owns the
// wording and the styling).

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { FileArtifact } from "../../types";
import { docFileName } from "../../lib/pins";
import { log } from "../../lib/logger";
import { WireframeView } from "./WireframeView";

type PreviewModule = typeof import("../../lib/componentPreview");

// Module-level: ONE dynamic import for the app's lifetime (mermaid's rule).
let previewPromise: Promise<PreviewModule> | null = null;

function loadPreview(): Promise<PreviewModule> {
  if (!previewPromise) previewPromise = import("../../lib/componentPreview");
  return previewPromise;
}

const NOTE_STYLE: CSSProperties = {
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-dim)",
  padding: 24,
  textAlign: "center",
};

/** Mounted by ArtifactBody with key={artifactIdentity}. `content` is the
 *  SOURCE; what reaches the iframe is the compiled document. */
export function ComponentPreview({
  artifact,
  content,
  onReload,
}: {
  artifact: FileArtifact;
  content: string;
  /** Host's re-read (see ArtifactBody). Passed straight through: a reload
   *  produces new SOURCE, this effect recompiles it, and the frame swaps —
   *  the compile step needs no reload logic of its own. */
  onReload?: () => void;
}) {
  const [doc, setDoc] = useState<string | null>(null);
  const fileName = docFileName(artifact.path);

  useEffect(() => {
    let alive = true;
    // Deliberately NOT `setDoc(null)` first: a live-edit recompile must not
    // blank the frame (the KB poll's rule), and unmounting WireframeView would
    // drop the pins refcount and the zoom for a frame. A doc SWITCH remounts
    // this component anyway — ArtifactBody keys it by artifact identity.
    loadPreview()
      .then((mod) => {
        if (!alive) return;
        // Compilation is a pure string transform; it cannot throw past
        // buildPreviewDocument, which returns the dim note instead.
        setDoc(mod.buildPreviewDocument(content, fileName));
      })
      .catch((e: unknown) => {
        // Only the CHUNK LOAD can land here. Still a dim frame, never a blank
        // panel — the message is built inline because the module that owns
        // previewErrorDocument is exactly the one that failed to load.
        log.warn(`component preview unavailable for ${artifact.path}: ${String(e)}`);
        if (alive) setDoc(FALLBACK_DOC);
      });
    return () => {
      alive = false;
    };
  }, [content, fileName, artifact.path]);

  if (doc === null) return <div style={NOTE_STYLE}>compiling {fileName}…</div>;
  // The compiled document goes through the wireframe surface unchanged:
  // sandbox="allow-scripts" with no allow-same-origin, the contentWindow
  // identity guard on messages, srcDoc memoized on content, zoom + pins.
  return <WireframeView artifact={artifact} content={doc} onReload={onReload} />;
}

/** Chunk-load failure. Same look as componentPreview's own notes, inlined
 *  because that module is what could not be loaded. */
const FALLBACK_DOC = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0f0f0f;color:#6e6e6e;font:11px 'JetBrains Mono','Cascadia Code','SF Mono',monospace">
preview compiler unavailable
</body></html>`;
