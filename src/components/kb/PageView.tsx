// THE ✦ PAGE (SWIT-48; re-cut SWIT-67/68/69/77/78) — a thread's one living
// page, rendered from pageStore's merge. Ky's thread panel is the reference:
// ONE page — a one-paragraph SUMMARY (theme + the newest turn's first line),
// an optional `start here →` line (the turn's reviewFirst address), then Open
// questions · To do · What happened · Evidence · Decided · Done · Dropped. "What
// happened" sits deliberately BELOW the material that needs the user: the
// reason to open the page comes first (Ky's rule, and Eric's, verbatim).
//
// DECISIONS ARE A BATCH (SWIT-77, Ky's DecisionsArtifact + decisionsStore):
// Open questions is the answering surface — every open question and every
// decided-but-unsent one, NUMBERED oldest first, each a card: the question,
// `open`/`decided` at the right, `Recommended: <option> — <why>`, the
// OptionRow list, `or type an answer…` that SAVES ON BLUR (Enter too; the
// block's own buttons keep focus on mousedown so a click never blurs the
// box). Picking or typing SAVES to answers.json through the same
// `answerQuestion` bridge Home uses — nothing reaches the agent yet. A
// decided card folds to one line (`N · question → answer · not sent yet ·
// change` — the amber word is SWIT-78's, Ky's CC-705). Under
// the list: a preview box printing the exact wire text, the footer count,
// and ONE `Send decisions ▸` that composes `decisionsMessage` through
// composeWrite → submitToThread (the 0.10.0 live-thread seam, gated by
// batchSendTarget — `thread not live` when it is not) and, on success,
// stamps the answers sent (markThreadAnswersSent — and if Rust stamped FEWER
// than were sent, the line says `sent, but N of M not marked sent` and
// nothing is marked sent locally; the files decide which rows leave). The
// batch's `convention` answers ride the submit, so App appends them to
// conventions.md at SEND, once per question. A failed send is one line
// beside the button and the answers stay unsent. An OPTIMISTIC OVERLAY
// (`local` saves, `sentIds`) bridges the ≤2.5s until the poll shows the
// files; the files win the moment they catch up.
//
// NEEDS YOU IS RETIRED HERE (SWIT-77, Ky's PlanPanel): an item waiting on
// the user is a To do row, first, with its owner column in amber; requests
// from other threads sit at the top of To do. Home keeps a Needs You block —
// Home is the roll-up, the page is the page.
//
// TYPOGRAPHY = KY'S PLAN PANEL (2026-09-09, `ky/plan/PlanPanel.tsx`; Eric:
// "it's this weird gray, everything's monotone, and there are no real
// sections. I really just want to copy the Ky platform"): the thread TITLE
// 17px semibold at the top, the theme line under it, `next →` in the accent;
// every section is an H2 — 14px semibold with a hairline under it, the count
// 10px faint beside it, the section that needs you (Open questions) in
// amber; rows are 12.5px `--text-primary` with a hairline under each (a
// list, not a wall); the owner column, states and stamps are 10px mono
// faint; the NEW dot and every link are the accent; the one primary button
// is the accent fill. SWIT-68's all-11px grey voice is retired here. THE
// BODY IS SANS (`--font-reading`, IBM Plex Sans — Eric's decision, same day):
// titles, rows, turn lines, questions, the input and the button; everything
// that is a label, a count, an address, a stamp or wire text stays MONO,
// Ky's split exactly (`font-sans` vs `font-mono` in PlanPanel.tsx).
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
//
// THE CORRECTABLE RECORD (SWIT-78, Ky's CC-703/704): every evidence row (bar
// the synthesized `decision:` rows) carries a hover/focus-only `×` at its
// right end — `Take this row off the page`. The click writes the address to
// the thread's retracted.json (Rust, the app's file) and asks the poll to
// re-read NOW; the row disappears because the MERGE hides it
// (pageStore.applyRetractions), never because of local hide state — the only
// component state is which address's write is in flight: EVERY `×` is
// disabled while one write runs (the retractions share one tmp file), but
// only the in-flight row's `×` dims (`data-retracting`), and focus moves to a
// neighbouring row's `×` before the row leaves so a keyboard retraction does
// not land on `body`. Scanned rows are hidden by address alone
// (`isRetracted(address, null, …)`); an agent row comes back if the agent
// re-posts it with a newer stamp (a later SECOND); a `decision:` row is never
// hidden — `isRetracted` ignores the prefix and Rust refuses to write it.
// Items the agent
// DROPPED (itemOp drop — never the right row) sit under a collapsed
// `Dropped N` disclosure below Done, excluded from every count.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, FocusEvent, ReactNode } from "react";
import {
  usePage,
  loadPageSeen,
  markPageSeen,
  isNewSince,
  pageSummary,
  SEEN_DWELL_MS,
  orderedOptions,
  PAGE_POLL_MS,
  answerErrorNote,
  sendErrorNote,
  partialSentNote,
  conventionEntries,
  decisionsMessage,
  decisionsFooter,
  recommendation,
  isWaitingOnUser,
  isRetracted,
  applyRetractions,
  isOpenItem,
  DECISION_ADDRESS_PREFIX,
  subscribePageFocus,
  pageFocusNonce,
  takePageFocus,
  peekPageFocus,
} from "../../lib/pageStore";
import { nextThingFor } from "../../lib/nextThing";
import type { AnswerNote, InboxPost, PageAnswer, PageItem, PageQuestion, RenderedPage, SettledQuestion } from "../../lib/pageStore";
import { parseSurfaceAddress } from "../../lib/surfaceParams";
import { answerQuestion, openArtifact, openInPanel, getActiveTabSession, submitToThread } from "../../lib/panelStore";
import type { OpenableArtifact } from "../../lib/panelStore";
import { composeWrite } from "../../lib/composer";
import { batchSendTarget, BATCH_NOT_LIVE } from "../../lib/viewNotes";
import { derivedThreadTitle, useThreadsView } from "../../lib/threadStore";
import {
  groupEvidence,
  latchViewKey,
  mergeScannedEvidence,
  mergeViewEvidence,
  resolveDocTarget,
  viewAnchorOfAddress,
} from "../../lib/evidenceModel";
import { requestReportAnchor } from "../../lib/reportStore";
import type { EvidenceGroupId, ThreadViewRow } from "../../lib/evidenceModel";
import { useScannedEvidence } from "../../lib/evidenceScan";
import { getCachedDocList, refreshDocList } from "../../lib/kb";
import { explorerProjects, listThreadViews, markThreadAnswersSent, readThreadView, retractThreadEvidence } from "../../lib/ipc";
import { projectKeyForDir } from "../../lib/explorer";
import { getThreads } from "../../lib/threadStore";
import { parseViewSpec } from "../../lib/viewStore";
import { OptionRow } from "./OptionRow";
import { log } from "../../lib/logger";

