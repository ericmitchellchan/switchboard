// The ✦ page's data layer (SWIT-48): tolerant parses, the three-file merge,
// the fold rules, the seen-stamp math — and the freeze-rule import check.

import { describe, it, expect } from "vitest";
// The module's SOURCE, for the freeze-rule import tripwire below. Vite's raw
// query keeps this a bundler concern (vite/client types cover ?raw).
import pageStoreSource from "./pageStore.ts?raw";
import {
  parsePageFile,
  parseAnswersFile,
  parseInboxFile,
  mergePage,
  isNewSince,
  EMPTY_PAGE,
  TURN_CAP,
  TURN_LINE_CAP,
  EVIDENCE_CAP,
  QUESTION_CAP,
  DONE_FOLD,
  countUnreadPosts,
  orderedOptions,
  decisionAddress,
  conventionLine,
  pageSummary,
  REVIEW_FIRST_CAP,
  answerSuccessNote,
  answerErrorNote,
  noteReplacesForm,
} from "./pageStore";
import type { PageQuestion } from "./pageStore";

const PAGE = {
  theme: "Give every market an anchor",
  turns: [
    { at: "2026-08-31T10:00:00Z", lines: ["Latest turn.", "Two lines."] },
    { at: "2026-08-31T09:00:00Z", lines: ["Earlier turn."] },
  ],
  evidence: [
    { address: "SWIT-43", label: "market anchors", status: "in progress", updatedAt: "2026-08-31T10:00:00Z" },
  ],
  questions: [
    { id: "q1", text: "Same set or per-market?", options: ["same set", "per-market"], askedAt: "2026-08-31T09:30:00Z" },
    { id: "q2", text: "Rename bar keys?", options: [], askedAt: "2026-08-31T08:00:00Z" },
  ],
  items: [
    { id: "i1", title: "Publish anchors", owner: "agent", state: "in_progress", note: null },
    { id: "i2", title: "Check the pins", owner: "user", state: "todo", note: "blocks R1" },
    { id: "i3", title: "Old thing", owner: "agent", state: "done", note: null },
  ],
};

describe("parsePageFile (tolerant)", () => {
  it("parses a well-formed page", () => {
    const p = parsePageFile(JSON.stringify(PAGE));
    expect(p.theme).toBe(PAGE.theme);
    expect(p.turns).toHaveLength(2);
    expect(p.evidence).toHaveLength(1);
    expect(p.questions).toHaveLength(2);
    expect(p.items).toHaveLength(3);
  });

  it("empty / junk / non-JSON degrade to the empty page, never throw", () => {
    expect(parsePageFile("")).toEqual(EMPTY_PAGE);
    expect(parsePageFile("   ")).toEqual(EMPTY_PAGE);
    expect(parsePageFile("not json {")).toEqual(EMPTY_PAGE);
    expect(parsePageFile("[1,2,3]")).toEqual(EMPTY_PAGE);
    expect(parsePageFile('"a string"')).toEqual(EMPTY_PAGE);
  });

  it("a malformed ENTRY drops alone — the page renders what survives", () => {
    const p = parsePageFile(
      JSON.stringify({
        theme: 42, // wrong type → null
        turns: [{ lines: ["ok"] }, { lines: [] }, null, { lines: [7, "kept"] }],
        evidence: [{ address: "A", label: "a" }, { label: "no address" }, { address: "A", label: "dup" }],
        questions: [{ id: "q", text: "t" }, { id: "q", text: "dup id" }, { text: "no id" }],
        items: [{ id: "i", title: "t", owner: "wat", state: "wat" }],
      })
    );
    expect(p.theme).toBeNull();
    expect(p.turns.map((t) => t.lines)).toEqual([["ok"], ["kept"]]);
    expect(p.evidence).toHaveLength(1); // address-deduped
    expect(p.questions).toHaveLength(1);
    // Unknown owner/state fall back rather than dropping the item.
    expect(p.items[0]).toMatchObject({ owner: "agent", state: "todo" });
  });

  it("applies the caps: turns, lines per turn, evidence, questions", () => {
    const big = {
      turns: Array.from({ length: 50 }, (_, i) => ({
        at: "",
        lines: Array.from({ length: 12 }, (_, j) => `l${i}-${j}`),
      })),
      evidence: Array.from({ length: 100 }, (_, i) => ({ address: `a${i}`, label: "" })),
      questions: Array.from({ length: 40 }, (_, i) => ({ id: `q${i}`, text: "t" })),
    };
    const p = parsePageFile(JSON.stringify(big));
    expect(p.turns).toHaveLength(TURN_CAP);
    expect(p.turns[0].lines).toHaveLength(TURN_LINE_CAP);
    expect(p.evidence).toHaveLength(EVIDENCE_CAP);
    expect(p.questions).toHaveLength(QUESTION_CAP);
  });
});

