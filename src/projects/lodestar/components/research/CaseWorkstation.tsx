/**
 * The workstation VIEWPORT (owner's consistent model): the right panel where you
 * OPEN artifacts to work on them. Nothing is stored here — it opens evidence / notes /
 * artifacts that LIVE in the left home, as tabs. Close a tab and the item stays left.
 */

import { useState } from "react";
import { useSurfaceNav } from "../../../../surfaces/page-api";
import { useUiStore } from "../../stores/uiStore";
import { api, type Case, type CasePin } from "../../api/client";
import { DataModal, PinCard, tickerFromPin } from "./ArtifactPane";
import { PatternResultView, isPatternResult, isInstanceAnalysis, isHypotheses } from "./DataView";
import InstanceAnalysisView from "./InstanceAnalysisView";
import HypothesesView from "./HypothesesView";
import WorkbenchGrid from "./WorkbenchGrid";
import Markdown from "../Markdown";
import { STREAM_COLOR } from "./streamTheme";

/** A reference to something living in the left home, opened into the viewport. */
export interface ArtifactRef {
  key: string; // stable tab key
  kind: "evidence" | "note" | "artifact";
  id: string; // pin_id | note_id | workbench index (as string)
}

type Widget = { type: string; params: Record<string, unknown>; title?: string };

/** Stable content key for a workbench widget, so an open artifact tab follows the
 *  same widget when the agent REORDERS/recomposes the workbench (an index would
 *  silently render a different widget — review finding). */
