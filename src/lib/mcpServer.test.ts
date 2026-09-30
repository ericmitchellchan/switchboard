// Switchboard's MCP server (SWIT-49) — the pure core, loaded straight from
// the shipped .cjs resource (createRequire): op semantics, caps as visible
// errors, evidence upsert-by-address — and the ROUND-TRIP seam test: every
// shape the server writes must parse through pageStore, because the rendered
// page is pageStore's merge of the file this server is the sole writer of.

import { describe, it, expect } from "vitest";
// @ts-expect-error — no @types/node in the frontend tsconfig; vitest's node
// runtime provides the real module, and the require result is cast below.
import { createRequire } from "node:module";
import {
  parsePageFile,
  mergePage,
  BRIEF_GOAL_CAP,
  BRIEF_LINE_CAP,
  BRIEF_LINES_CAP,
  FINDING_VERDICTS,
  FINDING_CAP,
  FINDING_CLAIM_CAP,
  FINDING_N_CAP,
  FINDING_REPORT_CAP,
} from "./pageStore";
import { parseViewSpec } from "./viewStore";
import { parseInboxFile } from "./pageStore";
import { parseBacklogInbox } from "./backlogStore";
import { parseJobsInbox, deriveJobState, JOB_LOG_LINES_MAX } from "./jobs";
import { parseSetsFile } from "./artifactSets";
import { parseShowsFile, showTargetFor, SHOW_CAP, SHOW_ADDRESS_CAP } from "./showIntent";
import { parseSurfaceQuery } from "./surfaceParams";
import { projectViewAddress } from "./evidenceModel";
import { PROJECT_VIEW_INDEX_CAP } from "./repoListing";
import { QUESTION_KEEP_CAP } from "./pageStore";
// Source text of the two loopback predicates, for the byte-identical check.
import viewStoreSource from "./viewStore.ts?raw";
import mcpServerSource from "../../src-tauri/resources/mcp/switchboard-mcp.cjs?raw";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require("../../src-tauri/resources/mcp/switchboard-mcp.cjs") as {
  parsePage: (raw: string) => Record<string, unknown>;
  applyOp: (
    page: Record<string, unknown>,
    args: Record<string, unknown>,
    now: number,
    answeredIds?: Set<string>
  ) => { page: Record<string, unknown>; message: string };
  buildViewSpec: (
    args: Record<string, unknown>,
    existingIds: string[],
    now: number
  ) => Record<string, unknown>;
  isLocalBackendUrl: (url: string) => boolean;
  PAGE_TOOL: { name: string; description: string; inputSchema: unknown };
  VIEW_TOOL: { name: string; description: string; inputSchema: unknown };
  OpError: new (message: string) => Error;
  QUESTION_KINDS: string[];
  NO_NOTE: string;
  DROP_EVIDENCE_CAP: number;
  WHY_CAP: number;
  TURN_CAP: number;
  TURN_LINE_CAP: number;
  EVIDENCE_CAP: number;
  QUESTION_CAP: number;
  VIEW_LEVEL_CAP: number;
  BAR_TONES: string[];
  TABLE_TONE_KINDS: string[];
  TABLE_TONES_CAP: number;
  TABLE_TONE_COLUMN_CAP: number;
};

const NOW = Date.parse("2026-08-31T10:00:00Z");
const empty = () => server.parsePage("");

function run(ops: Array<Record<string, unknown>>): Record<string, unknown> {
  let page = empty();
  for (const op of ops) page = server.applyOp(page, op, NOW).page;
  return page;
}

describe("applyOp semantics", () => {
  it("theme / turn / evidence / ask / item all write their sections", () => {
    const page = run([
      { op: "theme", text: "The theme" },
      { op: "turn", lines: ["Did a thing.", "It worked."] },
      { op: "evidence", address: "SWIT-49", label: "the server", status: "open" },
      { op: "ask", text: "Ship it?", options: ["yes", "no"] },
      { op: "item", itemOp: "add", title: "Publish anchors" },
    ]);
    expect(page.theme).toBe("The theme");
    expect(page.turns).toHaveLength(1);
    expect(page.evidence).toHaveLength(1);
    expect(page.questions).toHaveLength(1);
    expect(page.items).toHaveLength(1);
  });

  it("evidence upserts by address: the row UPDATES and moves to the top; omitted status keeps the old", () => {
    const page = run([
      { op: "evidence", address: "A", label: "first", status: "open" },
      { op: "evidence", address: "B", label: "second", status: "draft" },
      { op: "evidence", address: "A", label: "renamed" }, // no status
    ]);
    const evidence = page.evidence as Array<Record<string, unknown>>;
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({ address: "A", label: "renamed", status: "open" });
    expect(evidence[1]).toMatchObject({ address: "B" });
  });

  it("a turn beyond the line cap keeps the first lines and SAYS so", () => {
    const { page, message } = server.applyOp(
      empty(),
      { op: "turn", lines: Array.from({ length: 10 }, (_, i) => `line ${i}`) },
      NOW
    );
    const turns = page.turns as Array<{ lines: string[] }>;
    expect(turns[0].lines).toHaveLength(server.TURN_LINE_CAP);
    expect(message).toContain(`first ${server.TURN_LINE_CAP} lines`);
  });

  it("turns cap at TURN_CAP, newest first", () => {
    let page = empty();
    for (let i = 0; i < server.TURN_CAP + 5; i++) {
      page = server.applyOp(page, { op: "turn", lines: [`turn ${i}`] }, NOW).page;
    }
    const turns = page.turns as Array<{ lines: string[] }>;
    expect(turns).toHaveLength(server.TURN_CAP);
    expect(turns[0].lines[0]).toBe(`turn ${server.TURN_CAP + 4}`);
  });

  it("asking beyond the question cap is a VISIBLE error; re-asking an OPEN id SUPERSEDES; an answered id refuses", () => {
    let page = empty();
    for (let i = 0; i < server.QUESTION_CAP; i++) {
      page = server.applyOp(page, { op: "ask", text: `q ${i}` }, NOW).page;
    }
    expect(() => server.applyOp(page, { op: "ask", text: "one more" }, NOW)).toThrow(/already OPEN/);
    // The cap counts OPEN questions (review): answered ids unblock asking.
    const answered = new Set(["q1", "q2", "q3"]);
    const unblocked = server.applyOp(page, { op: "ask", text: "one more" }, NOW, answered);
    expect((unblocked.page.questions as unknown[]).length).toBe(server.QUESTION_CAP + 1);
    // SWIT-67: the same OPEN id asked again replaces the question in place —
    // superseded, never a duplicate row, and the cap is not consulted.
    const first = server.applyOp(empty(), { op: "ask", id: "q1", text: "t", options: ["a", "b"] }, NOW).page;
    const re = server.applyOp(first, { op: "ask", id: "q1", text: "again", options: ["c"] }, NOW);
    const qs = re.page.questions as Array<Record<string, unknown>>;
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ id: "q1", text: "again", options: ["c"] });
    expect(re.message).toContain("superseded");
    // An ANSWERED id refuses and points at the decision row.
    expect(() =>
      server.applyOp(first, { op: "ask", id: "q1", text: "again" }, NOW, new Set(["q1"]))
    ).toThrow(/decision:q1/);
  });

  it("an ask option beyond 60 chars is TRIMMED at a word boundary with …, and the result says which (SWIT-105; was a refusal, SWIT-69)", () => {
    const trim = (server as unknown as { trimOption: (o: string) => string; OPTION_CAP: number });
    expect(trim.OPTION_CAP).toBe(60);
    const long = "Release model on Model 4 debt, run against the whole forward stream";
    const { page, message } = server.applyOp(
      empty(),
      { op: "ask", text: "Which?", options: ["ok", long], default: long },
      NOW
    );
    const q = (page.questions as Array<Record<string, unknown>>)[0];
    const cut = (q.options as string[])[1];
    expect(cut).toBe("Release model on Model 4 debt, run against the whole…");
    expect(cut.length).toBeLessThanOrEqual(60);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    // The default names the option by its FULL text — matched after trimming.
    expect(q.default).toBe(cut);
    expect(message).toContain(`Trimmed 1 option to 60 chars: "${cut}"`);
    // An option at the cap is untouched, and the result carries no note.
    const exact = server.applyOp(empty(), { op: "ask", text: "Which?", options: ["x".repeat(60)] }, NOW);
    expect((exact.page.questions as Array<{ options: string[] }>)[0].options).toEqual(["x".repeat(60)]);
    expect(exact.message).not.toContain("Trimmed");
    // One unbroken word is cut hard, still ≤ 60 with the ellipsis.
    expect(trim.trimOption("y".repeat(90))).toBe(`${"y".repeat(59)}…`);
    // Two options that read the same once trimmed are a VISIBLE error.
    const twin = "a ".repeat(40);
    expect(() =>
      server.applyOp(empty(), { op: "ask", text: "Which?", options: [`${twin}one`, `${twin}two`] }, NOW)
    ).toThrow(/read the same once trimmed/);
    // A default that is none of the options, trimmed or not, still refuses.
    expect(() =>
      server.applyOp(empty(), { op: "ask", text: "Which?", options: ["ok", long], default: "z".repeat(80) }, NOW)
    ).toThrow(/default must be one of the options/);
  });

  it("a turn's reviewFirst is validated like an address, stored on the turn, and round-trips (SWIT-67)", () => {
    const { page } = server.applyOp(
      empty(),
      { op: "turn", lines: ["Did a thing."], reviewFirst: " surface:lodestar/trading?instrument=NQ " },
      NOW
    );
    const turns = page.turns as Array<Record<string, unknown>>;
    expect(turns[0].reviewFirst).toBe("surface:lodestar/trading?instrument=NQ");
    // Absent = absent, not null.
    const bare = server.applyOp(empty(), { op: "turn", lines: ["t"] }, NOW).page;
    expect("reviewFirst" in (bare.turns as Array<Record<string, unknown>>)[0]).toBe(false);
    expect(() =>
      server.applyOp(empty(), { op: "turn", lines: ["t"], reviewFirst: "" }, NOW)
    ).toThrow(/reviewFirst/);
    expect(() =>
      server.applyOp(empty(), { op: "turn", lines: ["t"], reviewFirst: "x".repeat(301) }, NOW)
    ).toThrow(/cap is 300/);
    // ROUND-TRIP: pageStore reads it back onto the latest turn.
    const parsed = parsePageFile(JSON.stringify(page));
    expect(parsed.turns[0].reviewFirst).toBe("surface:lodestar/trading?instrument=NQ");
    expect(mergePage(parsed, {}, []).latestTurn?.reviewFirst).toBe(
      "surface:lodestar/trading?instrument=NQ"
    );
  });

  it("items: add mints sequential ids; update and close by id; unknown id errors", () => {
    let page = run([
      { op: "item", itemOp: "add", title: "one" },
      { op: "item", itemOp: "add", title: "two", owner: "user" },
    ]);
    let items = page.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toEqual(["i1", "i2"]);
    page = server.applyOp(page, { op: "item", itemOp: "update", id: "i1", state: "in_progress" }, NOW).page;
    page = server.applyOp(page, { op: "item", itemOp: "close", id: "i2" }, NOW).page;
    items = page.items as Array<Record<string, unknown>>;
    expect(items[0].state).toBe("in_progress");
    expect(items[1].state).toBe("done");
    expect(() => server.applyOp(page, { op: "item", itemOp: "close", id: "i9" }, NOW)).toThrow(/no item/);
  });

  it("ask carries kind (default decision) and a default that must be one of the options (SWIT-58)", () => {
    expect(server.QUESTION_KINDS).toEqual(["decision", "convention", "info"]);
    const plain = server.applyOp(empty(), { op: "ask", text: "Which?", options: ["a", "b"] }, NOW);
    const q0 = (plain.page.questions as Array<Record<string, unknown>>)[0];
    expect(q0.kind).toBe("decision");
    expect(q0.default).toBeNull();

    const full = server.applyOp(
      empty(),
      { op: "ask", text: "Which?", options: ["a", "b"], kind: "convention", default: "b" },
      NOW
    );
    const q1 = (full.page.questions as Array<Record<string, unknown>>)[0];
    expect(q1.kind).toBe("convention");
    expect(q1.default).toBe("b");
    expect(q1.options).toEqual(["a", "b"]); // the asked order — the UI moves the default up
    expect(full.message).toContain("decision:q1");

    // Validation is VISIBLE (OpError), never a silent drop.
    expect(() =>
      server.applyOp(empty(), { op: "ask", text: "Which?", options: ["a"], kind: "whim" }, NOW)
    ).toThrow(/kind must be one of/);
    expect(() =>
      server.applyOp(empty(), { op: "ask", text: "Which?", options: ["a", "b"], default: "c" }, NOW)
    ).toThrow(/default must be one of the options/);
    expect(() => server.applyOp(empty(), { op: "ask", text: "Which?", default: "a" }, NOW)).toThrow(
      /none were given/
    );
    expect(() =>
      server.applyOp(empty(), { op: "ask", text: "Which?", options: ["a"], default: 4 }, NOW)
    ).toThrow(/default must be one of the options/);
  });

  it("ask carries why (≤ 240, a visible error beyond) and says the answers arrive as ONE message (SWIT-77)", () => {
    expect(server.WHY_CAP).toBe(240);
    const { page, message } = server.applyOp(
      empty(),
      { op: "ask", text: "Which?", options: ["a", "b"], why: "  cheapest to undo " },
      NOW
    );
    const q = (page.questions as Array<Record<string, unknown>>)[0];
    expect(q.why).toBe("cheapest to undo");
    expect(message).toContain("Decisions:");
    expect(message).toContain("still open");
    expect((server.applyOp(empty(), { op: "ask", text: "Which?" }, NOW).page.questions as Array<Record<string, unknown>>)[0].why).toBeNull();
    expect(() =>
      server.applyOp(empty(), { op: "ask", text: "Which?", options: ["a"], why: "w".repeat(241) }, NOW)
    ).toThrow(/cap is 240/);
    expect(() => server.applyOp(empty(), { op: "ask", text: "Which?", why: "   " }, NOW)).toThrow(/why must be/);
  });

  it("resolve settles a question the agent closed: answer + answeredAt + resolvedBy agent; unknown / user-answered ids refuse (SWIT-77)", () => {
    const asked = run([
      { op: "ask", id: "q1", text: "A?", options: ["x"] },
      { op: "ask", id: "q2", text: "B?" },
    ]);
    const { page, message } = server.applyOp(asked, { op: "resolve", id: "q1", answer: " decided in chat " }, NOW);
    const q1 = (page.questions as Array<Record<string, unknown>>).find((q) => q.id === "q1")!;
    expect(q1).toMatchObject({ answer: "decided in chat", answeredAt: new Date(NOW).toISOString(), resolvedBy: "agent" });
    expect(q1.text).toBe("A?"); // the rest of the question is untouched
    expect(message).toContain("decision:q1");
    expect(message).toContain("1 still open");
    expect(() => server.applyOp(asked, { op: "resolve", id: "q9", answer: "x" }, NOW)).toThrow(/no question with id q9/);
    expect(() => server.applyOp(asked, { op: "resolve", id: "q1" }, NOW)).toThrow(/answer must be/);
    expect(() => server.applyOp(asked, { op: "resolve", id: "q1", answer: "x" }, NOW, new Set(["q1"]))).toThrow(
      /answered by the user/
    );
    // A resolved id is SETTLED: re-asking it refuses like an answered one, and it no longer counts against the cap.
    expect(() => server.applyOp(page, { op: "ask", id: "q1", text: "again" }, NOW)).toThrow(/already settled/);
    let full = page;
    for (let i = 0; i < server.QUESTION_CAP - 1; i++) full = server.applyOp(full, { op: "ask", text: `q ${i}` }, NOW).page;
    expect(() => server.applyOp(full, { op: "ask", text: "one more" }, NOW)).toThrow(/already OPEN/);
  });

  it("item refuses a note, on add and on update, with the tidy-plan wording (SWIT-77)", () => {
    expect(server.NO_NOTE).toBe(
      "page item: items carry no note — put status in the item's state and the story in a turn (op turn)"
    );
    expect(() => server.applyOp(empty(), { op: "item", itemOp: "add", title: "t", note: "blocks R1" }, NOW)).toThrow(
      server.NO_NOTE
    );
    const added = server.applyOp(empty(), { op: "item", itemOp: "add", title: "t" }, NOW).page;
    expect(() => server.applyOp(added, { op: "item", itemOp: "update", id: "i1", note: "x" }, NOW)).toThrow(server.NO_NOTE);
    expect(() => server.applyOp(added, { op: "item", itemOp: "update", id: "i1", note: "" }, NOW)).toThrow(server.NO_NOTE);
    // A legacy note on an existing item survives an update untouched (read side tolerant).
    const legacy = server.parsePage(JSON.stringify({ items: [{ id: "i1", title: "t", owner: "agent", state: "todo", note: "old" }] }));
    const updated = server.applyOp(legacy, { op: "item", itemOp: "update", id: "i1", state: "done" }, NOW).page;
    expect((updated.items as Array<Record<string, unknown>>)[0].note).toBe("old");
    expect(parsePageFile(JSON.stringify(updated)).items[0].note).toBe("old");
  });

  it("a hand-corrupted page (nulls in the arrays) does not break ask / item add (review)", () => {
    const corrupted = server.parsePage(
      JSON.stringify({ questions: [null, { id: "q2", text: "t" }], items: [null] })
    );
    const asked = server.applyOp(corrupted, { op: "ask", text: "still works?" }, NOW);
    expect((asked.page.questions as Array<{ id?: string } | null>)[0]?.id).toBe("q3");
    const added = server.applyOp(corrupted, { op: "item", itemOp: "add", title: "t" }, NOW);
    expect((added.page.items as Array<{ id?: string } | null>).some((i) => i?.id === "i1")).toBe(true);
  });

  it("malformed input is a visible error, never a silent no-op", () => {
    expect(() => server.applyOp(empty(), { op: "theme", text: "" }, NOW)).toThrow();
    expect(() => server.applyOp(empty(), { op: "turn", lines: [] }, NOW)).toThrow();
    expect(() => server.applyOp(empty(), { op: "evidence", address: "A" }, NOW)).toThrow(); // no label
    expect(() => server.applyOp(empty(), { op: "wat" }, NOW)).toThrow(/op must be/);
    expect(() => server.applyOp(empty(), {}, NOW)).toThrow();
  });
});

describe("ROUND-TRIP: the server's writes parse through pageStore (the seam)", () => {
  it("a fully-worked page survives serialize → parsePageFile → mergePage intact", () => {
    const page = run([
      { op: "theme", text: "Give every market an anchor" },
      { op: "turn", lines: ["First turn."] },
      { op: "turn", lines: ["Second turn.", "Two lines."] },
      { op: "evidence", address: "SWIT-49", label: "the server", status: "in progress" },
      { op: "evidence", address: "switchboard #61", label: "the PR", status: "open" },
      { op: "ask", text: "Same set or per-market?", options: ["same set", "per-market"], default: "per-market", kind: "convention", why: "one file to read" },
      { op: "ask", id: "q2", text: "Keep the old keys?", options: ["yes", "no"] },
      { op: "resolve", id: "q2", answer: "moot — the keys are gone" },
      { op: "item", itemOp: "add", title: "Publish anchors", state: "in_progress" },
      { op: "item", itemOp: "add", title: "Check the pins", owner: "user" },
      { op: "item", itemOp: "add", title: "Old thing" },
      { op: "item", itemOp: "close", id: "i3" },
    ]);
    const parsed = parsePageFile(JSON.stringify(page));
    expect(parsed.theme).toBe("Give every market an anchor");
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].lines).toEqual(["Second turn.", "Two lines."]); // newest first
    expect(parsed.evidence.map((e) => e.address)).toEqual(["switchboard #61", "SWIT-49"]);
    expect(parsed.questions).toHaveLength(2);
    const q1 = parsed.questions.find((q) => q.id === "q1")!;
    expect(q1.kind).toBe("convention");
    expect(q1.defaultOption).toBe("per-market");
    expect(q1.why).toBe("one file to read");
    expect(parsed.questions.find((q) => q.id === "q2")!.resolved).toEqual({
      answer: "moot — the keys are gone",
      at: new Date(NOW).toISOString(),
      by: "agent",
    });
    expect(parsed.items).toHaveLength(3);

    // The user's answer, saved and not yet sent (SWIT-77): out of Open
    // questions, in the batch list, already a decided evidence row.
    const merged = mergePage(parsed, { q1: { text: "same set", at: "2026-08-31T10:05:00Z", resolvedBy: "user" } }, []);
    expect(merged.isEmpty).toBe(false);
    expect(merged.theme).toBe("Give every market an anchor");
    expect(merged.openQuestions).toHaveLength(0);
    expect(merged.decisionQuestions.map((q) => q.id)).toEqual(["q1"]); // q2 is settled, not in the batch
    expect(merged.unsentDecisions[0].answer.text).toBe("same set");
    expect(merged.settledQuestions).toEqual([
      { question: parsed.questions.find((q) => q.id === "q2"), answer: "moot — the keys are gone", at: new Date(NOW).toISOString(), by: "agent" },
    ]);
    // Both surface as decision rows beside the agent's rows — newest first
    // (every server op here shares NOW, so the settled row ties the agent's
    // rows and the stable sort keeps the decision rows ahead).
    expect(merged.evidence.map((e) => e.address)).toEqual(["decision:q1", "decision:q2", "switchboard #61", "SWIT-49"]);
    expect(merged.evidence[0].status).toBe("decided");
    expect(merged.evidence[1].status).toBe("settled");
    expect(merged.evidence[2].status).toBe("open");
    expect(merged.userItems.map((i) => i.title)).toEqual(["Check the pins"]);
    expect(merged.openItems.map((i) => i.title)).toEqual(["Check the pins", "Publish anchors"]); // waiting on the user first (SWIT-77)
    expect(merged.doneItems).toHaveLength(1);
    expect(merged.latestTurn?.lines[0]).toBe("Second turn.");
  });

  it("timestamps the server writes are ISO strings pageStore's dot rule can parse", () => {
    const { page } = server.applyOp(empty(), { op: "turn", lines: ["t"] }, NOW);
    const turns = page.turns as Array<{ at: string }>;
    expect(Date.parse(turns[0].at)).toBe(NOW);
  });

  it("the tool table carries the behavioural contract", () => {
    expect(server.PAGE_TOOL.name).toBe("page");
    for (const rule of [
      // SWIT-67/69 — the agent's own voice, tightened.
      "2–5 SHORT plain lines",
      "one clause each",
      "never restate what a section already shows",
      "each ≤ 60 chars",
      "name reviewFirst",
      "UPDATES its row",
      "never ask the same question twice",
      // SWIT-58 — help me help you.
      "ask only when the answer changes the work",
      "batch related questions into one",
      "propose a default",
      "decision | convention | info",
      "check Evidence for an existing decision: row BEFORE asking",
      // SWIT-77 — the batch, resolve, why, the tidy contract, no notes.
      "Answers arrive as ONE message when the user sends",
      '"still open"',
      "plus why: one line on that recommendation",
      "op resolve {id, answer}",
      "AT THE END OF EVERY TURN, resolve every question that is settled — answered in chat, decided elsewhere, or moot — or it stays open forever; the page lists the open ones",
      "TIDY THE PLAN EVERY TURN: close what finished, drop what no longer applies, retitle a row into its replacement rather than adding a second one, never file a 'later' bucket row",
      "items carry NO note",
    ]) {
      expect(server.PAGE_TOOL.description).toContain(rule);
    }
    const props = (server.PAGE_TOOL.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.kind.enum).toEqual(["decision", "convention", "info"]);
    expect(props.op.enum).toEqual(["theme", "turn", "evidence", "drop_evidence", "ask", "resolve", "item", "brief", "finding", "lane", "show", "read"]);
    expect(props.default).toBeDefined();
    expect(props.reviewFirst).toBeDefined();
    expect(props.why).toBeDefined();
    expect(props.answer).toBeDefined();
    expect(props.note).toBeUndefined(); // gone from the schema, refused by the op
  });
});

