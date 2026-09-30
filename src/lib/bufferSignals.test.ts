// Ky's bufferSignals tests for the two reads ported here (SWIT-103): the
// live-screen text and the narrow-frame detector (CC-653). The other reads of
// Ky's file (`tailText`, the mid-turn markers) live in resumeHeal.ts and are
// tested in resumeHeal.test.ts.

import { describe, expect, it } from "vitest";
import { agentOnScreen, detectNarrowFrame, screenText } from "./bufferSignals";
import { tailText, type TerminalTail } from "./resumeHeal";

/** Fake terminal whose buffer renders the given lines. The cursor is on the
 *  last line unless `cursorY` says otherwise — a real idle claude screen puts
 *  it in the input box with the footer BELOW it. */
function fakeTerm(lines: string[], cursorY = lines.length - 1): TerminalTail {
  return {
    rows: lines.length,
    buffer: {
      active: {
        baseY: 0,
        cursorY,
        getLine: (y: number) =>
          y >= 0 && y < lines.length ? { translateToString: () => lines[y]! } : undefined,
      },
    },
  };
}

describe("screenText", () => {
  const READY_SCREEN = [
    "╭────────────────────────────╮",
    "│ >                          │", // ← the cursor lives here
    "╰────────────────────────────╯",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
  ];
  const CURSOR_IN_COMPOSER = 1;

  it("reads the rows BELOW the cursor, which tailText cannot", () => {
    const term = fakeTerm(READY_SCREEN, CURSOR_IN_COMPOSER);
    expect(tailText(term)).not.toContain("shift+tab to cycle");
    expect(screenText(term)).toContain("shift+tab to cycle");
  });

  it("excludes the scrollback above the viewport", () => {
    const lines = ["  ? for shortcuts", "● working on it…", "  esc to interrupt"];
    const term = fakeTerm(lines);
    term.buffer.active.baseY = 1; // the first line is now scrollback
    term.rows = 2;
    expect(screenText(term)).not.toContain("? for shortcuts");
    expect(screenText(term)).toContain("esc to interrupt");
  });
});

describe("agentOnScreen", () => {
  it("sees claude at rest (either footer) and at work", () => {
    expect(agentOnScreen(fakeTerm(["─".repeat(100), "> ", "─".repeat(100), "  ? for shortcuts"], 1))).toBe(true);
    expect(
      agentOnScreen(fakeTerm(["> ", "  ⏵⏵ accept edits on (shift+tab to cycle)"], 0))
    ).toBe(true);
    expect(agentOnScreen(fakeTerm(["✻ Churning… (12s · esc to interrupt)"]))).toBe(true);
    expect(agentOnScreen(fakeTerm([" ✻ Welcome to Claude Code v2.1.278"]))).toBe(true);
  });

  it("is false on a plain shell — even one printing rules", () => {
    expect(
      agentOnScreen(fakeTerm(["PS C:\\projects> pnpm test", "─".repeat(60), " Test Files  59 passed", "PS C:\\projects> "]))
    ).toBe(false);
  });

  it("reads the live screen only — a footer in scrollback is history", () => {
    const lines = ["  ? for shortcuts", "PS C:\\projects> ls", "PS C:\\projects> "];
    const term = fakeTerm(lines);
    term.buffer.active.baseY = 1;
    term.rows = 2;
    expect(agentOnScreen(term)).toBe(false);
  });
});

describe("detectNarrowFrame (Ky CC-653)", () => {
  const rule = (n: number) => "─".repeat(n);
  const frame = (ruleWidth: number, extra: string[] = []) => [
    "● Don't copy that one — that's the",
    "  snippet for page_viewed, and the",
    ...extra,
    rule(ruleWidth),
    "> ",
    rule(ruleWidth),
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ];

  it("reports the believed width when claude's rules are narrower than the grid", () => {
    // Ky's screenshot: a 102-column pane, rules drawn at 38.
    expect(detectNarrowFrame(fakeTerm(frame(38)), 102)).toBe(38);
    // Our pinned grid.
    expect(detectNarrowFrame(fakeTerm(frame(60)), 100)).toBe(60);
  });

  it("is null when a rule spans the grid (belief is current)", () => {
    expect(detectNarrowFrame(fakeTerm(frame(102)), 102)).toBeNull();
    // A couple of cells short is still full width: a trailing cell xterm
    // trims, or a markdown --- drawn inside a 2-cell-indented message body.
    expect(detectNarrowFrame(fakeTerm(frame(101)), 102)).toBeNull();
    expect(detectNarrowFrame(fakeTerm(frame(99)), 102)).toBeNull();
    expect(detectNarrowFrame(fakeTerm(frame(98)), 102)).toBe(98);
  });

  it("a single full-width rule vetoes narrower decoration in the same frame", () => {
    // A markdown "---" that claude drew narrow earlier in the turn must not
    // outvote the live input-box rule at the real width.
    expect(detectNarrowFrame(fakeTerm(frame(102, [rule(60)])), 102)).toBeNull();
  });

  it("ignores table borders and short dashes", () => {
    const lines = [
      "┌───────┬────────────┐",
      "│ Event │ Base event │",
      "├───────┼────────────┤",
      "└───────┴────────────┘",
      "──────",
      "> ",
    ];
    expect(detectNarrowFrame(fakeTerm(lines), 102)).toBeNull();
  });

  it("is null on a plain shell — no rule at all", () => {
    const lines = ["PS C:\\Users\\e\\projects> git status", "On branch main", "PS C:\\Users\\e\\projects> "];
    expect(detectNarrowFrame(fakeTerm(lines), 100)).toBeNull();
  });

  it("only reads the live screen — narrow rules in scrollback are history", () => {
    // 3 rows of viewport; the narrow rules sit above baseY.
    const lines = [rule(38), rule(38), "● old turn", "● new turn", rule(102), "> "];
    const term: TerminalTail = {
      rows: 3,
      buffer: {
        active: {
          baseY: 3,
          cursorY: 2,
          getLine: (y) =>
            y >= 0 && y < lines.length ? { translateToString: () => lines[y]! } : undefined,
        },
      },
    };
    expect(detectNarrowFrame(term, 102)).toBeNull();
  });
});
