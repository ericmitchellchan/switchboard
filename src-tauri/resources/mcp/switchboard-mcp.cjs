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
// page.json (the app writes answers.json / inbox.json; the rendered page is
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
    const m = typeof entry.id === "string" && entry.id.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `${prefix}${n + 1}`;
}

/** Apply ONE page op. Returns { page, message } (message = what to tell the
 *  agent, including enforced-cap notes); throws OpError on invalid input —
 *  visible to the agent, never a silent drop. Pure: `now` injected. */
function applyOp(page, args, now) {
  const at = new Date(now).toISOString();
  const op = args && args.op;
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
      const turns = [{ at, lines: kept }, ...page.turns].slice(0, TURN_CAP);
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
    case "ask": {
      const t = text(args.text, "text");
      const open = page.questions.length;
      if (open >= QUESTION_CAP) {
        throw new OpError(`the page already holds ${QUESTION_CAP} questions — wait for answers before asking more`);
      }
      const options = Array.isArray(args.options)
        ? args.options
            .filter((o) => typeof o === "string" && o.trim().length > 0)
            .map((o) => text(o, "an option"))
            .slice(0, 6)
        : [];
      const id = typeof args.id === "string" && args.id.trim().length > 0
        ? args.id.trim()
        : nextId(page.questions, "q");
      if (page.questions.some((q) => q && q.id === id)) {
        throw new OpError(`a question with id ${id} already exists — do not ask a question twice`);
      }
      const questions = [{ id, text: t, options, askedAt: at }, ...page.questions];
      return {
        page: { ...page, questions },
        message: `Question ${id} recorded on the page. Wait for the user's answer — it arrives as their next message. Do not ask it again.`,
      };
    }
    case "item": {
      const itemOp = args.itemOp;
      if (itemOp === "add") {
        const title = text(args.title, "title");
        const owner = args.owner === "user" || args.owner === "team" ? args.owner : "agent";
        const state =
          args.state === "in_progress" || args.state === "waiting" || args.state === "done"
            ? args.state
            : "todo";
        const id = nextId(page.items, "i");
        const note =
          typeof args.note === "string" && args.note.trim().length > 0
            ? text(args.note, "note")
            : null;
        return {
          page: { ...page, items: [...page.items, { id, title, owner, state, note }] },
          message: `Item ${id} added.`,
        };
      }
      if (itemOp === "update" || itemOp === "close") {
        const id = text(args.id, "id");
        const index = page.items.findIndex((i) => i && i.id === id);
        if (index < 0) throw new OpError(`no item with id ${id}`);
        const prev = page.items[index];
        const nextItem = { ...prev };
        if (itemOp === "close") {
          nextItem.state = "done";
        } else {
          if (typeof args.title === "string") nextItem.title = text(args.title, "title");
          if (args.owner === "agent" || args.owner === "user" || args.owner === "team") {
            nextItem.owner = args.owner;
          }
          if (
            args.state === "todo" ||
            args.state === "in_progress" ||
            args.state === "waiting" ||
            args.state === "done"
          ) {
            nextItem.state = args.state;
          }
          if (typeof args.note === "string") {
            nextItem.note = args.note.trim().length > 0 ? text(args.note, "note") : null;
          }
        }
        const items = page.items.map((i, j) => (j === index ? nextItem : i));
        return {
          page: { ...page, items },
          message: itemOp === "close" ? `Item ${id} closed.` : `Item ${id} updated.`,
        };
      }
      throw new OpError('itemOp must be "add", "update" or "close"');
    }
    default:
      throw new OpError('op must be one of "theme", "turn", "evidence", "ask", "item"');
  }
}

// ── Views (SWIT-50) — a rendered dataset the shell draws ─────────────────────

const VIEW_KINDS = ["table", "candles", "dist"];
const VIEW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VIEW_MARKER_CAP = 200;

function validViewSourcePath(p) {
  if (typeof p !== "string" || p.trim().length === 0) return false;
  // Relative, inside the thread's working dir — the shell re-validates with
  // canonicalized containment; this is the friendly early error.
  if (p.includes("..")) return false;
  if (/^[A-Za-z]:/.test(p) || p.startsWith("/") || p.startsWith("\\")) return false;
  return true;
}

/** Validate + normalize a view op into the spec the shell renders. Pure;
 *  throws OpError with agent-readable messages. */
