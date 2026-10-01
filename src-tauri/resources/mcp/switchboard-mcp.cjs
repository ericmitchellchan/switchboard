#!/usr/bin/env node
// SWITCHBOARD'S OWN MCP SERVER (SWIT-49) — the agent's typed write channel
// into the app (R7). Spawned BY claude over stdio via the per-spawn
// `--mcp-config` file Switchboard generates; it dies with the conversation.
//
// DEPENDENCY-FREE ON PURPOSE. The architecture note planned an esbuild bundle
// of the MCP SDK; a tools-only stdio server is ~a page of newline-delimited
// JSON-RPC, and zero dependencies means zero bundling, zero node_modules and
// one file shipped as a plain Tauri resource. Runs on any Node ≥ 18.
//
// ONE WRITER, ONE FILE: this process is the SOLE writer of its thread's
// page.json (its brief — SWIT-104 — and findings ledger — SWIT-106 —
// included; and of views/, sets.json and — SWIT-102 — shows.json beside
// it), and (SWIT-64) ONE OF MANY APPENDERS to the app-wide
// backlog-inbox.json — an append-only NDJSON file with one taker (the app),
// never of backlog.json, which the app alone rewrites after draining the
// inbox (the app writes answers.json / inbox.json / retracted.json — this
// process only READS answers.json and, since SWIT-105, retracted.json's
// `question:<id>` dismissals — and, since SWIT-108, for `page read` in a
// lane thread, threads.json plus the lane's other threads' page / answers /
// retracted files and the project's report index, all READ-only; the
// rendered page is
// a merge — see src/lib/pageStore.ts, whose parser this file's shapes MUST
// round-trip through; the vitest suite asserts exactly that). Thread identity
// arrives by ENV (SWITCHBOARD_THREAD_DIR), so tools carry no thread-id param
// and Ky's thread-resolution fallback chain never exists here.
//
// The BEHAVIOURAL CONTRACT (R2 language rules, R3 tab rules) lives in the
// tool description below — tool descriptions travel over MCP with no
// shell-line length limit and refresh with every new session. A short spawn
// one-liner (agentContext.buildPageContractLine) points the agent at the tool.
//
// TESTABLE CORE: the pure half (parse + applyOp + caps) is exported via
// module.exports and unit-tested from vitest (createRequire); the stdio loop
// runs only under `require.main === module`.

"use strict";

const fs = require("fs");
const path = require("path");

// ── Caps — mirrored in src/lib/pageStore.ts; change one, change the other ────
const TURN_CAP = 30;
const TURN_LINE_CAP = 6;
const EVIDENCE_CAP = 60;
const QUESTION_CAP = 20; // OPEN questions — `ask` refuses a 21st (answered / dismissed ones do not count)
/** Review of c178f2f, #3: every question the page HOLDS — open, answered,
 *  settled, dismissed — up to this many. The app's parser keeps exactly as
 *  many (pageStore.QUESTION_KEEP_CAP), so nothing this server writes is ever
 *  dropped on the way in; before, the parser kept the newest 20 of ANY state,
 *  and with dismissals loosening the open cap an open question past the 20th
 *  vanished from the page, the rail and Home while `page read` listed it. A
 *  NEW question on a page already at this cap is refused (never an
 *  eviction: a decided question is a standing decision). */
const QUESTION_KEEP_CAP = 200;
const TEXT_CAP = 500; // any single text field — a page line is a sentence, not a document
const OPTION_CAP = 60; // an ask option is a short choice, not a paragraph (SWIT-69; a longer one is trimmed — SWIT-105)
/** SWIT-105: a dismissed question's address in the app's retracted.json —
 *  mirrors pageStore.QUESTION_ADDRESS_PREFIX. */
const QUESTION_ADDRESS_PREFIX = "question:";
const REVIEW_FIRST_CAP = 300; // a turn's reviewFirst is an ADDRESS, not prose (SWIT-67)
const WHY_CAP = 240; // an ask's `why` is ONE line on the recommendation (SWIT-77, Ky's cap)
/** SWIT-58: what an `ask` wants back. decision = a choice that shapes this
 *  work; convention = a standing rule (the app appends the answer to the
 *  design conventions file); info = a fact only the user knows. */
const QUESTION_KINDS = ["decision", "convention", "info"];
/** SWIT-77 (Ky's CC-691 rule, adapted): an item is one action and its
 *  subject; free-text notes under items were the main source of clutter, so
 *  the write path refuses them. Existing notes still render (the app's
 *  parser is tolerant); nothing new is written. */
const NO_NOTE =
  "page item: items carry no note — put status in the item's state and the story in a turn (op turn)";
/** SWIT-78 (Ky's CC-704): `drop_evidence` names at most this many rows at
 *  once — a correction, not a bulk wipe. */
const DROP_EVIDENCE_CAP = 20;
/** SWIT-78 (Ky's plan tool): the states an item may be SET to. `dropped` is
 *  reached only through itemOp drop — the distinction from close (done) is
 *  the point, so it is never a value you can slip into an update. */
const ITEM_STATES = ["todo", "in_progress", "waiting", "done"];
/** SWIT-104: THE STANDING BRIEF — where things stand, rewritten whole at
 *  every seam. `goal` is one sentence; the four lists are short lines. Caps
 *  mirrored in pageStore.ts (BRIEF_*). */
const BRIEF_GOAL_CAP = 300;
const BRIEF_LINE_CAP = 200;
const BRIEF_LINES_CAP = 6;
/** The brief's four lists, in the order the page draws them. */
const BRIEF_LISTS = ["established", "dead", "lead", "waiting"];
/** SWIT-104: `page read` answers with at most this many characters. Raised
 *  from 6000 (review of daaad36, #1): the BRIEF is never clipped in `read`
 *  (an obedient agent reads, then replaces the brief WHOLE — a clipped read
 *  would truncate it for good), and the brief at its caps is ~5.5k on its
 *  own; 8000 leaves every section header its room at the tightest level. */
const READ_CAP = 8000;
/** SWIT-106: THE FINDINGS LEDGER — claim · verdict · n · report. The verdict
 *  words are the one-platform mock's (lead · open · fact · dead). Caps
 *  mirrored in pageStore.ts (FINDING_*). */
const FINDING_VERDICTS = ["lead", "open", "fact", "dead"];
const FINDING_CAP = 60;
const FINDING_CLAIM_CAP = 240;
const FINDING_N_CAP = 40;
const FINDING_REPORT_CAP = 300; // an address, like reviewFirst / show
/** The retired evidence form an older thread used for a finding — still
 *  rendered, never written again (op finding is the way). */
const FINDING_ADDRESS_PREFIX = "finding:";
/** SWIT-108: LANES — a named body of work inside one registry project. The
 *  name rule mirrors src/lib/lanes.ts (LANE_NAME_MAX / LANE_NAME_RE) — change
 *  one, change the other. The charset avoids everything the typed-line
 *  sanitizer strips, because the name rides on the launch line. */
const LANE_NAME_CAP = 48;
const LANE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.,&+'()\/:#-]*$/u;
/** `page read`'s lane roll-up reads at most this many of the lane's threads
 *  (this one + the most recently active others) — bounded work per read. */
const LANE_READ_THREADS = 24;

// ── Pure core ────────────────────────────────────────────────────────────────

/** Tolerant read of the current page.json content (mirrors pageStore's
 *  posture: junk degrades to the empty page — the agent's next write heals). */
function parsePage(raw) {
  const empty = { theme: null, turns: [], evidence: [], questions: [], items: [] };
  if (typeof raw !== "string" || raw.trim().length === 0) return empty;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return empty;
  const page = {
    theme: typeof data.theme === "string" && data.theme.length > 0 ? data.theme : null,
    turns: Array.isArray(data.turns) ? data.turns : [],
    evidence: Array.isArray(data.evidence) ? data.evidence : [],
    questions: Array.isArray(data.questions) ? data.questions : [],
    items: Array.isArray(data.items) ? data.items : [],
  };
  // SWIT-104: the brief rides through every other op untouched. The key
  // exists only while there is one, so a page with no brief serializes as it
  // always did.
  if (typeof data.brief === "object" && data.brief !== null && !Array.isArray(data.brief)) {
    page.brief = data.brief;
  }
  // SWIT-106: the findings ledger, the same way — present only while it
  // holds something.
  if (Array.isArray(data.findings) && data.findings.length > 0) page.findings = data.findings;
  // SWIT-108: the lane the agent asked for (op lane) — carried the same way.
  if (typeof data.lane === "string" && data.lane.length > 0) page.lane = data.lane;
  return page;
}

/** SWIT-108: THE LANE NAME RULE (lanes.normalizeLaneName's mirror): NFC,
 *  whitespace folded, trimmed, 1..LANE_NAME_CAP code points, the charset.
 *  Throws a visible OpError. Pure. */
function normalizeLaneName(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new OpError('name must be the lane name — a few words, e.g. "Gamma model"');
  }
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (Array.from(name).length > LANE_NAME_CAP) {
    throw new OpError(`name is too long (the cap is ${LANE_NAME_CAP} characters) — a lane name is a few words`);
  }
  if (!LANE_NAME_RE.test(name)) {
    throw new OpError("name must start with a letter or digit and hold letters, digits, spaces and - _ . , & + ' ( ) / : # only");
  }
  return name;
}

/** Two spellings that differ only in case or spacing are one lane. */
function laneNameKey(name) {
  return String(name).normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** A thread record's lane (threads.json, the APP's file — read-only here):
 *  {name, project, setBy}, or null. Both fields must be there. */
function recordLane(t) {
  return t && typeof t.lane === "string" && t.lane.length > 0 && typeof t.laneProject === "string" && t.laneProject.length > 0
    ? { name: t.lane, project: t.laneProject, setBy: t.laneSetBy === "agent" ? "agent" : "user" }
    : null;
}

class OpError extends Error {}

function text(v, field) {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new OpError(`${field} must be a non-empty string`);
  }
  const t = v.trim();
  if (t.length > TEXT_CAP) {
    throw new OpError(`${field} is too long (${t.length} chars; the cap is ${TEXT_CAP} — detail belongs in evidence rows, tickets or files, not page prose)`);
  }
  return t;
}

/** SWIT-105: an `ask` option (or its `default`) over OPTION_CAP is cut at a
 *  word boundary and ends in `…` — never longer than the cap, never a halved
 *  surrogate pair. A short one passes through untouched. Pure. */
/** Review of c178f2f, #6: the cut works on GRAPHEMES (Intl.Segmenter — in
 *  every Node this server runs on), never code units, so a flag's second
 *  regional indicator, a ZWJ sequence's tail or a combining mark is never
 *  orphaned from its base. The cap is still OPTION_CAP code units (what the
 *  page measures); the `…` takes the last one. */
const GRAPHEMES = typeof Intl === "object" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
function graphemesOf(t) {
  return GRAPHEMES ? Array.from(GRAPHEMES.segment(t), (g) => g.segment) : Array.from(t);
}

function trimOption(opt) {
  if (opt.length <= OPTION_CAP) return opt;
  const parts = graphemesOf(opt);
  let head = "";
  let n = 0;
  while (n < parts.length && head.length + parts[n].length <= OPTION_CAP - 1) {
    head += parts[n];
    n += 1;
  }
  // A cut that lands on a whole word (the next grapheme is a space) keeps
  // it; otherwise back up to the last space, when there is one past halfway.
  if (parts[n] !== " ") {
    const space = head.lastIndexOf(" ");
    if (space >= OPTION_CAP / 2) head = head.slice(0, space);
  }
  return `${head.replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/** SWIT-105: the ids of the questions the USER DISMISSED as not needed — a
 *  `question:<id>` entry in the app's retracted.json (READ-only here) that is
 *  not older than the ask; a re-ask stamps a newer askedAt and the question
 *  is back. Mirrors pageStore.questionDismissedAt (whole seconds; an
 *  unparseable stamp stays dismissed). `retracted` = the file as parsed JSON.
 *  Pure. */
function dismissedQuestionIds(page, retracted) {
  const list =
    retracted && Array.isArray(retracted.evidence) ? retracted.evidence : Array.isArray(retracted) ? retracted : [];
  const dismissedAt = new Map();
  for (const r of list) {
    if (!r || typeof r.address !== "string" || !r.address.startsWith(QUESTION_ADDRESS_PREFIX)) continue;
    const id = r.address.slice(QUESTION_ADDRESS_PREFIX.length);
    if (!dismissedAt.has(id)) dismissedAt.set(id, typeof r.at === "string" ? r.at : "");
  }
  const out = new Set();
  if (dismissedAt.size === 0) return out;
  for (const q of page.questions) {
    if (!q || typeof q.id !== "string" || !dismissedAt.has(q.id)) continue;
    const asked = Date.parse(q.askedAt);
    const gone = Date.parse(dismissedAt.get(q.id));
    if (!Number.isFinite(asked) || !Number.isFinite(gone) || Math.floor(asked / 1000) <= Math.floor(gone / 1000)) {
      out.add(q.id);
    }
  }
  return out;
}

/** One of the brief's lists (SWIT-104): absent → []; a bare string is one
 *  line; blank lines drop; more than the cap, or a line over its cap, is a
 *  VISIBLE error — the brief is a summary, and a silently cut line would be
 *  a fact the user never sees. Pure; throws OpError. */
function briefLines(v, field) {
  if (v === undefined || v === null) return [];
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list) || list.some((l) => typeof l !== "string")) {
    throw new OpError(`${field} must be an array of short plain lines`);
  }
  const lines = list.map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length > BRIEF_LINES_CAP) {
    throw new OpError(`${field} has ${lines.length} lines; the cap is ${BRIEF_LINES_CAP} — the brief is a summary: fold lines together or drop the ones that no longer matter`);
  }
  for (const l of lines) {
    if (l.length > BRIEF_LINE_CAP) {
      throw new OpError(`a line in ${field} is too long (${l.length} chars; the cap is ${BRIEF_LINE_CAP}) — one short line each; detail belongs in a report or an evidence row`);
    }
  }
  return lines;
}

function nextId(list, prefix) {
  let n = 0;
  for (const entry of list) {
    // Null-guarded (review): parsePage passes these arrays through
    // unvalidated, so a hand-corrupted page.json can hold nulls — minting an
    // id must survive them or `ask`/`item add` break for the whole session.
    const m =
      entry && typeof entry.id === "string" && entry.id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `${prefix}${n + 1}`;
}

/** Apply ONE page op. Returns { page, message } (message = what to tell the
 *  agent, including enforced-cap notes); throws OpError on invalid input —
 *  visible to the agent, never a silent drop. Pure: `now` injected;
 *  `answeredIds` = question ids the app has recorded answers for (read from
 *  answers.json — READ-only, so one-writer-per-file holds), so the question
 *  cap counts OPEN questions rather than every question ever asked (review:
 *  a lifetime cap would refuse forever with advice that cannot unblock it). */
function applyOp(page, args, now, answeredIds = new Set(), dismissedIds = new Set(), laneCtx = null) {
  const at = new Date(now).toISOString();
  const op = args && args.op;
  // SWIT-77: a question is SETTLED by the user's answer (answers.json, the
  // app's file, read-only here) OR by the agent's own `resolve` (answeredAt
  // on the question in this file). Both close it for the cap and for the
  // re-ask refusal.
  const settled = (q) =>
    !!q && (answeredIds.has(q.id) || (typeof q.answeredAt === "string" && q.answeredAt.length > 0));
  // SWIT-105: a question the user DISMISSED as not needed (`dismissedIds`,
  // from the app's retracted.json — read-only here) is not settled — it can
  // be re-asked, which brings it back — but it is not open either: it is off
  // the page, so it does not count against the cap.
  const isOpen = (q) => !!q && !settled(q) && !dismissedIds.has(q.id);
  switch (op) {
    case "theme": {
      const t = text(args.text, "text");
      return { page: { ...page, theme: t }, message: "Theme set." };
    }
    case "turn": {
      if (!Array.isArray(args.lines) || args.lines.length === 0) {
        throw new OpError("lines must be a non-empty array of plain sentences (2–5 of them)");
      }
      const lines = args.lines
        .filter((l) => typeof l === "string" && l.trim().length > 0)
        .map((l) => text(l, "a turn line"));
      if (lines.length === 0) throw new OpError("every line was empty");
      const kept = lines.slice(0, TURN_LINE_CAP);
      // SWIT-67: `reviewFirst` — the ONE address to look at first when the
      // turn opened or produced more than one thing. Validated like an
      // evidence address (a short non-empty string); rendered by the page as
      // `start here →` under the summary.
      let reviewFirst;
      if (args.reviewFirst !== undefined && args.reviewFirst !== null) {
        reviewFirst = text(args.reviewFirst, "reviewFirst");
        if (reviewFirst.length > REVIEW_FIRST_CAP) {
          throw new OpError(`reviewFirst is too long (${reviewFirst.length} chars; the cap is ${REVIEW_FIRST_CAP}) — it is an address (a ticket key, a path, surface:<project>/<page>, view:<id>), not prose`);
        }
      }
      const turn = reviewFirst ? { at, lines: kept, reviewFirst } : { at, lines: kept };
      const turns = [turn, ...page.turns].slice(0, TURN_CAP);
      const note =
        lines.length > TURN_LINE_CAP
          ? ` Kept the first ${TURN_LINE_CAP} lines — a turn is 2–5 plain lines; put detail in evidence rows.`
          : "";
      return { page: { ...page, turns }, message: `Turn recorded.${note}` };
    }
    case "evidence": {
      const address = text(args.address, "address");
      // SWIT-106: a finding is a ledger row with a verdict now, not an
      // evidence row — rows an older thread wrote in this form still render.
      if (address.startsWith(FINDING_ADDRESS_PREFIX)) {
        // Review of 4f016e1, #4: live threads still carry rows in this form —
        // say how to clear the old one once the finding is in the ledger.
        throw new OpError(
          `a finding is not an evidence row — record it with op finding {claim, verdict, n?, report?} (the page's Findings ledger), ` +
            `then remove the old row with op drop_evidence {addresses: [${JSON.stringify(address)}]} so the claim is not listed twice`
        );
      }
      const label = text(args.label, "label");
      const status =
        typeof args.status === "string" && args.status.trim().length > 0
          ? text(args.status, "status")
          : null;
      const existing = page.evidence.find((e) => e && e.address === address);
      const row = {
        address,
        label,
        // Omitting status KEEPS the previous one (Ky's rule): a label refresh
        // must not erase "merged".
        status: status !== null ? status : existing ? existing.status ?? null : null,
        updatedAt: at,
      };
      const rest = page.evidence.filter((e) => !e || e.address !== address);
      const evidence = [row, ...rest].slice(0, EVIDENCE_CAP);
      return {
        page: { ...page, evidence },
        message: existing ? `Evidence row ${address} updated.` : `Evidence row ${address} added.`,
      };
    }
    case "drop_evidence": {
      // SWIT-78 (Ky's CC-704): take rows written against the wrong thing BACK
      // instead of stacking a "superseded" row on them. This file is ours, so
      // the rows simply go; unknown addresses are ignored (the page may have
      // moved) and the count says what actually happened.
      if (!Array.isArray(args.addresses) || args.addresses.length === 0) {
        throw new OpError("addresses must be a non-empty array of evidence addresses (each row's address says which to remove)");
      }
      if (args.addresses.length > DROP_EVIDENCE_CAP) {
        throw new OpError(`drop_evidence takes at most ${DROP_EVIDENCE_CAP} addresses at once (${args.addresses.length} given)`);
      }
      const targets = new Set(args.addresses.map((a) => text(a, "an address")));
      const evidence = page.evidence.filter((e) => !e || !targets.has(e.address));
      const dropped = page.evidence.length - evidence.length;
      return {
        page: { ...page, evidence },
        message:
          dropped === 0
            ? "Dropped 0 evidence rows — none of those addresses are on the page."
            : `Dropped ${dropped} evidence row${dropped === 1 ? "" : "s"}.`,
      };
    }
    case "ask": {
      const t = text(args.text, "text");
      // SWIT-69: an option is a SHORT choice — long ones wrap into paragraphs
      // the multiple-choice list cannot carry. SWIT-105: a long one is
      // TRIMMED (at a word boundary, with `…`), not refused — the refusal
      // cost a whole round trip for a choice that read fine cut — and the
      // result names what was cut.
      const trimmed = [];
      // The options as the agent WROTE them, before any cut — a `default`
      // names one of these (review of c178f2f, #6).
      const fullOptions = Array.isArray(args.options)
        ? args.options
            .filter((o) => typeof o === "string" && o.trim().length > 0)
            .slice(0, 6)
            .map((o) => text(o, "an option"))
        : [];
      const options = fullOptions.map((opt) => {
        const short = trimOption(opt);
        if (short !== opt) trimmed.push(short);
        return short;
      });
      if (trimmed.length > 0 && new Set(options).size !== options.length) {
        throw new OpError(`two options read the same once trimmed to ${OPTION_CAP} chars (${trimmed.map((o) => `"${o}"`).join(", ")}) — shorten them so they differ`);
      }
      const trimNote =
        trimmed.length > 0
          ? ` Trimmed ${trimmed.length} option${trimmed.length === 1 ? "" : "s"} to ${OPTION_CAP} chars: ${trimmed.map((o) => `"${o}"`).join(", ")} — keep options short; detail belongs in the question text.`
          : "";
      // SWIT-58 — a question says WHAT KIND of answer it wants and PROPOSES
      // one. `kind` defaults to decision (the common case); `default` must be
      // one of the options, so the proposal is a real choice the UI can list
      // first, never free text the user has to re-type.
      const kind =
        args.kind === undefined || args.kind === null ? "decision" : args.kind;
      if (!QUESTION_KINDS.includes(kind)) {
        throw new OpError(`kind must be one of ${QUESTION_KINDS.join(", ")}`);
      }
      let dflt = null;
      if (args.default !== undefined && args.default !== null) {
        if (typeof args.default !== "string" || args.default.trim().length === 0) {
          throw new OpError("default must be one of the options (a non-empty string)");
        }
        // SWIT-105 / review of c178f2f, #6: the default is matched against the
        // UNTRIMMED options first (two long options can share their first ~57
        // chars, and trimming the default before matching accepted one that
        // named a different option), then mapped to that option's trimmed
        // form; naming the trimmed form itself also works.
        const want = args.default.trim();
        const at = fullOptions.indexOf(want);
        dflt = at !== -1 ? options[at] : options.includes(want) ? want : null;
        if (dflt === null) {
          throw new OpError(`default must be one of the options (${options.length === 0 ? "none were given" : options.map((o) => `"${o}"`).join(", ")})`);
        }
      }
      // SWIT-77 (Ky's `why`): ONE line on why the recommendation is the one —
      // the page prints `Recommended: <option> — <why>` above the options.
      let why = null;
      if (args.why !== undefined && args.why !== null) {
        why = text(args.why, "why");
        if (why.length > WHY_CAP) {
          throw new OpError(`why is too long (${why.length} chars; the cap is ${WHY_CAP}) — one line on the recommendation, not the reasoning`);
        }
      }
      const id = typeof args.id === "string" && args.id.trim().length > 0
        ? args.id.trim()
        : nextId(page.questions, "q");
      const existingIndex = page.questions.findIndex((q) => q && q.id === id);
      const asked = { id, text: t, options, askedAt: at, kind, default: dflt, why };
      const arrives =
        `Their answers arrive as ONE message — "Decisions:" numbering every open question with its answer or "still open" — when they send; it also becomes evidence row decision:${id}.`;
      if (existingIndex >= 0) {
        // SWIT-67 (supersede): re-asking an OPEN id REPLACES the question in
        // place — the older text is superseded, no duplicate row. A SETTLED
        // id refuses: the decision already exists.
        if (settled(page.questions[existingIndex])) {
          throw new OpError(`question ${id} was already settled — its answer is evidence row decision:${id}; reuse it instead of re-asking`);
        }
        const questions = page.questions.map((q, i) => (i === existingIndex ? asked : q));
        // SWIT-105: re-asking an id the user DISMISSED brings it back (the
        // new askedAt is newer than the dismissal) — say that it had been.
        const back = dismissedIds.has(id)
          ? `Question ${id} is back on the page — the user had dismissed it as not needed, so it should be here only because the answer now matters.`
          : `Question ${id} replaced on the page (superseded).`;
        return {
          page: { ...page, questions },
          message: `${back} ${arrives}${trimNote}`,
        };
      }
      const open = page.questions.filter(isOpen).length;
      if (open >= QUESTION_CAP) {
        throw new OpError(`${QUESTION_CAP} questions are already OPEN on the page — wait for answers before asking more`);
      }
      if (page.questions.length >= QUESTION_KEEP_CAP) {
        throw new OpError(
          `the page already holds ${QUESTION_KEEP_CAP} questions, the most it keeps — its decisions stand; re-ask an existing id instead of a new one`
        );
      }
      const questions = [asked, ...page.questions];
      return {
        page: { ...page, questions },
        message: `Question ${id} recorded on the page. ${arrives} Do not ask it again.${trimNote}`,
      };
    }
    case "resolve": {
      // SWIT-77 (Ky's CC-705): the agent SETTLES a question the user did not
      // answer on the page — answered in chat, decided elsewhere, moot. The
      // answer and the stamp land on the question itself (this file); the
      // page renders it under Decided as `settled: <answer>`.
      const id = text(args.id, "id");
      const answer = text(args.answer, "answer");
      const index = page.questions.findIndex((q) => q && q.id === id);
      if (index < 0) throw new OpError(`no question with id ${id} — the page lists the open ones`);
      if (answeredIds.has(id)) {
        throw new OpError(`question ${id} was answered by the user — their answer is evidence row decision:${id}; nothing to resolve`);
      }
      const questions = page.questions.map((q, i) =>
        i === index ? { ...q, answer, answeredAt: at, resolvedBy: "agent" } : q
      );
      const stillOpen = questions.filter(isOpen).length;
      return {
        page: { ...page, questions },
        message: `Question ${id} resolved (evidence row decision:${id}, status settled). ${stillOpen} still open on the page.`,
      };
    }
    case "item": {
      const itemOp = args.itemOp;
      // SWIT-77: NO NOTES. Refused on add and update alike — a visible error
      // the agent can act on, never a silently dropped field.
      if (args.note !== undefined && args.note !== null) throw new OpError(NO_NOTE);
      if (itemOp === "add") {
        const title = text(args.title, "title");
        const owner = args.owner === "user" || args.owner === "team" ? args.owner : "agent";
        const state = ITEM_STATES.includes(args.state) ? args.state : "todo";
        const id = nextId(page.items, "i");
        const added = { id, title, owner, state, note: null };
        // An item ADDED as done left the live list at once — stamp it too.
        if (state === "done") added.closedAt = at;
        return {
          page: { ...page, items: [...page.items, added] },
          message: `Item ${id} added.`,
        };
      }
      if (itemOp === "update" || itemOp === "close" || itemOp === "drop") {
        const id = text(args.id, "id");
        const index = page.items.findIndex((i) => i && i.id === id);
        if (index < 0) throw new OpError(`no item with id ${id}`);
        const prev = page.items[index];
        const nextItem = { ...prev };
        if (itemOp === "close") {
          nextItem.state = "done";
        } else if (itemOp === "drop") {
          // SWIT-78 (Ky's plan tool): close = the work happened; drop = the
          // row was never the right row. Both leave the live list; the page
          // files a dropped row under its own collapsed disclosure, never
          // under Done.
          nextItem.state = "dropped";
        } else {
          if (typeof args.title === "string") nextItem.title = text(args.title, "title");
          if (args.owner === "agent" || args.owner === "user" || args.owner === "team") {
            nextItem.owner = args.owner;
          }
          if (ITEM_STATES.includes(args.state)) nextItem.state = args.state;
        }
        // SWIT-78: `closedAt` marks WHEN an item left the live list (done OR
        // dropped) and goes away when it is reopened — one stamp, one meaning.
        const wasOpen = prev.state !== "done" && prev.state !== "dropped";
        const isOpen = nextItem.state !== "done" && nextItem.state !== "dropped";
        if (isOpen) delete nextItem.closedAt;
        else if (wasOpen || !nextItem.closedAt) nextItem.closedAt = at;
        const items = page.items.map((i, j) => (j === index ? nextItem : i));
        const verb = itemOp === "close" ? "closed" : itemOp === "drop" ? "dropped" : "updated";
        return {
          page: { ...page, items },
          message: `Item ${id} ${verb}.`,
        };
      }
      throw new OpError('itemOp must be "add", "update", "close" or "drop"');
    }
    case "brief": {
      // SWIT-104: THE STANDING BRIEF — where things stand, for a reader who
      // has been away for days. WHOLE-REPLACE: the agent rewrites it at every
      // seam, so a field left out is a field that no longer stands. Passing
      // only empty fields clears it.
      const given = (v) => v !== undefined && v !== null;
      if (!given(args.goal) && !BRIEF_LISTS.some((f) => given(args[f]))) {
        throw new OpError(
          `brief needs at least one of goal, ${BRIEF_LISTS.join(", ")} — and it is REPLACED whole, so pass everything that still stands`
        );
      }
      let goal = null;
      if (given(args.goal)) {
        if (typeof args.goal !== "string") throw new OpError("goal must be one sentence (a string)");
        const g = args.goal.trim();
        if (g.length > BRIEF_GOAL_CAP) {
          throw new OpError(`goal is too long (${g.length} chars; the cap is ${BRIEF_GOAL_CAP}) — one sentence on what this work is for`);
        }
        goal = g.length > 0 ? g : null;
      }
      const brief = { goal };
      for (const f of BRIEF_LISTS) brief[f] = briefLines(args[f], f);
      brief.updatedAt = at;
      // SWIT-108 review #1: the lane it is written FOR — only through
      // performOp, which reads the app's threads.json (`laneCtx.stamp`); a
      // direct applyOp (the tests) writes the pre-stamp form.
      if (laneCtx && laneCtx.stamp !== undefined) brief.lane = laneCtx.stamp;
      const had = typeof page.brief === "object" && page.brief !== null;
      if (goal === null && BRIEF_LISTS.every((f) => brief[f].length === 0)) {
        const { brief: _gone, ...rest } = page;
        return { page: rest, message: had ? "Brief cleared." : "Brief cleared — there was none." };
      }
      return {
        page: { ...page, brief },
        message: `${had ? "Brief rewritten" : "Brief written"} — it is the first block on the page. Rewrite it whole at the next seam.`,
      };
    }
    case "finding": {
      // SWIT-106 — THE FINDINGS LEDGER: what the work has established, one
      // row per claim, with a verdict, the sample it rests on and the report
      // behind it. Same id = the SAME row, updated in place (a claim moves
      // from open to lead to fact, it is not re-filed); findingOp drop
      // removes one.
      const findings = Array.isArray(page.findings) ? page.findings.filter((f) => f && typeof f.id === "string") : [];
      const withFindings = (list) => {
        if (list.length > 0) return { ...page, findings: list };
        const { findings: _gone, ...rest } = page;
        return rest;
      };
      if (args.findingOp !== undefined && args.findingOp !== null && args.findingOp !== "drop") {
        throw new OpError('findingOp must be "drop" (or omitted, to add or update)');
      }
      if (args.findingOp === "drop") {
        const id = text(args.id, "id");
        if (!findings.some((f) => f.id === id)) throw new OpError(`no finding with id ${id} — the page lists them (op read too)`);
        return { page: withFindings(findings.filter((f) => f.id !== id)), message: `Finding ${id} dropped.` };
      }
      const id = args.id === undefined || args.id === null ? null : text(args.id, "id");
      if (id !== null && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
        throw new OpError("id must be a short stable key (letters, digits, _ and -; ≤ 40) — or omit it and one is minted");
      }
      // SWIT-114: `user-` ids are the USER's findings (filed from a report,
      // in the app's findings.json) — read them, never write them.
      if (id !== null && id.startsWith(USER_FINDING_PREFIX)) {
        throw new OpError(
          `${id} is a finding the user filed — it is theirs; file your own (omit id, or another id) if the evidence has moved`
        );
      }
      const prev = id === null ? undefined : findings.find((f) => f.id === id);
      const given = (v) => v !== undefined && v !== null;
      // A new finding needs a claim and a verdict; an update keeps what it
      // does not name (Ky's evidence rule: omitting a field is not erasing it).
      if (!prev && !given(args.claim)) throw new OpError("claim is required — ONE sentence saying what was found");
      if (!prev && !given(args.verdict)) throw new OpError(`verdict is required — one of ${FINDING_VERDICTS.join(", ")}`);
      let claim = prev ? prev.claim : null;
      if (given(args.claim)) {
        claim = text(args.claim, "claim");
        if (claim.length > FINDING_CLAIM_CAP) {
          throw new OpError(`claim is too long (${claim.length} chars; the cap is ${FINDING_CLAIM_CAP}) — one sentence; the detail is the report`);
        }
      }
      let verdict = prev ? prev.verdict : null;
      if (given(args.verdict)) {
        if (!FINDING_VERDICTS.includes(args.verdict)) {
          throw new OpError(`verdict must be one of ${FINDING_VERDICTS.join(", ")} (lead = worth chasing; open = not settled; fact = established; dead = ruled out)`);
        }
        verdict = args.verdict;
      }
      // n and report: omitted keeps; "" or null CLEARS (the only way to take
      // a report off a finding).
      let n = prev && typeof prev.n === "string" ? prev.n : null;
      if (args.n !== undefined) {
        if (args.n === null || (typeof args.n === "string" && args.n.trim().length === 0)) n = null;
        else if (typeof args.n === "number" && Number.isFinite(args.n)) n = String(args.n);
        else if (typeof args.n === "string") n = args.n.trim();
        else throw new OpError("n must be a short string (\"264 nights\", \"10 tests\") or a number");
        if (n !== null && n.length > FINDING_N_CAP) {
          throw new OpError(`n is too long (${n.length} chars; the cap is ${FINDING_N_CAP}) — the sample size, e.g. "264 nights"`);
        }
      }
      let report = prev && typeof prev.report === "string" ? prev.report : null;
      if (args.report !== undefined) {
        if (args.report === null || (typeof args.report === "string" && args.report.trim().length === 0)) report = null;
        else {
          report = text(args.report, "report");
          if (report.length > FINDING_REPORT_CAP) {
            throw new OpError(`report is too long (${report.length} chars; the cap is ${FINDING_REPORT_CAP}) — it is an address (view:<id>, a doc or file path, surface:<project>/<page>), not prose`);
          }
        }
      }
      const row = { id: prev ? prev.id : id ?? nextId(findings, "f"), claim, verdict, n, report, updatedAt: at };
      if (prev) {
        return {
          page: withFindings(findings.map((f) => (f.id === prev.id ? row : f))),
          message: `Finding ${row.id} updated (${verdict}).`,
        };
      }
      if (findings.length >= FINDING_CAP) {
        throw new OpError(`${FINDING_CAP} findings are already on the page — drop the ones that no longer matter (findingOp drop) before adding more`);
      }
      return {
        page: withFindings([row, ...findings]),
        message: `Finding ${row.id} recorded (${verdict}) in the page's Findings ledger. Update it by id as the verdict moves; never file it twice.`,
      };
    }
    case "lane": {
      // SWIT-108 — THE AGENT'S ROUTE INTO A LANE. It writes `page.lane` (this
      // server's file); the APP copies it onto the thread record only when
      // the record has no lane (src/lib/lanes.ts laneFromPage — Eric's choice
      // wins). `laneCtx` is what threads.json (the app's file, read-only
      // here) and the registry say: the lane the thread is already in and
      // who set it, whether the user took it out of one, and whether its
      // folder belongs to a registry project (null = no registry to ask).
      const name = normalizeLaneName(args.name);
      const ctx = laneCtx || {};
      if (ctx.current) {
        if (laneNameKey(ctx.current.name) === laneNameKey(name)) {
          return { page, message: `This thread is already in the lane "${ctx.current.name}".` };
        }
        throw new OpError(
          `this thread is already in the lane "${ctx.current.name}"${ctx.current.setBy === "user" ? " (the user put it there)" : ""} — only the user moves a thread between lanes; ask them if it belongs elsewhere`
        );
      }
      if (ctx.userCleared) {
        throw new OpError("the user took this thread out of its lane — only the user puts it in one again; ask them");
      }
      if (ctx.projectKnown === false) {
        throw new OpError("this thread's working directory is in no registry project — a lane belongs to a project, so this thread cannot join one");
      }
      return {
        page: { ...page, lane: name },
        message:
          `Lane recorded — this thread joins the lane "${name}" of its project within a few seconds (Switchboard puts it there; a lane the user chose always wins). ` +
          "From then on op read returns the lane's roll-up too — its brief, findings, newest reports and the other threads' open questions — and your brief is the LANE's brief: write it for the whole lane.",
      };
    }
    case "show":
      // SWIT-102: `show` writes shows.json, never page.json — performOp routes
      // it to performShowOp before this function is reached.
      throw new OpError("show does not write the page — it is recorded in shows.json (performShowOp)");
    case "read":
      // SWIT-104: `read` writes nothing — performOp routes it to
      // performReadOp before this function is reached.
      throw new OpError("read does not write the page — it returns it (performReadOp)");
    default:
      throw new OpError('op must be one of "theme", "turn", "evidence", "drop_evidence", "ask", "resolve", "item", "brief", "finding", "lane", "show", "read"');
  }
}

