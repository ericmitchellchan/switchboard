// Switchboard's MCP server (SWIT-49) — the pure core, loaded straight from
// the shipped .cjs resource (createRequire): op semantics, caps as visible
// errors, evidence upsert-by-address — and the ROUND-TRIP seam test: every
// shape the server writes must parse through pageStore, because the rendered
// page is pageStore's merge of the file this server is the sole writer of.

import { describe, it, expect } from "vitest";
// @ts-expect-error — no @types/node in the frontend tsconfig; vitest's node
// runtime provides the real module, and the require result is cast below.
import { createRequire } from "node:module";
import { parsePageFile, mergePage } from "./pageStore";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = require("../../src-tauri/resources/mcp/switchboard-mcp.cjs") as {
  parsePage: (raw: string) => Record<string, unknown>;
  applyOp: (
    page: Record<string, unknown>,
    args: Record<string, unknown>,
    now: number
  ) => { page: Record<string, unknown>; message: string };
  PAGE_TOOL: { name: string; description: string; inputSchema: unknown };
  OpError: new (message: string) => Error;
  TURN_CAP: number;
  TURN_LINE_CAP: number;
  EVIDENCE_CAP: number;
  QUESTION_CAP: number;
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

  it("asking beyond the question cap is a VISIBLE error, and duplicate ids refuse", () => {
    let page = empty();
    for (let i = 0; i < server.QUESTION_CAP; i++) {
      page = server.applyOp(page, { op: "ask", text: `q ${i}` }, NOW).page;
    }
    expect(() => server.applyOp(page, { op: "ask", text: "one more" }, NOW)).toThrow(/already holds/);
    expect(() =>
      server.applyOp(
        server.applyOp(empty(), { op: "ask", id: "q1", text: "t" }, NOW).page,
        { op: "ask", id: "q1", text: "again" },
        NOW
      )
    ).toThrow(/already exists/);
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
      { op: "ask", text: "Same set or per-market?", options: ["same set", "per-market"] },
      { op: "item", itemOp: "add", title: "Publish anchors", state: "in_progress" },
      { op: "item", itemOp: "add", title: "Check the pins", owner: "user", note: "blocks R1" },
      { op: "item", itemOp: "add", title: "Old thing" },
      { op: "item", itemOp: "close", id: "i3" },
    ]);
    const parsed = parsePageFile(JSON.stringify(page));
    expect(parsed.theme).toBe("Give every market an anchor");
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].lines).toEqual(["Second turn.", "Two lines."]); // newest first
    expect(parsed.evidence.map((e) => e.address)).toEqual(["switchboard #61", "SWIT-49"]);
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.items).toHaveLength(3);

    const merged = mergePage(parsed, { q1: { text: "same set", at: "2026-08-31T10:05:00Z" } }, []);
    expect(merged.isEmpty).toBe(false);
    expect(merged.theme).toBe("Give every market an anchor");
    expect(merged.openQuestions).toHaveLength(0); // answered
    expect(merged.answeredQuestions[0].answer.text).toBe("same set");
    expect(merged.userItems.map((i) => i.title)).toEqual(["Check the pins"]);
    expect(merged.openItems).toHaveLength(2);
    expect(merged.doneItems).toHaveLength(1);
    expect(merged.latestTurn?.lines[0]).toBe("Second turn.");
    expect(merged.evidence[0].status).toBe("open");
  });

  it("timestamps the server writes are ISO strings pageStore's dot rule can parse", () => {
    const { page } = server.applyOp(empty(), { op: "turn", lines: ["t"] }, NOW);
    const turns = page.turns as Array<{ at: string }>;
    expect(Date.parse(turns[0].at)).toBe(NOW);
  });

  it("the tool table carries the behavioural contract", () => {
    expect(server.PAGE_TOOL.name).toBe("page");
    for (const rule of ["2–5 plain lines", "UPDATES its row", "never ask the same question twice"]) {
      expect(server.PAGE_TOOL.description).toContain(rule);
    }
  });
});