describe("the correctable record (SWIT-78 — Ky's CC-703/704)", () => {
  it("drop_evidence removes the named rows from page.json, ignores unknown addresses, and the message counts what went", () => {
    const page = run([
      { op: "evidence", address: "SWIT-1", label: "wrong", status: "open" },
      { op: "evidence", address: "SWIT-2", label: "right", status: "open" },
      { op: "evidence", address: "docs/a.md", label: "a doc" },
    ]);
    const { page: after, message } = server.applyOp(
      page,
      { op: "drop_evidence", addresses: ["SWIT-1", " docs/a.md ", "NOPE-9"] },
      NOW
    );
    expect((after.evidence as Array<{ address: string }>).map((e) => e.address)).toEqual(["SWIT-2"]);
    expect(message).toBe("Dropped 2 evidence rows.");
    expect(server.applyOp(page, { op: "drop_evidence", addresses: ["SWIT-2"] }, NOW).message).toBe("Dropped 1 evidence row.");
    expect(server.applyOp(page, { op: "drop_evidence", addresses: ["NOPE-9"] }, NOW).message).toMatch(/Dropped 0 evidence rows/);
    // The rest of the page is untouched; the dropped row simply is not there
    // for pageStore either (no "superseded" row stacked on it).
    expect(parsePageFile(JSON.stringify(after)).evidence.map((e) => e.address)).toEqual(["SWIT-2"]);
  });

  it("drop_evidence refuses an empty / missing list, a non-string address and more than the cap — visible errors", () => {
    expect(server.DROP_EVIDENCE_CAP).toBe(20);
    expect(() => server.applyOp(empty(), { op: "drop_evidence" }, NOW)).toThrow(/addresses must be a non-empty array/);
    expect(() => server.applyOp(empty(), { op: "drop_evidence", addresses: [] }, NOW)).toThrow(/addresses must be a non-empty array/);
    expect(() => server.applyOp(empty(), { op: "drop_evidence", addresses: ["", "x"] }, NOW)).toThrow(/an address must be a non-empty string/);
    const tooMany = Array.from({ length: server.DROP_EVIDENCE_CAP + 1 }, (_, i) => `A-${i}`);
    expect(() => server.applyOp(empty(), { op: "drop_evidence", addresses: tooMany }, NOW)).toThrow(/at most 20 addresses/);
    // A hand-corrupted page (nulls in evidence) does not break the drop.
    const corrupted = server.parsePage(JSON.stringify({ evidence: [null, { address: "SWIT-1", label: "x" }] }));
    expect(() => server.applyOp(corrupted, { op: "drop_evidence", addresses: ["SWIT-1"] }, NOW)).not.toThrow();
  });

  it("item drop sets state dropped (distinct from close = done); closedAt is stamped by both and cleared on reopen; the state enum cannot reach dropped", () => {
    const at = new Date(NOW).toISOString();
    let page = run([
      { op: "item", itemOp: "add", title: "one" },
      { op: "item", itemOp: "add", title: "two" },
      { op: "item", itemOp: "add", title: "three", state: "done" },
    ]);
    let items = page.items as Array<Record<string, unknown>>;
    expect(items[0].closedAt).toBeUndefined();
    expect(items[2].closedAt).toBe(at); // added as done → stamped at once
    const dropped = server.applyOp(page, { op: "item", itemOp: "drop", id: "i1" }, NOW);
    expect(dropped.message).toBe("Item i1 dropped.");
    page = server.applyOp(dropped.page, { op: "item", itemOp: "close", id: "i2" }, NOW).page;
    items = page.items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ state: "dropped", closedAt: at });
    expect(items[1]).toMatchObject({ state: "done", closedAt: at });
    // `dropped` is not a value `update` accepts: the close-vs-drop distinction is the op.
    const sneaky = server.applyOp(page, { op: "item", itemOp: "update", id: "i2", state: "dropped" }, NOW).page;
    expect((sneaky.items as Array<Record<string, unknown>>)[1].state).toBe("done");
    // Reopening clears the stamp; re-closing later re-stamps.
    const reopened = server.applyOp(page, { op: "item", itemOp: "update", id: "i2", state: "in_progress" }, NOW).page;
    expect((reopened.items as Array<Record<string, unknown>>)[1].closedAt).toBeUndefined();
    const later = server.applyOp(reopened, { op: "item", itemOp: "update", id: "i2", state: "done" }, NOW + 60_000).page;
    expect((later.items as Array<Record<string, unknown>>)[1].closedAt).toBe(new Date(NOW + 60_000).toISOString());
    // A second close of an already-closed item keeps its original stamp.
    const again = server.applyOp(later, { op: "item", itemOp: "close", id: "i2" }, NOW + 120_000).page;
    expect((again.items as Array<Record<string, unknown>>)[1].closedAt).toBe(new Date(NOW + 60_000).toISOString());
    expect(() => server.applyOp(page, { op: "item", itemOp: "drop", id: "i9" }, NOW)).toThrow(/no item/);
    expect(() => server.applyOp(page, { op: "item", itemOp: "vanish", id: "i1" }, NOW)).toThrow(/"add", "update", "close" or "drop"/);
  });

  it("ROUND-TRIP: a dropped item lands under droppedItems in the merge and nowhere else; the tool table states close vs drop", () => {
    const page = run([
      { op: "item", itemOp: "add", title: "keep", owner: "user" },
      { op: "item", itemOp: "add", title: "never the right row", owner: "user" },
      { op: "item", itemOp: "drop", id: "i2" },
    ]);
    const merged = mergePage(parsePageFile(JSON.stringify(page)), {}, []);
    expect(merged.openItems.map((i) => i.title)).toEqual(["keep"]);
    expect(merged.userItems.map((i) => i.title)).toEqual(["keep"]);
    expect(merged.doneItems).toEqual([]);
    expect(merged.droppedItems.map((i) => i.title)).toEqual(["never the right row"]);
    expect(merged.droppedItems[0].closedAt).toBe(new Date(NOW).toISOString());
    for (const rule of [
      "op drop_evidence {addresses} removes rows written against the wrong thing",
      'use it instead of a second row labelled "superseded"',
      "itemOp close = the work happened; itemOp drop = the row was never the right row",
      "dropped rows leave the live plan and stay under Dropped",
      "TIDY THE PLAN EVERY TURN: close what finished, drop what no longer applies",
    ]) {
      expect(server.PAGE_TOOL.description).toContain(rule);
    }
    const props = (server.PAGE_TOOL.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.itemOp.enum).toEqual(["add", "update", "close", "drop"]);
    expect(props.state.enum).toEqual(["todo", "in_progress", "waiting", "done"]); // dropped only through the op
    expect(props.addresses).toBeDefined();
  });
});

describe("the view tool (SWIT-50)", () => {
  const base = {
    op: "show",
    kind: "candles",
    title: "MNQ entries",
    source: { type: "file", path: "out/bars.json" },
    markers: [{ ts: "2026-08-31T10:35:00Z", label: "entry", id: "t-41" }],
  };

  it("builds a spec, minting sequential ids when none is given", () => {
    const spec = server.buildViewSpec(base, ["v1", "v3"], NOW);
    expect(spec).toMatchObject({ id: "v4", kind: "candles", builtBy: "agent" });
    expect(spec.builtAt).toBe("2026-08-31T10:00:00.000Z");
  });

  it("refuses escapes, absolute paths and non-local query urls — visibly", () => {
    const withSource = (source: Record<string, unknown>) => ({ ...base, source });
    expect(() => server.buildViewSpec(withSource({ type: "file", path: "../secrets.json" }), [], NOW)).toThrow();
    expect(() => server.buildViewSpec(withSource({ type: "file", path: "C:/Windows/x" }), [], NOW)).toThrow();
    expect(() => server.buildViewSpec(withSource({ type: "file", path: "/etc/passwd" }), [], NOW)).toThrow();
    expect(() => server.buildViewSpec(withSource({ type: "query", url: "https://evil.example/x" }), [], NOW)).toThrow(/local backend/);
    // The userinfo bypass: `localhost:1234` is a credential here and the host is evil.com.
    expect(() => server.buildViewSpec(withSource({ type: "query", url: "http://localhost:1234@evil.com/x" }), [], NOW)).toThrow(/local backend/);
    expect(() => server.buildViewSpec(withSource({ type: "query", url: "http://127.0.0.1.evil.com/" }), [], NOW)).toThrow(/local backend/);
    expect(() => server.buildViewSpec(withSource({ type: "query", url: "not a url" }), [], NOW)).toThrow(/local backend/);
    expect(() => server.buildViewSpec(withSource({ type: "query", url: "http://[::1]:8799/rows" }), [], NOW)).not.toThrow();
    expect(() => server.buildViewSpec(withSource({ type: "query", url: "http://localhost/rows" }), [], NOW)).not.toThrow();
    expect(() => server.buildViewSpec({ ...base, kind: "pie" }, [], NOW)).toThrow(/kind must be/);
    expect(() => server.buildViewSpec({ ...base, kind: "line" }, [], NOW)).not.toThrow();
    expect(() => server.buildViewSpec({ ...base, kind: "bar" }, [], NOW)).not.toThrow();
    // SWIT-73: report joins the enum — .md file sources only, no query, no
    // {key}, no top-level drill; embedded blocks validate at render time.
    const report = (source: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      ...base,
      kind: "report",
      markers: undefined,
      source,
      ...extra,
    });
    expect(() => server.buildViewSpec(report({ type: "file", path: "analysis.md" }), [], NOW)).not.toThrow();
    expect(server.buildViewSpec(report({ type: "file", path: "notes/Analysis.MD" }), [], NOW)).toMatchObject({
      kind: "report",
    });
    expect(() => server.buildViewSpec(report({ type: "file", path: "rows.json" }), [], NOW)).toThrow(/\.md/);
    expect(() => server.buildViewSpec(report({ type: "file", path: "per/{key}.md" }), [], NOW)).toThrow(/\.md/);
    expect(() => server.buildViewSpec(report({ type: "query", url: "http://127.0.0.1:8799/r" }), [], NOW)).toThrow(
      /\.md/
    );
    expect(() =>
      server.buildViewSpec(
        report(
          { type: "file", path: "analysis.md" },
          { drill: { kind: "table", title: "t", source: { type: "file", path: "per/{key}.json" } } }
        ),
        [],
        NOW
      )
    ).toThrow(/no drill/);
    expect(() =>
      server.buildViewSpec(
        { ...base, drill: { kind: "report", title: "{key}", source: { type: "file", path: "per/{key}.md" } } },
        [],
        NOW
      )
    ).toThrow(/cannot be report/);
    expect((server.VIEW_TOOL.inputSchema as { properties: { kind: { enum: string[] } } }).properties.kind.enum).toContain(
      "report"
    );
    expect(() => server.buildViewSpec({ ...base, id: "no spaces!" }, [], NOW)).toThrow(/must match/);
  });

  it("T7 (SWIT-61): the enum lists line + bar; series / valueColumn normalise and ROUND-TRIP; the drill takes them too", () => {
    const props = (server.VIEW_TOOL.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.kind.enum).toEqual(["table", "candles", "dist", "line", "bar", "timeline", "report"]);
    expect(props.series).toBeDefined();
    expect(props.valueColumn).toBeDefined();
    const line = server.buildViewSpec({ ...base, kind: "line", series: [" close ", "", 3, "rsi"] }, [], NOW);
    expect(line.series).toEqual(["close", "rsi"]);
    const bar = server.buildViewSpec(
      {
        ...base,
        kind: "bar",
        keyColumn: "setup",
        valueColumn: " n ",
        drill: { kind: "line", title: "{key}", source: { type: "file", path: "per/{key}.json" }, series: ["close"] },
      },
      [],
      NOW
    );
    expect(bar.valueColumn).toBe("n");
    expect(bar.drill).toMatchObject({ kind: "line", series: ["close"] });
    // Absent when not given — the reader infers.
    expect("series" in server.buildViewSpec({ ...base, kind: "line" }, [], NOW)).toBe(false);
    for (const spec of [line, bar]) {
      const { spec: parsed, specError } = parseViewSpec(JSON.stringify(spec));
      expect(specError).toBeNull();
      expect(parsed!.kind).toBe(spec.kind);
    }
    expect(parseViewSpec(JSON.stringify(bar)).spec!.drill).toMatchObject({ kind: "line", series: ["close"] });
    expect(parseViewSpec(JSON.stringify(line)).spec!.series).toEqual(["close", "rsi"]);
    expect(server.VIEW_TOOL.description).toMatch(/line: rows \{time\|ts/);
    expect(server.VIEW_TOOL.description).toMatch(/bar: one row per category/);
  });

  it("T8 (SWIT-62): timeline is in the enum; sizeColumn normalises, validates and ROUND-TRIPS on spec AND drill; the description carries the tennis example", () => {
    const props = (server.VIEW_TOOL.inputSchema as { properties: Record<string, { enum?: string[]; description?: string }> }).properties;
    expect(props.kind.enum).toContain("timeline");
    expect(props.sizeColumn).toBeDefined();
    expect(props.sizeColumn.description).toMatch(/size_z/);
    expect(() => server.buildViewSpec({ ...base, kind: "timeline" }, [], NOW)).not.toThrow();
    const tl = server.buildViewSpec({ ...base, kind: "timeline", sizeColumn: " count " }, [], NOW);
    expect(tl.sizeColumn).toBe("count");
    // Absent when not given — the reader defaults to size_z.
    expect("sizeColumn" in server.buildViewSpec({ ...base, kind: "timeline" }, [], NOW)).toBe(false);
    // Given but empty / not a string is a VISIBLE error naming the field.
    expect(() => server.buildViewSpec({ ...base, kind: "timeline", sizeColumn: "" }, [], NOW)).toThrow(/sizeColumn must be a non-empty column name/);
    expect(() => server.buildViewSpec({ ...base, kind: "timeline", sizeColumn: 3 }, [], NOW)).toThrow(/sizeColumn must be/);
    // The tennis table, as the description's canonical example wires it.
    const table = server.buildViewSpec(
      {
        op: "show",
        kind: "table",
        title: "Tennis flow anomalies",
        source: { type: "file", path: ".sb-views/tennis/matches.json" },
        keyColumn: "match_id",
        columns: ["match_id", "player1_name", "player2_name", "score", "n_trades", "n_flagged"],
        drill: {
          kind: "timeline",
          title: "{key}",
          source: { type: "file", path: ".sb-views/tennis/{key}.json" },
          sizeColumn: "size_z",
        },
      },
      [],
      NOW
    );
    expect(table.drill).toMatchObject({ kind: "timeline", sizeColumn: "size_z" });
    expect(() =>
      server.buildViewSpec({ ...base, drill: { kind: "timeline", title: "{key}", source: { type: "file", path: "t/{key}.json" }, sizeColumn: " " } }, [], NOW)
    ).toThrow(/drill\.sizeColumn must be/);
    for (const spec of [tl, table]) {
      const { spec: parsed, specError } = parseViewSpec(JSON.stringify(spec));
      expect(specError).toBeNull();
      expect(parsed!.kind).toBe(spec.kind);
    }
    expect(parseViewSpec(JSON.stringify(tl)).spec!.sizeColumn).toBe("count");
    expect(parseViewSpec(JSON.stringify(table)).spec!.drill).toMatchObject({ kind: "timeline", sizeColumn: "size_z" });
    // The contract sentence + the canonical example, so the next agent wires the drill by default.
    const d = server.VIEW_TOOL.description;
    expect(d).toMatch(/timeline: one row per moment \{ts, price/);
    expect(d).toMatch(/flagged moments only/);
    expect(d).toMatch(/never imply the full tape/);
    expect(d).toMatch(/scripts\/export-tennis-match\.py/);
    expect(d).toMatch(/drill:\{kind:'timeline', title:'\{key\}', source:\{type:'file', path:'\.sb-views\/tennis\/\{key\}\.json'\}, sizeColumn:'size_z'\}/);
    // The whole tape is one flag away, and the description says what it needs.
    expect(d).toMatch(/`--full` to export the WHOLE trade tape with game state/);
    expect(d).toMatch(/full tape · N trades/);
    expect(d).toMatch(/docker start lode_shotclock_db/);
  });

  it("a local query url passes", () => {
    const spec = server.buildViewSpec(
      { ...base, source: { type: "query", url: "http://127.0.0.1:8799/api/bars" } },
      [],
      NOW
    );
    expect(spec.source).toEqual({ type: "query", url: "http://127.0.0.1:8799/api/bars" });
  });

  it("ROUND-TRIP: what the server writes parses through viewStore's parseViewSpec", () => {
    const spec = server.buildViewSpec(
      { ...base, columns: ["situation", "n"], keyColumn: "situation", kind: "table" },
      [],
      NOW
    );
    const { spec: parsed, specError } = parseViewSpec(JSON.stringify(spec));
    expect(specError).toBeNull();
    expect(parsed).toMatchObject({ id: "v1", kind: "table", keyColumn: "situation" });
    expect(parsed?.markers?.[0]).toEqual({ ts: "2026-08-31T10:35:00Z", label: "entry", id: "t-41" });
  });

  it("the view tool's description carries the never-executes contract", () => {
    expect(server.VIEW_TOOL.name).toBe("view");
    expect(server.VIEW_TOOL.description).toContain("NEVER runs your code");
    expect(server.VIEW_TOOL.description).toContain("you cannot make a view poll");
  });

  // ── T6 (SWIT-60): definition · filters · drill ─────────────────────────────
  describe("T6 — definition, filters, drill", () => {
    const srv = server as unknown as { VIEW_DEFINITION_CAP: number; VIEW_FILTER_CAP: number };
    const table = {
      op: "show",
      kind: "table",
      title: "Setup table",
      source: { type: "file", path: "out/setups.json" },
      keyColumn: "situation",
    };

    it("accepts the three fields and writes them lean; the reader round-trips them", () => {
      const spec = server.buildViewSpec(
        {
          ...table,
          definition: "  a setup is a 1m close outside the prior 20-bar range  ",
          filters: [
            { column: "sym", kind: "select", label: "instrument" },
            { column: "day", kind: "date" },
          ],
          drill: {
            kind: "table",
            title: "{key} instances",
            source: { type: "file", path: "out/setups/{key}.json" },
            columns: ["ts", "ret"],
            keyColumn: "ts",
            definition: "one row per matched window",
            junk: 1,
          },
        },
        [],
        NOW
      );
      expect(spec.definition).toBe("a setup is a 1m close outside the prior 20-bar range");
      expect(spec.filters).toEqual([
        { column: "sym", kind: "select", label: "instrument" },
        { column: "day", kind: "date" },
      ]);
      expect(spec.drill).toEqual({
        kind: "table",
        title: "{key} instances",
        source: { type: "file", path: "out/setups/{key}.json" },
        columns: ["ts", "ret"],
        keyColumn: "ts",
        definition: "one row per matched window",
      });
      const { spec: parsed, specError } = parseViewSpec(JSON.stringify(spec));
      expect(specError).toBeNull();
      expect(parsed?.drill).toEqual(spec.drill);
      expect(parsed?.filters).toEqual(spec.filters);
      expect(parsed?.definition).toBe(spec.definition);
      // Absent = absent, not null.
      const bare = server.buildViewSpec(table, [], NOW);
      expect("definition" in bare).toBe(false);
      expect("filters" in bare).toBe(false);
      expect("drill" in bare).toBe(false);
    });

    it("caps are visible errors that name the cap", () => {
      expect(() => server.buildViewSpec({ ...table, definition: "x".repeat(srv.VIEW_DEFINITION_CAP + 1) }, [], NOW)).toThrow(
        new RegExp(`cap is ${srv.VIEW_DEFINITION_CAP}`)
      );
      expect(() => server.buildViewSpec({ ...table, definition: "   " }, [], NOW)).toThrow(/non-empty/);
      const five = Array.from({ length: srv.VIEW_FILTER_CAP + 1 }, (_, i) => ({ column: `c${i}`, kind: "select" }));
      expect(() => server.buildViewSpec({ ...table, filters: five }, [], NOW)).toThrow(new RegExp(`cap is ${srv.VIEW_FILTER_CAP}`));
    });

    it("shape errors read like the `default`-style ones: which field, what it must be", () => {
      expect(() => server.buildViewSpec({ ...table, filters: "sym" }, [], NOW)).toThrow(/filters must be an array/);
      expect(() => server.buildViewSpec({ ...table, filters: [{ column: "sym", kind: "range" }] }, [], NOW)).toThrow(
        /filters\[0\]\.kind must be one of select, date/
      );
      expect(() => server.buildViewSpec({ ...table, filters: [{ kind: "select" }] }, [], NOW)).toThrow(/filters\[0\]\.column/);
      expect(() =>
        server.buildViewSpec({ ...table, filters: [{ column: "a", kind: "select" }, { column: "a", kind: "date" }] }, [], NOW)
      ).toThrow(/repeats column a/);
      expect(() => server.buildViewSpec({ ...table, drill: { kind: "pie", title: "t", source: { type: "file", path: "x/{key}.json" } } }, [], NOW)).toThrow(
        /drill\.kind must be one of/
      );
      expect(() => server.buildViewSpec({ ...table, drill: { kind: "table", source: { type: "file", path: "x/{key}.json" } } }, [], NOW)).toThrow(
        /drill\.title/
      );
      expect(() => server.buildViewSpec({ ...table, drill: { kind: "table", title: "t", source: { type: "file", path: "x/all.json" } } }, [], NOW)).toThrow(
        /must contain \{key\}/
      );
    });

    it("a drill template is guarded like a source: no escapes, no absolute paths, loopback only", () => {
      const drill = (source: Record<string, unknown>) => ({ ...table, drill: { kind: "table", title: "t", source } });
      expect(() => server.buildViewSpec(drill({ type: "file", path: "../{key}.json" }), [], NOW)).toThrow(/drill\.source\.path/);
      expect(() => server.buildViewSpec(drill({ type: "file", path: "C:/x/{key}.json" }), [], NOW)).toThrow(/drill\.source\.path/);
      expect(() => server.buildViewSpec(drill({ type: "query", url: "http://{key}/rows" }), [], NOW)).toThrow(/local backend/);
      expect(() => server.buildViewSpec(drill({ type: "query", url: "https://evil.example/{key}" }), [], NOW)).toThrow(/local backend/);
      const ok = server.buildViewSpec(drill({ type: "query", url: "http://127.0.0.1:8799/setups?k={key}", body: '{"k":"{key}"}' }), [], NOW);
      expect(ok.drill).toMatchObject({ source: { type: "query", url: "http://127.0.0.1:8799/setups?k={key}", body: '{"k":"{key}"}' } });
    });

    it("the description tells the agent when to declare a drill and give a definition", () => {
      expect(server.VIEW_TOOL.description).toMatch(/Declare a `drill` when the rows have instances behind them/);
      expect(server.VIEW_TOOL.description).toMatch(/Give a `definition`[^.]*whenever the view encodes a rule/);
      const props = (server.VIEW_TOOL.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(props)).toEqual(expect.arrayContaining(["definition", "filters", "drill"]));
    });
  });
});

describe("isLocalBackendUrl — the server's copy is the reader's copy", () => {
  it("a real parse: loopback spellings pass, userinfo / look-alikes / garbage fail", () => {
    expect(server.isLocalBackendUrl("http://127.0.0.1:8799/api")).toBe(true);
    expect(server.isLocalBackendUrl("http://localhost")).toBe(true);
    expect(server.isLocalBackendUrl("http://[::1]:8799/x")).toBe(true);
    expect(server.isLocalBackendUrl("http://localhost:1234@evil.com/x")).toBe(false);
    expect(server.isLocalBackendUrl("https://evil.example/x")).toBe(false);
    expect(server.isLocalBackendUrl("http://127.0.0.1.evil.com/")).toBe(false);
    expect(server.isLocalBackendUrl("not a url")).toBe(false);
  });

  it("is BYTE-IDENTICAL to viewStore's body (the pairing comment is a promise; this is the check)", () => {
    const body = (src: string) => {
      // Normalize line endings FIRST: the two files can be checked out with
      // different EOLs (this broke CI once — no .gitattributes meant the .cjs
      // and the .ts stored/checked out differently). The promise is identical
      // CODE, and EOL is transport, not code.
      const m = src.replace(/\r\n/g, "\n").match(/function isLocalBackendUrl\([^)]*\)[^{]*\{[\s\S]*?\n\}/);
      if (!m) throw new Error("isLocalBackendUrl not found");
      // Only the TS annotations differ: strip them and the bodies must match.
      return m[0].replace("(url: string): boolean", "(url)").replace("let parsed: URL;", "let parsed;");
    };
    expect(body(mcpServerSource)).toBe(body(viewStoreSource));
    expect(body(mcpServerSource)).toContain("parsed.username");
  });
});

describe("the post tool (SWIT-52)", () => {
  const threads = [
    { id: "t1", title: "sim audit" },
    { id: "t2", title: "markets - Aug 30" },
    { id: "t3", title: "gone", archivedAt: 5 },
  ];
  const srv = server as unknown as {
    resolvePostTarget: (t: unknown[], q: string, self: string) => { id: string; title: string };
    appendPost: (list: unknown[], post: Record<string, unknown>, now: number) => unknown[];
  };

  it("resolves by id and by unique title fragment; self + archived excluded; misses are sentences", () => {
    expect(srv.resolvePostTarget(threads, "t2", "t1").id).toBe("t2");
    expect(srv.resolvePostTarget(threads, "markets", "t1").id).toBe("t2");
    expect(() => srv.resolvePostTarget(threads, "sim", "t1")).toThrow(/THIS thread/);
    expect(() => srv.resolvePostTarget(threads, "gone", "t1")).toThrow(/no thread matches/);
    expect(() => srv.resolvePostTarget(threads, "zzz", "t1")).toThrow(/no thread matches/);
  });

  it("rate-limits per sending thread and caps the inbox", () => {
    const mk = (i: number, agoMs: number) => ({
      id: `p${i}`,
      fromId: "t1",
      kind: "update",
      text: "x",
      at: new Date(NOW - agoMs).toISOString(),
    });
    const recent = [mk(1, 1000), mk(2, 2000), mk(3, 3000), mk(4, 4000), mk(5, 5000)];
    expect(() =>
      srv.appendPost(recent, { id: "p6", fromId: "t1", kind: "update", text: "x", at: new Date(NOW).toISOString() }, NOW)
    ).toThrow(/rate limit/);
    // Old posts do not count against the window; the cap keeps the newest.
    const old = Array.from({ length: 120 }, (_, i) => mk(i, 10 * 60_000));
    const next = srv.appendPost(old, { id: "new", fromId: "t1", kind: "request", text: "x", at: new Date(NOW).toISOString() }, NOW);
    expect(next).toHaveLength(100);
    expect((next[next.length - 1] as { id: string }).id).toBe("new");
  });

  it("a post round-trips through pageStore's inbox parse", () => {
    const post = { id: "p1", from: "sim audit", fromId: "t1", kind: "request", text: "re-run it", at: new Date(NOW).toISOString() };
    const parsed = parseInboxFile(JSON.stringify({ posts: [post] }));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ id: "p1", from: "sim audit", kind: "request", text: "re-run it" });
  });
});

