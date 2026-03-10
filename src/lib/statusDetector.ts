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
 *  With PATTERN_SCAN_LINES=3, patterns scroll out of the scan window quickly,
 *  so this is a safety net for edge cases. */
const STICKY_EXPIRY_CHUNKS = 6;

/** Rolling buffer size for multi-chunk numbered-list detection */
const RECENT_LINES_MAX = 10;

/** How many trailing lines (near cursor) to check for waiting/error patterns.
 *  Patterns outside this window are considered "old output" and ignored.
 *  Keeps false positives short-lived: a pattern at line N only triggers
 *  for ~3 lines of subsequent output before scrolling out of range. */
const PATTERN_SCAN_LINES = 3;

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

/** Matches Claude Code's idle prompt (agent finished, waiting for new task).
 *  Only matches when ❯ appears alone on a line (possibly with whitespace). */
const PROMPT_RE = /^\s*❯\s*$/;

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

/** Status priority: higher number = higher priority (transitions up are instant) */
const STATUS_PRIORITY: Record<AgentStatus, number> = {
  done: 0,
  running: 1,
  error: 2,
  waiting: 3,
  exited: 4,
};

/** Minimum dwell time (ms) before transitioning TO a given status.
 *  Transitions to running require 400ms hold to prevent done→running flicker.
 *  Higher-priority transitions (waiting/error) are instant. */
const DWELL_MS: Partial<Record<AgentStatus, number>> = {
  running: 400,
};

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
  /** Timestamp of the last committed status transition */
  lastTransitionTime: number;
  /** Pending dwell transition (queued lower-priority status change) */
  pendingDwell: {
    status: AgentStatus;
    timerId: ReturnType<typeof setTimeout>;
  } | null;
  /** Last processed absolute cursor Y — for delta-based detection */
  lastProcessedCursorY: number;
  /** Timestamp when the current dwell transition first started.
   *  Tracks elapsed time so streaming output doesn't endlessly restart the timer. */
  dwellStartTime: number | null;
}

const detectors = new Map<string, DetectorState>();

// --- RAF coalescing: at most one React update per session per frame ---
const pendingStatusUpdates = new Map<string, { status: AgentStatus; callback: (sessionId: string, status: AgentStatus) => void }>();
let rafId: number | null = null;

function emitStatusChange(
  sessionId: string,
  status: AgentStatus,
  callback: (sessionId: string, status: AgentStatus) => void
): void {
  pendingStatusUpdates.set(sessionId, { status, callback });
  if (rafId === null) {
    rafId = -1; // Mark as scheduled before calling rAF
    requestAnimationFrame(() => {
      for (const [sid, { status: s, callback: cb }] of pendingStatusUpdates) {
        cb(sid, s);
      }
      pendingStatusUpdates.clear();
      rafId = null;
    });
  }
}

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
    lastTransitionTime: Date.now(),
    pendingDwell: null,
    lastProcessedCursorY: -1,
    dwellStartTime: null,
  });
}

/** Cancel any pending dwell transition */
function cancelPendingDwell(state: DetectorState): void {
  if (state.pendingDwell) {
    clearTimeout(state.pendingDwell.timerId);
    state.pendingDwell = null;
  }
}

/**
 * Attempt a status transition with dwell-time hysteresis.
 * - Higher-priority transitions are instant and cancel pending lower-priority ones.
 * - Lower-priority transitions are deferred by DWELL_MS for the target status.
 */
function transitionWithDwell(
  sessionId: string,
  state: DetectorState,
  newStatus: AgentStatus,
  onStatusChange: (sessionId: string, status: AgentStatus) => void
): void {
  if (newStatus === state.currentStatus) return;

  const currentPriority = STATUS_PRIORITY[state.currentStatus] ?? 0;
  const newPriority = STATUS_PRIORITY[newStatus] ?? 0;
  const dwellMs = DWELL_MS[newStatus] ?? 0;

  // Higher priority → instant transition, cancel any pending dwell
  if (newPriority > currentPriority) {
    cancelPendingDwell(state);
    state.dwellStartTime = null;
    commitTransition(sessionId, state, newStatus, onStatusChange);
    return;
  }

  // Same or lower priority with no dwell → instant
  if (dwellMs <= 0) {
    cancelPendingDwell(state);
    state.dwellStartTime = null;
    commitTransition(sessionId, state, newStatus, onStatusChange);
    return;
  }

  // Track when dwell first started — survives re-queuing from streaming output.
  // Once elapsed time exceeds dwellMs, commit immediately instead of endlessly
  // restarting the timer on every chunk.
  if (state.dwellStartTime === null || state.pendingDwell?.status !== newStatus) {
    state.dwellStartTime = Date.now();
  }

  const elapsed = Date.now() - state.dwellStartTime;
  if (elapsed >= dwellMs) {
    cancelPendingDwell(state);
    state.dwellStartTime = null;
    commitTransition(sessionId, state, newStatus, onStatusChange);
    return;
  }

  // Queue the transition if not already queued for this status
  if (state.pendingDwell?.status === newStatus) return;
  cancelPendingDwell(state);
  const remaining = dwellMs - elapsed;
  state.pendingDwell = {
    status: newStatus,
    timerId: setTimeout(() => {
      const s = detectors.get(sessionId);
      if (s && s.pendingDwell?.status === newStatus) {
        s.pendingDwell = null;
        s.dwellStartTime = null;
        // Revalidate: only commit if still desired
        if (s.currentStatus !== newStatus) {
          commitTransition(sessionId, s, newStatus, onStatusChange);
        }
      }
    }, remaining),
  };
}

