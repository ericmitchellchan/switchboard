// HOME (SWIT-45 shell → SWIT-52 filled) — the roll-up screen and the app's
// default route. Ky's lesson, adopted: Home has no content of its own —
// every block is a view over some other record:
//
//   Needs you        → every OPEN question + user-owned item + request across
//                      threads (the per-thread page files, one 5s poll while
//                      Home is on screen), plus ONE row per thread with
//                      decisions saved and not sent (SWIT-77 review fix —
//                      the batch is sent from the page, so the row says so
//                      and opens the thread). Answering HERE calls the same
//                      bridge the page uses (acceptance 7).
//   Live now         → launched threads + the latest turn's first line.
//   Between threads  → the last hour of cross-thread posts.
//   Listening        → announced dev servers, probed (never "healthy").
//   Kept views       → the scratchpad listing (_scratch/*.view.json).
//
// SKIN (SWIT-54 hierarchy pass; re-cut SWIT-91 — the ✦ page's Ky pass,
// SWIT-90, reads like Ky's PlanPanel and Home did not): ONE left-aligned
// column (max 720px), Ky's HomeScreen hierarchy logic in the page's own
// grammar. Sections are H2s — the page's SECTION_TITLE (14px 600 reading
// face, a 1px `--border` hairline under, the count/meta 10px mono faint
// beside it) — 18px apart; the rule-with-label header and the uppercase
// faint section-label voice are RETIRED on Home (kept nowhere else that
// still reads that way). Rows are 12.5px reading-face `--text-primary` with
// a hairline under each (the page's DENSE_ROW), meta 10px mono
// `--text-faint` right-aligned. Exactly ONE earned box: a question in
// Needs you is an elevated card — `--bg-active` (one step up from
// `--bg-panel`), 1px `--border`, radius 8 — because it asks Eric to act,
// with the page's FIELD for its input; everything else is a flat row. No
// decorative leading glyph column — dots (live status, the probe) are data
// and stay inline. An EMPTY section does not render; the empty ones fold
// into one quiet 10px mono line at the page bottom. Skin only — every click
// and every write goes through the same bridge it did.
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { PulsingDot } from "./PulsingDot";
import { MONO, READING, SECTION_TITLE, DENSE_ROW, FIELD } from "./kit";
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
  answerSuccessNote,
  answerErrorNote,
  noteReplacesForm,
  unsentDecisionsLine,
} from "../lib/pageStore";
import type { AnswerNote, InboxPost, PageItem, PageQuestion, RenderedPage } from "../lib/pageStore";
import { answerQuestion } from "../lib/panelStore";
import { readThreadFile, listScratchViews } from "../lib/ipc";
import { navigate } from "../lib/route";
import { useAllKnownServers, serverKey } from "../lib/devServer";
import type { DevServerHit } from "../lib/devServer";
import { useBacklog, openItems, HOME_BACKLOG_LIMIT } from "../lib/backlogStore";
import type { BacklogItem } from "../lib/backlogStore";
import { BacklogListing } from "./BacklogPanel";
import { OptionRow } from "./kb/OptionRow";

/** The page's H2 + trailing meta (10px mono faint, pushed right). */
const SECTION_META: CSSProperties = {
  marginLeft: "auto",
  fontFamily: MONO,
  fontSize: 10,
  fontWeight: 400,
  color: "var(--text-faint)",
};

/** The page's section header: an H2 (SECTION_TITLE) with an optional meta
 *  string at the right — a count (`Backlog · 3`) or a description
 *  (`Live now · 2 threads`, `Listening · probed, not health-checked`). */
function SectionHeader({ label, meta }: { label: string; meta?: string }) {
  return (
    <h2 style={SECTION_TITLE}>
      {label}
      {meta !== undefined && <span style={SECTION_META}>{meta}</span>}
    </h2>
  );
}

