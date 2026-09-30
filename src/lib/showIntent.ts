// THE AGENT'S `show` (SWIT-102) — put an EXISTING doc or file in front of the
// user.
//
// Eric, 2026-09-24: "can you open specs/sextant/gamma-metric-design.md in the
// panel" — and the agent's answer was "I have no other way to put a file in
// the panel." The `page` tool's op `show {address}` is that way. The MCP
// server (its one writer) appends to `shows.json` in the thread dir —
// `{version:1, shows:[{id:"o<n>", address, at, where?}]}`, newest first,
// capped — and App's view-intent poll reads it beside the views/ listing and
// sets.json with the SAME baseline rule (the first listing per thread is a
// baseline; nothing replays after a restart — and a FAILED read is no
// listing at all: `showsPass` skips the tick rather than baselining an empty
// set that would replay every stored show on the next good read), opening an
// unseen show in the ONE preview slot, FOCUSED — an explicit request, unlike
// the turn-end hook's open-behind.
//
// The address is the Evidence vocabulary's openable half and resolves through
// the SAME resolver the Evidence rows and `nextThingFor` use
// (`nextThing.resolveAddress`) — `view:<id>[#anchor]`,
// `surface:<project>/<page>[?k=v]`, a KB doc in the real list, a path
// relative to the thread's working directory RE-BASED onto its project (the
// `pathPrefix` every resolver path now carries). THREE rules are `show`'s
// alone, because a `show` address is an explicit request and never a word in
// a sentence:
//   1. THE SERVER'S WORD WINS OVER THE KB (review of 49ebb20, #1). A path the
//      server FOUND under the thread's working directory is recorded with
//      `where: "cwd"` and opens as THAT file — the knowledge base is not
//      asked, so `README.md` in a repo thread can never open
//      personal-kb/README.md. Only a path the server did NOT find there may
//      resolve to a KB doc. An old entry (no `where`) behaves as before.
//   2. An ABSOLUTE path (what an agent holds for a file outside its working
//      directory) that sits inside the knowledge base is read as that KB doc
//      — and as nothing else; an absolute path anywhere else opens nothing.
//   3. A TOP-LEVEL project file (`README.md`) opens without the slash the
//      Evidence rule requires of a repo path.
//
// Pure — no IO, no React. Caps mirror the server's (SHOW_CAP /
// SHOW_ADDRESS_CAP); mcpServer.test.ts asserts they agree.

import type { Artifact } from "../types";
import { evidenceKindOf, isPathShaped } from "./evidenceModel";
import { resolveAddress, type NextThingContext } from "./nextThing";

/** Shows kept in shows.json (the server trims to the same number). */
export const SHOW_CAP = 20;
/** An address, not prose (reviewFirst's cap). */
export const SHOW_ADDRESS_CAP = 300;

/** `where: "cwd"` — the server found the path under the thread's working
 *  directory, as a readable file (review of 49ebb20, #1). Absent on every
 *  other form and on entries written before the field existed. */
export type ThreadShow = { id: string; address: string; at: string; where?: "cwd" };

const SHOW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Tolerant parse: junk → no shows; a broken entry drops alone (a bad id, a
 *  repeated id, an empty or over-long address); at most SHOW_CAP survive.
 *  Order is the file's — newest first. An unknown `where` is dropped (the
 *  show then resolves the old way), never the entry. */
export function parseShowsFile(raw: string): ThreadShow[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
  const list = (data as { shows?: unknown }).shows;
  if (!Array.isArray(list)) return [];
  const out: ThreadShow[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (out.length >= SHOW_CAP) break;
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !SHOW_ID_RE.test(e.id) || seen.has(e.id)) continue;
    if (typeof e.address !== "string") continue;
    const address = e.address.trim();
    if (address.length === 0 || address.length > SHOW_ADDRESS_CAP) continue;
    seen.add(e.id);
    const show: ThreadShow = { id: e.id, address, at: typeof e.at === "string" ? e.at : "" };
    if (e.where === "cwd") show.where = "cwd";
    out.push(show);
  }
  return out;
}

/** What one tick of the view-intent poll does with shows.json (review of
 *  49ebb20, #2). `raw === null` = the READ FAILED: skip the block and record
 *  nothing, so a transient error on a thread's first tick is not taken for
 *  "no shows" (a baseline of nothing would replay every stored show on the
 *  next good tick). First good read = the BASELINE (every id seen, nothing
 *  opened). After that, the unseen shows OLDEST FIRST, so a burst lands with
 *  the newest in front. Pure: the caller owns the seen set and adds an id
 *  only after it has handled that show. */
