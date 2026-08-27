// Wireframe pins STORE — ONE shared record per `.pins.json` sidecar.
//
// WHY THIS EXISTS (A5 review gate, data-loss class):
// the same wireframe can be MOUNTED TWICE AT ONCE. The artifact panel hosts a
// DocView inside the terminal screen while the KEEP-ALIVE KB screen keeps its
// own DocView mounted for the last kb route — `display: none` is not unmount.
// WireframeView used to hold the sidecar in COMPONENT state: read once on
// mount (an effect keyed on the sidecar path, never re-read, never polled) and
// write the WHOLE file on a debounce. Two mounts therefore held two
// independent copies of the same file and the later writer silently clobbered
// the other's pins:
//
//   panel shows X.html → "open full" → KB screen mounts a SECOND
//   WireframeView(X) while the panel's stays mounted → add pin 4 in the panel
//   (writes [1,2,3,4]) → add a pin on the KB screen from its stale [1,2,3]
//   (writes [1,2,3,5]) → pin 4 is gone, with no error anywhere.
//
// The fix is a shared store, NOT a refuse-to-mount-twice rule: co-presence is
// the whole point of the panel, so both mounts must stay live and simply agree.
// Every mount of a given sidecar reads and mutates ONE record and re-renders
// on any change (module state + useSyncExternalStore, the same shape as
// panelStore / threadStore), and there is exactly ONE debounced writer per
// sidecar instead of one per mount.
//
// The PURE layer is untouched: pins.ts still owns the tolerant parse, the
// round-trip guarantees and every pin op (add/remove/updateNote). This module
// consumes those functions and adds nothing to them — it owns sharing,
// lifetime and IO scheduling, and no rules about the file's contents.
//
// IO is INJECTED (`configurePinsIO`, wired once at App module scope) so the
// store's lifetime rules — refcounting, coalescing, flush-exactly-once — are
// unit-testable under Node without a Tauri bridge.

import { useCallback, useSyncExternalStore } from "react";
import { emptyPinsFile, mergeForeignPins, parsePinsFile, serializePinsFile } from "./pins";
import type { PinsFile } from "./pins";
import { log } from "./logger";

/** Coalescing window for sidecar writes. Per SIDECAR now, not per mount. */
export const PINS_WRITE_DEBOUNCE_MS = 500;

/** The two file operations the store needs. Injected so tests can drive the
 *  scheduling rules without a backend. */
export type PinsIO = {
  read: (sidecarPath: string) => Promise<string>;
  write: (sidecarPath: string, text: string) => Promise<void>;
};

let io: PinsIO | null = null;

/** App wires the real KB read/write here at module scope (before any render).
 *  Null leaves the store inert — loads retry on the next mount rather than
 *  faking an empty sidecar, so a wiring mistake can never present a real file
 *  as empty and then overwrite it. */
export function configurePinsIO(next: PinsIO | null): void {
  io = next;
}

type Entry = {
  /** The ONE record every mount of this sidecar reads and mutates.
   *  null = never loaded (mounts show their loading state). */
  file: PinsFile | null;
  /** Live subscribers — mounted views showing a doc in this folder. */
  mounts: number;
  /** A load has been kicked off for the current idle period. */
  loadStarted: boolean;
  /** Bumped by every real mutation. A load that resolves against a stale
   *  count is DISCARDED: the in-memory record already has edits the disk
   *  read cannot know about, and clobbering them here would reintroduce the
   *  very bug this store exists to kill. */
  mutations: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** A write is OWED. Sole gate on flushing, which is what makes
   *  "flush exactly once" true across timer-fire and last-unmount. */
  pending: boolean;
  /** The write currently IN FLIGHT (null = none owed to the disk).
   *
   *  WHY (A5-class data loss, found on increment B's headline path): two
   *  wireframes in the SAME folder share one sidecar, and switching between
   *  their panel TABS unmounts one WireframeView and mounts the other in a
   *  single React commit — destroy before create. That is
   *  release → mounts 1→0 → flushEntry issues a write (fire-and-forget) →
   *  subscribe → wasIdle → loadStarted=false → ensureLoaded reads. No
   *  mutation happens in between, so `mutations !== at` cannot help, and
   *  kb_read_doc / kb_write_doc are independent async tokio commands with NO
   *  ordering guarantee (the write does strictly more work — create_dir_all).
   *  A read served before the write lands overwrites the in-memory record
   *  with pre-write disk content: the pin you just placed vanishes, and the
   *  next edit persists that loss.
   *
   *  The fix is a real happens-before: a load is not ISSUED until the write
   *  it would race has settled. Writes only ever follow mutations, so the
   *  reverse order (write issued while a read is in flight) is already
   *  covered by the `mutations` guard in applyLoad. */
  inFlight: Promise<unknown> | null;
  /** Monotonic count of writes ISSUED — lets a late-settling older write
   *  avoid clearing a newer write's gate. */
  writesIssued: number;
  /** The pin ids we last SAW on disk (set by every load/refresh, and by every
   *  write we complete). What lets a flush tell a FOREIGN add (agent, hand
   *  edit) from a LOCAL delete — pins.mergeForeignPins. */
  diskIds: ReadonlySet<string>;
  /** A refresh read in flight — a second tick while one is out is skipped. */
  refreshing: boolean;
  listeners: Set<() => void>;
};