describe("the backlog tool (SWIT-64) — ONE op, an inbox the app drains", () => {
  const srv = server as unknown as {
    buildBacklogEntry: (args: Record<string, unknown>, self: string, now: number) => Record<string, unknown>;
    formatBacklogEntry: (entry: Record<string, unknown>) => string;
    BACKLOG_TOOL: { name: string; description: string; inputSchema: { properties: Record<string, { enum?: string[] }>; required: string[] } };
  };

  it("validates op / itemId / kind / ref with sentences the agent can act on", () => {
    const ok = srv.buildBacklogEntry({ op: "link", itemId: "bmf1x2a01", kind: "ticket", ref: " SWIT-64 " }, "t1", NOW);
    expect(ok).toMatchObject({ itemId: "bmf1x2a01", kind: "ticket", ref: "SWIT-64", threadId: "t1", at: new Date(NOW).toISOString() });
    expect(String(ok.id)).toMatch(/^bl/);
    expect(() => srv.buildBacklogEntry({ op: "unlink", itemId: "a", kind: "ticket", ref: "x" }, "t1", NOW)).toThrow(/`op` must be "link"/);
    expect(() => srv.buildBacklogEntry({ op: "link", itemId: "../a", kind: "ticket", ref: "x" }, "t1", NOW)).toThrow(/itemId/);
    expect(() => srv.buildBacklogEntry({ op: "link", itemId: "a", kind: "thread", ref: "x" }, "t1", NOW)).toThrow(/ticket \| spec/);
    expect(() => srv.buildBacklogEntry({ op: "link", itemId: "a", kind: "spec", ref: "  " }, "t1", NOW)).toThrow(/ref must be a non-empty string/);
    // The ref cap (300) sits BELOW the generic text cap (500), so its own
    // sentence is reachable — a ref is a ticket key or a KB path, not prose.
    expect(() => srv.buildBacklogEntry({ op: "link", itemId: "a", kind: "spec", ref: "x".repeat(301) }, "t1", NOW)).toThrow(/ref too long \(cap 300\)/);
    expect(() => srv.buildBacklogEntry({ op: "link", itemId: "a", kind: "spec", ref: "x".repeat(501) }, "t1", NOW)).toThrow(/too long/);
  });

  it("the inbox is APPEND-ONLY NDJSON: an entry is ONE line, N servers append, and the app's line-wise parse drains them in order", () => {
    const e1 = srv.buildBacklogEntry({ op: "link", itemId: "i1", kind: "spec", ref: "switchboard/features/backlog/requirements.md" }, "t1", NOW);
    const e2 = srv.buildBacklogEntry({ op: "link", itemId: "i2", kind: "ticket", ref: "SWIT-64" }, "t2", NOW + 1);
    const line1 = srv.formatBacklogEntry(e1);
    // One line, terminated, with no newline INSIDE it whatever the content
    // (JSON.stringify escapes them) — that is what makes a line one entry.
    expect(line1.endsWith("\n")).toBe(true);
    expect(line1.slice(0, -1)).not.toContain("\n");
    expect(srv.formatBacklogEntry({ ...e1, ref: "a\nb" }).slice(0, -1)).not.toContain("\n");
    // ROUND-TRIP: two servers' appends, in file order, are what backlogStore drains.
    const parsed = parseBacklogInbox(line1 + srv.formatBacklogEntry(e2));
    expect(parsed).toEqual([
      { id: e1.id, itemId: "i1", kind: "spec", ref: "switchboard/features/backlog/requirements.md", threadId: "t1", at: e1.at },
      { id: e2.id, itemId: "i2", kind: "ticket", ref: "SWIT-64", threadId: "t2", at: e2.at },
    ]);
    // The server never rewrites the file: no read, no tmp, no rename on the inbox path.
    expect(mcpServerSource).toContain("fs.appendFileSync(backlogInboxPath");
    expect(mcpServerSource).not.toMatch(/backlogInboxPath}\.tmp/);
  });

  it("the tool table carries the one-writer contract and the single op", () => {
    const tool = srv.BACKLOG_TOOL;
    expect(tool.name).toBe("backlog");
    expect(tool.inputSchema.properties.op.enum).toEqual(["link"]);
    expect(tool.inputSchema.properties.kind.enum).toEqual(["ticket", "spec"]);
    expect(tool.inputSchema.required).toEqual(["op", "itemId", "kind", "ref"]);
    expect(tool.description).toMatch(/never writes the backlog itself/);
    expect(tool.description).toMatch(/inbox file the app applies/);
    expect(tool.description).toMatch(/app alone rewrites backlog\.json/);
    expect(tool.description).toMatch(/re-sending the same link is harmless/);
    // The server's env → tool wiring names the inbox path, never backlog.json.
    expect(mcpServerSource).toContain("SWITCHBOARD_BACKLOG_INBOX");
    expect(mcpServerSource).not.toMatch(/["'`]backlog\.json["'`]/);
  });
});

// ── SWIT-70: the line kind's story fields ────────────────────────────────────

describe("the view tool — seriesLabels / regions / panels (SWIT-70)", () => {
  const line = {
    op: "show",
    kind: "line",
    title: "gamma story",
    source: { type: "file", path: "out/gamma.json" },
  };
  const build = (extra: Record<string, unknown>, base: Record<string, unknown> = line) =>
    server.buildViewSpec({ ...base, ...extra }, [], NOW);

  it("accepts the three fields, trims and caps, and round-trips through viewStore's parse", () => {
    const spec = build({
      seriesLabels: { net_gamma: " net gamma ($bn) ", vol: "x".repeat(80) },
      regions: [{ from: "2026-06-05T13:30:00Z", to: "2026-06-05 14:00:00", label: " open drive " }],
      panels: [
        { title: " net gamma ", source: { type: "file", path: "out/a.json" } },
        { title: "vol", source: { type: "query", url: "http://127.0.0.1:8799/rows" } },
      ],
    });
    expect(spec.seriesLabels).toEqual({ net_gamma: "net gamma ($bn)", vol: "x".repeat(40) });
    expect(spec.regions).toEqual([
      { from: "2026-06-05T13:30:00Z", to: "2026-06-05 14:00:00", label: "open drive" },
    ]);
    expect((spec.panels as { title: string }[]).map((p) => p.title)).toEqual(["net gamma", "vol"]);
    const parsed = parseViewSpec(JSON.stringify(spec));
    expect(parsed.specError).toBeNull();
    expect(parsed.spec?.seriesLabels).toEqual(spec.seriesLabels);
    expect(parsed.spec?.regions).toEqual(spec.regions);
    expect(parsed.spec?.panels).toEqual(spec.panels);
  });

  it("rejects malformed fields as visible errors, with the caps named", () => {
    expect(() => build({ seriesLabels: ["a"] })).toThrow(/seriesLabels/);
    expect(() => build({ seriesLabels: { a: "" } })).toThrow(/non-empty/);
    expect(() => build({ regions: [{ from: "junk", to: "2026-06-05T14:00:00Z" }] })).toThrow(/parseable/);
    expect(() =>
      build({ regions: Array.from({ length: 13 }, () => ({ from: "2026-06-05T13:00:00Z", to: "2026-06-05T14:00:00Z" })) })
    ).toThrow(/cap is 12/);
    expect(() =>
      build({ panels: Array.from({ length: 7 }, (_, i) => ({ title: `p${i}`, source: { type: "file", path: `o/${i}.json` } })) })
    ).toThrow(/cap is 6/);
  });

  it("panels are line-only, loopback-only, and never templates", () => {
    expect(() =>
      build({ panels: [{ title: "x", source: { type: "file", path: "o/a.json" } }] }, { ...line, kind: "table" })
    ).toThrow(/line kind/);
    expect(() =>
      build({ panels: [{ title: "x", source: { type: "file", path: "o/{key}.json" } }] })
    ).toThrow(/\{key\}/);
    expect(() =>
      build({ panels: [{ title: "x", source: { type: "query", url: "https://evil.example/rows" } }] })
    ).toThrow(/local backend/);
    expect(() =>
      build({ panels: [{ title: "x", source: { type: "file", path: "../o.json" } }] })
    ).toThrow(/relative path/);
  });

  it("the tool description states the small-multiples preference and the read-only panels", () => {
    for (const rule of [
      "Prefer ONE line view",
      "small multiples",
      "no {key}",
      "definition` that says what to look at",
      "main chart only",
      "seriesLabels",
      "regions",
    ]) {
      expect(server.VIEW_TOOL.description).toContain(rule);
    }
    const props = (server.VIEW_TOOL.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.seriesLabels).toBeDefined();
    expect(props.regions).toBeDefined();
    expect(props.panels).toBeDefined();
  });
});

describe("the view tool — levels / markerColumns / drill markers (SWIT-75, the review loop)", () => {
  const deck = {
    op: "show",
    kind: "table",
    title: "gamma deck",
    source: { type: "file", path: ".sb-views/gamma/deck/index.json" },
    keyColumn: "day",
  };
  const drill = {
    kind: "line",
    title: "{key}",
    source: { type: "file", path: ".sb-views/gamma/deck/days/{key}.json" },
    series: ["nq_close"],
    markerColumns: ["eric_long_entry", "eric_short_entry", "eric_exit"],
    markers: [{ ts: "2026-02-19T14:30:00Z", label: "open" }],
    levels: [
      { price: 25471.4, label: " flip " },
      { price: 25443.8, label: "call wall", style: "dashed" },
      { price: 25233.5, price2: 25260, label: "put zone", style: "zone" },
    ],
  };
  const build = (extra: Record<string, unknown>, base: Record<string, unknown> = deck) =>
    server.buildViewSpec({ ...base, ...extra }, [], NOW);

  it("the gamma deck's drill carries levels, markers and markerColumns, and round-trips through viewStore", () => {
    const spec = build({ drill });
    const d = spec.drill as Record<string, unknown>;
    expect(d.levels).toEqual([
      { price: 25471.4, label: "flip" },
      { price: 25443.8, label: "call wall", style: "dashed" },
      { price: 25233.5, style: "zone", price2: 25260, label: "put zone" },
    ]);
    expect(d.markers).toEqual([{ ts: "2026-02-19T14:30:00Z", label: "open" }]);
    expect(d.markerColumns).toEqual(["eric_long_entry", "eric_short_entry", "eric_exit"]);
    const parsed = parseViewSpec(JSON.stringify(spec));
    expect(parsed.specError).toBeNull();
    expect(parsed.spec?.drill?.levels).toEqual(d.levels);
    expect(parsed.spec?.drill?.markers).toEqual(d.markers);
    expect(parsed.spec?.drill?.markerColumns).toEqual(d.markerColumns);
  });

  it("levels and markerColumns apply to a standalone spec too", () => {
    const spec = build(
      { levels: [{ price: 100 }], markerColumns: ["entry"] },
      { ...deck, kind: "line", source: { type: "file", path: "day.json" } }
    );
    expect(spec.levels).toEqual([{ price: 100 }]);
    expect(spec.markerColumns).toEqual(["entry"]);
    expect(parseViewSpec(JSON.stringify(spec)).spec?.levels).toEqual([{ price: 100 }]);
  });

  it("rejects malformed levels as visible errors — a zone needs price2, styles are the three, the cap is named", () => {
    expect(() => build({ levels: { price: 1 } })).toThrow(/levels must be an array/);
    expect(() => build({ levels: [{ price: "abc" }] })).toThrow(/finite number/);
    expect(() => build({ levels: [{ price: 1, style: "dotted" }] })).toThrow(/solid, dashed, zone/);
    expect(() => build({ levels: [{ price: 1, style: "zone" }] })).toThrow(/needs a finite price2/);
    expect(() => build({ levels: Array.from({ length: 13 }, (_, i) => ({ price: i })) })).toThrow(/cap is 12/);
    expect(() => build({ drill: { ...drill, levels: [{ price: 1, style: "zone" }] } })).toThrow(/drill\.levels\[0\]/);
    expect(server.VIEW_LEVEL_CAP).toBe(12);
  });

  it("the tool description states the loop: deck next/prev, levels, markerColumns, the notes file, one message", () => {
    for (const rule of [
      "next/prev",
      "`levels`",
      "`markerColumns`",
      "never encode a level as a constant column",
      "notes.json",
      "sentAt",
      "ONE message",
      "Chart notes on <title> (N):",
    ]) {
      expect(server.VIEW_TOOL.description).toContain(rule);
    }
    const props = (server.VIEW_TOOL.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.levels).toBeDefined();
    expect(props.markerColumns).toBeDefined();
    expect(String((props.drill as { description: string }).description)).toContain("markerColumns?");
  });
});

describe("the view tool — tone / tones (SWIT-81, colour carries meaning)", () => {
  const bar = {
    op: "show",
    kind: "bar",
    title: "flow by strike",
    source: { type: "file", path: "out/flow.json" },
    keyColumn: "strike",
    valueColumn: "net",
  };
  const table = {
    op: "show",
    kind: "table",
    title: "flows",
    source: { type: "file", path: "out/flows.json" },
    keyColumn: "id",
  };
  const build = (extra: Record<string, unknown>, base: Record<string, unknown> = bar) =>
    server.buildViewSpec({ ...base, ...extra }, [], NOW);

  it("accepts a valid bar/dist tone and round-trips through viewStore's parse", () => {
    const spec = build({ tone: "chart-4" });
    expect(spec.tone).toBe("chart-4");
    const parsed = parseViewSpec(JSON.stringify(spec));
    expect(parsed.specError).toBeNull();
    expect(parsed.spec?.tone).toBe("chart-4");
    expect(build({ tone: "sign" }, { ...bar, kind: "dist", source: { type: "file", path: "out/dist.json" } }).tone).toBe(
      "sign"
    );
  });

  it("rejects an unknown tone, naming the allowed values", () => {
    expect(() => build({ tone: "rainbow" })).toThrow(/tone must be one of/);
    expect(() => build({ tone: "rainbow" })).toThrow(/neutral/);
  });

  it("tone is bar/dist only — a table spec carrying it is refused", () => {
    expect(() => build({ tone: "accent" }, table)).toThrow(/tone applies to bar \/ dist/);
  });

  it("accepts valid table tones, trims the column, and round-trips through viewStore's parse", () => {
    const spec = build(
      { tones: [{ column: " pnl ", tone: "sign" }, { column: "vol", tone: "heat" }] },
      table
    );
    expect(spec.tones).toEqual([
      { column: "pnl", tone: "sign" },
      { column: "vol", tone: "heat" },
    ]);
    const parsed = parseViewSpec(JSON.stringify(spec));
    expect(parsed.specError).toBeNull();
    expect(parsed.spec?.tones).toEqual(spec.tones);
  });

  it("rejects malformed tones as visible errors — bad kind, empty/over-cap column, repeated column, the cap", () => {
    expect(() => build({ tones: [{ column: "x", tone: "rainbow" }] }, table)).toThrow(/tones\[0\]\.tone must be one of/);
    expect(() => build({ tones: [{ column: "", tone: "sign" }] }, table)).toThrow(/tones\[0\]\.column/);
    expect(() => build({ tones: [{ column: "x".repeat(65), tone: "sign" }] }, table)).toThrow(/cap is 64/);
    expect(() =>
      build({ tones: [{ column: "pnl", tone: "sign" }, { column: "pnl", tone: "heat" }] }, table)
    ).toThrow(/repeats column pnl/);
    expect(() =>
      build({ tones: Array.from({ length: 7 }, (_, i) => ({ column: `c${i}`, tone: "sign" })) }, table)
    ).toThrow(/cap is 6/);
    expect(server.TABLE_TONES_CAP).toBe(6);
    expect(server.TABLE_TONE_COLUMN_CAP).toBe(64);
  });

  it("tones is table only — a bar spec carrying it is refused", () => {
    expect(() => build({ tones: [{ column: "n", tone: "sign" }] })).toThrow(/tones applies to table/);
  });

  it("the tool description names tone/tones and the schema exposes both properties", () => {
    for (const rule of [
      "tone` picks the bars' fill",
      "neutral' | 'sign' (--up/--dn) | 'accent' | 'chart-1'..'chart-8'",
      "tones` (<=6)",
      "sign colours the",
      "heat tints the cell background",
    ]) {
      expect(server.VIEW_TOOL.description).toContain(rule);
    }
    const props = (server.VIEW_TOOL.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.tone).toBeDefined();
    expect(props.tones).toBeDefined();
    expect(server.BAR_TONES).toEqual([
      "neutral",
      "sign",
      "accent",
      "chart-1",
      "chart-2",
      "chart-3",
      "chart-4",
      "chart-5",
      "chart-6",
      "chart-7",
      "chart-8",
    ]);
    expect(server.TABLE_TONE_KINDS).toEqual(["sign", "heat"]);
  });
});

describe("the view tool — sets (SWIT-79, Ky's set tabs)", () => {
  const sets = server as unknown as {
    buildViewSet: (raw: unknown, existingIds: string[], existingSetIds: string[], now: number) => { id: string; label: string; ids: string[]; builtAt: string };
    performViewOp: (threadDir: string, args: Record<string, unknown>, now: number) => { message: string; set?: { id: string; ids: string[] } };
    SET_CAP: number;
    SET_ITEM_CAP: number;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeFs = require("fs") as {
    mkdtempSync: (p: string) => string;
    mkdirSync: (p: string, o?: { recursive: boolean }) => void;
    writeFileSync: (p: string, d: string) => void;
    readFileSync: (p: string, e: string) => string;
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeOs = require("os") as { tmpdir: () => string };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require("path") as { join: (...p: string[]) => string };

  it("builds a set from views that EXIST, minting s<n>, deduping ids", () => {
    const set = sets.buildViewSet({ label: "  gamma views ", ids: ["v1", "v2", "v1", " v3 "] }, ["v1", "v2", "v3"], ["s1", "s3"], NOW);
    expect(set).toEqual({ id: "s4", label: "gamma views", ids: ["v1", "v2", "v3"], builtAt: "2026-08-31T10:00:00.000Z" });
  });

  it("refuses — visibly — an unknown view, a bad id, fewer than two, too many, no label", () => {
    const build = (raw: unknown, existing = ["v1", "v2"]) => () => sets.buildViewSet(raw, existing, [], NOW);
    expect(build({ label: "x", ids: ["v1", "v9"] })).toThrow(/not a view of this thread/);
    expect(build({ label: "x", ids: ["v1", "bad id!"] })).toThrow(/not a view id/);
    expect(build({ label: "x", ids: ["v1", "v1"] })).toThrow(/at least two/);
    expect(build({ label: "x", ids: ["v1"] })).toThrow(/at least two/);
    expect(build({ label: "", ids: ["v1", "v2"] })).toThrow(/set\.label/);
    expect(build({ label: "x" })).toThrow(/set\.ids/);
    expect(build("x")).toThrow(/set must be/);
    const many = Array.from({ length: sets.SET_ITEM_CAP + 1 }, (_, i) => `v${i}`);
    expect(build({ label: "x", ids: many }, many)).toThrow(/cap is 50/);
    expect(sets.SET_ITEM_CAP).toBe(50);
  });

  it("`show` with `set` writes sets.json newest-first (capped) and never touches views/", () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "swb-sets-"));
    try {
      nodeFs.mkdirSync(nodePath.join(dir, "views"), { recursive: true });
      for (const id of ["v1", "v2", "v3"]) nodeFs.writeFileSync(nodePath.join(dir, "views", `${id}.json`), "{}");
      const first = sets.performViewOp(dir, { op: "show", set: { label: "two", ids: ["v1", "v2"] } }, NOW);
      expect(first.set).toMatchObject({ id: "s1", ids: ["v1", "v2"] });
      expect(first.message).toMatch(/ONE tab/);
      const second = sets.performViewOp(dir, { op: "show", set: { label: "three", ids: ["v1", "v2", "v3"] } }, NOW + 1000);
      expect(second.set?.id).toBe("s2");
      const file = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "sets.json"), "utf8"));
      expect(file.version).toBe(1);
      expect(file.sets.map((s: { id: string }) => s.id)).toEqual(["s2", "s1"]);
      // The app's parser reads exactly this shape.
      expect(parseSetsFile(JSON.stringify(file)).map((s) => s.id)).toEqual(["s2", "s1"]);
      // A set goes with `show` only; an unknown view is refused.
      expect(() => sets.performViewOp(dir, { op: "update", set: { label: "x", ids: ["v1", "v2"] } }, NOW)).toThrow(/op "show"/);
      expect(() => sets.performViewOp(dir, { op: "show", set: { label: "x", ids: ["v1", "v9"] } }, NOW)).toThrow(/show it first/);
      // views/ untouched: still three specs.
      expect(nodeFs.readFileSync(nodePath.join(dir, "views", "v1.json"), "utf8")).toBe("{}");
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a plain `show` still needs kind/title/source (checked in code — the schema requires only op)", () => {
    expect(() => server.buildViewSpec({ op: "show" }, [], NOW)).toThrow(/kind must be/);
    expect((server.VIEW_TOOL.inputSchema as { required: string[] }).required).toEqual(["op"]);
    const props = (server.VIEW_TOOL.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.set).toBeDefined();
    expect(server.VIEW_TOOL.description).toContain("ONE tab");
    expect(server.VIEW_TOOL.description).toContain("set:{label:");
  });
});

