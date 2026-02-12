import { useState, useCallback, useMemo } from "react";
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

  const initLayout = useCallback((sessionId: string) => {
    const pane = createSinglePane(sessionId);
    setRoot(pane);
    setFocusedPaneId(pane.id);
  }, []);

  const split = useCallback(
    (direction: "horizontal" | "vertical", newSessionId: string) => {
      if (!root || !focusedPaneId) return null;
      const result = splitPane(root, focusedPaneId, direction, newSessionId);
      setRoot(result.root);
      setFocusedPaneId(result.newPaneId);
      return result.newPaneId;
    },
    [root, focusedPaneId]
  );

  const close = useCallback(
    (paneId: string) => {
      if (!root) return;
      const newRoot = closePane(root, paneId);
      if (newRoot === null) {
        setRoot(null);
        setFocusedPaneId(null);
        return;
      }
      setRoot(newRoot);
      // If we closed the focused pane, focus the first leaf
      if (paneId === focusedPaneId) {
        const leaves = getAllLeafIds(newRoot);
        setFocusedPaneId(leaves[0] || null);
      }
    },
    [root, focusedPaneId]
  );

  const moveFocus = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      if (!root || !focusedPaneId) return;
      const next = findAdjacentPane(root, focusedPaneId, direction);
      if (next) setFocusedPaneId(next);
    },
    [root, focusedPaneId]
  );

  const resize = useCallback(
    (branchId: string, ratio: number) => {
      if (!root) return;
      setRoot(resizeSplit(root, branchId, ratio));
    },
    [root]
  );

  const focusPane = useCallback((paneId: string) => {
    setFocusedPaneId(paneId);
  }, []);

  // Focus a pane by session, or swap focused pane's session
  const focusOrSwapSession = useCallback(
    (sessionId: string) => {
      if (!root) return;
      // If the session is already visible in a pane, just focus that pane
      const existing = findPaneBySessionId(root, sessionId);
      if (existing) {
        setFocusedPaneId(existing.id);
        return;
      }
      // Otherwise swap the focused pane's session
      if (focusedPaneId) {
        setRoot(swapPaneSession(root, focusedPaneId, sessionId));
      }
    },
    [root, focusedPaneId]
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
