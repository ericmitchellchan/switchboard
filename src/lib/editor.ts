// THE MARKDOWN EDIT BUFFER (increment G) — what happens when Eric and the
// agent both write the same file.
//
// Rendering was the easy half. This module is the hard half, and every rule in
// it answers one question: "the agent just wrote the doc you have open with
// unsaved changes — now what?"
//
// THE FOUR RULES, in the order they matter:
//
//  1. EXPLICIT SAVE (Ctrl+S). Nothing reaches disk until you say so, which is
//     what gives a clean boundary against an agent that writes constantly: an
//     external write can be DETECTED and OFFERED rather than raced. (~1s
//     autosave was rejected — you and the agent then write the same file on
//     overlapping timers, which is precisely the race that produced two
//     data-loss bugs in the pins layer.)
//  2. NEVER SILENTLY OVERWRITE, IN EITHER DIRECTION. A CLEAN buffer follows the
//     file (that is the agent-picks-up-your-work loop running the other way,
//     and it is what the existing 2500ms poll already does). A DIRTY buffer
//     never gets replaced and never clobbers: `foldDisk` raises a CONFLICT and
//     the user picks keep-mine or take-theirs. No auto-merge.
//  3. A FAILED WRITE KEEPS THE BUFFER. The error is surfaced next to it. There
//     is no path in this file that drops typed text on the floor.
//  4. THE BUFFER OUTLIVES EVERYTHING SHORT OF AN EXPLICIT DISCARD — a tab
//     switch, a screen switch, a different artifact, and an app restart. That
//     is the mitigation for rule 1's cost.
//
// SHAPE: the same layout as the repo's other lib modules and the same
// singleton pattern `composer.ts` uses for its drafts — pure, unit-tested logic
// first (`isDirty` / `foldDisk` / `resolveWith` / `insertTab` / the draft
// codec), then a module-level Map + subscriber set + useSyncExternalStore
// hooks, deliberately not zustand. IO is INJECTED (like `pinsStore`) so the
// save path is testable without Tauri.
//
// It differs from `composer.ts` in exactly one way, and acceptance 6 is why:
// composer drafts are app-lifetime only ("a restart legitimately starts you
// with a fresh box"), while an unsaved DOCUMENT edit is work — so dirty buffers
// mirror to localStorage and come back after a restart.

import { useSyncExternalStore } from "react";
import type { FileArtifact } from "../types";
import { artifactIdentity } from "./panelStore";
import { docKind } from "./kb";
import { explorerRead, explorerWrite, kbReadDoc, kbWriteDoc } from "./ipc";

// ─────────────────────────────────────────────────────────────────────────────
// State shape + pure rules
// ─────────────────────────────────────────────────────────────────────────────

export type EditorState = {
  /** The disk content this buffer was forked from. Save compares against it;
   *  an external write is "disk !== baseline". */
  baseline: string;
  /** What is in the textarea. */
  buffer: string;
  /** Is the edit surface showing? A buffer can exist with `editing: false` —
   *  you toggled back to the rendered view, or switched artifacts, with unsaved
   *  work. Rule 4: that is preserved, not discarded. */
  editing: boolean;
  /** The disk content of an EXTERNAL change waiting on a decision, or null.
   *  Non-null blocks saving — a save while a conflict is pending routes through
   *  the banner instead of clobbering (rule 2). */
  conflict: string | null;
  /** Last failed save, kept next to the buffer that failed to write (rule 3). */
  error: string | null;
  /** A write is in flight — the save affordance disables so two Ctrl+S presses
   *  cannot both read-then-write. */
  saving: boolean;
  /** `Date.now()` of the last successful save, for the transient "saved" note.
   *  Null until the first one. */
  savedAt: number | null;
};

/** Does this artifact have an edit surface? Markdown only, and only for the two
 *  file-backed kinds — wireframes, diagrams, code previews and live localhost
 *  frames stay READ-ONLY (increment G non-goals). `docKind` stays the single
 *  kind vocabulary; nothing here re-derives one from an extension. */
