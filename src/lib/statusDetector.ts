import type { AgentStatus } from "../types";
import { log } from "./logger";

/** Default idle timeout — if no output for this long while "running", transition to "done".
 *  Longer = less flickering between blue/green during multi-step agent work. */
const DONE_TIMEOUT_MS = 8_000;

/** Shorter idle timeout used after a structural completion signal (checkmark + past tense + timing).
 *  Lets us show "done" faster when we're confident the agent actually finished. */
const SHORT_DONE_TIMEOUT_MS = 2_000;

/** Number of meaningful output chunks (without a waiting pattern re-appearing)
 *  after which stickyWaiting auto-clears. Prevents false-positive patterns
 *  from keeping the status stuck on "waiting" while the agent is clearly working.
 *  Higher = more conservative (stays yellow longer). */
const STICKY_EXPIRY_CHUNKS = 12;

/** Rolling buffer size for multi-chunk numbered-list detection */
const RECENT_LINES_MAX = 10;

/** Silence window after numbered list before transitioning to "waiting".
 *  Must be long enough that streaming output finishes before we commit to "waiting". */
const PENDING_WAITING_DELAY_MS = 1_500;

/** Matches numbered options like "  1. Allow", "  2. No" (capped at 1-4) */
const NUMBERED_OPTION_RE = /^\s*([1-4])\.\s+\S/;

/** Matches Claude Code's running indicator like "(3s, 1.2k tokens)" */
const TOKEN_COUNTER_RE = /\(\d+s,\s*[\d.]+k?\s*tokens?\)/;

/** Matches Claude Code's completion lines: checkmark + word(s) + (Xs) timing.
 *  e.g. "✓ Edited src/App.tsx (2s)", "✔ Wrote file.txt (0.5s)", "✓ Ran tests (15s)" */
const COMPLETION_RE = /[✓✔]\s+\w+.*\(\d+(\.\d+)?s\)/;

// Matches ANSI escape sequences: CSI (ESC[...letter), OSC (ESC]...BEL), and 2-char escapes
const ANSI_RE = /\x1b(?:\[[^a-zA-Z@]*[a-zA-Z@]|\][^\x07]*\x07?|[^[\]])/g;

/** Strip ANSI escape sequences for clean pattern matching */
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Returns true if text contains visible characters after stripping ANSI sequences and control chars */
function isMeaningfulOutput(text: string): boolean {
  const stripped = stripAnsi(text).replace(/[\x00-\x1f\x7f]/g, "");
  return /\S/.test(stripped);
}

/**
 * Check if the tail of the line buffer contains a consecutive numbered list
 * starting from 1 with at least 2 items (e.g. "1. Yes\n2. No").
 */
function hasTrailingNumberedList(lines: string[]): boolean {
  const numbers: number[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = NUMBERED_OPTION_RE.exec(lines[i]);
    if (match) {
      numbers.unshift(parseInt(match[1], 10));
    } else {
      break; // Non-numbered line stops the backward scan
    }
  }
  if (numbers.length < 2) return false;
  if (numbers[0] !== 1) return false;
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] !== numbers[i - 1] + 1) return false;
  }
  return true;
}

/** Cancel any pending numbered-list waiting timer */
function cancelPendingWaiting(state: DetectorState): void {
  if (state.pendingWaitingTimerId !== null) {
    clearTimeout(state.pendingWaitingTimerId);
    state.pendingWaitingTimerId = null;
  }
}

const WAITING_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /Do you want to proceed/i,
  /Do you want to continue/i,
  /Do you want to make this edit/i,
  /Do you want to allow/i,
  /Would you like to proceed/i,
  /Would you like to install/i,
  /Would you like to stash/i,
  /Allow this action/i,
  /Press any key/i,
  /Are you sure/i,
  /\bConfirm\b/i,
  /\? \[Y\/n\]/i,
  /\? \(Y\/n\)/i,
  /Enter a value/i,
  /waiting for input/i,
];

