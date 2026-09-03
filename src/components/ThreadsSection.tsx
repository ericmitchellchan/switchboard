// Threads band of the workstation side menu — modelled on Ky's desktop
// sidebar (SWIT-56; `ky-desktop/src/ky/main/Sidebar.tsx`, THREADS section):
//
//     THREADS                        SEE ALL (N)  +
//     ● New thread                  switchboard
//     ● fix the fit queue           lodestar
//
// The band owns its HEADER (SideMenu renders <ThreadsSection /> and nothing
// else for this band): `THREADS` and `SEE ALL` both open the history screen
// (`{screen:"threads"}`), `SEE ALL` carries the ACTIVE count, and `+` drops a
// small anchored CHOOSER (0.5.2 — Eric: "What if I don't want switchboard?"):
// the merged registry+config repo list Ctrl+T's dialog reads, the current
// default target first and PRESELECTED (Enter = the old blind create, zero
// extra cost), the rest alphabetical, `no repo — shell in <dir>` last. The
// pick creates IMMEDIATELY — titled `New thread`, title into inline rename
// (threadStore.requestThreadRename). The full picker dialog stays on Ctrl+T.
//
// Rows are dense 11.5px: status dot + title + a DIM PROJECT SUFFIX in flat
// mode (tabLabel.tabRepoSuffix's rule, so `switchboard · Sep 1` does not print
// the project twice) + the `⋯` menu, which appears on HOVER/FOCUS only. No
// chips except `↓ N` (unread posts), a dim `· N` open-question count with a
// worded tooltip (SWIT-69 — the filled `?` glyph chip is retired; the waiting
// state lives in the status dot) and `booting…` (the revive-boot window) —
// the status dot's statusConfig color is the ONLY color allowed; a dead row
// is the exited color and no chip: clicking it revives.
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
//
// SKIN (SWIT-57): the band header, the list row (hover = `--bg-active` +
// `--text-primary`, active = the same fill + the inset bar) and the chip are
// the kit's — design/wireframe-kit/components.md — nothing here is styled
// that the kit does not name.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { AgentStatus, RepoConfig, Thread } from "../types";
import {
  useThreadsView,
  getThreadActions,
  activeThreads,
  selectMenuThreads,
  groupMenuThreads,
  selectShellSessions,
  threadRepoName,
  clearThreadRenameRequest,
  quickCreateWorkingDir,
  orderThreadRepoChoices,
} from "../lib/threadStore";
import type { ThreadCreateTarget } from "../lib/threadStore";
import type { MenuSession } from "../lib/threadStore";
import { navigate } from "../lib/route";
import { STATUS_CONFIGS } from "../lib/statusConfig";
import { getExplorerActions, useSessionRepos, quickThreadTarget } from "../lib/explorer";
import { sessionDirFor } from "../lib/devServer";
import { getActiveTabSession } from "../lib/panelStore";
import { getHomeDir } from "../lib/ipc";
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

