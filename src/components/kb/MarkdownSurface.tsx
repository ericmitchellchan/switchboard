// THE MARKDOWN SURFACE (increment G) — view ⇄ edit on one surface, for every
// host that shows a markdown document.
//
// It sits between ArtifactBody's kind switch and `MarkdownDoc`, so the edit
// affordance appears in the artifact PANEL, on the full-width KB screen, on the
// Explorer screen and in the floating PiP window without any of them knowing
// about it — the same reason the kind switch exists at all. What lives here:
//
//   · the toolbar (edit toggle · dirty indicator · save · error),
//   · the CONFLICT BANNER — "this file changed on disk", keep-mine /
//     take-theirs — which is the whole point of the increment,
//   · a plain mono <textarea>.
//
// TOGGLE, NOT SPLIT PREVIEW (Decision 3): at a 420px panel a side-by-side
// halves an already narrow column, and a mode that behaves differently
// depending on which surface hosts it is its own confusion.
//
// PLAIN TEXTAREA, deliberately (non-goals): no CodeMirror, no Monaco, no syntax
// highlighting, no WYSIWYG. Tab inserts two spaces and Ctrl+S saves; everything
// else — selection, undo, multi-line, and dictation via paste — is the
// browser's, exactly as it is for the composer, and for the same reason (an
// `onPaste` handler is what re-creates the double-insert bug).
//
// ALL the buffer/conflict/draft RULES live in lib/editor.ts, pure and tested.
// This file draws them.

