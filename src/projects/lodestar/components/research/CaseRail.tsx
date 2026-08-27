/**
 * Case rail (workspace redesign · Stage 1 "Investigate"): the case's home — its
 * identity, thesis, disposition, and the conversations inside it — as a
 * collapsible left column. Open it to navigate/switch; collapse it to a spine so
 * the conversation + evidence get the room. Overview lives here; the detailed
 * evidence lives side-by-side in the pane to the right (ArtifactPane).
 */

import { useEffect, useState } from "react";
import { useSurfaceNav } from "../../../../surfaces/page-api";
import { useUiStore } from "../../stores/uiStore";
import { api, type Case, type CaseDisposition, type Thread } from "../../api/client";
import { widgetSig, type ArtifactRef } from "./CaseWorkstation";
import { ALL_DISPOSITIONS, DISPOSITION_CHIP, STREAM_COLOR, STREAM_LABEL } from "./streamTheme";

/** A prominent section header — the separator (no divider lines; whitespace groups). */
function SectionHeader({ label, count, first }: { label: string; count: number; first?: boolean }) {
  return (
    <div
      className={`${first ? "mt-5" : "mt-7"} mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.11em]`}
      style={{ color: "#9a9aa4" }}
    >
      {label} <span className="font-normal text-faint">· {count}</span>
    </div>
  );
}

/** One home item (evidence / note / artifact): click opens it in the workstation;
 *  hover reveals curate actions. */