// ── Read (SWIT-104) — the page, as compact plain text ────────────────────────
// `page` op `read` is how a RESUMED agent sees its own page: theme, the brief,
// the open questions (with ids), the open items, the standing decisions, the
// findings, the last three turns. It writes nothing. Bounded: every line
// OUTSIDE THE BRIEF is clipped and every list is cut (newest first, with a
// `+ N more` line) at one of a few progressively tighter levels until the
// whole text fits READ_CAP — the TURNS go first, then the decisions, the
// questions and the findings (review of daaad36, #1). THE BRIEF IS NEVER
// CLIPPED: the tool tells the agent to read first and replace the brief
// WHOLE, so a clipped brief in `read` would be written back clipped forever.

const READ_TURNS = 3;
const READ_LEVELS = [
  { clip: 240, turns: 3, decisions: 12, questions: 20, findings: 20, items: 30, ids: true },
  { clip: 140, turns: 1, decisions: 8, questions: 12, findings: 12, items: 16, ids: true },
  { clip: 80, turns: 0, decisions: 4, questions: 8, findings: 8, items: 10, ids: true },
  { clip: 50, turns: 0, decisions: 0, questions: 4, findings: 4, items: 6, ids: true },
  // The floor: headers and counts only — the brief and every section's
  // header always fit READ_CAP at this level (asserted at every cap).
  { clip: 50, turns: 0, decisions: 0, questions: 0, findings: 0, items: 0, ids: false },
];
/** The brief's lists as `read` names them to the AGENT (the page says
 *  "Waiting on you" to the user — the same list). */
const BRIEF_READ_LABELS = { established: "Established", dead: "Dead", lead: "Live lead", waiting: "Waiting on the user" };

function clipLine(v, n) {
  const t = String(v).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1)).trimEnd()}…` : t;
}

/** Newest first by an ISO stamp; an unparseable one sorts last. */
function newestFirstBy(list, stampOf) {
  const ms = (x) => {
    const t = Date.parse(stampOf(x));
    return Number.isFinite(t) ? t : -Infinity;
  };
  return [...list].sort((a, b) => ms(b) - ms(a));
}

function renderPageRead(page, answers, dismissedIds, lim) {
  const out = [];
  const more = (total, shown) => {
    if (total > shown) out.push(`  (+ ${total - shown} more — the page lists them)`);
  };
  out.push(`THEME: ${page.theme ? clipLine(page.theme, lim.clip) : "(none — set it once with op theme)"}`);

  out.push("");
  const b = page.brief;
  const briefLists = b ? BRIEF_LISTS.map((f) => [f, Array.isArray(b[f]) ? b[f].filter((l) => typeof l === "string" && l.trim().length > 0) : []]) : [];
  const goal = b && typeof b.goal === "string" && b.goal.trim().length > 0 ? b.goal : null;
  if (b && (goal !== null || briefLists.some(([, lines]) => lines.length > 0))) {
    out.push(`WHERE THINGS STAND (the brief${typeof b.updatedAt === "string" && b.updatedAt ? `, rewritten ${b.updatedAt}` : ""}):`);
    // Never clipped (see the header) — the stored text, verbatim (a line
    // break inside one, which the write path never stores, is flattened so
    // the listing stays one line per entry).
    const verbatim = (v) => String(v).replace(/[\r\n]+/g, " ").trim();
    if (goal !== null) out.push(`  Goal: ${verbatim(goal)}`);
    for (const [f, lines] of briefLists) {
      if (lines.length === 0) continue;
      out.push(`  ${BRIEF_READ_LABELS[f]}:`);
      for (const l of lines.slice(0, BRIEF_LINES_CAP)) out.push(`    - ${verbatim(l)}`);
    }
  } else {
    out.push("WHERE THINGS STAND: no brief yet — write one with op brief.");
  }

  const questions = page.questions.filter((q) => q && typeof q.id === "string" && typeof q.text === "string");
  const resolved = (q) => typeof q.answeredAt === "string" && q.answeredAt.length > 0 && typeof q.answer === "string";
  const answerOf = (q) => {
    const a = answers[q.id];
    return a && typeof a === "object" && typeof a.text === "string" && a.text.length > 0 ? a : null;
  };
  // An answer is the agent's to read once it was SENT (sentAt, not older
  // than the answer — pageStore.isAnswerUnsent's rule); until then the user
  // may still change it, so only the fact that it is coming is stated.
  const sent = (a) => typeof a.sentAt === "string" && a.sentAt.length > 0 && !(a.sentAt < String(a.at || ""));
  // SWIT-105: a question the user dismissed as not needed is off the page —
  // not open, not a decision; named by id so the agent knows not to wait.
  const dismissed = questions.filter((q) => !answerOf(q) && !resolved(q) && dismissedIds.has(q.id));
  const open = questions.filter((q) => !answerOf(q) && !resolved(q) && !dismissedIds.has(q.id));
  const pending = questions.filter((q) => answerOf(q) && !sent(answerOf(q)));
  out.push("");
  out.push(`OPEN QUESTIONS (${open.length}):`);
  for (const q of open.slice(0, lim.questions)) {
    const options = Array.isArray(q.options) ? q.options.filter((o) => typeof o === "string" && o.length > 0) : [];
    const kind = typeof q.kind === "string" ? q.kind : "decision";
    const tail =
      (options.length > 0 ? ` | options: ${clipLine(options.join(" / "), lim.clip)}` : "") +
      (typeof q.default === "string" && q.default.length > 0 ? ` | default: ${clipLine(q.default, 60)}` : "");
    out.push(`  ${q.id} [${kind}] ${clipLine(q.text, lim.clip)}${tail}`);
  }
  more(open.length, lim.questions);
  if (open.length === 0) out.push("  (none)");
  const idList = (qs) => (lim.ids ? ` (${qs.map((q) => q.id).join(", ")})` : "");
  if (pending.length > 0) {
    out.push(
      `  ${pending.length} more ${pending.length === 1 ? "is" : "are"} answered on the page and not sent yet${idList(pending)} — the answer arrives in the Decisions message; do not re-ask.`
    );
  }
  if (dismissed.length > 0) {
    out.push(
      `  ${dismissed.length} ${dismissed.length === 1 ? "was" : "were"} dismissed by the user as not needed${idList(dismissed)} — do not wait on ${dismissed.length === 1 ? "it" : "them"}; re-ask (same id) only if the answer has come to matter.`
    );
  }

  const items = page.items.filter((i) => i && typeof i.id === "string" && typeof i.title === "string");
  const openItems = items.filter((i) => i.state !== "done" && i.state !== "dropped").reverse();
  out.push("");
  out.push(`TO DO (${openItems.length} open):`);
  for (const i of openItems.slice(0, lim.items)) {
    const owner = i.owner === "user" ? "the user" : i.owner === "team" ? "team" : "you";
    out.push(`  ${i.id} [${typeof i.state === "string" ? i.state : "todo"}, ${owner}] ${clipLine(i.title, lim.clip)}`);
  }
  more(openItems.length, lim.items);
  if (openItems.length === 0) out.push("  (none)");

  // The user's answer wins the same id (the merge's precedence).
  const decisions = newestFirstBy(
    questions
      .map((q) => {
        const a = answerOf(q);
        if (a && sent(a)) return { q, answer: a.text, at: String(a.at || ""), by: "the user" };
        if (!a && resolved(q)) return { q, answer: q.answer, at: q.answeredAt, by: "settled by you" };
        return null;
      })
      .filter((d) => d !== null),
    (d) => d.at
  );
  out.push("");
  out.push(`STANDING DECISIONS (${decisions.length}):`);
  for (const d of decisions.slice(0, lim.decisions)) {
    out.push(`  decision:${d.q.id} ${clipLine(d.q.text, lim.clip)} → ${clipLine(d.answer, lim.clip)} (${d.by})`);
  }
  more(decisions.length, lim.decisions);
  if (decisions.length === 0) out.push("  (none)");

  // SWIT-106: the findings ledger, newest first by its last update.
  const findings = newestFirstBy(
    (Array.isArray(page.findings) ? page.findings : []).filter(
      (f) => f && typeof f.id === "string" && typeof f.claim === "string" && FINDING_VERDICTS.includes(f.verdict)
    ),
    (f) => f.updatedAt
  );
  out.push("");
  out.push(`FINDINGS (${findings.length}):`);
  for (const f of findings.slice(0, lim.findings)) {
    const tail =
      (typeof f.n === "string" && f.n.length > 0 ? ` | n: ${clipLine(f.n, FINDING_N_CAP)}` : "") +
      (typeof f.report === "string" && f.report.length > 0 ? ` | report: ${clipLine(f.report, lim.clip)}` : "");
    const who = f.by === "user" ? " (filed by the user)" : "";
    out.push(`  ${f.id} [${f.verdict}]${who} ${clipLine(f.claim, lim.clip)}${tail}`);
  }
  more(findings.length, lim.findings);
  if (findings.length === 0) out.push("  (none)");

  const turns = page.turns.filter((t) => t && Array.isArray(t.lines)).slice(0, Math.min(READ_TURNS, lim.turns));
  out.push("");
  out.push(`LAST TURNS (newest first, ${turns.length} of ${page.turns.length}):`);
  for (const t of turns) {
    const lines = t.lines.filter((l) => typeof l === "string" && l.trim().length > 0).slice(0, TURN_LINE_CAP);
    out.push(`  ${typeof t.at === "string" ? t.at : ""}: ${lines.map((l) => clipLine(l, lim.clip)).join(" | ")}`);
  }
  if (turns.length === 0) out.push(page.turns.length > 0 ? "  (cut — the page lists them)" : "  (none)");
  return out.join("\n");
}

/** THE READ FORMATTER. `page` = parsePage's shape (arrays unvalidated — every
 *  entry is guarded here); `answers` = answers.json and (SWIT-105)
 *  `retracted` = retracted.json, both as parsed JSON (the app's files,
 *  READ-only). Pure. Always ≤ READ_CAP characters. */
function formatPageRead(page, answers, retracted, lane = null) {
  const known = typeof answers === "object" && answers !== null && !Array.isArray(answers) ? answers : {};
  const dismissedIds = dismissedQuestionIds(page, retracted);
  if (!lane) return fitPageRead(page, known, dismissedIds, READ_CAP);
  // SWIT-108: a thread in a LANE reads the lane too — AFTER its own page,
  // inside the same READ_CAP. The lane's floor (headers + counts) is
  // reserved first, so this page keeps its level rules and its brief is
  // never clipped; the lane then takes what room is left, at the roomiest of
  // its own levels that fits.
  const floor = renderLaneRead(lane, LANE_READ_LEVELS[LANE_READ_LEVELS.length - 1]);
  const own = fitPageRead(page, known, dismissedIds, READ_CAP - floor.length - 2);
  const room = READ_CAP - own.length - 2;
  for (const lim of LANE_READ_LEVELS) {
    const text = renderLaneRead(lane, lim);
    if (text.length <= room) return `${own}\n\n${text}`;
  }
  return `${own}\n\n${floor.slice(0, Math.max(0, room))}`;
}

/** The page alone, at the first level that fits `cap`. */
function fitPageRead(page, known, dismissedIds, cap) {
  let text = "";
  for (const lim of READ_LEVELS) {
    text = renderPageRead(page, known, dismissedIds, lim);
    if (text.length <= cap) return text;
  }
  const cut = "\n… (cut — the page holds more)";
  return text.slice(0, cap - cut.length) + cut;
}

// ── The lane roll-up in `read` (SWIT-108) ────────────────────────────────────
// A thread in a lane starts from what the lane already knows (requirements
// §4.2): `read` appends the LANE — the lane's brief (the NEWEST brief among
// its threads, and which thread wrote it), the other threads' findings, the
// project reports built in the lane and the other threads' open questions.
// Everything is READ-only: threads.json (the app's), each sibling's
// page.json / answers.json / retracted.json and the project's report index.
// Bounded: at most LANE_READ_THREADS threads, and the text gives ground
// level by level inside what the page left of READ_CAP.

const LANE_READ_LEVELS = [
  { brief: Infinity, briefLines: BRIEF_LINES_CAP, findings: 20, reports: 10, questions: 12, threads: 12, clip: 200 },
  { brief: 160, briefLines: BRIEF_LINES_CAP, findings: 12, reports: 6, questions: 8, threads: 8, clip: 140 },
  { brief: 100, briefLines: 2, findings: 6, reports: 4, questions: 4, threads: 5, clip: 90 },
  { brief: 60, briefLines: 1, findings: 3, reports: 2, questions: 2, threads: 3, clip: 60 },
  // The floor: every header and its count; no rows, no brief text.
  { brief: 0, briefLines: 0, findings: 0, reports: 0, questions: 0, threads: 0, clip: 50 },
];

function renderLaneRead(lane, lim) {
  const out = [];
  const title = (t) => `"${clipLine(t || "untitled", 60)}"`;
  const more = (total, shown) => {
    if (total > shown) out.push(`  (+ ${total - shown} more — the lane page lists them)`);
  };
  const others = lane.threads.filter((t) => !t.self);
  out.push(
    `LANE: ${lane.name} (project ${lane.project}) — this thread and ${others.length} other${others.length === 1 ? "" : "s"}. Read it before asking the user for context; it is what the lane already knows.`
  );
  if (lim.threads > 0 && others.length > 0) {
    out.push(
      `  other threads: ${others
        .slice(0, lim.threads)
        .map((t) => `${title(t.title)}${t.archived ? " (archived)" : ""}`)
        .join(", ")}${others.length > lim.threads ? `, + ${others.length - lim.threads} more` : ""}`
    );
  }
  out.push("");
  const b = lane.brief;
  if (!b) {
    out.push("LANE BRIEF: none yet — no thread in the lane has written one. Write it (op brief) for the WHOLE lane at your first seam.");
  } else if (b.self) {
    out.push("LANE BRIEF: this page's brief (above) is the newest in the lane, so it IS the lane's brief — keep it written for the whole lane.");
  } else {
    out.push(
      `LANE BRIEF (the newest in the lane — thread ${title(b.threadTitle)}${b.deleted ? " (a deleted thread)" : ""}${b.brief.updatedAt ? `, rewritten ${b.brief.updatedAt}` : ""}; at your first seam rewrite it WHOLE with op brief, for the lane):`
    );
    if (lim.brief === 0) {
      out.push("  (cut — the room went to this page; the lane page shows it)");
    } else {
      const line = (v) => (lim.brief === Infinity ? String(v).replace(/[\r\n]+/g, " ").trim() : clipLine(v, lim.brief));
      if (typeof b.brief.goal === "string" && b.brief.goal.trim().length > 0) out.push(`  Goal: ${line(b.brief.goal)}`);
      for (const f of BRIEF_LISTS) {
        const lines = Array.isArray(b.brief[f]) ? b.brief[f].filter((l) => typeof l === "string" && l.trim().length > 0) : [];
        if (lines.length === 0) continue;
        out.push(`  ${BRIEF_READ_LABELS[f]}:`);
        for (const l of lines.slice(0, lim.briefLines)) out.push(`    - ${line(l)}`);
        if (lines.length > lim.briefLines) out.push(`    (+ ${lines.length - lim.briefLines} more)`);
      }
    }
  }

  out.push("");
  out.push(`LANE FINDINGS (${lane.findings.length}, from the other threads, newest first):`);
  for (const f of lane.findings.slice(0, lim.findings)) {
    const tail =
      (typeof f.finding.n === "string" && f.finding.n.length > 0 ? ` | n: ${clipLine(f.finding.n, FINDING_N_CAP)}` : "") +
      (typeof f.finding.report === "string" && f.finding.report.length > 0 ? ` | report: ${clipLine(f.finding.report, lim.clip)}` : "");
    const who = f.finding.by === "user" ? " (filed by the user)" : "";
    out.push(`  [${f.finding.verdict}]${who} ${clipLine(f.finding.claim, lim.clip)}${tail} — ${title(f.threadTitle)}`);
  }
  more(lane.findings.length, lim.findings);
  if (lane.findings.length === 0) out.push("  (none)");

  out.push("");
  if (lane.reports === null) {
    out.push("LANE REPORTS: not listed — the project registry could not be read from here.");
  } else {
    out.push(`LANE REPORTS (${lane.reports.length}, the project's reports built in this lane, newest first — op show opens one):`);
    for (const r of lane.reports.slice(0, lim.reports)) {
      out.push(`  ${projectViewAddress(lane.project, r.id)} ${clipLine(r.title || r.id, lim.clip)}${typeof r.builtAt === "string" && r.builtAt ? ` (built ${r.builtAt})` : ""}`);
    }
    more(lane.reports.length, lim.reports);
    if (lane.reports.length === 0) out.push("  (none)");
  }

  out.push("");
  out.push(`OTHER THREADS' OPEN QUESTIONS (${lane.questions.length} — answered on their own thread's page; do not re-ask them here):`);
  for (const q of lane.questions.slice(0, lim.questions)) {
    out.push(`  ${title(q.threadTitle)} ${q.id}: ${clipLine(q.text, lim.clip)}`);
  }
  more(lane.questions.length, lim.questions);
  if (lane.questions.length === 0) out.push("  (none)");
  return out.join("\n");
}

