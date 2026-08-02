// THE COMPOSER (increment D) — a prose input at the bottom of one terminal
// pane, addressing that pane's session.
//
// Scope, from Decision 3: this box handles PROSE. Ctrl+C, Esc, arrow-key TUI
// navigation and every other control character stay the terminal's job — click
// into it for those. Nothing here proxies a control character, and the wire
// format (lib/composer.composeWrite) strips them out of composed text rather
// than forwarding them.
//
// Dictation (the motivating case): Wispr Flow injects by PASTING. There is
// deliberately NO onPaste handler on the textarea below — the browser's native
// paste inserts the text exactly once. xterm's clipboard path needed explicit
// rules to avoid double-pasting precisely because it intercepts; a textarea
// that does not intercept has nothing to get wrong. Do not add one.

import { useCallback, useEffect, useRef, useState } from "react";
import { writeToSession } from "../lib/ipc";
import { getTerminal } from "../lib/terminal";
import { findThreadBySessionId, markChatStarted } from "../lib/threadStore";
import { saveThreadsToDisk } from "../lib/workspace";
import { log } from "../lib/logger";
import {
  DRAFT_INDEX,
  composeWrite,
  getComposerDraft,
  getSendHistory,
  hideComposer,
  recordSend,
  setComposerDraft,
  shouldNavigateHistory,
  stepHistory,
} from "../lib/composer";

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
  // as swallowing a failed send.
  useEffect(() => {
    return () => {
      setComposerDraft(sessionId, valueRef.current);
    };
  }, [sessionId]);

  const send = useCallback(async () => {
    if (inFlightRef.current) return;
    const text = valueRef.current;
    const payload = composeWrite(text);
    // Empty / whitespace-only: a no-op. Never a bare Enter.
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
    // typed (or dictated) during it is a NEW draft and must survive.
    if (valueRef.current === text) {
      setValue("");
      setComposerDraft(sessionId, "");
    }
    textareaRef.current?.focus();

    // Decision 4 — chatStarted is marked EXPLICITLY here. `writeToSession`
    // bypasses the input detector on purpose (feeding IPC writes back in
    // re-opens the false-positive class T5 removed: a shell command typed after
    // Ctrl+C'ing claude would falsely mark the thread started). A composer send
    // is unambiguous user intent, so it sets the flag directly. The detector is
    // untouched — typing into the terminal still flips the flag through it.
    const thread = findThreadBySessionId(sessionId);
    if (thread && !thread.chatStarted) {
      log.info(`Composer send — chatStarted id=${thread.id}`);
      markChatStarted(thread.id);
      // Same critical-field flush as the detector path: losing chatStarted to a
      // crash inside the 30s periodic window would relaunch instead of resume.
      void saveThreadsToDisk();
    }
  }, [sessionId]);

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

  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        alignItems: "flex-end",
        gap: 8,
        padding: "5px 8px 5px 10px",
        backgroundColor: "#0A0A0B",
        borderTop: "1px solid #1E1E22",
      }}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
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
          border: "1px solid #1E1E22",
          borderRadius: 4,
          backgroundColor: "#0C0C0E",
          color: "#E4E4E7",
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
            color: error ? "#F87171" : "#3F3F46",
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
            color: "#52525B",
            padding: "2px 4px",
          }}
        >
          {"×"}
        </button>
      </div>
    </div>
  );
}
