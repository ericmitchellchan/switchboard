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
import { parseViewSpec } from "./viewStore";
import { parseInboxFile } from "./pageStore";
import { parseBacklogInbox } from "./backlogStore";
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

  it("an ask option beyond 60 chars is a VISIBLE error (SWIT-69)", () => {
    expect(() =>
      server.applyOp(empty(), { op: "ask", text: "Which?", options: ["ok", "x".repeat(61)] }, NOW)
    ).toThrow(/cap is 60/);
    expect(() =>
      server.applyOp(empty(), { op: "ask", text: "Which?", options: ["x".repeat(60)] }, NOW)
    ).not.toThrow();
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
      { op: "ask", text: "Same set or per-market?", options: ["same set", "per-market"], default: "per-market", kind: "convention" },
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
    expect(parsed.questions[0].kind).toBe("convention");
    expect(parsed.questions[0].defaultOption).toBe("per-market");
    expect(parsed.items).toHaveLength(3);

    const merged = mergePage(parsed, { q1: { text: "same set", at: "2026-08-31T10:05:00Z" } }, []);
    expect(merged.isEmpty).toBe(false);
    expect(merged.theme).toBe("Give every market an anchor");
    expect(merged.openQuestions).toHaveLength(0); // answered
    expect(merged.answeredQuestions[0].answer.text).toBe("same set");
    // The answer surfaces as a decided evidence row beside the agent's rows.
    expect(merged.evidence.map((e) => e.address)).toEqual(["decision:q1", "switchboard #61", "SWIT-49"]);
    expect(merged.evidence[0].status).toBe("decided");
    expect(merged.userItems.map((i) => i.title)).toEqual(["Check the pins"]);
    expect(merged.openItems).toHaveLength(1); // needs-you items render ONCE (SWIT-69)
    expect(merged.doneItems).toHaveLength(1);
    expect(merged.latestTurn?.lines[0]).toBe("Second turn.");
    expect(merged.evidence[1].status).toBe("open");
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
    ]) {
      expect(server.PAGE_TOOL.description).toContain(rule);
    }
    const props = (server.PAGE_TOOL.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.kind.enum).toEqual(["decision", "convention", "info"]);
    expect(props.default).toBeDefined();
    expect(props.reviewFirst).toBeDefined();
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
    expect(() => server.buildViewSpec({ ...base, id: "no spaces!" }, [], NOW)).toThrow(/must match/);
  });

  it("T7 (SWIT-61): the enum lists line + bar; series / valueColumn normalise and ROUND-TRIP; the drill takes them too", () => {
    const props = (server.VIEW_TOOL.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.kind.enum).toEqual(["table", "candles", "dist", "line", "bar", "timeline"]);
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
      const m = src.match(/function isLocalBackendUrl\([^)]*\)[^{]*\{[\s\S]*?\n\}/);
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
