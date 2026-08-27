/**
 * Knowledge — the owner's personal, durable document store ("home base"). A list of
 * Markdown docs on disk (ideas / saved reports / research dumps / links) that outlive a
 * single case: revisit, edit as a living document, and let the ambient agent (^I) grab or
 * add to them. Two-way with cases: a doc can backlink to a case; the agent can promote here.
 */

import { useEffect, useMemo, useState } from "react";
import { useSurfaceNav } from "../../../surfaces/page-api";
import { api, type KnowledgeDocFull, type KnowledgeListItem, type KnowledgeType } from "../api/client";
import Markdown from "../components/Markdown";
import { ptTime } from "../lib/time";
import { useUiStore } from "../stores/uiStore";

const AC = "#6ea8d8"; // agent accent (agent-authored comments)

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Read a File as base64 (strip the data: prefix) for the JSON upload endpoint. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
const TYPES: KnowledgeType[] = ["idea", "report", "research", "link"];
const TYPE_COLOR: Record<KnowledgeType, string> = {
  idea: "#e0b45a",
  report: "#6ea8d8",
  research: "#8a8a93",
  link: "#4ea96a",
};

// Collections (the left sub-nav), keyed to our doc types + our use cases.
const COLLECTIONS: { key: KnowledgeType | "all"; label: string; desc: string }[] = [
  { key: "all", label: "All", desc: "Everything in your knowledge base." },
  { key: "report", label: "Reports", desc: "Saved hypothesis reports — the idea, rules, levels & verdict, snapshotted from the Playground." },
  { key: "research", label: "Research", desc: "Research dumps, trade CSVs, screenshots, and case snapshots to come back to. The agent reads the attachments." },
  { key: "idea", label: "Ideas", desc: "Half-baked ideas and things to explore — often the entry point for a case." },
  { key: "link", label: "Links", desc: "Saved URLs with a note." },
];

function TypeBadge({ type }: { type: KnowledgeType }) {
  return (
    <span className="rounded px-1.5 py-px font-mono text-[9px] uppercase" style={{ background: `${TYPE_COLOR[type]}22`, color: TYPE_COLOR[type] }}>
      {type}
    </span>
  );
}

interface Draft {
  title: string;
  type: KnowledgeType;
  tags: string;
  url: string;
  body: string;
}

const EMPTY_DRAFT: Draft = { title: "", type: "idea", tags: "", url: "", body: "" };

