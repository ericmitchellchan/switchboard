import { useEffect, useRef, useCallback } from "react";
import type { Session, AgentStatus } from "../types";
import {
  createTerminal,
  attachToDOM,
  detachFromDOM,
  fitTerminal,
  getTerminal,
} from "../lib/terminal";
import {
  writeToSession,
  resizeSession,
  onSessionOutput,
  onSessionExited,
} from "../lib/ipc";
import {
  initDetector,
  processOutput,
  markExited,
} from "../lib/statusDetector";

interface TerminalPaneProps {
  session: Session;
  onExited: (sessionId: string) => void;
  onStatusChange: (sessionId: string, status: AgentStatus) => void;
}

export function TerminalPane({
  session,
  onExited,
  onStatusChange,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const setupDone = useRef(new Set<string>());
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  // Set up terminal data wiring (once per session)
  const wireSession = useCallback((sessionId: string) => {
    if (setupDone.current.has(sessionId)) return;
    setupDone.current.add(sessionId);

    const instance = getTerminal(sessionId);
    if (!instance) return;

    // Init status detector
    initDetector(sessionId);

    // User input -> PTY
    instance.terminal.onData((data: string) => {
      writeToSession(sessionId, data).catch(console.error);
    });

    // PTY output -> terminal + status detector
    onSessionOutput(sessionId, (b64data: string) => {
      try {
        const bytes = atob(b64data);
        instance.terminal.write(bytes);
        processOutput(sessionId, bytes, onStatusChangeRef.current);
      } catch {
        // ignore decode errors
      }
    });

    // Session exit
    onSessionExited(sessionId, () => {
      instance.terminal.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      markExited(sessionId, onStatusChangeRef.current);
      onExitedRef.current(sessionId);
    });

    // Resize -> PTY
    instance.terminal.onResize(({ cols, rows }) => {
      resizeSession(sessionId, cols, rows).catch(console.error);
    });
  }, []);

  // Attach/detach terminal when session changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const sessionId = session.id;

    // Create terminal if it doesn't exist
    createTerminal(sessionId);
    wireSession(sessionId);

    // Attach to DOM
    attachToDOM(sessionId, container);

    // Do an initial resize to sync terminal size with PTY
    requestAnimationFrame(() => {
      const dims = fitTerminal(sessionId);
      if (dims) {
        resizeSession(sessionId, dims.cols, dims.rows).catch(console.error);
      }
    });

    return () => {
      detachFromDOM(sessionId);
    };
  }, [session.id, wireSession]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      const dims = fitTerminal(session.id);
      if (dims) {
        resizeSession(session.id, dims.cols, dims.rows).catch(console.error);
      }
    };

    window.addEventListener("resize", handleResize);

    // Also observe container size changes
    const container = containerRef.current;
    let ro: ResizeObserver | null = null;
    if (container) {
      ro = new ResizeObserver(handleResize);
      ro.observe(container);
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      if (ro) ro.disconnect();
    };
  }, [session.id]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        backgroundColor: "#0C0C0E",
        overflow: "hidden",
      }}
    />
  );
}
