// THE LANE PAGE (SWIT-108) — a body of work inside one project, from the
// one-platform mock's `lane` scene (V1 is its Overview only — no tabs). Eric:
// "Lanes: brief + findings + reports". Opening a lane answers "where did we
// leave off" without asking anyone: the brief, the findings, the reports, the
// decisions and the threads, every block a VIEW over what the lane's threads
// already wrote (lanes.laneRollup) — nothing here is typed into the lane.
//
//   header    lane name · project · `+ Thread in this lane` (the one action);
//             rename · archive/restore as quiet text links beside it
//   Brief     the NEWEST brief among the lane's threads, with the thread that
//             wrote it and when; absent → one plain line (requirement 2.3)
//   Findings  every thread's ledger, newest first; the report opens like an
//             Evidence address resolved against THAT finding's thread
//   Reports   the project's reports built in the lane (the index's threadId)
//   Decisions open questions, unsent batches, then recently answered — each
//             opens its own thread's page (decisions are answered THERE)
//   Threads   status dot · title · last activity; archived folded
//
// Its own poll while on screen only (Home's rule, the same 5s) — the page
// files of the lane's threads, archived ones included (principle 4).

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Thread } from "../types";
import { BackButton } from "./BackButton";
import { MONO, READING, PRIMARY, TEXT_LINK, FIELD } from "./kit";
import { PageBlock, ColumnHeads, StatusPill, Age, Fold, FINDING_GRID } from "./kb/PageBlock";
import { BriefBlock, AddressButton, EvidenceAddress } from "./kb/PageView";
import { STATUS_CONFIGS } from "../lib/statusConfig";
import {
  useThreadsView,
  getThreadActions,
  isThreadArchived,
  relativeActivity,
  sortThreadsForHistory,
} from "../lib/threadStore";
import { deriveLanes, findLane, laneReports, laneRollup, type Lane, type LaneRef } from "../lib/lanes";
import { readThreadDigest } from "../lib/threadDigest";
import type { PageFinding, RenderedPage } from "../lib/pageStore";
import { requestPageFocus } from "../lib/pageStore";
import { verdictTone } from "../lib/statusPill";
import { getProjectViews, getRegistryProjects, refreshRepoKb, useRepoListings } from "../lib/repoListing";
import { projectPlaceForDir } from "../lib/explorer";
import { resolveOpenable } from "../lib/nextThing";
import { getCachedDocList, noteKbMiss, resolveWithFreshKbDocs, subscribeDocList } from "../lib/kb";
import { projectViewOfAddress, viewAnchorOfAddress } from "../lib/evidenceModel";
import { activatePageTab, getActiveTabSession, openArtifact, openInPanel } from "../lib/panelStore";
import { requestReportAnchor } from "../lib/reportStore";
import { viewOwnerKey } from "../lib/viewStore";
import { navigate } from "../lib/route";

/** The lane page re-reads its threads' files at Home's cadence, on screen only. */
const LANE_POLL_MS = 5_000;
const EXITED_COLOR = STATUS_CONFIGS.exited.color;

const DIM: CSSProperties = { fontFamily: MONO, fontSize: 10, color: "var(--text-faint)" };
const ROW: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  width: "100%",
  padding: "7px 0",
  background: "none",
  borderTop: "none",
  borderLeft: "none",
  borderRight: "none",
  borderBottom: "1px solid var(--border)",
  fontFamily: READING,
  fontSize: 12.5,
  lineHeight: 1.45,
  color: "var(--text-primary)",
  textAlign: "left",
};

