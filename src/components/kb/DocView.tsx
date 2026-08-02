// KB document reading view (T6/T7/T9) — renders the open doc. Markdown goes
// through ONE shared unified processor; .html/.htm wireframes render live in
// WireframeView's sandboxed iframe (T7); .mmd diagrams render in DiagramView
// with pan/zoom + the verification strip (T9); the remaining kinds (.jsx/.tsx
// sources, .json data) show a placeholder until their task lands — the
// docKind switch below is the seam they plug into.
//
// Pipeline (architecture.md KB section — exactly this, in this order):
//   remark-parse → remark-gfm → remark-rehype({allowDangerousHtml:false})
//     → rehype-slug → rehype-autolink-headings({behavior:"wrap"})
//     → rehype-stringify
//
// SAFETY: the rendered HTML is injected via dangerouslySetInnerHTML. Two
// distinct guarantees hold, and only these:
//   1. No raw-HTML/script injection: `allowDangerousHtml: false` makes
//      remark-rehype DROP raw HTML nodes from the markdown — disk content
//      (untrusted by policy; the Explorer renders THIRD-PARTY repo READMEs
//      through this same pipeline via MarkdownDoc) can only ever become
//      text/markdown-shaped markup, and nothing in the pipeline
//      reintroduces raw HTML.
//   2. Navigation containment: the pipeline does NOT sanitize link hrefs —
//      `[x](javascript:…)` still renders as an anchor carrying that href —
//      so MarkdownBody intercepts activation with a delegated click/auxclick
//      handler: in-page `#` anchors keep their default jump, `http(s)`
//      links open in the SYSTEM browser via the shell plugin, and every
//      other href (javascript:, file:, data:, vbscript:, relative paths,
//      unknown schemes) is blocked. The privileged webview itself never
//      navigates from a doc link.
// If the pipeline or the handler changes, BOTH invariants must be
// re-established before keeping the innerHTML injection.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeStringify from "rehype-stringify";
import { docKind, useKbDoc } from "../../lib/kb";
import { log } from "../../lib/logger";
import { WireframeView } from "./WireframeView";
import { DiagramView } from "./DiagramView";

// One shared processor instance — unified processors are immutable-after-
// freeze and reusable; building it per render would re-run plugin setup on
// every doc read.
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeSlug)
  .use(rehypeAutolinkHeadings, { behavior: "wrap" })
  .use(rehypeStringify);

// Kit-matching doc typography (design-state.md tokens). Plain CSS in a scoped
// <style> block — the repo has no Tailwind and no CSS-modules pipeline, and
// element selectors (the markdown HTML is generated, not JSX) need real CSS.
const DOC_CSS = `
.kb-doc {
  max-width: 72ch;
  padding: 18px 24px 48px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
}
.kb-doc h1, .kb-doc h2, .kb-doc h3, .kb-doc h4, .kb-doc h5, .kb-doc h6 {
  color: var(--text-primary);
  font-weight: 600;
  line-height: 1.4;
}
.kb-doc h1 { font-size: 15px; margin: 20px 0 10px; }
.kb-doc h2 { font-size: 12.5px; margin: 18px 0 8px; }
.kb-doc h3, .kb-doc h4, .kb-doc h5, .kb-doc h6 { font-size: 12px; margin: 14px 0 6px; }
.kb-doc h1:first-child { margin-top: 0; }
.kb-doc p { margin: 0 0 10px; }
.kb-doc ul, .kb-doc ol { margin: 0 0 10px; padding-left: 22px; }
.kb-doc li { margin: 2px 0; }
.kb-doc a { color: var(--accent-blue-light); text-decoration: none; }
.kb-doc a:hover { text-decoration: underline; }
/* rehype-autolink-headings behavior:"wrap" wraps heading TEXT in an anchor —
   headings must keep heading color, not link blue. */
.kb-doc h1 a, .kb-doc h2 a, .kb-doc h3 a,
.kb-doc h4 a, .kb-doc h5 a, .kb-doc h6 a { color: inherit; }
.kb-doc code {
  background: var(--bg-active);
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 11px;
  font-family: var(--font-mono);
}
.kb-doc pre {
  background: var(--bg-active);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  padding: 10px 12px;
  margin: 0 0 12px;
  overflow-x: auto;
}
.kb-doc pre code { background: none; border: none; padding: 0; }
.kb-doc blockquote {
  border-left: 2px solid var(--border-subtle);
  margin: 0 0 10px;
  padding: 2px 0 2px 12px;
  color: var(--text-muted);
}
.kb-doc table { border-collapse: collapse; margin: 0 0 12px; font-size: 11.5px; }
.kb-doc th, .kb-doc td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.kb-doc th { color: var(--text-primary); }
.kb-doc hr { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
.kb-doc img { max-width: 100%; }
`;

