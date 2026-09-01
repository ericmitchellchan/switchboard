// HOME (SWIT-45 shell → SWIT-52 filled) — the roll-up screen and the app's
// default route. Ky's lesson, adopted: Home has no content of its own —
// every block is a view over some other record:
//
//   Needs you        → every OPEN question + user-owned item + request across
//                      threads (the per-thread page files, one 5s poll while
//                      Home is on screen). Answering HERE calls the same
//                      bridge the question tab uses (acceptance 7).
//   Live now         → launched threads + the latest turn's first line.
//   Between threads  → the last hour of cross-thread posts.
//   Listening        → announced dev servers, probed (never "healthy").
//   Kept views       → the scratchpad listing (_scratch/*.view.json).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { PulsingDot } from "./PulsingDot";
import { STATUS_CONFIGS } from "../lib/statusConfig";
import {
  useThreadsView,
  getThreadActions,
  threadRepoName,
  sortThreadsForHistory,
  activeThreads,
} from "../lib/threadStore";
import type { Thread } from "../types";
import {
  parsePageFile,
  parseAnswersFile,
  parseInboxFile,
  mergePage,
} from "../lib/pageStore";
import type { InboxPost, PageItem, PageQuestion, RenderedPage } from "../lib/pageStore";
import { answerQuestion } from "../lib/panelStore";
import { readThreadFile, listScratchViews } from "../lib/ipc";
import { navigate } from "../lib/route";
import { useAllKnownServers, serverKey } from "../lib/devServer";
import { useBacklog, openItems, HOME_BACKLOG_LIMIT } from "../lib/backlogStore";
import { BacklogListing } from "./BacklogPanel";

const MONO = "var(--font-mono)";

const BLOCK_TITLE: CSSProperties = {
  fontFamily: MONO,
  fontSize: 9.5,
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: "1px",
  marginBottom: 6,
  display: "flex",
  alignItems: "baseline",
};

const BLOCK_TITLE_RIGHT: CSSProperties = {
  marginLeft: "auto",
  textTransform: "none",
  letterSpacing: 0,
  color: "var(--text-faint)",
};

const RESERVED_BOX: CSSProperties = {
  border: "1px dashed var(--border-subtle)",
  padding: 14,
  fontFamily: MONO,
  fontSize: 10.5,
  color: "var(--text-dim)",
  lineHeight: 1.6,
};

const CARD: CSSProperties = {
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  padding: "8px 10px",
  fontFamily: MONO,
  fontSize: 11,
  color: "var(--text-secondary)",
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  marginBottom: 5,
};

/** How often Home re-reads the thread files while on screen. */
const HOME_POLL_MS = 5_000;
const HOUR_MS = 60 * 60 * 1000;

/** One thread's roll-up slice. */
type ThreadDigest = {
  thread: Thread;
  page: RenderedPage;
  posts: InboxPost[];
};

export function Home({
  active,
  backlogProjects = [],
}: {
  active: boolean;
  /** SWIT-64: registry project keys, for the rows' tag menu. */
  backlogProjects?: readonly string[];
}) {
  const view = useThreadsView();
  const [digests, setDigests] = useState<ThreadDigest[]>([]);
  const [kept, setKept] = useState<string[]>([]);

  // ONE poll for every block: page + answers + inbox per active thread, and
  // the scratchpad listing — while Home is on screen only (the standing
  // active-gate rule). A failed read keeps the previous digests.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const threads = activeThreads(view.threads);
        const next: ThreadDigest[] = [];
        for (const thread of threads) {
          try {
            const [pageRaw, answersRaw, inboxRaw] = await Promise.all([
              readThreadFile(thread.id, "page.json"),
              readThreadFile(thread.id, "answers.json"),
              readThreadFile(thread.id, "inbox.json"),
            ]);
            const posts = parseInboxFile(inboxRaw);
            next.push({
              thread,
              page: mergePage(parsePageFile(pageRaw), parseAnswersFile(answersRaw), posts),
              posts,
            });
          } catch {
            // this thread's slice degrades; the rest render
          }
          if (cancelled) return;
        }
        const keptViews = await listScratchViews().catch(() => [] as string[]);
        if (cancelled) return;
        setDigests(next);
        setKept(keptViews);
      } finally {
        busy = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), HOME_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // view.threads identity churns with the store; the poll re-arms then,
    // which is exactly when the thread list actually changed.
  }, [active, view.threads]);

  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        style={{
          height: 36,
          flex: "none",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          borderBottom: "1px solid var(--border)",
          fontFamily: MONO,
          fontSize: 11.5,
          color: "var(--text-secondary)",
        }}
      >
        Home
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "3fr 2fr",
          gap: 1,
          background: "var(--border)",
          overflow: "hidden",
        }}
      >
        <div style={{ background: "var(--bg-primary)", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 16, minHeight: 0, overflowY: "auto" }}>
          <NeedsYou digests={digests} />
          <LiveNow digests={digests} />
        </div>
        <div style={{ background: "var(--bg-primary)", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 16, minHeight: 0, overflowY: "auto" }}>
          <BacklogBlock projectOptions={backlogProjects} />
          <BetweenThreads digests={digests} />
          <Listening active={active} />
          <KeptViews kept={kept} />
        </div>
      </div>
    </div>
  );
}