describe("question kind + default (SWIT-58)", () => {
  const q = (extra: Record<string, unknown>): PageQuestion =>
    parsePageFile(
      JSON.stringify({ questions: [{ id: "q1", text: "Which?", options: ["a", "b", "c"], ...extra }] })
    ).questions[0];

  it("kind defaults to decision; convention / info parse; junk falls back", () => {
    expect(q({}).kind).toBe("decision");
    expect(q({ kind: "convention" }).kind).toBe("convention");
    expect(q({ kind: "info" }).kind).toBe("info");
    expect(q({ kind: "whim" }).kind).toBe("decision");
    expect(q({ kind: 7 }).kind).toBe("decision");
  });

  it("default is kept ONLY when it is one of the options — never trusted otherwise", () => {
    expect(q({ default: "b" }).defaultOption).toBe("b");
    expect(q({ default: "zzz" }).defaultOption).toBeNull();
    expect(q({ default: "" }).defaultOption).toBeNull();
    expect(q({}).defaultOption).toBeNull();
  });

  it("orderedOptions lists the default FIRST and leaves the file order alone", () => {
    const withDefault = q({ default: "b" });
    expect(orderedOptions(withDefault)).toEqual(["b", "a", "c"]);
    expect(withDefault.options).toEqual(["a", "b", "c"]); // the file's order, untouched
    expect(orderedOptions(q({}))).toEqual(["a", "b", "c"]);
  });

  it("conventionLine is ONE dated line in the file's own shape, no leading bullet", () => {
    const line = conventionLine("Tabs\nor spaces?", "two-space  indent", "lodestar · Sep 1", new Date(2026, 8, 1));
    expect(line).toBe("2026-09-01 — two-space indent (asked: Tabs or spaces?; thread: lodestar · Sep 1)");
    expect(line.startsWith("- ")).toBe(false);
    expect(line).not.toMatch(/[\r\n]/);
    expect(conventionLine("Q", "A", null, new Date(2026, 0, 9))).toBe("2026-01-09 — A (asked: Q)");
    expect(conventionLine("Q", "A", "   ", new Date(2026, 0, 9))).toBe("2026-01-09 — A (asked: Q)");
  });
});

describe("parseAnswersFile / parseInboxFile", () => {
  it("answers: keeps well-formed entries, drops junk", () => {
    const a = parseAnswersFile(
      JSON.stringify({ q1: { text: "same set", at: "2026-08-31T10:05:00Z" }, q2: { at: "x" }, "": { text: "t" } })
    );
    expect(Object.keys(a)).toEqual(["q1"]);
    expect(parseAnswersFile("")).toEqual({});
    expect(parseAnswersFile("junk")).toEqual({});
  });

  it("inbox: posts parsed, ids deduped, kind defaults to update", () => {
    const posts = parseInboxFile(
      JSON.stringify({
        posts: [
          { id: "p1", from: "sim audit", kind: "request", text: "re-run the check", at: "t" },
          { id: "p1", text: "dup" },
          { id: "p2", text: "an update" },
          { text: "no id" },
        ],
      })
    );
    expect(posts).toHaveLength(2);
    expect(posts[0].kind).toBe("request");
    expect(posts[1]).toMatchObject({ kind: "update", from: "another thread" });
    expect(parseInboxFile("")).toEqual([]);
  });
});

