// WHERE TO START AFTER A TURN (SWIT-79, Ky's nextThing CC-710).
//
// After a turn the panel used to open one preview per view the agent showed
// and nothing else said which of them came first. Now the page names ONE next
// thing, and the turn end opens at most that one tab:
//   0. the agent's own pointer — the newest turn's `reviewFirst` — wins when
//      it named one: `start here → <address>`, opened BEHIND the page when
//      the address is openable (a ticket key or a `decision:` row is printed
//      and opens nothing);
//   1. else open questions → the ✦ page's Open questions block, in front
//      (the agent is waiting on you — no new tab, the page scrolls to it);
//   2. else the first To do row (waiting-on-you first — the page's own order)
//      whose title carries an OPENABLE address — the spec, the view, the page
//      the plan is working on — opened BEHIND the page, not focused;
//   3. else nothing: the page itself is the place to be.
// Pure over the rendered page; the turn-end hook (App) and the page's own
// `start here →` / `next →` line both read it, so they cannot disagree about
// WHAT is next — the hook only differs in what it can DO (open behind vs. a
// click's focused open; it stands down for a preview being read).
//
// OFFERED ONCE PER KEY: the same set of open questions on a repaint does not
// raise the page again; a NEW question does (the key is the sorted open ids).
// A To do / reviewFirst open is keyed by the artifact's identity. The map is
// runtime-only (like threadStore's `prepared`) — a restart offers afresh,
// which is right; a deleted thread's entry is pruned.
//
// Addresses are the Evidence vocabulary (evidenceModel): `view:<id>[#anchor]`,
// `surface:<project>/<page>[?k=v]`, a KB doc path that EXISTS, a file path
// relative to the thread's working directory, re-based onto the thread's own
// project (`pathPrefix` — the SAME re-base the agent's `show` uses, so an
// address opens the same file from every surface). A `decision:` row and
// a ticket key open nothing here — they navigate away or have no surface.

import type { Artifact } from "../types";
import type { PageItem, RenderedPage } from "./pageStore";
import { artifactIdentity, type OpenableArtifact } from "./panelStore";
import { resolveDocTarget, viewAnchorOfAddress } from "./evidenceModel";
import { parseSurfaceAddress } from "./surfaceParams";

export type NextThingContext = {
  threadId: string;
  /** The real KB doc list (a KB row must exist to link), null = unknown. */
  kbDocs: readonly string[] | null;
  /** The thread's own project key (a repo path resolves against it). */
  projectKey: string | null;
  /** SWIT-101: told when a doc/file address is NOT in a known KB list, before
   *  the repo fallback (evidenceModel.resolveDocTarget) — the caller's way to
   *  refresh a stale list. Optional; absent = the pre-SWIT-101 behaviour. */
  onKbMiss?: (address: string) => void;
  /** What turns a path relative to the THREAD'S WORKING DIRECTORY into the
   *  project-relative path a repo-file artifact carries
   *  (`explorer.projectPlaceForDir`'s prefix): `""` at a single-repo
   *  project's root, `apps/desktop/` in a subdirectory, `<repo>/` in a
   *  multi-repo project. Absent = `""`. Never applied to a KB doc. */
  pathPrefix?: string;
};

/** The half of the resolver that yields an artifact the page's link rows can
 *  open directly — a page state, a KB doc, a repo file (re-based by
 *  `pathPrefix`). `resolveAddress` adds `view:` on top. The page's Evidence
 *  rows and `start here` link come here, so they resolve an address exactly
 *  as the turn-end hook and the agent's `show` do (review of 49ebb20, #7). */
export function resolveOpenable(address: string, ctx: NextThingContext): OpenableArtifact | null {
  return (
    parseSurfaceAddress(address) ??
    resolveDocTarget(address, ctx.kbDocs, ctx.projectKey, ctx.onKbMiss, ctx.pathPrefix ?? "")
  );
}

/** THE address resolver (SWIT-102 lifted it out of `openableAddressIn`): ONE
 *  whole address → the artifact it opens, or null. `view:<id>[#anchor]`,
 *  `surface:<project>/<page>[?k=v]`, a KB doc in the real list, a repo path
 *  against the thread's project (re-based from the thread's working
 *  directory) — the Evidence vocabulary. Text tokens (`openableAddressIn`),
 *  the page's link rows (`resolveOpenable`) and the agent's `show`
 *  (showIntent) all come here. */
