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

  it("treats U+2028 / U+2029 / U+0085 as newlines too", () => {
    // Dictation, PDFs and Word emit these. None is a C0 control, so none was
    // stripped OR normalized: a paragraph broken only by U+2028 contained no
    // \n, took the single-line branch, and reached the PTY UNBRACKETED — the
    // "4 lines become 4 submissions" shape the bracketing exists to prevent.
    expect(composeWrite("a\u2028b")).toBe(composeWrite("a\nb"));
    expect(composeWrite("a\u2029b")).toBe(composeWrite("a\nb"));
    expect(composeWrite("a\u0085b")).toBe(composeWrite("a\nb"));
  });

  it("a paragraph broken only by U+2028 goes as ONE bracketed paste", () => {
    const out = composeWrite("first line\u2028second line\u2028third line");
    expect(out.startsWith(PASTE_START)).toBe(true);
    expect(out).toBe(
      `${PASTE_START}first line${CR}second line${CR}third line${PASTE_END}${CR}`
    );
    // One submit, not three.
    expect(out.split(CR).length - 1).toBe(3);
    expect(out.endsWith(`${PASTE_END}${CR}`)).toBe(true);
  });

  it("still strips them from a single-line send rather than passing them through", () => {
    // A trailing separator is trailing blank space, exactly like a stray \n.
    expect(composeWrite("just one line\u2029")).toBe(`just one line${CR}`);
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

// ── Attachments (SWIT-59) ──────────────────────────────────────────────────
import {
  attachmentAgentBlock,
  attachmentStandInBody,
  composeMessage,
  mergeAttachments,
  basenameOf,
  extOf,
  pastedAttachmentFileName,
  pastedAttachmentLabel,
  formatAttachmentSize,
  getComposerAttachments,
  addComposerAttachments,
  removeComposerAttachment,
  clearComposerAttachments,
} from "./composer";

describe("attachmentAgentBlock — Ky's wording, verbatim", () => {
  it("is empty for no paths", () => {
    expect(attachmentAgentBlock([])).toBe("");
  });

  it("one path: singular, `it`", () => {
    expect(attachmentAgentBlock(["C:\\a\\shot.png"])).toBe(
      "\n\n[The user attached 1 file. Use the Read tool to open it — it renders images and PDFs directly; for other formats (Word, Excel, etc.) extract or convert the content first:\n- C:\\a\\shot.png\n]"
    );
  });

  it("n paths: plural, `them`, one bullet per path in order", () => {
    expect(attachmentAgentBlock(["/a.png", "/b.pdf", "/c.xlsx"])).toBe(
      "\n\n[The user attached 3 files. Use the Read tool to open them — it renders images and PDFs directly; for other formats (Word, Excel, etc.) extract or convert the content first:\n- /a.png\n- /b.pdf\n- /c.xlsx\n]"
    );
  });
});

describe("composeMessage — text + block, and the stand-in body", () => {
  it("no attachments: the text untouched", () => {
    expect(composeMessage("hello", [])).toBe("hello");
    expect(composeMessage("  ", [])).toBe("  ");
  });

  it("text + attachments: text (trailing blank space dropped) then the block", () => {
    expect(composeMessage("look at this\n\n", ["/x.png"])).toBe("look at this" + attachmentAgentBlock(["/x.png"]));
  });

  it("attachments and no words: Ky's stand-in body carries the block", () => {
    expect(attachmentStandInBody(1)).toBe("(see attached file)");
    expect(attachmentStandInBody(2)).toBe("(see attached files)");
    expect(composeMessage("", ["/x.png"])).toBe("(see attached file)" + attachmentAgentBlock(["/x.png"]));
    expect(composeMessage("  \n", ["/x.png", "/y.png"])).toBe(
      "(see attached files)" + attachmentAgentBlock(["/x.png", "/y.png"])
    );
  });

  it("a send with attachments is ONE bracketed paste with ONE submit", () => {
    const wire = composeWrite(composeMessage("", ["C:\\a\\shot.png"]));
    expect(wire.startsWith(PASTE_START)).toBe(true);
    expect(wire.endsWith(PASTE_END + CR)).toBe(true);
    expect(wire.slice(PASTE_START.length, -PASTE_END.length - 1)).toBe(
      "(see attached file)" + attachmentAgentBlock(["C:\\a\\shot.png"]).replace(/\n/g, CR)
    );
    // Exactly one CR outside the markers, none of them a submit inside.
    expect(wire.split(CR).length - 1).toBe(1 + 4);
    expect(wire.slice(0, -1).includes(ESC + "[201~" + CR)).toBe(false);
  });

  it("with attachments, a text that is only whitespace still sends", () => {
    expect(composeWrite(composeMessage("   ", ["/x.png"]))).not.toBe("");
    expect(composeWrite(composeMessage("   ", []))).toBe("");
  });
});

describe("attachment helpers", () => {
  it("mergeAttachments dedupes by path and keeps identity when nothing changes", () => {
    const cur = [{ path: "/a", name: "a" }];
    expect(mergeAttachments(cur, [{ path: "/a", name: "a again" }])).toBe(cur);
    expect(mergeAttachments(cur, [{ path: "", name: "blank" }])).toBe(cur);
    expect(mergeAttachments(cur, [{ path: "/b", name: "b" }, { path: "/b", name: "b dup" }])).toEqual([
      { path: "/a", name: "a" },
      { path: "/b", name: "b" },
    ]);
  });

  it("basenameOf / extOf handle both separators and dotfiles", () => {
    expect(basenameOf("C:\\Users\\e\\shot.PNG")).toBe("shot.PNG");
    expect(basenameOf("/tmp/a/b.pdf")).toBe("b.pdf");
    expect(basenameOf("plain")).toBe("plain");
    expect(extOf("shot.PNG")).toBe("png");
    expect(extOf(".bashrc")).toBe("");
    expect(extOf("noext")).toBe("");
  });

  it("pastedAttachmentFileName is <ts>-<n>.<ext> in the server's alphabet", () => {
    expect(pastedAttachmentFileName(1725000000000, 2, "png")).toBe("1725000000000-2.png");
    expect(pastedAttachmentFileName(1725000000000, 1, "svg+xml")).toBe("1725000000000-1.svgxml");
    expect(pastedAttachmentFileName(1, 1, "")).toBe("1-1.bin");
    expect(pastedAttachmentFileName(-5, 0, "PNG")).toBe("0-1.png");
    expect(pastedAttachmentFileName(1, 1, "../../x")).toBe("1-1.x");
  });

  it("pastedAttachmentLabel prefers a real name, else pasted[-n].<ext>", () => {
    expect(pastedAttachmentLabel("report.pdf", "pdf", 1, 1)).toBe("report.pdf");
    expect(pastedAttachmentLabel("", "png", 1, 1)).toBe("pasted.png");
    // Chromium names a screenshot `image.png`, which is no name at all.
    expect(pastedAttachmentLabel("image.png", "png", 2, 3)).toBe("pasted-2.png");
  });

  it("formatAttachmentSize", () => {
    expect(formatAttachmentSize(812)).toBe("812 B");
    expect(formatAttachmentSize(24 * 1024)).toBe("24 KB");
    expect(formatAttachmentSize(1.3 * 1024 * 1024)).toBe("1.3 MB");
    expect(formatAttachmentSize(-1)).toBe("");
  });
});

describe("staged attachments store — next to the draft, per session", () => {
  it("starts empty with a stable snapshot", () => {
    expect(getComposerAttachments("s1")).toEqual([]);
    expect(getComposerAttachments("s1")).toBe(getComposerAttachments("s2"));
  });

  it("add dedupes, remove drops one, clear drops all; other sessions untouched", () => {
    addComposerAttachments("s1", [{ path: "/a", name: "a" }]);
    addComposerAttachments("s1", [{ path: "/a", name: "a" }, { path: "/b", name: "b" }]);
    addComposerAttachments("s2", [{ path: "/z", name: "z" }]);
    expect(getComposerAttachments("s1").map((c) => c.path)).toEqual(["/a", "/b"]);
    removeComposerAttachment("s1", "/a");
    expect(getComposerAttachments("s1").map((c) => c.path)).toEqual(["/b"]);
    removeComposerAttachment("s1", "/nope");
    expect(getComposerAttachments("s1").map((c) => c.path)).toEqual(["/b"]);
    clearComposerAttachments("s1");
    expect(getComposerAttachments("s1")).toEqual([]);
    expect(getComposerAttachments("s2").map((c) => c.path)).toEqual(["/z"]);
  });

  it("survives the draft round trip and goes with clearComposerState", () => {
    setComposerDraft("s1", "half a line");
    addComposerAttachments("s1", [{ path: "/a", name: "a" }]);
    expect(getComposerDraft("s1")).toBe("half a line");
    expect(getComposerAttachments("s1").length).toBe(1);
    clearComposerState("s1");
    expect(getComposerAttachments("s1")).toEqual([]);
    expect(getComposerDraft("s1")).toBe("");
  });
});
