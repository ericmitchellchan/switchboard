// THE LANES BAND of the side menu (SWIT-108, requirements §3.3 — the default
// for Open question 1): a `LANES` band ABOVE `THREADS`, in bare shell mode
// too (lanes are part of the bare set). Each project with at least one lane,
// its lanes indented beneath it, and a dim `· N` when a lane waits on Eric —
// N and its worded tooltip from THE SAME rule Home's lane pill reads
// (lanes.laneWaitingFromCounts over App's 5s-pass counts: questions and
// unsent answers from every lane thread, requests and items of his from the
// threads that are not archived — review of ec319c7, #8). A row opens the
// lane's page. Archived lanes are off the band and listed under one `N
// archived · show` fold at its foot (their count still shows), restorable
// from their page. No `+`: a lane appears when its first thread joins it
// (requirement 1.5). Nothing renders while no thread is in a lane.

import { useState } from "react";
import type { CSSProperties } from "react";
import type { Route } from "../types";
import { useThreadsView } from "../lib/threadStore";
import { deriveLanes, laneWaitingFromCounts, laneWaitsLabel, namesLane, waitingTotal, type Lane, type LaneWaiting } from "../lib/lanes";
import { navigate } from "../lib/route";
import { Fold } from "./kb/PageBlock";

const HEADER_TEXT: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  textTransform: "uppercase",
  letterSpacing: 1,
  whiteSpace: "nowrap",
  color: "var(--text-dim)",
};

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 12px",
  background: "none",
  border: "none",
  boxShadow: "none",
  color: "var(--text-secondary)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  textAlign: "left",
  cursor: "pointer",
};

export function LanesSection({ route }: { route: Route }) {
  const view = useThreadsView();
  const lanes = deriveLanes(view.threads, view.laneRecords);
  if (lanes.length === 0) return null;
  const shown = lanes.filter((l) => l.archivedAt === null);
  const archived = lanes.filter((l) => l.archivedAt !== null);
  const projects = [...new Set(shown.map((l) => l.project))];
  const isOn = (l: Lane) => route.screen === "lane" && route.project === l.project && namesLane(l, route.lane);
  const waiting = (l: Lane) =>
    laneWaitingFromCounts(l.threads, {
      questions: view.openQuestions,
      unsent: view.unsentDecisions,
      requests: view.pendingRequests,
      items: view.waitingItems,
    });
  return (
    <div>
      <div style={{ padding: "10px 12px 4px" }}>
        <span style={HEADER_TEXT}>Lanes</span>
      </div>
      {projects.map((project) => (
        <div key={project}>
          <div
            style={{
              padding: "4px 12px 1px",
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {project}
          </div>
          {shown
            .filter((l) => l.project === project)
            .map((l) => (
              <LaneRow key={`${l.project}/${l.name}`} lane={l} active={isOn(l)} waiting={waiting(l)} />
            ))}
        </div>
      ))}
      {archived.length > 0 && (
        <div style={{ padding: "0 12px" }}>
          <Fold label="archived" count={archived.length}>
            {archived.map((l) => (
              <LaneRow key={`${l.project}/${l.name}`} lane={l} active={isOn(l)} waiting={waiting(l)} archived />
            ))}
          </Fold>
        </div>
      )}
    </div>
  );
}

function LaneRow({
  lane,
  active,
  waiting,
  archived = false,
}: {
  lane: Lane;
  active: boolean;
  waiting: LaneWaiting;
  archived?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const total = waitingTotal(waiting);
  const words = laneWaitsLabel(waiting);
  return (
    <button
      type="button"
      onClick={() => navigate({ screen: "lane", project: lane.project, lane: lane.name })}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${lane.name} — ${lane.threads.length} thread${lane.threads.length === 1 ? "" : "s"}${archived ? " (archived lane)" : ""}`}
      style={{
        ...ROW,
        paddingLeft: archived ? 10 : 22,
        background: active || hover ? "var(--bg-active)" : "none",
        boxShadow: active ? "inset 2px 0 0 var(--text-primary)" : "none",
        color: archived ? "var(--text-dim)" : active || hover ? "var(--text-primary)" : "var(--text-secondary)",
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lane.name}</span>
      {total > 0 && (
        <span title={words ?? undefined} style={{ flex: "none", fontSize: 9.5, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
          · {total}
        </span>
      )}
    </button>
  );
}
