// Attachment STAGING (SWIT-59) — the effectful half of the composer's
// attachments. `lib/composer.ts` owns the pure rules (the Read block, the
// merge, the file names) and the per-session store; this module is what turns
// a clipboard item, a dropped path or a picker result INTO a staged chip.
//
// Three sources, two shapes:
//   · PASTE carries BYTES. They are saved under the thread's data dir
//     (`threads/<id>/attachments/<ts>-<n>.<ext>`) through the guarded
//     `save_thread_attachment` command — base64 over IPC, so a ceiling applies
//     (MAX_PASTE_BYTES, Ky's number). A paste therefore needs a THREAD: a
//     forced composer on a plain shell has nowhere to file an image and says
//     so. Two paste routes feed this: the textarea's capture-phase handler
//     (right-click Paste, Shift+Insert — any paste the webview itself sees)
//     and App's OS-level `clipboard-paste-image` event (Ctrl+V, which the
//     global hotkey swallows before the webview gets a paste event at all —
//     see App / lib.rs).
//   · DROP and the `+` PICKER carry PATHS. Nothing is copied: the chip IS the
//     path and the agent Reads the original.
//
// IO is injected (the saver) so the rules are testable without Tauri. The
// module does no rendering and holds no state of its own — the store is the
// composer's.

import { saveThreadAttachment } from "./ipc";
import { findThreadBySessionId } from "./threadStore";
import {
  addComposerAttachments,
  basenameOf,
  extOf,
  pastedAttachmentFileName,
  pastedAttachmentLabel,
  type ComposerAttachment,
} from "./composer";

/** Pasted files travel as base64 over IPC, so they get a ceiling; dropped and
 *  picked files are just paths and have none. Mirrors lib.rs's
 *  ATTACHMENT_CAP — change one, change the other. */
export const MAX_PASTE_BYTES = 25 * 1024 * 1024;

export type AttachmentSaver = (threadId: string, name: string, dataBase64: string) => Promise<string>;

let saver: AttachmentSaver = saveThreadAttachment;

/** Test seam: replace the IPC writer. */
export function __setAttachmentSaverForTests(next: AttachmentSaver | null): void {
  saver = next ?? saveThreadAttachment;
}

export type PastedFile = { file: File; ext: string };

/** The file items of a paste, taken SYNCHRONOUSLY. `getAsFile()` and
 *  `clipboardData` are only valid during the paste event — after the first
 *  await they read back null — so every file is grabbed up front, then
 *  persisted. Plain-text items are NOT in the result and are not touched:
 *  that is the dictation rule (Composer.tsx header). */
export function pickPastedFiles(items: ArrayLike<DataTransferItem> | null | undefined): PastedFile[] {
  if (!items) return [];
  const picked: PastedFile[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    // Prefer the real filename's extension (a copied report.pdf); fall back to
    // the mime subtype (a screenshot arrives as image/png, name-less).
    const ext = extOf(file.name) || item.type.split("/")[1] || "bin";
    picked.push({ file, ext });
  }
  return picked;
}

/** Base64-encode bytes in chunks (btoa chokes on a huge binary string). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export type StageResult = {
  staged: ComposerAttachment[];
  /** Why something was NOT staged — surfaced next to the box, never only
   *  logged (an attach that fails silently reads as a broken button). */
  error: string | null;
};

/** The thread a session's pastes are filed under, or the reason there is none. */
function threadIdFor(sessionId: string): { threadId: string } | { error: string } {
  const thread = findThreadBySessionId(sessionId);
  if (!thread) return { error: "Image paste needs a thread — this shell has none. Drop the file or use + instead." };
  return { threadId: thread.id };
}

/** Save already-encoded bytes as a thread attachment and stage the chip. The
 *  OS-level paste route (App) lands here with a PNG the backend encoded. */
