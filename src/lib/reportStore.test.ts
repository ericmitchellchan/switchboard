// Report lexical layer (SWIT-73): fence splitting, stat tile parse, the
// evidence→heading one-shot — plus the realistic fixture report exercising
// the whole inline-spec derivation through viewStore.

import { describe, it, expect } from "vitest";
import {
  splitReport,
  parseStatTiles,
  requestReportAnchor,
  takeReportAnchor,
  subscribeReportAnchor,
  reportAnchorNonce,
  STAT_TILE_CAP,
  REPORT_BLOCK_CAP,
} from "./reportStore";
import { parseInlineViewSpec, inlineSpecAt, parseViewSpec } from "./viewStore";
import type { ViewSpec } from "./viewStore";

const REPORT: ViewSpec = {
  id: "r1",
  kind: "report",
  title: "gamma report",
  source: { type: "file", path: "analysis.md" },
  builtAt: "2026-09-02T10:00:00.000Z",
  builtBy: "agent",
};

describe("splitReport", () => {
  it("interleaves narrative, view and stat segments in document order", () => {
    const md = [
      "# Title",
      "",
      "Some prose.",
      "",
      "```view",
      '{"kind":"line"}',
      "```",
      "",
      "More prose.",
      "",
      "```stat",
      '{"label":"trades","value":12}',
      "```",
      "",
      "Tail prose.",
    ].join("\n");
    const segs = splitReport(md);
    expect(segs.map((s) => s.kind)).toEqual(["markdown", "view", "markdown", "stat", "markdown"]);
    expect(segs[1]).toMatchObject({ block: 1, body: '{"kind":"line"}' });
    expect(segs[3]).toMatchObject({ block: 2, body: '{"label":"trades","value":12}' });
  });

  it("numbers blocks 1-based across BOTH kinds", () => {
    const md = "```stat\n{}\n```\n```view\n{}\n```\n```stat\n{}\n```";
    const blocks = splitReport(md).filter((s) => s.kind === "view" || s.kind === "stat");
    expect(blocks.map((s) => s.block)).toEqual([1, 2, 3]);
    expect(blocks.map((s) => s.kind)).toEqual(["stat", "view", "stat"]);
  });

  it("cuts CRLF files identically to LF", () => {
    const lf = "prose\n```view\n{\"a\":1}\n```\nmore";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(splitReport(crlf)).toEqual(splitReport(lf));
  });

  it("leaves a ```view line inside an ordinary code fence as code", () => {
    const md = "```json\n```view\nnot a block\n```\nafter";
    const segs = splitReport(md);
    expect(segs.every((s) => s.kind === "markdown")).toBe(true);
    expect((segs[0] as { text: string }).text).toContain("```view");
  });

  it("an unclosed view fence at EOF is still that block (body to the end)", () => {
    const segs = splitReport("prose\n```view\n{\"kind\":\"table\"}");
    expect(segs.map((s) => s.kind)).toEqual(["markdown", "view"]);
    expect(segs[1]).toMatchObject({ block: 1, body: '{"kind":"table"}' });
  });

  it("drops whitespace-only narrative segments", () => {
    const segs = splitReport("```view\n{}\n```\n\n\n```view\n{}\n```");
    expect(segs.map((s) => s.kind)).toEqual(["view", "view"]);
  });

  it("tolerates trailing spaces on fence lines and multi-line bodies", () => {
    const segs = splitReport("```view  \n{\n  \"kind\": \"bar\"\n}\n```  ");
    expect(segs).toEqual([{ kind: "view", block: 1, body: '{\n  "kind": "bar"\n}' }]);
  });

  it("a ```view line inside a TILDE fence stays code (a doc quoting the syntax)", () => {
    const md = "~~~\n```view\nnot a block\n```\n~~~\nafter";
    const segs = splitReport(md);
    expect(segs.every((s) => s.kind === "markdown")).toBe(true);
    expect((segs[0] as { text: string }).text).toContain("```view");
  });

  it("a ````-opened fence closes only on a matching-or-longer run (CommonMark)", () => {
    // A ````markdown example quoting a FULL ```view … ``` block stays
    // narrative, and a later real block still renders.
    const md = [
      "````markdown",
      "```view",
      '{"kind":"line"}',
      "```",
      "````",
      "",
      "```view",
      '{"kind":"bar"}',
      "```",
    ].join("\n");
    const segs = splitReport(md);
    expect(segs.map((s) => s.kind)).toEqual(["markdown", "view"]);
    expect(segs[1]).toMatchObject({ block: 1, body: '{"kind":"bar"}' });
    expect((segs[0] as { text: string }).text).toContain('{"kind":"line"}');
  });

  it("a tilde fence does not close on backticks, nor backticks on tildes", () => {
    const md = "~~~json\n```\n~~~\n```view\n{}\n```";
    const segs = splitReport(md);
    expect(segs.map((s) => s.kind)).toEqual(["markdown", "view"]);
  });

  it("renders exactly REPORT_BLOCK_CAP blocks live and no overflow at the cap", () => {
    const md = Array.from({ length: REPORT_BLOCK_CAP }, () => "```view\n{}\n```").join("\n");
    const segs = splitReport(md);
    expect(segs.filter((s) => s.kind === "view")).toHaveLength(REPORT_BLOCK_CAP);
    expect(segs.some((s) => s.kind === "overflow")).toBe(false);
  });

  it("one past the cap: ONE overflow segment, the rest fall back to code fences", () => {
    const total = REPORT_BLOCK_CAP + 1;
    const md = Array.from({ length: total }, (_, i) =>
      i % 2 === 0 ? `\`\`\`view\n{"i":${i}}\n\`\`\`` : `\`\`\`stat\n{"i":${i}}\n\`\`\``
    ).join("\n");
    const segs = splitReport(md);
    const live = segs.filter((s) => s.kind === "view" || s.kind === "stat");
    expect(live).toHaveLength(REPORT_BLOCK_CAP);
    expect(live[live.length - 1]).toMatchObject({ block: REPORT_BLOCK_CAP });
    const overflow = segs.filter((s) => s.kind === "overflow");
    expect(overflow).toEqual([{ kind: "overflow", total }]);
    // The over-cap block survives as a plain code fence in the narrative.
    const tail = segs[segs.length - 1];
    expect(tail.kind).toBe("markdown");
    expect((tail as { text: string }).text).toBe(`\`\`\`view\n{"i":${total - 1}}\n\`\`\``);
  });
});

