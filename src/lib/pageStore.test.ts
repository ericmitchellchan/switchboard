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
} from "./pageStore";

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

  it("splits items: user-owned open items under Needs You, done folded", () => {
    const merged = mergePage(page, {}, []);
    expect(merged.userItems.map((i) => i.id)).toEqual(["i2"]);
    expect(merged.openItems.map((i) => i.id)).toEqual(["i1", "i2"]);
    expect(merged.doneItems.map((i) => i.id)).toEqual(["i3"]);
    expect(merged.doneFolded).toBe(0);
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

  it("inbox splits by kind: requests under Needs You, updates under What Happened", () => {
    const merged = mergePage(page, {}, [
      { id: "p1", from: "a", kind: "request", text: "r", at: "t" },
      { id: "p2", from: "b", kind: "update", text: "u", at: "t" },
    ]);
    expect(merged.requests.map((p) => p.id)).toEqual(["p1"]);
    expect(merged.updates.map((p) => p.id)).toEqual(["p2"]);
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