/** THE LANE ROLL-UP for `read`, or null when this thread is in no lane (or
 *  the app's files are not handed over). `env` = {threadsJsonPath,
 *  threadsRoot, selfThreadId, registryPath}. Never throws — a lane that
 *  cannot be read is simply not appended. */
function readLaneRollup(env) {
  try {
    if (!env || !env.threadsJsonPath || !env.threadsRoot || !env.selfThreadId) return null;
    const threads = readThreadsFile(env.threadsJsonPath);
    const self = threads.find((t) => t && t.id === env.selfThreadId);
    const lane = self ? recordLane(self) : null;
    if (!lane) return null;
    const key = laneNameKey(lane.name);
    // The lane's own record (threads.json's `lanes`, the app's): its former
    // names and its CACHED brief (review of ec319c7, #1, #5).
    const record = readLaneRecord(env.threadsJsonPath, lane);
    const aliasKeys = new Set([key, ...record.aliases.map(laneNameKey)]);
    const allIds = new Set(threads.filter((t) => t && typeof t.id === "string").map((t) => t.id));
    const members = threads.filter((t) => {
      const l = recordLane(t);
      return l !== null && l.project === lane.project && laneNameKey(l.name) === key;
    });
    const memberIds = new Set(members.map((t) => t.id));
    const others = members
      .filter((t) => t.id !== self.id)
      .sort((a, b) => (Number(b.lastActivityAt) || 0) - (Number(a.lastActivityAt) || 0))
      .slice(0, LANE_READ_THREADS - 1);
    const read = [self, ...others]
      .filter((t) => typeof t.id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(t.id))
      .map((t) => {
        const dir = path.join(env.threadsRoot, t.id);
        let raw = "";
        try {
          raw = fs.readFileSync(pagePathFor(dir), "utf-8");
        } catch {
          // no page yet
        }
        return {
          thread: t,
          page: withUserFindings(parsePage(raw), dir),
          answers: readAppJson(dir, "answers.json", {}),
          retracted: readAppJson(dir, "retracted.json", null),
        };
      });
    const validBrief = (x) =>
      x && typeof x === "object" && ((typeof x.goal === "string" && x.goal.trim().length > 0) || BRIEF_LISTS.some((f) => Array.isArray(x[f]) && x[f].length > 0));
    const ms = (s) => {
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : -Infinity;
    };
    // THE LANE BRIEF: the newest brief written FOR this lane (its stamp —
    // a brief from before the stamp counts for its thread's current lane,
    // and every thread read here is in it), by the brief's own time, among
    // the threads read AND the lane record's cached brief — so a brief
    // outlives a thread that moved away or was deleted, a thread that joins
    // with a brief written for its own corner never takes over (edge case
    // 2), and a lane of more than LANE_READ_THREADS still reads its newest
    // brief (the app keeps the cache newest over ALL its threads).
    const countsHere = (b) =>
      b.lane === undefined ||
      (b.lane !== null && typeof b.lane === "object" && b.lane.project === lane.project && aliasKeys.has(laneNameKey(b.lane.name)));
    let brief = null;
    for (const r of read) {
      if (!validBrief(r.page.brief) || !countsHere(r.page.brief)) continue;
      if (brief === null || ms(r.page.brief.updatedAt) > ms(brief.brief.updatedAt)) {
        brief = { brief: r.page.brief, threadTitle: r.thread.title, self: r.thread.id === self.id };
      }
    }
    const cached = record.brief;
    if (cached && validBrief(cached.brief) && (brief === null || ms(cached.brief.updatedAt) > ms(brief.brief.updatedAt))) {
      const holder = threads.find((t) => t && t.id === cached.threadId);
      brief = {
        brief: cached.brief,
        threadTitle: holder && typeof holder.title === "string" ? holder.title : cached.threadTitle || "a thread",
        self: cached.threadId === self.id,
        deleted: !holder,
      };
    }
    const siblings = read.filter((r) => r.thread.id !== self.id);
    const findings = newestFirstBy(
      siblings.flatMap((r) =>
        (Array.isArray(r.page.findings) ? r.page.findings : [])
          .filter((f) => f && typeof f.claim === "string" && FINDING_VERDICTS.includes(f.verdict))
          .map((finding) => ({ finding, threadTitle: r.thread.title }))
      ),
      (x) => x.finding.updatedAt
    );
    const questions = newestFirstBy(
      siblings.flatMap((r) => {
        const answers = typeof r.answers === "object" && r.answers !== null && !Array.isArray(r.answers) ? r.answers : {};
        const dismissed = dismissedQuestionIds(r.page, r.retracted);
        return r.page.questions
          .filter(
            (q) =>
              q &&
              typeof q.id === "string" &&
              typeof q.text === "string" &&
              !(q.id in answers) &&
              !(typeof q.answeredAt === "string" && q.answeredAt.length > 0) &&
              !dismissed.has(q.id)
          )
          .map((q) => ({ id: q.id, text: q.text, askedAt: q.askedAt, threadTitle: r.thread.title }));
      }),
      (q) => q.askedAt
    );
    // The project's reports built in the lane: by the index row's thread
    // (a thread that moved lanes takes its reports along), plus a report
    // whose thread no longer exists but was stamped with this lane.
    let reports = null;
    const projects = readRegistryProjects(env.registryPath);
    if (projects) {
      const project = projects.find((p) => p.key === lane.project);
      const seen = new Set();
      const rows = [];
      for (const repo of project ? project.repos : []) {
        for (const v of readProjectIndex(repo)) {
          if (seen.has(v.id)) continue;
          const tid = typeof v.threadId === "string" ? v.threadId : "";
          const inLane = memberIds.has(tid) || (!allIds.has(tid) && typeof v.lane === "string" && aliasKeys.has(laneNameKey(v.lane)));
          if (!inLane) continue;
          seen.add(v.id);
          rows.push({ id: v.id, title: typeof v.title === "string" ? v.title : v.id, builtAt: typeof v.builtAt === "string" ? v.builtAt : "" });
        }
      }
      reports = newestFirstBy(rows, (r) => r.builtAt);
    }
    return {
      name: lane.name,
      project: lane.project,
      threads: members.map((t) => ({ title: t.title, self: t.id === self.id, archived: typeof t.archivedAt === "number" && t.archivedAt > 0 })),
      brief,
      findings,
      reports,
      questions,
    };
  } catch {
    return null;
  }
}

/** The lane's record in threads.json's `lanes` (the app's; READ-only here):
 *  its former names and cached brief. Missing → none. */
function readLaneRecord(threadsJsonPath, lane) {
  const none = { aliases: [], brief: null };
  try {
    const data = JSON.parse(fs.readFileSync(threadsJsonPath, "utf-8"));
    const list = Array.isArray(data && data.lanes) ? data.lanes : [];
    const key = laneNameKey(lane.name);
    const rec = list.find((r) => r && r.project === lane.project && typeof r.name === "string" && laneNameKey(r.name) === key);
    if (!rec) return none;
    return {
      aliases: Array.isArray(rec.aliases) ? rec.aliases.filter((a) => typeof a === "string" && a.length > 0) : [],
      brief:
        rec.brief && typeof rec.brief === "object" && rec.brief.brief && typeof rec.brief.brief === "object" && typeof rec.brief.threadId === "string"
          ? { brief: rec.brief.brief, threadId: rec.brief.threadId, threadTitle: typeof rec.brief.threadTitle === "string" ? rec.brief.threadTitle : "" }
          : null,
    };
  } catch {
    return none;
  }
}

/** The lane the calling thread is in, by name — stamped on a project report's
 *  index row so a report whose thread is later deleted stays on its lane
 *  (requirements, edge case 6). Null = none / unreadable. */
function selfLaneName(threadsJsonPath, selfThreadId) {
  if (!threadsJsonPath || !selfThreadId) return null;
  const self = readThreadsFile(threadsJsonPath).find((t) => t && t.id === selfThreadId);
  const lane = self ? recordLane(self) : null;
  return lane ? lane.name : null;
}

/** What the `lane` op needs to know (SWIT-108): the thread's current lane and
 *  who set it, whether the user took it out of one, and whether its folder
 *  is in a registry project (null = no registry to ask). READ-only. */
function laneContextFor(env) {
  const threads = env && env.threadsJsonPath ? readThreadsFile(env.threadsJsonPath) : [];
  const self = env && env.selfThreadId ? threads.find((t) => t && t.id === env.selfThreadId) : undefined;
  const current = self ? recordLane(self) : null;
  const userCleared = !!self && current === null && self.laneSetBy === "user";
  const projects = env ? readRegistryProjects(env.registryPath) : null;
  const dir = self && typeof self.workingDir === "string" && self.workingDir.length > 0 ? self.workingDir : env && env.cwd;
  const place = projects ? projectPlaceFor(projects, dir) : null;
  const projectKnown = projects ? place !== null : null;
  return { current, userCleared, projectKnown, projectKey: place ? place.key : null };
}

/** THE BRIEF'S LANE STAMP (review of ec319c7, #1): the lane this thread is in
 *  as the brief is written — its record's lane (threads.json, the app's), or,
 *  in the seconds before the app copies an agent's own `lane` op, the page's
 *  lane when the thread has a project and the user did not take it out of
 *  one; else null ("written in no lane"). Only a brief stamped for lane L
 *  counts toward L's brief (src/lib/lanes.ts briefCountsFor). Pure. */
function briefLaneStamp(ctx, page) {
  if (ctx && ctx.current) return { name: ctx.current.name, project: ctx.current.project };
  if (ctx && !ctx.userCleared && ctx.projectKey && page && typeof page.lane === "string" && page.lane.length > 0) {
    return { name: page.lane, project: ctx.projectKey };
  }
  return null;
}

/** One of the app's files beside page.json, as parsed JSON — READ-only (the
 *  app is their one writer). Missing or junk → `fallback`. */
// SWIT-114: the USER's findings — filed from a report (`→ finding`) into the
// thread's findings.json, the APP's file (read-only here, like answers.json).
const USER_FINDING_PREFIX = "user-";

/** The page with the user's findings joined to the agent's (marked
 *  `by: "user"`). Read-only; a missing or torn file adds nothing. */
function withUserFindings(page, threadDir) {
  const file = readAppJson(threadDir, "findings.json", null);
  const rows =
    file && Array.isArray(file.findings)
      ? file.findings
          .filter(
            (f) =>
              f &&
              typeof f.id === "string" &&
              f.id.startsWith(USER_FINDING_PREFIX) &&
              typeof f.claim === "string" &&
              FINDING_VERDICTS.includes(f.verdict)
          )
          .map((f) => ({ ...f, by: "user" }))
      : [];
  if (rows.length === 0) return page;
  const own = (Array.isArray(page.findings) ? page.findings : []).filter(
    (f) => !(f && typeof f.id === "string" && f.id.startsWith(USER_FINDING_PREFIX))
  );
  return { ...page, findings: [...own, ...rows] };
}

function readAppJson(threadDir, name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(threadDir, name), "utf-8"));
  } catch {
    return fallback;
  }
}

/** `page` op `read` — reads page.json + answers.json + retracted.json,
 *  writes nothing. SWIT-108: with `env` (the app's files, handed over by the
 *  server's own env — never read from process.env here, so a test is never
 *  touched by the machine it runs on) a thread in a lane gets the lane's
 *  roll-up appended. */
function performReadOp(threadDir, env = null) {
  let raw = "";
  try {
    raw = fs.readFileSync(pagePathFor(threadDir), "utf-8");
  } catch {
    // no page yet — the read says so
  }
  return formatPageRead(
    withUserFindings(parsePage(raw), threadDir),
    readAppJson(threadDir, "answers.json", {}),
    readAppJson(threadDir, "retracted.json", null),
    readLaneRollup(env)
  );
}

// ── Shows (SWIT-102) — put an EXISTING doc or file in front of the user ──────
// `page` op `show {address}` appends to `shows.json` in the thread dir
// (`{version:1, shows:[{id:"o<n>", address, at}]}`, newest first, capped; this
// server is its one writer) and the app's view-intent poll reads it beside
// views/ and sets.json with the same baseline rule, opening an unseen show in
// the ONE preview slot, focused. The address is the Evidence vocabulary's
// openable half: a knowledge-base doc path, a file path in this thread's
// project, `surface:<project>/<page>[?k=v]`, `view:<id>[#h:<slug>]`. Caps
// mirror src/lib/showIntent.ts.

const SHOW_CAP = 20; // shows kept in shows.json
const SHOW_ADDRESS_CAP = 300; // an address, not prose (reviewFirst's cap)
const SHOW_PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/; // evidenceModel's PATH_SEGMENT
const SHOW_SURFACE_RE = /^surface:[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(\?.*)?$/; // surfaceParams' SURFACE_ADDRESS
const SHOW_FORMS =
  "a knowledge-base doc path (relative to the knowledge-base root), a file path relative to this thread's working directory, surface:<project>/<page>[?k=v], view:<id>[#h:<heading-slug>] or a project's view:<project>/<id>[#h:<heading-slug>]";

// src/lib/surfaceParams.ts's STRICT query rule, mirrored (review of 49ebb20,
// #3): an address whose params the app's `parseSurfaceQuery` rejects opens
// NOTHING there, so it is refused here instead of reported as opening.
const SURFACE_PARAM_MAX_KEYS = 8;
const SURFACE_PARAM_VALUE_MAX = 120;
const SURFACE_PARAM_KEY_RE = /^[a-z][a-zA-Z0-9_]*$/;
function surfaceQueryOk(query) {
  if (query.length === 0) return true;
  let pairs;
  try {
    pairs = new URLSearchParams(query);
  } catch {
    return false;
  }
  const seen = new Set();
  for (const [key, value] of pairs) {
    if (!SURFACE_PARAM_KEY_RE.test(key) || seen.has(key)) return false;
    if (value.length === 0 || value.length > SURFACE_PARAM_VALUE_MAX) return false;
    seen.add(key);
    if (seen.size > SURFACE_PARAM_MAX_KEYS) return false;
  }
  return true;
}

// What the app's repo-file viewer can render — mirrors explorer.rs's
// `read_at` (review of 49ebb20, #3): a FILE, at most MAX_READ_BYTES, UTF-8
// text (`fs::read_to_string` refuses anything else). A path that fails it
// would open an error card, so `show` refuses it by name instead.
const SHOW_READ_CAP = 512 * 1024; // explorer.rs MAX_READ_BYTES — change one, change the other

/** The real filesystem probe: {kind: "missing" | "dir" | "file", size, text}.
 *  Tests inject their own. */
function inspectPath(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return { kind: "missing", size: 0, text: false };
  }
  if (st.isDirectory()) return { kind: "dir", size: 0, text: false };
  if (!st.isFile()) return { kind: "missing", size: 0, text: false };
  if (st.size > SHOW_READ_CAP) return { kind: "file", size: st.size, text: false };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(p));
    return { kind: "file", size: st.size, text: true };
  } catch {
    return { kind: "file", size: st.size, text: false };
  }
}

/** Refuse a path the viewer could not render, by name. */
function assertOpenable(address, info) {
  if (info.kind === "dir") {
    throw new OpError(`${address} is a folder — show opens a file; name a file inside it`);
  }
  if (info.kind === "file" && info.size > SHOW_READ_CAP) {
    throw new OpError(
      `${address} is ${Math.ceil(info.size / 1024)} KB — the panel's viewer reads files up to ${SHOW_READ_CAP / 1024} KB, so nothing would open`
    );
  }
  if (info.kind === "file" && !info.text) {
    throw new OpError(`${address} is not a text file (the panel's viewer renders text — markdown, html, source) — nothing would open`);
  }
}

/** Classify + normalize a `show` address. Pure: `cwd` and the thread's view
 *  ids are passed in. Returns `{address, form}` — form is `view` | `surface` |
 *  `path` (relative, forward slashes) | `absolute` (outside cwd; the app opens
 *  it only when it sits inside the knowledge base). Throws OpError — visible —
 *  on anything that cannot open (a ticket key, a URL, prose, `..`). */
function normalizeShowAddress(raw, cwd, viewIds, projectViewIds) {
  const a = text(raw, "address");
  if (a.length > SHOW_ADDRESS_CAP) {
    throw new OpError(`address is too long (${a.length} chars; the cap is ${SHOW_ADDRESS_CAP}) — it is ${SHOW_FORMS}, not prose`);
  }
  if (a.startsWith("view:")) {
    const rest = a.slice("view:".length);
    const hash = rest.indexOf("#");
    const head = hash === -1 ? rest : rest.slice(0, hash);
    // SWIT-107: `view:<project>/<id>` — a view the PROJECT owns (the form is
    // evidenceModel.projectViewOfAddress's). Checked against the project's
    // index when the registry is readable (`projectViewIds(project)` → ids,
    // or null when it cannot be known).
    const slash = head.indexOf("/");
    if (slash !== -1) {
      const project = head.slice(0, slash);
      const pid = head.slice(slash + 1);
      if (!VIEW_ID_RE.test(project) || !VIEW_ID_RE.test(pid)) {
        throw new OpError(`${JSON.stringify(a)} is not a project view address — view:<project>/<id>, as the view tool's result named it`);
      }
      const known = typeof projectViewIds === "function" ? projectViewIds(project) : null;
      if (Array.isArray(known) && !known.includes(pid)) {
        throw new OpError(`no project view ${pid} in ${project} — a report shown with the view tool (scope project) names its address in the result`);
      }
      // eslint-disable-next-line no-control-regex
      if (hash !== -1 && (!/^[a-z][a-z0-9-]*:.+$/s.test(rest.slice(hash + 1)) || /[\x00-\x1f\x7f]/.test(rest.slice(hash + 1)))) {
        throw new OpError(`${JSON.stringify(a)} has a malformed anchor — a report heading is view:<project>/<id>#h:<heading-slug>`);
      }
      return { address: a, form: Array.isArray(known) ? "project-view" : "project-view-unchecked" };
    }
    const id = head;
    if (!VIEW_ID_RE.test(id)) throw new OpError(`${JSON.stringify(a)} is not a view address — view:<id> with the id the view tool gave you`);
    if (!viewIds.includes(id)) {
      throw new OpError(`no view with id ${id} in this thread — create it with the view tool (op show) first`);
    }
    // The anchor grammar is viewAnchorOfAddress's (evidenceModel): <kind>:<id>.
    // eslint-disable-next-line no-control-regex
    if (hash !== -1 && (!/^[a-z][a-z0-9-]*:.+$/s.test(rest.slice(hash + 1)) || /[\x00-\x1f\x7f]/.test(rest.slice(hash + 1)))) {
      throw new OpError(`${JSON.stringify(a)} has a malformed anchor — a report heading is view:<id>#h:<heading-slug>`);
    }
    return { address: a, form: "view" };
  }
  if (a.startsWith("surface:")) {
    if (!SHOW_SURFACE_RE.test(a)) {
      throw new OpError(`${JSON.stringify(a)} is not a page address — surface:<project>/<page>?key=value`);
    }
    const q = a.indexOf("?");
    if (q !== -1 && !surfaceQueryOk(a.slice(q + 1))) {
      throw new OpError(
        `${JSON.stringify(a)} has params the page would refuse — up to ${SURFACE_PARAM_MAX_KEYS} key=value pairs, ` +
          `each key [a-z][a-zA-Z0-9_]* used once, each value 1–${SURFACE_PARAM_VALUE_MAX} chars`
      );
    }
    return { address: a, form: "surface" };
  }
  // A path. Backslashes are separators here (Windows); `./` is noise.
  let p = a.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  const drive = /^[A-Za-z]:\//.test(p);
  let absolute = drive || p.startsWith("/");
  if (absolute && typeof cwd === "string" && cwd.length > 0) {
    // An absolute path INSIDE the working directory is that relative path.
    const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    const fold = (s) => (drive ? s.toLowerCase() : s); // drive paths are case-insensitive
    if (root.length > 0 && fold(p).startsWith(`${fold(root)}/`)) {
      p = p.slice(root.length + 1);
      absolute = false;
    }
  }
  const body = absolute ? p.replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "") : p;
  const segments = body.split("/");
  const clean = segments.every((s) => s.length > 0 && s !== ".." && s !== "." && SHOW_PATH_SEGMENT_RE.test(s));
  if (!clean || (!body.includes("/") && !/\.[A-Za-z0-9]{1,8}$/.test(body))) {
    throw new OpError(
      `${JSON.stringify(a)} is not something the panel can open — address must be ${SHOW_FORMS}. ` +
        "A path uses letters, digits, . _ - and / only (no spaces, no ..); a ticket key or a URL opens nothing here — those are evidence rows."
    );
  }
  return { address: p, form: absolute ? "absolute" : "path" };
}

function readShowsFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data && data.shows) ? data.shows.filter((s) => s && typeof s.id === "string") : [];
  } catch {
    return [];
  }
}

/** `page` op `show`. `env` = {cwd, exists?, inspect?} — injected by the
 *  tests; the real server uses its own working directory (claude's — the
 *  thread's) and the filesystem. A bare `exists` probe (older tests) reads as
 *  "a readable text file" when it answers true.
 *
 *  THE RESULT IS HONEST (review of 49ebb20, #3): a folder, an oversize or a
 *  binary file is REFUSED by name (nothing is recorded — the viewer could
 *  not render it); a page is "opening" only if its project/page is registered
 *  in Switchboard, which this server cannot see, so it says so; and a file
 *  under the working directory opens only when that folder belongs to a
 *  registry project — which this server cannot see either, so it says so.
 *  A path FOUND under the working directory is recorded `where: "cwd"`: the
 *  app then opens that file and never a knowledge-base doc of the same path
 *  (review of 49ebb20, #1 — `README.md` in a repo thread opened
 *  personal-kb/README.md). */
function performShowOp(threadDir, args, now, env) {
  const cwd = (env && env.cwd) || process.cwd();
  const inspect =
    (env && env.inspect) ||
    (env && env.exists
      ? (p) => (env.exists(p) ? { kind: "file", size: 0, text: true } : { kind: "missing", size: 0, text: false })
      : inspectPath);
  // SWIT-107: the registry (when this server was handed one) — to check a
  // project view address, and to say plainly whether a cwd file can open.
  const registryPath = env && "registryPath" in env ? env.registryPath : process.env.SWITCHBOARD_REGISTRY;
  const projects = readRegistryProjects(registryPath);
  const projectViewIds = (key) => {
    if (projects === null) return null;
    const project = projects.find((p) => p.key === key);
    if (!project) return [];
    return [...projectViewOwners({ repos: project.repos }).keys()];
  };
  const { address, form } = normalizeShowAddress(args.address, cwd, listViewIds(path.join(threadDir, "views")), projectViewIds);
  let underCwd = false;
  if (form === "absolute") {
    const info = inspect(address);
    if (info.kind === "missing") throw new OpError(`no file at ${address} — nothing to open`);
    assertOpenable(address, info);
  } else if (form === "path") {
    const info = inspect(path.join(cwd, address));
    if (info.kind !== "missing") {
      assertOpenable(address, info);
      underCwd = true;
    }
  }
  const file = path.join(threadDir, "shows.json");
  const shows = readShowsFile(file);
  const show = { id: nextId(shows, "o"), address, at: new Date(now).toISOString() };
  if (underCwd) show.where = "cwd";
  const next = { version: 1, shows: [show, ...shows].slice(0, SHOW_CAP) };
  fs.mkdirSync(threadDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  const opening = `${address} is opening in the panel beside the terminal.`;
  let message;
  if (form === "view" || form === "project-view") {
    message = opening;
  } else if (form === "project-view-unchecked") {
    message = `${address} opens in the panel beside the terminal if that project owns a view with that id (this server could not read the registry to check).`;
  } else if (form === "surface") {
    message =
      `${address} opens in the panel beside the terminal if it names a page Switchboard has registered ` +
      "(this server cannot see that list — an unregistered project or page opens nothing).";
  } else if (form === "absolute") {
    message = `Recorded — but ${address} is outside this thread's working directory, so it opens ONLY if it sits inside the knowledge base; otherwise nothing opens.`;
  } else if (underCwd && projects !== null && projectPlaceFor(projects, cwd) !== null) {
    // SWIT-107: the registry says which project holds this folder — exact.
    message = opening;
  } else if (underCwd && projects !== null) {
    message =
      `Recorded — but this thread's working directory is in no registry project, so ${address} opens ONLY if the folder is inside the knowledge base; otherwise nothing opens.`;
  } else if (underCwd) {
    message =
      `${address} opens in the panel beside the terminal when this thread's folder belongs to a registry project ` +
      "(every registered repo does; a folder outside them opens nothing unless it is inside the knowledge base).";
  } else {
    message = `Recorded — but ${address} is not a file under this thread's working directory, so it opens ONLY if Switchboard can resolve it as a knowledge-base doc (a path relative to the knowledge-base root) or a file in this thread's project; otherwise nothing opens.`;
  }
  return { show, message };
}

// ── Views (SWIT-50) — a rendered dataset the shell draws ─────────────────────

// T7 (SWIT-61): `line` (series over one time axis) and `bar` (by category)
// join the renderer registry; `series` / `valueColumn` are their two extra
// fields (both optional — the reader infers when absent).
// T8 (SWIT-62): `timeline` (price over a match, sized marks per moment, the
// score as steps) — `sizeColumn` names the mark-radius column (default
// `size_z` at the reader). The data file may carry `{meta, rows}`; the
// toolbar prints meta.coverage + meta.n_trades as the coverage line.
// SWIT-70: the line kind gains `seriesLabels` (legend words), `regions`
// (shaded time bands) and `panels` (small multiples — fixed sources, no
// {key}); validated here, parsed tolerantly by viewStore.
// SWIT-73: `report` — markdown with embedded live views. The source must be
// a FILE ending .md (no query, no {key}); the fenced ```view / ```stat
// blocks INSIDE the markdown are validated at RENDER time by the shell's
// tolerant parser (this server cannot see inside the file) — a broken block
// shows an error card in place and the rest of the report renders. A report
// cannot be a drill target and cannot embed a report.
// SWIT-75: the chart review loop — `levels` [{price, label?, style?, price2?}]
// (candles / line, and on a drill) draw horizontal rules; a `zone` needs
// `price2`. `markerColumns` (spec and drill) names columns whose non-null
// cells are markers labelled by the column name; a drill may also carry a
// static `markers` list. The shell adds deck next/prev over a drilled
// child, a per-card note (`<deck dir>/notes.json`, written by the app) and
// a batch send; this server validates the fields and states the loop.
// SWIT-81: colour carries meaning, never decoration. `tone` (bar/dist only)
// picks the bars' fill — 'neutral' | 'sign' (--up/--dn) | 'accent' |
// 'chart-1'..'chart-8'; omitted, the shell defaults it (sign when the
// values are mixed, else neutral — see viewTone.ts). `tones` (table only,
// <=6) [{column, tone:'sign'|'heat'}] colours cells — sign the text by
// number sign, heat the background by the column's min–max position; a
// report's ```stat tile takes its own `tone` ('up'|'dn'|'accent'|'neutral')
// on the figure, validated by the shell alone (this server cannot see
// inside the markdown file).

const VIEW_KINDS = ["table", "candles", "dist", "line", "bar", "timeline", "report"];
const VIEW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VIEW_MARKER_CAP = 200;
// T6 (SWIT-60): the three optional fields' caps — mirrored in viewStore.ts
// (the reader trims to the same numbers).
const VIEW_DEFINITION_CAP = 600;
const VIEW_FILTER_CAP = 4;
const VIEW_FILTER_KINDS = ["select", "date"];
const VIEW_DRILL_TITLE_CAP = 120;
// SWIT-70: the line kind's story fields — caps mirrored in viewStore.ts.
const VIEW_REGION_CAP = 12;
const VIEW_PANEL_CAP = 6;
const VIEW_SERIES_LABEL_CAP = 24;
// SWIT-75: levels per chart — mirrored in viewStore.ts.
const VIEW_LEVEL_CAP = 12;
const VIEW_LEVEL_STYLES = ["solid", "dashed", "zone"];
// SWIT-81: bar/dist tone, table tones — mirrored in src/lib/viewTone.ts.
const BAR_TONES = [
  "neutral",
  "sign",
  "accent",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-7",
  "chart-8",
];
const TABLE_TONE_KINDS = ["sign", "heat"];
const TABLE_TONES_CAP = 6;
const TABLE_TONE_COLUMN_CAP = 64;
// SWIT-111: views you can TWEAK — `controls` (<=4 knobs) re-ask the source
// with a different setting; the source (path, url, body), a line view's
// panels and the drill template name them as `{name}`. Mirrored in
// src/lib/viewControls.ts (the reader's tolerant parse + the substitution).
const CONTROL_CAP = 4;
const CONTROL_KINDS = ["select", "number", "date"];
const CONTROL_OPTION_CAP = 24;
const CONTROL_OPTION_LEN = 60;
const CONTROL_LABEL_CAP = 40;
const CONTROL_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const RESERVED_CONTROL_NAMES = ["key"];
/** A `{name}` placeholder — the same grammar as a control's name. */
const PLACEHOLDER_RE = /\{([a-z][a-zA-Z0-9_]{0,31})\}/g;

function validViewSourcePath(p) {
  if (typeof p !== "string" || p.trim().length === 0) return false;
  // Relative, inside the thread's working dir — the shell re-validates with
  // canonicalized containment; this is the friendly early error.
  if (p.includes("..")) return false;
  if (/^[A-Za-z]:/.test(p) || p.startsWith("/") || p.startsWith("\\")) return false;
  return true;
}

/** LOOPBACK-ONLY, as a REAL PARSE (review, T4-T6): the old prefix regex
 *  accepted `http://localhost:1234@evil.com/x` — that `localhost:1234` is
 *  userinfo and the request goes to evil.com. PAIRED WITH `isLocalBackendUrl`
 *  in `src/lib/viewStore.ts` — byte-identical body (this file is
 *  dependency-free and cannot import it). Change one, change the other. */
function isLocalBackendUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const host = parsed.hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/** Validate a view SOURCE — the top-level one or a drill's TEMPLATE (`field`
 *  names which, for the error). A template is checked with `{key}` replaced
 *  by a placeholder component, so `{key}` may sit in a path or a query
 *  string but a host that is not a literal loopback address is refused
 *  before any key exists. Pure; throws OpError. */
function buildViewSource(source, field) {
  if (typeof source !== "object" || source === null) {
    throw new OpError(`${field} is required: {type:'file', path} or {type:'query', url}`);
  }
  // `{key}` and (SWIT-111) every `{name}` control placeholder stand in as a
  // plain component — which ones are DECLARED is checked by the caller.
  const fill = (v) => (typeof v === "string" ? v.replace(PLACEHOLDER_RE, "k") : v);
  if (source.type === "file") {
    if (!validViewSourcePath(fill(source.path))) {
      throw new OpError(`${field}.path must be a relative path inside this thread's working directory (no .., no absolute paths)`);
    }
    return { type: "file", path: source.path.trim() };
  }
  if (source.type === "query") {
    const url = text(source.url, `${field}.url`);
    if (!isLocalBackendUrl(fill(url))) {
      throw new OpError(`${field}.url must be a local backend (127.0.0.1 / localhost)`);
    }
    const clean = { type: "query", url };
    if (typeof source.body === "string" && source.body.length > 0) {
      clean.body = source.body.slice(0, 4000);
    }
    return clean;
  }
  throw new OpError(`${field}.type must be "file" or "query"`);
}

/** A real calendar day `YYYY-MM-DD` (Feb 30 is not one). Mirrors
 *  viewControls.isControlDate. Pure. */
function isControlDate(v) {
  if (typeof v !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** A control value's cap — a number's PLAIN form must fit it too (review of
 *  9605373, #7). Mirrors viewControls.CONTROL_VALUE_CAP. */
const CONTROL_VALUE_CAP = 64;

/** A number printed PLAINLY — no exponent, no float noise, no trailing
 *  zeros, `-0` → `0`. Mirrors viewControls.formatControlNumber (the test
 *  compares the two on awkward numbers). Pure. */
function formatControlNumber(n) {
  if (!Number.isFinite(n)) return "0";
  const r = Number(n.toPrecision(15));
  if (r === 0) return "0";
  let s = String(r);
  const exp = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (exp) {
    const sign = exp[1];
    const digits = `${exp[2]}${exp[3] || ""}`;
    const point = 1 + Number(exp[4]);
    s =
      point <= 0
        ? `${sign}0.${"0".repeat(-point)}${digits}`
        : `${sign}${digits.padEnd(point, "0").slice(0, point)}${digits.length > point ? `.${digits.slice(point)}` : ""}`;
  }
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/** A finite number from a number (or a numeric string); null otherwise. */
function finiteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim().length > 0 && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** `controls` (SWIT-111): the knobs that re-ask the source. STRICT — every
 *  problem is a visible error naming the control (the reader's parse is the
 *  tolerant half). Pure; throws OpError. */
function buildControls(raw, kind) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new OpError("controls must be an array of {name, kind, label?, default, options? | min/max/step?}");
  if (raw.length === 0) return undefined;
  if (kind === "report") {
    throw new OpError("a report takes no controls — declare them on the embedded ```view blocks instead");
  }
  if (raw.length > CONTROL_CAP) throw new OpError(`controls has ${raw.length} entries; the cap is ${CONTROL_CAP}`);
  const out = [];
  const seen = new Set();
  raw.forEach((c, i) => {
    const at = `controls[${i}]`;
    if (typeof c !== "object" || c === null || Array.isArray(c)) {
      throw new OpError(`${at} must be {name, kind, label?, default, options? | min/max/step?}`);
    }
    const name = typeof c.name === "string" ? c.name.trim() : "";
    if (!CONTROL_NAME_RE.test(name)) {
      throw new OpError(`${at}.name must match [a-z][a-zA-Z0-9_]{0,31} — it is the {name} placeholder in the source`);
    }
    if (RESERVED_CONTROL_NAMES.includes(name)) {
      throw new OpError(`${at}.name cannot be "key" — {key} is a drill's placeholder`);
    }
    if (seen.has(name)) throw new OpError(`${at} repeats the name ${name}`);
    seen.add(name);
    if (!CONTROL_KINDS.includes(c.kind)) {
      throw new OpError(`${at}.kind must be one of ${CONTROL_KINDS.join(", ")}`);
    }
    if (c.kind !== "select" && c.options !== undefined && c.options !== null) {
      throw new OpError(`${at}.options apply to a select control`);
    }
    if (c.kind !== "number" && [c.min, c.max, c.step].some((v) => v !== undefined && v !== null)) {
      throw new OpError(`${at}.min / max / step apply to a number control`);
    }
    const control = { name, kind: c.kind };
    if (c.label !== undefined && c.label !== null) {
      if (typeof c.label !== "string" || c.label.trim().length === 0) {
        throw new OpError(`${at}.label must be a non-empty string when given`);
      }
      if (c.label.trim().length > CONTROL_LABEL_CAP) {
        throw new OpError(`${at}.label is ${c.label.trim().length} chars; the cap is ${CONTROL_LABEL_CAP}`);
      }
      control.label = c.label.trim();
    }
    if (c.kind === "select") {
      if (!Array.isArray(c.options) || c.options.length === 0) {
        throw new OpError(`${at} is a select and needs options: [\"…\", …]`);
      }
      if (c.options.length > CONTROL_OPTION_CAP) {
        throw new OpError(`${at}.options has ${c.options.length} entries; the cap is ${CONTROL_OPTION_CAP}`);
      }
      const options = [];
      c.options.forEach((o, j) => {
        if (typeof o !== "string" || o.trim().length === 0) {
          throw new OpError(`${at}.options[${j}] must be a non-empty string`);
        }
        const t = o.trim();
        if (t.length > CONTROL_OPTION_LEN) {
          throw new OpError(`${at}.options[${j}] is ${t.length} chars; the cap is ${CONTROL_OPTION_LEN}`);
        }
        if (options.includes(t)) throw new OpError(`${at}.options repeats ${JSON.stringify(t)}`);
        options.push(t);
      });
      const d = typeof c.default === "string" ? c.default.trim() : "";
      if (!options.includes(d)) {
        throw new OpError(`${at}.default must be one of its options (${options.join(", ")})`);
      }
      control.options = options;
      control.default = d;
    } else if (c.kind === "number") {
      const dflt = finiteNumber(c.default);
      if (dflt === null) throw new OpError(`${at} is a number and needs a finite numeric default`);
      const bound = (v, which) => {
        if (v === undefined || v === null) return undefined;
        const n = finiteNumber(v);
        if (n === null) throw new OpError(`${at}.${which} must be a finite number`);
        return n;
      };
      const min = bound(c.min, "min");
      const max = bound(c.max, "max");
      const step = bound(c.step, "step");
      if (min !== undefined && max !== undefined && min > max) {
        throw new OpError(`${at}.min (${min}) is above max (${max})`);
      }
      if (step !== undefined && step <= 0) throw new OpError(`${at}.step must be above 0`);
      if ((min !== undefined && dflt < min) || (max !== undefined && dflt > max)) {
        throw new OpError(`${at}.default ${dflt} is outside min–max`);
      }
      for (const [which, v] of [["default", dflt], ["min", min], ["max", max]]) {
        if (v === undefined) continue;
        const printed = formatControlNumber(v);
        if (printed.length > CONTROL_VALUE_CAP) {
          throw new OpError(
            `${at}.${which} prints as ${printed.length} characters; a control value is at most ${CONTROL_VALUE_CAP}`
          );
        }
      }
      control.default = dflt;
      if (min !== undefined) control.min = min;
      if (max !== undefined) control.max = max;
      if (step !== undefined) control.step = step;
    } else {
      const d = typeof c.default === "string" ? c.default.trim() : "";
      if (!isControlDate(d)) throw new OpError(`${at} is a date and needs a default YYYY-MM-DD (a real day)`);
      control.default = d;
    }
    out.push(control);
  });
  return out;
}

/** The `{name}` placeholders a template carries (duplicates once). */
function placeholdersIn(template) {
  const out = [];
  for (const m of String(template).matchAll(PLACEHOLDER_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** The text of a source a placeholder may sit in: path, or url + body. */
function sourceTemplate(source) {
  return source.type === "file" ? source.path : `${source.url}${source.body || ""}`;
}

/** SWIT-111: every placeholder in a source must be a DECLARED control (or,
 *  in a drill template, `{key}`) — an undeclared one would reach a read as
 *  literal text. `field` names the source for the error. Pure; throws. */
function checkPlaceholders(source, controls, field, allowed = []) {
  const names = (controls || []).map((c) => c.name);
  for (const p of placeholdersIn(sourceTemplate(source))) {
    if (names.includes(p) || allowed.includes(p)) continue;
    if (p === "key") {
      throw new OpError(`${field} names {key} — {key} belongs in a drill's source; declare a control for a setting instead`);
    }
    throw new OpError(
      `${field} names {${p}}, which no control declares — add controls:[{name:"${p}", kind, default, …}] or remove the placeholder`
    );
  }
}

/** `definition` (T6): the rule that defines the rows, in plain words. Pure. */
function buildDefinition(v, field) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new OpError(`${field} must be a non-empty string when given`);
  }
  if (v.trim().length > VIEW_DEFINITION_CAP) {
    throw new OpError(`${field} is ${v.trim().length} chars; the cap is ${VIEW_DEFINITION_CAP} — say the rule, not the analysis`);
  }
  return v.trim();
}

/** `filters` (T6): selectors over the view's own columns. Pure. */
function buildFilters(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new OpError("filters must be an array of {column, kind, label?}");
  if (raw.length > VIEW_FILTER_CAP) {
    throw new OpError(`filters has ${raw.length} entries; the cap is ${VIEW_FILTER_CAP}`);
  }
  const out = [];
  const seen = new Set();
  raw.forEach((f, i) => {
    if (typeof f !== "object" || f === null) throw new OpError(`filters[${i}] must be {column, kind, label?}`);
    const column = text(f.column, `filters[${i}].column`).trim();
    if (!VIEW_FILTER_KINDS.includes(f.kind)) {
      throw new OpError(`filters[${i}].kind must be one of ${VIEW_FILTER_KINDS.join(", ")}`);
    }
    if (seen.has(column)) throw new OpError(`filters[${i}] repeats column ${column}`);
    seen.add(column);
    const filter = { column, kind: f.kind };
    if (typeof f.label === "string" && f.label.trim().length > 0) filter.label = f.label.trim().slice(0, 40);
    out.push(filter);
  });
  return out.length > 0 ? out : undefined;
}

/** A list of column names (T7: `series`); undefined when absent/empty. */
function columnList(raw) {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((c) => typeof c === "string" && c.trim().length > 0).map((c) => c.trim()).slice(0, 24);
  return list.length > 0 ? list : undefined;
}

/** `levels` (SWIT-75): horizontal rules on candles / line. A `zone` is the
 *  band between `price` and `price2` — two prices, or it is an error (a
 *  single price is a line; say so). Pure; throws OpError. */
function buildLevels(raw, field) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new OpError(`${field} must be an array of {price, label?, style?, price2?}`);
  if (raw.length > VIEW_LEVEL_CAP) {
    throw new OpError(`${field} has ${raw.length} entries; the cap is ${VIEW_LEVEL_CAP}`);
  }
  const out = raw.map((l, i) => {
    if (typeof l !== "object" || l === null) throw new OpError(`${field}[${i}] must be {price, label?, style?, price2?}`);
    const price = Number(l.price);
    if (l.price === null || l.price === undefined || l.price === "" || !Number.isFinite(price)) {
      throw new OpError(`${field}[${i}].price must be a finite number`);
    }
    const style = l.style === undefined || l.style === null ? "solid" : l.style;
    if (!VIEW_LEVEL_STYLES.includes(style)) {
      throw new OpError(`${field}[${i}].style must be one of ${VIEW_LEVEL_STYLES.join(", ")}`);
    }
    const level = { price };
    if (style !== "solid") level.style = style;
    if (style === "zone") {
      const price2 = Number(l.price2);
      if (l.price2 === null || l.price2 === undefined || l.price2 === "" || !Number.isFinite(price2)) {
        throw new OpError(`${field}[${i}] is a zone and needs a finite price2 (a zone is the band between two prices; one price is a line)`);
      }
      level.price2 = price2;
    }
    if (typeof l.label === "string" && l.label.trim().length > 0) level.label = l.label.trim().slice(0, 40);
    return level;
  });
  return out.length > 0 ? out : undefined;
}

/** `markers` [{ts, label, id?}] — the spec's static list, and a drill's
 *  (SWIT-75). Malformed entries drop; capped. Pure. */
function buildMarkers(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((m) => m && typeof m === "object" && typeof m.ts === "string" && m.ts.length > 0)
    .map((m) => ({
      ts: m.ts,
      label: typeof m.label === "string" ? m.label.slice(0, 80) : "",
      ...(typeof m.id === "string" && m.id.length > 0 ? { id: m.id.slice(0, 64) } : {}),
    }))
    .slice(0, VIEW_MARKER_CAP);
  return out;
}

/** `drill` (T6): what is behind an anchor — a child view whose source strings
 *  carry `{key}`. SWIT-111: the template may also name the PARENT's declared
 *  controls — the child is read at the parent's current values. Pure. */
function buildDrill(raw, controls) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    throw new OpError("drill must be {kind, title, source, columns?, keyColumn?, series?, valueColumn?, sizeColumn?, definition?, levels?, markers?, markerColumns?}");
  }
  if (!VIEW_KINDS.includes(raw.kind)) {
    throw new OpError(`drill.kind must be one of ${VIEW_KINDS.join(", ")}`);
  }
  if (raw.kind === "report") {
    throw new OpError("drill.kind cannot be report — a report is a document, not a drill target");
  }
  const title = text(raw.title, "drill.title").trim().slice(0, VIEW_DRILL_TITLE_CAP);
  const source = buildViewSource(raw.source, "drill.source");
  const template = source.type === "file" ? source.path : `${source.url}${source.body || ""}`;
  if (!template.includes("{key}")) {
    throw new OpError("drill.source must contain {key} somewhere (the anchor's key value is substituted there)");
  }
  checkPlaceholders(source, controls, "drill.source", ["key"]);
  const drill = { kind: raw.kind, title, source };
  if (Array.isArray(raw.columns)) {
    const columns = raw.columns.filter((c) => typeof c === "string" && c.trim().length > 0).slice(0, 24);
    if (columns.length > 0) drill.columns = columns;
  }
  if (typeof raw.keyColumn === "string" && raw.keyColumn.trim().length > 0) drill.keyColumn = raw.keyColumn.trim();
  const series = columnList(raw.series);
  if (series !== undefined) drill.series = series;
  if (typeof raw.valueColumn === "string" && raw.valueColumn.trim().length > 0) drill.valueColumn = raw.valueColumn.trim();
  const sizeColumn = buildSizeColumn(raw.sizeColumn, "drill.sizeColumn");
  if (sizeColumn !== undefined) drill.sizeColumn = sizeColumn;
  const definition = buildDefinition(raw.definition, "drill.definition");
  if (definition !== undefined) drill.definition = definition;
  // SWIT-75: the child's levels, static markers, marker columns.
  const levels = buildLevels(raw.levels, "drill.levels");
  if (levels !== undefined) drill.levels = levels;
  const markers = buildMarkers(raw.markers);
  if (markers !== undefined && markers.length > 0) drill.markers = markers;
  const markerColumns = columnList(raw.markerColumns);
  if (markerColumns !== undefined) drill.markerColumns = markerColumns;
  return drill;
}

/** A parseable time for regions (SWIT-70): the candle rule — naive = UTC. */
function parseableTime(v) {
  if (typeof v !== "string" || v.trim().length === 0) return false;
  const t = v.trim().replace(" ", "T");
  const zoned = /(Z|[+-]\d\d:?\d\d)$/i.test(t) ? t : `${t}Z`;
  return Number.isFinite(Date.parse(zoned));
}

/** `seriesLabels` (SWIT-70): legend labels in plain words, by series COLUMN
 *  (the colour stays keyed on the column, so a label never moves a tone). */
function buildSeriesLabels(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new OpError("seriesLabels must be an object mapping a series column to a plain-words label");
  }
  const entries = Object.entries(raw);
  if (entries.length > VIEW_SERIES_LABEL_CAP) {
    throw new OpError(`seriesLabels has ${entries.length} entries; the cap is ${VIEW_SERIES_LABEL_CAP}`);
  }
  const out = {};
  for (const [k, v] of entries) {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new OpError(`seriesLabels.${k} must be a non-empty string`);
    }
    if (k.trim().length === 0) continue;
    out[k.trim()] = v.trim().slice(0, 40);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `regions` (SWIT-70): shaded time bands on a line chart. */
function buildRegions(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new OpError("regions must be an array of {from, to, label?}");
  if (raw.length > VIEW_REGION_CAP) {
    throw new OpError(`regions has ${raw.length} entries; the cap is ${VIEW_REGION_CAP}`);
  }
  const out = raw.map((r, i) => {
    if (typeof r !== "object" || r === null) throw new OpError(`regions[${i}] must be {from, to, label?}`);
    if (!parseableTime(r.from) || !parseableTime(r.to)) {
      throw new OpError(`regions[${i}].from and .to must be parseable times (ISO; a naive stamp is read as UTC)`);
    }
    const region = { from: r.from.trim(), to: r.to.trim() };
    if (typeof r.label === "string" && r.label.trim().length > 0) region.label = r.label.trim().slice(0, 40);
    return region;
  });
  return out.length > 0 ? out : undefined;
}

/** `panels` (SWIT-70): small multiples — line kind only, each source
 *  validated like the main one, `{key}` REFUSED (a panel is a fixed source,
 *  never a drill template). */
function buildPanels(raw, kind, controls) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new OpError("panels must be an array of {title, source}");
  if (kind !== "line") throw new OpError("panels apply to the line kind (small multiples)");
  if (raw.length > VIEW_PANEL_CAP) {
    throw new OpError(`panels has ${raw.length} entries; the cap is ${VIEW_PANEL_CAP}`);
  }
  const out = raw.map((p, i) => {
    if (typeof p !== "object" || p === null) throw new OpError(`panels[${i}] must be {title, source}`);
    const title = text(p.title, `panels[${i}].title`).trim().slice(0, 80);
    const source = buildViewSource(p.source, `panels[${i}].source`);
    const template = source.type === "file" ? source.path : `${source.url}${source.body || ""}`;
    if (template.includes("{key}")) {
      throw new OpError(`panels[${i}].source must not contain {key} — a panel is a fixed source; use drill for templates`);
    }
    // SWIT-111: a panel may follow the view's knobs — declared ones only.
    checkPlaceholders(source, controls, `panels[${i}].source`);
    return { title, source };
  });
  return out.length > 0 ? out : undefined;
}

/** `sizeColumn` (T8): the timeline's mark-radius column. Absent = the
 *  reader's default; given, it must be a non-empty column name. Pure. */
function buildSizeColumn(v, field) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new OpError(`${field} must be a non-empty column name when given (e.g. "size_z" or "count")`);
  }
  return v.trim();
}