describe("parseStatTiles", () => {
  it("parses a single tile object and an array row", () => {
    expect(parseStatTiles('{"label":"trades","value":6117,"n":137}')).toEqual({
      tiles: [{ label: "trades", value: "6117", n: 137 }],
      error: null,
    });
    const row = parseStatTiles('[{"label":"a","value":"1.2%"},{"label":"b","value":3}]');
    expect(row.tiles).toEqual([
      { label: "a", value: "1.2%" },
      { label: "b", value: "3" },
    ]);
  });

  it("errors the WHOLE block on one bad entry (strict per block)", () => {
    const out = parseStatTiles('[{"label":"a","value":1},{"value":2}]');
    expect(out.tiles).toBeNull();
    expect(out.error).toContain("tiles[1]");
  });

  it("errors on non-JSON, empty arrays, over-cap rows and a bad n", () => {
    expect(parseStatTiles("not json").error).toContain("not valid JSON");
    expect(parseStatTiles("[]").error).toContain("empty");
    const many = JSON.stringify(Array.from({ length: STAT_TILE_CAP + 1 }, (_, i) => ({ label: `t${i}`, value: i })));
    expect(parseStatTiles(many).error).toContain(`${STAT_TILE_CAP}`);
    expect(parseStatTiles('{"label":"a","value":1,"n":"lots"}').error).toContain(".n");
  });
});

describe("parseInlineViewSpec / inlineSpecAt", () => {
  it("derives id from the block position and builtAt from the REPORT", () => {
    const out = parseInlineViewSpec(
      '{"kind":"table","title":"anoms","source":{"type":"file","path":"a.json"}}',
      3,
      REPORT
    );
    expect(out.error).toBeNull();
    expect(out.spec).toMatchObject({ id: "r1~b3", builtAt: REPORT.builtAt, builtBy: "agent", kind: "table" });
  });

  it("overrides an id the block tried to carry (position indexes it)", () => {
    const out = parseInlineViewSpec(
      '{"id":"sneaky","builtAt":"1999-01-01","kind":"table","title":"t","source":{"type":"file","path":"a.json"}}',
      1,
      REPORT
    );
    expect(out.spec?.id).toBe("r1~b1");
    expect(out.spec?.builtAt).toBe(REPORT.builtAt);
  });

  it("names the block in every error and isolates malformed blocks", () => {
    expect(parseInlineViewSpec("{nope", 2, REPORT).error).toBe("view block 2: not valid JSON");
    expect(parseInlineViewSpec("[1]", 4, REPORT).error).toContain("view block 4");
    expect(parseInlineViewSpec('{"kind":"martian"}', 5, REPORT).error).toContain("unknown view kind");
  });

  it("refuses a nested report", () => {
    const out = parseInlineViewSpec('{"kind":"report","title":"r","source":{"type":"file","path":"x.md"}}', 1, REPORT);
    expect(out.spec).toBeNull();
    expect(out.error).toContain("cannot embed a report");
  });

  it("inlineSpecAt finds a block by number and says when there is none", () => {
    const md = 'a\n```view\n{"kind":"bar","title":"b","source":{"type":"file","path":"b.json"},"keyColumn":"k"}\n```';
    const hit = inlineSpecAt(md, 1, REPORT);
    expect(hit.spec?.kind).toBe("bar");
    expect(inlineSpecAt(md, 2, REPORT).error).toContain("no view block 2");
  });
});

