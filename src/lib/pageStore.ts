// THE ✦ PAGE's data layer (SWIT-48) — one living page per thread, rendered
// as a MERGE of three per-thread files with ONE WRITER EACH:
//
//   page.json    ← the agent, through the MCP server (SWIT-49). Theme, turns,
//                  evidence rows, questions, to-do items.
//   answers.json ← the app (SWIT-51): Eric's answers, joined to questions by
//                  id at render time — page.json is never touched. Each answer
//                  ALSO renders as a `decision:<id>` evidence row (SWIT-58),
//                  synthesized in the merge — never written to page.json.
//                  SWIT-77: an answer is SAVED here at once and reaches the
//                  agent later, as ONE message with every other answer
//                  (`decisionsMessage`); `sentAt` on the entry says it went
//                  (`isAnswerUnsent` is the rule — no sentAt, or older than
//                  `at`, so a changed answer is unsent again). The agent may
//                  settle a question itself (page op `resolve`): that lands
//                  in page.json as answer + answeredAt + resolvedBy "agent".
//                  An UNSENT batch is visible outside the page too: App's 5s
//                  pass counts open + unsent per thread (`countQuestionStates`)
//                  for the rail marker, and Home's Needs you prints one row
//                  per thread with unsent decisions (`unsentDecisionsLine`).
//   inbox.json   ← the app (SWIT-52): cross-thread posts, folded under Needs
//                  You / What Happened with their origin.
//   retracted.json ← the app (SWIT-78): the evidence rows Eric took OFF the
//                  page (`×` on a row). page.json stays the agent's file, so a
//                  retraction is an OVERLAY — `{address, at}` — folded out at
//                  read time (`applyRetractions`): the agent's row is hidden
//                  UNLESS its `updatedAt` is newer than the retraction, so
//                  re-posting the address brings it back on purpose. A
//                  scrollback-scanned row is hidden by address alone (PageView
//                  applies `isRetracted` with no stamp): a sighting in the
//                  buffer is not the agent re-posting.
//
// One-writer-per-file is the editor.ts / pinsStore lesson made structural:
// no file here can ever race two writers, so no conflict machinery exists.
//
// Layout mirrors the repo's other stores: PURE helpers first (tolerant
// parses — a broken field drops alone, never eats the page — the merge, the
// fold rules, the seen-stamp math), then the one React hook that owns loading
// policy: a 2.5s ACTIVE-GATED poll with the refreshPins rules (no-op on
// unchanged content; a failed read keeps the last good page).
//
// NOTHING in this module touches the terminal: no fitQueue, no terminal
// registry, no resize path — a page update arriving while the agent is
// RUNNING repaints the panel body and only the panel body (the freeze rule is
// unreachable from here by construction; the test asserts the import graph).

import { useCallback, useEffect, useRef, useState } from "react";
import { readThreadFile } from "./ipc";

// ── Caps (R2 edge cases: the page is not a chat) ─────────────────────────────
// Enforced at WRITE time by the MCP server (SWIT-49, with a visible error to
// the agent); applied here too on the way in, so a hand-edited or oversized
// file degrades to the same shape instead of an unbounded render.

export const TURN_CAP = 30;
export const TURN_LINE_CAP = 6;
export const EVIDENCE_CAP = 60;
export const QUESTION_CAP = 20;
/** Done items beyond this fold behind a count. */
export const DONE_FOLD = 10;
/** A turn's reviewFirst is an ADDRESS, not prose — the server refuses more
 *  (SWIT-67); here a hand-written longer one is truncated, same posture as
 *  the other caps. Mirrors the server's REVIEW_FIRST_CAP. */
export const REVIEW_FIRST_CAP = 300;
/** SWIT-77: an ask's `why` is ONE line on the recommendation — the server
 *  refuses more; a hand-written longer one is cut here. Mirrors WHY_CAP. */
export const WHY_CAP = 240;

// ── File shapes ──────────────────────────────────────────────────────────────

export type PageTurn = {
  at: string;
  lines: string[];
  /** SWIT-67: the ONE thing to look at first when a turn opened or produced
   *  more than one — an evidence-style address, rendered as `start here →`
   *  directly under the page summary. Absent on most turns. */
  reviewFirst?: string;
};
export type PageEvidence = {
  /** The dedupe key and the link — `SWIT-43`, `switchboard #61`, a path. */
  address: string;
  label: string;
  status: string | null;
  updatedAt: string;
};
/** SWIT-58: what an `ask` wants back. Mirrors the server's QUESTION_KINDS. */
export type PageQuestionKind = "decision" | "convention" | "info";
export type PageQuestion = {
  id: string;
  text: string;
  options: string[];
  askedAt: string;
  /** decision (the default) · convention (a standing rule — the app appends
   *  the answer to conventions.md) · info (a fact only the user knows). */
  kind: PageQuestionKind;
  /** The agent's PROPOSAL — one of `options`, or null. The UI lists it
   *  first and marks it; the file keeps `options` in the order asked. */
  defaultOption: string | null;
  /** SWIT-77: one line on why the recommendation is the one (Ky's `why`).
   *  Printed as `Recommended: <option> — <why>` above the options. */
  why: string | null;
  /** SWIT-77: the AGENT settled it (page op `resolve` — answered in chat,
   *  decided elsewhere, moot): the answer and when. Null while nobody has.
   *  A user answer in answers.json takes precedence over this (the merge). */
  resolved: { answer: string; at: string; by: "agent" | "user" } | null;
};
export type PageItemOwner = "agent" | "user" | "team";
/** SWIT-78 (Ky's plan tool): `done` = the work happened; `dropped` = the row
 *  was never the right row (superseded, taken over, a "later" bucket). Both
 *  leave the live list; only `done` is an accomplishment. */
