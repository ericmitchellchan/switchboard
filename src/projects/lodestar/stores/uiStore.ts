/**
 * UI store: current view, the screen context the ambient agent "sees", and the
 * open/closed state of the Ctrl+I ambient popup.
 */

import { create } from "zustand";
import type { ScreenContext } from "../types/lodestar";
import type { BacktestResult, HypLevels, Hypothesis } from "../api/client";

/** Everything the hypothesis report page needs — captured when it's opened as a page. */
export interface ReportCtx {
  hypothesis: Hypothesis;
  levels: HypLevels | null;
  note: string | null;
  symbol: string;
  timeframe: string;
  window: { start: string; end: string } | null;
  backtest: BacktestResult | null;
  caseId: string | null;
}

interface UiState {
  /** Active route/view id, e.g. "portfolio". */
  currentView: string;
  /** Human label for the current view, e.g. "Portfolio". */
  currentLabel: string;
  /** Whether the ambient (Ctrl+I) popup is open. */
  ambientOpen: boolean;
  /** Thread to open in the Playground (set by "Promote to thread"). */
  selectedThreadId: string | null;
  /** Case to open in the Playground (set by app-wide pattern intake, Decided #7d). */
  pendingCaseId: string | null;
  /** Desk tab the Playground should open on ("cases" | "tdash" | "sdash" | "new").
   *  Lets another surface (the Overview) drill INTO a specific desk tab instead
   *  of always landing on the case library. Consumed once, then cleared. */
  pendingDeskTab: string | null;
  /** Market to open in Markets (set by a case's "view on chart"). */
  /** SWITCHBOARD: `caseId` rides along so the Chart page can open a case's
   *  market WITH its case (the query string that carried it is gone). */
  pendingMarket: { ticker: string; label: string; caseId?: string } | null;
  /** Active market ticker (set when a market is selected), for sport-aware agent framing. */
  activeTicker: string | null;
  /** A chart image handed to the shell to start Vision Assist (e.g. the New-case tile's
   *  file picker). Layout consumes it → the pattern-intake modal. */
  intakeFile: File | null;
  /** The hypothesis report open as an in-platform PAGE (nav rail stays), or null. */
  reportCtx: ReportCtx | null;

  setView: (view: string, label: string) => void;
  setAmbientOpen: (open: boolean) => void;
  toggleAmbient: () => void;
  setSelectedThread: (id: string | null) => void;
  setPendingCase: (id: string | null) => void;
  setPendingDeskTab: (tab: string | null) => void;
  setPendingMarket: (m: { ticker: string; label: string; caseId?: string } | null) => void;
  setActiveTicker: (ticker: string | null) => void;
  setIntakeFile: (f: File | null) => void;
  openReport: (ctx: ReportCtx) => void;
  closeReport: () => void;
  /** The context the agent should be told about. */
  screenContext: () => ScreenContext;
}

export const useUiStore = create<UiState>((set, get) => ({
  currentView: "command",
  currentLabel: "Command",
  ambientOpen: false,
  selectedThreadId: null,
  pendingCaseId: null,
  pendingDeskTab: null,
  pendingMarket: null,
  activeTicker: null,
  intakeFile: null,
  reportCtx: null,

  setView: (view, label) => set({ currentView: view, currentLabel: label }),
  setAmbientOpen: (open) => set({ ambientOpen: open }),
  toggleAmbient: () => set((s) => ({ ambientOpen: !s.ambientOpen })),
  setSelectedThread: (id) => set({ selectedThreadId: id }),
  setPendingCase: (id) => set({ pendingCaseId: id }),
  setPendingDeskTab: (tab) => set({ pendingDeskTab: tab }),
  setPendingMarket: (m) => set({ pendingMarket: m }),
  setActiveTicker: (ticker) => set({ activeTicker: ticker }),
  setIntakeFile: (f) => set({ intakeFile: f }),
  openReport: (ctx) => set({ reportCtx: ctx }),
  closeReport: () => set({ reportCtx: null }),
  screenContext: () => {
    const ticker = get().activeTicker;
    const r = get().reportCtx;
    return {
      view: get().currentView,
      label: r ? `Report: ${r.hypothesis.title}` : get().currentLabel,
      ...(ticker ? { ticker } : {}),
      ...(r
        ? {
            report: {
              title: r.hypothesis.title,
              symbol: r.symbol,
              timeframe: r.timeframe,
              leg: r.hypothesis.leg,
              caseId: r.caseId,
            },
          }
        : {}),
    };
  },
}));
