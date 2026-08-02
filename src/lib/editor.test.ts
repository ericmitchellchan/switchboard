// Tests for the markdown edit buffer (increment G) — the four rules from
// editor.ts's header, each asserted where it lives:
//
//   1. explicit save            → saveBuffer is the only writer
//   2. never silently overwrite → foldDisk + the save-time re-read
//   3. a failed write keeps the buffer
//   4. the buffer outlives everything short of an explicit discard
//
// Vitest runs in a Node environment (no localStorage), so the draft MIRROR is
// exercised through its pure codec (serializeDrafts / parseDrafts) plus the
// restore seam, rather than through the browser API the store guards on.

import { describe, it, expect, beforeEach } from "vitest";
import type { FileArtifact } from "../types";
import {
  __resetEditorForTests,
  __restoreDraftsForTests,
  __setEditorIoForTests,
  beginEdit,
  dirtyCount,
  dirtyKeysSnapshot,
  discardDraft,
  editorKey,
  endEdit,
  foldDisk,
  getEditorState,
  insertTab,
  isDirty,
  isDirtyKey,
  isEditable,
  newEditorState,
  noteDisk,
  parseDrafts,
  resolveConflict,
  resolveWith,
  saveBuffer,
  serializeDrafts,
  setBuffer,
  TAB_SPACES,
  type EditorState,
} from "./editor";

const KB_DOC: FileArtifact = { kind: "kb-doc", path: "switchboard/spec.md" };
const REPO_DOC: FileArtifact = { kind: "repo-file", project: "lodestar", path: "specs/plan.md" };

/** A state in an explicit shape, so each test says what it is testing. */
function state(over: Partial<EditorState> = {}): EditorState {
  return { ...newEditorState("disk", true), ...over };
}

describe("isEditable — markdown only, file-backed only", () => {
  it("accepts markdown KB docs and repo files", () => {
    expect(isEditable(KB_DOC)).toBe(true);
    expect(isEditable(REPO_DOC)).toBe(true);
    expect(isEditable({ kind: "repo-file", path: "README.MD" })).toBe(true);
  });

  it("rejects every read-only kind (non-goal: wireframes/diagrams/code stay read-only)", () => {
    expect(isEditable({ kind: "kb-doc", path: "design/mock.html" })).toBe(false);
    expect(isEditable({ kind: "kb-doc", path: "arch/flow.mmd" })).toBe(false);
    expect(isEditable({ kind: "repo-file", path: "src/App.tsx" })).toBe(false);
    expect(isEditable({ kind: "repo-file", path: "package.json" })).toBe(false);
    expect(isEditable({ kind: "repo-file", path: "Makefile" })).toBe(false);
  });

  it("rejects a live preview, which is not file-backed at all", () => {
    expect(isEditable({ kind: "localhost", path: undefined })).toBe(false);
  });
});

describe("isDirty", () => {
  it("is false for a fresh fork and for no state at all", () => {
    expect(isDirty(newEditorState("x", true))).toBe(false);
    expect(isDirty(null)).toBe(false);
    expect(isDirty(undefined)).toBe(false);
  });

  it("is true the moment the buffer diverges from the baseline", () => {
    expect(isDirty(state({ baseline: "a", buffer: "b" }))).toBe(true);
  });
});

