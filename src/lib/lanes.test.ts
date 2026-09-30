// LANES (SWIT-108) — the pure rules: the name, the user-wins copy of the
// agent's `page` op `lane`, rename collisions, the archive records and the
// roll-ups Home, the side menu and the lane page draw.

import { describe, it, expect } from "vitest";
import type { Thread } from "../types";
import {
  LANE_NAME_MAX,
  normalizeLaneName,
  sameLaneName,
  laneId,
  threadLane,
  isInLane,
  projectLaneNames,
  canonicalLaneName,
  suggestLaneNames,
  laneFromPage,
  planLaneRename,
  sanitizeLaneRecords,
  setLaneArchivedIn,
  renameLaneRecords,
  pruneLaneRecords,
  laneArchivedAt,
  deriveLanes,
  findLane,
  rollupThreads,
  laneThreadDir,
  laneRollup,
  isLaneWaiting,
  laneWaitsLabel,
  laneHomeLine,
  orderLaneRows,
  laneMarkerCount,
  laneReports,
  LANE_ANSWERED_LIMIT,
  type LaneRow,
} from "./lanes";
import { mergePage, parsePageFile, type RenderedPage } from "./pageStore";
import type { ProjectViewEntry } from "./repoListing";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const HOUR = 3_600_000;

function thread(id: string, over: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    workingDir: "C:/projects/lodestar",
    chatSessionId: `c-${id}`,
    chatStarted: true,
    sessionId: null,
    createdAt: NOW - 100 * HOUR,
    lastActivityAt: NOW - 50 * HOUR,
    ...over,
  };
}
const inLane = (id: string, name: string, over: Partial<Thread> = {}) =>
  thread(id, { lane: name, laneProject: "lodestar", laneSetBy: "user", ...over });

const page = (json: Record<string, unknown>, answers: Record<string, unknown> = {}): RenderedPage =>
  mergePage(parsePageFile(JSON.stringify(json)), answers as never, []);
const brief = (goal: string, updatedAt: string) => ({ goal, established: ["e"], updatedAt });

describe("the lane name", () => {
  it("is a few words: folded, trimmed, NFC; refused with a reason when empty, too long or out of the charset", () => {
    expect(normalizeLaneName("  Gamma   model ")).toEqual({ ok: true, name: "Gamma model" });
    expect(normalizeLaneName("Kalshi MLB (G5) / live-lead #2")).toEqual({ ok: true, name: "Kalshi MLB (G5) / live-lead #2" });
    expect(normalizeLaneName("Exécution réalisme")).toMatchObject({ ok: true });
    expect(normalizeLaneName("")).toEqual({ ok: false, reason: "a lane needs a name" });
    expect(normalizeLaneName(7)).toMatchObject({ ok: false });
    expect(normalizeLaneName("x".repeat(LANE_NAME_MAX))).toMatchObject({ ok: true });
    expect(normalizeLaneName("x".repeat(LANE_NAME_MAX + 1))).toMatchObject({ ok: false, reason: expect.stringContaining("48") });
    // Nothing the typed-line sanitizer strips — the name rides the launch line.
    for (const bad of ['a"b', "a$b", "a%b", "a`b", "a\\b", "-leading", "tab\there"]) {
      expect(normalizeLaneName(bad).ok, bad).toBe(bad === "tab\there");
    }
  });

  it("two spellings that differ in case or spacing are one lane", () => {
    expect(sameLaneName("Gamma model", "gamma  MODEL")).toBe(true);
    expect(sameLaneName("Gamma model", "Gamma models")).toBe(false);
    expect(laneId({ project: "lodestar", name: "Gamma Model" })).toBe(laneId({ project: "lodestar", name: "gamma model" }));
    expect(laneId({ project: "lodestar", name: "x" })).not.toBe(laneId({ project: "kyde", name: "x" }));
  });
});

