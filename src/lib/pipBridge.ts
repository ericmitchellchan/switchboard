import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";

export type PipReadyPayload = {
  sessionId: string;
};

// All PTY content destined for PiP flows through a single channel so the
// snapshot and subsequent live chunks have a strict order. Main owns sequencing
// (PiP cannot receive live chunks before the snapshot lands) so PiP and main
// stay byte-identical — the only way absolute cursor-positioning sequences
// from PSReadLine / TUI redraws land at the same row in both views.
export type PipOutputPayload =
  | {
      type: "snapshot";
      text: string;
      // Main's terminal dimensions at snapshot time. PiP resizes its xterm to
      // match before writing the snapshot so wrapping is identical and live
      // PTY positioning sequences map to the same coordinates here as in main.
      cols: number;
      rows: number;
    }
  | { type: "pty"; data: string };

// PiP-side: signal main that the PiP window is mounted and ready for handoff.
export async function notifyPipReady(sessionId: string): Promise<void> {
  await emit("pip:ready", { sessionId });
}

// PiP-side: subscribe to the unified output channel from main.
export function onPipOutput(
  sessionId: string,
  callback: (payload: PipOutputPayload) => void
): Promise<UnlistenFn> {
  return listen<PipOutputPayload>(`pip:output:${sessionId}`, (event) => callback(event.payload));
}

// Main-side: listen for the PiP window signaling it's ready.
export function onPipReady(
  callback: (payload: PipReadyPayload) => void
): Promise<UnlistenFn> {
  return listen<PipReadyPayload>("pip:ready", (event) => callback(event.payload));
}

// Main-side: forward a payload (snapshot or live pty chunk) to PiP.
export async function sendPipOutput(sessionId: string, payload: PipOutputPayload): Promise<void> {
  await emit(`pip:output:${sessionId}`, payload);
}

// Minimal session info that PiP's tab strip needs — the full Session type lives
// in main and contains things (repo, working dir, dirty flag) PiP doesn't render.
export type PipSessionInfo = {
  id: string;
  name: string;
  status: string;
};

// PiP-side: ask main to switch the active session. Main re-wires its router
// for the new session and emits a fresh snapshot via pip:output.
export async function notifyPipSwitchSession(sessionId: string): Promise<void> {
  await emit("pip:switch-session", { sessionId });
}

// Main-side: listen for PiP requesting a session switch.
export function onPipSwitchSession(
  callback: (payload: { sessionId: string }) => void
): Promise<UnlistenFn> {
  return listen<{ sessionId: string }>("pip:switch-session", (e) => callback(e.payload));
}

// Main-side: broadcast the session list so PiP's tab strip stays in sync.
export async function broadcastPipSessions(sessions: PipSessionInfo[]): Promise<void> {
  await emit("pip:sessions", sessions);
}

// PiP-side: subscribe to session list updates from main.
export function onPipSessions(
  callback: (sessions: PipSessionInfo[]) => void
): Promise<UnlistenFn> {
  return listen<PipSessionInfo[]>("pip:sessions", (e) => callback(e.payload));
}

// PiP-side: announce that the floating window is closing so main can tear
// down its router and clear pipSessionId. PiP follows up with closePipWindow.
export async function notifyPipClosing(): Promise<void> {
  await emit("pip:closing");
}

// Main-side: listen for PiP shutting down (via the in-window X button).
export function onPipClosing(callback: () => void): Promise<UnlistenFn> {
  return listen("pip:closing", () => callback());
}
