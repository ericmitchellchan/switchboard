// THE NEXT THING (SWIT-79, Ky's nextThing CC-710): the pure rule over the
// rendered page, the once-per-key offer, and the page-focus one-shot.

import { describe, it, expect, beforeEach } from "vitest";
import {
  nextThingFor,
  openableAddressIn,
  questionsOfferKey,
  offerNextThing,
  clearNextThingOffer,
  __resetNextThingOffers,
  type NextThingContext,
} from "./nextThing";
import {
  mergePage,
  parsePageFile,
  requestPageFocus,
  takePageFocus,
  peekPageFocus,
  subscribePageFocus,
  pageFocusNonce,
  __resetPageFocusForTests,
  type PageItem,
  type PageQuestion,
} from "./pageStore";

const ctx: NextThingContext = { threadId: "th1", kbDocs: ["switchboard/spec.md"], projectKey: "switchboard" };

function question(id: string): PageQuestion {
  return { id, text: `q ${id}`, options: ["a", "b"], askedAt: "2026-09-08T10:00:00Z", kind: "decision", defaultOption: null, why: null, resolved: null };
}
function item(id: string, title: string, extra: Partial<PageItem> = {}): PageItem {
  return { id, title, owner: "agent", state: "todo", note: null, closedAt: null, ...extra };
}
function rendered(questions: PageQuestion[], items: PageItem[]) {
  return mergePage({ ...parsePageFile(""), questions, items }, {}, []);
}

beforeEach(() => {
  __resetNextThingOffers();
  __resetPageFocusForTests();
});

describe("openableAddressIn", () => {
  it("finds a view (with its heading), a surface, a KB doc and a repo file; nothing else", () => {
    expect(openableAddressIn("see view:v3#h:results first", ctx)).toEqual({
      artifact: { kind: "view", threadId: "th1", viewId: "v3" },
      anchor: "h:results",
      address: "view:v3#h:results",
    });
    expect(openableAddressIn("open (surface:lodestar/trading?instrument=NQ).", ctx)?.artifact).toEqual({
      kind: "surface",
      project: "lodestar",
      page: "trading",
      params: { instrument: "NQ" },
    });
    expect(openableAddressIn("read switchboard/spec.md, then", ctx)?.artifact).toEqual({ kind: "kb-doc", path: "switchboard/spec.md" });
    expect(openableAddressIn("fix src/lib/panelStore.ts", ctx)?.artifact).toEqual({ kind: "repo-file", project: "switchboard", path: "src/lib/panelStore.ts" });
    expect(openableAddressIn("ticket SWIT-79 and decision:q1 and plain words", ctx)).toBeNull();
    // A `.md` path that is not in the KB list resolves as a REPO file when the
    // thread has a project (evidenceModel's rule); with no project it is prose.
    expect(openableAddressIn("a KB doc that does not exist: other/x.md", { ...ctx, projectKey: null })).toBeNull();
    expect(openableAddressIn("other/x.md", ctx)?.artifact).toEqual({ kind: "repo-file", project: "switchboard", path: "other/x.md" });
  });

  it("takes the FIRST openable token", () => {
    expect(openableAddressIn("view:v1 then switchboard/spec.md", ctx)?.address).toBe("view:v1");
  });
});

