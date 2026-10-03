// SWIT-117 — the session-record parser. Each assertion is the inverse of a
// real failure (Ky's playbook's list), plus the record shapes measured on a
// live session: one block per assistant record, results on a later user
// record, isMeta scaffolding, isSidechain subagent work, slash commands.

import { describe, it, expect } from "vitest";
import {
  parseTranscript,
  toolState,
  toolResultBody,
  toolSummary,
  toolDisplayName,
  cleanUserText,
  slashCommandOf,
  TOOL_RESULT_CAP,
  type ToolEntry,
} from "./transcript";

const at = "2026-10-03T19:00:00.000Z";
const line = (o: object) => JSON.stringify(o);
const user = (uuid: string, content: unknown, extra: object = {}) =>
  line({ type: "user", uuid, timestamp: at, isSidechain: false, message: { role: "user", content }, ...extra });
const assistant = (uuid: string, block: object, extra: object = {}) =>
  line({ type: "assistant", uuid, timestamp: at, isSidechain: false, message: { id: "msg_1", role: "assistant", content: [block] }, ...extra });
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: object) => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, content: unknown, isError = false) => ({ type: "tool_result", tool_use_id: id, content, is_error: isError });
const parse = (...lines: string[]) => parseTranscript(lines.join("\n"));

describe("parseTranscript", () => {
  it("a message appears ONCE — even when the same text occurs twice in a turn, and even when a record is written twice", () => {
    const rec = assistant("a1", text("Done."));
    const out = parse(user("u1", "go"), rec, rec, assistant("a2", text("Done.")));
    const said = out.filter((e) => e.kind === "assistant");
    expect(said.map((e) => e.id)).toEqual(["a1:0", "a2:0"]);
  });

  it("keeps markdown verbatim — a table is handed to the renderer as a table", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    const out = parse(assistant("a1", text(table)));
    expect(out).toEqual([expect.objectContaining({ kind: "assistant", text: table })]);
  });

  it("a tool call is visible with its result; a failed one says so", () => {
    const out = parse(
      assistant("a1", toolUse("t1", "Bash", { command: "pnpm test", description: "Run tests" })),
      user("u2", [toolResult("t1", "2,277 passed")]),
      assistant("a2", toolUse("t2", "Read", { file_path: "C:/x/missing.ts" })),
      user("u3", [toolResult("t2", "File does not exist.", true)]),
    );
    const [ok, bad] = out as ToolEntry[];
    expect(ok).toMatchObject({ name: "Bash", summary: "Run tests", result: "2,277 passed" });
    expect(toolState(ok)).toBe("done");
    expect(toolState(bad)).toBe("failed");
    expect(toolResultBody(bad)).toBe("File does not exist.");
  });

  it("a call still running is NOT drawn as if it finished", () => {
    const [t] = parse(assistant("a1", toolUse("t1", "Bash", { command: "sleep 60" }))) as ToolEntry[];
    expect(t.done).toBe(false);
    expect(toolState(t)).toBe("running");
  });

  it("a SILENT result is done — an empty string, an image-only result, an empty list", () => {
    const out = parse(
      assistant("a1", toolUse("t1", "Write", { file_path: "a.ts" })),
      assistant("a2", toolUse("t2", "Read", { file_path: "shot.png" })),
      assistant("a3", toolUse("t3", "Edit", { file_path: "b.ts" })),
      user("u1", [toolResult("t1", "")]),
      user("u2", [toolResult("t2", [{ type: "image", source: { type: "base64", data: "x" } }])]),
      user("u3", [toolResult("t3", [])]),
    ) as ToolEntry[];
    expect(out.map(toolState)).toEqual(["done", "done", "done"]);
    expect(toolResultBody(out[1])).toMatch(/image/);
    expect(toolResultBody(out[0])).toBe("(no output)");
  });

  it("draws nothing for scaffolding: isMeta records, a subagent's working, attachments, bookkeeping", () => {
    const out = parse(
      user("m1", [text("Base directory for this skill: …")], { isMeta: true }),
      user("m2", "Stop hook feedback: …", { isMeta: true }),
      assistant("s1", text("subagent thinking aloud"), { isSidechain: true }),
      line({ type: "attachment", uuid: "x1", attachment: { type: "environment" } }),
      line({ type: "mode", mode: "normal" }),
      line({ type: "file-history-snapshot", messageId: "m" }),
      line({ type: "system", subtype: "turn_duration", uuid: "y1" }),
      user("u1", "hello"),
    );
    expect(out).toEqual([expect.objectContaining({ kind: "user", text: "hello" })]);
  });

  it("strips system reminders and the paste wrapper from what the user said", () => {
    const out = parse(user("u1", '<pasted_content id="2b3e">\nship it\n</pasted_content id="2b3e">\n<system-reminder>secret</system-reminder>'));
    expect(out).toEqual([expect.objectContaining({ kind: "user", text: "ship it" })]);
  });

  it("a slash command, a compaction and an interruption are NOTICES, never the user's words", () => {
    const out = parse(
      user("u1", "<command-name>/mcp</command-name>\n<command-args></command-args>"),
      user("u2", "<local-command-stdout>Reconnected</local-command-stdout>"),
      line({ type: "system", subtype: "compact_boundary", uuid: "c1", timestamp: at }),
      user("u3", [text("[Request interrupted by user]")]),
    );
    expect(out.map((e) => [e.kind, "text" in e ? e.text : ""])).toEqual([
      ["notice", "/mcp"],
      ["notice", "Conversation compacted"],
      ["notice", "Interrupted"],
    ]);
  });

  it("a message typed WHILE claude was busy (a queued_command from a human) is drawn; queued notifications and peer messages are not", () => {
    const queued = (uuid: string, origin: object, prompt: string) =>
      line({ type: "attachment", uuid, timestamp: at, isSidechain: false, attachment: { type: "queued_command", commandMode: "prompt", origin, prompt, timestamp: at } });
    const out = parse(
      queued("q1", { kind: "human" }, "also check the logs"),
      queued("q2", { kind: "task-notification", producer: "session-task" }, "<task-notification>x</task-notification>"),
      queued("q3", { kind: "peer", from: "uds:x", name: "switchboard-01" }, "<cross-session-message>hi</cross-session-message>"),
    );
    expect(out).toEqual([expect.objectContaining({ kind: "user", id: "q1", text: "also check the logs" })]);
  });

  it("folds the composer's attachment instructions to one line", () => {
    const sent = "(see attached file)\n\n[The user attached 1 file. Use the Read tool to open it — it renders images:\n- C:\\x\\shot.png\n]";
    const out = parse(user("u1", sent));
    expect(out).toEqual([expect.objectContaining({ text: "(see attached file)\n\n_(1 file attached)_" })]);
  });

  it("a compaction summary is bookkeeping, not the user's words", () => {
    const out = parse(user("u1", "This session is being continued from a previous conversation…", { isCompactSummary: true }), user("u2", "next"));
    expect(out).toEqual([expect.objectContaining({ text: "next" })]);
  });

  it("shows thinking only where the record kept its text", () => {
    const out = parse(
      assistant("a1", { type: "thinking", thinking: "", signature: "sig" }),
      assistant("a2", { type: "thinking", thinking: "weighing two options", signature: "sig" }),
    );
    expect(out).toEqual([expect.objectContaining({ kind: "thinking", text: "weighing two options" })]);
  });

  it("a tail that starts mid-record skips the broken line; a result whose call fell off the window is ignored", () => {
    const out = parse('"half": "a record"}', user("u1", [toolResult("gone", "x")]), user("u2", "after"));
    expect(out).toEqual([expect.objectContaining({ kind: "user", text: "after" })]);
  });

  it("caps a huge result and says how much was cut", () => {
    const big = "x".repeat(TOOL_RESULT_CAP + 500);
    const [t] = parse(assistant("a1", toolUse("t1", "Bash", { command: "cat big" })), user("u1", [toolResult("t1", big)])) as ToolEntry[];
    expect(t.result.length).toBeLessThan(big.length);
    expect(t.result).toMatch(/500 more characters/);
  });

  it("an empty record is an empty conversation, not a throw", () => {
    expect(parseTranscript("")).toEqual([]);
    expect(parseTranscript("not json\n{}\n")).toEqual([]);
  });
});