/** Row / question title — 12.5px reading-face `--text-primary`. */
const TITLE: CSSProperties = {
  fontFamily: READING,
  fontSize: 12.5,
  color: "var(--text-primary)",
};

/** Trailing meta on a row — 10px mono `--text-faint`, right-aligned. */
const ROW_META: CSSProperties = {
  marginLeft: "auto",
  flex: "none",
  fontFamily: MONO,
  fontSize: 10,
  color: "var(--text-faint)",
  whiteSpace: "nowrap",
};

/** The page's DENSE_ROW, as a full-width row (a hairline under each). */
const ROW: CSSProperties = {
  ...DENSE_ROW,
  width: "100%",
  padding: "6px 4px",
  background: "none",
  border: "none",
  boxShadow: "none",
  fontFamily: READING,
  fontSize: 12.5,
  lineHeight: 1.45,
  color: "var(--text-secondary)",
  textAlign: "left",
  outline: "none",
};

/** THE EARNED BOX — reserved for a block that asks the user to act; one
 *  step up from `--bg-panel` (`--bg-active`), the page's radius. */
const CARD: CSSProperties = {
  background: "var(--bg-active)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  fontFamily: READING,
};

/** A clickable row: hover `--bg-hover` + `--text-primary` (the page's own
 *  row-hover fill), keyboard focus draws the inset bar. Children lay out as
 *  the row's flex items. */
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
        background: hover || focus ? "var(--bg-hover)" : "none",
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
  const backlog = useBacklog();
  const servers = useAllKnownServers();
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

  // Which sections have anything to say — an empty one folds into the quiet
  // line instead of rendering (page order preserved in both places).
  const needsCount = digests.reduce(
    (n, d) =>
      n +
      d.page.openQuestions.length +
      (d.page.unsentDecisions.length > 0 ? 1 : 0) +
      d.page.requests.length +
      d.page.userItems.length,
    0
  );
  const openBacklog = openItems(backlog.items);
  const liveRows = sortThreadsForHistory(
    view.threads.filter((t) => view.launched.has(t.id)),
    view.launched
  );
  const recentPosts = collectRecentPosts(digests);
  const quiet: string[] = [];
  if (needsCount === 0) quiet.push("needs you");
  if (openBacklog.length === 0) quiet.push("backlog");
  if (liveRows.length === 0) quiet.push("live now");
  if (recentPosts.length === 0) quiet.push("between threads");
  if (servers.length === 0) quiet.push("listening");
  if (kept.length === 0) quiet.push("kept views");

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
            padding: "14px 20px 28px",
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          {needsCount > 0 && <NeedsYou digests={digests} />}
          {openBacklog.length > 0 && (
            <BacklogBlock items={openBacklog} projectOptions={backlogProjects} />
          )}
          {liveRows.length > 0 && <LiveNow rows={liveRows} digests={digests} />}
          {recentPosts.length > 0 && <BetweenThreads recent={recentPosts} />}
          {servers.length > 0 && <Listening active={active} servers={servers} />}
          {kept.length > 0 && <KeptViews kept={kept} />}
          {quiet.length > 0 && (
            <div style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)", lineHeight: 1.5 }}>
              {quiet.join(" · ")} — all quiet
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Backlog (SWIT-64) ────────────────────────────────────────────────────────

/** Open items newest first, the first HOME_BACKLOG_LIMIT + `See all` (which
 *  opens the top bar's dropdown — the one place the whole list lives). Same
 *  row component as the dropdown; the block itself is a view over
 *  backlogStore, like every other block here. Rendered only with items —
 *  empty folds into the quiet line. */
function BacklogBlock({
  items,
  projectOptions,
}: {
  items: readonly BacklogItem[];
  projectOptions: readonly string[];
}) {
  return (
    <div>
      <SectionHeader label="Backlog" meta={String(items.length)} />
      <BacklogListing
        items={items}
        limit={HOME_BACKLOG_LIMIT}
        projectOptions={projectOptions}
        empty={null}
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
    if (d.page.unsentDecisions.length > 0) {
      entries.push(<UnsentRow key={`u-${d.thread.id}`} digest={d} count={d.page.unsentDecisions.length} />);
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
      <SectionHeader label="Needs you" meta={String(entries.length)} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{entries}</div>
    </div>
  );
}

/** An open question, answerable IN PLACE — the same bridge the page uses,
 *  so answering from Home SAVES exactly as from the page (SWIT-77: the
 *  answer goes to the agent with the batch, sent from the page — the note
 *  says so and the card drops off Home on the next poll). THE one earned
 *  box on Home: it asks Eric to act, so it gets the elevated card;
 *  informational rows never do. */
function QuestionCard({ digest, question }: { digest: ThreadDigest; question: PageQuestion }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState<AnswerNote | null>(null);
  const [fieldFocus, setFieldFocus] = useState(false);
  const submit = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (clean.length === 0 || busy) return;
      setBusy(true);
      setChosen(text);
      setNote(null);
      try {
        // SWIT-77: answering SAVES on the page; the batch is sent from the
        // page, not from Home (a roll-up has no send button — one place
        // sends, and it is the one that shows the whole message).
        await answerQuestion(digest.thread.id, question.id, clean);
        setNote(answerSuccessNote());
      } catch (err) {
        setNote(answerErrorNote(err));
      } finally {
        setBusy(false);
        setChosen(null);
      }
    },
    [busy, digest.thread.id, question.id]
  );
  const options = orderedOptions(question);
  return (
    <div style={CARD}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ ...TITLE, lineHeight: 1.5, minWidth: 0, flex: 1 }}>{question.text}</span>
        <span style={{ ...ROW_META, marginLeft: 0 }}>
          {digest.thread.title} · {threadRepoName(digest.thread.workingDir)}
        </span>
      </div>
      {noteReplacesForm(note) ? (
        <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{note?.text}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
          {options.length > 0 && <div style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)" }}>or</div>}
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
            style={{ ...FIELD, borderColor: fieldFocus ? "var(--text-secondary)" : "var(--border)" }}
          />
          {/* A failed answer keeps the form — options clickable, draft intact
              (pageStore.noteReplacesForm); the error is one line below it. */}
          {note?.kind === "error" && (
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{note.text}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Decisions saved on a thread's page and not yet sent — ONE flat row per
 *  thread (a roll-up sends nothing; the page does), opening the thread.
 *  Without it a decided question dropped off Home the moment it saved and
 *  the batch was invisible until the page was opened. */
function UnsentRow({ digest, count }: { digest: ThreadDigest; count: number }) {
  return (
    <Row onClick={() => getThreadActions()?.openThread(digest.thread.id)}>
      <span style={{ minWidth: 0, flex: 1, ...TITLE }}>
        {unsentDecisionsLine(count)}{" "}
        <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)" }}>
          {digest.thread.title} · {threadRepoName(digest.thread.workingDir)}
        </span>
      </span>
      <span style={ROW_META}>open →</span>
    </Row>
  );
}

function RequestCard({ digest, post }: { digest: ThreadDigest; post: InboxPost }) {
  return (
    <Row onClick={() => getThreadActions()?.openThread(digest.thread.id)}>
      <span style={{ minWidth: 0, flex: 1, ...TITLE }}>
        {post.text}{" "}
        <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)" }}>
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
      <span style={{ minWidth: 0, flex: 1, ...TITLE }}>
        {item.title}{" "}
        <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)" }}>
          {digest.thread.title}
          {item.note ? ` · ${item.note}` : ""}
        </span>
      </span>
      <span style={ROW_META}>open →</span>
    </Row>
  );
}

// ── Live now ─────────────────────────────────────────────────────────────────

function LiveNow({ rows, digests }: { rows: Thread[]; digests: ThreadDigest[] }) {
  const view = useThreadsView();
  const pageFor = (threadId: string) => digests.find((d) => d.thread.id === threadId)?.page;
  return (
    <div>
      <SectionHeader
        label="Live now"
        meta={`${rows.length} thread${rows.length === 1 ? "" : "s"}`}
      />
      {rows.map((t) => {
        const status = t.sessionId ? view.sessionStatuses[t.sessionId] : undefined;
        const cfg = STATUS_CONFIGS[status ?? "idle"] ?? STATUS_CONFIGS.idle;
        const lastLine = pageFor(t.id)?.latestTurn?.lines[0] ?? null;
        return (
          <Row key={t.id} onClick={() => getThreadActions()?.openThread(t.id)}>
            <span style={{ flex: "none", display: "flex", alignItems: "center" }}>
              <PulsingDot color={cfg.color} pulse={cfg.pulse} size={7} />
            </span>
            <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <span style={TITLE}>{t.title}</span>
              <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)" }}>
                {" "}
                {threadRepoName(t.workingDir)}
              </span>
              {lastLine && (
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  {"  "}
                  {lastLine}
                </span>
              )}
            </span>
            <span style={ROW_META}>open →</span>
          </Row>
        );
      })}
    </div>
  );
}

