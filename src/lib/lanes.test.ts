// LANES (SWIT-108) — the pure rules: the name, the user-wins copy of the
// agent's `page` op `lane`, rename collisions, the archive records and the
// roll-ups Home, the side menu and the lane page draw.

import { describe, it, expect } from "vitest";
import type { LaneRecord, Thread } from "../types";
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
  laneWaitingFromCounts,
  waitingTotal,
  inVisibleLane,
  laneEditProject,
  liveliestStatus,
  namesLane,
  briefCountsFor,
  pickLaneBrief,
  nextLaneBriefCaches,
  LANE_ALIAS_CAP,
  type Lane,
  laneReports,
  LANE_ANSWERED_LIMIT,
  type LaneRow,
} from "./lanes";
import { mergePage, parsePageFile, type PageBrief, type RenderedPage } from "./pageStore";
import type { ProjectViewEntry } from "./repoListing";
import { digestCacheHit } from "./threadDigest";

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
const brief = (goal: string, updatedAt: string): PageBrief => ({ goal, established: ["e"], dead: [], lead: [], waiting: [], updatedAt });

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

describe("lane records (requirement 1.6; review of ec319c7, #1 and #5)", () => {
  const gamma = { project: "lodestar", name: "Gamma model" };
  const cache = (goal: string, updatedAt: string, threadId = "a") => ({ brief: brief(goal, updatedAt), threadId, threadTitle: `t ${threadId}` });
  it("tolerant parse: junk drops alone (a bad alias, a bad brief), a repeat keeps its first, a record holding nothing is none", () => {
    expect(
      sanitizeLaneRecords([
        { project: "lodestar", name: " Gamma  model ", archivedAt: 5, aliases: ["Gamma", "gamma", 'bad"', "Gamma model"] },
        { project: "lodestar", name: "gamma model", archivedAt: 9 },
        { project: "", name: "x", archivedAt: 1 },
        { project: "p", name: 'bad"', archivedAt: 1 },
        { project: "p", name: "ok", archivedAt: 0 },
        { project: "p", name: "junk brief", brief: { brief: "nope", threadId: "a" } },
        { project: "p", name: "cached", brief: cache("g", "2026-09-29T00:00:00Z") },
        null,
      ])
    ).toEqual([
      { project: "lodestar", name: "Gamma model", archivedAt: 5, aliases: ["Gamma"] },
      { project: "p", name: "cached", brief: { ...cache("g", "2026-09-29T00:00:00Z"), brief: { goal: "g", established: ["e"], dead: [], lead: [], waiting: [], updatedAt: "2026-09-29T00:00:00Z" } } },
    ]);
    expect(sanitizeLaneRecords("junk")).toEqual([]);
  });
  it("archive / restore move ONE record; a no-op is the same array; restoring a record that holds nothing else drops it", () => {
    const none: never[] = [];
    const archived = setLaneArchivedIn(none, gamma, true, 7);
    expect(archived).toEqual([{ ...gamma, archivedAt: 7 }]);
    expect(setLaneArchivedIn(archived, { project: "lodestar", name: "GAMMA model" }, true, 9)).toBe(archived);
    expect(laneArchivedAt(archived, gamma)).toBe(7);
    expect(setLaneArchivedIn(archived, gamma, false, 9)).toEqual([]);
    expect(pruneLaneRecords(archived, [inLane("a", "gamma model")])).toBe(archived);
    expect(pruneLaneRecords(archived, [inLane("a", "Tennis")])).toEqual([]);
  });
  it("a RENAME keeps the former names (newest LANE_ALIAS_CAP), never the new name itself; the record goes with it", () => {
    const archived = setLaneArchivedIn([], gamma, true, 7);
    const once = renameLaneRecords(archived, gamma, "Gamma");
    expect(once).toEqual([{ project: "lodestar", name: "Gamma", archivedAt: 7, aliases: ["Gamma model"] }]);
    // Renaming back drops the name it returns to from the aliases.
    expect(renameLaneRecords(once, { project: "lodestar", name: "Gamma" }, "gamma MODEL")).toEqual([
      { project: "lodestar", name: "gamma MODEL", archivedAt: 7, aliases: ["Gamma"] },
    ]);
    // A lane with no record gets one holding just its former name.
    expect(renameLaneRecords([], gamma, "G")).toEqual([{ project: "lodestar", name: "G", aliases: ["Gamma model"] }]);
    let rec: readonly LaneRecord[] = [];
    let name = "n0";
    for (let i = 1; i <= LANE_ALIAS_CAP + 3; i++) {
      rec = renameLaneRecords(rec, { project: "p", name }, `n${i}`);
      name = `n${i}`;
    }
    expect(rec[0].aliases).toHaveLength(LANE_ALIAS_CAP);
    expect(rec[0].aliases?.[LANE_ALIAS_CAP - 1]).toBe(`n${LANE_ALIAS_CAP + 2}`);
  });
  it("a former name still FINDS the lane (a route from before the rename); the current name wins first", () => {
    const threads = [inLane("a", "Gamma"), inLane("b", "Gamma model")];
    const lanes = deriveLanes(threads, [{ project: "lodestar", name: "Gamma", aliases: ["Gamma model", "Old"] }]);
    expect(findLane(lanes, { project: "lodestar", name: "old" })?.name).toBe("Gamma");
    expect(findLane(lanes, { project: "lodestar", name: "Gamma model" })?.name).toBe("Gamma model");
    expect(namesLane(lanes[0], "OLD")).toBe(true);
  });
});

