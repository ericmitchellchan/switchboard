// THE BACKLOG PANEL (SWIT-64) — Ky's `To-dos · N` in the top bar's right end,
// and the dropdown under it. Eric: "backlog is normally a thought, a dump,
// whatever, an idea or something to investigate later … It can graduate to a
// ticket and/or spec … and then any item can be dumped into a thread to work
// on it. To-do list can hold an item before it goes to one of these
// locations." "We will need to have a tag for each project. It might not be a
// project, it might be just a thought because it is more personal."
//
// What is here: the quiet button (`TodosButton`, rendered by TopBar), the
// dropdown (`BacklogDropdown`: quick-add with a project-tag chip, the filter
// chips, open items newest first, `Done (N)` folded), and `BacklogRow` — the
// ONE row component Home's Backlog block reuses. Every rule about items lives
// in `lib/backlogStore.ts`; this file only draws it. The row's `⋯` is
// ThreadRowMenu's portalled menu primitive — it is generic over
// `ThreadMenuItem[]`, so nothing was written twice.
//
// OPEN IN THREAD goes through `ThreadActions.openBacklogItemInThread` (App:
// T2's direct-create path with the item's project resolved to its repo and
// the item as spawn context). The item then carries a `thread` link; the row
// shows `→` and clicking it opens (or revives) THAT thread. Graduation is
// never done here: mark ticket / mark spec only RECORD a ref Eric types (an
// inline input, no modal) — the app creates no Linear ticket and no KB file.
//
// Kit: list rows (`5px 8px`, hover `--bg-active`), 14px glyph column in
// `--text-dim`, quiet buttons, chips (9px, 1px `--border-subtle`), the kit
// input. No new colour; nothing here touches the terminal.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import {
  useBacklog,
  backlogAdd,
  backlogGraduate,
  backlogRemove,
  backlogSetStage,
  backlogSetProject,
  setBacklogPanelOpen,
  toggleBacklogPanel,
  visibleItems,
  doneItems,
  matchesFilter,
  projectsPresent,
  cycleProjectTag,
  threadLinkOf,
  stageGlyph,
  linkGlyphs,
  type BacklogFilter,
  type BacklogItem,
} from "../lib/backlogStore";
import { getThreadActions, getThreadById, isThreadLaunched } from "../lib/threadStore";
import { ThreadRowMenu, type ThreadMenuItem } from "./ThreadRowMenu";

const MONO = "var(--font-mono)";
const DROPDOWN_WIDTH = 380;

// ── The top-bar button ───────────────────────────────────────────────────────

/** `To-dos · N` (N = open items; just `To-dos` at zero). Toggles the
 *  dropdown, which anchors under this button. `defaultProject` is the ACTIVE
 *  thread's project (the quick-add tag's starting value); `projectOptions`
 *  are the registry keys the tag chip cycles through. */
export function TodosButton({
  defaultProject,
  projectOptions,
}: {
  defaultProject: string | null;
  projectOptions: readonly string[];
}) {
  const view = useBacklog();
  const ref = useRef<HTMLButtonElement>(null);
  const [hover, setHover] = useState(false);
  const open = view.panelOpen;
  const label = view.openCount > 0 ? `To-dos · ${view.openCount}` : "To-dos";
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={toggleBacklogPanel}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title="Your backlog — thoughts, to-dos, things to investigate; any item can open in a thread"
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          background: open ? "var(--bg-active)" : hover ? "var(--bg-elevated)" : "transparent",
          border: "none",
          borderRadius: 4,
          padding: "4px 8px",
          fontFamily: MONO,
          fontSize: 10.5,
          color: open || hover ? "var(--text-primary)" : "var(--text-muted)",
          cursor: "pointer",
          whiteSpace: "nowrap",
          transition: "background-color 0.15s ease, color 0.15s ease",
        }}
      >
        {label}
      </button>
      {open && (
        <BacklogDropdown
          anchor={ref}
          defaultProject={defaultProject}
          projectOptions={projectOptions}
          onClose={() => setBacklogPanelOpen(false)}
        />
      )}
    </>
  );
}

// ── The dropdown ─────────────────────────────────────────────────────────────

const INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "transparent",
  border: "1px solid var(--border-subtle)",
  borderRadius: 3,
  padding: "5px 8px",
  fontFamily: MONO,
  fontSize: 11.5,
  lineHeight: 1.5,
  color: "var(--text-primary)",
  outline: "none",
};

function chipStyle(on: boolean): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: 9,
    padding: "0 5px",
    lineHeight: "15px",
    border: `1px solid ${on ? "var(--text-secondary)" : "var(--border-subtle)"}`,
    borderRadius: 4,
    background: "transparent",
    color: on ? "var(--text-primary)" : "var(--text-muted)",
    whiteSpace: "nowrap",
    flex: "none",
    cursor: "pointer",
  };
}