describe("mergePage", () => {
  const page = parsePageFile(JSON.stringify(PAGE));

  it("joins answers to questions by id — open vs answered", () => {
    const merged = mergePage(page, { q2: { text: "yes", at: "t" } }, []);
    expect(merged.openQuestions.map((q) => q.id)).toEqual(["q1"]);
    expect(merged.answeredQuestions).toHaveLength(1);
    expect(merged.answeredQuestions[0].answer.text).toBe("yes");
  });

  it("splits items ONCE (SWIT-69): user-owned and waiting items under Needs You, the rest under To do, done folded", () => {
    const merged = mergePage(page, {}, []);
    expect(merged.userItems.map((i) => i.id)).toEqual(["i2"]);
    expect(merged.openItems.map((i) => i.id)).toEqual(["i1"]); // no duplication
    expect(merged.doneItems.map((i) => i.id)).toEqual(["i3"]);
    expect(merged.doneFolded).toBe(0);
    // A `waiting` item is waiting ON THE USER — Needs You, whoever owns it.
    const waiting = parsePageFile(
      JSON.stringify({ items: [{ id: "w1", title: "t", owner: "agent", state: "waiting" }] })
    );
    const m2 = mergePage(waiting, {}, []);
    expect(m2.userItems.map((i) => i.id)).toEqual(["w1"]);
    expect(m2.openItems).toEqual([]);
  });

  it("folds done past DONE_FOLD", () => {
    const many = {
      items: Array.from({ length: DONE_FOLD + 5 }, (_, i) => ({
        id: `d${i}`,
        title: "t",
        owner: "agent",
        state: "done",
      })),
    };
    const merged = mergePage(parsePageFile(JSON.stringify(many)), {}, []);
    expect(merged.doneItems).toHaveLength(DONE_FOLD);
    expect(merged.doneFolded).toBe(5);
  });

  it("latest turn leads; earlier fold behind a count", () => {
    const merged = mergePage(page, {}, []);
    expect(merged.latestTurn?.lines[0]).toBe("Latest turn.");
    expect(merged.earlierTurns).toHaveLength(1);
  });

  it("a turn's reviewFirst parses through and rides the latest turn (SWIT-67)", () => {
    const p = parsePageFile(
      JSON.stringify({
        turns: [
          { at: "t2", lines: ["Newest."], reviewFirst: "surface:lodestar/trading?instrument=NQ" },
          { at: "t1", lines: ["Older."], reviewFirst: 7 }, // wrong type drops alone
        ],
      })
    );
    expect(p.turns[0].reviewFirst).toBe("surface:lodestar/trading?instrument=NQ");
    expect(p.turns[1].reviewFirst).toBeUndefined();
    expect(mergePage(p, {}, []).latestTurn?.reviewFirst).toBe("surface:lodestar/trading?instrument=NQ");
  });

  it("pageSummary is the theme + the newest turn's first line, joined with a dash (SWIT-68)", () => {
    const merged = mergePage(page, {}, []);
    expect(pageSummary(merged)).toBe("Give every market an anchor — Latest turn.");
    const themeOnly = mergePage(parsePageFile(JSON.stringify({ theme: "Just a theme" })), {}, []);
    expect(pageSummary(themeOnly)).toBe("Just a theme");
    expect(pageSummary(mergePage(EMPTY_PAGE, {}, []))).toBeNull();
  });

  it("a hand-written reviewFirst is capped at REVIEW_FIRST_CAP on the way in (review F3)", () => {
    const p = parsePageFile(
      JSON.stringify({ turns: [{ at: "t", lines: ["x"], reviewFirst: "a".repeat(REVIEW_FIRST_CAP + 50) }] })
    );
    expect(p.turns[0].reviewFirst).toBe("a".repeat(REVIEW_FIRST_CAP));
  });

  it("answer notes: only success collapses the form; an error keeps it (review F1)", () => {
    expect(answerSuccessNote("sent")).toEqual({ kind: "success", text: "answered → sent to the thread" });
    expect(answerSuccessNote("saved")).toEqual({ kind: "success", text: "answered → saved on the page" });
    expect(answerErrorNote(new Error("disk full"))).toEqual({ kind: "error", text: "could not save: disk full" });
    expect(answerErrorNote("nope").text).toBe("could not save: nope");
    expect(noteReplacesForm(answerSuccessNote("sent"))).toBe(true);
    expect(noteReplacesForm(answerErrorNote(new Error("x")))).toBe(false);
    expect(noteReplacesForm(null)).toBe(false);
  });

  it("inbox splits by kind: requests under Needs You, updates under What Happened", () => {
    const merged = mergePage(page, {}, [
      { id: "p1", from: "a", kind: "request", text: "r", at: "t" },
      { id: "p2", from: "b", kind: "update", text: "u", at: "t" },
    ]);
    expect(merged.requests.map((p) => p.id)).toEqual(["p1"]);
    expect(merged.updates.map((p) => p.id)).toEqual(["p2"]);
  });

  it("an answer becomes a decision:<id> evidence row — decided, labelled by the answer, in the merge only", () => {
    const merged = mergePage(
      page,
      {
        q1: { text: "per-market", at: "2026-08-31T11:00:00Z" },
        q2: { text: "no", at: "2026-08-31T09:30:00Z" },
      },
      []
    );
    // Newest first across the agent's rows AND the decided rows.
    expect(merged.evidence.map((e) => e.address)).toEqual(["decision:q1", "SWIT-43", "decision:q2"]);
    expect(merged.evidence[0]).toEqual({
      address: decisionAddress("q1"),
      label: "per-market",
      status: "decided",
      updatedAt: "2026-08-31T11:00:00Z",
    });
    expect(merged.decisions.map((d) => d.label)).toEqual(["per-market", "no"]);
    // page.json's own evidence is untouched — the row exists in the MERGE
    // (answers.json is the app's file; the agent's file gains nothing).
    expect(page.evidence.map((e) => e.address)).toEqual(["SWIT-43"]);
    // No answers → no decided rows and the agent's evidence passes through.
    expect(mergePage(page, {}, []).decisions).toEqual([]);
    expect(mergePage(page, {}, []).evidence).toEqual(page.evidence);
  });

  it("a decided row wins over an agent-written row at the same address", () => {
    const withAgentRow = parsePageFile(
      JSON.stringify({
        ...PAGE,
        evidence: [
          { address: "decision:q1", label: "agent's guess", status: "open", updatedAt: "2026-08-31T12:00:00Z" },
        ],
      })
    );
    const merged = mergePage(withAgentRow, { q1: { text: "per-market", at: "2026-08-31T11:00:00Z" } }, []);
    expect(merged.evidence).toHaveLength(1);
    expect(merged.evidence[0].label).toBe("per-market");
    expect(merged.evidence[0].status).toBe("decided");
  });

  it("isEmpty is true only when EVERYTHING is empty", () => {
    expect(mergePage(EMPTY_PAGE, {}, []).isEmpty).toBe(true);
    expect(mergePage(page, {}, []).isEmpty).toBe(false);
    expect(
      mergePage(EMPTY_PAGE, {}, [{ id: "p", from: "a", kind: "update", text: "t", at: "" }]).isEmpty
    ).toBe(false);
  });
});