export default function Knowledge() {
  const nav = useSurfaceNav();
  const setPendingCase = useUiStore((s) => s.setPendingCase);
  const [startingCase, setStartingCase] = useState(false);
  const [items, setItems] = useState<KnowledgeListItem[]>([]);
  const [q, setQ] = useState("");
  const [collection, setCollection] = useState<KnowledgeType | "all">("all");
  const [selId, setSelId] = useState<string | null>(null);
  const [doc, setDoc] = useState<KnowledgeDocFull | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null); // non-null = editing/creating
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newComment, setNewComment] = useState("");

  // Fetch all docs once (metadata + excerpt + counts); filter by collection/search client-side.
  const load = (): void => {
    api.listKnowledge().then(setItems).catch(() => setItems([]));
  };
  useEffect(() => {
    load();
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const t of TYPES) c[t] = items.filter((i) => i.type === t).length;
    return c;
  }, [items]);
  const ql = q.trim().toLowerCase();
  const filtered = items
    .filter((i) => collection === "all" || i.type === collection)
    .filter((i) => !ql || i.title.toLowerCase().includes(ql) || i.excerpt.toLowerCase().includes(ql) || i.tags.some((t) => t.toLowerCase().includes(ql)));
  const activeCol = COLLECTIONS.find((c) => c.key === collection) ?? COLLECTIONS[0];
  const openDoc = (id: string): void => {
    setCreating(false);
    setDraft(null);
    setSelId(id);
  };

  useEffect(() => {
    setConfirmDelete(false);
    if (!selId) {
      setDoc(null);
      return;
    }
    api.getKnowledge(selId).then(setDoc).catch(() => setDoc(null));
  }, [selId]);

  const startNew = (): void => {
    setCreating(true);
    setSelId(null);
    setDoc(null);
    setDraft({ ...EMPTY_DRAFT });
  };

  const startEdit = (): void => {
    if (!doc) return;
    setCreating(false);
    setDraft({ title: doc.title, type: doc.type, tags: doc.tags.join(", "), url: doc.url ?? "", body: doc.body });
  };

  const save = async (): Promise<void> => {
    if (!draft || !draft.title.trim() || saving) return;
    setSaving(true);
    const payload = {
      title: draft.title.trim(),
      type: draft.type,
      tags: draft.tags.split(",").map((t) => t.trim()).filter(Boolean),
      url: draft.type === "link" ? draft.url.trim() || null : null,
      body: draft.body,
    };
    try {
      const out = creating ? await api.createKnowledge(payload) : await api.updateKnowledge(doc!.id, payload);
      setDraft(null);
      setCreating(false);
      setSelId(out.id);
      setDoc(await api.getKnowledge(out.id)); // full doc incl. comments (id is stable on edit)
      load();
    } finally {
      setSaving(false);
    }
  };

  const del = async (): Promise<void> => {
    if (!doc) return;
    await api.deleteKnowledge(doc.id);
    setSelId(null);
    setDoc(null);
    setConfirmDelete(false);
    load();
  };

  const openCase = (caseId: string): void => {
    setPendingCase(caseId);
    nav.openPage("playground");
  };

  // KB → case: seed a new investigation from this doc, link them, and open it.
  const startCase = async (): Promise<void> => {
    if (!doc || startingCase) return;
    setStartingCase(true);
    try {
      const seed = doc.body.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? null;
      const c = await api.createCase({
        title: doc.title,
        stream: "generic",
        subject: { kind: "situation", label: doc.title, params: { from_knowledge: doc.id } },
        hypothesis: seed,
      });
      await api.updateKnowledge(doc.id, { case_id: c.case_id });
      openCase(c.case_id); // navigate to the new case (the link persists on the doc)
    } finally {
      setStartingCase(false);
    }
  };

  const addComment = async (): Promise<void> => {
    if (!doc || !newComment.trim()) return;
    await api.addKnowledgeComment(doc.id, newComment.trim());
    setNewComment("");
    setDoc(await api.getKnowledge(doc.id));
  };

  const delComment = async (commentId: string): Promise<void> => {
    if (!doc) return;
    await api.deleteKnowledgeComment(doc.id, commentId);
    setDoc(await api.getKnowledge(doc.id));
  };

  const [uploading, setUploading] = useState(false);
  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file || !doc) return;
    setUploading(true);
    try {
      await api.addKnowledgeFile(doc.id, file.name, await fileToBase64(file));
      setDoc(await api.getKnowledge(doc.id));
    } finally {
      setUploading(false);
    }
  };
  const delFile = async (name: string): Promise<void> => {
    if (!doc) return;
    await api.deleteKnowledgeFile(doc.id, name);
    setDoc(await api.getKnowledge(doc.id));
  };

  const editing = draft !== null;

  return (
    <div className="flex h-full gap-5">
      {/* collections sub-nav (mirrors Ky's KB) */}
      <div className="flex w-52 shrink-0 flex-col gap-1">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-dim">Knowledge Base</span>
          <button type="button" onClick={startNew} title="new doc" className="font-mono text-sm text-dim hover:text-accent">+</button>
        </div>
        {COLLECTIONS.map((col) => {
          const on = collection === col.key && !selId && !editing;
          return (
            <button
              key={col.key}
              type="button"
              onClick={() => {
                setCollection(col.key);
                setSelId(null);
                setDraft(null);
                setCreating(false);
              }}
              className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${on ? "bg-surface2 text-text" : "text-dim hover:bg-surface2/40 hover:text-text"}`}
            >
              {col.key !== "all" ? <span className="h-1.5 w-1.5 rounded-full" style={{ background: TYPE_COLOR[col.key] }} /> : null}
              <span>{col.label}</span>
              <span className="ml-auto font-mono text-[10px] text-dim2">{counts[col.key] ?? 0}</span>
            </button>
          );
        })}
        <div className="mt-3 px-2 font-mono text-[10px] leading-relaxed text-dim2">
          Markdown docs on disk. Attach CSVs, screenshots &amp; reports; the agent reads them (^I).
        </div>
      </div>

      {/* main pane — browse grid, or the open doc's viewer/editor */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-line bg-surface/30 p-5">
          {editing && draft ? (
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="Title"
                className="border-b border-line bg-transparent pb-1 text-xl text-text placeholder:text-dim focus:border-accent focus:outline-none"
              />
              <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
                <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as KnowledgeType })} className="rounded border border-line bg-bg px-2 py-1 text-text">
                  {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="tags, comma, separated" className="flex-1 rounded border border-line bg-bg px-2 py-1 text-text placeholder:text-dim focus:border-accent focus:outline-none" />
              </div>
              {draft.type === "link" ? (
                <input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://…" className="rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] text-text placeholder:text-dim focus:border-accent focus:outline-none" />
              ) : null}
              <textarea
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                placeholder="Markdown — dump the idea, the research, the notes…"
                rows={18}
                className="resize-none rounded-md border border-line bg-bg p-3 font-mono text-[13px] leading-relaxed text-text placeholder:text-dim focus:border-accent focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void save()} disabled={!draft.title.trim() || saving} className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-bg disabled:opacity-40">
                  {saving ? "Saving…" : creating ? "Create" : "Save"}
                </button>
                <button type="button" onClick={() => { setDraft(null); setCreating(false); }} className="font-mono text-[11px] uppercase text-dim hover:text-text">Cancel</button>
                <span className="ml-auto font-mono text-[10px] text-dim2">Markdown · saved as a .md file on disk</span>
              </div>
            </div>
          ) : doc ? (
            <div className="mx-auto max-w-3xl">
              <button type="button" onClick={() => setSelId(null)} className="mb-3 rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-dim hover:text-text">
                ← knowledge
              </button>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <TypeBadge type={doc.type} />
                <h2 className="text-xl text-text">{doc.title}</h2>
                <div className="ml-auto flex items-center gap-3 font-mono text-[11px]">
                  <button type="button" onClick={startEdit} className="text-dim hover:text-accent">edit</button>
                  {confirmDelete ? (
                    <>
                      <span className="text-dim2">delete?</span>
                      <button type="button" onClick={() => void del()} className="text-red-400 hover:underline">yes</button>
                      <button type="button" onClick={() => setConfirmDelete(false)} className="text-dim hover:text-text">no</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(true)} className="text-dim hover:text-red-400" title="delete this doc">⋯</button>
                  )}
                </div>
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[10px] text-dim2">
                <span>updated {ptTime(doc.updated)} PT</span>
                {doc.tags.map((t) => <span key={t} className="rounded bg-surface2/60 px-1.5 py-px">#{t}</span>)}
                {doc.case_id ? (
                  <button type="button" onClick={() => openCase(doc.case_id!)} className="rounded bg-accent/15 px-1.5 py-px text-accent hover:bg-accent/25" title="open the linked case">
                    → open case {doc.case_id}
                  </button>
                ) : (
                  <button type="button" onClick={() => void startCase()} disabled={startingCase} className="rounded border border-line px-1.5 py-px text-dim hover:text-accent disabled:opacity-40" title="start a new case seeded from this doc">
                    {startingCase ? "starting…" : "→ start a case"}
                  </button>
                )}
              </div>
              {doc.type === "link" && doc.url ? (
                <a href={doc.url} target="_blank" rel="noreferrer" className="mb-3 block break-all font-mono text-[12px] text-accent hover:underline">{doc.url}</a>
              ) : null}
              {doc.body.trim() ? <Markdown text={doc.body} /> : <div className="font-mono text-[12px] text-dim">no body yet — edit to add notes.</div>}

              {/* attachments — CSVs / exports / screenshots; on disk so the agent reads them */}
              <div className="mt-8 border-t border-line pt-4">
                <div className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.1em] text-dim">
                  Attachments
                  <label className="cursor-pointer rounded border border-line px-1.5 py-px text-[10px] normal-case tracking-normal text-dim hover:text-accent">
                    {uploading ? "uploading…" : "＋ add file"}
                    <input type="file" className="hidden" onChange={(e) => void onUpload(e)} disabled={uploading} />
                  </label>
                </div>
                {doc.attachments.length === 0 ? (
                  <div className="font-mono text-[11px] text-dim2">no files — attach CSVs, exports, or screenshots; the agent can read them from disk.</div>
                ) : (
                  <div className="space-y-1">
                    {doc.attachments.map((f) => (
                      <div key={f.name} className="group flex items-center gap-2 rounded border border-line bg-surface/40 px-3 py-1.5 font-mono text-[11px]">
                        <span className="text-dim2">▤</span>
                        <span className="truncate text-text">{f.name}</span>
                        <span className="shrink-0 text-dim2">{fmtSize(f.size)}</span>
                        <a href={api.knowledgeFileUrl(doc.id, f.name)} download={f.name} className="ml-auto shrink-0 text-dim hover:text-accent">download</a>
                        <button type="button" onClick={() => void delFile(f.name)} className="shrink-0 text-dim opacity-0 hover:text-red-400 group-hover:opacity-100">×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* comments — margin notes (you + agent); the agent adds these via kb_comment */}
              <div className="mt-8 border-t border-line pt-4">
                <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-dim">Comments</div>
                <div className="space-y-1.5">
                  {doc.comments.length === 0 ? (
                    <div className="font-mono text-[11px] text-dim2">no comments yet — add one below, or ^I the agent to leave a note.</div>
                  ) : (
                    doc.comments.map((c) => (
                      <div key={c.id} className="group rounded border border-line bg-surface/40 px-3 py-1.5">
                        <div className="mb-0.5 flex items-center gap-2 font-mono text-[10px] text-dim2">
                          <span style={{ color: c.author === "agent" ? AC : undefined }}>{c.author}</span>
                          <span>{ptTime(c.ts)} PT</span>
                          <button type="button" onClick={() => void delComment(c.id)} className="ml-auto text-dim opacity-0 hover:text-red-400 group-hover:opacity-100">×</button>
                        </div>
                        <div className="whitespace-pre-wrap text-sm text-text">{c.text}</div>
                      </div>
                    ))
                  )}
                </div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addComment(); } }}
                    placeholder="add a comment…"
                    className="flex-1 rounded-md border border-line bg-bg px-2.5 py-1.5 text-sm text-text placeholder:text-dim focus:border-accent focus:outline-none"
                  />
                  <button type="button" onClick={() => void addComment()} disabled={!newComment.trim()} className="rounded-md border border-line px-2.5 py-1.5 font-mono text-[11px] uppercase text-dim hover:text-accent disabled:opacity-40">
                    comment
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-4xl">
              <h1 className="text-2xl text-text">{activeCol.label}</h1>
              <p className="mb-4 mt-1 max-w-2xl text-sm text-dim">{activeCol.desc}</p>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter — title, excerpt, tags…"
                className="mb-4 w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-text placeholder:text-dim focus:border-accent focus:outline-none"
              />
              {filtered.length === 0 ? (
                <div className="py-10 text-center font-mono text-[12px] text-dim">
                  nothing here{ql ? " for that filter" : ""} — <button type="button" onClick={startNew} className="text-accent hover:underline">create a doc</button> or ask the agent (^I) to save one.
                </div>
              ) : (
                <div className="space-y-2">
                  {filtered.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => openDoc(it.id)}
                      className="block w-full rounded-lg border border-line bg-bg/40 px-5 py-4 text-left transition-colors hover:border-line/80 hover:bg-surface2/30"
                    >
                      <div className="flex items-start gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-base text-text">{it.title}</span>
                            {collection === "all" ? <TypeBadge type={it.type} /> : null}
                          </div>
                          {it.excerpt ? <p className="mt-1 line-clamp-2 text-sm text-dim">{it.excerpt}</p> : null}
                          <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[10px] text-dim2">
                            <span>{ptTime(it.updated)} PT</span>
                            {it.n_attachments > 0 ? <span>📎 {it.n_attachments}</span> : null}
                            {it.n_comments > 0 ? <span>💬 {it.n_comments}</span> : null}
                            {it.case_id ? <span className="text-accent">→ {it.case_id}</span> : null}
                            {it.tags.slice(0, 4).map((t) => <span key={t} className="rounded bg-surface2/60 px-1.5">#{t}</span>)}
                          </div>
                        </div>
                        {it.sections.length > 0 ? (
                          <div className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
                            {it.sections.map((s) => (
                              <span key={s} className="max-w-[180px] truncate font-mono text-[10px] text-dim2">{s}</span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
      </div>
    </div>
  );
}