export function widgetSig(w: Widget): string {
  const s = JSON.stringify(w.params ?? {});
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${w.type}::${w.title ?? ""}::${h}`;
}

function Gone() {
  return <div className="text-xs text-dim">this item was removed — close the tab.</div>;
}

export default function CaseWorkstation({
  c,
  open,
  activeKey,
  onSelect,
  onClose,
  onCaseChanged,
  onPromoteWidget,
  isWidgetEvidence,
}: {
  c: Case;
  open: ArtifactRef[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onCaseChanged: (updated: Case) => void;
  /** Promote an artifact (workbench widget) up to evidence — the ladder's first rung. */
  onPromoteWidget?: (w: Widget) => void;
  isWidgetEvidence?: (w: Widget) => boolean;
}) {
  const nav = useSurfaceNav();
  const setPendingMarket = useUiStore((s) => s.setPendingMarket);
  const [dataPin, setDataPin] = useState<CasePin | null>(null);
  const color = STREAM_COLOR[c.stream];
  const active = open.find((o) => o.key === activeKey) ?? open[open.length - 1] ?? null;

  const widgetAt = (id: string): Widget | undefined => (c.workbench ?? []).find((w) => widgetSig(w) === id);
  const titleFor = (r: ArtifactRef): string => {
    if (r.kind === "evidence") return c.pins.find((p) => p.pin_id === r.id)?.title ?? "evidence";
    if (r.kind === "note") return (c.notes.find((n) => n.note_id === r.id)?.text ?? "note").slice(0, 26);
    const w = widgetAt(r.id);
    return w?.title ?? w?.type ?? "artifact";
  };
  const iconFor = (r: ArtifactRef): string => (r.kind === "note" ? "✎" : r.kind === "evidence" ? "◆" : "▤");

  const viewChartFor = (pin: CasePin): (() => void) | undefined => {
    const ticker = tickerFromPin(pin) ?? c.subject.ticker ?? null;
    if (!ticker) return undefined;
    return () => {
      // SWITCHBOARD: intent via the project store, page via the shell.
      setPendingMarket({ ticker, label: pin.title, caseId: c.case_id });
      nav.openPage("chart");
    };
  };
  const promote = async (pin: CasePin): Promise<void> => {
    const u = await api.addSynthesisBlock(c.case_id, { kind: "evidence", pin_id: pin.pin_id }).catch(() => null);
    if (u) onCaseChanged(u);
  };
  const inSynthesis = (pinId: string): boolean => (c.synthesis ?? []).some((b) => b.pin_id === pinId);

  // One card per artifact — no card-in-a-card. Widgets bring their own Frame; evidence
  // and notes get a matching soft card here.
  const card = (children: React.ReactNode): React.ReactNode => (
    <div className="rounded-lg border border-line/50 bg-surface/40 p-4">{children}</div>
  );
  const renderActive = (): React.ReactNode => {
    if (!active) return null;
    if (active.kind === "evidence") {
      const pin = c.pins.find((p) => p.pin_id === active.id);
      if (!pin) return <Gone />;
      // Pattern-search evidence renders as thumbnails + signature inline (no extra
      // click), with the pin's actions kept in a small header.
      if (isPatternResult(pin.payload)) {
        const viewChart = viewChartFor(pin);
        return card(
          <div className="space-y-3">
            <div className="flex items-baseline gap-3">
              <span className="text-sm font-medium text-text">{pin.title}</span>
              {viewChart ? (
                <button type="button" onClick={viewChart} className="font-mono text-[10px] text-accent hover:text-text">
                  view chart →
                </button>
              ) : null}
              {inSynthesis(pin.pin_id) ? (
                <span className="ml-auto font-mono text-[10px] text-dim/70">in synthesis ✓</span>
              ) : (
                <button type="button" onClick={() => void promote(pin)} className="ml-auto font-mono text-[10px] text-accent hover:text-text">
                  + synthesis
                </button>
              )}
            </div>
            <PatternResultView result={pin.payload as Record<string, unknown>} />
          </div>,
        );
      }
      if (isInstanceAnalysis(pin.payload)) {
        return card(
          <div className="space-y-3">
            <div className="flex items-baseline gap-3">
              <span className="text-sm font-medium text-text">{pin.title}</span>
              {inSynthesis(pin.pin_id) ? (
                <span className="ml-auto font-mono text-[10px] text-dim/70">in synthesis ✓</span>
              ) : (
                <button type="button" onClick={() => void promote(pin)} className="ml-auto font-mono text-[10px] text-accent hover:text-text">
                  + synthesis
                </button>
              )}
            </div>
            <InstanceAnalysisView result={pin.payload as Record<string, unknown>} />
          </div>,
        );
      }
      if (isHypotheses(pin.payload)) {
        return card(
          <div className="space-y-3">
            <div className="flex items-baseline gap-3">
              <span className="text-sm font-medium text-text">{pin.title}</span>
              {inSynthesis(pin.pin_id) ? (
                <span className="ml-auto font-mono text-[10px] text-dim/70">in synthesis ✓</span>
              ) : (
                <button type="button" onClick={() => void promote(pin)} className="ml-auto font-mono text-[10px] text-accent hover:text-text">
                  + synthesis
                </button>
              )}
            </div>
            <HypothesesView key={pin.pin_id} result={pin.payload as Record<string, unknown>} />
          </div>,
        );
      }
      return card(
        <PinCard
          pin={pin}
          color={color}
          inSynthesis={inSynthesis(pin.pin_id)}
          onExpand={setDataPin}
          onViewChart={viewChartFor(pin)}
          onPromote={() => void promote(pin)}
        />,
      );
    }
    if (active.kind === "note") {
      const note = c.notes.find((n) => n.note_id === active.id);
      if (!note) return <Gone />;
      return card(
        <div className="text-sm leading-relaxed text-text">
          <Markdown text={note.text.replace(/\\n/g, "\n")} />
        </div>,
      );
    }
    const w = widgetAt(active.id);
    if (!w) return <Gone />;
    return <WorkbenchGrid widgets={[w]} onPromote={onPromoteWidget} isPromoted={isWidgetEvidence} />;
  };

  if (open.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-dim">
        Open an item from the left — evidence, a note, or an artifact — to work on it here.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* tabs — one per open artifact */}
      <div className="mb-2 flex items-center gap-1 overflow-x-auto pb-0.5">
        {open.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => onSelect(r.key)}
            className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors ${
              active?.key === r.key
                ? "border-line bg-surface2 text-text"
                : "border-transparent text-dim hover:text-text"
            }`}
          >
            <span className="opacity-70">{iconFor(r)}</span>
            <span className="max-w-[150px] truncate">{titleFor(r)}</span>
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onClose(r.key);
              }}
              className="ml-1 font-mono text-faint hover:text-text"
            >
              ×
            </span>
          </button>
        ))}
      </div>
      {/* borderless body — the artifact's own card is the single card; wide charts
          scroll here rather than clip on the right */}
      <div className="min-h-0 flex-1 overflow-auto pt-1">{renderActive()}</div>
      {dataPin ? (
        <DataModal pin={dataPin} onClose={() => setDataPin(null)} onViewChart={viewChartFor(dataPin)} />
      ) : null}
    </div>
  );
}