export type PageItemState = "todo" | "in_progress" | "waiting" | "done" | "dropped";
export type PageItem = {
  id: string;
  title: string;
  owner: PageItemOwner;
  state: PageItemState;
  note: string | null;
  /** SWIT-78: when the item left the live list (close OR drop). Null while
   *  open, or on an item closed before the stamp existed. */
  closedAt: string | null;
};

/** An item still on the live list — neither done nor dropped. Pure. */
export function isOpenItem(item: Pick<PageItem, "state">): boolean {
  return item.state !== "done" && item.state !== "dropped";
}

/** page.json — the agent's half, newest-first arrays. */
export type PageFile = {
  theme: string | null;
  turns: PageTurn[];
  evidence: PageEvidence[];
  questions: PageQuestion[];
  items: PageItem[];
};

export const EMPTY_PAGE: PageFile = Object.freeze({
  theme: null,
  turns: [],
  evidence: [],
  questions: [],
  items: [],
});

/** answers.json — question id → Eric's answer. SWIT-77: `sentAt` = when the
 *  batch that carried it reached the thread (absent = unsent); `resolvedBy`
 *  is always "user" for this file (the agent's settlements live in
 *  page.json) — carried so a reader of the file alone can tell. */
export type PageAnswer = { text: string; at: string; sentAt?: string; resolvedBy?: "user" };
export type AnswersFile = Record<string, PageAnswer>;

/** retracted.json — an evidence row Eric took off the page (SWIT-78): the
 *  address and WHEN, so a row the agent re-posts later (newer `updatedAt`)
 *  comes back. The app is this file's one writer (Rust
 *  `retract_thread_evidence`); the cap mirrors its RETRACTED_CAP. */
export type RetractedEvidence = { address: string; at: string };
export const RETRACTED_CAP = 200;

/** inbox.json — cross-thread posts delivered TO this thread (SWIT-52). */
export type InboxPost = {
  id: string;
  /** The SENDING thread's title (plain words, not an id — R2 language rules). */
  from: string;
  kind: "update" | "request";
  text: string;
  at: string;
};

// ── Tolerant parses ──────────────────────────────────────────────────────────
// Same posture as pins.ts: unknown fields ignored, a malformed ENTRY drops
// alone, malformed FILES degrade to empty — the page must render whatever
// survives, never throw over what does not.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function parsePageFile(raw: string): PageFile {
  if (raw.trim().length === 0) return EMPTY_PAGE;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY_PAGE;
  }
  if (!isRecord(data)) return EMPTY_PAGE;

  const turns: PageTurn[] = [];
  if (Array.isArray(data.turns)) {
    for (const t of data.turns) {
      if (!isRecord(t) || !Array.isArray(t.lines)) continue;
      const lines = t.lines
        .filter((l): l is string => typeof l === "string" && l.trim().length > 0)
        .slice(0, TURN_LINE_CAP);
      if (lines.length === 0) continue;
      const reviewFirst = str(t.reviewFirst)?.slice(0, REVIEW_FIRST_CAP) ?? null;
      turns.push(
        reviewFirst !== null
          ? { at: str(t.at) ?? "", lines, reviewFirst }
          : { at: str(t.at) ?? "", lines }
      );
      if (turns.length >= TURN_CAP) break;
    }
  }

  const evidence: PageEvidence[] = [];
  const seenAddresses = new Set<string>();
  if (Array.isArray(data.evidence)) {
    for (const e of data.evidence) {
      if (!isRecord(e)) continue;
      const address = str(e.address);
      if (!address || seenAddresses.has(address)) continue;
      seenAddresses.add(address);
      evidence.push({
        address,
        label: str(e.label) ?? "",
        status: str(e.status),
        updatedAt: str(e.updatedAt) ?? "",
      });
      if (evidence.length >= EVIDENCE_CAP) break;
    }
  }

  const questions: PageQuestion[] = [];
  const seenQuestionIds = new Set<string>();
  if (Array.isArray(data.questions)) {
    for (const q of data.questions) {
      if (!isRecord(q)) continue;
      const id = str(q.id);
      const text = str(q.text);
      if (!id || !text || seenQuestionIds.has(id)) continue;
      seenQuestionIds.add(id);
      const options = Array.isArray(q.options)
        ? q.options.filter((o): o is string => typeof o === "string" && o.length > 0)
        : [];
      // A default that is not one of the options is dropped, not trusted:
      // the server refuses one at write time, so only a hand-edit gets here.
      const dflt = str(q.default);
      // SWIT-77: an agent settlement needs BOTH the answer and the stamp;
      // one without the other is a half-write and the question stays open.
      const resolvedAnswer = str(q.answer);
      const resolvedAt = str(q.answeredAt);
      questions.push({
        id,
        text,
        options,
        askedAt: str(q.askedAt) ?? "",
        kind: q.kind === "convention" || q.kind === "info" ? q.kind : "decision",
        defaultOption: dflt !== null && options.includes(dflt) ? dflt : null,
        why: str(q.why)?.slice(0, WHY_CAP) ?? null,
        resolved:
          resolvedAnswer !== null && resolvedAt !== null
            ? { answer: resolvedAnswer, at: resolvedAt, by: q.resolvedBy === "user" ? "user" : "agent" }
            : null,
      });
      if (questions.length >= QUESTION_CAP) break;
    }
  }

  const items: PageItem[] = [];
  const seenItemIds = new Set<string>();
  if (Array.isArray(data.items)) {
    for (const i of data.items) {
      if (!isRecord(i)) continue;
      const id = str(i.id);
      const title = str(i.title);
      if (!id || !title || seenItemIds.has(id)) continue;
      seenItemIds.add(id);
      const owner = i.owner === "user" || i.owner === "team" ? i.owner : "agent";
      const state =
        i.state === "in_progress" || i.state === "waiting" || i.state === "done" || i.state === "dropped"
          ? i.state
          : "todo";
      items.push({ id, title, owner, state, note: str(i.note), closedAt: str(i.closedAt) });
    }
  }

  return { theme: str(data.theme), turns, evidence, questions, items };
}

