// RESUMED-SESSION HEAL (SWIT-100) — the decision, pure so vitest can walk it.
// Ported from ky-desktop's `chat/resumeHeal.ts` (CC-762); the constants and the
// rule order are Ky's, verbatim.
//
// What it fixes ("the thread is always mangled after a restart"): a thread
// reopened after an app restart types `claude --resume`, claude replays the
// transcript, then repaints its live frame a few rows OFF from where it first
// drew it, writing only the non-blank cells — so the previous row shows
// through every space ("only onlyour go. Wheredthings stand:"). Ky read that
// straight out of claude's own ConPTY screen buffer: a copy of the same
// transcript resumed in a bare Windows console garbles the same way, so it is
// claude's doing, not xterm's and not the restored scrollback's (SWIT-93
// fixed that half — where the restored frame leaves the cursor).
//
// What heals it: a rows-only PTY bounce (rows-1 → rows). claude repaints the
// WHOLE frame at the true grid on the way back. xterm is never touched, so
// nothing reflows. (Since SWIT-103 pinned the grid, this bounce and the
// narrow-frame nudge that shares it are the only PTY resizes there are.)
//
// When: at output settles inside a window after the resumed session's FIRST
// output (the replay lands ~2–25 s after spawn depending on MCP load; claude's
// late repaints — MCP status, notices — follow over the next ~10–20 s, each
// one a fresh chance to garble). Bounded so a chatty session can't turn every
// settle into a resize storm: a cap on bounces and a minimum gap, and never
// while the agent owns the frame (working, or parked on a prompt/menu — a
// SIGWINCH there redraws the dialog).
//
// BOTH screen facts are read from the terminal BUFFER at the settle, as Ky
// does (`bufferSignals.ts`), never from statusDetector: its RUNNING state
// leaves only after a dwell (2.5 s after a completion line, 15.5 s otherwise),
// so a 1.5 s settle would always read "still running", skip, and nothing
// would re-check when the status finally dropped (review of the first cut).

export const RESUME_HEAL_WINDOW_MS = 90_000;
export const RESUME_HEAL_MAX_BOUNCES = 5;
/** Floor between bounces. The bounce's OWN repaint lands within ~1 s and
 *  settles after its last byte — that settle must be refused or the echo
 *  re-bounces forever, so the gap cannot go below ~3 s. The cost is a blind
 *  window: a genuine late repaint from claude that settles together with the
 *  echo is refused the same way and stays garbled until claude prints anything
 *  else (which re-arms a settle inside the window). */
export const RESUME_HEAL_MIN_GAP_MS = 4_000;
/** Quiet after the last PTY byte that counts as a settle (Ky's turn-end
 *  settle; repaintRunner's REPAINT_SETTLE_MS is the same length on purpose —
 *  the two clocks fire at the same settle, this one first). */
export const RESUME_HEAL_SETTLE_MS = 1_500;
/** The pause between the two legs of the bounce. */
export const RESUME_HEAL_BOUNCE_GAP_MS = 120;

/** What the planner knows about a session that was launched with `--resume`
 *  (the runner holds state for no other kind). */
export type ResumeHealInput = {
  /** When the first PTY byte after the launch landed; 0 = nothing yet. */
  firstOutputAt: number;
  now: number;
  /** Heal bounces already sent for this session. */
  bounces: number;
  /** When the last heal bounce fired; 0 = never. */
  lastBounceAt: number;
  /** claude has drawn since the launch line (`claudeDrewAfterLaunch`). Until
   *  then the only output is the shell echoing that line, and a bounce would
   *  be spent on a booting shell. */
  drawn: boolean;
  /** The agent owns the frame — working, or parked on a prompt
   *  (`midTurnOnScreen`, read from the buffer AT the settle). */
  midTurn: boolean;
};

export type ResumeHealVerdict =
  | { bounce: true }
  | {
      bounce: false;
      why: "no-output" | "window-closed" | "cap" | "too-soon" | "booting" | "mid-turn";
    };

/** Decide whether this settle should bounce the PTY rows to heal a resumed
 *  session's repaint. Pure; resumeHealRunner sends it. */
