import type { AgentStatus } from "../types";
import { log } from "./logger";

const DONE_TIMEOUT_MS = 5_000;

/** Number of meaningful output chunks (without a waiting pattern re-appearing)
 *  after which stickyWaiting auto-clears. Prevents false-positive patterns
 *  from keeping the status stuck on "waiting" while the agent is clearly working. */
const STICKY_EXPIRY_CHUNKS = 3;

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

const WAITING_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /Do you want to proceed/i,
  /Do you want to continue/i,
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

  // Set up done timeout — only fires when actively running (not waiting/error)
  state.idleTimeoutId = setTimeout(() => {
    const s = detectors.get(sessionId);
    if (s && s.currentStatus === "running") {
      s.currentStatus = "done";
      onStatusChange(sessionId, "done");
    }
  }, DONE_TIMEOUT_MS);
}

/** Clear sticky waiting state when the user sends input (they responded to the prompt) */
export function clearWaiting(
  sessionId: string,
  onStatusChange?: (sessionId: string, status: AgentStatus) => void
): void {
  const state = detectors.get(sessionId);
  if (state) {
    state.stickyWaiting = false;
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
  state.currentStatus = "exited";
  onStatusChange(sessionId, "exited");
}

export function destroyDetector(sessionId: string): void {
  const state = detectors.get(sessionId);
  if (state) {
    if (state.idleTimeoutId !== null) {
      clearTimeout(state.idleTimeoutId);
    }
    detectors.delete(sessionId);
  }
}