export function isEditable(artifact: { kind: string; path?: string }): boolean {
  if (artifact.kind !== "kb-doc" && artifact.kind !== "repo-file") return false;
  return docKind(artifact.path ?? "") === "markdown";
}

/** Unsaved work exists. THE dirty predicate — the dot, the draft mirror and the
 *  save gate all ask this one function. */
export function isDirty(state: EditorState | null | undefined): boolean {
  return !!state && state.buffer !== state.baseline;
}

/** A fresh buffer forked from disk content. */
export function newEditorState(disk: string, editing: boolean): EditorState {
  return {
    baseline: disk,
    buffer: disk,
    editing,
    conflict: null,
    error: null,
    saving: false,
    savedAt: null,
  };
}

/**
 * RULE 2, as one pure function: fold the disk's current content into an open
 * buffer. Returns the PREVIOUS OBJECT (identity-equal) when nothing changed, so
 * a 2500ms poll tick over an untouched file costs no re-render — the same
 * discipline `kb.mergeDocRead` and `explorer.mergeFileRead` apply one layer up.
 *
 *   · disk === baseline           → nothing happened. Unchanged.
 *   · buffer CLEAN, disk moved    → follow the file. The rendered view was
 *                                   already refreshing; the buffer just keeps
 *                                   up so toggling to edit shows the new text.
 *   · buffer DIRTY, disk moved    → CONFLICT. The buffer is not touched and the
 *                                   file is not touched; the banner decides.
 *
 * A conflict already raised for the SAME disk content is not re-raised (a poll
 * repeats the same read every 2.5s), but a conflict whose content moves AGAIN
 * updates to the newer disk state — "take theirs" must mean the current file,
 * not the first version we happened to notice.
 */
export function foldDisk(prev: EditorState, disk: string): EditorState {
  if (prev.buffer === prev.baseline) {
    // CLEAN: the file wins, in full, including clearing a stale conflict.
    if (prev.baseline === disk && prev.conflict === null) return prev;
    return { ...prev, baseline: disk, buffer: disk, conflict: null };
  }
  if (disk === prev.baseline) {
    // DIRTY, and the file came back to what we forked from (an agent undid its
    // own edit). Nothing to decide any more.
    return prev.conflict === null ? prev : { ...prev, conflict: null };
  }
  if (prev.conflict === disk) return prev;
  return { ...prev, conflict: disk };
}

/** Resolve a pending conflict. Neither branch loses work:
 *   · `mine`   — the buffer stands, re-forked from THEIR version so the next
 *                save is a deliberate overwrite of a change you have seen.
 *   · `theirs` — the file wins; the buffer becomes their text and is CLEAN.
 *                (Your text is gone from the buffer by your own instruction —
 *                that is what the button says.)
 *  A no-op when there is no conflict. */
export function resolveWith(prev: EditorState, choice: "mine" | "theirs"): EditorState {
  const theirs = prev.conflict;
  if (theirs === null) return prev;
  if (choice === "mine") return { ...prev, baseline: theirs, conflict: null };
  return { ...prev, baseline: theirs, buffer: theirs, conflict: null, error: null };
}

/** Two spaces per Tab — the app's density, and the indentation every markdown
 *  list in the KB already uses. Returns the new value and where the caret goes,
 *  so the textarea can restore selection (React would otherwise jump it to the
 *  end on a controlled re-render). A SELECTION is replaced, matching a plain
 *  textarea's own Tab-less behaviour for typed characters. */
export const TAB_SPACES = "  ";

