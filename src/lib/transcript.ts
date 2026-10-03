// THE SESSION RECORD, READ AS A CONVERSATION (SWIT-117, Ky's playbook
// `pretty-chat-from-the-session-record.md`). claude writes every session to
// `~/.claude/projects/<munged cwd>/<uuid>.jsonl` as it goes — the file its
// own `--resume` reads back. The chat view draws THAT, not the terminal: each
// message is in the file once, so a duplicated paragraph is impossible and a
// refresh is a correct re-read, not a hopeful one. The engine is untouched.
//
// This module is the pure half: record text in, a list of entries out. No
// DOM, no file system — the read is the caller's (`ipc.readClaudeTranscript`).
//
// What the record holds, measured on a live session before this was written
// (2026-10-03): user / assistant / attachment / system / mode / file-history
// / queue-operation / cost-state records; assistant content is ONE block per
// record (thinking, text or tool_use), the record's `uuid` its identity; tool
// results ride a later `user` record by `tool_use_id`; 17 of 127 results
// carried no text (12 began with an image); 59 of 73 thinking blocks were an
// empty string with only a signature — the reasoning is not kept.
//
// Ky's rules, kept here:
//   - a tool call is DONE on its result's arrival, never on whether the
//     result has text (an image or a silent success is a real outcome);
//   - a NOTICE for what happened to the conversation without anyone saying
//     it (a slash command, a compaction, an interruption);
//   - NOTHING for scaffolding nobody typed: `isMeta` records (skill bodies,
//     hook feedback, injected context), a subagent's working (`isSidechain`),
//     system reminders inside a message, attachments, bookkeeping records;
//   - thinking is shown only where the record kept its text.
//
// A message typed WHILE claude is busy is not a `user` record: claude files it
// as an `attachment` of type `queued_command` (origin.kind "human"). Task
// notifications and messages from other sessions use the same shape with
// another origin — those are scaffolding and draw nothing (review of SWIT-117,
// found on the live record: a pasted screenshot sent mid-turn was missing).

export type ChatEntry =
  | { kind: "user"; id: string; text: string; at: string }
  | { kind: "assistant"; id: string; text: string; at: string }
  | { kind: "thinking"; id: string; text: string; at: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      summary: string;
      done: boolean;
      isError: boolean;
      /** The result's text, capped. "" for a silent or image-only result. */
      result: string;
      hasImage: boolean;
      at: string;
    }
  | { kind: "notice"; id: string; text: string; at: string };

export type ToolEntry = Extract<ChatEntry, { kind: "tool" }>;

/** A result longer than this is cut, with a line saying so — a 2 MB build log
 *  is one click away in the terminal, not worth a frozen pane. */
export const TOOL_RESULT_CAP = 20_000;
const SUMMARY_CAP = 120;

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function oneLine(s: string, cap = SUMMARY_CAP): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

/** What a person reads in a user message: system reminders and other
 *  injected blocks out, the paste wrapper's tags out (its content stays), the
 *  composer's Read-tool instructions for attachments (SWIT-59's block, words
 *  meant for the agent) folded to one line saying how many were attached. */
export function cleanUserText(raw: string): string {
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<\/?pasted_content\b[^>]*>/g, "")
    .replace(/\[The user attached (\d+) files?\. Use the Read tool[\s\S]*?\n\]/g, (_m, n: string) =>
      `_(${n} file${n === "1" ? "" : "s"} attached)_`,
    )
    .replace(/\r\n/g, "\n")
    .trim();
}

/** `/name args` from claude's slash-command markup, or null. */
export function slashCommandOf(raw: string): string | null {
  const name = raw.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (!name) return null;
  const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const cmd = name[1].trim().replace(/^\/?/, "/");
  const rest = args ? args[1].trim() : "";
  return rest ? `${cmd} ${rest}` : cmd;
}

/** The tool's name as a person reads it: `mcp__switchboard__page` → `page`. */
export function toolDisplayName(name: string): string {
  const mcp = name.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/);
  return mcp ? mcp[1] : name;
}

/** One line saying what the call did, from its input. */
export function toolSummary(name: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = str(i[k]);
      if (v.trim()) return v;
    }
    return "";
  };
  switch (name) {
    case "Bash":
      return oneLine(pick("description") || pick("command"));
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return oneLine(pick("file_path", "notebook_path"));
    case "Grep":
      return oneLine([pick("pattern"), pick("path") && `in ${pick("path")}`].filter(Boolean).join(" "));
    case "Glob":
      return oneLine(pick("pattern"));
    case "Agent":
    case "Task":
      return oneLine(pick("description", "prompt"));
    case "Skill":
      return oneLine(pick("skill"));
    case "WebFetch":
      return oneLine(pick("url"));
    case "WebSearch":
    case "ToolSearch":
      return oneLine(pick("query"));
  }
  const op = pick("op", "action");
  const detail = pick("title", "text", "address", "query", "name", "description", "path");
  const parts = [op, detail].filter(Boolean);
  if (parts.length) return oneLine(parts.join(" · "));
  for (const v of Object.values(i)) if (typeof v === "string" && v.trim()) return oneLine(v);
  return "";
}