export function planResumeHeal(input: ResumeHealInput): ResumeHealVerdict {
  if (!input.firstOutputAt) return { bounce: false, why: "no-output" };
  if (input.now - input.firstOutputAt > RESUME_HEAL_WINDOW_MS) {
    return { bounce: false, why: "window-closed" };
  }
  if (input.bounces >= RESUME_HEAL_MAX_BOUNCES) return { bounce: false, why: "cap" };
  if (input.lastBounceAt && input.now - input.lastBounceAt < RESUME_HEAL_MIN_GAP_MS) {
    return { bounce: false, why: "too-soon" };
  }
  if (!input.drawn) return { bounce: false, why: "booting" };
  if (input.midTurn) return { bounce: false, why: "mid-turn" };
  return { bounce: true };
}

/** Can a later settle still heal this session? False once the window closed or
 *  the cap is spent — the runner then forgets the session and stops arming
 *  timers on its output. */
export function resumeHealOpen(input: Pick<ResumeHealInput, "firstOutputAt" | "now" | "bounces">): boolean {
  if (input.bounces >= RESUME_HEAL_MAX_BOUNCES) return false;
  if (!input.firstOutputAt) return true;
  return input.now - input.firstOutputAt <= RESUME_HEAL_WINDOW_MS;
}

// ─────────────────────────────────────────────────────────────────────────────
// What the screen says — pure over a structural terminal type (Ky's
// bufferSignals.ts), so vitest fakes the buffer and nothing imports xterm.
// ─────────────────────────────────────────────────────────────────────────────

/** The slice of xterm's Terminal these read. */
export type TerminalTail = {
  rows: number;
  buffer: {
    active: {
      baseY: number;
      cursorY: number;
      getLine(y: number): { translateToString(trim?: boolean): string } | undefined;
    };
  };
};

function linesBetween(term: TerminalTail, start: number, end: number): string[] {
  const out: string[] = [];
  for (let y = Math.max(0, start); y <= end; y++) {
    const line = term.buffer.active.getLine(y);
    if (line) out.push(line.translateToString(true));
  }
  return out;
}

/** The last ~`lines` rendered lines up to the cursor, as clean text. */
export function tailText(term: TerminalTail, lines = 16): string {
  const end = term.buffer.active.baseY + term.buffer.active.cursorY;
  return linesBetween(term, end - lines, end).join("\n");
}

/** A real permission gate (Ky's list): the `❯ 1. Yes` menu or an explicit
 *  proceed/confirm question. */
const WAITING_PATTERNS: RegExp[] = [
  /❯\s*\d+\.\s*yes/i,
  /\benter to confirm\b/i,
  /do you want to (proceed|continue|allow|create|make)/i,
  /would you like to proceed/i,
  /\(y\/n\)/i,
];

/** Is claude visibly MID-TURN — working (the `esc to interrupt` footer) or
 *  parked on a permission prompt? A false positive only postpones the heal to
 *  the next settle. */
export function midTurnOnScreen(term: TerminalTail): boolean {
  const tail = tailText(term);
  return /\besc to interrupt\b/i.test(tail) || WAITING_PATTERNS.some((p) => p.test(tail));
}

/** How far above the cursor the launch line is looked for. */
export const LAUNCH_LOOKBACK_ROWS = 80;
const LAUNCH_LINE = /\bclaude --resume\b/;
/** Things only claude draws: its boot banner, an input-box rule, the working
 *  footer. */
const CLAUDE_DREW = [/Claude Code v\d/, /─{20,}/, /\besc to interrupt\b/i];

/** Has claude drawn anything since the `claude --resume` line was typed?
 *
 *  Looks for the LAST launch line in the rows around the cursor (a restored
 *  transcript above it may hold an older one, and an older frame — both are
 *  history). Found with nothing of claude's after it → still booting. Not
 *  found → it has scrolled out of the window, which takes more output than a
 *  shell echo: claude drew. */
export function claudeDrewAfterLaunch(term: TerminalTail): boolean {
  const buf = term.buffer.active;
  const cursor = buf.baseY + buf.cursorY;
  const lines = linesBetween(term, cursor - LAUNCH_LOOKBACK_ROWS, buf.baseY + term.rows - 1);
  let launchAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (LAUNCH_LINE.test(lines[i])) {
      launchAt = i;
      break;
    }
  }
  if (launchAt === -1) return true;
  return lines.slice(launchAt + 1).some((line) => CLAUDE_DREW.some((p) => p.test(line)));
}
