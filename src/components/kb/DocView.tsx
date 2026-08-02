// KB document screen body (T6/T7/T9) — the KB's LOADING POLICY and nothing
// else. It reads the open doc with useKbDoc (a 2500ms re-read while the screen
// is active) and hands the text to the SHARED kind switch, ArtifactBody, which
// the Explorer's FileViewer renders too. Markdown, wireframes, diagrams and
// component previews all live behind that switch; what stays here is the
// scroller, the read-error note, and the KB's own fallback for kinds nothing
// renders yet.
//
// The renderers take content as a PROP and know nothing about where it came
// from — that is what lets a repo file render exactly like a KB doc, and it is
// why the markdown pipeline moved out to MarkdownDoc.tsx (ArtifactBody
// importing it from here was an import cycle).

import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { docKind, useKbDoc } from "../../lib/kb";
import type { FileArtifact } from "../../types";
import { ArtifactBody } from "./ArtifactBody";

const SCROLL_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflowY: "auto",
  // SURFACE-AGNOSTIC (increment B): DocView is hosted by both the full-width
  // KB screen (--bg-primary #0C0C0E) and the artifact panel, which paints its
  // own --bg-panel #1A1A1D so it reads as a second surface. Painting
  // --bg-primary here would punch a terminal-coloured hole in the panel.
  background: "transparent",
};

export function DocView({ path, active }: { path: string; active: boolean }) {
  // `loadedPath` is which doc `content`/`error` actually BELONG to. useKbDoc
  // keeps the previous doc's content until the new read resolves (deliberate —
  // the poll must not blank the view), so a tab switch has a window where
  // `content` is the OLD doc while `kind` is already the NEW one. Rendering
  // through that window mounted DiagramView with markdown in hand and flashed
  // a mermaid parse error. Nothing renders until the two agree.
  const { path: loadedPath, content, error, reload } = useKbDoc(path, active);
  const ready = loadedPath === path;
  const kind = docKind(path);
  const scrollRef = useRef<HTMLDivElement>(null);
  const artifact = useMemo<FileArtifact>(() => ({ kind: "kb-doc", path }), [path]);

  // New doc → back to the top. Poll swaps of the SAME doc never pass here
  // (path unchanged), so live-edit refreshes keep the scroll position.
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [path]);

  return (
    <div ref={scrollRef} style={SCROLL_STYLE}>
      {!ready ? null : error !== null && content === null ? (
        <CenteredNote>cannot read {path}: {error}</CenteredNote>
      ) : content === null ? null : (
        // THE shared kind switch — the Explorer's FileViewer renders the same
        // one over repo files, so an HTML mockup renders identically wherever
        // it lives. Per-doc state (zoom, pins, pan) is keyed inside it.
        <ArtifactBody
          artifact={artifact}
          content={content}
          fallback={<PlaceholderBody kind={kind} path={path} />}
          // The reload affordance is the HOST's read, forced: the KB's poll
          // covers a doc you are watching, but not one you just saved from
          // elsewhere and want NOW (and it pauses entirely while the screen is
          // hidden). Same read, same merge, so an unchanged file is a no-op.
          onReload={reload}
        />
      )}
    </div>
  );
}

/** The KB screen's fallback for kinds ArtifactBody has no renderer for —
 *  `data` and `unknown`. (`code` now renders through ComponentPreview, so it
 *  no longer reaches here — the prop stays the full DocKind anyway rather than
 *  encoding today's coverage in a type.) The Explorer
 *  passes a DIFFERENT fallback — the file's source — because a repo file's
 *  text is worth reading even when nothing renders it. */
function PlaceholderBody({ kind, path }: { kind: ReturnType<typeof docKind>; path: string }) {
  const label =
    kind === "data" ? "JSON document — rendered by a later task" : "unsupported document type";
  return (
    <CenteredNote>
      <span style={{ color: "var(--text-muted)" }}>{path.split("/").pop()}</span>
      <span>{label}</span>
    </CenteredNote>
  );
}

function CenteredNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text-dim)",
        padding: 24,
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}
