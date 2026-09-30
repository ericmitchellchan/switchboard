// Lanes on the thread record (SWIT-108): the lean-record gate, the store's
// mutators (who set it, taking a thread out, rename, archive) and the disk
// mirror's `lanes` — plus the page's `lane` parse.

import { describe, it, expect, beforeEach } from "vitest";
import type { Thread } from "../types";
import {
  sanitizeThread,
  serializeThreadsForDisk,
  parseThreadsFromDisk,
  parseLanesFromDisk,
  migrateSavedWorkspace,
  initThreadStore,
  getThreads,
  getThreadById,
  getThreadsView,
  getLaneRecords,
  setThreadLane,
  renameLaneInStore,
  setLaneArchived,
  replaceLaneRecords,
  deleteThread,
  __resetThreadStoreForTests,
} from "./threadStore";
import { deriveLanes, laneFromPage } from "./lanes";
import { parsePageFile } from "./pageStore";

const base: Thread = {
  id: "t1",
  title: "gamma · design review",
  workingDir: "C:/projects/lodestar",
  chatSessionId: "c1",
  chatStarted: true,
  sessionId: null,
  createdAt: 1,
  lastActivityAt: 2,
};
const GAMMA = { project: "lodestar", name: "Gamma model" };

describe("the lane on the lean record (sanitizeThread)", () => {
  it("rides like archivedAt: present only while in a lane, name normalized, paired with its project", () => {
    expect(sanitizeThread({ ...base, lane: " Gamma  model ", laneProject: "lodestar", laneSetBy: "agent" })).toEqual({
      ...base,
      lane: "Gamma model",
      laneProject: "lodestar",
      laneSetBy: "agent",
    });
    // A laneless record is byte-for-byte what it was.
    expect(JSON.stringify(sanitizeThread(base))).toBe(JSON.stringify(base));
    // No project, or a name that is not a lane name, is no lane.
    expect(sanitizeThread({ ...base, lane: "Gamma" })).toEqual(base);
    expect(sanitizeThread({ ...base, lane: 'bad"name', laneProject: "lodestar" })).toEqual(base);
    // An unreadable setter is the USER's (the agent never overrides it).
    expect(sanitizeThread({ ...base, lane: "Gamma", laneProject: "lodestar", laneSetBy: "robot" })?.laneSetBy).toBe("user");
    // "The user took it out" survives alone; an agent marker without a lane does not.
    expect(sanitizeThread({ ...base, laneSetBy: "user" })).toEqual({ ...base, laneSetBy: "user" });
    expect(sanitizeThread({ ...base, laneSetBy: "agent" })).toEqual(base);
  });

  it("the disk mirror carries the archived lanes — only while there is one — and parses them back", () => {
    const t = { ...base, lane: "Gamma model", laneProject: "lodestar", laneSetBy: "user" as const };
    const plain = serializeThreadsForDisk([t]);
    expect(JSON.parse(plain).lanes).toBeUndefined();
    expect(parseLanesFromDisk(plain)).toEqual([]);
    const withLanes = serializeThreadsForDisk([t], [{ ...GAMMA, archivedAt: 5 }]);
    expect(parseThreadsFromDisk(withLanes)).toEqual([t]);
    expect(parseLanesFromDisk(withLanes)).toEqual([{ ...GAMMA, archivedAt: 5 }]);
    expect(parseLanesFromDisk("")).toBeNull();
    expect(parseLanesFromDisk("junk")).toBeNull();
    // The workspace blob's optional `lanes` is sanitized at every version.
    expect(migrateSavedWorkspace({ version: 7, sessions: [], threads: [t], lanes: [{ ...GAMMA, archivedAt: 5 }, "junk"] })?.lanes).toEqual([
      { ...GAMMA, archivedAt: 5 },
    ]);
    expect(migrateSavedWorkspace({ version: 2, sessions: [] })?.lanes).toEqual([]);
  });

  it("a brief's LANE STAMP parses: a lane, explicit null (written in no lane), or absent (pre-stamp, junk)", () => {
    const b = (lane: unknown) => parsePageFile(JSON.stringify({ brief: { goal: "g", updatedAt: "x", lane } })).brief;
    expect(b({ name: " Gamma  model ", project: "lodestar" })?.lane).toEqual({ name: "Gamma model", project: "lodestar" });
    expect(b(null)?.lane).toBeNull();
    expect(b(undefined)?.lane).toBeUndefined();
    expect(b({ name: 'bad"', project: "lodestar" })?.lane).toBeUndefined();
    expect(b({ name: "x" })?.lane).toBeUndefined();
    expect(b("junk")?.lane).toBeUndefined();
  });

  it("the page's `lane` (the agent's op) parses to a lane name or nothing", () => {
    expect(parsePageFile(JSON.stringify({ lane: " Gamma  model " })).lane).toBe("Gamma model");
    expect(parsePageFile(JSON.stringify({ lane: 'bad"' })).lane).toBeNull();
    expect(parsePageFile(JSON.stringify({ theme: "t" })).lane).toBeNull();
    expect(parsePageFile("").lane).toBeNull();
  });
});