export function parseAnswersFile(raw: string): AnswersFile {
  if (raw.trim().length === 0) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(data)) return {};
  const out: AnswersFile = {};
  for (const [id, v] of Object.entries(data)) {
    if (id.length === 0 || !isRecord(v)) continue;
    const text = str(v.text);
    if (!text) continue;
    const answer: PageAnswer = { text, at: str(v.at) ?? "" };
    const sentAt = str(v.sentAt);
    if (sentAt !== null) answer.sentAt = sentAt;
    if (v.resolvedBy === "user") answer.resolvedBy = "user";
    out[id] = answer;
  }
  return out;
}

/** Tolerant parse of retracted.json: `{version, evidence: [{address, at}]}`
 *  (a bare array is taken too). A malformed entry drops alone; a repeated
 *  address keeps its FIRST (newest-first file) entry; capped. */
export function parseRetractedFile(raw: string): RetractedEvidence[] {
  if (raw.trim().length === 0) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = isRecord(data) && Array.isArray(data.evidence) ? data.evidence : Array.isArray(data) ? data : [];
  const out: RetractedEvidence[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    if (!isRecord(r)) continue;
    const address = str(r.address);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({ address, at: str(r.at) ?? "" });
    if (out.length >= RETRACTED_CAP) break;
  }
  return out;
}

// ── Retractions (SWIT-78 — the correctable record) ───────────────────────────
// Ky's CC-703: a `×` on an evidence row takes it off the page. page.json is
// the agent's file, so the app never edits the row — it records the address
// in retracted.json and the MERGE hides it. The rule has one exception, on
// purpose: an agent row whose `updatedAt` is NEWER than the retraction shows
// again, because re-posting an address is the agent saying "no, this one
// belongs" (its `drop_evidence` op is how it takes a row back for good).

/** Is a row at `address` hidden by the retractions? With `updatedAt` (an
 *  agent row), a stamp newer than the retraction's un-hides it; with NULL
 *  (a scrollback-scanned row — the scan's clock is a sighting, not a claim)
 *  the address alone decides. An unparseable stamp on either side counts as
 *  NOT newer — a retraction stands until the agent demonstrably re-posts.
 *  NEWER MEANS A LATER SECOND: the server stamps `updatedAt` in
 *  milliseconds, and retracted.json files written before the SWIT-78 review
 *  carry second-precision stamps — compared raw, a row updated at
 *  `10:00:00.500Z` and retracted at `10:00:00Z` counted as "re-posted" and
 *  stayed on the page. Both sides are floored to the second. A `decision:`
 *  address is NEVER retracted here (the writer refuses the prefix too): a
 *  decision is corrected on its question. Pure. */
export function isRetracted(
  address: string,
  updatedAt: string | null,
  retracted: readonly RetractedEvidence[]
): boolean {
  if (address.startsWith(DECISION_ADDRESS_PREFIX)) return false;
  const hit = retracted.find((r) => r.address === address);
  if (!hit) return false;
  if (updatedAt === null) return true;
  const rowAt = Date.parse(updatedAt);
  const retractedAt = Date.parse(hit.at);
  if (!Number.isFinite(rowAt) || !Number.isFinite(retractedAt)) return true;
  return Math.floor(rowAt / 1000) <= Math.floor(retractedAt / 1000);
}

/** The synthesized decision row's address prefix (`decisionAddress`). */
export const DECISION_ADDRESS_PREFIX = "decision:";

/** Fold the retractions out of a row list (agent-clock rows: `updatedAt` is
 *  consulted). Returns the SAME array when nothing is hidden. Pure. */
export function applyRetractions<T extends Pick<PageEvidence, "address" | "updatedAt">>(
  rows: readonly T[],
  retracted: readonly RetractedEvidence[]
): T[] {
  if (retracted.length === 0) return rows as T[];
  const kept = rows.filter((r) => !isRetracted(r.address, r.updatedAt, retracted));
  return kept.length === rows.length ? (rows as T[]) : kept;
}

// ── The batch (SWIT-77, Ky's decisionsStore) ─────────────────────────────────
// Answering SAVES; the agent hears every answer at once, as ONE message,
// when the user sends. The page owns the answer (answers.json); "unsent" is
// a stamp on the entry, not a second store.

/** An answer is UNSENT while it has no `sentAt`, or one older than `at` (a
 *  changed answer goes again). ISO stamps compare as strings — both come
 *  from the same writer (Rust's `chrono_like_now_iso`, one fixed shape).
 *  Pure. */
export function isAnswerUnsent(answer: PageAnswer | undefined): boolean {
  if (!answer) return false;
  return !answer.sentAt || answer.sentAt < answer.at;
}

/** The open / unsent split of a page's questions — what App's 5s pass counts
 *  per thread and the rail marker + Home's Needs you read (SWIT-77 review
 *  fix: an unsent batch used to be invisible outside the page). `open` =
 *  `isQuestionOpen`; `unsent` = answered in answers.json and not yet sent
 *  (`isAnswerUnsent`). Pure. */