const ERROR_PATTERNS = [
  /Error:/i,
  /FAILED/,
  /panic:/,
  /ERROR/,
  /fatal:/i,
  /Traceback \(most recent/,
  /Exception:/,
];

interface DetectorState {
  lastOutputTime: number;
  currentStatus: AgentStatus;
  idleTimeoutId: ReturnType<typeof setTimeout> | null;
  /** When true, "waiting" status persists until clearWaiting() is called or auto-expires */
  stickyWaiting: boolean;
  /** Meaningful output chunks since the last waiting pattern match.
   *  Once this reaches STICKY_EXPIRY_CHUNKS, stickyWaiting auto-clears. */
  chunksSinceWaiting: number;
  /** Rolling buffer of recent non-blank cleaned lines for numbered-list detection */
  recentLines: string[];
  /** Timer for numbered-list-then-silence detection */
  pendingWaitingTimerId: ReturnType<typeof setTimeout> | null;
  /** Stores latest onStatusChange ref for async timer callback */
  lastCallback: ((sessionId: string, status: AgentStatus) => void) | null;
}

const detectors = new Map<string, DetectorState>();

export function initDetector(sessionId: string): void {
  destroyDetector(sessionId);
  detectors.set(sessionId, {
    lastOutputTime: Date.now(),
    currentStatus: "running",
    idleTimeoutId: null,
    stickyWaiting: false,
    chunksSinceWaiting: 0,
    recentLines: [],
    pendingWaitingTimerId: null,
    lastCallback: null,
  });
}

export function processOutput(
  sessionId: string,
  text: string,
  onStatusChange: (sessionId: string, status: AgentStatus) => void
): void {
  const state = detectors.get(sessionId);
  if (!state) return;

  // Strip ANSI before pattern matching so escape sequences (terminal titles,
  // cursor movements, etc.) don't cause false-positive pattern matches
  const clean = stripAnsi(text);

  let detectedWaiting = false;
  let detectedError = false;

  for (const p of WAITING_PATTERNS) {
    if (p.test(clean)) {
      detectedWaiting = true;
      break;
    }
  }

  if (!detectedWaiting) {
    for (const p of ERROR_PATTERNS) {
      if (p.test(clean)) {
        detectedError = true;
        break;
      }
    }
  }

  // If no pattern matched and the output is just control sequences (cursor moves,
  // title updates, etc.), ignore it — don't reset the timer or flip to "running"
  if (!detectedWaiting && !detectedError && !isMeaningfulOutput(text)) {
    return;
  }

  // Accumulate non-blank cleaned lines into rolling buffer
  const newLines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (newLines.length > 0) {
    state.recentLines.push(...newLines);
    if (state.recentLines.length > RECENT_LINES_MAX) {
      state.recentLines = state.recentLines.slice(-RECENT_LINES_MAX);
    }
  }

  // Store callback ref for async timer use
  state.lastCallback = onStatusChange;

  const hasTokenCounter = TOKEN_COUNTER_RE.test(clean);
  const hasCompletion = COMPLETION_RE.test(clean);

  // Token counter is a strong "running" signal — the agent is actively
  // processing, so cancel any pending numbered-list timer AND clear sticky
  // waiting (the agent clearly moved past any earlier prompt)
  if (hasTokenCounter) {
    cancelPendingWaiting(state);
    if (state.stickyWaiting) {
      state.stickyWaiting = false;
      state.chunksSinceWaiting = 0;
    }
  }

  // If meaningful output arrives while a pending timer is active, cancel it —
  // the numbered list was part of response text, not a prompt
  if (state.pendingWaitingTimerId !== null && !detectedWaiting) {
    // Only cancel if we got non-numbered-list meaningful output
    const isOnlyNumberedItems = newLines.length > 0 && newLines.every((l) => NUMBERED_OPTION_RE.test(l));
    if (!isOnlyNumberedItems) {
      cancelPendingWaiting(state);
    }
  }

  state.lastOutputTime = Date.now();

  // Clear existing done timeout
  if (state.idleTimeoutId !== null) {
    clearTimeout(state.idleTimeoutId);
    state.idleTimeoutId = null;
  }

  // Determine new status: waiting > error > running
  let newStatus: AgentStatus = "running";

  if (detectedWaiting) {
    newStatus = "waiting";
    state.stickyWaiting = true;
    state.chunksSinceWaiting = 0;
    cancelPendingWaiting(state); // Legacy pattern wins, no need for timer
  } else if (state.stickyWaiting) {
    state.chunksSinceWaiting++;
    if (state.chunksSinceWaiting >= STICKY_EXPIRY_CHUNKS) {
      // Agent has produced enough output without a waiting pattern re-appearing —
      // the earlier match was likely a false positive (e.g. "Confirmed" in output)
      state.stickyWaiting = false;
      state.chunksSinceWaiting = 0;
      if (detectedError) {
        newStatus = "error";
      }
      // else stays "running"
    } else {
      newStatus = "waiting";
    }
  } else if (detectedError) {
    newStatus = "error";
  }

  if (newStatus !== state.currentStatus) {
    log.debug(`Status transition id=${sessionId}: ${state.currentStatus} -> ${newStatus}`);
    state.currentStatus = newStatus;
    onStatusChange(sessionId, newStatus);
  }

  // After resolving status: if we're "running" and tail has a numbered list,
  // start the silence timer for structural waiting detection
  if (
    newStatus === "running" &&
    state.pendingWaitingTimerId === null &&
    hasTrailingNumberedList(state.recentLines)
  ) {
    state.pendingWaitingTimerId = setTimeout(() => {
      const s = detectors.get(sessionId);
      if (s && s.currentStatus === "running") {
        s.pendingWaitingTimerId = null;
        s.stickyWaiting = true;
        s.chunksSinceWaiting = 0;
        s.currentStatus = "waiting";
        log.debug(`Status transition id=${sessionId}: running -> waiting (numbered list)`);
        if (s.lastCallback) {
          s.lastCallback(sessionId, "waiting");
        }
      }
    }, PENDING_WAITING_DELAY_MS);
  }

  // Set up done timeout — only fires when actively running (not waiting/error).
  // Use a shorter timeout when we detected a completion pattern (checkmark + timing),
  // since that's a strong signal the agent finished an action.
  const doneDelay = hasCompletion ? SHORT_DONE_TIMEOUT_MS : DONE_TIMEOUT_MS;
  state.idleTimeoutId = setTimeout(() => {
    const s = detectors.get(sessionId);
    if (s && s.currentStatus === "running") {
      s.currentStatus = "done";
      onStatusChange(sessionId, "done");
    }
  }, doneDelay);
}

/** Clear sticky waiting state when the user sends input (they responded to the prompt) */
export function clearWaiting(
  sessionId: string,
  onStatusChange?: (sessionId: string, status: AgentStatus) => void
): void {
  const state = detectors.get(sessionId);
  if (state) {
    state.stickyWaiting = false;
    cancelPendingWaiting(state);
    state.recentLines = [];
    if (state.currentStatus === "waiting" && onStatusChange) {
      state.currentStatus = "running";
      onStatusChange(sessionId, "running");
    }
  }
}

export function markExited(
  sessionId: string,
  onStatusChange: (sessionId: string, status: AgentStatus) => void
): void {
  const state = detectors.get(sessionId);
  if (!state) return;
  log.debug(`Session exited id=${sessionId}`);
  if (state.idleTimeoutId !== null) {
    clearTimeout(state.idleTimeoutId);
    state.idleTimeoutId = null;
  }
  cancelPendingWaiting(state);
  state.currentStatus = "exited";
  onStatusChange(sessionId, "exited");
}

export function destroyDetector(sessionId: string): void {
  const state = detectors.get(sessionId);
  if (state) {
    if (state.idleTimeoutId !== null) {
      clearTimeout(state.idleTimeoutId);
    }
    cancelPendingWaiting(state);
    detectors.delete(sessionId);
  }
}

/** Exported for testing only */
export const _testOnly = { hasTrailingNumberedList };