function commitTransition(
  sessionId: string,
  state: DetectorState,
  newStatus: AgentStatus,
  onStatusChange: (sessionId: string, status: AgentStatus) => void
): void {
  log.debug(`Status transition id=${sessionId}: ${state.currentStatus} -> ${newStatus}`);
  state.currentStatus = newStatus;
  state.lastTransitionTime = Date.now();
  emitStatusChange(sessionId, newStatus, onStatusChange);
}

/**
 * Buffer-based detection: operates on clean text lines read from xterm's buffer
 * after onWriteParsed fires. Lines are already stripped of ANSI by xterm's
 * buffer.translateToString(true). This avoids false matches from mid-chunk
 * ANSI splits and fires at most once per frame.
 */
export function processBufferLines(
  sessionId: string,
  lines: string[],
  cursorAbsY: number,
  onStatusChange: (sessionId: string, status: AgentStatus) => void
): void {
  const state = detectors.get(sessionId);
  if (!state) return;

  // Check if any line has meaningful visible content
  const hasMeaningful = lines.some((l) => /\S/.test(l));
  if (!hasMeaningful) return;

  // Position-based delta detection (replaces content dedup).
  // Cursor blink and internal xterm redraws fire onWriteParsed without
  // new PTY data — the cursor position stays the same.
  const positionUnchanged = cursorAbsY === state.lastProcessedCursorY && cursorAbsY >= 0;
  const positionReset = cursorAbsY < state.lastProcessedCursorY;

  if (positionUnchanged) {
    // Cursor blink / redraw: reset idle timer so it doesn't freeze,
    // but skip all pattern matching (no new data to analyze).
    state.lastOutputTime = Date.now();
    if (state.idleTimeoutId !== null) {
      clearTimeout(state.idleTimeoutId);
      state.idleTimeoutId = null;
    }
    // Re-arm the idle timer with the appropriate delay
    const doneDelay = DONE_TIMEOUT_MS;
    state.idleTimeoutId = setTimeout(() => {
      const s = detectors.get(sessionId);
      if (s && s.currentStatus === "running") {
        transitionWithDwell(sessionId, s, "done", onStatusChange);
      }
    }, doneDelay);
    return;
  }

  // Compute delta: how many new lines since last read
  let deltaLines: string[];
  if (positionReset || state.lastProcessedCursorY < 0) {
    // Terminal cleared, alternate buffer, or first read — process all lines
    deltaLines = lines;
  } else {
    const deltaCount = cursorAbsY - state.lastProcessedCursorY;
    const clampedDelta = Math.min(deltaCount, lines.length);
    deltaLines = lines.slice(-clampedDelta);
  }

  state.lastProcessedCursorY = cursorAbsY;

  // Store callback ref for async timer use
  state.lastCallback = onStatusChange;

  let hasTokenCounter = false;
  let hasCompletion = false;
  let hasPrompt = false;

  // Scan ALL lines for structural signals (token counter, completion, prompt)
  for (const line of lines) {
    if (!hasTokenCounter && TOKEN_COUNTER_RE.test(line)) hasTokenCounter = true;
    if (!hasCompletion && COMPLETION_RE.test(line)) hasCompletion = true;
    if (!hasPrompt && PROMPT_RE.test(line)) hasPrompt = true;
  }

  // Scan delta lines for waiting/error patterns (only new content).
  // Also limit to PATTERN_SCAN_LINES from the tail so stale patterns
  // in the delta window don't re-trigger.
  const patternLines = deltaLines.slice(-PATTERN_SCAN_LINES);
  let detectedWaiting = false;
  let detectedError = false;

  // Token counter is a strong "running" signal — if the agent is actively
  // counting tokens, any waiting/error pattern in the same window is stale
  // output from a previous step.  Skip pattern matching entirely.
  if (!hasTokenCounter) {
    for (const line of patternLines) {
      if (!detectedWaiting) {
        for (const p of WAITING_PATTERNS) {
          if (p.test(line)) {
            detectedWaiting = true;
            break;
          }
        }
      }
      if (!detectedWaiting && !detectedError) {
        for (const p of ERROR_PATTERNS) {
          if (p.test(line)) {
            detectedError = true;
            break;
          }
        }
      }
    }
  }

  // Token counter clears sticky waiting and pending timers
  if (hasTokenCounter) {
    cancelPendingWaiting(state);
    if (state.stickyWaiting) {
      state.stickyWaiting = false;
      state.chunksSinceWaiting = 0;
    }
  }

  // Non-blank lines for numbered-list detection (use entire line array)
  const nonBlankLines = lines.filter((l) => l.trim().length > 0);

  // If meaningful output arrives while a pending timer is active, cancel it
  if (state.pendingWaitingTimerId !== null && !detectedWaiting) {
    const isOnlyNumberedItems = nonBlankLines.length > 0 && nonBlankLines.every((l) => NUMBERED_OPTION_RE.test(l));
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
    cancelPendingWaiting(state);
  } else if (state.stickyWaiting) {
    state.chunksSinceWaiting++;
    if (state.chunksSinceWaiting >= STICKY_EXPIRY_CHUNKS) {
      state.stickyWaiting = false;
      state.chunksSinceWaiting = 0;
      if (detectedError) {
        newStatus = "error";
      }
    } else {
      newStatus = "waiting";
    }
  } else if (detectedError) {
    newStatus = "error";
  }

  if (newStatus !== state.currentStatus) {
    transitionWithDwell(sessionId, state, newStatus, onStatusChange);
  }

  // Numbered list detection on the buffer lines directly
  // Use the effective current status (may have been updated by transitionWithDwell)
  if (
    !hasTokenCounter &&
    state.currentStatus === "running" &&
    state.pendingWaitingTimerId === null &&
    hasTrailingNumberedList(nonBlankLines)
  ) {
    state.pendingWaitingTimerId = setTimeout(() => {
      const s = detectors.get(sessionId);
      if (s && s.currentStatus === "running") {
        s.pendingWaitingTimerId = null;
        s.stickyWaiting = true;
        s.chunksSinceWaiting = 0;
        // waiting is high priority → instant transition
        transitionWithDwell(sessionId, s, "waiting", s.lastCallback ?? onStatusChange);
      }
    }, PENDING_WAITING_DELAY_MS);
  }

  // Set up done timeout.
  // Prompt (❯) = agent returned to idle prompt → very fast done.
  // Completion (✓ ... Xs) = agent finished a tool step → quick done.
  // Otherwise = standard idle timeout.
  const doneDelay = hasPrompt ? 500
    : hasCompletion ? SHORT_DONE_TIMEOUT_MS
    : DONE_TIMEOUT_MS;
  state.idleTimeoutId = setTimeout(() => {
    const s = detectors.get(sessionId);
    if (s && s.currentStatus === "running") {
      transitionWithDwell(sessionId, s, "done", onStatusChange);
    }
  }, doneDelay);
}

