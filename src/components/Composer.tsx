// THE COMPOSER (increment D) — a prose input at the bottom of one terminal
// pane, addressing that pane's session.
//
// Scope, from Decision 3: this box handles PROSE. Ctrl+C, Esc, arrow-key TUI
// navigation and every other control character stay the terminal's job — click
// into it for those. Nothing here proxies a control character, and the wire
// format (lib/composer.composeWrite) strips them out of composed text rather
// than forwarding them.
//
// PASTE (the rule, revised for SWIT-59). Dictation is the motivating case:
// Wispr Flow injects by PASTING, and the browser's native paste into a
// textarea inserts the text exactly once. xterm's clipboard path needed
// explicit rules to avoid double-pasting precisely because it intercepts; a
// textarea that does not intercept has nothing to get wrong. So the ONE paste
// handler below is a CAPTURE-phase filter that acts on clipboard items whose
// `kind === "file"` ONLY (a screenshot, a copied PDF): those it stages as
// attachments and preventDefaults — nothing sensible could be inserted for a
// file anyway. A paste with no file item returns before touching the event,
// so plain text — dictation included — still reaches the textarea untouched
// and lands once. A MIXED clipboard (Excel-style: a `text/plain` item beside
// an image rendering of the same cells) is TEXT — files are attached only
// when there is no text item; otherwise the paste falls through whole. Do not
// widen it to text; do not add a second handler.
//
// Two paste routes end here. This handler sees every paste the WEBVIEW sees
// (right-click Paste, Shift+Insert). Ctrl+V does NOT reach it: the global
// hotkey (lib.rs, RegisterHotKey) consumes the keystroke before WebView2 and
// re-delivers the clipboard as an app event — text as `clipboard-paste`
// (App inserts it into the focused textarea), an image as
// `clipboard-paste-image` (App stages it for the composer whose textarea is
// focused, found by `data-composer-session`).
//
// ATTACHMENTS. Chips sit in a row ABOVE the textarea that exists only while
// there is at least one chip — never a permanent empty bar. Its appearance is
// a height change like the box growing: the pane's ResizeObserver → fitQueue
// → grow-only policy handle it, and the busy gate defers the refit while the
// agent is RUNNING. Nothing here resizes anything.

