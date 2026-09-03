// THE ✦ PAGE (SWIT-48; re-cut SWIT-67/68/69) — a thread's one living page,
// rendered from pageStore's merge. Ky's thread panel is the reference: ONE
// page — a one-paragraph SUMMARY (theme + the newest turn's first line), an
// optional `start here →` line (the turn's reviewFirst address), then Open
// questions · Needs you · To do · What happened · Evidence · Questions ·
// Done. "What happened" sits deliberately BELOW the needs-you material: the
// reason to open the page comes first (Ky's rule, and Eric's, verbatim).
//
// QUESTIONS ANSWER HERE (SWIT-67): `ask` no longer opens a tab — each open
// question renders the OptionRow list + a free-text input + the quiet
// `answer` button, through the SAME bridge Home's Needs You uses
// (panelStore.answerQuestion). Answering collapses it to the decided line
// (the `decision:<id>` evidence row) on the next poll.
//
// TYPOGRAPHY (SWIT-68): section titles are sentence case, 12.5px
// `--text-primary`, the count beside them in `--text-dim` — the uppercase
// faint label style is retired ON THIS PAGE (Home keeps its rule-with-label
// headers). Body is one step dimmer (11px `--text-secondary`, line-height
// 1.45); question OPTION rows stay `--text-primary` (they were the hardest
// thing to read). Sections get more air (26px), rows stay tight.
//
// WORDS, NOT GLYPHS (SWIT-69): items are CHECKBOXES (`☐`/`☑` in our tokens)
// with a one-word status where not obvious (`waiting`, `in progress`) and the
// owner right-aligned dim; the blue `⟳` and every colored item dot are gone.
// No `?` glyph anywhere. An item waiting on the user appears ONCE, under
// Needs you (pageStore.mergePage owns that split).
//
// THE TAB BUDGET (SWIT-69): Evidence also lists the thread's VIEW SPECS as
// `view:<id>` rows (evidenceModel.mergeViewEvidence — label = the view
// title), each opening the view in the ONE preview slot beside the thread, so
// every view stays reachable while the strip stays `✦ page + preview + pins`.
//
// PLAIN LANGUAGE ONLY: the page never renders markdown from the agent — every
// line is text. The shapes are enforced upstream (the MCP server validates,
// pageStore parses tolerantly); this component only draws.
//
// The NEW-SINCE-YOU-LOOKED stamp: after the page has been on screen for
// SEEN_DWELL_MS the stamp advances; anything dated after the PREVIOUS stamp
// carries a dot until then. A first visit marks nothing.
//
// EVIDENCE IS A HISTORY (SWIT-66): the section renders kind-group chips with
// counts (`recent` default) over rows merged from the agent's page.json AND
// the scrollback scan (evidenceScan, union) — an agent row wins an address
// collision, a doc/file row that resolves opens beside the thread.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  usePage,
  loadPageSeen,
  markPageSeen,
  isNewSince,
  pageSummary,
  SEEN_DWELL_MS,
  orderedOptions,
  PAGE_POLL_MS,
  answerSuccessNote,
  answerErrorNote,
  noteReplacesForm,
} from "../../lib/pageStore";
import type { AnswerNote, InboxPost, PageItem, PageQuestion } from "../../lib/pageStore";
import { parseSurfaceAddress } from "../../lib/surfaceParams";
import { answerQuestion, openArtifact, openInPanel, getActiveTabSession } from "../../lib/panelStore";
import type { OpenableArtifact } from "../../lib/panelStore";
import {
  groupEvidence,
  latchViewKey,
  mergeScannedEvidence,
  mergeViewEvidence,
  resolveDocTarget,
  viewIdOfAddress,
} from "../../lib/evidenceModel";
import type { EvidenceGroupId, ThreadViewRow } from "../../lib/evidenceModel";
import { useScannedEvidence } from "../../lib/evidenceScan";
import { getCachedDocList, refreshDocList } from "../../lib/kb";
import { explorerProjects, listThreadViews, readThreadView } from "../../lib/ipc";
import { projectKeyForDir } from "../../lib/explorer";
import { getThreads } from "../../lib/threadStore";
import { parseViewSpec } from "../../lib/viewStore";
import { OptionRow } from "./OptionRow";

const MONO = "var(--font-mono)";

/** SWIT-68: section title — sentence case, upright, the count dim beside it.
 *  The uppercase faint band-header voice is retired on this page. */
const SECTION_TITLE: CSSProperties = {
  fontFamily: MONO,
  fontSize: 12.5,
  color: "var(--text-primary)",
  marginBottom: 6,
  display: "flex",
  alignItems: "baseline",
  gap: 6,
};