describe("the lane mutators", () => {
  beforeEach(() => {
    __resetThreadStoreForTests();
    initThreadStore([
      base,
      { ...base, id: "t2", chatSessionId: "c2", archivedAt: 9 },
      { ...base, id: "t3", chatSessionId: "c3" },
    ]);
  });

  it("Eric puts threads in a lane — archived ones too (acceptance 1) — and the lane appears with them", () => {
    setThreadLane("t1", GAMMA, "user");
    setThreadLane("t2", GAMMA, "user");
    const lanes = deriveLanes(getThreads(), getLaneRecords());
    expect(lanes).toHaveLength(1);
    expect(lanes[0].threads.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(getThreadById("t2")).toMatchObject({ lane: "Gamma model", laneProject: "lodestar", laneSetBy: "user", archivedAt: 9 });
  });

  it("the agent's lane never overrides Eric's, and taking a thread OUT is remembered against the agent (acceptance 7)", () => {
    setThreadLane("t1", { project: "lodestar", name: "Tennis" }, "user");
    expect(laneFromPage(getThreadById("t1")!, "Gamma model", "lodestar", getThreads())).toBeNull();
    setThreadLane("t1", null, "user");
    expect(getThreadById("t1")).toMatchObject({ laneSetBy: "user" });
    expect(getThreadById("t1")?.lane).toBeUndefined();
    expect(laneFromPage(getThreadById("t1")!, "Gamma model", "lodestar", getThreads())).toBeNull();
    // A thread nobody placed takes the agent's lane.
    const next = laneFromPage(getThreadById("t3")!, "Gamma model", "lodestar", getThreads());
    expect(next).toEqual(GAMMA);
    setThreadLane("t3", next, "agent");
    expect(getThreadById("t3")).toMatchObject({ lane: "Gamma model", laneSetBy: "agent" });
    // …and then Eric's move wins over it.
    setThreadLane("t3", { project: "lodestar", name: "Combos" }, "user");
    expect(getThreadById("t3")).toMatchObject({ lane: "Combos", laneSetBy: "user" });
  });

  it("rename moves every thread and the archive record; archive/restore is lane state, not thread state (acceptance 6)", () => {
    setThreadLane("t1", GAMMA, "user");
    setThreadLane("t2", GAMMA, "user");
    setLaneArchived(GAMMA, true, 42);
    expect(getThreadsView().laneRecords).toEqual([{ ...GAMMA, archivedAt: 42 }]);
    expect(deriveLanes(getThreads(), getLaneRecords())[0].archivedAt).toBe(42);
    renameLaneInStore(GAMMA, "Gamma");
    expect(getThreads().filter((t) => t.lane === "Gamma").map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    // The record moves with it and remembers the former name (review #5).
    expect(getLaneRecords()).toEqual([{ project: "lodestar", name: "Gamma", archivedAt: 42, aliases: ["Gamma model"] }]);
    setLaneArchived({ project: "lodestar", name: "gamma" }, false);
    expect(getLaneRecords()).toEqual([{ project: "lodestar", name: "Gamma", aliases: ["Gamma model"] }]);
    // Threads never carried the archive.
    expect(getThreadById("t1")?.archivedAt).toBeUndefined();
  });

  it("only a USER join restores an archived lane — an agent join leaves it archived (review #2); the last thread leaving takes the record", () => {
    setThreadLane("t1", GAMMA, "user");
    setLaneArchived(GAMMA, true, 42);
    setThreadLane("t3", GAMMA, "agent");
    expect(getThreadById("t3")).toMatchObject({ lane: "Gamma model", laneSetBy: "agent" });
    expect(getLaneRecords()).toEqual([{ ...GAMMA, archivedAt: 42 }]);
    setThreadLane("t2", GAMMA, "user");
    expect(getLaneRecords()).toEqual([]);
    setLaneArchived(GAMMA, true, 43);
    setThreadLane("t2", null, "user");
    setThreadLane("t1", null, "user");
    expect(getLaneRecords()).toHaveLength(1); // t3 is still in it
    deleteThread("t3");
    expect(getLaneRecords()).toEqual([]);
  });

  it("the brief cache lands through replaceLaneRecords (sanitized), and is dropped with its lane", () => {
    setThreadLane("t1", GAMMA, "user");
    const cached = { brief: { goal: "g", established: [], dead: [], lead: [], waiting: [], updatedAt: "2026-09-29T00:00:00Z" }, threadId: "t1", threadTitle: "t" };
    replaceLaneRecords([{ ...GAMMA, brief: cached }, { project: "lodestar", name: "Nobody", archivedAt: 1 }]);
    expect(getLaneRecords()).toEqual([{ ...GAMMA, brief: cached }]);
    expect(deriveLanes(getThreads(), getLaneRecords())[0].cachedBrief).toEqual(cached);
    // It persists in the disk mirror and comes back.
    expect(parseLanesFromDisk(serializeThreadsForDisk(getThreads(), getLaneRecords()))).toEqual([{ ...GAMMA, brief: cached }]);
    setThreadLane("t1", null, "user");
    expect(getLaneRecords()).toEqual([]);
  });

  it("boot drops an archive record whose lane no thread carries", () => {
    __resetThreadStoreForTests();
    initThreadStore([{ ...base, lane: "Gamma model", laneProject: "lodestar", laneSetBy: "user" }], [
      { ...GAMMA, archivedAt: 1 },
      { project: "lodestar", name: "Gone", archivedAt: 1 },
    ]);
    expect(getLaneRecords()).toEqual([{ ...GAMMA, archivedAt: 1 }]);
  });
});
