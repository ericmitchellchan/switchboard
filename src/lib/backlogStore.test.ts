// The backlog (SWIT-64): pure ops, the tolerant parse, caps, the filter, the
// inbox drain (idempotent on re-apply) and the singleton's write discipline
// (never before load; debounced; a failed write keeps the edit and retries).

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  parseBacklog,
  serializeBacklog,
  parseBacklogInbox,
  addItem,
  setStage,
  addLink,
  graduate,
  setProject,
  removeItem,
  applyInbox,
  visibleItems,
  openItems,
  doneItems,
  projectsPresent,
  cycleProjectTag,
  itemForThread,
  threadLinkOf,
  backlogThreadTitle,
  normalizeBacklogText,
  stageGlyph,
  linkGlyphs,
  BACKLOG_ITEM_CAP,
  BACKLOG_TEXT_CAP,
  BACKLOG_LINK_CAP,
  BACKLOG_TITLE_MAX,
  BACKLOG_WRITE_DEBOUNCE_MS,
  configureBacklogIO,
  initBacklog,
  backlogAdd,
  backlogGraduate,
  backlogAddLink,
  backlogRemove,
  backlogSetStage,
  drainBacklogInbox,
  flushBacklogWrites,
  getBacklogItems,
  backlogItemForThread,
  toggleBacklogPanel,
  isBacklogPanelOpen,
  __resetBacklogForTests,
  type BacklogItem,
} from "./backlogStore";

const NOW = Date.parse("2026-09-01T10:00:00Z");

function seed(): BacklogItem[] {
  let items: BacklogItem[] = [];
  items = addItem(items, "look at duckdb for the tennis table", "lodestar", NOW - 3000, "i1").items;
  items = addItem(items, "a thought about pricing", null, NOW - 2000, "i2").items;
  items = addItem(items, "spec the backlog", "switchboard", NOW - 1000, "i3").items;
  return items;
}

describe("item ops", () => {
  it("addItem prepends (newest first), trims, caps text by code point, refuses empty", () => {
    const items = seed();
    expect(items.map((i) => i.id)).toEqual(["i3", "i2", "i1"]);
    expect(items[0]).toMatchObject({ text: "spec the backlog", project: "switchboard", stage: "backlog", links: [] });
    const empty = addItem(items, "   \n ", null, NOW);
    expect(empty.item).toBeNull();
    expect(empty.items).toBe(items);
    const long = addItem(items, "é".repeat(BACKLOG_TEXT_CAP + 20), null, NOW, "long").item!;
    expect(Array.from(long.text)).toHaveLength(BACKLOG_TEXT_CAP);
    const ctl = addItem(items, "two\nlines\tand  spaces", null, NOW, "ctl").item!;
    expect(ctl.text).toBe("two lines and spaces");
    expect(addItem(items, "dup", null, NOW, "i1").item).toBeNull();
    expect(addItem(items, "bad id", null, NOW, "../x").item).toBeNull();
  });

  it("the item cap refuses the 501st", () => {
    let items: BacklogItem[] = [];
    for (let i = 0; i < BACKLOG_ITEM_CAP; i++) items = addItem(items, `t${i}`, null, NOW + i, `id${i}`).items;
    expect(items).toHaveLength(BACKLOG_ITEM_CAP);
    expect(addItem(items, "one more", null, NOW).item).toBeNull();
  });

  it("setStage / setProject / removeItem return the SAME array when nothing changes", () => {
    const items = seed();
    expect(setStage(items, "i1", "backlog", NOW)).toBe(items);
    expect(setStage(items, "nope", "done", NOW)).toBe(items);
    const done = setStage(items, "i1", "done", NOW);
    expect(done).not.toBe(items);
    expect(done.find((i) => i.id === "i1")).toMatchObject({ stage: "done", updatedAt: NOW });
    expect(setProject(items, "i2", null, NOW)).toBe(items);
    expect(setProject(items, "i2", "orbit", NOW).find((i) => i.id === "i2")!.project).toBe("orbit");
    expect(setProject(items, "i2", "   ", NOW)).toBe(items);
    expect(removeItem(items, "zzz")).toBe(items);
    expect(removeItem(items, "i2").map((i) => i.id)).toEqual(["i3", "i1"]);
  });

  it("addLink is a SET (dup kind+ref ignored) and caps at 8; refs are trimmed and capped", () => {
    const items = seed();
    const once = addLink(items, "i1", { kind: "ticket", ref: " SWIT-64 " }, NOW);
    expect(once.find((i) => i.id === "i1")!.links).toEqual([{ kind: "ticket", ref: "SWIT-64" }]);
    expect(addLink(once, "i1", { kind: "ticket", ref: "SWIT-64" }, NOW)).toBe(once);
    expect(addLink(once, "i1", { kind: "ticket", ref: "" }, NOW)).toBe(once);
    let many = once;
    for (let i = 0; i < 10; i++) many = addLink(many, "i1", { kind: "spec", ref: `s${i}` }, NOW);
    expect(many.find((i) => i.id === "i1")!.links).toHaveLength(BACKLOG_LINK_CAP);
    const longRef = addLink(items, "i1", { kind: "spec", ref: "x".repeat(900) }, NOW);
    expect(longRef.find((i) => i.id === "i1")!.links[0].ref).toHaveLength(500);
  });

  it("graduate links AND moves a plain item to that stage; a graduated or done item keeps its stage", () => {
    const items = seed();
    const t = graduate(items, "i1", "ticket", "SWIT-64", NOW);
    expect(t.find((i) => i.id === "i1")).toMatchObject({ stage: "ticket", links: [{ kind: "ticket", ref: "SWIT-64" }] });
    const s = graduate(t, "i1", "spec", "switchboard/features/x/requirements.md", NOW);
    const i1 = s.find((i) => i.id === "i1")!;
    expect(i1.stage).toBe("ticket");
    expect(i1.links).toHaveLength(2);
    const done = setStage(items, "i2", "done", NOW);
    const g = graduate(done, "i2", "ticket", "SWIT-1", NOW);
    expect(g.find((i) => i.id === "i2")!.stage).toBe("done");
    expect(g.find((i) => i.id === "i2")!.links).toEqual([{ kind: "ticket", ref: "SWIT-1" }]);
    expect(graduate(items, "missing", "ticket", "SWIT-1", NOW)).toBe(items);
  });
});

