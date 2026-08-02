// JSX/TSX component preview — the LAZY half (increment C).
//
// WHY A SEPARATE MODULE: everything here is heavy. The TypeScript compiler
// (~6MB unminified) and React's two UMD builds (~140KB) are needed ONLY when a
// `.jsx`/`.tsx` artifact is actually opened, so nothing in the app imports this
// file statically — ComponentPreview.tsx reaches it through a single
// module-level `import()`, exactly the shape DiagramView uses for mermaid, and
// rollup gives it its own chunk. `pnpm build` is the check that keeps that
// true: `typescript-*.js` and `react*.production.min-*.js` must appear as
// their own chunks, never inside `main`.
//
// WHY THE UMD BUILDS AND NOT THE APP'S OWN REACT: the compiled component runs
// inside WireframeView's SANDBOXED iframe (`allow-scripts`, no
// `allow-same-origin`) because repo/KB content is untrusted by policy — the
// same policy that makes DocView drop raw HTML and mermaid run "strict". An
// iframe is a separate JS realm, so the parent's bundled React is unreachable
// from it by construction; the preview document has to carry its own copy as
// TEXT. The UMD files are imported with `?raw` through their real paths under
// node_modules because React 18's package `exports` map does not expose
// `./umd/*` (a bare `react/umd/…?raw` specifier fails to resolve).
//
// WHY THE FULL TYPESCRIPT COMPILER: it is already in the repo (devDependency,
// promoted to a dependency for this), so the preview costs no new package —
// and `ts.transpileModule` is a single syntax-only pass with no type checking,
// no file system and no program construction, which is exactly the job. It
// also means `.tsx` and `.jsx` go through ONE code path.
//
// SAFETY POSTURE — unchanged from WireframeView's, deliberately:
//   · the component is COMPILED here (a pure string→string transform) and
//     EXECUTED only inside the sandboxed iframe. Nothing from disk is ever
//     evaluated in the privileged webview.
//   · the harness resolves `require("react")`/`require("react-dom")` to the
//     inlined UMD globals and every other specifier to an inert stub, so a
//     mockup importing a design-system package renders instead of exploding.
//     It cannot fetch a real one: `connect-src 'none'` in the frame CSP below
//     blocks every scripted request. (An earlier version of this comment said
//     "there is no network inside the frame" — that was FALSE. `allow-scripts`
//     without `allow-same-origin` is an opaque ORIGIN, not a network block;
//     the CSP is what makes the sentence true, and only for scripted requests
//     — see lib/sandbox.ts for what remains reachable and why.)
//   · every failure mode — transpile diagnostics, a throwing module body, a
//     component that throws during render, a missing export — ends as a DIM
//     MESSAGE inside the frame. Never a blank panel, never a thrown error in
//     the app.

import ts from "typescript";
import { cspMeta } from "./sandbox";
// Real paths, not package specifiers — see the module header.
import reactUmd from "../../node_modules/react/umd/react.production.min.js?raw";
import reactDomUmd from "../../node_modules/react-dom/umd/react-dom.production.min.js?raw";

/** Result of the syntax-only transpile. `code` is null when the source could
 *  not be compiled at all; `error` carries the first diagnostic either way. */
export interface CompileResult {
  code: string | null;
  error: string | null;
}

/**
 * Transpile one JSX/TSX source to CommonJS + `React.createElement` calls.
 * Syntax-only (no type checking, no module resolution): types are ERASED, so
 * a `.tsx` importing types it cannot resolve still compiles.
 */