/** @deprecated Use processBufferLines() with onWriteParsed instead */
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
    emitStatusChange(sessionId, newStatus, onStatusChange);
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
          emitStatusChange(sessionId, "waiting", s.lastCallback);
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
      emitStatusChange(sessionId, "done", onStatusChange);
    }
  }, doneDelay);
}

/** Clear sticky waiting state when the user sends input (they responded to the prompt) */
export function clearWaiting(
  sessionId: string,
  onStatusChange?: (sessionId: string, status: AgentStatus) => void
): void {
  const state = detectors.get(sessionId);
  if (!state) return;
  // Always clear recentLines — cheap, and prevents old partial numbered lists
  // from combining with new output after user input.
  state.recentLines = [];
  // Fast path: nothing else to clear — skip work on every keystroke
  if (
    !state.stickyWaiting &&
    state.pendingWaitingTimerId === null &&
    state.pendingDwell === null &&
    state.currentStatus !== "waiting"
  ) return;
  state.stickyWaiting = false;
  cancelPendingWaiting(state);
  cancelPendingDwell(state);
  if (state.currentStatus === "waiting" && onStatusChange) {
    state.currentStatus = "running";
    state.lastTransitionTime = Date.now();
    emitStatusChange(sessionId, "running", onStatusChange);
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
  cancelPendingDwell(state);
  state.currentStatus = "exited";
  state.lastTransitionTime = Date.now();
  onStatusChange(sessionId, "exited");
}

export function destroyDetector(sessionId: string): void {
  const state = detectors.get(sessionId);
  if (state) {
    if (state.idleTimeoutId !== null) {
      clearTimeout(state.idleTimeoutId);
    }
    cancelPendingWaiting(state);
    cancelPendingDwell(state);
    detectors.delete(sessionId);
  }
}

/** Exported for testing only */
export const _testOnly = { hasTrailingNumberedList };
