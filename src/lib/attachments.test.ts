import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MAX_PASTE_BYTES,
  DROP_CLAIM_DEFER_MS,
  pickPastedFiles,
  bytesToBase64,
  stagePastedFiles,
  stagePastedBase64,
  stagePaths,
  noteDropClaimed,
  consumeDropClaim,
  __setAttachmentSaverForTests,
  __resetDropClaimsForTests,
} from "./attachments";
import { getComposerAttachments, __resetComposerStoreForTests } from "./composer";
import { __resetThreadStoreForTests, createThreadRecord, bindThreadSession } from "./threadStore";

vi.mock("./ipc", () => ({
  saveThreadAttachment: vi.fn(async () => {
    throw new Error("ipc must be injected in tests");
  }),
}));

const SESSION = "s1";

function boundThread(): string {
  const t = createThreadRecord({ title: "t", workingDir: "C:/w" });
  bindThreadSession(t.id, SESSION);
  return t.id;
}

function fakeItem(kind: "file" | "string", type: string, file: File | null): DataTransferItem {
  return {
    kind,
    type,
    getAsFile: () => file,
    getAsString: () => {},
    webkitGetAsEntry: () => null,
  } as unknown as DataTransferItem;
}

beforeEach(() => {
  __resetComposerStoreForTests();
  __resetThreadStoreForTests();
  __resetDropClaimsForTests();
});

afterEach(() => {
  __setAttachmentSaverForTests(null);
  __resetComposerStoreForTests();
  __resetThreadStoreForTests();
  __resetDropClaimsForTests();
});

describe("pickPastedFiles — file items only, text untouched", () => {
  it("returns nothing for a text-only paste (dictation)", () => {
    const items = [fakeItem("string", "text/plain", null)];
    expect(pickPastedFiles(items)).toEqual([]);
    expect(pickPastedFiles(null)).toEqual([]);
    expect(pickPastedFiles(undefined)).toEqual([]);
  });

  it("takes every file item, skipping a null getAsFile, and picks the extension", () => {
    const shot = new File([new Uint8Array(4)], "image.png", { type: "image/png" });
    const pdf = new File([new Uint8Array(4)], "report.PDF", { type: "application/pdf" });
    const items = [
      fakeItem("string", "text/html", null),
      fakeItem("file", "image/png", shot),
      fakeItem("file", "image/png", null),
      fakeItem("file", "application/pdf", pdf),
    ];
    const picked = pickPastedFiles(items);
    expect(picked.map((p) => p.ext)).toEqual(["png", "pdf"]);
    expect(picked[0]!.file).toBe(shot);
  });

  it("falls back to the mime subtype, then bin", () => {
    const nameless = new File([new Uint8Array(1)], "", { type: "image/webp" });
    const mystery = new File([new Uint8Array(1)], "", { type: "" });
    const picked = pickPastedFiles([fakeItem("file", "image/webp", nameless), fakeItem("file", "", mystery)]);
    expect(picked.map((p) => p.ext)).toEqual(["webp", "bin"]);
  });
});

describe("bytesToBase64", () => {
  it("matches btoa for small input and survives large input", () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe(btoa("hi"));
    const big = new Uint8Array(0x8000 * 3 + 7);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const out = bytesToBase64(big);
    expect(out.length).toBe(Math.ceil(big.length / 3) * 4);
  });
});

