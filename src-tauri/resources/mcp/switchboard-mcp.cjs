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
// page.json, and (SWIT-64) ONE OF MANY APPENDERS to the app-wide
// backlog-inbox.json — an append-only NDJSON file with one taker (the app),
// never of backlog.json, which the app alone rewrites after draining the
// inbox (the app writes answers.json / inbox.json; the rendered page is
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
const QUESTION_CAP = 20;
const TEXT_CAP = 500; // any single text field — a page line is a sentence, not a document
const OPTION_CAP = 60; // an ask option is a short choice, not a paragraph (SWIT-69)
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
  "page item: items carry no note — put status in the item's links/state and the story in a turn (op turn)";
/** SWIT-78 (Ky's CC-704): `drop_evidence` names at most this many rows at
 *  once — a correction, not a bulk wipe. */
const DROP_EVIDENCE_CAP = 20;
/** SWIT-78 (Ky's plan tool): the states an item may be SET to. `dropped` is
 *  reached only through itemOp drop — the distinction from close (done) is
 *  the point, so it is never a value you can slip into an update. */
const ITEM_STATES = ["todo", "in_progress", "waiting", "done"];

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
  return {
    theme: typeof data.theme === "string" && data.theme.length > 0 ? data.theme : null,
    turns: Array.isArray(data.turns) ? data.turns : [],
    evidence: Array.isArray(data.evidence) ? data.evidence : [],
    questions: Array.isArray(data.questions) ? data.questions : [],
    items: Array.isArray(data.items) ? data.items : [],
  };
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
function applyOp(page, args, now, answeredIds = new Set()) {
  const at = new Date(now).toISOString();
  const op = args && args.op;
  // SWIT-77: a question is SETTLED by the user's answer (answers.json, the
  // app's file, read-only here) OR by the agent's own `resolve` (answeredAt
  // on the question in this file). Both close it for the cap and for the
  // re-ask refusal.
  const settled = (q) =>
    !!q && (answeredIds.has(q.id) || (typeof q.answeredAt === "string" && q.answeredAt.length > 0));
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
      const options = Array.isArray(args.options)
        ? args.options
            .filter((o) => typeof o === "string" && o.trim().length > 0)
            .map((o) => {
              const opt = text(o, "an option");
              // SWIT-69: an option is a SHORT choice — long ones wrap into
              // paragraphs the multiple-choice list cannot carry.
              if (opt.length > OPTION_CAP) {
                throw new OpError(`an option is too long (${opt.length} chars; the cap is ${OPTION_CAP}) — keep options short; detail belongs in the question text`);
              }
              return opt;
            })
            .slice(0, 6)
        : [];
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
        dflt = args.default.trim();
        if (!options.includes(dflt)) {
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
        return {
          page: { ...page, questions },
          message: `Question ${id} replaced on the page (superseded). ${arrives}`,
        };
      }
      const open = page.questions.filter((q) => q && !settled(q)).length;
      if (open >= QUESTION_CAP) {
        throw new OpError(`${QUESTION_CAP} questions are already OPEN on the page — wait for answers before asking more`);
      }
      const questions = [asked, ...page.questions];
      return {
        page: { ...page, questions },
        message: `Question ${id} recorded on the page. ${arrives} Do not ask it again.`,
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
      const stillOpen = questions.filter((q) => q && !settled(q)).length;
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
    default:
      throw new OpError('op must be one of "theme", "turn", "evidence", "drop_evidence", "ask", "resolve", "item"');
  }
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
  const fill = (v) => (typeof v === "string" ? v.split("{key}").join("k") : v);
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
 *  carry `{key}`. Pure. */
function buildDrill(raw) {
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
function buildPanels(raw, kind) {
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
  }
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
  const drill = buildDrill(args.drill);
  if (drill !== undefined) spec.drill = drill;
  // SWIT-70: the line kind's story fields.
  const seriesLabels = buildSeriesLabels(args.seriesLabels);
  if (seriesLabels !== undefined) spec.seriesLabels = seriesLabels;
  const regions = buildRegions(args.regions);
  if (regions !== undefined) spec.regions = regions;
  const panels = buildPanels(args.panels, kind);
  if (panels !== undefined) spec.panels = panels;
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

function performViewOp(threadDir, args, now) {
  const viewsDir = path.join(threadDir, "views");
  const existing = listViewIds(viewsDir);
  if (args.op === "update") {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!existing.includes(id)) {
      throw new OpError(`no view with id ${id} — use op "show" to create one`);
    }
  } else if (args.op !== "show") {
    throw new OpError('op must be "show" or "update"');
  }
  const spec = buildViewSpec(args, existing, now);
  fs.mkdirSync(viewsDir, { recursive: true });
  const file = path.join(viewsDir, `${spec.id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(spec, null, 2));
  fs.renameSync(tmp, file);
  return {
    spec,
    message:
      args.op === "update"
        ? `View ${spec.id} updated — the open tab re-renders within a couple of seconds.`
        : `View ${spec.id} is opening in the panel beside the terminal. Update it later with op "update" and the same id.`,
  };
}

const VIEW_TOOL = {
  name: "view",
  description:
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
    "row for pins). For candles pass markers [{ts, label, id?}] for entries/exits. " +
    "line: rows {time|ts, <series>…} over one time axis — pass `series` (column names) or every " +
    "numeric non-time column is drawn; markers apply as on candles. bar: one row per category " +
    "{<keyColumn>, <valueColumn>} — pass keyColumn and valueColumn (else count/n/value by name). " +
    "dist is the same shape, pre-binned. timeline: one row per moment {ts, price (0-100, the " +
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
    "as _; in a query url it is URL-encoded) — opening a row then shows the child beside " +
    "the terminal with back. Declare `filters` [{column, kind:'select'|'date'}] so the " +
    "user can slice the loaded rows themselves without asking you. Prefer ONE line view " +
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
    '{label, value, n?} (or an array of them) renders stat tiles — e.g. ```view\\n' +
    '{"kind":"line","title":"net gamma","source":{"type":"file","path":".sb-views/gamma.json"}}\\n```. ' +
    "Blocks are validated when drawn — a broken block shows an error card in place and the " +
    "rest of the report renders; at most 24 view/stat blocks render live, the rest as plain " +
    "code. op 'update' re-renders the open report (every block reloads " +
    "its data); the markdown itself is re-read while the tab is active. A report's headings " +
    "are addressable from page evidence as view:<id>#h:<heading-slug>. Prefer one report over " +
    "several views when narrative belongs between the charts. THE REVIEW LOOP (a deck): a " +
    "table with a drill is a deck the user steps through with next/prev in the panel; give the " +
    "drill `levels` [{price, label?, style?:'solid'|'dashed'|'zone', price2?}] (<=12; a zone is " +
    "the band between price and price2) for horizontal levels, and `markerColumns` " +
    "['entry','exit'] so a sparse column's non-null cells become markers at that row's time " +
    "(labelled by the column name; those columns are never drawn as series) — never encode a " +
    "level as a constant column or an entry as a series. The user writes a one-line note per " +
    "card, autosaved to `<deck dir>/notes.json` beside the deck's index file (Read it: " +
    "{version:1, notes:{[key]:{text, updatedAt, sentAt?}}}), and `send N notes` delivers every " +
    "unsent note to you as ONE message: `Chart notes on <title> (N):` then `- <key>: <note>` " +
    "per line.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["show", "update"], description: "show = create/open; update = refresh an existing id." },
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
          "What is behind an opened row/bin/bar/marker: {kind, title, source:{type:'file', path:'per/{key}.json'} | {type:'query', url:'http://127.0.0.1:…?k={key}', body?}, columns?, keyColumn?, series?, valueColumn?, sizeColumn?, definition?, levels?, markers?, markerColumns?}. {key} = the anchor's key value (file: one path component, [A-Za-z0-9._-], else _; query: URL-encoded). A table with a drill is a DECK: the user steps its children with next/prev and notes each one.",
      },
    },
    required: ["op", "kind", "title", "source"],
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
    "questions on the page, answerable in place. Answers arrive as ONE message when the user " +
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
    "an answer — the page IS where your findings go.",
  inputSchema: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["theme", "turn", "evidence", "drop_evidence", "ask", "resolve", "item"],
        description: "Which page operation to perform.",
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
        description: "evidence: the row's address — a ticket key, `repo #pr`, a doc or file path, or a page state `surface:<project>/<page>?key=value`. The same address updates its row.",
      },
      label: { type: "string", description: "evidence: a plain few-word label." },
      status: {
        type: "string",
        description: "evidence: short status (open, merged, draft…). Omit to keep the previous one.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "ask: 2–4 short answer options, each ≤ 60 chars (free text is always possible).",
      },
      kind: {
        type: "string",
        enum: ["decision", "convention", "info"],
        description:
          "ask: what the answer is. decision (default) = a choice for this work; convention = a standing rule, recorded in the design conventions file by the app; info = a fact only the user knows.",
      },
      default: {
        type: "string",
        description: "ask: your proposal — must be one of options. Listed first and marked as the default; the user confirms it in one click.",
      },
      itemOp: {
        type: "string",
        enum: ["add", "update", "close", "drop"],
        description: "item: which item operation. close = done (the work happened); drop = never the right row (leaves the plan, not an accomplishment).",
      },
      id: { type: "string", description: "item update/close/drop: the item id. resolve: the question id. ask: optional stable question id." },
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
function performOp(threadDir, args, now) {
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
  try {
    const answers = JSON.parse(fs.readFileSync(path.join(threadDir, "answers.json"), "utf-8"));
    if (answers && typeof answers === "object" && !Array.isArray(answers)) {
      for (const k of Object.keys(answers)) answeredIds.add(k);
    }
  } catch {
    // no answers yet, or junk — every question counts as open
  }
  const { page, message } = applyOp(parsePage(raw), args, now, answeredIds);
  fs.mkdirSync(threadDir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(page, null, 2));
  fs.renameSync(tmp, file);
  return message;
}

