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
  const rootRef = useRef<PaneNode | null>(null);
  rootRef.current = root;

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
        return result.root;
      });
      if (newPaneId) {
        setFocusedPaneId(newPaneId);
        focusedPaneIdRef.current = newPaneId;
      }
      return newPaneId;
    },
    []
  );

  const close = useCallback(
    (paneId: string) => {
      let newFocusId: string | null | undefined = undefined;
      setRoot((prevRoot) => {
        if (!prevRoot) return prevRoot;
        const newRoot = closePane(prevRoot, paneId);
        if (newRoot === null) {
          newFocusId = null;
          return null;
        }
        if (paneId === focusedPaneIdRef.current) {
          const leaves = getAllLeafIds(newRoot);
          newFocusId = leaves[0] || null;
        }
        return newRoot;
      });
      if (newFocusId !== undefined) {
        setFocusedPaneId(newFocusId);
        focusedPaneIdRef.current = newFocusId;
      }
    },
    []
  );

  const moveFocus = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      const currentRoot = rootRef.current;
      const fpId = focusedPaneIdRef.current;
      if (!currentRoot || !fpId) return;
      const next = findAdjacentPane(currentRoot, fpId, direction);
      if (next) {
        setFocusedPaneId(next);
        focusedPaneIdRef.current = next;
      }
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

  const focusOrSwapSession = useCallback(
    (sessionId: string) => {
      const currentRoot = rootRef.current;
      if (!currentRoot) return;
      const existing = findPaneBySessionId(currentRoot, sessionId);
      if (existing) {
        setFocusedPaneId(existing.id);
        focusedPaneIdRef.current = existing.id;
        return;
      }
      const fpId = focusedPaneIdRef.current;
      if (fpId) {
        setRoot((prevRoot) => prevRoot ? swapPaneSession(prevRoot, fpId, sessionId) : prevRoot);
      }
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
