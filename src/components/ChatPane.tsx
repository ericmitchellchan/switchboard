// THE CHAT VIEW (SWIT-117, Ky's playbook `pretty-chat-from-the-session-record.md`).
// claude's own session record drawn as a conversation, mounted OVER the live
// terminal — never instead of it. The terminal underneath keeps its size, its
// composer, its permission answers and its repaint machinery; covering it
// changes what you look at and nothing about what runs, so flipping back is
// instant and nothing restarts.
//
// A re-read, not a stream: the record is re-read every 1.5 s while a turn is
// in flight and every 10 s otherwise (lib/chatView.chatPollMs), and parsed only
// when it changed. The pane SAYS what the record cannot account for: a turn in
// flight, claude waiting on the user in the terminal (a permission prompt is
// terminal UI and is never written down), a read that failed, and a window
// that cut — a quiet pane must never read as a calm one.
//
// Type: every size is a token (lib/typeScale) — this file is in the guard's
// SWEPT list from day one.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { MarkdownBody, MarkdownDocStyles } from "./kb/MarkdownDoc";
import { T } from "../lib/typeScale";
import { readClaudeTranscript } from "../lib/ipc";
import {
  parseTranscript,
  toolDisplayName,
  toolResultBody,
  toolState,
  type ChatEntry,
  type ToolEntry,
} from "../lib/transcript";
import {
  CHAT_WINDOW_MAX,
  CHAT_WINDOW_START,
  chatPollMs,
  nextChatWindow,
  focusComposerFor,
  setChatViewEnabled,
  useSessionStatus,
  type ChatTarget,
} from "../lib/chatView";
import type { AgentStatus } from "../types";

interface ReadState {
  entries: ChatEntry[];
  /** null = not read yet; false = no record yet (nothing said). */
  hasRecord: boolean | null;
  truncated: boolean;
  error: string | null;
}

const EMPTY: ReadState = { entries: [], hasRecord: null, truncated: false, error: null };

/** Re-read the record on a status-paced timer while the pane is on screen;
 *  an unchanged file is answered by Rust from its size and modified time
 *  alone (nothing read, nothing sent), and only a changed one is parsed. */
function useTranscript(target: ChatTarget, status: AgentStatus | null, visible: boolean) {
  const [state, setState] = useState<ReadState>(EMPTY);
  const [windowBytes, setWindowBytes] = useState(CHAT_WINDOW_START);
  /** What the rows on screen were read from — sent back so Rust can say
   *  `unchanged`. Reset whenever the window or the conversation changes. */
  const known = useRef<{ size: number; modifiedMs: number } | null>(null);
  /** Drops a read that a newer one already overtook. */
  const seq = useRef(0);

  // A new conversation starts from nothing.
  useEffect(() => {
    known.current = null;
    setState(EMPTY);
    setWindowBytes(CHAT_WINDOW_START);
  }, [target.chatSessionId, target.workingDir]);

  // A wider window is a different read.
  useEffect(() => {
    known.current = null;
  }, [windowBytes]);

  const read = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const tail = await readClaudeTranscript(target.workingDir, target.chatSessionId, windowBytes, known.current);
      if (mine !== seq.current) return;
      if (!tail) {
        known.current = null;
        setState({ entries: [], hasRecord: false, truncated: false, error: null });
        return;
      }
      if (tail.unchanged) {
        setState((s) => (s.error ? { ...s, error: null } : s));
        return;
      }
      known.current = { size: tail.size, modifiedMs: tail.modifiedMs };
      setState({ entries: parseTranscript(tail.text), hasRecord: true, truncated: tail.truncated, error: null });
    } catch (e) {
      if (mine !== seq.current) return;
      // A failed read keeps what is on screen and SAYS it failed.
      setState((s) => ({ ...s, error: String(e) }));
    }
  }, [target.workingDir, target.chatSessionId, windowBytes]);

  // Read now (mount, a status change, a wider window, coming back on screen),
  // then on the cadence — and NOT AT ALL while the pane is hidden (a hidden
  // tab keeps its pane mounted under display:none).
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await read();
      if (!cancelled) timer = setTimeout(tick, chatPollMs(status));
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [read, status, visible]);

  const loadEarlier = useCallback(() => setWindowBytes((w) => nextChatWindow(w)), []);
  return { ...state, windowBytes, loadEarlier };
}

/** What the pane says when it has no entries to draw — never a blank pane
 *  (Ky: a surface that renders nothing passes every test that does not mount
 *  it). Pure; exported for tests. */