export function countQuestionStates(
  questions: readonly Pick<PageQuestion, "id" | "resolved">[],
  answers: AnswersFile
): { open: number; unsent: number } {
  let open = 0;
  let unsent = 0;
  for (const q of questions) {
    if (isQuestionOpen(q, answers)) open += 1;
    else if (isAnswerUnsent(answers[q.id])) unsent += 1;
  }
  return { open, unsent };
}

/** The rail marker's WORDED tooltip for a thread's question state (the dim
 *  `· N` prints `open + unsent`): `2 open questions` · `1 decision unsent` ·
 *  `2 open · 1 unsent` when both. Null when there is nothing to mark. Pure. */
export function questionMarkerTitle(open: number, unsent: number): string | null {
  if (open <= 0 && unsent <= 0) return null;
  if (unsent <= 0) return `${open} open question${open === 1 ? "" : "s"}`;
  if (open <= 0) return `${unsent} decision${unsent === 1 ? "" : "s"} unsent`;
  return `${open} open · ${unsent} unsent`;
}

/** Home's Needs you row for a thread with decisions saved and not sent:
 *  `2 decisions unsent · send from the page` (ONE row per thread — the page
 *  is where the batch is sent; the row opens the thread). Pure. */
export function unsentDecisionsLine(n: number): string {
  return `${n} decision${n === 1 ? "" : "s"} unsent · send from the page`;
}

/** SWIT-77 review fix (F6): the `convention` answers in a batch — what the
 *  app appends to conventions.md AT SEND (the decision is final when it
 *  goes; appending on every save wrote two lines for pick A → change → pick
 *  B). Only questions of kind `convention` with a non-blank answer. Pure. */
export type ConventionEntry = { questionId: string; question: string; answer: string };
export function conventionEntries(
  questions: readonly Pick<PageQuestion, "id" | "text" | "kind">[],
  answers: Readonly<Record<string, string>>
): ConventionEntry[] {
  const out: ConventionEntry[] = [];
  for (const q of questions) {
    if (q.kind !== "convention") continue;
    const answer = answers[q.id];
    if (!answer || answer.trim().length === 0) continue;
    out.push({ questionId: q.id, question: q.text, answer: answer.trim() });
  }
  return out;
}

/** THE one message the agent gets (Ky's `decisionsMessage`, verbatim shape):
 *  every listed question, numbered in the order given, with its answer or
 *  `still open`. A multi-line answer folds to one line so each entry stays
 *  two lines and the message stays the composer's one bracketed paste.
 *
 *    Decisions:
 *    1. <question>
 *       → <answer | still open>
 *
 *  Pure. */
export function decisionsMessage(
  questions: readonly Pick<PageQuestion, "id" | "text">[],
  answers: Readonly<Record<string, string>>
): string {
  const flat = (s: string) => s.replace(/\s*\r?\n\s*/g, " ").trim();
  const lines = questions.map((q, i) => {
    const a = answers[q.id];
    return `${i + 1}. ${flat(q.text)}\n   → ${a && a.trim().length > 0 ? flat(a) : "still open"}`;
  });
  return `Decisions:\n${lines.join("\n")}`;
}

/** The footer under the batch: `M of N decided`, plus what happens to the
 *  rest when both kinds are present. Pure. */
export function decisionsFooter(decided: number, total: number): string {
  const base = `${decided} of ${total} decided`;
  return decided > 0 && decided < total ? `${base} · undecided ones go as "still open"` : base;
}

/** The agent's RECOMMENDATION line (Ky: `Recommended: <first> — <why>`):
 *  the default when one was given, else the FIRST option (Ky's rule — the
 *  agent's first option is its recommendation), with the `why` when there is
 *  one. Null when there is nothing to recommend: no options, or neither a
 *  default nor a why (a bare list is a list, not a proposal). Pure. */
export function recommendation(q: PageQuestion): { option: string; why: string | null } | null {
  if (q.options.length === 0) return null;
  if (q.defaultOption === null && q.why === null) return null;
  return { option: q.defaultOption ?? q.options[0], why: q.why };
}

export function parseInboxFile(raw: string): InboxPost[] {
  if (raw.trim().length === 0) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = isRecord(data) && Array.isArray(data.posts) ? data.posts : Array.isArray(data) ? data : [];
  const out: InboxPost[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    if (!isRecord(p)) continue;
    const id = str(p.id);
    const text = str(p.text);
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      from: str(p.from) ?? "another thread",
      kind: p.kind === "request" ? "request" : "update",
      text,
      at: str(p.at) ?? "",
    });
  }
  return out;
}

// ── Question helpers (pure) ──────────────────────────────────────────────────

/** The options as the UI lists them: the agent's default FIRST, the rest in
 *  the order asked. The file order is untouched (`options` is what the agent
 *  wrote); only the presentation moves the proposal to the top. */
export function orderedOptions(q: PageQuestion): string[] {
  if (q.defaultOption === null || !q.options.includes(q.defaultOption)) return q.options;
  return [q.defaultOption, ...q.options.filter((o) => o !== q.defaultOption)];
}

/** Evidence address of the decision an answered question became. The
 *  `decision:` prefix is what the agent's contract tells it to look for
 *  before asking (the server's tool description names it). */
export function decisionAddress(questionId: string): string {
  return `${DECISION_ADDRESS_PREFIX}${questionId}`;
}

/** The ONE line the app appends to conventions.md for a `convention` answer
 *  (SWIT-58) — the file's own dated-bullet shape, minus the leading `- `
 *  (the Rust append adds it, so a line can never be two bullets). Whitespace
 *  runs fold to one space: the file is one rule per line, and the Rust side
 *  refuses a line break outright. */
