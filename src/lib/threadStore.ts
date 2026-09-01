// Thread store (T5) — durable agent threads that survive app/machine restarts.
//
// A thread binds a Switchboard session (a tab) to a Claude Code conversation
// through two critical persisted fields: `chatSessionId` (the claude UUID we
// mint) and `chatStarted` (gates `--resume` vs `--session-id`). Everything
// else here is bookkeeping around those two fields.
//
// Layout:
//   1. Pure helpers — unit-tested under Node: record construction/sanitizing,
//      launch-command choice, the bracketed-paste-aware chatStarted detector,
//      restore reconciliation, disk (de)serialization + disk-wins merge, and
//      the SavedWorkspace v1/v2→v3 migration + staleness rules (they live here,
//      not in workspace.ts, so tests can import them without dragging in the
//      xterm-backed terminal facade that workspace.ts depends on).
//   2. Module-level store — same shape as route.ts / terminalRegistry.ts
//      (module singletons + useSyncExternalStore), deliberately not zustand.
//
// Persistence is DOUBLE-WRITTEN: threads ride inside the SavedWorkspace v2
// localStorage blob AND mirror to disk (save_threads/load_threads IPC, wired
// in workspace.ts). On boot, DISK WINS over localStorage when both exist —
// disk survives webview storage clears. Records must stay LEAN (localStorage
// is one shared key; quota overflow silently halts persistence): sanitizeThread
// is the single gate every loaded/merged record passes through.
//
// Ky bug, recorded per the architecture doc: a cloud sync once wiped
// chatSessionId by wholesale record replacement. No sync exists here, but all
// store mutators below update field-by-field on the existing record — never
// bulk-replace a thread with an externally-sourced object.

import { useSyncExternalStore } from "react";
import type { AgentStatus, SavedSession, SavedWorkspace, Thread } from "../types";
import { parsePanels, parsePanelsV3, parsePanelWidth, parsePanelSides } from "./panelStore";
import { sanitizeForTypedLine, SPAWN_CONTEXT_MAX } from "./agentContext";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Mint a v4 uuid (thread ids and claude chat-session ids). */
export function mintUuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  // Extremely defensive fallback — every runtime we target has randomUUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Construct a fresh thread record. The chatSessionId is minted HERE — before
 *  claude ever runs — so the conversation UUID is pinned from the start. */
export function newThread(args: {
  title: string;
  workingDir: string;
  now?: number;
}): Thread {
  const now = args.now ?? Date.now();
  return {
    id: mintUuid(),
    title: args.title,
    workingDir: args.workingDir,
    chatSessionId: mintUuid(),
    chatStarted: false,
    sessionId: null,
    createdAt: now,
    lastActivityAt: now,
  };
}

/** The launch line typed into the thread's shell (without the trailing \r).
 *
 *  `resume` is GROUND TRUTH from disk (claude_session_exists: does
 *  ~/.claude/projects/<munged-cwd>/<chatSessionId>.jsonl exist?), NOT the
 *  chatStarted hint. Decision table:
 *
 *    transcript exists | chatStarted | launch
 *    ------------------+-------------+----------------------------------------
 *    true              | true        | --resume
 *    true              | false       | --resume     (heals the PiP bypass:
 *                                      first turn typed in the PiP window
 *                                      never reached the main detector)
 *    false             | true        | --session-id (heals the shell false
 *                                      positive: Ctrl+C claude then `git
 *                                      status⏎` flipped the flag forever)
 *    false             | false       | --session-id
 *
 *  i.e. launch = exists alone; chatStarted is a UI hint only. An unstarted
 *  claude session has nothing on disk to resume — resuming it errors — so it
 *  relaunches fresh under the SAME pinned uuid.
 *
 *  `appendSystemPrompt` (T8/A4, seam 1) is the panel-context one-liner from
 *  agentContext.buildSpawnContext. It is appended as a double-quoted argument
 *  and RE-SANITIZED here — the sanitizer is idempotent, so this costs nothing
 *  and makes it impossible for a future caller to hand this function raw text
 *  that breaks out of the quotes or plants an Enter in the typed line. Null /
 *  empty omits the flag ENTIRELY (never `--append-system-prompt ""`). */