describe("stagePastedFiles", () => {
  it("saves each file under the thread and stages chips with size", async () => {
    const threadId = boundThread();
    const calls: { threadId: string; name: string; b64: string }[] = [];
    __setAttachmentSaverForTests(async (t, name, b64) => {
      calls.push({ threadId: t, name, b64 });
      return `C:/data/threads/${t}/attachments/${name}`;
    });
    const a = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
    const b = new File([new Uint8Array([4, 5])], "notes.pdf", { type: "application/pdf" });
    const result = await stagePastedFiles(SESSION, [
      { file: a, ext: "png" },
      { file: b, ext: "pdf" },
    ]);
    expect(result.error).toBeNull();
    expect(calls.map((c) => c.threadId)).toEqual([threadId, threadId]);
    expect(calls[0]!.name).toMatch(/^\d+-1\.png$/);
    expect(calls[1]!.name).toMatch(/^\d+-2\.pdf$/);
    // One stamp per paste — the index is what disambiguates.
    expect(calls[0]!.name.split("-")[0]).toBe(calls[1]!.name.split("-")[0]);
    expect(calls[0]!.b64).toBe(btoa("\x01\x02\x03"));
    const staged = getComposerAttachments(SESSION);
    expect(staged.map((s) => s.name)).toEqual(["pasted-1.png", "notes.pdf"]);
    expect(staged.map((s) => s.size)).toEqual([3, 2]);
    expect(staged[0]!.path).toBe(`C:/data/threads/${threadId}/attachments/${calls[0]!.name}`);
  });

  it("refuses with a reason when the session has no thread, and saves nothing", async () => {
    const saver = vi.fn(async () => "x");
    __setAttachmentSaverForTests(saver);
    const f = new File([new Uint8Array(1)], "image.png", { type: "image/png" });
    const result = await stagePastedFiles(SESSION, [{ file: f, ext: "png" }]);
    expect(result.staged).toEqual([]);
    expect(result.error).toMatch(/needs a thread/);
    expect(saver).not.toHaveBeenCalled();
    expect(getComposerAttachments(SESSION)).toEqual([]);
  });

  it("skips an oversize item, names it, and still stages the rest", async () => {
    boundThread();
    __setAttachmentSaverForTests(async (_t, name) => `/a/${name}`);
    const huge = { size: MAX_PASTE_BYTES + 1, name: "wall.png", arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;
    const ok = new File([new Uint8Array(2)], "ok.png", { type: "image/png" });
    const result = await stagePastedFiles(SESSION, [
      { file: huge, ext: "png" },
      { file: ok, ext: "png" },
    ]);
    expect(result.staged.map((s) => s.name)).toEqual(["ok.png"]);
    expect(result.error).toMatch(/wall\.png is too large/);
  });

  it("a failed save keeps the error and stages nothing for that item", async () => {
    boundThread();
    __setAttachmentSaverForTests(async () => {
      throw new Error("disk full");
    });
    const f = new File([new Uint8Array(1)], "image.png", { type: "image/png" });
    const result = await stagePastedFiles(SESSION, [{ file: f, ext: "png" }]);
    expect(result.staged).toEqual([]);
    expect(result.error).toMatch(/disk full/);
    expect(getComposerAttachments(SESSION)).toEqual([]);
  });

  it("an empty pick is a no-op with no error", async () => {
    expect(await stagePastedFiles(SESSION, [])).toEqual({ staged: [], error: null });
  });
});

describe("stagePastedBase64 (the OS-level Ctrl+V route)", () => {
  it("saves a png under the thread and stages a pasted.png chip", async () => {
    const threadId = boundThread();
    let seen: string[] = [];
    __setAttachmentSaverForTests(async (t, name) => {
      seen = [t, name];
      return `/t/${name}`;
    });
    const result = await stagePastedBase64(SESSION, "AAAA", "png", 3);
    expect(result.error).toBeNull();
    expect(seen[0]).toBe(threadId);
    expect(seen[1]).toMatch(/^\d+-1\.png$/);
    expect(getComposerAttachments(SESSION)).toEqual([{ path: `/t/${seen[1]}`, name: "pasted.png", size: 3 }]);
  });

  it("refuses oversize and thread-less pastes before touching IPC", async () => {
    const saver = vi.fn(async () => "x");
    __setAttachmentSaverForTests(saver);
    expect((await stagePastedBase64(SESSION, "AAAA", "png", 3)).error).toMatch(/needs a thread/);
    boundThread();
    expect((await stagePastedBase64(SESSION, "AAAA", "png", MAX_PASTE_BYTES + 1)).error).toMatch(/too large/);
    expect(saver).not.toHaveBeenCalled();
  });
});

describe("stagePaths (drop + picker)", () => {
  it("stages by path with the basename, no IPC, no thread needed", () => {
    const saver = vi.fn(async () => "x");
    __setAttachmentSaverForTests(saver);
    const chips = stagePaths(SESSION, ["C:\\Users\\ericm\\shot.png", " /tmp/a b.pdf ", ""]);
    expect(chips).toEqual([
      { path: "C:\\Users\\ericm\\shot.png", name: "shot.png" },
      { path: "/tmp/a b.pdf", name: "a b.pdf" },
    ]);
    expect(getComposerAttachments(SESSION)).toEqual(chips);
    expect(saver).not.toHaveBeenCalled();
  });

  it("dropping the same file twice yields one chip", () => {
    stagePaths(SESSION, ["/x/a.png"]);
    stagePaths(SESSION, ["/x/a.png", "/x/b.png"]);
    expect(getComposerAttachments(SESSION).map((c) => c.path)).toEqual(["/x/a.png", "/x/b.png"]);
  });
});

describe("drop claims — a zone's drop is not also a terminal paste", () => {
  it("a claimed drop is consumed once, within the window", () => {
    noteDropClaimed(["/a", "/b"], 1000);
    expect(consumeDropClaim(["/a", "/b"], 1000 + DROP_CLAIM_DEFER_MS)).toBe(true);
    expect(consumeDropClaim(["/a", "/b"], 1000 + DROP_CLAIM_DEFER_MS)).toBe(false);
  });

  it("different paths or a stale claim do not match", () => {
    noteDropClaimed(["/a"], 1000);
    expect(consumeDropClaim(["/b"], 1010)).toBe(false);
    // A miss consumes nothing: the claim is still there for the right paths.
    expect(consumeDropClaim(["/a"], 1010)).toBe(true);
    noteDropClaimed(["/a"], 2000);
    expect(consumeDropClaim(["/a"], 2000 + 5000)).toBe(false);
  });

  it("no claim, no match", () => {
    expect(consumeDropClaim(["/a"])).toBe(false);
  });
});