describe("foldDisk — RULE 2: never silently overwrite, in either direction", () => {
  it("returns the PREVIOUS OBJECT when the file has not moved (poll costs no re-render)", () => {
    const prev = state({ baseline: "a", buffer: "a" });
    expect(foldDisk(prev, "a")).toBe(prev);
    const dirty = state({ baseline: "a", buffer: "mine" });
    expect(foldDisk(dirty, "a")).toBe(dirty);
  });

  it("a CLEAN buffer follows the file (the agent-picks-up-your-work loop)", () => {
    const next = foldDisk(state({ baseline: "a", buffer: "a" }), "agent wrote this");
    expect(next.baseline).toBe("agent wrote this");
    expect(next.buffer).toBe("agent wrote this");
    expect(next.conflict).toBeNull();
    expect(isDirty(next)).toBe(false);
  });

  it("a DIRTY buffer raises a CONFLICT and is not touched", () => {
    const next = foldDisk(state({ baseline: "a", buffer: "mine" }), "theirs");
    expect(next.buffer).toBe("mine"); // untouched
    expect(next.baseline).toBe("a"); // still what we forked from
    expect(next.conflict).toBe("theirs");
  });

  it("does not re-raise a conflict for the same disk content (a 2.5s poll repeats it)", () => {
    const raised = foldDisk(state({ baseline: "a", buffer: "mine" }), "theirs");
    expect(foldDisk(raised, "theirs")).toBe(raised);
  });

  it("moves the conflict on when the file changes AGAIN — take-theirs must mean NOW", () => {
    const raised = foldDisk(state({ baseline: "a", buffer: "mine" }), "theirs v1");
    const moved = foldDisk(raised, "theirs v2");
    expect(moved.conflict).toBe("theirs v2");
    expect(moved.buffer).toBe("mine");
  });

  it("clears the conflict when the file comes back to what we forked from", () => {
    const raised = foldDisk(state({ baseline: "a", buffer: "mine" }), "theirs");
    const undone = foldDisk(raised, "a");
    expect(undone.conflict).toBeNull();
    expect(undone.buffer).toBe("mine");
    expect(undone.baseline).toBe("a");
  });

  it("a buffer that becomes clean again drops a pending conflict and adopts the file", () => {
    const raised = foldDisk(state({ baseline: "a", buffer: "mine" }), "theirs");
    // The user undid their edit by hand: buffer === baseline again.
    const clean = { ...raised, buffer: raised.baseline };
    const next = foldDisk(clean, "theirs");
    expect(next.conflict).toBeNull();
    expect(next.buffer).toBe("theirs");
    expect(next.baseline).toBe("theirs");
  });
});

describe("resolveWith — the two ways out, neither of them silent", () => {
  it("keep-mine keeps the buffer and re-forks from their version", () => {
    const raised = foldDisk(state({ baseline: "a", buffer: "mine" }), "theirs");
    const next = resolveWith(raised, "mine");
    expect(next.buffer).toBe("mine");
    expect(next.baseline).toBe("theirs"); // next save is a deliberate overwrite
    expect(next.conflict).toBeNull();
    expect(isDirty(next)).toBe(true);
  });

  it("take-theirs replaces the buffer and leaves it CLEAN", () => {
    const raised = foldDisk(state({ baseline: "a", buffer: "mine" }), "theirs");
    const next = resolveWith(raised, "theirs");
    expect(next.buffer).toBe("theirs");
    expect(next.baseline).toBe("theirs");
    expect(next.conflict).toBeNull();
    expect(isDirty(next)).toBe(false);
  });

  it("is a no-op with no conflict pending", () => {
    const prev = state({ baseline: "a", buffer: "mine" });
    expect(resolveWith(prev, "mine")).toBe(prev);
    expect(resolveWith(prev, "theirs")).toBe(prev);
  });
});

describe("insertTab", () => {
  it("inserts two spaces at the caret", () => {
    expect(insertTab("ab", 1, 1)).toEqual({ value: `a${TAB_SPACES}b`, caret: 3 });
  });

  it("replaces a selection", () => {
    expect(insertTab("abcd", 1, 3)).toEqual({ value: `a${TAB_SPACES}d`, caret: 3 });
  });

  it("works at both ends", () => {
    expect(insertTab("x", 0, 0).value).toBe(`${TAB_SPACES}x`);
    expect(insertTab("x", 1, 1).value).toBe(`x${TAB_SPACES}`);
  });
});

