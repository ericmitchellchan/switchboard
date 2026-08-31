// Agent context injection (T8, merged into the artifact panel as A4).
//
// THE HONESTY CONSTRAINT — read before changing anything here. The claude TUI
// owns the terminal input. There is NO hidden per-message channel into a
// running conversation and we do not fake one. Exactly TWO seams exist, and
// both are mechanically visible to the user:
//
//   1. SPAWN-TIME — when a thread's claude process is launched (create OR
//      revive), the launch line carries `--append-system-prompt "<one-liner>"`
//      describing what the tab's panel shows. Re-derived at EVERY spawn, so
//      stale context dies with the session rather than accumulating.
//   2. SEND-TO-THREAD — an explicit `→ thread` click TYPES a reference into
//      the terminal and stops. No trailing \r: the Enter that sends it is the
//      user's own keystroke, after he has read (and possibly edited) the line.
//
// Anything that silently injects text mid-conversation, or presses Enter for
// the user, is out of scope and wrong.
//
// Everything in this module is PURE (types + pins helpers only) so the exact
// bytes that reach a shell are unit-testable under Node. The effectful ends —
// reading the pin sidecar, appending the flag to the launch line, the IPC
// write — live in App.tsx / threadStore.ts / panelStore.ts respectively.
//
// SANITIZATION IS LOAD-BEARING, not decorative. Both strings are typed into a
// SHELL line (the launch line literally, the reference potentially — a tab
// whose claude has exited is a bare prompt), and one of them embeds
// USER-AUTHORED pin notes. The rules below are the intersection of what cmd,
// PowerShell and POSIX shells would otherwise interpret inside a
// double-quoted argument:
//
//   - control characters (incl. \r \n \t and ESC) → a single space. A newline
//     in a typed line IS an Enter — this rule is the one that matters most.
//   - INVISIBLE formatting characters dropped: bidi overrides/embeddings/
//     isolates (U+202A-202E, U+2066-206F), zero-width space/joiners and the
//     LRM/RLM marks (U+200B-200F), word joiner + invisible operators
//     (U+2060-2065), BOM (U+FEFF), and LONE surrogates. These cannot break
//     quoting — the metacharacters are already gone — but the send-to-thread
//     seam's entire safety argument is "he READS the line before pressing
//     Enter", and an RLO makes the rendered line differ from the bytes. A
//     lone surrogate is worse than invisible: it is malformed UTF-16 that
//     writeToSession's invoke rejects outright. (Dropping U+200D also splits
//     ZWJ emoji sequences into their parts — an acceptable cost on a shell
//     line, where legibility beats glyph fidelity.)
//   - `"` dropped: it would close the quoted argument.
//   - `\` dropped: escape/line-continuation in POSIX shells (path separators
//     are normalized to `/` BEFORE this runs — see normalizePath).
//   - `$` dropped: POSIX + PowerShell variable/command expansion `$(...)`.
//   - `` ` `` dropped: POSIX command substitution + PowerShell escape.
//   - `%` dropped: cmd.exe variable expansion `%VAR%`.
//   - whitespace runs collapsed, ends trimmed, length capped.
//
// The framing quotes around a pin note — and, in the send-to-thread seam,
// around the artifact ref itself — are OURS and are added AFTER the string has
// been stripped of every `"`, so neither can break out of them. That framing
// is what makes the drop list sufficient: the list is calibrated for text
// sitting INSIDE a double-quoted argument, and every interpolation this module
// emits is placed inside one (see buildSendReference for why the ref needs its
// own pair even though the spawn one-liner does not).

import type { Artifact } from "../types";
import { SIDECAR_NAME, SURFACE_PINS_NAME } from "./pins";

/** Cap for the spawn one-liner. Generous — it rides in a system prompt — but
 *  finite: a runaway path must not produce an unbounded typed line. */
export const SPAWN_CONTEXT_MAX = 2000;

/** Cap for an artifact reference (`kb <root>/<path>`, `repo <proj>/<path>`). */
export const REF_MAX = 300;