describe("the lanes themselves", () => {
  it("a lane is its threads — archived ones included — with its record; ordered by project then name", () => {
    const threads = [inLane("a", "Tennis"), inLane("b", "gamma"), inLane("c", "Gamma", { archivedAt: NOW, lastActivityAt: NOW }), thread("d"), thread("e", { lane: "Z", laneProject: "kyde" })];
    const lanes = deriveLanes(threads, [{ project: "lodestar", name: "Tennis", archivedAt: 3, aliases: ["T"] }]);
    expect(lanes.map((l) => `${l.project}/${l.name}:${l.threads.map((t) => t.id).join("")}:${l.archivedAt}:${l.aliases.join()}`)).toEqual([
      "kyde/Z:e:null:",
      "lodestar/Gamma:cb:null:",
      "lodestar/Tennis:a:3:T",
    ]);
    expect(findLane(lanes, { project: "lodestar", name: "GAMMA" })?.threads).toHaveLength(2);
    expect(findLane(lanes, { project: "lodestar", name: "Combos" })).toBeNull();
  });
  it("the roll-ups read every active thread and an archived one ONLY when it is in a lane that is not archived (principle 4; nothing read is discarded)", () => {
    const threads = [thread("a"), thread("b", { archivedAt: NOW }), inLane("c", "Gamma", { archivedAt: NOW }), inLane("d", "Gamma"), inLane("e", "Put away", { archivedAt: NOW }), inLane("f", "Put away")];
    const records = [{ project: "lodestar", name: "Put away", archivedAt: 1 }];
    expect(rollupThreads(threads, records).map((t) => t.id)).toEqual(["a", "c", "d", "f"]);
    expect(inVisibleLane(threads[3], records)).toBe(true);
    expect(inVisibleLane(threads[5], records)).toBe(false); // its lane is archived — it shows as a thread
    expect(inVisibleLane(threads[0], records)).toBe(false);
  });
  it("`lane…` works in the thread's FROZEN lane project, else its folder's (review #4)", () => {
    expect(laneEditProject(inLane("a", "Gamma"), "elsewhere")).toBe("lodestar");
    expect(laneEditProject(inLane("a", "Gamma"), null)).toBe("lodestar");
    expect(laneEditProject(thread("a"), "kyde")).toBe("kyde");
    expect(laneEditProject(thread("a"), null)).toBeNull();
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
  it("Home's dot is the liveliest status of the lane's live threads", () => {
    expect(liveliestStatus(["idle", "running", "waiting"])).toBe("waiting");
    expect(liveliestStatus(["done", "running"])).toBe("running");
    expect(liveliestStatus([undefined])).toBe("idle");
    expect(liveliestStatus([])).toBeNull();
  });
});

/** A lane over some threads, record-free unless given. */
function laneOf(threads: Thread[], over: Partial<Lane> = {}): Lane {
  return { project: "lodestar", name: "Gamma", threads, archivedAt: null, aliases: [], cachedBrief: null, ...over };
}
const stamped = (goal: string, updatedAt: string, lane: { name: string; project: string } | null): PageBrief => ({ ...brief(goal, updatedAt), lane });

describe("which brief is the lane's (review of ec319c7, #1; edge cases 1, 2, 3)", () => {
  const a = inLane("a", "Gamma", { title: "gamma · design review" });
  const b = inLane("b", "Gamma", { title: "gamma · deck export", archivedAt: NOW });
  const c = inLane("c", "Gamma", { title: "gamma · layer 0" });
  const G = { name: "Gamma", project: "lodestar" };

  it("the newest brief written FOR the lane wins, and it names its thread (edge case 1) — archived threads count", () => {
    const digests = new Map([
      ["a", page({ brief: stamped("older goal", "2026-09-20T10:00:00Z", G) })],
      ["b", page({ brief: stamped("newest goal", "2026-09-29T10:00:00Z", G) })],
      ["c", page({})],
    ]);
    const r = laneRollup(laneOf([a, b, c]), [a, b, c], digests, new Set(), NOW);
    expect(r.brief?.brief.goal).toBe("newest goal");
    expect(r.brief?.thread?.id).toBe("b");
    expect(r.brief?.fromCache).toBe(false);
  });

  it("a thread that JOINS with a brief written for its own corner never takes the lane over, however new (edge case 2)", () => {
    const joiner = inLane("j", "Gamma");
    const digests = new Map([
      ["a", page({ brief: stamped("the lane's brief", "2026-09-20T10:00:00Z", G) })],
      ["j", page({ brief: stamped("my own corner, NEWER", "2026-09-29T10:00:00Z", null) })],
    ]);
    expect(laneRollup(laneOf([a, joiner]), [a, joiner], digests, new Set(), NOW).brief?.brief.goal).toBe("the lane's brief");
    // One written for ANOTHER lane does not count either.
    const other = new Map([...digests, ["j", page({ brief: stamped("tennis", "2026-09-30T10:00:00Z", { name: "Tennis", project: "lodestar" }) })]]);
    expect(laneRollup(laneOf([a, joiner]), [a, joiner], other, new Set(), NOW).brief?.brief.goal).toBe("the lane's brief");
    // Rewriting it FOR the lane (after reading it) is what replaces it.
    const rewritten = new Map([...digests, ["j", page({ brief: stamped("rewritten for the lane", "2026-09-30T10:00:00Z", G) })]]);
    const r = laneRollup(laneOf([a, joiner]), [a, joiner], rewritten, new Set(), NOW);
    expect(r.brief?.brief.goal).toBe("rewritten for the lane");
    expect(r.brief?.thread?.id).toBe("j");
    // A brief from before the stamp still counts for its thread's current lane — nothing existing vanishes.
    const legacy = new Map([["a", page({ brief: brief("pre-stamp brief", "2026-09-20T10:00:00Z") })]]);
    expect(laneRollup(laneOf([a]), [a], legacy, new Set(), NOW).brief?.brief.goal).toBe("pre-stamp brief");
    expect(laneRollup(laneOf([c]), [c], new Map([["c", page({})]]), new Set(), NOW).brief).toBeNull();
  });

  it("a thread that MOVED AWAY keeps counting for the lane it wrote for (edge case 3), a former name too", () => {
    const moved = inLane("m", "Tennis");
    const digests = new Map([["m", page({ brief: stamped("written for gamma", "2026-09-28T10:00:00Z", { name: "Old gamma", project: "lodestar" }) })]]);
    const lane = laneOf([a], { aliases: ["Old gamma"] });
    const r = laneRollup(lane, [a, moved], digests, new Set(), NOW);
    expect(r.brief?.brief.goal).toBe("written for gamma");
    expect(r.brief?.thread?.id).toBe("m");
    expect(briefCountsFor(stamped("x", "", G), moved, lane)).toBe(true);
    expect(briefCountsFor(brief("x", ""), moved, lane)).toBe(false); // legacy: counts for its CURRENT lane (Tennis)
  });

  it("the CACHED brief keeps the lane's brief when its thread is gone — named, `from a deleted thread` when it is; a newer live one wins", () => {
    const cachedBrief = { brief: stamped("kept goal", "2026-09-25T10:00:00Z", G), threadId: "gone", threadTitle: "gamma · layer 0 (old)" };
    const lane = laneOf([a], { cachedBrief });
    const empty = laneRollup(lane, [a], new Map([["a", page({})]]), new Set(), NOW);
    expect(empty.brief).toMatchObject({ threadTitle: "gamma · layer 0 (old)", thread: null, fromCache: true });
    expect(empty.brief?.brief.goal).toBe("kept goal");
    const newer = laneRollup(lane, [a], new Map([["a", page({ brief: stamped("newer", "2026-09-29T10:00:00Z", G) })]]), new Set(), NOW);
    expect(newer.brief).toMatchObject({ fromCache: false, threadTitle: a.title });
    // A cache whose thread still exists names it by its CURRENT title.
    const held = pickLaneBrief(laneOf([a], { cachedBrief: { ...cachedBrief, threadId: "a" } }), [a], () => null);
    expect(held).toMatchObject({ thread: a, threadTitle: a.title, fromCache: true });
  });

  it("the cache update: a newer counting brief becomes the cache; an older or equal one leaves the SAME array", () => {
    const threads = [a, c];
    const lanes = deriveLanes(threads, []);
    const briefs: Record<string, PageBrief> = { a: stamped("first", "2026-09-20T10:00:00Z", G) as PageBrief };
    const once = nextLaneBriefCaches([], lanes, threads, (id) => briefs[id]);
    expect(once).toEqual([{ project: "lodestar", name: "Gamma", brief: { brief: briefs.a, threadId: "a", threadTitle: a.title } }]);
    expect(nextLaneBriefCaches(once, deriveLanes(threads, once), threads, (id) => briefs[id])).toBe(once);
    briefs.c = stamped("newer", "2026-09-29T10:00:00Z", G) as PageBrief;
    const twice = nextLaneBriefCaches(once, deriveLanes(threads, once), threads, (id) => briefs[id]);
    expect(twice[0].brief?.threadId).toBe("c");
    // The holder moves away and its brief is rewritten for its new lane: the cache keeps gamma's.
    briefs.c = stamped("tennis now", "2026-09-30T10:00:00Z", { name: "Tennis", project: "lodestar" }) as PageBrief;
    expect(nextLaneBriefCaches(twice, deriveLanes(threads, twice), threads, (id) => briefs[id])).toBe(twice);
  });
});

describe("the lane roll-up (requirement 2; edge case 4; review #8)", () => {
  const a = inLane("a", "Gamma", { title: "gamma · design review" });
  const b = inLane("b", "Gamma", { title: "gamma · deck export", archivedAt: NOW });
  const c = inLane("c", "Gamma", { title: "gamma · layer 0" });

  it("findings from every thread newest first; decisions open → unsent → answered; what waits", () => {
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
          items: [{ id: "i1", title: "a stale item on a put-away thread", owner: "user" }],
        }),
      ],
    ]);
    const r = laneRollup(laneOf([a, b, c]), [a, b, c], digests, new Set(), NOW);
    expect(r.findings.map((f) => `${f.thread.id}:${f.finding.claim}`)).toEqual(["b:newest claim", "a:old claim"]);
    expect(r.openQuestions.map((q) => `${q.thread.id}:${q.question.text}`)).toEqual(["b:State variable?", "a:Which book?"]);
    expect(r.unsent).toEqual([{ thread: a, count: 1 }]);
    expect(r.answered.map((x) => x.settled.question.id)).toEqual(["q3"]);
    // The archived thread's QUESTION counts (edge case 4); its ITEM does not (review #8).
    expect(r.waiting).toEqual({ questions: 2, unsent: 1, requests: 0, items: 1 });
    expect(isLaneWaiting(r.waiting)).toBe(true);
    expect(laneWaitsLabel(r.waiting)).toBe("2 questions · 1 unsent · 1 item for you");
    expect(laneHomeLine(r)).toBe("newest claim");
  });

  it("THE SAME waiting rule over the pass's counts (the side menu's `· N`) as over the digests (Home's pill)", () => {
    const w = laneWaitingFromCounts([a, b, c], {
      questions: { a: 1, b: 1 },
      unsent: { a: 1 },
      requests: { b: 3, c: 1 },
      items: { a: 1, b: 5 },
    });
    expect(w).toEqual({ questions: 2, unsent: 1, requests: 1, items: 1 });
    expect(waitingTotal(w)).toBe(5);
    expect(waitingTotal(laneWaitingFromCounts([c], { questions: {}, unsent: {}, requests: {}, items: {} }))).toBe(0);
  });

  it("answered decisions are capped; Home's line falls back to the brief's goal, then nothing", () => {
    const qs = Array.from({ length: LANE_ANSWERED_LIMIT + 3 }, (_, i) => ({
      id: `q${i}`,
      text: `q${i}`,
      askedAt: "2026-09-01T00:00:00Z",
      answer: "a",
      answeredAt: `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
    }));
    const r = laneRollup(laneOf([a]), [a], new Map([["a", page({ questions: qs, brief: brief("the goal", "2026-09-29T00:00:00Z") })]]), new Set(), NOW);
    expect(r.answered).toHaveLength(LANE_ANSWERED_LIMIT);
    expect(r.answered[0].settled.question.id).toBe(`q${LANE_ANSWERED_LIMIT + 2}`);
    expect(laneHomeLine(r)).toBe("the goal");
    expect(laneHomeLine({ findings: [], brief: null })).toBeNull();
    expect(laneWaitsLabel({ questions: 1, unsent: 0, requests: 1, items: 2 })).toBe("1 question · 1 request · 2 items for you");
    expect(laneWaitsLabel({ questions: 0, unsent: 0, requests: 0, items: 0 })).toBeNull();
  });

  it("last activity: live = now; else the newest of record stamps, turns, asks, the brief and findings; unread threads count their record", () => {
    const digests = new Map([["a", page({ brief: brief("g", "2026-09-29T00:00:00Z") })]]);
    expect(laneRollup(laneOf([a]), [a], digests, new Set(), NOW).lastActive).toBe(Date.parse("2026-09-29T00:00:00Z"));
    expect(laneRollup(laneOf([a]), [a], digests, new Set(["a"]), NOW).lastActive).toBe(NOW);
    expect(laneRollup(laneOf([c]), [c], new Map(), new Set(), NOW).lastActive).toBe(c.lastActivityAt);
  });

  it("Home's order: waiting on Eric first, then last activity; a lane whose only live thread was archived stays up while it has open decisions (edge case 4)", () => {
    const row = (name: string, waiting: number, lastActive: number): LaneRow => ({
      lane: laneOf([], { name }),
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
});

describe("the lane's reports (requirement 2.5; edge cases 3 and 6; review #5)", () => {
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
  const lane = laneOf([inLane("a", "Gamma"), inLane("b", "Gamma", { archivedAt: NOW })]);
  it("the reports the lane's threads built — by the index row's thread — archived threads' included", () => {
    const views = [view("v1", "a"), view("v2", "b"), view("v3", "other"), view("v4", "")];
    const known = new Set(["a", "b", "other"]);
    expect(laneReports(views, lane, known).map((v) => v.id)).toEqual(["v1", "v2"]);
  });
  it("a report whose thread was DELETED stays on the lane it was built in — under a FORMER name too; a live thread's report follows its CURRENT lane", () => {
    const known = new Set(["a", "b", "moved"]);
    const views = [view("gone", "deleted-thread", "gamma"), view("renamed", "deleted-3", "Old gamma"), view("elsewhere", "deleted-2", "Tennis"), view("moved", "moved", "Gamma")];
    expect(laneReports(views, lane, known).map((v) => v.id)).toEqual(["gone"]);
    expect(laneReports(views, { ...lane, aliases: ["Old gamma"] }, known).map((v) => v.id)).toEqual(["gone", "renamed"]);
  });
});

describe("Home's and the lane page's reads are stamp-gated (review #7)", () => {
  it("a cached digest is reused only under the SAME real stamp; a failed stat (-1) or none always reads", () => {
    expect(digestCacheHit({ stamp: 17 }, 17)).toBe(true);
    expect(digestCacheHit({ stamp: 17 }, 18)).toBe(false);
    expect(digestCacheHit({ stamp: -1 }, -1)).toBe(false);
    expect(digestCacheHit(undefined, 17)).toBe(false);
  });
});
