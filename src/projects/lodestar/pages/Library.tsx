/**
 * "See all" browse page for Cases or Threads (owner ask, Ky-style): search, Active/Archived
 * tabs, one-line entries. Click to open in the Playground; archive/unarchive to shelve.
 * The rail shows the recent/active few; this is the full library.
 */

import { useEffect, useState } from "react";
import { useSurfaceNav } from "../../../surfaces/page-api";
import { api, type Case, type Thread } from "../api/client";
import { useUiStore } from "../stores/uiStore";

/** "Jul 7 · 14:07 PT" — the owner's frame. */
function fmtWhen(ts: string): string {
  const s = ts.replace(" ", "T");
  const d = new Date(s.endsWith("Z") ? s : `${s}Z`);
  return `${new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(d)} PT`;
}

export default function Library({ kind }: { kind: "cases" | "threads" }) {
  const nav = useSurfaceNav();
  const setPendingCase = useUiStore((s) => s.setPendingCase);
  const setSelectedThread = useUiStore((s) => s.setSelectedThread);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [cases, setCases] = useState<Case[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);

  const load = (): void => {
    if (kind === "cases") api.listCases({ include_archived: true }).then(setCases).catch(() => setCases([]));
    else api.getThreads(true).then(setThreads).catch(() => setThreads([]));
  };
  useEffect(() => {
    setTab("active");
    setQ("");
    load();
  }, [kind]);

  const all: (Case | Thread)[] = kind === "cases" ? cases : threads;
  const activeCount = all.filter((x) => !x.archived).length;
  const archivedCount = all.filter((x) => x.archived).length;

  const ql = q.trim().toLowerCase();
  const items = all
    .filter((x) => x.archived === (tab === "archived"))
    .filter((x) => {
      if (!ql) return true;
      if (x.title.toLowerCase().includes(ql)) return true;
      if (kind === "cases") return ((x as Case).hypothesis ?? "").toLowerCase().includes(ql);
      return (x as Thread).messages.some((m) => (m.text ?? "").toLowerCase().includes(ql));
    });

  const openItem = (id: string): void => {
    if (kind === "cases") setPendingCase(id);
    else setSelectedThread(id);
    nav.openPage("playground");
  };
  const toggleArchive = async (id: string, archived: boolean): Promise<void> => {
    if (kind === "cases") await api.patchCase(id, { archived: !archived }).catch(() => {});
    else await api.updateThreadMeta(id, { archived: !archived }).catch(() => {});
    load();
  };

  const Tab = ({ id, label }: { id: "active" | "archived"; label: string }) => (
    <button type="button" onClick={() => setTab(id)} className={`rounded-md px-3 py-1 font-mono text-[12px] ${tab === id ? "bg-surface2 text-text" : "text-dim hover:text-text"}`}>
      {label}
    </button>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-4 text-2xl text-text">{kind === "cases" ? "Cases" : "Threads"}</h1>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${kind} — titles${kind === "threads" ? " and message text" : " and hypotheses"}`}
        className="mb-3 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-text placeholder:text-dim focus:border-accent focus:outline-none"
      />
      <div className="mb-4 flex gap-2">
        <Tab id="active" label={`Active (${activeCount})`} />
        <Tab id="archived" label={`Archived (${archivedCount})`} />
      </div>
      {items.length === 0 ? (
        <div className="py-10 text-center font-mono text-[12px] text-dim">nothing here{ql ? " for that search" : ""}.</div>
      ) : (
        <div className="space-y-1">
          {items.map((it) => {
            const id = kind === "cases" ? (it as Case).case_id : (it as Thread).thread_id;
            const meta =
              kind === "cases"
                ? `${(it as Case).stream} · ${(it as Case).disposition} · ${(it as Case).pins.length} evidence · ${fmtWhen(it.updated_at)}`
                : `${(it as Thread).messages.length} msg · ${fmtWhen(it.updated_at)}`;
            return (
              <div key={id} className="group rounded-lg border border-line px-4 py-2.5 hover:bg-surface2/30">
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => openItem(id)} className="min-w-0 flex-1 truncate text-left text-sm text-text hover:text-accent">
                    {it.title}
                  </button>
                  <button type="button" onClick={() => void toggleArchive(id, it.archived)} className="shrink-0 font-mono text-[10px] uppercase text-dim opacity-0 hover:text-accent group-hover:opacity-100">
                    {it.archived ? "unarchive" : "archive"}
                  </button>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[10px] text-dim2">
                  <span>{meta}</span>
                  {it.labels.slice(0, 4).map((t) => (
                    <span key={t} className="rounded bg-surface2/60 px-1.5">#{t}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