function BacklogDropdown({
  anchor,
  defaultProject,
  projectOptions,
  onClose,
}: {
  anchor: React.RefObject<HTMLElement>;
  defaultProject: string | null;
  projectOptions: readonly string[];
  onClose: () => void;
}) {
  const view = useBacklog();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [tag, setTag] = useState<string | null>(defaultProject);
  const [filter, setFilter] = useState<BacklogFilter>("all");
  const [showDone, setShowDone] = useState(false);

  // Anchored under the button; re-measured on resize. `position: fixed`
  // because the top bar is `overflow: hidden`.
  useLayoutEffect(() => {
    const measure = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ top: r.bottom + 4, right: Math.max(4, window.innerWidth - r.right) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchor]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Outside mousedown closes — except inside a portalled row menu (which is
  // also outside this box) or on the anchor button (its own click toggles).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || anchor.current?.contains(t)) return;
      if (t instanceof Element && t.closest('[role="menu"]')) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [anchor, onClose]);

  const submit = useCallback(() => {
    const item = backlogAdd(draft, tag);
    if (item) setDraft("");
  }, [draft, tag]);

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const present = projectsPresent(view.items);
  const open = visibleItems(view.items, filter);
  const done = doneItems(view.items).filter((i) => matchesFilter(i, filter));
  const filterKey = filter === "all" ? "all" : filter === "none" ? "none" : filter.project;

  if (!pos) return null;
  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label="To-dos"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      style={{
        position: "fixed",
        top: pos.top,
        right: pos.right,
        width: DROPDOWN_WIDTH,
        maxWidth: "calc(100vw - 8px)",
        maxHeight: "70vh",
        zIndex: 230,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
        fontFamily: MONO,
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "10px 12px 6px", display: "flex", alignItems: "baseline" }}>
        <span style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: 1, color: "var(--text-dim)" }}>
          To-dos
        </span>
        <span style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--text-faint)" }}>
          {view.openCount === 0 ? "" : `${view.openCount} open`}
        </span>
      </div>
      <div style={{ padding: "0 12px 8px", display: "flex", gap: 6, alignItems: "center" }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder="Add a to-do…  (↵)"
          aria-label="Add a to-do"
          style={INPUT_STYLE}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--text-dim)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--border-subtle)";
          }}
        />
        <button
          type="button"
          onClick={() => setTag(cycleProjectTag(tag, projectOptions))}
          title="Project tag for the new item — click to cycle; none = just a thought"
          style={chipStyle(tag !== null)}
        >
          {tag ?? "none"}
        </button>
      </div>
      {view.lastWriteError && (
        <div style={{ padding: "0 12px 6px", fontSize: 10, color: "var(--text-muted)" }}>{view.lastWriteError}</div>
      )}
      {(present.length > 0 || filter !== "all") && (
        <div style={{ padding: "0 12px 8px", display: "flex", gap: 4, flexWrap: "wrap" }}>
          {(["all", "none", ...present] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key === "all" ? "all" : key === "none" ? "none" : { project: key })}
              aria-pressed={filterKey === key}
              style={chipStyle(filterKey === key)}
            >
              {key}
            </button>
          ))}
        </div>
      )}
      <div style={{ overflowY: "auto", minHeight: 0, padding: "0 4px 6px" }}>
        {open.length === 0 && done.length === 0 && (
          <div style={{ padding: "6px 8px 8px", fontSize: 11, color: "var(--text-faint)" }}>Nothing yet.</div>
        )}
        {open.map((item) => (
          <BacklogRow key={item.id} item={item} projectOptions={projectOptions} />
        ))}
        {done.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowDone((v) => !v)}
              style={{
                background: "none",
                border: "none",
                padding: "8px 8px 4px",
                fontFamily: MONO,
                fontSize: 9.5,
                color: "var(--text-dim)",
                cursor: "pointer",
              }}
            >
              Done ({done.length}) {showDone ? "▾" : "▸"}
            </button>
            {showDone && done.map((item) => <BacklogRow key={item.id} item={item} projectOptions={projectOptions} />)}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

// ── The row (shared with Home) ───────────────────────────────────────────────

type RefEdit = "ticket" | "spec" | null;

/** How a linked item's thread is opened: live → open; dead but known →
 *  revive; record gone → nothing (the menu still offers `open in thread`,
 *  which creates a fresh one and re-links). */
function openLinkedThread(threadId: string): boolean {
  const actions = getThreadActions();
  const thread = getThreadById(threadId);
  if (!actions || !thread) return false;
  if (isThreadLaunched(threadId)) actions.openThread(threadId);
  else actions.reviveThread(threadId);
  return true;
}

