// SWIT-114 — `→ finding`: a report (or a standalone view) becomes a finding
// in one click and a sentence. The button sits in the view's toolbar; the
// form opens as a small card UNDER it, fixed to the button's box (the toolbar
// is one clipped line, so the card cannot live inside it). Saving files the
// finding on a thread's page through Rust (`add_thread_finding` → the
// thread's findings.json, the app's file) — no live agent needed, and it
// outlives the thread like any finding. Where it goes is
// lib/userFindings.findingTargetFor; nothing renders when there is nowhere.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Artifact } from "../../types";
import { addThreadFinding } from "../../lib/ipc";
import { FINDING_CLAIM_CAP, FINDING_N_CAP, FINDING_VERDICTS, type FindingVerdict } from "../../lib/pageStore";
import { verdictTone } from "../../lib/statusPill";
import { getProjectViews } from "../../lib/repoListing";
import { getActiveTabSession } from "../../lib/panelStore";
import { findThreadBySessionId, getThreadById, useThreadsView } from "../../lib/threadStore";
import { draftClaim, findingTargetFor } from "../../lib/userFindings";
import { FIELD, MONO, PRIMARY, QUIET_BUTTON, READING } from "../kit";
import { StatusPill } from "../kb/PageBlock";

type ViewArtifact = Extract<Artifact, { kind: "view" }>;

const CARD_WIDTH = 360;

export function FindingAction({
  artifact,
  title,
  buttonStyle,
}: {
  artifact: ViewArtifact;
  title: string;
  buttonStyle: CSSProperties;
}) {
  // The thread list re-renders this when a thread comes or goes, so the
  // target is never a deleted thread.
  const view = useThreadsView();
  const target = useMemo(
    () =>
      findingTargetFor(artifact, {
        projectViewThread: (project, viewId) =>
          getProjectViews(project)?.find((r) => r.id === viewId)?.threadId ?? null,
        threadExists: (id) => getThreadById(id) !== undefined,
        activeThreadId: findThreadBySessionId(getActiveTabSession() ?? "")?.id ?? null,
      }),
    // `view` stands in for "the threads moved"; the rest is the artifact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [artifact, view.threads, view.activeSessionId]
  );
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  if (!target) return null;
  const threadTitle = getThreadById(target.threadId)?.title ?? "this thread";
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        style={{ ...buttonStyle, ...(open ? { color: "var(--text-primary)", borderColor: "var(--text-secondary)" } : {}) }}
        onClick={() => setOpen((o) => !o)}
        title={`File what this shows as a finding on ${threadTitle}'s page — it outlives the thread`}
      >
        → finding
      </button>
      {open && (
        <FindingCard
          anchor={buttonRef.current}
          threadId={target.threadId}
          threadTitle={threadTitle}
          report={target.report}
          initialClaim={draftClaim(title)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function FindingCard({
  anchor,
  threadId,
  threadTitle,
  report,
  initialClaim,
  onClose,
}: {
  anchor: HTMLElement | null;
  threadId: string;
  threadTitle: string;
  report: string;
  initialClaim: string;
  onClose: () => void;
}) {
  const [claim, setClaim] = useState(initialClaim);
  const [verdict, setVerdict] = useState<FindingVerdict>("lead");
  const [n, setN] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; why: string }>({
    kind: "idle",
  });
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const claimRef = useRef<HTMLInputElement | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - CARD_WIDTH, window.innerWidth - CARD_WIDTH - 8));
    setPos({ top: r.bottom + 4, left });
  }, [anchor]);
  useEffect(() => {
    claimRef.current?.focus();
    claimRef.current?.select();
  }, []);
  useEffect(() => {
    if (state.kind !== "saved") return;
    const t = window.setTimeout(onClose, 1600);
    return () => window.clearTimeout(t);
  }, [state.kind, onClose]);

  const save = async () => {
    if (claim.trim().length === 0 || state.kind === "saving") return;
    setState({ kind: "saving" });
    try {
      await addThreadFinding(threadId, {
        claim: claim.trim(),
        verdict,
        n: n.trim().length > 0 ? n.trim() : null,
        report,
      });
      setState({ kind: "saved" });
    } catch (err) {
      setState({ kind: "error", why: String(err) });
    }
  };

  if (!pos) return null;
  return (
    <div
      role="dialog"
      aria-label="File a finding"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: CARD_WIDTH,
        zIndex: 50,
        background: "var(--bg-active)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontFamily: READING,
        boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)" }}>Finding</div>
      <input
        ref={claimRef}
        type="text"
        value={claim}
        maxLength={FINDING_CLAIM_CAP}
        placeholder="One sentence: what this shows"
        onChange={(e) => setClaim(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          }
        }}
        style={{ ...FIELD, maxWidth: "none" }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {FINDING_VERDICTS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setVerdict(v)}
            aria-pressed={verdict === v}
            style={{
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              opacity: verdict === v ? 1 : 0.45,
            }}
            title={
              v === "lead" ? "Worth chasing" : v === "open" ? "Not settled" : v === "fact" ? "Established" : "Ruled out"
            }
          >
            <StatusPill word={v} tone={verdictTone(v)} />
          </button>
        ))}
        <input
          type="text"
          value={n}
          maxLength={FINDING_N_CAP}
          placeholder="n (e.g. 264 nights)"
          onChange={(e) => setN(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          style={{ ...FIELD, flex: 1, minWidth: 0, padding: "4px 8px", fontFamily: MONO, fontSize: 11 }}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button type="button" style={PRIMARY} disabled={claim.trim().length === 0 || state.kind === "saving"} onClick={() => void save()}>
          {state.kind === "saving" ? "Filing…" : "File"}
        </button>
        <button type="button" style={QUIET_BUTTON} onClick={onClose}>
          Cancel
        </button>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10.5,
            color: state.kind === "error" ? "var(--tone-rose)" : "var(--text-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={state.kind === "error" ? state.why : undefined}
        >
          {state.kind === "saved"
            ? `filed on ${threadTitle}'s page`
            : state.kind === "error"
              ? `not filed — ${state.why}`
              : `on ${threadTitle}'s page`}
        </span>
      </div>
    </div>
  );
}
