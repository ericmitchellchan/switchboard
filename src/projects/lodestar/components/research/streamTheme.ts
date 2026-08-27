/**
 * Research Desk theming (research-streams T4) — stream colors + disposition
 * chips, lifted from specs/mockups/playground-redesign.html (Direction A cards,
 * Direction B feed rail). One place so cards, rails, and panes stay consistent.
 */

import type { CaseDisposition, CaseStream, CaseSubject } from "../../api/client";

/** Domain accent per stream (mockup: --nba/--tennis/--es/--port). */
export const STREAM_COLOR: Record<CaseStream, string> = {
  mlb: "#d18f5a",      // warm orange (the mockup's sports hue)
  tennis: "#6fb38a",   // green
  trading: "#5aa6c9",  // blue
  generic: "#a78bcf",  // purple
};

export const STREAM_LABEL: Record<CaseStream, string> = {
  trading: "Trading",
  tennis: "Tennis",
  mlb: "MLB",
  generic: "General",
};

/** Disposition chip: text + tone. `pulse` marks the actively-working states. */
export const DISPOSITION_CHIP: Record<
  CaseDisposition,
  { label: string; color: string; pulse?: boolean }
> = {
  open: { label: "open", color: "#d18f5a", pulse: true },
  supported: { label: "supported", color: "#4ea96a" },
  refuted: { label: "refuted", color: "#e0645b" },
  watch: { label: "watch", color: "#7c8ce8", pulse: true },
  parked: { label: "parked", color: "#57575f" },
  traded: { label: "traded", color: "#c9a75a" },
  live: { label: "live", color: "#5ac9b0", pulse: true },
};

export const ALL_DISPOSITIONS: CaseDisposition[] = [
  "open", "supported", "refuted", "watch", "parked", "traded", "live",
];

export const ALL_STREAMS: CaseStream[] = ["trading", "tennis", "mlb", "generic"];

/** One-line subject descriptor for chips/rails ("KXNBA…", "Player X", …). */
export function subjectLine(subject: CaseSubject): string {
  switch (subject.kind) {
    case "market":
      return subject.ticker ?? subject.label ?? "market";
    case "player":
      return subject.label ?? subject.player_key ?? "player";
    case "situation":
      return subject.label ?? "situation";
    case "pattern":
      return subject.label ?? "chart pattern";
    default:
      return subject.label ?? "subject";
  }
}