describe("parse + serialize", () => {
  it("round-trips, and a broken item drops ALONE", () => {
    const items = seed();
    const linked = addLink(items, "i1", { kind: "thread", ref: "3f1c2a9e-0b7d-4c1e-9a55-1234567890ab" }, NOW);
    const back = parseBacklog(serializeBacklog(linked));
    expect(back).toEqual(linked);
    const raw = JSON.stringify({
      version: 1,
      items: [
        { id: "ok", text: "fine", project: "p", stage: "spec", links: [], createdAt: 5, updatedAt: 6 },
        { id: "no text", stage: "backlog", links: [] },
        { id: "bad-stage", text: "x", stage: "later", links: [{ kind: "pr", ref: "1" }, { kind: "ticket", ref: "T-1" }], createdAt: "1" },
        null,
        "string",
        { id: "ok", text: "dup id", stage: "backlog", links: [] },
        { id: "../x", text: "bad id", stage: "backlog", links: [] },
      ],
    });
    const parsed = parseBacklog(raw);
    expect(parsed.map((i) => i.id)).toEqual(["ok", "bad-stage"]);
    expect(parsed[1]).toMatchObject({ stage: "backlog", links: [{ kind: "ticket", ref: "T-1" }], createdAt: 0, updatedAt: 0, project: null });
  });

  it("empty / junk / wrong shape → the empty backlog", () => {
    expect(parseBacklog("")).toEqual([]);
    expect(parseBacklog("not json")).toEqual([]);
    expect(parseBacklog("42")).toEqual([]);
    expect(parseBacklog(JSON.stringify({ version: 1 }))).toEqual([]);
  });

  it("the inbox parse keeps only well-formed link entries", () => {
    const raw = JSON.stringify({
      version: 1,
      entries: [
        { id: "e1", itemId: "i1", kind: "ticket", ref: "SWIT-64", threadId: "t1", at: "2026-09-01T10:00:00Z" },
        { id: "e2", itemId: "i1", kind: "thread", ref: "x" },
        { id: "e3", itemId: "bad id!", kind: "spec", ref: "x" },
        { id: "e4", itemId: "i2", kind: "spec", ref: "   " },
        { itemId: "i2", kind: "spec", ref: "switchboard/x.md" },
        7,
      ],
    });
    const entries = parseBacklogInbox(raw);
    expect(entries.map((e) => e.itemId + ":" + e.kind)).toEqual(["i1:ticket", "i2:spec"]);
    expect(parseBacklogInbox("")).toEqual([]);
    expect(parseBacklogInbox("{")).toEqual([]);
  });

  it("the inbox is APPEND-ONLY NDJSON: one entry per line, parsed line-wise, a bad line drops ALONE", () => {
    const e1 = { id: "e1", itemId: "i1", kind: "ticket", ref: "SWIT-64", threadId: "t1", at: "2026-09-01T10:00:00Z" };
    const e2 = { id: "e2", itemId: "i2", kind: "spec", ref: "switchboard/x.md", threadId: "t2", at: "2026-09-01T10:00:01Z" };
    const e3 = { id: "e3", itemId: "i3", kind: "ticket", ref: "SWIT-65", threadId: "t3", at: "2026-09-01T10:00:02Z" };
    // Two servers appended in turn; CRLF tolerated; blank lines ignored.
    const ndjson = `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\r\n\n${JSON.stringify(e3)}\n`;
    expect(parseBacklogInbox(ndjson).map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    // One line only (the common case: one link since the last drain) — the
    // whole file parses as a single record, and it is still one entry.
    expect(parseBacklogInbox(`${JSON.stringify(e1)}\n`).map((e) => e.id)).toEqual(["e1"]);
    // A TORN last line — an append the take cut in half — costs that entry, never the file.
    const torn = `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n${JSON.stringify(e3).slice(0, 30)}`;
    expect(parseBacklogInbox(torn).map((e) => e.id)).toEqual(["e1", "e2"]);
    // Junk in the middle drops alone too.
    expect(parseBacklogInbox(`${JSON.stringify(e1)}\nnot json\n7\n${JSON.stringify(e3)}\n`).map((e) => e.id)).toEqual(["e1", "e3"]);
  });

  it("the previous inbox shape — one JSON document, an array or {version, entries} — is still read (one version of tolerance)", () => {
    const e1 = { id: "e1", itemId: "i1", kind: "ticket", ref: "SWIT-64", threadId: "t1", at: "2026-09-01T10:00:00Z" };
    const e2 = { id: "e2", itemId: "i2", kind: "spec", ref: "switchboard/x.md", threadId: "t2", at: "2026-09-01T10:00:01Z" };
    expect(parseBacklogInbox(JSON.stringify({ version: 1, entries: [e1, e2] }, null, 2)).map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(parseBacklogInbox(JSON.stringify([e1, e2])).map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});

describe("the inbox drain merge", () => {
  it("applies every entry as a graduate and is IDEMPOTENT on re-apply", () => {
    const items = seed();
    const entries = parseBacklogInbox(
      JSON.stringify({
        entries: [
          { id: "e1", itemId: "i1", kind: "ticket", ref: "SWIT-64" },
          { id: "e2", itemId: "i3", kind: "spec", ref: "switchboard/features/backlog/requirements.md" },
          { id: "e3", itemId: "gone", kind: "ticket", ref: "SWIT-1" },
        ],
      })
    );
    const first = applyInbox(items, entries, NOW);
    expect(first.applied).toBe(2);
    expect(first.items.find((i) => i.id === "i1")).toMatchObject({ stage: "ticket" });
    expect(first.items.find((i) => i.id === "i3")).toMatchObject({ stage: "spec" });
    expect(first.items).toHaveLength(3); // `gone` did not resurrect
    const again = applyInbox(first.items, entries, NOW + 1);
    expect(again.applied).toBe(0);
    expect(again.items).toBe(first.items);
  });
});

describe("selectors", () => {
  it("visibleItems: open only, newest first, under the filter; done folds separately", () => {
    let items = seed();
    items = setStage(items, "i2", "done", NOW);
    expect(visibleItems(items, "all").map((i) => i.id)).toEqual(["i3", "i1"]);
    expect(visibleItems(items, "none")).toEqual([]);
    expect(visibleItems(items, { project: "lodestar" }).map((i) => i.id)).toEqual(["i1"]);
    expect(openItems(items)).toHaveLength(2);
    expect(doneItems(items).map((i) => i.id)).toEqual(["i2"]);
    expect(projectsPresent(items)).toEqual(["lodestar", "switchboard"]);
  });

  it("the tag chip cycles none → projects → none, and recovers from an unknown current", () => {
    const ps = ["lodestar", "switchboard"];
    expect(cycleProjectTag(null, ps)).toBe("lodestar");
    expect(cycleProjectTag("lodestar", ps)).toBe("switchboard");
    expect(cycleProjectTag("switchboard", ps)).toBeNull();
    expect(cycleProjectTag("gone", ps)).toBe("lodestar");
    expect(cycleProjectTag(null, [])).toBeNull();
  });

  it("thread links: itemForThread / threadLinkOf", () => {
    const items = addLink(seed(), "i1", { kind: "thread", ref: "t-1" }, NOW);
    expect(itemForThread(items, "t-1")?.id).toBe("i1");
    expect(itemForThread(items, "t-2")).toBeNull();
    expect(itemForThread(items, "")).toBeNull();
    expect(threadLinkOf(items.find((i) => i.id === "i1")!)).toBe("t-1");
    expect(threadLinkOf(items.find((i) => i.id === "i2")!)).toBeNull();
  });

  it("threadLinkOf keys on the LATEST thread link, preferring the latest one the store still knows", () => {
    // Opened into a thread twice: the first conversation is archived/gone,
    // the second is live. Keying on the first forever pointed "open in
    // thread" at the dead one (review finding F5).
    let items = addLink(seed(), "i1", { kind: "thread", ref: "t-old" }, NOW);
    items = addLink(items, "i1", { kind: "thread", ref: "t-new" }, NOW + 1);
    const item = items.find((i) => i.id === "i1")!;
    expect(item.links.filter((l) => l.kind === "thread").map((l) => l.ref)).toEqual(["t-old", "t-new"]);
    expect(threadLinkOf(item)).toBe("t-new");
    // With a `known` predicate: the latest KNOWN one wins over a later unknown.
    expect(threadLinkOf(item, (id) => id === "t-old")).toBe("t-old");
    expect(threadLinkOf(item, (id) => id === "t-new")).toBe("t-new");
    // None known: the latest at all, so the caller can say "gone" about the right one.
    expect(threadLinkOf(item, () => false)).toBe("t-new");
    expect(threadLinkOf(items.find((i) => i.id === "i2")!, () => true)).toBeNull();
  });

  it("the thread title is the first ~40 chars, cut at a word, with an ellipsis", () => {
    expect(backlogThreadTitle("short one")).toBe("short one");
    const t = backlogThreadTitle("look at duckdb for the tennis table and the flow anomaly moments");
    expect(Array.from(t).length).toBeLessThanOrEqual(BACKLOG_TITLE_MAX + 1);
    expect(t.endsWith("…")).toBe(true);
    expect(t).toBe("look at duckdb for the tennis table and…");
    expect(backlogThreadTitle("x".repeat(60))).toBe("x".repeat(40) + "…");
    expect(normalizeBacklogText(null)).toBeNull();
  });

  it("glyphs: one per stage; links de-duplicated by kind in link order", () => {
    expect(["○", "◔", "◑", "✓"]).toEqual(["backlog", "ticket", "spec", "done"].map((s) => stageGlyph(s as never)));
    let items = addLink(seed(), "i1", { kind: "thread", ref: "t-1" }, NOW);
    items = addLink(items, "i1", { kind: "ticket", ref: "SWIT-1" }, NOW);
    items = addLink(items, "i1", { kind: "ticket", ref: "SWIT-2" }, NOW);
    expect(linkGlyphs(items.find((i) => i.id === "i1")!).map((g) => g.glyph)).toEqual(["→", "#"]);
  });
});

describe("the singleton (injected IO)", () => {
  beforeEach(() => {
    __resetBacklogForTests();
    vi.useFakeTimers();
  });

  function fakeIO(disk: string, inbox: string[] = []) {
    const writes: string[] = [];
    const io = {
      read: vi.fn(async () => disk),
      write: vi.fn(async (text: string) => {
        writes.push(text);
      }),
      takeInbox: vi.fn(async () => inbox.shift() ?? ""),
    };
    return { io, writes };
  }

  it("never writes before load; after load, edits debounce into ONE write", async () => {
    const { io, writes } = fakeIO("");
    configureBacklogIO(io);
    expect(backlogAdd("pre-load thought", null)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(BACKLOG_WRITE_DEBOUNCE_MS * 2);
    expect(writes).toHaveLength(0);
    await initBacklog();
    // The pre-load item survived the load and was written back.
    await vi.advanceTimersByTimeAsync(BACKLOG_WRITE_DEBOUNCE_MS + 1);
    expect(writes).toHaveLength(1);
    backlogAdd("one", "lodestar");
    backlogAdd("two", null);
    backlogSetStage(getBacklogItems()[0].id, "done");
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BACKLOG_WRITE_DEBOUNCE_MS + 1);
    expect(writes).toHaveLength(2);
    const back = parseBacklog(writes[1]);
    expect(back.map((i) => i.text)).toEqual(["two", "one", "pre-load thought"]);
    expect(back[0].stage).toBe("done");
  });

  it("disk wins on load; a failed read leaves the store UNLOADED (no write can clobber)", async () => {
    const seeded = serializeBacklog(seed());
    const { io, writes } = fakeIO(seeded);
    configureBacklogIO(io);
    await initBacklog();
    expect(getBacklogItems().map((i) => i.id)).toEqual(["i3", "i2", "i1"]);
    await vi.advanceTimersByTimeAsync(BACKLOG_WRITE_DEBOUNCE_MS + 1);
    expect(writes).toHaveLength(0);

    __resetBacklogForTests();
    const failing = {
      read: vi.fn(async () => {
        throw new Error("disk");
      }),
      write: vi.fn(async () => {}),
      takeInbox: vi.fn(async () => ""),
    };
    configureBacklogIO(failing);
    await initBacklog();
    backlogAdd("x", null);
    await vi.advanceTimersByTimeAsync(BACKLOG_WRITE_DEBOUNCE_MS + 1);
    expect(failing.write).not.toHaveBeenCalled();
  });

  it("a failed write keeps the edit and retries on the next flush", async () => {
    let fail = true;
    const writes: string[] = [];
    configureBacklogIO({
      read: async () => "",
      write: async (t) => {
        if (fail) throw new Error("locked");
        writes.push(t);
      },
      takeInbox: async () => "",
    });
    await initBacklog();
    backlogAdd("keep me", null);
    await vi.advanceTimersByTimeAsync(BACKLOG_WRITE_DEBOUNCE_MS + 1);
    expect(writes).toHaveLength(0);
    expect(getBacklogItems()[0].text).toBe("keep me");
    fail = false;
    await flushBacklogWrites();
    expect(writes).toHaveLength(1);
  });

  it("drainBacklogInbox folds the server's entries in (and is a no-op before load / on an empty take)", async () => {
    const entry = { id: "e1", itemId: "i1", kind: "ticket", ref: "SWIT-64", threadId: "t", at: "x" };
    const { io, writes } = fakeIO(serializeBacklog(seed()), [JSON.stringify({ version: 1, entries: [entry] }), JSON.stringify({ version: 1, entries: [entry] })]);
    configureBacklogIO(io);
    expect(await drainBacklogInbox()).toBe(0);
    expect(io.takeInbox).not.toHaveBeenCalled();
    await initBacklog();
    expect(await drainBacklogInbox()).toBe(1);
    expect(getBacklogItems().find((i) => i.id === "i1")).toMatchObject({ stage: "ticket" });
    // The same entries re-emitted (a racing server rename) change nothing.
    expect(await drainBacklogInbox()).toBe(0);
    expect(await drainBacklogInbox()).toBe(0);
    await vi.advanceTimersByTimeAsync(BACKLOG_WRITE_DEBOUNCE_MS + 1);
    expect(writes).toHaveLength(1);
  });

  it("graduate / link / remove through the singleton; thread lookup; panel toggle", async () => {
    configureBacklogIO(fakeIO(serializeBacklog(seed())).io);
    await initBacklog();
    backlogAddLink("i1", { kind: "thread", ref: "t-9" });
    expect(backlogItemForThread("t-9")?.id).toBe("i1");
    backlogGraduate("i1", "spec", "switchboard/x.md");
    expect(getBacklogItems().find((i) => i.id === "i1")).toMatchObject({ stage: "spec" });
    backlogRemove("i1");
    expect(backlogItemForThread("t-9")).toBeNull();
    expect(isBacklogPanelOpen()).toBe(false);
    toggleBacklogPanel();
    expect(isBacklogPanelOpen()).toBe(true);
  });
});
