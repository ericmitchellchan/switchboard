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
//
// INCREMENT E: two tabs, Active | Archived, each with a count and each
// carrying the same filter. This screen is the ONLY surface archived threads
// appear on — the rail, its `See all (N)` count and everything downstream see
// the active list only. Each row's actions moved into the shared `⋯` menu
// (ThreadRowMenu), and the bare `×` is gone: Delete asks first now.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { AgentStatus, Thread } from "../types";
import {
  useThreadsView,
  getThreadActions,
  activeThreads,
  archivedThreads,
  filterThreads,
  relativeActivity,
  sortThreadsForHistory,
  threadRepoName,
} from "../lib/threadStore";
import { STATUS_CONFIGS } from "../lib/statusConfig";
import { ThreadRowMenu, ThreadTitleEditor, threadMenuItems } from "./ThreadRowMenu";

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

/** Which list the screen is showing (increment E). SCREEN-LOCAL state, not
 *  route identity — exactly like the filter box, and for the same reason: the
 *  route stays `?screen=threads`, deep-linkable and param-less. */
type ThreadTab = "active" | "archived";

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
  const [tab, setTab] = useState<ThreadTab>("active");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);

  // The two lists, and their counts on the tabs. This SCREEN is the only place
  // archived threads appear anywhere in the app (Decision 5) — the side menu,
  // its `See all (N)` count and every other surface see the active list only.
  const activeList = useMemo(() => activeThreads(view.threads), [view.threads]);
  const archivedList = useMemo(() => archivedThreads(view.threads), [view.threads]);
  const source = tab === "active" ? activeList : archivedList;

  // Leaving the Archived tab empty under you (unarchiving the last one) would
  // strand the screen on a dead tab. Fall back to Active.
  useEffect(() => {
    if (tab === "archived" && archivedList.length === 0) setTab("active");
  }, [tab, archivedList.length]);

  const ordered = sortThreadsForHistory(source, view.launched);
  const rows = filterThreads(ordered, query);

  return (
    <div style={ROOT_STYLE}>
      <div style={HEAD_STYLE}>
        <span style={{ color: "var(--text-secondary)", fontWeight: 600 }}>threads</span>
        <Tab label="active" count={activeList.length} on={tab === "active"} onClick={() => setTab("active")} />
        <Tab
          label="archived"
          count={archivedList.length}
          on={tab === "archived"}
          onClick={() => setTab("archived")}
        />
        <span>
          {rows.length === source.length ? "" : `${rows.length} of ${source.length}`}
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
              archived={tab === "archived"}
              live={view.launched.has(t.id)}
              booting={view.booting.has(t.id)}
              status={t.sessionId ? view.sessionStatuses[t.sessionId] : undefined}
              active={t.sessionId !== null && t.sessionId === view.activeSessionId}
              now={now}
            />
          ))
        ) : source.length === 0 ? (
          tab === "archived" ? (
            // Archiving is not deleting, and the empty state says so — this is
            // where a user comes looking for a thread that "disappeared".
            <CenteredNote>
              <span>nothing archived</span>
              <span style={{ color: "var(--text-faint)" }}>
                archiving a thread hides it from the navigator; it keeps its
                conversation and stays revivable from here
              </span>
            </CenteredNote>
          ) : (
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
          )
        ) : (
          <CenteredNote>
            <span>no thread matches “{query.trim()}”</span>
            <span style={{ color: "var(--text-faint)" }}>
              {source.length} {tab} thread{source.length === 1 ? "" : "s"}
            </span>
          </CenteredNote>
        )}
      </div>
    </div>
  );
}

/** Active | Archived. Text tabs with counts, in the 36px header — no new
 *  chrome row, no colour: the selected one is bright with a 2px underline,
 *  which is the whole vocabulary the panel's tab strip uses too. */
function Tab({
  label,
  count,
  on,
  onClick,
}: {
  label: string;
  count: number;
  on: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: "none",
        border: "none",
        borderBottom: on ? "2px solid var(--text-secondary)" : "2px solid transparent",
        padding: "2px 2px 1px",
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        color: on
          ? "var(--text-primary)"
          : hover
            ? "var(--text-secondary)"
            : "var(--text-dim)",
        cursor: "pointer",
      }}
    >
      {label} <span style={{ color: "var(--text-dim)" }}>{count}</span>
    </button>
  );
}

function HistoryRow({
  thread,
  archived,
  live,
  booting,
  status,
  active,
  now,
}: {
  thread: Thread;
  /** Row on the Archived tab — its primary action is UNARCHIVE, not revive. */
  archived: boolean;
  live: boolean;
  booting: boolean;
  status: AgentStatus | undefined;
  active: boolean;
  now: number;
}) {
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const actions = getThreadActions();

  // Dead = no claude process behind the row (app restart, session exit, tab
  // close) — same definition the side menu uses.
  const dead = !live;
  const dotColor = live && status ? STATUS_CONFIGS[status].color : EXITED_COLOR;

  // On the Archived tab EVERY affordance says "put it back" — the row, the
  // chip and the menu all unarchive (Decision 5: archived rows offer Unarchive
  // + Delete). Reviving is a click away once it is back, and the record is
  // untouched meanwhile, which is what "still revivable" means.
  const activateRow = () => {
    if (!actions) return;
    if (archived) actions.setThreadArchived(thread.id, false);
    else if (dead && !booting) actions.reviveThread(thread.id);
    else actions.openThread(thread.id);
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={editing ? undefined : activateRow}
      onDoubleClick={(e) => {
        // ARCHIVED rows are not renameable, matching threadMenuItems, which
        // deliberately offers an archived row only Unarchive + Delete. A
        // shortcut that reaches a verb the menu withholds is the menu lying.
        if (archived) return;
        e.preventDefault();
        setEditing(true);
      }}
      title={thread.workingDir}
      style={{
        ...ROW_STYLE,
        cursor: editing ? "default" : "pointer",
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
      {editing ? (
        <ThreadTitleEditor thread={thread} onDone={() => setEditing(false)} />
      ) : (
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
      )}
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
        {archived ? "archived" : booting ? "booting…" : live ? "live" : "dead"}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (booting && !archived) return;
          activateRow();
        }}
        style={{
          ...CHIP_STYLE,
          color: archived || (dead && !booting) ? "var(--text-primary)" : "var(--text-muted)",
          borderColor:
            archived || (dead && !booting) ? "var(--text-secondary)" : "var(--border-subtle)",
        }}
      >
        {archived ? "unarchive" : booting ? "⟳ booting…" : dead ? "⟳ revive" : "open"}
      </button>
      {/* The `⋯` menu — the SAME items the rail's rows carry (Decision 2).
          The bare `×` that used to sit here is gone: Delete lives in the menu
          and asks first. */}
      <ThreadRowMenu
        ariaLabel="Thread actions"
        size={13}
        onOpenChange={setMenuOpen}
        triggerStyle={{
          width: 20,
          height: 18,
          borderRadius: 4,
          color: menuOpen ? "var(--text-primary)" : "var(--text-muted)",
        }}
        items={threadMenuItems({ thread, live, onRename: () => setEditing(true) })}
      />
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