/** `tone` (SWIT-81): bar / dist only — the bars' colour rule. Absent = the
 *  reader's default (sign when the values are mixed, else neutral). Pure;
 *  throws OpError. */
function buildTone(v, kind) {
  if (v === undefined || v === null) return undefined;
  if (kind !== "bar" && kind !== "dist") {
    throw new OpError("tone applies to bar / dist views");
  }
  if (typeof v !== "string" || !BAR_TONES.includes(v)) {
    throw new OpError(`tone must be one of ${BAR_TONES.join(", ")}`);
  }
  return v;
}

/** `tones` (SWIT-81): table only — up to TABLE_TONES_CAP
 *  {column, tone:'sign'|'heat'} cell-colour rules; a repeated column is an
 *  error (the reader's tolerant re-parse keeps the first rule instead, for
 *  a hand-written spec). Pure; throws OpError. */
function buildTableTones(raw, kind) {
  if (raw === undefined || raw === null) return undefined;
  if (kind !== "table") throw new OpError("tones applies to table views");
  if (!Array.isArray(raw)) throw new OpError("tones must be an array of {column, tone:'sign'|'heat'}");
  if (raw.length > TABLE_TONES_CAP) {
    throw new OpError(`tones has ${raw.length} entries; the cap is ${TABLE_TONES_CAP}`);
  }
  const out = [];
  const seen = new Set();
  raw.forEach((t, i) => {
    if (typeof t !== "object" || t === null) throw new OpError(`tones[${i}] must be {column, tone}`);
    const column = text(t.column, `tones[${i}].column`).trim();
    if (column.length > TABLE_TONE_COLUMN_CAP) {
      throw new OpError(`tones[${i}].column is ${column.length} chars; the cap is ${TABLE_TONE_COLUMN_CAP}`);
    }
    if (!TABLE_TONE_KINDS.includes(t.tone)) {
      throw new OpError(`tones[${i}].tone must be one of ${TABLE_TONE_KINDS.join(", ")}`);
    }
    if (seen.has(column)) throw new OpError(`tones[${i}] repeats column ${column}`);
    seen.add(column);
    out.push({ column, tone: t.tone });
  });
  return out.length > 0 ? out : undefined;
}

/** Validate + normalize a view op into the spec the shell renders. Pure;
 *  throws OpError with agent-readable messages. */
function buildViewSpec(args, existingIds, now) {
  const kind = args.kind;
  if (!VIEW_KINDS.includes(kind)) {
    throw new OpError(`kind must be one of ${VIEW_KINDS.join(", ")}`);
  }
  const title = text(args.title, "title");
  const cleanSource = buildViewSource(args.source, "source");
  // SWIT-73: a report's source is a markdown FILE, nothing else — the
  // embedded blocks are validated when drawn, not here.
  if (kind === "report") {
    if (cleanSource.type !== "file" || !/\.md$/i.test(cleanSource.path) || cleanSource.path.includes("{key}")) {
      throw new OpError(
        "a report's source must be {type:'file', path:'….md'} — a markdown file in this thread's working directory"
      );
    }
    if (args.drill !== undefined && args.drill !== null) {
      throw new OpError("a report takes no drill — declare drills on the embedded ```view blocks instead");
    }
    // Review of 9605373, #8: say it once, for the report — not "add
    // controls" (which a report then refuses).
    const named = placeholdersIn(cleanSource.path);
    if (named.length > 0) {
      throw new OpError(
        `a report's path takes no placeholders ({${named[0]}}) — a report has no controls; declare them on its embedded \`\`\`view blocks`
      );
    }
  }
  // SWIT-111: the knobs first — every `{name}` in the source, the panels and
  // the drill template must be one of them.
  const controls = buildControls(args.controls, kind);
  checkPlaceholders(cleanSource, controls, "source");
  let id;
  if (typeof args.id === "string" && args.id.trim().length > 0) {
    id = args.id.trim();
    if (!VIEW_ID_RE.test(id)) throw new OpError("id must match [A-Za-z0-9_-]{1,64}");
  } else {
    let n = 0;
    for (const e of existingIds) {
      const m = e.match(/^v(\d+)$/);
      if (m) n = Math.max(n, Number(m[1]));
    }
    id = `v${n + 1}`;
  }
  const spec = {
    id,
    kind,
    title,
    source: cleanSource,
    builtAt: new Date(now).toISOString(),
    builtBy: "agent",
  };
  if (Array.isArray(args.columns)) {
    spec.columns = args.columns
      .filter((c) => typeof c === "string" && c.trim().length > 0)
      .slice(0, 24);
  }
  if (typeof args.keyColumn === "string" && args.keyColumn.trim().length > 0) {
    spec.keyColumn = args.keyColumn.trim();
  }
  // T7 (SWIT-61): line series / bar value column.
  const series = columnList(args.series);
  if (series !== undefined) spec.series = series;
  if (typeof args.valueColumn === "string" && args.valueColumn.trim().length > 0) {
    spec.valueColumn = args.valueColumn.trim();
  }
  // T8 (SWIT-62): the timeline's size column.
  const sizeColumn = buildSizeColumn(args.sizeColumn, "sizeColumn");
  if (sizeColumn !== undefined) spec.sizeColumn = sizeColumn;
  const markers = buildMarkers(args.markers);
  if (markers !== undefined) spec.markers = markers;
  // SWIT-75: levels and marker columns.
  const levels = buildLevels(args.levels, "levels");
  if (levels !== undefined) spec.levels = levels;
  const markerColumns = columnList(args.markerColumns);
  if (markerColumns !== undefined) spec.markerColumns = markerColumns;
  // T6 (SWIT-60): the view explains itself and opens downward.
  const definition = buildDefinition(args.definition, "definition");
  if (definition !== undefined) spec.definition = definition;
  const filters = buildFilters(args.filters);
  if (filters !== undefined) spec.filters = filters;
  const drill = buildDrill(args.drill, controls);
  if (drill !== undefined) spec.drill = drill;
  // SWIT-70: the line kind's story fields.
  const seriesLabels = buildSeriesLabels(args.seriesLabels);
  if (seriesLabels !== undefined) spec.seriesLabels = seriesLabels;
  const regions = buildRegions(args.regions);
  if (regions !== undefined) spec.regions = regions;
  const panels = buildPanels(args.panels, kind, controls);
  if (panels !== undefined) spec.panels = panels;
  // SWIT-111: a knob that no source names would change nothing — a dead
  // control is refused by name rather than drawn.
  if (controls !== undefined) {
    const used = new Set(
      [cleanSource, ...(panels || []).map((p) => p.source), ...(drill ? [drill.source] : [])].flatMap((s) =>
        placeholdersIn(sourceTemplate(s))
      )
    );
    const dead = controls.find((c) => !used.has(c.name));
    if (dead) {
      throw new OpError(
        `controls: ${dead.name} is not named by the source, a panel or the drill — put {${dead.name}} where the setting goes (a control that changes nothing is a dead knob)`
      );
    }
    spec.controls = controls;
  }
  // SWIT-81: colour carries meaning.
  const tone = buildTone(args.tone, kind);
  if (tone !== undefined) spec.tone = tone;
  const tones = buildTableTones(args.tones, kind);
  if (tones !== undefined) spec.tones = tones;
  return spec;
}

function listViewIds(viewsDir) {
  try {
    return fs
      .readdirSync(viewsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

// ── Sets (SWIT-79, Ky's set tabs) ───────────────────────────────────────────
// `show` with `set: {label, ids}` opens SEVERAL views already written this
// thread as ONE tab the panel steps through, instead of N tabs. The server
// writes `sets.json` in the thread dir (`{version:1, sets:[{id, label, ids,
// builtAt}]}`, newest first, capped) and the app's view-intent poll reads it
// beside the views/ listing. Caps mirror src/lib/artifactSets.ts.

const SET_CAP = 20; // sets kept in sets.json
const SET_ITEM_CAP = 50; // views per set
const SET_LABEL_CAP = 80;

/** Validate a `set` argument against the views on disk. Pure. */
function buildViewSet(raw, existingIds, existingSetIds, now) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new OpError("set must be {label, ids: [viewId…]}");
  }
  const label = text(raw.label, "set.label").slice(0, SET_LABEL_CAP);
  if (!Array.isArray(raw.ids)) throw new OpError("set.ids must be an array of view ids written this thread");
  const ids = [];
  for (const id of raw.ids) {
    if (typeof id !== "string" || !VIEW_ID_RE.test(id.trim())) {
      throw new OpError(`set.ids entry ${JSON.stringify(id)} is not a view id ([A-Za-z0-9_-])`);
    }
    const clean = id.trim();
    if (!existingIds.includes(clean)) {
      throw new OpError(`set.ids names ${clean}, which is not a view of this thread — show it first`);
    }
    if (!ids.includes(clean)) ids.push(clean);
  }
  if (ids.length < 2) throw new OpError("set.ids needs at least two distinct views — one view is one tab already");
  if (ids.length > SET_ITEM_CAP) throw new OpError(`set.ids has ${ids.length} views; the cap is ${SET_ITEM_CAP}`);
  let n = 0;
  for (const e of existingSetIds) {
    const m = e.match(/^s(\d+)$/);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return { id: `s${n + 1}`, label, ids, builtAt: new Date(now).toISOString() };
}

function readSetsFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data && data.sets) ? data.sets.filter((s) => s && typeof s.id === "string") : [];
  } catch {
    return [];
  }
}

/** `view` op show/update. `env` = {cwd, threadId, registryPath} — injected by
 *  the tests; the real server uses its cwd (claude's — the thread's),
 *  SWITCHBOARD_THREAD_ID and SWITCHBOARD_REGISTRY. */
function performViewOp(threadDir, args, now, env) {
  const viewsDir = path.join(threadDir, "views");
  const existing = listViewIds(viewsDir);
  if (args.set !== undefined && args.set !== null) {
    if (args.op !== "show") throw new OpError('a set goes with op "show"');
    const file = path.join(threadDir, "sets.json");
    const sets = readSetsFile(file);
    const set = buildViewSet(args.set, existing, sets.map((s) => s.id), now);
    const next = { version: 1, sets: [set, ...sets].slice(0, SET_CAP) };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    return {
      set,
      message: `Set ${set.id} (${set.label}) of ${set.ids.length} views is opening as ONE tab beside the terminal — the user steps through it.`,
    };
  }
  if (args.scope !== undefined && args.scope !== null && !VIEW_SCOPES.includes(args.scope)) {
    throw new OpError('scope must be "thread" or "project"');
  }
  if (args.op === "update") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!existing.includes(id)) {
      throw new OpError(`no view with id ${id} — use op "show" to create one`);
    }
  } else if (args.op !== "show") {
    throw new OpError('op must be "show" or "update"');
  }
  // SWIT-107: WHO OWNS IT. On `show`, a report defaults to the project and
  // everything else to the thread; an explicit scope wins. On `update`, the
  // view KEEPS the scope it already has — a report shown before 0.17.0 (or
  // with scope thread) stays in the thread; an explicit scope project
  // promotes it; a view this thread already put in the project keeps writing
  // both copies. (Release review: defaulting an UPDATE to project silently
  // promoted every older thread's report on its next update, and the second
  // thread to update its own minted `v1` was refused because the first had
  // just claimed that id in the project.)
  const threadId = env && typeof env.threadId === "string" ? env.threadId : process.env.SWITCHBOARD_THREAD_ID || "";
  const cwd = (env && env.cwd) || process.cwd();
  const registryPath = env && "registryPath" in env ? env.registryPath : process.env.SWITCHBOARD_REGISTRY;
  const explicit = args.scope === "project" || args.scope === "thread" ? args.scope : null;
  const updateId = args.op === "update" && typeof args.id === "string" ? args.id.trim() : "";
  let scope =
    args.op === "update"
      ? explicit === "project" || existingViewScope(viewsDir, updateId) === "project"
        ? "project"
        : "thread"
      : explicit || (args.kind === "report" ? "project" : "thread");
  const place = projectPlaceFor(readRegistryProjects(registryPath), cwd);
  const owners = place ? projectViewOwners(place) : new Map();
  if (args.op === "update" && place) {
    const owner = owners.get(updateId);
    if (owner && owner.threadId === threadId) scope = "project";
  }
  let note = "";
  if (scope === "project" && place === null) {
    if (explicit === "project") {
      throw new OpError(
        "this thread's working directory is in no registry project (or the registry is unreadable) — a project view needs a project to own it; show it with scope 'thread'"
      );
    }
    scope = "thread";
    note = " It is kept in this thread — its working directory is in no registry project, so no project can own it.";
  }
  if (scope === "project" && place !== null && readProjectIndexStrict(place.repoRoot) === null) {
    // A torn or hand-edited index must never be rewritten as a one-row file:
    // that would drop every other report from the listing AND from the id
    // check, letting another thread overwrite a spec it does not own.
    throw new OpError(
      `the project's report index (${place.key}: .sb-views/_project/index.json) cannot be read — fix or delete it, or show this view with scope 'thread'`
    );
  }
  const spec = buildViewSpec(args, scope === "project" ? [...existing, ...owners.keys()] : existing, now);
  if (scope === "project") {
    const owner = owners.get(spec.id);
    if (owner && owner.threadId !== threadId) {
      throw new OpError(
        args.op === "update"
          ? `view id ${spec.id} is already a project view of another thread (${owner.threadId || "unknown"}) in ${place.key} — keep this one in this thread (update without scope, or scope 'thread')`
          : `view id ${spec.id} is already a project view of another thread (${owner.threadId || "unknown"}) in ${place.key} — pick another id, or omit id to mint one`
      );
    }
    spec.scope = "project";
    spec.project = place.key;
    spec.base = place.base;
    spec.threadId = threadId;
  }
  fs.mkdirSync(viewsDir, { recursive: true });
  const file = path.join(viewsDir, `${spec.id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(spec, null, 2));
  fs.renameSync(tmp, file);
  // SWIT-108: the index row carries the lane this thread is in NOW, so a
  // report whose thread is later deleted stays listed on its lane. Only the
  // env the caller handed over is read (the real server passes its own).
  if (scope === "project") writeProjectView(place, spec, env ? selfLaneName(env.threadsJsonPath, threadId) : null);
  const owned =
    scope === "project"
      ? ` The PROJECT ${place.key} owns it (${projectViewAddress(place.key, spec.id)} — the address for page evidence, a finding's report or page show), so it outlives this thread and is listed under ${place.key} › reports in the knowledge base.`
      : "";
  return {
    spec,
    message:
      (args.op === "update"
        ? `View ${spec.id} updated — the open tab re-renders within a couple of seconds.`
        : `View ${spec.id} is opening in the panel beside the terminal. Update it later with op "update" and the same id.`) +
      owned +
      note,
  };
}

// ── Project views (SWIT-107) — a view the PROJECT owns ───────────────────────
// A report used to live inside the thread that made it: spec in the thread
// dir, data relative to the thread's cwd — archive or lose the thread and the
// report was unreachable. `scope: "project"` (a report's DEFAULT) ALSO writes
// the spec into the project's repo at `.sb-views/_project/<id>.json` and keeps
// `.sb-views/_project/index.json` (`{version:1, views:[{id, title, kind,
// builtAt, threadId}]}`, newest first, PROJECT_VIEW_INDEX_CAP) — this server is
// the one writer of both. The project is the registry project whose repo
// holds this thread's working directory (longest match — the app's
// explorer.projectPlaceForDir rule), read from SWITCHBOARD_REGISTRY; the
// copy records `base` (the cwd relative to that repo root), so the app reads
// the view's data — and a report's embedded blocks' data — relative to the
// same directory the agent wrote it from. Ids are PROJECT-unique: an id
// another thread already holds in the project is refused by name, and a
// minted id counts the project's ids too. The THREAD copy is still written
// (views/<id>.json), so the thread's Evidence rows and the view-intent poll
// work unchanged; the PROJECT copy is the authoritative one (it is what
// outlives the thread), and `update` writes both.

const PROJECT_VIEW_INDEX_CAP = 200;
const VIEW_SCOPES = ["thread", "project"];
const PROJECT_VIEWS_REL = [".sb-views", "_project"];

/** The registry's projects as {key, repos:[absolute, forward slashes]} —
 *  explorer.rs's lenient parse (conventions.reposRoot + projects[].repos +
 *  archived[].path). Null when the file is unreadable or has no reposRoot. */
function readRegistryProjects(registryPath) {
  if (typeof registryPath !== "string" || registryPath.length === 0) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch {
    return null;
  }
  const rootRaw = data && data.conventions && data.conventions.reposRoot;
  if (typeof rootRaw !== "string" || rootRaw.trim().length === 0) return null;
  const root = rootRaw.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const out = [];
  const projects = data.projects && typeof data.projects === "object" ? data.projects : {};
  for (const [key, entry] of Object.entries(projects)) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.repos)) continue;
    const repos = entry.repos.filter((r) => typeof r === "string" && r.trim().length > 0).map((r) => `${root}/${r.trim()}`);
    if (repos.length > 0) out.push({ key, repos });
  }
  const archived = data.archived && typeof data.archived === "object" ? data.archived : {};
  for (const [key, entry] of Object.entries(archived)) {
    if (entry && typeof entry.path === "string" && entry.path.trim().length > 0) out.push({ key, repos: [`${root}/${entry.path.trim()}`] });
  }
  return out;
}

function foldPath(p) {
  return String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Is `dir` the same directory as `root` or inside it? Segment-safe,
 *  case-insensitive (Windows) — explorer.ts `isPathInside`. */
function isDirInside(dir, root) {
  const d = foldPath(dir);
  const r = foldPath(root);
  return r.length > 0 && (d === r || d.startsWith(`${r}/`));
}

/** WHERE this thread's working directory sits in the registry: the project
 *  key, the repo root holding it, every repo of the project, and `base` — the
 *  cwd relative to that repo root ("" at the root). Null = no registry, or no
 *  project holds the folder. Pure over the parsed projects. */
function projectPlaceFor(projects, cwd) {
  if (!Array.isArray(projects) || typeof cwd !== "string" || cwd.length === 0) return null;
  let best = null;
  for (const project of projects) {
    for (const repo of project.repos) {
      if (!isDirInside(cwd, repo)) continue;
      if (best === null || repo.length > best.repoRoot.length) best = { key: project.key, repoRoot: repo, repos: project.repos };
    }
  }
  if (best === null) return null;
  const rel = cwd.replace(/\\/g, "/").replace(/\/+$/, "").slice(best.repoRoot.replace(/\/+$/, "").length).replace(/^\/+/, "");
  return { ...best, base: rel };
}

function projectViewsDir(repoRoot) {
  return path.join(repoRoot, ...PROJECT_VIEWS_REL);
}

function readProjectIndex(repoRoot) {
  return readProjectIndexStrict(repoRoot) || [];
}

/** The index's rows; [] when there is no index yet; NULL when a file is there
 *  but cannot be parsed (torn or hand-edited) — the one case a writer must
 *  not proceed on. */
function readProjectIndexStrict(repoRoot) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(projectViewsDir(repoRoot), "index.json"), "utf8");
  } catch (err) {
    return err && err.code === "ENOENT" ? [] : null;
  }
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data && data.views) ? data.views.filter((v) => v && typeof v.id === "string") : null;
  } catch {
    return null;
  }
}

/** The scope a thread's existing view was written with ("project" | "thread");
 *  "thread" when the file is missing, unreadable or predates SWIT-107. */
function existingViewScope(viewsDir, id) {
  if (!VIEW_ID_RE.test(id)) return "thread";
  try {
    const spec = JSON.parse(fs.readFileSync(path.join(viewsDir, `${id}.json`), "utf8"));
    return spec && spec.scope === "project" ? "project" : "thread";
  } catch {
    return "thread";
  }
}

/** Every project view id across the project's repos → {threadId, repoRoot}. */
function projectViewOwners(place) {
  const owners = new Map();
  for (const repo of place.repos) {
    for (const v of readProjectIndex(repo)) {
      if (!owners.has(v.id)) owners.set(v.id, { threadId: typeof v.threadId === "string" ? v.threadId : "", repoRoot: repo });
    }
  }
  return owners;
}

function writeJsonAtomic(file, value) {
  // A tmp name per WRITER: every live thread runs its own server, and two of
  // them writing the same project's index at once must not share one tmp file
  // (a torn write, or EPERM on the Windows rename). The read-modify-write of
  // the index can still lose a row to a writer in the same instant — rare,
  // and the next update of that view writes its row back.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** Write the PROJECT copy + its index entry (newest first, one per id).
 *  SWIT-108: `lane` = the building thread's lane (or null) — the row keeps it
 *  so a report outlives a deleted thread ON its lane. */
function writeProjectView(place, spec, lane = null) {
  const dir = projectViewsDir(place.repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, `${spec.id}.json`), spec);
  const entry = { id: spec.id, title: spec.title, kind: spec.kind, builtAt: spec.builtAt, threadId: spec.threadId };
  if (typeof lane === "string" && lane.length > 0) entry.lane = lane;
  const views = [entry, ...readProjectIndex(place.repoRoot).filter((v) => v.id !== spec.id)].slice(0, PROJECT_VIEW_INDEX_CAP);
  writeJsonAtomic(path.join(dir, "index.json"), { version: 1, views });
}

/** A project view's address — `view:<project>/<id>` (evidenceModel.ts
 *  projectViewAddress; the app's one definition of the form). */
function projectViewAddress(project, id) {
  return `view:${project}/${id}`;
}