const MONO = "var(--font-mono)";
/** The reading face (Ky's `font-sans`): bodies, not chrome. */
const READING = "var(--font-reading)";

/** Ky's section H2 (`PlanPanel.Section`): 14px semibold, a hairline under
 *  it, the count 10px faint beside it; `hot` = amber (the section that
 *  needs you). */
const SECTION_TITLE: CSSProperties = {
  fontFamily: READING,
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.3,
  color: "var(--text-primary)",
  margin: 0,
  paddingBottom: 6,
  marginBottom: 4,
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "baseline",
  gap: 8,
};

const SECTION_COUNT: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  fontWeight: 400,
  color: "var(--text-faint)",
};

const SECTION_META: CSSProperties = {
  marginLeft: "auto",
  fontFamily: MONO,
  fontSize: 10,
  fontWeight: 400,
  color: "var(--text-faint)",
};

/** Ky's NewDot: the accent, the one place green means "moved since you
 *  last looked". */
const NEW_DOT: CSSProperties = {
  display: "inline-block",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--accent)",
  flex: "none",
};

/** Ky's row: a hairline under each (`py-2 border-b`), baseline-aligned. */
const DENSE_ROW: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  padding: "6px 0",
  borderBottom: "1px solid var(--border)",
};

/** Ky's checkbox on an item row (`w-3 h-3 rounded-[3px] border`): an empty
 *  bordered square, filled with a ✓ when done. */
function checkboxStyle(done: boolean): CSSProperties {
  return {
    flex: "none",
    width: 12,
    height: 12,
    marginTop: 3,
    borderRadius: 3,
    border: "1px solid var(--text-primary)",
    background: done ? "var(--text-primary)" : "transparent",
    color: "var(--bg-primary)",
    fontSize: 9,
    lineHeight: "10px",
    textAlign: "center",
  };
}

/** Ky's trailing column on a row: 10px mono faint. */
const ROW_META: CSSProperties = {
  marginLeft: "auto",
  flex: "none",
  fontFamily: MONO,
  fontSize: 10,
  color: "var(--text-faint)",
};

/** Ky's input (`TodoPanel`: `bg-bg border-line-soft rounded-md px-2.5
 *  py-1.5 text-[12px]`): the deepest ground, a hairline, radius 6. */
const FIELD: CSSProperties = {
  width: "100%",
  maxWidth: 480,
  background: "var(--bg-secondary)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-primary)",
  fontFamily: READING,
  fontSize: 12,
  lineHeight: 1.45,
  padding: "6px 10px",
  outline: "none",
};

/** Ky's PrimaryButton (`Buttons.tsx`: `bg-accent text-[12px] font-semibold
 *  rounded-md px-3 py-1`) — ONE per surface (the batch's `Send decisions ▸`). */
const PRIMARY: CSSProperties = {
  background: "var(--accent)",
  border: "none",
  borderRadius: 6,
  color: "var(--bg-primary)",
  fontFamily: READING,
  fontSize: 12,
  fontWeight: 600,
  padding: "4px 12px",
  cursor: "pointer",
};

/** Ky's text link button (`show all 12`, `earlier (3)`): 10px mono faint,
 *  primary under the pointer (`.page-textlink` in global.css). */
const TEXT_LINK: CSSProperties = {
  background: "none",
  border: "none",
  padding: "0 2px",
  marginTop: 4,
  fontFamily: MONO,
  fontSize: 10,
  color: "var(--text-faint)",
  cursor: "pointer",
};

/** Owner column reads claude · you · team (Ky's OWNER_LABEL, 2026-08-31). */
const OWNER_LABEL: Record<PageItem["owner"], string> = { agent: "claude", user: "you", team: "team" };

