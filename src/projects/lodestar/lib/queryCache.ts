/**
 * A tiny stale-while-revalidate cache shared across the whole renderer.
 *
 * Why this exists (owner-reported 2026-08-02: "every time I move away from the
 * screen and click a different tab, it refreshes the platform so we have to
 * start loading again"): every surface used to fetch on mount into its own
 * `useState`. React Router UNMOUNTS a page on navigation, so that state died
 * every time and coming back was always a cold start — blank pane, spinner,
 * full refetch. On the sports dashboard that meant re-paying the whole build
 * for the crime of looking at another tab (that build was 32s at the time; the
 * LATERAL rewrite in dashboards.py has since cut it to ~1s).
 *
 * The cache lives at MODULE scope, so it outlives every component and every
 * route change for the life of the window. Returning to a page paints the last
 * known value on the FIRST frame and revalidates behind it — the surface never
 * blanks, and `refreshing` (not `loading`) is what a background fetch sets.
 *
 * Deliberately ~80 lines instead of a react-query dependency: the app has one
 * user, one window, and no mutations to reconcile. What it does NOT do is
 * dedupe across concurrent mounts of DIFFERENT keys or garbage-collect — the
 * key space is small and bounded by the number of surfaces.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Entry = { data: unknown; at: number };

const CACHE = new Map<string, Entry>();
/** In-flight fetches, keyed the same way: two components mounting on the same
 *  key in the same tick share ONE request instead of racing two. */
const INFLIGHT = new Map<string, Promise<unknown>>();

/** Drop a cached key (or everything). Use after a mutation that invalidates a
 *  derived view — not needed for plain reads, which revalidate on mount. */
export function invalidate(key?: string): void {
  if (key == null) CACHE.clear();
  else CACHE.delete(key);
}

/** Read a cached value without subscribing — for seeding a first render. */
export function peek<T>(key: string): T | null {
  const hit = CACHE.get(key);
  return hit ? (hit.data as T) : null;
}

/** Write a value into the cache from outside the hook (e.g. a prefetch). */
export function prime<T>(key: string, data: T): void {
  CACHE.set(key, { data, at: Date.now() });
}

/** Per-key fetch generation. A forced refresh abandons the in-flight fetch and
 *  starts a newer one; without this the ABANDONED fetch could still (a) delete
 *  the newer fetch's INFLIGHT entry when it settled and (b) land last and
 *  overwrite CACHE with the very response `force` was trying to replace. */
const GEN = new Map<string, number>();

/** Boot tolerance, mirroring `usePoll` (owner-reported 2026-08-02). Electron and
 *  vite serve several seconds before the Python backend finishes starting, so the
 *  FIRST fetch of every surface routinely lands on a refused connection. This hook
 *  fetched ONCE on mount, so that startup race became a PERMANENT "backend
 *  unreachable": the error was set once and nothing ever retried or cleared it —
 *  the pane stayed broken long after the backend was healthy. Now a failed load
 *  retries with linear backoff, and `error` stays null until the failures look
 *  real (or a previous success proves this is a genuine regression). */
const BOOT_GRACE_FAILURES = 6;
const RETRY_CAP_MS = 10_000;

function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = INFLIGHT.get(key);
  if (existing) return existing as Promise<T>;
  const gen = (GEN.get(key) ?? 0) + 1;
  GEN.set(key, gen);
  const p = fn()
    .then((d) => {
      // Only the NEWEST fetch for this key may write the shared cache.
      if (GEN.get(key) === gen) CACHE.set(key, { data: d, at: Date.now() });
      return d;
    })
    .finally(() => {
      if (GEN.get(key) === gen) INFLIGHT.delete(key);
    });
  INFLIGHT.set(key, p);
  return p;
}

/** Fetch `fn` under `key`, served stale-first from the module cache.
 *
 * - `data`       last known value — non-null on remount, so no blank frame
 * - `loading`    TRUE only with nothing to show (a genuine cold start)
 * - `refreshing` a background revalidation is in flight over existing data
 * - `reload()`   force a refetch (the surface's manual refresh button)
 *
 * `maxAgeMs` skips revalidation entirely when the cached value is younger than
 * it — a tab flicked back and forth doesn't hammer the backend.
 */
export function useCachedFetch<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { maxAgeMs?: number } = {},
) {
  const { maxAgeMs = 0 } = opts;
  const [data, setData] = useState<T | null>(() => peek<T>(key));
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Keep `fn` current without making it a dep — call sites pass inline arrows,
  // which would otherwise re-fire the effect on every render.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const failures = useRef(0);
  const hadSuccess = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped on unmount and on every key change: a late response — or a queued
   *  retry — from a superseded run must never write this component's state. */
  const runId = useRef(0);
  /** Lets a scheduled retry call the CURRENT `load` without making `load`
   *  depend on itself. */
  const loadRef = useRef<(force: boolean) => void>(() => {});

  const clearRetry = (): void => {
    if (retryTimer.current != null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  };

  const load = useCallback(
    (force: boolean): void => {
      clearRetry(); // a fresh load supersedes any pending retry
      const myRun = runId.current;
      const hit = CACHE.get(key);
      if (!force && hit && maxAgeMs > 0 && Date.now() - hit.at < maxAgeMs) {
        setData(hit.data as T);
        return;
      }
      setRefreshing(true);
      // `force` must bypass the in-flight share too, or a manual refresh can
      // resolve to the very response the user is trying to replace.
      if (force) INFLIGHT.delete(key);
      run(key, fnRef.current)
        .then((d) => {
          if (runId.current !== myRun) return;
          hadSuccess.current = true;
          failures.current = 0;
          setData(d as T);
          setError(null); // recovery must clear a stale outage message
        })
        .catch((e: unknown) => {
          if (runId.current !== myRun) return;
          failures.current += 1;
          // Only claim the backend is down once it looks down for real.
          if (hadSuccess.current || failures.current >= BOOT_GRACE_FAILURES) {
            setError(String(e));
          }
          // Keep trying. A backend that is still booting answers shortly, and
          // without this the surface stays broken until a manual reload.
          retryTimer.current = setTimeout(
            () => loadRef.current(false),
            Math.min(1000 * failures.current, RETRY_CAP_MS),
          );
        })
        .finally(() => {
          if (runId.current === myRun) setRefreshing(false);
        });
    },
    [key, maxAgeMs],
  );
  loadRef.current = load;

  useEffect(() => {
    // Paint whatever the cache holds for this key, then revalidate. Assigned
    // UNCONDITIONALLY: on a key change with no cache entry the previous key's
    // value must clear, or one key's rows bleed into another (the same bug
    // usePoll's resetKey handling exists to prevent).
    setData(peek<T>(key));
    setError(null); // one key's outage must not label the next key
    failures.current = 0; // boot grace counts per key, not across keys
    hadSuccess.current = false;
    load(false);
    return () => {
      runId.current += 1;
      clearRetry();
    };
  }, [key, load]);

  /** Write a value straight into cache + local state, no round trip. For when
   *  the caller ALREADY has authoritative fresh data (e.g. a forced server-side
   *  rebuild returned the new payload) and re-fetching it would be waste. */
  const mutate = useCallback(
    (next: T): void => {
      prime(key, next);
      setData(next);
      setError(null);
    },
    [key],
  );

  return {
    data,
    error,
    loading: data === null && error === null,
    refreshing,
    mutate,
    reload: useCallback(() => load(true), [load]),
  };
}
