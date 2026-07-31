// Knowledge Base data layer (T6) — tree building, doc-list cache, doc polling.
//
// Structure mirrors the repo's other lib modules: PURE, unit-tested logic
// (buildKbTree / sameDocList / mergeDocRead / docKind) up top, module-level
// cache + React hooks below. The hooks are thin shells over the pure parts.
//
// Cache: the doc list lives in a module-level variable so param-driven
// remounts of the KB screen (and the keep-alive hide/show cycle) render the
// last known list synchronously instead of flashing empty and re-IPCing.
//
// Poll: only the OPEN doc is re-read, every KB_POLL_MS, and ONLY while the
// screen is visible — T4's keep-alive keeps hidden screens mounted, so the
// hook takes an `active` flag from App (which owns the route) instead of
// guessing from DOM visibility. State is swapped only when content actually
// differs (mergeDocRead returns the previous object reference otherwise), so
// a poll tick never causes a re-render, flicker, or scroll reset. The doc
// LIST refreshes on screen re-activation, not on the poll.

import { useEffect, useState } from "react";
import { kbListDocs, kbReadDoc } from "./ipc";

/** Open-doc re-read interval while the KB screen is visible. */
export const KB_POLL_MS = 2500;

// ── Tree building (pure) ─────────────────────────────────────────────────────

export interface KbDocNode {
  type: "doc";
  /** Last path segment (file name). */
  name: string;
  /** Full relative path — the id used for selection/navigation/read. */
  path: string;
}

export interface KbFolderNode {
  type: "folder";
  name: string;
  path: string;
  children: KbNode[];
}

export type KbNode = KbDocNode | KbFolderNode;

/**
 * Group a flat, forward-slash relative path list into a nested tree.
 * Top-level segments are the KB's project folders; deeper segments nest.
 * Pure: no IPC, no globals. Each level is sorted folders-first, then
 * alphabetically. `_`/`.`-prefixed segments are already filtered server-side
 * but are re-filtered here defensively (stale cache, future backend drift).
 */
