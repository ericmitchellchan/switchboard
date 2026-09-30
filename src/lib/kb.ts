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

import { useCallback, useEffect, useState } from "react";
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

/** What a doc path renders as. "markdown" (T6), "wireframe" (T7), "diagram"
 *  (T9) and "view" (SWIT-53, a kept view snapshot) all have real renderers;
 *  "code"/"data"/"unknown" still show DocView's placeholder — the switch is
 *  the stable seam they plug into. */
export type DocKind = "markdown" | "wireframe" | "diagram" | "code" | "data" | "view" | "unknown";

export function docKind(path: string): DocKind {
  const name = path.split("/").pop() ?? "";
  // A kept view's snapshot (SWIT-53): `<id>-<stamp>.view.json`, always
  // exactly that suffix — checked BEFORE the generic extension switch so it
  // never falls into the plain ".json" → "data" case.
  if (/\.view\.json$/i.test(name)) return "view";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  switch (ext) {
    case "md":
      return "markdown";
    case "html":
    case "htm":
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

const docListListeners = new Set<() => void>();

/** Be told when the cached list CHANGES (a new reference — never on an
 *  unchanged refresh). With `getCachedDocList` as the snapshot this is a
 *  `useSyncExternalStore` pair: a page holding the list re-resolves its
 *  addresses the moment a refresh — anyone's — brings a new doc in. */
export function subscribeDocList(listener: () => void): () => void {
  docListListeners.add(listener);
  return () => {
    docListListeners.delete(listener);
  };
}

/** Re-IPC the doc list. Keeps the SAME array reference when the content is
 *  unchanged so setState(prev => …) consumers can no-op by identity. */
export async function refreshDocList(): Promise<string[]> {
  const next = await kbListDocs();
  if (docListCache && sameDocList(docListCache, next)) return docListCache;
  docListCache = next;
  for (const listener of [...docListListeners]) listener();
  return next;
}

/** Test-only: reset the module cache. */
export function __resetKbCacheForTests(): void {
  docListCache = null;
  kbMisses.clear();
  missRefreshQueued = false;
  docListListeners.clear();
}

// ── A KB-list MISS refreshes the list once (SWIT-101) ────────────────────────
// The list above is a cache: it loads once and refreshes on KB-screen
// activation. A doc created mid-session (an agent writes a spec, then points
// at it) is not in it, so `evidenceModel.resolveDocTarget` fell through to
// the repo fallback and the doc opened as a missing repo file. The resolver
// now REPORTS a miss; these are the two things a caller does with one:
//
//   · RENDER (`noteKbMiss`): a page resolves its addresses on every paint, so
//     a miss is REMEMBERED — each address asks for a refresh ONCE, a paint's
//     worth of new misses share ONE `kb_list`, and an address that simply is
//     not a KB doc (every repo path on the page) never asks again. Never a
//     loop: a failed refresh stays remembered too.
//   · ONE-SHOT OPEN (`resolveWithFreshKbDocs`): a click, the turn-end hook,
//     the agent's `show`. The memory above would be wrong here — an address
//     seen BEFORE its file existed is remembered as a miss — so a one-shot
//     that misses refreshes once and resolves again, every time. One
//     `kb_list` per open that missed; an open is an event, not a poll.
//
// A refresh that changes the list notifies `subscribeDocList`, so a row that
// was plain text or a repo link becomes the KB doc without another paint
// asking.

/** Remembered misses are capped; at the cap the memory starts over (each live
 *  address may then ask once more — still bounded, still never per paint). */
export const KB_MISS_CAP = 2000;

const kbMisses = new Set<string>();
let missRefreshQueued = false;

/** The memory rule, pure over the set it is handed: true when this address
 *  has NOT missed before (and records it). */
export function rememberKbMiss(remembered: Set<string>, address: string, cap: number = KB_MISS_CAP): boolean {
  if (remembered.has(address)) return false;
  if (remembered.size >= cap) remembered.clear();
  remembered.add(address);
  return true;
}

/** The render-side sink for `resolveDocTarget`'s `onKbMiss`: a NEW miss asks
 *  for one list refresh, coalesced across the paint that reported it (a
 *  microtask — every miss of one synchronous render lands first). Safe to
 *  call during render: idempotent, and it touches no React state itself. */
export function noteKbMiss(address: string): void {
  if (!rememberKbMiss(kbMisses, address)) return;
  if (missRefreshQueued) return;
  missRefreshQueued = true;
  queueMicrotask(() => {
    missRefreshQueued = false;
    refreshDocList().catch(() => {
      // kb_list failed — the misses stay remembered (no retry loop); any
      // later refresh, or a one-shot open, still brings the list in.
    });
  });
}

/** Run a resolver against the doc list for a ONE-SHOT open. A cold cache is
 *  loaded first; a miss against a list that was already cached refreshes it
 *  ONCE and, when the list actually changed, resolves again. `run` must be
 *  pure over its arguments — it may be called twice. A failed `kb_list`
 *  degrades to the first answer (the repo fallback), never a throw. */
export async function resolveWithFreshKbDocs<T>(
  run: (kbDocs: readonly string[] | null, onKbMiss: (address: string) => void) => T
): Promise<T> {
  let docs = getCachedDocList();
  let justLoaded = false;
  if (docs === null) {
    docs = await refreshDocList().catch(() => null);
    justLoaded = true;
  }
  let missed = false;
  const first = run(docs, (address) => {
    missed = true;
    // The refresh below covers this address — a later paint need not ask.
    rememberKbMiss(kbMisses, address);
  });
  if (!missed || justLoaded) return first;
  const fresh = await refreshDocList().catch(() => null);
  if (fresh === null || fresh === docs) return first;
  return run(fresh, () => {});
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
 *
 * `reload` forces the read NOW (the wireframe toolbar's ⟳). It goes through
 * the SAME effect and the same mergeDocRead fold rather than a second read
 * path, so an unchanged file is still a no-op re-render and a changed one is
 * the identical clean content swap the poll performs.
 */
export function useKbDoc(
  path: string | undefined,
  active: boolean
): KbDocState & { reload: () => void } {
  const [state, setState] = useState<KbDocState>(EMPTY_DOC_STATE);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

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
  }, [path, active, nonce]);

  return { ...state, reload };
}