export function chatPlaceholder(
  hasRecord: boolean | null,
  error: string | null,
  count: number,
  truncated = false,
): string | null {
  if (count > 0) return null;
  if (hasRecord === false) return "Nothing has been said in this thread yet.";
  if (hasRecord === null) return error ? "The conversation could not be read yet." : "Reading the conversation…";
  if (truncated) return "The latest part of the record holds no messages.";
  return "Nothing to show yet — so far the record holds only setup.";
}

const SCROLLER: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  overflowX: "hidden",
};

const COLUMN: CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "16px 20px 24px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const QUIET_LINK: CSSProperties = {
  ...T.caption,
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--text-muted)",
  textDecoration: "underline",
  textUnderlineOffset: 2,
  cursor: "pointer",
};

interface ChatPaneProps {
  sessionId: string;
  target: ChatTarget;
  /** The pane is on screen (not a hidden tab). Hidden = no polling. */
  visible: boolean;
}

export function ChatPane({ sessionId, target, visible }: ChatPaneProps) {
  const status = useSessionStatus(sessionId);
  const { entries, hasRecord, truncated, error, windowBytes, loadEarlier } = useTranscript(target, status, visible);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const savedTopRef = useRef(0);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  const toggleOpen = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Follow the conversation while the reader is at the bottom; leave them
  // alone once they scroll up.
  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || el.clientHeight === 0) return; // hidden: display:none reports zeros
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    savedTopRef.current = el.scrollTop;
  }, []);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, status]);
  // The content grows AFTER a render too — markdown is rendered
  // asynchronously, so a message lands empty and fills in a beat later — and
  // a hidden tab (display:none) comes back with its scroll offset reset. One
  // observer on the column and the scroller handles both: hold the bottom if
  // the reader was there, else put them back where they were.
  useEffect(() => {
    const el = scrollerRef.current;
    const column = columnRef.current;
    if (!el || !column) return;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === 0) return;
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
      else if (el.scrollTop === 0 && savedTopRef.current > 0) el.scrollTop = savedTopRef.current;
    });
    ro.observe(column);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A click in the chat that is not on a control and not a text selection
  // gives the keyboard back to the composer — keystrokes and Ctrl+V must not
  // land in the terminal hidden underneath.
  const onPaneClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("button, a, input, textarea, select, [contenteditable='true']")) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      focusComposerFor(sessionId);
    },
    [sessionId],
  );

  const placeholder = chatPlaceholder(hasRecord, error, entries.length, truncated);
  const working = status === "running";
  const waiting = status === "waiting";

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-primary)",
      }}
    >
      <MarkdownDocStyles />
      <button
        type="button"
        onClick={() => setChatViewEnabled(false)}
        title="Show the live terminal under this chat (the setting applies to every thread)"
        style={{
          ...T.caption,
          position: "absolute",
          top: 8,
          right: 14,
          zIndex: 1,
          background: "var(--bg-active)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "2px 8px",
          color: "var(--text-secondary)",
          cursor: "pointer",
        }}
      >
        terminal
      </button>
      <div ref={scrollerRef} onScroll={onScroll} onClick={onPaneClick} style={SCROLLER}>
        <div ref={columnRef} style={COLUMN}>
          {truncated && (
            <div style={{ ...T.caption, color: "var(--text-dim)", textAlign: "center" }}>
              {windowBytes < CHAT_WINDOW_MAX ? (
                <>
                  Earlier messages are not loaded ·{" "}
                  <button type="button" style={QUIET_LINK} onClick={loadEarlier}>
                    load earlier
                  </button>
                </>
              ) : (
                "Earlier messages are in the terminal"
              )}
            </div>
          )}
          {placeholder && (
            <div style={{ ...T.body, color: "var(--text-muted)", padding: "24px 0", textAlign: "center" }}>{placeholder}</div>
          )}
          {entries.map((e) => (
            <EntryView key={e.id} entry={e} open={open.has(e.id)} onToggle={toggleOpen} />
          ))}
        </div>
      </div>
      <StatusLine working={working} waiting={waiting} error={error} />
    </div>
  );
}

/** The one line at the bottom for what the record cannot show. Renders
 *  nothing when there is nothing to say. */
