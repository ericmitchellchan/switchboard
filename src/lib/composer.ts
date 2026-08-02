// The composer (increment D) — a prose input hosted at the BOTTOM of each
// terminal pane, addressing that pane's session.
//
// Why it exists (increment-d-composer.md §Why this is more than polish): a
// `<textarea>` takes dictation (Wispr Flow injects via PASTE) natively with no
// interception, it is a separate DOM node so reading scrollback while composing
// costs nothing, and selection/undo/multi-line come free. The mechanism is
// already proven — A4's `→ thread` types into a session via `writeToSession`.
// The composer is that, plus Enter, plus a text box.
//
// Layout:
//   1. Wire format — `composeWrite`, the ONE decision that must not silently
//      regress (single line vs bracketed paste), pure and unit-tested.
//   2. Send history — pure list ops + the caret rules that decide when ↑/↓
//      belong to history and when they belong to the caret.
//   3. Per-session store — module singleton + useSyncExternalStore, the same
//      shape as panelStore / threadStore, deliberately not zustand.
//
// Everything here is IN-MEMORY and app-lifetime only. Nothing the composer
// knows (visibility override, draft, send history) is worth a localStorage key
// or a disk mirror: a restart legitimately starts you with a fresh box.

import { useSyncExternalStore } from "react";
import { findThreadBySessionId, isThreadLaunched, subscribeThreads } from "./threadStore";

// ─────────────────────────────────────────────────────────────────────────────
// Wire format
// ─────────────────────────────────────────────────────────────────────────────

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/** Control characters stripped from composed text: every C0 byte EXCEPT tab
 *  (\t) and newline (\n), plus DEL. Two reasons, and the second is the load
 *  bearing one:
 *   · The composer handles PROSE (Decision 3) — a Ctrl+C in the box is not a
 *     SIGINT, it is a stray byte.
 *   · ESC is how a payload would BREAK OUT of the bracketed paste we wrap it
 *     in. Dictated or pasted text containing a literal `ESC[201~` would end the
 *     paste early and turn the rest into N submissions — exactly the failure
 *     the wrapping exists to prevent. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Every character that means "line break" in text that reaches this box,
 *  not just the three ASCII ones. Dictation, PDFs, Word and a fair amount of
 *  the web emit U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR or U+0085
 *  NEL, and none of them is in CONTROL_CHARS (U+0085 is C1, the other two are
 *  punctuation) — so they used to survive sanitization intact.
 *
 *  That mattered for the WIRE FORMAT, not for safety: a paragraph whose only
 *  breaks were U+2028 contained no \n, took composeWrite's SINGLE-LINE branch,
 *  and went to the PTY UNBRACKETED — the exact "4 lines become 4 submissions"
 *  shape the bracketing exists to prevent. (A wrong shape, never a breakout:
 *  none of these can terminate a bracketed paste, only ESC can, and ESC is
 *  stripped above.) Folding them into \n puts such text back on the multi-line
 *  path where it belongs. */
const LINE_TERMINATORS = /\r\n?|\u0085|\u2028|\u2029/g;

/** Normalize every line terminator to \n and drop control characters.
 *  Idempotent. */
export function sanitizeComposerText(text: string): string {
  return text.replace(LINE_TERMINATORS, "\n").replace(CONTROL_CHARS, "");
}

/** THE wire-format decision: what bytes a composer send puts on the PTY.
 *
 *  Returns "" when there is nothing to send (empty or whitespace-only) — an
 *  empty send is a no-op, never a bare Enter, which in the TUI would submit
 *  nothing while still costing a turn's worth of repaint.
 *
 *  Single line  →  `<text>\r`                      (plain typing + submit)
 *  Multi-line   →  `ESC[200~<text with \n → \r>ESC[201~\r`
 *
 *  The bracketed-paste wrapping is what makes multi-line arrive as ONE message.
 *  Without it each embedded newline is its own Enter and a 4-line message
 *  becomes 4 submissions. Inside the brackets the line breaks are CARRIAGE
 *  RETURNS, not \n — that is exactly what xterm's own paste path does
 *  (`prepareTextForTerminal`: /\r?\n/g → \r), so a composer paste and a
 *  Ctrl+V paste are byte-identical to the TUI. The single trailing \r sits
 *  OUTSIDE the end marker: it is the submit, and it is the only Enter.
 *
 *  Trailing blank space is dropped (a Shift+Enter you changed your mind about
 *  must not become a trailing empty line); LEADING whitespace is preserved,
 *  because indentation in a pasted snippet is content. */
