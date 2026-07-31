// Pure Node tests for the keep-alive registry's ownership/eviction rules.
// No DOM, no xterm — that's the point of terminalLifecycle.ts being pure.

import { describe, it, expect } from "vitest";
import {
  attachedLifecycle,
  attach,
  isSteal,
  adopt,
  release,
  markExited,
  revive,
  type KeepAliveLifecycle,
} from "./terminalLifecycle";

describe("ownership tokens: grant and steal", () => {
  it("a fresh instance is attached to its creating mount", () => {
    const l = attachedLifecycle(1);
    expect(l.attachedTo).toBe(1);
    expect(l.exited).toBe(false);
  });

  it("re-attach by the same owner is not a steal", () => {
    const l = attachedLifecycle(1);
    expect(isSteal(l, 1)).toBe(false);
  });

  it("attach by a different mount while attached IS a steal (last mount wins)", () => {
    const l = attachedLifecycle(1);
    expect(isSteal(l, 2)).toBe(true);
    const next = attach(l, 2);
    expect(next.attachedTo).toBe(2);
  });

  it("adopting a detached (hidden) instance is not a steal", () => {
    const hidden: KeepAliveLifecycle = { attachedTo: null, exited: false };
    expect(isSteal(hidden, 3)).toBe(false);
    expect(adopt(hidden, 3)).toMatchObject({ steal: false });
  });

  // NOTE: this test SIMULATES the registry's bookkeeping (terminalRegistry.ts
  // acquireTerminal: fire the loser's onStolen, then null `mount`, then commit
  // the adopted lifecycle). If that sequence changes in the registry, this
  // harness must be updated to match — it can drift silently otherwise.
  it("steal sequence A→B→C fires the loser's onStolen exactly once per steal", () => {
    // `mount` holds the current owner's handlers and is nulled on every steal,
    // so a mount that already lost can never be notified (or notify) twice.
    const stolenCalls: number[] = [];
    let lifecycle = attachedLifecycle(1);
    let mount: { owner: number; onStolen: () => void } | null = {
      owner: 1,
      onStolen: () => stolenCalls.push(1),
    };

    const adoptAs = (owner: number) => {
      const outcome = adopt(lifecycle, owner);
      if (outcome.steal) mount?.onStolen();
      mount = { owner, onStolen: () => stolenCalls.push(owner) };
      lifecycle = outcome.next;
    };

    adoptAs(2); // steals from 1
    expect(stolenCalls).toEqual([1]);
    adoptAs(3); // steals from 2 — mount 1 already severed, cannot re-fire
    expect(stolenCalls).toEqual([1, 2]);

    // The losers' late cleanups are no-ops: not the owner anymore.
    expect(release(lifecycle, 1)).toEqual({ action: "ignore" });
    expect(release(lifecycle, 2)).toEqual({ action: "ignore" });
    expect(stolenCalls).toEqual([1, 2]); // nothing double-fired
  });

  it("a loser's unbind guard: only the current owner matches attachedTo", () => {
    let l = attachedLifecycle(1);
    l = attach(l, 2);
    expect(l.attachedTo).toBe(2);
    expect(l.attachedTo === 1).toBe(false); // owner-guarded bind/unbind is a no-op for 1
  });
});

describe("disposal decision matrix (exit never disposes)", () => {
  it("release by the owner of a live instance → keep-alive, detached", () => {
    const outcome = release(attachedLifecycle(7), 7);
    expect(outcome.action).toBe("keep-alive");
    if (outcome.action === "keep-alive") {
      expect(outcome.next.attachedTo).toBeNull();
      expect(outcome.next.exited).toBe(false);
    }
  });

  it("release by a non-owner → ignore (a newer mount owns it)", () => {
    const l = attach(attachedLifecycle(1), 2);
    expect(release(l, 1)).toEqual({ action: "ignore" });
  });

  it("PTY exit while hidden → latch only; the parked buffer survives", () => {
    const hidden: KeepAliveLifecycle = { attachedTo: null, exited: false };
    const next = markExited(hidden);
    expect(next).toEqual({ attachedTo: null, exited: true });
  });

  it("PTY exit while a mount is showing → latch only; owner keeps the tail", () => {
    const next = markExited(attachedLifecycle(4));
    expect(next.exited).toBe(true);
    expect(next.attachedTo).toBe(4);
  });

  it("release after exit → keep-alive parked, NOT disposed (tail stays readable)", () => {
    const exited = markExited(attachedLifecycle(4));
    const outcome = release(exited, 4);
    expect(outcome.action).toBe("keep-alive");
    if (outcome.action === "keep-alive") {
      expect(outcome.next).toEqual({ attachedTo: null, exited: true });
    }
  });

  it("release after exit by a NON-owner → ignore", () => {
    const exited = markExited(attachedLifecycle(4));
    expect(release(exited, 99)).toEqual({ action: "ignore" });
  });
});

describe("exited entries stay adoptable and revivable", () => {
  it("adopting a parked exited entry works — the exit tail is what the remount shows", () => {
    const parkedExited: KeepAliveLifecycle = { attachedTo: null, exited: true };
    const outcome = adopt(parkedExited, 9);
    expect(outcome.steal).toBe(false);
    expect(outcome.next).toEqual({ attachedTo: 9, exited: true });
  });

  it("adopting a SHOWN exited entry is still a steal for the showing mount", () => {
    const shownExited = markExited(attachedLifecycle(5));
    const outcome = adopt(shownExited, 6);
    expect(outcome.steal).toBe(true);
    expect(outcome.next.attachedTo).toBe(6);
    expect(outcome.next.exited).toBe(true);
  });

  it("revive (in-place Restart on the same session id) clears the latch", () => {
    const revived = revive(markExited(attachedLifecycle(5)));
    expect(revived).toEqual({ attachedTo: 5, exited: false });
    // ...and the restarted session's later release parks it live, as usual.
    const outcome = release(revived, 5);
    expect(outcome.action).toBe("keep-alive");
    if (outcome.action === "keep-alive") expect(outcome.next.exited).toBe(false);
  });

  it("full restart round-trip: exit shown → release parked → adopt → revive", () => {
    let l = attachedLifecycle(1);
    l = markExited(l); // PTY died while shown
    const rel = release(l, 1); // pane unmounts (tab switch in split mode)
    if (rel.action !== "keep-alive") throw new Error("expected keep-alive");
    l = rel.next; // parked, exited — buffer intact
    l = adopt(l, 2).next; // user reopens the tab; tail is readable
    l = revive(l); // user clicks Restart; new PTY, same terminal
    expect(l).toEqual({ attachedTo: 2, exited: false });
  });
});

describe("re-attach refresh requirement", () => {
  it("adopting a hidden instance always demands a viewport refresh", () => {
    // Hidden writes advanced the buffer but the renderer skipped them — the
    // registry must term.refresh(0, rows-1) on every adoption.
    expect(adopt({ attachedTo: null, exited: false }, 2).refresh).toBe(true);
  });

  it("a steal-adoption demands a refresh too (the element changed hosts)", () => {
    expect(adopt(attachedLifecycle(1), 2)).toMatchObject({ steal: true, refresh: true });
  });

  it("adopting a parked EXITED instance demands a refresh as well", () => {
    expect(adopt({ attachedTo: null, exited: true }, 2).refresh).toBe(true);
  });
});
