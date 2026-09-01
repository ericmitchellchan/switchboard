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
// Attachments (SWIT-59)
// ─────────────────────────────────────────────────────────────────────────────
// Ky's convention, verbatim: the agent is told to `Read` the attached files.
// A path is all an agent needs — Read renders images and PDFs directly — so
// pasted images are saved to the thread's attachments dir and dropped/picked
// files are staged BY PATH (never copied). The block rides on the composed
// text and goes through `composeWrite` like any other multi-line message.

export type ComposerAttachment = {
  /** Absolute path the agent will `Read`. Identity of the chip. */
  path: string;
  /** What the chip prints (a pasted screenshot has no real name: `pasted.png`). */
  name: string;
  /** Bytes, when known (pasted files always; dropped/picked files never —
   *  they are paths, and stat-ing them would be a second IPC per chip). */
  size?: number;
};

/** The block appended to text SENT to the agent, telling it to Read the
 *  attached files. Copied from ky-desktop's `useAttachments.attachmentAgentBlock`
 *  WORD FOR WORD — the two apps must speak one convention. Pure. */
export function attachmentAgentBlock(paths: string[]): string {
  if (paths.length === 0) return "";
  const list = paths.map((p) => `- ${p}`).join("\n");
  const plural = paths.length === 1 ? "" : "s";
  const it = paths.length === 1 ? "it" : "them";
  return `\n\n[The user attached ${paths.length} file${plural}. Use the Read tool to open ${it} — it renders images and PDFs directly; for other formats (Word, Excel, etc.) extract or convert the content first:\n${list}\n]`;
}

/** Ky's stand-in body when attachments are sent with no words of your own. */
export function attachmentStandInBody(count: number): string {
  return count === 1 ? "(see attached file)" : "(see attached files)";
}

/** What a send is MADE OF: the typed text plus the Read block. No attachments
 *  → the text untouched. Attachments and no words → the stand-in body carries
 *  the block, so the message never opens with two blank lines. The result is
 *  multi-line whenever there is a block, which is exactly what puts it on
 *  `composeWrite`'s bracketed-paste path: the block is ONE message. */
export function composeMessage(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const words = text.trim().length > 0 ? text.replace(/[ \t\n]+$/, "") : attachmentStandInBody(paths.length);
  return words + attachmentAgentBlock([...paths]);
}

/** Merge staged attachments, keyed by path — dropping the same file twice, or
 *  a pasted screenshot re-added, must not produce two chips (and two `- path`
 *  lines in the block). Returns the SAME array when nothing changes so a
 *  useSyncExternalStore snapshot stays stable. */
export function mergeAttachments(
  current: readonly ComposerAttachment[],
  incoming: readonly ComposerAttachment[]
): ComposerAttachment[] {
  const seen = new Set(current.map((a) => a.path));
  const fresh = incoming.filter((a) => {
    if (a.path.length === 0 || seen.has(a.path)) return false;
    seen.add(a.path);
    return true;
  });
  return fresh.length === 0 ? (current as ComposerAttachment[]) : [...current, ...fresh];
}

export function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** The file name a pasted item is SAVED under: `<ts>-<n>.<ext>`, the shape
 *  lib.rs's `save_thread_attachment` accepts (`[A-Za-z0-9._-]` only). The
 *  extension is reduced to that alphabet too — a mime subtype like
 *  `svg+xml` would otherwise be refused server-side. */
export function pastedAttachmentFileName(stamp: number, index: number, ext: string): string {
  const safeExt = ext.replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 8) || "bin";
  return `${Math.max(0, Math.floor(stamp))}-${Math.max(1, Math.floor(index))}.${safeExt}`;
}

/** What the CHIP prints for a pasted item: the clipboard's real file name
 *  when it has one (a copied `report.pdf`), else `pasted.<ext>` — numbered
 *  only when one paste carried several. */
export function pastedAttachmentLabel(
  fileName: string,
  ext: string,
  index: number,
  total: number
): string {
  const base = basenameOf(fileName.trim());
  if (base.length > 0 && base !== "image.png") return base;
  const safeExt = ext.replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "bin";
  return total > 1 ? `pasted-${index}.${safeExt}` : `pasted.${safeExt}`;
}

/** Human size for a chip: `812 B`, `24 KB`, `1.3 MB`. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─────────────────────────────────────────────────────────────────────────────
// @thread posts (SWIT-52)
// ─────────────────────────────────────────────────────────────────────────────
// `@sim-audit re-run the pin check` / `@"markets · Aug 30" look at this` —
// the composer's address form for posting to ANOTHER thread by hand. Pure
// parse; resolution and delivery are the app's (threadStore actions bridge).

export type ThreadPost = { target: string; body: string };

/** A message addressed to another thread, or null for an ordinary send. The
 *  target is one word or a quoted phrase; the body is everything after. */
export function parseThreadPost(text: string): ThreadPost | null {
  if (typeof text !== "string") return null;
  const m = text.trimStart().match(/^@(?:"([^"]{1,80})"|(\S{1,80}))[ 	]+([\s\S]+)$/);
  if (!m) return null;
  const target = (m[1] ?? m[2] ?? "").trim();
  const body = (m[3] ?? "").trim();
  if (target.length === 0 || body.length === 0) return null;
  return { target, body };
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
  /** Staged attachments (SWIT-59) — next to the draft, for the same reason:
   *  a chip must survive a tab/thread switch as a half-dictated line does. */
  attachments: ComposerAttachment[];
};

const NO_ATTACHMENTS: ComposerAttachment[] = [];

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
    s = { draft: "", history: [], attachments: NO_ATTACHMENTS };
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

export function getComposerAttachments(sessionId: string): readonly ComposerAttachment[] {
  return states.get(sessionId)?.attachments ?? NO_ATTACHMENTS;
}

/** Stage attachments for a session (deduped by path). Notifies — unlike the
 *  draft, a chip is drawn by the store's own hook, and a paste that lands
 *  while the pane is unmounted must still be there when it comes back. */
export function addComposerAttachments(
  sessionId: string,
  items: readonly ComposerAttachment[]
): void {
  const s = stateFor(sessionId);
  const next = mergeAttachments(s.attachments, items);
  if (next === s.attachments) return;
  s.attachments = next;
  bump();
}

/** Remove one chip. Drops the RECORD only: a pasted image stays on disk in
 *  the thread's attachments dir (cheap, and the agent may already have been
 *  told about it in an earlier send). */
export function removeComposerAttachment(sessionId: string, path: string): void {
  const s = states.get(sessionId);
  if (!s) return;
  const next = s.attachments.filter((a) => a.path !== path);
  if (next.length === s.attachments.length) return;
  s.attachments = next.length === 0 ? NO_ATTACHMENTS : next;
  bump();
}

/** Clear every chip — the successful-send path and the discard path alike.
 *  Files are never deleted here (see removeComposerAttachment). */
export function clearComposerAttachments(sessionId: string): void {
  const s = states.get(sessionId);
  if (!s || s.attachments.length === 0) return;
  s.attachments = NO_ATTACHMENTS;
  bump();
}

/** React hook: this session's staged attachments. The snapshot is the store's
 *  own array (replaced only on change), so the row re-renders per real change. */
export function useComposerAttachments(sessionId: string): readonly ComposerAttachment[] {
  return useSyncExternalStore(subscribeComposerStore, () => getComposerAttachments(sessionId));
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
