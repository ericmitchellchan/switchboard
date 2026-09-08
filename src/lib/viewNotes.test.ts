// View notes (SWIT-75): the deck's notes file — tolerant parse, the unsent
// rule, the batch's wording, and the store's one-writer / never-before-load
// discipline with injected IO.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  parseViewNotes,
  serializeViewNotes,
  setNote,
  noteFor,
  isUnsent,
  unsentNotes,
  markSent,
  formatBatch,
  viewNotesPath,
  emptyViewNotes,
  VIEW_NOTE_CAP,
  VIEW_NOTES_WRITE_DEBOUNCE_MS,
  configureViewNotesIO,
  loadViewNotes,
  getViewNotes,
  editViewNote,
  flushViewNotes,
  markViewNotesSent,
  __resetViewNotesForTests,
} from "./viewNotes";

const T0 = "2026-09-08T10:00:00.000Z";
const T1 = "2026-09-08T10:01:00.000Z";
const T2 = "2026-09-08T10:02:00.000Z";

describe("parseViewNotes — tolerant", () => {
  it("empty / junk / wrong shape is an empty file; bad entries drop alone", () => {
    expect(parseViewNotes("")).toEqual(emptyViewNotes());
    expect(parseViewNotes("not json")).toEqual(emptyViewNotes());
    expect(parseViewNotes("[]")).toEqual(emptyViewNotes());
    expect(parseViewNotes(JSON.stringify({ version: 1, notes: [] }))).toEqual(emptyViewNotes());
    const parsed = parseViewNotes(
      JSON.stringify({
        version: 1,
        notes: {
          "2026-02-19": { text: "chase, no edge", updatedAt: T0, sentAt: T1 },
          "2026-02-20": { text: 5 },
          "2026-02-23": { text: "x", updatedAt: 3, sentAt: "" },
          "": { text: "no key" },
        },
      })
    );
    expect(parsed).toEqual({
      version: 1,
      notes: {
        "2026-02-19": { text: "chase, no edge", updatedAt: T0, sentAt: T1 },
        "2026-02-23": { text: "x", updatedAt: "" },
      },
    });
    expect(parseViewNotes(JSON.stringify({ version: 1, notes: { a: { text: "y".repeat(VIEW_NOTE_CAP + 5) } } })).notes.a.text).toHaveLength(
      VIEW_NOTE_CAP
    );
  });

  it("round-trips through serialize", () => {
    const f = setNote(emptyViewNotes(), "2026-02-19", "chase", T0);
    expect(parseViewNotes(serializeViewNotes(f))).toEqual(f);
  });

  it("viewNotesPath: the dir's notes.json, or the root's", () => {
    expect(viewNotesPath(".sb-views/gamma/deck")).toBe(".sb-views/gamma/deck/notes.json");
    expect(viewNotesPath("")).toBe("notes.json");
  });
});

describe("setNote / isUnsent / unsentNotes / markSent", () => {
  it("setNote writes, keeps the file reference on no change, and empty text removes", () => {
    const a = setNote(emptyViewNotes(), "d1", "chase", T0);
    expect(noteFor(a, "d1")).toBe("chase");
    expect(setNote(a, "d1", "chase", T1)).toBe(a);
    expect(setNote(a, "zz", "   ", T1)).toBe(a);
    const b = setNote(a, "d1", "", T1);
    expect(b.notes).toEqual({});
  });

  it("a note is unsent until sent, and unsent again once edited after", () => {
    const a = setNote(emptyViewNotes(), "d1", "chase", T0);
    expect(isUnsent(a.notes.d1)).toBe(true);
    const sent = markSent(a, ["d1", "missing"], T1);
    expect(sent.notes.d1.sentAt).toBe(T1);
    expect(isUnsent(sent.notes.d1)).toBe(false);
    // Sent in the same instant as the edit counts as sent.
    expect(isUnsent(markSent(a, ["d1"], T0).notes.d1)).toBe(false);
    const edited = setNote(sent, "d1", "chase — the counter", T2);
    expect(edited.notes.d1.sentAt).toBe(T1);
    expect(isUnsent(edited.notes.d1)).toBe(true);
    expect(markSent(a, ["nope"], T1)).toBe(a);
    expect(isUnsent(undefined)).toBe(false);
  });

  it("unsentNotes follows the DECK order when given, file order otherwise", () => {
    let f = emptyViewNotes();
    f = setNote(f, "2026-02-23", "late", T0);
    f = setNote(f, "2026-02-19", "early", T0);
    f = setNote(f, "2026-02-20", "sent already", T0);
    f = markSent(f, ["2026-02-20"], T1);
    f = setNote(f, "stray", "not in the deck", T0);
    expect(unsentNotes(f).map((e) => e.key)).toEqual(["2026-02-23", "2026-02-19", "stray"]);
    expect(unsentNotes(f, ["2026-02-19", "2026-02-20", "2026-02-23"]).map((e) => e.key)).toEqual([
      "2026-02-19",
      "2026-02-23",
      "stray",
    ]);
  });
});