describe("the fixture report (SWIT-73 verification shape)", () => {
  // Three narrative sections, a stat row, a line view with regions, a table
  // with a drill — the report the ticket names, end to end through the
  // lexical split and the inline derivation.
  const FIXTURE = [
    "# Gamma over the June week",
    "",
    "What moved and when — the squeeze case in one page.",
    "",
    "```stat",
    '[{"label":"sessions","value":5},{"label":"flagged","value":"12","n":6117},{"label":"max |gamma|","value":"4.1bn"}]',
    "```",
    "",
    "## The path",
    "",
    "Net gamma flipped twice; the shaded bands are the halts.",
    "",
    "```view",
    JSON.stringify({
      kind: "line",
      title: "net gamma",
      source: { type: "file", path: ".sb-views/gamma.json" },
      regions: [{ from: "2026-06-05T14:30:00Z", to: "2026-06-05T15:00:00Z", label: "halt" }],
      seriesLabels: { net_gamma: "net gamma ($bn)" },
    }),
    "```",
    "",
    "## The instances",
    "",
    "Every flagged match, drillable to its timeline.",
    "",
    "```view",
    JSON.stringify({
      kind: "table",
      title: "flagged matches",
      source: { type: "file", path: ".sb-views/tennis/index.json" },
      keyColumn: "match_id",
      drill: {
        kind: "timeline",
        title: "{key}",
        source: { type: "file", path: ".sb-views/tennis/{key}.json" },
        sizeColumn: "size_z",
      },
    }),
    "```",
    "",
    "Closing note.",
  ].join("\n");

  it("splits into the expected interleave and every block derives", () => {
    const segs = splitReport(FIXTURE);
    expect(segs.map((s) => s.kind)).toEqual([
      "markdown",
      "stat",
      "markdown",
      "view",
      "markdown",
      "view",
      "markdown",
    ]);
    const stat = segs[1];
    expect(stat.kind === "stat" && parseStatTiles(stat.body).tiles?.length).toBe(3);
    const line = inlineSpecAt(FIXTURE, 2, REPORT);
    expect(line.spec).toMatchObject({ id: "r1~b2", kind: "line" });
    expect(line.spec?.regions).toHaveLength(1);
    expect(line.spec?.seriesLabels).toEqual({ net_gamma: "net gamma ($bn)" });
    const table = inlineSpecAt(FIXTURE, 3, REPORT);
    expect(table.spec).toMatchObject({ id: "r1~b3", kind: "table", keyColumn: "match_id" });
    expect(table.spec?.drill?.kind).toBe("timeline");
  });

  it("one malformed block errors alone; the rest of the report renders", () => {
    const broken = FIXTURE.replace('"kind":"line"', '"kind":"line"...');
    const segs = splitReport(broken);
    expect(segs.map((s) => s.kind)).toEqual([
      "markdown",
      "stat",
      "markdown",
      "view",
      "markdown",
      "view",
      "markdown",
    ]);
    expect(inlineSpecAt(broken, 2, REPORT).error).toBe("view block 2: not valid JSON");
    expect(inlineSpecAt(broken, 3, REPORT).spec?.kind).toBe("table");
  });
});

describe("report kind at the spec parser", () => {
  const spec = (source: unknown) =>
    parseViewSpec(JSON.stringify({ id: "r1", kind: "report", title: "r", source }));

  it("accepts a .md file source and refuses everything else", () => {
    expect(spec({ type: "file", path: "notes/analysis.md" }).spec?.kind).toBe("report");
    expect(spec({ type: "file", path: "analysis.MD" }).spec?.kind).toBe("report");
    expect(spec({ type: "file", path: "rows.json" }).specError).toContain(".md");
    expect(spec({ type: "file", path: "per/{key}.md" }).specError).toContain(".md");
    expect(spec({ type: "query", url: "http://127.0.0.1:8799/report" }).specError).toContain(".md");
  });
});

describe("the evidence→heading one-shot", () => {
  it("answers once, for the requested report only", () => {
    requestReportAnchor("t1", "r1", "h:the-path");
    expect(takeReportAnchor("t1", "OTHER")).toBeNull();
    expect(takeReportAnchor("t1", "r1")).toBe("h:the-path");
    expect(takeReportAnchor("t1", "r1")).toBeNull();
  });

  it("a second request replaces the first (the newer click wins)", () => {
    requestReportAnchor("t1", "r1", "h:a");
    requestReportAnchor("t1", "r1", "h:b");
    expect(takeReportAnchor("t1", "r1")).toBe("h:b");
  });

  it("is observable: a request notifies and bumps the nonce; a take is quiet", () => {
    let calls = 0;
    const unsubscribe = subscribeReportAnchor(() => {
      calls += 1;
    });
    const before = reportAnchorNonce();
    requestReportAnchor("t1", "r1", "h:observed");
    expect(calls).toBe(1);
    expect(reportAnchorNonce()).toBe(before + 1);
    // Consuming changes nothing a subscriber renders from.
    expect(takeReportAnchor("t1", "r1")).toBe("h:observed");
    expect(calls).toBe(1);
    expect(reportAnchorNonce()).toBe(before + 1);
    expect(takeReportAnchor("t1", "r1")).toBeNull();
    unsubscribe();
    requestReportAnchor("t1", "r1", "h:after");
    expect(calls).toBe(1);
    takeReportAnchor("t1", "r1");
  });
});