export function conventionLine(
  question: string,
  answer: string,
  threadTitle: string | null,
  now: Date = new Date()
): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const who = threadTitle && flat(threadTitle).length > 0 ? `; thread: ${flat(threadTitle)}` : "";
  return `${y}-${m}-${d} — ${flat(answer)} (asked: ${flat(question)}${who})`;
}

// ── The merge (pure) ─────────────────────────────────────────────────────────

export type AnsweredQuestion = { question: PageQuestion; answer: PageAnswer };
/** SWIT-77: a question nobody needs to answer any more — the user's SENT
 *  answer, or the agent's resolution. `by` picks the page's word: `you:` /
 *  `settled:`. */
export type SettledQuestion = { question: PageQuestion; answer: string; at: string; by: "user" | "agent" };

/** Is the item waiting on the USER — owned by the user, or parked in
 *  `waiting` (whoever owns it)? Home's Needs You and the To do owner column
 *  share this one predicate. Pure. */
export function isWaitingOnUser(item: Pick<PageItem, "owner" | "state">): boolean {
  return item.owner === "user" || item.state === "waiting";
}

/** Nobody has settled it: no user answer in answers.json, no agent
 *  resolution on the question. Pure — App's 5s pass counts with it too. */
export function isQuestionOpen(q: Pick<PageQuestion, "id" | "resolved">, answers: AnswersFile): boolean {
  return !(q.id in answers) && q.resolved === null;
}

/** What PageView renders — the three files folded into R2's section order. */
export type RenderedPage = {
  theme: string | null;
  /** OPEN questions — nobody has settled them (Home's Needs You lists these;
   *  a decided-but-unsent one is NOT here, it is in `unsentDecisions`). */
  openQuestions: PageQuestion[];
  /** SWIT-77: answered on the page, not yet sent to the agent. */
  unsentDecisions: AnsweredQuestion[];
  /** SWIT-77: THE BATCH — open + unsent, OLDEST FIRST so the numbering is
   *  stable while the user works down the list (Ky's visibleQuestions). The
   *  page's Open questions section renders exactly this, numbered. */
  decisionQuestions: PageQuestion[];
  /** Requests from other threads (the inbox's `request` posts). */
  requests: InboxPost[];
  /** The items WAITING ON THE USER (isWaitingOnUser) — what Home's Needs
   *  You lists. On the page itself they are To do rows with the owner column
   *  lit (SWIT-77: Needs you is retired there). */
  userItems: PageItem[];
  /** TO DO — EVERY open (non-done) item, the ones waiting on the user first
   *  (Ky's `[...waiting, ...active]`), then the rest in file order. */
  openItems: PageItem[];
  /** WHAT HAPPENED — the latest turn; earlier ones folded behind a count.
   *  Cross-thread updates ride here too, tagged with their origin. */
  latestTurn: PageTurn | null;
  earlierTurns: PageTurn[];
  updates: InboxPost[];
  /** EVIDENCE — the agent's rows PLUS one `decision:<id>` row per settled
   *  question (status `decided` for the user's answer — sent or not, it is
   *  on the page — `settled` for the agent's resolution; label = the
   *  answer), newest first. The decided rows are synthesized HERE:
   *  page.json stays the agent's file (one writer), and the page still shows
   *  every decision where the agent's contract says to look for it. */
  evidence: PageEvidence[];
  /** The decided rows alone, newest first — what the spawn context names as
   *  the standing decisions. */
  decisions: PageEvidence[];
  /** DECIDED — the settled questions (user answers that went, agent
   *  resolutions), newest first; the page folds them. */
  settledQuestions: SettledQuestion[];
  /** DONE — folded past DONE_FOLD. */
  doneItems: PageItem[];
  doneFolded: number;
  /** DROPPED (SWIT-78) — items that were never the right row; a collapsed
   *  disclosure BELOW Done. Excluded from To do, from Home and from every
   *  count. */
  droppedItems: PageItem[];
  /** SWIT-78: the retractions the merge applied — PageView needs them again
   *  for the rows it synthesizes AFTER the merge (scanned + view rows). */
  retractedEvidence: RetractedEvidence[];
  /** Nothing anywhere — the agent has not written yet. */
  isEmpty: boolean;
};

/** Newest first by `updatedAt`; an unparseable stamp sorts LAST, and equal
 *  stamps keep their input order (Array.prototype.sort is stable). */
function newestFirst(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  const na = Number.isFinite(ta) ? ta : -Infinity;
  const nb = Number.isFinite(tb) ? tb : -Infinity;
  return nb - na;
}

function byNewest(a: PageEvidence, b: PageEvidence): number {
  return newestFirst(a.updatedAt, b.updatedAt);
}

/** Oldest first by askedAt (the batch's stable numbering); an unparseable
 *  stamp sorts LAST; equal stamps keep input order (stable sort). */
function byOldestAsked(a: PageQuestion, b: PageQuestion): number {
  const ta = Date.parse(a.askedAt);
  const tb = Date.parse(b.askedAt);
  const na = Number.isFinite(ta) ? ta : Infinity;
  const nb = Number.isFinite(tb) ? tb : Infinity;
  return na - nb;
}

const NO_RETRACTIONS: RetractedEvidence[] = [];

