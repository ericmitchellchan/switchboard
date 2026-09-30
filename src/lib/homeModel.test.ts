// Home's roll-up rules (SWIT-105): which threads' questions fold as "older".

import { describe, it, expect } from "vitest";
import {
  NEEDS_YOU_RECENT_DAYS,
  threadLastActive,
  isThreadRecent,
  olderThreadIds,
  olderQuestionsLabel,
  recentFindings,
  HOME_FINDINGS_LIMIT,
} from "./homeModel";
import { mergePage, parsePageFile } from "./pageStore";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-30T12:00:00Z");

const pageWith = (turnAt: string | null, askedAt: string[] = []) =>
  mergePage(
    parsePageFile(
      JSON.stringify({
        turns: turnAt ? [{ at: turnAt, lines: ["t"] }] : [],
        questions: askedAt.map((a, i) => ({ id: `q${i}`, text: "?", askedAt: a })),
      })
    ),
    {},
    []
  );

describe("homeModel — older questions fold on Home (SWIT-105)", () => {
  it("threadLastActive: the newest of the record's stamps, the latest turn, the open questions' asks", () => {
    const old = { lastActivityAt: NOW - 40 * DAY, createdAt: NOW - 60 * DAY };
    expect(threadLastActive(old, pageWith(null))).toBe(NOW - 40 * DAY);
    expect(threadLastActive(old, pageWith(new Date(NOW - 2 * DAY).toISOString()))).toBe(NOW - 2 * DAY);
    expect(threadLastActive(old, pageWith(null, [new Date(NOW - DAY).toISOString(), "junk"]))).toBe(NOW - DAY);
    expect(threadLastActive({ lastActivityAt: 0, createdAt: 0 }, pageWith("garbage"))).toBe(0);
  });

  it("isThreadRecent: live always; else inside the 14-day window (the edge included)", () => {
    expect(NEEDS_YOU_RECENT_DAYS).toBe(14);
    expect(isThreadRecent(NOW - 13 * DAY, false, NOW)).toBe(true);
    expect(isThreadRecent(NOW - 14 * DAY, false, NOW)).toBe(true);
    expect(isThreadRecent(NOW - 14 * DAY - 1, false, NOW)).toBe(false);
    expect(isThreadRecent(0, true, NOW)).toBe(true);
    expect(isThreadRecent(NOW + DAY, false, NOW)).toBe(true); // clock skew reads as recent
  });

  it("olderThreadIds: not live and no sign of life in the window", () => {
    const stale = { id: "old", lastActivityAt: NOW - 30 * DAY, createdAt: NOW - 30 * DAY };
    const digests = [
      { thread: stale, page: pageWith(null, [new Date(NOW - 30 * DAY).toISOString()]) },
      { thread: { ...stale, id: "asked-yesterday" }, page: pageWith(null, [new Date(NOW - DAY).toISOString()]) },
      { thread: { ...stale, id: "live" }, page: pageWith(null) },
      { thread: { ...stale, id: "fresh", lastActivityAt: NOW - DAY }, page: pageWith(null) },
    ];
    expect(olderThreadIds(digests, new Set(["live"]), NOW)).toEqual(new Set(["old"]));
  });

  it("the fold's words", () => {
    expect(olderQuestionsLabel(1)).toBe("older question");
    expect(olderQuestionsLabel(3)).toBe("older questions");
  });
});

describe("homeModel — Home's Findings block (SWIT-106)", () => {
  const withFindings = (rows: Array<{ id: string; verdict: string; updatedAt: string }>) =>
    mergePage(parsePageFile(JSON.stringify({ findings: rows.map((r) => ({ ...r, claim: `claim ${r.id}` })) })), {}, []);

  it("the newest HOME_FINDINGS_LIMIT across threads, each carrying its thread; an unparseable stamp sorts last", () => {
    expect(HOME_FINDINGS_LIMIT).toBe(8);
    const a = { id: "A", title: "gamma" };
    const b = { id: "B", title: "tennis" };
    const digests = [
      { thread: a, page: withFindings([{ id: "a1", verdict: "lead", updatedAt: "2026-09-30T02:00:00Z" }, { id: "a2", verdict: "dead", updatedAt: "garbage" }]) },
      { thread: b, page: withFindings([{ id: "b1", verdict: "open", updatedAt: "2026-09-30T09:00:00Z" }]) },
    ];
    expect(recentFindings(digests).map((r) => [r.thread.title, r.finding.id])).toEqual([
      ["tennis", "b1"],
      ["gamma", "a1"],
      ["gamma", "a2"],
    ]);
    expect(recentFindings(digests, 1).map((r) => r.finding.id)).toEqual(["b1"]);
    const many = [{ thread: a, page: withFindings(Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, verdict: "open", updatedAt: new Date(NOW - i * 1000).toISOString() }))) }];
    expect(recentFindings(many).map((r) => r.finding.id)).toEqual(["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7"]);
    expect(recentFindings([])).toEqual([]);
  });
});
