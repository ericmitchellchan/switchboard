// ONE THREAD'S PAGE, MERGED (SWIT-108 — lifted out of Home's poll so the lane
// page reads a thread exactly as Home does): page.json (the agent's),
// answers.json + retracted.json (the app's) and inbox.json, through
// pageStore's merge. A read that fails rejects — the caller keeps its last
// digest for that thread and the rest render.

import { readThreadFile, threadFilesStamp } from "./ipc";
import { mergePage, parseAnswersFile, parseInboxFile, parsePageFile, parseRetractedFile } from "./pageStore";
import type { InboxPost, RenderedPage } from "./pageStore";

export type ThreadPageDigest = { page: RenderedPage; posts: InboxPost[] };

export async function readThreadDigest(threadId: string): Promise<ThreadPageDigest> {
  const [pageRaw, answersRaw, inboxRaw, retractedRaw] = await Promise.all([
    readThreadFile(threadId, "page.json"),
    readThreadFile(threadId, "answers.json"),
    readThreadFile(threadId, "inbox.json"),
    // SWIT-105: a question dismissed on the page (`not needed`) is not open
    // anywhere else either — the dismissals live in this file.
    readThreadFile(threadId, "retracted.json"),
  ]);
  const posts = parseInboxFile(inboxRaw);
  return {
    page: mergePage(parsePageFile(pageRaw), parseAnswersFile(answersRaw), posts, parseRetractedFile(retractedRaw)),
    posts,
  };
}

// ── Stamp-gated (review of ec319c7, #7) ──────────────────────────────────────
// Home and the lane page poll every 5s; like App's pass they stat the thread's
// files first (`thread_files_stamp`, the max mtime of its page / answers /
// inbox / retracted / sets / shows) and read only when it moved. A failed
// stat (-1) never matches, so the next tick reads.

export type DigestCache = Map<string, { stamp: number; digest: ThreadPageDigest }>;

/** Reuse the cached digest? Only when a real stamp EQUALS the one it was read
 *  under. Pure. */
export function digestCacheHit(cached: { stamp: number } | undefined, stamp: number): boolean {
  return cached !== undefined && stamp !== -1 && cached.stamp === stamp;
}

export async function readThreadDigestGated(threadId: string, cache: DigestCache): Promise<ThreadPageDigest> {
  let stamp = -1;
  try {
    stamp = await threadFilesStamp(threadId);
  } catch {
    // stat failed — read
  }
  const hit = cache.get(threadId);
  if (hit && digestCacheHit(hit, stamp)) return hit.digest;
  const digest = await readThreadDigest(threadId);
  cache.set(threadId, { stamp, digest });
  return digest;
}
