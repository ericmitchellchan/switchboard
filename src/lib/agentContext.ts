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
//   - `"` dropped: it would close the quoted argument.
//   - `\` dropped: escape/line-continuation in POSIX shells (path separators
//     are normalized to `/` BEFORE this runs — see normalizePath).
//   - `$` dropped: POSIX + PowerShell variable/command expansion `$(...)`.
//   - `` ` `` dropped: POSIX command substitution + PowerShell escape.
//   - `%` dropped: cmd.exe variable expansion `%VAR%`.
//   - whitespace runs collapsed, ends trimmed, length capped.
//
// The framing quotes around a pin note are OURS and are added AFTER the note
// has been stripped of every `"`, so a note can never break out of them.

import type { Artifact } from "../types";
import { SIDECAR_NAME } from "./pins";

/** Cap for the spawn one-liner. Generous — it rides in a system prompt — but
 *  finite: a runaway path must not produce an unbounded typed line. */
export const SPAWN_CONTEXT_MAX = 2000;

/** Cap for an artifact reference (`kb <root>/<path>`, `repo <proj>/<path>`). */
export const REF_MAX = 300;

/** Cap for the user-authored note quoted inside a send-to-thread reference. */
export const PIN_NOTE_MAX = 240;

/** Upper bound on ANY string buildSendReference can return — derived from the
 *  component caps above (asserted in the tests, not enforced by a final
 *  truncation: truncating the assembled line could strip a closing quote). */
export const SEND_REFERENCE_MAX = 600;

/** Highest pin number a reference will print (keeps the bound above real). */
const MAX_PIN_NUMBER = 9999;

const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
const SHELL_METACHARS = /["\\$%`]/g;

/** The single sanitizer both seams use (see the module header for the rule
 *  list and why each character is on it). Idempotent: sanitizing an already
 *  sanitized string is a no-op, which is what makes defense-in-depth
 *  re-sanitization at the launch-line seam free. */
export function sanitizeForTypedLine(text: string, maxLength: number): string {
  if (typeof text !== "string") return "";
  const flattened = text
    .replace(CONTROL_CHARS, " ")
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
export type RefOptions = { kbRoot?: string | null };

/** How an artifact is NAMED to the agent: `<kind> <path>`.
 *
 *    kb-doc     → `kb C:/Users/eric/projects/personal-kb/switchboard/…/requirements.md`
 *                 (or `kb switchboard/…/requirements.md` with no known root)
 *    repo-file  → `repo switchboard/src/App.tsx`
 *    localhost  → `localhost switchboard http://localhost:5173` (phase B) */
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
  const pins = Number.isFinite(pinCount) ? Math.max(0, Math.trunc(pinCount)) : 0;
  const clause =
    pins > 0 ? ` (${pins} pin${pins === 1 ? "" : "s"} in ${SIDECAR_NAME} alongside)` : "";
  return sanitizeForTypedLine(`Workstation context: panel shows ${ref}${clause}.`, SPAWN_CONTEXT_MAX);
}

/** A pin as the send-to-thread reference names it: its DISPLAY number (1-based
 *  position in the doc's pin list — what the badge shows) plus its note. */
export type PinReference = { number: number; note: string };

/** SEAM 2 — the exact text a `→ thread` click TYPES into the terminal.
 *
 *  Single line, NO trailing newline (that would be an Enter, i.e. sending on
 *  the user's behalf). The caller writes this verbatim and nothing else.
 *
 *    Look at kb <path>
 *    Look at kb <path>, pin 2: "the CTA is below the fold"
 *    Look at kb <path>, pin 2            (note still empty)
 */
export function buildSendReference(
  artifact: Artifact,
  pin?: PinReference | null,
  opts: RefOptions = {}
): string {
  const ref = artifactRef(artifact, opts);
  if (!pin) return `Look at ${ref}`;
  const number = Number.isFinite(pin.number)
    ? Math.min(MAX_PIN_NUMBER, Math.max(1, Math.trunc(pin.number)))
    : 1;
  const note = sanitizeForTypedLine(pin.note ?? "", PIN_NOTE_MAX);
  return note.length > 0
    ? `Look at ${ref}, pin ${number}: "${note}"`
    : `Look at ${ref}, pin ${number}`;
}

// ── KB root cache ────────────────────────────────────────────────────────────
// The absolute KB path comes from Rust (kb_root) and never changes while the
// app runs, so App fetches it ONCE at boot and parks it here — the builders
// stay pure (they take it as an option) while both call sites can reach it
// without threading a prop through the panel and the wireframe rail.

let kbRootCache: string | null = null;

/** App publishes the resolved KB root here at boot (null = unresolved; the
 *  builders then emit KB-relative refs). */
export function setKbRootForContext(root: string | null): void {
  kbRootCache = root && root.length > 0 ? root : null;
}

/** The cached KB root, for call sites building a ref. */
export function getKbRootForContext(): string | null {
  return kbRootCache;
}

/** Convenience for call sites: `buildSendReference(a, p, refOptions())`. */
export function refOptions(): RefOptions {
  return { kbRoot: kbRootCache };
}