describe("the view tool — the dashboard grammar (SWIT-96: facts / width / stat series+delta)", () => {
  it("the description names facts, width and series so an agent can write a dashboard", () => {
    for (const rule of [
      "```facts block",
      "tone?:'accent'|'amber'|'neutral'",
      "renders ONE header card (always full width",
      "`series` (<=60 finite numbers",
      "trimmed to its most recent 60",
      "a sparkline",
      "`delta`",
      "`width`:'half'|'third'",
      "pack side by side",
    ]) {
      expect(server.VIEW_TOOL.description).toContain(rule);
    }
  });
});

describe("the page tool — op show (SWIT-102): put an existing doc or file in front of the user", () => {
  const shows = server as unknown as {
    normalizeShowAddress: (raw: unknown, cwd: string, viewIds: string[]) => { address: string; form: string };
    performShowOp: (
      threadDir: string,
      args: Record<string, unknown>,
      now: number,
      env?: {
        cwd?: string;
        exists?: (p: string) => boolean;
        inspect?: (p: string) => { kind: "missing" | "dir" | "file"; size: number; text: boolean };
      }
    ) => { show: { id: string; address: string; at: string; where?: string }; message: string };
    SHOW_READ_CAP: number;
    surfaceQueryOk: (q: string) => boolean;
    inspectPath: (p: string) => { kind: string; size: number; text: boolean };
    performOp: (threadDir: string, args: Record<string, unknown>, now: number) => string;
    SHOW_CAP: number;
    SHOW_ADDRESS_CAP: number;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeFs = require("fs") as {
    mkdtempSync: (p: string) => string;
    mkdirSync: (p: string, o?: { recursive: boolean }) => void;
    writeFileSync: (p: string, d: string) => void;
    readFileSync: (p: string, e: string) => string;
    existsSync: (p: string) => boolean;
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeOs = require("os") as { tmpdir: () => string };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require("path") as { join: (...p: string[]) => string };
  const CWD = "C:/Users/eric/projects/lodestar";
  const norm = (raw: unknown, viewIds: string[] = []) => shows.normalizeShowAddress(raw, CWD, viewIds);

  it("accepts the four address forms and normalizes a path (backslashes, ./, an absolute path inside cwd)", () => {
    expect(norm("specs/sextant/gamma-metric-design.md")).toEqual({ address: "specs/sextant/gamma-metric-design.md", form: "path" });
    expect(norm("  switchboard/features/x/requirements.md ")).toEqual({ address: "switchboard/features/x/requirements.md", form: "path" });
    expect(norm("mockups\\cases-compact-v1.html")).toEqual({ address: "mockups/cases-compact-v1.html", form: "path" });
    expect(norm("./README.md")).toEqual({ address: "README.md", form: "path" });
    // Inside the working directory — drive paths compare case-insensitively.
    expect(norm("c:\\users\\eric\\projects\\lodestar\\specs\\a.md")).toEqual({ address: "specs/a.md", form: "path" });
    // Outside it — kept absolute; the app opens it only inside the knowledge base.
    expect(norm("C:\\Users\\eric\\projects\\personal-kb\\switchboard\\notes.md")).toEqual({
      address: "C:/Users/eric/projects/personal-kb/switchboard/notes.md",
      form: "absolute",
    });
    // A sibling directory that merely shares the prefix is NOT inside cwd.
    expect(norm("C:/Users/eric/projects/lodestar-old/a.md").form).toBe("absolute");
    expect(norm("surface:lodestar/trading?instrument=NQ&date=2026-06-05")).toEqual({
      address: "surface:lodestar/trading?instrument=NQ&date=2026-06-05",
      form: "surface",
    });
    expect(norm("view:v2", ["v1", "v2"])).toEqual({ address: "view:v2", form: "view" });
    expect(norm("view:v2#h:net-gamma", ["v2"])).toEqual({ address: "view:v2#h:net-gamma", form: "view" });
  });

  it("refuses — visibly — what cannot open: a ticket key, a URL, prose, `..`, a bare word, an unknown view, a bad anchor, a long address", () => {
    expect(() => norm("SWIT-102")).toThrow(/not something the panel can open/);
    expect(() => norm("https://claude.ai/artifact/abc")).toThrow(/not something the panel can open/);
    expect(() => norm("the gamma design doc")).toThrow(/no spaces/);
    expect(() => norm("../secrets/a.md")).toThrow(/no \.\./);
    expect(() => norm("specs/../../a.md")).toThrow(/not something the panel can open/);
    expect(() => norm("refactor")).toThrow(/not something the panel can open/);
    expect(() => norm("")).toThrow(/address must be a non-empty string/);
    expect(() => norm(undefined)).toThrow(/address must be a non-empty string/);
    expect(() => norm("view:v9", ["v1"])).toThrow(/no view with id v9 in this thread — create it with the view tool/);
    expect(() => norm("view:bad id", ["v1"])).toThrow(/not a view address/);
    expect(() => norm("view:v1#nope", ["v1"])).toThrow(/malformed anchor/);
    expect(() => norm("surface:lodestar")).toThrow(/not a page address/);
    expect(() => norm(`docs/${"a".repeat(shows.SHOW_ADDRESS_CAP)}.md`)).toThrow(/too long \(\d+ chars; the cap is 300\)/);
  });

  it("writes shows.json newest-first with o<n> ids, capped at 20 — and never touches page.json", () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "swb-shows-"));
    try {
      const env = { cwd: CWD, exists: () => true };
      const first = shows.performShowOp(dir, { op: "show", address: "specs/a.md" }, NOW, env);
      expect(first.show).toEqual({ id: "o1", address: "specs/a.md", at: "2026-08-31T10:00:00.000Z", where: "cwd" });
      expect(first.message).toMatch(/^specs\/a\.md opens in the panel beside the terminal when this thread's folder belongs to a registry project/);
      const second = shows.performShowOp(dir, { op: "show", address: "mock.html" }, NOW + 1000, env);
      expect(second.show.id).toBe("o2");
      const file = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "shows.json"), "utf8"));
      expect(file.version).toBe(1);
      expect(file.shows.map((s: { id: string }) => s.id)).toEqual(["o2", "o1"]);
      // The app's parser reads exactly this shape.
      expect(parseShowsFile(JSON.stringify(file))).toEqual([
        { id: "o2", address: "mock.html", at: "2026-08-31T10:00:01.000Z", where: "cwd" },
        { id: "o1", address: "specs/a.md", at: "2026-08-31T10:00:00.000Z", where: "cwd" },
      ]);
      // The cap: 25 more shows keep the newest 20, and ids keep counting up
      // (a trimmed id is never re-minted — the app's seen-set stays honest).
      for (let i = 0; i < 25; i++) shows.performShowOp(dir, { op: "show", address: `docs/n${i}.md` }, NOW + 2000 + i, env);
      const capped = JSON.parse(nodeFs.readFileSync(nodePath.join(dir, "shows.json"), "utf8"));
      expect(capped.shows).toHaveLength(shows.SHOW_CAP);
      expect(capped.shows[0].id).toBe("o27");
      expect(capped.shows[capped.shows.length - 1].id).toBe("o8");
      expect(parseShowsFile(JSON.stringify(capped))).toHaveLength(SHOW_CAP);
      // Through the page tool's own entry point; page.json is never written.
      expect(shows.performOp(dir, { op: "show", address: "surface:lodestar/trading" }, NOW)).toMatch(
        /^surface:lodestar\/trading opens in the panel beside the terminal if it names a page Switchboard has registered/
      );
      expect(nodeFs.existsSync(nodePath.join(dir, "page.json"))).toBe(false);
      // The pure page half refuses it rather than pretending to write a page.
      expect(() => server.applyOp(empty(), { op: "show", address: "a/b.md" }, NOW)).toThrow(/shows\.json/);
      // A refused address writes nothing.
      const before = nodeFs.readFileSync(nodePath.join(dir, "shows.json"), "utf8");
      expect(() => shows.performShowOp(dir, { op: "show", address: "SWIT-1" }, NOW, env)).toThrow();
      expect(nodeFs.readFileSync(nodePath.join(dir, "shows.json"), "utf8")).toBe(before);
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the RESULT says plainly when nothing may open: a path not under cwd, an absolute path outside it; a missing absolute path is refused", () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "swb-shows-"));
    try {
      nodeFs.mkdirSync(nodePath.join(dir, "views"), { recursive: true });
      nodeFs.writeFileSync(nodePath.join(dir, "views", "v1.json"), "{}");
      const asked: string[] = [];
      const missing = { cwd: CWD, exists: (p: string) => (asked.push(p), false) };
      const kbDoc = shows.performShowOp(dir, { op: "show", address: "switchboard/features/x/requirements.md" }, NOW, missing);
      // Not under cwd: no `where` — the app may resolve it as a KB doc.
      expect(kbDoc.show.where).toBeUndefined();
      expect(kbDoc.message).toMatch(/^Recorded — but switchboard\/features\/x\/requirements\.md is not a file under this thread's working directory/);
      expect(kbDoc.message).toMatch(/opens ONLY if Switchboard can resolve it as a knowledge-base doc .* or a file in this thread's project; otherwise nothing opens\.$/);
      // The existence check is cwd + the relative address (the server's cwd is the thread's).
      expect(asked[asked.length - 1].replace(/\\/g, "/")).toBe(`${CWD}/switchboard/features/x/requirements.md`);
      const outside = shows.performShowOp(
        dir,
        { op: "show", address: "C:\\Users\\eric\\projects\\personal-kb\\switchboard\\notes.md" },
        NOW,
        { cwd: CWD, exists: () => true }
      );
      expect(outside.show.address).toBe("C:/Users/eric/projects/personal-kb/switchboard/notes.md");
      expect(outside.message).toMatch(/outside this thread's working directory, so it opens ONLY if it sits inside the knowledge base; otherwise nothing opens\.$/);
      expect(() =>
        shows.performShowOp(dir, { op: "show", address: "C:/nowhere/at/all.md" }, NOW, missing)
      ).toThrow(/no file at C:\/nowhere\/at\/all\.md — nothing to open/);
      // A view the thread has opens; one it does not have is refused by name.
      expect(shows.performShowOp(dir, { op: "show", address: "view:v1#h:summary" }, NOW, missing).message).toBe(
        "view:v1#h:summary is opening in the panel beside the terminal."
      );
      expect(() => shows.performShowOp(dir, { op: "show", address: "view:v2" }, NOW, missing)).toThrow(/no view with id v2/);
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("REFUSES what the viewer cannot render — a folder, an oversize file, a binary file — and records nothing (review of 49ebb20, #3)", () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "swb-shows-"));
    try {
      const probe = (info: { kind: "missing" | "dir" | "file"; size: number; text: boolean }) => ({ cwd: CWD, inspect: () => info });
      expect(() => shows.performShowOp(dir, { op: "show", address: "specs/sextant" }, NOW, probe({ kind: "dir", size: 0, text: false }))).toThrow(
        /specs\/sextant is a folder — show opens a file/
      );
      expect(() =>
        shows.performShowOp(dir, { op: "show", address: "data/big.json" }, NOW, probe({ kind: "file", size: shows.SHOW_READ_CAP + 1, text: false }))
      ).toThrow(/data\/big\.json is 513 KB — the panel's viewer reads files up to 512 KB/);
      expect(() => shows.performShowOp(dir, { op: "show", address: "shot.png" }, NOW, probe({ kind: "file", size: 900, text: false }))).toThrow(
        /shot\.png is not a text file/
      );
      // The absolute form gets the same checks (it opens only as a KB doc, which is text too).
      expect(() =>
        shows.performShowOp(dir, { op: "show", address: "C:/Users/eric/projects/personal-kb/switchboard" }, NOW, probe({ kind: "dir", size: 0, text: false }))
      ).toThrow(/is a folder/);
      expect(nodeFs.existsSync(nodePath.join(dir, "shows.json"))).toBe(false);
      // The cap is explorer.rs MAX_READ_BYTES.
      expect(shows.SHOW_READ_CAP).toBe(512 * 1024);
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inspectPath is the real probe: a folder, a text file, a binary file, a missing path", () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "swb-inspect-"));
    try {
      nodeFs.writeFileSync(nodePath.join(dir, "a.md"), "# héllo");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      (require("fs") as { writeFileSync: (p: string, d: Uint8Array) => void }).writeFileSync(
        nodePath.join(dir, "b.bin"),
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0xc3])
      );
      expect(shows.inspectPath(dir)).toEqual({ kind: "dir", size: 0, text: false });
      expect(shows.inspectPath(nodePath.join(dir, "a.md"))).toMatchObject({ kind: "file", text: true });
      expect(shows.inspectPath(nodePath.join(dir, "b.bin"))).toMatchObject({ kind: "file", text: false });
      expect(shows.inspectPath(nodePath.join(dir, "nope.md")).kind).toBe("missing");
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a page address whose params the app's strict parser rejects is refused, not reported as opening (review of 49ebb20, #3)", () => {
    expect(() => norm("surface:lodestar/trading?Bad=1")).toThrow(/has params the page would refuse/);
    expect(() => norm("surface:lodestar/trading?date=")).toThrow(/has params the page would refuse/);
    expect(() => norm("surface:lodestar/trading?a=1&a=2")).toThrow(/has params the page would refuse/);
    expect(() => norm(`surface:lodestar/trading?a=${"x".repeat(121)}`)).toThrow(/has params the page would refuse/);
    const nine = Array.from({ length: 9 }, (_, i) => `k${i}=v`).join("&");
    expect(() => norm(`surface:lodestar/trading?${nine}`)).toThrow(/has params the page would refuse/);
    expect(norm("surface:lodestar/trading?instrument=NQ&date=2026-06-05").form).toBe("surface");
    // The mirror agrees with the app's parser on every case above.
    for (const q of ["Bad=1", "date=", "a=1&a=2", nine, "instrument=NQ&date=2026-06-05", ""]) {
      expect(shows.surfaceQueryOk(q)).toBe(parseSurfaceQuery(q) !== null);
    }
  });

  it("a path FOUND under cwd is recorded `where: cwd` and opens as that file — never a KB doc of the same path (review of 49ebb20, #1)", () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "swb-shows-"));
    try {
      const found = shows.performShowOp(dir, { op: "show", address: "README.md" }, NOW, { cwd: CWD, exists: () => true });
      expect(found.show.where).toBe("cwd");
      const [stored] = parseShowsFile(nodeFs.readFileSync(nodePath.join(dir, "shows.json"), "utf8"));
      // personal-kb/README.md exists in the KB list — and still does not win.
      const ctx = { threadId: "t1", kbDocs: ["README.md", "registry.json"], projectKey: "lodestar", kbRoot: "C:/Users/eric/projects/personal-kb" };
      expect(showTargetFor(stored.address, ctx, stored.where)?.artifact).toEqual({ kind: "repo-file", project: "lodestar", path: "README.md" });
      // Without the field (an entry written before it existed) the old order holds.
      expect(showTargetFor(stored.address, ctx)?.artifact).toEqual({ kind: "kb-doc", path: "README.md" });
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ROUND-TRIP: every address the server stores resolves through the app's resolver (or to nothing, as the result said)", () => {
    const ctx = { threadId: "t1", kbDocs: ["switchboard/notes.md"], projectKey: "lodestar", kbRoot: "C:/Users/eric/projects/personal-kb" };
    const stored = (raw: string, viewIds: string[] = ["v1"]) => shows.normalizeShowAddress(raw, CWD, viewIds).address;
    expect(showTargetFor(stored("specs\\a.md"), ctx)?.artifact).toEqual({ kind: "repo-file", project: "lodestar", path: "specs/a.md" });
    expect(showTargetFor(stored("switchboard/notes.md"), ctx)?.artifact).toEqual({ kind: "kb-doc", path: "switchboard/notes.md" });
    expect(showTargetFor(stored("C:\\Users\\eric\\projects\\personal-kb\\switchboard\\notes.md"), ctx)?.artifact).toEqual({
      kind: "kb-doc",
      path: "switchboard/notes.md",
    });
    expect(showTargetFor(stored("view:v1#h:summary"), ctx)).toEqual({ artifact: { kind: "view", threadId: "t1", viewId: "v1" }, anchor: "h:summary" });
    expect(showTargetFor(stored("surface:lodestar/trading?instrument=NQ"), ctx)?.artifact).toEqual({
      kind: "surface",
      project: "lodestar",
      page: "trading",
      params: { instrument: "NQ" },
    });
    expect(showTargetFor(stored("C:/elsewhere/a.md"), ctx)).toBeNull();
  });

  it("caps are mirrored in showIntent.ts and the tool table states the op", () => {
    expect(shows.SHOW_CAP).toBe(SHOW_CAP);
    expect(shows.SHOW_ADDRESS_CAP).toBe(SHOW_ADDRESS_CAP);
    for (const rule of [
      "op show {address} PUTS AN EXISTING DOC OR FILE IN FRONT OF THE USER",
      "it opens in the panel beside the terminal, in front",
      "nothing is published anywhere",
      "a knowledge-base doc path relative to the knowledge-base root",
      "a file path relative to this thread's working directory",
      "surface:<project>/<page>?key=value; view:<id>",
      "A ticket key or a URL opens nothing",
      "The result says when the address may not resolve — then nothing opens",
      "The last 20 shows are kept",
      "a new report is made with the view tool (kind report), not this op",
    ]) {
      expect(server.PAGE_TOOL.description).toContain(rule);
    }
    const props = (server.PAGE_TOOL.inputSchema as { properties: Record<string, { enum?: string[]; description?: string }> }).properties;
    expect(props.op.enum).toContain("show");
    expect(props.address.description).toContain("show: what to open in the panel");
  });
});

describe("the view tool claims the words a user says (SWIT-102): report, artifact, summary page, in the panel", () => {
  it("the description OPENS with them, keeps the report in Switchboard, and points at page show for what already exists", () => {
    const d = server.VIEW_TOOL.description;
    const opening = d.slice(0, 480);
    expect(opening.startsWith('A REPORT, an "artifact", a summary page, a brief')).toBe(true);
    for (const word of ["REPORT", '"artifact"', "summary page", "IN THE PANEL"]) expect(opening).toContain(word);
    expect(opening).toContain("is made with THIS tool and stays in Switchboard");
    expect(opening).toContain("show it with kind 'report'");
    expect(opening).toContain("Never publish it to claude.ai (the Artifact tool, Claude Docs) unless the user asks for a link to share");
    expect(opening).toContain("A doc or file that ALREADY exists opens with the page tool's op show");
    // The rest of the description is still there, after the claim.
    expect(d).toContain("SHOW the user rendered data in the panel");
    expect(d).toContain("report: ONE document with live views embedded");
  });
});

