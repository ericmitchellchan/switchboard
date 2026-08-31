// THE ✦ PAGE's data layer (SWIT-48) — one living page per thread, rendered
// as a MERGE of three per-thread files with ONE WRITER EACH:
//
//   page.json    ← the agent, through the MCP server (SWIT-49). Theme, turns,
//                  evidence rows, questions, to-do items.
//   answers.json ← the app (SWIT-51): Eric's answers, joined to questions by
//                  id at render time — page.json is never touched.
//   inbox.json   ← the app (SWIT-52): cross-thread posts, folded under Needs
//                  You / What Happened with their origin.
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

import { useEffect, useRef, useState } from "react";
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

// ── File shapes ──────────────────────────────────────────────────────────────

export type PageTurn = { at: string; lines: string[] };
export type PageEvidence = {
  /** The dedupe key and the link — `SWIT-43`, `switchboard #61`, a path. */
  address: string;
  label: string;
  status: string | null;
  updatedAt: string;
};
export type PageQuestion = {
  id: string;
  text: string;
  options: string[];
  askedAt: string;
};
export type PageItemOwner = "agent" | "user" | "team";
export type PageItemState = "todo" | "in_progress" | "waiting" | "done";
export type PageItem = {
  id: string;
  title: string;
  owner: PageItemOwner;
  state: PageItemState;
  note: string | null;
};

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

/** answers.json — question id → Eric's answer. */
export type PageAnswer = { text: string; at: string };
export type AnswersFile = Record<string, PageAnswer>;

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
      turns.push({ at: str(t.at) ?? "", lines });
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
      questions.push({
        id,
        text,
        options: Array.isArray(q.options)
          ? q.options.filter((o): o is string => typeof o === "string" && o.length > 0)
          : [],
        askedAt: str(q.askedAt) ?? "",
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
        i.state === "in_progress" || i.state === "waiting" || i.state === "done"
          ? i.state
          : "todo";
      items.push({ id, title, owner, state, note: str(i.note) });
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
    out[id] = { text, at: str(v.at) ?? "" };
  }
  return out;
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

// ── The merge (pure) ─────────────────────────────────────────────────────────

export type AnsweredQuestion = { question: PageQuestion; answer: PageAnswer };

/** What PageView renders — the three files folded into R2's section order. */
export type RenderedPage = {
  theme: string | null;
  /** NEEDS YOU, in rail order: open questions first, then requests from other
   *  threads, then to-do items owned by the user. */
  openQuestions: PageQuestion[];
  requests: InboxPost[];
  userItems: PageItem[];
  /** TO DO — every open (non-done) item, page order. */
  openItems: PageItem[];
  /** WHAT HAPPENED — the latest turn; earlier ones folded behind a count.
   *  Cross-thread updates ride here too, tagged with their origin. */
  latestTurn: PageTurn | null;
  earlierTurns: PageTurn[];
  updates: InboxPost[];
  evidence: PageEvidence[];
  /** QUESTIONS — answered ones, answer joined by id. */
  answeredQuestions: AnsweredQuestion[];
  /** DONE — folded past DONE_FOLD. */
  doneItems: PageItem[];
  doneFolded: number;
  /** Nothing anywhere — the agent has not written yet. */
  isEmpty: boolean;
};

export function mergePage(page: PageFile, answers: AnswersFile, inbox: InboxPost[]): RenderedPage {
  const openQuestions = page.questions.filter((q) => !(q.id in answers));
  const answeredQuestions: AnsweredQuestion[] = page.questions
    .filter((q) => q.id in answers)
    .map((q) => ({ question: q, answer: answers[q.id] }));
  const openItems = page.items.filter((i) => i.state !== "done");
  const doneAll = page.items.filter((i) => i.state === "done");
  const doneItems = doneAll.slice(0, DONE_FOLD);
  const requests = inbox.filter((p) => p.kind === "request");
  const updates = inbox.filter((p) => p.kind === "update");
  const merged: RenderedPage = {
    theme: page.theme,
    openQuestions,
    requests,
    userItems: openItems.filter((i) => i.owner === "user"),
    openItems,
    latestTurn: page.turns[0] ?? null,
    earlierTurns: page.turns.slice(1),
    updates,
    evidence: page.evidence,
    answeredQuestions,
    doneItems,
    doneFolded: Math.max(0, doneAll.length - DONE_FOLD),
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

// ── The hook — loading policy (2.5s active-gated, refreshPins rules) ─────────

export const PAGE_POLL_MS = 2_500;

const THREAD_FILE_NAMES = ["page.json", "answers.json", "inbox.json"] as const;

export type PageRead = {
  page: RenderedPage;
  /** Bumps when content actually changed — a render key for "new" chips. */
  revision: number;
};

/** Read + merge a thread's page, re-reading every PAGE_POLL_MS while
 *  `active`. Unchanged raw content is a NO-OP (no state write, no re-render);
 *  a failed read keeps the last good page — degraded, never blanked. */
export function usePage(threadId: string, active: boolean): PageRead {
  const [state, setState] = useState<PageRead>(() => ({
    page: mergePage(EMPTY_PAGE, {}, []),
    revision: 0,
  }));
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
        const [pageRaw, answersRaw, inboxRaw] = await Promise.all(
          THREAD_FILE_NAMES.map((name) => readThreadFile(threadId, name))
        );
        if (cancelled) return;
        const combined = `${pageRaw} ${answersRaw} ${inboxRaw}`;
        if (combined === lastRawRef.current) return; // unchanged — no re-render
        lastRawRef.current = combined;
        const page = mergePage(
          parsePageFile(pageRaw),
          parseAnswersFile(answersRaw),
          parseInboxFile(inboxRaw)
        );
        setState((prev) => ({ page, revision: prev.revision + 1 }));
      } catch {
        // Keep the last good page. The read failing is a backend hiccup, not
        // a reason to blank a document that was on screen.
      } finally {
        busyRef.current = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), PAGE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [threadId, active]);

  return state;
}
