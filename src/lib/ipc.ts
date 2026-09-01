import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { SessionInfo, Config } from "../types";
import { log } from "./logger";

export async function createSession(
  name: string,
  repo: string,
  working_dir: string,
  cols?: number,
  rows?: number
): Promise<SessionInfo> {
  log.debug(`IPC createSession name=${name} repo=${repo} working_dir=${working_dir}`);
  return invoke("create_session", { name, repo, workingDir: working_dir, cols, rows });
}

export async function restartSession(
  sessionId: string,
  name: string,
  repo: string,
  working_dir: string,
  cols: number | undefined,
  rows: number | undefined,
  // Client-generated spawn generation for this restart. The caller MUST have
  // bumped the registry's expectation to this value BEFORE invoking (see
  // bumpSessionGeneration) — that ordering is what makes the old reader
  // thread's dying events droppable and the new spawn's first output safe.
  gen: number
): Promise<SessionInfo> {
  log.debug(`IPC restartSession id=${sessionId} name=${name} cols=${cols} rows=${rows} gen=${gen}`);
  return invoke("restart_session", { sessionId, name, repo, workingDir: working_dir, cols, rows, gen });
}

export async function closeSession(sessionId: string): Promise<void> {
  log.debug(`IPC closeSession id=${sessionId}`);
  return invoke("close_session", { sessionId });
}

export async function writeToSession(
  sessionId: string,
  data: string
): Promise<void> {
  log.debug(`IPC writeToSession id=${sessionId}`);
  return invoke("write_to_session", { sessionId, data });
}

