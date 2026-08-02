import { useState, useCallback, useRef } from "react";
import type { Session } from "../types";
import { log } from "../lib/logger";

/**
 * @param isSelectable Can this session be the ACTIVE tab? Increment H: a panel
 *   terminal is a real session that is deliberately absent from the tab bar and
 *   the pane tree (panelStore.isPanelOwnedSession), so every "which tab now?"
 *   decision here — Ctrl+1…9, Ctrl+[ / ], and the next tab after a close — must
 *   step OVER it. Without this, those chords could hand focus to a session with
 *   nothing on screen and blank the workspace. Omitted = every session counts,
 *   which is the pre-increment-H behaviour exactly.
 */
export function useSessions(isSelectable?: (session: Session) => boolean) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeIdRef = useRef(activeSessionId);
  activeIdRef.current = activeSessionId;
  // A ref, not a dep: the predicate reads a module store that is current the
  // instant it mutates, and every callback below must see the latest one
  // without being re-created (they are handed to useKeyboardShortcuts).
  const selectableRef = useRef(isSelectable);
  selectableRef.current = isSelectable;
  const selectableList = useCallback(
    (list: Session[]) => (selectableRef.current ? list.filter(selectableRef.current) : list),
    []
  );

  const addSession = useCallback((session: Session) => {
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
  }, []);

  const removeSession = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== sessionId);
      if (sessionId === activeIdRef.current && next.length > 0) {
        // The next tab is chosen from the SELECTABLE list (see the hook doc):
        // landing on a panel terminal would show an empty workspace.
        const pickable = selectableList(next);
        const removedIndex = selectableList(prev).findIndex((s) => s.id === sessionId);
        if (pickable.length > 0) {
          const newIndex = Math.min(Math.max(0, removedIndex), pickable.length - 1);
          setActiveSessionId(pickable[newIndex].id);
        } else {
          setActiveSessionId(null);
        }
      } else if (next.length === 0) {
        setActiveSessionId(null);
      }
      return next;
    });
  }, [selectableList]);

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
      setSessions((prev) => {
        const target = prev.find((s) => s.id === sessionId);
        if (!target || target.status === status) return prev; // no-op: skip re-render
        log.debug(`Session status id=${sessionId}: ${target.status} → ${status}`);
        return prev.map((s) => (s.id === sessionId ? { ...s, status } : s));
      });
    },
    []
  );

  const switchToSession = useCallback((sessionId: string) => {
    const exists = sessionsRef.current.find((s) => s.id === sessionId);
    // Selectable, not merely existing: a panel terminal is a session, but
    // making it the active TAB would leave the workspace showing nothing.
    // (`promote to tab` releases panel ownership BEFORE calling this, so the
    // promoted session is selectable by the time it gets here.)
    if (exists && (!selectableRef.current || selectableRef.current(exists))) {
      setActiveSessionId(sessionId);
    }
  }, []);

  const switchByIndex = useCallback((index: number) => {
    // Ctrl+1…9 counts the TABS the user can see, not the raw session array.
    const s = selectableList(sessionsRef.current);
    if (index >= 0 && index < s.length) {
      setActiveSessionId(s[index].id);
    }
  }, [selectableList]);

  const switchRelative = useCallback((delta: number) => {
    const s = selectableList(sessionsRef.current);
    if (s.length === 0) return;
    const currentIndex = s.findIndex((x) => x.id === activeIdRef.current);
    const nextIndex = (currentIndex + delta + s.length) % s.length;
    setActiveSessionId(s[nextIndex].id);
  }, [selectableList]);

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