// ── Backlog (SWIT-64) ────────────────────────────────────────────────────────

/** Open items newest first, the first HOME_BACKLOG_LIMIT + `See all` (which
 *  opens the top bar's dropdown — the one place the whole list lives). Same
 *  row component as the dropdown; the block itself is a view over
 *  backlogStore, like every other block here. */
function BacklogBlock({ projectOptions }: { projectOptions: readonly string[] }) {
  const view = useBacklog();
  const open = openItems(view.items);
  return (
    <div>
      <div style={BLOCK_TITLE}>
        Backlog{" "}
        <span style={BLOCK_TITLE_RIGHT}>{open.length === 0 ? "empty" : String(open.length)}</span>
      </div>
      <BacklogListing
        items={open}
        limit={HOME_BACKLOG_LIMIT}
        projectOptions={projectOptions}
        empty={<div style={RESERVED_BOX}>Nothing in the backlog. Add a thought from To-dos in the top bar.</div>}
      />
    </div>
  );
}

// ── Needs you ────────────────────────────────────────────────────────────────

function NeedsYou({ digests }: { digests: ThreadDigest[] }) {
  const entries: ReactNode[] = [];
  for (const d of digests) {
    for (const q of d.page.openQuestions) {
      entries.push(<QuestionCard key={`q-${d.thread.id}-${q.id}`} digest={d} question={q} />);
    }
    for (const p of d.page.requests) {
      entries.push(<RequestCard key={`r-${d.thread.id}-${p.id}`} digest={d} post={p} />);
    }
    for (const item of d.page.userItems) {
      entries.push(<UserItemCard key={`i-${d.thread.id}-${item.id}`} digest={d} item={item} />);
    }
  }
  return (
    <div>
      <div style={BLOCK_TITLE}>
        Needs you{" "}
        <span style={BLOCK_TITLE_RIGHT}>
          {entries.length === 0 ? "nothing right now" : String(entries.length)}
        </span>
      </div>
      {entries.length === 0 ? (
        <div style={RESERVED_BOX}>
          Nothing needs you. Open questions, requests from other threads and to-dos the agent
          assigned to you collect here.
        </div>
      ) : (
        entries
      )}
    </div>
  );
}

/** An open question, answerable IN PLACE — the same bridge the question tab
 *  uses, so answering from Home behaves exactly as from the page. */
