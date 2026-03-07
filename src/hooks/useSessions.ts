import { useState, useCallback, useRef } from "react";
import type { Session } from "../types";

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeIdRef = useRef(activeSessionId);
  activeIdRef.current = activeSessionId;

  const addSession = useCallback((session: Session) => {
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
  }, []);

  const removeSession = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== sessionId);
      if (sessionId === activeIdRef.current && next.length > 0) {
        const removedIndex = prev.findIndex((s) => s.id === sessionId);
        const newIndex = Math.min(removedIndex, next.length - 1);
        setActiveSessionId(next[newIndex].id);
      } else if (next.length === 0) {
        setActiveSessionId(null);
      }
      return next;
    });
  }, []);

  const renameSession = useCallback(
    (sessionId: string, newName: string) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, name: newName } : s))
      );
    },
    []
  );

  const updateSessionStatus = useCallback(
    (sessionId: string, status: Session["status"]) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, status } : s))
      );
    },
    []
  );

  const switchToSession = useCallback((sessionId: string) => {
    const exists = sessionsRef.current.find((s) => s.id === sessionId);
    if (exists) setActiveSessionId(sessionId);
  }, []);

  const switchByIndex = useCallback((index: number) => {
    const s = sessionsRef.current;
    if (index >= 0 && index < s.length) {
      setActiveSessionId(s[index].id);
    }
  }, []);

  const switchRelative = useCallback((delta: number) => {
    const s = sessionsRef.current;
    if (s.length === 0) return;
    const currentIndex = s.findIndex((x) => x.id === activeIdRef.current);
    const nextIndex = (currentIndex + delta + s.length) % s.length;
    setActiveSessionId(s[nextIndex].id);
  }, []);

  const moveSession = useCallback((sessionId: string, direction: -1 | 1) => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === sessionId);
      if (idx < 0) return prev;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return next;
    });
  }, []);

  const reorderSession = useCallback((sessionId: string, newIndex: number) => {
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === sessionId);
      if (idx < 0 || idx === newIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      next.splice(newIndex, 0, moved);
      return next;
    });
  }, []);

  const bulkSetSessions = useCallback(
    (newSessions: Session[], activeId: string | null) => {
      setSessions(newSessions);
      setActiveSessionId(activeId);
    },
    []
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const waitingCount = sessions.filter((s) => s.status === "waiting").length;

  return {
    sessions,
    activeSessionId,
    activeSession,
    waitingCount,
    addSession,
    removeSession,
    renameSession,
    updateSessionStatus,
    switchToSession,
    switchByIndex,
    switchRelative,
    moveSession,
    reorderSession,
    bulkSetSessions,
  };
}