const VIEW_TOOL = {
  name: "view",
  description:
    // SWIT-102: the description OPENS by claiming the words a user says — an
    // agent that hears "artifact" or "report" reached for a claude.ai
    // publishing tool three times on 2026-09-22 and every link died.
    "A REPORT, an \"artifact\", a summary page, a brief — anything the user asks to see IN THE " +
    "PANEL — is made with THIS tool and stays in Switchboard: write a .md file in this " +
    "thread's working directory and show it with kind 'report' (see report: below). Never " +
    "publish it to claude.ai (the Artifact tool, Claude Docs) unless the user asks for a link " +
    "to share. A doc or file that ALREADY exists opens with the page tool's op show. " +
    "SHOW the user rendered data in the panel — a table, a candle chart with markers, a " +
    "distribution, a line chart, bars by category, or a match timeline — drawn by Switchboard's own chart " +
    "components from data YOU supply. Use it " +
    "when the user asks to see something, or as the direct output of an analysis they asked " +
    "for — never as a side effect of a turn. Two sources: write rows to a JSON file in this " +
    "thread's working directory (an ARRAY of flat objects; for candles each row needs " +
    "time/open/high/low/close, time as ISO or epoch seconds) and pass source " +
    "{type:'file', path:'relative/path.json'}; or point at the project's local backend with " +
    "{type:'query', url}. The view NEVER runs your code — it renders your data. op 'show' " +
    "opens it (id minted if omitted); op 'update' with the same id refreshes the open tab. " +
    "For tables pass columns (display order) and keyColumn (the column whose value names a " +
    "row for pins); `tones` (<=6) [{column, tone:'sign'|'heat'}] colours cells — sign colours the " +
    "cell text --up/--dn by the number's sign, heat tints the cell background toward --accent by " +
    "the column's min–max position; header cells are never tinted. For candles pass markers " +
    "[{ts, label, id?}] for entries/exits. " +
    "line: rows {time|ts, <series>…} over one time axis — pass `series` (column names) or every " +
    "numeric non-time column is drawn; markers apply as on candles. bar: one row per category " +
    "{<keyColumn>, <valueColumn>} — pass keyColumn and valueColumn (else count/n/value by name). " +
    "dist is the same shape, pre-binned. bar / dist colour: `tone` picks the bars' fill — " +
    "'neutral' | 'sign' (--up/--dn) | 'accent' | 'chart-1'..'chart-8'; omit it and the shell " +
    "picks sign when the values are mixed, else neutral. timeline: one row per moment {ts, price (0-100, the " +
    "yes-price), <sizeColumn>, backs_player? (1|2), sets_p1?, sets_p2?, games_p1?, games_p2?} — " +
    "the price is drawn as a line, every row as a mark sized by `sizeColumn` (default size_z) " +
    "and toned by backs_player, the score as discrete steps under the price; anchors are " +
    "trade:<ts>. The file may be {meta:{coverage, n_trades, player1, player2, price_of}, rows} " +
    "and the toolbar then states `<coverage> · N of M trades` — write what the rows ARE " +
    "(e.g. 'flagged moments only'), never imply the full tape. CANONICAL EXAMPLE, the tennis " +
    "anomalies: `scripts/export-tennis-match.py --all .sb-views/tennis` writes one " +
    ".sb-views/tennis/<match_id>.json per match (price folded to player 1's yes-price), then show " +
    "kind:'table', keyColumn:'match_id', columns:[match_id, player1_name, player2_name, score, " +
    "n_trades, n_flagged], drill:{kind:'timeline', title:'{key}', source:{type:'file', " +
    "path:'.sb-views/tennis/{key}.json'}, sizeColumn:'size_z'} — a click on a match then opens " +
    "its timeline beside the terminal; add `--full` to export the WHOLE trade tape with game " +
    "state (every trade, `full tape · N trades`) when the Shot Clock DB is up (`docker start " +
    "lode_shotclock_db`; the script says so and exits 2 when it is not). The user " +
    "can pin rows/bars/bins/marks and keep the view; you cannot make a view poll — re-running a " +
    "query is their gesture. Give a `definition` (the rule that defines the rows, in plain " +
    "words) whenever the view encodes a rule — the user reads it under `spec`. Declare a " +
    "`drill` when the rows have instances behind them: {kind, title, source} where the " +
    "source strings carry {key} (the opened row's key-column value / bin label / marker id; " +
    "in a file path it is reduced to one component, [A-Za-z0-9._-] with everything else " +
    "as _; in a query url it is URL-encoded; in a query body it is JSON-escaped) — opening a row then shows the child beside " +
    "the terminal with back. Declare `filters` [{column, kind:'select'|'date'}] so the " +
    "user can slice the loaded rows themselves without asking you. When the user will want to " +
    "TWEAK a setting that changes the data itself, declare `controls` (<=4) and put {name} in " +
    "the source — e.g. controls:[{name:'expiry', kind:'select', options:['front','all'], " +
    "default:'front'}] with source:{type:'file', path:'.sb-views/gamma/book-{expiry}.json'}, " +
    "one file per setting you wrote — and the panel draws the knob and re-reads the source on " +
    "each change (select: options <=24; number: default, min?, max?, step?; date: default " +
    "YYYY-MM-DD; a panel or the drill may name the same {name}; in a file path a value is one " +
    "path component, in a query url it is URL-encoded, in a query body it is JSON-escaped). " +
    "Prefer ONE line view " +
    "with `panels` [{title, source}] (small multiples: a 2-up grid with the main chart, " +
    "shared time axis, <=6, no {key}) over several near-identical views, and give every " +
    "view a `definition` that says what to look at; anchors and pins publish from the main " +
    "chart only — the panels are read-only. line extras: `seriesLabels` {column: plain " +
    "words} names the legend (the same column keeps the same colour in every view), " +
    "`regions` [{from, to, label?}] shade time bands (sessions, halts, regimes; <=12). " +
    "report: ONE document with live views embedded — write a .md file in the thread cwd and " +
    "pass kind:'report', source:{type:'file', path:'analysis.md'}; inside it a fenced block " +
    "```view whose body is a view-spec JSON (the same fields as this tool, NO id — the " +
    "block's position names it) renders as an interactive chart in place, and ```stat with " +
    '{label, value, n?, note?, tag?, tone?} (or an array of them) renders stat cards — note = one ' +
    "plain line under the figure, tag = a few words drawn as an accent chip ('2 – 3× benchmark'), " +
    "tone ('up'|'dn'|'accent'|'neutral') colours the figure only — omit it and a value that starts " +
    "with an explicit + or - picks up/dn for you — e.g. ```view\\n" +
    '{"kind":"line","title":"net gamma","source":{"type":"file","path":".sb-views/gamma.json"}}\\n```. ' +
    "Blocks are validated when drawn — a broken block shows an error card in place and the " +
    "rest of the report renders; at most 24 view/stat blocks render live, the rest as plain " +
    "code. op 'update' re-renders the open report (every block reloads " +
    "its data); the markdown itself is re-read while the tab is active. A report's headings " +
    "are addressable from page evidence as view:<id>#h:<heading-slug>. Prefer one report over " +
    "several views when narrative belongs between the charts. A REPORT BELONGS TO THE " +
    "PROJECT by default (scope 'project'): it is also written into the project's repo " +
    "(.sb-views/_project/<id>.json + index.json), outlives this thread, is listed under the " +
    "project's reports in the knowledge base and is addressed view:<project>/<id> (the " +
    "result names it) — use that address in evidence, a finding's report or page show. Its " +
    "data paths stay relative to this working directory. Ids are unique across the project " +
    "(omit id to mint one); update writes both copies. Pass scope 'project' to give any other " +
    "view the same life, or scope 'thread' to keep a report in this thread only. THE REVIEW LOOP (a deck): a " +
    "table with a drill is a deck the user steps through with next/prev in the panel; give the " +
    "drill `levels` [{price, label?, style?:'solid'|'dashed'|'zone', price2?}] (<=12; a zone is " +
    "the band between price and price2) for horizontal levels, and `markerColumns` " +
    "['entry','exit'] so a sparse column's non-null cells become markers at that row's time " +
    "(labelled by the column name; those columns are never drawn as series) — never encode a " +
    "level as a constant column or an entry as a series. The user writes a one-line note per " +
    "card, autosaved to `<deck dir>/notes.json` beside the deck's index file (Read it: " +
    "{version:1, notes:{[key]:{text, updatedAt, sentAt?}}}; a note made at a non-default control " +
    "setting is keyed `<key> @ expiry=all`), and `send N notes` delivers every " +
    "unsent note to you as ONE message: `Chart notes on <title> (N):` then `- <key>: <note>` " +
    "per line. SETS: several views of one kind go in as ONE tab — the panel steps through " +
    "them — instead of opening N tabs: show each view, then `show` with " +
    "set:{label:'3 gamma views', ids:['v1','v2','v3']} (views already written this thread, " +
    "2–50) opens them as one tab; no kind/title/source on that call. A DASHBOARD is a report " +
    "with a layout: a ```facts block, body a JSON array (<=8) of {label, value, " +
    "tone?:'accent'|'amber'|'neutral'}, renders ONE header card (always full width, never " +
    "packed; a `facts` block inserted ahead of others renumbers them, so add it before pins are filed) — put it first. A ```stat tile also takes `series` (<=60 finite numbers — a longer series is trimmed to its most recent 60 — drawn as " +
    "a sparkline) and `delta` (one line under the figure, e.g. '+2 vs prior 30d'). Any ```view " +
    "or ```stat block's JSON may carry `width`:'half'|'third' (default 'full', stripped before " +
    "the block is otherwise parsed); consecutive blocks of the SAME width with no prose between " +
    "them pack side by side — two halves, three thirds. So: a ```facts header, a row of " +
    "```stat tiles with `series`/`delta` and `width`, then ```view blocks with " +
    "`width:'half'|'third'` for the charts beside them — reads as one scroll instead of a page " +
    "per number.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["show", "update"], description: "show = create/open; update = refresh an existing id." },
      scope: {
        type: "string",
        enum: VIEW_SCOPES,
        description:
          "Who owns the view: 'project' (the default for kind report — written into the project's repo too, so it outlives this thread and is listed under the project's reports) or 'thread' (the default for every other kind).",
      },
      set: {
        type: "object",
        description:
          "show only: {label, ids:[viewId…]} — open these already-shown views as ONE tab the user steps through (← → / [ ]) instead of N tabs. With `set`, kind/title/source are not needed.",
      },
      id: { type: "string", description: "View id ([A-Za-z0-9_-]). Omit on show to mint one; required on update." },
      kind: {
        type: "string",
        enum: ["table", "candles", "dist", "line", "bar", "timeline", "report"],
        description:
          "How the data renders: table (rows), candles (OHLC + markers), dist (pre-binned counts), line (series over time), bar (one value per category), timeline (price over a match + sized marks per moment + score steps), report (a .md file with ```view / ```stat blocks embedded).",
      },
      title: { type: "string", description: "A few plain words — the tab and toolbar name." },
      source: {
        type: "object",
        description: "{type:'file', path: relative JSON file in the thread cwd (report: a .md file)} or {type:'query', url: local backend, body?: JSON string → POST} (report: file only).",
      },
      columns: { type: "array", items: { type: "string" }, description: "table: column display order (subset of the row keys)." },
      keyColumn: { type: "string", description: "table: the column whose value identifies a row (pin anchors). Default: the first column." },
      markers: {
        type: "array",
        items: { type: "object" },
        description: "candles / line: [{ts: ISO time, label, id?}] — entry/exit marks on the nearest bar or point.",
      },
      series: {
        type: "array",
        items: { type: "string" },
        description: "line: the columns drawn as series (each numeric). Omit to draw every numeric non-time column.",
      },
      valueColumn: {
        type: "string",
        description: "bar / dist: the column holding each bar's value. Omit for count/n/value by name, else the first numeric column.",
      },
      sizeColumn: {
        type: "string",
        description: "timeline: the column a mark's radius comes from (size_z or count). Default size_z. Radii are clamped to a readable range.",
      },
      tone: {
        type: "string",
        enum: BAR_TONES,
        description:
          "bar / dist: the bars' colour. Omit for the default — 'sign' (--up/--dn) when the values are mixed, else 'neutral'.",
      },
      tones: {
        type: "array",
        items: { type: "object" },
        description:
          "table (<=6): [{column, tone:'sign'|'heat'}] — sign colours the cell text by the number's sign, heat tints the cell background toward --accent by the column's min–max position. Header cells are never tinted.",
      },
      definition: {
        type: "string",
        description: "The rule that defines the rows, in plain words (<= 600 chars). Shown under `spec`.",
      },
      filters: {
        type: "array",
        items: { type: "object" },
        description:
          "Up to 4 selectors over the view's own columns: [{column, kind:'select'|'date', label?}]. Values come from the loaded rows; the slice is client-side.",
      },
      controls: {
        type: "array",
        items: { type: "object" },
        description:
          "Up to 4 knobs that RE-READ the source with a different setting: [{name ([a-z][a-zA-Z0-9_]*, not 'key'), kind:'select'|'number'|'date', label?, default, options? (select: <=24, each <=60 chars) | min?, max?, step? (number)}]. The source path / url / body (and a panel's or the drill's) names each as {name}: a file value becomes one path component ([A-Za-z0-9._-], else _), a query url value is URL-encoded, a query body value is JSON-escaped; a number's plain form is at most 64 characters. Every {name} must be declared and every control used. Not on a report — declare them on its ```view blocks.",
      },
      seriesLabels: {
        type: "object",
        description:
          "line: legend labels by series column, plain words ({net_gamma:'net gamma ($bn)'}). Colour stays keyed on the column.",
      },
      regions: {
        type: "array",
        items: { type: "object" },
        description:
          "line: shaded time bands [{from: ISO, to: ISO, label?}] (<=12) — sessions, halts, regimes.",
      },
      panels: {
        type: "array",
        items: { type: "object" },
        description:
          "line only: small multiples [{title, source}] (<=6, {key} not allowed) — a 2-up grid with the main chart, shared time axis, shared value axis when the series sets match. Anchors/pins publish from the main chart only.",
      },
      levels: {
        type: "array",
        items: { type: "object" },
        description:
          "candles / line: horizontal levels [{price, label?, style?:'solid'|'dashed'|'zone', price2?}] (<=12) — flip, walls, zones. A zone is the band between price and price2. Label at the right edge.",
      },
      markerColumns: {
        type: "array",
        items: { type: "string" },
        description:
          "candles / line: columns whose non-null cells become markers at that row's time, labelled by the column name (entries/exits). Excluded from series inference.",
      },
      drill: {
        type: "object",
        description:
          "What is behind an opened row/bin/bar/marker: {kind, title, source:{type:'file', path:'per/{key}.json'} | {type:'query', url:'http://127.0.0.1:…?k={key}', body?}, columns?, keyColumn?, series?, valueColumn?, sizeColumn?, definition?, levels?, markers?, markerColumns?}. {key} = the anchor's key value (file: one path component, [A-Za-z0-9._-], else _; query url: URL-encoded; query body: JSON-escaped). A table with a drill is a DECK: the user steps its children with next/prev and notes each one.",
      },
    },
    // SWIT-79: kind/title/source are required for a VIEW and checked in code
    // (buildViewSpec) — a `set` call carries none of them.
    required: ["op"],
  },
};

// ── Cross-thread posts (SWIT-52) ─────────────────────────────────────────────
// A post lands in the TARGET thread's inbox.json. HONEST LIMIT, documented:
// inbox.json can be written by any thread's server plus the app (@thread) —
// concurrent appends are last-writer-wins over an atomic rename. Single user,
// sub-second windows; accepted over adding a lock file.

const POST_TEXT_CAP = 1000;
const INBOX_CAP = 100;
const POST_RATE_WINDOW_MS = 60_000;
const POST_RATE_MAX = 5;

/** Resolve `to` against the app's thread records: exact id first, else a
 *  case-insensitive title substring that matches EXACTLY ONE active thread.
 *  Ambiguity and misses are agent-readable errors naming the candidates. */
function resolvePostTarget(threads, query, selfId) {
  const q = String(query || "").trim();
  if (q.length === 0) throw new OpError("`to` must name a thread (a title fragment or id)");
  const active = threads.filter((t) => t && typeof t.id === "string" && !t.archivedAt);
  const byId = active.find((t) => t.id === q);
  if (byId) return byId;
  const needle = q.toLowerCase();
  const matches = active.filter(
    (t) => typeof t.title === "string" && t.title.toLowerCase().includes(needle)
  );
  const others = matches.filter((t) => t.id !== selfId);
  if (others.length === 1) return others[0];
  if (others.length === 0) {
    if (matches.length > 0) throw new OpError("that names THIS thread — a post cannot target itself");
    throw new OpError(`no thread matches "${q}"`);
  }
  throw new OpError(
    `"${q}" is ambiguous — matches: ${others.map((t) => `"${t.title}"`).join(", ")}. Be more specific.`
  );
}

/** Rate limit + append, pure over the raw inbox list. Returns the next list
 *  (newest kept, capped). */
function appendPost(list, post, now) {
  const posts = Array.isArray(list) ? list.filter((p) => p && typeof p === "object") : [];
  const recent = posts.filter(
    (p) =>
      p.fromId === post.fromId &&
      typeof p.at === "string" &&
      now - Date.parse(p.at) < POST_RATE_WINDOW_MS
  );
  if (recent.length >= POST_RATE_MAX) {
    throw new OpError(
      `rate limit: ${POST_RATE_MAX} posts to one thread per minute — batch what you have to say`
    );
  }
  return [...posts, post].slice(-INBOX_CAP);
}

function readThreadsFile(threadsJsonPath) {
  try {
    const data = JSON.parse(fs.readFileSync(threadsJsonPath, "utf-8"));
    return Array.isArray(data.threads) ? data.threads : [];
  } catch {
    return [];
  }
}

function performPostOp(env, args, now) {
  const { threadsRoot, threadsJsonPath, selfThreadId } = env;
  if (!threadsRoot || !threadsJsonPath) {
    throw new OpError("cross-thread posting is not wired in this session");
  }
  const kind = args.kind === "request" ? "request" : "update";
  const body = text(args.text, "text");
  if (body.length > POST_TEXT_CAP) {
    throw new OpError(`text too long (cap ${POST_TEXT_CAP}) — a post is a sentence or two`);
  }
  const threads = readThreadsFile(threadsJsonPath);
  const self = threads.find((t) => t && t.id === selfThreadId);
  const target = resolvePostTarget(threads, args.to, selfThreadId);
  const post = {
    id: `p${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    from: self && typeof self.title === "string" ? self.title : "another thread",
    fromId: selfThreadId || "",
    kind,
    text: body,
    at: new Date(now).toISOString(),
  };
  const dir = path.join(threadsRoot, target.id);
  const file = path.join(dir, "inbox.json");
  let existing = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    existing = Array.isArray(parsed) ? parsed : Array.isArray(parsed.posts) ? parsed.posts : [];
  } catch {
    // no inbox yet
  }
  const posts = appendPost(existing, post, now);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ posts }, null, 2));
  fs.renameSync(tmp, file);
  return {
    message:
      kind === "request"
        ? `Request posted to "${target.title}" — it lands under Needs You on their page and is typed into their terminal.`
        : `Update posted to "${target.title}" — it lands on their page and is typed into their terminal.`,
  };
}

const POST_TOOL = {
  name: "post",
  description:
    "Send an UPDATE or a REQUEST to another of the user's threads — only when the user asks " +
    "you to, or when work they asked for directly concerns that thread. A request lands under " +
    "Needs You on the target's page; an update lands in its What Happened — and either is " +
    "typed into the target terminal as a quoted reference its agent reads on its next turn. " +
    "Posts are never auto-forwarded: what the receiving agent does with it is its own call. " +
    "Name the target by a title fragment (unique match required). A post is a sentence or " +
    "two of plain language — not a report.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "The target thread: a title fragment (must match exactly one) or its id." },
      kind: { type: "string", enum: ["update", "request"], description: "request = needs the user/that thread to act; update = FYI." },
      text: { type: "string", description: "One or two plain sentences." },
    },
    required: ["to", "kind", "text"],
  },
};

// ── Backlog links (SWIT-64) ──────────────────────────────────────────────────
// The agent NEVER writes backlog.json — the app is that file's only writer.
// What a thread working a backlog item may do is RECORD the ticket key or
// spec path it created, and it does that by appending to an INBOX file the
// app drains on its 5s pass (take = rename away, so an append racing the
// drain lands in a fresh inbox; a re-emitted entry is folded idempotently —
// links are a set per item). The writer rule is per FILE and differs
// between the two: backlog.json has ONE writer, the app. The inbox has MANY
// APPENDERS — every live thread runs its own copy of this server — and ONE
// TAKER, so it is APPEND-ONLY NDJSON: one `appendFileSync` of one JSON line
// per link, no read-modify-write, no tmp file. (The first cut did
// read → write `.tmp` → rename with ONE shared tmp name, which is a lost
// update between any two threads linking at once. Review finding F3.) The
// app's parse is line-wise and a torn last line drops alone. The inbox path
// arrives by ENV like everything else here.

const BACKLOG_ITEM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BACKLOG_LINK_KINDS = ["ticket", "spec"];
/** Tighter than TEXT_CAP on purpose — a ticket key or a KB path, not prose —
 *  so the `ref too long` sentence below is a branch that can actually fire. */
const BACKLOG_REF_CAP = 300;

/** Validate + build one inbox entry. Pure; throws OpError with a sentence. */
function buildBacklogEntry(args, selfThreadId, now) {
  if (args.op !== "link") throw new OpError("`op` must be \"link\"");
  const itemId = String(args.itemId || "").trim();
  if (!BACKLOG_ITEM_ID_RE.test(itemId)) {
    throw new OpError("`itemId` must be the backlog item's id (letters, digits, - and _; ≤ 64) — it is in your spawn context");
  }
  const kind = args.kind;
  if (!BACKLOG_LINK_KINDS.includes(kind)) {
    throw new OpError(`\`kind\` must be one of ${BACKLOG_LINK_KINDS.join(" | ")}`);
  }
  const ref = text(args.ref, "ref");
  if (ref.length > BACKLOG_REF_CAP) {
    throw new OpError(`ref too long (cap ${BACKLOG_REF_CAP}) — a ticket key or a KB path`);
  }
  return {
    id: `bl${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    itemId,
    kind,
    ref,
    threadId: selfThreadId || "",
    at: new Date(now).toISOString(),
  };
}

/** The ONE inbox line an entry becomes: compact JSON + "\n". JSON.stringify
 *  escapes every newline inside a string, so a line is one entry by
 *  construction and the app's line-wise parse cannot be torn by content. */
function formatBacklogEntry(entry) {
  return `${JSON.stringify(entry)}\n`;
}

function performBacklogOp(env, args, now) {
  const { backlogInboxPath, selfThreadId } = env;
  if (!backlogInboxPath) throw new OpError("the backlog is not wired in this session");
  const entry = buildBacklogEntry(args, selfThreadId, now);
  fs.mkdirSync(path.dirname(backlogInboxPath), { recursive: true });
  // Append-only: one syscall, no read, no tmp — N threads may do this at once.
  fs.appendFileSync(backlogInboxPath, formatBacklogEntry(entry));
  return {
    message: `Queued: backlog item ${entry.itemId} → ${entry.kind} ${entry.ref}. The app applies it within a few seconds; the item's stage moves to ${entry.kind} if it was still a plain backlog item.`,
  };
}

const BACKLOG_TOOL = {
  name: "backlog",
  description:
    "Record that a BACKLOG ITEM now has a ticket or a spec. Use it ONLY when this thread was " +
    "opened from a backlog item (your spawn context names the item id) and you have actually " +
    "created the ticket (a Linear key like SWIT-64 or its URL) or the spec (a KB path). One op: " +
    "link {itemId, kind: ticket | spec, ref}. CONTRACT: this tool never writes the backlog " +
    "itself — it queues the link in an inbox file the app applies on its next pass and the " +
    "app alone rewrites backlog.json; re-sending the same link is harmless.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["link"] },
      itemId: { type: "string", description: "The backlog item's id, from your spawn context." },
      kind: { type: "string", enum: BACKLOG_LINK_KINDS, description: "ticket = a tracker issue; spec = a KB document." },
      ref: { type: "string", description: "The ticket key/URL or the spec's KB-relative path." },
    },
    required: ["op", "itemId", "kind", "ref"],
  },
};

// ── machine (SWIT-92): the Docker piece of the machine watcher ──────────────
// The watcher container (watcher/docker-watch.sh) writes containers.json and
// ledger.jsonl into SWITCHBOARD_MACHINE_DIR; this tool READS them and owns ONE
// write of its own, actions.jsonl (append-only NDJSON like the backlog inbox —
// every live thread runs a copy of this server). `stop` is the only thing here
// that touches Docker, and it is an explicit human-directed act: it runs
// `docker stop <name>` and records who asked.

const MACHINE_OPS = ["containers", "why", "stop"];
/** Docker's own container-name grammar: [a-zA-Z0-9][a-zA-Z0-9_.-]+ */
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MACHINE_LEDGER_TAIL = 12;