export async function stagePastedBase64(
  sessionId: string,
  dataBase64: string,
  ext: string,
  byteLength: number,
  label?: string
): Promise<StageResult> {
  const target = threadIdFor(sessionId);
  if ("error" in target) return { staged: [], error: target.error };
  if (byteLength > MAX_PASTE_BYTES) {
    return {
      staged: [],
      error: `Pasted image too large (${Math.round(byteLength / 1e6)} MB) — drop the file or use + instead.`,
    };
  }
  const name = pastedAttachmentFileName(Date.now(), 1, ext);
  try {
    const path = await saver(target.threadId, name, dataBase64);
    const chip: ComposerAttachment = {
      path,
      name: label ?? pastedAttachmentLabel("", ext, 1, 1),
      size: byteLength,
    };
    addComposerAttachments(sessionId, [chip]);
    return { staged: [chip], error: null };
  } catch (err) {
    return { staged: [], error: `Couldn't save the pasted image: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Persist the files of one paste and stage them. One stamp per paste, the
 *  index disambiguates within it. Oversize items are skipped and named in
 *  the error; the rest still stage — one bad item must not void the paste. */
export async function stagePastedFiles(sessionId: string, picked: PastedFile[]): Promise<StageResult> {
  if (picked.length === 0) return { staged: [], error: null };
  const target = threadIdFor(sessionId);
  if ("error" in target) return { staged: [], error: target.error };
  const stamp = Date.now();
  const staged: ComposerAttachment[] = [];
  const problems: string[] = [];
  for (let i = 0; i < picked.length; i++) {
    const { file, ext } = picked[i]!;
    if (file.size > MAX_PASTE_BYTES) {
      problems.push(`${basenameOf(file.name) || `item ${i + 1}`} is too large (${Math.round(file.size / 1e6)} MB)`);
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const path = await saver(target.threadId, pastedAttachmentFileName(stamp, i + 1, ext), bytesToBase64(bytes));
      staged.push({
        path,
        name: pastedAttachmentLabel(file.name, ext, i + 1, picked.length),
        size: file.size,
      });
    } catch (err) {
      problems.push(`${basenameOf(file.name) || `item ${i + 1}`}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (staged.length > 0) addComposerAttachments(sessionId, staged);
  return {
    staged,
    error: problems.length > 0 ? `Couldn't attach — ${problems.join("; ")}` : null,
  };
}

/** Stage files that already exist on disk (drop + picker). By PATH: no copy,
 *  no thread needed, no size limit. Blank entries are ignored. */
export function stagePaths(sessionId: string, paths: readonly string[]): ComposerAttachment[] {
  const chips = paths
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => ({ path: p, name: basenameOf(p) }));
  if (chips.length > 0) addComposerAttachments(sessionId, chips);
  return chips;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drop claims
// ─────────────────────────────────────────────────────────────────────────────
// A drop reaches the app TWICE: lib.rs's window handler emits `file-drop`
// (App pastes the quoted paths into the active terminal — the pre-composer
// behaviour) and the webview's own `tauri://drag-drop` carries the SAME paths
// plus a cursor position (what the drop zone hit-tests). When a zone takes a
// drop it CLAIMS the paths here, and App's terminal paste, which waits a beat
// before acting, stands down. Order between the two events is not something
// to rely on, which is why the claim is a record and the paste is deferred.

const CLAIM_WINDOW_MS = 1500;
let lastClaim: { key: string; at: number } | null = null;

function claimKey(paths: readonly string[]): string {
  return paths.join("\n");
}

/** A drop zone took these paths. */
export function noteDropClaimed(paths: readonly string[], now: number = Date.now()): void {
  lastClaim = { key: claimKey(paths), at: now };
}

/** Were these paths claimed by a zone just now? Consuming — a second
 *  identical drop later is a new drop. */
export function consumeDropClaim(paths: readonly string[], now: number = Date.now()): boolean {
  if (!lastClaim) return false;
  const hit = lastClaim.key === claimKey(paths) && now - lastClaim.at <= CLAIM_WINDOW_MS;
  if (hit) lastClaim = null;
  return hit;
}

/** How long App's terminal paste waits for a possible claim. */
export const DROP_CLAIM_DEFER_MS = 80;

/** Test-only. */
export function __resetDropClaimsForTests(): void {
  lastClaim = null;
}