function resultText(content: unknown): { text: string; hasImage: boolean } {
  if (typeof content === "string") return { text: content, hasImage: false };
  if (!Array.isArray(content)) return { text: "", hasImage: false };
  let hasImage = false;
  const parts: string[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === "image") hasImage = true;
    else if (b.type === "text") parts.push(str(b.text));
  }
  return { text: parts.join("\n"), hasImage };
}

function capResult(text: string): string {
  if (text.length <= TOOL_RESULT_CAP) return text;
  return `${text.slice(0, TOOL_RESULT_CAP)}\n… ${(text.length - TOOL_RESULT_CAP).toLocaleString("en-US")} more characters — the terminal has the rest`;
}

const INTERRUPT = /^\[Request interrupted by user[^\]]*\]$/;

/** Parse a session record (or its tail — a partial first line is skipped,
 *  like any other line that is not JSON) into the conversation. */
export function parseTranscript(text: string): ChatEntry[] {
  const out: ChatEntry[] = [];
  const seen = new Set<string>();
  const tools = new Map<string, ToolEntry>();
  const push = (e: ChatEntry) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    out.push(e);
    if (e.kind === "tool") tools.set(e.id, e);
  };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(rec)) continue;
    if (rec.isSidechain === true || rec.isMeta === true) continue;
    // A compaction's summary and transcript-only records are claude's own
    // bookkeeping — the compact_boundary notice says what happened.
    if (rec.isCompactSummary === true || rec.isVisibleInTranscriptOnly === true) continue;
    const uuid = str(rec.uuid);
    const at = str(rec.timestamp);
    const type = rec.type;

    if (type === "attachment") {
      const a = isObj(rec.attachment) ? rec.attachment : null;
      const origin = a && isObj(a.origin) ? a.origin : null;
      if (a && a.type === "queued_command" && origin?.kind === "human" && uuid) {
        const clean = cleanUserText(str(a.prompt));
        if (clean) push({ kind: "user", id: uuid, text: clean, at: str(a.timestamp) || at });
      }
      continue;
    }

    if (type === "system") {
      if (rec.subtype === "compact_boundary" && uuid) {
        push({ kind: "notice", id: uuid, text: "Conversation compacted", at });
      }
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    const message = isObj(rec.message) ? rec.message : null;
    if (!message || !uuid) continue;
    const content = message.content;

    if (type === "user") {
      if (typeof content === "string") {
        const cmd = slashCommandOf(content);
        if (cmd) {
          push({ kind: "notice", id: uuid, text: cmd, at });
          continue;
        }
        if (/<local-command-(stdout|stderr|caveat)>/.test(content)) continue;
        const clean = cleanUserText(content);
        if (INTERRUPT.test(clean)) {
          push({ kind: "notice", id: uuid, text: "Interrupted", at });
          continue;
        }
        if (clean) push({ kind: "user", id: uuid, text: clean, at });
        continue;
      }
      if (!Array.isArray(content)) continue;
      const texts: string[] = [];
      let images = 0;
      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === "tool_result") {
          const tool = tools.get(str(b.tool_use_id));
          if (!tool) continue; // its call fell outside the window
          const r = resultText(b.content);
          tool.done = true;
          tool.isError = b.is_error === true;
          tool.result = capResult(r.text);
          tool.hasImage = r.hasImage;
        } else if (b.type === "text") {
          texts.push(str(b.text));
        } else if (b.type === "image") {
          images += 1;
        }
      }
      const clean = cleanUserText(texts.join("\n"));
      if (INTERRUPT.test(clean)) {
        push({ kind: "notice", id: uuid, text: "Interrupted", at });
        continue;
      }
      const withImages = images > 0 ? [clean, `_(${images} image${images > 1 ? "s" : ""} attached)_`].filter(Boolean).join("\n\n") : clean;
      if (withImages) push({ kind: "user", id: uuid, text: withImages, at });
      continue;
    }

    // assistant: one block per record in practice; index it anyway.
    if (!Array.isArray(content)) continue;
    content.forEach((b, i) => {
      if (!isObj(b)) return;
      const id = `${uuid}:${i}`;
      if (b.type === "text") {
        const t = str(b.text).trim();
        if (t) push({ kind: "assistant", id, text: t, at });
      } else if (b.type === "thinking") {
        const t = str(b.thinking).trim();
        if (t) push({ kind: "thinking", id, text: t, at });
      } else if (b.type === "tool_use") {
        const name = str(b.name);
        const toolId = str(b.id) || id;
        push({
          kind: "tool",
          id: toolId,
          name,
          summary: toolSummary(name, b.input),
          done: false,
          isError: false,
          result: "",
          hasImage: false,
          at,
        });
      }
    });
  }
  return out;
}

/** A tool call's state, judged on the completion flag — never on the text. */
export function toolState(entry: ToolEntry): "running" | "failed" | "done" {
  if (!entry.done) return "running";
  return entry.isError ? "failed" : "done";
}

/** What a done call's body holds when opened. */
export function toolResultBody(entry: ToolEntry): string {
  if (entry.result.trim()) return entry.result;
  if (entry.hasImage) return "(an image — open the terminal to see it)";
  return entry.isError ? "(failed with no output)" : "(no output)";
}