/** SWIT-78 (Ky's CC-705 `not sent yet`): a decided-but-unsent answer says so
 *  in amber — the one colour on the page, reserved for what still needs you.
 *  Every answer still in the batch is unsent by construction (a sent one
 *  leaves it), so the word rides the decided card and its folded row. */
const UNSENT_WORD = "not sent yet";
const UNSENT_TITLE = "decided on the page; the agent hears it when you send";
const UNSENT: CSSProperties = {
  flex: "none",
  fontFamily: MONO,
  fontSize: 10,
  color: "var(--tone-amber)",
};

/** The batch's number column (Ky's `w-4` mono 10px). */
const NUM: CSSProperties = {
  flex: "none",
  width: 16,
  fontFamily: MONO,
  fontSize: 10,
  color: "var(--text-dim)",
};
/** Everything under a card's first line indents past the number column. */
const CARD_INDENT = 22;

/** Ky's GroupChip (`PlanPanel.EvidenceList`): the Evidence group tabs are
 *  UNDERLINE tabs on one hairline — the active one carries a 1.5px primary
 *  bar and primary text, the rest are faint. No box. */
const GROUP_TABS: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: 16,
  marginBottom: 4,
  borderBottom: "1px solid var(--border)",
};

function chipStyle(on: boolean): CSSProperties {
  return {
    marginBottom: -1,
    padding: "4px 0 6px",
    background: "none",
    border: "none",
    borderBottom: `1.5px solid ${on ? "var(--text-primary)" : "transparent"}`,
    fontFamily: MONO,
    fontSize: 10.5,
    color: on ? "var(--text-primary)" : "var(--text-faint)",
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
  const { page, revision, refresh } = usePage(threadId, active);
  // Ky's page opens on the THREAD TITLE (17px) — the page is the thread.
  const threadsView = useThreadsView();
  const threadTitle = useMemo(() => {
    const thread = threadsView.threads.find((t) => t.id === threadId);
    return thread ? derivedThreadTitle(thread) : null;
  }, [threadsView.threads, threadId]);
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
  // SWIT-69 adds the view rows through the same union. SWIT-78: the
  // retractions fold out of the whole union — the merge already hid the
  // agent's rows; scanned rows go by ADDRESS alone (a sighting in the buffer
  // is not the agent re-posting, so the scan's seen-set can never resurrect
  // one), and a view row comes back only with a newer build, like an agent row.
  const scanned = useScannedEvidence(threadId);
  const retracted = page.retractedEvidence;
  const evidence = useMemo(() => {
    const scannedVisible = scanned.filter((s) => !isRetracted(s.address, null, retracted));
    return applyRetractions(mergeViewEvidence(mergeScannedEvidence(page.evidence, scannedVisible), threadViews), retracted);
  }, [page.evidence, scanned, threadViews, retracted]);
  // The one address whose retraction write is in flight — NOT a hidden set:
  // the row leaves when the merged files say so.
  const [retracting, setRetracting] = useState<string | null>(null);
  const retract = useCallback(
    async (address: string, row: HTMLElement | null) => {
      setRetracting(address);
      try {
        await retractThreadEvidence(threadId, address);
        // The row is about to unmount with the focused `×` inside it — hand
        // focus to a neighbour's `×` first (keyboard: the next row's `×`
        // shows through `:focus-visible`; mouse: nothing visible changes).
        const neighbour = (row?.nextElementSibling ?? row?.previousElementSibling)?.querySelector<HTMLElement>(".page-evidence-x");
        neighbour?.focus();
        refresh();
      } catch (err) {
        log.warn(`Could not take ${address} off the page: ${err}`);
      } finally {
        setRetracting(null);
      }
    },
    [threadId, refresh]
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

  // THE NEXT THING (SWIT-79, Ky's CC-710): the ONE line under the summary —
  // `start here → <address>` (the agent's reviewFirst, when it named one) /
  // `next → answer 2 questions` / `next → <address> · <item>` — from the
  // same pure rule the turn-end hook reads (lib/nextThing), so the page and
  // the hook cannot disagree about WHAT is next; a click here opens it
  // focused where the hook opens it behind.
  const nextThing = useMemo(
    () => nextThingFor(page, { threadId, kbDocs, projectKey }),
    [page, threadId, kbDocs, projectKey]
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollToBlock = useCallback((block: string) => {
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-page-block="${block}"]`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);
  // A focus REQUEST raised by the turn-end hook (pageStore.requestPageFocus)
  // — taken here, once, by the page that shows this thread; observable, so a
  // page already on screen scrolls now. PEEK BEFORE TAKE: a page that was not
  // the active tab mounts empty (revision 0, no blocks yet), and taking the
  // request then would consume it with nothing to scroll to — so the request
  // is taken only once the block exists; the `revision` dep re-runs this when
  // the page loads.
  const focusNonce = useSyncExternalStore(subscribePageFocus, pageFocusNonce);
  useEffect(() => {
    const pending = peekPageFocus(threadId);
    if (pending === null) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-page-block="${pending}"]`);
    if (!el) return;
    if (takePageFocus(threadId) === pending) scrollToBlock(pending);
  }, [focusNonce, threadId, revision, scrollToBlock]);

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
          fontFamily: READING,
          fontSize: 12.5,
          color: "var(--text-faint)",
          lineHeight: 1.6,
        }}
      >
        <span style={{ fontSize: 14, color: "var(--text-muted)" }}>✦</span>
        <span>No page yet.</span>
      </div>
    );
  }

  const summary = pageSummary(page);

  const renderAddress = (address: string, accent = false) => {
    // SWIT-73: `view:<id>#h:<slug>` names a heading INSIDE a report — the
    // anchor rides reportStore's one-shot; the open is the ordinary view
    // open. A malformed fragment made the whole address plain upstream.
    const viewHit = viewAnchorOfAddress(address);
    if (viewHit !== null) {
      return (
        <AddressButton
          text={address}
          title="open this view beside the thread"
          accent={accent}
          onOpen={() => {
            if (viewHit.anchor) requestReportAnchor(threadId, viewHit.viewId, viewHit.anchor);
            openViewAddress(viewHit.viewId);
          }}
        />
      );
    }
    return <EvidenceAddress address={address} target={linkTarget(address)} accent={accent} />;
  };

  return (
    <div
      ref={rootRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: "14px 20px 28px",
        fontFamily: READING,
        fontSize: 12,
        lineHeight: 1.5,
        color: "var(--text-secondary)",
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      {/* Ky's page head: the thread title, the theme line, `next →`. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {threadTitle && (
          <h1 style={{ margin: 0, fontFamily: READING, fontSize: 17, fontWeight: 600, lineHeight: 1.25, color: "var(--text-primary)" }}>
            {threadTitle}
          </h1>
        )}
        {summary && (
          <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            {summary}
          </div>
        )}
        {nextThing?.why === "review" ? (
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0, fontFamily: MONO, fontSize: 11, marginTop: 2 }}>
            <span style={{ flex: "none", color: "var(--text-faint)" }}>start here →</span>
            {renderAddress(nextThing.address, true)}
          </div>
        ) : nextThing ? (
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0, fontFamily: MONO, fontSize: 11, marginTop: 2 }}>
            <span style={{ flex: "none", color: "var(--text-faint)" }}>next →</span>
            {nextThing.why === "questions" ? (
              <AddressButton
                text={nextThing.label}
                title="Every open question, one send"
                accent
                onOpen={() => scrollToBlock("decisions")}
              />
            ) : (
              <AddressButton
                text={nextThing.label}
                title="Open it beside this thread"
                accent
                onOpen={() => {
                    const host = getActiveTabSession();
                    if (!host) return;
                    if (nextThing.artifact.kind === "view" && nextThing.anchor) {
                      requestReportAnchor(threadId, nextThing.artifact.viewId, nextThing.anchor);
                    }
                  openInPanel(host, nextThing.artifact, { preview: true });
                }}
              />
            )}
          </div>
        ) : null}
      </div>

      <DecisionsBlock threadId={threadId} page={page} seenAt={seenAt} />

      {(page.requests.length > 0 || page.openItems.length > 0) && (
        <Section title="To do" count={page.requests.length + page.openItems.length}>
          {page.requests.map((p) => (
            <PostRow key={p.id} post={p} isNew={isNewSince(p.at, seenAt)} />
          ))}
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
          {page.latestTurn && <TurnLines lines={page.latestTurn.lines} />}
          {page.updates.map((p) => (
            <PostRow key={p.id} post={p} isNew={isNewSince(p.at, seenAt)} />
          ))}
          {page.earlierTurns.length > 0 && <EarlierTurns turns={page.earlierTurns} />}
        </Section>
      )}

      {evidence.length > 0 && (
        <Section title="Evidence" count={evidence.length}>
          {groups.length > 1 && (
            <div style={GROUP_TABS} role="tablist">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  role="tab"
                  aria-selected={g.id === (activeGroup?.id ?? "recent")}
                  onClick={() => setGroupId(g.id)}
                  style={chipStyle(g.id === (activeGroup?.id ?? "recent"))}
                >
                  {g.label} <span style={{ color: "var(--text-faint)" }}>{g.count}</span>
                </button>
              ))}
            </div>
          )}
          {(activeGroup?.rows ?? []).map((e) => (
            <div
              key={e.address}
              className="page-evidence-row"
              style={{
                ...DENSE_ROW,
                whiteSpace: "nowrap",
                overflow: "hidden",
                minWidth: 0,
              }}
            >
              {isNewSince(e.updatedAt, seenAt) && <span style={NEW_DOT} />}
              {renderAddress(e.address)}
              <span style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                {e.label}
              </span>
              {e.status && <span style={ROW_META}>{e.status}</span>}
              {/* A decision row is corrected on its question (`change`), not taken off. */}
              {!e.address.startsWith(DECISION_ADDRESS_PREFIX) && (
                <button
                  type="button"
                  className="page-evidence-x"
                  disabled={retracting !== null}
                  data-retracting={retracting === e.address ? "" : undefined}
                  onClick={(ev) => void retract(e.address, ev.currentTarget.closest<HTMLElement>(".page-evidence-row"))}
                  title="Take this row off the page"
                  aria-label={`Take ${e.address} off the page`}
                  style={e.status ? undefined : { marginLeft: "auto" }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </Section>
      )}

      {page.settledQuestions.length > 0 && <DecidedSection rows={page.settledQuestions} />}

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

      {page.droppedItems.length > 0 && <DroppedSection rows={page.droppedItems} />}
    </div>
  );
}

/** DROPPED (SWIT-78, Ky's CC-703): rows that were never the right row —
 *  history, collapsed by default so they never compete with the rows that
 *  still matter. Same disclosure shape as Decided. */
function DroppedSection({ rows }: { rows: PageItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Dropped" count={rows.length}>
      <button type="button" className="page-textlink" onClick={() => setOpen((v) => !v)} style={TEXT_LINK}>
        {open ? "hide" : `show ${rows.length} ▸`}
      </button>
      {open && rows.map((i) => <ItemRow key={i.id} item={i} />)}
    </Section>
  );
}

/** Ky's `PlanPanel.Section`: an H2 with a hairline; `hot` = the section
 *  that needs the user, in amber. */
function Section({
  title,
  count,
  meta,
  isNew = false,
  hot = false,
  block,
  children,
}: {
  title: string;
  count?: number;
  meta?: string;
  isNew?: boolean;
  hot?: boolean;
  /** SWIT-79: a scroll target name (`data-page-block`) for a focus request. */
  block?: string;
  children: ReactNode;
}) {
  return (
    <section data-page-block={block}>
      <h2 style={hot ? { ...SECTION_TITLE, color: "var(--tone-amber)" } : SECTION_TITLE}>
        {title}
        {count !== undefined && <span style={SECTION_COUNT}>{count}</span>}
        {isNew && <span style={{ ...NEW_DOT, alignSelf: "center" }} title="New since you last looked" />}
        {meta && <span style={SECTION_META}>{meta}</span>}
      </h2>
      {children}
    </section>
  );
}

/** A local save the poll has not shown yet (`at` = Date.now() at the save). */
type LocalAnswer = { text: string; at: number };
/** Second-precision stamps from Rust vs Date.now() here: a page answer
 *  stamped within this window of the local save is the same save. */
const CAUGHT_UP_SLACK_MS = 1_500;

/** THE BATCH (SWIT-77 — Ky's DecisionsArtifact): every open question and
 *  every decided-but-unsent one, numbered oldest first; the preview of the
 *  one message; the footer; one `Send decisions ▸`. Renders its own section
 *  and nothing at all when the list is empty. See the file header. */
function DecisionsBlock({
  threadId,
  page,
  seenAt,
}: {
  threadId: string;
  page: RenderedPage;
  seenAt: number | null;
}) {
  // The overlay between an action and the poll that shows it on the page:
  // answers saved HERE (until the files carry them), ids SENT here (until
  // the files say sent). The files win the moment they catch up.
  const [local, setLocal] = useState<Record<string, LocalAnswer>>({});
  /** id → Date.now() at the send. Hidden until the files take the question
   *  out of the batch, or show an answer newer than the send (re-answered
   *  elsewhere — it goes again). */
  const [sent, setSent] = useState<Record<string, number>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // A decided card folds to one line; `change` reopens it until the next save.
  const [reopened, setReopened] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<AnswerNote | null>(null);
  const [focusBox, setFocusBox] = useState<string | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);

  const pageAnswers = useMemo(() => {
    const m: Record<string, PageAnswer> = {};
    for (const a of page.unsentDecisions) m[a.question.id] = a.answer;
    return m;
  }, [page.unsentDecisions]);

  useEffect(() => {
    setLocal((prev) => {
      let next: Record<string, LocalAnswer> | null = null;
      for (const [id, l] of Object.entries(prev)) {
        const listed = page.decisionQuestions.some((q) => q.id === id);
        const onPage = pageAnswers[id];
        const caughtUp =
          onPage !== undefined &&
          (onPage.text === l.text || Date.parse(onPage.at) >= l.at - CAUGHT_UP_SLACK_MS);
        if (!listed || caughtUp) {
          next ??= { ...prev };
          delete next[id];
        }
      }
      return next ?? prev;
    });
    setSent((prev) => {
      let next: Record<string, number> | null = null;
      for (const [id, sentAt] of Object.entries(prev)) {
        const listed = page.decisionQuestions.some((q) => q.id === id);
        const onPage = pageAnswers[id];
        const reanswered = onPage !== undefined && Date.parse(onPage.at) > sentAt + CAUGHT_UP_SLACK_MS;
        if (!listed || reanswered) {
          next ??= { ...prev };
          delete next[id];
        }
      }
      return next ?? prev;
    });
  }, [page.decisionQuestions, pageAnswers]);

  useEffect(() => {
    if (!focusBox) return;
    inputRefs.current[focusBox]?.focus();
    setFocusBox(null);
  }, [focusBox]);

  // Where the batch would go: this thread, launched and live — read from
  // the published view so the button reads `thread not live` the moment the
  // claude exits. App re-applies the same rule on send (its session list is
  // the ground truth).
  const threadsView = useThreadsView();
  const target = useMemo(() => {
    const thread = threadsView.threads.find((t) => t.id === threadId);
    const status = thread?.sessionId ? threadsView.sessionStatuses[thread.sessionId] : undefined;
    return batchSendTarget(thread, threadsView.launched.has(threadId), status !== undefined && status !== "exited");
  }, [threadsView, threadId]);

  const visible = useMemo(
    () => page.decisionQuestions.filter((q) => !(q.id in sent)),
    [page.decisionQuestions, sent]
  );
  const answerOf = (q: PageQuestion): string | null => local[q.id]?.text ?? pageAnswers[q.id]?.text ?? null;
  const answers = useMemo(() => {
    const m: Record<string, string> = {};
    for (const q of visible) {
      const a = local[q.id]?.text ?? pageAnswers[q.id]?.text;
      if (a) m[q.id] = a;
    }
    return m;
  }, [visible, local, pageAnswers]);
  const decided = Object.keys(answers).length;
  const frozen = busy !== null || sending;
  /** Text typed into a box and not saved yet — Send saves it first. */
  const pendingDraft = (q: PageQuestion): string => {
    const text = (drafts[q.id] ?? "").trim();
    return text && text !== answerOf(q) ? text : "";
  };
  const hasDraft = visible.some((q) => pendingDraft(q));

  /** Save one answer to the page (answers.json) and hold it locally until
   *  the poll shows it. False, with the note set, if the write failed — the
   *  draft stays in its box. */
  const saveAnswer = async (q: PageQuestion, clean: string): Promise<boolean> => {
    try {
      await answerQuestion(threadId, q.id, clean);
    } catch (err) {
      setNote(answerErrorNote(err));
      return false;
    }
    setLocal((p) => ({ ...p, [q.id]: { text: clean, at: Date.now() } }));
    setDrafts((d) => ({ ...d, [q.id]: "" }));
    setReopened((o) => ({ ...o, [q.id]: false }));
    setNote(null);
    return true;
  };
  const decideOne = async (q: PageQuestion, text: string) => {
    const clean = text.trim();
    if (!clean || frozen) return;
    setBusy(q.id);
    setPicking(q.options.includes(clean) ? clean : null);
    try {
      await saveAnswer(q, clean);
    } finally {
      setBusy(null);
      setPicking(null);
    }
  };
  /** Leaving a box saves what was typed — unless focus is moving to one of
   *  THIS block's buttons (Tab; clicks never blur, see keepFocus): a chip
   *  decides for itself and Send saves every box itself. */
  const leaveBox = (q: PageQuestion, e: FocusEvent<HTMLInputElement>) => {
    const to = e.relatedTarget;
    if (to instanceof HTMLButtonElement && rootRef.current?.contains(to)) return;
    const text = pendingDraft(q);
    if (text) void decideOne(q, text);
  };
  const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault();

  const send = async () => {
    if ((decided === 0 && !hasDraft) || frozen) return;
    setSending(true);
    setNote(null);
    try {
      // Typed answers first: every box still holding text is saved before
      // the message is built, so nothing typed is lost (Ky's CC-721).
      const saved: Record<string, string> = { ...answers };
      for (const q of visible) {
        const text = pendingDraft(q);
        if (!text) continue;
        if (!(await saveAnswer(q, text))) return; // the note names it; the text is still in its box
        saved[q.id] = text;
      }
      const ids = visible.filter((q) => saved[q.id]).map((q) => q.id);
      if (ids.length === 0) return;
      // The gate again at send time (the button can lag a store tick).
      if (target.sessionId === null) throw new Error(target.reason);
      // composeWrite: multi-line → ONE bracketed paste + ONE CR, so the
      // batch arrives as one message. The batch's `convention` answers ride
      // along: App appends them to conventions.md once the write succeeded
      // (the decision is final when it goes — review fix F6).
      const bytes = composeWrite(decisionsMessage(visible, saved));
      await submitToThread(threadId, bytes, { conventions: conventionEntries(visible, saved) });
      let marked: number;
      try {
        marked = await markThreadAnswersSent(threadId, ids);
      } catch (err) {
        // The agent HAS the message; only the stamp failed. Say so and leave
        // the rows — a second send would repeat what it already heard.
        setNote(sendErrorNote(`sent, but not marked sent: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      // Review fix F7: Rust returns HOW MANY it stamped. Fewer than sent is
      // not success — say which count, and mark NOTHING sent locally: the
      // poll folds the stamped ones out of the batch from the files, and
      // the rest stay listed (unsent) for the next send.
      const partial = partialSentNote(marked, ids.length);
      if (partial !== null) {
        setNote(partial);
        return;
      }
      const now = Date.now();
      setSent((prev) => {
        const next = { ...prev };
        for (const id of ids) next[id] = now;
        return next;
      });
      setLocal((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
    } catch (err) {
      setNote(sendErrorNote(err));
    } finally {
      setSending(false);
    }
  };

  if (visible.length === 0) return null;
  const notLive = target.sessionId === null;
  const cannotSend = (decided === 0 && !hasDraft) || frozen || notLive;

  return (
    <Section title="Open questions" count={visible.length} block="decisions" hot>
      <div ref={rootRef} style={{ display: "flex", flexDirection: "column" }}>
        {visible.map((q, i) => {
          const chosen = answerOf(q);
          const rec = recommendation(q);
          const options = orderedOptions(q);
          const isNew = isNewSince(q.askedAt, seenAt);
          if (chosen !== null && !reopened[q.id]) {
            return (
              <button
                key={q.id}
                type="button"
                onMouseDown={keepFocus}
                onClick={() => {
                  setReopened((o) => ({ ...o, [q.id]: true }));
                  setFocusBox(q.id);
                }}
                title={`${chosen} — click to change`}
                className="page-evidence-row"
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  width: "100%",
                  padding: "7px 0",
                  background: "none",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  fontFamily: READING,
                  fontSize: 12,
                  lineHeight: 1.45,
                  textAlign: "left",
                  cursor: "pointer",
                  color: "var(--text-secondary)",
                }}
              >
                <span style={NUM}>{i + 1}</span>
                <span style={{ color: "var(--text-secondary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {q.text}
                </span>
                <span style={{ color: "var(--text-primary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  → {chosen}
                </span>
                <span style={UNSENT} title={UNSENT_TITLE}>{UNSENT_WORD}</span>
                <span style={{ flex: "none", fontFamily: MONO, fontSize: 10, color: "var(--text-faint)" }}>change</span>
              </button>
            );
          }
          return (
            <div
              key={q.id}
              style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 0", borderBottom: "1px solid var(--border)" }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={NUM}>{i + 1}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "var(--text-primary)", lineHeight: 1.45 }}>
                  {q.text}
                  {isNew && <span style={{ ...NEW_DOT, marginLeft: 6, verticalAlign: "middle" }} title="New since you last looked" />}
                </span>
                <span style={{ flex: "none", fontFamily: MONO, fontSize: 10, color: chosen ? "var(--text-primary)" : "var(--text-faint)" }}>
                  {chosen ? "decided" : "open"}
                </span>
                {chosen && <span style={UNSENT} title={UNSENT_TITLE}>{UNSENT_WORD}</span>}
              </div>
              {rec && (
                <div style={{ marginLeft: CARD_INDENT, fontSize: 12, color: "var(--text-secondary)" }}>
                  <span style={{ color: "var(--text-primary)" }}>Recommended: {rec.option}</span>
                  {rec.why && <> — {rec.why}</>}
                </div>
              )}
              {options.length > 0 && (
                <div
                  role="listbox"
                  aria-label="Options"
                  style={{
                    marginLeft: CARD_INDENT,
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
                    const at = nodes.indexOf(document.activeElement as HTMLElement);
                    const next = nodes[at + (e.key === "ArrowDown" ? 1 : -1)];
                    if (!next) return;
                    e.preventDefault();
                    next.focus();
                  }}
                >
                  {options.map((o) => (
                    <OptionRow
                      key={o}
                      label={o}
                      isDefault={o === q.defaultOption}
                      disabled={frozen}
                      chosen={chosen === o || (busy === q.id && picking === o)}
                      keepFocus
                      onPick={() => void decideOne(q, o)}
                    />
                  ))}
                </div>
              )}
              {chosen !== null && !options.includes(chosen) && (
                <div style={{ marginLeft: CARD_INDENT, fontSize: 12 }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)" }}>you: </span>
                  {chosen}
                </div>
              )}
              <input
                ref={(el) => {
                  inputRefs.current[q.id] = el;
                }}
                value={drafts[q.id] ?? ""}
                // Only THIS question's box waits on its own save: a blur into
                // the next box must not disable that box before focus lands.
                disabled={busy === q.id || sending}
                onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (drafts[q.id] ?? "").trim()) void decideOne(q, drafts[q.id]);
                  e.stopPropagation();
                }}
                onBlur={(e) => leaveBox(q, e)}
                placeholder={chosen ? "or change your answer…" : options.length ? "or type an answer…" : "type your answer…"}
                aria-label={`Your answer to: ${q.text}`}
                style={{ ...FIELD, marginLeft: CARD_INDENT, width: `calc(100% - ${CARD_INDENT}px)` }}
              />
            </div>
          );
        })}

        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 4 }}>
            what the agent gets — one message, when you send
          </div>
          <div style={{ fontFamily: MONO, fontSize: 11, lineHeight: 1.6, color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>
            {decisionsMessage(visible, answers)}
          </div>
        </div>

        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, fontFamily: MONO, fontSize: 10.5, color: "var(--text-faint)" }}>
          <span>{decisionsFooter(decided, visible.length)}</span>
          {note?.kind === "error" && <span style={{ color: "var(--text-muted)" }}>{note.text}</span>}
          <button
            type="button"
            disabled={cannotSend}
            onMouseDown={keepFocus}
            onClick={() => void send()}
            title={
              notLive
                ? target.reason ?? BATCH_NOT_LIVE
                : decided === 0 && !hasDraft
                  ? "pick an option or type an answer first"
                  : "send every decision to the thread as one message"
            }
            style={{ ...PRIMARY, marginLeft: "auto", opacity: cannotSend ? 0.4 : 1, cursor: cannotSend ? "default" : "pointer" }}
          >
            {sending ? "Sending…" : notLive ? BATCH_NOT_LIVE : "Send decisions ▸"}
          </button>
        </div>
      </div>
    </Section>
  );
}

/** DECIDED (SWIT-77): the settled questions, folded behind a count —
 *  `you: <answer>` for the user's, `settled: <answer>` for the agent's. */
function DecidedSection({ rows }: { rows: SettledQuestion[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Decided" count={rows.length}>
      <button type="button" className="page-textlink" onClick={() => setOpen((v) => !v)} style={TEXT_LINK}>
        {open ? "hide" : `show ${rows.length} ▸`}
      </button>
      {open &&
        rows.map(({ question, answer, by }) => (
          <div key={question.id} style={{ ...DENSE_ROW, flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 12.5, color: "var(--text-primary)", lineHeight: 1.45 }}>{question.text}</span>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)" }}>{by === "agent" ? "settled: " : "you: "}</span>
              {answer}
            </span>
          </div>
        ))}
    </Section>
  );
}

/** A cross-thread post: the origin as a 9.5px meta line, then the text. */
function PostRow({ post, isNew }: { post: InboxPost; isNew: boolean }) {
  return (
    <div style={{ ...DENSE_ROW, flexDirection: "column", gap: 2 }}>
      <div style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)", display: "flex", gap: 6, alignItems: "center" }}>
        ↓ <span style={{ color: "var(--text-muted)" }}>{post.from}</span>
        {isNew && <span style={NEW_DOT} title="New since you last looked" />}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-primary)", lineHeight: 1.45 }}>{post.text}</div>
    </div>
  );
}

/** SWIT-69 — words, not glyphs: a CHECKBOX (`☐` open, `☑` done, in our
 *  tokens), the text, a one-word status where not obvious, the OWNER column
 *  right-aligned — dim, or AMBER semibold when the row waits on the user
 *  (SWIT-77, Ky's PlanPanel: the colour is the state that needs you, the
 *  only colour on the page). No colored glyph, no spinner. A legacy note
 *  (nothing writes one since SWIT-77) still reads in the row's title. */
function ItemRow({ item }: { item: PageItem }) {
  const word = STATE_WORD[item.state];
  const done = item.state === "done";
  // SWIT-78: a dropped row is off the live list too — never amber, never checked.
  const onYou = isOpenItem(item) && isWaitingOnUser(item);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "18px minmax(0, 1fr) auto",
        columnGap: 12,
        alignItems: "start",
        padding: "7px 0",
        borderBottom: "1px solid var(--border)",
      }}
      title={item.note ?? undefined}
    >
      <span style={checkboxStyle(done)} aria-hidden>
        {done ? "✓" : ""}
      </span>
      <span
        style={{
          minWidth: 0,
          fontSize: 12.5,
          lineHeight: 1.45,
          overflowWrap: "anywhere",
          color: isOpenItem(item) ? "var(--text-primary)" : "var(--text-faint)",
          textDecoration: done ? "none" : undefined,
        }}
      >
        {item.title}
      </span>
      <span
        style={{
          paddingTop: 2,
          fontFamily: MONO,
          fontSize: 10,
          whiteSpace: "nowrap",
          textAlign: "right",
          color: onYou ? "var(--tone-amber)" : "var(--text-faint)",
          fontWeight: onYou ? 600 : 400,
        }}
        title={word ?? item.state}
      >
        {word ? `${word} · ` : ""}
        {OWNER_LABEL[item.owner]}
      </span>
    </div>
  );
}

/** Ky's TurnLines: each line of a turn as a dash-bulleted line with a
 *  hanging indent — 12.5px primary for the latest turn, dim for earlier. */
function TurnLines({ lines, dim = false }: { lines: string[]; dim?: boolean }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: "4px 0" }}>
      {lines.map((l, i) => (
        <li
          key={i}
          style={{
            fontSize: 12.5,
            lineHeight: 1.5,
            paddingLeft: 12,
            textIndent: -12,
            color: dim ? "var(--text-secondary)" : "var(--text-primary)",
          }}
        >
          <span style={{ color: "var(--text-faint)" }}>– </span>
          {l}
        </li>
      ))}
    </ul>
  );
}

/** The shared link shape for an address that OPENS something. */
function AddressButton({
  text,
  title,
  onOpen,
  accent = false,
}: {
  text: string;
  title: string;
  onOpen: (modifier: boolean) => void;
  /** Ky's `next →` link: the accent, underlined under the pointer. An
   *  evidence address is primary text on Ky's hairline (`.page-address`). */
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      className={accent ? "page-next" : "page-address"}
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
        fontFamily: MONO,
        fontSize: 11,
        color: accent ? "var(--accent)" : "var(--text-primary)",
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
function EvidenceAddress({
  address,
  target,
  accent = false,
}: {
  address: string;
  target: OpenableArtifact | null;
  accent?: boolean;
}) {
  if (!target)
    return (
      <span
        className={accent ? undefined : "page-address"}
        style={{
          fontFamily: MONO,
          fontSize: 11,
          color: accent ? "var(--accent)" : "var(--text-primary)",
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
      accent={accent}
      onOpen={(modifier) => openArtifact(target, { modifier })}
    />
  );
}

/** Earlier turns, folded behind a text link button — the latest is the page's face. */
function EarlierTurns({ turns }: { turns: { at: string; lines: string[] }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="page-textlink" onClick={() => setOpen((v) => !v)} style={TEXT_LINK}>
        {open ? "hide earlier" : `earlier (${turns.length})`}
      </button>
      {open &&
        turns.map((t, i) => (
          <div key={`${t.at}-${i}`} style={{ marginTop: 8, paddingLeft: 8, borderLeft: "1px solid var(--border)" }}>
            {t.at && <div style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)" }}>{turnTime(t.at)}</div>}
            <TurnLines lines={t.lines} dim />
          </div>
        ))}
    </>
  );
}

/** Ky's turnTime: `Sep 9, 9:09 AM`; an unparseable stamp prints as written. */
function turnTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
