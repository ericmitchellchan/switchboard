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
//
// SKIN (SWIT-57): the kit's PAGE SECTIONS — every section is a band header +
// dense list rows, no section is a box, and nothing on the page explains the
// page (design/wireframe-kit/components.md). A question row is a row with a
// `?` glyph; a post is an origin line and its text; the empty state is one
// line.

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  usePage,
  loadPageSeen,
  markPageSeen,
  isNewSince,
  SEEN_DWELL_MS,
  orderedOptions,
} from "../../lib/pageStore";
import type { InboxPost, PageItem, PageQuestion } from "../../lib/pageStore";
import { parseSurfaceAddress } from "../../lib/surfaceParams";
import { openArtifact } from "../../lib/panelStore";

const MONO = "var(--font-mono)";

/** kit: band header, page-section variant (padding 0; the section gap does it). */
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

/** kit: the NEW dot. */
const NEW_DOT: CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--text-primary)",
  flex: "none",
};

/** kit: dense list row (`2px 0`, no hover fill). */
const DENSE_ROW: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  padding: "2px 0",
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
        gap: 14,
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
                ...DENSE_ROW,
                gap: 10,
                borderBottom: "1px solid var(--border)",
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}
            >
              {isNewSince(e.updatedAt, seenAt) && <span style={NEW_DOT} />}
              <EvidenceAddress address={e.address} />
              <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>
                {e.label}
              </span>
              {e.status && <span style={{ ...ROW_META, fontSize: 10 }}>{e.status}</span>}
            </div>
          ))}
        </Section>
      )}

      {page.answeredQuestions.length > 0 && (
        <Section title="Questions" meta={`${page.answeredQuestions.length} answered`}>
          {page.answeredQuestions.map(({ question, answer }) => (
            <div key={question.id} style={{ ...DENSE_ROW, flexDirection: "column", gap: 0 }}>
              <span style={{ color: "var(--text-muted)" }}>{question.text}</span>
              <span style={{ color: "var(--text-secondary)" }}>
                <span style={{ color: "var(--text-dim)" }}>you: </span>
                {answer.text}
              </span>
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

/** An OPEN question, as a row: `?` · the text · its options, dim, after it.
 *  The answer affordance is the `? question` tab (SWIT-51), which the agent's
 *  ask opens beside this page; the row states the question and nothing else. */
function QuestionRow({ question, isNew }: { question: PageQuestion; isNew: boolean }) {
  return (
    <div style={DENSE_ROW}>
      <span style={{ ...GLYPH, color: "var(--text-primary)" }}>?</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ color: "var(--text-primary)" }}>{question.text}</span>
        {isNew && <span style={{ ...NEW_DOT, marginLeft: 6, verticalAlign: "middle" }} />}
        {question.options.length > 0 && (
          <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{orderedOptions(question).join(" · ")}</div>
        )}
      </div>
    </div>
  );
}

/** A cross-thread post: the origin as a 9.5px meta line, then the text. */
function PostRow({ post, isNew }: { post: InboxPost; isNew: boolean }) {
  return (
    <div style={{ ...DENSE_ROW, flexDirection: "column", gap: 0 }}>
      <div style={{ fontSize: 9.5, color: "var(--text-dim)", display: "flex", gap: 6, alignItems: "center" }}>
        ↓ <span style={{ color: "var(--text-muted)" }}>{post.from}</span>
        {isNew && <span style={NEW_DOT} />}
      </div>
      <div>{post.text}</div>
    </div>
  );
}

function ItemRow({ item }: { item: PageItem }) {
  return (
    <div
      style={{ ...DENSE_ROW, whiteSpace: "nowrap", overflow: "hidden" }}
      title={item.note ?? undefined}
    >
      <span
        style={{
          ...GLYPH,
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
      <span style={ROW_META}>{item.owner === "user" ? "you" : item.owner}</span>
    </div>
  );
}

/** An Evidence row's address (T9 — SWIT-63): a `surface:<project>/<page>?k=v`
 *  address is a LINK that opens that page in that state through the same open
 *  rule as a destination click (the preview slot beside this thread; Ctrl =
 *  full width). Anything else — a ticket key, a PR, a path, or a surface
 *  address with a malformed query — prints as plain text, no link. */
function EvidenceAddress({ address }: { address: string }) {
  const target = parseSurfaceAddress(address);
  if (!target) return <span style={{ color: "var(--text-primary)", flex: "none" }}>{address}</span>;
  return (
    <button
      type="button"
      onClick={(e) => openArtifact(target, { modifier: e.ctrlKey || e.metaKey })}
      title={`open ${target.project} / ${target.page}${target.params ? " in that state" : ""} beside this thread (Ctrl+click: full width)`}
      style={{
        flex: "none",
        background: "none",
        border: "none",
        padding: 0,
        margin: 0,
        font: "inherit",
        color: "var(--text-primary)",
        textDecoration: "underline",
        textUnderlineOffset: 2,
        cursor: "pointer",
      }}
    >
      {address}
    </button>
  );
}

/** Earlier turns, folded behind a text link button — the latest is the page's face. */
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
