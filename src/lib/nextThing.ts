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
// `surface:<project>/<page>[?k=v]`, a KB doc path that EXISTS, a repo-relative
// file path resolved against the thread's own project. A `decision:` row and
// a ticket key open nothing here — they navigate away or have no surface.

import type { Artifact } from "../types";
import type { PageItem, RenderedPage } from "./pageStore";
import { artifactIdentity } from "./panelStore";
import { resolveDocTarget, viewAnchorOfAddress } from "./evidenceModel";
import { parseSurfaceAddress } from "./surfaceParams";

export type NextThingContext = {
  threadId: string;
  /** The real KB doc list (a KB row must exist to link), null = unknown. */
  kbDocs: readonly string[] | null;
  /** The thread's own project key (a repo path resolves against it). */
  projectKey: string | null;
};

export type NextThing =
  | {
      why: "review";
      /** The turn's reviewFirst, verbatim — the page prints it as `start here →`. */
      address: string;
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
    const view = viewAnchorOfAddress(token);
    if (view) {
      return {
        artifact: { kind: "view", threadId: ctx.threadId, viewId: view.viewId },
        anchor: view.anchor,
        address: token,
      };
    }
    const surface = parseSurfaceAddress(token);
    if (surface) return { artifact: surface, anchor: null, address: token };
    const doc = resolveDocTarget(token, ctx.kbDocs, ctx.projectKey);
    if (doc) return { artifact: doc, anchor: null, address: token };
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

/** Nothing to offer any more — forget the thread's last key, so the same
 *  thing coming BACK later (a question re-asked) is offered again. */
export function clearNextThingOffer(threadId: string): void {
  offered.delete(threadId);
}

/** Tests: forget every offer. */
export function __resetNextThingOffers(): void {
  offered.clear();
}
