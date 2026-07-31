// Ownership + eviction rules for the keep-alive terminal registry
// (terminalRegistry.ts) — extracted as pure logic so the lifecycle guarantees
// are unit-testable without DOM/xterm (the webgl/fit addons crash under Node).
//
// Ported from ky-desktop's terminalLifecycle.ts (which itself evolved from this
// repo's terminal substrate). Rules:
//
//   • one live Terminal per session, shown by at most ONE mount (the owner);
//     a newer mount STEALS ownership (last mount wins — e.g. the same session
//     visible in two split panes, or a single-pane ↔ split transition racing),
//     and the loser's late cleanup must then be a no-op;
//   • release by the owner keeps the instance alive (hidden) — unless the PTY
//     exited, in which case release disposes it;
//   • a PTY exit disposes a hidden instance immediately, but defers while a
//     mount is showing the exit tail;
//   • an exited instance is never re-adopted (a fresh spawn gets a fresh term)
//     — UNLESS the session is revived in place (Switchboard's Restart button
//     reuses the session id; `revive` clears the exited latch so the live
//     terminal isn't disposed out from under the restarted PTY);
//   • every adoption of an existing instance requires a viewport refresh:
//     hidden writes advanced the buffer but the renderer skipped them.

export type KeepAliveLifecycle = {
  /** Token of the mount currently showing the terminal; null while hidden. */
  attachedTo: number | null;
  /** The PTY exited — keep only while a mount displays the tail; never reuse
   *  (until an explicit in-place revive/restart). */
  exited: boolean;
};

/** Lifecycle for a freshly created instance, attached to its creating mount. */
export function attachedLifecycle(owner: number): KeepAliveLifecycle {
  return { attachedTo: owner, exited: false };
}

/** Can a remount adopt this instance? Exited terminals are dead ends — the
 *  remount disposes them and spawns fresh instead. */
export function canReattach(l: KeepAliveLifecycle): boolean {
  return !l.exited;
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

export type AdoptOutcome =
  /** Existing live instance — move its DOM into the new host. `steal` = it was
   *  taken from another still-attached mount (fire that mount's onStolen and
   *  sever its handlers). `refresh` is ALWAYS required: writes that landed
   *  while hidden advanced the buffer but the renderer skipped them. */
  | { action: "adopt"; steal: boolean; refresh: true; next: KeepAliveLifecycle }
  /** Exited instance — dispose it and create a fresh terminal instead. */
  | { action: "replace" };

/** A mount wants the session's terminal and an entry already exists. */
export function adopt(l: KeepAliveLifecycle, owner: number): AdoptOutcome {
  if (!canReattach(l)) return { action: "replace" };
  return { action: "adopt", steal: isSteal(l, owner), refresh: true, next: attach(l, owner) };
}

export type ReleaseOutcome =
  /** Not the owner (a newer mount stole the instance) — leave it alone. */
  | { action: "ignore" }
  /** The PTY exited while attached — nothing left worth keeping alive. */
  | { action: "dispose" }
  /** Detach and keep the instance alive, hidden, still consuming output. */
  | { action: "keep-alive"; next: KeepAliveLifecycle };

/** A mount is unmounting. */
export function release(l: KeepAliveLifecycle, owner: number): ReleaseOutcome {
  if (l.attachedTo !== owner) return { action: "ignore" };
  if (l.exited) return { action: "dispose" };
  return { action: "keep-alive", next: { ...l, attachedTo: null } };
}

export type ExitOutcome =
  /** Hidden — nobody is looking at the tail, evict immediately. */
  | { action: "dispose" }
  /** Visible — keep showing the exit tail; dispose on release instead. */
  | { action: "defer"; next: KeepAliveLifecycle };

/** The PTY behind the instance exited. */
export function markExited(l: KeepAliveLifecycle): ExitOutcome {
  if (l.attachedTo === null) return { action: "dispose" };
  return { action: "defer", next: { ...l, exited: true } };
}

/** In-place restart (Switchboard reuses the session id): a new PTY is about to
 *  spawn behind the SAME live terminal — clear the exited latch so a later
 *  release keeps the instance alive instead of disposing it. */
export function revive(l: KeepAliveLifecycle): KeepAliveLifecycle {
  return { ...l, exited: false };
}