describe("a dismissed question (SWIT-105) — the app's retracted.json, read-only here", () => {
  const d = server as unknown as {
    dismissedQuestionIds: (page: Record<string, unknown>, retracted: unknown) => Set<string>;
    formatPageRead: (page: Record<string, unknown>, answers: unknown, retracted?: unknown) => string;
    performOp: (threadDir: string, args: Record<string, unknown>, now: number) => string;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeFs = require("fs") as {
    mkdtempSync: (p: string) => string;
    writeFileSync: (p: string, d: string) => void;
    readFileSync: (p: string, e: string) => string;
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeOs = require("os") as { tmpdir: () => string };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require("path") as { join: (...p: string[]) => string };
  const asked = () => run([{ op: "ask", id: "q1", text: "A?" }, { op: "ask", id: "q2", text: "B?" }]); // askedAt = NOW
  const LATER = new Date(NOW + 60_000).toISOString();
  const EARLIER = new Date(NOW - 60_000).toISOString();

  it("dismissedQuestionIds: a question:<id> entry not older than the ask; a re-ask after it brings the question back", () => {
    const page = asked();
    expect(d.dismissedQuestionIds(page, { version: 1, evidence: [{ address: "question:q1", at: LATER }] })).toEqual(new Set(["q1"]));
    // Same second as the ask — still dismissed (whole seconds, pageStore's rule).
    expect(d.dismissedQuestionIds(page, [{ address: "question:q1", at: new Date(NOW + 400).toISOString() }])).toEqual(new Set(["q1"]));
    // Dismissed BEFORE the (re-)ask: the question is back.
    expect(d.dismissedQuestionIds(page, [{ address: "question:q1", at: EARLIER }]).size).toBe(0);
    // Unparseable stamp stays dismissed; evidence rows, unknown ids and junk are ignored.
    expect(d.dismissedQuestionIds(page, [{ address: "question:q2", at: "garbage" }, { address: "SWIT-1", at: LATER }, { address: "question:q9", at: LATER }, null])).toEqual(new Set(["q2"]));
    expect(d.dismissedQuestionIds(page, null).size).toBe(0);
    expect(d.dismissedQuestionIds(page, "junk").size).toBe(0);
  });

  it("a dismissed question does not count against the ask cap; re-asking it brings it back and SAYS so", () => {
    let page = empty();
    for (let i = 0; i < server.QUESTION_CAP; i++) page = server.applyOp(page, { op: "ask", text: `q ${i}` }, NOW).page;
    expect(() => server.applyOp(page, { op: "ask", text: "one more" }, NOW)).toThrow(/already OPEN/);
    const applyDismissed = server.applyOp as unknown as (
      p: Record<string, unknown>, a: Record<string, unknown>, n: number, answered: Set<string>, dismissed: Set<string>
    ) => { page: Record<string, unknown>; message: string };
    expect(() => applyDismissed(page, { op: "ask", text: "one more" }, NOW, new Set(), new Set(["q1"]))).not.toThrow();
    const back = applyDismissed(asked(), { op: "ask", id: "q1", text: "A, again?" }, NOW + 120_000, new Set(), new Set(["q1"]));
    expect(back.message).toMatch(/^Question q1 is back on the page — the user had dismissed it as not needed/);
    expect((back.page.questions as Array<Record<string, unknown>>).find((q) => q.id === "q1")!.askedAt).toBe(new Date(NOW + 120_000).toISOString());
    // A dismissed question can still be resolved (the agent closing it out).
    expect(() => applyDismissed(asked(), { op: "resolve", id: "q1", answer: "moot" }, NOW, new Set(), new Set(["q1"]))).not.toThrow();
  });

  it("op read names a dismissed question by id, outside OPEN QUESTIONS; performOp reads retracted.json", () => {
    const text = d.formatPageRead(asked(), {}, { evidence: [{ address: "question:q1", at: LATER }] });
    expect(text).toContain("OPEN QUESTIONS (1):\n  q2 [decision] B?");
    expect(text).toContain("1 was dismissed by the user as not needed (q1) — do not wait on it; re-ask (same id) only if the answer has come to matter.");
    expect(text).not.toContain("q1 [decision]");
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "swb-dismiss-"));
    try {
      d.performOp(dir, { op: "ask", id: "q1", text: "A?" }, NOW);
      nodeFs.writeFileSync(nodePath.join(dir, "retracted.json"), JSON.stringify({ version: 1, evidence: [{ address: "question:q1", at: LATER }] }));
      expect(d.performOp(dir, { op: "read" }, NOW)).toContain("dismissed by the user as not needed (q1)");
      // Re-asking through the real entry point: the message says it is back.
      expect(d.performOp(dir, { op: "ask", id: "q1", text: "A?" }, NOW + 120_000)).toMatch(/^Question q1 is back on the page/);
      expect(d.performOp(dir, { op: "read" }, NOW + 120_000)).toContain("OPEN QUESTIONS (1):\n  q1 [decision] A?");
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the tool table states dismissal and trimming", () => {
    for (const rule of [
      "An option over 60 chars is CUT at a word boundary with … (the result says which)",
      "The user can DISMISS a question as not needed: it leaves the page and op read names it",
      "re-ask it (same id) only if the answer has come to matter",
    ]) {
      expect(server.PAGE_TOOL.description).toContain(rule);
    }
  });
});

describe("the page tool — the standing brief + op read (SWIT-104)", () => {
  const brief = server as unknown as {
    formatPageRead: (page: Record<string, unknown>, answers: unknown, retracted?: unknown) => string;
    performReadOp: (threadDir: string) => string;
    performOp: (threadDir: string, args: Record<string, unknown>, now: number) => string;
    BRIEF_GOAL_CAP: number;
    BRIEF_LINE_CAP: number;
    BRIEF_LINES_CAP: number;
    READ_CAP: number;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeFs = require("fs") as {
    mkdtempSync: (p: string) => string;
    writeFileSync: (p: string, d: string) => void;
    readFileSync: (p: string, e: string) => string;
    existsSync: (p: string) => boolean;
    readdirSync: (p: string) => string[];
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeOs = require("os") as { tmpdir: () => string };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require("path") as { join: (...p: string[]) => string };
  const AT = new Date(NOW).toISOString();
  const GAMMA = {
    op: "brief",
    goal: " A gamma measure of our own that a discretionary trader can lean on live. ",
    established: ["our all-expiry sum is about 0.58 of the vendor total", " same sign 82% of nights "],
    dead: ["level effects beyond price motion (ten registered tests)"],
    lead: ["overnight hedging debt vs the Europe open"],
    waiting: ["the book (front expiries vs all)", "the state variable"],
  };

  it("writes the brief whole, stamped, trimmed — and it ROUND-TRIPS through pageStore", () => {
    const { page, message } = server.applyOp(empty(), GAMMA, NOW);
    expect(page.brief).toEqual({
      goal: "A gamma measure of our own that a discretionary trader can lean on live.",
      established: ["our all-expiry sum is about 0.58 of the vendor total", "same sign 82% of nights"],
      dead: ["level effects beyond price motion (ten registered tests)"],
      lead: ["overnight hedging debt vs the Europe open"],
      waiting: ["the book (front expiries vs all)", "the state variable"],
      updatedAt: AT,
    });
    expect(message).toMatch(/^Brief written — it is the first block on the page\./);
    const parsed = parsePageFile(JSON.stringify(page));
    expect(parsed.brief).toEqual(page.brief);
    const merged = mergePage(parsed, {}, []);
    expect(merged.brief?.lead).toEqual(["overnight hedging debt vs the Europe open"]);
    expect(merged.isEmpty).toBe(false); // a page holding only a brief is a page
  });

  it("is REPLACED, never appended: a field left out no longer stands; a bare string is one line", () => {
    const first = server.applyOp(empty(), GAMMA, NOW).page;
    const { page, message } = server.applyOp(first, { op: "brief", goal: "A new goal.", lead: "one live lead" }, NOW + 60_000);
    expect(page.brief).toEqual({
      goal: "A new goal.",
      established: [],
      dead: [],
      lead: ["one live lead"],
      waiting: [],
      updatedAt: new Date(NOW + 60_000).toISOString(),
    });
    expect(message).toMatch(/^Brief rewritten/);
    // Lists alone are a brief too (no goal).
    const listsOnly = server.applyOp(empty(), { op: "brief", dead: ["x"] }, NOW).page;
    expect((listsOnly.brief as { goal: unknown }).goal).toBeNull();
    expect(parsePageFile(JSON.stringify(listsOnly)).brief?.dead).toEqual(["x"]);
  });

  it("is CLEARED by passing only empty fields — the key leaves the file", () => {
    const first = server.applyOp(empty(), GAMMA, NOW).page;
    const cleared = server.applyOp(first, { op: "brief", goal: "" }, NOW);
    expect("brief" in cleared.page).toBe(false);
    expect(cleared.message).toBe("Brief cleared.");
    expect(parsePageFile(JSON.stringify(cleared.page)).brief).toBeNull();
    expect(server.applyOp(empty(), { op: "brief", established: [], waiting: ["  "] }, NOW).message).toBe("Brief cleared — there was none.");
  });

  it("caps are VISIBLE errors: no field, a long goal, a long line, too many lines, a non-string line", () => {
    expect(brief.BRIEF_GOAL_CAP).toBe(300);
    expect(brief.BRIEF_LINE_CAP).toBe(200);
    expect(brief.BRIEF_LINES_CAP).toBe(6);
    expect(() => server.applyOp(empty(), { op: "brief" }, NOW)).toThrow(/at least one of goal, established, dead, lead, waiting/);
    expect(() => server.applyOp(empty(), { op: "brief", goal: null, dead: null }, NOW)).toThrow(/REPLACED whole/);
    expect(() => server.applyOp(empty(), { op: "brief", goal: "g".repeat(301) }, NOW)).toThrow(/goal is too long \(301 chars; the cap is 300\)/);
    expect(() => server.applyOp(empty(), { op: "brief", goal: "g".repeat(300) }, NOW)).not.toThrow();
    expect(() => server.applyOp(empty(), { op: "brief", goal: 7 }, NOW)).toThrow(/goal must be one sentence/);
    expect(() => server.applyOp(empty(), { op: "brief", dead: ["l".repeat(201)] }, NOW)).toThrow(/a line in dead is too long \(201 chars; the cap is 200\)/);
    expect(() => server.applyOp(empty(), { op: "brief", established: Array.from({ length: 7 }, (_, i) => `fact ${i}`) }, NOW)).toThrow(
      /established has 7 lines; the cap is 6/
    );
    expect(() => server.applyOp(empty(), { op: "brief", established: Array.from({ length: 6 }, (_, i) => `fact ${i}`) }, NOW)).not.toThrow();
    expect(() => server.applyOp(empty(), { op: "brief", waiting: ["ok", 4] }, NOW)).toThrow(/waiting must be an array of short plain lines/);
    expect(() => server.applyOp(empty(), { op: "brief", lead: { a: 1 } }, NOW)).toThrow(/lead must be an array/);
  });

  it("the brief SURVIVES every other op (parsePage carries it), and a page without one serializes as before", () => {
    let page = server.applyOp(empty(), GAMMA, NOW).page;
    page = server.parsePage(JSON.stringify(page)); // what the next op reads back from disk
    page = server.applyOp(page, { op: "turn", lines: ["Did a thing."] }, NOW).page;
    page = server.applyOp(server.parsePage(JSON.stringify(page)), { op: "item", itemOp: "add", title: "t" }, NOW).page;
    expect((page.brief as { goal: string }).goal).toBe("A gamma measure of our own that a discretionary trader can lean on live.");
    expect("brief" in empty()).toBe(false);
    expect("brief" in server.applyOp(empty(), { op: "theme", text: "t" }, NOW).page).toBe(false);
    // A junk brief in the file is dropped at the read, not carried.
    expect("brief" in server.parsePage(JSON.stringify({ brief: ["not", "an", "object"] }))).toBe(false);
  });

  const worked = () =>
    run([
      { op: "theme", text: "Build a gamma measure of our own" },
      GAMMA,
      { op: "turn", lines: ["First turn."] },
      { op: "turn", lines: ["Second turn.", "Two lines."] },
      { op: "turn", lines: ["Third turn."] },
      { op: "turn", lines: ["Fourth turn — the newest."] },
      { op: "ask", id: "q1", text: "Which options are the book?", options: ["front expiries", "all expiries"], default: "all expiries" },
      { op: "ask", id: "q2", text: "State variable?", kind: "info" },
      { op: "ask", id: "q3", text: "Keep the old keys?" },
      { op: "ask", id: "q4", text: "Which vendor?" },
      { op: "resolve", id: "q3", answer: "moot — the keys are gone" },
      { op: "item", itemOp: "add", title: "Run the release model", state: "in_progress" },
      { op: "item", itemOp: "add", title: "Pick the book", owner: "user", state: "waiting" },
      { op: "item", itemOp: "add", title: "Old thing" },
      { op: "item", itemOp: "close", id: "i3" },
    ]);

  it("read prints EVERY section: theme, the brief, open questions with ids, open items, standing decisions, the last three turns", () => {
    const answers = {
      q2: { text: "net over gross", at: "2026-08-31T11:00:00Z", sentAt: "2026-08-31T11:05:00Z", resolvedBy: "user" },
      q4: { text: "the second one", at: "2026-08-31T12:00:00Z" }, // saved on the page, NOT sent
    };
    const text = brief.formatPageRead(worked(), answers);
    expect(text).toBe(
      [
        "THEME: Build a gamma measure of our own",
        "",
        `WHERE THINGS STAND (the brief, rewritten ${AT}):`,
        "  Goal: A gamma measure of our own that a discretionary trader can lean on live.",
        "  Established:",
        "    - our all-expiry sum is about 0.58 of the vendor total",
        "    - same sign 82% of nights",
        "  Dead:",
        "    - level effects beyond price motion (ten registered tests)",
        "  Live lead:",
        "    - overnight hedging debt vs the Europe open",
        "  Waiting on the user:",
        "    - the book (front expiries vs all)",
        "    - the state variable",
        "",
        "OPEN QUESTIONS (1):",
        "  q1 [decision] Which options are the book? | options: front expiries / all expiries | default: all expiries",
        "  1 more is answered on the page and not sent yet (q4) — the answer arrives in the Decisions message; do not re-ask.",
        "",
        "TO DO (2 open):",
        "  i2 [waiting, the user] Pick the book",
        "  i1 [in_progress, you] Run the release model",
        "",
        "STANDING DECISIONS (2):",
        "  decision:q2 State variable? → net over gross (the user)",
        "  decision:q3 Keep the old keys? → moot — the keys are gone (settled by you)",
        "",
        "FINDINGS (0):",
        "  (none)",
        "",
        "LAST TURNS (newest first, 3 of 4):",
        `  ${AT}: Fourth turn — the newest.`,
        `  ${AT}: Third turn.`,
        `  ${AT}: Second turn. | Two lines.`,
      ].join("\n")
    );
    // An unsent answer's TEXT is never in the read — the user may still change it.
    expect(text).not.toContain("the second one");
  });

  it("read on an empty page still names every section, and says how to start a brief", () => {
    const text = brief.formatPageRead(empty(), {});
    for (const heading of [
      "THEME: (none",
      "WHERE THINGS STAND: no brief yet — write one with op brief.",
      "OPEN QUESTIONS (0):",
      "TO DO (0 open):",
      "STANDING DECISIONS (0):",
      "FINDINGS (0):",
      "LAST TURNS (newest first, 0 of 0):",
    ]) {
      expect(text).toContain(heading);
    }
    // Junk answers and a hand-corrupted page (nulls in the arrays) do not throw.
    const corrupted = server.parsePage(
      JSON.stringify({ questions: [null, { id: "q2", text: "t" }], items: [null], turns: [null, { lines: [7, "kept"] }], brief: { goal: 4, dead: ["x", 9] } })
    );
    const out = brief.formatPageRead(corrupted, "junk");
    expect(out).toContain("  q2 [decision] t");
    expect(out).toContain("    - x");
    expect(out).toContain("kept");
  });

  it("read stays under READ_CAP on a page at every cap — sections all present, lists cut with a count", () => {
    expect(brief.READ_CAP).toBe(8000);
    const long = (tag: string, n: number) => `${tag} ${"word ".repeat(200)}`.slice(0, n).trim();
    let page = empty();
    page = server.applyOp(page, { op: "theme", text: long("theme", 500) }, NOW).page;
    page = server.applyOp(
      page,
      {
        op: "brief",
        goal: long("goal", 300),
        established: Array.from({ length: 6 }, (_, i) => long(`e${i}`, 200)),
        dead: Array.from({ length: 6 }, (_, i) => long(`d${i}`, 200)),
        lead: Array.from({ length: 6 }, (_, i) => long(`l${i}`, 200)),
        waiting: Array.from({ length: 6 }, (_, i) => long(`w${i}`, 200)),
      },
      NOW
    ).page;
    for (let i = 0; i < server.QUESTION_CAP; i++) {
      page = server.applyOp(page, { op: "ask", text: long(`question ${i}`, 500), options: ["a".repeat(60), "b".repeat(60), "c".repeat(60)] }, NOW).page;
    }
    for (let i = 0; i < 60; i++) page = server.applyOp(page, { op: "item", itemOp: "add", title: long(`item ${i}`, 500) }, NOW).page;
    for (let i = 0; i < server.TURN_CAP; i++) {
      page = server.applyOp(page, { op: "turn", lines: Array.from({ length: 6 }, (_, j) => long(`turn ${i} line ${j}`, 500)) }, NOW).page;
    }
    // SWIT-106: a full ledger too.
    for (let i = 0; i < 60; i++) {
      page = server.applyOp(page, { op: "finding", claim: long(`finding ${i}`, 240), verdict: "open", n: "n".repeat(40), report: `docs/${"r".repeat(280)}.md` }, NOW + i).page;
    }
    const text = brief.formatPageRead(page, {});
    expect(text.length).toBeLessThanOrEqual(brief.READ_CAP);
    for (const heading of [
      "THEME: ",
      "WHERE THINGS STAND (the brief",
      "OPEN QUESTIONS (20):",
      "TO DO (60 open):",
      "STANDING DECISIONS (0):",
      "FINDINGS (60):",
      "LAST TURNS (newest first, ",
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toMatch(/\(\+ \d+ more — the page lists them\)/);
    // Newest first inside a cut list: the newest item and question are the ones kept.
    expect(text).toContain("  i60 [todo, you] item 59");
    expect(text).toContain("  q20 [decision] question 19");
    expect(text).not.toMatch(/\n {2}i1 \[/);
    // A modest page is printed at the roomiest level — nothing clipped.
    expect(brief.formatPageRead(worked(), {})).not.toContain("…");
  });

  it("the BRIEF is never clipped: at every cap, beside every other section at its cap, it reads back byte-for-byte (review of daaad36, #1)", () => {
    const long = (tag: string, n: number) => `${tag} ${"wörd ".repeat(200)}`.slice(0, n).trim();
    const goal = long("goal", 300);
    const lists = {
      established: Array.from({ length: 6 }, (_, i) => long(`established ${i}`, 200)),
      dead: Array.from({ length: 6 }, (_, i) => long(`dead ${i}`, 200)),
      lead: Array.from({ length: 6 }, (_, i) => long(`lead ${i}`, 200)),
      waiting: Array.from({ length: 6 }, (_, i) => long(`waiting ${i}`, 200)),
    };
    let page = empty();
    page = server.applyOp(page, { op: "theme", text: long("theme", 500) }, NOW).page;
    page = server.applyOp(page, { op: "brief", goal, ...lists }, NOW).page;
    // Every other section at its cap: 20 open questions + 40 answered and
    // sent + 20 dismissed (every id list long), 60 items, 30 full turns, 60
    // findings with long reports.
    const answers: Record<string, { text: string; at: string; sentAt: string }> = {};
    const dismissed: { address: string; at: string }[] = [];
    for (let i = 0; i < 80; i++) {
      const id = `question-with-a-long-id-${i}`;
      const answered = new Set<string>(Object.keys(answers));
      const gone = new Set<string>(dismissed.map((d) => d.address.slice("question:".length)));
      page = (server.applyOp as unknown as (
        p: Record<string, unknown>,
        a: Record<string, unknown>,
        n: number,
        answered: Set<string>,
        dismissed: Set<string>
      ) => { page: Record<string, unknown> })(page, { op: "ask", id, text: long(`question ${i}`, 500), options: ["a".repeat(60), "b".repeat(60)] }, NOW + i, answered, gone).page;
      if (i < 40) answers[id] = { text: long(`answer ${i}`, 500), at: "2026-08-31T11:00:00Z", sentAt: "2026-08-31T11:00:05Z" };
      else if (i < 60) dismissed.push({ address: `question:${id}`, at: "2026-09-30T00:00:00Z" });
    }
    for (let i = 0; i < 60; i++) page = server.applyOp(page, { op: "item", itemOp: "add", title: long(`item ${i}`, 500) }, NOW).page;
    for (let i = 0; i < server.TURN_CAP; i++) {
      page = server.applyOp(page, { op: "turn", lines: Array.from({ length: 6 }, (_, j) => long(`turn ${i} line ${j}`, 500)) }, NOW).page;
    }
    for (let i = 0; i < 60; i++) {
      page = server.applyOp(page, { op: "finding", claim: long(`finding ${i}`, 240), verdict: "open", n: "n".repeat(40), report: `docs/${"r".repeat(280)}.md` }, NOW + i).page;
    }
    const text = brief.formatPageRead(page, answers, { version: 1, evidence: dismissed });
    expect(text.length).toBeLessThanOrEqual(brief.READ_CAP);
    expect(text).toContain(`  Goal: ${goal}\n`);
    for (const [label, lines] of [
      ["Established", lists.established],
      ["Dead", lists.dead],
      ["Live lead", lists.lead],
      ["Waiting on the user", lists.waiting],
    ] as const) {
      expect(text).toContain(`  ${label}:\n${lines.map((l) => `    - ${l}`).join("\n")}\n`);
    }
    // …and the sections the brief shares the cap with are all still there.
    for (const heading of ["OPEN QUESTIONS (20):", "TO DO (60 open):", "STANDING DECISIONS (40):", "FINDINGS (60):", "LAST TURNS (newest first, "]) {
      expect(text).toContain(heading);
    }
    expect(text).not.toContain("… (cut — the page holds more)");
  });

  it("performOp read returns the text and WRITES NOTHING — no page.json, no tmp file", () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "swb-read-"));
    try {
      const fresh = brief.performOp(dir, { op: "read" }, NOW);
      expect(fresh).toContain("WHERE THINGS STAND: no brief yet");
      expect(nodeFs.readdirSync(dir)).toEqual([]);
      brief.performOp(dir, GAMMA, NOW);
      brief.performOp(dir, { op: "ask", id: "q1", text: "A?" }, NOW);
      nodeFs.writeFileSync(
        nodePath.join(dir, "answers.json"),
        JSON.stringify({ q1: { text: "yes", at: "2026-08-31T11:00:00Z", sentAt: "2026-08-31T11:00:05Z" } })
      );
      const before = nodeFs.readFileSync(nodePath.join(dir, "page.json"), "utf8");
      const text = brief.performOp(dir, { op: "read" }, NOW + 5000);
      expect(text).toContain("  Live lead:\n    - overnight hedging debt vs the Europe open");
      expect(text).toContain("  decision:q1 A? → yes (the user)");
      expect(text).toBe(brief.performReadOp(dir));
      expect(nodeFs.readFileSync(nodePath.join(dir, "page.json"), "utf8")).toBe(before);
      expect(nodeFs.readdirSync(dir).sort()).toEqual(["answers.json", "page.json"]);
      // The pure page half refuses it rather than pretending to write a page.
      expect(() => server.applyOp(empty(), { op: "read" }, NOW)).toThrow(/returns it/);
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the tool table states the brief contract and the read op", () => {
    for (const rule of [
      "KEEP THE BRIEF CURRENT — rewrite it at every seam (a finding lands, a decision is made, the direction changes); it is what the user reads after days away.",
      "op brief {goal, established, dead, lead, waiting} writes WHERE THINGS STAND, the first block on the page",
      "goal is ONE sentence (≤ 300 chars)",
      "are each ≤ 6 short plain lines (≤ 200 chars)",
      "The brief is REPLACED WHOLE by every call",
      'goal: "" alone clears it',
      "op read RETURNS THE PAGE as compact plain text",
      "the open questions with their ids, the ids of questions the user dismissed as not needed, the open items, the standing decisions, the findings, the last three turns",
      "(≤ 8000 chars)",
      "the brief (always whole, never clipped)",
      "on a full page the turns are cut first, then the lists",
      "writes nothing",
      "call it FIRST when you are resumed",
    ]) {
      expect(server.PAGE_TOOL.description).toContain(rule);
    }
    const props = (server.PAGE_TOOL.inputSchema as { properties: Record<string, { enum?: string[]; type?: string }> }).properties;
    expect(props.op.enum).toContain("brief");
    expect(props.op.enum).toContain("read");
    expect(props.goal.type).toBe("string");
    for (const list of ["established", "dead", "lead", "waiting"]) expect(props[list].type).toBe("array");
    // The caps stated to the agent are the caps the app's parser applies.
    expect([brief.BRIEF_GOAL_CAP, brief.BRIEF_LINE_CAP, brief.BRIEF_LINES_CAP]).toEqual([BRIEF_GOAL_CAP, BRIEF_LINE_CAP, BRIEF_LINES_CAP]);
  });
});

describe("the page tool — op finding, the Findings ledger (SWIT-106)", () => {
  const f = server as unknown as {
    formatPageRead: (page: Record<string, unknown>, answers: unknown, retracted?: unknown) => string;
    FINDING_VERDICTS: string[];
    FINDING_CAP: number;
    FINDING_CLAIM_CAP: number;
    FINDING_N_CAP: number;
    FINDING_REPORT_CAP: number;
  };
  type Row = { id: string; claim: string; verdict: string; n: string | null; report: string | null; updatedAt: string };
  const findingsOf = (page: Record<string, unknown>) => (page.findings ?? []) as Row[];

  it("adds a finding with a minted id, newest first; the row round-trips through pageStore", () => {
    let page = server.applyOp(empty(), { op: "finding", claim: " Debt by 02:00 predicts the Europe-open block ", verdict: "lead", n: 264, report: "view:model4-debt" }, NOW).page;
    const second = server.applyOp(page, { op: "finding", claim: "All-expiry ÷ vendor total = 0.58", verdict: "fact", n: "531 nights" }, NOW + 1000);
    page = second.page;
    expect(second.message).toMatch(/^Finding f2 recorded \(fact\) in the page's Findings ledger/);
    expect(findingsOf(page)).toEqual([
      { id: "f2", claim: "All-expiry ÷ vendor total = 0.58", verdict: "fact", n: "531 nights", report: null, updatedAt: new Date(NOW + 1000).toISOString() },
      { id: "f1", claim: "Debt by 02:00 predicts the Europe-open block", verdict: "lead", n: "264", report: "view:model4-debt", updatedAt: new Date(NOW).toISOString() },
    ]);
    const parsed = parsePageFile(JSON.stringify(page));
    expect(parsed.findings).toEqual(findingsOf(page));
    const merged = mergePage(parsed, {}, []);
    expect(merged.findings.map((x) => x.id)).toEqual(["f2", "f1"]);
    expect(merged.isEmpty).toBe(false);
  });

  it("the same id UPDATES in place — omitted fields kept, \"\" clears n / report; the moved row sorts first in the merge", () => {
    let page = run([
      { op: "finding", claim: "Charm dominates quiet nights", verdict: "open", n: "4", report: "reports/charm.md" },
      { op: "finding", claim: "Second", verdict: "open" },
    ]);
    const upd = server.applyOp(page, { op: "finding", id: "f1", verdict: "dead", n: "" }, NOW + 60_000);
    page = upd.page;
    expect(upd.message).toBe("Finding f1 updated (dead).");
    const rows = findingsOf(page);
    expect(rows.map((r) => r.id)).toEqual(["f2", "f1"]); // in place in the file
    expect(rows[1]).toEqual({ id: "f1", claim: "Charm dominates quiet nights", verdict: "dead", n: null, report: "reports/charm.md", updatedAt: new Date(NOW + 60_000).toISOString() });
    page = server.applyOp(page, { op: "finding", id: "f1", report: "" }, NOW + 61_000).page;
    expect(findingsOf(page)[1].report).toBeNull();
    // A caller-chosen stable id is a NEW finding the first time, then updates.
    page = server.applyOp(page, { op: "finding", id: "gap-audit", claim: "Gap audit", verdict: "fact" }, NOW).page;
    page = server.applyOp(page, { op: "finding", id: "gap-audit", verdict: "lead" }, NOW + 1).page;
    expect(findingsOf(page).filter((r) => r.id === "gap-audit")).toHaveLength(1);
    expect(findingsOf(page)[0]).toMatchObject({ id: "gap-audit", verdict: "lead", claim: "Gap audit" });
    // The merge puts the most recently moved finding first.
    expect(mergePage(parsePageFile(JSON.stringify(page)), {}, []).findings[0].id).toBe("f1");
  });

  it("findingOp drop removes one; the last one out takes the key with it", () => {
    const page = run([{ op: "finding", claim: "Only one", verdict: "open" }]);
    const dropped = server.applyOp(page, { op: "finding", findingOp: "drop", id: "f1" }, NOW);
    expect(dropped.message).toBe("Finding f1 dropped.");
    expect("findings" in dropped.page).toBe(false);
    expect(() => server.applyOp(page, { op: "finding", findingOp: "drop", id: "f9" }, NOW)).toThrow(/no finding with id f9/);
    expect(() => server.applyOp(page, { op: "finding", findingOp: "vanish", id: "f1" }, NOW)).toThrow(/findingOp must be "drop"/);
    // A page without findings serializes as before; the ledger survives other ops.
    expect("findings" in empty()).toBe(false);
    const kept = server.applyOp(server.parsePage(JSON.stringify(page)), { op: "turn", lines: ["t"] }, NOW).page;
    expect(findingsOf(kept)).toHaveLength(1);
  });

  it("caps and shapes are VISIBLE errors", () => {
    expect(f.FINDING_VERDICTS).toEqual(["lead", "open", "fact", "dead"]);
    expect([f.FINDING_CAP, f.FINDING_CLAIM_CAP, f.FINDING_N_CAP, f.FINDING_REPORT_CAP]).toEqual([60, 240, 40, 300]);
    expect(() => server.applyOp(empty(), { op: "finding", verdict: "lead" }, NOW)).toThrow(/claim is required/);
    expect(() => server.applyOp(empty(), { op: "finding", claim: "c" }, NOW)).toThrow(/verdict is required/);
    expect(() => server.applyOp(empty(), { op: "finding", claim: "c", verdict: "maybe" }, NOW)).toThrow(/verdict must be one of lead, open, fact, dead/);
    expect(() => server.applyOp(empty(), { op: "finding", claim: "c".repeat(241), verdict: "open" }, NOW)).toThrow(/claim is too long \(241 chars; the cap is 240\)/);
    expect(() => server.applyOp(empty(), { op: "finding", claim: "c".repeat(240), verdict: "open" }, NOW)).not.toThrow();
    expect(() => server.applyOp(empty(), { op: "finding", claim: "c", verdict: "open", n: "n".repeat(41) }, NOW)).toThrow(/n is too long/);
    expect(() => server.applyOp(empty(), { op: "finding", claim: "c", verdict: "open", n: { a: 1 } }, NOW)).toThrow(/n must be a short string/);
    expect(() => server.applyOp(empty(), { op: "finding", claim: "c", verdict: "open", report: "r".repeat(301) }, NOW)).toThrow(/report is too long .* it is an address/);
    expect(() => server.applyOp(empty(), { op: "finding", id: "bad id!", claim: "c", verdict: "open" }, NOW)).toThrow(/id must be a short stable key/);
    let page = empty();
    for (let i = 0; i < f.FINDING_CAP; i++) page = server.applyOp(page, { op: "finding", claim: `c${i}`, verdict: "open" }, NOW).page;
    expect(() => server.applyOp(page, { op: "finding", claim: "one more", verdict: "open" }, NOW)).toThrow(/60 findings are already on the page — drop/);
    // An UPDATE at the cap is fine.
    expect(() => server.applyOp(page, { op: "finding", id: "f3", verdict: "fact" }, NOW)).not.toThrow();
    // A hand-corrupted ledger (nulls) does not break the op.
    const corrupted = server.parsePage(JSON.stringify({ findings: [null, { id: "f2", claim: "x", verdict: "open" }] }));
    expect(findingsOf(server.applyOp(corrupted, { op: "finding", claim: "y", verdict: "lead" }, NOW).page)[0].id).toBe("f3");
  });

  it("nothing new writes the old `finding:` evidence form — and a row written in it still parses and renders", () => {
    expect(() => server.applyOp(empty(), { op: "evidence", address: "finding:gamma-1", label: "x" }, NOW)).toThrow(/a finding is not an evidence row — record it with op finding/);
    const legacy = parsePageFile(JSON.stringify({ evidence: [{ address: "finding:gamma-1", label: "old", status: "open", updatedAt: "t" }] }));
    expect(mergePage(legacy, {}, []).evidence.map((e) => e.address)).toEqual(["finding:gamma-1"]);
  });

  it("op read lists the ledger newest first with n and report; the tool table states the op", () => {
    const page = run([
      { op: "finding", claim: "Older claim", verdict: "dead", n: "10 tests" },
      { op: "finding", claim: "Newer claim", verdict: "lead", report: "view:v1" },
    ]);
    const bumped = server.applyOp(page, { op: "finding", id: "f1", verdict: "dead" }, NOW + 5000).page; // f1 moved last
    const text = f.formatPageRead(bumped, {});
    expect(text).toContain("FINDINGS (2):\n  f1 [dead] Older claim | n: 10 tests\n  f2 [lead] Newer claim | report: view:v1");
    for (const rule of [
      "RECORD WHAT THE WORK ESTABLISHED as op finding {claim, verdict, n?, report?}",
      "verdict is lead (worth chasing) | open (not settled) | fact (established) | dead (ruled out)",
      "Pass the finding's id (the result gives it) to UPDATE it in place as the verdict moves — never file the same claim twice",
      "findingOp drop {id} removes one that was never right",
      "At most 60 per page",
      "A finding is never an evidence row",
    ]) {
      expect(server.PAGE_TOOL.description).toContain(rule);
    }
    const props = (server.PAGE_TOOL.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.op.enum).toContain("finding");
    expect(props.verdict.enum).toEqual(["lead", "open", "fact", "dead"]);
    expect(props.findingOp.enum).toEqual(["drop"]);
    expect(props.claim).toBeDefined();
    expect(props.n).toBeDefined();
    expect(props.report).toBeDefined();
    // Caps mirrored in pageStore.
    expect([...FINDING_VERDICTS]).toEqual(f.FINDING_VERDICTS);
    expect([FINDING_CAP, FINDING_CLAIM_CAP, FINDING_N_CAP, FINDING_REPORT_CAP]).toEqual([f.FINDING_CAP, f.FINDING_CLAIM_CAP, f.FINDING_N_CAP, f.FINDING_REPORT_CAP]);
  });
});

describe("the view tool — project-level reports (SWIT-107)", () => {
  const pv = server as unknown as {
    performViewOp: (
      threadDir: string,
      args: Record<string, unknown>,
      now: number,
      env?: { cwd?: string; threadId?: string; registryPath?: string | null }
    ) => { spec: Record<string, unknown>; message: string };
    performShowOp: (
      threadDir: string,
      args: Record<string, unknown>,
      now: number,
      env?: { cwd?: string; exists?: (p: string) => boolean; registryPath?: string | null }
    ) => { show: { id: string; address: string }; message: string };
    readRegistryProjects: (p: string | null | undefined) => { key: string; repos: string[] }[] | null;
    projectPlaceFor: (projects: { key: string; repos: string[] }[] | null, cwd: string) => { key: string; repoRoot: string; base: string } | null;
    projectViewAddress: (project: string, id: string) => string;
    PROJECT_VIEW_INDEX_CAP: number;
    VIEW_SCOPES: string[];
    VIEW_TOOL: { description: string; inputSchema: { properties: Record<string, { enum?: string[] }> } };
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeFs = require("fs") as {
    mkdtempSync: (p: string) => string;
    mkdirSync: (p: string, o?: { recursive: boolean }) => void;
    writeFileSync: (p: string, d: string) => void;
    readFileSync: (p: string, e: string) => string;
    existsSync: (p: string) => boolean;
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeOs = require("os") as { tmpdir: () => string };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodePath = require("path") as { join: (...p: string[]) => string };

  /** A registry whose reposRoot holds `lodestar` (single repo) and `kyde`
   *  (two repos), and two thread dirs. */
  function fixture() {
    const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "swb-pviews-")).split("\\").join("/");
    for (const d of ["repos/lodestar/apps/desktop", "repos/admin-panel", "repos/api", "t1", "t2", "kb"]) {
      nodeFs.mkdirSync(`${root}/${d}`, { recursive: true });
    }
    const registryPath = `${root}/kb/registry.json`;
    nodeFs.writeFileSync(
      registryPath,
      JSON.stringify({
        conventions: { reposRoot: `${root}/repos/` },
        projects: { lodestar: { repos: ["lodestar"] }, kyde: { repos: ["admin-panel", "api"] }, broken: "x" },
      })
    );
    return { root, registryPath, cleanup: () => nodeFs.rmSync(root, { recursive: true, force: true }) };
  }
  const report = (over: Record<string, unknown> = {}) => ({
    op: "show",
    kind: "report",
    title: "gamma review",
    source: { type: "file", path: "analysis.md" },
    ...over,
  });
  const readJson = (p: string) => JSON.parse(nodeFs.readFileSync(p, "utf8"));

  it("the registry parse and the place: longest repo holding the cwd, `base` = the cwd under that repo", () => {
    const f = fixture();
    try {
      const projects = pv.readRegistryProjects(f.registryPath)!;
      expect(projects.map((p) => p.key)).toEqual(["lodestar", "kyde"]);
      const place = pv.projectPlaceFor(projects, `${f.root}/repos/lodestar/apps/desktop`);
      expect(place).toMatchObject({ key: "lodestar", repoRoot: `${f.root}/repos/lodestar`, base: "apps/desktop" });
      expect(pv.projectPlaceFor(projects, `${f.root}/repos/LODESTAR/`)).toMatchObject({ key: "lodestar", base: "" });
      expect(pv.projectPlaceFor(projects, `${f.root}/repos/api`)).toMatchObject({ key: "kyde", repoRoot: `${f.root}/repos/api` });
      expect(pv.projectPlaceFor(projects, `${f.root}/repos/lodestar-old`)).toBeNull();
      expect(pv.projectPlaceFor(null, `${f.root}/repos/lodestar`)).toBeNull();
      expect(pv.readRegistryProjects(`${f.root}/nope.json`)).toBeNull();
      expect(pv.readRegistryProjects(null)).toBeNull();
    } finally {
      f.cleanup();
    }
  });

  it("a REPORT defaults to project scope: the thread copy AND the project copy + index, with base and threadId", () => {
    const f = fixture();
    try {
      const env = { cwd: `${f.root}/repos/lodestar/apps/desktop`, threadId: "t-one", registryPath: f.registryPath };
      const out = pv.performViewOp(`${f.root}/t1`, report(), NOW, env);
      expect(out.spec).toMatchObject({ id: "v1", scope: "project", project: "lodestar", base: "apps/desktop", threadId: "t-one" });
      expect(out.message).toContain("The PROJECT lodestar owns it (view:lodestar/v1");
      const threadCopy = readJson(`${f.root}/t1/views/v1.json`);
      const projectCopy = readJson(`${f.root}/repos/lodestar/.sb-views/_project/v1.json`);
      expect(projectCopy).toEqual(threadCopy);
      // The app's tolerant parser reads the copy as the same report.
      expect(parseViewSpec(JSON.stringify(projectCopy)).spec?.kind).toBe("report");
      expect(readJson(`${f.root}/repos/lodestar/.sb-views/_project/index.json`)).toEqual({
        version: 1,
        views: [{ id: "v1", title: "gamma review", kind: "report", builtAt: "2026-08-31T10:00:00.000Z", threadId: "t-one" }],
      });
      // Any other kind stays in the thread unless asked.
      const table = pv.performViewOp(`${f.root}/t1`, { op: "show", kind: "table", title: "rows", source: { type: "file", path: "r.json" } }, NOW, env);
      expect(table.spec.scope).toBeUndefined();
      expect(nodeFs.existsSync(`${f.root}/repos/lodestar/.sb-views/_project/${table.spec.id}.json`)).toBe(false);
      // …and scope project gives it the same life; scope thread keeps a report in the thread.
      const pinned = pv.performViewOp(`${f.root}/t1`, { op: "show", kind: "table", title: "rows", source: { type: "file", path: "r.json" }, scope: "project" }, NOW, env);
      expect(pinned.spec.scope).toBe("project");
      const local = pv.performViewOp(`${f.root}/t1`, report({ scope: "thread" }), NOW, env);
      expect(local.spec.scope).toBeUndefined();
      expect(nodeFs.existsSync(`${f.root}/repos/lodestar/.sb-views/_project/${local.spec.id}.json`)).toBe(false);
      expect(() => pv.performViewOp(`${f.root}/t1`, report({ scope: "global" }), NOW, env)).toThrow(/scope must be "thread" or "project"/);
    } finally {
      f.cleanup();
    }
  });

  it("ids are PROJECT-unique: another thread's id is refused by name; a minted id counts the project's ids", () => {
    const f = fixture();
    try {
      const envA = { cwd: `${f.root}/repos/lodestar`, threadId: "t-a", registryPath: f.registryPath };
      const envB = { cwd: `${f.root}/repos/lodestar`, threadId: "t-b", registryPath: f.registryPath };
      pv.performViewOp(`${f.root}/t1`, report({ id: "gamma" }), NOW, envA);
      expect(() => pv.performViewOp(`${f.root}/t2`, report({ id: "gamma" }), NOW, envB)).toThrow(
        /view id gamma is already a project view of another thread \(t-a\) in lodestar — pick another id, or omit id to mint one/
      );
      pv.performViewOp(`${f.root}/t1`, report(), NOW, envA); // v1 in the project, from t1
      const minted = pv.performViewOp(`${f.root}/t2`, report(), NOW + 1, envB);
      expect(minted.spec.id).toBe("v2"); // t2 has no views, but the project already holds v1
      const index = readJson(`${f.root}/repos/lodestar/.sb-views/_project/index.json`);
      expect(index.views.map((v: { id: string }) => v.id)).toEqual(["v2", "v1", "gamma"]);
    } finally {
      f.cleanup();
    }
  });

  it("update writes BOTH copies — the project one stays authoritative — and moves the index row to the front", () => {
    const f = fixture();
    try {
      const env = { cwd: `${f.root}/repos/lodestar`, threadId: "t-a", registryPath: f.registryPath };
      pv.performViewOp(`${f.root}/t1`, report({ id: "r1" }), NOW, env);
      pv.performViewOp(`${f.root}/t1`, report({ id: "r2" }), NOW + 1, env);
      // An update that names scope thread still writes both: a project view is not demoted by update.
      pv.performViewOp(`${f.root}/t1`, report({ op: "update", id: "r1", title: "gamma v2", scope: "thread" }), NOW + 2, env);
      expect(readJson(`${f.root}/repos/lodestar/.sb-views/_project/r1.json`).title).toBe("gamma v2");
      expect(readJson(`${f.root}/t1/views/r1.json`).title).toBe("gamma v2");
      const index = readJson(`${f.root}/repos/lodestar/.sb-views/_project/index.json`);
      expect(index.views.map((v: { id: string; title: string }) => `${v.id}:${v.title}`)).toEqual(["r1:gamma v2", "r2:gamma review"]);
    } finally {
      f.cleanup();
    }
  });

  it("update KEEPS a view's scope: an older thread-only report stays in its thread, even when another thread holds its id in the project (release review)", () => {
    const f = fixture();
    try {
      const envA = { cwd: `${f.root}/repos/lodestar`, threadId: "t-a", registryPath: f.registryPath };
      const envB = { cwd: `${f.root}/repos/lodestar`, threadId: "t-b", registryPath: f.registryPath };
      // Two threads, each with a thread-only report v1 — what every thread shown before 0.17.0 has.
      pv.performViewOp(`${f.root}/t1`, report({ scope: "thread" }), NOW, envA);
      pv.performViewOp(`${f.root}/t2`, report({ scope: "thread" }), NOW, envB);
      // A updates its v1 with no scope: it stays in the thread — nothing is claimed in the project.
      const a = pv.performViewOp(`${f.root}/t1`, report({ op: "update", id: "v1", title: "A's report" }), NOW + 1, envA);
      expect(a.spec.scope).toBeUndefined();
      expect(nodeFs.existsSync(`${f.root}/repos/lodestar/.sb-views/_project/v1.json`)).toBe(false);
      // A promotes it on purpose; B's update of ITS v1 is still fine (thread scope)…
      pv.performViewOp(`${f.root}/t1`, report({ op: "update", id: "v1", title: "A's report", scope: "project" }), NOW + 2, envA);
      const b = pv.performViewOp(`${f.root}/t2`, report({ op: "update", id: "v1", title: "B's report" }), NOW + 3, envB);
      expect(b.spec.scope).toBeUndefined();
      expect(readJson(`${f.root}/t2/views/v1.json`).title).toBe("B's report");
      expect(readJson(`${f.root}/repos/lodestar/.sb-views/_project/v1.json`).title).toBe("A's report");
      // …and asking to promote it names the way out that applies to an update.
      expect(() => pv.performViewOp(`${f.root}/t2`, report({ op: "update", id: "v1", scope: "project" }), NOW + 4, envB)).toThrow(
        /already a project view of another thread \(t-a\) in lodestar — keep this one in this thread/
      );
    } finally {
      f.cleanup();
    }
  });

  it("a torn or hand-edited project index is never rewritten as a one-row file — the write is refused by name", () => {
    const f = fixture();
    try {
      const env = { cwd: `${f.root}/repos/lodestar`, threadId: "t-a", registryPath: f.registryPath };
      pv.performViewOp(`${f.root}/t1`, report({ id: "r1" }), NOW, env);
      const index = `${f.root}/repos/lodestar/.sb-views/_project/index.json`;
      nodeFs.writeFileSync(index, '{"version":1,"views":[{"id":"r1"');
      expect(() => pv.performViewOp(`${f.root}/t1`, report({ id: "r2" }), NOW + 1, env)).toThrow(/report index .* cannot be read/);
      expect(nodeFs.readFileSync(index, "utf8")).toBe('{"version":1,"views":[{"id":"r1"'); // untouched
      // Thread scope still works while the index is broken.
      expect(pv.performViewOp(`${f.root}/t1`, report({ id: "r3", scope: "thread" }), NOW + 2, env).spec.scope).toBeUndefined();
      // No leftover tmp files from the writes that did happen.
      const listDir = (nodeFs as unknown as { readdirSync: (p: string) => string[] }).readdirSync;
      expect(listDir(`${f.root}/repos/lodestar/.sb-views/_project`).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("no project for the folder: an explicit project scope is refused; a report falls back to the thread and says so", () => {
    const f = fixture();
    try {
      const env = { cwd: `${f.root}/elsewhere`, threadId: "t-a", registryPath: f.registryPath };
      expect(() => pv.performViewOp(`${f.root}/t1`, report({ scope: "project" }), NOW, env)).toThrow(/in no registry project/);
      const kept = pv.performViewOp(`${f.root}/t1`, report(), NOW, env);
      expect(kept.spec.scope).toBeUndefined();
      expect(kept.message).toContain("kept in this thread — its working directory is in no registry project");
      // No registry at all — the same fallback.
      const none = pv.performViewOp(`${f.root}/t1`, report(), NOW, { cwd: `${f.root}/repos/lodestar`, threadId: "t-a", registryPath: null });
      expect(none.spec.scope).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  it("the index is capped at PROJECT_VIEW_INDEX_CAP, newest first (mirrored in repoListing)", () => {
    const f = fixture();
    try {
      const dir = `${f.root}/repos/lodestar/.sb-views/_project`;
      nodeFs.mkdirSync(dir, { recursive: true });
      const views = Array.from({ length: pv.PROJECT_VIEW_INDEX_CAP }, (_, i) => ({ id: `old${i}`, title: "t", kind: "report", builtAt: "", threadId: "t-a" }));
      nodeFs.writeFileSync(`${dir}/index.json`, JSON.stringify({ version: 1, views }));
      pv.performViewOp(`${f.root}/t1`, report({ id: "fresh" }), NOW, { cwd: `${f.root}/repos/lodestar`, threadId: "t-a", registryPath: f.registryPath });
      const index = readJson(`${dir}/index.json`);
      expect(index.views).toHaveLength(pv.PROJECT_VIEW_INDEX_CAP);
      expect(index.views[0].id).toBe("fresh");
      expect(pv.PROJECT_VIEW_INDEX_CAP).toBe(PROJECT_VIEW_INDEX_CAP);
    } finally {
      f.cleanup();
    }
  });

  it("`page show` takes view:<project>/<id> — checked against the project's index when the registry is readable", () => {
    const f = fixture();
    try {
      const env = { cwd: `${f.root}/repos/lodestar`, threadId: "t-a", registryPath: f.registryPath };
      pv.performViewOp(`${f.root}/t1`, report({ id: "gamma" }), NOW, env);
      const ok = pv.performShowOp(`${f.root}/t2`, { op: "show", address: "view:lodestar/gamma#h:results" }, NOW, env);
      expect(ok.show.address).toBe("view:lodestar/gamma#h:results");
      expect(ok.message).toBe("view:lodestar/gamma#h:results is opening in the panel beside the terminal.");
      expect(() => pv.performShowOp(`${f.root}/t2`, { op: "show", address: "view:lodestar/nope" }, NOW, env)).toThrow(/no project view nope in lodestar/);
      expect(() => pv.performShowOp(`${f.root}/t2`, { op: "show", address: "view:lodestar/a b" }, NOW, env)).toThrow(/not a project view address/);
      const unchecked = pv.performShowOp(`${f.root}/t2`, { op: "show", address: "view:lodestar/gamma" }, NOW, { ...env, registryPath: null });
      expect(unchecked.message).toMatch(/opens in the panel beside the terminal if that project owns a view with that id/);
      // The address the result names is the one the app's resolver reads.
      expect(pv.projectViewAddress("lodestar", "gamma")).toBe(projectViewAddress("lodestar", "gamma"));
      expect(showTargetFor("view:lodestar/gamma#h:results", { threadId: "t2", kbDocs: [], projectKey: null, kbRoot: null })).toEqual({
        artifact: { kind: "view", project: "lodestar", viewId: "gamma" },
        anchor: "h:results",
      });
    } finally {
      f.cleanup();
    }
  });

  it("with the registry, a cwd file's `show` result is exact: opening, or plainly nothing outside a project", () => {
    const f = fixture();
    try {
      nodeFs.writeFileSync(`${f.root}/repos/lodestar/README.md`, "# lodestar");
      const inProject = pv.performShowOp(`${f.root}/t1`, { op: "show", address: "README.md" }, NOW, {
        cwd: `${f.root}/repos/lodestar`,
        registryPath: f.registryPath,
      });
      expect(inProject.message).toBe("README.md is opening in the panel beside the terminal.");
      nodeFs.mkdirSync(`${f.root}/loose`, { recursive: true });
      nodeFs.writeFileSync(`${f.root}/loose/notes.md`, "x");
      const loose = pv.performShowOp(`${f.root}/t1`, { op: "show", address: "notes.md" }, NOW, {
        cwd: `${f.root}/loose`,
        registryPath: f.registryPath,
      });
      expect(loose.message).toMatch(/^Recorded — but this thread's working directory is in no registry project/);
    } finally {
      f.cleanup();
    }
  });

  it("the tool states the rule: report defaults to project, the address form, update writes both", () => {
    expect(pv.VIEW_SCOPES).toEqual(["thread", "project"]);
    expect(pv.VIEW_TOOL.inputSchema.properties.scope.enum).toEqual(["thread", "project"]);
    for (const rule of [
      "A REPORT BELONGS TO THE PROJECT by default (scope 'project')",
      "(.sb-views/_project/<id>.json + index.json)",
      "addressed view:<project>/<id>",
      "update writes both copies",
      "scope 'thread' to keep a report in this thread only",
    ]) {
      expect(pv.VIEW_TOOL.description).toContain(rule);
    }
    expect(server.PAGE_TOOL.description).toContain("view:<project>/<id> for a report the project owns");
  });
});

describe("review of daaad36 / c178f2f / 4f016e1 — the server half", () => {
  const srv = server as unknown as {
    applyOp: (
      page: Record<string, unknown>,
      args: Record<string, unknown>,
      now: number,
      answeredIds?: Set<string>,
      dismissedIds?: Set<string>
    ) => { page: Record<string, unknown>; message: string };
    QUESTION_KEEP_CAP: number;
    OPTION_CAP: number;
  };
  const optionsOf = (page: Record<string, unknown>) => (page.questions as { options: string[]; default: string | null }[])[0];

  it("#3 — a page HOLDS at most QUESTION_KEEP_CAP questions (the parser keeps exactly as many); a new ask past it is refused, nothing evicted", () => {
    expect(srv.QUESTION_KEEP_CAP).toBe(QUESTION_KEEP_CAP);
    let page = empty();
    const answered = new Set<string>();
    for (let i = 0; i < srv.QUESTION_KEEP_CAP; i++) {
      page = srv.applyOp(page, { op: "ask", id: `q${i}`, text: `q ${i}` }, NOW, answered).page;
      answered.add(`q${i}`); // answered at once, so the OPEN cap never bites
    }
    expect(() => srv.applyOp(page, { op: "ask", id: "one-more", text: "?" }, NOW, answered)).toThrow(
      /already holds 200 questions, the most it keeps — its decisions stand/
    );
    // Every one the server wrote survives the app's parse — open or not.
    expect(parsePageFile(JSON.stringify(page)).questions).toHaveLength(srv.QUESTION_KEEP_CAP);
    // Re-asking an existing (open) id still works at the cap — it replaces, it does not add.
    const reopened = srv.applyOp(page, { op: "ask", id: "q0", text: "again" }, NOW, new Set());
    expect((reopened.page.questions as unknown[]).length).toBe(srv.QUESTION_KEEP_CAP);
  });

  it("#4 — refusing a finding: evidence row names op finding AND the drop_evidence that clears the old row", () => {
    expect(() => srv.applyOp(empty(), { op: "evidence", address: "finding:f3", label: "x" }, NOW)).toThrow(
      /record it with op finding \{claim, verdict, n\?, report\?\}.*then remove the old row with op drop_evidence \{addresses: \["finding:f3"\]\}/
    );
  });

  it("#6 — an option is cut on GRAPHEME boundaries: a flag, a ZWJ family and a combining mark stay whole", () => {
    const pad = "x".repeat(srv.OPTION_CAP - 3);
    for (const tail of ["🇯🇵🇯🇵", "👨‍👩‍👧‍👦 family", "é́ accents"]) {
      const opt = `${pad}${tail} and more words to force the cut`;
      const cut = optionsOf(srv.applyOp(empty(), { op: "ask", text: "q", options: [opt, "b"] }, NOW).page).options[0];
      expect(cut.endsWith("…")).toBe(true);
      expect(cut.length).toBeLessThanOrEqual(srv.OPTION_CAP);
      const body = cut.slice(0, -1);
      // Whatever survives is a PREFIX of whole graphemes of the original.
      const Segmenter = (Intl as unknown as { Segmenter: new (l: undefined, o: { granularity: "grapheme" }) => { segment: (t: string) => Iterable<{ segment: string }> } }).Segmenter;
      const graphemes = Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(opt), (g) => g.segment);
      let joined = "";
      let whole = false;
      for (const g of graphemes) {
        if (joined === body) {
          whole = true;
          break;
        }
        joined += g;
      }
      expect(whole || joined === body).toBe(true);
      // No orphans: no lone surrogate, no dangling ZWJ, no regional indicator half (a combining mark rides with its base — the prefix check above).
      expect(body).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(body.endsWith("\u200D")).toBe(false);
      expect((body.match(/[\u{1F1E6}-\u{1F1FF}]/gu) ?? []).length % 2).toBe(0);
    }
  });

  it("#6 — `default` is matched against the UNTRIMMED options first, so two long options sharing a head are not confused", () => {
    const head = "Ship the gamma exporter with the prior-close levels ";
    const a = `${head}as drill levels and drop the constant columns`;
    const b = "Keep the constant columns and the series as they are now";
    // A default that is NOT an option but trims to the same text as `a` —
    // accepted before (the default was trimmed, then matched), refused now.
    const c = `${head}as drill levels and keep the constant columns`;
    expect(() => srv.applyOp(empty(), { op: "ask", text: "which?", options: [a, b], default: c }, NOW)).toThrow(
      /default must be one of the options/
    );
    // The untrimmed option maps to its trimmed form…
    const q = optionsOf(srv.applyOp(empty(), { op: "ask", text: "which?", options: [a, b], default: a }, NOW).page);
    expect(q.options[0].endsWith("…")).toBe(true);
    expect(q.default).toBe(q.options[0]);
    // …and the trimmed form itself still names its option.
    expect(optionsOf(srv.applyOp(empty(), { op: "ask", text: "which?", options: [a, b], default: q.options[0] }, NOW).page).default).toBe(q.options[0]);
  });
});

// ─── SWIT-108: LANES — the `lane` op and the lane roll-up in `read` ──────────

describe("the page tool — lanes (SWIT-108)", () => {
  type Env = { threadsRoot?: string; threadsJsonPath?: string; selfThreadId?: string; registryPath?: string | null; cwd?: string };
  const lanes = server as unknown as {
    performOp: (threadDir: string, args: Record<string, unknown>, now: number, env?: Env | null) => string;
    performReadOp: (threadDir: string, env?: Env | null) => string;
    readLaneRollup: (env: Env | null) => { name: string; brief: { self: boolean; threadTitle: string } | null } | null;
    performViewOp: (threadDir: string, args: Record<string, unknown>, now: number, env?: Record<string, unknown>) => { spec: Record<string, unknown> };
    normalizeLaneName: (raw: unknown) => string;
    LANE_NAME_CAP: number;
    READ_CAP: number;
    QUESTION_CAP: number;
    TURN_CAP: number;
    PAGE_TOOL: { description: string; inputSchema: { properties: Record<string, { enum?: string[] }> } };
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as {
    mkdtempSync: (p: string) => string;
    mkdirSync: (p: string, o?: { recursive: boolean }) => void;
    writeFileSync: (p: string, d: string) => void;
    readFileSync: (p: string, e: string) => string;
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require("os") as { tmpdir: () => string };
  const AT = (d: number) => new Date(NOW + d * 3_600_000).toISOString();

  /** A registry (lodestar = one repo), a threads.json, a thread dir per id. */
  function world(threads: Array<Record<string, unknown>>) {
    const root = fs.mkdtempSync(`${os.tmpdir()}/swb-lanes-`).split("\\").join("/");
    fs.mkdirSync(`${root}/repos/lodestar/.sb-views/_project`, { recursive: true });
    fs.mkdirSync(`${root}/repos/elsewhere`, { recursive: true });
    fs.mkdirSync(`${root}/kb`, { recursive: true });
    const registryPath = `${root}/kb/registry.json`;
    fs.writeFileSync(registryPath, JSON.stringify({ conventions: { reposRoot: `${root}/repos/` }, projects: { lodestar: { repos: ["lodestar"] } } }));
    const threadsJsonPath = `${root}/threads.json`;
    fs.writeFileSync(threadsJsonPath, JSON.stringify({ version: 1, threads }));
    for (const t of threads) fs.mkdirSync(`${root}/threads/${t.id}`, { recursive: true });
    const env = (self: string, cwd = `${root}/repos/lodestar`): Env => ({ threadsRoot: `${root}/threads`, threadsJsonPath, selfThreadId: self, registryPath, cwd });
    const write = (id: string, name: string, value: unknown) => fs.writeFileSync(`${root}/threads/${id}/${name}`, JSON.stringify(value));
    return { root, env, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }
  const rec = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `thread ${id}`, workingDir: "", chatSessionId: `c${id}`, lastActivityAt: 1, ...over });
  const gamma = { lane: "Gamma model", laneProject: "lodestar" };

  it("the op enum and the description state the lane op and its rules", () => {
    expect(lanes.PAGE_TOOL.inputSchema.properties.op.enum).toContain("lane");
    expect(lanes.PAGE_TOOL.inputSchema.properties.name).toBeDefined();
    for (const rule of [
      "op lane {name} puts THIS thread in a lane when it has none",
      "only the user moves a thread between lanes",
      "In a lane, op read also returns the lane",
      "YOUR brief is the lane's brief: rewrite it WHOLE for the whole lane",
    ]) {
      expect(lanes.PAGE_TOOL.description).toContain(rule);
    }
  });

  it("`lane` writes page.lane for a thread with NO lane; the app parses it; the page keeps it through other ops", () => {
    const w = world([rec("t1")]);
    try {
      const dir = `${w.root}/threads/t1`;
      const msg = lanes.performOp(dir, { op: "lane", name: "  Gamma   model " }, NOW, w.env("t1"));
      expect(msg).toMatch(/^Lane recorded — this thread joins the lane "Gamma model"/);
      lanes.performOp(dir, { op: "theme", text: "gamma" }, NOW, w.env("t1"));
      const raw = fs.readFileSync(`${dir}/page.json`, "utf8");
      expect(JSON.parse(raw).lane).toBe("Gamma model");
      expect(parsePageFile(raw).lane).toBe("Gamma model");
      expect(lanes.normalizeLaneName("a b")).toBe("a b");
      expect(lanes.LANE_NAME_CAP).toBe(48);
    } finally {
      w.cleanup();
    }
  });

  it("Eric's choice wins: a thread already in a lane (his or an earlier agent's) or one he took OUT is refused; the same lane is a no-op", () => {
    const w = world([
      rec("mine", { lane: "Tennis", laneProject: "lodestar", laneSetBy: "user" }),
      rec("agents", { lane: "Tennis", laneProject: "lodestar", laneSetBy: "agent" }),
      rec("out", { laneSetBy: "user" }),
    ]);
    try {
      expect(() => lanes.performOp(`${w.root}/threads/mine`, { op: "lane", name: "Gamma model" }, NOW, w.env("mine"))).toThrow(
        /already in the lane "Tennis" \(the user put it there\) — only the user moves a thread between lanes/
      );
      expect(() => lanes.performOp(`${w.root}/threads/agents`, { op: "lane", name: "Gamma model" }, NOW, w.env("agents"))).toThrow(/only the user moves/);
      expect(lanes.performOp(`${w.root}/threads/mine`, { op: "lane", name: "tennis" }, NOW, w.env("mine"))).toBe('This thread is already in the lane "Tennis".');
      expect(() => lanes.performOp(`${w.root}/threads/out`, { op: "lane", name: "Gamma model" }, NOW, w.env("out"))).toThrow(/the user took this thread out of its lane/);
    } finally {
      w.cleanup();
    }
  });

  it("a thread with no registry project cannot join a lane; a bad name is a visible error", () => {
    const w = world([rec("t1")]);
    try {
      expect(() => lanes.performOp(`${w.root}/threads/t1`, { op: "lane", name: "Gamma" }, NOW, w.env("t1", `${w.root}/repos/elsewhere`))).toThrow(
        /in no registry project — a lane belongs to a project/
      );
      expect(() => lanes.performOp(`${w.root}/threads/t1`, { op: "lane", name: 'bad"name' }, NOW, w.env("t1"))).toThrow(/name must start with a letter/);
      expect(() => lanes.performOp(`${w.root}/threads/t1`, { op: "lane", name: "x".repeat(49) }, NOW, w.env("t1"))).toThrow(/cap is 48/);
      expect(() => lanes.performOp(`${w.root}/threads/t1`, { op: "lane" }, NOW, w.env("t1"))).toThrow(/name must be the lane name/);
    } finally {
      w.cleanup();
    }
  });

  it("`read` in a lane appends the LANE: the newest brief (named by thread), the others' findings, the lane's reports, the others' OPEN questions", () => {
    const w = world([
      rec("t1", { ...gamma, title: "gamma · design review" }),
      rec("t2", { ...gamma, title: "gamma · deck export", lastActivityAt: 5 }),
      rec("t3", { ...gamma, title: "gamma · layer 0", archivedAt: 9 }),
      rec("t4", { lane: "Tennis", laneProject: "lodestar", title: "tennis" }),
    ]);
    try {
      w.write("t1", "page.json", {
        theme: "design review",
        brief: { goal: "my old narrow brief", established: [], dead: [], lead: [], waiting: [], updatedAt: AT(-48) },
        findings: [{ id: "f1", claim: "MY OWN claim", verdict: "lead", updatedAt: AT(0) }],
      });
      w.write("t2", "page.json", {
        brief: { goal: "The lane goal, newest.", established: ["0.58 of vendor"], dead: [], lead: ["debt vs Europe open"], waiting: [], updatedAt: AT(-2) },
        findings: [{ id: "f1", claim: "Debt predicts the Europe open", verdict: "lead", n: "264 nights", report: "view:lodestar/deck", updatedAt: AT(-1) }],
        questions: [
          { id: "q1", text: "Which options are the book?", askedAt: AT(-3) },
          { id: "q2", text: "Answered already?", askedAt: AT(-4) },
          { id: "q3", text: "Dismissed?", askedAt: AT(-5) },
          { id: "q4", text: "Resolved by the agent?", askedAt: AT(-6), answer: "moot", answeredAt: AT(-5) },
        ],
      });
      w.write("t2", "answers.json", { q2: { text: "front", at: AT(-1) } });
      w.write("t2", "retracted.json", { version: 1, evidence: [{ address: "question:q3", at: AT(-1) }] });
      w.write("t3", "page.json", { findings: [{ id: "f1", claim: "Level effects are dead", verdict: "dead", updatedAt: AT(-30) }] });
      w.write("t4", "page.json", { findings: [{ id: "f1", claim: "a TENNIS claim", verdict: "open", updatedAt: AT(0) }] });
      fs.writeFileSync(
        `${w.root}/repos/lodestar/.sb-views/_project/index.json`,
        JSON.stringify({
          version: 1,
          views: [
            { id: "deck", title: "Gamma model deck", kind: "report", builtAt: AT(-1), threadId: "t2" },
            { id: "tennis-tape", title: "Tennis tape", kind: "report", builtAt: AT(0), threadId: "t4" },
            { id: "orphan", title: "Book by strike", kind: "report", builtAt: AT(-10), threadId: "deleted", lane: "gamma MODEL" },
            { id: "orphan2", title: "Other orphan", kind: "report", builtAt: AT(-10), threadId: "deleted2", lane: "Tennis" },
          ],
        })
      );
      const text = lanes.performReadOp(`${w.root}/threads/t1`, w.env("t1"));
      expect(text.length).toBeLessThanOrEqual(lanes.READ_CAP);
      // Its own page first, whole.
      expect(text.startsWith("THEME: design review")).toBe(true);
      expect(text).toContain("  Goal: my old narrow brief");
      const lane = text.slice(text.indexOf("LANE: "));
      expect(lane).toContain("LANE: Gamma model (project lodestar) — this thread and 2 others.");
      expect(lane).toContain('other threads: "gamma · deck export", "gamma · layer 0" (archived)');
      // Edge case 2: t1's OLDER brief is not the lane brief; t2's newer one is, named.
      expect(lane).toContain(
        `LANE BRIEF (the newest in the lane — thread "gamma · deck export", rewritten ${AT(-2)}; at your first seam rewrite it WHOLE with op brief, for the lane):`
      );
      expect(lane).toContain("  Goal: The lane goal, newest.");
      expect(lane).toContain("    - debt vs Europe open");
      expect(lane).toContain("LANE FINDINGS (2, from the other threads, newest first):");
      expect(lane).toContain('  [lead] Debt predicts the Europe open | n: 264 nights | report: view:lodestar/deck — "gamma · deck export"');
      expect(lane).toContain('  [dead] Level effects are dead — "gamma · layer 0"'); // archived is not gone
      expect(lane).not.toContain("MY OWN claim"); // already in this page's own section
      expect(lane).not.toContain("TENNIS");
      expect(lane).toContain("LANE REPORTS (2,");
      expect(lane).toContain("  view:lodestar/deck Gamma model deck");
      expect(lane).toContain("  view:lodestar/orphan Book by strike"); // edge case 6: its thread is gone
      expect(lane).not.toContain("tennis-tape");
      expect(lane).not.toContain("orphan2");
      expect(lane).toContain("OTHER THREADS' OPEN QUESTIONS (1 — answered on their own thread's page; do not re-ask them here):");
      expect(lane).toContain('  "gamma · deck export" q1: Which options are the book?');
      expect(lane).not.toMatch(/Answered already|Dismissed\?|Resolved by the agent/);
      // The same read from t2: its OWN brief is the lane's.
      expect(lanes.performReadOp(`${w.root}/threads/t2`, w.env("t2"))).toContain("LANE BRIEF: this page's brief (above) is the newest in the lane");
      // Not in a lane, or no env: exactly the page.
      expect(lanes.performReadOp(`${w.root}/threads/t1`, null)).not.toContain("LANE:");
      expect(lanes.performOp(`${w.root}/threads/t1`, { op: "read" }, NOW, null)).toBe(lanes.performReadOp(`${w.root}/threads/t1`, null));
      expect(lanes.performReadOp(`${w.root}/threads/t4`, w.env("t4"))).toContain("LANE: Tennis (project lodestar) — this thread and 0 others.");
    } finally {
      w.cleanup();
    }
  });

  it("no brief anywhere in the lane: the read says to write the first one, for the whole lane", () => {
    const w = world([rec("t1", gamma), rec("t2", gamma)]);
    try {
      const text = lanes.performReadOp(`${w.root}/threads/t1`, w.env("t1"));
      expect(text).toContain("LANE BRIEF: none yet — no thread in the lane has written one. Write it (op brief) for the WHOLE lane at your first seam.");
      expect(lanes.readLaneRollup(w.env("t1"))?.brief).toBeNull();
      expect(lanes.readLaneRollup(w.env("nobody"))).toBeNull();
    } finally {
      w.cleanup();
    }
  });

  it("the read stays inside READ_CAP with a page AND a lane at every cap — this page's brief byte-for-byte, the lane giving ground", () => {
    const long = (tag: string, n: number) => `${tag} ${"wörd ".repeat(200)}`.slice(0, n).trim();
    const fullBrief = (tag: string) => ({
      goal: long(`${tag} goal`, 300),
      established: Array.from({ length: 6 }, (_, i) => long(`${tag} est ${i}`, 200)),
      dead: Array.from({ length: 6 }, (_, i) => long(`${tag} dead ${i}`, 200)),
      lead: Array.from({ length: 6 }, (_, i) => long(`${tag} lead ${i}`, 200)),
      waiting: Array.from({ length: 6 }, (_, i) => long(`${tag} wait ${i}`, 200)),
    });
    const siblings = Array.from({ length: 30 }, (_, i) => rec(`s${i}`, { ...gamma, title: long(`sibling ${i}`, 120), lastActivityAt: i }));
    const w = world([rec("me", gamma), ...siblings]);
    try {
      let page = empty();
      page = server.applyOp(page, { op: "theme", text: long("theme", 500) }, NOW).page;
      page = server.applyOp(page, { op: "brief", ...fullBrief("mine") }, NOW).page;
      for (let i = 0; i < lanes.QUESTION_CAP; i++) page = server.applyOp(page, { op: "ask", text: long(`question ${i}`, 500) }, NOW).page;
      for (let i = 0; i < 60; i++) page = server.applyOp(page, { op: "item", itemOp: "add", title: long(`item ${i}`, 500) }, NOW).page;
      for (let i = 0; i < lanes.TURN_CAP; i++) page = server.applyOp(page, { op: "turn", lines: [long(`turn ${i}`, 500)] }, NOW).page;
      for (let i = 0; i < 60; i++) {
        page = server.applyOp(page, { op: "finding", claim: long(`finding ${i}`, 240), verdict: "open", report: `docs/${"r".repeat(280)}.md` }, NOW + i).page;
      }
      w.write("me", "page.json", page);
      for (const s of siblings) {
        let p = server.applyOp(empty(), { op: "brief", ...fullBrief(s.id) }, NOW + 1000).page;
        for (let i = 0; i < 20; i++) p = server.applyOp(p, { op: "ask", text: long(`${s.id} q ${i}`, 500) }, NOW).page;
        for (let i = 0; i < 10; i++) p = server.applyOp(p, { op: "finding", claim: long(`${s.id} f ${i}`, 240), verdict: "lead" }, NOW + i).page;
        w.write(s.id as string, "page.json", p);
      }
      const text = lanes.performReadOp(`${w.root}/threads/me`, w.env("me"));
      expect(text.length).toBeLessThanOrEqual(lanes.READ_CAP);
      const mine = fullBrief("mine");
      expect(text).toContain(`  Goal: ${mine.goal}\n`);
      expect(text).toContain(`  Established:\n${mine.established.map((l) => `    - ${l}`).join("\n")}\n`);
      expect(text).toContain(`  Waiting on the user:\n${mine.waiting.map((l) => `    - ${l}`).join("\n")}\n`);
      // Every lane header is still there, with its count.
      for (const heading of [
        "LANE: Gamma model (project lodestar) — this thread and 30 others.",
        "LANE BRIEF (the newest in the lane",
        "LANE FINDINGS (",
        "LANE REPORTS (0,",
        "OTHER THREADS' OPEN QUESTIONS (",
      ]) {
        expect(text).toContain(heading);
      }
      // Bounded: at most LANE_READ_THREADS threads are read (this one + 23 others).
      expect(text).toContain("LANE FINDINGS (230,");
    } finally {
      w.cleanup();
    }
  });

  it("a project report's index row carries the building thread's lane (so it outlives a deleted thread on its lane)", () => {
    const w = world([rec("t1", gamma)]);
    try {
      const env = { cwd: `${w.root}/repos/lodestar`, threadId: "t1", registryPath: `${w.root}/kb/registry.json`, threadsJsonPath: `${w.root}/threads.json` };
      lanes.performViewOp(`${w.root}/threads/t1`, { op: "show", kind: "report", title: "deck", source: { type: "file", path: "a.md" } }, NOW, env);
      const index = JSON.parse(fs.readFileSync(`${w.root}/repos/lodestar/.sb-views/_project/index.json`, "utf8"));
      expect(index.views[0]).toMatchObject({ id: "v1", threadId: "t1", lane: "Gamma model" });
      // No threads file handed over → no lane key (the pre-lanes row).
      const bare = { cwd: env.cwd, threadId: "t1", registryPath: env.registryPath };
      lanes.performViewOp(`${w.root}/threads/t1`, { op: "show", kind: "report", title: "deck 2", source: { type: "file", path: "a.md" } }, NOW, bare);
      const again = JSON.parse(fs.readFileSync(`${w.root}/repos/lodestar/.sb-views/_project/index.json`, "utf8"));
      expect("lane" in again.views[0]).toBe(false);
    } finally {
      w.cleanup();
    }
  });
});

// ─── SWIT-108 review of ec319c7: the brief's lane stamp and the cached lane brief ─

describe("the page tool — the lane brief outlives its thread (SWIT-108 review #1, #5, #8)", () => {
  type Env = { threadsRoot?: string; threadsJsonPath?: string; selfThreadId?: string; registryPath?: string | null; cwd?: string };
  const srv = server as unknown as {
    performOp: (threadDir: string, args: Record<string, unknown>, now: number, env?: Env | null) => string;
    performReadOp: (threadDir: string, env?: Env | null) => string;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as {
    mkdtempSync: (p: string) => string;
    mkdirSync: (p: string, o?: { recursive: boolean }) => void;
    writeFileSync: (p: string, d: string) => void;
    readFileSync: (p: string, e: string) => string;
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require("os") as { tmpdir: () => string };
  const AT = (d: number) => new Date(NOW + d * 3_600_000).toISOString();
  const G = { name: "Gamma model", project: "lodestar" };

  function world(threads: Array<Record<string, unknown>>, lanes: unknown[] = []) {
    const root = fs.mkdtempSync(`${os.tmpdir()}/swb-lanes2-`).split("\\").join("/");
    fs.mkdirSync(`${root}/repos/lodestar/.sb-views/_project`, { recursive: true });
    fs.mkdirSync(`${root}/kb`, { recursive: true });
    const registryPath = `${root}/kb/registry.json`;
    fs.writeFileSync(registryPath, JSON.stringify({ conventions: { reposRoot: `${root}/repos/` }, projects: { lodestar: { repos: ["lodestar"] } } }));
    const threadsJsonPath = `${root}/threads.json`;
    fs.writeFileSync(threadsJsonPath, JSON.stringify({ version: 1, threads, lanes }));
    for (const t of threads) fs.mkdirSync(`${root}/threads/${t.id}`, { recursive: true });
    const env = (self: string): Env => ({ threadsRoot: `${root}/threads`, threadsJsonPath, selfThreadId: self, registryPath, cwd: `${root}/repos/lodestar` });
    const write = (id: string, value: unknown) => fs.writeFileSync(`${root}/threads/${id}/page.json`, JSON.stringify(value));
    const pageOf = (id: string) => JSON.parse(fs.readFileSync(`${root}/threads/${id}/page.json`, "utf8"));
    return { root, env, write, pageOf, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }
  const rec = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `thread ${id}`, workingDir: "", chatSessionId: `c${id}`, lastActivityAt: 1, ...over });
  const gamma = { lane: "Gamma model", laneProject: "lodestar" };
  const brief = (goal: string, updatedAt: string, lane?: unknown) => ({ goal, established: [], dead: [], lead: [], waiting: [], updatedAt, ...(lane === undefined ? {} : { lane }) });

  it("`brief` is STAMPED with the lane it is written for — the record's lane, the page's own lane before the app copies it, else null", () => {
    const w = world([rec("in", gamma), rec("free"), rec("out", { laneSetBy: "user" })]);
    try {
      srv.performOp(`${w.root}/threads/in`, { op: "brief", goal: "g" }, NOW, w.env("in"));
      expect(w.pageOf("in").brief.lane).toEqual(G);
      expect(parsePageFile(JSON.stringify(w.pageOf("in"))).brief?.lane).toEqual(G);
      srv.performOp(`${w.root}/threads/free`, { op: "brief", goal: "g" }, NOW, w.env("free"));
      expect(w.pageOf("free").brief.lane).toBeNull();
      // The agent asked for a lane (op lane) and the app has not copied it yet: the brief is for that lane.
      srv.performOp(`${w.root}/threads/free`, { op: "lane", name: "Tennis" }, NOW, w.env("free"));
      srv.performOp(`${w.root}/threads/free`, { op: "brief", goal: "g2" }, NOW, w.env("free"));
      expect(w.pageOf("free").brief.lane).toEqual({ name: "Tennis", project: "lodestar" });
      // No env (a test's direct call): the stamp says "no lane".
      srv.performOp(`${w.root}/threads/out`, { op: "brief", goal: "g" }, NOW, null);
      expect(w.pageOf("out").brief.lane).toBeNull();
    } finally {
      w.cleanup();
    }
  });

  it("read: a sibling's brief written for its own corner never becomes the lane brief; a pre-stamp brief still counts", () => {
    const w = world([rec("me", gamma), rec("joiner", { ...gamma, title: "joiner" }), rec("old", { ...gamma, title: "old timer" })]);
    try {
      w.write("me", {});
      w.write("joiner", { brief: brief("my corner", AT(-1), null) });
      w.write("old", { brief: brief("pre-stamp lane brief", AT(-9)) });
      const text = srv.performReadOp(`${w.root}/threads/me`, w.env("me"));
      expect(text).toContain('LANE BRIEF (the newest in the lane — thread "old timer"');
      expect(text).toContain("  Goal: pre-stamp lane brief");
      expect(text).not.toContain("my corner");
    } finally {
      w.cleanup();
    }
  });

  it("read: the CACHED lane brief (threads.json `lanes`) keeps it when its thread is deleted, and beats an older live one; a former name still matches", () => {
    const cached = { brief: brief("the kept lane brief", AT(-2), { name: "Old gamma", project: "lodestar" }), threadId: "deleted", threadTitle: "gamma · design review" };
    const w = world([rec("me", gamma), rec("t2", { ...gamma, title: "t2" })], [{ project: "lodestar", name: "Gamma model", aliases: ["Old gamma"], brief: cached }]);
    try {
      w.write("me", {});
      w.write("t2", { brief: brief("older live brief", AT(-5), G) });
      fs.writeFileSync(
        `${w.root}/repos/lodestar/.sb-views/_project/index.json`,
        JSON.stringify({ version: 1, views: [{ id: "renamed", title: "Built under the old name", kind: "report", builtAt: AT(-1), threadId: "deleted", lane: "old GAMMA" }] })
      );
      const text = srv.performReadOp(`${w.root}/threads/me`, w.env("me"));
      expect(text).toContain('LANE BRIEF (the newest in the lane — thread "gamma · design review" (a deleted thread)');
      expect(text).toContain("  Goal: the kept lane brief");
      expect(text).toContain("  view:lodestar/renamed Built under the old name");
      // A NEWER live brief for the lane wins over the cache.
      w.write("t2", { brief: brief("newer live brief", AT(0), G) });
      expect(srv.performReadOp(`${w.root}/threads/me`, w.env("me"))).toContain("  Goal: newer live brief");
    } finally {
      w.cleanup();
    }
  });

  it("read with more than LANE_READ_THREADS threads: the lane brief is the NEWEST overall (the cache), not the newest of the 24 read", () => {
    const siblings = Array.from({ length: 30 }, (_, i) => rec(`s${i}`, { ...gamma, lastActivityAt: 100 + i }));
    // The least recently active thread (not read) holds the newest brief — the app cached it.
    const cached = { brief: brief("newest brief, on a quiet thread", AT(0), G), threadId: "s0", threadTitle: "thread s0" };
    const w = world([rec("me", gamma), ...siblings], [{ project: "lodestar", name: "Gamma model", brief: cached }]);
    try {
      w.write("me", {});
      for (const s of siblings) w.write(s.id as string, { brief: brief(`brief ${s.id}`, AT(-10), G) });
      w.write("s0", { brief: cached.brief });
      const text = srv.performReadOp(`${w.root}/threads/me`, w.env("me"));
      expect(text).toContain("  Goal: newest brief, on a quiet thread");
      expect(text).toContain('thread "thread s0"');
    } finally {
      w.cleanup();
    }
  });
});

// ── SWIT-109: the job tool — requests the app acts on, files it reads ────────

describe("the job tool (SWIT-109) — the app runs it, the server only queues and reads", () => {
  type JobEnv = { jobsInboxPath?: string; jobsDir?: string; selfThreadId?: string; cwd?: string };
  const srv = server as unknown as {
    JOB_TOOL: { name: string; description: string; inputSchema: { properties: Record<string, { enum?: string[] }>; required: string[] } };
    JOB_OPS: string[];
    JOB_COMMAND_CAP: number;
    JOB_LOG_LINES_MAX: number;
    jobState: (rec: Record<string, unknown>, exit: unknown, alive: boolean) => string;
    performJobOp: (env: JobEnv, args: Record<string, unknown>, now: number, deps?: { alive?: (pid: number) => boolean; isDir?: (p: string) => boolean }) => { message: string };
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as {
    mkdtempSync: (p: string) => string;
    mkdirSync: (p: string, o?: { recursive: boolean }) => void;
    writeFileSync: (p: string, d: string) => void;
    readFileSync: (p: string, e: string) => string;
    existsSync: (p: string) => boolean;
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require("os") as { tmpdir: () => string };
  const SELF = "3f1c2a9e-0b7d-4c1e-9a55-1234567890ab";
  const MIN = 60_000;

  function world(jobs: Array<Record<string, unknown>>) {
    const root = fs.mkdtempSync(`${os.tmpdir()}/swb-jobtool-`).split("\\").join("/");
    const jobsDir = `${root}/jobs`;
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(`${jobsDir}/jobs.json`, JSON.stringify({ version: 1, jobs }));
    for (const j of jobs) fs.mkdirSync(`${jobsDir}/${j.id}`, { recursive: true });
    const env: JobEnv = { jobsInboxPath: `${root}/jobs-inbox.json`, jobsDir, selfThreadId: SELF, cwd: root };
    return { root, jobsDir, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }
  const job = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id,
    name,
    threadId: SELF,
    command: "python x.py",
    cwd: "C:\\work",
    kind: "job",
    pid: 4242,
    pidStartedAt: 1,
    startedAt: NOW - 42 * MIN,
    ...over,
  });
  const alive = { alive: () => true, isDir: () => true };
  const dead = { alive: () => false, isDir: () => true };

  it("the state rule is the app's (jobs.ts deriveJobState — same table)", () => {
    const e = { code: 0, endedAt: 1, timedOut: false, error: null };
    const cases: Array<[Record<string, unknown>, unknown, boolean]> = [
      [{}, e, true],
      [{}, null, true],
      [{}, null, false],
      [{ stoppedAt: 5 }, null, false],
      [{ lostAt: 5 }, null, true],
      [{ stoppedAt: 5 }, e, false],
    ];
    for (const [rec, exit, live] of cases) {
      const stoppedAt = typeof rec.stoppedAt === "number" ? rec.stoppedAt : null;
      const lostAt = typeof rec.lostAt === "number" ? rec.lostAt : null;
      expect(srv.jobState(rec, exit, live)).toBe(deriveJobState({ stoppedAt, lostAt }, exit as never, live));
    }
  });

  it("start QUEUES one NDJSON line the app's parse reads — it never starts anything", () => {
    const w = world([]);
    try {
      const r = srv.performJobOp(w.env, { op: "start", name: "capture", command: "  python capture.py --loop  " }, NOW, alive);
      expect(r.message).toMatch(/outlives this session/);
      expect(r.message).toMatch(/one line arrives in this thread when it ends/);
      srv.performJobOp(w.env, { op: "start", name: "second", command: "x", cwd: "sub" }, NOW, alive);
      const parsed = parseJobsInbox(fs.readFileSync(w.env.jobsInboxPath as string, "utf-8"));
      expect(parsed.map((p) => [p.op, p.name, p.threadId])).toEqual([
        ["start", "capture", SELF],
        ["start", "second", SELF],
      ]);
      expect(parsed[0].op === "start" && parsed[0].command).toBe("python capture.py --loop");
      // cwd defaults to the thread's own and resolves relative ones against it.
      expect(parsed[0].op === "start" && parsed[0].cwd?.split("\\").join("/")).toBe(w.root);
      expect(parsed[1].op === "start" && parsed[1].cwd?.split("\\").join("/")).toBe(`${w.root}/sub`);
      // Nothing under the jobs dir was written by the server.
      expect(JSON.parse(fs.readFileSync(`${w.jobsDir}/jobs.json`, "utf-8")).jobs).toEqual([]);
      expect(mcpServerSource).toContain("fs.appendFileSync(env.jobsInboxPath");
    } finally {
      w.cleanup();
    }
  });

  it("start refuses early with a sentence: name, command cap, cwd, a running name, the per-thread cap", () => {
    const running = Array.from({ length: 8 }, (_, i) => job(`j${i}`, `n${i}`));
    const w = world(running);
    try {
      const go = (args: Record<string, unknown>, deps = alive) => () => srv.performJobOp(w.env, { op: "start", ...args }, NOW, deps);
      expect(go({ name: "sp ace", command: "x" })).toThrow(/`name` must be/);
      expect(go({ name: "a", command: "  " })).toThrow(/non-empty/);
      expect(go({ name: "a", command: "é".repeat(srv.JOB_COMMAND_CAP + 1) })).toThrow(/cap 2000 characters/);
      expect(go({ name: "a", command: "x" }, { alive: () => true, isDir: () => false })).toThrow(/not an existing directory/);
      expect(go({ name: "n3", command: "x" })).toThrow(/already running/);
      expect(go({ name: "fresh", command: "x" })).toThrow(/cap 8/);
      // Dead pids free both the name and the slot.
      expect(() => srv.performJobOp(w.env, { op: "start", name: "n3", command: "x" }, NOW, dead)).not.toThrow();
      expect(() => srv.performJobOp(w.env, { op: "reboot", name: "a" }, NOW, alive)).toThrow(/`op` must be one of/);
    } finally {
      w.cleanup();
    }
  });

  it("stop queues only a job of THIS thread that is running", () => {
    const w = world([
      job("ja", "capture"),
      job("jb", "done-one", { stoppedAt: NOW - MIN }),
      job("jc", "theirs", { threadId: "other" }),
    ]);
    try {
      expect(srv.performJobOp(w.env, { op: "stop", name: "capture" }, NOW, alive).message).toMatch(/stops capture/);
      expect(() => srv.performJobOp(w.env, { op: "stop", name: "done-one" }, NOW, alive)).toThrow(/already stopped/);
      expect(() => srv.performJobOp(w.env, { op: "stop", name: "theirs" }, NOW, alive)).toThrow(/no job named theirs in this thread/);
      expect(parseJobsInbox(fs.readFileSync(w.env.jobsInboxPath as string, "utf-8"))).toEqual([
        expect.objectContaining({ op: "stop", name: "capture", threadId: SELF }),
      ]);
    } finally {
      w.cleanup();
    }
  });

  it("list and log read the app's files: state words, the last line, a capped tail across a rotation", () => {
    const w = world([
      job("ja", "capture"),
      job("jb", "backfill", { startedAt: NOW - 3 * 60 * MIN }),
      job("jc", "gone", { lostAt: NOW - 5 * MIN }),
      job("jd", "theirs", { threadId: "other" }),
    ]);
    try {
      fs.writeFileSync(`${w.jobsDir}/ja/log.txt`, "\uFEFFstarting\r\ncaptured 12 prices\r\n");
      fs.writeFileSync(`${w.jobsDir}/jb/exit.json`, JSON.stringify({ code: 0, endedAt: NOW - 60 * MIN, timedOut: false }));
      fs.writeFileSync(`${w.jobsDir}/jb/log.1.txt`, Array.from({ length: 30 }, (_, i) => `old ${i}`).join("\n") + "\n");
      fs.writeFileSync(`${w.jobsDir}/jb/log.txt`, "new 0\nnew 1\n");
      const list = srv.performJobOp(w.env, { op: "list" }, NOW, alive).message;
      expect(list).toContain("Jobs of this thread (1 running):");
      expect(list).toContain("- capture · running 42 min · in C:\\work · last: captured 12 prices");
      expect(list).toContain("- backfill · exit 0 after 2 h (1 h ago)");
      expect(list).toContain("- gone · lost");
      expect(list).not.toContain("theirs");
      const log = srv.performJobOp(w.env, { op: "log", name: "backfill", lines: 3 }, NOW, alive).message;
      expect(log.split("\n")).toEqual(["job backfill · exit 0 after 2 h (1 h ago) · last 3 lines:", "old 29", "new 0", "new 1"]);
      const capped = srv.performJobOp(w.env, { op: "log", name: "backfill", lines: 100_000 }, NOW, alive).message;
      expect(capped.split("\n")).toHaveLength(1 + 32);
      expect(srv.performJobOp(w.env, { op: "log", name: "gone" }, NOW, alive).message).toMatch(/\(no output yet\)/);
      expect(() => srv.performJobOp(w.env, { op: "log", name: "nope" }, NOW, alive)).toThrow(/no job named nope/);
      // A dead pid with no exit.json reads lost before the app stamps it.
      expect(srv.performJobOp(w.env, { op: "list" }, NOW, dead).message).toContain("- capture · lost");
    } finally {
      w.cleanup();
    }
  });

  it("the tool table states the contract in one paragraph", () => {
    const tool = srv.JOB_TOOL;
    expect(tool.name).toBe("job");
    expect(tool.inputSchema.properties.op.enum).toEqual(["start", "stop", "list", "log", "watch", "unwatch"]);
    expect(tool.inputSchema.required).toEqual(["op"]);
    expect(tool.description).toMatch(/the Switchboard APP starts and owns/);
    expect(tool.description).toMatch(/keeps running when this conversation ends/);
    expect(tool.description).toMatch(/read its output with `log`/);
    expect(tool.description).toMatch(/exactly one line arrives in this thread/);
    expect(tool.description).not.toContain("\n");
    expect(mcpServerSource).toContain("SWITCHBOARD_JOBS_INBOX");
    expect(mcpServerSource).toContain("SWITCHBOARD_JOBS_DIR");
    expect(srv.JOB_LOG_LINES_MAX).toBe(JOB_LOG_LINES_MAX);
  });
});

// ── SWIT-110: watches — a job on a schedule with a pass/fail reading ─────────

describe("the job tool's watches (SWIT-110)", () => {
  type JobEnv = { jobsInboxPath?: string; jobsDir?: string; selfThreadId?: string; cwd?: string };
  const srv = server as unknown as {
    JOB_TOOL: { description: string; inputSchema: { properties: Record<string, unknown> } };
    performJobOp: (env: JobEnv, args: Record<string, unknown>, now: number, deps?: { alive?: (pid: number) => boolean; isDir?: (p: string) => boolean }) => { message: string };
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as {
    mkdtempSync: (p: string) => string;
    mkdirSync: (p: string, o?: { recursive: boolean }) => void;
    writeFileSync: (p: string, d: string) => void;
    readFileSync: (p: string, e: string) => string;
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require("os") as { tmpdir: () => string };
  const SELF = "3f1c2a9e-0b7d-4c1e-9a55-1234567890ab";
  const deps = { alive: () => true, isDir: () => true };

  function world(watches: Array<Record<string, unknown>>) {
    const root = fs.mkdtempSync(`${os.tmpdir()}/swb-watch-`).split("\\").join("/");
    const jobsDir = `${root}/jobs`;
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(`${jobsDir}/watches.json`, JSON.stringify({ version: 1, watches }));
    const env: JobEnv = { jobsInboxPath: `${root}/jobs-inbox.json`, jobsDir, selfThreadId: SELF, cwd: root };
    return { root, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }
  const watch = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    threadId: SELF,
    command: "python check.py",
    cwd: "C:\\work",
    everyMin: 15,
    createdAt: 1,
    status: "unknown",
    lastLine: "",
    ...over,
  });

  it("watch / unwatch queue requests the app's parse reads; the cadence, the name and the cap are checked early", () => {
    const w = world([watch("theirs", { threadId: "other" }), watch("mine")]);
    try {
      expect(srv.performJobOp(w.env, { op: "watch", name: "itf", command: "python itf_fresh.py", every: 15 }, NOW, deps).message).toMatch(/every 15 min/);
      expect(srv.performJobOp(w.env, { op: "unwatch", name: "mine" }, NOW, deps).message).toMatch(/stops watching mine/);
      const parsed = parseJobsInbox(fs.readFileSync(w.env.jobsInboxPath as string, "utf-8"));
      expect(parsed.map((p) => p.op)).toEqual(["watch", "unwatch"]);
      expect(parsed[0]).toMatchObject({ op: "watch", name: "itf", command: "python itf_fresh.py", every: 15, threadId: SELF });
      const go = (args: Record<string, unknown>) => () => srv.performJobOp(w.env, args, NOW, deps);
      expect(go({ op: "watch", name: "a", command: "x", every: 4 })).toThrow(/5\.\.10080/);
      expect(go({ op: "watch", name: "a", command: "x", every: 7.5 })).toThrow(/whole number/);
      expect(go({ op: "watch", name: "theirs", command: "x", every: 5 })).toThrow(/another thread already watches theirs/);
      expect(go({ op: "unwatch", name: "theirs" })).toThrow(/this thread has no watch named theirs/);
      expect(go({ op: "unwatch", name: "nope" })).toThrow(/no watch named nope/);
    } finally {
      w.cleanup();
    }
  });

  it("list shows this thread's watches with their reading", () => {
    const w = world([
      watch("prices", { status: "fail", lastRunAt: NOW - 3 * 60_000, lastLine: "0 rows in the last hour" }),
      watch("itf", { status: "pass", everyMin: 60 }),
      watch("theirs", { threadId: "other" }),
    ]);
    try {
      const list = srv.performJobOp(w.env, { op: "list" }, NOW, deps).message;
      expect(list).toContain("Watches of this thread (2):");
      expect(list).toContain("- prices · FAILING · every 15 min · ran 3 min ago · last: 0 rows in the last hour");
      expect(list).toContain("- itf · passing · every 60 min");
      expect(list).not.toContain("theirs");
    } finally {
      w.cleanup();
    }
  });

  it("the description carries the watch contract", () => {
    expect(srv.JOB_TOOL.description).toMatch(/WATCHES: watch \{name, command, every, cwd\?\}/);
    expect(srv.JOB_TOOL.description).toMatch(/ONE line in this thread when it starts failing/);
    expect(srv.JOB_TOOL.inputSchema.properties).toHaveProperty("every");
  });
});

// ── Review fixes for SWIT-109/110, the server half ───────────────────────────

describe("the job tool — review fixes (SWIT-109/110)", () => {
  type JobEnv = { jobsInboxPath?: string; jobsDir?: string; selfThreadId?: string; cwd?: string };
  const srv = server as unknown as {
    JOB_TOOL: { description: string };
    performJobOp: (env: JobEnv, args: Record<string, unknown>, now: number, deps?: { alive?: (pid: number) => boolean; isDir?: (p: string) => boolean }) => { message: string };
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs") as {
    mkdtempSync: (p: string) => string;
    mkdirSync: (p: string, o?: { recursive: boolean }) => void;
    writeFileSync: (p: string, d: string) => void;
    existsSync: (p: string) => boolean;
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const os = require("os") as { tmpdir: () => string };
  const SELF = "3f1c2a9e-0b7d-4c1e-9a55-1234567890ab";
  const deps = { alive: () => false, isDir: () => true };

  function world(jobs: Array<Record<string, unknown>>) {
    const root = fs.mkdtempSync(`${os.tmpdir()}/swb-jobfix-`).split("\\").join("/");
    const jobsDir = `${root}/jobs`;
    fs.mkdirSync(jobsDir, { recursive: true });
    fs.writeFileSync(`${jobsDir}/jobs.json`, JSON.stringify({ version: 1, jobs }));
    for (const j of jobs) fs.mkdirSync(`${jobsDir}/${j.id}`, { recursive: true });
    return { root, jobsDir, env: { jobsInboxPath: `${root}/inbox.json`, jobsDir, selfThreadId: SELF, cwd: root } as JobEnv, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  }
  const job = (id: string, name: string) => ({ id, name, threadId: SELF, command: "x", cwd: "C:\w", kind: "job", pid: 1, pidStartedAt: 1, startedAt: NOW - 60_000 });

  it("M2: exit -1 from a real program is an exit code; `could not start` needs the supervisor's error", () => {
    const w = world([job("ja", "real"), job("jb", "nostart")]);
    try {
      fs.writeFileSync(`${w.jobsDir}/ja/exit.json`, JSON.stringify({ code: -1, endedAt: NOW, timedOut: false }));
      fs.writeFileSync(`${w.jobsDir}/jb/exit.json`, JSON.stringify({ code: -1, endedAt: NOW, timedOut: false, error: "The directory name is invalid" }));
      const list = srv.performJobOp(w.env, { op: "list" }, NOW, deps).message;
      expect(list).toContain("- real · exit -1 after 1 min");
      expect(list).toContain("- nostart · could not start: The directory name is invalid");
    } finally {
      w.cleanup();
    }
  });

  it("M3: the last line comes from the log's last 8 KB, even for a big log", () => {
    const w = world([job("ja", "big")]);
    try {
      fs.writeFileSync(`${w.jobsDir}/ja/log.txt`, `${"x".repeat(100)}\n`.repeat(10_000) + "the end\n");
      expect(srv.performJobOp(w.env, { op: "list" }, NOW, deps).message).toContain("last: the end");
    } finally {
      w.cleanup();
    }
  });

  it("an empty thread id is refused, never `Queued`", () => {
    const w = world([]);
    try {
      const env = { ...w.env, selfThreadId: "" };
      expect(() => srv.performJobOp(env, { op: "start", name: "a", command: "x" }, NOW, deps)).toThrow(/no thread id/);
      expect(fs.existsSync(w.env.jobsInboxPath as string)).toBe(false);
    } finally {
      w.cleanup();
    }
  });

  it("the description says whose environment, how failure is decided, and what a stop cannot reach", () => {
    const d = srv.JOB_TOOL.description;
    expect(d).toMatch(/in the APP's environment, not this shell's/);
    expect(d).toMatch(/raises any PowerShell error \(a command not found, a missing file\)/);
    expect(d).toMatch(/a native program's stderr alone is output, not failure/);
    expect(d).toMatch(/a process that left the tree .* keeps running/);
  });
});
