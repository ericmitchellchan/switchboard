// SWIT-117 — the chat view's rendering rules that a parser test cannot see:
// a folded tool call shows its header and NO result text; opening it shows the
// whole thing; a running call says so and cannot be opened; an empty
// conversation says something. Rendered with react-dom/server (no DOM in this
// suite), so effects do not run — these are the first-paint truths.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolRow, chatPlaceholder } from "../components/ChatPane";
import type { ToolEntry } from "./transcript";

const tool = (over: Partial<ToolEntry> = {}): ToolEntry => ({
  kind: "tool",
  id: "t1",
  name: "Bash",
  summary: "Run the tests",
  done: true,
  isError: false,
  result: "2,277 passed — SECRET-RESULT-TEXT",
  hasImage: false,
  at: "2026-10-03T19:00:00.000Z",
  ...over,
});

const render = (entry: ToolEntry, open: boolean) =>
  renderToStaticMarkup(createElement(ToolRow, { entry, open, onToggle: () => {} }));

describe("a tool call row", () => {
  it("folded: the header line only — the name and summary, never the result text", () => {
    const html = render(tool(), false);
    expect(html).toContain("Bash");
    expect(html).toContain("Run the tests");
    expect(html).toContain("show");
    expect(html).not.toContain("SECRET-RESULT-TEXT");
  });

  it("opened: the whole result", () => {
    expect(render(tool(), true)).toContain("SECRET-RESULT-TEXT");
  });

  it("a running call says so and draws no result even if asked open", () => {
    const html = render(tool({ done: false, result: "" }), true);
    expect(html).toContain("running…");
    expect(html).not.toContain("<pre");
  });

  it("a failed call says failed", () => {
    expect(render(tool({ isError: true }), false)).toContain("failed");
  });
});

describe("the empty conversation", () => {
  it("always says something until there is something to draw", () => {
    expect(chatPlaceholder(false, null, 0)).toMatch(/Nothing has been said/);
    expect(chatPlaceholder(null, null, 0)).toMatch(/Reading/);
    expect(chatPlaceholder(true, null, 0)).toMatch(/only setup/);
    expect(chatPlaceholder(true, null, 3)).toBeNull();
    // review: a first read that failed, and a window that cut a record with
    // no messages in its tail, are not blank either
    expect(chatPlaceholder(null, "boom", 0)).toMatch(/could not be read/);
    expect(chatPlaceholder(true, null, 0, true)).toMatch(/latest part/);
  });
});
