// Thread ROW ACTIONS (increment E) — the two pieces of chrome the side-menu
// rail and the history screen share: the `⋯` menu (Decision 2) and the inline
// title editor behind Rename (Decision 4). Both surfaces render their own row,
// but the verbs they offer and the way a title is edited must be identical, so
// both live here rather than being written twice.
//
// THE MENU (Decision 2)
//
// It replaces the bare `×` that used to sit on a thread row. A single-click
// destructive affordance on a hover-revealed 10px glyph in a dense rail is a
// mis-click waiting to happen, and it was also the ONLY action a row had —
// Open, Rename and Archive had nowhere to live. A menu solves both: one
// trigger, four verbs, and the destructive one now goes through a dialog
// (App.handleConfirmDeleteThread).
//
// STRUCTURE — why the popup is a PORTAL:
//   · A side-menu row is a <button>. Interactive content nested inside a
//     button is invalid and does not reliably receive focus, so the popup
//     cannot be a DOM child of the row.
//   · The rail is `overflow-y: auto`; an in-flow popup would be clipped by it.
//   · React events still bubble through the COMPONENT tree from a portal, so
//     every handler below stops propagation — otherwise choosing "Rename"
//     would also fire the row's own click (open/revive the thread).
//
// Positioning is `position: fixed` against the trigger's measured rect, with a
// flip up / clamp left when the menu would leave the viewport. Closed on Esc,
// on an outside mousedown, and on any scroll (a rail scroll would otherwise
// leave the menu floating over an unrelated row).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, FocusEvent } from "react";
import type { Thread } from "../types";
import { getThreadActions, isThreadArchived, renameEditorHoldsFocus } from "../lib/threadStore";
import { Icon, type IconName } from "./icons";

export type ThreadMenuItem = {
  /** Stable key + the label the user reads. */
  label: string;
  icon: IconName;
  /** Delete only: red text, and it sits last behind a separator. */
  destructive?: boolean;
  onSelect: () => void;
};

/** THE menu's contents, for both surfaces — the rail and the history screen
 *  build their rows differently but must offer the same verbs in the same
 *  order, so the list is assembled once here.
 *
 *  An ARCHIVED row offers Unarchive + Delete only (Decision 5): Open and
 *  Rename on a row you have explicitly put away are noise, and Archive is
 *  meaningless. Reviving an archived thread is still possible — it unarchives
 *  and comes back everywhere (threadStore.markThreadLaunched).
 *
 *  The verbs read in the rail's own lowercase voice ("open full", "new
 *  thread"), and the first one names what will ACTUALLY happen: a dead thread
 *  is revived, not merely shown. The RAIL omits that first verb (SWIT-56, Ky's
 *  `Rename · Archive · Delete`): its row IS the open/revive click, so the menu
 *  would only repeat it. The history screen keeps it — there a row click also
 *  opens, but the screen is where you go to find a thread, and the verb says
 *  which of the two things the click will do. */
export function threadMenuItems(args: {
  thread: Thread;
  /** claude is running behind this row in this app run. */
  live: boolean;
  /** Start this surface's inline title edit. */
  onRename: () => void;
  /** Lead with `open`/`revive` (default). The rail passes false. */
  openVerb?: boolean;
}): ThreadMenuItem[] {
  const { thread, live, onRename, openVerb = true } = args;
  const actions = getThreadActions();
  const del: ThreadMenuItem = {
    label: "delete…",
    icon: "trash",
    destructive: true,
    onSelect: () => actions?.confirmDeleteThread(thread.id),
  };
  if (isThreadArchived(thread)) {
    return [
      {
        label: "unarchive",
        icon: "unarchive",
        onSelect: () => actions?.setThreadArchived(thread.id, false),
      },
      del,
    ];
  }
  const open: ThreadMenuItem = {
    label: live ? "open" : "revive",
    icon: "open",
    onSelect: () =>
      live ? actions?.openThread(thread.id) : actions?.reviveThread(thread.id),
  };
  return [
    ...(openVerb ? [open] : []),
    { label: "rename", icon: "rename", onSelect: onRename },
    {
      label: "archive",
      icon: "archive",
      onSelect: () => actions?.setThreadArchived(thread.id, true),
    },
    del,
  ];
}