export function launchCommand(args: {
  chatSessionId: string;
  resume: boolean;
  appendSystemPrompt?: string | null;
  /** SWIT-49: absolute path of the per-spawn mcp-config file (Switchboard's
   *  own page-tool server). Regenerated at every spawn; null/empty omits the
   *  flag entirely — the thread runs without page tools, degraded not broken.
   *  Backslashes fold to forward slashes BEFORE the sanitizer (which strips
   *  `\` as a shell metachar) — node and claude accept `/` on Windows. */
  mcpConfig?: string | null;
}): string {
  const base = args.resume
    ? `claude --resume ${args.chatSessionId}`
    : `claude --session-id ${args.chatSessionId}`;
  const mcp = sanitizeForTypedLine((args.mcpConfig ?? "").replace(/\\/g, "/"), 400);
  const withMcp = mcp.length > 0 ? `${base} --mcp-config "${mcp}"` : base;
  const context = sanitizeForTypedLine(args.appendSystemPrompt ?? "", SPAWN_CONTEXT_MAX);
  return context.length > 0 ? `${withMcp} --append-system-prompt "${context}"` : withMcp;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Default thread title: repo name + date ("lodestar · Jul 31"). */
export function defaultThreadTitle(repoName: string, now: Date = new Date()): string {
  return `${repoName} · ${MONTHS[now.getMonth()]} ${now.getDate()}`;
}

/** Do two paths name the same directory? Windows-shaped comparison: separator
 *  style, a trailing separator, the verbatim `\\?\` prefix and CASE are all
 *  insignificant here (NTFS is case-insensitive, and the two strings reach us
 *  from different sources — our own config vs claude's session file).
 *
 *  Used at revive time: a PROMOTED thread's workingDir is CLAUDE's cwd, which
 *  is not necessarily the cwd its tab was spawned in (`Ctrl+T`, `cd`, then
 *  `claude`). Resuming from the wrong directory silently finds no transcript,
 *  because claude locates it by munging its own cwd. */
export function sameWorkingDir(a: string, b: string): boolean {
  const norm = (p: string) => {
    let s = p.replace(/\\/g, "/");
    if (s.startsWith("//?/UNC/")) s = `//${s.slice(8)}`;
    else if (s.startsWith("//?/")) s = s.slice(4);
    return s.replace(/\/+$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
}

/** Cross-platform basename of a thread's workingDir — the repo meta shown in
 *  the side menu and the history screen, and the name a PROMOTED thread's
 *  default title is built from (so promoted and explicit titles read alike). */
export function threadRepoName(workingDir: string): string {
  const parts = workingDir.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? workingDir;
}

/** The title THIS record would have had if it had never been named — repo +
 *  the day the thread was CREATED, not today. Rename falls back to it when the
 *  box is emptied (increment E, Decision 4): recomputing from `new Date()`
 *  would silently re-date a month-old thread to this morning, which is a
 *  different (and false) label. */
export function derivedThreadTitle(thread: Thread): string {
  return defaultThreadTitle(
    threadRepoName(thread.workingDir),
    thread.createdAt > 0 ? new Date(thread.createdAt) : new Date()
  );
}

/** Lean-record gate: rebuild a Thread from unknown input keeping ONLY the
 *  schema fields (drops any scrollback/messages/derived state that might have
 *  leaked into a persisted blob), or reject it. Every load path — localStorage
 *  migration and disk parse — funnels through here. */
export function sanitizeThread(raw: unknown): Thread | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (
    typeof t.id !== "string" ||
    typeof t.title !== "string" ||
    typeof t.workingDir !== "string" ||
    typeof t.chatSessionId !== "string" ||
    t.id.length === 0 ||
    t.chatSessionId.length === 0
  ) {
    return null;
  }
  const out: Thread = {
    id: t.id,
    title: t.title,
    workingDir: t.workingDir,
    chatSessionId: t.chatSessionId,
    chatStarted: t.chatStarted === true,
    sessionId: typeof t.sessionId === "string" ? t.sessionId : null,
    createdAt: typeof t.createdAt === "number" ? t.createdAt : 0,
    lastActivityAt: typeof t.lastActivityAt === "number" ? t.lastActivityAt : 0,
  };
  // `archivedAt` is OPTIONAL surface (increment E): the key exists only while
  // the thread is actually archived, so an active record serializes byte-for-
  // byte as it did before archiving existed. A non-positive or non-numeric
  // value is not "archived at the epoch", it is not archived.
  if (typeof t.archivedAt === "number" && t.archivedAt > 0) out.archivedAt = t.archivedAt;
  return out;
}

/** Is this thread archived? THE predicate — every surface that hides archived
 *  threads asks this rather than testing the field itself, so "archived" has
 *  one definition (a positive timestamp) in one place. */
export function isThreadArchived(thread: Thread): boolean {
  return typeof thread.archivedAt === "number" && thread.archivedAt > 0;
}

/** The threads every ordinary surface means: side-menu rows, the `See all (N)`
 *  count, the history screen's Active tab. */
export function activeThreads(threads: readonly Thread[]): Thread[] {
  return threads.filter((t) => !isThreadArchived(t));
}

/** The history screen's Archived tab — the ONLY surface archived threads
 *  appear on. */
export function archivedThreads(threads: readonly Thread[]): Thread[] {
  return threads.filter((t) => isThreadArchived(t));
}

function sanitizeThreads(raw: unknown): Thread[] {
  if (!Array.isArray(raw)) return [];
  const out: Thread[] = [];
  for (const item of raw) {
    const t = sanitizeThread(item);
    if (t) out.push(t);
  }
  return out;
}

// ── chatStarted detector ─────────────────────────────────────────────────────

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Stateful detector for the first REAL user turn: returns true when an Enter
 *  (\r or \n) arrives OUTSIDE a bracketed paste AND some message content has
 *  been seen. Rules:
 *  - Bracketed-paste sequences are stripped before deciding: a paste is NOT
 *    typing and must never flip chatStarted on its own (claude's session file
 *    doesn't exist until a real turn; resuming an unstarted session errors).
 *  - Paste BODY still counts as composer CONTENT — paste text, then press a
 *    real Enter, and that Enter is a real send.
 *  - A bare Enter with an empty composer sends nothing in the TUI, so it does
 *    not flip either (guards against a stray settle-Enter after launch).
 *  - Escape sequences (arrow keys etc.) are skipped, not counted as content.
 *  Feed every onData chunk; state carries across chunks. */
export function createChatStartDetector(): (data: string) => boolean {
  let inPaste = false;
  let hasContent = false;
  return (data: string): boolean => {
    let fired = false;
    let i = 0;
    while (i < data.length) {
      if (!inPaste && data.startsWith(PASTE_START, i)) {
        inPaste = true;
        i += PASTE_START.length;
        continue;
      }
      if (inPaste) {
        if (data.startsWith(PASTE_END, i)) {
          inPaste = false;
          i += PASTE_END.length;
          continue;
        }
        hasContent = true; // pasted text lands in the composer
        i++;
        continue;
      }
      const ch = data[i];
      if (ch === "\r" || ch === "\n") {
        if (hasContent) fired = true;
        i++;
        continue;
      }
      if (ch === "\x1b") {
        // Skip the escape sequence (never content). CSI: ESC [ … final byte
        // in 0x40–0x7E. SS3: ESC O <byte>. Anything else: ESC + one byte
        // (alt-keys).
        if (data[i + 1] === "[") {
          let j = i + 2;
          while (j < data.length) {
            const code = data.charCodeAt(j);
            if (code >= 0x40 && code <= 0x7e) break;
            j++;
          }
          i = j + 1;
        } else if (data[i + 1] === "O") {
          i += 3;
        } else {
          i += 2;
        }
        continue;
      }
      if (ch >= " " && ch !== "\x7f") hasContent = true;
      i++;
    }
    return fired;
  };
}

// ── Shell-ready wait ─────────────────────────────────────────────────────────

export const SHELL_READY_SETTLE_MS = 300;
export const SHELL_READY_FALLBACK_MS = 1500;

/** Wait for a thread's shell session to be ready to receive the typed claude
 *  launch line. Definition: first ACCEPTED PTY output chunk + a short settle
 *  (the first output is the prompt painting — proof the shell spawned and
 *  ConPTY is delivering; the settle lets multi-chunk prompt paints like
 *  oh-my-posh finish so the typed line isn't interleaved mid-paint). A
 *  fallback timer covers the no-output cases: a silent shell profile, and
 *  reviving into an ALREADY-RUNNING restored shell whose prompt painted long
 *  ago — the fallback IS the path there. Never rejects: worst case the line
 *  is typed early and ConPTY buffers it (accepted v1).
 *
 *  Chunks are FILTERED by spawn generation: on revive-into-an-exited-tab the
 *  restart's old reader thread can emit dying chunks stamped with the
 *  previous generation, and those must not satisfy "first output" (they'd
 *  start the settle before the new shell even spawned). `expectedGen()` is
 *  the registry's current expectation; undefined means no registry entry yet
 *  (fresh session whose pane hasn't mounted) — accepted, because a fresh
 *  session id is a brand-new UUID with no stale readers possible (this is
 *  deliberately looser than terminalLifecycle.acceptsGeneration, whose
 *  undefined-rejects rule targets closed sessions).
 *
 *  Dependencies are injected (subscribe = the session's output events,
 *  expectedGen = registry lookup) so this stays pure-testable under Node. */
export function waitForShellReady(opts: {
  subscribe: (cb: (gen: number) => void) => Promise<() => void>;
  expectedGen: () => number | undefined;
  settleMs?: number;
  fallbackMs?: number;
}): Promise<void> {
  const settleMs = opts.settleMs ?? SHELL_READY_SETTLE_MS;
  const fallbackMs = opts.fallbackMs ?? SHELL_READY_FALLBACK_MS;
  return new Promise((resolve) => {
    let settled = false;
    let sawOutput = false;
    let unlisten: (() => void) | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      unlisten?.();
      resolve();
    };
    const fallback = setTimeout(finish, fallbackMs);
    opts
      .subscribe((gen) => {
        if (settled || sawOutput) return;
        const expected = opts.expectedGen();
        if (expected !== undefined && gen !== expected) return; // stale spawn's dying chunk
        sawOutput = true;
        clearTimeout(fallback);
        setTimeout(finish, settleMs);
      })
      .then((fn) => {
        if (settled) fn();
        else unlisten = fn;
      });
  });
}

// ── Restore reconciliation ───────────────────────────────────────────────────

/** Remap thread→session bindings through the workspace-restore id map. A
 *  thread whose old sessionId has no restored counterpart is severed
 *  (sessionId=null → revivable). Threads whose sessions DID restore keep the
 *  binding (the row points at the restored tab and its scrollback) — but note
 *  the restored shell is a fresh process: the claude PROCESS is gone either
 *  way, so liveness (the transient `launched` set below) starts empty on boot
 *  and EVERY thread shows revive after an app restart. */
export function remapThreadSessions(
  threads: Thread[],
  idMap: Map<string, string>
): Thread[] {
  return threads.map((t) =>
    t.sessionId ? { ...t, sessionId: idMap.get(t.sessionId) ?? null } : t
  );
}

// ── Thread history selection (increment C) ───────────────────────────────────
// Threads are the LONG history; the side menu is a 218px rail. These pure
// helpers decide what the rail shows and how the See-all screen orders and
// filters. Kept here (not in the components) so the "a live thread is never
// scrolled out of the list" rule is unit-tested rather than eyeballed.

/** Rows the side-menu Threads section shows before the `See all (N)` row. */
export const MENU_THREAD_LIMIT = 8;

/** Canonical history order: LIVE threads first, then most-recent activity
 *  first, then newest-created, then id — the last two only so the order is
 *  total and stable (equal timestamps must not reshuffle between renders). */
export function sortThreadsForHistory(
  threads: readonly Thread[],
  live: ReadonlySet<string>
): Thread[] {
  return [...threads].sort((a, b) => {
    const liveDelta = Number(live.has(b.id)) - Number(live.has(a.id));
    if (liveDelta !== 0) return liveDelta;
    if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id.localeCompare(b.id);
  });
}

/** The side menu's rows: at most `limit` — EXCEPT that every LIVE thread is
 *  always present regardless of recency. A live thread scrolled out of the
 *  list would be a bug (you cannot reach the conversation you are having), so
 *  when more than `limit` threads are live the list grows to fit them rather
 *  than truncating. Live threads sort first, so this is a widened slice.
 *
 *  ARCHIVED threads are dropped here, before any of that (increment E): the
 *  rail is the recent-work list and archiving is how you say "not now". The
 *  filter lives INSIDE this function rather than at its two call sites so the
 *  rail and its `See all (N)` count can never disagree about what is on it.
 *  Archiving a thread that is still LIVE is allowed and does hide it — that is
 *  an explicit user act on the record, not the truncation the rule above
 *  guards against, and the thread's TAB is untouched either way. */
export function selectMenuThreads(
  threads: readonly Thread[],
  live: ReadonlySet<string>,
  limit: number = MENU_THREAD_LIMIT
): Thread[] {
  const sorted = sortThreadsForHistory(activeThreads(threads), live);
  let liveCount = 0;
  for (const t of sorted) if (live.has(t.id)) liveCount++;
  return sorted.slice(0, Math.max(limit, liveCount));
}

/** A tab-bar-less session as the menu sees it (SWIT-46): published by App
 *  from its session state (name/status live there, not on any thread
 *  record). Panel-owned sessions are filtered out BEFORE publishing — the
 *  menu must never offer a second live view. */
export type MenuSession = {
  id: string;
  name: string;
  workingDir: string;
  status: AgentStatus;
};

/** One project group of the side-menu Threads band (SWIT-46). */
export type MenuThreadGroup = {
  /** The repo folder name (threadRepoName) — what the group header prints. */
  project: string;
  threads: Thread[];
  /** Live threads in this group — the header's `N ●`. */
  liveCount: number;
};

/** Group the rail's selection by project, preserving selectMenuThreads'
 *  order (live first, then recency) — so groups appear in the order of their
 *  best-ranked thread and live-first holds WITHIN each group by construction.
 *  Selection rules (archived hidden, live never truncated) are unchanged:
 *  this is a fold over selectMenuThreads' output, never a second selection. */
export function groupMenuThreads(
  threads: readonly Thread[],
  live: ReadonlySet<string>,
  limit: number = MENU_THREAD_LIMIT
): MenuThreadGroup[] {
  const shown = selectMenuThreads(threads, live, limit);
  const groups: MenuThreadGroup[] = [];
  const byName = new Map<string, MenuThreadGroup>();
  for (const t of shown) {
    const project = threadRepoName(t.workingDir);
    let group = byName.get(project);
    if (!group) {
      group = { project, threads: [], liveCount: 0 };
      byName.set(project, group);
      groups.push(group);
    }
    group.threads.push(t);
    if (live.has(t.id)) group.liveCount += 1;
  }
  return groups;
}

/** The `shells` group: published sessions no thread record claims (the
 *  promote-on-claude rule defines the set — a plain Ctrl+T shell has no
 *  record until a claude conversation is actually running in it). Derived
 *  from the SAME view as the thread groups, so a promotion moves a row
 *  between groups in one render. */
export function selectShellSessions(
  threads: readonly Thread[],
  sessions: readonly MenuSession[]
): MenuSession[] {
  const bound = new Set<string>();
  for (const t of threads) if (t.sessionId) bound.add(t.sessionId);
  return sessions.filter((s) => !bound.has(s.id));
}

/** Resolve an `@thread` target (SWIT-52): exact id first, else a
 *  case-insensitive TITLE substring matching EXACTLY ONE active thread
 *  (self excluded — a post cannot target its own thread). Pure; errors are
 *  human sentences the composer prints as-is. */
export function resolveThreadByQuery(
  threads: readonly Thread[],
  query: string,
  excludeThreadId: string | null = null
): { thread: Thread } | { error: string } {
  const q = query.trim();
  if (q.length === 0) return { error: "name a thread after the @" };
  const active = activeThreads(threads);
  const byId = active.find((t) => t.id === q);
  if (byId) {
    return byId.id === excludeThreadId ? { error: "that is THIS thread" } : { thread: byId };
  }
  const needle = q.toLowerCase();
  const matches = active.filter(
    (t) => t.title.toLowerCase().includes(needle) && t.id !== excludeThreadId
  );
  if (matches.length === 1) return { thread: matches[0] };
  if (matches.length === 0) return { error: `no thread matches "${q}"` };
  return {
    error: `"${q}" matches ${matches.length} threads (${matches
      .slice(0, 3)
      .map((t) => `"${t.title}"`)
      .join(", ")}${matches.length > 3 ? ", …" : ""}) — be more specific`,
  };
}

/** Free-text filter for the See-all screen: case-insensitive substring over
 *  TITLE + repo name. A blank/whitespace query matches everything. */
export function filterThreads(threads: readonly Thread[], query: string): Thread[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...threads];
  return threads.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      threadRepoName(t.workingDir).toLowerCase().includes(q)
  );
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Relative last-activity label ("just now" / "12m ago" / "2h ago" / "3d ago").
 *  A record with no recorded activity reads "—" rather than "56y ago" — an
 *  honest blank beats a wrong number. Future timestamps (clock skew) clamp to
 *  "just now" instead of printing a negative age. */
export function relativeActivity(timestamp: number, now: number = Date.now()): string {
  if (!timestamp) return "—";
  const delta = now - timestamp;
  if (delta < MINUTE_MS) return "just now";
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)}m ago`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)}h ago`;
  return `${Math.floor(delta / DAY_MS)}d ago`;
}

