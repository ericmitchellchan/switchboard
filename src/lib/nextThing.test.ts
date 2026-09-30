// THE NEXT THING (SWIT-79, Ky's nextThing CC-710): the pure rule over the
// rendered page, the once-per-key offer, and the page-focus one-shot.

import { describe, it, expect, beforeEach } from "vitest";
import {
  nextThingFor,
  openableAddressIn,
  resolveAddress,
  questionsOfferKey,
  offerNextThing,
  clearNextThingOffer,
  __resetNextThingOffers,
  decideTurnSettle,
  isNextThingOffered,
  resolveOpenable,
  type NextThingContext,
  type TurnSettleDeps,
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

describe("resolveAddress — the ONE resolver (SWIT-102) and the KB miss it reports (SWIT-101)", () => {
  it("resolves a whole address exactly as a token of text resolves", () => {
    for (const address of ["view:v3#h:results", "surface:lodestar/trading?instrument=NQ", "switchboard/spec.md", "src/lib/panelStore.ts"]) {
      const whole = resolveAddress(address, ctx);
      const token = openableAddressIn(`see ${address} first`, ctx);
      expect(whole).not.toBeNull();
      expect(token).toEqual({ ...whole, address });
    }
    expect(resolveAddress("SWIT-79", ctx)).toBeNull();
    expect(resolveAddress("decision:q1", ctx)).toBeNull();
    // Whole, not tokenized: text around an address is not an address.
    expect(resolveAddress("see switchboard/spec.md", ctx)).toBeNull();
  });

  it("a doc/file address NOT in a known KB list reports the miss, then falls back — text, reviewFirst and To do alike", () => {
    const misses: string[] = [];
    const c: NextThingContext = { ...ctx, onKbMiss: (a) => misses.push(a) };
    expect(resolveAddress("switchboard/new-spec.md", c)?.artifact).toEqual({ kind: "repo-file", project: "switchboard", path: "switchboard/new-spec.md" });
    expect(misses).toEqual(["switchboard/new-spec.md"]);
    // A hit, a view, a surface and a ticket report nothing.
    resolveAddress("switchboard/spec.md", c);
    resolveAddress("view:v1", c);
    resolveAddress("surface:lodestar/trading", c);
    resolveAddress("SWIT-79", c);
    expect(misses).toHaveLength(1);
    // Through the page's own paths: a reviewFirst and a To do row.
    const review = mergePage({ ...parsePageFile(""), turns: [{ at: "2026-09-30T10:00:00Z", lines: ["wrote it"], reviewFirst: "switchboard/review.md" }] }, {}, []);
    expect(nextThingFor(review, c)?.why).toBe("review");
    expect(misses).toContain("switchboard/review.md");
    nextThingFor(rendered([], [item("i1", "read switchboard/todo.md")]), c);
    expect(misses).toContain("switchboard/todo.md");
    // With the refreshed list the SAME call resolves to the KB doc.
    const fresh = nextThingFor(review, { ...ctx, kbDocs: ["switchboard/spec.md", "switchboard/review.md"] });
    expect(fresh && fresh.why === "review" ? fresh.artifact : null).toEqual({ kind: "kb-doc", path: "switchboard/review.md" });
  });

  it("an UNKNOWN list (null — still loading) is not a miss: there is nothing to have missed", () => {
    const misses: string[] = [];
    resolveAddress("switchboard/new-spec.md", { ...ctx, kbDocs: null, onKbMiss: (a) => misses.push(a) });
    expect(misses).toEqual([]);
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

describe("ONE resolver: the cwd→project re-base rides every path (review of 49ebb20, #7)", () => {
  const sub: NextThingContext = { ...ctx, pathPrefix: "apps/desktop/" };

  it("a repo path in a To do row, a reviewFirst and an Evidence-style address re-base the same way `show` does", () => {
    expect(resolveAddress("src/x.md", sub)?.artifact).toEqual({ kind: "repo-file", project: "switchboard", path: "apps/desktop/src/x.md" });
    expect(resolveOpenable("src/x.md", sub)).toEqual({ kind: "repo-file", project: "switchboard", path: "apps/desktop/src/x.md" });
    expect(openableAddressIn("fix src/x.md next", sub)?.artifact).toEqual({ kind: "repo-file", project: "switchboard", path: "apps/desktop/src/x.md" });
    const page = mergePage({ ...parsePageFile(""), items: [item("i1", "update src/x.md")] }, {}, []);
    const next = nextThingFor(page, sub);
    expect(next?.why === "todo" && next.artifact).toEqual({ kind: "repo-file", project: "switchboard", path: "apps/desktop/src/x.md" });
    // A multi-repo project addresses its files as <repo>/….
    expect(resolveOpenable("specs/a.md", { ...ctx, projectKey: "kyde", pathPrefix: "admin-panel/" })).toEqual({
      kind: "repo-file",
      project: "kyde",
      path: "admin-panel/specs/a.md",
    });
  });

  it("never re-bases a KB doc, a page state or a view", () => {
    expect(resolveOpenable("switchboard/spec.md", sub)).toEqual({ kind: "kb-doc", path: "switchboard/spec.md" });
    expect(resolveOpenable("surface:lodestar/trading", sub)).toEqual({ kind: "surface", project: "lodestar", page: "trading" });
    expect(resolveAddress("view:v1", sub)?.artifact).toEqual({ kind: "view", threadId: "th1", viewId: "v1" });
  });

  it("a reviewFirst carries the TOKEN that resolved, so a click re-resolves it and not the whole line (review nit)", () => {
    const page = mergePage(
      { ...parsePageFile(""), turns: [{ at: "2026-09-30T10:00:00Z", lines: ["did it"], reviewFirst: "(src/x.md)" }] },
      {},
      []
    );
    const next = nextThingFor(page, sub);
    expect(next?.why).toBe("review");
    if (next?.why !== "review") return;
    expect(next.address).toBe("(src/x.md)");
    expect(next.token).toBe("src/x.md");
    expect(resolveOpenable(next.token!, sub)).toEqual(next.artifact);
  });
});

describe("decideTurnSettle — the checks before the KB refresh (review of 49ebb20, #5)", () => {
  const todoPage = (title: string) => mergePage({ ...parsePageFile(""), items: [item("i1", title)] }, {}, []);
  const deps = (over: Partial<TurnSettleDeps> = {}): TurnSettleDeps & { refreshes: number } => {
    const d = {
      refreshes: 0,
      ctx: { threadId: "th1", projectKey: "switchboard", pathPrefix: "" },
      kbDocs: ["switchboard/spec.md"] as readonly string[] | null,
      refreshKbDocs: async () => {
        d.refreshes += 1;
        return ["switchboard/spec.md", "switchboard/new.md"];
      },
      previewActive: () => false,
      intentRecent: () => false,
      ...over,
    };
    return d;
  };

  it("a dotted word in a To do row costs NO refresh — it could never be a KB doc", async () => {
    for (const title of ["bump Cargo.toml", "ship v0.16.0", "e.g the thing"]) {
      __resetNextThingOffers();
      const d = deps();
      await decideTurnSettle(todoPage(title), d);
      expect(d.refreshes).toBe(0);
    }
  });

  it("every stand-down comes BEFORE the refresh: preview being read, the agent's own show, already offered", async () => {
    const page = todoPage("write switchboard/new.md");
    const preview = deps({ previewActive: () => true });
    expect((await decideTurnSettle(page, preview)).act).toBe("stand-down");
    expect(preview.refreshes).toBe(0);
    const intent = deps({ intentRecent: () => true });
    expect(await decideTurnSettle(page, intent)).toMatchObject({ act: "stand-down", reason: "intent" });
    expect(intent.refreshes).toBe(0);
    // Already offered (App recorded the open): the next settle, against the
    // list the refresh left cached, stands down with no IPC.
    const first = await decideTurnSettle(page, deps());
    expect(first.act).toBe("open");
    if (first.act !== "open") return;
    offerNextThing("th1", first.next.offerKey);
    const warm = deps({ kbDocs: ["switchboard/spec.md", "switchboard/new.md"] });
    expect(await decideTurnSettle(page, warm)).toMatchObject({ act: "stand-down", reason: "offered" });
    expect(warm.refreshes).toBe(0);
    // …and against a still-stale list the refreshed answer is checked too.
    const stale = deps();
    expect(await decideTurnSettle(page, stale)).toMatchObject({ act: "stand-down", reason: "offered" });
  });

  it("an open that survived the checks and missed the KB list refreshes ONCE and opens the KB doc", async () => {
    const d = deps();
    const decision = await decideTurnSettle(todoPage("write switchboard/new.md"), d);
    expect(d.refreshes).toBe(1);
    expect(decision.act === "open" && decision.next.artifact).toEqual({ kind: "kb-doc", path: "switchboard/new.md" });
    expect(isNextThingOffered("th1", decision.act === "open" ? decision.next.offerKey : "")).toBe(false); // App records it
  });

  it("nothing next / questions / a reviewFirst ticket key — no refresh either", async () => {
    const d = deps();
    expect((await decideTurnSettle(mergePage(parsePageFile(""), {}, []), d)).act).toBe("none");
    expect((await decideTurnSettle(rendered([question("q1")], []), d)).act).toBe("questions");
    expect(d.refreshes).toBe(0);
  });
});