export function compileComponentSource(source: string, fileName: string): CompileResult {
  try {
    const out = ts.transpileModule(source, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        target: ts.ScriptTarget.ES2019,
        // CommonJS so imports become `require(…)` calls the harness can
        // intercept — an ES module body cannot run inside `new Function`.
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        allowJs: true,
        removeComments: false,
      },
    });
    const first = out.diagnostics?.[0];
    const error = first
      ? ts.flattenDiagnosticMessageText(first.messageText, " ")
      : null;
    return { code: out.outputText, error };
  } catch (e) {
    return { code: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Document assembly ────────────────────────────────────────────────────────

/** Inline a script BODY safely: only `</script` can end the block early, and
 *  in real JS it can only occur inside a string/regex literal, where `<\/` is
 *  an equivalent escape. */
function inlineScript(body: string): string {
  return body.replace(/<\/script/gi, "<\\/script");
}

/** A JS string literal that is safe inside `<script>`: JSON quoting plus `<`
 *  escaped, so no `</script` sequence can survive in the source text. */
function jsStringLiteral(text: string): string {
  return JSON.stringify(text).replace(/</g, "\\u003c");
}

/** Kit-matching chrome for the preview document. Token VALUES are literal
 *  here (styles/global.css does not reach into an opaque-origin iframe). */
const PREVIEW_CSS = `
  html, body { margin: 0; padding: 0; }
  body { background: #FFFFFF; }
  .sb-preview-note {
    box-sizing: border-box;
    min-height: 100vh;
    margin: 0;
    padding: 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: #0C0C0E;
    color: #52525B;
    font-family: 'JetBrains Mono', 'Cascadia Code', 'SF Mono', monospace;
    font-size: 11px;
    line-height: 1.7;
    text-align: center;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .sb-preview-note b { color: #71717A; font-weight: 600; }
`;

function documentShell(bodyHtml: string, scripts: string): string {
  // The CSP goes FIRST in the head — before the styles, and long before the
  // harness scripts it governs. Same policy the wireframe surface plants
  // (lib/sandbox.ts); this shell is built here rather than passed through
  // injectCsp because we own every byte of it.
  return `<!doctype html>
<html>
<head>${cspMeta()}<meta charset="utf-8"><style>${PREVIEW_CSS}</style></head>
<body>${bodyHtml}${scripts}</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The dim in-frame failure state. Used for compile failures here and, by the
 *  harness, for runtime ones — one look for both. */
export function previewErrorDocument(title: string, detail: string): string {
  return documentShell(
    `<div class="sb-preview-note"><b>${escapeHtml(title)}</b><span>${escapeHtml(detail)}</span></div>`,
    ""
  );
}

/** The in-frame runtime harness. Plain ES5-ish JS: it renders the compiled
 *  module's component into `#root`, and turns every failure into the same dim
 *  note the compile path produces. */
const HARNESS = `
(function () {
  var root = document.getElementById("sb-preview-root");
  function note(title, detail) {
    document.body.innerHTML = "";
    var box = document.createElement("div");
    box.className = "sb-preview-note";
    var b = document.createElement("b");
    b.textContent = title;
    var s = document.createElement("span");
    s.textContent = detail || "";
    box.appendChild(b);
    box.appendChild(s);
    document.body.appendChild(box);
  }
  function message(e) {
    return (e && (e.message || e.toString())) || "unknown error";
  }

  // Unresolvable imports become inert stubs — a mockup importing its design
  // system should still render its own markup, not blank the panel. There is
  // no network in an opaque-origin sandbox to fetch a real module from.
  function stub() {
    var fn = function () { return null; };
    return new Proxy(fn, {
      get: function (t, k) {
        if (k === "__esModule") return true;
        if (k === "default") return fn;
        return stub();
      },
      apply: function () { return null; }
    });
  }
  function require(name) {
    if (name === "react") return React;
    if (name === "react-dom" || name === "react-dom/client") return ReactDOM;
    return stub();
  }

  // Pick the component to render: default export first (the convention for a
  // one-component mockup file), then the first capitalized function export.
  function pick(exports) {
    if (!exports) return null;
    if (typeof exports === "function") return exports;
    if (typeof exports.default === "function") return exports.default;
    var keys = Object.keys(exports);
    for (var i = 0; i < keys.length; i++) {
      var v = exports[keys[i]];
      if (typeof v === "function" && /^[A-Z]/.test(keys[i])) return v;
    }
    return null;
  }

  var Component;
  try {
    var module = { exports: {} };
    new Function("require", "module", "exports", "React", "ReactDOM", __SB_SOURCE__)(
      require, module, module.exports, React, ReactDOM
    );
    Component = pick(module.exports);
  } catch (e) {
    note("preview failed to load", message(e));
    return;
  }
  if (!Component) {
    note("no component to preview", "export a component as \`default\` (or a capitalized named export)");
    return;
  }

  // Render errors do not propagate out of React's root, so the boundary — not
  // a try/catch — is what keeps a throwing component from blanking the frame.
  // The fallback is rendered AS REACT ELEMENTS rather than by rewriting
  // document.body: tearing the root container out from under React mid-commit
  // is its own crash.
  function Boundary(props) { React.Component.call(this, props); this.state = { error: null }; }
  Boundary.prototype = Object.create(React.Component.prototype);
  Boundary.prototype.constructor = Boundary;
  Boundary.getDerivedStateFromError = function (error) { return { error: error }; };
  Boundary.prototype.render = function () {
    if (!this.state.error) return React.createElement(Component, null);
    return React.createElement(
      "div",
      { className: "sb-preview-note" },
      React.createElement("b", null, "component threw while rendering"),
      React.createElement("span", null, message(this.state.error))
    );
  };

  try {
    var element = React.createElement(Boundary, null);
    if (ReactDOM.createRoot) ReactDOM.createRoot(root).render(element);
    else ReactDOM.render(element, root);
  } catch (e) {
    note("preview failed to render", message(e));
  }
})();
`;

/**
 * Compile one JSX/TSX source into a complete, self-contained preview document
 * for WireframeView's sandboxed iframe. NEVER throws and never returns an
 * empty document: a compile failure returns the dim note instead.
 */
export function buildPreviewDocument(source: string, fileName: string): string {
  const { code, error } = compileComponentSource(source, fileName);
  if (code === null) {
    return previewErrorDocument("could not compile", error ?? "unknown compile error");
  }
  // Diagnostics from a syntax-only pass mean the emit is not trustworthy —
  // show the message rather than render half a component.
  if (error !== null) {
    return previewErrorDocument(`${fileName}: could not compile`, error);
  }
  // Function replacement, not a string one: `$&`/`$'` in the compiled source
  // would otherwise be re-expanded by String.replace.
  const literal = jsStringLiteral(code);
  const harness = HARNESS.replace("__SB_SOURCE__", () => literal);
  return documentShell(
    `<div id="sb-preview-root"></div>`,
    [
      `<script>${inlineScript(reactUmd)}</script>`,
      `<script>${inlineScript(reactDomUmd)}</script>`,
      `<script>${harness}</script>`,
    ].join("\n")
  );
}
