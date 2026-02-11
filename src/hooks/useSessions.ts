import { useState, useCallback } from "react";
import type { Session } from "../types";

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const addSession = useCallback((session: Session) => {
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
  }, []);

  const removeSession = useCallback(
    (sessionId: string) => {
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== sessionId);
        // If we removed the active session, switch to the last one
        if (sessionId === activeSessionId && next.length > 0) {
          const removedIndex = prev.findIndex((s) => s.id === sessionId);
          const newIndex = Math.min(removedIndex, next.length - 1);
          setActiveSessionId(next[newIndex].id);
        } else if (next.length === 0) {
          setActiveSessionId(null);
        }
        return next;
      });
    },
    [activeSessionId]
  );

  const updateSessionStatus = useCallback(
    (sessionId: string, status: Session["status"]) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, status } : s))
      );
    },
    []
  );

  const switchToSession = useCallback(
    (sessionId: string) => {
      const exists = sessions.find((s) => s.id === sessionId);
      if (exists) setActiveSessionId(sessionId);
    },
    [sessions]
  );

  const switchByIndex = useCallback(
    (index: number) => {
      if (index >= 0 && index < sessions.length) {
        setActiveSessionId(sessions[index].id);
      }
    },
    [sessions]
  );

  const switchRelative = useCallback(
    (delta: number) => {
      if (sessions.length === 0) return;
      const currentIndex = sessions.findIndex(
        (s) => s.id === activeSessionId
      );
      const nextIndex =
        (currentIndex + delta + sessions.length) % sessions.length;
      setActiveSessionId(sessions[nextIndex].id);
    },
    [sessions, activeSessionId]
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  return {
    sessions,
    activeSessionId,
    activeSession,
    addSession,
    removeSession,
    updateSessionStatus,
    switchToSession,
    switchByIndex,
    switchRelative,
  };
}