describe("a thread's lane", () => {
  it("needs both the name and the project; membership is case-insensitive on the name, exact on the project", () => {
    expect(threadLane(thread("a"))).toBeNull();
    expect(threadLane(thread("a", { lane: "Gamma" }))).toBeNull();
    expect(threadLane(inLane("a", "Gamma"))).toEqual({ project: "lodestar", name: "Gamma" });
    expect(isInLane(inLane("a", "Gamma"), { project: "lodestar", name: "gamma" })).toBe(true);
    expect(isInLane(inLane("a", "Gamma"), { project: "kyde", name: "Gamma" })).toBe(false);
  });

  it("the project's lanes (archived threads included), one spelling each — the most recent thread's — offered and matched", () => {
    const threads = [
      inLane("a", "gamma model", { lastActivityAt: NOW - 10 * HOUR }),
      inLane("b", "Gamma model", { lastActivityAt: NOW - HOUR, archivedAt: NOW }),
      inLane("c", "Tennis"),
      thread("d", { lane: "Other", laneProject: "kyde" }),
    ];
    expect(projectLaneNames(threads, "lodestar")).toEqual(["Gamma model", "Tennis"]);
    expect(projectLaneNames(threads, "kyde")).toEqual(["Other"]);
    expect(canonicalLaneName(threads, "lodestar", "GAMMA MODEL")).toBe("Gamma model");
    expect(canonicalLaneName(threads, "lodestar", "Combos")).toBe("Combos");
    expect(suggestLaneNames(["Gamma model", "Tennis", "Kalshi gamma"], "gam")).toEqual(["Gamma model", "Kalshi gamma"]);
    expect(suggestLaneNames(["Gamma model", "Tennis"], "")).toEqual(["Gamma model", "Tennis"]);
  });
});

describe("Eric's choice wins — the agent's `lane` op is copied only onto a thread with no lane (acceptance 7)", () => {
  const all = [inLane("x", "Gamma model")];
  it("a thread with no lane takes the page's lane, spelled as the project spells it", () => {
    expect(laneFromPage(thread("a"), "gamma MODEL", "lodestar", all)).toEqual({ project: "lodestar", name: "Gamma model" });
    expect(laneFromPage(thread("a"), "Combos", "lodestar", all)).toEqual({ project: "lodestar", name: "Combos" });
  });
  it("never moves a thread Eric placed, never re-places one he took out, never an agent's earlier lane either", () => {
    expect(laneFromPage(inLane("a", "Tennis", { laneSetBy: "user" }), "Gamma model", "lodestar", all)).toBeNull();
    expect(laneFromPage(inLane("a", "Tennis", { laneSetBy: "agent" }), "Gamma model", "lodestar", all)).toBeNull();
    expect(laneFromPage(thread("a", { laneSetBy: "user" }), "Gamma model", "lodestar", all)).toBeNull();
  });
  it("no page lane, no project, or not a lane name → nothing", () => {
    expect(laneFromPage(thread("a"), null, "lodestar", all)).toBeNull();
    expect(laneFromPage(thread("a"), "Gamma", null, all)).toBeNull();
    expect(laneFromPage(thread("a"), 'bad"name', "lodestar", all)).toBeNull();
  });
});

describe("rename (edge case 5)", () => {
  const threads = [inLane("a", "Gamma model"), inLane("b", "Gamma model", { archivedAt: NOW }), inLane("c", "Tennis"), thread("d", { lane: "Combos", laneProject: "kyde" })];
  it("a name another lane in the project has is REFUSED with the reason; another project's name is fine", () => {
    expect(planLaneRename(threads, "lodestar", "Gamma model", "tennis")).toEqual({
      ok: false,
      reason: "Tennis is already a lane in lodestar — merging two lanes is not possible yet",
    });
    expect(planLaneRename(threads, "lodestar", "Gamma model", "Combos")).toEqual({ ok: true, name: "Combos" });
  });
  it("a case-only rename of the lane itself is allowed; a bad name or a missing lane is refused", () => {
    expect(planLaneRename(threads, "lodestar", "Gamma model", "gamma Model")).toEqual({ ok: true, name: "gamma Model" });
    expect(planLaneRename(threads, "lodestar", "Gamma model", "")).toMatchObject({ ok: false });
    expect(planLaneRename(threads, "lodestar", "Nope", "New")).toMatchObject({ ok: false, reason: expect.stringContaining("no lane named Nope") });
  });
});

