// VIEW NOTES (SWIT-75 — the chart review loop): one note per deck key, in
// ONE file beside the deck — `<deck dir>/notes.json` in the thread cwd, where
// the deck dir is the PARENT spec's file-source directory (viewStore.
// notesDirOf; `.sb-views/gamma/deck/notes.json` for the gamma deck). Eric
// steps through the drilled children with `←`/`→`, types a line under each
// chart, and sends the UNSENT ones to the thread as ONE message.
//
// The file: `{version: 1, notes: {[key]: {text, updatedAt, sentAt?}}}`. A
// note is UNSENT while it has text and no `sentAt` at or after its
// `updatedAt` — editing a sent note makes it unsent again, and the batch
// carries exactly those. ONE WRITER: the app, through `write_view_notes`
// (the Rust guard fixes the file name and refuses a dir that does not
// exist). The agent `Read`s the file; it never writes it.
//
// Two halves, the neighbours' pattern: PURE rules over the file's contents
// (parse tolerant, setNote, unsentNotes, markSent, formatBatch), then a
// module singleton with INJECTED IO — one record per (thread, dir), loaded
// once, edits applied in memory and written by one debounced writer per
// record, NEVER a write before the load resolved (an edit racing the first
// read would otherwise clobber notes already on disk — backlogStore's rule).
// A remount (every `next` replaces the child artifact, so ViewChrome
// remounts) reads the record, not the disk, which is what keeps a 400ms
// pending write from being overwritten by a stale re-read.

import { useEffect, useSyncExternalStore } from "react";
import { readViewData, writeViewNotes } from "./ipc";

export const VIEW_NOTES_FILE = "notes.json";
/** Longest note kept (chars) — a note is a line, not a document. */
export const VIEW_NOTE_CAP = 2000;
export const VIEW_NOTES_WRITE_DEBOUNCE_MS = 400;

export type ViewNote = { text: string; updatedAt: string; sentAt?: string };
export type ViewNotesFile = { version: 1; notes: Record<string, ViewNote> };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function emptyViewNotes(): ViewNotesFile {
  return { version: 1, notes: {} };
}

/** The file's relative path for a deck dir (`""` = the cwd root). Pure. */
export function viewNotesPath(dir: string): string {
  return dir.length > 0 ? `${dir}/${VIEW_NOTES_FILE}` : VIEW_NOTES_FILE;
}

/** Tolerant parse: "" / bad JSON / wrong shape → an empty file (a missing
 *  notes file is the ordinary first state); an entry without a string
 *  `text` drops alone; stamps that are not strings become "". Pure. */
export function parseViewNotes(raw: string): ViewNotesFile {
  if (typeof raw !== "string" || raw.trim().length === 0) return emptyViewNotes();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyViewNotes();
  }
  if (!isRecord(data) || !isRecord(data.notes)) return emptyViewNotes();
  const notes: Record<string, ViewNote> = {};
  for (const [key, v] of Object.entries(data.notes)) {
    if (!isRecord(v) || typeof v.text !== "string" || key.length === 0) continue;
    const note: ViewNote = {
      text: v.text.slice(0, VIEW_NOTE_CAP),
      updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : "",
    };
    if (typeof v.sentAt === "string" && v.sentAt.length > 0) note.sentAt = v.sentAt;
    notes[key] = note;
  }
  return { version: 1, notes };
}

export function serializeViewNotes(file: ViewNotesFile): string {
  return JSON.stringify(file, null, 2);
}

/** The text under a key ("" when none). Pure. */
export function noteFor(file: ViewNotesFile, key: string): string {
  return file.notes[key]?.text ?? "";
}

/** Set a key's note. Empty/whitespace text REMOVES the entry (a cleared note
 *  is no note, not a note that says nothing); unchanged text returns the
 *  SAME file so nothing is written. A previous `sentAt` is kept — the
 *  unsent rule compares it against the new `updatedAt`. Pure. */
export function setNote(file: ViewNotesFile, key: string, text: string, now: string): ViewNotesFile {
  const clean = text.slice(0, VIEW_NOTE_CAP);
  const prev = file.notes[key];
  if (clean.trim().length === 0) {
    if (!prev) return file;
    const notes = { ...file.notes };
    delete notes[key];
    return { version: 1, notes };
  }
  if (prev && prev.text === clean) return file;
  const next: ViewNote = { text: clean, updatedAt: now };
  if (prev?.sentAt) next.sentAt = prev.sentAt;
  return { version: 1, notes: { ...file.notes, [key]: next } };
}

