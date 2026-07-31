// KB document reading view (T6/T7) — renders the open doc. Markdown goes
// through ONE shared unified processor; .html/.htm wireframes render live in
// WireframeView's sandboxed iframe (T7); the remaining kinds (.mmd diagrams,
// .jsx/.tsx sources, .json data) show a placeholder until their task lands —
// the docKind switch below is the seam they plug into.
//
// Pipeline (architecture.md KB section — exactly this, in this order):
//   remark-parse → remark-gfm → remark-rehype({allowDangerousHtml:false})
//     → rehype-slug → rehype-autolink-headings({behavior:"wrap"})
//     → rehype-stringify
//
// SAFETY: the rendered HTML is injected via dangerouslySetInnerHTML. That is
// safe here because `allowDangerousHtml: false` makes remark-rehype DROP raw
// HTML nodes from the markdown instead of passing them through — disk content
// (untrusted by policy) can only ever become text/markdown-shaped markup, and
// nothing in the pipeline reintroduces raw HTML. If the pipeline ever
// changes, this invariant must be re-established before keeping the
// innerHTML injection.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeStringify from "rehype-stringify";
import { docKind, useKbDoc } from "../../lib/kb";
import { WireframeView } from "./WireframeView";

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
  background: "var(--bg-primary)",
};

export function DocView({ path, active }: { path: string; active: boolean }) {
  const { content, error } = useKbDoc(path, active);
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
      {error !== null && content === null ? (
        <CenteredNote>cannot read {path}: {error}</CenteredNote>
      ) : content === null ? null : kind === "markdown" ? (
        <MarkdownBody content={content} />
      ) : kind === "wireframe" ? (
        // T7: live sandboxed rendering for .html/.htm. keyed by path so all
        // per-doc state (zoom, pins file, pin-mode) re-initializes on doc
        // switch instead of leaking across docs. .jsx/.tsx wireframe SOURCES
        // stay on the placeholder (kind "code") — deferred per architecture.
        <WireframeView key={path} path={path} content={content} />
      ) : (
        <PlaceholderBody kind={kind} path={path} />
      )}
    </div>
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

  // Safe: allowDangerousHtml:false upstream — see module header.
  return <div className="kb-doc" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Kinds without a renderer yet — extension seam for later tasks (diagrams,
 *  code, data). Centered dim placeholder until then. */
function PlaceholderBody({ kind, path }: { kind: Exclude<ReturnType<typeof docKind>, "markdown" | "wireframe">; path: string }) {
  const label: Record<typeof kind, string> = {
    diagram: "Mermaid diagram — rendered by a later task",
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