function buildViewSpec(args, existingIds, now) {
  const kind = args.kind;
  if (!VIEW_KINDS.includes(kind)) {
    throw new OpError(`kind must be one of ${VIEW_KINDS.join(", ")}`);
  }
  const title = text(args.title, "title");
  const source = args.source;
  if (typeof source !== "object" || source === null) {
    throw new OpError("source is required: {type:'file', path} or {type:'query', url}");
  }
  let cleanSource;
  if (source.type === "file") {
    if (!validViewSourcePath(source.path)) {
      throw new OpError("source.path must be a relative path inside this thread's working directory (no .., no absolute paths)");
    }
    cleanSource = { type: "file", path: source.path.trim() };
  } else if (source.type === "query") {
    const url = text(source.url, "source.url");
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url)) {
      throw new OpError("source.url must be a local backend (127.0.0.1 / localhost)");
    }
    cleanSource = { type: "query", url };
    if (typeof source.body === "string" && source.body.length > 0) {
      cleanSource.body = source.body.slice(0, 4000);
    }
  } else {
    throw new OpError('source.type must be "file" or "query"');
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
  if (Array.isArray(args.markers)) {
    spec.markers = args.markers
      .filter((m) => m && typeof m === "object" && typeof m.ts === "string" && m.ts.length > 0)
      .map((m) => ({
        ts: m.ts,
        label: typeof m.label === "string" ? m.label.slice(0, 80) : "",
        ...(typeof m.id === "string" && m.id.length > 0 ? { id: m.id.slice(0, 64) } : {}),
      }))
      .slice(0, VIEW_MARKER_CAP);
  }
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
    "SHOW the user rendered data in the panel — a table, a candle chart with markers, or a " +
    "distribution — drawn by Switchboard's own chart components from data YOU supply. Use it " +
    "when the user asks to see something, or as the direct output of an analysis they asked " +
    "for — never as a side effect of a turn. Two sources: write rows to a JSON file in this " +
    "thread's working directory (an ARRAY of flat objects; for candles each row needs " +
    "time/open/high/low/close, time as ISO or epoch seconds) and pass source " +
    "{type:'file', path:'relative/path.json'}; or point at the project's local backend with " +
    "{type:'query', url}. The view NEVER runs your code — it renders your data. op 'show' " +
    "opens it (id minted if omitted); op 'update' with the same id refreshes the open tab. " +
    "For tables pass columns (display order) and keyColumn (the column whose value names a " +
    "row for pins). For candles pass markers [{ts, label, id?}] for entries/exits. The user " +
    "can pin rows/bars/bins and keep the view; you cannot make a view poll — re-running a " +
    "query is their gesture.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["show", "update"], description: "show = create/open; update = refresh an existing id." },
      id: { type: "string", description: "View id ([A-Za-z0-9_-]). Omit on show to mint one; required on update." },
      kind: { type: "string", enum: ["table", "candles", "dist"], description: "How the data renders." },
      title: { type: "string", description: "A few plain words — the tab and toolbar name." },
      source: {
        type: "object",
        description: "{type:'file', path: relative JSON file in the thread cwd} or {type:'query', url: local backend, body?: JSON string → POST}.",
      },
      columns: { type: "array", items: { type: "string" }, description: "table: column display order (subset of the row keys)." },
      keyColumn: { type: "string", description: "table: the column whose value identifies a row (pin anchors). Default: the first column." },
      markers: {
        type: "array",
        items: { type: "object" },
        description: "candles: [{ts: ISO time, label, id?}] — entry/exit marks on the nearest bar.",
      },
    },
    required: ["op", "kind", "title", "source"],
  },
};

// ── The tool table (the behavioural contract lives HERE) ─────────────────────

const PAGE_TOOL = {
  name: "page",
  description:
    "Write this thread's ✦ PAGE — the one surface the user reads (it renders beside your " +
    "terminal). After each turn of work, record what happened (op turn: 2–5 plain lines a " +
    "non-engineer follows — no file paths, code names or hashes; a list is NEVER inside a " +
    "line, N things are N evidence rows). Keep Evidence current (op evidence: one row per " +
    "PR / ticket / doc / file with a plain label and a status; writing the same address " +
    "again UPDATES its row — omit status to keep the previous one). Track the plan with op " +
    "item (owner agent|user|team, state todo|in_progress|waiting|done; status changes go in " +
    "the item's note or state, never a new turn). Something only the user can answer: op " +
    "ask (prefer 2–4 short options) — it lands under Needs You on the page; the answer " +
    "arrives as their next message, so never ask the same question twice. Set op theme once " +
    "to one line saying what this thread is working on. Never open anything for an answer — " +
    "the page IS where your findings go.",
  inputSchema: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["theme", "turn", "evidence", "ask", "item"],
        description: "Which page operation to perform.",
      },
      text: { type: "string", description: "theme: the one-line theme. ask: the question." },
      lines: {
        type: "array",
        items: { type: "string" },
        description: "turn: 2–5 plain sentences describing what just happened.",
      },
      address: {
        type: "string",
        description: "evidence: the row's address — a ticket key, `repo #pr`, a doc or file path. The same address updates its row.",
      },
      label: { type: "string", description: "evidence: a plain few-word label." },
      status: {
        type: "string",
        description: "evidence: short status (open, merged, draft…). Omit to keep the previous one.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "ask: 2–4 short answer options (free text is always possible).",
      },
      itemOp: { type: "string", enum: ["add", "update", "close"], description: "item: which item operation." },
      id: { type: "string", description: "item update/close: the item id. ask: optional stable question id." },
      title: { type: "string", description: "item: a few plain words." },
      owner: { type: "string", enum: ["agent", "user", "team"], description: "item: who owns it." },
      state: { type: "string", enum: ["todo", "in_progress", "waiting", "done"], description: "item: its state." },
      note: { type: "string", description: "item: a short note (status detail lives here)." },
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
  const { page, message } = applyOp(parsePage(raw), args, now);
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
        respond({ jsonrpc: "2.0", id, result: { tools: [PAGE_TOOL, VIEW_TOOL] } });
        return;
      }
      if (method === "tools/call") {
        const name = params && params.name;
        if (name !== "page" && name !== "view") {
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
              content: [{ type: "text", text: `page write refused: ${err.message}` }],
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
  parsePage,
  applyOp,
  performOp,
  buildViewSpec,
  performViewOp,
  PAGE_TOOL,
  VIEW_TOOL,
  OpError,
  TURN_CAP,
  TURN_LINE_CAP,
  EVIDENCE_CAP,
  QUESTION_CAP,
};