// ── Between threads ──────────────────────────────────────────────────────────

type RecentPost = { post: InboxPost; to: Thread; t: number };

/** The last hour of cross-thread posts, newest first. */
function collectRecentPosts(digests: ThreadDigest[]): RecentPost[] {
  const now = Date.now();
  const recent: RecentPost[] = [];
  for (const d of digests) {
    for (const post of d.posts) {
      const t = Date.parse(post.at);
      if (Number.isFinite(t) && now - t <= HOUR_MS) recent.push({ post, to: d.thread, t });
    }
  }
  recent.sort((a, b) => b.t - a.t);
  return recent;
}

function BetweenThreads({ recent }: { recent: RecentPost[] }) {
  return (
    <div>
      <SectionHeader label="Between threads" meta="last hour" />
      {recent.map(({ post, to, t }) => (
        <div key={`${to.id}-${post.id}`} style={ROW}>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)" }}>
              {post.from} → {to.title}
            </span>{" "}
            <span style={{ color: "var(--text-secondary)" }}>{post.text}</span>
          </span>
          <span style={ROW_META}>{new Date(t).toTimeString().slice(0, 5)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Kept views ───────────────────────────────────────────────────────────────

function KeptViews({ kept }: { kept: string[] }) {
  return (
    <div>
      <SectionHeader label="Kept views" meta={String(kept.length)} />
      {kept.map((relPath) => {
        const parts = relPath.split("/");
        const project = parts[1] ?? "";
        const name = (parts[parts.length - 1] ?? relPath).replace(/\.view\.json$/, "");
        return (
          <Row
            key={relPath}
            title={`${relPath} — opens the raw snapshot for now; rendered reopen is a follow-up`}
            onClick={() => navigate({ screen: "kb", doc: relPath })}
          >
            <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...TITLE }}>
              {name}
            </span>
            <span style={ROW_META}>{project}</span>
          </Row>
        );
      })}
    </div>
  );
}

// ── Listening ────────────────────────────────────────────

const PROBE_MS = 5_000;

function Listening({ active, servers }: { active: boolean; servers: readonly DevServerHit[] }) {
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
      <SectionHeader label="Listening" meta="probed, not health-checked" />
      {servers.map((hit) => {
        const key = serverKey(hit.url);
        const state = alive[key];
        const dotColor =
          state === true ? "var(--st-done, var(--accent-green))" : state === false ? "var(--st-exited, var(--text-dim))" : "var(--text-faint)";
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
            <span style={{ flex: "none", display: "flex", alignItems: "center" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor }} />
            </span>
            <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)", flex: "none" }}>{hit.source}</span>
            <span style={{ color: "var(--text-secondary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{hit.url}</span>
            <span style={ROW_META}>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
