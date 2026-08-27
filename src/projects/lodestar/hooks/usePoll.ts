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

/** `resetKey`: when it changes, data clears and the poll restarts immediately
 * (e.g. a sport-tab switch must not show the previous tab's rows for 10s).
 *
 * `cacheKey`: opt IN to surviving unmount. Without it the hook behaves exactly
 * as before — blank on mount, fill on first tick. With it, the last value is
 * kept at module scope and repainted on the FIRST frame after a remount, so
 * navigating away and back no longer empties the surface while it refetches
 * (owner-reported 2026-08-02). Only pass a key whose `fn` is a pure read of the
 * same thing every time — the key IS the identity of the data.
 */
export function usePoll<T>(
  fn: () => Promise<T>,
  intervalMs = 2000,
  resetKey?: unknown,
  cacheKey?: string,
) {
  // `cacheKey` is combined with `resetKey` so one surface polling different
  // keys (a sport tab, a symbol) can't repaint another key's rows.
  const fullKey = cacheKey != null ? `${cacheKey}:${String(resetKey ?? "")}` : null;
  const [data, setData] = useState<T | null>(() =>
    fullKey != null ? (POLL_CACHE.get(fullKey) as T | undefined) ?? null : null,
  );
  const [error, setError] = useState<string | null>(null);
  const active = useSurfaceActive();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const hadSuccess = useRef(false);
  const failures = useRef(0);

  // ONE tick function for both effects; `cancelled` is per key so a late
  // response for the previous key never paints over the new one.
  const cancelledRef = useRef(false);
  const tick = (): void => {
    fnRef
      .current()
      .then((d) => {
        // Cache even if this instance unmounted mid-flight: the value is
        // still current, and the NEXT mount is exactly who wants it.
        if (fullKey != null) POLL_CACHE.set(fullKey, d);
        if (!cancelledRef.current) {
          hadSuccess.current = true;
          failures.current = 0;
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (cancelledRef.current) return;
        failures.current += 1;
        if (hadSuccess.current || failures.current >= BOOT_GRACE_FAILURES) {
          setError(String(e));
        }
      });
  };
  const tickRef = useRef(tick);
  tickRef.current = tick;

  // KEY change: reset + first tick (the original behaviour).
  useEffect(() => {
    cancelledRef.current = false;
    // Keep the cached value on screen while the first tick lands; without a
    // cacheKey this is the original blank-then-fill behaviour.
    setData(fullKey != null ? ((POLL_CACHE.get(fullKey) as T | undefined) ?? null) : null);
    setError(null); // a prefix-specific failure must not poison the next key
    failures.current = 0; // boot-grace counts per key, not across tabs
    tickRef.current();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, resetKey, fullKey]);

  // SWITCHBOARD: the INTERVAL runs only while the surface is ON SCREEN
  // (page-api useSurfaceActive). Going inactive stops the timer and keeps the
  // last data — no reset, no tick; coming back restarts the cadence. Beside a
  // live terminal, an ungated 2s poll is a cost the shell refuses.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => tickRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, resetKey, fullKey]);

  return { data, error };
}