describe("archive records (requirement 1.6)", () => {
  const gamma = { project: "lodestar", name: "Gamma model" };
  it("tolerant parse: junk drops alone, a repeat keeps its first, the name is normalized", () => {
    expect(
      sanitizeLaneRecords([
        { project: "lodestar", name: " Gamma  model ", archivedAt: 5 },
        { project: "lodestar", name: "gamma model", archivedAt: 9 },
        { project: "", name: "x", archivedAt: 1 },
        { project: "p", name: 'bad"', archivedAt: 1 },
        { project: "p", name: "ok", archivedAt: 0 },
        null,
      ])
    ).toEqual([{ project: "lodestar", name: "Gamma model", archivedAt: 5 }]);
    expect(sanitizeLaneRecords("junk")).toEqual([]);
  });
  it("archive / restore / rename move ONE record; a no-op is the same array; a lane with no thread left is pruned", () => {
    const none: never[] = [];
    const archived = setLaneArchivedIn(none, gamma, true, 7);
    expect(archived).toEqual([{ ...gamma, archivedAt: 7 }]);
    expect(setLaneArchivedIn(archived, { project: "lodestar", name: "GAMMA model" }, true, 9)).toBe(archived);
    expect(laneArchivedAt(archived, gamma)).toBe(7);
    expect(setLaneArchivedIn(archived, gamma, false, 9)).toEqual([]);
    expect(renameLaneRecords(archived, gamma, "Gamma")).toEqual([{ project: "lodestar", name: "Gamma", archivedAt: 7 }]);
    expect(pruneLaneRecords(archived, [inLane("a", "gamma model")])).toBe(archived);
    expect(pruneLaneRecords(archived, [inLane("a", "Tennis")])).toEqual([]);
  });
});

describe("the lanes themselves", () => {
  it("a lane is its threads — archived ones included — with its archive state; ordered by project then name", () => {
    const threads = [inLane("a", "Tennis"), inLane("b", "gamma"), inLane("c", "Gamma", { archivedAt: NOW, lastActivityAt: NOW }), thread("d"), thread("e", { lane: "Z", laneProject: "kyde" })];
    const lanes = deriveLanes(threads, [{ project: "lodestar", name: "Tennis", archivedAt: 3 }]);
    expect(lanes.map((l) => `${l.project}/${l.name}:${l.threads.map((t) => t.id).join("")}:${l.archivedAt}`)).toEqual([
      "kyde/Z:e:null",
      "lodestar/Gamma:cb:null",
      "lodestar/Tennis:a:3",
    ]);
    expect(findLane(lanes, { project: "lodestar", name: "GAMMA" })?.threads).toHaveLength(2);
    expect(findLane(lanes, { project: "lodestar", name: "Combos" })).toBeNull();
  });
  it("the roll-up reads every active thread and an archived one ONLY when it is in a lane (principle 4)", () => {
    const threads = [thread("a"), thread("b", { archivedAt: NOW }), inLane("c", "Gamma", { archivedAt: NOW }), inLane("d", "Gamma")];
    expect(rollupThreads(threads).map((t) => t.id)).toEqual(["a", "c", "d"]);
  });
  it("`+ Thread in this lane` starts in the most recent lane thread's folder when it is in a project repo, else the first repo", () => {
    const inside = (dir: string, repo: string) => dir.toLowerCase().startsWith(repo.toLowerCase());
    const repos = ["C:/p/lodestar", "C:/p/orbit"];
    expect(
      laneThreadDir(
        [
          { workingDir: "C:/p/orbit/sub", lastActivityAt: NOW, createdAt: 0 },
          { workingDir: "C:/p/lodestar", lastActivityAt: NOW - HOUR, createdAt: 0 },
        ],
        repos,
        inside
      )
    ).toBe("C:/p/orbit/sub");
    expect(laneThreadDir([{ workingDir: "C:/elsewhere", lastActivityAt: NOW, createdAt: 0 }], repos, inside)).toBe("C:/p/lodestar");
    expect(laneThreadDir([], [], inside)).toBeNull();
  });
});