export function mergePage(
  page: PageFile,
  answers: AnswersFile,
  inbox: InboxPost[],
  retracted: readonly RetractedEvidence[] = NO_RETRACTIONS
): RenderedPage {
  const openQuestions = page.questions.filter((q) => isQuestionOpen(q, answers));
  // PRECEDENCE (SWIT-77): the user's answer in answers.json is ground truth
  // over the agent's resolution of the same question — the agent settles
  // what the user left, never what the user said.
  const answeredQuestions: AnsweredQuestion[] = page.questions
    .filter((q) => q.id in answers)
    .map((q) => ({ question: q, answer: answers[q.id] }));
  const unsentDecisions = answeredQuestions.filter((a) => isAnswerUnsent(a.answer));
  const decisionQuestions = [...openQuestions, ...unsentDecisions.map((a) => a.question)].sort(byOldestAsked);
  const settledQuestions: SettledQuestion[] = [
    ...answeredQuestions
      .filter((a) => !isAnswerUnsent(a.answer))
      .map((a) => ({ question: a.question, answer: a.answer.text, at: a.answer.at, by: "user" as const })),
    ...page.questions
      .filter((q) => !(q.id in answers) && q.resolved !== null)
      .map((q) => ({ question: q, answer: q.resolved!.answer, at: q.resolved!.at, by: q.resolved!.by })),
  ].sort((a, b) => newestFirst(a.at, b.at));
  // SWIT-78: `dropped` leaves the live list exactly as `done` does — so it
  // is out of To do, out of `userItems` (Home's Needs you) and out of every
  // count — but it is not an accomplishment, so it never joins Done.
  const openAll = page.items.filter(isOpenItem);
  // SWIT-77 (Ky's PlanPanel): Needs you is retired on the page — an item
  // waiting on the user is a To do row with its owner column lit, listed
  // FIRST. `userItems` stays the roll-up's (Home) subset.
  const userItems = openAll.filter(isWaitingOnUser);
  const openItems = [...userItems, ...openAll.filter((i) => !isWaitingOnUser(i))];
  const doneAll = page.items.filter((i) => i.state === "done");
  const doneItems = doneAll.slice(0, DONE_FOLD);
  const droppedItems = page.items.filter((i) => i.state === "dropped");
  const requests = inbox.filter((p) => p.kind === "request");
  const updates = inbox.filter((p) => p.kind === "update");
  const decisions: PageEvidence[] = [
    ...answeredQuestions.map(({ question, answer }) => ({
      address: decisionAddress(question.id),
      label: answer.text,
      status: "decided",
      updatedAt: answer.at,
    })),
    ...page.questions
      .filter((q) => !(q.id in answers) && q.resolved !== null)
      .map((q) => ({
        address: decisionAddress(q.id),
        label: q.resolved!.answer,
        status: "settled",
        updatedAt: q.resolved!.at,
      })),
  ].sort(byNewest);
  // A decided row wins over an agent-written row at the same address (the
  // answer is ground truth); the rest merge newest-first, which keeps the
  // agent's own newest-first order among themselves (stable sort).
  // SWIT-78: the retractions fold out of the AGENT's rows here (newer
  // `updatedAt` un-hides — a re-post brings a row back); decision rows are
  // never retracted — a decision is corrected on its question (`change`).
  const decidedAddresses = new Set(decisions.map((d) => d.address));
  const evidence = [
    ...decisions,
    ...applyRetractions(page.evidence, retracted).filter((e) => !decidedAddresses.has(e.address)),
  ].sort(byNewest);
  const merged: RenderedPage = {
    theme: page.theme,
    openQuestions,
    unsentDecisions,
    decisionQuestions,
    requests,
    userItems,
    openItems,
    latestTurn: page.turns[0] ?? null,
    earlierTurns: page.turns.slice(1),
    updates,
    evidence,
    decisions,
    settledQuestions,
    doneItems,
    doneFolded: Math.max(0, doneAll.length - DONE_FOLD),
    droppedItems,
    retractedEvidence: retracted as RetractedEvidence[],
    isEmpty:
      page.theme === null &&
      page.turns.length === 0 &&
      page.evidence.length === 0 &&
      page.questions.length === 0 &&
      page.items.length === 0 &&
      inbox.length === 0,
  };
  return merged;
}

/** SWIT-68: the one-paragraph SUMMARY at the top of the page — the theme line
 *  plus the newest turn's first line, joined with ` — ` (a bare space ran two
 *  sentences together), plain text, no label. Null when neither exists (the
 *  empty-page state covers that). Pure. */
export function pageSummary(page: RenderedPage): string | null {
  const parts: string[] = [];
  if (page.theme) parts.push(page.theme);
  const first = page.latestTurn?.lines[0];
  if (first && first !== page.theme) parts.push(first);
  return parts.length > 0 ? parts.join(" — ") : null;
}

// ── Answer notes (SWIT-70 review fix; SWIT-77 the batch) ─────────────────────
// The ONE state rule both answering surfaces (PageView's DecisionsBlock,
// Home's QuestionCard) draw from: a SUCCESS note replaces the form (the poll
// collapses the block to the decided line next), a FAILURE note renders
// BESIDE the form — options stay clickable, the draft stays in the box, so a
// rejected answer is retryable (the retired QuestionView's rule kept). The
// same rule covers the batch's SEND: a failed send is an error note beside
// the form, the answers stay unsent, nothing is replaced (the 0.7.0 lesson).
// Pure.

export type AnswerNote = { kind: "success" | "error"; text: string };

/** Answering SAVES (SWIT-77): the wording says where the send is. Home's
 *  card shows it in place of the form; the page needs no note — the decided
 *  row IS the outcome. */
export function answerSuccessNote(): AnswerNote {
  return { kind: "success", text: "saved · send from the page" };
}

export function answerErrorNote(err: unknown): AnswerNote {
  return {
    kind: "error",
    text: `could not save: ${err instanceof Error ? err.message : String(err)}`,
  };
}

