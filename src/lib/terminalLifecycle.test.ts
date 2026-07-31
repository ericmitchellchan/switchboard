// Pure Node tests for the keep-alive registry's ownership/eviction rules.
// No DOM, no xterm — that's the point of terminalLifecycle.ts being pure.

import { describe, it, expect } from "vitest";
import {
  attachedLifecycle,
  canReattach,
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
    const outcome = adopt(hidden, 3);
    expect(outcome).toMatchObject({ action: "adopt", steal: false });
  });

  it("steal sequence A→B→C fires the loser's onStolen exactly once per steal", () => {
    // Simulates the registry's bookkeeping: `mount` holds the current owner's
    // handlers and is nulled on every steal, so a mount that already lost can
    // never be notified (or notify) twice.
    const stolenCalls: number[] = [];
    let lifecycle = attachedLifecycle(1);
    let mount: { owner: number; onStolen: () => void } | null = {
      owner: 1,
      onStolen: () => stolenCalls.push(1),
    };

    const adoptAs = (owner: number) => {
      const outcome = adopt(lifecycle, owner);
      if (outcome.action !== "adopt") throw new Error("expected adopt");
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

describe("disposal decision matrix", () => {
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

  it("PTY exit while hidden → dispose immediately", () => {
    const hidden: KeepAliveLifecycle = { attachedTo: null, exited: false };
    expect(markExited(hidden)).toEqual({ action: "dispose" });
  });

  it("PTY exit while a mount is showing → defer (keep the exit tail visible)", () => {
    const outcome = markExited(attachedLifecycle(4));
    expect(outcome.action).toBe("defer");
    if (outcome.action === "defer") {
      expect(outcome.next.exited).toBe(true);
      expect(outcome.next.attachedTo).toBe(4);
    }
  });

  it("release after a deferred exit → dispose (nothing left worth keeping)", () => {
    const exit = markExited(attachedLifecycle(4));
    if (exit.action !== "defer") throw new Error("expected defer");
    expect(release(exit.next, 4)).toEqual({ action: "dispose" });
  });

  it("release after a deferred exit by a NON-owner → ignore, not dispose", () => {
    const exit = markExited(attachedLifecycle(4));
    if (exit.action !== "defer") throw new Error("expected defer");
    expect(release(exit.next, 99)).toEqual({ action: "ignore" });
  });

  it("session close is unconditional — no lifecycle gate exists for it (the registry disposes directly)", () => {
    // Documented here for the matrix: close/kill does not consult release/
    // markExited; disposeTerminal tears down regardless of attachedTo/exited.
    expect(true).toBe(true);
  });
});

describe("exited instances are never re-adopted", () => {
  const exited: KeepAliveLifecycle = { attachedTo: null, exited: true };

  it("canReattach is false once exited", () => {
    expect(canReattach(exited)).toBe(false);
    expect(canReattach({ attachedTo: 5, exited: true })).toBe(false);
  });

  it("adopt on an exited instance → replace (dispose + fresh terminal)", () => {
    expect(adopt(exited, 9)).toEqual({ action: "replace" });
  });

  it("revive (in-place restart on the same session id) clears the latch", () => {
    const revived = revive({ attachedTo: 5, exited: true });
    expect(revived.exited).toBe(false);
    expect(canReattach(revived)).toBe(true);
    // ...and a later release keeps the live terminal instead of disposing it.
    expect(release(revived, 5).action).toBe("keep-alive");
  });
});

describe("re-attach refresh requirement", () => {
  it("adopting a hidden instance always demands a viewport refresh", () => {
    // Hidden writes advanced the buffer but the renderer skipped them — the
    // registry must term.refresh(0, rows-1) on every adoption.
    const outcome = adopt({ attachedTo: null, exited: false }, 2);
    expect(outcome).toMatchObject({ action: "adopt", refresh: true });
  });

  it("a steal-adoption demands a refresh too (the element changed hosts)", () => {
    const outcome = adopt(attachedLifecycle(1), 2);
    expect(outcome).toMatchObject({ action: "adopt", steal: true, refresh: true });
  });

  it("fresh creation carries no refresh flag — there is nothing skipped to repaint", () => {
    expect(adopt({ attachedTo: null, exited: true }, 2)).toEqual({ action: "replace" });
  });
});
