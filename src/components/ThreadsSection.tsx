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
// T5-REGISTRATION block — no prop plumbing through it.

import { useState } from "react";
import type { CSSProperties } from "react";
import type { AgentStatus, Thread } from "../types";
import { useThreadsView, getThreadActions } from "../lib/threadStore";
import { STATUS_CONFIGS } from "../lib/statusConfig";

const EXITED_COLOR = "#52525B"; // --st-exited

/** Cross-platform basename of the thread's workingDir — the dim repo meta. */
function repoMeta(workingDir: string): string {
  const parts = workingDir.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? workingDir;
}

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

  return (
    <>
      {view.threads.map((t) => (
        <ThreadRow
          key={t.id}
          thread={t}
          live={view.launched.has(t.id)}
          booting={view.booting.has(t.id)}
          status={t.sessionId ? view.sessionStatuses[t.sessionId] : undefined}
          active={t.sessionId !== null && t.sessionId === view.activeSessionId}
        />
      ))}
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

  return (
    <button
      type="button"
      onClick={handleClick}
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
      {hover && (
        <span
          role="button"
          aria-label="Delete thread"
          onClick={(e) => {
            e.stopPropagation();
            actions?.deleteThread(thread.id);
          }}
          style={{
            flex: "none",
            fontSize: 10,
            lineHeight: 1,
            color: "var(--text-dim)",
            padding: "0 2px",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.color = "var(--text-dim)";
          }}
        >
          ×
        </span>
      )}
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
          {repoMeta(thread.workingDir)}
        </span>
      )}
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
