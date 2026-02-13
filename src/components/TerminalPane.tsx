import { useEffect, useRef, useCallback } from "react";
import type { Session, AgentStatus } from "../types";
import {
  createTerminal,
  attachToDOM,
  detachFromDOM,
  fitTerminal,
  getTerminal,
  writeRestoreContent,
} from "../lib/terminal";
import {
  writeToSession,
  resizeSession,
  onSessionOutput,
  onSessionExited,
  loadScrollback,
} from "../lib/ipc";
import {
  initDetector,
  processOutput,
  markExited,
  clearWaiting,
} from "../lib/statusDetector";
import { SearchBar } from "./SearchBar";

// Module-level map for event listener cleanup functions
const listenerCleanups = new Map<string, (() => void)[]>();

// Reusable UTF-8 decoder (avoids per-chunk allocation)
const utf8Decoder = new TextDecoder();

export function cleanupSessionListeners(sessionId: string) {
  const fns = listenerCleanups.get(sessionId);
  if (fns) {
    fns.forEach((fn) => fn());
    listenerCleanups.delete(sessionId);
  }
}

interface TerminalPaneProps {
  session: Session;
  searchOpen?: boolean;
  onCloseSearch?: () => void;
  onExited: (sessionId: string) => void;
  onStatusChange: (sessionId: string, status: AgentStatus) => void;
  onAutoTask?: (task: { text: string; fingerprint: string; priority: "high" | "med" | "low"; category: string }, sessionId: string) => void;
  onResolveTask?: (fingerprintPrefix: string) => void;
  isFocused?: boolean;
}

export function TerminalPane({
  session,
  searchOpen,
  onCloseSearch,
  onExited,
  onStatusChange,
  onAutoTask,
  onResolveTask,
  isFocused = true,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const setupDone = useRef(new Set<string>());
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;
  const onAutoTaskRef = useRef(onAutoTask);
  onAutoTaskRef.current = onAutoTask;
  const onResolveTaskRef = useRef(onResolveTask);
  onResolveTaskRef.current = onResolveTask;

  // Set up terminal data wiring (once per session)
  const wireSession = useCallback((sessionId: string, restoredFromId?: string) => {
    if (setupDone.current.has(sessionId)) return;
    setupDone.current.add(sessionId);

    const instance = getTerminal(sessionId);
    if (!instance) return;

    // Init status detector
    initDetector(sessionId);

    // User input -> PTY
    instance.terminal.onData((data: string) => {
      clearWaiting(sessionId);
      writeToSession(sessionId, data).catch(console.error);
    });

    // Helper to store unlisten functions
    const pushCleanup = (unlisten: () => void) => {
      const arr = listenerCleanups.get(sessionId) ?? [];
      arr.push(unlisten);
      listenerCleanups.set(sessionId, arr);
    };

    // PTY output -> terminal + status detector + task detector
    onSessionOutput(sessionId, (b64data: string) => {
      try {
        const binaryStr = atob(b64data);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        instance.terminal.write(bytes);

        // Decode as UTF-8 for text-based detection (regex needs proper unicode)
        const text = utf8Decoder.decode(bytes);
        processOutput(sessionId, text, onStatusChangeRef.current);

        // Task detection (lazy import to avoid circular deps)
        if (onAutoTaskRef.current || onResolveTaskRef.current) {
          import("../lib/taskDetector").then(({ detectTasks, detectResolutions }) => {
            if (onAutoTaskRef.current) {
              const detected = detectTasks(sessionId, text);
              for (const task of detected) {
                onAutoTaskRef.current!(task, sessionId);
              }
            }
            if (onResolveTaskRef.current) {
              const resolved = detectResolutions(sessionId, text);
              for (const prefix of resolved) {
                onResolveTaskRef.current!(prefix);
              }
            }
          });
        }
      } catch {
        // ignore decode errors
      }
    }).then(pushCleanup);

    // Session exit
    onSessionExited(sessionId, () => {
      instance.terminal.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      markExited(sessionId, onStatusChangeRef.current);
      onExitedRef.current(sessionId);
    }).then(pushCleanup);

    // Resize -> PTY
    instance.terminal.onResize(({ cols, rows }) => {
      resizeSession(sessionId, cols, rows).catch(console.error);
    });

    // Restore scrollback for sessions restored from a saved workspace (once, gated by setupDone)
    if (restoredFromId) {
      loadScrollback(restoredFromId).then((content) => {
        if (content) writeRestoreContent(sessionId, content);
      }).catch(() => {});
    }
  }, []);

  // Attach/detach terminal when session changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const sessionId = session.id;

    // Create terminal if it doesn't exist
    createTerminal(sessionId);
    wireSession(sessionId, session.restoredFromId);

    // Attach to DOM
    attachToDOM(sessionId, container);

    // Do an initial resize to sync terminal size with PTY
    requestAnimationFrame(() => {
      const dims = fitTerminal(sessionId);
      if (dims) {
        resizeSession(sessionId, dims.cols, dims.rows).catch(console.error);
      }
      // Ensure viewport is at the bottom after reattach
      const inst = getTerminal(sessionId);
      if (inst) inst.terminal.scrollToBottom();
    });

    return () => {
      detachFromDOM(sessionId);
    };
  }, [session.id, wireSession]);

  // Handle window resize
  useEffect(() => {
    let mounted = true;

    const handleResize = () => {
      if (!mounted) return;
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
      mounted = false;
      window.removeEventListener("resize", handleResize);
      if (ro) ro.disconnect();
    };
  }, [session.id]);

  // Focus management for split panes
  useEffect(() => {
    if (!isFocused) return;
    const instance = getTerminal(session.id);
    if (instance) {
      instance.terminal.focus();
    }
  }, [isFocused, session.id]);

  // Close search refocuses terminal
  const handleCloseSearch = useCallback(() => {
    onCloseSearch?.();
    const instance = getTerminal(session.id);
    if (instance) {
      instance.terminal.focus();
    }
  }, [session.id, onCloseSearch]);

  const searchAddon = getTerminal(session.id)?.searchAddon;

  return (
    <div
      style={{
        flex: 1,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {searchOpen && searchAddon && (
        <SearchBar searchAddon={searchAddon} onClose={handleCloseSearch} />
      )}
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
          backgroundColor: "#0C0C0E",
          overflow: "hidden",
        }}
      />
    </div>
  );
}