/** A note is UNSENT while it has text and was edited after (or never) sent.
 *  ISO stamps compare as strings — both come from `toISOString`. Pure. */
export function isUnsent(note: ViewNote | undefined): boolean {
  if (!note || note.text.trim().length === 0) return false;
  return !note.sentAt || note.sentAt < note.updatedAt;
}

/** The unsent notes as `{key, text}` — in DECK ORDER when `order` (the
 *  deck's keys) is given, keys outside it after, in file order. Pure. */
export function unsentNotes(file: ViewNotesFile, order?: readonly string[]): { key: string; text: string }[] {
  const keys = Object.keys(file.notes).filter((k) => isUnsent(file.notes[k]));
  if (order && order.length > 0) {
    const rank = new Map(order.map((k, i) => [k, i]));
    keys.sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
  }
  return keys.map((key) => ({ key, text: file.notes[key].text }));
}

/** Stamp `sentAt` on the given keys (missing keys ignored). Pure. */
export function markSent(file: ViewNotesFile, keys: readonly string[], now: string): ViewNotesFile {
  let changed = false;
  const notes = { ...file.notes };
  for (const k of keys) {
    const n = notes[k];
    if (!n) continue;
    notes[k] = { ...n, sentAt: now };
    changed = true;
  }
  return changed ? { version: 1, notes } : file;
}

/** THE batch message (SWIT-75) — what the thread receives, verbatim:
 *
 *    Chart notes on <parent title> (<N>):
 *    - <key>: <note>
 *
 *  A note's internal line breaks fold to one space so each bullet stays one
 *  line and the message stays the composer's multi-line shape. Pure. */
