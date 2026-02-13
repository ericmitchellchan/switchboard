import type { AgentStatus } from "../types";

const DONE_TIMEOUT_MS = 5_000;

// Matches ANSI escape sequences: CSI (ESC[...letter), OSC (ESC]...BEL), and 2-char escapes
const ANSI_RE = /\x1b(?:\[[^a-zA-Z@]*[a-zA-Z@]|\][^\x07]*\x07?|[^[\]])/g;

/** Returns true if text contains visible characters after stripping ANSI sequences and control chars */
function isMeaningfulOutput(text: string): boolean {
  const stripped = text.replace(ANSI_RE, "").replace(/[\x00-\x1f\x7f]/g, "");
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
  /Confirm/i,
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
  /** When true, "waiting" status persists until clearWaiting() is called */
  stickyWaiting: boolean;
}

const detectors = new Map<string, DetectorState>();

export function initDetector(sessionId: string): void {
  destroyDetector(sessionId);
  detectors.set(sessionId, {
    lastOutputTime: Date.now(),
    currentStatus: "running",
    idleTimeoutId: null,
    stickyWaiting: false,
  });
}

export function processOutput(
  sessionId: string,
  text: string,
  onStatusChange: (sessionId: string, status: AgentStatus) => void
): void {
  const state = detectors.get(sessionId);
  if (!state) return;

  // Always check for waiting/error patterns (they can appear in styled output)
  let detectedWaiting = false;
  let detectedError = false;

  for (const p of WAITING_PATTERNS) {
    if (p.test(text)) {
      detectedWaiting = true;
      break;
    }
  }

  if (!detectedWaiting) {
    for (const p of ERROR_PATTERNS) {
      if (p.test(text)) {
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
  } else if (state.stickyWaiting) {
    newStatus = "waiting";
  } else if (detectedError) {
    newStatus = "error";
  }

  if (newStatus !== state.currentStatus) {
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