describe("the lane roll-up (requirement 2; edge cases 1, 2, 4)", () => {
  const a = inLane("a", "Gamma", { title: "gamma · design review" });
  const b = inLane("b", "Gamma", { title: "gamma · deck export", archivedAt: NOW });
  const c = inLane("c", "Gamma", { title: "gamma · layer 0" });

  it("THE LANE BRIEF is the newest brief among its threads, and it names the thread (edge case 1)", () => {
    const digests = new Map([
      ["a", page({ brief: brief("older goal", "2026-09-20T10:00:00Z") })],
      ["b", page({ brief: brief("newest goal", "2026-09-29T10:00:00Z") })],
      ["c", page({})],
    ]);
    const r = laneRollup([a, b, c], digests, new Set(), NOW);
    expect(r.brief?.brief.goal).toBe("newest goal");
    expect(r.brief?.thread.id).toBe("b"); // archived is not gone (principle 4)
  });

  it("a thread that JOINS with an OLDER brief never becomes the lane brief (edge case 2)", () => {
    const current = new Map([["a", page({ brief: brief("the lane's current brief", "2026-09-29T10:00:00Z") })]]);
    const joiner = inLane("j", "Gamma");
    const withJoiner = new Map([...current, ["j", page({ brief: brief("a narrow old brief", "2026-09-01T10:00:00Z") })]]);
    expect(laneRollup([a], current, new Set(), NOW).brief?.brief.goal).toBe("the lane's current brief");
    expect(laneRollup([a, joiner], withJoiner, new Set(), NOW).brief?.brief.goal).toBe("the lane's current brief");
    // Rewriting it AFTER reading (a newer stamp) is what replaces it.
    const rewritten = new Map([...withJoiner, ["j", page({ brief: brief("rewritten for the lane", "2026-09-30T10:00:00Z") })]]);
    const r = laneRollup([a, joiner], rewritten, new Set(), NOW);
    expect(r.brief?.brief.goal).toBe("rewritten for the lane");
    expect(r.brief?.thread.id).toBe("j");
    // No brief anywhere → null.
    expect(laneRollup([c], new Map([["c", page({})]]), new Set(), NOW).brief).toBeNull();
  });

  it("findings from every thread newest first (a dropped finding is gone from its page); decisions open → unsent → answered", () => {
    const digests = new Map([
      [
        "a",
        page(
          {
            findings: [{ id: "f1", claim: "old claim", verdict: "fact", updatedAt: "2026-09-10T00:00:00Z" }],
            questions: [
              { id: "q1", text: "Which book?", askedAt: "2026-09-20T00:00:00Z" },
              { id: "q2", text: "Decided one?", askedAt: "2026-09-19T00:00:00Z" },
              { id: "q3", text: "Settled?", askedAt: "2026-09-18T00:00:00Z", answer: "moot", answeredAt: "2026-09-21T00:00:00Z" },
            ],
            items: [{ id: "i1", title: "pick", owner: "user" }],
          },
          { q2: { text: "front", at: "2026-09-22T00:00:00Z" } }
        ),
      ],
      [
        "b",
        page({
          findings: [{ id: "f9", claim: "newest claim", verdict: "lead", n: "264 nights", updatedAt: "2026-09-28T00:00:00Z" }],
          questions: [{ id: "q1", text: "State variable?", askedAt: "2026-09-25T00:00:00Z" }],
        }),
      ],
    ]);
    const r = laneRollup([a, b, c], digests, new Set(), NOW);
    expect(r.findings.map((f) => `${f.thread.id}:${f.finding.claim}`)).toEqual(["b:newest claim", "a:old claim"]);
    expect(r.openQuestions.map((q) => `${q.thread.id}:${q.question.text}`)).toEqual(["b:State variable?", "a:Which book?"]);
    expect(r.unsent).toEqual([{ thread: a, count: 1 }]);
    expect(r.answered.map((x) => x.settled.question.id)).toEqual(["q3"]);
    expect(r.waiting).toEqual({ questions: 2, unsent: 1, requests: 0, items: 1 });
    expect(isLaneWaiting(r.waiting)).toBe(true);
    expect(laneWaitsLabel(r.waiting)).toBe("2 questions · 1 unsent · 1 item for you");
    expect(laneHomeLine(r)).toBe("newest claim");
  });

  it("answered decisions are capped; Home's line falls back to the brief's goal, then nothing", () => {
    const qs = Array.from({ length: LANE_ANSWERED_LIMIT + 3 }, (_, i) => ({
      id: `q${i}`,
      text: `q${i}`,
      askedAt: "2026-09-01T00:00:00Z",
      answer: "a",
      answeredAt: `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
    }));
    const r = laneRollup([a], new Map([["a", page({ questions: qs, brief: brief("the goal", "2026-09-29T00:00:00Z") })]]), new Set(), NOW);
    expect(r.answered).toHaveLength(LANE_ANSWERED_LIMIT);
    expect(r.answered[0].settled.question.id).toBe(`q${LANE_ANSWERED_LIMIT + 2}`);
    expect(laneHomeLine(r)).toBe("the goal");
    expect(laneHomeLine({ findings: [], brief: null })).toBeNull();
    expect(laneWaitsLabel({ questions: 1, unsent: 0, requests: 1, items: 2 })).toBe("1 question · 1 request · 2 items for you");
    expect(laneWaitsLabel({ questions: 0, unsent: 0, requests: 0, items: 0 })).toBeNull();
  });

  it("last activity: live = now; else the newest of record stamps, turns, asks, the brief and findings; unread threads count their record", () => {
    const digests = new Map([["a", page({ brief: brief("g", "2026-09-29T00:00:00Z") })]]);
    expect(laneRollup([a], digests, new Set(), NOW).lastActive).toBe(Date.parse("2026-09-29T00:00:00Z"));
    expect(laneRollup([a], digests, new Set(["a"]), NOW).lastActive).toBe(NOW);
    expect(laneRollup([c], new Map(), new Set(), NOW).lastActive).toBe(c.lastActivityAt);
  });

  it("Home's order: waiting on Eric first, then last activity; a lane whose only live thread was archived stays up while it has open decisions (edge case 4)", () => {
    const row = (name: string, waiting: number, lastActive: number): LaneRow => ({
      lane: { project: "lodestar", name, threads: [], archivedAt: null },
      rollup: {
        brief: null,
        findings: [],
        openQuestions: [],
        unsent: [],
        answered: [],
        waiting: { questions: waiting, unsent: 0, requests: 0, items: 0 },
        lastActive,
      },
    });
    const ordered = orderLaneRows([row("quiet-new", 0, NOW), row("waits-old", 2, NOW - 90 * HOUR), row("quiet-old", 0, NOW - 99 * HOUR), row("waits-new", 1, NOW - HOUR)]);
    expect(ordered.map((r) => r.lane.name)).toEqual(["waits-new", "waits-old", "quiet-new", "quiet-old"]);
  });

  it("the side menu's `· N`: open questions + unsent answers over the lane's threads", () => {
    expect(laneMarkerCount({ threads: [a, b, c] }, { a: 2, c: 1, x: 9 }, { b: 1 })).toBe(4);
    expect(laneMarkerCount({ threads: [c] }, {}, {})).toBe(0);
  });
});

describe("the lane's reports (requirement 2.5; edge cases 3 and 6)", () => {
  const view = (id: string, threadId: string, lane = ""): ProjectViewEntry => ({
    project: "lodestar",
    id,
    title: id,
    kind: "report",
    builtAt: "2026-09-29T00:00:00Z",
    threadId,
    repo: "",
    lane,
  });
  const lane = { name: "Gamma", threads: [inLane("a", "Gamma"), inLane("b", "Gamma", { archivedAt: NOW })] };
  it("the reports the lane's threads built — by the index row's thread — archived threads' included", () => {
    const views = [view("v1", "a"), view("v2", "b"), view("v3", "other"), view("v4", "")];
    const known = new Set(["a", "b", "other"]);
    expect(laneReports(views, lane, known).map((v) => v.id)).toEqual(["v1", "v2"]);
  });
  it("a report whose thread was DELETED stays on the lane it was built in; a live thread's report follows the thread's CURRENT lane", () => {
    const known = new Set(["a", "b", "moved"]);
    const views = [view("gone", "deleted-thread", "gamma"), view("elsewhere", "deleted-2", "Tennis"), view("moved", "moved", "Gamma")];
    expect(laneReports(views, lane, known).map((v) => v.id)).toEqual(["gone"]);
  });
});