const entries = new Map<string, Entry>();

function entryFor(sidecarPath: string): Entry {
  let entry = entries.get(sidecarPath);
  if (!entry) {
    entry = {
      file: null,
      mounts: 0,
      loadStarted: false,
      mutations: 0,
      timer: null,
      pending: false,
      inFlight: null,
      writesIssued: 0,
      diskIds: new Set(),
      refreshing: false,
      listeners: new Set(),
    };
    entries.set(sidecarPath, entry);
  }
  return entry;
}

function notify(entry: Entry): void {
  for (const listener of entry.listeners) listener();
}

// ── Load ─────────────────────────────────────────────────────────────────────

function ensureLoaded(sidecarPath: string, entry: Entry): void {
  if (entry.loadStarted) return;
  const reader = io;
  if (!reader) {
    // Unwired (a test that forgot, or a wiring bug). Stay silent-but-inert and
    // retry on the next mount — never seed an empty file over a real one.
    log.error(`pinsStore: no IO configured, cannot load ${sidecarPath}`);
    return;
  }
  entry.loadStarted = true;
  const at = entry.mutations;
  const issue = () =>
    reader.read(sidecarPath).then(
      (text) => applyLoad(entry, parsePinsFile(text), at),
      // A read error means "no sidecar yet" — kb_read_doc errors on missing
      // files — so an empty v1 file is the correct starting point.
      () => applyLoad(entry, emptyPinsFile(), at)
    );
  // ORDERING GATE (see Entry.inFlight): never issue a read while a write for
  // this sidecar is still unacknowledged, or the read can be served
  // pre-write content and clobber the record. Nothing in flight → issue
  // SYNCHRONOUSLY, exactly as before, so the common path is unchanged.
  if (entry.inFlight === null) void issue();
  else void entry.inFlight.then(issue);
}

function applyLoad(entry: Entry, file: PinsFile, at: number): void {
  if (entry.mutations !== at) return; // local edits are newer; keep them
  entry.diskIds = new Set(file.pins.map((p) => p.id));
  // A re-read (refreshPins) that finds the SAME content must not re-render
  // every mount — compare by serialized form, which is what the disk holds.
  if (entry.file !== null && serializePinsFile(entry.file) === serializePinsFile(file)) return;
  entry.file = file;
  notify(entry);
}

/** RE-READ an already-loaded sidecar from disk (Inc 3d — SWIT-38): the agent
 *  adds a pin by writing the file, and a mounted rail polls this so the pin
 *  appears without a remount. Every protection the first load has applies:
 *  skipped while a write is owed or in flight (the disk is about to change
 *  under us — reading it now could only be stale), discarded if a local edit
 *  lands before the read resolves (`mutations` guard), and a no-op when the
 *  content is unchanged. Never creates an entry: nothing mounted means
 *  nothing to refresh. */
export function refreshPins(sidecarPath: string): void {
  const entry = entries.get(sidecarPath);
  const reader = io;
  if (!entry || !reader || entry.file === null || entry.mounts === 0) return;
  if (entry.pending || entry.inFlight !== null || entry.refreshing) return;
  entry.refreshing = true;
  const at = entry.mutations;
  void reader.read(sidecarPath).then(
    (text) => {
      entry.refreshing = false;
      applyLoad(entry, parsePinsFile(text), at);
    },
    () => {
      // A missing sidecar now means nothing changed that we can act on — an
      // earlier load already settled the in-memory record.
      entry.refreshing = false;
    }
  );
}

// ── Subscribe / refcount ─────────────────────────────────────────────────────

/** Subscribe to a sidecar and take a reference on it. The returned function
 *  unsubscribes AND releases; when the LAST reference goes away with a write
 *  still owed, that write is flushed immediately (the backend outlives the
 *  component, so fire-and-forget is fine).
 *
 *  Exported beyond the hook so the lifetime rules can be tested as two
 *  independent "mounts" without a React renderer. */
export function subscribeToPins(sidecarPath: string, listener: () => void): () => void {
  const entry = entryFor(sidecarPath);
  entry.listeners.add(listener);
  const wasIdle = entry.mounts === 0;
  entry.mounts += 1;
  // First mount on an IDLE record re-reads: the sidecar is a file in a git
  // checkout that an agent, a rebase or a hand-edit can change while the app
  // runs, and the pre-store code re-read on every mount. Safe because an idle
  // record owes no write (release flushes), so nothing local can be lost —
  // and the existing record stays on screen until the read resolves, so
  // reopening a panel never flashes empty.
  if (wasIdle) entry.loadStarted = false;
  ensureLoaded(sidecarPath, entry);

  return () => {
    entry.listeners.delete(listener);
    entry.mounts = Math.max(0, entry.mounts - 1);
    if (entry.mounts === 0 && entry.pending) flushEntry(sidecarPath, entry);
  };
}