function HomeRow({
  icon,
  title,
  sub,
  active,
  onOpen,
  onArchive,
  onDelete,
}: {
  icon: string;
  title: string;
  sub?: string;
  active: boolean;
  onOpen: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const hasMenu = Boolean(onArchive || onDelete);
  const close = (): void => {
    setMenu(false);
    setConfirm(false);
  };
  return (
    <div
      className={`group relative -ml-px flex items-start border-l-2 transition-colors ${
        active ? "border-[#5aa6c9]" : "border-transparent hover:border-line"
      }`}
    >
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-start gap-2 py-1 pl-2.5 text-left">
        <span className="mt-[3px] shrink-0 text-[11px] opacity-60">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className={`truncate text-xs ${active ? "text-text" : "text-dim group-hover:text-text"}`}>{title}</div>
          {sub ? <div className="truncate text-[11px] text-dim/60">{sub}</div> : null}
        </div>
      </button>
      {hasMenu ? (
        <button
          type="button"
          onClick={() => {
            setMenu((v) => !v);
            setConfirm(false);
          }}
          title="options"
          className="shrink-0 px-1.5 py-1 font-mono text-sm leading-none text-dim opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
        >
          ⋯
        </button>
      ) : null}
      {menu ? (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div className="absolute right-1 top-6 z-20 w-36 overflow-hidden rounded-md border border-line bg-surface2 py-0.5 shadow-lg">
            <button type="button" onClick={() => { close(); onOpen(); }} className="block w-full px-2.5 py-1 text-left text-xs text-text hover:bg-bg">
              open
            </button>
            {onArchive ? (
              <button type="button" onClick={() => { close(); onArchive(); }} className="block w-full px-2.5 py-1 text-left text-xs text-text hover:bg-bg">
                archive
              </button>
            ) : null}
            {onDelete ? (
              confirm ? (
                <div className="flex items-center border-t border-line">
                  <button type="button" onClick={() => { close(); onDelete(); }} className="flex-1 px-2.5 py-1 text-left text-xs text-dn hover:bg-bg">
                    confirm delete
                  </button>
                  <button type="button" onClick={() => setConfirm(false)} className="px-2 py-1 text-xs text-dim hover:text-text">
                    cancel
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirm(true)} className="block w-full border-t border-line px-2.5 py-1 text-left text-xs text-dn hover:bg-bg">
                  delete
                </button>
              )
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** One conversation as a line: click to open, double-click to rename inline, ⋯ for
 *  archive/delete. Keeps an optimistic local title so a rename shows instantly. */
function ConversationRow({
  t,
  active,
  onSelect,
  onRename,
  onArchive,
  onDelete,
}: {
  t: Thread;
  active: boolean;
  onSelect: () => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [title, setTitle] = useState(t.title);
  const [draft, setDraft] = useState(t.title);
  useEffect(() => setTitle(t.title), [t.title]); // let the poll catch up to the real title

  const startEdit = (): void => {
    setDraft(title);
    setEditing(true);
    setMenu(false);
  };
  const commit = (): void => {
    setEditing(false);
    const v = draft.trim();
    if (v && v !== title) {
      setTitle(v);
      onRename(t.thread_id, v);
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        className="block w-full rounded border border-accent/60 bg-bg py-1 pl-2.5 text-xs text-text focus:outline-none"
      />
    );
  }

  return (
    <div className={`group relative flex items-center border-l-2 ${active ? "border-accent" : "border-transparent hover:border-line"}`}>
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={startEdit}
        title={title}
        className={`min-w-0 flex-1 truncate py-1 pl-2.5 text-left text-xs transition-colors ${
          active ? "text-text" : "text-dim group-hover:text-text"
        }`}
      >
        {title}
      </button>
      <button
        type="button"
        onClick={() => {
          setMenu((v) => !v);
          setConfirm(false);
        }}
        title="conversation options"
        className="shrink-0 px-1.5 font-mono text-sm leading-none text-dim opacity-0 transition-opacity hover:text-text group-hover:opacity-100"
      >
        ⋯
      </button>
      {menu ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => { setMenu(false); setConfirm(false); }} />
          <div className="absolute right-1 top-6 z-20 w-28 overflow-hidden rounded-md border border-line bg-surface2 py-0.5 shadow-lg">
            <button type="button" onClick={startEdit} className="block w-full px-2.5 py-1 text-left text-xs text-text hover:bg-bg">
              rename
            </button>
            <button
              type="button"
              onClick={() => {
                setMenu(false);
                onArchive(t.thread_id);
              }}
              className="block w-full px-2.5 py-1 text-left text-xs text-text hover:bg-bg"
            >
              archive
            </button>
            {confirm ? (
              <div className="flex items-center border-t border-line">
                <button
                  type="button"
                  onClick={() => {
                    setMenu(false);
                    setConfirm(false);
                    onDelete(t.thread_id);
                  }}
                  className="flex-1 px-2.5 py-1 text-left text-xs text-dn hover:bg-bg"
                >
                  confirm delete
                </button>
                <button type="button" onClick={() => setConfirm(false)} className="px-2 py-1 text-xs text-dim hover:text-text">
                  cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirm(true)}
                className="block w-full border-t border-line px-2.5 py-1 text-left text-xs text-dn hover:bg-bg"
              >
                delete
              </button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function CaseRail({
  c,
  onCaseChanged,
  memberThreads,
  selectedId,
  collapsed,
  onToggleCollapse,
  onSelectThread,
  onNewThread,
  onUnfileThread,
  onDelete,
  onRenameThread,
  onArchiveThread,
  onDeleteThread,
  onOpenArtifact,
  activeArtifactKey,
  onArchiveItem,
  onDeletePin,
  onDeleteNote,
}: {
  c: Case;
  onCaseChanged: (updated: Case) => void;
  memberThreads: Thread[];
  selectedId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
  onUnfileThread: () => void;
  onDelete: () => void;
  onRenameThread: (id: string, title: string) => void;
  onArchiveThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  onOpenArtifact: (ref: ArtifactRef) => void;
  activeArtifactKey: string | null;
  onArchiveItem: (itemId: string) => void;
  onDeletePin: (pinId: string) => void;
  onDeleteNote: (noteId: string) => void;
}) {
  const nav = useSurfaceNav();
  const setPendingMarket = useUiStore((s) => s.setPendingMarket);
  const color = STREAM_COLOR[c.stream];
  const [hypDraft, setHypDraft] = useState(c.hypothesis ?? "");
  const [watchDraft, setWatchDraft] = useState<string | null>(null);
  // Resync the thesis draft only when the case itself changes (not every poll),
  // so a background refresh never clobbers in-progress typing.
  useEffect(() => {
    setHypDraft(c.hypothesis ?? "");
    setWatchDraft(null); // drop any half-typed watch condition from the prior case
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.case_id]);

  const [caseConfirm, setCaseConfirm] = useState(false);
  useEffect(() => setCaseConfirm(false), [c.case_id]); // reset the delete-confirm on case switch
  const subjectName = c.subject.label ?? c.subject.ticker ?? null;
  // Home sections (archived items drop out of the default view).
  const archivedSet = new Set(c.archived_ids ?? []);
  const activePins = c.pins.filter((p) => !archivedSet.has(p.pin_id));
  const activeNotes = c.notes.filter((n) => !archivedSet.has(n.note_id));
  const artifacts = c.workbench ?? [];

  const setDisposition = async (d: CaseDisposition): Promise<void> => {
    // Leaving watch/live clears the spec so the nudge engine doesn't act on a
    // persisted-but-invisible condition (review F12).
    const clearWatch = c.watch != null && d !== "watch" && d !== "live";
    const updated = await api
      .patchCase(c.case_id, clearWatch ? { disposition: d, watch: null } : { disposition: d })
      .catch(() => null);
    if (updated) onCaseChanged(updated);
  };

  const saveHypothesis = async (): Promise<void> => {
    const v = hypDraft.trim();
    if (v === (c.hypothesis ?? "")) return;
    const updated = await api.patchCase(c.case_id, { hypothesis: v || null }).catch(() => null);
    if (updated) onCaseChanged(updated);
  };

  const openSubjectChart = (): void => {
    if (!c.subject.ticker) return;
    // SWITCHBOARD: no query string — the Chart page reads the intent from the
    // project store and the shell decides where the page opens.
    setPendingMarket({ ticker: c.subject.ticker, label: c.subject.label ?? c.title, caseId: c.case_id });
    nav.openPage("chart");
  };

  // --- collapsed: a thin spine that still shows state (owner: "open the rail at
  //     any time to switch through evidence, threads, conversations") ---
  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-3 border-r border-line/60 bg-surface/40 py-3">
        <button
          type="button"
          onClick={onToggleCollapse}
          title="expand case"
          className="font-mono text-sm text-accent hover:text-text"
        >
          ›
        </button>
        <div className="flex min-h-0 flex-1 items-center">
          <span
            className="truncate font-mono text-[9px] uppercase tracking-[0.16em] text-dim"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", maxHeight: "60%" }}
            title={c.title}
          >
            {c.title}
          </span>
        </div>
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: DISPOSITION_CHIP[c.disposition].color }}
          title={`disposition · ${c.disposition}`}
        />
        <span className="font-mono text-[10px] text-text" title={`${activePins.length} evidence`}>
          {activePins.length}
        </span>
      </div>
    );
  }

  // --- expanded: the full case overview + conversation switcher ---
  return (
    <div className="flex h-full min-h-0 flex-col border-r border-line/60 bg-surface/40 px-3 py-3">
      {/* identity + collapse */}
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-wide text-dim">
          {STREAM_LABEL[c.stream]} · {c.subject.kind}
          {subjectName ? <span style={{ color }}> · {subjectName}</span> : null}
        </span>
        <button
          type="button"
          onClick={onToggleCollapse}
          title="collapse case"
          className="ml-auto shrink-0 font-mono text-sm text-dim hover:text-text"
        >
          ‹
        </button>
      </div>

      {/* disposition + subject chart + delete */}
      <div className="mt-2 flex items-center gap-2">
        <select
          value={c.disposition}
          onChange={(e) => void setDisposition(e.target.value as CaseDisposition)}
          title="case disposition"
          className="rounded-md border border-line/60 bg-bg px-1.5 py-0.5 font-mono text-[10px] focus:outline-none"
          style={{ color: DISPOSITION_CHIP[c.disposition].color }}
        >
          {ALL_DISPOSITIONS.map((d) => (
            <option key={d} value={d} className="text-text">
              {DISPOSITION_CHIP[d].label}
            </option>
          ))}
        </select>
        {c.subject.ticker ? (
          <button
            type="button"
            onClick={openSubjectChart}
            title="open this market's chart"
            className="font-mono text-[10px] text-accent hover:text-text"
          >
            chart →
          </button>
        ) : null}
        {caseConfirm ? (
          <span className="ml-auto flex items-center gap-2 font-mono text-[10px]">
            <button type="button" onClick={() => { setCaseConfirm(false); onDelete(); }} className="text-dn hover:brightness-125">
              confirm delete
            </button>
            <button type="button" onClick={() => setCaseConfirm(false)} className="text-dim hover:text-text">
              cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setCaseConfirm(true)}
            title="delete this case and its conversations"
            className="ml-auto font-mono text-[10px] text-dim hover:text-dn"
          >
            delete
          </button>
        )}
      </div>

      {/* thesis — the overarching field (always editable) */}
      <textarea
        value={hypDraft}
        onChange={(e) => setHypDraft(e.target.value)}
        onBlur={() => void saveHypothesis()}
        rows={3}
        placeholder="What's this case about? State the thesis you're testing…"
        className="mt-3 w-full resize-none bg-transparent text-xs leading-relaxed text-text placeholder:text-dim focus:outline-none"
      />

      {/* watch condition (only while watch/live) */}
      {(c.disposition === "watch" || c.disposition === "live") && (
        <div className="mt-1 rounded border border-line/50 bg-bg/40 px-2 py-1.5">
          <div className="font-mono text-[9px] uppercase text-dim">watch condition</div>
          <input
            value={watchDraft ?? String((c.watch as { condition?: string } | null)?.condition ?? "")}
            onChange={(e) => setWatchDraft(e.target.value)}
            onBlur={() => {
              if (watchDraft == null) return;
              const v = watchDraft.trim();
              void api
                .patchCase(c.case_id, {
                  watch: v ? { condition: v, set_at: new Date().toISOString() } : null,
                })
                .then((u) => {
                  onCaseChanged(u);
                  setWatchDraft(null);
                })
                .catch(() => {
                  /* keep the typed draft on screen so nothing is lost (F11) */
                });
            }}
            placeholder="e.g. next match of this player · price crosses 40c"
            className="mt-0.5 w-full bg-transparent text-xs text-text placeholder:text-dim focus:outline-none"
          />
        </div>
      )}

      {/* the case HOME — everything lives here in sections; the workstation (right)
          is just where you open them to work. Prominent headers + whitespace do the
          separating (no divider lines). */}
      <div className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
        {/* conversations */}
        <div className="flex items-baseline">
          <SectionHeader first label={`${STREAM_LABEL[c.stream].toLowerCase()} conversations`} count={memberThreads.length} />
          {selectedId ? (
            <button
              type="button"
              onClick={onUnfileThread}
              title="return the active thread to unfiled"
              className="ml-auto font-mono text-[9px] text-dim hover:text-text"
            >
              unfile
            </button>
          ) : null}
        </div>
        {memberThreads.map((t) => (
          <ConversationRow
            key={t.thread_id}
            t={t}
            active={selectedId === t.thread_id}
            onSelect={() => onSelectThread(t.thread_id)}
            onRename={onRenameThread}
            onArchive={onArchiveThread}
            onDelete={onDeleteThread}
          />
        ))}
        <button
          type="button"
          onClick={onNewThread}
          className="mt-1 block w-full pl-2.5 text-left font-mono text-[10px] text-accent hover:text-text"
        >
          + new conversation
        </button>

        {/* evidence */}
        <SectionHeader label="evidence" count={activePins.length} />
        {activePins.length === 0 ? <div className="pl-2.5 text-[11px] text-dim/60">none yet</div> : null}
        {activePins.map((p) => (
          <HomeRow
            key={p.pin_id}
            icon="◆"
            title={p.title}
            active={activeArtifactKey === `evidence:${p.pin_id}`}
            onOpen={() => onOpenArtifact({ key: `evidence:${p.pin_id}`, kind: "evidence", id: p.pin_id })}
            onArchive={() => onArchiveItem(p.pin_id)}
            onDelete={() => onDeletePin(p.pin_id)}
          />
        ))}

        {/* notes */}
        <SectionHeader label="notes" count={activeNotes.length} />
        {activeNotes.length === 0 ? <div className="pl-2.5 text-[11px] text-dim/60">none yet</div> : null}
        {activeNotes.map((n) => (
          <HomeRow
            key={n.note_id}
            icon="✎"
            title={n.text.replace(/\\n/g, " ").slice(0, 44)}
            active={activeArtifactKey === `note:${n.note_id}`}
            onOpen={() => onOpenArtifact({ key: `note:${n.note_id}`, kind: "note", id: n.note_id })}
            onArchive={() => onArchiveItem(n.note_id)}
            onDelete={() => onDeleteNote(n.note_id)}
          />
        ))}

        {/* artifacts — the agent's composed charts/tables (curate coming with stable ids) */}
        <SectionHeader label="artifacts" count={artifacts.length} />
        {artifacts.length === 0 ? (
          <div className="pl-2.5 text-[11px] text-dim/60">none yet — ask the thread to build one</div>
        ) : null}
        {artifacts.map((w, i) => {
          const sig = widgetSig(w);
          return (
            <HomeRow
              key={`${sig}:${i}`}
              icon={w.type === "table" ? "▤" : "▦"}
              title={w.title ?? w.type}
              active={activeArtifactKey === `artifact:${sig}`}
              onOpen={() => onOpenArtifact({ key: `artifact:${sig}`, kind: "artifact", id: sig })}
            />
          );
        })}
      </div>
    </div>
  );
}