describe("formatBatch — the one message the thread receives", () => {
  it("prints the header with the count and one bullet per note, folding inner newlines", () => {
    expect(
      formatBatch(" gamma deck ", [
        { key: "2026-02-19", text: "chase, no edge" },
        { key: "2026-02-20", text: "held\n the counter " },
      ])
    ).toBe("Chart notes on gamma deck (2):\n- 2026-02-19: chase, no edge\n- 2026-02-20: held the counter");
  });
});

describe("the store — one record per (thread, dir), injected IO, one writer", () => {
  afterEach(() => {
    __resetViewNotesForTests();
    vi.useRealTimers();
  });

  function fakeIO(initial: string | null) {
    const writes: { dir: string; data: string }[] = [];
    let fail = false;
    configureViewNotesIO({
      read: (_t, p) => (initial === null ? Promise.reject(new Error(`no ${p}`)) : Promise.resolve(initial)),
      write: (_t, dir, data) => {
        if (fail) return Promise.reject(new Error("disk says no"));
        writes.push({ dir, data });
        return Promise.resolve();
      },
    });
    return { writes, setFail: (v: boolean) => (fail = v) };
  }

  it("a missing file loads as empty; an edit before the load is IGNORED (never a write before the read)", async () => {
    const io = fakeIO(null);
    expect(editViewNote("t1", "deck", "d1", "too early", T0)).toBe(false);
    await loadViewNotes("t1", "deck");
    expect(getViewNotes("t1", "deck")).toEqual({ file: emptyViewNotes(), loaded: true, error: null });
    expect(io.writes).toEqual([]);
  });

  it("edits debounce into ONE write of the whole file; flush writes now", async () => {
    vi.useFakeTimers();
    const io = fakeIO(JSON.stringify({ version: 1, notes: { d0: { text: "kept", updatedAt: T0 } } }));
    await loadViewNotes("t1", ".sb-views/gamma/deck");
    expect(editViewNote("t1", ".sb-views/gamma/deck", "d1", "c", T1)).toBe(true);
    editViewNote("t1", ".sb-views/gamma/deck", "d1", "ch", T1);
    editViewNote("t1", ".sb-views/gamma/deck", "d1", "chase", T1);
    expect(io.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(VIEW_NOTES_WRITE_DEBOUNCE_MS + 5);
    expect(io.writes).toHaveLength(1);
    expect(io.writes[0].dir).toBe(".sb-views/gamma/deck");
    const written = parseViewNotes(io.writes[0].data);
    expect(written.notes.d0.text).toBe("kept");
    expect(written.notes.d1.text).toBe("chase");
    // The snapshot is the in-memory truth; a flush with nothing pending is a no-op.
    expect(noteFor(getViewNotes("t1", ".sb-views/gamma/deck").file, "d1")).toBe("chase");
    await flushViewNotes("t1", ".sb-views/gamma/deck");
    expect(io.writes).toHaveLength(1);
    editViewNote("t1", ".sb-views/gamma/deck", "d1", "chase!", T2);
    await flushViewNotes("t1", ".sb-views/gamma/deck");
    expect(io.writes).toHaveLength(2);
  });

  it("a failed write keeps the notes and records the error; the next success clears it", async () => {
    const io = fakeIO(null);
    await loadViewNotes("t1", "deck");
    io.setFail(true);
    editViewNote("t1", "deck", "d1", "chase", T1);
    await flushViewNotes("t1", "deck");
    let snap = getViewNotes("t1", "deck");
    expect(snap.error).toBe("disk says no");
    expect(noteFor(snap.file, "d1")).toBe("chase");
    io.setFail(false);
    editViewNote("t1", "deck", "d1", "chase, no edge", T2);
    await flushViewNotes("t1", "deck");
    snap = getViewNotes("t1", "deck");
    expect(snap.error).toBeNull();
    expect(io.writes).toHaveLength(1);
  });

  it("markViewNotesSent stamps and writes immediately, cancelling a pending debounce", async () => {
    vi.useFakeTimers();
    const io = fakeIO(null);
    await loadViewNotes("t1", "deck");
    editViewNote("t1", "deck", "d1", "chase", T1);
    editViewNote("t1", "deck", "d2", "counter", T1);
    await markViewNotesSent("t1", "deck", ["d1", "d2"], T2);
    expect(io.writes).toHaveLength(1);
    const f = parseViewNotes(io.writes[0].data);
    expect(f.notes.d1.sentAt).toBe(T2);
    expect(unsentNotes(f)).toEqual([]);
    await vi.advanceTimersByTimeAsync(VIEW_NOTES_WRITE_DEBOUNCE_MS + 5);
    expect(io.writes).toHaveLength(1);
  });
});
