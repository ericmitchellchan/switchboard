// Threads band of the workstation side menu — modelled on Ky's desktop
// sidebar (SWIT-56; `ky-desktop/src/ky/main/Sidebar.tsx`, THREADS section):
//
//     THREADS                        SEE ALL (N)  +
//     ● New thread                  switchboard
//     ● fix the fit queue           lodestar
//
// The band owns its HEADER (SideMenu renders <ThreadsSection /> and nothing
// else for this band): `THREADS` and `SEE ALL` both open the history screen
// (`{screen:"threads"}`), `SEE ALL` carries the ACTIVE count, and `+` creates
// a thread IMMEDIATELY — titled `New thread`, in the active thread's repo
// (else the last-used repo, else the tab's cwd) — and puts the title into
// inline rename (threadStore.requestThreadRename). The repo picker dialog is
// not on this band any more; Ctrl+T still has one.
//
// Rows are dense 11.5px: status dot + title + a DIM PROJECT SUFFIX in flat
// mode (tabLabel.tabRepoSuffix's rule, so `switchboard · Sep 1` does not print
// the project twice) + the `⋯` menu, which appears on HOVER/FOCUS only. No
// chips except `↓ N` (unread posts) and `?` (agent waiting) — the status
// dot's statusConfig color is the ONLY color allowed; a dead row is the
// exited color and no chip: clicking it revives.
//
// FLAT in bare mode: live threads first, then most recent by last activity,
// capped by selectMenuThreads' rule (a live thread is never truncated out —
// the count on SEE ALL says how many more there are). The SWIT-46 project
// GROUP HEADERS and the `shells` group render in FULL shell mode only
// (`?shell=full` / config `shell_mode`); both modes draw the same rows through
// threadStore.menuThreadRows, which is also what Ctrl+1–9 counts.
//
// Data flows from the threadStore singleton (useThreadsView); actions flow
// back through the registered ThreadActions bridge (App owns session
// creation/revival).

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { AgentStatus, Thread } from "../types";
import {
  useThreadsView,
  getThreadActions,
  activeThreads,
  selectMenuThreads,
  groupMenuThreads,
  selectShellSessions,
  threadRepoName,
  clearThreadRenameRequest,
} from "../lib/threadStore";
import type { MenuSession } from "../lib/threadStore";
import { navigate } from "../lib/route";
import { STATUS_CONFIGS } from "../lib/statusConfig";
import { getExplorerActions } from "../lib/explorer";
import { useShellMode } from "../lib/shellMode";
import { tabRepoSuffix } from "../lib/tabLabel";
import { ThreadRowMenu, ThreadTitleEditor, threadMenuItems } from "./ThreadRowMenu";

/** Dead rows use the EXITED status colour — read from statusConfig, the
 *  single source of truth, so a palette change lands here too. */
const EXITED_COLOR = STATUS_CONFIGS.exited.color;

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 12px",
  background: "none",
  border: "none",
  boxShadow: "none",
  color: "var(--text-secondary)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  textAlign: "left",
  cursor: "pointer",
};

/** The `⋯` slot. Fixed width, ALWAYS rendered — increment B made the rail's
 *  icon column exact and a hover-conditional element in the flow would undo
 *  that by re-flowing the row under the cursor (the tab strip's `×` learned
 *  the same lesson). Only the trigger's `visibility` toggles. */
const MENU_SLOT_STYLE: CSSProperties = {
  flex: "none",
  width: 14,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const CHIP_STYLE: CSSProperties = {
  flex: "none",
  fontSize: 9,
  border: "1px solid var(--border-subtle)",
  borderRadius: 4,
  padding: "0 5px",
  color: "var(--text-muted)",
  whiteSpace: "nowrap",
};

/** The header's small-caps voice — the same 9.5px uppercase the other band
 *  labels use (SideMenu.SectionLabel), so the band reads as one of them. */
const HEADER_TEXT: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  textTransform: "uppercase",
  letterSpacing: 1,
  whiteSpace: "nowrap",
};

const HEADER_BUTTON: CSSProperties = {
  ...HEADER_TEXT,
  background: "none",
  border: "none",
  boxShadow: "none",
  padding: 0,
  cursor: "pointer",
  color: "var(--text-dim)",
};