// ── Read ─────────────────────────────────────────────────────────────────────

/** The shared record for a sidecar, or null when it has not loaded. Reference
 *  is stable between changes (mutators replace the record, never mutate it),
 *  so it is a valid useSyncExternalStore snapshot.
 *
 *  Deliberately does NOT create an entry — a snapshot read during render must
 *  not take a reference or start IO. */
export function getPinsFile(sidecarPath: string): PinsFile | null {
  return entries.get(sidecarPath)?.file ?? null;
}

/** React hook: the shared record, re-rendering every mount on any change.
 *  Subscribing IS acquiring — React's own subscribe/unsubscribe pairing is the
 *  refcount, so StrictMode's double-invoke stays balanced. */
export function usePinsFile(sidecarPath: string): PinsFile | null {
  const subscribe = useCallback(
    (onChange: () => void) => subscribeToPins(sidecarPath, onChange),
    [sidecarPath]
  );
  const snapshot = useCallback(() => getPinsFile(sidecarPath), [sidecarPath]);
  return useSyncExternalStore(subscribe, snapshot);
}

// ── Mutate / write ───────────────────────────────────────────────────────────

/** Apply a pure pins.ts op to the shared record: every mount sees the result,
 *  and ONE debounced write is (re)scheduled for the sidecar.
 *
 *  No-op before the record loads (the UI disables pin actions until then) and
 *  when the pure op returns the same object — pins.ts signals "nothing
 *  changed" by identity, and an unchanged file is not worth a write. */
export function mutatePins(sidecarPath: string, fn: (file: PinsFile) => PinsFile): void {
  const entry = entries.get(sidecarPath);
  if (!entry || !entry.file) return;
  const next = fn(entry.file);
  if (next === entry.file) return;
  entry.file = next;
  entry.mutations += 1;
  entry.pending = true;
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    flushEntry(sidecarPath, entry);
  }, PINS_WRITE_DEBOUNCE_MS);
  notify(entry);
}

/** Write an owed change NOW. Idempotent: `pending` is cleared first, so a
 *  timer that fires afterwards, or a release, writes nothing. */
export function flushPins(sidecarPath: string): void {
  const entry = entries.get(sidecarPath);
  if (entry) flushEntry(sidecarPath, entry);
}

function flushEntry(sidecarPath: string, entry: Entry): void {
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (!entry.pending || !entry.file) return;
  entry.pending = false;
  const writer = io;
  if (!writer) {
    log.error(`pinsStore: no IO configured, dropping write for ${sidecarPath}`);
    return;
  }
  const issued = (entry.writesIssued += 1);
  // READ-THEN-MERGE-THEN-WRITE (Inc 3d — SWIT-38). The file may have changed
  // under us since the last load — an agent appending a pin is the designed
  // case — and writing our record over it verbatim would be last-writer-wins
  // on the whole file, which is what this store exists to kill. So a flush
  // first reads what is on disk NOW, keeps the pins that are foreign to us
  // (pins.mergeForeignPins), and writes the union. A read failure (no file
  // yet) merges against nothing. The whole sequence is the in-flight gate, so
  // no load can be served between the read and the write.
  const local = entry.file;
  entry.inFlight = writer
    .read(sidecarPath)
    .then(
      (text) => parsePinsFile(text),
      () => emptyPinsFile()
    )
    .then((disk) => {
      const merged = mergeForeignPins(local, disk, entry.diskIds);
      if (merged !== local && entry.file === local) {
        // Foreign pins joined: show them, without counting as a local edit
        // (no mutation bump — a refresh landing later must still be honoured).
        entry.file = merged;
        notify(entry);
      }
      const out = entry.file ?? merged;
      entry.diskIds = new Set(out.pins.map((p) => p.id));
      return writer.write(sidecarPath, serializePinsFile(out));
    })
    .catch((e: unknown) => {
      log.error(`pinsStore: pins write failed for ${sidecarPath}: ${String(e)}`);
    })
    .then(() => {
      // Only the NEWEST write clears the gate. An older write settling late
      // must not let a read overtake one that is still in flight.
      if (entry.writesIssued === issued) entry.inFlight = null;
    });
}

/** Is a write still owed for this sidecar? (Test/diagnostic surface — the
 *  scheduling rules are invisible from the record alone.) */
export function hasPendingWrite(sidecarPath: string): boolean {
  return entries.get(sidecarPath)?.pending ?? false;
}

/** Is a write still unacknowledged for this sidecar? A load issued now would
 *  be GATED behind it (test/diagnostic surface — the ordering rule is
 *  invisible from the record alone). */
export function hasInFlightWrite(sidecarPath: string): boolean {
  return entries.get(sidecarPath)?.inFlight != null;
}

/** Test-only: drop every record, timer and the injected IO. */
export function __resetPinsStoreForTests(): void {
  for (const entry of entries.values()) {
    if (entry.timer !== null) clearTimeout(entry.timer);
  }
  entries.clear();
  io = null;
}