export function insertTab(
  value: string,
  selectionStart: number,
  selectionEnd: number
): { value: string; caret: number } {
  const next = value.slice(0, selectionStart) + TAB_SPACES + value.slice(selectionEnd);
  return { value: next, caret: selectionStart + TAB_SPACES.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Draft persistence (acceptance 6) — the one place this differs from composer.ts
// ─────────────────────────────────────────────────────────────────────────────

export const DRAFTS_KEY = "switchboard:drafts";
const DRAFTS_VERSION = 1;

/** What survives a restart: the buffer, what it was forked from, and whether
 *  the edit surface was showing. Nothing transient (`saving`, `error`,
 *  `savedAt`) and NOT the conflict — a conflict is re-derived from the file on
 *  the next fold, which is the only source that can still be true. */
export type SavedDraft = { baseline: string; buffer: string; editing: boolean };

/** Only DIRTY buffers are worth a storage slot — a clean one is just the file.
 *  Pure. */
export function serializeDrafts(states: ReadonlyMap<string, EditorState>): string {
  const drafts: Record<string, SavedDraft> = {};
  for (const [key, state] of states) {
    if (!isDirty(state)) continue;
    drafts[key] = { baseline: state.baseline, buffer: state.buffer, editing: state.editing };
  }
  return JSON.stringify({ v: DRAFTS_VERSION, drafts });
}

/** Tolerant parse — anything malformed yields no drafts rather than throwing at
 *  module load and taking the app down with it. Pure. */
export function parseDrafts(raw: string | null): Map<string, EditorState> {
  const out = new Map<string, EditorState>();
  if (!raw) return out;
  try {
    const blob = JSON.parse(raw) as { v?: unknown; drafts?: unknown };
    if (blob?.v !== DRAFTS_VERSION || typeof blob.drafts !== "object" || blob.drafts === null) {
      return out;
    }
    for (const [key, value] of Object.entries(blob.drafts as Record<string, unknown>)) {
      const d = value as Partial<SavedDraft>;
      if (typeof d?.baseline !== "string" || typeof d?.buffer !== "string") continue;
      // A "draft" that is not dirty is meaningless — drop rather than restore.
      if (d.baseline === d.buffer) continue;
      out.set(key, {
        baseline: d.baseline,
        buffer: d.buffer,
        editing: d.editing !== false,
        conflict: null,
        error: null,
        saving: false,
        savedAt: null,
      });
    }
  } catch {
    // Unparseable blob — treat as no drafts.
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Injected IO
// ─────────────────────────────────────────────────────────────────────────────
// Same posture as pinsStore: the store owns the RULES, not the transport, so
// the save path (read-then-compare-then-write) is assertable without Tauri.

export type EditorIo = {
  read: (artifact: FileArtifact) => Promise<string>;
  write: (artifact: FileArtifact, content: string) => Promise<void>;
};

const defaultIo: EditorIo = {
  read: (artifact) =>
    artifact.kind === "kb-doc"
      ? kbReadDoc(artifact.path)
      : explorerRead(artifact.project, artifact.path),
  write: (artifact, content) =>
    artifact.kind === "kb-doc"
      ? kbWriteDoc(artifact.path, content)
      : explorerWrite(artifact.project, artifact.path, content),
};

let io: EditorIo = defaultIo;

/** Test-only: swap the transport. */
export function __setEditorIoForTests(next: EditorIo | null): void {
  io = next ?? defaultIo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

let states: Map<string, EditorState> = loadDrafts();
const listeners = new Set<() => void>();

function loadDrafts(): Map<string, EditorState> {
  if (typeof localStorage === "undefined") return new Map();
  try {
    return parseDrafts(localStorage.getItem(DRAFTS_KEY));
  } catch {
    return new Map();
  }
}

/** Mirror dirty buffers to localStorage. Debounced: a keystroke must not cost a
 *  JSON serialize + storage write, but a crash must not cost more than the last
 *  few hundred milliseconds of typing. */
const DRAFT_FLUSH_MS = 400;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function flushDrafts(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(DRAFTS_KEY, serializeDrafts(states));
  } catch {
    // Storage full or unavailable — the in-memory buffer is still intact.
  }
}

function scheduleFlush(): void {
  if (typeof localStorage === "undefined") return;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDrafts();
  }, DRAFT_FLUSH_MS);
}

function bump(): void {
  // A new Map identity per change: `useDirtyKeys` snapshots a derived string,
  // and `useEditorState` snapshots the per-key object, so subscribers still
  // re-render only when what they read actually moved.
  cachedDirtyKeys = null;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(key: string, next: EditorState | null): void {
  const prev = states.get(key) ?? null;
  if (prev === next) return;
  states = new Map(states);
  if (next === null) states.delete(key);
  else states.set(key, next);
  bump();
  scheduleFlush();
}

/** THE key for an artifact's buffer — `artifactIdentity`, the same string the
 *  panel strip, the pins sidecars and the per-doc zoom key use. A repo file and
 *  a KB doc can share a relative path; a path key would let one document's
 *  buffer follow you to a different document. */
export function editorKey(artifact: FileArtifact): string {
  return artifactIdentity(artifact);
}

export function getEditorState(key: string): EditorState | null {
  return states.get(key) ?? null;
}

/** Reconcile an open buffer against the host's freshly-read disk content.
 *  Called by the editing surface whenever `content` changes — which, for a KB
 *  doc, is every poll tick that actually moved.
 *
 *  No state for this key = nothing to reconcile. That is deliberate: reading a
 *  markdown doc must not allocate an editor record for it, so the store holds
 *  only documents you have actually opened for editing (or have a restored
 *  draft for). */
export function noteDisk(key: string, disk: string): void {
  const prev = states.get(key);
  if (!prev) return;
  commit(key, foldDisk(prev, disk));
}

/** Turn the edit surface ON. Forks from the disk content the host currently
 *  holds when there is no buffer yet; an existing buffer (a draft, or a
 *  toggle-off/toggle-on) is preserved untouched. */
export function beginEdit(key: string, disk: string): void {
  const prev = states.get(key);
  commit(key, prev ? { ...prev, editing: true } : newEditorState(disk, true));
}

/** Turn the edit surface OFF. A CLEAN buffer is forgotten entirely (it is just
 *  the file); a DIRTY one is kept as a draft — rule 4. */
export function endEdit(key: string): void {
  const prev = states.get(key);
  if (!prev) return;
  commit(key, isDirty(prev) ? { ...prev, editing: false } : null);
}

/** Throw the buffer away. The ONE path that loses typed text, and it is always
 *  a button the user pressed. */
export function discardDraft(key: string): void {
  commit(key, null);
}

export function setBuffer(key: string, buffer: string): void {
  const prev = states.get(key);
  if (!prev || prev.buffer === buffer) return;
  // Typing clears a stale save error — the message described the write that
  // failed, not the text now in the box.
  commit(key, { ...prev, buffer, error: null });
}

export function resolveConflict(key: string, choice: "mine" | "theirs"): void {
  const prev = states.get(key);
  if (!prev) return;
  commit(key, resolveWith(prev, choice));
}

/**
 * SAVE. The read-then-compare-then-write shape is the whole point: it is the
 * only way a REPO file — whose host does one-shot reads and never polls — can
 * discover an external change before clobbering it. A KB doc reaches the same
 * verdict earlier through `foldDisk`; this is the backstop for both.
 *
 * Honest limit: between the read and the write there is a window in which an
 * agent could land a change we then overwrite. It is milliseconds against an
 * agent that writes whole files at human-visible intervals, and closing it
 * properly needs file locking the platform does not offer through this stack.
 * The failure mode is recoverable in both places we write (git for repos, the
 * KB checkout for docs); silent loss of the BUFFER is not, which is why rule 3
 * outranks it.
 */
export async function saveBuffer(key: string, artifact: FileArtifact): Promise<void> {
  const start = states.get(key);
  if (!start || start.saving) return;
  // A pending conflict must be resolved first — saving through it is exactly
  // the silent clobber rule 2 forbids.
  if (start.conflict !== null) return;
  if (!isDirty(start)) return;

  const snapshot = start.buffer;
  commit(key, { ...start, saving: true, error: null });

  try {
    const disk = await io.read(artifact);
    const current = states.get(key);
    if (!current) return; // discarded mid-save
    if (disk !== current.baseline) {
      commit(key, { ...current, saving: false, conflict: disk });
      return;
    }
    await io.write(artifact, snapshot);
    const after = states.get(key);
    if (!after) return;
    // baseline := the bytes we WROTE, not the bytes in the box: typing during
    // the round trip must stay dirty rather than be silently marked saved.
    commit(key, { ...after, saving: false, baseline: snapshot, error: null, savedAt: Date.now() });
  } catch (e) {
    const after = states.get(key);
    if (!after) return;
    // Rule 3: the buffer is untouched, the error rides alongside it.
    commit(key, { ...after, saving: false, error: String(e) });
  }
}

// ── Selectors + hooks ────────────────────────────────────────────────────────

let cachedDirtyKeys: string | null = null;

/** A stable snapshot of WHICH documents are dirty — a sorted, joined string, so
 *  a subscriber (the panel tab strip, the tab bar) re-renders when the SET
 *  changes and not on every keystroke inside one buffer. Same narrow-selector
 *  trick `panelStore` uses for the popped-out identity. */
export function dirtyKeysSnapshot(): string {
  if (cachedDirtyKeys === null) {
    const keys: string[] = [];
    for (const [key, state] of states) {
      if (isDirty(state)) keys.push(key);
    }
    keys.sort();
    cachedDirtyKeys = keys.join("\n");
  }
  return cachedDirtyKeys;
}

/** How many documents hold unsaved work. Used by the close dialog, which has to
 *  SAY that they are preserved. */
export function dirtyCount(): number {
  const snapshot = dirtyKeysSnapshot();
  return snapshot.length === 0 ? 0 : snapshot.split("\n").length;
}

export function isDirtyKey(key: string): boolean {
  return isDirty(states.get(key));
}

/** React hook: this document's buffer, re-rendering on every change to it. Only
 *  the editing surface itself wants this granularity. */
export function useEditorState(key: string): EditorState | null {
  return useSyncExternalStore(subscribe, () => states.get(key) ?? null);
}

/** React hook: is THIS document dirty? A boolean snapshot — a tab re-renders
 *  when its own dot appears or disappears and never for another document's
 *  typing. */
export function useIsDirty(key: string): boolean {
  return useSyncExternalStore(subscribe, () => isDirty(states.get(key)));
}

/** React hook: does this document have an open buffer at all (being edited, or
 *  holding a draft)?
 *
 *  It exists for the HOSTS, and for one reason: a repo file's host does a
 *  ONE-SHOT read and has never polled, so with a dirty buffer an agent's write
 *  would go unnoticed until the save-time re-read caught it. A buffer open on
 *  the document is exactly when a re-read earns its cost, so the host turns its
 *  poll ON for the duration and off again after. A KB doc already polls and
 *  ignores this. Boolean snapshot — no re-render on typing. */
export function useHasBuffer(key: string): boolean {
  return useSyncExternalStore(subscribe, () => states.has(key));
}

/** React hook: the dirty SET, as a string snapshot. */
export function useDirtyKeys(): string {
  return useSyncExternalStore(subscribe, dirtyKeysSnapshot);
}

/** Test-only: reset the store (and the persisted mirror). */
export function __resetEditorForTests(): void {
  states = new Map();
  cachedDirtyKeys = null;
  listeners.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(DRAFTS_KEY);
    } catch {
      /* ignore */
    }
  }
}

/** Test-only: seed the store from a drafts blob, exercising the restore path. */
export function __restoreDraftsForTests(raw: string | null): void {
  states = parseDrafts(raw);
  cachedDirtyKeys = null;
}