export function ThreadsSection() {
  const view = useThreadsView();
  const bare = useShellMode() === "bare";

  // The rows: selectMenuThreads caps the rail at MENU_THREAD_LIMIT but never
  // truncates a LIVE thread out (you must always be able to reach the
  // conversation you are having). ARCHIVED threads are not on this rail at all
  // (increment E) and the header's count is the ACTIVE count for the same
  // reason — SEE ALL opens the history screen's Active tab, and a total that
  // included put-away threads would promise rows that tab does not show.
  const active = activeThreads(view.threads);
  const shown = selectMenuThreads(view.threads, view.launched);
  // Full mode keeps the SWIT-46 grouping (a fold over the same selection).
  const groups = bare ? null : groupMenuThreads(view.threads, view.launched);

  // The `shells` group: tab sessions no thread record claims (a plain Ctrl+T
  // shell — the promote-on-claude rule). Full mode only (SWIT-55).
  const shells = bare ? [] : selectShellSessions(view.threads, view.menuSessions);

  const row = (t: Thread, withSuffix: boolean) => (
    <ThreadRow
      key={t.id}
      thread={t}
      live={view.launched.has(t.id)}
      booting={view.booting.has(t.id)}
      status={t.sessionId ? view.sessionStatuses[t.sessionId] : undefined}
      active={t.sessionId !== null && t.sessionId === view.activeSessionId}
      unread={view.unreadPosts[t.id] ?? 0}
      suffix={withSuffix ? tabRepoSuffix(t.title, threadRepoName(t.workingDir)) : null}
      renameRequested={view.renameRequest === t.id}
    />
  );

  return (
    <>
      <BandHeader total={active.length} />
      {groups
        ? groups.map((g) => (
            <div key={g.project}>
              <GroupHeader project={g.project} meta={g.liveCount > 0 ? `${g.liveCount} ●` : undefined} />
              {g.threads.map((t) => row(t, false))}
            </div>
          ))
        : shown.map((t) => row(t, true))}
      {shells.length > 0 && (
        <div>
          <GroupHeader project="shells" meta={String(shells.length)} />
          {shells.map((s) => (
            <ShellRow key={s.id} session={s} active={s.id === view.activeSessionId} />
          ))}
        </div>
      )}
    </>
  );
}

/** `THREADS · SEE ALL (N) · +` (SWIT-56). The label and SEE ALL both open the
 *  history screen — reachable however short the list is — and `N` is the
 *  ACTIVE count (the history screen's Active tab), dim so the word leads.
 *  `+` creates directly through the actions bridge; nothing here knows how. */
function BandHeader({ total }: { total: number }) {
  const [seeAllHover, setSeeAllHover] = useState(false);
  const [plusHover, setPlusHover] = useState(false);
  const openHistory = () => navigate({ screen: "threads" });
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px 4px",
      }}
    >
      <span
        onClick={openHistory}
        title="Open the full thread history"
        style={{ ...HEADER_TEXT, color: "var(--text-dim)", cursor: "pointer", flex: 1, minWidth: 0 }}
      >
        Threads
      </span>
      <button
        type="button"
        onClick={openHistory}
        onMouseEnter={() => setSeeAllHover(true)}
        onMouseLeave={() => setSeeAllHover(false)}
        title={`${total} active thread${total === 1 ? "" : "s"} — open the full history`}
        style={{ ...HEADER_BUTTON, color: seeAllHover ? "var(--text-primary)" : "var(--text-dim)" }}
      >
        See all <span style={{ color: "var(--text-faint)", letterSpacing: 0 }}>({total})</span>
      </button>
      <button
        type="button"
        onClick={() => getThreadActions()?.createThreadNow()}
        onMouseEnter={() => setPlusHover(true)}
        onMouseLeave={() => setPlusHover(false)}
        title="New thread"
        aria-label="New thread"
        style={{
          ...HEADER_BUTTON,
          textTransform: "none",
          letterSpacing: 0,
          fontSize: 13,
          lineHeight: 1,
          padding: "0 2px",
          color: plusHover ? "var(--text-primary)" : "var(--text-dim)",
        }}
      >
        +
      </button>
    </div>
  );
}

/** A project group's header line (full mode) — dim, smaller than a row,
 *  carrying the live count (`2 ●`) or the shell count. Not clickable: the
 *  rows are. */
function GroupHeader({ project, meta }: { project: string; meta?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "6px 12px 1px",
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{project}</span>
      {meta && (
        <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--text-faint)" }}>{meta}</span>
      )}
    </div>
  );
}

/** A plain shell's row (full mode) — no thread record, so no menu, no revive,
 *  no rename; clicking shows its tab (the same plain switch the Projects
 *  tree's `terminals` rows make, through the same bridge). */
