/** Poll an async fetch on an interval. Returns latest data + error.
 *
 * Boot-tolerant (owner-reported 2026-07-02): the backend takes a few seconds
 * to come up under `pnpm dev`, and pages used to flash "backend unreachable"
 * for what was really just startup. `error` stays null until either (a) a
 * fetch has EVER succeeded — after which any failure is a real regression and
 * surfaces immediately — or (b) BOOT_GRACE_FAILURES consecutive failures pass
 * (the backend is genuinely down/broken, say so). Until then consumers see
 * `data == null, error == null` — their loading state.
 */

import { useEffect, useRef, useState } from "react";
import { useSurfaceActive } from "../../../surfaces/page-api";

const BOOT_GRACE_FAILURES = 6; // x poll interval ≈ how long boot may take

/** Last value per cache key, at module scope so it outlives route unmounts.
 *  Only written for callers that opt in with `cacheKey` (see below). */
const POLL_CACHE = new Map<string, unknown>();

/** One KEY's life: set when the key-change effect runs, flipped when that run
 *  is torn down (key change or unmount). A response belongs to the run that
 *  asked for it, so a late answer for the previous key can never paint over
 *  the new one — each run owns its own flag (a single shared flag was reset to
 *  false by the next run's setup, which let the old in-flight response through). */
export interface PollRun {
  cancelled: boolean;
  /** A request of THIS run is still in flight: the next tick is skipped, so a
   *  slow answer (or a fast boot cadence) never stacks concurrent copies. */
  pending: boolean;
  /** When the pending request started (ms), and a counter that numbers the
   *  requests of this run - an abandoned request's late result carries an old
   *  number and cannot land. */
  pendingSince: number;
  seq: number;
}

/** Start a new run; the previous one (if any) is cancelled for good. */
export function beginRun(prev: PollRun | null): PollRun {
  if (prev) prev.cancelled = true;
  return { cancelled: false, pending: false, pendingSince: 0, seq: 0 };
}

/** One fetch, answered to the run that asked. Pure of React so the stale-drop
 *  has a unit test. `onCache` fires even for a cancelled run: the value is
 *  still current for its key, and the next mount is who wants it. */
export async function runTick<T>(
  run: PollRun,
  fn: () => Promise<T>,
  h: { onCache?: (d: T) => void; onData: (d: T) => void; onError: (e: unknown) => void },
  opts?: { staleAfterMs?: number; now?: () => number },
): Promise<void> {
  const now = opts?.now ?? Date.now;
  if (run.pending) {
    // A request that never settles must not stall the poll forever: past this
    // age it is abandoned, the next tick goes, and the abandoned request's late
    // result can no longer land (it carries an old request number).
    if (now() - run.pendingSince < (opts?.staleAfterMs ?? ABANDON_FLOOR_MS)) return;
  }
  const mine = ++run.seq;
  run.pending = true;
  run.pendingSince = now();
  let d: T;
  try {
    d = await fn();
  } catch (e) {
    if (mine !== run.seq) return;
    run.pending = false;
    if (!run.cancelled) h.onError(e);
    return;
  }
  if (mine !== run.seq) return;
  run.pending = false;
  h.onCache?.(d);
  if (!run.cancelled) h.onData(d);
}

/** A pending request older than max(this, 1.5 x the interval) is abandoned. */
export const ABANDON_FLOOR_MS = 45_000;

export interface PollOptions {
  /** Poll at this (shorter) interval until the first success, then at
   *  `intervalMs` - so a slow cadence does not also make boot errors slow. */
  bootIntervalMs?: number;
  /** Stop the interval (the first fetch still happens; data is kept). Does not
   *  reset or refetch, unlike changing `intervalMs`. */
  paused?: boolean;
}

/** `resetKey`: when it changes, data clears and the poll restarts immediately
 * (e.g. a sport-tab switch must not show the previous tab's rows for 10s).
 *
 * `cacheKey`: opt IN to surviving unmount. Without it the hook behaves exactly
 * as before - blank on mount, fill on first tick. With it, the last value is
 * kept at module scope and repainted on the FIRST frame after a remount, so
 * navigating away and back no longer empties the surface while it refetches
 * (owner-reported 2026-08-02). Only pass a key whose `fn` is a pure read of the
 * same thing every time - the key IS the identity of the data.
 */
export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs = 2000,
  resetKey?: unknown,
  cacheKey?: string,
  options?: PollOptions,
) {
  // `cacheKey` is combined with `resetKey` so one surface polling different
  // keys (a sport tab, a symbol) can't repaint another key's rows.
  const fullKey = cacheKey != null ? `${cacheKey}:${String(resetKey ?? "")}` : null;
  const [data, setData] = useState<T | null>(() =>
    fullKey != null ? (POLL_CACHE.get(fullKey) as T | undefined) ?? null : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const active = useSurfaceActive();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const hadSuccess = useRef(false);
  const failures = useRef(0);

  // ONE tick function for both effects. The run is read when the tick STARTS,
  // so an interval tick after a key change belongs to the new run and a
  // response that was already in flight stays bound to the old (cancelled) one.
  const runRef = useRef<PollRun | null>(null);
  const tick = (): void => {
    const run = runRef.current;
    if (!run) return;
    void runTick(run, fnRef.current, {
      onCache: (d) => {
        if (fullKey != null) POLL_CACHE.set(fullKey, d);
      },
      onData: (d) => {
        hadSuccess.current = true;
        failures.current = 0;
        setBooted(true);
        setData(d);
        setError(null);
      },
      onError: (e) => {
        failures.current += 1;
        if (hadSuccess.current || failures.current >= BOOT_GRACE_FAILURES) {
          setError(String(e));
        }
      },
    }, { staleAfterMs: Math.max(ABANDON_FLOOR_MS, 1.5 * intervalMs) });
  };
  const tickRef = useRef(tick);
  tickRef.current = tick;

  // KEY change: reset + first tick (the original behaviour).
  useEffect(() => {
    runRef.current = beginRun(runRef.current);
    // Keep the cached value on screen while the first tick lands; without a
    // cacheKey this is the original blank-then-fill behaviour.
    setData(fullKey != null ? ((POLL_CACHE.get(fullKey) as T | undefined) ?? null) : null);
    setError(null); // a prefix-specific failure must not poison the next key
    failures.current = 0; // boot-grace counts per key, not across tabs
    tickRef.current();
    return () => {
      if (runRef.current) runRef.current.cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, resetKey, fullKey]);

  // SWITCHBOARD: the INTERVAL runs only while the surface is ON SCREEN
  // (page-api useSurfaceActive). Going inactive stops the timer and keeps the
  // last data - no reset, no tick; coming back restarts the cadence. Beside a
  // live terminal, an ungated 2s poll is a cost the shell refuses.
  const paused = options?.paused === true;
  const bootMs = options?.bootIntervalMs;
  const everyMs = bootMs != null && !booted ? Math.min(bootMs, intervalMs) : intervalMs;
  useEffect(() => {
    if (!active || paused) return;
    const id = setInterval(() => tickRef.current(), everyMs);
    return () => clearInterval(id);
  }, [active, paused, everyMs, resetKey, fullKey]);

  return { data, error };
}