function StatusLine({ working, waiting, error }: { working: boolean; waiting: boolean; error: string | null }) {
  if (!working && !waiting && !error) return null;
  const base: CSSProperties = {
    ...T.caption,
    flex: "none",
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 20px",
    borderTop: "1px solid var(--border)",
    background: "var(--bg-secondary)",
  };
  if (error) {
    return (
      <div style={{ ...base, color: "var(--tone-rose)" }} title={error}>
        Couldn't read the conversation — what's above may be behind.
      </div>
    );
  }
  if (waiting) {
    return (
      <div style={{ ...base, color: "var(--tone-amber)" }}>
        Claude may be waiting on you in the terminal.
        <button type="button" style={{ ...QUIET_LINK, color: "var(--tone-amber)" }} onClick={() => setChatViewEnabled(false)}>
          open terminal
        </button>
      </div>
    );
  }
  return <div style={{ ...base, color: "var(--text-muted)" }}>Claude is working…</div>;
}

const EntryView = memo(function EntryView({
  entry,
  open,
  onToggle,
}: {
  entry: ChatEntry;
  open: boolean;
  onToggle: (id: string) => void;
}) {
  switch (entry.kind) {
    case "user":
      return (
        <div
          style={{
            ...T.body,
            alignSelf: "flex-end",
            maxWidth: "85%",
            background: "var(--bg-active)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "8px 12px",
            color: "var(--text-primary)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {entry.text}
        </div>
      );
    case "assistant":
      return <MarkdownBody content={entry.text} style={{ ...T.body, padding: 0, maxWidth: "none" }} />;
    case "notice":
      return (
        <div style={{ ...T.caption, color: "var(--text-dim)", textAlign: "center" }}>{entry.text}</div>
      );
    case "thinking":
      return (
        <Fold
          label="thinking"
          detail=""
          state={open ? "hide" : "show"}
          tone="var(--text-dim)"
          open={open}
          onToggle={() => onToggle(entry.id)}
          body={<div style={{ ...T.bodySm, color: "var(--text-muted)", whiteSpace: "pre-wrap" }}>{entry.text}</div>}
        />
      );
    case "tool":
      return <ToolRow entry={entry} open={open} onToggle={onToggle} />;
  }
});

export function ToolRow({ entry, open, onToggle }: { entry: ToolEntry; open: boolean; onToggle: (id: string) => void }) {
  const state = toolState(entry);
  const word = state === "running" ? "running…" : state === "failed" ? (open ? "hide" : "failed") : open ? "hide" : "show";
  const tone = state === "running" ? "var(--tone-blue)" : state === "failed" ? "var(--tone-rose)" : "var(--text-dim)";
  return (
    <Fold
      label={toolDisplayName(entry.name)}
      detail={entry.summary}
      state={word}
      tone={tone}
      open={open && state !== "running"}
      onToggle={() => {
        if (state !== "running") onToggle(entry.id);
      }}
      body={
        <pre
          style={{
            ...T.mono,
            margin: "4px 0 0",
            maxHeight: 320,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 10px",
            color: "var(--text-secondary)",
          }}
        >
          {toolResultBody(entry)}
        </pre>
      }
    />
  );
}

/** A folded row: its header line and nothing else until opened (Ky's lesson —
 *  a preview that repeats the summary beside it is noise). */
function Fold({
  label,
  detail,
  state,
  tone,
  open,
  onToggle,
  body,
}: {
  label: string;
  detail: string;
  state: string;
  tone: string;
  open: boolean;
  onToggle: () => void;
  body: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          background: "none",
          border: "none",
          padding: "1px 0",
          cursor: "pointer",
          textAlign: "left",
          minWidth: 0,
        }}
      >
        <span style={{ ...T.label, color: "var(--text-muted)", flex: "none" }}>{label}</span>
        <span
          style={{
            ...T.bodySm,
            color: "var(--text-secondary)",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {detail}
        </span>
        <span style={{ ...T.caption, color: tone, flex: "none" }}>{state}</span>
      </button>
      {open && body}
    </div>
  );
}

/** The way back in, drawn over the terminal while the chat view is off. */
export function ChatChip() {
  return (
    <button
      type="button"
      onClick={() => setChatViewEnabled(true)}
      title="Read this thread as a chat (the setting applies to every thread)"
      style={{
        ...T.caption,
        position: "absolute",
        top: 8,
        right: 14,
        zIndex: 5,
        background: "var(--bg-active)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "2px 8px",
        color: "var(--text-secondary)",
        cursor: "pointer",
      }}
    >
      chat
    </button>
  );
}
