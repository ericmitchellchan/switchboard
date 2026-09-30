// ONE THREAD'S PAGE, MERGED (SWIT-108 — lifted out of Home's poll so the lane
// page reads a thread exactly as Home does): page.json (the agent's),
// answers.json + retracted.json (the app's) and inbox.json, through
// pageStore's merge. A read that fails rejects — the caller keeps its last
// digest for that thread and the rest render.

import { readThreadFile } from "./ipc";
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
