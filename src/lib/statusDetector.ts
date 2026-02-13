import type { AgentStatus } from "../types";

const DONE_TIMEOUT_MS = 5_000;

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

  state.lastOutputTime = Date.now();

  // Clear existing idle timeout
  if (state.idleTimeoutId !== null) {
    clearTimeout(state.idleTimeoutId);
    state.idleTimeoutId = null;
  }

  // Priority: waiting > error > running
  let newStatus: AgentStatus = "running";

  for (const p of WAITING_PATTERNS) {
    if (p.test(text)) {
      newStatus = "waiting";
      break;
    }
  }

  if (newStatus === "waiting") {
    state.stickyWaiting = true;
  } else if (state.stickyWaiting) {
    // Keep waiting status until explicitly cleared by user input
    newStatus = "waiting";
  }

  if (newStatus !== "waiting") {
    for (const p of ERROR_PATTERNS) {
      if (p.test(text)) {
        newStatus = "error";
        break;
      }
    }
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
export function clearWaiting(sessionId: string): void {
  const state = detectors.get(sessionId);
  if (state) {
    state.stickyWaiting = false;
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