export async function resizeSession(
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> {
  // This is the single path that SIGWINCHes the shell. Logged so a recurrence
  // of the text-render corruption can be traced to the resize(s) that caused it.
  log.debug(`IPC resizeSession id=${sessionId} cols=${cols} rows=${rows}`);
  return invoke("resize_session", { sessionId, cols, rows });
}

export async function renameSession(
  sessionId: string,
  newName: string
): Promise<void> {
  return invoke("rename_session", { sessionId, newName });
}

export async function listSessions(): Promise<SessionInfo[]> {
  return invoke("list_sessions");
}

export async function getConfig(): Promise<Config> {
  return invoke("get_config");
}

export async function getHomeDir(): Promise<string> {
  return invoke("get_home_dir");
}

/** Absolute path of the scrollback mirror directory — the one thing that turns
 *  a live panel terminal into something an agent can be pointed at. */
export async function scrollbackRoot(): Promise<string> {
  return invoke("scrollback_root");
}

/** Absolute path of the per-thread data root (SWIT-48) — what lets a thread's
 *  ✦ page be NAMED to an agent as a file it can Read. */
export async function threadsRoot(): Promise<string> {
  return invoke("threads_root");
}

/** Read one of a thread's page files (page.json / answers.json / inbox.json).
 *  A missing file resolves to "" — "no page yet" is the ordinary state. */
export async function readThreadFile(threadId: string, name: string): Promise<string> {
  return invoke("read_thread_file", { threadId, name });
}

/** A thread's view ids, newest-first (SWIT-50). Missing dir = []. */
export async function listThreadViews(threadId: string): Promise<string[]> {
  return invoke("list_thread_views", { threadId });
}

/** One view's SPEC json ("" when missing — the cannot-render card's case). */
export async function readThreadView(threadId: string, viewId: string): Promise<string> {
  return invoke("read_thread_view", { threadId, viewId });
}

/** A view's DATA file — path relative to the thread's working dir, resolved
 *  and containment-checked server-side (the thread id is the root's key;
 *  no path root ever crosses this seam). Size-capped in Rust. */
export async function readViewData(threadId: string, relPath: string): Promise<string> {
  return invoke("read_view_data", { threadId, relPath });
}

/** Deliver a cross-thread post into a TARGET thread's inbox (SWIT-52) — the
 *  app-side writer behind the composer's `@thread …` form. Same record shape
 *  the MCP server's `post` tool appends. */
export async function writeThreadPost(
  targetThreadId: string,
  fromTitle: string,
  fromId: string,
  kind: "update" | "request",
  text: string
): Promise<void> {
  return invoke("write_thread_post", { targetThreadId, fromTitle, fromId, kind, text });
}

/** Kept views (SWIT-52): every `.view.json` under `_scratch/`, rel paths,
 *  newest first — the scratchpad's one window (the KB tree hides `_` roots). */
export async function listScratchViews(): Promise<string[]> {
  return invoke("list_scratch_views");
}

/** Record Eric's answer to a page question (SWIT-51). The APP is
 *  answers.json's sole writer; the write is atomic server-side. Durability
 *  first: callers write THIS before typing anything into a terminal. */
export async function writeThreadAnswer(
  threadId: string,
  questionId: string,
  text: string
): Promise<void> {
  return invoke("write_thread_answer", { threadId, questionId, text });
}

/** Append ONE dated line to the design conventions file (SWIT-58) — the
 *  app's record of a `convention` answer. The target is FIXED in Rust (the
 *  switchboard repo's `design/wireframe-kit/conventions.md`, by registry
 *  key); nothing here names a path. Rejects when the file is missing. */
export async function appendConvention(line: string): Promise<void> {
  return invoke("append_convention", { line });
}

/** Prepare a thread's launch (SWIT-49): create its data dir + write the
 *  per-spawn mcp-config pointing claude at Switchboard's page-tool server.
 *  Resolves to the config file's absolute path; a rejection means the caller
 *  omits `--mcp-config` and the thread runs without page tools. */
export async function prepareThreadLaunch(threadId: string): Promise<string> {
  return invoke("prepare_thread_launch", { threadId });
}

/** Write the AGENT-FACING plain-text transcript for a session (see
 *  lib.rs's TRANSCRIPT_SUFFIX for why it is a second file). */
export async function saveTranscript(sessionId: string, data: string): Promise<void> {
  return invoke("save_transcript", { sessionId, data });
}

export async function saveScrollback(sessionId: string, data: string): Promise<void> {
  return invoke("save_scrollback", { sessionId, data });
}

export async function loadScrollback(sessionId: string): Promise<string> {
  return invoke("load_scrollback", { sessionId });
}

export async function clearScrollback(): Promise<void> {
  return invoke("clear_scrollback");
}

export async function clearSessionScrollback(sessionId: string): Promise<void> {
  return invoke("clear_session_scrollback", { sessionId });
}

// Thread records disk mirror (T5): localStorage is one shared key and webview
// storage can be cleared wholesale — the JSON blob written here survives both
// and WINS over the localStorage copy on boot (threadStore.mergeThreads).
export async function saveThreads(data: string): Promise<void> {
  return invoke("save_threads", { data });
}

export async function loadThreads(): Promise<string> {
  return invoke("load_threads");
}

/** Ground truth for revive: does claude's transcript for this conversation
 *  exist on disk (~/.claude/projects/<munged-cwd>/<sessionId>.jsonl)? Decides
 *  --resume vs --session-id; the chatStarted flag is a UI hint only. */
export async function claudeSessionExists(
  workingDir: string,
  sessionId: string
): Promise<boolean> {
  return invoke("claude_session_exists", { workingDir, sessionId });
}

/** Claude discovery (increment C): which of these tabs currently has a claude
 *  conversation running inside it, and which conversation?
 *
 *  Resolved in Rust by walking each tab's PTY process tree down to a process
 *  that owns a `~/.claude/sessions/<pid>.json` — see src-tauri/src/discovery.rs
 *  for the mechanism and the two guards. AMBIGUOUS tabs (two claude
 *  descendants) and ambiguous conversations (one claude under two tabs) are
 *  omitted and logged server-side, never guessed at.
 *
 *  OBSERVE-ONLY. This whole path reads a process snapshot and some JSON; it
 *  cannot type into a shell. */
export interface ClaudeDiscovery {
  /** Switchboard session (tab) id. */
  sessionId: string;
  /** The claude conversation uuid — DISCOVERED, not minted by us. */
  chatSessionId: string;
  /** CLAUDE's cwd (the user may have `cd`'d first), which is what the
   *  transcript path is munged from — so it is what a promoted thread stores
   *  as its workingDir. */
  cwd: string;
  startedAt: number;
}

export async function discoverClaudeSessions(
  sessionIds: string[]
): Promise<ClaudeDiscovery[]> {
  return invoke("discover_claude_sessions", { sessionIds });
}

// ── Knowledge Base (T6) ──────────────────────────────────────────────────────
// All KB commands are rooted at the personal-kb checkout (env
// SWITCHBOARD_KB_PATH → config kb_path → built-in default) and traversal-
// guarded in Rust: relative paths only, `..`/absolute/drive/verbatim forms
// rejected, canonical containment enforced. See src-tauri/src/kb.rs.

/** The resolved ABSOLUTE path of the KB checkout (already stripped of Windows
 *  verbatim prefixes). Used by T8's spawn context: a thread's cwd is a REPO,
 *  so a KB-relative doc path is not resolvable from inside the conversation. */
export async function kbRoot(): Promise<string> {
  return invoke("kb_root");
}

/** Flat recursive doc listing — relative paths, forward-slash normalized,
 *  sorted. `.`/`_`-prefixed dirs and node_modules are skipped server-side. */
export async function kbListDocs(): Promise<string[]> {
  return invoke("kb_list_docs");
}

export async function kbReadDoc(relPath: string): Promise<string> {
  return invoke("kb_read_doc", { relPath });
}

/** Write a doc (parent dirs created). Exists now for the T7 pins sidecars —
 *  guarded now so it never ships unguarded. */
export async function kbWriteDoc(relPath: string, content: string): Promise<void> {
  return invoke("kb_write_doc", { relPath, content });
}

// ── Explorer (T9) ────────────────────────────────────────────────────────────
// Registry-driven repo browsing. The browsable roots come from
// <kb_root>/registry.json server-side; every call addresses a repo by PROJECT
// KEY + relative path and is traversal-guarded in Rust (component validation
// + canonical containment inside that project's repo root — explorer.rs).

export interface ExplorerProject {
  key: string;
  /** Registry status ("active"/"paused"/…); archived entries come back with
   *  status "archived". Missing statuses default to "active" server-side. */
  status: string;
  /** Absolute repo paths (forward slashes) — matched against live thread
   *  workingDirs by explorer.annotateProjects. */
  repos: string[];
  /** Registry `notes` free text, when present. */
  note: string | null;
}

export interface ExplorerEntry {
  name: string;
  is_dir: boolean;
}

export async function explorerProjects(): Promise<ExplorerProject[]> {
  return invoke("explorer_projects");
}

/** Entries of a directory inside a project's repo(s) — dirs first, sorted.
 *  Multi-repo projects list their repo names at relDir "". */
export async function explorerList(
  projectKey: string,
  relDir: string
): Promise<ExplorerEntry[]> {
  return invoke("explorer_list", { projectKey, relDir });
}

/** Read a repo file (UTF-8, capped at 512KB server-side — larger files
 *  reject with a readable error string). */
export async function explorerRead(
  projectKey: string,
  relPath: string
): Promise<string> {
  return invoke("explorer_read", { projectKey, relPath });
}

/** Write a repo file (increment G — repo markdown is editable too). Guarded in
 *  Rust by the SAME two layers `explorer_read` goes through, plus two rules of
 *  its own: the file must ALREADY EXIST (this is an editor's save, not a way to
 *  drop new files into a source tree) and a symlink at the target is refused. */
export async function explorerWrite(
  projectKey: string,
  relPath: string,
  content: string
): Promise<void> {
  return invoke("explorer_write", { projectKey, relPath, content });
}

export async function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

export async function confirmAppClose(): Promise<void> {
  return invoke("confirm_app_close");
}

/** Open the floating window. With `artifactJson` it boots hosting an ARTIFACT
 *  (increment F, Decision 2); without, it mirrors `sessionId`'s terminal as it
 *  always has. The JSON is URL-encoded here rather than in Rust so exactly one
 *  side owns the encoding. */
export async function openPipWindow(sessionId: string, artifactJson?: string): Promise<void> {
  return invoke("open_pip_window", {
    sessionId,
    artifact: artifactJson ? encodeURIComponent(artifactJson) : null,
  });
}

/** A SURFACE WINDOW (Inc 5d): one project page in its own always-on-top
 *  window. `artifactJson` is the artifact record; encoded here, decoded by
 *  the window's URLSearchParams — one side owns each direction, like the
 *  PiP. Re-opening focuses the existing window. */
export async function openSurfaceWindow(
  label: string,
  artifactJson: string,
  opts: { title: string; width: number; height: number }
): Promise<void> {
  return invoke("open_surface_window", {
    label,
    artifact: encodeURIComponent(artifactJson),
    title: opts.title,
    width: opts.width,
    height: opts.height,
  });
}

export async function closeSurfaceWindow(label: string): Promise<void> {
  return invoke("close_surface_window", { label });
}

export async function closePipWindow(): Promise<void> {
  return invoke("close_pip_window");
}

export async function isPipWindowOpen(): Promise<boolean> {
  return invoke("is_pip_window_open");
}

// PTY event payloads are structured: every event carries the spawn generation
// stamped by the Rust reader thread that emitted it. Event names are keyed
// only by session id, and a restart REUSES the id — the generation is how the
// terminal registry tells the restarted PTY's stream apart from the old
// (unjoined) reader thread's dying output/exited events and drops the latter.

export interface SessionOutputPayload {
  gen: number;
  /** Base64-encoded raw PTY bytes. */
  data: string;
}

export interface SessionExitedPayload {
  gen: number;
}

export function onSessionOutput(
  sessionId: string,
  callback: (data: string, gen: number) => void
): Promise<UnlistenFn> {
  return listen<SessionOutputPayload>(`session:output:${sessionId}`, (event) => {
    callback(event.payload.data, event.payload.gen);
  });
}

export function onSessionExited(
  sessionId: string,
  callback: (gen: number) => void
): Promise<UnlistenFn> {
  return listen<SessionExitedPayload>(`session:exited:${sessionId}`, (event) => {
    callback(event.payload.gen);
  });
}

export function flashTaskbar() {
  getCurrentWindow()
    .requestUserAttention(UserAttentionType.Informational)
    .catch(() => {});
}

export async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    // Notification API unavailable — silently ignore
  }
}
