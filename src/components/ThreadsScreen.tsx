// Thread history screen (increment C) — the `See all (N)` destination.
//
// The side menu's Threads section is a RECENT list capped at 8 rows; this is
// the whole history. Same vocabulary as the rail (status dot + title + dim
// repo meta + the "⟳ revive" chip), widened into a screen so each row can also
// carry last activity and its own revive / delete actions, with a text filter
// over title + repo.
//
// Structure follows the Explorer screen: a 36px header bar over a single
// scrolling body. Soft palette — black/white/zinc only; the status dot's
// statusConfig colour is the ONLY colour here, exactly as in the side menu.
//
// Routed as `{screen:"threads"}`, param-less, so it is deep-linkable and
// reachable with the side menu hidden — the filter box is screen-local UI
// state, never route identity.

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { AgentStatus, Thread } from "../types";
import {
  useThreadsView,
  getThreadActions,
  filterThreads,
  relativeActivity,
  sortThreadsForHistory,
  threadRepoName,
} from "../lib/threadStore";
import { STATUS_CONFIGS } from "../lib/statusConfig";

/** Dead rows use the EXITED status colour — read from statusConfig, the
 *  single source of truth, so a palette change lands here too. */
const EXITED_COLOR = STATUS_CONFIGS.exited.color;

/** Relative labels ("2h ago") go stale while the screen sits open. One slow
 *  tick keeps them honest without turning the screen into a render loop; it
 *  runs only while the screen is the ACTIVE route (this screen is keep-alive,
 *  so it stays mounted behind the terminal otherwise). */
const CLOCK_TICK_MS = 30_000;

const ROOT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "var(--font-mono)",
};

const HEAD_STYLE: CSSProperties = {
  height: 36,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "0 14px",
  borderBottom: "1px solid var(--border)",
  fontSize: 11.5,
  color: "var(--text-dim)",
};

const FILTER_STYLE: CSSProperties = {
  flex: "none",
  width: 200,
  background: "var(--bg-secondary)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "3px 8px",
  color: "var(--text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  outline: "none",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  padding: "7px 14px",
  background: "none",
  border: "none",
  borderBottom: "1px solid var(--border-subtle)",
  boxShadow: "none",
  color: "var(--text-secondary)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  textAlign: "left",
  cursor: "pointer",
};

const CHIP_STYLE: CSSProperties = {
  flex: "none",
  fontSize: 9,
  border: "1px solid var(--border-subtle)",
  borderRadius: 4,
  padding: "1px 6px",
  color: "var(--text-muted)",
  whiteSpace: "nowrap",
  background: "none",
  fontFamily: "var(--font-mono)",
  cursor: "pointer",
};

export function ThreadsScreen({
  active,
  menuHidden,
}: {
  /** This screen is the current route (gates the relative-clock tick). */
  active: boolean;
  /** Side menu hidden — the empty state hints how to open the navigator. */
  menuHidden: boolean;
}) {
  const view = useThreadsView();
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);

  const ordered = sortThreadsForHistory(view.threads, view.launched);
  const rows = filterThreads(ordered, query);

  return (
    <div style={ROOT_STYLE}>
      <div style={HEAD_STYLE}>
        <span style={{ color: "var(--text-secondary)", fontWeight: 600 }}>threads</span>
        <span>
          {rows.length === view.threads.length
            ? `${view.threads.length}`
            : `${rows.length} of ${view.threads.length}`}
        </span>
        <span style={{ flex: 1 }} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter title or repo…"
          aria-label="Filter threads"
          style={FILTER_STYLE}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--text-secondary)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--border)";
          }}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", background: "var(--bg-primary)" }}>
        {rows.length > 0 ? (
          rows.map((t) => (
            <HistoryRow
              key={t.id}
              thread={t}
              live={view.launched.has(t.id)}
              booting={view.booting.has(t.id)}
              status={t.sessionId ? view.sessionStatuses[t.sessionId] : undefined}
              active={t.sessionId !== null && t.sessionId === view.activeSessionId}
              now={now}
            />
          ))
        ) : view.threads.length === 0 ? (
          // Honest empty state: no threads exist at all, and BOTH ways of
          // getting one are named (they are genuinely equivalent now).
          <CenteredNote>
            <span>no threads yet</span>
            <span style={{ color: "var(--text-faint)" }}>
              run `claude` in any tab, or use “+ new thread” in the navigator
            </span>
            {menuHidden && (
              <span style={{ color: "var(--text-faint)" }}>
                Ctrl+Shift+B (or click SWITCHBOARD) opens the navigator
              </span>
            )}
          </CenteredNote>
        ) : (
          <CenteredNote>
            <span>no thread matches “{query.trim()}”</span>
            <span style={{ color: "var(--text-faint)" }}>
              {view.threads.length} thread{view.threads.length === 1 ? "" : "s"} in history
            </span>
          </CenteredNote>
        )}
      </div>
    </div>
  );
}

function HistoryRow({
  thread,
  live,
  booting,
  status,
  active,
  now,
}: {
  thread: Thread;
  live: boolean;
  booting: boolean;
  status: AgentStatus | undefined;
  active: boolean;
  now: number;
}) {
  const [hover, setHover] = useState(false);
  const actions = getThreadActions();

  // Dead = no claude process behind the row (app restart, session exit, tab
  // close) — same definition the side menu uses.
  const dead = !live;
  const dotColor = live && status ? STATUS_CONFIGS[status].color : EXITED_COLOR;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => {
        if (!actions) return;
        if (dead && !booting) actions.reviveThread(thread.id);
        else actions.openThread(thread.id);
      }}
      title={thread.workingDir}
      style={{
        ...ROW_STYLE,
        background: active ? "var(--bg-active)" : hover ? "var(--bg-secondary)" : "none",
        boxShadow: active ? "inset 2px 0 0 var(--text-primary)" : "none",
        color: active || hover ? "var(--text-primary)" : "var(--text-secondary)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          flex: "none",
          backgroundColor: dotColor,
        }}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {thread.title}
      </span>
      <span
        style={{
          flex: "none",
          width: 150,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          textAlign: "right",
          fontSize: 10,
          color: "var(--text-dim)",
        }}
      >
        {threadRepoName(thread.workingDir)}
      </span>
      <span
        style={{
          flex: "none",
          width: 70,
          textAlign: "right",
          fontSize: 10,
          color: "var(--text-dim)",
        }}
      >
        {relativeActivity(thread.lastActivityAt, now)}
      </span>
      <span
        style={{
          flex: "none",
          width: 56,
          textAlign: "right",
          fontSize: 9.5,
          color: "var(--text-dim)",
        }}
      >
        {booting ? "booting…" : live ? "live" : "dead"}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (booting) return;
          if (dead) actions?.reviveThread(thread.id);
          else actions?.openThread(thread.id);
        }}
        style={{
          ...CHIP_STYLE,
          color: dead && !booting ? "var(--text-primary)" : "var(--text-muted)",
          borderColor: dead && !booting ? "var(--text-secondary)" : "var(--border-subtle)",
        }}
      >
        {booting ? "⟳ booting…" : dead ? "⟳ revive" : "open"}
      </button>
      <button
        type="button"
        aria-label="Delete thread"
        title="Delete this thread record"
        onClick={(e) => {
          e.stopPropagation();
          // Destructive and unrecoverable — the record IS the only way back to
          // the conversation, so this one asks first.
          actions?.confirmDeleteThread(thread.id);
        }}
        style={{ ...CHIP_STYLE, padding: "1px 7px" }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--text-primary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        ×
      </button>
    </div>
  );
}

function CenteredNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text-dim)",
        padding: 24,
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}
