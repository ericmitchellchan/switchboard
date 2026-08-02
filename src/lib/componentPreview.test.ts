// Component preview tests (increment C) — the compile + document-assembly
// half of `.jsx`/`.tsx` rendering. The iframe harness itself is exercised by
// the app (it needs a DOM realm and React's UMD globals); what is testable
// here, and what the failure modes turn on, is: does the source compile, does
// a broken one degrade to the DIM NOTE instead of an exception or an empty
// document, and does the assembled document stay a single well-formed script
// payload (no `</script>` escape, no `$&` re-expansion from String.replace).
//
// NOTE: importing this module pulls in the real TypeScript compiler and both
// React UMD builds — the same ~3.7MB lazy chunk the app loads on demand. That
// is deliberate: the point of the test is that THAT module works.

import { describe, it, expect } from "vitest";
import {
  buildPreviewDocument,
  compileComponentSource,
  previewErrorDocument,
} from "./componentPreview";

const TSX = `
type Props = { label: string };
function Row({ label }: Props) {
  return <div className="row">{label}</div>;
}
export default function Card() {
  return <section><Row label="hi" /></section>;
}
`;

describe("compileComponentSource", () => {
  it("erases types and emits React.createElement calls for .tsx", () => {
    const { code, error } = compileComponentSource(TSX, "Card.tsx");
    expect(error).toBeNull();
    expect(code).toContain("React.createElement");
    expect(code).not.toContain("type Props");
    // CommonJS emit — the harness intercepts `require` and reads
    // `module.exports`.
    expect(code).toContain("exports");
  });

  it("compiles .jsx the same way", () => {
    const { code, error } = compileComponentSource(
      `export default function A(){ return <b>x</b>; }`,
      "A.jsx"
    );
    expect(error).toBeNull();
    expect(code).toContain("React.createElement");
  });

  it("reports a syntax error instead of throwing", () => {
    const { error } = compileComponentSource(`export default function A(){ return <b>x</`, "A.tsx");
    expect(error).not.toBeNull();
  });

  it("does NOT type-check — unresolved imports still compile", () => {
    const { error } = compileComponentSource(
      `import { Button } from "@acme/design";\nexport default () => <Button />;`,
      "A.tsx"
    );
    expect(error).toBeNull();
  });
});

describe("buildPreviewDocument", () => {
  it("produces a self-contained document carrying React and the component", () => {
    const doc = buildPreviewDocument(TSX, "Card.tsx");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("sb-preview-root");
    // React's UMD builds are INLINED. Not because the frame has no network —
    // an opaque origin is fully networked — but because nothing may be fetched
    // at runtime, which the frame CSP now actually enforces (see below).
    expect(doc).toContain("react.production.min.js");
    expect(doc).toContain("react-dom.production.min.js");
    expect(doc).toContain("React.createElement");
  });

  it("carries the frame CSP first in the head, before styles or scripts", () => {
    // The posture correction: `allow-scripts` alone blocks no network at all,
    // so the preview shell plants the same policy the wireframe surface does.
    const doc = buildPreviewDocument(TSX, "Card.tsx");
    const csp = doc.indexOf("Content-Security-Policy");
    expect(csp).toBeGreaterThan(doc.indexOf("<head>"));
    expect(csp).toBeLessThan(doc.indexOf("<style>"));
    expect(csp).toBeLessThan(doc.indexOf("<script>"));
    expect(doc).toContain("connect-src 'none'");
  });

  it("puts the CSP on the ERROR document too — a failure is still a frame", () => {
    expect(previewErrorDocument("nope", "detail")).toContain("connect-src 'none'");
  });

  it("emits three script blocks, the last of which PARSES as JS", () => {
    // The harness is assembled by string substitution; a broken substitution
    // would only show up as a silently blank frame in the app.
    const doc = buildPreviewDocument(TSX, "Card.tsx");
    const scripts = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(3);
    // Parsed, not run — React's UMD globals only exist inside the frame.
    expect(() => new Function(scripts[2])).not.toThrow();
  });

  it("degrades a broken component to the dim note, not an empty document", () => {
    const doc = buildPreviewDocument(`export default function A(){ return <b>x</`, "Broken.tsx");
    expect(doc).toContain("sb-preview-note");
    expect(doc).toContain("could not compile");
    // No harness, no root: nothing to render means nothing pretends to.
    expect(doc).not.toContain("sb-preview-root");
  });

  it("neutralizes a `</script>` inside the source so the payload cannot break out", () => {
    const doc = buildPreviewDocument(
      `export default function A(){ return <b>{"</script><img>"}</b>; }`,
      "A.tsx"
    );
    // The only `</script` sequences left are the three closers this module
    // emits (React, ReactDOM, harness) — the source's own is escaped.
    expect((doc.match(/<\/script/gi) ?? []).length).toBe(3);
    expect(doc).toContain("\\u003c/script>");
  });

  it("does not re-expand String.replace patterns from the source", () => {
    // `$&` in a naive `.replace(pattern, string)` would duplicate the match.
    const doc = buildPreviewDocument(`export default () => <b>{"$& $\` $'"}</b>;`, "A.tsx");
    expect(doc).toContain("new Function");
    // The placeholder was substituted exactly once, with no doubled match.
    expect(doc).not.toContain("__SB_SOURCE__");
    expect((doc.match(/\$& \$` \$'/g) ?? []).length).toBe(1);
  });
});

describe("previewErrorDocument", () => {
  it("escapes the message it renders", () => {
    const doc = previewErrorDocument("could not compile", "<img onerror=x>");
    expect(doc).toContain("&lt;img onerror=x&gt;");
    expect(doc).not.toContain("<img onerror=x>");
  });
});
