// THE ✦ PAGE (SWIT-48) — a thread's one living page, rendered from
// pageStore's merge in R2's section order: theme · NEEDS YOU · to do · what
// happened · evidence · questions · done. "What happened" sits deliberately
// BELOW needs-you: the reason to open the page comes first (Ky's rule, and
// Eric's, verbatim).
//
// PLAIN LANGUAGE ONLY: the page never renders markdown from the agent — every
// line is text. The shapes are enforced upstream (the MCP server validates,
// pageStore parses tolerantly); this component only draws.
//
// The NEW-SINCE-YOU-LOOKED stamp: after the page has been on screen for
// SEEN_DWELL_MS the stamp advances; anything dated after the PREVIOUS stamp
// carries a dot until then. A first visit marks nothing.

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  usePage,
  loadPageSeen,
  markPageSeen,
  isNewSince,
  SEEN_DWELL_MS,
} from "../../lib/pageStore";
import type { InboxPost, PageItem, PageQuestion } from "../../lib/pageStore";

const MONO = "var(--font-mono)";

const SECTION_TITLE: CSSProperties = {
  fontFamily: MONO,
  fontSize: 9.5,
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: "1px",
  marginBottom: 4,
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const SECTION_META: CSSProperties = {
  marginLeft: "auto",
  textTransform: "none",
  letterSpacing: 0,
  color: "var(--text-faint)",
};

const NEW_DOT: CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--text-primary)",
  flex: "none",
};

/** Item state glyphs — text, no new colour (the kit's rule). */
const STATE_GLYPH: Record<PageItem["state"], string> = {
  todo: "○",
  in_progress: "⟳",
  waiting: "◔",
  done: "✓",
};

export function PageView({ threadId, active }: { threadId: string; active: boolean }) {
  const { page, revision } = usePage(threadId, active);
  // The stamp AGAINST WHICH dots are judged — loaded once per thread visit
  // and held while the page is open, so the dots don't vanish the instant the
  // dwell timer advances the stored stamp.
  const [seenAt, setSeenAt] = useState<number | null>(() => loadPageSeen(threadId));

  useEffect(() => {
    setSeenAt(loadPageSeen(threadId));
  }, [threadId]);

  // Dwell: after SEEN_DWELL_MS on screen the stored stamp advances (a glance
  // while switching threads clears nothing). The in-memory `seenAt` keeps its
  // old value so the dots stay judgeable until the next visit.
  useEffect(() => {
    if (!active || threadId.length === 0) return;
    const id = window.setTimeout(() => markPageSeen(threadId), SEEN_DWELL_MS);
    return () => window.clearTimeout(id);
  }, [threadId, active, revision]);

  if (page.isEmpty) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: 24,
          textAlign: "center",
          fontFamily: MONO,
          fontSize: 11,
          color: "var(--text-dim)",
          lineHeight: 1.6,
        }}
      >
        <span style={{ fontSize: 14, color: "var(--text-muted)" }}>✦</span>
        <span>No page yet.</span>
        <span style={{ color: "var(--text-faint)", maxWidth: 320 }}>
          The agent writes this page as it works — theme, what needs you, to-dos, what happened,
          evidence. It fills in once the thread's agent has page tools (a thread launched after the
          tool server ships).
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: "12px 14px",
        fontFamily: MONO,
        fontSize: 11,
        lineHeight: 1.55,
        color: "var(--text-secondary)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {page.theme && (
        <div style={{ fontSize: 12.5, color: "var(--text-primary)" }}>{page.theme}</div>
      )}

      {(page.openQuestions.length > 0 || page.requests.length > 0 || page.userItems.length > 0) && (
        <Section
          title="Needs you"
          meta={String(page.openQuestions.length + page.requests.length + page.userItems.length)}
        >
          {page.openQuestions.map((q) => (
            <QuestionRow key={q.id} question={q} isNew={isNewSince(q.askedAt, seenAt)} />
          ))}
          {page.requests.map((p) => (
            <PostRow key={p.id} post={p} isNew={isNewSince(p.at, seenAt)} />
          ))}
          {page.userItems.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </Section>
      )}

      {page.openItems.length > 0 && (
        <Section
          title="To do"
          meta={`agent ${page.openItems.filter((i) => i.owner === "agent").length} · you ${page.userItems.length}`}
        >
          {page.openItems.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </Section>
      )}

      {(page.latestTurn || page.updates.length > 0) && (
        <Section
          title="What happened"
          meta={
            page.earlierTurns.length > 0 ? `earlier (${page.earlierTurns.length})` : undefined
          }
          isNew={page.latestTurn ? isNewSince(page.latestTurn.at, seenAt) : false}
        >
          {page.latestTurn && (
            <div style={{ whiteSpace: "pre-wrap" }}>{page.latestTurn.lines.join("\n")}</div>
          )}
          {page.updates.map((p) => (
            <PostRow key={p.id} post={p} isNew={isNewSince(p.at, seenAt)} />
          ))}
          {page.earlierTurns.length > 0 && <EarlierTurns turns={page.earlierTurns} />}
        </Section>
      )}

      {page.evidence.length > 0 && (
        <Section title="Evidence" meta={String(page.evidence.length)}>
          {page.evidence.map((e) => (
            <div
              key={e.address}
              style={{
                display: "flex",
                gap: 10,
                padding: "2px 0",
                borderBottom: "1px solid var(--border)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                alignItems: "baseline",
              }}
            >
              {isNewSince(e.updatedAt, seenAt) && <span style={NEW_DOT} />}
              <span style={{ color: "var(--text-primary)", flex: "none" }}>{e.address}</span>
              <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>
                {e.label}
              </span>
              {e.status && (
                <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, flex: "none" }}>
                  {e.status}
                </span>
              )}
            </div>
          ))}
        </Section>
      )}

      {page.answeredQuestions.length > 0 && (
        <Section title="Questions" meta={`${page.answeredQuestions.length} answered`}>
          {page.answeredQuestions.map(({ question, answer }) => (
            <div key={question.id} style={{ color: "var(--text-muted)", marginBottom: 3 }}>
              {question.text}
              <div style={{ color: "var(--text-secondary)" }}>
                <span style={{ color: "var(--text-dim)" }}>you: </span>
                {answer.text}
              </div>
            </div>
          ))}
        </Section>
      )}

      {page.doneItems.length > 0 && (
        <Section
          title="Done"
          meta={page.doneFolded > 0 ? `+ ${page.doneFolded} more` : undefined}
        >
          {page.doneItems.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  meta,
  isNew = false,
  children,
}: {
  title: string;
  meta?: string;
  isNew?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <div style={SECTION_TITLE}>
        {title}
        {isNew && <span style={NEW_DOT} />}
        {meta && <span style={SECTION_META}>{meta}</span>}
      </div>
      {children}
    </div>
  );
}

/** An OPEN question. The answer AFFORDANCE (options, free text, write-back)
 *  is SWIT-51's question tab — until then the row states the question and
 *  says where to answer it: the terminal. */
function QuestionRow({ question, isNew }: { question: PageQuestion; isNew: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        border: "1px solid var(--border-subtle)",
        background: "var(--bg-elevated)",
        padding: "6px 8px",
        marginBottom: 4,
      }}
    >
      <span
        style={{
          flex: "none",
          width: 16,
          height: 16,
          border: "1px solid var(--text-secondary)",
          borderRadius: 3,
          fontSize: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-primary)",
          marginTop: 1,
        }}
      >
        ?
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "var(--text-primary)", display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ minWidth: 0 }}>{question.text}</span>
          {isNew && <span style={NEW_DOT} />}
        </div>
        {question.options.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
            {question.options.map((o) => (
              <span
                key={o}
                style={{
                  fontSize: 10,
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 3,
                  padding: "0 6px",
                  color: "var(--text-muted)",
                }}
              >
                {o}
              </span>
            ))}
          </div>
        )}
        <div style={{ fontSize: 9.5, color: "var(--text-faint)", marginTop: 3 }}>
          answer in the terminal — the question tab arrives with the next increment
        </div>
      </div>
    </div>
  );
}