// ── Disk mirror (de)serialization + merge ────────────────────────────────────

export const THREADS_DISK_VERSION = 1;

export function serializeThreadsForDisk(threads: Thread[]): string {
  return JSON.stringify({
    version: THREADS_DISK_VERSION,
    savedAt: Date.now(),
    // Re-sanitize on the way out — the lean invariant holds even if a caller
    // ever hands us decorated records.
    threads: sanitizeThreads(threads),
  });
}

/** Parse the disk mirror. Returns null for "no disk copy" (empty/absent file
 *  or unreadable payload) — DISTINCT from a valid empty list, which is a real
 *  state (user deleted every thread) and must win over localStorage. */
export function parseThreadsFromDisk(raw: string): Thread[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; threads?: unknown };
    if (parsed?.version !== THREADS_DISK_VERSION || !Array.isArray(parsed.threads)) {
      return null;
    }
    return sanitizeThreads(parsed.threads);
  } catch {
    return null;
  }
}

/** Boot merge rule: DISK WINS over the localStorage copy whenever a disk
 *  mirror exists (disk survives webview storage clears; both are written on
 *  the same cadence so they only diverge when one side was wiped). */
export function mergeThreads(
  diskThreads: Thread[] | null,
  localThreads: Thread[]
): Thread[] {
  return diskThreads ?? localThreads;
}

