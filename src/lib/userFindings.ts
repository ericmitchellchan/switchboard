// SWIT-114 — A REPORT BECOMES A FINDING IN ONE CLICK (the mock's Ask scene:
// "A report you trust becomes a finding in one click, so it outlives the
// thread"). The user's finding is filed into a THREAD's findings.json — the
// app's file, Rust's `add_thread_finding` its one writer — and the page,
// Home, the lane page and `page read` merge it with the agent's ledger. Pure
// rules here; the control is components/views/FindingAction.tsx.

import type { Artifact } from "../types";
import { FINDING_CLAIM_CAP } from "./pageStore";
import { projectViewAddress, viewAddress } from "./evidenceModel";

type ViewArtifact = Extract<Artifact, { kind: "view" }>;

export type FindingTarget = {
  /** The thread whose page the finding is filed on. */
  threadId: string;
  /** The report address the finding links back to. */
  report: string;
};

export type FindingTargetContext = {
  /** The project index rows for a project view (who built it). */
  projectViewThread: (project: string, viewId: string) => string | null;
  threadExists: (threadId: string) => boolean;
  /** The thread beside the panel (the active tab's), else null. */
  activeThreadId: string | null;
};

/** WHERE a finding from this view goes, or null (no thread to file it on —
 *  the control is not drawn). A drilled child or an embedded block has no
 *  address of its own, so it files nothing (its report does). A thread's
 *  view: that thread. A project view: the thread that BUILT it while it
 *  exists, else the thread beside the panel. Pure. */
export function findingTargetFor(artifact: ViewArtifact, ctx: FindingTargetContext): FindingTarget | null {
  if (artifact.drill || artifact.block !== undefined) return null;
  if (artifact.project !== undefined) {
    const builder = ctx.projectViewThread(artifact.project, artifact.viewId);
    const threadId = builder !== null && ctx.threadExists(builder) ? builder : ctx.activeThreadId;
    if (threadId === null) return null;
    return { threadId, report: projectViewAddress(artifact.project, artifact.viewId) };
  }
  if (!artifact.threadId || !ctx.threadExists(artifact.threadId)) return null;
  return { threadId: artifact.threadId, report: viewAddress(artifact.viewId) };
}

/** The claim the box starts with: the view's title, cut to the cap. The
 *  user rewrites it into the sentence the report supports. */
export function draftClaim(title: string): string {
  const t = title.trim();
  return t.length > FINDING_CLAIM_CAP ? t.slice(0, FINDING_CLAIM_CAP) : t;
}
