// The sandbox CSP: what it permits, what it must block, and — the part that is
// easy to get silently wrong — WHERE it lands in a real document.

import { describe, it, expect } from "vitest";
import { FRAME_CSP, cspMeta, injectCsp } from "./sandbox";

/** The head of lodestar's `specs/mockups/cases-compact-v1.html`, verbatim from
 *  the file (lines 1, 24-30). It is the reason the policy is not
 *  `default-src 'none'`: a real mockup Eric reviews loads IBM Plex from Google
 *  Fonts, and it opens with a long comment block BEFORE `<head>`. */
const REAL_MOCKUP = `<!DOCTYPE html>
<!--
  LODESTAR — Cases compact view · TWO directions in one file.
  A comment block that mentions <head> and <html> on purpose.
-->
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lodestar — cases</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Serif&display=swap" rel="stylesheet">
<style>body { font-family: "IBM Plex Sans"; }</style>
</head>
<body><header>cases</header></body>
</html>`;

describe("FRAME_CSP", () => {
  it("blocks the scripted exfil channels", () => {
    // connect-src covers fetch / XHR / WebSocket / EventSource / sendBeacon —
    // the only ways a script can CONSTRUCT and send a request.
    expect(FRAME_CSP).toContain("connect-src 'none'");
    expect(FRAME_CSP).toContain("form-action 'none'");
    expect(FRAME_CSP).toContain("base-uri 'none'");
    expect(FRAME_CSP).toContain("default-src 'none'");
  });

  it("allows inline script but no remote script", () => {
    // The instrument and the preview harness are inline; nothing may LOAD.
    const script = FRAME_CSP.split("; ").find((d) => d.startsWith("script-src "))!;
    expect(script).toBe("script-src 'unsafe-inline'");
    expect(script).not.toContain("https:");
  });

  it("keeps webfonts working — the reason it is not default-src 'none'", () => {
    expect(FRAME_CSP).toContain("style-src 'unsafe-inline' https:");
    expect(FRAME_CSP).toContain("font-src https: data:");
    expect(FRAME_CSP).toContain("img-src data: https:");
  });
});

describe("injectCsp", () => {
  it("lands inside <head>, BEFORE the first stylesheet it has to govern", () => {
    const out = injectCsp(REAL_MOCKUP);
    const meta = out.indexOf("http-equiv=\"Content-Security-Policy\"");
    expect(meta).toBeGreaterThan(-1);
    expect(meta).toBeGreaterThan(out.indexOf("<head>"));
    // A policy that arrives after the link is a policy that arrives too late.
    expect(meta).toBeLessThan(out.indexOf("fonts.googleapis.com"));
  });

  it("never lands before the doctype (that would be quirks mode)", () => {
    const out = injectCsp(REAL_MOCKUP);
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("ignores a <head> that only appears inside a comment", () => {
    // The failure this guards: planting the meta inside a comment block is a
    // silent no-op that looks exactly like success.
    const out = injectCsp(REAL_MOCKUP);
    const commentEnd = out.indexOf("-->");
    expect(out.indexOf("Content-Security-Policy")).toBeGreaterThan(commentEnd);
  });

  it("preserves the rest of the document byte-for-byte", () => {
    const out = injectCsp(REAL_MOCKUP);
    expect(out.replace(cspMeta(), "")).toBe(REAL_MOCKUP);
  });

  it("falls back to <html>, then the doctype, then the front", () => {
    expect(injectCsp('<!doctype html><html lang="en"><body>x</body></html>')).toBe(
      `<!doctype html><html lang="en">${cspMeta()}<body>x</body></html>`
    );
    expect(injectCsp("<!doctype html><body>x</body>")).toBe(
      `<!doctype html>${cspMeta()}<body>x</body>`
    );
    // A bare fragment (a mockup that is just markup) still gets the policy.
    expect(injectCsp("<div>x</div>")).toBe(`${cspMeta()}<div>x</div>`);
  });

  it("handles an attributed or upper-case head", () => {
    expect(injectCsp("<HTML><HEAD lang=en><title>t</title></HEAD>")).toContain(
      `<HEAD lang=en>${cspMeta()}<title>`
    );
  });

  it("adds to an author's own policy rather than replacing it", () => {
    // Browsers enforce every policy present, so ours can only tighten.
    const authored = `<html><head><meta http-equiv="Content-Security-Policy" content="img-src 'none'"></head>`;
    const out = injectCsp(authored);
    expect(out).toContain("img-src 'none'");
    expect(out).toContain(FRAME_CSP);
    expect(out.indexOf(FRAME_CSP)).toBeLessThan(out.indexOf("img-src 'none'"));
  });
});
