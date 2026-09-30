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
  QUESTION_KEEP_CAP,
  neighbourAfterDismiss,
  dismissSuccessNote,
  noteReplacesForm as noteReplacesFormForDismiss,
  DONE_FOLD,
  countUnreadPosts,
  postTimes,
  countUnreadTimes,
  nextPassEntry,
  orderedOptions,
  decisionAddress,
  conventionLine,
  pageSummary,
  REVIEW_FIRST_CAP,
  answerSuccessNote,
  answerErrorNote,
  sendErrorNote,
  noteReplacesForm,
  isAnswerUnsent,
  countQuestionStates,
  questionMarkerTitle,
  unsentDecisionsLine,
  conventionEntries,
  partialSentNote,
  decisionsMessage,
  decisionsFooter,
  recommendation,
  isWaitingOnUser,
  isQuestionOpen,
  WHY_CAP,
  parseRetractedFile,
  isRetracted,
  applyRetractions,
  isOpenItem,
  RETRACTED_CAP,
  parseBrief,
  briefSections,
  questionAddress,
  questionDismissedAt,
  QUESTION_ADDRESS_PREFIX,
  dismissErrorNote,
  BRIEF_LISTS,
  BRIEF_GOAL_CAP,
  BRIEF_LINE_CAP,
  BRIEF_LINES_CAP,
  parseFindings,
  FINDING_VERDICTS,
  FINDING_CAP,
  FINDING_CLAIM_CAP,
  FINDING_N_CAP,
  FINDING_REPORT_CAP,
} from "./pageStore";
import { statusTone, verdictTone } from "./statusPill";
import { evidenceKindOf } from "./evidenceModel";
import type { PageQuestion, RetractedEvidence } from "./pageStore";

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
    // Review of c178f2f, #3: questions are NOT cut at the open cap — all 40
    // survive (the file holds only what the server let in, ≤ QUESTION_KEEP_CAP).
    expect(p.questions).toHaveLength(40);
    expect(QUESTION_CAP).toBe(20);
    const huge = parsePageFile(JSON.stringify({ questions: Array.from({ length: QUESTION_KEEP_CAP + 30 }, (_, i) => ({ id: `q${i}`, text: "t" })) }));
    expect(huge.questions).toHaveLength(QUESTION_KEEP_CAP);
  });

  it("an OPEN question behind twenty answered/dismissed ones stays on the page (review of c178f2f, #3)", () => {
    // Newest first, as the server writes: 25 newer questions the user
    // answered, then the one still open.
    const questions = [
      ...Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, text: `newer ${i}`, askedAt: "2026-09-30T10:00:00Z" })),
      { id: "old", text: "still open", askedAt: "2026-09-01T10:00:00Z" },
    ];
    const answers: Record<string, { text: string; at: string; resolvedBy: "user" }> = {};
    for (let i = 0; i < 25; i++) answers[`n${i}`] = { text: "yes", at: "2026-09-30T11:00:00Z", resolvedBy: "user" };
    const merged = mergePage(parsePageFile(JSON.stringify({ questions })), parseAnswersFile(JSON.stringify(answers)), []);
    expect(merged.openQuestions.map((q) => q.id)).toEqual(["old"]);
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

  it("why parses (capped) and resolved needs BOTH answer and answeredAt (SWIT-77)", () => {
    expect(q({ why: "cheapest to undo" }).why).toBe("cheapest to undo");
    expect(q({ why: 7 }).why).toBeNull();
    expect(q({ why: "w".repeat(WHY_CAP + 20) }).why).toHaveLength(WHY_CAP);
    expect(q({}).resolved).toBeNull();
    expect(q({ answer: "moot", answeredAt: "2026-09-08T10:00:00Z", resolvedBy: "agent" }).resolved).toEqual({
      answer: "moot",
      at: "2026-09-08T10:00:00Z",
      by: "agent",
    });
    // Half a settlement is no settlement: the question stays open.
    expect(q({ answer: "moot" }).resolved).toBeNull();
    expect(q({ answeredAt: "t" }).resolved).toBeNull();
    // resolvedBy defaults to agent — page.json is the agent's file.
    expect(q({ answer: "a", answeredAt: "t" }).resolved?.by).toBe("agent");
  });

  it("recommendation is the default, else the first option — and only when there is a why or a default", () => {
    expect(recommendation(q({ default: "b", why: "w" }))).toEqual({ option: "b", why: "w" });
    expect(recommendation(q({ why: "w" }))).toEqual({ option: "a", why: "w" });
    expect(recommendation(q({ default: "c" }))).toEqual({ option: "c", why: null });
    expect(recommendation(q({}))).toBeNull(); // a bare list is a list, not a proposal
    const noOptions = parsePageFile(JSON.stringify({ questions: [{ id: "q", text: "t", why: "w" }] })).questions[0];
    expect(recommendation(noOptions)).toBeNull();
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
    expect(a.q1).toEqual({ text: "same set", at: "2026-08-31T10:05:00Z" }); // a pre-SWIT-77 entry parses unchanged
    expect(parseAnswersFile("")).toEqual({});
    expect(parseAnswersFile("junk")).toEqual({});
  });

  it("answers: sentAt / resolvedBy ride the entry (SWIT-77); junk in them drops alone", () => {
    const a = parseAnswersFile(
      JSON.stringify({
        q1: { text: "a", at: "2026-09-08T10:00:00Z", sentAt: "2026-09-08T10:00:05Z", resolvedBy: "user" },
        q2: { text: "b", at: "t", sentAt: 7, resolvedBy: "agent" },
      })
    );
    expect(a.q1).toEqual({ text: "a", at: "2026-09-08T10:00:00Z", sentAt: "2026-09-08T10:00:05Z", resolvedBy: "user" });
    expect(a.q2).toEqual({ text: "b", at: "t" }); // answers.json never says agent
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

describe("the batch's pure rules (SWIT-77)", () => {
  it("isAnswerUnsent: no sentAt, or one older than at — a changed answer goes again", () => {
    expect(isAnswerUnsent(undefined)).toBe(false);
    expect(isAnswerUnsent({ text: "a", at: "2026-09-08T10:00:00Z" })).toBe(true);
    expect(isAnswerUnsent({ text: "a", at: "2026-09-08T10:00:00Z", sentAt: "2026-09-08T10:00:00Z" })).toBe(false); // same second = sent
    expect(isAnswerUnsent({ text: "a", at: "2026-09-08T10:00:00Z", sentAt: "2026-09-08T10:00:05Z" })).toBe(false);
    expect(isAnswerUnsent({ text: "b", at: "2026-09-08T10:01:00Z", sentAt: "2026-09-08T10:00:05Z" })).toBe(true);
  });

  it("countQuestionStates splits open / unsent the way the merge does — a sent or agent-resolved one is neither (review fix F5)", () => {
    const qs = [
      { id: "open", resolved: null },
      { id: "unsent", resolved: null },
      { id: "changed", resolved: null },
      { id: "sent", resolved: null },
      { id: "settled", resolved: { answer: "a", at: "t", by: "agent" as const } },
    ];
    const answers = {
      unsent: { text: "a", at: "2026-09-08T10:00:00Z" },
      changed: { text: "b", at: "2026-09-08T10:05:00Z", sentAt: "2026-09-08T10:00:00Z" }, // re-answered after the send
      sent: { text: "c", at: "2026-09-08T10:00:00Z", sentAt: "2026-09-08T10:00:00Z" },
    };
    expect(countQuestionStates(qs, answers)).toEqual({ open: 1, unsent: 2 });
    expect(countQuestionStates([], {})).toEqual({ open: 0, unsent: 0 });
    // The same numbers the merge would show — the rail and the page cannot disagree.
    const page = parsePageFile(JSON.stringify({ questions: qs.map((q) => ({ id: q.id, text: "t?", askedAt: "t", ...(q.resolved ? { answer: "a", answeredAt: "t" } : {}) })) }));
    const merged = mergePage(page, answers, []);
    expect(countQuestionStates(page.questions, answers)).toEqual({
      open: merged.openQuestions.length,
      unsent: merged.unsentDecisions.length,
    });
  });

  it("questionMarkerTitle is worded: open alone, unsent alone, both — null with nothing to mark", () => {
    expect(questionMarkerTitle(0, 0)).toBeNull();
    expect(questionMarkerTitle(1, 0)).toBe("1 open question");
    expect(questionMarkerTitle(2, 0)).toBe("2 open questions");
    expect(questionMarkerTitle(0, 1)).toBe("1 decision unsent");
    expect(questionMarkerTitle(0, 3)).toBe("3 decisions unsent");
    expect(questionMarkerTitle(2, 1)).toBe("2 open · 1 unsent");
  });

  it("unsentDecisionsLine is Home's one row per thread", () => {
    expect(unsentDecisionsLine(1)).toBe("1 decision unsent · send from the page");
    expect(unsentDecisionsLine(2)).toBe("2 decisions unsent · send from the page");
  });

  it("conventionEntries keeps only convention questions with a non-blank answer, in batch order (review fix F6)", () => {
    const qs = [
      { id: "q1", text: "Tabs or spaces?", kind: "convention" as const },
      { id: "q2", text: "Ship?", kind: "decision" as const },
      { id: "q3", text: "Colour?", kind: "convention" as const },
      { id: "q4", text: "Blank?", kind: "convention" as const },
    ];
    expect(conventionEntries(qs, { q1: "spaces", q2: "yes", q3: " green ", q4: "  " })).toEqual([
      { questionId: "q1", question: "Tabs or spaces?", answer: "spaces" },
      { questionId: "q3", question: "Colour?", answer: "green" },
    ]);
    expect(conventionEntries(qs, {})).toEqual([]);
  });

  it("partialSentNote: null when every id was stamped, else the count that was not (review fix F7)", () => {
    expect(partialSentNote(3, 3)).toBeNull();
    expect(partialSentNote(4, 3)).toBeNull();
    expect(partialSentNote(1, 3)).toEqual({ kind: "error", text: "sent, but 2 of 3 not marked sent" });
    expect(partialSentNote(0, 1)).toEqual({ kind: "error", text: "sent, but 1 of 1 not marked sent" });
  });

  it("decisionsMessage is Ky's shape verbatim: numbered in display order, still open for the undecided, one line per answer", () => {
    const qs = [
      { id: "q1", text: "Same set or per-market?" },
      { id: "q2", text: "Rename bar keys?" },
      { id: "q3", text: "Ship\nnow?" },
    ];
    expect(decisionsMessage(qs, { q1: "per-market", q3: "yes —\n  after tests" })).toBe(
      "Decisions:\n1. Same set or per-market?\n   → per-market\n2. Rename bar keys?\n   → still open\n3. Ship now?\n   → yes — after tests"
    );
    expect(decisionsMessage([], {})).toBe("Decisions:\n");
    expect(decisionsMessage([qs[0]], { q1: "   " })).toContain("→ still open"); // blank is no answer
  });

  it("decisionsFooter names the count and, only when both kinds are present, what happens to the rest", () => {
    expect(decisionsFooter(0, 3)).toBe("0 of 3 decided");
    expect(decisionsFooter(2, 3)).toBe('2 of 3 decided · undecided ones go as "still open"');
    expect(decisionsFooter(3, 3)).toBe("3 of 3 decided");
  });

  it("isWaitingOnUser: owned by the user, or parked in waiting", () => {
    expect(isWaitingOnUser({ owner: "user", state: "todo" })).toBe(true);
    expect(isWaitingOnUser({ owner: "agent", state: "waiting" })).toBe(true);
    expect(isWaitingOnUser({ owner: "team", state: "in_progress" })).toBe(false);
  });

  it("isQuestionOpen: neither a user answer nor an agent resolution", () => {
    const open = { id: "q", resolved: null };
    expect(isQuestionOpen(open, {})).toBe(true);
    expect(isQuestionOpen(open, { q: { text: "a", at: "t" } })).toBe(false);
    expect(isQuestionOpen({ id: "q", resolved: { answer: "a", at: "t", by: "agent" } }, {})).toBe(false);
  });
});

describe("mergePage", () => {
  const page = parsePageFile(JSON.stringify(PAGE));

  it("joins answers to questions by id — open vs decided-unsent vs settled (SWIT-77)", () => {
    // Answered, not sent: NOT open (Home drops it), still in the batch list.
    const unsent = mergePage(page, { q2: { text: "yes", at: "t" } }, []);
    expect(unsent.openQuestions.map((q) => q.id)).toEqual(["q1"]);
    expect(unsent.unsentDecisions.map((a) => a.question.id)).toEqual(["q2"]);
    expect(unsent.unsentDecisions[0].answer.text).toBe("yes");
    expect(unsent.decisionQuestions.map((q) => q.id)).toEqual(["q2", "q1"]); // OLDEST first (q2 asked 08:00, q1 09:30)
    expect(unsent.settledQuestions).toEqual([]);
    // Sent: out of the batch, under Decided as the user's.
    const sent = mergePage(page, { q2: { text: "yes", at: "t1", sentAt: "t1" } }, []);
    expect(sent.decisionQuestions.map((q) => q.id)).toEqual(["q1"]);
    expect(sent.settledQuestions).toEqual([{ question: page.questions[1], answer: "yes", at: "t1", by: "user" }]);
  });

  it("an agent resolution leaves Open questions and prints as settled; the user's answer wins the same id (precedence)", () => {
    const resolved = parsePageFile(
      JSON.stringify({
        questions: [
          { id: "q1", text: "A?", askedAt: "2026-09-08T09:00:00Z", answer: "decided in chat", answeredAt: "2026-09-08T10:00:00Z", resolvedBy: "agent" },
          { id: "q2", text: "B?", askedAt: "2026-09-08T09:10:00Z" },
        ],
      })
    );
    const m = mergePage(resolved, {}, []);
    expect(m.openQuestions.map((q) => q.id)).toEqual(["q2"]);
    expect(m.decisionQuestions.map((q) => q.id)).toEqual(["q2"]);
    expect(m.settledQuestions).toHaveLength(1);
    expect(m.settledQuestions[0]).toMatchObject({ answer: "decided in chat", by: "agent" });
    // The resolution is a standing decision too — status `settled`, not `decided`.
    expect(m.decisions).toEqual([
      { address: "decision:q1", label: "decided in chat", status: "settled", updatedAt: "2026-09-08T10:00:00Z" },
    ]);
    // The user's answer to the SAME id is ground truth over the agent's resolution.
    const both = mergePage(resolved, { q1: { text: "no — keep it", at: "2026-09-08T11:00:00Z", sentAt: "2026-09-08T11:00:00Z" } }, []);
    expect(both.settledQuestions).toEqual([{ question: resolved.questions[0], answer: "no — keep it", at: "2026-09-08T11:00:00Z", by: "user" }]);
    expect(both.decisions.map((d) => [d.label, d.status])).toEqual([["no — keep it", "decided"]]);
  });

  it("To do is EVERY open item, the ones waiting on the user FIRST (SWIT-77 — Needs you retired on the page); userItems stays Home's subset; done folded", () => {
    const merged = mergePage(page, {}, []);
    expect(merged.userItems.map((i) => i.id)).toEqual(["i2"]);
    expect(merged.openItems.map((i) => i.id)).toEqual(["i2", "i1"]);
    expect(merged.doneItems.map((i) => i.id)).toEqual(["i3"]);
    expect(merged.doneFolded).toBe(0);
    // A `waiting` item is waiting ON THE USER, whoever owns it — first in To do, and in Home's list.
    const waiting = parsePageFile(
      JSON.stringify({
        items: [
          { id: "a1", title: "t", owner: "agent", state: "todo" },
          { id: "w1", title: "t", owner: "agent", state: "waiting" },
        ],
      })
    );
    const m2 = mergePage(waiting, {}, []);
    expect(m2.userItems.map((i) => i.id)).toEqual(["w1"]);
    expect(m2.openItems.map((i) => i.id)).toEqual(["w1", "a1"]);
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

  it("answer notes: only success collapses the form; an error — a failed save OR a failed send — keeps it (review F1, SWIT-77)", () => {
    expect(answerSuccessNote()).toEqual({ kind: "success", text: "saved · send from the page" });
    expect(answerErrorNote(new Error("disk full"))).toEqual({ kind: "error", text: "could not save: disk full" });
    expect(answerErrorNote("nope").text).toBe("could not save: nope");
    expect(sendErrorNote(new Error("thread not live"))).toEqual({ kind: "error", text: "not sent — thread not live" });
    expect(noteReplacesForm(answerSuccessNote())).toBe(true);
    expect(noteReplacesForm(answerErrorNote(new Error("x")))).toBe(false);
    expect(noteReplacesForm(sendErrorNote(new Error("x")))).toBe(false); // the form stays; the answers stay unsent
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

describe("the findings ledger (SWIT-106)", () => {
  const ROW = { id: "f1", claim: "Debt by 02:00 predicts the Europe-open block", verdict: "lead", n: "264 nights", report: "view:model4-debt", updatedAt: "2026-09-29T02:41:00Z" };

  it("parses a well-formed ledger; the merge sorts it newest first by updatedAt", () => {
    const p = parsePageFile(
      JSON.stringify({ findings: [ROW, { id: "f2", claim: "Charm dominates quiet nights", verdict: "open", n: 4, report: null, updatedAt: "2026-09-30T09:00:00Z" }] })
    );
    expect(p.findings).toEqual([ROW, { id: "f2", claim: "Charm dominates quiet nights", verdict: "open", n: "4", report: null, updatedAt: "2026-09-30T09:00:00Z" }]);
    expect(mergePage(p, {}, []).findings.map((f) => f.id)).toEqual(["f2", "f1"]);
    expect(mergePage(parsePageFile(JSON.stringify({ findings: [ROW] })), {}, []).isEmpty).toBe(false);
    expect(mergePage(EMPTY_PAGE, {}, []).findings).toEqual([]);
  });

  it("a malformed entry drops ALONE — no id, no claim, an unknown verdict, a repeat; fields are cut to the caps; not an array → none", () => {
    const p = parsePageFile(
      JSON.stringify({
        ...PAGE,
        findings: [
          ROW,
          { claim: "no id", verdict: "open" },
          { id: "f3", verdict: "open" },
          { id: "f4", claim: "maybe", verdict: "maybe" },
          { id: "f1", claim: "dup", verdict: "dead" },
          null,
          { id: "f5", claim: ` ${"c".repeat(FINDING_CLAIM_CAP + 9)} `, verdict: "dead", n: "n".repeat(FINDING_N_CAP + 5), report: "r".repeat(FINDING_REPORT_CAP + 5) },
        ],
      })
    );
    expect(p.findings.map((f) => f.id)).toEqual(["f1", "f5"]);
    expect(p.findings[1]).toMatchObject({ claim: "c".repeat(FINDING_CLAIM_CAP), n: "n".repeat(FINDING_N_CAP), report: "r".repeat(FINDING_REPORT_CAP), updatedAt: "" });
    expect(p.theme).toBe(PAGE.theme); // the rest of the page is untouched
    expect(parseFindings({ f1: ROW })).toEqual([]);
    expect(parseFindings(Array.from({ length: FINDING_CAP + 5 }, (_, i) => ({ ...ROW, id: `f${i}` })))).toHaveLength(FINDING_CAP);
  });

  it("the verdict pill tone: lead = the accent, fact = neutral, open = amber, dead = dim — not statusTone's reading of `open`", () => {
    expect(FINDING_VERDICTS.map((v) => [v, verdictTone(v)])).toEqual([
      ["lead", "green"],
      ["open", "amber"],
      ["fact", "neutral"],
      ["dead", "dim"],
    ]);
    expect(statusTone("open")).toBe("blue"); // why the verdict has its own rule
  });

  it("the old `finding:<id>` evidence form still reads as an ordinary row", () => {
    expect(evidenceKindOf("finding:gamma-1")).toBe("other");
  });
});

describe("a dismissed question (SWIT-105)", () => {
  const ASKED = "2026-09-30T10:00:00.000Z";
  const qs = parsePageFile(
    JSON.stringify({
      questions: [
        { id: "q1", text: "A?", askedAt: ASKED },
        { id: "q2", text: "B?", askedAt: ASKED },
        { id: "q3", text: "C?", askedAt: ASKED, answer: "moot", answeredAt: "2026-09-30T10:30:00Z" },
      ],
    })
  );
  const gone = (id: string, at: string): RetractedEvidence => ({ address: questionAddress(id), at });

  it("questionAddress / questionDismissedAt: dismissed until a re-ask NEWER (by a whole second) than the dismissal", () => {
    expect(questionAddress("q1")).toBe("question:q1");
    expect(QUESTION_ADDRESS_PREFIX).toBe("question:");
    const q = { id: "q1", askedAt: ASKED };
    expect(questionDismissedAt(q, [])).toBeNull();
    expect(questionDismissedAt(q, [gone("q1", "2026-09-30T11:00:00Z")])).toBe("2026-09-30T11:00:00Z");
    expect(questionDismissedAt(q, [gone("q1", "2026-09-30T10:00:00.900Z")])).not.toBeNull(); // same second
    expect(questionDismissedAt({ id: "q1", askedAt: "2026-09-30T12:00:00Z" }, [gone("q1", "2026-09-30T11:00:00Z")])).toBeNull(); // re-asked
    expect(questionDismissedAt({ id: "q1", askedAt: "" }, [gone("q1", "2026-09-30T11:00:00Z")])).not.toBeNull(); // unparseable stays dismissed
    expect(questionDismissedAt(q, [gone("q2", "2026-09-30T11:00:00Z"), { address: "q1", at: "2026-09-30T11:00:00Z" }])).toBeNull();
  });

  it("isQuestionOpen / countQuestionStates honour it; with no retractions nothing changes", () => {
    const r = [gone("q1", "2026-09-30T11:00:00Z")];
    expect(isQuestionOpen(qs.questions[0], {}, r)).toBe(false);
    expect(isQuestionOpen(qs.questions[0], {})).toBe(true);
    expect(countQuestionStates(qs.questions, {}, r)).toEqual({ open: 1, unsent: 0 });
    expect(countQuestionStates(qs.questions, {})).toEqual({ open: 2, unsent: 0 });
  });

  it("the merge takes it out of Open questions, the batch and Home's list, and lists it under dismissedQuestions — never a decision", () => {
    const m = mergePage(qs, {}, [], [gone("q1", "2026-09-30T11:00:00Z"), gone("q3", "2026-09-30T11:00:00Z")]);
    expect(m.openQuestions.map((q) => q.id)).toEqual(["q2"]);
    expect(m.decisionQuestions.map((q) => q.id)).toEqual(["q2"]);
    // q3 was SETTLED — an answer outranks a dismissal; it stays a decision.
    expect(m.dismissedQuestions).toEqual([{ question: qs.questions[0], at: "2026-09-30T11:00:00Z" }]);
    expect(m.decisions.map((d) => d.address)).toEqual(["decision:q3"]);
    expect(m.evidence.some((e) => e.address.startsWith(QUESTION_ADDRESS_PREFIX))).toBe(false);
    // A user answer to a dismissed question wins too (it is answered, not dismissed).
    const answered = mergePage(qs, { q1: { text: "yes", at: "2026-09-30T12:00:00Z" } }, [], [gone("q1", "2026-09-30T11:00:00Z")]);
    expect(answered.dismissedQuestions).toEqual([]);
    expect(answered.unsentDecisions.map((a) => a.question.id)).toEqual(["q1"]);
    // No retractions: the pre-SWIT-105 merge.
    expect(mergePage(qs, {}, []).dismissedQuestions).toEqual([]);
  });

  it("dismissErrorNote keeps the card: an error note, never a success", () => {
    expect(dismissErrorNote(new Error("disk full"))).toEqual({ kind: "error", text: "not dismissed — disk full" });
    expect(noteReplacesForm(dismissErrorNote("x"))).toBe(false);
  });
});

describe("the standing brief (SWIT-104)", () => {
  const BRIEF = {
    goal: "A gamma measure of our own that a discretionary trader can lean on live.",
    established: ["all-expiry sum is about 0.58 of the vendor total"],
    dead: ["level effects beyond price motion"],
    lead: ["overnight hedging debt vs the Europe open"],
    waiting: ["the book", "the state variable"],
    updatedAt: "2026-09-29T18:00:00.000Z",
  };

  it("parses a well-formed brief onto the page, and the merge carries it", () => {
    const p = parsePageFile(JSON.stringify({ brief: BRIEF }));
    expect(p.brief).toEqual(BRIEF);
    const merged = mergePage(p, {}, []);
    expect(merged.brief).toEqual(BRIEF);
    // A page holding ONLY a brief is not the empty page.
    expect(merged.isEmpty).toBe(false);
    expect(mergePage(EMPTY_PAGE, {}, []).brief).toBeNull();
  });

  it("a malformed brief is ABSENT, never a broken page — the rest still parses", () => {
    for (const junk of [null, 7, "a brief", ["a", "list"], {}, { goal: "", dead: [] }, { goal: 9, established: "not a list", updatedAt: "t" }]) {
      const p = parsePageFile(JSON.stringify({ ...PAGE, brief: junk }));
      expect(p.brief).toBeNull();
      expect(p.theme).toBe(PAGE.theme);
      expect(p.items).toHaveLength(3);
    }
    expect(parseBrief(undefined)).toBeNull();
  });

  it("a malformed LINE drops alone; caps are applied on the way in", () => {
    const b = parseBrief({
      goal: `  ${"g".repeat(BRIEF_GOAL_CAP + 40)}  `,
      established: ["kept", 4, null, "   ", "  trimmed  ", "l".repeat(BRIEF_LINE_CAP + 10)],
      dead: Array.from({ length: BRIEF_LINES_CAP + 3 }, (_, i) => `d${i}`),
      lead: "not an array",
      extra: "ignored",
    })!;
    expect(b.goal).toBe("g".repeat(BRIEF_GOAL_CAP));
    expect(b.established).toEqual(["kept", "trimmed", "l".repeat(BRIEF_LINE_CAP)]);
    expect(b.dead).toHaveLength(BRIEF_LINES_CAP);
    expect(b.dead[0]).toBe("d0");
    expect(b.lead).toEqual([]);
    expect(b.waiting).toEqual([]);
    expect(b.updatedAt).toBe(""); // no stamp — the block prints no age
    expect("extra" in b).toBe(false);
  });

  it("briefSections: the non-empty lists, in page order, with the words the page prints", () => {
    expect(briefSections(parseBrief(BRIEF)!)).toEqual([
      { key: "established", label: "Established", lines: BRIEF.established },
      { key: "dead", label: "Dead", lines: BRIEF.dead },
      { key: "lead", label: "Live lead", lines: BRIEF.lead },
      { key: "waiting", label: "Waiting on you", lines: BRIEF.waiting },
    ]);
    expect(briefSections(parseBrief({ goal: "g", waiting: ["w"] })!)).toEqual([{ key: "waiting", label: "Waiting on you", lines: ["w"] }]);
    expect(briefSections(parseBrief({ goal: "only a goal" })!)).toEqual([]);
    expect(BRIEF_LISTS.map((l) => l.key)).toEqual(["established", "dead", "lead", "waiting"]);
  });
});

describe("the correctable record (SWIT-78)", () => {
  const T0 = "2026-09-08T10:00:00Z";
  const T1 = "2026-09-08T11:00:00Z";
  const T2 = "2026-09-08T12:00:00Z";

  it("parseRetractedFile is tolerant: the {version, evidence} shape or a bare array; junk drops alone; first entry per address; capped", () => {
    expect(parseRetractedFile("")).toEqual([]);
    expect(parseRetractedFile("{not json")).toEqual([]);
    expect(parseRetractedFile("42")).toEqual([]);
    expect(
      parseRetractedFile(
        JSON.stringify({
          version: 1,
          evidence: [
            { address: "SWIT-1", at: T1 },
            "junk",
            { at: "no address" },
            { address: "" },
            { address: "docs/a.md" }, // no stamp → "" (never newer than a row)
            { address: "SWIT-1", at: T0 }, // repeat → the FIRST (newest-first file) wins
          ],
        })
      )
    ).toEqual([
      { address: "SWIT-1", at: T1 },
      { address: "docs/a.md", at: "" },
    ]);
    expect(parseRetractedFile(JSON.stringify([{ address: "x", at: T0 }]))).toEqual([{ address: "x", at: T0 }]);
    const many = Array.from({ length: RETRACTED_CAP + 5 }, (_, i) => ({ address: `A-${i}`, at: T0 }));
    expect(parseRetractedFile(JSON.stringify({ evidence: many }))).toHaveLength(RETRACTED_CAP);
  });

  it("isRetracted: an agent row is hidden unless its updatedAt is NEWER than the retraction; a scanned row (no stamp) is hidden by address alone", () => {
    const retracted: RetractedEvidence[] = [{ address: "SWIT-1", at: T1 }];
    expect(isRetracted("SWIT-2", T2, retracted)).toBe(false); // not retracted at all
    expect(isRetracted("SWIT-1", T0, retracted)).toBe(true); // older row → hidden
    expect(isRetracted("SWIT-1", T1, retracted)).toBe(true); // same second → still hidden (must be demonstrably newer)
    expect(isRetracted("SWIT-1", T2, retracted)).toBe(false); // the agent re-posted → back
    expect(isRetracted("SWIT-1", null, retracted)).toBe(true); // scanned: the address decides
    // Unparseable stamps on either side = NOT newer: the retraction stands.
    expect(isRetracted("SWIT-1", "yesterday", retracted)).toBe(true);
    expect(isRetracted("SWIT-1", T2, [{ address: "SWIT-1", at: "" }])).toBe(true);
    expect(isRetracted("SWIT-1", T2, [])).toBe(false);
  });

  it("isRetracted compares at SECOND precision: a ms updatedAt inside the retraction's second is NOT newer (review fix F1)", () => {
    // The server stamps ms; retracted.json written before the review stamps seconds.
    const retracted: RetractedEvidence[] = [{ address: "SWIT-1", at: "2026-09-08T10:00:00Z" }];
    expect(isRetracted("SWIT-1", "2026-09-08T10:00:00.500Z", retracted)).toBe(true); // same second → hidden
    expect(isRetracted("SWIT-1", "2026-09-08T10:00:00.999Z", retracted)).toBe(true);
    expect(isRetracted("SWIT-1", "2026-09-08T10:00:01.000Z", retracted)).toBe(false); // the next second → re-posted
    // And the other way round, once Rust stamps ms too.
    const msRetracted: RetractedEvidence[] = [{ address: "SWIT-1", at: "2026-09-08T10:00:00.700Z" }];
    expect(isRetracted("SWIT-1", "2026-09-08T10:00:00.900Z", msRetracted)).toBe(true);
    expect(isRetracted("SWIT-1", "2026-09-08T10:00:00Z", msRetracted)).toBe(true);
    expect(isRetracted("SWIT-1", "2026-09-08T10:00:01Z", msRetracted)).toBe(false);
  });

  it("a decision: address is never retracted, whatever retracted.json says (review fix F3 — the merge side)", () => {
    const retracted: RetractedEvidence[] = [{ address: "decision:q1", at: T2 }];
    expect(isRetracted("decision:q1", T0, retracted)).toBe(false);
    expect(isRetracted("decision:q1", null, retracted)).toBe(false);
    const rows = [{ address: "decision:q1", label: "yes", status: "decided", updatedAt: T0 }];
    expect(applyRetractions(rows, retracted)).toBe(rows);
  });

  it("applyRetractions returns the SAME array when nothing hides (the no-re-render contract)", () => {
    const rows = [
      { address: "SWIT-1", label: "a", status: null, updatedAt: T2 },
      { address: "SWIT-2", label: "b", status: null, updatedAt: T0 },
    ];
    expect(applyRetractions(rows, [])).toBe(rows);
    expect(applyRetractions(rows, [{ address: "SWIT-9", at: T1 }])).toBe(rows);
    expect(applyRetractions(rows, [{ address: "SWIT-1", at: T1 }])).toBe(rows); // newer than the retraction
    expect(applyRetractions(rows, [{ address: "SWIT-2", at: T1 }]).map((r) => r.address)).toEqual(["SWIT-1"]);
  });

  it("mergePage folds the retractions out of the agent's rows and carries them for the post-merge union; decision rows are never retracted", () => {
    const page = parsePageFile(
      JSON.stringify({
        evidence: [
          { address: "SWIT-1", label: "wrong ticket", status: "open", updatedAt: T0 },
          { address: "SWIT-2", label: "right ticket", status: "open", updatedAt: T0 },
          { address: "SWIT-3", label: "re-posted", status: "open", updatedAt: T2 },
        ],
        questions: [{ id: "q1", text: "Q?", askedAt: T0 }],
      })
    );
    const retracted: RetractedEvidence[] = [
      { address: "SWIT-1", at: T1 },
      { address: "SWIT-3", at: T1 },
      { address: "decision:q1", at: T2 },
    ];
    const merged = mergePage(page, { q1: { text: "yes", at: T1 } }, [], retracted);
    expect(merged.evidence.map((e) => e.address)).toEqual(["SWIT-3", "decision:q1", "SWIT-2"]);
    expect(merged.retractedEvidence).toBe(retracted);
    // The default (no fourth argument) hides nothing (the merge still orders newest first).
    expect(mergePage(page, {}, []).evidence.map((e) => e.address)).toEqual(["SWIT-3", "SWIT-1", "SWIT-2"]);
    expect(mergePage(page, {}, []).retractedEvidence).toEqual([]);
  });

  it("dropped items leave the live list everywhere — To do, userItems (Home), Done — and land in droppedItems; closedAt parses", () => {
    const page = parsePageFile(
      JSON.stringify({
        items: [
          { id: "i1", title: "live", owner: "agent", state: "todo" },
          { id: "i2", title: "waiting on you but dropped", owner: "user", state: "dropped", closedAt: T1 },
          { id: "i3", title: "done", owner: "agent", state: "done", closedAt: T1 },
          { id: "i4", title: "dropped, no stamp", owner: "agent", state: "dropped" },
          { id: "i5", title: "waiting on you", owner: "user", state: "todo" },
        ],
      })
    );
    expect(page.items.map((i) => i.state)).toEqual(["todo", "dropped", "done", "dropped", "todo"]);
    expect(page.items[1].closedAt).toBe(T1);
    expect(page.items[3].closedAt).toBeNull();
    expect(page.items[0].closedAt).toBeNull();
    const merged = mergePage(page, {}, []);
    expect(merged.openItems.map((i) => i.id)).toEqual(["i5", "i1"]);
    expect(merged.userItems.map((i) => i.id)).toEqual(["i5"]); // i2 is dropped — Home never lists it
    expect(merged.doneItems.map((i) => i.id)).toEqual(["i3"]); // a drop is not an accomplishment
    expect(merged.droppedItems.map((i) => i.id)).toEqual(["i2", "i4"]);
    expect(merged.doneFolded).toBe(0);
    expect(isOpenItem({ state: "dropped" })).toBe(false);
    expect(isOpenItem({ state: "done" })).toBe(false);
    expect(isOpenItem({ state: "waiting" })).toBe(true);
    // An unknown state still degrades to todo, never to dropped.
    expect(parsePageFile(JSON.stringify({ items: [{ id: "x", title: "t", state: "gone" }] })).items[0].state).toBe("todo");
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

  it("postTimes drops junk; countUnreadTimes is the same rule over parsed times", () => {
    const times = postTimes([post("1", "2026-08-31T10:00:00Z"), post("2", "junk"), post("3", "2026-08-31T08:00:00Z")]);
    expect(times).toEqual([Date.parse("2026-08-31T10:00:00Z"), Date.parse("2026-08-31T08:00:00Z")]);
    expect(countUnreadTimes(times, null)).toBe(2);
    expect(countUnreadTimes(times, Date.parse("2026-08-31T09:00:00Z"))).toBe(1);
    expect(countUnreadTimes([], null)).toBe(0);
  });
});

describe("nextPassEntry (the stamp gate's cached branch, 0.9.x hygiene review fix)", () => {
  const T1 = Date.parse("2026-09-06T10:00:00Z");
  const T2 = Date.parse("2026-09-06T10:05:00Z");
  const cached = { stamp: 1_700_000, questions: 1, unsent: 2, postsAt: [T1, T2] };

  it("re-reads with no entry, a failed stat, or a moved stamp", () => {
    expect(nextPassEntry(undefined, 1_700_000, null)).toEqual({ reread: true });
    expect(nextPassEntry(cached, -1, null)).toEqual({ reread: true });
    expect(nextPassEntry({ ...cached, stamp: -1 }, -1, null)).toEqual({ reread: true });
    expect(nextPassEntry(cached, 1_700_001, null)).toEqual({ reread: true });
  });

  it("an unchanged stamp republishes the question count and re-derives unread from the stamp NOW", () => {
    // Thread B shows `↓ 2`; Eric opens B (seen), clicks back to A inside the
    // same tick; inbox.json's mtime has not moved. The next tick must say 0,
    // not republish the count the entry was read with.
    expect(nextPassEntry(cached, 1_700_000, null)).toEqual({ reread: false, questions: 1, unsent: 2, unread: 2 });
    const seenAfterOpeningB = T2 + 1_000;
    expect(nextPassEntry(cached, 1_700_000, seenAfterOpeningB)).toEqual({ reread: false, questions: 1, unsent: 2, unread: 0 });
    // A post newer than the stamp still counts — the stamp is a moment, not a reset.
    expect(nextPassEntry(cached, 1_700_000, T1 + 1)).toEqual({ reread: false, questions: 1, unsent: 2, unread: 1 });
  });
});

describe("review of c178f2f — the keyboard `not needed` hand-off and Home's dismissal note", () => {
  it("#5 — focus goes to the NEXT card still on the page, else the previous, else null (Send) — by id, whether or not the dismissed card has left yet", () => {
    const atClick = ["q1", "q2", "q3"];
    expect(neighbourAfterDismiss(atClick, "q2", ["q1", "q2", "q3"])).toBe("q3"); // the card has not left yet
    expect(neighbourAfterDismiss(atClick, "q2", ["q1", "q3"])).toBe("q3"); // it has — no off-by-one
    expect(neighbourAfterDismiss(atClick, "q3", ["q1", "q2", "q3"])).toBe("q2"); // the last card → the one before
    expect(neighbourAfterDismiss(atClick, "q2", ["q1"])).toBe("q1"); // the next one went too
    expect(neighbourAfterDismiss(["q1"], "q1", ["q1"])).toBeNull(); // the only card → Send
    expect(neighbourAfterDismiss(atClick, "zz", atClick)).toBeNull();
  });

  it("nit — Home's `not needed` saved note replaces the card's form (a success)", () => {
    expect(dismissSuccessNote()).toEqual({ kind: "success", text: "not needed · off the page" });
    expect(noteReplacesFormForDismiss(dismissSuccessNote())).toBe(true);
  });
});
