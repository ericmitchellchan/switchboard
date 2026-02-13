export interface PaneLeaf {
  type: "leaf";
  id: string;
  sessionId: string;
}

export interface PaneBranch {
  type: "branch";
  id: string;
  direction: "horizontal" | "vertical"; // horizontal = side-by-side, vertical = stacked
  ratio: number; // 0-1, proportion of first child
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneBranch;

let paneIdCounter = 0;

export function setPaneIdCounter(n: number): void {
  paneIdCounter = n;
}

function nextPaneId(): string {
  return `pane-${++paneIdCounter}`;
}

export function createSinglePane(sessionId: string): PaneLeaf {
  return { type: "leaf", id: nextPaneId(), sessionId };
}

export function splitPane(
  root: PaneNode,
  targetPaneId: string,
  direction: "horizontal" | "vertical",
  newSessionId: string
): { root: PaneNode; newPaneId: string } {
  const newPaneId = nextPaneId();
  const newRoot = mapNode(root, (node) => {
    if (node.type === "leaf" && node.id === targetPaneId) {
      const branch: PaneBranch = {
        type: "branch",
        id: nextPaneId(),
        direction,
        ratio: 0.5,
        first: node,
        second: { type: "leaf", id: newPaneId, sessionId: newSessionId },
      };
      return branch;
    }
    return node;
  });
  return { root: newRoot, newPaneId };
}

export function closePane(
  root: PaneNode,
  targetPaneId: string
): PaneNode | null {
  if (root.type === "leaf") {
    return root.id === targetPaneId ? null : root;
  }

  // If one of the direct children is the target, return the other
  if (root.first.type === "leaf" && root.first.id === targetPaneId) {
    return root.second;
  }
  if (root.second.type === "leaf" && root.second.id === targetPaneId) {
    return root.first;
  }

  // Recurse
  const newFirst = closePane(root.first, targetPaneId);
  const newSecond = closePane(root.second, targetPaneId);

  if (newFirst === null) return newSecond;
  if (newSecond === null) return newFirst;

  if (newFirst === root.first && newSecond === root.second) return root;
  return { ...root, first: newFirst, second: newSecond };
}

export function resizeSplit(
  root: PaneNode,
  branchId: string,
  newRatio: number
): PaneNode {
  return mapNode(root, (node) => {
    if (node.type === "branch" && node.id === branchId) {
      return { ...node, ratio: Math.max(0.15, Math.min(0.85, newRatio)) };
    }
    return node;
  });
}

export function findLeaf(root: PaneNode, paneId: string): PaneLeaf | null {
  if (root.type === "leaf") {
    return root.id === paneId ? root : null;
  }
  return findLeaf(root.first, paneId) || findLeaf(root.second, paneId);
}

export function getVisibleSessionIds(root: PaneNode): string[] {
  if (root.type === "leaf") return [root.sessionId];
  return [
    ...getVisibleSessionIds(root.first),
    ...getVisibleSessionIds(root.second),
  ];
}

export function getAllLeafIds(root: PaneNode): string[] {
  if (root.type === "leaf") return [root.id];
  return [...getAllLeafIds(root.first), ...getAllLeafIds(root.second)];
}

export function findPaneBySessionId(root: PaneNode, sessionId: string): PaneLeaf | null {
  if (root.type === "leaf") {
    return root.sessionId === sessionId ? root : null;
  }
  return findPaneBySessionId(root.first, sessionId) || findPaneBySessionId(root.second, sessionId);
}

export function swapPaneSession(root: PaneNode, paneId: string, newSessionId: string): PaneNode {
  return mapNode(root, (node) => {
    if (node.type === "leaf" && node.id === paneId) {
      return { ...node, sessionId: newSessionId };
    }
    return node;
  });
}

// Directional navigation
export function findAdjacentPane(
  root: PaneNode,
  currentPaneId: string,
  direction: "up" | "down" | "left" | "right"
): string | null {
  const leaves = getAllLeavesWithPath(root);
  const current = leaves.find((l) => l.leaf.id === currentPaneId);
  if (!current) return null;

  // Simple strategy: find the nearest leaf in the requested direction
  // based on the binary tree structure
  const allLeafIds = getAllLeafIds(root);
  const currentIdx = allLeafIds.indexOf(currentPaneId);
  if (currentIdx === -1) return null;

  switch (direction) {
    case "left":
    case "up":
      return currentIdx > 0 ? allLeafIds[currentIdx - 1] : null;
    case "right":
    case "down":
      return currentIdx < allLeafIds.length - 1 ? allLeafIds[currentIdx + 1] : null;
  }
}

interface LeafWithPath {
  leaf: PaneLeaf;
  path: string[];
}

function getAllLeavesWithPath(node: PaneNode, path: string[] = []): LeafWithPath[] {
  if (node.type === "leaf") return [{ leaf: node, path }];
  return [
    ...getAllLeavesWithPath(node.first, [...path, "first"]),
    ...getAllLeavesWithPath(node.second, [...path, "second"]),
  ];
}

export function remapSessionIds(root: PaneNode, idMap: Map<string, string>): PaneNode {
  return mapNode(root, (node) => {
    if (node.type === "leaf") {
      const newId = idMap.get(node.sessionId);
      if (newId) return { ...node, sessionId: newId };
    }
    return node;
  });
}

export function getMaxPaneIdNumber(root: PaneNode): number {
  let max = 0;
  const walk = (node: PaneNode) => {
    const match = node.id.match(/^pane-(\d+)$/);
    if (match) max = Math.max(max, parseInt(match[1], 10));
    if (node.type === "branch") {
      walk(node.first);
      walk(node.second);
    }
  };
  walk(root);
  return max;
}

// Generic tree mapper — applies fn bottom-up
function mapNode(node: PaneNode, fn: (node: PaneNode) => PaneNode): PaneNode {
  if (node.type === "leaf") return fn(node);
  const first = mapNode(node.first, fn);
  const second = mapNode(node.second, fn);
  const updated = first === node.first && second === node.second
    ? node
    : { ...node, first, second };
  return fn(updated);
}