export function formatBatch(parentTitle: string, entries: readonly { key: string; text: string }[]): string {
  const lines = entries.map((e) => `- ${e.key}: ${e.text.replace(/\s*\r?\n\s*/g, " ").trim()}`);
  return [`Chart notes on ${parentTitle.trim()} (${entries.length}):`, ...lines].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// The store: one record per (thread, deck dir), injected IO, one writer
// ─────────────────────────────────────────────────────────────────────────────

export type ViewNotesIO = {
  /** The file's text; REJECTS when missing (readViewData's contract) —
   *  treated as an empty file. */
  read: (threadId: string, relPath: string) => Promise<string>;
  write: (threadId: string, relDir: string, data: string) => Promise<void>;
};

const DEFAULT_IO: ViewNotesIO = { read: readViewData, write: writeViewNotes };
let io: ViewNotesIO = DEFAULT_IO;

/** Inject IO (tests). `null` restores the IPC pair. */
export function configureViewNotesIO(next: ViewNotesIO | null): void {
  io = next ?? DEFAULT_IO;
}

type NotesRecord = {
  file: ViewNotesFile;
  loaded: boolean;
  /** The last write's failure, kept until the next write succeeds. */
  error: string | null;
  /** A load in flight (so two mounts share one read). */
  loading: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Dirty = edited since the last write was ISSUED. */
  dirty: boolean;
  /** The write in flight, so a flush can await it. */
  writing: Promise<void> | null;
  /** The snapshot object `useViewNotes` hands React — rebuilt on change. */
  snapshot: ViewNotesSnapshot;
};

export type ViewNotesSnapshot = { file: ViewNotesFile; loaded: boolean; error: string | null };

const records = new Map<string, NotesRecord>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function viewNotesKey(threadId: string, dir: string): string {
  return `${threadId}|${dir}`;
}

const EMPTY_SNAPSHOT: ViewNotesSnapshot = { file: emptyViewNotes(), loaded: false, error: null };

function record(threadId: string, dir: string): NotesRecord {
  const key = viewNotesKey(threadId, dir);
  let rec = records.get(key);
  if (!rec) {
    rec = {
      file: emptyViewNotes(),
      loaded: false,
      error: null,
      loading: null,
      timer: null,
      dirty: false,
      writing: null,
      snapshot: EMPTY_SNAPSHOT,
    };
    records.set(key, rec);
  }
  return rec;
}

function touch(rec: NotesRecord): void {
  rec.snapshot = { file: rec.file, loaded: rec.loaded, error: rec.error };
  notify();
}

/** Load a record ONCE (a missing file is an empty one). Concurrent callers
 *  share the read. */
export function loadViewNotes(threadId: string, dir: string): Promise<void> {
  const rec = record(threadId, dir);
  if (rec.loaded) return Promise.resolve();
  if (rec.loading) return rec.loading;
  rec.loading = io
    .read(threadId, viewNotesPath(dir))
    .then(
      (raw) => {
        rec.file = parseViewNotes(raw);
      },
      () => {
        rec.file = emptyViewNotes();
      }
    )
    .then(() => {
      rec.loaded = true;
      rec.loading = null;
      touch(rec);
    });
  return rec.loading;
}

export function getViewNotes(threadId: string, dir: string): ViewNotesSnapshot {
  return records.get(viewNotesKey(threadId, dir))?.snapshot ?? EMPTY_SNAPSHOT;
}

function issueWrite(rec: NotesRecord, threadId: string, dir: string): Promise<void> {
  rec.dirty = false;
  const p = io
    .write(threadId, dir, serializeViewNotes(rec.file))
    .then(
      () => {
        if (rec.error !== null) {
          rec.error = null;
          touch(rec);
        }
      },
      (err) => {
        rec.error = String(err instanceof Error ? err.message : err);
        touch(rec);
      }
    )
    .then(() => {
      if (rec.writing === p) rec.writing = null;
    });
  rec.writing = p;
  return p;
}

function scheduleWrite(rec: NotesRecord, threadId: string, dir: string): void {
  rec.dirty = true;
  if (rec.timer !== null) clearTimeout(rec.timer);
  rec.timer = setTimeout(() => {
    rec.timer = null;
    void issueWrite(rec, threadId, dir);
  }, VIEW_NOTES_WRITE_DEBOUNCE_MS);
}

/** Edit a key's note. IGNORED (returns false) before the record is loaded —
 *  never a write before the load. Autosaves after the debounce. */
export function editViewNote(threadId: string, dir: string, key: string, text: string, now = new Date().toISOString()): boolean {
  const rec = record(threadId, dir);
  if (!rec.loaded) return false;
  const next = setNote(rec.file, key, text, now);
  if (next === rec.file) return true;
  rec.file = next;
  touch(rec);
  scheduleWrite(rec, threadId, dir);
  return true;
}

/** Write a pending edit NOW (the debounce cancelled); resolves after the
 *  write settles — a failure is recorded on the snapshot, never thrown. */
export function flushViewNotes(threadId: string, dir: string): Promise<void> {
  const rec = records.get(viewNotesKey(threadId, dir));
  if (!rec) return Promise.resolve();
  if (rec.timer !== null) {
    clearTimeout(rec.timer);
    rec.timer = null;
  }
  if (rec.dirty) return issueWrite(rec, threadId, dir);
  return rec.writing ?? Promise.resolve();
}

/** Stamp keys as sent and write immediately. Call ONLY after the thread
 *  write succeeded — a failed send leaves the notes unsent. */
export function markViewNotesSent(threadId: string, dir: string, keys: readonly string[], now = new Date().toISOString()): Promise<void> {
  const rec = record(threadId, dir);
  if (!rec.loaded) return Promise.resolve();
  const next = markSent(rec.file, keys, now);
  if (next === rec.file) return flushViewNotes(threadId, dir);
  rec.file = next;
  touch(rec);
  if (rec.timer !== null) {
    clearTimeout(rec.timer);
    rec.timer = null;
  }
  return issueWrite(rec, threadId, dir);
}

/** The record for a (thread, dir), loaded on first use while `active`. A
 *  null dir (a query-sourced deck) yields the empty, never-loaded snapshot —
 *  the input renders disabled. */
export function useViewNotes(threadId: string, dir: string | null, active: boolean): ViewNotesSnapshot {
  const snapshot = useSyncExternalStore(subscribe, () =>
    dir === null ? EMPTY_SNAPSHOT : getViewNotes(threadId, dir)
  );
  const loaded = snapshot.loaded;
  useEffect(() => {
    if (dir !== null && active && !loaded) void loadViewNotes(threadId, dir);
  }, [threadId, dir, active, loaded]);
  return snapshot;
}

/** Tests: drop every record and pending timer. */
export function __resetViewNotesForTests(): void {
  for (const rec of records.values()) if (rec.timer !== null) clearTimeout(rec.timer);
  records.clear();
  io = DEFAULT_IO;
}