/** The batch did not go — the reason beside the button; the answers are
 *  still on the page and still unsent. */
export function sendErrorNote(err: unknown): AnswerNote {
  return {
    kind: "error",
    text: `not sent — ${err instanceof Error ? err.message : String(err)}`,
  };
}

/** SWIT-77 review fix (F7): the batch WENT, but Rust stamped fewer entries
 *  than were sent (`mark_thread_answers_sent` returns the count; an entry
 *  missing from answers.json — a concurrent re-answer, a hand edit — is not
 *  stamped). Null when every id was marked. The block shows this beside the
 *  button and marks NOTHING sent locally: the poll folds out the stamped
 *  ones from the files, and the rest stay in the batch. Pure. */
export function partialSentNote(marked: number, total: number): AnswerNote | null {
  if (marked >= total) return null;
  return { kind: "error", text: `sent, but ${total - marked} of ${total} not marked sent` };
}

/** Only a SUCCESS collapses the form; an error must leave it interactive. */
export function noteReplacesForm(note: AnswerNote | null): boolean {
  return note !== null && note.kind === "success";
}

// ── New-since-you-looked (device-local — R2, Ky's rule verbatim) ─────────────
// A localStorage stamp per thread, recorded only after the page has been ON
// SCREEN for SEEN_DWELL_MS (a glance while switching threads clears nothing);
// a FIRST visit marks nothing new (a page of dots says nothing).

export const SEEN_DWELL_MS = 4_000;

function seenKey(threadId: string): string {
  return `switchboard:pageSeen:${threadId}`;
}