const SECTION_META: CSSProperties = {
  marginLeft: "auto",
  fontSize: 9.5,
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

/** kit: input (transparent — the field takes the panel's surface). */
const FIELD: CSSProperties = {
  width: "100%",
  maxWidth: 480,
  background: "transparent",
  border: "1px solid var(--border-subtle)",
  borderRadius: 3,
  color: "var(--text-primary)",
  fontFamily: MONO,
  fontSize: 11,
  lineHeight: 1.45,
  padding: "5px 8px",
  outline: "none",
};

/** kit: quiet button. */
const QUIET: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border-subtle)",
  borderRadius: 3,
  color: "var(--text-secondary)",
  fontFamily: MONO,
  fontSize: 11,
  padding: "3px 10px",
  cursor: "pointer",
};

/** kit: chip (BacklogPanel's measurements) — the Evidence group tabs; the
 *  active one carries the brighter border + text, never a fill. */
function chipStyle(on: boolean): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: 9,
    padding: "0 5px",
    lineHeight: "15px",
    border: `1px solid ${on ? "var(--text-secondary)" : "var(--border-subtle)"}`,
    borderRadius: 4,
    background: "transparent",
    color: on ? "var(--text-primary)" : "var(--text-muted)",
    whiteSpace: "nowrap",
    flex: "none",
    cursor: "pointer",
  };
}

/** SWIT-69: a checkbox, not a state glyph — done is checked, everything open
 *  is an empty box; the WORD carries the non-obvious states. */