// ── SavedWorkspace v1/v2/v3/v4 → v5 migration + staleness ────────────────────

/** Migrate a raw parsed workspace blob to v5. Additive per version — each new
 *  schema EXTENDS this table rather than forking a second migrator:
 *
 *  | from | sessions/layout | threads             | panels                       |
 *  |------|-----------------|---------------------|------------------------------|
 *  | v1   | preserved       | `[]`                | `{}`                         |
 *  | v2   | preserved       | sanitized           | `{}`                         |
 *  | v3   | preserved       | sanitized           | `Artifact` → one-tab strip   |
 *  | v4   | preserved       | sanitized           | tolerant-parsed strips       |
 *  | v5   | preserved       | sanitized           | tolerant-parsed strips       |
 *
 *  v4 → v5 (increment H) is LOSSLESS AND SHAPELESS: a strip may now hold a
 *  `session` artifact, which a v4 blob simply never contained, so the parse is
 *  identical and a v4 payload is already a valid v5 one. The number still moves
 *  because the CONTENT changed meaning — a v5 blob read by v4 code would drop
 *  those entries silently, and the version is what makes that legible.
 *
 *  The width is clamped from whatever is present at every version (it has
 *  existed since v3 and is not session-bound). Anything else is rejected. */
/** Re-key a ≤v5 record (keyed by SAVED session id) onto thread ids via the
 *  blob's own thread records (SWIT-47): an entry whose session a thread
 *  claims follows that thread; the rest were SHELL panels, transient by the
 *  new rule, and are dropped. Pure; shared by the panels and panelSides
 *  migrations. */