describe("helpers", () => {
  it("summarises the common tools in plain words", () => {
    expect(toolSummary("Bash", { command: "git status", description: "Show status" })).toBe("Show status");
    expect(toolSummary("Bash", { command: "git status" })).toBe("git status");
    expect(toolSummary("Grep", { pattern: "foo", path: "src" })).toBe("foo in src");
    expect(toolSummary("mcp__switchboard__page", { op: "turn", lines: ["a"] })).toBe("turn");
    expect(toolSummary("mcp__switchboard__page", { op: "evidence", address: "SWIT-1" })).toBe("evidence · SWIT-1");
  });

  it("names an MCP tool by its own name", () => {
    expect(toolDisplayName("mcp__switchboard__page")).toBe("page");
    expect(toolDisplayName("mcp__claude_ai_chat-recall-mcp__search_conversations")).toBe("search_conversations");
    expect(toolDisplayName("Bash")).toBe("Bash");
  });

  it("cleanUserText and slashCommandOf", () => {
    expect(cleanUserText("a<system-reminder>x\ny</system-reminder>b")).toBe("ab");
    expect(slashCommandOf("<command-name>compact</command-name><command-args>keep it short</command-args>")).toBe("/compact keep it short");
    expect(slashCommandOf("plain")).toBeNull();
  });
});