export function composeWrite(text: string): string {
  const clean = sanitizeComposerText(text).replace(/[ \t\n]+$/, "");
  if (clean.trim().length === 0) return "";
  if (!clean.includes("\n")) return `${clean}\r`;
  return `${PASTE_START}${clean.replace(/\n/g, "\r")}${PASTE_END}\r`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Send history
// ─────────────────────────────────────────────────────────────────────────────

/** How many recent sends ↑/↓ can reach. Session-scoped and in-memory; this is
 *  a convenience, not a transcript (the terminal has the real one). */
export const SEND_HISTORY_LIMIT = 50;

/** Sentinel index for "the live draft" — the slot ↓ returns you to. */
export const DRAFT_INDEX = -1;

/** Append a send to the (oldest-first) history. Consecutive duplicates collapse
 *  — re-sending the same line twice should not cost two ↑ presses to get past
 *  — and the list is capped from the OLD end. */
export function pushSendHistory(
  history: readonly string[],
  entry: string,
  limit: number = SEND_HISTORY_LIMIT
): string[] {
  if (entry.length === 0) return [...history];
  if (history[history.length - 1] === entry) return [...history];
  const next = [...history, entry];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Where ↑ / ↓ lands from `index` (oldest-first history, DRAFT_INDEX = draft).
 *  Returns null when the step is impossible — an empty history, already at the
 *  oldest entry, or already back at the draft — in which case the key event is
 *  left alone rather than swallowed. */
export function stepHistory(
  historyLength: number,
  index: number,
  direction: "older" | "newer"
): number | null {
  if (direction === "older") {
    if (historyLength === 0) return null;
    if (index === DRAFT_INDEX) return historyLength - 1;
    if (index <= 0) return null;
    return index - 1;
  }
  if (index === DRAFT_INDEX) return null;
  if (index >= historyLength - 1) return DRAFT_INDEX;
  return index + 1;
}

/** Does this ↑/↓ belong to HISTORY or to the caret? The composer must not
 *  hijack the arrows mid-edit — a multi-line message is exactly where you need
 *  them to move the caret.
 *
 *  Rules, in order:
 *   · A SELECTION always wins. Shift-arrow extends it; stealing that would make
 *     the box worse at the editing it exists to provide.
 *   · While BROWSING history (a previous ↑ already replaced the value and put
 *     the caret at the end) the arrows keep browsing, the way every shell
 *     behaves. Typing anything ends browsing and hands the arrows back.
 *   · Otherwise ↑ needs the caret at position 0 and ↓ needs it at the very end
 *     — i.e. the arrow had nowhere left to go inside the text. */
export function shouldNavigateHistory(args: {
  direction: "older" | "newer";
  inHistory: boolean;
  value: string;
  selectionStart: number;
  selectionEnd: number;
}): boolean {
  if (args.selectionStart !== args.selectionEnd) return false;
  if (args.inHistory) return true;
  return args.direction === "older"
    ? args.selectionStart === 0
    : args.selectionStart === args.value.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-session store
// ─────────────────────────────────────────────────────────────────────────────

type ComposerState = {
  /** User's explicit choice for this session. `undefined` = follow the
   *  automatic rule (a live claude conversation shows a composer). */
  override?: boolean;
  /** Unsent text, stashed across pane remounts (split ⇄ single-pane rebuilds
   *  the tree, which unmounts panes that never went away visually). */
  draft: string;
  history: string[];
};

const states = new Map<string, ComposerState>();
const listeners = new Set<() => void>();

function bump(): void {
  for (const l of listeners) l();
}

function subscribeComposerStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function stateFor(sessionId: string): ComposerState {
  let s = states.get(sessionId);
  if (!s) {
    s = { draft: "", history: [] };
    states.set(sessionId, s);
  }
  return s;
}

/** Visibility is DERIVED, not detected: a session bound to a thread whose
 *  claude was launched in this app run IS a session holding a conversation.
 *  That is increment C's promotion signal reused verbatim (`launched` is set by
 *  both the explicit launch and the promotion pass, and cleared on PTY exit /
 *  tab close) — the composer deliberately adds no second detector. */
export function composerAutoVisible(sessionId: string | null): boolean {
  if (!sessionId) return false;
  const thread = findThreadBySessionId(sessionId);
  return !!thread && isThreadLaunched(thread.id);
}

/** Should this session show a composer? Override first, automatic rule second. */
export function isComposerVisible(sessionId: string | null): boolean {
  if (!sessionId) return false;
  const override = states.get(sessionId)?.override;
  return override ?? composerAutoVisible(sessionId);
}

/** Flip this session's composer and REMEMBER the resolved answer.
 *
 *  Storing the boolean (rather than clearing back to "auto") is what makes the
 *  toggle mean the same thing in both directions: hiding it on a claude tab
 *  keeps it hidden even though the conversation is still live, and forcing it
 *  on for a plain shell keeps it there even though nothing is running. The
 *  memory is per SESSION and lasts the app's lifetime — see the file header. */
export function toggleComposer(sessionId: string): void {
  const next = !isComposerVisible(sessionId);
  stateFor(sessionId).override = next;
  bump();
}

/** The composer's own hide affordance — same memory as the chord. */
export function hideComposer(sessionId: string): void {
  if (!isComposerVisible(sessionId)) return;
  stateFor(sessionId).override = false;
  bump();
}

export function getComposerDraft(sessionId: string): string {
  return states.get(sessionId)?.draft ?? "";
}

/** Stash the unsent draft. Deliberately does NOT notify: the draft is owned by
 *  the textarea (React state), and re-rendering every keystroke through the
 *  store would be a pointless round trip. This is a write-only cubby read once
 *  on mount. */
export function setComposerDraft(sessionId: string, draft: string): void {
  stateFor(sessionId).draft = draft;
}

export function getSendHistory(sessionId: string): readonly string[] {
  return states.get(sessionId)?.history ?? [];
}

/** Record a successful send. Only successes land here — a failed write leaves
 *  the text in the box, where it is still the draft, not yet history. */
export function recordSend(sessionId: string, text: string): void {
  const s = stateFor(sessionId);
  s.history = pushSendHistory(s.history, text);
}

/** Drop everything the composer remembers about a session. Called from
 *  TerminalPane.cleanupSessionListeners — i.e. on session close AND on
 *  in-place restart, both of which end the conversation the box was
 *  addressing. */
export function clearComposerState(sessionId: string): void {
  if (!states.delete(sessionId)) return;
  bump();
}

/** React hook: is this session's composer showing? Subscribes to BOTH stores —
 *  the answer moves when the user toggles AND when a tab is promoted to a live
 *  thread. A boolean snapshot, so a pane re-renders once per real change and
 *  never on unrelated thread-store traffic (status publishes, other tabs). */
export function useComposerVisible(sessionId: string | null): boolean {
  return useSyncExternalStore(subscribeVisibility, () => isComposerVisible(sessionId));
}

/** Module-scope so its identity is stable — an inline subscribe would make
 *  useSyncExternalStore tear down and re-add both listeners on every render. */
function subscribeVisibility(listener: () => void): () => void {
  const offComposer = subscribeComposerStore(listener);
  const offThreads = subscribeThreads(listener);
  return () => {
    offComposer();
    offThreads();
  };
}

/** Test-only: reset the store to a blank state. */
export function __resetComposerStoreForTests(): void {
  states.clear();
  listeners.clear();
}
