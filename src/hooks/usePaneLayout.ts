import { useState, useCallback, useMemo, useRef } from "react";
import {
  type PaneNode,
  createSinglePane,
  splitPane,
  closePane,
  resizeSplit,
  findLeaf,
  findAdjacentPane,
  getVisibleSessionIds,
  getAllLeafIds,
  findPaneBySessionId,
  swapPaneSession,
} from "../lib/paneLayout";

export function usePaneLayout() {
  const [root, setRoot] = useState<PaneNode | null>(null);
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  const focusedPaneIdRef = useRef<string | null>(null);
  focusedPaneIdRef.current = focusedPaneId;

  const initLayout = useCallback((sessionId: string) => {
    const pane = createSinglePane(sessionId);
    setRoot(pane);
    setFocusedPaneId(pane.id);
    focusedPaneIdRef.current = pane.id;
  }, []);

  const split = useCallback(
    (direction: "horizontal" | "vertical", newSessionId: string) => {
      let newPaneId: string | null = null;
      setRoot((prevRoot) => {
        const fpId = focusedPaneIdRef.current;
        if (!prevRoot || !fpId) return prevRoot;
        const result = splitPane(prevRoot, fpId, direction, newSessionId);
        newPaneId = result.newPaneId;
        setFocusedPaneId(result.newPaneId);
        focusedPaneIdRef.current = result.newPaneId;
        return result.root;
      });
      return newPaneId;
    },
    []
  );

  const close = useCallback(
    (paneId: string) => {
      setRoot((prevRoot) => {
        if (!prevRoot) return prevRoot;
        const newRoot = closePane(prevRoot, paneId);
        if (newRoot === null) {
          setFocusedPaneId(null);
          focusedPaneIdRef.current = null;
          return null;
        }
        // If we closed the focused pane, focus the first leaf
        if (paneId === focusedPaneIdRef.current) {
          const leaves = getAllLeafIds(newRoot);
          const next = leaves[0] || null;
          setFocusedPaneId(next);
          focusedPaneIdRef.current = next;
        }
        return newRoot;
      });
    },
    []
  );

  const moveFocus = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      setRoot((prevRoot) => {
        const fpId = focusedPaneIdRef.current;
        if (!prevRoot || !fpId) return prevRoot;
        const next = findAdjacentPane(prevRoot, fpId, direction);
        if (next) {
          setFocusedPaneId(next);
          focusedPaneIdRef.current = next;
        }
        return prevRoot; // root unchanged
      });
    },
    []
  );

  const resize = useCallback(
    (branchId: string, ratio: number) => {
      setRoot((prevRoot) => {
        if (!prevRoot) return prevRoot;
        return resizeSplit(prevRoot, branchId, ratio);
      });
    },
    []
  );

  const focusPane = useCallback((paneId: string) => {
    setFocusedPaneId(paneId);
    focusedPaneIdRef.current = paneId;
  }, []);

  // Focus a pane by session, or swap focused pane's session
  const focusOrSwapSession = useCallback(
    (sessionId: string) => {
      setRoot((prevRoot) => {
        if (!prevRoot) return prevRoot;
        // If the session is already visible in a pane, just focus that pane
        const existing = findPaneBySessionId(prevRoot, sessionId);
        if (existing) {
          setFocusedPaneId(existing.id);
          focusedPaneIdRef.current = existing.id;
          return prevRoot; // root unchanged
        }
        // Otherwise swap the focused pane's session
        const fpId = focusedPaneIdRef.current;
        if (fpId) {
          return swapPaneSession(prevRoot, fpId, sessionId);
        }
        return prevRoot;
      });
    },
    []
  );

  const visibleSessionIds = useMemo(
    () => (root ? getVisibleSessionIds(root) : []),
    [root]
  );

  const focusedSessionId = useMemo(() => {
    if (!root || !focusedPaneId) return null;
    const leaf = findLeaf(root, focusedPaneId);
    return leaf?.sessionId ?? null;
  }, [root, focusedPaneId]);

  const isSplit = useMemo(
    () => root?.type === "branch",
    [root]
  );

  return {
    root,
    focusedPaneId,
    focusedSessionId,
    visibleSessionIds,
    isSplit,
    initLayout,
    split,
    close,
    moveFocus,
    resize,
    focusPane,
    focusOrSwapSession,
    setRoot,
  };
}