export function ThreadsSection({ repos }: { repos: readonly RepoConfig[] }) {
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
      questions={view.openQuestions[t.id] ?? 0}
      suffix={withSuffix ? tabRepoSuffix(t.title, threadRepoName(t.workingDir)) : null}
      renameRequested={view.renameRequest === t.id}
    />
  );

  return (
    <>
      <BandHeader total={active.length} repos={repos} />
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
function BandHeader({ total, repos }: { total: number; repos: readonly RepoConfig[] }) {
  const [seeAllHover, setSeeAllHover] = useState(false);
  const [plusHover, setPlusHover] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
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
        ref={plusRef}
        type="button"
        onClick={() => setChooserOpen((v) => !v)}
        onMouseEnter={() => setPlusHover(true)}
        onMouseLeave={() => setPlusHover(false)}
        title="New thread — choose a repo"
        aria-label="New thread"
        aria-haspopup="listbox"
        aria-expanded={chooserOpen}
        style={{
          ...HEADER_BUTTON,
          textTransform: "none",
          letterSpacing: 0,
          fontSize: 13,
          lineHeight: 1,
          padding: "0 2px",
          color: chooserOpen || plusHover ? "var(--text-primary)" : "var(--text-dim)",
        }}
      >
        +
      </button>
      {chooserOpen && (
        <NewThreadChooser anchor={plusRef} repos={repos} onClose={() => setChooserOpen(false)} />
      )}
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
        background: active || hover ? "var(--bg-active)" : "none",
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
  questions,
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
  /** Open page questions (SWIT-69) — the dim `· N` count with its worded
   *  tooltip; the filled `?` glyph chip is retired. */
  questions: number;
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
        background: active || hover ? "var(--bg-active)" : "none",
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
      {/* Chips: `↓ N` (unread posts), the dim `· N` open-question count
          (SWIT-69 — words, not glyphs: the tooltip says what N counts; the
          filled `?` chip is retired, the waiting status lives in the dot),
          or booting. No revive chip (SWIT-56): the dot says dead, the click
          revives. */}
      {unread > 0 && (
        <span style={{ ...CHIP_STYLE, color: "var(--text-primary)", borderColor: "var(--text-secondary)" }}>
          {unread} ↓
        </span>
      )}
      {booting ? (
        <span style={CHIP_STYLE}>booting…</span>
      ) : questions > 0 ? (
        <span
          title={`${questions} open question${questions === 1 ? "" : "s"}`}
          style={{ flex: "none", fontSize: 9.5, color: "var(--text-dim)", whiteSpace: "nowrap" }}
        >
          · {questions}
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

// ── The `+` chooser (0.5.2) ──────────────────────────────────────────────────
// Eric: "Every time I open a new thread, it automatically starts a session in
// switchboard. What if I don't want switchboard?" So the `+` asks — once,
// cheaply: the dropdown opens PRESELECTED on the current default target, so
// Enter (or a second click) is exactly the old blind create. Rows come from
// THE SAME merged registry+config list Ctrl+T's dialog reads
// (explorer.useSessionRepos); order is threadStore.orderThreadRepoChoices
// (default first, rest alphabetical, archived sunk) plus the trailing
// `no repo — shell in <dir>` row (the quick-create target). Creation goes
// through the SAME ThreadActions.createThreadNow machinery, now with a
// target; App's creatingThreadRef is the durable double-create guard and a
// local one-shot (NewThreadDialog's rule) stops the second gesture before it.
// BacklogPanel's dropdown is the pattern: portalled, fixed under the anchor,
// outside-mousedown closes, Esc closes, kit rows only.

const CHOOSER_WIDTH = 280;

function NewThreadChooser({
  anchor,
  repos,
  onClose,
}: {
  anchor: React.RefObject<HTMLButtonElement>;
  repos: readonly RepoConfig[];
  onClose: () => void;
}) {
  const view = useThreadsView();
  const { options, projects } = useSessionRepos(repos);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [homeDir, setHomeDir] = useState("");

  useEffect(() => {
    getHomeDir()
      .then(setHomeDir)
      .catch(() => setHomeDir(""));
  }, []);

  // The default target and the tab's cwd are read ONCE, on open — the
  // dropdown is transient, and rows must not reshuffle under the pointer.
  // (The registry answer still lands async; the preselection effect below is
  // what keeps the marked row selected when it does.)
  /* eslint-disable react-hooks/exhaustive-deps */
  const defaultDir = useMemo(() => quickCreateWorkingDir(view.threads, view.activeSessionId), []);
  const tabDir = useMemo(() => sessionDirFor(getActiveTabSession()), []);
  /* eslint-enable react-hooks/exhaustive-deps */

  const { repos: ordered, defaultIsRepo } = useMemo(
    () => orderThreadRepoChoices(options, defaultDir),
    [options, defaultDir]
  );
  const quick = quickThreadTarget(projects, tabDir, homeDir);
  // The no-repo row: when the default target IS a repo this is the dialog's
  // quick target (tab cwd, else home) and selects `quick`; when it is not,
  // the row IS the default — it names the resolved dir and Enter runs exactly
  // the old `+` resolution (`default`).
  const quickPath = defaultIsRepo ? quick.path : (defaultDir ?? quick.path);
  const quickTarget: ThreadCreateTarget = defaultIsRepo ? { kind: "quick" } : { kind: "default" };
  const rowCount = ordered.length + 1;
  const defaultIndex = defaultIsRepo ? 0 : rowCount - 1;

  const [selected, setSelected] = useState(defaultIndex);
  const touchedRef = useRef(false);
  useEffect(() => {
    if (!touchedRef.current) setSelected(defaultIndex);
    else setSelected((prev) => Math.min(prev, rowCount - 1));
  }, [defaultIndex, rowCount]);

  // Anchored under the `+`; re-measured on resize. `position: fixed` because
  // the rail scrolls and clips (BacklogDropdown's rule).
  useLayoutEffect(() => {
    const measure = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      setPos({
        top: r.bottom + 4,
        left: Math.max(4, Math.min(r.left, window.innerWidth - CHOOSER_WIDTH - 4)),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor]);

  useEffect(() => {
    if (pos) boxRef.current?.focus();
  }, [pos]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [anchor, onClose]);

  // One-shot like NewThreadDialog's: a double-Enter (or Enter + click) before
  // the portal unmounts must not reach createThreadNow twice.
  const submittedRef = useRef(false);
  const select = useCallback(
    (target: ThreadCreateTarget) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      getThreadActions()?.createThreadNow(target);
      onClose();
    },
    [onClose]
  );

  const targetAt = (i: number): ThreadCreateTarget => {
    const o = ordered[i];
    return o
      ? { kind: "repo", name: o.name, path: o.path, color: o.color, group: o.group }
      : quickTarget;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        touchedRef.current = true;
        setSelected((prev) => Math.min(prev + 1, rowCount - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        touchedRef.current = true;
        setSelected((prev) => Math.max(prev - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        select(targetAt(selected));
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  if (!pos) return null;
  return createPortal(
    <div
      ref={boxRef}
      tabIndex={-1}
      role="listbox"
      aria-label="New thread — choose a repo"
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: CHOOSER_WIDTH,
        maxHeight: "60vh",
        zIndex: 230,
        overflowY: "auto",
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
        fontFamily: "var(--font-mono)",
        padding: "4px 0",
        outline: "none",
      }}
    >
      {ordered.map((o, i) => (
        <ChooserRow
          key={`repo:${o.path}`}
          selected={selected === i}
          onSelect={() => select(targetAt(i))}
          onHover={() => {
            touchedRef.current = true;
            setSelected(i);
          }}
          dot={o.color}
          name={o.name}
          dim={o.archived}
          meta={defaultIsRepo && i === 0 ? "default" : undefined}
          title={o.path}
        />
      ))}
      <ChooserRow
        key="quick"
        selected={selected === rowCount - 1}
        onSelect={() => select(quickTarget)}
        onHover={() => {
          touchedRef.current = true;
          setSelected(rowCount - 1);
        }}
        dot={null}
        name={`no repo — shell in ${shortDir(quickPath) || "~"}`}
        meta={!defaultIsRepo ? "default" : undefined}
        title={quickPath}
        hairlineAbove={ordered.length > 0}
      />
    </div>,
    document.body
  );
}

/** One chooser row — the kit's list row (dot · name · dim meta), same
 *  geometry as a thread row, selection = the inset bar + `--bg-active`. */
function ChooserRow({
  selected,
  onSelect,
  onHover,
  dot,
  name,
  meta,
  dim,
  title,
  hairlineAbove,
}: {
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
  /** Repo colour; null = the quick row's dashed empty dot. */
  dot: string | null;
  name: string;
  /** `default` on the preselected row; nothing elsewhere. */
  meta?: string;
  dim?: boolean;
  title: string;
  hairlineAbove?: boolean;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      onMouseEnter={onHover}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 12px",
        cursor: "pointer",
        background: selected ? "var(--bg-active)" : "transparent",
        boxShadow: selected ? "inset 2px 0 0 var(--text-primary)" : "none",
        color: dim ? "var(--text-dim)" : selected ? "var(--text-primary)" : "var(--text-secondary)",
        fontSize: 11.5,
        whiteSpace: "nowrap",
        borderTop: hairlineAbove ? "1px solid var(--border-subtle)" : "none",
        marginTop: hairlineAbove ? 2 : 0,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          flex: "none",
          backgroundColor: dot ?? "transparent",
          border: dot ? "none" : "1px dashed var(--text-faint)",
          opacity: dim ? 0.4 : 1,
        }}
      />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {name}
      </span>
      {meta && <span style={{ flex: "none", fontSize: 9.5, color: "var(--text-faint)" }}>{meta}</span>}
    </div>
  );
}
