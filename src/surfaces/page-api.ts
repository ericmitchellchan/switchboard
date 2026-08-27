// THE PAGE-FACING API (platform evolution, Inc 5a — SWIT-39): the ONE module
// a project page may import from the shell.
//
// A surface is a chunk, not a dependency (CLAUDE.md §Project surfaces): the
// shell reaches a page only through the registry's `import()`, and a page
// reaches the shell only through THIS file. Everything here is a React
// context + a hook, provided by SurfaceHost; a page rendered anywhere else (a
// test, a future standalone build) sees the null/default and keeps working.
//
//   useSurfaceActive()        — "is this surface on screen?" Pages gate their
//                                polling on it (a hidden tab's page must not
//                                fetch at 2s beside a live terminal).
//   useSurfaceNav()           — open another page of the SAME project (the
//                                react-router `useNavigate` replacement): the
//                                shell decides panel vs full width.
//   useSurfaceAnchorRegistry  — publish a programmatic anchor provider
//                                (canvas charts); see anchors.ts.
//   useSurfaceKeydown()       — page shortcuts, scoped to the page (the host
//                                root is focusable); replaces window listeners.
//   useSurfaceAgent()         — type a line into the thread beside the page;
//                                replaces an in-page agent bridge.

import { createContext, useContext, useEffect, useRef } from "react";

export { SurfaceAnchorContext, useSurfaceAnchorRegistry } from "./anchors";
export type { SurfaceAnchor, SurfaceAnchorProvider, SurfaceAnchorRegistry } from "./anchors";

// Shared UI a page may render with: THE markdown path (one pipeline, one
// link policy — CLAUDE.md) is re-exported here; the chart components are
// imported from `surfaces/charts/*` directly (they themselves depend on this
// module for the anchor registry, so re-exporting them here would be a
// cycle). Both are the sanctioned page-side imports; nothing else in
// `src/` is.
export { MarkdownDoc } from "../components/kb/MarkdownDoc";

// ── Active ───────────────────────────────────────────────────────────────────

/** Default TRUE: a page outside a host (tests, storybook-style previews) is
 *  as good as visible. The host sets it from the panel's / screen's `active`. */
export const SurfaceActiveContext = createContext<boolean>(true);

export function useSurfaceActive(): boolean {
  return useContext(SurfaceActiveContext);
}

// ── Navigation ───────────────────────────────────────────────────────────────

export type SurfaceNav = {
  /** Open a page of this project. Where it opens (this panel's strip, or full
   *  width) is the shell's decision — the same rule a tree click follows. A
   *  page id the registry does not know renders the host's "no such page"
   *  note rather than throwing. */
  openPage: (page: string) => void;
  /** Open a page of this project in ITS OWN always-on-top window (Inc 5d —
   *  the trading HUD). Re-opening focuses the existing window. */
  openWindow: (page: string) => void;
  /** Close the thing hosting this page: its own window when it has one; a
   *  no-op in the panel (the panel's own × does that). The HUD's × uses it. */
  closeHost: () => void;
  /** A system notification (the shell's plugin — the web `Notification`
   *  API is not reliably available inside the webview). */
  notify: (title: string, body: string) => void;
};

const NOOP_NAV: SurfaceNav = {
  openPage: () => {},
  openWindow: () => {},
  closeHost: () => {},
  notify: () => {},
};

export const SurfaceNavContext = createContext<SurfaceNav>(NOOP_NAV);

export function useSurfaceNav(): SurfaceNav {
  return useContext(SurfaceNavContext);
}

// ── Keyboard ─────────────────────────────────────────────────────────────────
// A page that listened on `window` in its home app (Escape to close a
// drill-in, ← → to step, a/d/u to judge) now sits beside a live terminal, and
// a window listener would fire from keys typed into the shell. The host's
// content root is FOCUSABLE and takes focus when the page is clicked (unless
// an input already has it), so a keydown reaches the root only from inside
// the page — this hook listens there and nowhere else.

export const SurfaceRootContext = createContext<HTMLElement | null>(null);

/** Keys typed into a text field are the field's, never a page shortcut. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function useSurfaceKeydown(handler: (e: KeyboardEvent) => void): void {
  const root = useContext(SurfaceRootContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      handlerRef.current(e);
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [root]);
}

// ── The agent ────────────────────────────────────────────────────────────────
// In Lodestar's Electron shell a page could spawn `claude -p` and stream the
// reply into itself (`window.lodestar.askAgent`). Here THE AGENT IS THE THREAD
// BESIDE THE PAGE — a live claude in a terminal — and a page talks to it the
// one way everything else does: it TYPES a line into that terminal and the
// user presses Enter (the send-to-thread seam, CLAUDE.md). No streamed reply
// comes back to the page; the conversation happens where the user can see it.

export type SurfaceAgent = {
  /** A thread is there to type into. */
  available: boolean;
  /** Type `text` (ONE line — sanitized by the shell like a pin reference:
   *  newlines flattened, shell metacharacters and quotes dropped, backslash
   *  paths turned into forward slashes, capped) into the thread beside this
   *  surface. `sent` is false when no thread is available; `truncated` says
   *  the cap bit, so a page can tell the user rather than let a paragraph
   *  lose its tail silently. */
  send: (text: string) => { sent: boolean; truncated: boolean };
};

const NOOP_AGENT: SurfaceAgent = { available: false, send: () => ({ sent: false, truncated: false }) };

export const SurfaceAgentContext = createContext<SurfaceAgent>(NOOP_AGENT);

export function useSurfaceAgent(): SurfaceAgent {
  return useContext(SurfaceAgentContext);
}