export function resolveAddress(
  address: string,
  ctx: NextThingContext
): { artifact: Artifact; anchor: string | null } | null {
  const view = viewAnchorOfAddress(address);
  if (view) return { artifact: { kind: "view", threadId: ctx.threadId, viewId: view.viewId }, anchor: view.anchor };
  const hit = resolveOpenable(address, ctx);
  return hit ? { artifact: hit, anchor: null } : null;
}

export type NextThing =
  | {
      why: "review";
      /** The turn's reviewFirst, verbatim — the page prints it as `start here →`. */
      address: string;
      /** The token INSIDE reviewFirst that resolved (wrapping punctuation
       *  stripped) — what a click re-resolves; null when nothing resolved. */
      token: string | null;
      /** Null when the address names nothing openable (a ticket, a decision). */
      artifact: Artifact | null;
      anchor: string | null;
      label: string;
      offerKey: string;
    }
  | { why: "questions"; count: number; label: string; offerKey: string }
  | {
      why: "todo";
      artifact: Artifact;
      /** A report heading (`view:<id>#h:<slug>`), carried to the open. */
      anchor: string | null;
      address: string;
      label: string;
      offerKey: string;
    };

/** One openable address found in free text, or null. Tokens are whitespace
 *  runs with wrapping punctuation stripped; the FIRST that resolves wins. */