/** Pure: the containers of a snapshot in three lists. `running` is sorted
 *  CPU-first; `idle` is the running ones the idle rule applies to (traffic
 *  known, not skipped, quiet for ≥ idleMinutes); `stopped` is everything
 *  not running, restart-policy `always`/`unless-stopped` first because those
 *  come back on the next Docker start. */
function classifyContainers(rows, idleMinutes) {
  const running = rows.filter((r) => r.state === "running").sort((a, b) => (b.cpuPct || 0) - (a.cpuPct || 0));
  const idle = running.filter(
    (r) => r.trafficKnown && !r.skipped && typeof r.idleMinutes === "number" && r.idleMinutes >= idleMinutes
  );
  const comesBack = (r) => r.restart === "always" || r.restart === "unless-stopped";
  const stopped = rows
    .filter((r) => r.state !== "running")
    .sort((a, b) => Number(comesBack(b)) - Number(comesBack(a)) || String(a.name).localeCompare(String(b.name)));
  return { running, idle, stopped };
}

function idleWord(r) {
  if (!r.trafficKnown) return "traffic unknown";
  if (typeof r.idleMinutes !== "number") return "just seen";
  if (r.idleMinutes < 60) return `${r.idleMinutes}m quiet`;
  const h = Math.floor(r.idleMinutes / 60);
  return `${h}h ${r.idleMinutes - h * 60}m quiet`;
}

function containerLine(r) {
  const where = r.project ? ` · ${r.project}` : "";
  const restart = r.restart && r.restart !== "no" ? ` · restart ${r.restart}` : "";
  if (r.state !== "running") return `- ${r.name}${where}: ${r.state}${restart}`;
  const mem = r.memMb ? ` · ${Math.round(r.memMb)} MB` : "";
  const skip = r.skipped ? " · (skipped: its own reaper)" : "";
  const policy = r.policy ? ` · ${r.policy.toUpperCase()}` : "";
  return `- ${r.name}${where}: ${(r.cpuPct || 0).toFixed(1)}% cpu${mem} · ${idleWord(r)}${restart}${skip}${policy}`;
}

/** Pure: the `containers` answer. */
function formatContainers(snapshot, nowMs) {
  const { running, idle, stopped } = classifyContainers(snapshot.containers || [], snapshot.idleMinutes);
  const sampledMs = Date.parse(snapshot.sampledAt);
  const age = Number.isFinite(sampledMs) ? `${Math.max(0, Math.round((nowMs - sampledMs) / 60000))} min ago` : "age unknown";
  const held = Boolean(snapshot.holdUntil) && snapshot.holdUntil * 1000 > nowMs;
  const head = `Machine watcher snapshot from ${snapshot.sampledAt} (${age}) · idle rule ${snapshot.idleMinutes}m · ${snapshot.dryRun ? "DRY RUN — the rule logs, never stops" : "LIVE — the rule stops"}` +
    (held ? ` · HOLD until ${new Date(snapshot.holdUntil * 1000).toISOString()} (the clock is paused)` : "");
  const lines = [head, "", `Running (${running.length}, hottest first):`];
  lines.push(...(running.length ? running.map(containerLine) : ["- none"]));
  lines.push("", `Idle by the rule (${idle.length}):`);
  // During a real hold the watcher resets every clock, so this list is empty and
  // the "held" wording is defensive — it only shows for a snapshot written
  // before the hold began.
  const fate = held ? " — held, not stopped" : snapshot.dryRun ? " — would be stopped" : "";
  lines.push(...(idle.length ? idle.map((r) => `- ${r.name}: ${idleWord(r)}${fate}`) : ["- none"]));
  lines.push("", `Not running (${stopped.length}; restart always/unless-stopped come back with Docker):`);
  lines.push(...(stopped.length ? stopped.map(containerLine) : ["- none"]));
  lines.push("", "why {name} explains one; stop {name} stops one (recorded).");
  return lines.join("\n");
}

/** Pure: the `why` answer for one container + its ledger tail. */
function formatWhy(row, ledgerRows) {
  const lines = [`${row.name} — ${row.state}${row.project ? ` · compose project ${row.project}` : ""}${row.service ? ` · service ${row.service}` : ""}`];
  lines.push(`image ${row.image}`);
  if (row.workdir) lines.push(`started from ${row.workdir}`);
  if (row.startedAt && row.state === "running") lines.push(`up since ${String(row.startedAt).replace(/\.\d+Z$/, "Z")}`);
  if (row.restart && row.restart !== "no") {
    lines.push(`restart policy ${row.restart} — it comes back every time Docker starts; \`docker update --restart no ${row.name}\` ends that`);
  } else {
    lines.push("restart policy no — it stays down once stopped");
  }
  if (row.state === "running") {
    lines.push(`now: ${(row.cpuPct || 0).toFixed(1)}% cpu · ${Math.round(row.memMb || 0)} MB · ${idleWord(row)}${row.lastTrafficAt ? ` (last traffic ${row.lastTrafficAt})` : ""}`);
    if (row.skipped) lines.push("skipped by the idle rule: its own reaper owns it");
    if (row.policy) lines.push(`idle rule: ${row.policy.toUpperCase()}`);
  }
  if (ledgerRows.length) {
    lines.push("", `last ${ledgerRows.length} samples (cpu% · MB · bytes moved):`);
    lines.push(...ledgerRows.map((l) => `- ${l.at}: ${(l.cpuPct || 0).toFixed(1)} · ${Math.round(l.memMb || 0)} · ${l.movedBytes || 0}`));
  }
  return lines.join("\n");
}

function readMachineSnapshot(machineDir) {
  if (!machineDir) throw new OpError("the machine watcher is not wired in this session");
  const file = path.join(machineDir, "containers.json");
  if (!fs.existsSync(file)) {
    throw new OpError("the machine watcher has not written a snapshot yet — run `watcher/mw.sh ensure` in the switchboard repo");
  }
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    throw new OpError("containers.json is not readable JSON — the watcher may be mid-write; try again");
  }
  if (!snap || !Array.isArray(snap.containers)) throw new OpError("containers.json has no containers list");
  return snap;
}

/** The last N ledger lines for one name. Line-wise; a torn last line drops alone. */
function ledgerTailFor(machineDir, name, n) {
  const file = path.join(machineDir, "ledger.jsonl");
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row.name === name) out.push(row);
    } catch {
      /* torn line */
    }
  }
  return out.slice(-n);
}

function containerName(args) {
  const name = String(args.name || "").trim();
  if (!CONTAINER_NAME_RE.test(name)) throw new OpError("`name` must be a container name (letters, digits, _ . -)");
  return name;
}

/** deps.exec(file, args) runs a command; the test passes a fake. */
function performMachineOp(env, args, now, deps) {
  const exec = (deps && deps.exec) || ((file, argv) => require("child_process").execFileSync(file, argv, { encoding: "utf-8", timeout: 30000 }));
  const { machineDir, selfThreadId } = env;
  if (!MACHINE_OPS.includes(args.op)) throw new OpError(`\`op\` must be one of ${MACHINE_OPS.join(" | ")}`);
  const snap = readMachineSnapshot(machineDir);
  if (args.op === "containers") return { message: formatContainers(snap, now) };
  const name = containerName(args);
  const row = snap.containers.find((r) => r.name === name);
  if (args.op === "why") {
    if (!row) throw new OpError(`no container named ${name} in the last snapshot (${snap.sampledAt})`);
    return { message: formatWhy(row, ledgerTailFor(machineDir, name, MACHINE_LEDGER_TAIL)) };
  }
  // stop — nothing is recorded unless docker actually did it
  if (row && row.state !== "running") return { message: `${name} is already ${row.state}; nothing to stop.` };
  try {
    exec("docker", ["stop", name]);
  } catch (err) {
    if (err && err.code === "ENOENT") throw new OpError("docker is not on this app's PATH — stop it from a terminal (`docker stop " + name + "`)");
    const detail = String((err && err.stderr) || (err && err.message) || err).trim().split("\n").pop();
    throw new OpError(`docker stop ${name} failed: ${detail}`);
  }
  const entry = { at: new Date(now).toISOString(), name, action: "stopped", rule: "mcp stop", threadId: selfThreadId || "" };
  fs.mkdirSync(machineDir, { recursive: true });
  fs.appendFileSync(path.join(machineDir, "actions.jsonl"), `${JSON.stringify(entry)}\n`);
  const back = row && (row.restart === "always" || row.restart === "unless-stopped")
    ? ` Its restart policy is ${row.restart}, so it returns when Docker restarts — \`docker update --restart no ${name}\` if it should stay down.`
    : "";
  return { message: `Stopped ${name} and recorded it.${back}` };
}

const MACHINE_TOOL = {
  name: "machine",
  description:
    "The machine watcher (SWIT-92, Docker piece): what is running on this laptop's Docker, " +
    "how hot it is, how long since it moved real traffic, and why it is there. " +
    "Ops: containers (every container — running hottest first, the ones the idle rule would stop, " +
    "the stopped ones that come back with Docker); why {name} (image, compose project and folder, " +
    "restart policy, current load, last traffic, the last samples); stop {name} (runs `docker stop`, " +
    "records it). CONTRACT: the snapshot is written by the watcher container every minute — say " +
    "its age when it matters; the idle rule runs DRY by default and this tool never changes that; " +
    "`stop` is a human decision — ask before stopping anything that is not plainly abandoned.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: MACHINE_OPS },
      name: { type: "string", description: "The container name, for why and stop." },
    },
    required: ["op"],
  },
};

// ── job (SWIT-109): jobs that outlive the session ────────────────────────────
// A process claude starts is claude's child and dies with the session (the
// paper daemon that "died with the laptop session on Sep 10"). So this tool
// never starts anything: `start` / `stop` APPEND a request to the jobs inbox
// (SWITCHBOARD_JOBS_INBOX — append-only NDJSON, many appenders, one taker:
// the backlog inbox's pattern) and the APP, on its 5s pass, starts a detached
// wrapper that belongs to no session. `list` / `log` READ the app's files
// under SWITCHBOARD_JOBS_DIR (jobs.json + <id>/log.txt + <id>/exit.json);
// this server writes nothing there. The early checks below are courtesy —
// Rust holds every guard and a refusal comes back as one inbox line.

const JOB_OPS = ["start", "stop", "list", "log", "watch", "unwatch"];
/** Mirrors lib/jobs.ts + src-tauri/src/jobs.rs — change one, change all three. */
const JOB_NAME_RE = /^[A-Za-z0-9_.-]{1,48}$/;
const JOB_COMMAND_CAP = 2000;
const JOBS_RUNNING_PER_THREAD = 8;
const JOB_LOG_LINES_DEFAULT = 40;
const JOB_LOG_LINES_MAX = 400;
const JOB_ID_RE = /^[a-z0-9-]{1,40}$/;
/** SWIT-110 — mirrored in lib/jobs.ts + jobs.rs. */
const WATCH_EVERY_MIN = 5;
const WATCH_EVERY_MAX = 7 * 24 * 60;
const WATCHES_PER_THREAD = 8;

/** The app's watches.json (a READ — the app is its one writer). */
function readWatchesFile(jobsDir) {
  const file = path.join(jobsDir, "watches.json");
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, ""));
    return Array.isArray(data && data.watches) ? data.watches.filter((w) => w && typeof w.name === "string") : [];
  } catch {
    throw new OpError("the app's watches.json is unreadable right now — try again in a few seconds");
  }
}

/** THE state rule (lib/jobs.ts deriveJobState, jobs.rs derive_state). */
function jobState(rec, exit, alive) {
  if (exit) return "ended";
  if (typeof rec.stoppedAt === "number") return "stopped";
  if (typeof rec.lostAt === "number") return "lost";
  return alive ? "running" : "lost";
}

/** Is a pid alive? `process.kill(pid, 0)` signals nothing; EPERM means it
 *  exists. HONEST LIMIT: this cannot compare creation times the way the app
 *  does, so a pid recycled in the ≤ 5 s before the app stamps the job lost
 *  reads as running here — the app's page is the authority. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function readJobsIndex(jobsDir) {
  const file = path.join(jobsDir, "jobs.json");
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, ""));
    return Array.isArray(data && data.jobs) ? data.jobs.filter((j) => j && JOB_ID_RE.test(String(j.id))) : [];
  } catch {
    throw new OpError("the app's jobs.json is unreadable right now — try again in a few seconds");
  }
}

function readJobExit(jobDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(jobDir, "exit.json"), "utf-8").replace(/^\uFEFF/, ""));
    return { code: typeof v.code === "number" ? v.code : null, endedAt: typeof v.endedAt === "number" ? v.endedAt : null, timedOut: v.timedOut === true, error: typeof v.error === "string" ? v.error : null };
  } catch (err) {
    // A file that exists but does not parse still means the supervisor reached its last line.
    return err && err.code === "ENOENT" ? null : { code: null, endedAt: null, timedOut: false, error: null };
  }
}

/** The tail of one log file as lines (the last `maxBytes`, default 512 KB;
 *  a cut first line dropped). */
function readLogFileTail(file, maxBytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let t = buf.toString("utf-8").replace(/^\uFEFF/, "");
    if (size > len) t = t.slice(t.indexOf("\n") + 1);
    const lines = t.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The last `n` output lines of a job — log.1.txt's tail first when the
 *  current log is shorter (the runner rotated it). */
function jobLogTail(jobDir, n) {
  let lines = readLogFileTail(path.join(jobDir, "log.txt"));
  if (lines.length < n) lines = readLogFileTail(path.join(jobDir, "log.1.txt")).concat(lines);
  return lines.slice(-n);
}

/** Every record with its derived state + last line. `alive` injectable (tests). */
function jobRows(jobsDir, alive) {
  return readJobsIndex(jobsDir).map((rec) => {
    const dir = path.join(jobsDir, rec.id);
    const settled = typeof rec.stoppedAt === "number" || typeof rec.lostAt === "number";
    let exit = readJobExit(dir);
    const live = !exit && !settled ? alive(rec.pid) : false;
    if (!exit && !settled) exit = readJobExit(dir); // alive first, exit.json after — the app's order
    // The last line only needs the last 8 KB (as Rust reads it) — not a
    // 512 KB tail per record on every `list` (review M3).
    const lines = readLogFileTail(path.join(dir, "log.txt"), 8 * 1024);
    const last = lines[lines.length - 1] || readLogFileTail(path.join(dir, "log.1.txt"), 8 * 1024).pop() || "";
    return { ...rec, exit, state: jobState(rec, exit, live), lastLine: last.slice(0, 240) };
  });
}

function durationWords(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** One row's state in words, for `list` and `log`'s header. */
function jobStateWords(row, now) {
  const exit = row.exit;
  const endedAt = (exit && exit.endedAt) || row.stoppedAt || row.lostAt || row.startedAt;
  const ran = durationWords(endedAt - row.startedAt);
  const ago = durationWords(now - endedAt);
  switch (row.state) {
    case "running":
      return `running ${durationWords(now - row.startedAt)}`;
    case "stopped":
      return `stopped after ${ran} (${ago} ago)`;
    case "lost":
      return `lost — its process is gone with no exit code (noticed ${ago} ago)`;
    default:
      // Keyed on the supervisor's error, never on the code: a real program may exit -1 (review M2).
      if (exit && exit.error) return `could not start: ${exit.error}`;
      if (exit && exit.timedOut) return `timed out after ${ran} (${ago} ago)`;
      return `${exit && exit.code !== null ? `exit ${exit.code}` : "ended"} after ${ran} (${ago} ago)`;
  }
}

function jobName(args) {
  const name = String(args.name || "").trim();
  if (!JOB_NAME_RE.test(name)) throw new OpError("`name` must be 1–48 of A-Z a-z 0-9 _ . - (how you and the page will say which job)");
  return name;
}

/** Newest first; this thread's before any other's. A watch's runs carry the
 *  watch's name, so `log {watch name}` reads its latest run. */
function findJob(rows, name, selfThreadId) {
  const byName = rows.filter((r) => r.name === name).sort((a, b) => b.startedAt - a.startedAt);
  return byName.find((r) => r.threadId === selfThreadId) || byName[0] || null;
}

/** Validate + build one inbox request. Pure over `rows` (the current jobs)
 *  and `isDir`; throws OpError with a sentence the agent can act on. */
function buildJobRequest(args, env, rows, now, isDir, watches) {
  const op = args.op;
  const name = jobName(args);
  const allWatches = watches || [];
  const base = { id: `jr${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, op, threadId: env.selfThreadId || "", name, at: new Date(now).toISOString() };
  const running = rows.filter((r) => r.state === "running");
  if (op === "stop") {
    const mine = rows.filter((r) => r.name === name && r.threadId === env.selfThreadId);
    if (mine.length === 0) throw new OpError(`no job named ${name} in this thread`);
    if (!mine.some((r) => r.state === "running")) {
      throw new OpError(`job ${name} is already ${mine.sort((a, b) => b.startedAt - a.startedAt)[0].state}`);
    }
    return base;
  }
  if (op === "unwatch") {
    const w = allWatches.find((x) => x.name === name);
    if (!w || w.threadId !== env.selfThreadId) throw new OpError(`this thread has no watch named ${name}`);
    return base;
  }
  // start | watch
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) throw new OpError("`command` must be a non-empty string");
  if ([...command].length > JOB_COMMAND_CAP) throw new OpError(`command too long (cap ${JOB_COMMAND_CAP} characters) — put a long script in a file and run the file`);
  const cwdRaw = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : env.cwd;
  const cwd = path.resolve(env.cwd || ".", cwdRaw || ".");
  if (!isDir(cwd)) throw new OpError(`cwd is not an existing directory: ${cwd}`);
  if (op === "watch") {
    const every = args.every;
    if (!Number.isInteger(every) || every < WATCH_EVERY_MIN || every > WATCH_EVERY_MAX) {
      throw new OpError(`\`every\` must be a whole number of minutes, ${WATCH_EVERY_MIN}..${WATCH_EVERY_MAX}`);
    }
    const taken = allWatches.find((w) => w.name === name);
    if (taken && taken.threadId !== env.selfThreadId) throw new OpError(`another thread already watches ${name} — pick another name`);
    const mine = allWatches.filter((w) => w.threadId === env.selfThreadId && w.name !== name).length;
    if (mine >= WATCHES_PER_THREAD) throw new OpError(`this thread already has ${mine} watches (cap ${WATCHES_PER_THREAD})`);
    return { ...base, command, cwd, every };
  }
  if (running.some((r) => r.name === name && r.kind === "job")) throw new OpError(`a job named ${name} is already running — stop it first or pick another name`);
  const mineRunning = running.filter((r) => r.threadId === env.selfThreadId && r.kind === "job").length;
  if (mineRunning >= JOBS_RUNNING_PER_THREAD) throw new OpError(`this thread already has ${mineRunning} jobs running (cap ${JOBS_RUNNING_PER_THREAD})`);
  return { ...base, command, cwd };
}

function formatJobList(rows, selfThreadId, now, watches) {
  const mine = rows.filter((r) => r.threadId === selfThreadId && r.kind === "job");
  const myWatches = (watches || []).filter((w) => w.threadId === selfThreadId);
  const running = mine.filter((r) => r.state === "running").sort((a, b) => b.startedAt - a.startedAt);
  const settled = mine.filter((r) => r.state !== "running").sort((a, b) => b.startedAt - a.startedAt);
  if (mine.length === 0 && myWatches.length === 0) return "No jobs or watches in this thread. `start {name, command}` runs one the app owns; `watch {name, command, every}` checks one on a schedule.";
  const line = (r) => `- ${r.name} · ${jobStateWords(r, now)} · in ${r.cwd}${r.lastLine ? ` · last: ${r.lastLine}` : ""}`;
  const out = [];
  if (mine.length) {
    out.push(`Jobs of this thread (${running.length} running):`, ...running.map(line));
    if (settled.length) out.push("", "Ended:", ...settled.map(line));
  }
  if (myWatches.length) {
    if (out.length) out.push("");
    out.push(`Watches of this thread (${myWatches.length}):`);
    for (const w of myWatches) {
      const state = w.status === "fail" ? "FAILING" : w.status === "pass" ? "passing" : "not run yet";
      const ran = typeof w.lastRunAt === "number" ? ` · ran ${durationWords(now - w.lastRunAt)} ago` : "";
      out.push(`- ${w.name} · ${state} · every ${w.everyMin} min${ran}${w.lastLine ? ` · last: ${w.lastLine}` : ""}`);
    }
  }
  out.push("", "`log {name}` reads a job's (or a watch's latest run's) output.");
  return out.join("\n");
}

/** deps: {alive(pid), isDir(p)} — the test passes fakes. */
function performJobOp(env, args, now, deps) {
  const alive = (deps && deps.alive) || pidAlive;
  const isDir = (deps && deps.isDir) || ((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  if (!JOB_OPS.includes(args.op)) throw new OpError(`\`op\` must be one of ${JOB_OPS.join(" | ")}`);
  if (!env.jobsDir) throw new OpError("jobs are not wired in this session (an older app?)");
  const rows = jobRows(env.jobsDir, alive);
  const watches = args.op === "list" || args.op === "watch" || args.op === "unwatch" ? readWatchesFile(env.jobsDir) : [];
  if (args.op === "list") return { message: formatJobList(rows, env.selfThreadId, now, watches) };
  if (args.op === "log") {
    const name = jobName(args);
    const row = findJob(rows, name, env.selfThreadId);
    if (!row) throw new OpError(`no job named ${name}`);
    const asked = Number.isInteger(args.lines) ? args.lines : JOB_LOG_LINES_DEFAULT;
    const n = Math.min(Math.max(asked, 1), JOB_LOG_LINES_MAX);
    const lines = jobLogTail(path.join(env.jobsDir, row.id), n);
    const head = `job ${row.name} · ${jobStateWords(row, now)} · last ${lines.length} line${lines.length === 1 ? "" : "s"}:`;
    return { message: [head, ...(lines.length ? lines : ["(no output yet)"])].join("\n") };
  }
  if (!env.jobsInboxPath) throw new OpError("jobs are not wired in this session (an older app?)");
  // A request with no thread would be refused by the app after we said
  // "Queued" — refuse it here, where the agent can read why.
  if (!env.selfThreadId) throw new OpError("this session has no thread id, so the app cannot run a job for it");
  const entry = buildJobRequest(args, env, rows, now, isDir, watches);
  fs.mkdirSync(path.dirname(env.jobsInboxPath), { recursive: true });
  // Append-only: one syscall, no read, no tmp — every live thread may do this at once.
  fs.appendFileSync(env.jobsInboxPath, `${JSON.stringify(entry)}\n`);
  return {
    message:
      entry.op === "start"
        ? `Queued: the app starts ${entry.name} within ~5 s in ${entry.cwd}, detached — it outlives this session. \`list\` confirms it is running; \`log {name: "${entry.name}"}\` reads its output; one line arrives in this thread when it ends.`
        : entry.op === "watch"
          ? `Queued: the app runs ${entry.name} every ${entry.every} min while it is open (each run ≤ 120 s; exit 0 = passing). One line arrives in this thread when it starts failing and one when it recovers; a failing watch is on Home's Needs you.`
          : entry.op === "unwatch"
            ? `Queued: the app stops watching ${entry.name}.`
            : `Queued: the app stops ${entry.name} within ~5 s (its whole process tree); one line arrives in this thread when it has.`,
  };
}

const JOB_TOOL = {
  name: "job",
  description:
    "Run a long-lived command as a JOB that the Switchboard APP starts and owns — not a child of this " +
    "session, so it keeps running when this conversation ends, the terminal closes or claude restarts " +
    "(a reboot still ends it, and then it reads `lost`). Ops: start {name, command, cwd?} runs the " +
    "command in Windows PowerShell in cwd (default: this thread's working directory) with ALL its " +
    "output going to a log file — in the APP's environment, not this shell's (PATH and variables as " +
    "the app saw them when it launched; set anything else inside the command). It FAILS when it " +
    "exits non-zero, or when it raises any PowerShell error (a command not found, a missing file) " +
    "and sets no exit code of its own; a native program's stderr alone is output, not failure. " +
    "stop {name} ends its process tree — but a process that left the tree (something it started " +
    "detached, a Docker container, a service) keeps running; list shows this thread's " +
    "jobs as running / ended (exit code) / stopped / lost with each one's last output line; log " +
    "{name, lines?} prints the last lines of its output (default 40, max 400). CONTRACT: the app runs " +
    "it — start and stop are requests it acts on within ~5 s (`list` confirms, and a refusal comes " +
    "back as one line in this thread); it outlives the session; read its output with `log`, never by " +
    "attaching to it; when it ends exactly one line arrives in this thread (`job capture ended: exit " +
    "0 after 42 min`). Use a job for anything that must keep running — a daemon, a capture, a long " +
    "backfill — instead of backgrounding it yourself with `&` or Start-Process. WATCHES: watch {name, " +
    "command, every, cwd?} has the app run a short check every `every` minutes (≥ 5) while it is open " +
    "— each run is cut at 120 s, exit 0 is passing, anything else failing — and a failing watch is one " +
    "Needs-you row on Home plus ONE line in this thread when it starts failing (and one when it " +
    "recovers); unwatch {name} ends it. Watch what must keep happening (a capture still writing rows, " +
    "a feed still fresh), not what you are doing right now.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: JOB_OPS },
      name: { type: "string", description: "1–48 of A-Z a-z 0-9 _ . - ; unique among running jobs." },
      command: { type: "string", description: "start / watch: the PowerShell command line (≤ 2000 characters). Its exit code is the last native command's, or `exit N`." },
      cwd: { type: "string", description: "start / watch: the working directory (absolute, or relative to this thread's). Default: this thread's." },
      lines: { type: "integer", description: "log: how many lines (default 40, max 400)." },
      every: { type: "integer", description: "watch: minutes between runs (5 to 10080)." },
    },
    required: ["op"],
  },
};