const MENU_STYLE: CSSProperties = {
  position: "fixed",
  zIndex: 240,
  minWidth: 156,
  padding: "4px 0",
  background: "var(--bg-active)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  boxShadow: "0 10px 30px rgba(0,0,0,0.55)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  outline: "none",
};

const ITEM_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 10px",
  background: "none",
  border: "none",
  boxShadow: "none",
  color: "var(--text-secondary)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  textAlign: "left",
  cursor: "pointer",
};

/** Destructive red — the same functional red ConfirmDialog's destructive
 *  button uses. The soft palette's one exception is "colour that MEANS
 *  something"; nothing else in this menu is coloured. */
const DESTRUCTIVE_COLOR = "var(--accent-red)";

const MENU_WIDTH = 156;
const ITEM_HEIGHT = 24;

export function ThreadRowMenu({
  items,
  ariaLabel,
  /** Rail rows reserve the trigger's slot and reveal it on hover; the parent
   *  owns that (it knows about hover) and tells us to stay visible while open
   *  through `onOpenChange`. */
  onOpenChange,
  triggerStyle,
  size = 12,
}: {
  items: ThreadMenuItem[];
  ariaLabel: string;
  onOpenChange?: (open: boolean) => void;
  triggerStyle?: CSSProperties;
  size?: number;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const close = useCallback(() => {
    setOpen(false);
    setPos(null);
    onOpenChange?.(false);
  }, [onOpenChange]);

  const openMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = items.length * ITEM_HEIGHT + 10;
    // Flip up when the menu would run off the bottom; clamp so it never runs
    // off the right edge of a narrow window.
    const top = rect.bottom + height > window.innerHeight ? rect.top - height : rect.bottom + 2;
    const left = Math.max(4, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 4));
    setPos({ top: Math.max(4, top), left });
    setActiveIndex(0);
    setOpen(true);
    onOpenChange?.(true);
  }, [items.length, onOpenChange]);

  // Focus the menu itself once it exists — arrow keys and Esc are handled
  // there, so the menu must own focus the moment it opens (Decision 2's
  // "keyboard-navigable").
  useLayoutEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  // Dismissal that is NOT a click on an item: outside mousedown, and any
  // scroll (capture phase — the rail's own scroller does not bubble).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onScroll = () => close();
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close]);

  const choose = (index: number) => {
    const item = items[index];
    close();
    item?.onSelect();
  };

  return (
    <>
      <span
        ref={triggerRef}
        role="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (open) close();
          else openMenu();
        }}
        // The row beneath double-clicks into rename; a fast double-tap on the
        // trigger must not also start an edit behind the open menu.
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            openMenu();
          }
        }}
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: open ? "var(--text-primary)" : "var(--text-dim)",
          cursor: "pointer",
          ...triggerStyle,
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.color = open
            ? "var(--text-primary)"
            : "var(--text-dim)";
        }}
      >
        <Icon name="ellipsis" size={size} />
      </span>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={ariaLabel}
            tabIndex={-1}
            // Portalled, but React events still travel the COMPONENT tree —
            // without these the row underneath would act on every click and
            // keystroke aimed at the menu.
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              switch (e.key) {
                case "Escape":
                  e.preventDefault();
                  close();
                  break;
                case "ArrowDown":
                  e.preventDefault();
                  setActiveIndex((i) => (i + 1) % items.length);
                  break;
                case "ArrowUp":
                  e.preventDefault();
                  setActiveIndex((i) => (i - 1 + items.length) % items.length);
                  break;
                case "Home":
                  e.preventDefault();
                  setActiveIndex(0);
                  break;
                case "End":
                  e.preventDefault();
                  setActiveIndex(items.length - 1);
                  break;
                case "Enter":
                case " ":
                  e.preventDefault();
                  choose(activeIndex);
                  break;
              }
            }}
            onBlur={(e) => {
              // Focus left the menu entirely (window blur keeps relatedTarget
              // null-but-inside, hence the containment test).
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
            }}
            style={{ ...MENU_STYLE, top: pos.top, left: pos.left, width: MENU_WIDTH }}
          >
            {items.map((item, i) => (
              <div
                key={item.label}
                role="menuitem"
                tabIndex={-1}
                onClick={() => choose(i)}
                onMouseEnter={() => setActiveIndex(i)}
                style={{
                  ...ITEM_STYLE,
                  color: item.destructive
                    ? DESTRUCTIVE_COLOR
                    : activeIndex === i
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                  background: activeIndex === i ? "var(--bg-elevated)" : "none",
                  // The destructive verb is set apart, not just recoloured —
                  // it must not read as the fourth of four equivalent items.
                  borderTop: item.destructive ? "1px solid var(--border-subtle)" : "none",
                  marginTop: item.destructive ? 4 : 0,
                  paddingTop: item.destructive ? 6 : 5,
                }}
              >
                <Icon name={item.icon} size={12} />
                <span>{item.label}</span>
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

// ── Inline title editor (Decision 4) ─────────────────────────────────────────

/** Edit a thread's title IN PLACE. Reached two ways on both surfaces: a
 *  double-click on the row (fast, and the reason it is in-place at all) and
 *  the `⋯` menu's Rename (discoverable — double-click alone is not, the same
 *  lesson the side-menu toggle taught).
 *
 *  Enter commits, Esc cancels, blur commits (a click elsewhere is not a
 *  cancel — nothing was destroyed and re-typing the name would be the
 *  surprise). An EMPTY box commits too: threadStore.renameThread substitutes
 *  the record's derived default rather than persisting a blank row.
 *
 *  The rename is LOCAL to Switchboard's record — claude's session has no title
 *  and is never touched — and rides the existing persistence, so it survives a
 *  restart like every other field.
 *
 *  ONE blur is not a commit: the box a `+` opened (SWIT-56) is on screen while
 *  the new pane's terminal focuses ITSELF — from the pane's visibility effect,
 *  or from the show-fit's `shouldFocus` several frames later. That blur has
 *  xterm's helper textarea as its `relatedTarget` and no pointer gesture
 *  behind it; `threadStore.renameEditorHoldsFocus` calls it a steal and the
 *  box takes focus back. A click on the terminal commits as before. */
export function ThreadTitleEditor({
  thread,
  onDone,
  style,
}: {
  thread: Thread;
  onDone: () => void;
  style?: CSSProperties;
}) {
  const [value, setValue] = useState(thread.title);
  const committed = useRef(false);
  const openedAt = useRef(Date.now());
  const pointerSinceOpen = useRef(false);

  useEffect(() => {
    // Capture phase, document-wide: a pointer anywhere (the terminal above
    // all) marks the next blur as the user's, whatever it lands on.
    const mark = () => { pointerSinceOpen.current = true; };
    document.addEventListener("pointerdown", mark, true);
    return () => document.removeEventListener("pointerdown", mark, true);
  }, []);

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    getThreadActions()?.renameThread(thread.id, value);
    onDone();
  };

  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    const to = e.relatedTarget;
    const blurredToTerminal =
      to instanceof HTMLElement && to.classList.contains("xterm-helper-textarea");
    if (
      renameEditorHoldsFocus({
        blurredToTerminal,
        pointerSinceOpen: pointerSinceOpen.current,
        ageMs: Date.now() - openedAt.current,
      })
    ) {
      const el = e.currentTarget;
      // After the steal's own focus step has finished, not inside it.
      window.requestAnimationFrame(() => {
        if (!committed.current && document.body.contains(el)) el.focus();
      });
      return;
    }
    commit();
  };

  return (
    <input
      autoFocus
      value={value}
      aria-label="Thread title"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      // The row beneath is a click target; typing in this box is not a click
      // on it, and Esc here is not the app's Esc.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={handleBlur}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          committed.current = true; // blur must not then commit
          onDone();
        }
      }}
      style={{
        flex: 1,
        minWidth: 0,
        background: "var(--bg-elevated)",
        border: "1px solid var(--text-secondary)",
        borderRadius: 3,
        padding: "1px 5px",
        color: "var(--text-primary)",
        fontFamily: "var(--font-mono)",
        fontSize: "inherit",
        outline: "none",
        ...style,
      }}
    />
  );
}