export function openableAddressIn(
  text: string,
  ctx: NextThingContext
): { artifact: Artifact; anchor: string | null; address: string } | null {
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^[(\[<"'`]+/, "").replace(/[)\]>"'`,.;:!?]+$/, "");
    if (token.length === 0) continue;
    const hit = resolveAddress(token, ctx);
    if (hit) return { ...hit, address: token };
  }
  return null;
}

/** Ky's label: `<address> · <title>` — or the title alone when it already
 *  says the address. */
function todoLabel(item: PageItem, address: string): string {
  return item.title.includes(address) ? item.title : `${address} · ${item.title}`;
}

export function questionsOfferKey(openIds: readonly string[]): string {
  return `questions:${[...openIds].sort().join(",")}`;
}

export function nextThingFor(page: RenderedPage | null | undefined, ctx: NextThingContext): NextThing | null {
  if (!page) return null;
  const reviewFirst = page.latestTurn?.reviewFirst ?? null;
  if (reviewFirst !== null && reviewFirst.length > 0) {
    const hit = openableAddressIn(reviewFirst, ctx);
    return {
      why: "review",
      address: reviewFirst,
      token: hit?.address ?? null,
      artifact: hit?.artifact ?? null,
      anchor: hit?.anchor ?? null,
      label: reviewFirst,
      offerKey: hit ? `review:${artifactIdentity(hit.artifact)}` : `review:${reviewFirst}`,
    };
  }
  const open = page.openQuestions.length;
  if (open > 0) {
    return {
      why: "questions",
      count: open,
      label: open === 1 ? "answer 1 question" : `answer ${open} questions`,
      offerKey: questionsOfferKey(page.openQuestions.map((q) => q.id)),
    };
  }
  // The To do list in the order the page shows it: waiting on you first,
  // then the live rows (mergePage's `openItems` is already that order).
  for (const item of page.openItems) {
    const hit = openableAddressIn(`${item.title} ${item.note ?? ""}`, ctx);
    if (!hit) continue;
    return {
      why: "todo",
      artifact: hit.artifact,
      anchor: hit.anchor,
      address: hit.address,
      label: todoLabel(item, hit.address),
      offerKey: artifactIdentity(hit.artifact),
    };
  }
  return null;
}

/** The page's one line under the summary: `next → answer 2 questions`. */
export function nextThingLine(next: NextThing | null): string | null {
  return next ? next.label : null;
}

// ── Offered once per key (runtime) ───────────────────────────────────────────

const offered = new Map<string, string>();

/** Should this next thing be offered NOW? True — and recorded — when its key
 *  differs from the thread's last offer; false on the same key again. */
export function offerNextThing(threadId: string, offerKey: string): boolean {
  if (offered.get(threadId) === offerKey) return false;
  offered.set(threadId, offerKey);
  return true;
}

/** Has this key already been offered for the thread? A PEEK — records
 *  nothing. The turn-end hook asks it before paying for a fresh KB list, so a
 *  settle that would stand down anyway costs no IPC (review of 49ebb20, #5). */
export function isNextThingOffered(threadId: string, offerKey: string): boolean {
  return offered.get(threadId) === offerKey;
}

/** Nothing to offer any more — forget the thread's last key, so the same
 *  thing coming BACK later (a question re-asked) is offered again. */
export function clearNextThingOffer(threadId: string): void {
  offered.delete(threadId);
}

/** Tests: forget every offer. */
export function __resetNextThingOffers(): void {
  offered.clear();
}

// ── The turn-end decision (review of 49ebb20, #5) ────────────────────────────
// App's settleTurn used to resolve against a FRESH KB list first — one
// `kb_list` on nearly every settle, since any dotted token in a turn line was
// a KB miss — and only then run the checks that make most settles a no-op.
// The order is now: resolve against the CACHED list (no IPC) → nothing / the
// questions branch / a stand-down (nothing openable, the preview is being
// read, the agent's own show wins the slot, already offered) → and only for
// an open that survived all of that AND fell back to a repo file after a
// real miss, ONE refresh and a re-derive. Pure over injected effects; App
// applies the decision (offer-once recording, focus, the open).

export type TurnSettleDeps = {
  /** The resolver context minus the list (threadId, projectKey, pathPrefix). */
  ctx: Omit<NextThingContext, "kbDocs" | "onKbMiss">;
  /** The CACHED KB list (the caller loads a cold cache once). */
  kbDocs: readonly string[] | null;
  /** One `kb_list`; resolves the SAME reference when nothing changed. */
  refreshKbDocs: () => Promise<readonly string[] | null>;
  /** Is the strip's active tab its preview (a replace would land in front)? */
  previewActive: () => boolean;
  /** Did the agent's own view/set/show open something moments ago? */
  intentRecent: () => boolean;
};

export type TurnSettleDecision =
  | { act: "none" }
  | { act: "questions"; next: Extract<NextThing, { why: "questions" }> }
  | { act: "stand-down"; reason: "not-openable" | "preview" | "intent" | "offered"; next: NextThing }
  | { act: "open"; next: Exclude<NextThing, { why: "questions" }> & { artifact: Artifact } };

export async function decideTurnSettle(
  page: RenderedPage | null | undefined,
  deps: TurnSettleDeps
): Promise<TurnSettleDecision> {
  let missed = false;
  const first = nextThingFor(page, { ...deps.ctx, kbDocs: deps.kbDocs, onKbMiss: () => (missed = true) });
  if (!first) return { act: "none" };
  if (first.why === "questions") return { act: "questions", next: first };
  if (first.artifact === null) return { act: "stand-down", reason: "not-openable", next: first };
  if (deps.previewActive()) return { act: "stand-down", reason: "preview", next: first };
  if (deps.intentRecent()) return { act: "stand-down", reason: "intent", next: first };
  if (isNextThingOffered(deps.ctx.threadId, first.offerKey)) return { act: "stand-down", reason: "offered", next: first };
  let next: NextThing = first;
  if (missed && first.artifact.kind === "repo-file") {
    const fresh = await deps.refreshKbDocs().catch(() => null);
    if (fresh !== null && fresh !== deps.kbDocs) {
      const again = nextThingFor(page, { ...deps.ctx, kbDocs: fresh });
      if (!again) return { act: "none" };
      next = again;
    }
  }
  if (next.why === "questions") return { act: "questions", next };
  if (next.artifact === null) return { act: "stand-down", reason: "not-openable", next };
  if (next !== first && isNextThingOffered(deps.ctx.threadId, next.offerKey)) {
    return { act: "stand-down", reason: "offered", next };
  }
  return { act: "open", next: next as Exclude<NextThing, { why: "questions" }> & { artifact: Artifact } };
}