import { useCallback, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { FileArtifact } from "../../types";
import {
  beginEdit,
  discardDraft,
  editorKey,
  endEdit,
  isDirty,
  insertTab,
  noteDisk,
  resolveConflict,
  saveBuffer,
  setBuffer,
  useEditorState,
} from "../../lib/editor";
import { Icon } from "../icons";
import { MarkdownDoc } from "./MarkdownDoc";

const BAR_STYLE: CSSProperties = {
  height: 24,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "0 8px 0 12px",
  borderBottom: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  color: "var(--text-dim)",
  // Transparent, like every other body in this tree: the panel paints
  // --bg-panel and the full-width screens paint --bg-primary, and a surface of
  // our own would punch a hole in one of them.
  background: "transparent",
  whiteSpace: "nowrap",
  overflow: "hidden",
};

const ACTION_STYLE: CSSProperties = {
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 4,
  background: "none",
  border: "none",
  padding: "0 3px",
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  lineHeight: 1,
  color: "var(--text-dim)",
  cursor: "pointer",
};

/** The dirty mark. One dot, `--text-muted` — functional, no new hue (the soft
 *  palette keeps colour for status). The panel tab strip draws the same dot
 *  from the same predicate. */
function DirtyDot() {
  return (
    <span
      aria-label="unsaved changes"
      title="Unsaved changes"
      style={{
        flex: "none",
        width: 5,
        height: 5,
        borderRadius: "50%",
        background: "var(--text-muted)",
      }}
    />
  );
}

export function MarkdownSurface({
  artifact,
  content,
  onReload,
}: {
  artifact: FileArtifact;
  /** The document's CURRENT DISK text — the host owns loading policy. */
  content: string;
  /** Force the host's read NOW. Used after a successful save so the rendered
   *  view reflects what just landed without waiting for the poll (and so a repo
   *  file, whose host never polls, refreshes at all). */
  onReload?: () => void;
}) {
  const key = editorKey(artifact);
  const state = useEditorState(key);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reconcile the buffer against what the host just read. THE rule (never
  // silently overwrite in either direction) is `editor.foldDisk`; this is only
  // the trigger. A no-op when nothing is open for this document.
  useEffect(() => {
    noteDisk(key, content);
  }, [key, content]);

  const dirty = isDirty(state);
  const editing = !!state?.editing;
  const conflict = state?.conflict ?? null;

  const save = useCallback(() => {
    void saveBuffer(key, artifact).then(() => {
      // The write may have landed — pull it back through the host's own read so
      // the rendered view and the buffer agree. Unchanged content folds to a
      // no-op re-render on both sides.
      onReload?.();
    });
  }, [key, artifact, onReload]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // Stop it reaching the window handler: Ctrl+Shift+S is export, and a
        // future Ctrl+S binding must not fire behind an editor that owns it.
        e.stopPropagation();
        save();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const el = e.currentTarget;
        const { value, caret } = insertTab(el.value, el.selectionStart, el.selectionEnd);
        setBuffer(key, value);
        // The value is controlled by the store, so React repaints it on the
        // next commit and would put the caret at the end. Restore it after.
        requestAnimationFrame(() => {
          el.setSelectionRange(caret, caret);
        });
      }
    },
    [key, save]
  );

  // Focus the box when the surface opens — a toggle that needs a second click
  // to type into is a toggle that did half its job.
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  return (
    // `height: 100%` + `overflow: hidden`, not `flex: 1`: every host wraps this
    // in its own `overflowY: auto` scroller (DocView's, the Explorer screen's,
    // ArtifactSurface's), and a toolbar that scrolls away with the document is
    // a toolbar you cannot reach mid-file. Filling the scroller exactly means
    // the BODY below scrolls and the chrome stays put.
    <div
      style={{
        flex: 1,
        minWidth: 0,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={BAR_STYLE}>
        <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
          {dirty && <DirtyDot />}
          {state?.error ? (
            // A FAILED WRITE KEEPS THE BUFFER and says why — never a silent
            // loss (editor.ts rule 3). Status red, the one place colour is
            // functional here.
            <span
              title={state.error}
              style={{ color: "var(--accent-red)", overflow: "hidden", textOverflow: "ellipsis" }}
            >
              save failed: {state.error}
            </span>
          ) : state?.saving ? (
            <span>saving…</span>
          ) : dirty ? (
            <span>unsaved — Ctrl+S to save</span>
          ) : editing ? (
            <span style={{ color: "var(--text-faint)" }}>editing</span>
          ) : null}
        </span>

        {editing && (
          <button
            type="button"
            onClick={save}
            disabled={!dirty || state?.saving || conflict !== null}
            title={
              conflict !== null
                ? "Resolve the change on disk first"
                : dirty
                  ? "Save (Ctrl+S)"
                  : "Nothing to save"
            }
            style={{
              ...ACTION_STYLE,
              opacity: dirty && !state?.saving && conflict === null ? 1 : 0.35,
              cursor: dirty && conflict === null ? "pointer" : "default",
            }}
            onMouseEnter={(e) => {
              if (dirty && conflict === null) e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
          >
            <Icon name="save" size={11} />
            save
          </button>
        )}
        <button
          type="button"
          onClick={() => (editing ? endEdit(key) : beginEdit(key, content))}
          title={editing ? "Back to the rendered view (unsaved text is kept)" : "Edit this document"}
          aria-pressed={editing}
          style={{ ...ACTION_STYLE, color: editing ? "var(--text-primary)" : "var(--text-dim)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
          onMouseLeave={(e) =>
            (e.currentTarget.style.color = editing ? "var(--text-primary)" : "var(--text-dim)")
          }
        >
          <Icon name="edit" size={11} />
          {editing ? "done" : "edit"}
        </button>
      </div>

      {conflict !== null && (
        <ConflictBanner
          onKeepMine={() => resolveConflict(key, "mine")}
          onTakeTheirs={() => {
            resolveConflict(key, "theirs");
            onReload?.();
          }}
        />
      )}

      {/* A DIRTY buffer with the editor toggled OFF still exists — say so and
          offer the two ways out, rather than leaving invisible unsaved work
          behind a rendered view that does not contain it. */}
      {!editing && dirty && (
        <div style={{ ...BAR_STYLE, height: "auto", padding: "5px 8px 5px 12px", whiteSpace: "normal" }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            you have unsaved edits to this document (kept as a draft)
          </span>
          <button
            type="button"
            onClick={() => beginEdit(key, content)}
            style={{ ...ACTION_STYLE, color: "var(--text-secondary)" }}
          >
            resume
          </button>
          <button
            type="button"
            onClick={() => discardDraft(key)}
            title="Throw the unsaved edits away"
            style={ACTION_STYLE}
          >
            discard
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: "flex", overflowY: editing ? "hidden" : "auto" }}>
        {editing && state ? (
          <textarea
            ref={textareaRef}
            value={state.buffer}
            onChange={(e) => setBuffer(key, e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            wrap="off"
            aria-label={`Edit ${artifact.path}`}
            style={{
              flex: 1,
              minWidth: 0,
              // Matches MarkdownDoc's own metrics (12px / 1.7 / 18px 24px) so
              // toggling does not reflow the page under the cursor.
              padding: "18px 24px 48px",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.7,
              color: "var(--text-secondary)",
              background: "transparent",
              border: "none",
              outline: "none",
              resize: "none",
              overflow: "auto",
              whiteSpace: "pre",
              tabSize: 2,
            }}
          />
        ) : (
          <div style={{ flex: 1, minWidth: 0 }}>
            <MarkdownDoc content={content} />
          </div>
        )}
      </div>
    </div>
  );
}

/** "This file changed on disk." No auto-merge, no diff UI beyond the two
 *  buttons — one human and one agent writing a file do not need a three-way
 *  merge, they need to not lose each other's work. */
function ConflictBanner({
  onKeepMine,
  onTakeTheirs,
}: {
  onKeepMine: () => void;
  onTakeTheirs: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px 6px 12px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-active)",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        color: "var(--text-secondary)",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>this file changed on disk</span>
      <button
        type="button"
        onClick={onKeepMine}
        title="Keep your buffer; the next save overwrites the version on disk"
        style={{ ...ACTION_STYLE, color: "var(--text-secondary)" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
      >
        keep mine
      </button>
      <button
        type="button"
        onClick={onTakeTheirs}
        title="Replace your buffer with the version on disk"
        style={{ ...ACTION_STYLE, color: "var(--text-secondary)" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
      >
        take theirs
      </button>
    </div>
  );
}
