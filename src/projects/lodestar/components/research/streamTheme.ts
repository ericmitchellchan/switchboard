/**
 * Research Desk theming (research-streams T4) — stream colors + disposition
 * chips, lifted from specs/mockups/playground-redesign.html (Direction A cards,
 * Direction B feed rail). One place so cards, rails, and panes stay consistent.
 */

import type { CaseDisposition, CaseStream, CaseSubject } from "../../api/client";

/** Domain accent per stream (mockup: --nba/--tennis/--es/--port). */
export const STREAM_COLOR: Record<CaseStream, string> = {
  mlb: "#e8a27a",      // = --chart-8 (the mockup's sports hue)
  tennis: "#a8c97e",   // = --chart-6
  trading: "#7ab8e8",  // = --liq
  generic: "#a99cf0",  // = --chart-2
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
  open: { label: "open", color: "#e8a27a" /* = --chart-8 */, pulse: true },
  supported: { label: "supported", color: "#6fc492" /* = --up */ },
  refuted: { label: "refuted", color: "#e88a8a" /* = --dn */ },
  watch: { label: "watch", color: "#7ab8e8" /* = --liq (a category beside `supported` = --up; the accent is the same green) */, pulse: true },
  parked: { label: "parked", color: "#888888" /* = --dim2 */ },
  traded: { label: "traded", color: "#e8b765" /* = --chart-3 */ },
  live: { label: "live", color: "#6fc9c0" /* = --chart-4 */, pulse: true },
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