describe("isNewSince (the dot rule)", () => {
  it("a null stamp = first visit = never new", () => {
    expect(isNewSince("2026-08-31T10:00:00Z", null)).toBe(false);
  });

  it("newer than the stamp → new; older → not; junk time → never new", () => {
    const stamp = Date.parse("2026-08-31T09:00:00Z");
    expect(isNewSince("2026-08-31T10:00:00Z", stamp)).toBe(true);
    expect(isNewSince("2026-08-31T08:00:00Z", stamp)).toBe(false);
    expect(isNewSince("not a time", stamp)).toBe(false);
    expect(isNewSince("", stamp)).toBe(false);
  });
});

describe("the freeze rule is unreachable from here (import graph)", () => {
  it("pageStore imports nothing that can touch the terminal grid", () => {
    // A page update arriving while the agent is RUNNING repaints the panel
    // body only. That is structural — this module must never grow an import
    // of the fit/terminal machinery, and this test is the tripwire. Only
    // IMPORT statements are scanned (comments legitimately name the modules).
    const imports = Array.from(
      String(pageStoreSource).matchAll(/^import[^"']*["']([^"']+)["']/gm),
      (m) => m[1]
    );
    expect(imports.length).toBeGreaterThan(0); // the scan actually saw the file
    for (const spec of imports) {
      expect(spec).not.toMatch(/fitQueue|terminal|resizePolicy|paneLayout/i);
    }
  });
});

describe("countUnreadPosts (the chip rule, SWIT-52)", () => {
  const post = (id: string, at: string) => ({ id, from: "a", kind: "update" as const, text: "t", at });

  it("a null stamp counts EVERYTHING - a post to a never-opened thread must chip", () => {
    expect(countUnreadPosts([post("1", "2026-08-31T10:00:00Z")], null)).toBe(1);
  });

  it("counts posts newer than the stamp; junk timestamps never count", () => {
    const stamp = Date.parse("2026-08-31T09:00:00Z");
    expect(
      countUnreadPosts(
        [post("1", "2026-08-31T10:00:00Z"), post("2", "2026-08-31T08:00:00Z"), post("3", "junk")],
        stamp
      )
    ).toBe(1);
  });
});