// ── The tool table (the behavioural contract lives HERE) ─────────────────────

const PAGE_TOOL = {
  name: "page",
  description:
    "Write this thread's ✦ PAGE — the one surface the user reads (it renders beside your " +
    "terminal). After each turn of work, record what happened (op turn: 2–5 SHORT plain lines, " +
    "one clause each, that a " +
    "non-engineer follows — never restate what a section already shows; no file paths, code " +
    "names or hashes; a list is NEVER inside a " +
    "line, N things are N evidence rows; when the turn opened or produced more than one " +
    "thing, name reviewFirst — an evidence-style address the page prints as `start here`). " +
    "Keep Evidence current (op evidence: one row per " +
    "PR / ticket / doc / file with a plain label and a status; writing the same address " +
    "again UPDATES its row — omit status to keep the previous one; to point Eric at a page " +
    "state, write the address as surface:<project>/<page>?key=value, e.g. " +
    "surface:lodestar/trading?instrument=NQ&date=2026-06-05 — the row opens that page in that " +
    "state beside the thread). op drop_evidence {addresses} removes rows written against the " +
    "wrong thing (pass their addresses); use it instead of a second row labelled " +
    "\"superseded\". Track the plan with op " +
    "item (owner agent|user|team, state todo|in_progress|waiting|done; status changes go in " +
    "the item's state, never a new turn; items carry NO note — the story is a turn). itemOp " +
    "close = the work happened; itemOp drop = the row was never the right row (superseded, " +
    "another thread took it over, a 'later' bucket that should not have been filed) — dropped " +
    "rows leave the live plan and stay under Dropped. TIDY THE " +
    "PLAN EVERY TURN: close what finished, drop what no longer applies, retitle a row into " +
    "its replacement rather than adding a second one, never file a 'later' bucket row. " +
    "Something only the user can " +
    "answer: op ask (prefer 2–4 short options, each ≤ 60 chars, YOUR recommendation first or " +
    "named as default, plus why: one line on that recommendation) — it renders under Open " +
    "questions on the page, answerable in place. An option over 60 chars is CUT at a word " +
    "boundary with … (the result says which), so write short ones. The user can DISMISS a " +
    "question as not needed: it leaves the page and op read names it — do not wait on it, " +
    "and re-ask it (same id) only if the answer has come to matter. Answers arrive as ONE message when the user " +
    "sends — \"Decisions:\" numbering every open question with its answer or \"still open\" — " +
    "so never ask the same question twice (re-asking an open id replaces that question), and " +
    "do not re-ask a \"still open\" one; the user chose to leave it. Asking is HELP ME " +
    "HELP YOU: ask only when the answer changes the work; batch related questions into one " +
    "ask; always propose a default (one of the options — the user confirms it in one " +
    "click); say what kind of answer you need (kind decision | convention | info — a " +
    "convention is a standing rule the app records in the design conventions file, so " +
    "nobody has to state it twice). Every answer becomes an evidence row decision:<id> " +
    "with status decided — check Evidence for an existing decision: row BEFORE asking, and " +
    "reuse it instead of asking. op resolve {id, answer} closes a question YOU settled " +
    "(what settled it, or one line on why it went moot — status settled). AT THE END OF " +
    "EVERY TURN, resolve every question that is settled — answered in chat, decided " +
    "elsewhere, or moot — or it stays open forever; the page lists the open ones. Set op " +
    "theme once to one line saying what this thread is working on. Never open anything for " +
    "an answer — the page IS where your findings go. op show {address} PUTS AN EXISTING DOC " +
    "OR FILE IN FRONT OF THE USER: it opens in the panel beside the terminal, in front. Use " +
    "it when the user asks to open, show or see a doc or file \"in the panel\" — this is how a " +
    "file gets there; nothing is published anywhere. address is ONE of: a knowledge-base doc " +
    "path relative to the knowledge-base root (switchboard/features/x/requirements.md); a " +
    "file path relative to this thread's working directory (specs/design.md renders as a " +
    "document, mock.html as a page); surface:<project>/<page>?key=value; view:<id> (add " +
    "#h:<heading-slug> for a report heading); view:<project>/<id> for a report the project " +
    "owns (the view tool's result names it). A file that exists under your working " +
    "directory is always THAT file — a knowledge-base doc of the same path never shadows it. " +
    "A folder, a binary file or one over 512 KB is refused (the viewer renders text). " +
    "A ticket key or a URL opens nothing. The " +
    "result says when the address may not resolve — then nothing opens. The last 20 shows " +
    "are kept; a new report is made with the view tool (kind report), not this op. " +
    "KEEP THE BRIEF CURRENT — rewrite it at every seam (a finding lands, a decision is made, " +
    "the direction changes); it is what the user reads after days away. op brief {goal, " +
    "established, dead, lead, waiting} writes WHERE THINGS STAND, the first block on the " +
    "page: goal is ONE sentence (≤ 300 chars) on what this work is for; established (what " +
    "is now known), dead (what was tried and ruled out), lead (the live lead being chased) " +
    "and waiting (what is waiting on the user) are each ≤ 6 short plain lines (≤ 200 chars). " +
    "The brief is REPLACED WHOLE by every call — pass everything that still stands, not a " +
    "delta; goal: \"\" alone clears it. It is a summary, never a log: the story is a turn, " +
    "the detail a report. op read RETURNS THE PAGE as compact plain text (≤ 8000 chars) — " +
    "theme, the brief (always whole, never clipped), the open questions with their ids, the " +
    "ids of questions the user dismissed as not needed, the open items, the standing " +
    "decisions, the findings, the last three turns — and writes nothing; on a full page the " +
    "turns are cut first, then the lists. It is how you see your own page: call it FIRST when " +
    "you are resumed, and before you rewrite the brief. RECORD WHAT THE WORK ESTABLISHED as " +
    "op finding {claim, verdict, n?, report?} — the page's Findings ledger, the record that " +
    "outlives the thread: claim is ONE sentence (≤ 240 chars); verdict is lead (worth " +
    "chasing) | open (not settled) | fact (established) | dead (ruled out); n is the sample " +
    "it rests on in a few words (\"264 nights\", \"10 tests\"; ≤ 40); report is the address " +
    "of the report or view behind it (view:<id>, a doc or file path, surface:<project>/<page>) " +
    "and opens like an evidence row. Pass the finding's id (the result gives it) to UPDATE it " +
    "in place as the verdict moves — never file the same claim twice; fields you omit are " +
    "kept, n or report \"\" clears one; findingOp drop {id} removes one that was never right. " +
    "At most 60 per page. A finding is never an evidence row (finding:<id> is refused). " +
    "Findings whose id starts user- are the USER's (filed from a report in the panel, " +
    "marked \"filed by the user\" in op read): read them as their verdict, never update or drop them. " +
    "LANES: a lane is a named body of work inside this thread's project (e.g. \"Gamma model\"); " +
    "its brief is the newest brief any of its threads wrote, and its findings, reports and " +
    "decisions are what its threads recorded. op lane {name} puts THIS thread in a lane when it " +
    "has none — use an existing lane's name when the work belongs to it (≤ 48 chars: letters, " +
    "digits, spaces, - _ . , & + ' ( ) / : #); it is refused when the thread already has a lane " +
    "(only the user moves a thread between lanes), when the user took it out of one, or when its " +
    "folder is in no registry project. In a lane, op read also returns the lane — its brief, the " +
    "other threads' findings, the project reports built in the lane and the other threads' open " +
    "questions — and YOUR brief is the lane's brief: rewrite it WHOLE for the whole lane, never " +
    "for your corner of it.",
  inputSchema: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["theme", "turn", "evidence", "drop_evidence", "ask", "resolve", "item", "brief", "finding", "lane", "show", "read"],
        description: "Which page operation to perform.",
      },
      claim: {
        type: "string",
        description: "finding: ONE sentence (≤ 240 chars) saying what was found.",
      },
      name: {
        type: "string",
        description: "lane: the lane's name (≤ 48 chars) — an existing lane of this project when the work belongs to it.",
      },
      verdict: {
        type: "string",
        enum: ["lead", "open", "fact", "dead"],
        description: "finding: lead = worth chasing; open = not settled; fact = established; dead = ruled out.",
      },
      n: {
        type: "string",
        description: "finding: the sample the claim rests on, a few words (\"264 nights\", \"10 tests\"; ≤ 40). \"\" clears it.",
      },
      report: {
        type: "string",
        description: "finding: the address of the report behind it — view:<id>, a doc or file path, surface:<project>/<page> (≤ 300). \"\" clears it.",
      },
      findingOp: {
        type: "string",
        enum: ["drop"],
        description: "finding: drop removes the finding named by id. Omit to add (no id, or a new id) or update (an existing id).",
      },
      goal: {
        type: "string",
        description: "brief: ONE sentence (≤ 300 chars) on what this work is for.",
      },
      established: {
        type: "array",
        items: { type: "string" },
        description: "brief: what is now known — ≤ 6 short plain lines (≤ 200 chars each).",
      },
      dead: {
        type: "array",
        items: { type: "string" },
        description: "brief: what was tried and ruled out — ≤ 6 short plain lines.",
      },
      lead: {
        type: "array",
        items: { type: "string" },
        description: "brief: the live lead being chased — ≤ 6 short plain lines (usually one).",
      },
      waiting: {
        type: "array",
        items: { type: "string" },
        description: "brief: what is waiting on the user — ≤ 6 short plain lines.",
      },
      addresses: {
        type: "array",
        items: { type: "string" },
        description: "drop_evidence: the addresses of the rows to remove (≤ 20). Unknown addresses are ignored.",
      },
      text: { type: "string", description: "theme: the one-line theme. ask: the question." },
      why: {
        type: "string",
        description: "ask: ONE line (≤ 240 chars) on why your recommendation (the default, else the first option) is the one — shown beside the question.",
      },
      answer: {
        type: "string",
        description: "resolve: what settled the question — the answer the user gave in chat, or one line on why it no longer needs one.",
      },
      lines: {
        type: "array",
        items: { type: "string" },
        description: "turn: 2–5 short plain lines, one clause each, describing what just happened.",
      },
      reviewFirst: {
        type: "string",
        description:
          "turn: the ONE address to look at first (a ticket key, a doc/file path, surface:<project>/<page>?k=v, view:<id>). Name it when you open or produce more than one thing.",
      },
      address: {
        type: "string",
        description: "evidence: the row's address — a ticket key, `repo #pr`, a doc or file path, or a page state `surface:<project>/<page>?key=value`. The same address updates its row. show: what to open in the panel — a knowledge-base doc path, a file path in this thread's working directory, `surface:<project>/<page>?key=value` or `view:<id>[#h:<slug>]` (≤ 300 chars).",
      },
      label: { type: "string", description: "evidence: a plain few-word label." },
      status: {
        type: "string",
        description: "evidence: short status (open, merged, draft…). Omit to keep the previous one.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "ask: 2–4 short answer options, each ≤ 60 chars — a longer one is cut at a word boundary with … (free text is always possible).",
      },
      kind: {
        type: "string",
        enum: ["decision", "convention", "info"],
        description:
          "ask: what the answer is. decision (default) = a choice for this work; convention = a standing rule, recorded in the design conventions file by the app; info = a fact only the user knows.",
      },
      default: {
        type: "string",
        description: "ask: your proposal — must be one of options (matched after an over-long option is trimmed). Listed first and marked as the default; the user confirms it in one click.",
      },
      itemOp: {
        type: "string",
        enum: ["add", "update", "close", "drop"],
        description: "item: which item operation. close = done (the work happened); drop = never the right row (leaves the plan, not an accomplishment).",
      },
      id: { type: "string", description: "item update/close/drop: the item id. resolve: the question id. ask: optional stable question id. finding: the finding to update or drop (omit to add one)." },
      title: { type: "string", description: "item: a few plain words." },
      owner: { type: "string", enum: ["agent", "user", "team"], description: "item: who owns it." },
      state: { type: "string", enum: ["todo", "in_progress", "waiting", "done"], description: "item: its state." },
    },
    required: ["op"],
  },
};

// ── IO (the effectful shell) ─────────────────────────────────────────────────

function pagePathFor(threadDir) {
  return path.join(threadDir, "page.json");
}

/** Read-modify-write, atomic (tmp + rename): this process is page.json's only
 *  writer, so the read is always our own last write; the atomicity protects
 *  the APP's concurrent 2.5s reads from a torn file. */
function performOp(threadDir, args, now, env = null) {
  // SWIT-102: `show` is the one page op that does not touch page.json.
  if (args && args.op === "show") return performShowOp(threadDir, args, now).message;
  // SWIT-104: `read` writes nothing at all — it returns the page as text.
  if (args && args.op === "read") return performReadOp(threadDir, env);
  const file = pagePathFor(threadDir);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    // no page yet — the ordinary first-write state
  }
  // Answered question ids (READ-only — the app writes answers.json): what
  // makes the ask cap an OPEN-question cap.
  const answeredIds = new Set();
  const answers = readAppJson(threadDir, "answers.json", null);
  // no answers yet, or junk — every question counts as open
  if (answers && typeof answers === "object" && !Array.isArray(answers)) {
    for (const k of Object.keys(answers)) answeredIds.add(k);
  }
  // SWIT-105: the questions the user dismissed (READ-only — the app writes
  // retracted.json): off the page, so not counted against the ask cap.
  const current = parsePage(raw);
  const dismissedIds = dismissedQuestionIds(current, readAppJson(threadDir, "retracted.json", null));
  // SWIT-108: `lane` needs what the app's threads.json and the registry say
  // (read-only) — the thread's current lane, and whether it has a project.
  let laneCtx = args && (args.op === "lane" || args.op === "brief") ? laneContextFor(env) : null;
  if (laneCtx && args.op === "brief") laneCtx = { ...laneCtx, stamp: briefLaneStamp(laneCtx, current) };
  const { page, message } = applyOp(current, args, now, answeredIds, dismissedIds, laneCtx);
  fs.mkdirSync(threadDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(page, null, 2));
  fs.renameSync(tmp, file);
  return message;
}

// ── Liveness record (SWIT-113) ──────────────────────────────────────────────
// The app cannot see whether claude still has this server: a model switch or
// a disconnect drops the tools mid-session and nothing said so. So the server
// writes `mcp.json` in the thread dir when it starts — its pid and start time —
// and stamps `endedAt` when its input closes. The app checks the pid (with
// the process's own creation time, so a recycled pid never counts) on its 5s
// pass and says `page tools dropped` when the server is gone while the thread
// is live. A reconnect (`/mcp` in claude) starts a new server, which rewrites
// the file, and the warning clears. This file has ONE writer at a time: the
// newest server; an older one ending marks it only while it is still its own.

const MCP_RECORD = "mcp.json";

function mcpRecordPath(threadDir) {
  return path.join(threadDir, MCP_RECORD);
}

/** Write this server's record. Best effort: a liveness file that cannot be
 *  written must never stop the tools from serving. */
function writeMcpRecord(threadDir, record) {
  try {
    fs.mkdirSync(threadDir, { recursive: true });
    writeJsonAtomic(mcpRecordPath(threadDir), record);
  } catch {
    // the app reads a missing record as "no claim"
  }
}

function startMcpRecord(threadDir, pid = process.pid, now = Date.now()) {
  const record = { version: 1, pid, startedAt: now };
  writeMcpRecord(threadDir, record);
  return record;
}

/** Stamp `endedAt` — only while the record is still THIS server's (a newer
 *  server after a reconnect owns the file; an old one ending must not mark
 *  it). Returns whether it wrote. */
function endMcpRecord(threadDir, pid = process.pid, now = Date.now()) {
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(mcpRecordPath(threadDir), "utf-8"));
  } catch {
    return false;
  }
  if (!current || current.pid !== pid || typeof current.endedAt === "number") return false;
  writeMcpRecord(threadDir, { ...current, endedAt: now });
  return true;
}

// ── MCP over stdio (newline-delimited JSON-RPC) ──────────────────────────────

/** Put this server's record back when another took it over (a second,
 *  short-lived server for the same thread rewrites the file and may stamp it
 *  ended). The app waits DROP_AFTER_MS (30s) before it believes an end, so a
 *  re-assert every MCP_REASSERT_MS keeps a live server from reading dropped.
 *  Returns whether it wrote. */
function reassertMcpRecord(threadDir, record) {
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(mcpRecordPath(threadDir), "utf-8"));
  } catch {
    // missing or torn — write ours
  }
  if (current && current.pid === record.pid && typeof current.endedAt !== "number") return false;
  writeMcpRecord(threadDir, record);
  return true;
}

const MCP_REASSERT_MS = 20_000;

function serve(threadDir) {
  const mcpRecord = startMcpRecord(threadDir);
  setInterval(() => reassertMcpRecord(threadDir, mcpRecord), MCP_REASSERT_MS).unref();
  const respond = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

  let buffer = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not ours to crash over
      }
      handle(msg);
    }
  });
  process.stdin.on("end", () => {
    endMcpRecord(threadDir);
    process.exit(0);
  });

  function handle(msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    try {
      if (method === "initialize") {
        respond({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion:
              params && typeof params.protocolVersion === "string"
                ? params.protocolVersion
                : "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "switchboard", version: "1.0.0" },
          },
        });
        return;
      }
      if (method === "notifications/initialized" || (typeof method === "string" && method.startsWith("notifications/"))) {
        return; // notifications need no reply
      }
      if (method === "ping") {
        respond({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (method === "tools/list") {
        respond({ jsonrpc: "2.0", id, result: { tools: [PAGE_TOOL, VIEW_TOOL, POST_TOOL, BACKLOG_TOOL, MACHINE_TOOL, JOB_TOOL] } });
        return;
      }
      if (method === "tools/call") {
        const name = params && params.name;
        if (name !== "page" && name !== "view" && name !== "post" && name !== "backlog" && name !== "machine" && name !== "job") {
          respond({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `unknown tool: ${name}` },
          });
          return;
        }
        try {
          const args = (params && params.arguments) || {};
          const message =
            name === "view"
              ? performViewOp(threadDir, args, Date.now(), {
                  cwd: process.cwd(),
                  threadId: process.env.SWITCHBOARD_THREAD_ID || "",
                  registryPath: process.env.SWITCHBOARD_REGISTRY,
                  threadsJsonPath: process.env.SWITCHBOARD_THREADS_JSON,
                }).message
              : name === "backlog"
                ? performBacklogOp(
                    {
                      backlogInboxPath: process.env.SWITCHBOARD_BACKLOG_INBOX,
                      selfThreadId: process.env.SWITCHBOARD_THREAD_ID,
                    },
                    args,
                    Date.now()
                  ).message
              : name === "job"
                ? performJobOp(
                    {
                      jobsInboxPath: process.env.SWITCHBOARD_JOBS_INBOX,
                      jobsDir: process.env.SWITCHBOARD_JOBS_DIR,
                      selfThreadId: process.env.SWITCHBOARD_THREAD_ID,
                      cwd: process.cwd(),
                    },
                    args,
                    Date.now()
                  ).message
              : name === "machine"
                ? performMachineOp(
                    {
                      machineDir: process.env.SWITCHBOARD_MACHINE_DIR,
                      selfThreadId: process.env.SWITCHBOARD_THREAD_ID,
                    },
                    args,
                    Date.now()
                  ).message
              : name === "post"
                ? performPostOp(
                    {
                      threadsRoot: process.env.SWITCHBOARD_THREADS_ROOT,
                      threadsJsonPath: process.env.SWITCHBOARD_THREADS_JSON,
                      selfThreadId: process.env.SWITCHBOARD_THREAD_ID,
                    },
                    args,
                    Date.now()
                  ).message
                : performOp(threadDir, args, Date.now(), {
                    threadsRoot: process.env.SWITCHBOARD_THREADS_ROOT,
                    threadsJsonPath: process.env.SWITCHBOARD_THREADS_JSON,
                    selfThreadId: process.env.SWITCHBOARD_THREAD_ID,
                    registryPath: process.env.SWITCHBOARD_REGISTRY,
                    cwd: process.cwd(),
                  });
          respond({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: message }], isError: false },
          });
        } catch (err) {
          // A VALIDATION failure is a tool RESULT with isError — the agent
          // reads it and corrects; a protocol error would just look broken.
          respond({
            jsonrpc: "2.0",
            id,
            result: {
              // `machine` mostly reads; "write refused" would misname a missing snapshot.
              content: [{ type: "text", text: name === "machine" || name === "job" ? `${name}: ${err.message}` : `${name} write refused: ${err.message}` }],
              isError: true,
            },
          });
        }
        return;
      }
      if (isRequest) {
        respond({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    } catch (err) {
      if (isRequest) {
        respond({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err && err.message) } });
      }
    }
  }
}

// ── Entry ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const threadDir = process.env.SWITCHBOARD_THREAD_DIR;
  if (!threadDir || threadDir.length === 0) {
    process.stderr.write("switchboard-mcp: SWITCHBOARD_THREAD_DIR is not set\n");
    process.exit(1);
  }
  serve(threadDir);
}

module.exports = {
  isLocalBackendUrl,
  startMcpRecord,
  endMcpRecord,
  reassertMcpRecord,
  MCP_REASSERT_MS,
  MCP_RECORD,
  CONTROL_CAP,
  CONTROL_KINDS,
  CONTROL_OPTION_CAP,
  CONTROL_OPTION_LEN,
  CONTROL_LABEL_CAP,
  CONTROL_NAME_RE,
  RESERVED_CONTROL_NAMES,
  CONTROL_VALUE_CAP,
  formatControlNumber,
  VIEW_DEFINITION_CAP,
  VIEW_FILTER_CAP,
  VIEW_FILTER_KINDS,
  VIEW_REGION_CAP,
  VIEW_PANEL_CAP,
  VIEW_SERIES_LABEL_CAP,
  VIEW_LEVEL_CAP,
  BAR_TONES,
  TABLE_TONE_KINDS,
  TABLE_TONES_CAP,
  TABLE_TONE_COLUMN_CAP,
  parsePage,
  applyOp,
  performOp,
  formatPageRead,
  performReadOp,
  readLaneRollup,
  normalizeLaneName,
  laneNameKey,
  LANE_NAME_CAP,
  LANE_READ_THREADS,
  trimOption,
  dismissedQuestionIds,
  OPTION_CAP,
  FINDING_VERDICTS,
  FINDING_CAP,
  FINDING_CLAIM_CAP,
  FINDING_N_CAP,
  FINDING_REPORT_CAP,
  BRIEF_GOAL_CAP,
  BRIEF_LINE_CAP,
  BRIEF_LINES_CAP,
  READ_CAP,
  normalizeShowAddress,
  performShowOp,
  SHOW_CAP,
  SHOW_ADDRESS_CAP,
  SHOW_READ_CAP,
  surfaceQueryOk,
  inspectPath,
  buildViewSpec,
  buildViewSet,
  performViewOp,
  readRegistryProjects,
  projectPlaceFor,
  projectViewAddress,
  PROJECT_VIEW_INDEX_CAP,
  VIEW_SCOPES,
  SET_CAP,
  SET_ITEM_CAP,
  resolvePostTarget,
  appendPost,
  performPostOp,
  buildBacklogEntry,
  formatBacklogEntry,
  performBacklogOp,
  classifyContainers,
  formatContainers,
  formatWhy,
  performMachineOp,
  MACHINE_TOOL,
  JOB_TOOL,
  JOB_OPS,
  jobState,
  jobRows,
  readWatchesFile,
  WATCH_EVERY_MIN,
  WATCHES_PER_THREAD,
  jobLogTail,
  buildJobRequest,
  performJobOp,
  formatJobList,
  JOB_COMMAND_CAP,
  JOBS_RUNNING_PER_THREAD,
  JOB_LOG_LINES_MAX,
  BACKLOG_TOOL,
  POST_TOOL,
  PAGE_TOOL,
  VIEW_TOOL,
  OpError,
  QUESTION_KINDS,
  NO_NOTE,
  DROP_EVIDENCE_CAP,
  WHY_CAP,
  TURN_CAP,
  TURN_LINE_CAP,
  EVIDENCE_CAP,
  QUESTION_CAP,
  QUESTION_KEEP_CAP,
};