// ── MCP over stdio (newline-delimited JSON-RPC) ──────────────────────────────

function serve(threadDir) {
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
  process.stdin.on("end", () => process.exit(0));

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
        respond({ jsonrpc: "2.0", id, result: { tools: [PAGE_TOOL, VIEW_TOOL, POST_TOOL, BACKLOG_TOOL] } });
        return;
      }
      if (method === "tools/call") {
        const name = params && params.name;
        if (name !== "page" && name !== "view" && name !== "post" && name !== "backlog") {
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
              ? performViewOp(threadDir, args, Date.now()).message
              : name === "backlog"
                ? performBacklogOp(
                    {
                      backlogInboxPath: process.env.SWITCHBOARD_BACKLOG_INBOX,
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
                : performOp(threadDir, args, Date.now());
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
              content: [{ type: "text", text: `${name} write refused: ${err.message}` }],
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
  VIEW_DEFINITION_CAP,
  VIEW_FILTER_CAP,
  VIEW_FILTER_KINDS,
  VIEW_REGION_CAP,
  VIEW_PANEL_CAP,
  VIEW_SERIES_LABEL_CAP,
  VIEW_LEVEL_CAP,
  parsePage,
  applyOp,
  performOp,
  buildViewSpec,
  performViewOp,
  resolvePostTarget,
  appendPost,
  performPostOp,
  buildBacklogEntry,
  formatBacklogEntry,
  performBacklogOp,
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
};