export function LaneView({ project, lane: laneName, active }: { project: string; lane: string; active: boolean }) {
  const view = useThreadsView();
  const lanes = useMemo(() => deriveLanes(view.threads, view.laneRecords), [view.threads, view.laneRecords]);
  const lane = findLane(lanes, { project, name: laneName });
  const [digests, setDigests] = useState<ReadonlyMap<string, RenderedPage>>(new Map());
  useRepoListings();

  // ONE poll for the page, on screen only: every lane thread's merged page
  // (archived ones too — archived is not gone). A failed read keeps the
  // thread's previous digest.
  const threadKey = lane ? lane.threads.map((t) => t.id).join(",") : "";
  useEffect(() => {
    if (!active || !lane) return;
    let cancelled = false;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = new Map<string, RenderedPage>();
        for (const t of lane.threads) {
          try {
            next.set(t.id, (await readThreadDigest(t.id)).page);
          } catch {
            // this thread's slice degrades; the rest render
          }
          if (cancelled) return;
        }
        refreshRepoKb();
        setDigests((prev) => {
          const merged = new Map(prev);
          for (const [k, v] of next) merged.set(k, v);
          return merged;
        });
      } finally {
        busy = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), LANE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // threadKey: the poll re-arms when the lane's membership changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, threadKey]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [active]);

  if (!lane) {
    return (
      <Frame project={project} laneName={laneName}>
        <div style={{ ...DIM, fontSize: 11, padding: "18px 0" }}>
          No lane named {laneName} in {project} — it was renamed, or its last thread left it.
        </div>
      </Frame>
    );
  }
  const rollup = laneRollup(lane.threads, digests, view.launched, now);
  const knownIds = new Set(view.threads.map((t) => t.id));
  const reports = laneReports(getProjectViews(lane.project) ?? [], lane, knownIds);
  const nothingWritten = rollup.brief === null && rollup.findings.length === 0 && reports.length === 0;

  return (
    <Frame project={lane.project} laneName={lane.name} lane={lane}>
      <LaneHead lane={lane} />
      {rollup.brief ? (
        <BriefBlock
          brief={rollup.brief.brief}
          isNew={false}
          title="Brief"
          note={
            <>
              rewritten <Age at={rollup.brief.brief.updatedAt} /> by {rollup.brief.thread.title}
            </>
          }
        />
      ) : (
        // Requirement 2.3 / edge case 7: no brief yet — no block, one plain
        // line; the next thread started in the lane is told to write one.
        <div style={{ ...DIM, fontSize: 11 }}>
          {nothingWritten ? "Nothing written yet — the brief is written by the lane's threads." : "No brief yet — the lane's threads write it."}
        </div>
      )}
      {rollup.findings.length > 0 && <LaneFindings rows={rollup.findings} />}
      {reports.length > 0 && (
        <PageBlock title="Reports">
          {reports.map((r) => {
            const thread = view.threads.find((t) => t.id === r.threadId);
            return (
              <button
                key={r.id}
                type="button"
                className="page-block-row"
                title={`view:${r.project}/${r.id} — opens beside the active thread (Ctrl: full width)`}
                onClick={(e) => openArtifact({ kind: "view", project: r.project, viewId: r.id }, { modifier: e.ctrlKey || e.metaKey })}
                style={{ ...ROW, cursor: "pointer" }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                {/* Edge case 6: a report whose thread was deleted shows no thread. */}
                {thread && <span style={{ ...DIM, flex: "none", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{thread.title}</span>}
                <span style={{ ...DIM, flex: "none" }}>{r.kind}</span>
                <span style={{ flex: "none", width: 40, textAlign: "right" }}>
                  <Age at={r.builtAt} />
                </span>
              </button>
            );
          })}
        </PageBlock>
      )}
      {(rollup.openQuestions.length > 0 || rollup.unsent.length > 0 || rollup.answered.length > 0) && (
        <PageBlock title="Decisions" note="answered on their own thread's page">
          {rollup.openQuestions.map(({ thread, question }) => (
            <DecisionRow key={`${thread.id}-${question.id}`} thread={thread} text={question.text} pill="open" />
          ))}
          {rollup.unsent.map(({ thread, count }) => (
            <DecisionRow
              key={`${thread.id}-unsent`}
              thread={thread}
              text={`${count} decision${count === 1 ? "" : "s"} saved, not sent yet`}
              pill="unsent"
            />
          ))}
          {rollup.answered.length > 0 && (
            <Fold label="recently answered" count={rollup.answered.length}>
              {rollup.answered.map(({ thread, settled }) => (
                <DecisionRow
                  key={`${thread.id}-${settled.question.id}-done`}
                  thread={thread}
                  text={`${settled.question.text} → ${settled.by === "user" ? "you: " : "settled: "}${settled.answer}`}
                  pill={null}
                />
              ))}
            </Fold>
          )}
        </PageBlock>
      )}
      <LaneThreads lane={lane} now={now} />
    </Frame>
  );
}

/** The 36px header bar (the full-width screens' shape) over one column. */
function Frame({ project, laneName, lane, children }: { project: string; laneName: string; lane?: Lane; children: ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        style={{
          height: 36,
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 14px",
          borderBottom: "1px solid var(--border)",
          fontFamily: MONO,
          fontSize: 11.5,
          color: "var(--text-dim)",
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <BackButton />
        <span>{project}</span>
        <span>/</span>
        <span style={{ color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis" }}>{laneName}</span>
        {lane && <LaneAdmin lane={lane} />}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div style={{ maxWidth: 820, padding: "14px 20px 28px", display: "flex", flexDirection: "column", gap: 18, fontFamily: READING, fontSize: 12, color: "var(--text-secondary)" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Title · project · the one action. */
function LaneHead({ lane }: { lane: Lane }) {
  const archived = lane.archivedAt !== null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      <h1 style={{ margin: 0, fontFamily: READING, fontSize: 17, fontWeight: 600, lineHeight: 1.25, color: "var(--text-primary)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {lane.name}
      </h1>
      <span style={{ ...DIM, fontSize: 10.5 }}>{lane.project}</span>
      {archived && <StatusPill word="archived" tone="dim" />}
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={() => getThreadActions()?.createThreadInLane({ project: lane.project, name: lane.name })}
        title="Start a thread in this lane's project — it reads the lane's brief, findings, reports and open questions first"
        style={{ ...PRIMARY, flex: "none" }}
      >
        + Thread in this lane
      </button>
    </div>
  );
}

/** rename · archive / restore — quiet text links in the header bar. Rename
 *  is an inline box; a refused name (one the project already has) keeps the
 *  box and says why in one line. */
function LaneAdmin({ lane }: { lane: Lane }) {
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState(lane.name);
  const [error, setError] = useState<string | null>(null);
  const ref: LaneRef = { project: lane.project, name: lane.name };
  const archived = lane.archivedAt !== null;
  const commit = () => {
    const reason = getThreadActions()?.renameLane(ref, value) ?? "the app is not ready";
    if (reason === null) {
      setRenaming(false);
      setError(null);
    } else setError(reason);
  };
  return (
    <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
      {renaming ? (
        <>
          <input
            autoFocus
            value={value}
            aria-label="Lane name"
            title={error ?? undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setRenaming(false);
                setError(null);
              }
            }}
            style={{ ...FIELD, width: 200, padding: "2px 8px", fontSize: 11.5, borderColor: error ? "var(--tone-rose)" : "var(--border)" }}
          />
          {error && <span style={{ ...DIM, color: "var(--tone-rose)", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>{error}</span>}
        </>
      ) : (
        <button
          type="button"
          style={{ ...TEXT_LINK, marginTop: 0 }}
          title="Rename the lane — every thread in it follows"
          onClick={() => {
            setValue(lane.name);
            setRenaming(true);
          }}
        >
          rename
        </button>
      )}
      <button
        type="button"
        style={{ ...TEXT_LINK, marginTop: 0 }}
        title={archived ? "Put the lane back on Home and in the side menu" : "Hide the lane from Home and the side menu — its threads are untouched"}
        onClick={() => getThreadActions()?.setLaneArchived(ref, !archived)}
      >
        {archived ? "restore" : "archive"}
      </button>
    </span>
  );
}

/** Findings from every lane thread, newest first — the page's own grid and
 *  pill; the report link resolves against the FINDING'S thread. */
function LaneFindings({ rows }: { rows: { thread: Thread; finding: PageFinding }[] }) {
  return (
    <PageBlock title="Findings">
      <ColumnHeads grid={FINDING_GRID} labels={["Verdict", "Claim", "n", "Report", { label: "Updated", right: true }]} />
      {rows.map(({ thread, finding: f }) => (
        <div
          key={`${thread.id}-${f.id}`}
          className="page-block-row"
          style={{ display: "grid", ...FINDING_GRID, columnGap: 11, alignItems: "center", padding: "7px 0", borderBottom: "1px solid var(--border)" }}
        >
          <span style={{ minWidth: 0 }}>
            <StatusPill word={f.verdict} tone={verdictTone(f.verdict)} />
          </span>
          <span title={`${f.claim} — ${thread.title}`} style={{ minWidth: 0, fontSize: 12.5, lineHeight: 1.45, color: "var(--text-primary)" }}>
            {f.claim} <span style={DIM}>{thread.title}</span>
          </span>
          <span title={f.n ?? undefined} style={{ minWidth: 0, fontFamily: MONO, fontSize: 10.5, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {f.n ?? "—"}
          </span>
          <span style={{ minWidth: 0, overflow: "hidden" }}>{f.report ? <ReportLink thread={thread} address={f.report} /> : null}</span>
          <Age at={f.updatedAt} />
        </div>
      ))}
    </PageBlock>
  );
}

/** A finding's report, opened as its own page would open it: a project view
 *  needs no thread; a thread view opens beside the active thread (the view is
 *  the finding's thread's); anything else through THE resolver with that
 *  thread's place in its project. */
function ReportLink({ thread, address }: { thread: Thread; address: string }) {
  const kbDocs: readonly string[] | null = useSyncExternalStore(subscribeDocList, getCachedDocList);
  const projects = getRegistryProjects().projects;
  const place = useMemo(() => (projects ? projectPlaceForDir(projects, thread.workingDir) : null), [projects, thread.workingDir]);
  const pview = projectViewOfAddress(address);
  if (pview) {
    return (
      <AddressButton
        text={address}
        title="open this project report beside the active thread (Ctrl: full width)"
        fontSize={10.5}
        onOpen={(modifier) => {
          const artifact = { kind: "view" as const, project: pview.project, viewId: pview.viewId };
          if (pview.anchor) requestReportAnchor(viewOwnerKey(artifact), artifact.viewId, pview.anchor);
          openArtifact(artifact, { modifier });
        }}
      />
    );
  }
  const tview = viewAnchorOfAddress(address);
  if (tview) {
    return (
      <AddressButton
        text={address}
        title={`open ${thread.title}'s view beside the active thread`}
        fontSize={10.5}
        onOpen={() => {
          const host = getActiveTabSession();
          if (!host) return;
          if (tview.anchor) requestReportAnchor(thread.id, tview.viewId, tview.anchor);
          openInPanel(host, { kind: "view", threadId: thread.id, viewId: tview.viewId }, { preview: true });
          navigate({ screen: "terminal" });
        }}
      />
    );
  }
  const ctx = { threadId: thread.id, kbDocs, projectKey: place?.key ?? null, pathPrefix: place?.prefix ?? "", onKbMiss: noteKbMiss };
  const target = resolveOpenable(address, ctx);
  return (
    <EvidenceAddress
      address={address}
      target={target}
      fontSize={10.5}
      lateTarget={
        target?.kind === "repo-file"
          ? () => resolveWithFreshKbDocs((docs, onKbMiss) => resolveOpenable(address, { ...ctx, kbDocs: docs, onKbMiss }))
          : undefined
      }
    />
  );
}

/** One decision line — the question (or the unsent batch), its thread dim
 *  beside it, a pill; the row opens the thread's page, where it is answered
 *  (requirement 2.6 — the lane lists, the page answers). */
function DecisionRow({ thread, text, pill }: { thread: Thread; text: string; pill: "open" | "unsent" | null }) {
  const [hover, setHover] = useState(false);
  const open = useCallback(() => {
    getThreadActions()?.openThread(thread.id);
    if (thread.sessionId) activatePageTab(thread.sessionId);
    requestPageFocus(thread.id, "decisions");
  }, [thread.id, thread.sessionId]);
  return (
    <button
      type="button"
      className="page-block-row"
      onClick={open}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Answer it on ${thread.title}'s page`}
      style={{ ...ROW, cursor: "pointer", color: hover ? "var(--text-primary)" : "var(--text-secondary)" }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ color: "var(--text-primary)" }}>{text}</span> <span style={DIM}>{thread.title}</span>
      </span>
      {pill && (
        <span style={{ flex: "none", width: 74, display: "flex", alignSelf: "center" }}>
          <StatusPill word={pill === "open" ? "open" : "not sent"} tone="amber" />
        </span>
      )}
    </button>
  );
}

/** Every thread in the lane: status dot · title · last activity; archived
 *  ones behind a fold. The row opens (or revives) the thread. */
function LaneThreads({ lane, now }: { lane: Lane; now: number }) {
  const view = useThreadsView();
  const live = lane.threads.filter((t) => !isThreadArchived(t));
  const archived = lane.threads.filter((t) => isThreadArchived(t));
  const row = (t: Thread) => <LaneThreadRow key={t.id} thread={t} now={now} />;
  return (
    <PageBlock title="Threads">
      {sortThreadsForHistory(live, view.launched).map(row)}
      {archived.length > 0 && (
        <Fold label="archived" count={archived.length}>
          {sortThreadsForHistory(archived, view.launched).map(row)}
        </Fold>
      )}
    </PageBlock>
  );
}

function LaneThreadRow({ thread, now }: { thread: Thread; now: number }) {
  const view = useThreadsView();
  const [hover, setHover] = useState(false);
  const live = view.launched.has(thread.id);
  const status = thread.sessionId ? view.sessionStatuses[thread.sessionId] : undefined;
  const dot = live && status ? STATUS_CONFIGS[status].color : EXITED_COLOR;
  return (
    <button
      type="button"
      className="page-block-row"
      onClick={() => getThreadActions()?.openThread(thread.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={thread.workingDir}
      style={{ ...ROW, alignItems: "center", cursor: "pointer", color: hover ? "var(--text-primary)" : "var(--text-secondary)" }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", backgroundColor: dot }} />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{thread.title}</span>
      <span style={{ ...DIM, flex: "none" }}>{relativeActivity(thread.lastActivityAt, now)}</span>
    </button>
  );
}