export type ShowsPass =
  | { kind: "skip" }
  | { kind: "baseline"; ids: string[] }
  | { kind: "open"; shows: ThreadShow[] };

export function showsPass(seen: ReadonlySet<string> | undefined, raw: string | null): ShowsPass {
  if (raw === null) return { kind: "skip" };
  const shows = parseShowsFile(raw);
  if (!seen) return { kind: "baseline", ids: shows.map((s) => s.id) };
  return { kind: "open", shows: [...shows].reverse().filter((s) => !seen.has(s.id)) };
}

/** Is this an absolute filesystem path (a drive path or a rooted one)? */
function isAbsolutePath(address: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(address) || address.startsWith("/") || address.startsWith("\\");
}

/** The KB-relative path of an absolute path INSIDE the knowledge base, or
 *  null (no known root, or the path is elsewhere). Separators fold to `/`; a
 *  drive path compares case-insensitively (Windows), and the returned path
 *  keeps the address's own casing — the doc list decides whether it exists. */
export function kbRelativePath(address: string, kbRoot: string | null | undefined): string | null {
  if (!kbRoot) return null;
  const path = address.trim().replace(/\\/g, "/");
  const root = kbRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root.length === 0) return null;
  const fold = (s: string) => (/^[A-Za-z]:/.test(root) ? s.toLowerCase() : s);
  if (!fold(path).startsWith(`${fold(root)}/`)) return null;
  const rel = path.slice(root.length + 1);
  return rel.length > 0 ? rel : null;
}

/** CAN THE VIEWER RENDER IT? An Evidence row links a repo path syntactically
 *  and lets the viewer report a missing file; a `show` must open NOTHING for
 *  one (the tool result said it might not resolve — an error card in front of
 *  the user is not "nothing"). The test is the viewer's own read
 *  (`explorer_read`: the file exists, is a file, is ≤ 512 KB and is UTF-8
 *  text) — a listing only proved the NAME, and let a binary or oversize file
 *  through to an error card (review of 49ebb20, #3). Never throws. */
export async function repoFileOpens(read: () => Promise<string>): Promise<boolean> {
  try {
    await read();
    return true;
  } catch {
    return false;
  }
}

export type ShowContext = NextThingContext & {
  /** The absolute KB root (agentContext's cache), for an absolute address. */
  kbRoot: string | null;
  /** The thread's working directory — what a `where: "cwd"` path is relative
   *  to, when the thread's folder is in no registry project (it may still be
   *  inside the knowledge base). */
  workingDir?: string | null;
};

/** What a `show` opens, or null when nothing resolves (the tool result
 *  already said so; the app opens nothing). `where` is the entry's own field
 *  (rule 1 in the header). */
export function showTargetFor(
  address: string,
  ctx: ShowContext,
  where?: "cwd"
): { artifact: Artifact; anchor: string | null } | null {
  const a = address.trim();
  if (a.length === 0 || a.length > SHOW_ADDRESS_CAP) return null;
  if (isAbsolutePath(a)) {
    // KB only: a KB-relative remainder must never fall back to the thread's
    // project (it would name a file that is not there).
    const rel = kbRelativePath(a, ctx.kbRoot);
    return rel === null ? null : resolveAddress(rel, { ...ctx, projectKey: null });
  }
  if (where === "cwd" && isPathShaped(a)) {
    // The server found THIS file under the thread's working directory. The
    // KB is never asked first — a KB doc of the same path would shadow it.
    if (ctx.projectKey !== null) {
      return { artifact: { kind: "repo-file", project: ctx.projectKey, path: `${ctx.pathPrefix ?? ""}${a}` }, anchor: null };
    }
    // No registry project holds the folder; it opens only if the folder is
    // inside the knowledge base, as that KB doc.
    const wd = (ctx.workingDir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const rel = wd.length > 0 ? kbRelativePath(`${wd}/${a}`, ctx.kbRoot) : null;
    return rel === null ? null : resolveAddress(rel, { ...ctx, projectKey: null });
  }
  const hit = resolveAddress(a, ctx);
  if (hit) return hit;
  // A TOP-LEVEL project file (`README.md`, `CLAUDE.md`): the Evidence rule
  // wants a slash before it believes a repo path, because there a bare
  // `Cargo.toml` is a word in a sentence. A `show` address is never prose —
  // the agent named a file to open — so the slash is not required here. (The
  // KB list was asked first, above, and its miss reported.)
  if (ctx.projectKey !== null && !a.includes("/")) {
    const kind = evidenceKindOf(a);
    if (kind === "doc" || kind === "file") {
      return { artifact: { kind: "repo-file", project: ctx.projectKey, path: `${ctx.pathPrefix ?? ""}${a}` }, anchor: null };
    }
  }
  return null;
}