describe("draft codec (acceptance 6)", () => {
  it("persists only DIRTY buffers — a clean one is just the file", () => {
    const map = new Map<string, EditorState>([
      ["kb-doc:a.md", state({ baseline: "a", buffer: "mine" })],
      ["kb-doc:b.md", state({ baseline: "b", buffer: "b" })],
    ]);
    const parsed = parseDrafts(serializeDrafts(map));
    expect([...parsed.keys()]).toEqual(["kb-doc:a.md"]);
    expect(parsed.get("kb-doc:a.md")?.buffer).toBe("mine");
    expect(parsed.get("kb-doc:a.md")?.baseline).toBe("a");
  });

  it("round-trips the editing flag", () => {
    const map = new Map<string, EditorState>([
      ["k", state({ baseline: "a", buffer: "mine", editing: false })],
    ]);
    expect(parseDrafts(serializeDrafts(map)).get("k")?.editing).toBe(false);
  });

  it("restores transient fields blank — a conflict is re-derived from the file", () => {
    const map = new Map<string, EditorState>([
      [
        "k",
        state({ baseline: "a", buffer: "mine", conflict: "theirs", error: "boom", saving: true }),
      ],
    ]);
    const restored = parseDrafts(serializeDrafts(map)).get("k")!;
    expect(restored.conflict).toBeNull();
    expect(restored.error).toBeNull();
    expect(restored.saving).toBe(false);
  });

  it("is tolerant: junk, wrong version and malformed entries yield no drafts", () => {
    expect(parseDrafts(null).size).toBe(0);
    expect(parseDrafts("").size).toBe(0);
    expect(parseDrafts("{not json").size).toBe(0);
    expect(parseDrafts(JSON.stringify({ v: 99, drafts: { k: { baseline: "a", buffer: "b" } } })).size).toBe(0);
    expect(parseDrafts(JSON.stringify({ v: 1, drafts: null })).size).toBe(0);
    expect(parseDrafts(JSON.stringify({ v: 1, drafts: { k: { baseline: 1, buffer: "b" } } })).size).toBe(0);
    // Not dirty → not a draft.
    expect(parseDrafts(JSON.stringify({ v: 1, drafts: { k: { baseline: "a", buffer: "a" } } })).size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

describe("editor store", () => {
  const KEY = editorKey(KB_DOC);
  let reads: string[];
  let writes: Array<{ artifact: FileArtifact; content: string }>;
  let diskContent: string;
  let readError: string | null;
  let writeError: string | null;

  beforeEach(() => {
    __resetEditorForTests();
    reads = [];
    writes = [];
    diskContent = "# on disk";
    readError = null;
    writeError = null;
    __setEditorIoForTests({
      read: async (artifact) => {
        reads.push(artifact.path);
        if (readError) throw new Error(readError);
        return diskContent;
      },
      write: async (artifact, content) => {
        writes.push({ artifact, content });
        if (writeError) throw new Error(writeError);
        diskContent = content;
      },
    });
  });

  it("editorKey is the artifact identity, so a repo file and a KB doc never share a buffer", () => {
    expect(editorKey(KB_DOC)).toBe("kb-doc:switchboard/spec.md");
    expect(editorKey({ kind: "repo-file", project: "p", path: "switchboard/spec.md" })).toBe(
      "repo-file:p:switchboard/spec.md"
    );
    expect(editorKey(KB_DOC)).not.toBe(
      editorKey({ kind: "repo-file", project: "p", path: "switchboard/spec.md" })
    );
  });

  it("reading a doc allocates nothing — only beginEdit does", () => {
    noteDisk(KEY, "# on disk");
    expect(getEditorState(KEY)).toBeNull();
    beginEdit(KEY, "# on disk");
    expect(getEditorState(KEY)?.editing).toBe(true);
  });

  it("beginEdit forks from disk; setBuffer makes it dirty", () => {
    beginEdit(KEY, "# on disk");
    expect(isDirtyKey(KEY)).toBe(false);
    setBuffer(KEY, "# edited");
    expect(isDirtyKey(KEY)).toBe(true);
    expect(getEditorState(KEY)?.baseline).toBe("# on disk");
  });

  it("RULE 4: toggling edit off keeps a DIRTY buffer and forgets a CLEAN one", () => {
    beginEdit(KEY, "a");
    endEdit(KEY);
    expect(getEditorState(KEY)).toBeNull();

    beginEdit(KEY, "a");
    setBuffer(KEY, "mine");
    endEdit(KEY);
    expect(getEditorState(KEY)?.buffer).toBe("mine");
    expect(getEditorState(KEY)?.editing).toBe(false);
    // …and turning it back on does NOT re-fork from disk.
    beginEdit(KEY, "something else entirely");
    expect(getEditorState(KEY)?.buffer).toBe("mine");
    expect(getEditorState(KEY)?.baseline).toBe("a");
  });

  it("discardDraft is the ONE path that loses typed text", () => {
    beginEdit(KEY, "a");
    setBuffer(KEY, "mine");
    discardDraft(KEY);
    expect(getEditorState(KEY)).toBeNull();
    expect(isDirtyKey(KEY)).toBe(false);
  });

  it("RULE 1: a save writes exactly once, and only what the buffer holds", async () => {
    beginEdit(KEY, "# on disk");
    setBuffer(KEY, "# edited");
    await saveBuffer(KEY, KB_DOC);
    expect(writes).toEqual([{ artifact: KB_DOC, content: "# edited" }]);
    expect(diskContent).toBe("# edited");
    expect(isDirtyKey(KEY)).toBe(false);
    expect(getEditorState(KEY)?.baseline).toBe("# edited");
    expect(getEditorState(KEY)?.savedAt).not.toBeNull();
  });

  it("a clean buffer saves nothing", async () => {
    beginEdit(KEY, "# on disk");
    await saveBuffer(KEY, KB_DOC);
    expect(writes).toHaveLength(0);
    expect(reads).toHaveLength(0);
  });

  it("RULE 2 at save time: an external change becomes a CONFLICT, and nothing is written", async () => {
    beginEdit(KEY, "# on disk");
    setBuffer(KEY, "# mine");
    // The agent wrote between the fork and the save. A repo file's host does
    // not poll, so this re-read is the only place it can be noticed.
    diskContent = "# theirs";
    await saveBuffer(KEY, KB_DOC);
    expect(writes).toHaveLength(0);
    expect(diskContent).toBe("# theirs");
    expect(getEditorState(KEY)?.conflict).toBe("# theirs");
    expect(getEditorState(KEY)?.buffer).toBe("# mine");
  });

  it("saving THROUGH a pending conflict is refused — it routes through the banner", async () => {
    beginEdit(KEY, "# on disk");
    setBuffer(KEY, "# mine");
    noteDisk(KEY, "# theirs");
    expect(getEditorState(KEY)?.conflict).toBe("# theirs");
    await saveBuffer(KEY, KB_DOC);
    expect(writes).toHaveLength(0);
    expect(reads).toHaveLength(0);
  });

  it("keep-mine then save overwrites deliberately; take-theirs leaves nothing to save", async () => {
    beginEdit(KEY, "# on disk");
    setBuffer(KEY, "# mine");
    diskContent = "# theirs"; // the agent wrote
    noteDisk(KEY, "# theirs");
    resolveConflict(KEY, "mine");
    await saveBuffer(KEY, KB_DOC);
    expect(writes).toEqual([{ artifact: KB_DOC, content: "# mine" }]);

    __resetEditorForTests();
    diskContent = "# on disk";
    writes.length = 0;
    beginEdit(KEY, "# on disk");
    setBuffer(KEY, "# mine");
    diskContent = "# theirs";
    noteDisk(KEY, "# theirs");
    resolveConflict(KEY, "theirs");
    expect(getEditorState(KEY)?.buffer).toBe("# theirs");
    await saveBuffer(KEY, KB_DOC);
    expect(writes).toHaveLength(0);
  });

  it("RULE 3: a failed WRITE keeps the buffer and surfaces the error", async () => {
    beginEdit(KEY, "# on disk"); // matches the fake disk
    setBuffer(KEY, "# mine");
    writeError = "Access is denied. (os error 5)";
    await saveBuffer(KEY, KB_DOC);
    const s = getEditorState(KEY)!;
    expect(s.buffer).toBe("# mine");
    expect(s.baseline).toBe("# on disk");
    expect(isDirty(s)).toBe(true);
    expect(s.error).toContain("Access is denied");
    expect(s.saving).toBe(false);
  });

  it("RULE 3: a failed pre-save READ also keeps the buffer", async () => {
    beginEdit(KEY, "# on disk");
    setBuffer(KEY, "# mine");
    readError = "cannot read";
    await saveBuffer(KEY, KB_DOC);
    expect(writes).toHaveLength(0);
    expect(getEditorState(KEY)?.buffer).toBe("# mine");
    expect(getEditorState(KEY)?.error).toContain("cannot read");
  });

  it("typing clears a stale save error", async () => {
    diskContent = "a";
    beginEdit(KEY, "a");
    setBuffer(KEY, "mine");
    writeError = "boom";
    await saveBuffer(KEY, KB_DOC);
    expect(getEditorState(KEY)?.error).not.toBeNull();
    setBuffer(KEY, "mine, edited");
    expect(getEditorState(KEY)?.error).toBeNull();
  });

  it("typing DURING a save leaves the buffer dirty against what was written", async () => {
    diskContent = "a";
    beginEdit(KEY, "a");
    setBuffer(KEY, "first");
    const pending = saveBuffer(KEY, KB_DOC);
    // The read is in flight; keep typing.
    setBuffer(KEY, "first and more");
    await pending;
    expect(writes).toEqual([{ artifact: KB_DOC, content: "first" }]);
    const s = getEditorState(KEY)!;
    expect(s.baseline).toBe("first"); // the bytes we actually wrote
    expect(s.buffer).toBe("first and more");
    expect(isDirty(s)).toBe(true); // still unsaved work, correctly
  });

  it("a second save while one is in flight is refused (no double read-then-write)", async () => {
    diskContent = "a";
    beginEdit(KEY, "a");
    setBuffer(KEY, "mine");
    const first = saveBuffer(KEY, KB_DOC);
    await saveBuffer(KEY, KB_DOC);
    await first;
    expect(writes).toHaveLength(1);
  });

  it("a buffer discarded mid-save does not resurrect", async () => {
    diskContent = "a";
    beginEdit(KEY, "a");
    setBuffer(KEY, "mine");
    const pending = saveBuffer(KEY, KB_DOC);
    discardDraft(KEY);
    await pending;
    expect(getEditorState(KEY)).toBeNull();
  });

  it("routes a repo file through the repo write, not the KB one", async () => {
    const key = editorKey(REPO_DOC);
    beginEdit(key, "# on disk");
    setBuffer(key, "# edited");
    await saveBuffer(key, REPO_DOC);
    expect(writes).toEqual([{ artifact: REPO_DOC, content: "# edited" }]);
  });

  it("dirty selectors describe the SET, not one buffer", () => {
    const repoKey = editorKey(REPO_DOC);
    expect(dirtyCount()).toBe(0);
    expect(dirtyKeysSnapshot()).toBe("");
    beginEdit(KEY, "a");
    beginEdit(repoKey, "b");
    expect(dirtyCount()).toBe(0); // open, but clean
    setBuffer(KEY, "mine");
    expect(dirtyCount()).toBe(1);
    expect(isDirtyKey(KEY)).toBe(true);
    expect(isDirtyKey(repoKey)).toBe(false);
    setBuffer(repoKey, "also mine");
    expect(dirtyKeysSnapshot().split("\n").sort()).toEqual([KEY, repoKey].sort());
  });

  it("a restored draft comes back dirty, and folds against the CURRENT file", () => {
    const blob = JSON.stringify({
      v: 1,
      drafts: { [KEY]: { baseline: "# on disk", buffer: "# mine", editing: true } },
    });
    __restoreDraftsForTests(blob);
    expect(isDirtyKey(KEY)).toBe(true);

    // Restart case A: the file is where we left it → no conflict.
    noteDisk(KEY, "# on disk");
    expect(getEditorState(KEY)?.conflict).toBeNull();

    // Restart case B: the agent moved it while we were away → the banner, not
    // a silent clobber and not a silently discarded draft.
    noteDisk(KEY, "# theirs, written overnight");
    expect(getEditorState(KEY)?.conflict).toBe("# theirs, written overnight");
    expect(getEditorState(KEY)?.buffer).toBe("# mine");
  });

  it("noteDisk on a CLEAN open buffer keeps the poll flicker-free (no state churn)", () => {
    beginEdit(KEY, "a");
    const before = getEditorState(KEY);
    noteDisk(KEY, "a");
    expect(getEditorState(KEY)).toBe(before);
  });
});
