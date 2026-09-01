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
//
// SKIN (post-0.5.0, SWIT-54 — Eric: "home screen is still this weird boxy
// format"): ONE left-aligned column (max 720px, 18px padding) of kit BAND
// sections; every item is a kit LIST ROW (no border, no elevated fill, hover
// `--bg-active`, focus draws the inset bar, dim meta on the right); an empty
// section is one dim line, never a dashed box; the question controls are the
// same OptionRow list the question tab draws. Skin only — every click and
// every write goes through the same bridge it did.
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
  orderedOptions,
} from "../lib/pageStore";
import type { InboxPost, PageItem, PageQuestion, RenderedPage } from "../lib/pageStore";
import { answerQuestion } from "../lib/panelStore";
import { readThreadFile, listScratchViews } from "../lib/ipc";
import { navigate } from "../lib/route";
import { useAllKnownServers, serverKey } from "../lib/devServer";
import { useBacklog, openItems, HOME_BACKLOG_LIMIT } from "../lib/backlogStore";
import { BacklogListing } from "./BacklogPanel";
import { OptionRow } from "./kb/OptionRow";

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

/** kit: the empty-section line — one dim line, no box. */
const EMPTY_LINE: CSSProperties = {
  padding: "5px 8px",
  fontFamily: MONO,
  fontSize: 11,
  color: "var(--text-dim)",
  lineHeight: 1.5,
};

/** kit: list row (content-body variant, `5px 8px`). The row IS the target. */
const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 8px",
  background: "none",
  border: "none",
  boxShadow: "none",
  fontFamily: MONO,
  fontSize: 11.5,
  lineHeight: 1.5,
  color: "var(--text-secondary)",
  textAlign: "left",
  outline: "none",
};

/** kit: the row's leading glyph column — fixed, so titles align. */
const GLYPH: CSSProperties = {
  flex: "none",
  width: 14,
  color: "var(--text-dim)",
};

/** kit: trailing meta on a row. */
const ROW_META: CSSProperties = {
  marginLeft: "auto",
  flex: "none",
  fontSize: 9.5,
  color: "var(--text-dim)",
  whiteSpace: "nowrap",
};

/** kit: input. Transparent — the field takes the screen's surface. */
const FIELD: CSSProperties = {
  width: "100%",
  background: "transparent",
  border: "1px solid var(--border-subtle)",
  borderRadius: 3,
  color: "var(--text-primary)",
  fontFamily: MONO,
  fontSize: 11.5,
  lineHeight: 1.5,
  padding: "5px 8px",
  outline: "none",
};

/** A clickable kit row: hover `--bg-active` + `--text-primary`, keyboard
 *  focus draws the inset bar. Children lay out as the row's flex items. */
function Row({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        ...ROW,
        cursor: "pointer",
        background: hover || focus ? "var(--bg-active)" : "none",
        boxShadow: focus ? "inset 2px 0 0 var(--text-primary)" : "none",
        color: hover || focus ? "var(--text-primary)" : "var(--text-secondary)",
      }}
    >
      {children}
    </button>
  );
}

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
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div
          style={{
            maxWidth: 720,
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          <NeedsYou digests={digests} />
          <BacklogBlock projectOptions={backlogProjects} />
          <LiveNow digests={digests} />
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
        <span style={BLOCK_TITLE_RIGHT}>{open.length === 0 ? "" : String(open.length)}</span>
      </div>
      <BacklogListing
        items={open}
        limit={HOME_BACKLOG_LIMIT}
        projectOptions={projectOptions}
        empty={<div style={EMPTY_LINE}>nothing in the backlog</div>}
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
          {entries.length === 0 ? "" : String(entries.length)}
        </span>
      </div>
      {entries.length === 0 ? <div style={EMPTY_LINE}>nothing needs you</div> : entries}
    </div>
  );
}

/** An open question, answerable IN PLACE — the same bridge the question tab
 *  uses, so answering from Home behaves exactly as from the page. */