export function buildKbTree(paths: readonly string[]): KbNode[] {
  const rootChildren: KbNode[] = [];
  const folderIndex = new Map<string, KbFolderNode>();
  const seenDocs = new Set<string>();

  const childrenForFolder = (segments: string[]): KbNode[] => {
    let children = rootChildren;
    let pathSoFar = "";
    for (const seg of segments) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${seg}` : seg;
      let folder = folderIndex.get(pathSoFar);
      if (!folder) {
        folder = { type: "folder", name: seg, path: pathSoFar, children: [] };
        folderIndex.set(pathSoFar, folder);
        children.push(folder);
      }
      children = folder.children;
    }
    return children;
  };

  for (const raw of paths) {
    const segments = raw.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    if (segments.some((s) => s.startsWith("_") || s.startsWith("."))) continue;
    const path = segments.join("/");
    if (seenDocs.has(path)) continue;
    seenDocs.add(path);
    childrenForFolder(segments.slice(0, -1)).push({
      type: "doc",
      name: segments[segments.length - 1],
      path,
    });
  }

  sortTree(rootChildren);
  return rootChildren;
}

function sortTree(nodes: KbNode[]): void {
  nodes.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1
  );
  for (const node of nodes) {
    if (node.type === "folder") sortTree(node.children);
  }
}

/** Folder paths that must be expanded for `docPath` to be visible. */
export function ancestorFolders(docPath: string): string[] {
  const segments = docPath.split("/").filter((s) => s.length > 0);
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    out.push(segments.slice(0, i).join("/"));
  }
  return out;
}

// ── Doc kind (extension switch, pure) ────────────────────────────────────────

/** What a doc path renders as. Only "markdown" renders in T6; "wireframe"
 *  (T7) and "diagram"/"code"/"data" (T7/T9) show placeholders until their
 *  tasks land — the switch itself is the stable seam they plug into. */
export type DocKind = "markdown" | "wireframe" | "diagram" | "code" | "data" | "unknown";

export function docKind(path: string): DocKind {
  const name = path.split("/").pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  switch (ext) {
    case "md":
      return "markdown";
    case "html":
      return "wireframe";
    case "mmd":
      return "diagram";
    case "jsx":
    case "tsx":
      return "code";
    case "json":
      return "data";
    default:
      return "unknown";
  }
}

// ── Doc-list cache (module-level) ────────────────────────────────────────────

let docListCache: string[] | null = null;

/** Order-sensitive equality — the backend returns a sorted list, so index
 *  compare is exact. Pure. */
export function sameDocList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function getCachedDocList(): string[] | null {
  return docListCache;
}

/** Re-IPC the doc list. Keeps the SAME array reference when the content is
 *  unchanged so setState(prev => …) consumers can no-op by identity. */
export async function refreshDocList(): Promise<string[]> {
  const next = await kbListDocs();
  if (docListCache && sameDocList(docListCache, next)) return docListCache;
  docListCache = next;
  return next;
}

/** Test-only: reset the module cache. */
export function __resetKbCacheForTests(): void {
  docListCache = null;
}

// ── Poll differ (pure core of useKbDoc) ──────────────────────────────────────

export interface KbDocState {
  /** Path the content/error belong to; null before any read. */
  path: string | null;
  content: string | null;
  error: string | null;
}

export const EMPTY_DOC_STATE: KbDocState = { path: null, content: null, error: null };

export type KbReadResult = { ok: true; content: string } | { ok: false; error: string };

/**
 * Fold one read result into the previous state. Returns the PREVIOUS OBJECT
 * (identity-equal) when nothing changed, which is what makes the 2.5s poll
 * flicker-free: React bails out of the re-render entirely. On a read error
 * the last good content of the SAME doc is kept (a poll racing an editor's
 * atomic save must not blank the view) with the error surfaced alongside.
 */
export function mergeDocRead(prev: KbDocState, path: string, result: KbReadResult): KbDocState {
  if (result.ok) {
    if (prev.path === path && prev.content === result.content && prev.error === null) {
      return prev;
    }
    return { path, content: result.content, error: null };
  }
  const content = prev.path === path ? prev.content : null;
  if (prev.path === path && prev.error === result.error && prev.content === content) {
    return prev;
  }
  return { path, content, error: result.error };
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/**
 * The KB doc list. Initial state comes synchronously from the module cache
 * (no flash on remount); a background refresh runs on every screen
 * ACTIVATION (`active` flipping true — including the first), never on the
 * poll cadence. When the refreshed list is unchanged, refreshDocList returns
 * the cached reference and the setState below no-ops by identity.
 */
export function useKbDocList(active: boolean): { docs: string[] | null; error: string | null } {
  const [docs, setDocs] = useState<string[] | null>(getCachedDocList);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    refreshDocList()
      .then((list) => {
        if (cancelled) return;
        setDocs((prev) => (prev === list ? prev : list));
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return { docs, error };
}

/**
 * The open doc's content, kept fresh by a KB_POLL_MS re-read while `active`.
 * Hidden screens (keep-alive display:none) read once on mount/path-change so
 * a deep-linked doc is ready when the screen first shows, but never poll.
 * mergeDocRead guarantees state identity is preserved on unchanged content —
 * no re-render, no innerHTML swap, no scroll reset.
 */
export function useKbDoc(path: string | undefined, active: boolean): KbDocState {
  const [state, setState] = useState<KbDocState>(EMPTY_DOC_STATE);

  useEffect(() => {
    if (!path) {
      setState(EMPTY_DOC_STATE);
      return;
    }
    let cancelled = false;
    const read = async () => {
      let result: KbReadResult;
      try {
        result = { ok: true, content: await kbReadDoc(path) };
      } catch (e) {
        result = { ok: false, error: String(e) };
      }
      if (cancelled) return;
      setState((prev) => mergeDocRead(prev, path, result));
    };
    void read();
    if (!active) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(() => void read(), KB_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [path, active]);

  return state;
}