const SCROLL_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflowY: "auto",
  // SURFACE-AGNOSTIC (increment B): DocView is hosted by both the full-width
  // KB screen (--bg-primary #0C0C0E) and the artifact panel, which now paints
  // its own --bg-elevated #0F0F11 so it reads as a second surface. Painting
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
  const { path: loadedPath, content, error } = useKbDoc(path, active);
  const ready = loadedPath === path;
  const kind = docKind(path);
  const scrollRef = useRef<HTMLDivElement>(null);

  // New doc → back to the top. Poll swaps of the SAME doc never pass here
  // (path unchanged), so live-edit refreshes keep the scroll position.
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [path]);

  return (
    <div ref={scrollRef} style={SCROLL_STYLE}>
      <style>{DOC_CSS}</style>
      {!ready ? null : error !== null && content === null ? (
        <CenteredNote>cannot read {path}: {error}</CenteredNote>
      ) : content === null ? null : kind === "markdown" ? (
        <MarkdownBody content={content} />
      ) : kind === "wireframe" ? (
        // T7: live sandboxed rendering for .html/.htm. keyed by path so all
        // per-doc state (zoom, pins file, pin-mode) re-initializes on doc
        // switch instead of leaking across docs. .jsx/.tsx wireframe SOURCES
        // stay on the placeholder (kind "code") — deferred per architecture.
        <WireframeView key={path} path={path} content={content} />
      ) : kind === "diagram" ? (
        // T9: mermaid rendering with hand-rolled pan/zoom. keyed by path for
        // the same reason as WireframeView — the Transform is per-doc state
        // and must reset on doc SWITCH (it survives live reloads, where the
        // path is unchanged and only `content` swaps).
        <DiagramView key={path} path={path} content={content} />
      ) : (
        <PlaceholderBody kind={kind} path={path} />
      )}
    </div>
  );
}

/** The markdown rendering path as a self-contained unit (pipeline + doc CSS).
 *  T9's Explorer reuses THIS for repo `.md` files instead of duplicating the
 *  unified pipeline — one processor, one typography block, everywhere. */
export function MarkdownDoc({ content }: { content: string }) {
  return (
    <>
      <style>{DOC_CSS}</style>
      <MarkdownBody content={content} />
    </>
  );
}

function MarkdownBody({ content }: { content: string }) {
  const [html, setHtml] = useState("");
  const renderSeq = useRef(0);

  // Async render; the sequence counter drops out-of-order completions (fast
  // typing on disk + slow render must not paint stale HTML over fresh).
  useEffect(() => {
    const seq = ++renderSeq.current;
    processor
      .process(content)
      .then((file) => {
        if (renderSeq.current === seq) setHtml(String(file));
      })
      .catch(() => {
        if (renderSeq.current === seq) setHtml("");
      });
  }, [content]);

  // Delegated link policy (SAFETY invariant 2, module header): the pipeline
  // drops raw HTML but does NOT sanitize hrefs, and this div renders
  // untrusted markdown (KB docs + third-party repo READMEs via the
  // Explorer). `#` anchors keep their in-page default; http(s) opens in the
  // system browser; everything else is blocked. Wired to click AND auxclick
  // so a middle-click can't slip a navigation past the policy.
  const handleLinkActivation = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#")) return; // in-page heading anchor (rehype-slug)
      e.preventDefault();
      if (e.type !== "click") return; // aux/middle activation never navigates
      if (/^https?:\/\//i.test(href)) {
        // System browser via tauri-plugin-shell — the webview never follows.
        open(href).catch((err) => log.warn(`Failed to open link ${href}: ${err}`));
      }
      // Every other href (javascript:, file:, data:, vbscript:, relative,
      // unknown schemes) is intentionally dropped.
    },
    []
  );

  // Safe: allowDangerousHtml:false upstream + the activation policy above —
  // see the module header's SAFETY block.
  return (
    <div
      className="kb-doc"
      onClick={handleLinkActivation}
      onAuxClick={handleLinkActivation}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Kinds without a renderer yet — extension seam for later tasks (code,
 *  data). Centered dim placeholder until then. */
function PlaceholderBody({ kind, path }: { kind: Exclude<ReturnType<typeof docKind>, "markdown" | "wireframe" | "diagram">; path: string }) {
  const label: Record<typeof kind, string> = {
    code: "JSX/TSX source — rendered by a later task",
    data: "JSON document — rendered by a later task",
    unknown: "unsupported document type",
  };
  return (
    <CenteredNote>
      <span style={{ color: "var(--text-muted)" }}>{path.split("/").pop()}</span>
      <span>{label[kind]}</span>
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