function QuestionCard({ digest, question }: { digest: ThreadDigest; question: PageQuestion }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const submit = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (clean.length === 0 || busy) return;
      setBusy(true);
      setNote(null);
      try {
        const outcome = await answerQuestion(digest.thread.id, question.id, question.text, clean, question.kind);
        setNote(outcome === "sent" ? "answered → sent to the thread" : "answered → saved on the page");
      } catch (err) {
        setNote(`could not save: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, digest.thread.id, question.id, question.text, question.kind]
  );
  return (
    <div style={{ ...CARD, flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, width: "100%" }}>
        <span style={{ flex: "none", color: "var(--text-primary)" }}>?</span>
        <span style={{ color: "var(--text-primary)", minWidth: 0 }}>
          {question.text}{" "}
          <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
            {digest.thread.title} · {threadRepoName(digest.thread.workingDir)}
          </span>
        </span>
      </div>
      {note ? (
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{note}</span>
      ) : (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {question.options.map((o) => (
            <button
              key={o}
              type="button"
              disabled={busy}
              onClick={() => void submit(o)}
              style={{
                background: "var(--bg-primary)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 3,
                color: "var(--text-secondary)",
                fontFamily: MONO,
                fontSize: 10,
                padding: "2px 8px",
                cursor: "pointer",
              }}
            >
              {o}
            </button>
          ))}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit(draft);
              e.stopPropagation();
            }}
            placeholder="type…"
            disabled={busy}
            style={{
              flex: 1,
              minWidth: 90,
              background: "var(--bg-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 3,
              color: "var(--text-primary)",
              fontFamily: MONO,
              fontSize: 10.5,
              padding: "2px 6px",
              outline: "none",
            }}
          />
        </div>
      )}
    </div>
  );
}

function RequestCard({ digest, post }: { digest: ThreadDigest; post: InboxPost }) {
  return (
    <button type="button" style={{ ...CARD, width: "100%", textAlign: "left", cursor: "pointer" }} onClick={() => getThreadActions()?.openThread(digest.thread.id)}>
      <span style={{ flex: "none", color: "var(--text-muted)" }}>→</span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ color: "var(--text-primary)" }}>{post.text}</span>
        <span style={{ display: "block", color: "var(--text-dim)", fontSize: 10, marginTop: 2 }}>
          request from {post.from} · to {digest.thread.title}
        </span>
      </span>
      <span style={{ flex: "none", color: "var(--text-dim)", fontSize: 9.5 }}>open →</span>
    </button>
  );
}

function UserItemCard({ digest, item }: { digest: ThreadDigest; item: PageItem }) {
  return (
    <button type="button" style={{ ...CARD, width: "100%", textAlign: "left", cursor: "pointer" }} onClick={() => getThreadActions()?.openThread(digest.thread.id)}>
      <span style={{ flex: "none", color: "var(--text-muted)" }}>☐</span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ color: "var(--text-primary)" }}>{item.title}</span>
        <span style={{ display: "block", color: "var(--text-dim)", fontSize: 10, marginTop: 2 }}>
          to-do · owner: you · {digest.thread.title}
          {item.note ? ` · ${item.note}` : ""}
        </span>
      </span>
      <span style={{ flex: "none", color: "var(--text-dim)", fontSize: 9.5 }}>open →</span>
    </button>
  );
}

// ── Live now ─────────────────────────────────────────────────────────────────

function LiveNow({ digests }: { digests: ThreadDigest[] }) {
  const view = useThreadsView();
  const live = view.threads.filter((t) => view.launched.has(t.id));
  const rows = sortThreadsForHistory(live, view.launched);
  const pageFor = (threadId: string) => digests.find((d) => d.thread.id === threadId)?.page;
  return (
    <div>
      <div style={BLOCK_TITLE}>
        Live now{" "}
        <span style={BLOCK_TITLE_RIGHT}>
          {rows.length === 0 ? "no live threads" : `${rows.length} thread${rows.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {rows.length === 0 ? (
        <div style={RESERVED_BOX}>
          Nothing is running. Open a thread from the side menu (Ctrl+Shift+B), or Ctrl+T for a new
          one.
        </div>
      ) : (
        rows.map((t) => {
          const status = t.sessionId ? view.sessionStatuses[t.sessionId] : undefined;
          const cfg = STATUS_CONFIGS[status ?? "idle"] ?? STATUS_CONFIGS.idle;
          const lastLine = pageFor(t.id)?.latestTurn?.lines[0] ?? null;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => getThreadActions()?.openThread(t.id)}
              style={{ ...CARD, width: "100%", textAlign: "left", cursor: "pointer", alignItems: "center" }}
            >
              <PulsingDot color={cfg.color} pulse={cfg.pulse} size={7} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ color: "var(--text-primary)" }}>{t.title}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                  {" "}
                  {threadRepoName(t.workingDir)}
                </span>
                {lastLine && (
                  <span
                    style={{
                      display: "block",
                      color: "var(--text-muted)",
                      fontSize: 10.5,
                      marginTop: 2,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {lastLine}
                  </span>
                )}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 9.5, flex: "none" }}>
                open →
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

// ── Between threads ──────────────────────────────────────────────────────────

function BetweenThreads({ digests }: { digests: ThreadDigest[] }) {
  const now = Date.now();
  const recent: Array<{ post: InboxPost; to: Thread; t: number }> = [];
  for (const d of digests) {
    for (const post of d.posts) {
      const t = Date.parse(post.at);
      if (Number.isFinite(t) && now - t <= HOUR_MS) recent.push({ post, to: d.thread, t });
    }
  }
  recent.sort((a, b) => b.t - a.t);
  return (
    <div>
      <div style={BLOCK_TITLE}>
        Between threads <span style={BLOCK_TITLE_RIGHT}>last hour</span>
      </div>
      {recent.length === 0 ? (
        <div style={RESERVED_BOX}>
          No cross-thread traffic in the last hour. Threads post here with the agent's post tool, or
          your composer's <span style={{ color: "var(--text-muted)" }}>@thread …</span> form.
        </div>
      ) : (
        recent.map(({ post, to, t }) => (
          <div key={`${to.id}-${post.id}`} style={CARD}>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                {post.from} → {to.title}
              </span>
              <span style={{ display: "block", color: "var(--text-secondary)", marginTop: 2 }}>
                “{post.text}”
              </span>
            </span>
            <span style={{ flex: "none", color: "var(--text-faint)", fontSize: 9.5 }}>
              {new Date(t).toTimeString().slice(0, 5)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// ── Kept views ───────────────────────────────────────────────────────────────

function KeptViews({ kept }: { kept: string[] }) {
  return (
    <div>
      <div style={BLOCK_TITLE}>
        Kept views <span style={BLOCK_TITLE_RIGHT}>{kept.length === 0 ? "none yet" : String(kept.length)}</span>
      </div>
      {kept.length === 0 ? (
        <div style={RESERVED_BOX}>
          A view the agent showed and you kept lands in the project's scratchpad and is listed here.
        </div>
      ) : (
        kept.map((relPath) => {
          const parts = relPath.split("/");
          const project = parts[1] ?? "";
          const name = (parts[parts.length - 1] ?? relPath).replace(/\.view\.json$/, "");
          return (
            <button
              key={relPath}
              type="button"
              title={`${relPath} — opens the raw snapshot for now; rendered reopen is a follow-up`}
              onClick={() => navigate({ screen: "kb", doc: relPath })}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                width: "100%",
                textAlign: "left",
                background: "none",
                border: "none",
                padding: "3px 0",
                fontFamily: MONO,
                fontSize: 10.5,
                color: "var(--text-secondary)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
              <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 9.5, flex: "none" }}>
                {project}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

// ── Listening (unchanged from T1) ────────────────────────────────────────────

const PROBE_MS = 5_000;

function Listening({ active }: { active: boolean }) {
  const servers = useAllKnownServers();
  const [alive, setAlive] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!active || servers.length === 0) return;
    let cancelled = false;
    const probe = () => {
      for (const hit of servers) {
        const key = serverKey(hit.url);
        fetch(hit.url, { mode: "no-cors", cache: "no-store" })
          .then(() => {
            if (!cancelled) setAlive((prev) => (prev[key] === true ? prev : { ...prev, [key]: true }));
          })
          .catch(() => {
            if (!cancelled) setAlive((prev) => (prev[key] === false ? prev : { ...prev, [key]: false }));
          });
      }
    };
    probe();
    const id = window.setInterval(probe, PROBE_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, servers]);

  return (
    <div>
      <div style={BLOCK_TITLE}>
        Listening <span style={BLOCK_TITLE_RIGHT}>probed, not health-checked</span>
      </div>
      {servers.length === 0 ? (
        <div style={RESERVED_BOX}>
          No dev servers announced yet. When a shell prints a local URL it is listed here, probed.
        </div>
      ) : (
        servers.map((hit) => {
          const key = serverKey(hit.url);
          const state = alive[key];
          const dotColor =
            state === true ? "var(--st-done, #10B981)" : state === false ? "var(--st-exited, #52525B)" : "var(--text-faint)";
          const label = state === true ? "listening" : state === false ? "not answering" : "probing…";
          return (
            <div
              key={key}
              title={
                state === true
                  ? "listening — something accepted the probe (opaque response; not a health check)"
                  : state === false
                    ? "not answering — nothing is listening on that port"
                    : "probing"
              }
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "3px 0",
                fontFamily: MONO,
                fontSize: 10.5,
                color: "var(--text-secondary)",
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor, flex: "none" }} />
              <span style={{ color: "var(--text-dim)", fontSize: 9.5 }}>{hit.source}</span>
              <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>{hit.url}</span>
              <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 9.5, flex: "none" }}>{label}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
