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
import { parsePanels, parsePanelWidth } from "./panelStore";

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
 *  relaunches fresh under the SAME pinned uuid. */
export function launchCommand(args: { chatSessionId: string; resume: boolean }): string {
  return args.resume
    ? `claude --resume ${args.chatSessionId}`
    : `claude --session-id ${args.chatSessionId}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Default thread title: repo name + date ("lodestar · Jul 31"). */
export function defaultThreadTitle(repoName: string, now: Date = new Date()): string {
  return `${repoName} · ${MONTHS[now.getMonth()]} ${now.getDate()}`;
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
  return {
    id: t.id,
    title: t.title,
    workingDir: t.workingDir,
    chatSessionId: t.chatSessionId,
    chatStarted: t.chatStarted === true,
    sessionId: typeof t.sessionId === "string" ? t.sessionId : null,
    createdAt: typeof t.createdAt === "number" ? t.createdAt : 0,
    lastActivityAt: typeof t.lastActivityAt === "number" ? t.lastActivityAt : 0,
  };
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

// ── SavedWorkspace v1/v2 → v3 migration + staleness ──────────────────────────

/** Migrate a raw parsed workspace blob to v3. Additive per version:
 *  v1 payloads keep all their sessions/layout and gain `threads: []`;
 *  v2 payloads pass through with their threads sanitized; both gain
 *  `panels: {}` + the default width. v3 payloads pass through with panels
 *  tolerant-parsed and the width clamped. Anything else is rejected. */
export function migrateSavedWorkspace(raw: unknown): SavedWorkspace | null {
  if (!raw || typeof raw !== "object") return null;
  const ws = raw as Record<string, unknown>;
  if (ws.version !== 1 && ws.version !== 2 && ws.version !== 3) return null;
  if (!Array.isArray(ws.sessions)) return null;
  return {
    version: 3,
    sessions: ws.sessions as SavedSession[],
    activeSessionId: typeof ws.activeSessionId === "string" ? ws.activeSessionId : null,
    paneLayout: ws.paneLayout ?? null,
    focusedPaneId: typeof ws.focusedPaneId === "string" ? ws.focusedPaneId : null,
    sessionCounter: typeof ws.sessionCounter === "number" ? ws.sessionCounter : 0,
    savedAt: typeof ws.savedAt === "number" ? ws.savedAt : 0,
    threads: ws.version === 1 ? [] : sanitizeThreads(ws.threads),
    panels: ws.version === 3 ? parsePanels(ws.panels) : {},
    panelWidth: parsePanelWidth(ws.panelWidth),
  };
}

/** 7-day staleness applies to SESSIONS only: a stale workspace loses its
 *  sessions/layout, but threads are durable by definition and survive.
 *  Panels expire WITH their sessions (a panel binding to an expired session
 *  is meaningless — unlike a thread, there is nothing left to revive); the
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
    panels: {},
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
};

let threads: Thread[] = [];
const launched = new Set<string>();
const booting = new Set<string>();
let sessionStatuses: Record<string, AgentStatus> = {};
let activeSessionId: string | null = null;

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

export function getThreadsView(): ThreadsView {
  if (!cachedView) {
    cachedView = {
      threads,
      launched: new Set(launched),
      booting: new Set(booting),
      sessionStatuses,
      activeSessionId,
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

/** Bind a live Switchboard session (tab) to the thread. */
export function bindThreadSession(threadId: string, sessionId: string): void {
  threads = threads.map((t) =>
    t.id === threadId ? { ...t, sessionId, lastActivityAt: Date.now() } : t
  );
  bump();
}

/** Mark the thread's claude process as launched in this app run. */
export function markThreadLaunched(threadId: string): void {
  launched.add(threadId);
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

/** Explicit thread delete (the row's × affordance): removes the RECORD. The
 *  bound session, if any, lives on as a plain tab. */
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
  /** × affordance: delete the record (session tab survives). */
  deleteThread: (threadId: string) => void;
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
  cachedView = null;
  threadActions = null;
  listeners.clear();
}