function QuestionCard({ digest, question }: { digest: ThreadDigest; question: PageQuestion }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [fieldFocus, setFieldFocus] = useState(false);
  const submit = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (clean.length === 0 || busy) return;
      setBusy(true);
      setChosen(text);
      setNote(null);
      try {
        const outcome = await answerQuestion(digest.thread.id, question.id, question.text, clean, question.kind);
        setNote(outcome === "sent" ? "answered → sent to the thread" : "answered → saved on the page");
      } catch (err) {
        setNote(`could not save: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
        setChosen(null);
      }
    },
    [busy, digest.thread.id, question.id, question.text, question.kind]
  );
  const options = orderedOptions(question);
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={ROW}>
        <span style={{ ...GLYPH, color: "var(--text-primary)" }}>?</span>
        <span style={{ color: "var(--text-primary)", minWidth: 0 }}>
          {question.text}{" "}
          <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
            {digest.thread.title} · {threadRepoName(digest.thread.workingDir)}
          </span>
        </span>
      </div>
      {note ? (
        <div style={{ ...EMPTY_LINE, color: "var(--text-muted)", paddingLeft: 30 }}>{note}</div>
      ) : (
        <div style={{ paddingLeft: 22, display: "flex", flexDirection: "column", gap: 6 }}>
          {options.length > 0 && (
            <div
              role="listbox"
              aria-label="Options"
              style={{
                display: "flex",
                flexDirection: "column",
                borderTop: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
                padding: "4px 0",
              }}
              onKeyDown={(e) => {
                // ↑/↓ walk the rows — the question tab's rule, scoped to this list.
                if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-kit-row]"));
                const i = nodes.indexOf(document.activeElement as HTMLElement);
                const next = nodes[i + (e.key === "ArrowDown" ? 1 : -1)];
                if (!next) return;
                e.preventDefault();
                next.focus();
              }}
            >
              {options.map((o) => (
                <OptionRow
                  key={o}
                  label={o}
                  isDefault={o === question.defaultOption}
                  disabled={busy}
                  chosen={chosen === o}
                  onPick={() => void submit(o)}
                />
              ))}
            </div>
          )}
          {options.length > 0 && <div style={{ fontSize: 10, color: "var(--text-dim)" }}>or</div>}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => setFieldFocus(true)}
            onBlur={() => setFieldFocus(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit(draft);
              e.stopPropagation();
            }}
            placeholder={options.length > 0 ? "type your own…" : "type your answer…"}
            disabled={busy}
            style={{ ...FIELD, borderColor: fieldFocus ? "var(--text-dim)" : "var(--border-subtle)" }}
          />
        </div>
      )}
    </div>
  );
}

function RequestCard({ digest, post }: { digest: ThreadDigest; post: InboxPost }) {
  return (
    <Row onClick={() => getThreadActions()?.openThread(digest.thread.id)}>
      <span style={GLYPH}>→</span>
      <span style={{ minWidth: 0, flex: 1, color: "var(--text-primary)" }}>
        {post.text}{" "}
        <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
          from {post.from} · {digest.thread.title}
        </span>
      </span>
      <span style={ROW_META}>open →</span>
    </Row>
  );
}

function UserItemCard({ digest, item }: { digest: ThreadDigest; item: PageItem }) {
  return (
    <Row onClick={() => getThreadActions()?.openThread(digest.thread.id)}>
      <span style={GLYPH}>○</span>
      <span style={{ minWidth: 0, flex: 1, color: "var(--text-primary)" }}>
        {item.title}{" "}
        <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
          {digest.thread.title}
          {item.note ? ` · ${item.note}` : ""}
        </span>
      </span>
      <span style={ROW_META}>open →</span>
    </Row>
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
          {rows.length === 0 ? "" : `${rows.length} thread${rows.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {rows.length === 0 ? (
        <div style={EMPTY_LINE}>no live threads</div>
      ) : (
        rows.map((t) => {
          const status = t.sessionId ? view.sessionStatuses[t.sessionId] : undefined;
          const cfg = STATUS_CONFIGS[status ?? "idle"] ?? STATUS_CONFIGS.idle;
          const lastLine = pageFor(t.id)?.latestTurn?.lines[0] ?? null;
          return (
            <Row key={t.id} onClick={() => getThreadActions()?.openThread(t.id)}>
              <span style={{ ...GLYPH, display: "flex", alignItems: "center" }}>
                <PulsingDot color={cfg.color} pulse={cfg.pulse} size={7} />
              </span>
              <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <span style={{ color: "var(--text-primary)" }}>{t.title}</span>
                <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                  {" "}
                  {threadRepoName(t.workingDir)}
                </span>
                {lastLine && (
                  <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                    {"  "}
                    {lastLine}
                  </span>
                )}
              </span>
              <span style={ROW_META}>open →</span>
            </Row>
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
        <div style={EMPTY_LINE}>nothing in the last hour</div>
      ) : (
        recent.map(({ post, to, t }) => (
          <div key={`${to.id}-${post.id}`} style={ROW}>
            <span style={GLYPH}>↓</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                {post.from} → {to.title}
              </span>{" "}
              <span style={{ color: "var(--text-secondary)" }}>{post.text}</span>
            </span>
            <span style={ROW_META}>{new Date(t).toTimeString().slice(0, 5)}</span>
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
        Kept views <span style={BLOCK_TITLE_RIGHT}>{kept.length === 0 ? "" : String(kept.length)}</span>
      </div>
      {kept.length === 0 ? (
        <div style={EMPTY_LINE}>no kept views</div>
      ) : (
        kept.map((relPath) => {
          const parts = relPath.split("/");
          const project = parts[1] ?? "";
          const name = (parts[parts.length - 1] ?? relPath).replace(/\.view\.json$/, "");
          return (
            <Row
              key={relPath}
              title={`${relPath} — opens the raw snapshot for now; rendered reopen is a follow-up`}
              onClick={() => navigate({ screen: "kb", doc: relPath })}
            >
              <span style={GLYPH}>◫</span>
              <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
              <span style={ROW_META}>{project}</span>
            </Row>
          );
        })
      )}
    </div>
  );
}

// ── Listening ────────────────────────────────────────────

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
        <div style={EMPTY_LINE}>nothing listening</div>
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
              style={{ ...ROW, whiteSpace: "nowrap", overflow: "hidden" }}
            >
              <span style={{ ...GLYPH, display: "flex", alignItems: "center" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor }} />
              </span>
              <span style={{ color: "var(--text-dim)", fontSize: 9.5, flex: "none" }}>{hit.source}</span>
              <span style={{ color: "var(--text-secondary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{hit.url}</span>
              <span style={ROW_META}>{label}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
