import type { AgentStatus } from "../types";

const IDLE_TIMEOUT_MS = 15_000;

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
}

const detectors = new Map<string, DetectorState>();

export function initDetector(sessionId: string): void {
  destroyDetector(sessionId);
  detectors.set(sessionId, {
    lastOutputTime: Date.now(),
    currentStatus: "running",
    idleTimeoutId: null,
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

  // Set up idle timeout
  state.idleTimeoutId = setTimeout(() => {
    const s = detectors.get(sessionId);
    if (s && s.currentStatus !== "exited") {
      s.currentStatus = "idle";
      onStatusChange(sessionId, "idle");
    }
  }, IDLE_TIMEOUT_MS);
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
