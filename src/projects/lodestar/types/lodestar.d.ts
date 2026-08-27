/**
 * SWITCHBOARD COPY — only the type the pages still use. Lodestar's original
 * also declared the Electron preload bridge (`window.lodestar`) as a global;
 * there is no such bridge here and a global augmentation would leak an
 * Electron-shaped `Window` into the whole shell, so it is gone.
 */

/** What a page tells the agent about itself (uiStore.screenContext). */
export interface ScreenContext {
  view: string;
  label?: string;
  ticker?: string;
  caseId?: string;
  caseTitle?: string;
  caseStream?: string;
  caseSubject?: string;
  caseHypothesis?: string;
  /** Set when the hypothesis report is open as a page. */
  report?: {
    title: string;
    symbol: string;
    timeframe: string;
    leg?: string | null;
    caseId?: string | null;
  };
}