describe("nextThingFor", () => {
  it("the turn's reviewFirst wins over questions and To do — openable or not", () => {
    const withReview = (reviewFirst: string) =>
      mergePage(
        { ...parsePageFile(""), questions: [question("q1")], items: [item("i1", "read view:v1")], turns: [{ at: "2026-09-08T10:00:00Z", lines: ["done"], reviewFirst }] },
        {},
        []
      );
    const next = nextThingFor(withReview("view:v3#h:results"), ctx)!;
    expect(next.why).toBe("review");
    if (next.why !== "review") return;
    expect(next.address).toBe("view:v3#h:results");
    expect(next.artifact).toEqual({ kind: "view", threadId: "th1", viewId: "v3" });
    expect(next.anchor).toBe("h:results");
    expect(next.offerKey).toBe("review:view:th1:v3");
    // A pointer at something with no surface (a ticket) is still the line —
    // and opens nothing.
    const ticket = nextThingFor(withReview("SWIT-79"), ctx)!;
    expect(ticket.why).toBe("review");
    if (ticket.why !== "review") return;
    expect(ticket.artifact).toBeNull();
    expect(ticket.label).toBe("SWIT-79");
  });

  it("open questions win: `answer N question(s)`, keyed by the sorted open ids", () => {
    const page = rendered([question("q2"), question("q1")], [item("i1", "read view:v1")]);
    const next = nextThingFor(page, ctx)!;
    expect(next.why).toBe("questions");
    expect(next.label).toBe("answer 2 questions");
    expect(next.offerKey).toBe(questionsOfferKey(["q1", "q2"]));
    expect(nextThingFor(rendered([question("q1")], []), ctx)!.label).toBe("answer 1 question");
  });

  it("else the first To do row with an openable address — waiting on you first — opened as that artifact", () => {
    const page = rendered(
      [],
      [
        item("i1", "no link here"),
        item("i2", "write the report", { note: "see switchboard/spec.md" }),
        item("i3", "review view:v7", { owner: "user" }),
      ]
    );
    const next = nextThingFor(page, ctx)!;
    expect(next.why).toBe("todo");
    if (next.why !== "todo") return;
    expect(next.artifact).toEqual({ kind: "view", threadId: "th1", viewId: "v7" });
    expect(next.label).toBe("review view:v7"); // the title already says the address
    expect(next.offerKey).toBe("view:th1:v7");
    // Without the user item, the note's doc is the next thing, labelled Ky's way.
    const page2 = rendered([], [item("i1", "no link here"), item("i2", "write the report", { note: "see switchboard/spec.md" })]);
    const next2 = nextThingFor(page2, ctx)!;
    expect(next2.label).toBe("switchboard/spec.md · write the report");
  });

  it("is null with nothing to offer, and ignores done/dropped rows", () => {
    expect(nextThingFor(rendered([], []), ctx)).toBeNull();
    expect(nextThingFor(rendered([], [item("i1", "view:v1", { state: "done" }), item("i2", "view:v2", { state: "dropped" })]), ctx)).toBeNull();
    expect(nextThingFor(null, ctx)).toBeNull();
  });
});

describe("offered once per key", () => {
  it("offers a key once per thread; a new key offers again; clearing forgets", () => {
    expect(offerNextThing("th1", "questions:q1")).toBe(true);
    expect(offerNextThing("th1", "questions:q1")).toBe(false);
    expect(offerNextThing("th1", "questions:q1,q2")).toBe(true);
    expect(offerNextThing("th2", "questions:q1,q2")).toBe(true);
    clearNextThingOffer("th1");
    expect(offerNextThing("th1", "questions:q1,q2")).toBe(true);
  });
});

describe("the page-focus one-shot", () => {
  it("is observable, per thread, taken once", () => {
    let notified = 0;
    const unsubscribe = subscribePageFocus(() => notified++);
    const before = pageFocusNonce();
    requestPageFocus("th1", "decisions");
    expect(notified).toBe(1);
    expect(pageFocusNonce()).toBe(before + 1);
    expect(takePageFocus("th2")).toBeNull();
    // Peek does not consume — the page peeks until its block is mounted.
    expect(peekPageFocus("th1")).toBe("decisions");
    expect(peekPageFocus("th1")).toBe("decisions");
    expect(peekPageFocus("th2")).toBeNull();
    expect(takePageFocus("th1")).toBe("decisions");
    expect(takePageFocus("th1")).toBeNull();
    expect(peekPageFocus("th1")).toBeNull();
    unsubscribe();
    requestPageFocus("th1", "decisions");
    expect(notified).toBe(1);
  });
});
