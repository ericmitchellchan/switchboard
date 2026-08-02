import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  PASTE_START,
  PASTE_END,
  DRAFT_INDEX,
  SEND_HISTORY_LIMIT,
  sanitizeComposerText,
  composeWrite,
  pushSendHistory,
  stepHistory,
  shouldNavigateHistory,
  composerAutoVisible,
  isComposerVisible,
  toggleComposer,
  hideComposer,
  getComposerDraft,
  setComposerDraft,
  getSendHistory,
  recordSend,
  clearComposerState,
  __resetComposerStoreForTests,
} from "./composer";
import {
  __resetThreadStoreForTests,
  createThreadRecord,
  bindThreadSession,
  markThreadLaunched,
  markThreadSessionExited,
} from "./threadStore";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

beforeEach(() => {
  __resetComposerStoreForTests();
  __resetThreadStoreForTests();
});

afterEach(() => {
  __resetComposerStoreForTests();
  __resetThreadStoreForTests();
});

// ─────────────────────────────────────────────────────────────────────────────
// Wire format — the part that must not silently regress
// ─────────────────────────────────────────────────────────────────────────────

describe("composeWrite", () => {
  it("markers are the standard bracketed-paste sequences", () => {
    expect(PASTE_START).toBe(`${ESC}[200~`);
    expect(PASTE_END).toBe(`${ESC}[201~`);
  });

  it("sends a single line as plain text plus one CR", () => {
    expect(composeWrite("refactor the fit queue")).toBe(`refactor the fit queue${CR}`);
  });

  it("wraps multi-line content in bracketed paste with ONE trailing CR", () => {
    // The acceptance case: a 3-line message must arrive as ONE message, not 3.
    const out = composeWrite("one\ntwo\nthree");
    expect(out).toBe(`${PASTE_START}one${CR}two${CR}three${PASTE_END}${CR}`);
    // Exactly one CR outside the markers = exactly one submit.
    const body = out.slice(PASTE_START.length, out.length - PASTE_END.length - 1);
    expect(body.split(CR)).toEqual(["one", "two", "three"]);
    expect(out.endsWith(`${PASTE_END}${CR}`)).toBe(true);
  });

  it("uses CR (not LF) for line breaks inside the paste, like xterm's own paste path", () => {
    expect(composeWrite("a\nb")).not.toContain("\n");
  });

  it("treats CRLF and lone CR input as newlines", () => {
    expect(composeWrite("a\r\nb")).toBe(composeWrite("a\nb"));
    expect(composeWrite("a\rb")).toBe(composeWrite("a\nb"));
  });

  it("is a no-op for empty and whitespace-only text (never a bare Enter)", () => {
    expect(composeWrite("")).toBe("");
    expect(composeWrite("   ")).toBe("");
    expect(composeWrite("\n\n")).toBe("");
    expect(composeWrite(" \t \n ")).toBe("");
  });

  it("drops trailing blank space but keeps leading indentation", () => {
    expect(composeWrite("hello  \n\n")).toBe(`hello${CR}`);
    expect(composeWrite("    indented")).toBe(`    indented${CR}`);
    expect(composeWrite("def f():\n    return 1\n")).toBe(
      `${PASTE_START}def f():${CR}    return 1${PASTE_END}${CR}`
    );
  });

  it("a message that is one line after trailing-trim is NOT wrapped", () => {
    expect(composeWrite("just one\n")).toBe(`just one${CR}`);
  });

  it("strips control characters so pasted text cannot break out of the paste", () => {
    // A literal end-marker inside the payload would end the paste early and
    // turn the remainder into extra submissions.
    const hostile = `hello${PASTE_END}${CR}rm -rf /`;
    const out = composeWrite(hostile);
    expect(out).toBe(`${PASTE_START}hello[201~${CR}rm -rf /${PASTE_END}${CR}`);
    // The only ESCs in the payload are OUR two markers — the body has none.
    const body = out.slice(PASTE_START.length, out.length - PASTE_END.length - 1);
    expect(body).not.toContain(ESC);
  });

  it("keeps tabs, which are content inside a paste", () => {
    expect(composeWrite("a\tb")).toBe(`a\tb${CR}`);
  });

  it("sanitizeComposerText is idempotent", () => {
    const once = sanitizeComposerText("a\r\nb\x07c");
    expect(sanitizeComposerText(once)).toBe(once);
    expect(once).toBe("a\nbc");
  });

  it("preserves unicode (dictation output is prose, not ascii)", () => {
    expect(composeWrite("café — naïve ✅")).toBe(`café — naïve ✅${CR}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Send history
// ─────────────────────────────────────────────────────────────────────────────

describe("pushSendHistory", () => {
  it("appends oldest-first", () => {
    expect(pushSendHistory(pushSendHistory([], "a"), "b")).toEqual(["a", "b"]);
  });

  it("collapses consecutive duplicates but not repeats separated by another send", () => {
    expect(pushSendHistory(["a"], "a")).toEqual(["a"]);
    expect(pushSendHistory(["a", "b"], "a")).toEqual(["a", "b", "a"]);
  });

  it("ignores empty entries", () => {
    expect(pushSendHistory(["a"], "")).toEqual(["a"]);
  });

  it("caps from the OLD end", () => {
    let h: string[] = [];
    for (let i = 0; i < SEND_HISTORY_LIMIT + 5; i++) h = pushSendHistory(h, `m${i}`);
    expect(h.length).toBe(SEND_HISTORY_LIMIT);
    expect(h[0]).toBe("m5");
    expect(h[h.length - 1]).toBe(`m${SEND_HISTORY_LIMIT + 4}`);
  });
});

describe("stepHistory", () => {
  it("first ↑ from the draft lands on the most recent send", () => {
    expect(stepHistory(3, DRAFT_INDEX, "older")).toBe(2);
  });

  it("↑ walks backwards and stops at the oldest", () => {
    expect(stepHistory(3, 2, "older")).toBe(1);
    expect(stepHistory(3, 0, "older")).toBeNull();
  });

  it("↓ walks forwards and returns to the draft", () => {
    expect(stepHistory(3, 0, "newer")).toBe(1);
    expect(stepHistory(3, 2, "newer")).toBe(DRAFT_INDEX);
  });

  it("↓ from the draft is a no-op, and ↑ with no history is a no-op", () => {
    expect(stepHistory(3, DRAFT_INDEX, "newer")).toBeNull();
    expect(stepHistory(0, DRAFT_INDEX, "older")).toBeNull();
  });

  it("round-trips through the whole list", () => {
    let i: number | null = DRAFT_INDEX;
    const seen: number[] = [];
    while ((i = stepHistory(3, i as number, "older")) !== null) seen.push(i);
    expect(seen).toEqual([2, 1, 0]);
  });
});

describe("shouldNavigateHistory (do not hijack ↑/↓ mid-edit)", () => {
  const base = { value: "hello world", selectionStart: 5, selectionEnd: 5, inHistory: false };

  it("ignores the arrows with the caret inside the text", () => {
    expect(shouldNavigateHistory({ ...base, direction: "older" })).toBe(false);
    expect(shouldNavigateHistory({ ...base, direction: "newer" })).toBe(false);
  });

  it("↑ navigates only from the very start", () => {
    expect(
      shouldNavigateHistory({ ...base, direction: "older", selectionStart: 0, selectionEnd: 0 })
    ).toBe(true);
  });

  it("↓ navigates only from the very end", () => {
    const end = base.value.length;
    expect(
      shouldNavigateHistory({ ...base, direction: "newer", selectionStart: end, selectionEnd: end })
    ).toBe(true);
    expect(
      shouldNavigateHistory({ ...base, direction: "older", selectionStart: end, selectionEnd: end })
    ).toBe(false);
  });

  it("a selection always wins (shift-arrow must still extend it)", () => {
    expect(
      shouldNavigateHistory({
        ...base,
        direction: "older",
        selectionStart: 0,
        selectionEnd: 4,
        inHistory: true,
      })
    ).toBe(false);
  });

  it("while browsing history the arrows keep browsing wherever the caret is", () => {
    expect(shouldNavigateHistory({ ...base, direction: "older", inHistory: true })).toBe(true);
    expect(shouldNavigateHistory({ ...base, direction: "newer", inHistory: true })).toBe(true);
  });

  it("multi-line: the caret at the start of line 2 belongs to the caret, not history", () => {
    expect(
      shouldNavigateHistory({
        direction: "older",
        inHistory: false,
        value: "one\ntwo",
        selectionStart: 4,
        selectionEnd: 4,
      })
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Visibility, derived from the promotion signal
// ─────────────────────────────────────────────────────────────────────────────

function liveThreadOn(sessionId: string): string {
  const t = createThreadRecord({ title: "t", workingDir: "C:/repo" });
  bindThreadSession(t.id, sessionId);
  markThreadLaunched(t.id);
  return t.id;
}

describe("composer visibility", () => {
  it("a plain shell has none by default", () => {
    expect(composerAutoVisible("s1")).toBe(false);
    expect(isComposerVisible("s1")).toBe(false);
    expect(isComposerVisible(null)).toBe(false);
  });

  it("a bound thread whose claude is NOT launched is not enough", () => {
    const t = createThreadRecord({ title: "t", workingDir: "C:/repo" });
    bindThreadSession(t.id, "s1");
    expect(composerAutoVisible("s1")).toBe(false);
  });

  it("a session holding a live claude conversation shows one automatically", () => {
    liveThreadOn("s1");
    expect(composerAutoVisible("s1")).toBe(true);
    expect(isComposerVisible("s1")).toBe(true);
  });

  it("is per-session — a sibling pane's session is unaffected", () => {
    liveThreadOn("s1");
    expect(isComposerVisible("s2")).toBe(false);
  });

  it("auto-hides when the bound session's PTY exits", () => {
    liveThreadOn("s1");
    markThreadSessionExited("s1");
    expect(isComposerVisible("s1")).toBe(false);
  });

  it("toggle hides it on a live conversation and the choice sticks", () => {
    liveThreadOn("s1");
    toggleComposer("s1");
    expect(isComposerVisible("s1")).toBe(false);
    // Still auto-eligible — the override is what is winning.
    expect(composerAutoVisible("s1")).toBe(true);
    toggleComposer("s1");
    expect(isComposerVisible("s1")).toBe(true);
  });

  it("toggle forces one onto a plain shell, and it survives a later promotion", () => {
    toggleComposer("s1");
    expect(isComposerVisible("s1")).toBe(true);
    liveThreadOn("s1");
    expect(isComposerVisible("s1")).toBe(true);
  });

  it("the hide affordance matches the chord", () => {
    liveThreadOn("s1");
    hideComposer("s1");
    expect(isComposerVisible("s1")).toBe(false);
    // Idempotent — hiding an already-hidden composer changes nothing.
    hideComposer("s1");
    expect(isComposerVisible("s1")).toBe(false);
  });
});

describe("per-session composer state", () => {
  it("drafts and history are session-scoped", () => {
    setComposerDraft("s1", "half a sentence");
    recordSend("s1", "sent one");
    expect(getComposerDraft("s1")).toBe("half a sentence");
    expect(getComposerDraft("s2")).toBe("");
    expect(getSendHistory("s1")).toEqual(["sent one"]);
    expect(getSendHistory("s2")).toEqual([]);
  });

  it("clearComposerState drops everything for one session only", () => {
    liveThreadOn("s1");
    toggleComposer("s1");
    setComposerDraft("s1", "d");
    recordSend("s1", "x");
    setComposerDraft("s2", "keep me");

    clearComposerState("s1");

    expect(getComposerDraft("s1")).toBe("");
    expect(getSendHistory("s1")).toEqual([]);
    // Override gone → back to the automatic rule.
    expect(isComposerVisible("s1")).toBe(true);
    expect(getComposerDraft("s2")).toBe("keep me");
  });
});
