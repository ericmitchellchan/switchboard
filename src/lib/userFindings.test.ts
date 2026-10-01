import { describe, expect, it } from "vitest";
import { draftClaim, findingTargetFor, type FindingTargetContext } from "./userFindings";
import { FINDING_CLAIM_CAP } from "./pageStore";

const ctx = (over: Partial<FindingTargetContext> = {}): FindingTargetContext => ({
  projectViewThread: () => null,
  threadExists: (id) => id === "th-1" || id === "th-builder",
  activeThreadId: "th-1",
  ...over,
});

describe("findingTargetFor — where a finding from a view is filed (SWIT-114)", () => {
  it("a thread's view files on that thread, linking view:<id>", () => {
    expect(findingTargetFor({ kind: "view", threadId: "th-1", viewId: "v3" }, ctx())).toEqual({ threadId: "th-1", report: "view:v3" });
  });

  it("a project view files on the thread that built it, else the thread beside the panel", () => {
    const pv = { kind: "view" as const, project: "lodestar", viewId: "r2" };
    expect(findingTargetFor(pv, ctx({ projectViewThread: () => "th-builder" }))).toEqual({
      threadId: "th-builder",
      report: "view:lodestar/r2",
    });
    // the builder was deleted → the active thread
    expect(findingTargetFor(pv, ctx({ projectViewThread: () => "th-gone" }))?.threadId).toBe("th-1");
    // no thread anywhere → nothing to file on (the control is not drawn)
    expect(findingTargetFor(pv, ctx({ activeThreadId: null }))).toBeNull();
  });

  it("a drilled child, an embedded block or a deleted thread's view files nothing", () => {
    expect(findingTargetFor({ kind: "view", threadId: "th-1", viewId: "v3", drill: { key: "SPX" } }, ctx())).toBeNull();
    expect(findingTargetFor({ kind: "view", threadId: "th-1", viewId: "v3", block: 2 }, ctx())).toBeNull();
    expect(findingTargetFor({ kind: "view", threadId: "th-gone", viewId: "v3" }, ctx())).toBeNull();
  });

  it("the draft claim is the title, cut to the cap", () => {
    expect(draftClaim("  Gamma flip vs SPX  ")).toBe("Gamma flip vs SPX");
    expect(draftClaim("x".repeat(FINDING_CLAIM_CAP + 10)).length).toBe(FINDING_CLAIM_CAP);
    // never half an emoji at the cut (review L6)
    const cut = draftClaim("x".repeat(FINDING_CLAIM_CAP - 1) + "😀tail");
    expect(cut).toBe("x".repeat(FINDING_CLAIM_CAP - 1));
  });
});