function ShellRow({ session, active }: { session: MenuSession; active: boolean }) {
  const [hover, setHover] = useState(false);
  const cfg = STATUS_CONFIGS[session.status] ?? STATUS_CONFIGS.idle;
  return (
    <button
      type="button"
      onClick={() => getExplorerActions()?.showSession(session.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={session.workingDir}
      style={{
        ...ROW_STYLE,
        paddingLeft: 22,
        background: active ? "var(--bg-active)" : "none",
        boxShadow: active ? "inset 2px 0 0 var(--text-primary)" : "none",
        color: active || hover ? "var(--text-primary)" : "var(--text-secondary)",
      }}
    >
      <span
        style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", backgroundColor: cfg.color }}
      />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {session.name}
      </span>
      <span style={{ flex: "none", fontSize: 9.5, color: "var(--text-dim)" }}>
        {shortDir(session.workingDir)}
      </span>
    </button>
  );
}

/** The cwd's tail, one segment — `~/projects` prints worse than `projects`
 *  helps at 218px, so one honest folder name. */
function shortDir(dir: string): string {
  const parts = dir.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function ThreadRow({
  thread,
  live,
  booting,
  status,
  active,
  unread,
  suffix,
  renameRequested,
}: {
  thread: Thread;
  /** claude launched for this thread in THIS app run (create or revive). */
  live: boolean;
  booting: boolean;
  status: AgentStatus | undefined;
  active: boolean;
  /** Unread cross-thread posts (`↓ N`, SWIT-52). */
  unread: number;
  /** The dim project name after the title (flat mode), already de-duplicated
   *  against the title by tabLabel; null draws nothing (grouped mode, or a
   *  title that leads with the project). */
  suffix: string | null;
  /** threadStore asked for this row's title to open in rename (the header
   *  `+`, SWIT-56). Honoured once, then cleared. */
  renameRequested: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const actions = getThreadActions();

  useEffect(() => {
    if (!renameRequested) return;
    setEditing(true);
    clearThreadRenameRequest(thread.id);
  }, [renameRequested, thread.id]);

  // Dead = no claude process behind the row (app restart, session exit, tab
  // close). The dot goes --st-exited; the click revives.
  const dead = !live;
  const dotColor =
    live && status ? STATUS_CONFIGS[status].color : EXITED_COLOR;

  const handleClick = () => {
    if (!actions) return;
    if (dead && !booting) actions.reviveThread(thread.id);
    else actions.openThread(thread.id);
  };

  const dot = (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        flex: "none",
        backgroundColor: dotColor,
      }}
    />
  );

  // RENAME (Decision 4). A <button> may not contain an <input>, so the editing
  // row is a plain <div> with the SAME ROW_STYLE — identical geometry, no
  // gutter movement, and no invalid nesting. The row's click actions are
  // deliberately absent while editing: a click inside the box is a caret
  // placement, not "open this thread".
  if (editing) {
    return (
      <div style={{ ...ROW_STYLE, paddingLeft: 22, cursor: "default", background: "var(--bg-active)" }}>
        {dot}
        <ThreadTitleEditor thread={thread} onDone={() => setEditing(false)} />
        <span style={MENU_SLOT_STYLE} />
      </div>
    );
  }

  const menuVisible = hover || focusWithin || menuOpen;

  return (
    <button
      type="button"
      onClick={handleClick}
      onDoubleClick={(e) => {
        // Double-click = rename, the fast path. The single-click that precedes
        // it has already run (open/revive) — harmless in both directions: the
        // thread's tab is shown, or a dead thread starts reviving while you
        // retitle it, which is exactly what the menu's Rename would do too.
        e.preventDefault();
        setEditing(true);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={() => setFocusWithin(false)}
      title={thread.workingDir}
      style={{
        ...ROW_STYLE,
        paddingLeft: 22,
        background: active ? "var(--bg-active)" : "none",
        boxShadow: active ? "inset 2px 0 0 var(--text-primary)" : "none",
        color: active || hover ? "var(--text-primary)" : "var(--text-secondary)",
      }}
    >
      {dot}
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
      {suffix && (
        <span
          style={{
            flex: "none",
            maxWidth: 72,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 9.5,
            color: "var(--text-dim)",
          }}
        >
          {suffix}
        </span>
      )}
      {/* Chips: `↓ N` (unread posts), then `?` (agent waiting on you) or
          booting. No revive chip (SWIT-56): the dot says dead, the click
          revives. */}
      {unread > 0 && (
        <span style={{ ...CHIP_STYLE, color: "var(--text-primary)", borderColor: "var(--text-secondary)" }}>
          {unread} ↓
        </span>
      )}
      {booting ? (
        <span style={CHIP_STYLE}>⟳ booting…</span>
      ) : live && status === "waiting" ? (
        <span
          style={{
            ...CHIP_STYLE,
            background: STATUS_CONFIGS.waiting.color,
            color: "#0C0C0E",
            borderColor: "transparent",
            fontWeight: 600,
          }}
        >
          ?
        </span>
      ) : null}
      {/* RESERVED SLOT, not conditional rendering: the `⋯` occupies its width
          whether or not it is showing, so sweeping the rail never re-flows a
          row's title. Shown on hover/keyboard focus (Ky's `group-hover` /
          `focus`), and while its menu is open — the pointer is over the menu
          by then, not the row. Last in the row, at the right edge, as Ky
          draws it. */}
      <span style={MENU_SLOT_STYLE}>
        <span style={{ visibility: menuVisible ? "visible" : "hidden" }}>
          <ThreadRowMenu
            ariaLabel="Thread actions"
            onOpenChange={setMenuOpen}
            items={threadMenuItems({ thread, live, openVerb: false, onRename: () => setEditing(true) })}
          />
        </span>
      </span>
    </button>
  );
}
