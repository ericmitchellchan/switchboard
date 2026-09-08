// THE FACTS ROW (SWIT-79, Ky's facts.ts CC-702): the paragraph rule, the
// first-two-sections reach, the list-shaped keys — and the real spec header.

import { describe, it, expect } from "vitest";
// @ts-expect-error — no @types/node in the frontend tsconfig; vitest's node
// runtime provides the real module.
import { createRequire } from "node:module";
import { parseFactsParagraph, factItems, splitFacts, sectionStarts, FACTS_SECTION_REACH } from "./facts";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require("fs") as { existsSync: (p: string) => boolean; readFileSync: (p: string, enc: string) => string };

const REAL_SPEC = "C:/Users/ericm/projects/personal-kb/switchboard/features/shell-v3-deep-dive/requirements.md";

describe("parseFactsParagraph", () => {
  it("needs a leading pair and at least two; values run to the next pair, a trailing separator stripped", () => {
    expect(parseFactsParagraph("**Owner:** Eric · **Date:** 2026-09-01 · **Status:** Draft")).toEqual([
      { key: "Owner", value: "Eric" },
      { key: "Date", value: "2026-09-01" },
      { key: "Status", value: "Draft" },
    ]);
    expect(parseFactsParagraph("**Owner:** Eric")).toBeNull();
    expect(parseFactsParagraph("Owner: Eric · **Date:** x · **Status:** y")).toBeNull();
    expect(parseFactsParagraph("plain paragraph")).toBeNull();
  });

  it("bold inside a value is not a pair (no colon), and a key may hold spaces and parentheses", () => {
    const facts = parseFactsParagraph("**Tracker:** Linear epic **SWIT-54**.\n**Decision (Eric, 2026-09-01):** \"Rip it out.\"")!;
    expect(facts).toEqual([
      { key: "Tracker", value: "Linear epic **SWIT-54**." },
      { key: "Decision (Eric, 2026-09-01)", value: "\"Rip it out.\"" },
    ]);
  });
});

describe("factItems", () => {
  it("splits list-shaped keys on ` · `, leaves the rest whole", () => {
    expect(factItems({ key: "Tickets", value: "CAD-1 (epic) · CAD-2 (mobile)" })).toEqual(["CAD-1 (epic)", "CAD-2 (mobile)"]);
    expect(factItems({ key: "PRs", value: "#1 • #2" })).toEqual(["#1", "#2"]);
    expect(factItems({ key: "Status", value: "a · b" })).toEqual(["a · b"]);
  });
});

describe("sectionStarts", () => {
  it("marks heading lines outside code fences, plus an intro when text precedes the first heading", () => {
    const md = "intro\n\n# One\n\n```\n# not a heading\n```\n\n## Two\n";
    const starts = sectionStarts(md);
    expect(starts).toEqual([0, md.indexOf("# One"), md.indexOf("## Two")]);
    expect(sectionStarts("# A\n\n# B\n")).toEqual([0, 5]);
    expect(sectionStarts("just text")).toEqual([0]);
    expect(sectionStarts("")).toEqual([]);
  });
});

describe("splitFacts", () => {
  it("cuts the first facts paragraph within the first two sections and keeps the rest byte-exact", () => {
    const md = "# Title\n\n**Owner:** Eric · **Date:** 2026-09-01\n\nBody line one.\n\n## Next\n\ntext\n";
    const split = splitFacts(md)!;
    expect(split.before).toBe("# Title");
    expect(split.facts.map((f) => f.key)).toEqual(["Owner", "Date"]);
    expect(split.after).toBe("Body line one.\n\n## Next\n\ntext\n");
  });

  it("finds the H1 section behind an intro (Ky's YAML-intro case) and a line directly under the heading", () => {
    const intro = "---\ntitle: x\n---\n\n# Title\n**Owner:** Eric · **Status:** Draft\n\nprose\n";
    const split = splitFacts(intro)!;
    expect(split.before).toBe("---\ntitle: x\n---\n\n# Title");
    expect(split.facts).toHaveLength(2);
    expect(split.after).toBe("prose\n");
  });

  it("looks no further than the first two sections — a facts line in section three stays prose", () => {
    expect(FACTS_SECTION_REACH).toBe(2);
    const md = "# One\n\nprose\n\n## Two\n\nprose\n\n## Three\n\n**A:** 1 · **B:** 2\n";
    expect(splitFacts(md)).toBeNull();
    const md2 = "# One\n\nprose\n\n## Two\n\n**A:** 1 · **B:** 2\n";
    expect(splitFacts(md2)!.facts).toHaveLength(2);
  });

  it("ignores a facts-shaped line inside a code fence and folds CRLF", () => {
    expect(splitFacts("# T\r\n\r\n```\r\n**A:** 1 · **B:** 2\r\n```\r\n")).toBeNull();
    expect(splitFacts("# T\r\n\r\n**A:** 1 · **B:** 2\r\n\r\nbody\r\n")!.after).toBe("body\n");
  });

  it("the real shell-v3 spec header: Status · Tracker · Decision (Eric, 2026-09-01)", () => {
    if (!fs.existsSync(REAL_SPEC)) {
      // The personal KB is not checked out beside this repo — the inline
      // copy of its header below is asserted instead.
      const header =
        "# Shell v3 — bare bones first, then the deep-dive lane\n\n" +
        "**Status:** DRAFT 2026-09-01, written from Eric's first-look review of v0.4.0 (this session). Supersedes nothing in `coaching-platform/` — it re-sequences it.\n" +
        "**Tracker:** Linear epic **SWIT-54**.\n" +
        "**Decision (Eric, 2026-09-01):** \"Rip everything out.\"\n\n## Why\n\nprose\n";
      const split = splitFacts(header)!;
      expect(split.facts.map((f) => f.key)).toEqual(["Status", "Tracker", "Decision (Eric, 2026-09-01)"]);
      return;
    }
    const split = splitFacts(fs.readFileSync(REAL_SPEC, "utf8"))!;
    expect(split).not.toBeNull();
    expect(split.before).toBe("# Shell v3 — bare bones first, then the deep-dive lane");
    expect(split.facts.map((f) => f.key)).toEqual(["Status", "Tracker", "Decision (Eric, 2026-09-01)"]);
    expect(split.facts[1].value).toBe("Linear epic **SWIT-54**.");
    expect(split.after.startsWith("## Why")).toBe(true);
  });
});