export function loadPageSeen(threadId: string): number | null {
  try {
    const raw = localStorage.getItem(seenKey(threadId));
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function markPageSeen(threadId: string, now: number = Date.now()): void {
  try {
    localStorage.setItem(seenKey(threadId), String(now));
  } catch {
    // no persistence — the dot logic just stays quiet
  }
}

/** Is a timestamp string (ISO, from the page files) newer than the stamp?
 *  A null stamp = FIRST VISIT = never "new"; an unparseable time = not new
 *  (a dot must never be noise). Pure. */
export function isNewSince(at: string, seenAt: number | null): boolean {
  if (seenAt === null) return false;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  return t > seenAt;
}

// ── Inbox seen (SWIT-52) — the `↓ N` chip's device-local stamp ───────────────
// Same shape as the page stamp: opening the THREAD marks its inbox seen (the
// reference was typed into the terminal you are now looking at); the chip
// counts posts newer than the stamp.

function inboxSeenKey(threadId: string): string {
  return `switchboard:inboxSeen:${threadId}`;
}

export function loadInboxSeen(threadId: string): number | null {
  try {
    const raw = localStorage.getItem(inboxSeenKey(threadId));
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function markInboxSeen(threadId: string, now: number = Date.now()): void {
  try {
    localStorage.setItem(inboxSeenKey(threadId), String(now));
  } catch {
    // no persistence — the chip just stays quiet
  }
}

/** The ms of every post `at` that parses — what the 5s pass CACHES for a
 *  thread instead of a derived unread count (see nextPassEntry). Unparseable
 *  timestamps are dropped here, so they never count. Pure. */
export function postTimes(posts: readonly InboxPost[]): number[] {
  const out: number[] = [];
  for (const p of posts) {
    const t = Date.parse(p.at);
    if (Number.isFinite(t)) out.push(t);
  }
  return out;
}

/** `countUnreadPosts` over already-parsed times. A null stamp = never opened =
 *  EVERYTHING counts. Pure. */
export function countUnreadTimes(times: readonly number[], seenAt: number | null): number {
  if (seenAt === null) return times.length;
  let n = 0;
  for (const t of times) if (t > seenAt) n += 1;
  return n;
}

/** Unread posts for the chip. A null stamp = never opened = EVERYTHING
 *  counts (a brand-new post to a thread you have not visited should chip).
 *  Unparseable timestamps do not count — a chip must never be noise. Pure. */
export function countUnreadPosts(posts: readonly InboxPost[], seenAt: number | null): number {
  return countUnreadTimes(postTimes(posts), seenAt);
}

// ── The 5s pass's stamp gate (0.9.x hygiene, H3) — what a cached entry may say ─
// One `thread_files_stamp` stat per thread per tick; while the max mtime of
// page.json / answers.json / inbox.json is unchanged the reads are skipped and
// the entry below stands in. The entry holds the inbox's post TIMES, never an
// unread COUNT: the seen stamp is device-local state (localStorage), not one
// of the stamped files, so a count frozen at read time was wrong for a whole
// tick after a tab switch (thread B chipped `↓ 2`, Eric opened B — seen — and
// went back to A inside the same 5s; the next tick republished the cached 2).

export type ThreadPassEntry = {
  /** The stamp the entry was read under; -1 = a failed stat or read, which
   *  never matches, so the next tick re-reads. */
  stamp: number;
  /** Open questions at the read — page.json + answers.json, both stamped. */
  questions: number;
  /** Decided-but-unsent answers at the read (answers.json, stamped) — the
   *  same pass, the same two files (`countQuestionStates`). */
  unsent: number;
  /** The inbox's post times at the read (postTimes) — inbox.json is stamped,
   *  the seen stamp is not, so unread is re-derived from these every tick. */
  postsAt: readonly number[];
};

export type PassDecision =
  | { reread: true }
  | { reread: false; questions: number; unsent: number; unread: number };

/** The cached branch's decision for one thread on one tick: reuse the entry
 *  only when the stamp just stat'ed EQUALS the one it was read under (-1 on
 *  either side never matches); the question + unsent counts are republished
 *  as cached and the unread count is re-derived against the seen stamp
 *  passed in NOW. Pure. */
export function nextPassEntry(
  cached: ThreadPassEntry | undefined,
  stamp: number,
  seenAt: number | null
): PassDecision {
  if (!cached || stamp === -1 || cached.stamp !== stamp) return { reread: true };
  return {
    reread: false,
    questions: cached.questions,
    unsent: cached.unsent,
    unread: countUnreadTimes(cached.postsAt, seenAt),
  };
}

// ── The hook — loading policy (2.5s active-gated, refreshPins rules) ─────────

export const PAGE_POLL_MS = 2_500;

const THREAD_FILE_NAMES = ["page.json", "answers.json", "inbox.json", "retracted.json"] as const;

export type PageRead = {
  page: RenderedPage;
  /** Bumps when content actually changed — a render key for "new" chips. */
  revision: number;
  /** SWIT-78: re-read NOW (after an app write like a retraction) instead of
   *  waiting out the poll — the page still re-renders from the merged files,
   *  never from local hide state. A no-op while inactive or mid-read. */
  refresh: () => void;
};

/** Read + merge a thread's page, re-reading every PAGE_POLL_MS while
 *  `active`. Unchanged raw content is a NO-OP (no state write, no re-render);
 *  a failed read keeps the last good page — degraded, never blanked. */
export function usePage(threadId: string, active: boolean): PageRead {
  const [state, setState] = useState<Omit<PageRead, "refresh">>(() => ({
    page: mergePage(EMPTY_PAGE, {}, []),
    revision: 0,
  }));
  // The current poll's tick, for `refresh` — null while inactive.
  const tickRef = useRef<(() => Promise<void>) | null>(null);
  // The last raw content seen, concatenated — the no-op compare. A ref, not
  // state: it must not trigger renders and must be current inside the async
  // read callback.
  const lastRawRef = useRef<string | null>(null);
  // One read in flight at a time (a slow disk must not stack reads).
  const busyRef = useRef(false);

  useEffect(() => {
    // A different thread is a different document: blank the compare so the
    // first read always lands, and reset to the empty page so thread A's
    // content never paints under thread B's tab.
    lastRawRef.current = null;
    setState({ page: mergePage(EMPTY_PAGE, {}, []), revision: 0 });
  }, [threadId]);

  useEffect(() => {
    if (!active || threadId.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const [pageRaw, answersRaw, inboxRaw, retractedRaw] = await Promise.all(
          THREAD_FILE_NAMES.map((name) => readThreadFile(threadId, name))
        );
        if (cancelled) return;
        const combined = `${pageRaw} ${answersRaw} ${inboxRaw} ${retractedRaw}`;
        if (combined === lastRawRef.current) return; // unchanged — no re-render
        lastRawRef.current = combined;
        const page = mergePage(
          parsePageFile(pageRaw),
          parseAnswersFile(answersRaw),
          parseInboxFile(inboxRaw),
          parseRetractedFile(retractedRaw)
        );
        setState((prev) => ({ page, revision: prev.revision + 1 }));
      } catch {
        // Keep the last good page. The read failing is a backend hiccup, not
        // a reason to blank a document that was on screen.
      } finally {
        busyRef.current = false;
      }
    };
    tickRef.current = tick;
    void tick();
    const id = window.setInterval(() => void tick(), PAGE_POLL_MS);
    return () => {
      cancelled = true;
      tickRef.current = null;
      window.clearInterval(id);
    };
  }, [threadId, active]);

  const refresh = useCallback(() => {
    void tickRef.current?.();
  }, []);

  return { ...state, refresh };
}

// ── Page focus requests (SWIT-79 — the turn-end rule) ────────────────────────
// "Open questions → the page's decisions block, in front." App raises the
// request when a turn settles; the PageView showing that thread takes it and
// scrolls its block into view. Observable the way reportStore's anchor
// one-shot is: each request bumps a nonce + notifies, so an already-open page
// consumes a fresh request now, not on some later re-render. One pending
// request per thread; a page that is not mounted takes it when it next is.

export type PageFocusTarget = "decisions";

let pendingFocus = new Map<string, PageFocusTarget>();
let focusNonce = 0;
const focusListeners = new Set<() => void>();

export function requestPageFocus(threadId: string, target: PageFocusTarget): void {
  pendingFocus = new Map(pendingFocus);
  pendingFocus.set(threadId, target);
  focusNonce += 1;
  for (const listener of focusListeners) listener();
}

/** Subscribe to focus REQUESTS (useSyncExternalStore's subscribe half). */
export function subscribePageFocus(listener: () => void): () => void {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

/** The request counter (useSyncExternalStore's snapshot half). */
export function pageFocusNonce(): number {
  return focusNonce;
}

/** Read the pending request for one thread WITHOUT taking it — the page
 *  peeks until the block it would scroll to is actually mounted (a page that
 *  was not the active tab mounts empty at revision 0), then takes. */
export function peekPageFocus(threadId: string): PageFocusTarget | null {
  return pendingFocus.get(threadId) ?? null;
}

/** Take (and clear) the pending request for one thread. */
export function takePageFocus(threadId: string): PageFocusTarget | null {
  const target = pendingFocus.get(threadId);
  if (target === undefined) return null;
  pendingFocus = new Map(pendingFocus);
  pendingFocus.delete(threadId);
  return target;
}

/** Tests: forget every request. */
export function __resetPageFocusForTests(): void {
  pendingFocus = new Map();
  focusNonce = 0;
  focusListeners.clear();
}