import { useCallback, useEffect, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { writeToSession } from "../lib/ipc";
import { getTerminal } from "../lib/terminal";
import { findThreadBySessionId, markChatStarted, getThreadActions } from "../lib/threadStore";
import { saveThreadsToDisk } from "../lib/workspace";
import { log } from "../lib/logger";
import {
  DRAFT_INDEX,
  attachmentAgentBlock,
  composeMessage,
  composeWrite,
  formatAttachmentSize,
  parseThreadPost,
  getComposerDraft,
  getSendHistory,
  hideComposer,
  recordSend,
  removeComposerAttachment,
  setComposerDraft,
  shouldNavigateHistory,
  stepHistory,
  useComposerAttachments,
} from "../lib/composer";
import { pickPastedFiles, stagePastedFiles, stagePaths } from "../lib/attachments";
import { useFileDropZone } from "../hooks/useFileDropZone";

// One line tall by default, growing to MAX_ROWS then scrolling (spec §Visual).
// The box's height is computed from these rather than measured from a rendered
// glyph, so the pane's height change is a single deterministic step.
const FONT_SIZE = 12;
const LINE_HEIGHT = 17;
const PAD_Y = 5;
const MAX_ROWS = 5;
const MIN_HEIGHT = LINE_HEIGHT + PAD_Y * 2;
const MAX_HEIGHT = LINE_HEIGHT * MAX_ROWS + PAD_Y * 2;

const HINT = "^C · Esc → terminal";
const HINT_TITLE =
  "The composer sends prose. Control keys — Ctrl+C, Esc, arrow-key navigation — belong to the terminal: click it to use them.";

export function Composer({ sessionId }: { sessionId: string }) {
  const [value, setValue] = useState(() => getComposerDraft(sessionId));
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachments = useComposerAttachments(sessionId);

  // Refs, not state, for everything an async send or a key handler reads: the
  // same stale-closure rule the PTY callbacks follow elsewhere in this app.
  const valueRef = useRef(value);
  valueRef.current = value;
  const inFlightRef = useRef(false);
  // DRAFT_INDEX while composing; an index into the send history while browsing
  // it with ↑/↓. `draftRef` holds what was in the box when browsing started so
  // ↓ can put it back.
  const historyIndexRef = useRef(DRAFT_INDEX);
  const draftRef = useRef("");

  // Drop a file anywhere on the composer to attach it (the webview drag-drop
  // event; HTML5 drop never fires under Tauri — see hooks/useFileDropZone).
  const drop = useFileDropZone<HTMLDivElement>((paths) => {
    stagePaths(sessionId, paths);
    setError(null);
    textareaRef.current?.focus();
  });

  // Auto-grow. Height is set imperatively (not via rows) so the box tracks
  // wrapped lines too. The pane's ResizeObserver sees the resulting container
  // height change and drives the EXISTING fit pipeline — grow-only policy,
  // debounce, settle pass — exactly as a divider drag does. There is no resize
  // logic here, and there must not be.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    const next = Math.min(Math.max(ta.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
    ta.style.height = `${next}px`;
    ta.style.overflowY = ta.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  // Stash the unsent draft on unmount. Panes are remounted by things that are
  // not "the user is done" — splitting, unsplitting, moving a tab — and losing
  // half a dictated message to a layout change would be the same class of bug
  // as swallowing a failed send. (Attachments need no stash: they live in the
  // store from the moment they are staged.)
  useEffect(() => {
    return () => {
      setComposerDraft(sessionId, valueRef.current);
    };
  }, [sessionId]);

  const send = useCallback(async () => {
    if (inFlightRef.current) return;
    const text = valueRef.current;
    const paths = attachments.map((a) => a.path);

    // `@thread …` (SWIT-52): a message addressed to ANOTHER thread. Resolved
    // + delivered by App through the actions bridge — nothing is typed into
    // THIS terminal, and a resolution failure keeps the text right here. The
    // Read block rides along: the paths are absolute, so the other thread's
    // agent can open them just the same.
    const post = parseThreadPost(text);
    if (post) {
      const actions = getThreadActions();
      if (!actions) return;
      inFlightRef.current = true;
      try {
        const confirmation = await actions.postToThread(
          sessionId,
          post.target,
          post.body + attachmentAgentBlock(paths)
        );
        setError(`→ ${confirmation}`);
        if (valueRef.current === text) {
          setValue("");
          setComposerDraft(sessionId, "");
        }
        for (const p of paths) removeComposerAttachment(sessionId, p);
        recordSend(sessionId, text);
        historyIndexRef.current = DRAFT_INDEX;
        draftRef.current = "";
      } catch (err) {
        setError(
          `@post failed: ${err instanceof Error ? err.message : String(err)} — your text is still here`
        );
      } finally {
        inFlightRef.current = false;
        textareaRef.current?.focus();
      }
      return;
    }

    const payload = composeWrite(composeMessage(text, paths));
    // Empty / whitespace-only and nothing attached: a no-op. Never a bare Enter.
    if (payload.length === 0) return;

    inFlightRef.current = true;
    try {
      await writeToSession(sessionId, payload);
    } catch (err) {
      // NEVER silently swallow a message: the text stays exactly where it is
      // and the failure is surfaced in the box's own hint slot.
      log.error(`Composer send failed session=${sessionId}: ${err}`);
      setError("Send failed — your text is still here. Retry, or type into the terminal.");
      inFlightRef.current = false;
      return;
    }
    inFlightRef.current = false;
    setError(null);
    recordSend(sessionId, text);
    historyIndexRef.current = DRAFT_INDEX;
    draftRef.current = "";
    // Clear only what we actually sent. The write is a round trip; anything
    // typed (or dictated) during it is a NEW draft and must survive. Chips are
    // cleared by PATH for the same reason — one staged mid-flight is the next
    // message's.
    if (valueRef.current === text) {
      setValue("");
      setComposerDraft(sessionId, "");
    }
    for (const p of paths) removeComposerAttachment(sessionId, p);
    textareaRef.current?.focus();

    // Decision 4 — chatStarted is marked EXPLICITLY here. `writeToSession`
    // bypasses the input detector on purpose (feeding IPC writes back in
    // re-opens the false-positive class T5 removed: a shell command typed after
    // Ctrl+C'ing claude would falsely mark the thread started). A composer send
    // is unambiguous user intent, so it sets the flag directly. The detector is
    // untouched — typing into the terminal still flips the flag through it.
    //
    // ONE HONEST GAP, and it is a HINT, not the T5 class: Ctrl+Shift+M can
    // force a composer onto a plain shell whose session is still BOUND to a
    // dead thread, and a send there marks that thread started even though the
    // text went to a shell prompt. Nothing downstream believes it — the revive
    // decision reads DISK GROUND TRUTH (claude_session_exists), which is
    // exactly why T5 demoted this field to a hint — but the row's chip can read
    // "resume" until the next launch re-syncs it. Gating on liveness would mean
    // re-deriving "is claude actually running" here, which is the detector this
    // path deliberately does not re-open. Left as-is, documented, and it
    // self-heals at the next launch.
    const thread = findThreadBySessionId(sessionId);
    if (thread && !thread.chatStarted) {
      log.info(`Composer send — chatStarted id=${thread.id}`);
      markChatStarted(thread.id);
      // Same critical-field flush as the detector path: losing chatStarted to a
      // crash inside the 30s periodic window would relaunch instead of resume.
      void saveThreadsToDisk();
    }
  }, [sessionId, attachments]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline (the default, so it falls
      // through untouched). An IME composition Enter is a candidate commit, not
      // a send.
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault();
        void send();
        return;
      }

      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const ta = e.currentTarget;
        const direction = e.key === "ArrowUp" ? "older" : "newer";
        if (
          !shouldNavigateHistory({
            direction,
            inHistory: historyIndexRef.current !== DRAFT_INDEX,
            value: ta.value,
            selectionStart: ta.selectionStart,
            selectionEnd: ta.selectionEnd,
          })
        ) {
          return; // the caret's arrow, not history's
        }
        const history = getSendHistory(sessionId);
        const next = stepHistory(history.length, historyIndexRef.current, direction);
        if (next === null) return; // nowhere to go — leave the key alone
        e.preventDefault();
        if (historyIndexRef.current === DRAFT_INDEX) draftRef.current = ta.value;
        historyIndexRef.current = next;
        const recalled = next === DRAFT_INDEX ? draftRef.current : history[next];
        setValue(recalled);
        // Caret to the end, like every shell's history recall. After the
        // controlled re-render, hence the frame delay.
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) el.setSelectionRange(el.value.length, el.value.length);
        });
        return;
      }

      if (e.key === "Escape") {
        // NOT proxied — nothing is written. Escape hands FOCUS back to the
        // terminal, which is where Escape actually means something (Decision 3).
        e.preventDefault();
        getTerminal(sessionId)?.terminal.focus();
      }
    },
    [send, sessionId]
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    // Editing ends history browsing and hands ↑/↓ back to the caret.
    historyIndexRef.current = DRAFT_INDEX;
    setError(null);
  }, []);

  // The file-only paste filter — see the header. Files are taken SYNCHRONOUSLY
  // (clipboardData is void after the first await) and the event is claimed
  // only when there is at least one AND no text item rides beside them; a
  // mixed clipboard is text and falls through untouched.
  const handlePasteCapture = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (items && Array.from(items).some((it) => it.kind === "string" && it.type === "text/plain")) return;
      const picked = pickPastedFiles(items);
      if (picked.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      void stagePastedFiles(sessionId, picked).then((result) => {
        if (result.error) {
          log.error(`Composer paste session=${sessionId}: ${result.error}`);
          setError(result.error);
        } else {
          setError(null);
        }
      });
    },
    [sessionId]
  );

  // `+` → the native file picker → chips by path. open() rejects when the
  // dialog permission is missing; that must not vanish into the click.
  // No extension filter: a filtered dialog HIDES the PDF you came for.
  const handlePick = useCallback(async () => {
    try {
      const sel = await openFileDialog({ multiple: true });
      if (!sel) return;
      stagePaths(sessionId, Array.isArray(sel) ? sel : [sel]);
      setError(null);
    } catch (err) {
      log.error(`Composer picker session=${sessionId}: ${err}`);
      setError("Couldn't open the file picker.");
    } finally {
      textareaRef.current?.focus();
    }
  }, [sessionId]);

  return (
    <div
      ref={drop.ref}
      style={{
        flex: "none",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "5px 8px 5px 8px",
        backgroundColor: "var(--bg-secondary)",
        borderTop: `1px solid ${drop.isOver ? "var(--text-secondary)" : "var(--border)"}`,
      }}
    >
      {attachments.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 4,
            paddingLeft: 2,
          }}
        >
          {attachments.map((a) => (
            <span
              key={a.path}
              title={a.path}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                flex: "none",
                maxWidth: 220,
                height: 18,
                padding: "0 5px",
                border: "1px solid var(--border-subtle)",
                borderRadius: 4,
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                color: "var(--text-muted)",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-secondary)" }}>
                {a.name}
              </span>
              {a.size !== undefined && <span>{formatAttachmentSize(a.size)}</span>}
              <button
                type="button"
                onClick={() => removeComposerAttachment(sessionId, a.path)}
                title={`Remove ${a.name}`}
                aria-label={`Remove ${a.name}`}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  lineHeight: 1,
                  color: "var(--text-dim)",
                }}
              >
                {"×"}
              </button>
            </span>
          ))}
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={() => void handlePick()}
          title="Attach a file"
          aria-label="Attach a file"
          style={{
            flex: "none",
            width: 24,
            height: 24,
            marginBottom: (MIN_HEIGHT - 24) / 2,
            borderRadius: 4,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            lineHeight: 1,
            color: "var(--text-muted)",
            padding: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text-primary)";
            e.currentTarget.style.backgroundColor = "var(--bg-elevated)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-muted)";
            e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          {"+"}
        </button>
        <textarea
          ref={textareaRef}
          data-composer-session={sessionId}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPasteCapture={handlePasteCapture}
          rows={1}
          spellCheck={false}
          placeholder="Message this session — Enter sends, Shift+Enter newline"
          title={HINT_TITLE}
          style={{
            flex: 1,
            minWidth: 0,
            height: MIN_HEIGHT,
            maxHeight: MAX_HEIGHT,
            resize: "none",
            border: "1px solid var(--border)",
            borderRadius: 4,
            backgroundColor: "var(--bg-primary)",
            color: "var(--text-primary)",
            fontFamily: "var(--font-mono)",
            fontSize: FONT_SIZE,
            lineHeight: `${LINE_HEIGHT}px`,
            padding: `${PAD_Y}px 8px`,
            outline: "none",
            overflowY: "hidden",
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: MIN_HEIGHT,
            flex: "none",
          }}
        >
          <span
            title={error ? undefined : HINT_TITLE}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              color: error ? "#F87171" : "var(--text-faint)",
              whiteSpace: "nowrap",
              maxWidth: 320,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {error ?? HINT}
          </span>
          <button
            onClick={() => hideComposer(sessionId)}
            title="Hide composer (Ctrl+Shift+M)"
            aria-label="Hide composer"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1,
              color: "var(--text-dim)",
              padding: "2px 4px",
            }}
          >
            {"×"}
          </button>
        </div>
      </div>
    </div>
  );
}
