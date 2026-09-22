// THE markdown rendering path — one unified processor and one typography
// block for every surface (KB docs, third-party repo READMEs), reached
// through ArtifactBody's kind switch.
//
// Extracted from DocView (increment C) so the shared kind switch can reach
// markdown WITHOUT importing the KB screen: DocView → ArtifactBody →
// MarkdownDoc is a straight line, where DocView → ArtifactBody → DocView was
// an import cycle that happened to work only because every export is a
// hoisted function declaration.
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
//      through this same pipeline) can only ever become text/markdown-shaped
//      markup, and nothing in the pipeline reintroduces raw HTML.
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
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import { planHeading, planTableRow, stampAttributes } from "../../lib/docAnchors";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeStringify from "rehype-stringify";
import { log } from "../../lib/logger";

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

// Doc typography = Ky's KB reader (`ky-desktop/src/styles/global.css`
// `.doc-md`, 2026-09-09) in our tokens: a real heading hierarchy (H2 carries
// a hairline), dash bullets, amber inline code on the deepest ground, accent
// links, bordered tables with a raised header row; the body is the READING
// face (IBM Plex Sans, `--font-reading`), tables and code stay mono — Ky's
// split. Plain CSS in a scoped <style> block — the repo has
// no Tailwind and no CSS-modules pipeline, and element selectors (the
// markdown HTML is generated, not JSX) need real CSS.
const DOC_CSS = `
.kb-doc {
  max-width: 72ch;
  padding: 18px 24px 48px;
  font-family: var(--font-reading);
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-primary);
}
.kb-doc > :first-child { margin-top: 0; }
.kb-doc h1, .kb-doc h2, .kb-doc h3, .kb-doc h4, .kb-doc h5, .kb-doc h6 {
  color: var(--text-primary);
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.kb-doc h1 { font-size: 1.65em; margin: 0 0 0.6em; }
.kb-doc h2 {
  font-size: 1.32em;
  margin: 1.7em 0 0.55em;
  padding-bottom: 0.25em;
  border-bottom: 1px solid var(--border);
}
.kb-doc h3 { font-size: 1.12em; margin: 1.4em 0 0.45em; }
.kb-doc h4, .kb-doc h5, .kb-doc h6 { font-size: 1em; margin: 1.2em 0 0.4em; color: var(--text-secondary); }
.kb-doc h1:first-child { margin-top: 0; }
.kb-doc p { margin: 0 0 0.95em; }
.kb-doc ol { margin: 0 0 0.95em; padding-left: 1.4em; }
.kb-doc ol li::marker { color: var(--text-faint); }
.kb-doc ul { list-style: none; margin: 0 0 0.95em; padding-left: 1.3em; }
.kb-doc ul li { position: relative; }
.kb-doc ul li::before { content: "–"; position: absolute; left: -1.1em; color: var(--text-faint); }
.kb-doc ul li:has(> input[type="checkbox"])::before { content: none; }
.kb-doc li { margin-bottom: 0.35em; }
.kb-doc li > ul, .kb-doc li > ol { margin: 0.35em 0 0.2em; }
.kb-doc strong, .kb-doc b { color: var(--text-primary); font-weight: 700; }
.kb-doc a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
/* rehype-autolink-headings behavior:"wrap" wraps heading TEXT in an anchor —
   headings must keep heading color, not link green. */
.kb-doc h1 a, .kb-doc h2 a, .kb-doc h3 a,
.kb-doc h4 a, .kb-doc h5 a, .kb-doc h6 a { color: inherit; text-decoration: none; font-weight: inherit; }
.kb-doc code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  color: var(--tone-amber);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.08em 0.34em;
}
.kb-doc pre {
  font-family: var(--font-mono);
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 12px 14px;
  margin: 1em 0;
  overflow-x: auto;
  font-size: 0.9em;
  line-height: 1.55;
}
.kb-doc pre code { background: none; border: none; color: var(--text-primary); padding: 0; font-size: inherit; }
.kb-doc blockquote {
  border-left: 3px solid var(--border);
  margin: 1em 0;
  padding: 2px 0 2px 14px;
  color: var(--text-secondary);
}
.kb-doc table {
  border-collapse: collapse;
  margin: 1.2em 0;
  font-family: var(--font-mono);
  font-size: 0.88em;
  display: block;
  overflow-x: auto;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.kb-doc th, .kb-doc td { border: 1px solid var(--border); padding: 6px 12px; text-align: left; vertical-align: top; }
.kb-doc th { background: var(--bg-active); color: var(--text-primary); font-weight: 600; }
.kb-doc td { color: var(--text-secondary); }
.kb-doc tr:nth-child(even) td { background: rgba(255, 255, 255, 0.025); }
.kb-doc hr { border: none; border-top: 1px solid var(--border); margin: 1.6em 0; }
.kb-doc img { max-width: 100%; border-radius: 6px; }
`;

/** The markdown rendering path as a self-contained unit (pipeline + doc CSS).
 *  KB docs and repo `.md` files both land here through ArtifactBody — one
 *  processor, one typography block, everywhere. */
export function MarkdownDoc({ content }: { content: string }) {
  return (
    <>
      <MarkdownDocStyles />
      <MarkdownBody content={content} />
    </>
  );
}

/** The typography block alone (SWIT-73): a host that renders MANY markdown
 *  fragments (the report's narrative segments) mounts this ONCE and
 *  `MarkdownBody` per fragment — same pipeline, same CSS, no fork. */
export function MarkdownDocStyles() {
  return <style>{DOC_CSS}</style>;
}

/** One rendered markdown fragment — the pipeline + anchor stamps + link
 *  policy, without the style block. Exported for the report surface
 *  (SWIT-73) and the facts split (SWIT-79 — two fragments around a `<dl>`,
 *  `style` trimming the padding where they meet); everything else goes
 *  through MarkdownDoc. */
export function MarkdownBody({ content, style }: { content: string; style?: CSSProperties }) {
  const [html, setHtml] = useState("");
  const renderSeq = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  // DOC ANCHORS (Inc 3c — SWIT-37): after each paint, stamp `data-anchor`
  // on every heading (by its rehype-slug id) and every table body row (by
  // position), so a doc pin can name the THING it is on and the generic DOM
  // anchor provider can find it again after a re-render. Reads the DOM this
  // component just injected; the plan itself is pure (lib/docAnchors).
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    decorateDocAnchors(root);
  }, [html]);

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
      ref={bodyRef}
      className="kb-doc"
      style={style}
      onClick={handleLinkActivation}
      onAuxClick={handleLinkActivation}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Stamp anchors onto a rendered doc's headings and table rows. Idempotent —
 *  re-running over an already-stamped tree rewrites the same values. */
function decorateDocAnchors(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach((h) => {
    const stamp = planHeading(h.id || null, h.textContent ?? "");
    if (stamp) for (const [name, value] of stampAttributes(stamp)) h.setAttribute(name, value);
  });
  root.querySelectorAll<HTMLTableElement>("table").forEach((table, ti) => {
    table.querySelectorAll<HTMLTableRowElement>("tbody tr").forEach((row, ri) => {
      const first = row.querySelector("td, th");
      const stamp = planTableRow(ti + 1, ri + 1, first?.textContent ?? "");
      if (stamp) for (const [name, value] of stampAttributes(stamp)) row.setAttribute(name, value);
    });
  });
}