/** Cap for the user-authored note quoted inside a send-to-thread reference. */
export const PIN_NOTE_MAX = 240;

/** Upper bound on ANY string buildSendReference can return — derived from the
 *  component caps above plus the two framing quote pairs (asserted in the
 *  tests, not enforced by a final truncation: truncating the assembled line
 *  could strip a closing quote). */
export const SEND_REFERENCE_MAX = 800; // + PIN_ANCHOR_MAX and its parentheses (Inc 3d)

/** Highest pin number a reference will print (keeps the bound above real). */
const MAX_PIN_NUMBER = 9999;

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const SHELL_METACHARS = /["\\$%`]/g;
/** Invisible/direction-altering formatting characters (see the module header).
 *  The `u` flag is load-bearing: in Unicode mode the string is matched as CODE
 *  POINTS, so `\uD800-\uDFFF` hits only UNPAIRED surrogates — a well-formed
 *  pair is one code point above the range and emoji survive untouched. */
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uD800-\uDFFF]/gu;

/** The single sanitizer both seams use (see the module header for the rule
 *  list and why each character is on it). Idempotent: sanitizing an already
 *  sanitized string is a no-op, which is what makes defense-in-depth
 *  re-sanitization at the launch-line seam free. */
export function sanitizeForTypedLine(text: string, maxLength: number): string {
  if (typeof text !== "string") return "";
  const flattened = text
    .replace(CONTROL_CHARS, " ")
    .replace(INVISIBLE_CHARS, "")
    .replace(SHELL_METACHARS, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateCodePoints(flattened, maxLength);
}

/** Truncate by CODE POINT, never mid-surrogate — a half emoji is a mojibake
 *  byte in the shell. A truncated string ends in `…` so the reader (human or
 *  agent) can tell something was cut. */
function truncateCodePoints(text: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const points = Array.from(text);
  if (points.length <= maxLength) return text;
  return `${points.slice(0, maxLength - 1).join("").trimEnd()}…`;
}

/** Windows paths arrive with backslashes (kb_root's display_path, explorer
 *  paths); `\` is on the drop list, so separators are normalized to `/` FIRST
 *  or `C:\kb\docs` would sanitize to `C:kbdocs`. Forward slashes work
 *  everywhere the agent will use the path. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function joinPath(root: string, path: string): string {
  const left = root.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "");
  if (!left) return right;
  if (!right) return left;
  return `${left}/${right}`;
}

/** Options shared by both builders. `kbRoot` is the ABSOLUTE path of the
 *  personal-kb checkout (ipc.kbRoot): a thread's cwd is a REPO, so a
 *  KB-relative path alone is not resolvable from inside the conversation.
 *  Omitted/empty → the KB-relative form, which is still honest, just weaker. */
export type RefOptions = {
  kbRoot?: string | null;
  /** ABSOLUTE path of the scrollback mirror directory (ipc.scrollbackRoot).
   *  Without it a `session` artifact has no ref at all — see artifactRef. */
  scrollbackRoot?: string | null;
  /** Display name of a `session` artifact's shell (the tab name Eric gave it).
   *  Passed in rather than looked up so this module stays pure: the names live
   *  in App's session list, published through panelStore.sessionLabelFor. */
  sessionName?: string | null;
  /** A surface page's anchor vocabulary (registry `pinHint`), for the spawn
   *  context's pin advice. Passed in so this module stays project-agnostic. */
  anchorHint?: string | null;
  /** ABSOLUTE path of the per-thread data root (ipc.threadsRoot, SWIT-48).
   *  Without it a `page` artifact has no ref — same degrade rule as the
   *  scrollback root. */
  threadsRoot?: string | null;
};

/** Where a session's transcript is mirrored, or `""` when the root is unknown.
 *  The file is written by workspace.saveAllScrollbacks (periodically, and
 *  FORCED immediately before either seam emits a reference to it). */
/** File suffix of the agent-facing plain-text transcript. PAIRED WITH
 *  `src-tauri/src/lib.rs`'s `TRANSCRIPT_SUFFIX`, which does the writing —
 *  change one and change the other. It is deliberately NOT the `<id>.txt`
 *  restore mirror: that one is an xterm serialize, full of escape sequences. */
export const TRANSCRIPT_SUFFIX = ".transcript.txt";

export function sessionTranscriptPath(sessionId: string, opts: RefOptions = {}): string {
  const root = normalizePath(opts.scrollbackRoot ?? "");
  if (root.length === 0 || sessionId.length === 0) return "";
  // Sanitized HERE, so the callers below can wrap it in their own quotes
  // without a second pass stripping those quotes back off — the same order
  // artifactRef/buildSendReference already use for every other kind.
  return sanitizeForTypedLine(joinPath(root, `${sessionId}${TRANSCRIPT_SUFFIX}`), REF_MAX);
}

/** Cap on the shell's display name inside a reference. Deliberately tighter
 *  than REF_MAX so that path + name + the literal wording stays inside
 *  SEND_REFERENCE_MAX without a final truncation (which could cut a quote). */
const SESSION_NAME_MAX = 80;

/** A panel terminal's name as it should READ in a sentence to an agent. */
function sessionDisplayName(opts: RefOptions): string {
  return sanitizeForTypedLine(opts.sessionName ?? "", SESSION_NAME_MAX) || "terminal";
}

/** How an artifact is NAMED to the agent: `<kind> <path>`.
 *
 *    kb-doc     → `kb C:/Users/eric/projects/personal-kb/switchboard/…/requirements.md`
 *                 (or `kb switchboard/…/requirements.md` with no known root)
 *    repo-file  → `repo switchboard/src/App.tsx`
 *    localhost  → `localhost switchboard http://localhost:5173` (phase B)
 *    session    → `terminal C:/…/switchboard/scrollback/<id>.txt`
 *
 *  THE SESSION CASE, and why it changed (2026-08-02, Eric, driving the app).
 *  It used to return `""`: a live shell is not a document, so both seams said
 *  nothing about it. That was true about the SHELL and wrong about the point of
 *  the panel — Eric put a `pnpm dev` in the panel beside a claude thread,
 *  asked the thread to look at it, and it could not. "That's the whole point:
 *  seeing the same surface."
 *
 *  What we can honestly offer is not the process but its TRANSCRIPT: the app
 *  already mirrors every session's scrollback to
 *  `%LOCALAPPDATA%/switchboard/scrollback/<id>.txt`, which is an ordinary file
 *  an agent can Read. So a session's ref NAMES THAT FILE. Two consequences we
 *  state rather than paper over:
 *   · it is a SNAPSHOT, not a tail — both seams FORCE a flush immediately
 *     before emitting the ref (App / ArtifactPanel), and the wording tells the
 *     agent to re-read it for anything later; and
 *   · with no known scrollback root there is still no ref, so the empty-string
 *     contract below is unchanged for that case — the flag is omitted and
 *     `→ thread` types nothing rather than naming a path that does not exist. */
export function artifactRef(artifact: Artifact, opts: RefOptions = {}): string {
  switch (artifact.kind) {
    case "kb-doc": {
      const root = normalizePath(opts.kbRoot ?? "");
      return sanitizeForTypedLine(`kb ${joinPath(root, normalizePath(artifact.path))}`, REF_MAX);
    }
    case "repo-file":
      return sanitizeForTypedLine(
        `repo ${joinPath(normalizePath(artifact.project), normalizePath(artifact.path))}`,
        REF_MAX
      );
    case "localhost":
      return sanitizeForTypedLine(`localhost ${artifact.project} ${artifact.url}`, REF_MAX);
    case "surface":
      // A live page has no file to Read (yet — Inc 3 gives it pins and screen
      // context). Naming it by project/page is still worth typing: the agent
      // knows WHICH surface Eric is looking at, and the project's own MCP
      // tools are how it reads the same data.
      return sanitizeForTypedLine(`surface ${artifact.project}/${artifact.page}`, REF_MAX);
    case "session": {
      const path = sessionTranscriptPath(artifact.sessionId, opts);
      if (path.length === 0) return "";
      return sanitizeForTypedLine(`terminal ${path}`, REF_MAX);
    }
    case "page": {
      // The ✦ page IS a file (SWIT-48): the agent can Read its own page —
      // the same honesty rule as the transcript. No known root → no ref,
      // never a path that does not exist.
      const root = normalizePath(opts.threadsRoot ?? "");
      if (root.length === 0) return "";
      return sanitizeForTypedLine(
        `page ${joinPath(root, `${artifact.threadId}/page.json`)}`,
        REF_MAX
      );
    }
    case "view": {
      // A view's SPEC is a file too (SWIT-50): reading it tells the agent
      // what is rendered and where the data came from.
      const root = normalizePath(opts.threadsRoot ?? "");
      if (root.length === 0) return "";
      return sanitizeForTypedLine(
        `view ${joinPath(root, `${artifact.threadId}/views/${artifact.viewId}.json`)}`,
        REF_MAX
      );
    }
  }
}

/** SEAM 1 — the `--append-system-prompt` one-liner for a spawn.
 *
 *  Returns null when the tab has no panel artifact: the caller must then omit
 *  the flag ENTIRELY rather than pass an empty one (an empty system prompt
 *  append is noise, and an empty quoted arg is a shell wart).
 *
 *  Example (3 pins, KB root known):
 *    Workstation context: panel shows kb C:/Users/eric/projects/personal-kb/
 *    switchboard/features/artifact-panel/requirements.md (3 pins in
 *    .pins.json alongside).
 *
 *  The pin clause is what makes the transferred acceptance criterion work:
 *  it tells the agent both THAT annotations exist and WHERE to read them,
 *  without the user naming the doc. */
export function buildSpawnContext(
  artifact: Artifact | null,
  pinCount: number,
  opts: RefOptions = {}
): string | null {
  if (!artifact) return null;
  const ref = artifactRef(artifact, opts);
  if (ref.length === 0) return null;
  // A LIVE TERMINAL gets its own sentence. "panel shows terminal <path>" would
  // read as a file the panel is displaying, when the truth is a running shell
  // whose output happens to be readable at that path — and the difference is
  // the whole reason the agent should re-read it rather than assume it is
  // final. Pins never apply (a shell has no sidecar), so the clause is skipped.
  if (artifact.kind === "session") {
    const path = sessionTranscriptPath(artifact.sessionId, opts);
    return sanitizeForTypedLine(
      `Workstation context: a live terminal named ${sessionDisplayName(opts)} is running beside ` +
        `this conversation in the panel; its output is mirrored to ${path} — read that file for ` +
        `what it has printed so far, and re-read it for anything since.`,
      SPAWN_CONTEXT_MAX
    );
  }
  const pins = Number.isFinite(pinCount) ? Math.max(0, Math.trunc(pinCount)) : 0;
  // A SURFACE (Inc 3d — SWIT-38) names its pins file by path — it is not
  // "alongside" anything — and says how the agent may add one: the file is
  // plain JSON the app re-reads while the surface is open, so a pin the agent
  // appends shows up in the rail marked "from thread". `origin` is what marks
  // it; `anchor` is the page's own key (the same keys the rail sends back in
  // a pin reference), so the agent pins the THING, never a coordinate.
  if (artifact.kind === "surface") {
    const root = normalizePath(opts.kbRoot ?? "");
    const file = joinPath(root, `${normalizePath(artifact.project)}/${SURFACE_PINS_NAME}`);
    const count = pins > 0 ? `${pins} pin${pins === 1 ? "" : "s"} in ${file}` : `pins file ${file}`;
    // The anchor vocabulary is the PAGE's (registry `pinHint`), never spelled
    // out here — this module is generic to every project.
    const anchors = (opts.anchorHint ?? "").trim();
    const vocab = anchors.length > 0 ? `anchor kinds on this page: ${anchors}` : "anchor: the page's own <kind>:<id> key, as in the pins it already holds";
    return sanitizeForTypedLine(
      `Workstation context: panel shows ${ref} (${count}; ${vocab}; to add a pin, append to its pins array ` +
        `{id, doc: ${artifact.page}, anchor, anchorLabel, note, origin: thread, xPct: 0, yPct: 0, createdAt} — ` +
        `create the file as {version: 1, pins: []} if absent; the app re-reads it while the page is open).`,
      SPAWN_CONTEXT_MAX
    );
  }
  // The doc one-liner is UNCHANGED by 3c (it is an acceptance criterion): a
  // doc pin's `anchor` field (h:<slug> / table:<n>:row:<m>) is self-describing
  // in the sidecar the clause already points the agent at.
  const clause =
    pins > 0 ? ` (${pins} pin${pins === 1 ? "" : "s"} in ${SIDECAR_NAME} alongside)` : "";
  return sanitizeForTypedLine(`Workstation context: panel shows ${ref}${clause}.`, SPAWN_CONTEXT_MAX);
}

/** A pin as the send-to-thread reference names it: its DISPLAY number (1-based
 *  position in the doc's pin list — what the badge shows) plus its note.
 *
 *  ANCHORED pins (Inc 3d — SWIT-38) also carry the page's key for the thing
 *  and its label, so the line says WHAT the pin is on, not just which number:
 *  `pin 2 (trade:t1 — NQ long 10:02): "note"`. The agent can then find the
 *  same thing through the project's own tools (a trade id, a table row) —
 *  a number alone only means something to a person looking at the rail. */
export type PinReference = { number: number; note: string; anchor?: string; label?: string };

/** Cap for the `(anchor — label)` clause of an anchored pin reference. */
export const PIN_ANCHOR_MAX = 160;

/** SEAM 2 — the exact text a `→ thread` click TYPES into the terminal.
 *
 *  Single line, NO trailing newline (that would be an Enter, i.e. sending on
 *  the user's behalf). The caller writes this verbatim and nothing else.
 *
 *    Look at "kb <path>"
 *    Look at "kb <path>", pin 2: "the CTA is below the fold"
 *    Look at "kb <path>", pin 2          (note still empty)
 *
 *  THE REF IS QUOTED, and the quotes are ours. Unlike buildSpawnContext —
 *  whose one-liner rides INSIDE launchCommand's own double quotes — nothing
 *  wraps this line, and the drop list alone does not cover a bare shell:
 *  `; | & ' < >` are all legal in a filename and all shell syntax unquoted, so
 *  `notes & calc.md` would type a line that runs two commands if Enter is
 *  pressed at a prompt whose claude has exited (a case the module header
 *  explicitly admits happens). Quoting fixes it without mangling the path,
 *  which is what adding those characters to the drop list would do — and it
 *  cannot be escaped, because artifactRef has already removed every `"`.
 *  Same rule, same reason, as the framing quotes around the note below.
 */
export function buildSendReference(
  artifact: Artifact,
  pin?: PinReference | null,
  opts: RefOptions = {}
): string {
  const bare = artifactRef(artifact, opts);
  // Nothing to reference (a session with no known scrollback root — see
  // artifactRef): type NOTHING. `Look at ""` says less than silence.
  if (bare.length === 0) return "";
  // A LIVE TERMINAL, same reason as the spawn seam: "Look at" a shell is the
  // wrong verb and the wrong object. Name the FILE and say what it is, so the
  // line is actionable without the user having to explain it afterwards.
  // Pins are impossible here, so the pin branch below is unreachable for a
  // session and is not spelled out twice.
  if (artifact.kind === "session") {
    // No final sanitize: `path` and the name are already clean (and a second
    // pass would strip the quotes this line adds), and both are capped so the
    // assembled line stays under SEND_REFERENCE_MAX.
    return `Read "${sessionTranscriptPath(artifact.sessionId, opts)}" — the output of the live terminal ${sessionDisplayName(opts)} in my panel`;
  }
  const ref = `"${bare}"`;
  if (!pin) return `Look at ${ref}`;
  const number = Number.isFinite(pin.number)
    ? Math.min(MAX_PIN_NUMBER, Math.max(1, Math.trunc(pin.number)))
    : 1;
  const note = sanitizeForTypedLine(pin.note ?? "", PIN_NOTE_MAX);
  // The anchor clause rides UNQUOTED inside parentheses — it is sanitized like
  // the note (no quotes, no metacharacters survive), and parentheses are inert
  // in a typed line that is not being evaluated. `—` separates key from label.
  const anchor = sanitizeForTypedLine(pin.anchor ?? "", PIN_ANCHOR_MAX);
  const label = sanitizeForTypedLine(pin.label ?? "", PIN_ANCHOR_MAX);
  const where =
    anchor.length > 0
      ? label.length > 0 && label !== anchor
        ? ` (${sanitizeForTypedLine(`${anchor} — ${label}`, PIN_ANCHOR_MAX)})`
        : ` (${anchor})`
      : "";
  return note.length > 0
    ? `Look at ${ref}, pin ${number}${where}: "${note}"`
    : `Look at ${ref}, pin ${number}${where}`;
}

// ── KB root cache ────────────────────────────────────────────────────────────
// The absolute KB path comes from Rust (kb_root) and never changes while the
// app runs, so App fetches it ONCE at boot and parks it here — the builders
// stay pure (they take it as an option) while both call sites can reach it
// without threading a prop through the panel and the wireframe rail.

let kbRootCache: string | null = null;
let scrollbackRootCache: string | null = null;

/** App publishes the resolved KB root here at boot (null = unresolved; the
 *  builders then emit KB-relative refs). */
export function setKbRootForContext(root: string | null): void {
  kbRootCache = root && root.length > 0 ? root : null;
}

/** The cached KB root, for call sites building a ref. */
export function getKbRootForContext(): string | null {
  return kbRootCache;
}

/** App publishes the scrollback mirror directory here at boot. Null = a
 *  `session` artifact has NO ref, and both seams fall silent for it — which is
 *  exactly the pre-linkage behaviour, so a failed lookup degrades to the old
 *  honest silence rather than to a broken path. */
export function setScrollbackRootForContext(root: string | null): void {
  scrollbackRootCache = root && root.length > 0 ? root : null;
}

export function getScrollbackRootForContext(): string | null {
  return scrollbackRootCache;
}

/** The ✦-page one-liner for a spawn WHOSE MCP CONFIG ATTACHED (SWIT-49).
 *  Deliberately SHORT — the full behavioural contract (R2 language rules, R3
 *  tab rules) rides in the page tool's own DESCRIPTION, which travels over
 *  MCP with no shell-line limits and refreshes every session; this line only
 *  tells the agent the page exists and to use the tool. Composed FIRST in
 *  the joined context so a long panel ref truncates its own tail, never this. */
export function buildPageContractLine(): string {
  return sanitizeForTypedLine(
    "This thread has a PAGE beside the terminal — the one surface the user reads. " +
      "After each turn of work, record what happened with the page tool and keep its " +
      "evidence and items current; the tool description has the rules.",
    SPAWN_CONTEXT_MAX
  );
}

/** Same shape for the per-thread data root (SWIT-48): fetched once at boot;
 *  unset = a page has no ref, exactly the pre-page behaviour. */
let threadsRootCache: string | null = null;

export function setThreadsRootForContext(root: string | null): void {
  threadsRootCache = root && root.length > 0 ? root : null;
}

/** Convenience for call sites: `buildSendReference(a, p, refOptions())`.
 *  `sessionName` is NOT here — it is per-artifact and the caller holds it
 *  (panelStore.artifactShortTitle). */
export function refOptions(): RefOptions {
  return { kbRoot: kbRootCache, scrollbackRoot: scrollbackRootCache, threadsRoot: threadsRootCache };
}
