// Ownership + eviction rules for the keep-alive terminal registry
// (terminalRegistry.ts) — extracted as pure logic so the lifecycle guarantees
// are unit-testable without DOM/xterm (the webgl/fit addons crash under Node).
//
// Ported from ky-desktop's terminalLifecycle.ts (which itself evolved from
// this repo's terminal substrate), adapted to Switchboard's session model.
// Rules:
//
//   • one live Terminal per session, shown by at most ONE mount (the owner);
//     a newer mount STEALS ownership (last mount wins — e.g. the same session
//     visible in two split panes, or a single-pane ↔ split transition racing),
//     and the loser's late cleanup must then be a no-op;
//   • release by the owner parks the instance (hidden, still consuming
//     output) — release NEVER disposes;
//   • a PTY exit NEVER disposes either (deviation from Ky, where exit ≈
//     session over): Switchboard keeps exited sessions in the tab bar with a
//     Restart button, so the final output must stay readable — shown, parked,
//     or re-adopted later. `exited` is a truthful state latch, not a disposal
//     trigger; `revive` clears it when an in-place Restart (same session id)
//     spawns a new PTY behind the same terminal;
//   • the ONLY disposal paths are explicit: session close / kill
//     (disposeTerminal, from App.destroySession) and app teardown. They are
//     unconditional and never consult these rules;
//   • every adoption of an existing instance requires a viewport refresh:
//     hidden writes advanced the buffer but the renderer skipped them.

export type KeepAliveLifecycle = {
  /** Token of the mount currently showing the terminal; null while hidden. */
  attachedTo: number | null;
  /** The PTY behind the instance exited. Informational latch — the exit tail
   *  stays readable until session close; cleared by `revive` on an in-place
   *  restart so the state stays truthful for the new PTY. */
  exited: boolean;
};

/** Lifecycle for a freshly created instance, attached to its creating mount. */
export function attachedLifecycle(owner: number): KeepAliveLifecycle {
  return { attachedTo: owner, exited: false };
}

/** A mount adopts the instance — steals from any current owner (last wins). */
export function attach(l: KeepAliveLifecycle, owner: number): KeepAliveLifecycle {
  return { ...l, attachedTo: owner };
}

/** Does this attach take the instance from a DIFFERENT, still-attached mount
 *  (same session shown in two panes)? The loser must be told: its DOM just
 *  emptied, and its per-mount handlers must be severed — otherwise its late
 *  cleanup/fits would fight the winner (and, were input handlers per-mount,
 *  every keystroke would be forwarded to the PTY twice). */
export function isSteal(l: KeepAliveLifecycle, owner: number): boolean {
  return l.attachedTo !== null && l.attachedTo !== owner;
}

export type AdoptOutcome = {
  /** The instance was taken from another still-attached mount — fire that
   *  mount's onStolen and sever its handlers. */
  steal: boolean;
  /** ALWAYS required: writes that landed while hidden advanced the buffer but
   *  the renderer skipped them — repaint on every adoption. */
  refresh: true;
  next: KeepAliveLifecycle;
};

/** A mount wants the session's terminal and an entry already exists. EVERY
 *  existing entry is adoptable — including an exited one, whose buffer (the
 *  exit tail) is exactly what the remount is there to show. */
export function adopt(l: KeepAliveLifecycle, owner: number): AdoptOutcome {
  return { steal: isSteal(l, owner), refresh: true, next: attach(l, owner) };
}

export type ReleaseOutcome =
  /** Not the owner (a newer mount stole the instance) — leave it alone. */
  | { action: "ignore" }
  /** Detach and park the instance, hidden — exited or not, the buffer stays
   *  readable until the session itself is closed. */
  | { action: "keep-alive"; next: KeepAliveLifecycle };

/** A mount is unmounting. Never disposes — see the module header. */
export function release(l: KeepAliveLifecycle, owner: number): ReleaseOutcome {
  if (l.attachedTo !== owner) return { action: "ignore" };
  return { action: "keep-alive", next: { ...l, attachedTo: null } };
}

/** The PTY behind the instance exited. Latch it — shown or hidden, the
 *  instance survives so the final output stays readable; only explicit
 *  session close disposes. */
export function markExited(l: KeepAliveLifecycle): KeepAliveLifecycle {
  return { ...l, exited: true };
}

/** In-place restart (Switchboard reuses the session id): a new PTY is about
 *  to spawn behind the SAME live terminal — clear the exited latch so the
 *  lifecycle state stays truthful for the restarted session. */
export function revive(l: KeepAliveLifecycle): KeepAliveLifecycle {
  return { ...l, exited: false };
}

// ── Spawn generations ────────────────────────────────────────────────────────
// A restart kills the old PTY but does NOT join its reader thread; that thread
// proceeds to EOF, drains, and emits its dying session:output/session:exited
// events under names keyed only by the session id — which the restarted
// session REUSES. Every event therefore carries the generation of the spawn
// that produced it, and the registry drops events whose generation doesn't
// match its expectation.
//
// The expectation is CLIENT-generated and bumped BEFORE the restart invoke is
// sent (bump-expectation-then-spawn). Tauri delivers events and invoke
// results on the same IPC into the same JS event loop, so a new-generation
// event can overtake the invoke's own resolution — setting the expectation
// from the invoke RESULT would leave a window where the new spawn's first
// output is dropped. Bumping first closes it: the old PTY dies inside the
// invoke (strictly after the bump), so by the time any new-gen event can
// exist the expectation already matches it, and every stale event carries a
// previous generation regardless of when it trickles in.

/** Generation of a session's first spawn. Fresh sessions get brand-new UUIDs,
 *  so no stale reader thread can exist for them — gen 1 needs no handshake. */
export const FIRST_SPAWN_GEN = 1;

/** The expectation for the NEXT spawn of a session (call before the restart
 *  invoke; pass the result to the backend so it stamps the new reader). */
export function nextGeneration(current: number | undefined): number {
  return (current ?? FIRST_SPAWN_GEN) + 1;
}

/** Should an event stamped `eventGen` be applied to a session whose expected
 *  generation is `expectedGen`? Undefined expectation rejects: listeners only
 *  exist alongside a registry entry, which records its generation at creation
 *  — an event with no recorded expectation is targeting a closed session. */
export function acceptsGeneration(
  expectedGen: number | undefined,
  eventGen: number
): boolean {
  return expectedGen !== undefined && eventGen === expectedGen;
}