function rekeyBySavedThreads<V>(
  record: Record<string, V>,
  threads: readonly Thread[]
): Record<string, V> {
  const threadBySession = new Map<string, string>();
  for (const t of threads) if (t.sessionId) threadBySession.set(t.sessionId, t.id);
  const out: Record<string, V> = {};
  for (const [sessionId, value] of Object.entries(record)) {
    const threadId = threadBySession.get(sessionId);
    if (threadId) out[threadId] = value;
  }
  return out;
}

export function migrateSavedWorkspace(raw: unknown): SavedWorkspace | null {
  if (!raw || typeof raw !== "object") return null;
  const ws = raw as Record<string, unknown>;
  const version = ws.version;
  if (
    version !== 1 &&
    version !== 2 &&
    version !== 3 &&
    version !== 4 &&
    version !== 5 &&
    version !== 6
  ) {
    return null;
  }
  if (!Array.isArray(ws.sessions)) return null;
  const threads = version === 1 ? [] : sanitizeThreads(ws.threads);
  // v6 (SWIT-47): panels + panelSides are keyed by THREAD id. A ≤v5 blob keys
  // them by saved session id — re-keyed here through the blob's own thread
  // records, so a thread's panel survives the version bump and a shell's is
  // dropped (transient by the new rule).
  const rawPanels =
    version >= 4 ? parsePanels(ws.panels) : version === 3 ? parsePanelsV3(ws.panels) : {};
  const panels = version === 6 ? rawPanels : rekeyBySavedThreads(rawPanels, threads);
  const rawSides = parsePanelSides(ws.panelSides);
  const panelSides = version === 6 ? rawSides : rekeyBySavedThreads(rawSides, threads);
  return {
    version: 6,
    sessions: ws.sessions as SavedSession[],
    activeSessionId: typeof ws.activeSessionId === "string" ? ws.activeSessionId : null,
    paneLayout: ws.paneLayout ?? null,
    focusedPaneId: typeof ws.focusedPaneId === "string" ? ws.focusedPaneId : null,
    sessionCounter: typeof ws.sessionCounter === "number" ? ws.sessionCounter : 0,
    savedAt: typeof ws.savedAt === "number" ? ws.savedAt : 0,
    threads,
    panels,
    panelWidth: parsePanelWidth(ws.panelWidth),
    panelSides,
  };
}

