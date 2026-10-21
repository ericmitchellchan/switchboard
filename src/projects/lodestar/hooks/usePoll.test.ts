// usePoll's stale-drop (SWIT-130 review). The node test environment has no DOM
// to mount a hook in, so the part that decides who may paint - the per-run
// cancel flag and the tick that honours it - is exported and tested directly;
// the hook is a thin shell over exactly these two functions.

import { describe, expect, it, vi } from "vitest";
import { beginRun, runTick } from "./usePoll";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const handlers = () => ({ onCache: vi.fn(), onData: vi.fn(), onError: vi.fn() });

describe("usePoll runs", () => {
  it("a response for the previous key is dropped once a new run has begun", async () => {
    const run1 = beginRun(null);
    const slow = deferred<string>();
    const h1 = handlers();
    const t1 = runTick(run1, () => slow.promise, h1);

    // the key changes while run 1's request is still in flight
    const run2 = beginRun(run1);
    expect(run1.cancelled).toBe(true);
    expect(run2.cancelled).toBe(false);
    const h2 = handlers();
    await runTick(run2, async () => "new key", h2);
    expect(h2.onData).toHaveBeenCalledWith("new key");

    slow.resolve("old key"); // the late answer
    await t1;
    expect(h1.onData).not.toHaveBeenCalled();
    // ...but its value is still cached for ITS key, which is what the next mount wants
    expect(h1.onCache).toHaveBeenCalledWith("old key");
  });

  it("a late failure for the previous key is dropped too", async () => {
    const run1 = beginRun(null);
    const slow = deferred<string>();
    const h1 = handlers();
    const t1 = runTick(run1, () => slow.promise, h1);
    beginRun(run1);
    slow.reject(new Error("boom"));
    await t1;
    expect(h1.onError).not.toHaveBeenCalled();
  });

  it("the current run delivers data and errors", async () => {
    const run = beginRun(null);
    const ok = handlers();
    await runTick(run, async () => 7, ok);
    expect(ok.onData).toHaveBeenCalledWith(7);
    const bad = handlers();
    await runTick(run, async () => { throw new Error("nope"); }, bad);
    expect(bad.onError).toHaveBeenCalledTimes(1);
    expect(bad.onData).not.toHaveBeenCalled();
  });

  it("an unmounted run (cancelled, never replaced) paints nothing", async () => {
    const run = beginRun(null);
    const slow = deferred<number>();
    const h = handlers();
    const t = runTick(run, () => slow.promise, h);
    run.cancelled = true; // the effect cleanup
    slow.resolve(1);
    await t;
    expect(h.onData).not.toHaveBeenCalled();
  });

  it("beginRun with nothing before it is a fresh live run", () => {
    expect(beginRun(null)).toEqual({ cancelled: false });
  });
});