const STATE_WORD: Partial<Record<PageItem["state"], string>> = {
  in_progress: "in progress",
  waiting: "waiting",
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

  // SWIT-69 (the tab budget's ledger half): the thread's view SPECS, one row
  // each under Evidence, so a view that lost the preview slot is one click
  // away. Polled at the page cadence while active; re-read only when the id
  // list changes (a title changed by `view update` catches up when any id
  // does — the row is a pointer, not the view).
  const [threadViews, setThreadViews] = useState<ThreadViewRow[]>([]);
  const viewIdsRef = useRef<string | null>(null);
  useEffect(() => {
    viewIdsRef.current = null;
    setThreadViews([]);
  }, [threadId]);
  useEffect(() => {
    if (!active || threadId.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const ids = await listThreadViews(threadId);
        if (cancelled) return;
        const key = ids.join("\n");
        if (key === viewIdsRef.current) return;
        const rows: ThreadViewRow[] = [];
        const okIds: string[] = [];
        for (const id of ids) {
          try {
            const { spec } = parseViewSpec(await readThreadView(threadId, id));
            if (spec) {
              rows.push({ id, title: spec.title, builtAt: spec.builtAt });
              okIds.push(id);
            }
          } catch {
            // an unreadable spec drops alone — and is NOT latched (below)
          }
        }
        if (cancelled) return;
        // Latch only what actually read (evidenceModel.latchViewKey): a spec
        // caught mid-write keeps the keys unequal, so the next tick retries
        // it instead of dropping the row until the id list happens to change.
        viewIdsRef.current = latchViewKey(ids, okIds);
        setThreadViews(rows);
      } catch {
        // a failed listing is a quiet tick
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), PAGE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [threadId, active]);

  // SWIT-66: Evidence as a thread HISTORY — the agent's rows UNIONED with the
  // scrollback scan, merged at RENDER time (an agent-posted row wins an
  // address collision; page.json is never written by the app — the same
  // one-writer pattern as the synthesized `decision:` rows), then folded into
  // fixed kind groups the chips below the band header switch between.
  // SWIT-69 adds the view rows through the same union.
  const scanned = useScannedEvidence(threadId);
  const evidence = useMemo(
    () => mergeViewEvidence(mergeScannedEvidence(page.evidence, scanned), threadViews),
    [page.evidence, scanned, threadViews]
  );
  const groups = useMemo(() => groupEvidence(evidence), [evidence]);
  const [groupId, setGroupId] = useState<EvidenceGroupId>("recent");
  useEffect(() => setGroupId("recent"), [threadId]);
  const activeGroup = groups.find((g) => g.id === groupId) ?? groups[0] ?? null;

  // The doc/file link rule's context: the REAL KB doc list (a KB row must
  // exist to link) and the thread's own project key (a repo path resolves
  // syntactically against it — evidenceModel.resolveDocTarget).
  const [kbDocs, setKbDocs] = useState<readonly string[] | null>(() => getCachedDocList());
  const [projectKey, setProjectKey] = useState<string | null>(null);
  useEffect(() => {
    if (getCachedDocList() !== null) return;
    let cancelled = false;
    refreshDocList()
      .then((docs) => {
        if (!cancelled) setKbDocs(docs);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setProjectKey(null);
    const dir = getThreads().find((t) => t.id === threadId)?.workingDir;
    if (!dir) return;
    explorerProjects()
      .then((projects) => {
        if (!cancelled) setProjectKey(projectKeyForDir(projects, dir));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [threadId]);
  const linkTarget = (address: string): OpenableArtifact | null =>
    parseSurfaceAddress(address) ?? resolveDocTarget(address, kbDocs, projectKey);
  // A `view:` address opens the view artifact in the ONE preview slot beside
  // this thread (SWIT-69) — a view has no full-width screen, so no modifier.
  const openViewAddress = useCallback(
    (viewId: string) => {
      const host = getActiveTabSession();
      if (host) openInPanel(host, { kind: "view", threadId, viewId }, { preview: true });
    },
    [threadId]
  );

  // Dwell: after SEEN_DWELL_MS on screen the stored stamp advances (a glance
  // while switching threads clears nothing). The in-memory `seenAt` keeps its
  // old value so the dots stay judgeable until the next visit.
  useEffect(() => {
    if (!active || threadId.length === 0) return;
    const id = window.setTimeout(() => markPageSeen(threadId), SEEN_DWELL_MS);
    return () => window.clearTimeout(id);
  }, [threadId, active, revision]);

  if (page.isEmpty && evidence.length === 0) {
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

  const summary = pageSummary(page);
  const reviewFirst = page.latestTurn?.reviewFirst ?? null;

  const renderAddress = (address: string) => {
    const viewId = viewIdOfAddress(address);
    if (viewId !== null) {
      return (
        <AddressButton
          text={address}
          title="open this view beside the thread"
          onOpen={() => openViewAddress(viewId)}
        />
      );
    }
    return <EvidenceAddress address={address} target={linkTarget(address)} />;
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: "12px 14px",
        fontFamily: MONO,
        fontSize: 11,
        lineHeight: 1.45,
        color: "var(--text-secondary)",
        display: "flex",
        flexDirection: "column",
        gap: 26,
      }}
    >
      {(summary || reviewFirst) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {summary && (
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {summary}
            </div>
          )}
          {reviewFirst && (
            <div style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
              <span style={{ flex: "none", color: "var(--text-dim)" }}>start here →</span>
              {renderAddress(reviewFirst)}
            </div>
          )}
        </div>
      )}

      {page.openQuestions.length > 0 && (
        <Section title="Open questions" count={page.openQuestions.length}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {page.openQuestions.map((q) => (
              <InlineQuestion
                key={q.id}
                threadId={threadId}
                question={q}
                isNew={isNewSince(q.askedAt, seenAt)}
              />
            ))}
          </div>
        </Section>
      )}

      {(page.requests.length > 0 || page.userItems.length > 0) && (
        <Section title="Needs you" count={page.requests.length + page.userItems.length}>
          {page.requests.map((p) => (
            <PostRow key={p.id} post={p} isNew={isNewSince(p.at, seenAt)} />
          ))}
          {page.userItems.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </Section>
      )}

      {page.openItems.length > 0 && (
        <Section title="To do" count={page.openItems.length}>
          {page.openItems.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </Section>
      )}

      {(page.latestTurn || page.updates.length > 0) && (
        <Section
          title="What happened"
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

      {evidence.length > 0 && (
        <Section title="Evidence" count={evidence.length}>
          {groups.length > 1 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "2px 0 4px" }}>
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setGroupId(g.id)}
                  style={chipStyle(g.id === (activeGroup?.id ?? "recent"))}
                >
                  {g.label} {g.count}
                </button>
              ))}
            </div>
          )}
          {(activeGroup?.rows ?? []).map((e) => (
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
              {renderAddress(e.address)}
              <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>
                {e.label}
              </span>
              {e.status && <span style={{ ...ROW_META, fontSize: 10 }}>{e.status}</span>}
            </div>
          ))}
        </Section>
      )}

      {page.answeredQuestions.length > 0 && (
        <Section title="Questions" count={page.answeredQuestions.length} meta="answered">
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
          count={page.doneItems.length}
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
  count,
  meta,
  isNew = false,
  children,
}: {
  title: string;
  count?: number;
  meta?: string;
  isNew?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <div style={SECTION_TITLE}>
        {title}
        {count !== undefined && (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{count}</span>
        )}
        {isNew && <span style={{ ...NEW_DOT, alignSelf: "center" }} />}
        {meta && <span style={SECTION_META}>{meta}</span>}
      </div>
      {children}
    </div>
  );
}

/** An OPEN question, answerable IN PLACE (SWIT-67): the question · the
 *  OptionRow list between hairlines · a free-text input · the quiet `answer`
 *  button — the SAME bridge Home's Needs You uses (answerQuestion), so
 *  answering here behaves exactly as from Home. On success the note stands in
 *  until the poll collapses the block to the decided line; a FAILED answer
 *  renders its error UNDER the form, which stays interactive with the draft
 *  intact (pageStore.noteReplacesForm is the rule). No box: the section is
 *  the surface (Home's card is Home's earned box). */
function InlineQuestion({
  threadId,
  question,
  isNew,
}: {
  threadId: string;
  question: PageQuestion;
  isNew: boolean;
}) {
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
        const outcome = await answerQuestion(threadId, question.id, question.text, clean, question.kind);
        setNote(answerSuccessNote(outcome));
      } catch (err) {
        setNote(answerErrorNote(err));
      } finally {
        setBusy(false);
        setChosen(null);
      }
    },
    [busy, threadId, question.id, question.text, question.kind]
  );
  const options = orderedOptions(question);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 11.5, color: "var(--text-primary)", lineHeight: 1.5 }}>
        {question.text}
        {isNew && <span style={{ ...NEW_DOT, marginLeft: 6, verticalAlign: "middle" }} />}
      </div>
      {noteReplacesForm(note) ? (
        <div style={{ color: "var(--text-muted)" }}>{note?.text}</div>
      ) : (
        <>
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
                // ↑/↓ walk the rows — the kit's keyboard-selectable list.
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
          <div style={{ display: "flex", maxWidth: 480 }}>
            <button
              type="button"
              style={{ ...QUIET, marginLeft: "auto", opacity: busy ? 0.4 : 1 }}
              disabled={busy}
              onClick={() => void submit(draft)}
            >
              answer
            </button>
          </div>
          {note?.kind === "error" && <div style={{ color: "var(--text-muted)" }}>{note.text}</div>}
        </>
      )}
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

