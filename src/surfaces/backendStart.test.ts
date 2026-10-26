import { beforeEach, describe, expect, it } from "vitest";
import {
  BACKEND_START_GRACE_MS,
  BACKEND_START_RETRY_MS,
  forgetAsk,
  noteAskFailed,
  noteAsked,
  pendingAskAt,
  resetBackendAsks,
  shouldAskStart,
  viewAfterMiss,
} from "./backendStart";

describe("surface backend start pacing (SWIT-154)", () => {
  beforeEach(() => resetBackendAsks());

  it("asks the first time, then not again inside the retry window", () => {
    expect(shouldAskStart("lodestar", 1_000)).toBe(true);
    noteAsked("lodestar", 1_000);
    expect(shouldAskStart("lodestar", 1_000 + BACKEND_START_RETRY_MS - 1)).toBe(false);
    expect(shouldAskStart("lodestar", 1_000 + BACKEND_START_RETRY_MS)).toBe(true);
  });

  it("paces per project, shared by every host of that project", () => {
    noteAsked("lodestar", 5_000);
    // A second host of the same project reads the same record.
    expect(shouldAskStart("lodestar", 6_000)).toBe(false);
    expect(pendingAskAt("lodestar")).toBe(5_000);
    expect(shouldAskStart("orbit", 6_000)).toBe(true);
  });

  it("shows a failed start before it retries it", () => {
    expect(BACKEND_START_RETRY_MS).toBeGreaterThan(BACKEND_START_GRACE_MS);
  });

  it("a refused ask reads down at once but is not re-asked every probe", () => {
    noteAsked("lodestar", 1_000);
    noteAskFailed("lodestar");
    expect(pendingAskAt("lodestar")).toBeNull();
    expect(viewAfterMiss(2, 2, pendingAskAt("lodestar"), 2_000)).toBe("down");
    expect(shouldAskStart("lodestar", 2_000)).toBe(false);
  });

  it("an answer forgets the ask, so the next outage asks at once", () => {
    noteAsked("lodestar", 1_000);
    forgetAsk("lodestar");
    expect(shouldAskStart("lodestar", 1_001)).toBe(true);
    // ...and a later outage never shows "starting" for a start nobody asked.
    expect(viewAfterMiss(2, 2, pendingAskAt("lodestar"), 1_002)).toBe("down");
  });

  it("no card below the miss limit; starting inside the grace; down after", () => {
    expect(viewAfterMiss(1, 2, 0, 1)).toBeNull();
    expect(viewAfterMiss(2, 2, 0, BACKEND_START_GRACE_MS - 1)).toBe("starting");
    expect(viewAfterMiss(2, 2, 0, BACKEND_START_GRACE_MS)).toBe("down");
    expect(viewAfterMiss(3, 2, null, 10)).toBe("down");
  });
});
