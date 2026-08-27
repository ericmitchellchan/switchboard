/**
 * CaseStudy — the case's third face (investigate · synthesize · study).
 *
 * The desk's old domain tabs (Tennis / MLB / Pitchers / Markets / Exits) folded
 * in here (desk-dashboards epic phase 2): studies happen INSIDE a case, on the
 * stream-appropriate surfaces, full width — the 480px workstation pane would
 * cramp their fixed-viewBox charts. The surfaces are self-contained; this
 * component only picks which apply to the case's stream (generic sees them all).
 *
 * The ambient render_exploration chart renders below the surface — with the
 * domain tabs gone, the study view IS the exploration surface Ctrl+I draws into.
 */

import { useEffect, useRef, useState } from "react";
import TennisExplore from "./TennisExplore";
import MlbExplore from "./MlbExplore";
import PitcherExplore from "./PitcherExplore";
import MarketsExplore from "./MarketsExplore";
import ExitSandbox from "../trading/ExitSandbox";
import WorkbenchGrid from "./WorkbenchGrid";
import { api, type CaseStream } from "../../api/client";
import { usePoll } from "../../hooks/usePoll";
import { useUiStore } from "../../stores/uiStore";

interface Surface {
  key: string;
  label: string;
  streams: CaseStream[]; // which case streams this surface studies
  render: () => React.ReactNode;
}

const SURFACES: Surface[] = [
  { key: "tennis", label: "Tennis", streams: ["tennis"], render: () => <TennisExplore /> },
  { key: "mlb", label: "Situations", streams: ["mlb"], render: () => <MlbExplore /> },
  { key: "pitchers", label: "Pitchers", streams: ["mlb"], render: () => <PitcherExplore inCase /> },
  { key: "markets", label: "Markets", streams: ["trading"], render: () => <MarketsExplore /> },
  { key: "exits", label: "Exits", streams: ["trading"], render: () => <ExitSandbox /> },
];

export default function CaseStudy({ caseId, stream }: { caseId: string; stream: CaseStream }) {
  const surfaces = SURFACES.filter((s) => stream === "generic" || s.streams.includes(stream));
  const [surfaceKey, setSurfaceKey] = useState<string | null>(null);
  const active = surfaces.find((s) => s.key === surfaceKey) ?? surfaces[0];
  // The agent draws here via render_exploration when asked (Ctrl+I) to visualize
  // something mid-study. Scratch surface — pin into the case for anything durable.
  const { data: exploreChart } = usePoll(api.getExploreChart, 2500);

  // The exploration chart is ONE global server-side surface with no case scoping.
  // Rendering it inside a case frame means a chart drawn while case A was open
  // would otherwise show up beside case B's evidence, reading as B's artifact —
  // the exact misattribution this whole epic exists to fix. So drop the stale one
  // when the case changes; the agent redraws on the next ask.
  const clearedFor = useRef<string | null>(null);
  useEffect(() => {
    if (clearedFor.current === caseId) return;
    clearedFor.current = caseId;
    void api.clearExploreChart().catch(() => undefined);
  }, [caseId]);

  // Tell the ambient agent which surface is up, so Ctrl+I ("chart this") knows
  // which domain's tools apply — the desk tabs this replaced named the surface
  // exactly ("Pitcher explore"), and the case's stream alone doesn't.
  const setView = useUiStore((s) => s.setView);
  useEffect(() => {
    if (!active) return;
    setView("playground", `Playground · Case study (${active.label}) · case=${caseId}`);
  }, [active, caseId, setView]);

  if (!active) {
    return (
      <div className="pl-6 pt-2 text-sm text-dim">
        No study surfaces for this stream yet — the exploration engines are per-domain.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pl-6 pr-1">
      {surfaces.length > 1 ? (
        <div className="mb-4 flex gap-4 border-b border-line">
          {surfaces.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSurfaceKey(s.key)}
              className={`-mb-px border-b-2 pb-2 font-mono text-[12px] transition-colors ${
                active.key === s.key
                  ? "border-accent font-medium text-text"
                  : "border-transparent text-dim hover:text-text"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
      {active.render()}

      {exploreChart?.widgets?.length ? (
        <div className="mt-4 border-t border-line/60 pt-3">
          <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-dim">
            <span className="h-1 w-1 rounded-full bg-accent" />
            composed by the agent
            {exploreChart.note ? (
              <span className="min-w-0 truncate normal-case text-dim/70">· {exploreChart.note}</span>
            ) : null}
            <button
              type="button"
              onClick={() => void api.clearExploreChart().catch(() => undefined)}
              className="ml-auto shrink-0 normal-case text-dim transition-colors hover:text-text"
            >
              clear
            </button>
          </div>
          <WorkbenchGrid widgets={exploreChart.widgets} />
        </div>
      ) : null}
    </div>
  );
}