/** SWIT-69 — words, not glyphs: a CHECKBOX (`☐` open, `☑` done, in our
 *  tokens), the text, a one-word status where not obvious, the owner
 *  right-aligned dim. No colored glyph, no spinner. */
function ItemRow({ item }: { item: PageItem }) {
  const word = STATE_WORD[item.state];
  return (
    <div
      style={{ ...DENSE_ROW, whiteSpace: "nowrap", overflow: "hidden" }}
      title={item.note ?? undefined}
    >
      <span style={GLYPH}>{item.state === "done" ? "☑" : "☐"}</span>
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
      <span style={ROW_META}>
        {word ? `${word} · ` : ""}
        {item.owner === "user" ? "you" : item.owner}
      </span>
    </div>
  );
}

/** The shared link shape for an address that OPENS something. */
function AddressButton({
  text,
  title,
  onOpen,
}: {
  text: string;
  title: string;
  onOpen: (modifier: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}
      title={title}
      style={{
        // Shrinkable, never row-blowing: a reviewFirst address can run to
        // REVIEW_FIRST_CAP chars, so it ellipsizes like the kit's other rows.
        flex: "0 1 auto",
        minWidth: 0,
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        textAlign: "left",
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
      {text}
    </button>
  );
}

/** An Evidence row's address: a `surface:<project>/<page>?k=v` address (T9 —
 *  SWIT-63) and a RESOLVED doc/file address (SWIT-66 — the KB doc list, else
 *  the thread's project + a repo-relative path) are LINKS that open through
 *  the same rule as a destination click (the preview slot beside this thread;
 *  Ctrl = full width). Anything else — a ticket key, a PR, an unresolved
 *  path, a malformed surface query — prints as plain text, no link. The
 *  caller resolves; this component only draws. */
function EvidenceAddress({ address, target }: { address: string; target: OpenableArtifact | null }) {
  if (!target)
    return (
      <span
        style={{
          color: "var(--text-primary)",
          flex: "0 1 auto",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {address}
      </span>
    );
  const title =
    target.kind === "surface"
      ? `open ${target.project} / ${target.page}${target.params ? " in that state" : ""} beside this thread (Ctrl+click: full width)`
      : "open beside this thread (Ctrl+click: full width)";
  return (
    <AddressButton
      text={address}
      title={title}
      onOpen={(modifier) => openArtifact(target, { modifier })}
    />
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
