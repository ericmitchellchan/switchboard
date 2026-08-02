// Threads section of the workstation side menu (T5) — follows the approved
// wireframe (personal-kb …/workstation-shell.html row 1) exactly: dense
// 11.5px rows, dot + title + right-aligned dim repo meta for live threads, a
// white/zinc "⟳ revive" chip for dead ones (soft palette — NO green; the
// status dot's statusConfig color is the ONLY color allowed), a booting chip
// during the ~10s revive window, and a "+ new thread" affordance at the end.
//
// Data flows from the threadStore singleton (useThreadsView); actions flow
// back through the registered ThreadActions bridge (App owns session
// creation/revival). SideMenu itself only renders <ThreadsSection /> in its
// threads section — no prop plumbing through it.

import { useState } from "react";
import type { CSSProperties } from "react";
import type { AgentStatus, Thread } from "../types";
import {
  useThreadsView,
  getThreadActions,
  activeThreads,
  selectMenuThreads,
  threadRepoName,
} from "../lib/threadStore";
import { navigate } from "../lib/route";
import { STATUS_CONFIGS } from "../lib/statusConfig";
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

export function ThreadsSection() {
  const view = useThreadsView();

  // Threads are the long history; this rail is 218px wide and has a Knowledge
  // Base and an Explorer under it. Show the most recent handful — but never
  // truncate a LIVE thread out of the list (you must always be able to reach
  // the conversation you are having), which is selectMenuThreads' whole job.
  //
  // ARCHIVED threads are not on this rail at all (increment E). The count on
  // the `See all (N)` row is the ACTIVE count for the same reason — the row
  // opens the history screen's Active tab, and a total that included put-away
  // threads would promise rows that tab does not show. selectMenuThreads drops
  // them itself, so `shown` and this count cannot disagree.
  const active = activeThreads(view.threads);
  const shown = selectMenuThreads(view.threads, view.launched);
  const hidden = active.length - shown.length;

  return (
    <>
      {shown.map((t) => (
        <ThreadRow
          key={t.id}
          thread={t}
          live={view.launched.has(t.id)}
          booting={view.booting.has(t.id)}
          status={t.sessionId ? view.sessionStatuses[t.sessionId] : undefined}
          active={t.sessionId !== null && t.sessionId === view.activeSessionId}
        />
      ))}
      {hidden > 0 && <SeeAllRow total={active.length} />}
      <NewThreadRow />
    </>
  );
}

function ThreadRow({
  thread,
  live,
  booting,
  status,
  active,
}: {
  thread: Thread;
  /** claude launched for this thread in THIS app run (create or revive). */
  live: boolean;
  booting: boolean;
  status: AgentStatus | undefined;
  active: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const actions = getThreadActions();

  // Dead = no claude process behind the row (app restart, session exit, tab
  // close). The dot goes --st-exited and the revive chip appears.
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
      <div style={{ ...ROW_STYLE, cursor: "default", background: "var(--bg-active)" }}>
        {dot}
        <ThreadTitleEditor thread={thread} onDone={() => setEditing(false)} />
        <span style={MENU_SLOT_STYLE} />
      </div>
    );
  }

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
      title={thread.workingDir}
      style={{
        ...ROW_STYLE,
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
      {/* RESERVED SLOT, not conditional rendering: the `⋯` occupies its width
          whether or not it is showing, so sweeping the rail never re-flows a
          row's title or nudges the chip beside it. It stays visible while its
          menu is open — the pointer is over the menu by then, not the row. */}
      <span style={MENU_SLOT_STYLE}>
        <span style={{ visibility: hover || menuOpen ? "visible" : "hidden" }}>
          <ThreadRowMenu
            ariaLabel="Thread actions"
            onOpenChange={setMenuOpen}
            items={threadMenuItems({ thread, live, onRename: () => setEditing(true) })}
          />
        </span>
      </span>
      {booting ? (
        <span style={CHIP_STYLE}>⟳ booting…</span>
      ) : dead ? (
        <span
          style={{
            ...CHIP_STYLE,
            color: "var(--text-primary)",
            borderColor: "var(--text-secondary)",
          }}
        >
          ⟳ revive
        </span>
      ) : (
        <span style={{ flex: "none", fontSize: 9.5, color: "var(--text-dim)" }}>
          {threadRepoName(thread.workingDir)}
        </span>
      )}
    </button>
  );
}

/** The overflow affordance: opens the full history SCREEN rather than
 *  expanding in place — a long list in this rail buries Knowledge Base and
 *  Explorer, and unbounded scroll degrades quietly as history accumulates. */
function SeeAllRow({ total }: { total: number }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigate({ screen: "threads" })}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Open the full thread history"
      style={{
        ...ROW_STYLE,
        color: hover ? "var(--text-secondary)" : "var(--text-dim)",
      }}
    >
      <span style={{ width: 8, flex: "none" }} />
      <span>See all ({total})</span>
    </button>
  );
}

function NewThreadRow() {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={() => getThreadActions()?.newThread()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...ROW_STYLE,
        color: hover ? "var(--text-secondary)" : "var(--text-dim)",
      }}
    >
      <span style={{ width: 8, textAlign: "center", flex: "none" }}>+</span>
      <span>new thread</span>
    </button>
  );
}
