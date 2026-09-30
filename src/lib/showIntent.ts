// THE AGENT'S `show` (SWIT-102) — put an EXISTING doc or file in front of the
// user.
//
// Eric, 2026-09-24: "can you open specs/sextant/gamma-metric-design.md in the
// panel" — and the agent's answer was "I have no other way to put a file in
// the panel." The `page` tool's op `show {address}` is that way. The MCP
// server (its one writer) appends to `shows.json` in the thread dir —
// `{version:1, shows:[{id:"o<n>", address, at}]}`, newest first, capped — and
// App's view-intent poll reads it beside the views/ listing and sets.json with
// the SAME baseline rule (the first listing per thread is a baseline; nothing
// replays after a restart), opening an unseen show in the ONE preview slot,
// FOCUSED — an explicit request, unlike the turn-end hook's open-behind.
//
// The address is the Evidence vocabulary's openable half and resolves through
// the SAME resolver the Evidence rows and `nextThingFor` use
// (`nextThing.resolveAddress`): `view:<id>[#anchor]`,
// `surface:<project>/<page>[?k=v]`, a KB doc in the real list, a repo-relative
// path against the thread's project. TWO additions, for `show` alone, because
// a `show` address is an explicit request and never a word in a sentence:
// an ABSOLUTE path (what an agent holds for a file outside its working
// directory) that sits inside the knowledge base is read as that KB doc — and
// as nothing else; an absolute path anywhere else opens nothing — and a
// TOP-LEVEL project file (`README.md`) opens without the slash the Evidence
// rule requires of a repo path.
//
// Pure — no IO, no React. Caps mirror the server's (SHOW_CAP /
// SHOW_ADDRESS_CAP); mcpServer.test.ts asserts they agree.

import type { Artifact } from "../types";
import { evidenceKindOf } from "./evidenceModel";
import { resolveAddress, type NextThingContext } from "./nextThing";

/** Shows kept in shows.json (the server trims to the same number). */
export const SHOW_CAP = 20;
/** An address, not prose (reviewFirst's cap). */
export const SHOW_ADDRESS_CAP = 300;

export type ThreadShow = { id: string; address: string; at: string };

const SHOW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Tolerant parse: junk → no shows; a broken entry drops alone (a bad id, a
 *  repeated id, an empty or over-long address); at most SHOW_CAP survive.
 *  Order is the file's — newest first. */
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
    out.push({ id: e.id, address, at: typeof e.at === "string" ? e.at : "" });
  }
  return out;
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

/** IS THE REPO FILE THERE? An Evidence row links a repo path syntactically
 *  and lets the viewer report a missing file; a `show` must open NOTHING for
 *  one (the tool result said it might not resolve — an error card in front of
 *  the user is not "nothing"). The app lists the file's directory
 *  (`explorer_list`, the same guarded read) and asks this. Names compare
 *  case-insensitively — the filesystem here does — and a directory of that
 *  name is not a file. Pure. */
export function repoFileListed(
  entries: readonly { name: string; is_dir: boolean }[],
  path: string
): boolean {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (name.length === 0) return false;
  return entries.some((e) => !e.is_dir && e.name.toLowerCase() === name);
}

/** The directory a repo path sits in, as `explorer_list` takes it (`""` =
 *  the project root). */
export function repoDirOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

export type ShowContext = NextThingContext & {
  /** The absolute KB root (agentContext's cache), for an absolute address. */
  kbRoot: string | null;
  /** What turns a path relative to the THREAD'S WORKING DIRECTORY — which is
   *  what the agent writes and what the server checked exists — into the
   *  project-relative path a repo-file artifact carries
   *  (`explorer.projectPlaceForDir`): `""` at a single-repo project's root,
   *  `apps/desktop/` in a subdirectory, `<repo>/` in a multi-repo project.
   *  Absent = `""`. Never applied to a KB doc. */
  pathPrefix?: string;
};

/** A repo-file hit, re-based from the thread's cwd onto the project root. */
function rebased(
  hit: { artifact: Artifact; anchor: string | null },
  prefix: string | undefined
): { artifact: Artifact; anchor: string | null } {
  if (!prefix || hit.artifact.kind !== "repo-file") return hit;
  return { ...hit, artifact: { ...hit.artifact, path: `${prefix}${hit.artifact.path}` } };
}

/** What a `show` address opens, or null when nothing resolves (the tool
 *  result already said so; the app opens nothing). */
export function showTargetFor(
  address: string,
  ctx: ShowContext
): { artifact: Artifact; anchor: string | null } | null {
  const a = address.trim();
  if (a.length === 0 || a.length > SHOW_ADDRESS_CAP) return null;
  if (isAbsolutePath(a)) {
    // KB only: a KB-relative remainder must never fall back to the thread's
    // project (it would name a file that is not there).
    const rel = kbRelativePath(a, ctx.kbRoot);
    return rel === null ? null : resolveAddress(rel, { ...ctx, projectKey: null });
  }
  const hit = resolveAddress(a, ctx);
  if (hit) return rebased(hit, ctx.pathPrefix);
  // A TOP-LEVEL project file (`README.md`, `CLAUDE.md`): the Evidence rule
  // wants a slash before it believes a repo path, because there a bare
  // `Cargo.toml` is a word in a sentence. A `show` address is never prose —
  // the agent named a file to open — so the slash is not required here. (The
  // KB list was asked first, above, and its miss reported.)
  if (ctx.projectKey !== null && !a.includes("/")) {
    const kind = evidenceKindOf(a);
    if (kind === "doc" || kind === "file") {
      return rebased({ artifact: { kind: "repo-file", project: ctx.projectKey, path: a }, anchor: null }, ctx.pathPrefix);
    }
  }
  return null;
}