function PostRow({ post, isNew }: { post: InboxPost; isNew: boolean }) {
  return (
    <div
      style={{
        borderLeft: "2px solid var(--text-dim)",
        paddingLeft: 8,
        margin: "3px 0",
      }}
    >
      <div style={{ fontSize: 9.5, color: "var(--text-dim)", display: "flex", gap: 6, alignItems: "center" }}>
        ↓ from thread <span style={{ color: "var(--text-muted)" }}>{post.from}</span>
        {isNew && <span style={NEW_DOT} />}
      </div>
      <div>{post.text}</div>
    </div>
  );
}

function ItemRow({ item }: { item: PageItem }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 7,
        alignItems: "baseline",
        padding: "1px 0",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
      title={item.note ?? undefined}
    >
      <span
        style={{
          flex: "none",
          color: item.state === "in_progress" ? "var(--st-running, #3B82F6)" : "var(--text-dim)",
        }}
      >
        {STATE_GLYPH[item.state]}
      </span>
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          color: item.state === "done" ? "var(--text-dim)" : "var(--text-secondary)",
        }}
      >
        {item.title}
      </span>
      <span style={{ marginLeft: "auto", flex: "none", fontSize: 9.5, color: "var(--text-dim)" }}>
        {item.owner === "user" ? "you" : item.owner}
      </span>
    </div>
  );
}

/** Earlier turns, folded behind a click — the latest is the page's face. */
function EarlierTurns({ turns }: { turns: { at: string; lines: string[] }[] }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          marginTop: 4,
          fontFamily: MONO,
          fontSize: 10,
          color: "var(--text-dim)",
          cursor: "pointer",
        }}
      >
        earlier ({turns.length}) ▸
      </button>
    );
  }
  return (
    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
      {turns.map((t, i) => (
        <div key={`${t.at}-${i}`} style={{ color: "var(--text-muted)", whiteSpace: "pre-wrap" }}>
          {t.at && <div style={{ fontSize: 9.5, color: "var(--text-faint)" }}>{t.at}</div>}
          {t.lines.join("\n")}
        </div>
      ))}
    </div>
  );
}