/** 7-day staleness applies to SESSIONS only: a stale workspace loses its
 *  sessions/layout, but threads are durable by definition and survive — and
 *  since v6 keys panels by THREAD id, a thread's panel survives WITH it
 *  (SWIT-47: "a strip whose thread exists is kept"). The session artifacts
 *  inside those strips are dropped at restore (their sessions are gone); the
 *  global panelWidth is not session-bound and survives. */
export function applyWorkspaceStaleness(
  ws: SavedWorkspace,
  now: number,
  maxAgeMs: number
): SavedWorkspace {
  if (now - ws.savedAt <= maxAgeMs) return ws;
  return {
    ...ws,
    sessions: [],
    activeSessionId: null,
    paneLayout: null,
    focusedPaneId: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

/** Snapshot consumed by ThreadsSection (useSyncExternalStore). */
export type ThreadsView = {
  threads: readonly Thread[];
  /** Threads whose claude process was launched in THIS app run (create or
   *  revive). Transient on purpose: empty on boot, so an app restart shows
   *  every thread as revivable — the claude processes are gone.
   *
   *  KNOWN v1 BOUNDARY: claude exiting INSIDE a live shell (/exit, double
   *  Ctrl+C) leaves the shell running, so nothing clears this flag — the row
   *  keeps showing live until the tab closes / the app restarts. Detecting
   *  that would mean parsing claude's output (out of scope v1). It is
   *  SELF-HEALING though: revive is ground-truth (claude_session_exists
   *  decides --resume vs --session-id from the transcript on disk), so
   *  reviving such a thread later still does the right thing. */
  launched: ReadonlySet<string>;
  /** Threads in the ~10s revive-boot window (MCP/tool reload). */
  booting: ReadonlySet<string>;
  sessionStatuses: Readonly<Record<string, AgentStatus>>;
  activeSessionId: string | null;
  /** Tab-bar-less sessions (SWIT-46) — App publishes its TAB sessions here so
   *  the menu's `shells` group can be derived (selectShellSessions) in the
   *  same view as the thread groups. Transient, like sessionStatuses. */
  menuSessions: readonly MenuSession[];
  /** Unread cross-thread posts per thread id — the `↓ N` chip. RENDER-SIDE
   *  ONLY until SWIT-52 publishes real counts; empty means no chip. */
  unreadPosts: Readonly<Record<string, number>>;
};

let threads: Thread[] = [];
const launched = new Set<string>();
const booting = new Set<string>();
let sessionStatuses: Record<string, AgentStatus> = {};
let activeSessionId: string | null = null;
let menuSessions: readonly MenuSession[] = [];
let unreadPosts: Record<string, number> = {};

const listeners = new Set<() => void>();
let cachedView: ThreadsView | null = null;

function bump(): void {
  cachedView = null;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Raw store subscription for DERIVED views that live in other modules (the
 *  composer's visibility is a fact about `threads` + `launched`, not a second
 *  detector — see lib/composer.composerAutoVisible). Exported rather than
 *  re-implemented so there is exactly one notify channel. */
export const subscribeThreads = subscribe;

export function getThreadsView(): ThreadsView {
  if (!cachedView) {
    cachedView = {
      threads,
      launched: new Set(launched),
      booting: new Set(booting),
      sessionStatuses,
      activeSessionId,
      menuSessions,
      unreadPosts,
    };
  }
  return cachedView;
}

/** React hook: the thread view, re-rendering on any store change. */
export function useThreadsView(): ThreadsView {
  return useSyncExternalStore(subscribe, getThreadsView);
}

export function getThreads(): Thread[] {
  return threads;
}

export function getThreadById(threadId: string): Thread | undefined {
  return threads.find((t) => t.id === threadId);
}

export function findThreadBySessionId(sessionId: string): Thread | undefined {
  return threads.find((t) => t.sessionId === sessionId);
}

export function isThreadLaunched(threadId: string): boolean {
  return launched.has(threadId);
}

/** Seed the store at boot with the merged (disk-wins) thread list. Transient
 *  liveness resets — nothing is launched yet. */
export function initThreadStore(initial: Thread[]): void {
  threads = sanitizeThreads(initial);
  launched.clear();
  booting.clear();
  bump();
}

/** Remap all thread→session bindings after workspace restore (pass an empty
 *  map on fresh starts to sever every binding). */
export function remapThreadSessionsInStore(idMap: Map<string, string>): void {
  threads = remapThreadSessions(threads, idMap);
  bump();
}

/** Create + insert a fresh thread record and return it. */
export function createThreadRecord(args: { title: string; workingDir: string }): Thread {
  const t = newThread(args);
  threads = [...threads, t];
  bump();
  return t;
}

/** Create + insert a PROMOTED thread: a claude conversation was discovered
 *  running in a plain tab (increment C), so the record adopts the uuid claude
 *  ALREADY chose instead of minting one.
 *
 *  Deliberately built on newThread() rather than forking it — same shape, same
 *  sanitize gate, same disk mirror. Only three fields differ from the explicit
 *  path, and they are exactly the three the discovery knows better than we do:
 *   · chatSessionId — claude's, not ours;
 *   · chatStarted   — from claude_session_exists (a discovered conversation
 *                     with a transcript on disk IS started; the caller passes
 *                     that ground truth in);
 *   · sessionId     — bound at birth, because the tab is right there.
 *  Revive needs no special-casing: it re-reads disk ground truth to choose
 *  --resume vs --session-id, and this uuid is in the same field either way.
 *
 *  `startedAt` (claude's own launch time) becomes createdAt when supplied: the
 *  conversation is as old as ITSELF, not as old as the poll that noticed it,
 *  and history sorts on these timestamps. lastActivityAt stays "now" — being
 *  seen alive IS activity. */
export function promoteThreadRecord(args: {
  title: string;
  workingDir: string;
  chatSessionId: string;
  chatStarted: boolean;
  sessionId: string;
  startedAt?: number;
}): Thread {
  const base = newThread({ title: args.title, workingDir: args.workingDir });
  const t: Thread = {
    ...base,
    chatSessionId: args.chatSessionId,
    chatStarted: args.chatStarted,
    sessionId: args.sessionId,
    createdAt:
      args.startedAt && args.startedAt > 0 && args.startedAt <= base.createdAt
        ? args.startedAt
        : base.createdAt,
  };
  threads = [...threads, t];
  bump();
  return t;
}

/** Sever a thread's tab binding BY THREAD ID, keeping the record whole.
 *
 *  This is Decision 1's half of "a plain `claude` in a bound tab starts a NEW
 *  thread" (increment E, reversing increment C's `adoptChatSession`). Adopting
 *  overwrote the record's chatSessionId with the restarted conversation's,
 *  which silently rebound the row to a fresh empty conversation and FORGOT the
 *  old uuid — the one thing that made the old conversation revivable. Now
 *  thread A simply lets the tab go (uuid intact, still in the history, still
 *  revivable) and the promotion pass creates thread B for that tab.
 *
 *  Same effect on the record as unbindThreadsForSession, keyed by thread
 *  rather than by session because the caller is holding a plan, not an event. */
export function unbindThread(threadId: string): void {
  const t = getThreadById(threadId);
  if (!t) return;
  threads = threads.map((x) => (x.id === threadId ? { ...x, sessionId: null } : x));
  launched.delete(threadId);
  booting.delete(threadId);
  bump();
}

/** Rename (increment E, Decision 4). LOCAL to Switchboard's record: claude's
 *  session is not touched, has no title of its own, and never learns about
 *  this. An empty/whitespace title falls back to the record's DERIVED default
 *  rather than persisting a blank row. Rides the existing persistence (the
 *  workspace blob + the disk mirror), so it survives a restart. */
export function renameThread(threadId: string, title: string): void {
  const t = getThreadById(threadId);
  if (!t) return;
  const next = title.trim() || derivedThreadTitle(t);
  if (next === t.title) return;
  threads = threads.map((x) => (x.id === threadId ? { ...x, title: next } : x));
  bump();
}

/** Archive / unarchive (increment E, Decision 5). Nothing but the flag moves:
 *  the record, its uuid and its tab binding are untouched, which is what makes
 *  archiving reversible and lossless — the exact opposite of delete. */
export function setThreadArchived(threadId: string, archived: boolean): void {
  const t = getThreadById(threadId);
  if (!t || isThreadArchived(t) === archived) return;
  threads = threads.map((x) => {
    if (x.id !== threadId) return x;
    if (!archived) {
      const { archivedAt: _dropped, ...rest } = x;
      return rest;
    }
    return { ...x, archivedAt: Date.now() };
  });
  bump();
}

/** Bind a live Switchboard session (tab) to the thread. */
export function bindThreadSession(threadId: string, sessionId: string): void {
  threads = threads.map((t) =>
    t.id === threadId ? { ...t, sessionId, lastActivityAt: Date.now() } : t
  );
  bump();
}

/** Mark the thread's claude process as launched in this app run.
 *
 *  ALSO UNARCHIVES (increment E): a conversation with a live claude process
 *  behind it is by definition not "not now". Every path that reaches here —
 *  an explicit revive from the Archived tab, the promotion pass binding a
 *  rediscovered conversation — is the user putting the thread back in use, and
 *  leaving it archived would hide a RUNNING conversation from the rail, which
 *  is the one thing selectMenuThreads exists to prevent. This is the single
 *  choke point for "claude is behind this row", so it is the only honest place
 *  to put the rule. (Archiving a live thread by hand still works: that is an
 *  explicit act, not a side effect.) */
export function markThreadLaunched(threadId: string): void {
  launched.add(threadId);
  setThreadArchived(threadId, false);
  bump();
}

/** Roll back a launched mark — the launch line write failed, so no claude
 *  process is behind the row after all (it must show revive again). */
export function clearThreadLaunched(threadId: string): void {
  if (!launched.delete(threadId)) return;
  bump();
}

// ── Revive re-entrancy gate ──────────────────────────────────────────────────
// handleReviveThread awaits session creation before it can bind/mark the
// thread, so a second click in that window would see sessionId=null and
// revive AGAIN — two shells resuming one conversation. This gate is
// SYNCHRONOUS: taken at revive entry before the first await, released on
// completion/failure.

const reviveInFlight = new Set<string>();

/** Take the revive gate for a thread. Returns false (bail) when a revive for
 *  it is already in flight. */
export function tryBeginRevive(threadId: string): boolean {
  if (reviveInFlight.has(threadId)) return false;
  reviveInFlight.add(threadId);
  return true;
}

export function endRevive(threadId: string): void {
  reviveInFlight.delete(threadId);
}

/** Flip chatStarted — the first real user turn happened; from now on revive
 *  uses `--resume`. Field-level update on the existing record (never a bulk
 *  record replace — see the Ky-bug note at the top). */
export function markChatStarted(threadId: string): void {
  threads = threads.map((t) =>
    t.id === threadId && !t.chatStarted
      ? { ...t, chatStarted: true, lastActivityAt: Date.now() }
      : t
  );
  bump();
}

export function setThreadBooting(threadId: string, on: boolean): void {
  const had = booting.has(threadId);
  if (on === had) return;
  if (on) booting.add(threadId);
  else booting.delete(threadId);
  bump();
}

/** The bound session's PTY exited: the thread stays, keeps its tab binding
 *  (the exit tail is still readable there), but is no longer live — the side
 *  menu shows the revive chip. */
export function markThreadSessionExited(sessionId: string): void {
  const t = findThreadBySessionId(sessionId);
  if (!t) return;
  launched.delete(t.id);
  booting.delete(t.id);
  bump();
}

/** The session was destroyed (tab closed): kill the binding but NOT the
 *  thread — it becomes dead/revivable. */
export function unbindThreadsForSession(sessionId: string): void {
  const t = findThreadBySessionId(sessionId);
  if (!t) return;
  threads = threads.map((x) =>
    x.sessionId === sessionId ? { ...x, sessionId: null } : x
  );
  launched.delete(t.id);
  booting.delete(t.id);
  bump();
}

/** Explicit thread delete (the row menu's Delete, behind its dialog): removes
 *  the RECORD. The bound session, if any, lives on as a plain tab — a record
 *  and a shell are different things. claude's transcript on disk is untouched
 *  too; what is lost is Switchboard's knowledge of its uuid. */
export function deleteThread(threadId: string): void {
  threads = threads.filter((t) => t.id !== threadId);
  launched.delete(threadId);
  booting.delete(threadId);
  bump();
}

/** App publishes session statuses + the active session so thread rows can
 *  show live status dots (statusConfig colors — the only color allowed in the
 *  side menu) and the active-row highlight. Shallow-compared to avoid
 *  notify loops on unrelated renders. */
export function publishSessionStatuses(
  statuses: Record<string, AgentStatus>,
  activeId: string | null
): void {
  const prev = sessionStatuses;
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(statuses);
  const same =
    activeId === activeSessionId &&
    prevKeys.length === nextKeys.length &&
    nextKeys.every((k) => prev[k] === statuses[k]);
  if (same) return;
  sessionStatuses = statuses;
  activeSessionId = activeId;
  bump();
}

/** App publishes its TAB sessions (panel-owned already filtered) so the menu
 *  can derive the `shells` group (SWIT-46). Same skip-if-unchanged shape as
 *  publishSessionStatuses — the effect fires on every session render tick. */
export function publishMenuSessions(sessions: readonly MenuSession[]): void {
  const prev = menuSessions;
  const same =
    prev.length === sessions.length &&
    sessions.every((s, i) => {
      const p = prev[i];
      return (
        p.id === s.id && p.name === s.name && p.workingDir === s.workingDir && p.status === s.status
      );
    });
  if (same) return;
  menuSessions = sessions;
  bump();
}

/** Unread cross-thread posts per thread (`↓ N` chip). Nothing calls this
 *  until SWIT-52 delivers posts; until then the record stays empty and no
 *  chip renders. */
export function publishThreadUnread(counts: Record<string, number>): void {
  unreadPosts = counts;
  bump();
}

// ── Actions bridge ───────────────────────────────────────────────────────────
// App owns session creation/revival; ThreadsSection renders deep inside
// SideMenu. Rather than threading callbacks through SideMenu's props, App
// registers its handlers here (same module-singleton pattern as
// TerminalPane's sessionCallbacks map).

export type ThreadActions = {
  /** Row click on a live thread: show its session tab. */
  openThread: (threadId: string) => void;
  /** Revive chip / dead-row click: spawn + type the launch line. */
  reviveThread: (threadId: string) => void;
  /** "+ new thread" affordance: open the create dialog. */
  newThread: () => void;
  /** Row menu → Delete, behind the ConfirmDialog. There is no unconfirmed
   *  delete action any more (increment E, Decision 3): the record is the only
   *  route back to a conversation, on BOTH surfaces, so the bare `×` that used
   *  to delete a side-menu row on one click is gone with it. */
  confirmDeleteThread: (threadId: string) => void;
  /** Row menu → Rename, or a double-click on the row. Persists. */
  renameThread: (threadId: string, title: string) => void;
  /** Row menu → Archive / Unarchive. Reversible and lossless; never presented
   *  as deleting. */
  setThreadArchived: (threadId: string, archived: boolean) => void;
  /** The composer's `@thread …` form (SWIT-52): resolve + deliver a post from
   *  the given SESSION's thread (null = no source thread; still allowed —
   *  Eric posting from a plain shell). Resolves to a confirmation sentence;
   *  rejects with a human-readable reason the composer prints as-is. */
  postToThread: (fromSessionId: string | null, targetQuery: string, body: string) => Promise<string>;
};

let threadActions: ThreadActions | null = null;

export function registerThreadActions(actions: ThreadActions | null): void {
  threadActions = actions;
}

export function getThreadActions(): ThreadActions | null {
  return threadActions;
}

/** Test-only: reset the store to a blank state. */
export function __resetThreadStoreForTests(): void {
  threads = [];
  launched.clear();
  booting.clear();
  reviveInFlight.clear();
  sessionStatuses = {};
  activeSessionId = null;
  menuSessions = [];
  unreadPosts = {};
  cachedView = null;
  threadActions = null;
  listeners.clear();
}