export function BacklogRow({
  item,
  projectOptions,
  /** Home's block passes a slightly larger padding; the dropdown the kit's
   *  content-row default. */
  padding = "5px 8px",
}: {
  item: BacklogItem;
  projectOptions: readonly string[];
  padding?: string;
}) {
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [edit, setEdit] = useState<RefEdit>(null);
  const [refDraft, setRefDraft] = useState("");
  // The LATEST thread link the store still knows (an item can be opened
  // into a thread more than once); with none known, the latest at all.
  const threadId = threadLinkOf(item, (id) => getThreadById(id) !== undefined);
  const linkedThreadKnown = threadId !== null && getThreadById(threadId) !== undefined;
  const done = item.stage === "done";

  const startEdit = (kind: "ticket" | "spec") => {
    setRefDraft("");
    setEdit(kind);
  };

  const commitEdit = () => {
    if (edit && refDraft.trim().length > 0) backlogGraduate(item.id, edit, refDraft);
    setEdit(null);
  };

  const items: ThreadMenuItem[] = done
    ? [
        { label: "reopen", icon: "unarchive", onSelect: () => backlogSetStage(item.id, "backlog") },
        { label: "delete", icon: "trash", destructive: true, onSelect: () => backlogRemove(item.id) },
      ]
    : [
        ...(linkedThreadKnown
          ? [{ label: "open thread", icon: "open" as const, onSelect: () => void openLinkedThread(threadId!) }]
          : [{ label: "open in thread", icon: "open" as const, onSelect: () => getThreadActions()?.openBacklogItemInThread(item.id) }]),
        { label: "mark ticket…", icon: "edit", onSelect: () => startEdit("ticket") },
        { label: "mark spec…", icon: "edit", onSelect: () => startEdit("spec") },
        ...(projectOptions.length > 0
          ? [{
              label: `tag: ${item.project ?? "none"} ›`,
              icon: "rename" as const,
              onSelect: () => backlogSetProject(item.id, cycleProjectTag(item.project, projectOptions)),
            }]
          : []),
        { label: "done", icon: "archive", onSelect: () => backlogSetStage(item.id, "done") },
        { label: "delete", icon: "trash", destructive: true, onSelect: () => backlogRemove(item.id) },
      ];

  const glyphs = linkGlyphs(item);
  const clickable = linkedThreadKnown && !done;

  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={() => {
        if (clickable && threadId) openLinkedThread(threadId);
      }}
      onKeyDown={(e) => {
        if (clickable && threadId && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          openLinkedThread(threadId);
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={
        linkedThreadKnown
          ? "Open the thread working this item"
          : glyphs.length > 0
            ? glyphs.map((g) => `${g.kind}: ${g.ref}`).join("\n")
            : undefined
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding,
        fontFamily: MONO,
        fontSize: 11.5,
        color: hover || menuOpen ? "var(--text-primary)" : done ? "var(--text-dim)" : "var(--text-secondary)",
        background: hover || menuOpen ? "var(--bg-active)" : "transparent",
        cursor: clickable ? "pointer" : "default",
        textAlign: "left",
      }}
    >
      <span style={{ width: 14, flex: "none", textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
        {stageGlyph(item.stage)}
      </span>
      {edit ? (
        <input
          autoFocus
          value={refDraft}
          onChange={(e) => setRefDraft(e.target.value)}
          placeholder={edit === "ticket" ? "ticket key or URL" : "KB path of the spec"}
          aria-label={edit === "ticket" ? "Ticket key or URL" : "Spec path"}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commitEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setRefDraft("");
              setEdit(null);
            }
          }}
          style={{ ...INPUT_STYLE, padding: "1px 5px", fontSize: "inherit", border: "1px solid var(--text-secondary)" }}
        />
      ) : (
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {item.text}
        </span>
      )}
      {item.project && (
        <span style={{ flex: "none", fontSize: 9.5, color: "var(--text-dim)", maxWidth: 72, overflow: "hidden", textOverflow: "ellipsis" }}>
          {item.project}
        </span>
      )}
      {glyphs.length > 0 && (
        <span style={{ flex: "none", fontSize: 10, color: "var(--text-muted)", letterSpacing: 1 }}>
          {glyphs.map((g) => g.glyph).join("")}
        </span>
      )}
      <span style={{ width: 14, flex: "none", display: "flex", visibility: hover || menuOpen ? "visible" : "hidden" }}>
        <ThreadRowMenu items={items} ariaLabel="Item actions" onOpenChange={setMenuOpen} />
      </span>
    </div>
  );
}

/** Home's block body: a few open rows + `See all`, which opens the dropdown
 *  (the one place the whole list lives). Empty state is one line. */
export function BacklogListing({
  items,
  limit,
  projectOptions,
  empty,
}: {
  items: readonly BacklogItem[];
  limit: number;
  projectOptions: readonly string[];
  empty: ReactNode;
}) {
  if (items.length === 0) return <>{empty}</>;
  return (
    <div>
      {items.slice(0, limit).map((i) => (
        <BacklogRow key={i.id} item={i} projectOptions={projectOptions} />
      ))}
      {items.length > limit && (
        <button
          type="button"
          onClick={() => setBacklogPanelOpen(true)}
          style={{ background: "none", border: "none", padding: "4px 8px", fontFamily: MONO, fontSize: 9.5, color: "var(--text-dim)", cursor: "pointer" }}
        >
          See all ({items.length})
        </button>
      )}
    </div>
  );
}
