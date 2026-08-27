/**
 * Artifact pane (mockup Direction B `.artpane`): the open case's subject +
 * hypothesis header, disposition control, evidence pins (each an artcard with
 * its provenance line — tool · window · n), and notes.
 *
 * Pins are immutable snapshots; this pane only renders and appends. Every
 * pinned number keeps its provenance visible per the requirements safeguard.
 */

import { useState } from "react";
import { useSurfaceKeydown, useSurfaceNav } from "../../../../surfaces/page-api";
import { useUiStore } from "../../stores/uiStore";
import DataView from "./DataView";
import Markdown from "../Markdown";
import SituationStudyPanel from "./SituationStudyPanel";
import { api, type Case, type CasePin } from "../../api/client";
import { STREAM_COLOR } from "./streamTheme";

/** The tennis flow-anomaly scoring, explained where the numbers appear (owner
 * ask 2026-07-03). Language stays statistical — ranked, never conclusive. */
function ScoreGlossary() {
  const rows: [string, string][] = [
    ["size_z", "how unusual a trade's size is vs that market's own sized-trade history (log scale). ~2 is big, 3+ is extreme."],
    ["disagreement", "does the money back the player the match state says is LOSING? 0 = agrees with the state, 1 = fully against it."],
    ["moment score", "size_z × (1 + 2 × disagreement) — a big trade against the state scores far higher than a big trade with it. Halved when the trade's side had to be inferred."],
    ["match score", "the average of the match's top-5 moment scores — repeated unusual flow, not one print."],
    ["score_ratio (×N)", "match score vs what that market's trade count would produce by pure chance. ×1 ≈ expectable noise; higher = harder to explain by liquidity alone. This is the board's ranking number."],
    ["flagged", "moments with score ≥ 3 — the red dots on the flow chart."],
  ];
  return (
    <div className="rounded-md border border-line bg-surface2/40 p-3">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wide text-dim">
        how the scores work
      </div>
      <div className="space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[130px_1fr] gap-x-3 text-[11px]">
            <span className="font-mono text-accent">{k}</span>
            <span className="leading-relaxed text-text">{v}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 font-mono text-[9px] leading-relaxed text-dim">
        these RANK unusual flow — they never conclude anything about a person. For this
        case's specific numbers, ask the thread: "walk me through this case's scores."
      </div>
    </div>
  );
}

/** Find a Kalshi ticker (or match id) in a pin's own data — a case whose
 * subject is a PLAYER can still carry match-anchored evidence, and the chart
 * button must work from the pin, not only from the subject (owner-reported). */
export function tickerFromPin(pin: CasePin): string | null {
  const looksLikeTicker = (v: unknown): v is string =>
    typeof v === "string" && /^KX[A-Z0-9]+-[A-Z0-9]+/.test(v);
  const scan = (obj: unknown): string | null => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    for (const key of ["ticker", "match_id", "market"]) {
      if (looksLikeTicker(rec[key])) return rec[key] as string;
    }
    for (const v of Object.values(rec)) if (looksLikeTicker(v)) return v;
    return null;
  };
  return scan(pin.payload) ?? scan(pin.provenance.params) ?? null;
}

/** Fullscreen data view (owner ask 2026-07-02: "see the spreadsheet more").
 * Escape or backdrop closes. */
export function DataModal({
  pin,
  onClose,
  onViewChart,
}: {
  pin: CasePin;
  onClose: () => void;
  /** Present when the pin (or its case) anchors to a market — jumps to its chart. */
  onViewChart?: () => void;
}) {
  const [glossary, setGlossary] = useState(false);
  // SWITCHBOARD: surface-scoped, not window-scoped (page-api).
  useSurfaceKeydown((e) => {
    if (e.key === "Escape") onClose();
  });
  const p = pin.provenance;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-5xl flex-col rounded-lg border border-line bg-bg p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-baseline gap-2">
          <span className="font-mono text-[10px] uppercase text-dim">{pin.kind}</span>
          <span className="min-w-0 flex-1 text-base text-text">{pin.title}</span>
          {onViewChart ? (
            <button
              type="button"
              onClick={onViewChart}
              className="shrink-0 rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-accent hover:border-accent"
            >
              view on chart →
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setGlossary((g) => !g)}
            title="what do these scores mean?"
            className={`shrink-0 rounded-md border border-line px-2 py-0.5 font-mono text-[11px] ${
              glossary ? "border-accent text-accent" : "text-dim hover:text-text"
            }`}
          >
            ⓘ scores
          </button>
          <button type="button" onClick={onClose} className="ml-1 shrink-0 text-dim hover:text-text">✕</button>
        </div>
        {/* provenance on its own line — cramming it into the title row made the
            whole header collide (owner-reported) */}
        <div className="mb-2 font-mono text-[10px] leading-relaxed text-dim">
          {p.tool} · {p.data_window} · n={p.sample_size}
        </div>
        {glossary ? <div className="mb-2">{/* explanation above the data */}<ScoreGlossary /></div> : null}
        <div className="min-h-0 flex-1 overflow-auto rounded bg-surface2/60 p-3">
          <DataView payload={pin.payload} />
        </div>
      </div>
    </div>
  );
}

/** Humanize a provenance window like "2026-02-20..2026-03-04" -> "Feb 20 – Mar 4".
 * Free-text windows pass through untouched. */
function humanWindow(w: unknown): string {
  const s = String(w ?? "");
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(s.trim());
  if (!m) return s;
  const f = (d: string): string =>
    new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${f(m[1])} – ${f(m[2])}`;
}

/** A pin's title is composed by the agent in a regular shape for match/session
 * analyses: `SUBJECT (matchup, tournament, date): headline`. Pull those apart so
 * the card can lead with MEANING — matchup + what the anomaly IS — instead of a
 * dense one-liner that truncates (owner feedback 2026-07-03). Defensive: only
 * treats the parenthetical as match metadata when a segment actually looks like
 * a matchup or a date, so non-match titles (e.g. anomaly boards) pass through
 * whole. */
const isMatchupSeg = (s: string): boolean => /\s(vs\.?|def\.?|d\.?|beat|over)\s/i.test(` ${s} `);
const isDateSeg = (s: string): boolean =>
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b|\b(19|20)\d{2}\b/i.test(s);

interface AnalysisMeta {
  date: string | null;
  tournament: string | null;
  main: string; // the headline identity — matchup, or the subject/title
  category: string | null; // what this analysis highlights (the agent's headline)
  summary: string | null; // the fuller detail paragraph
}

export function parseAnalysisMeta(pin: CasePin): AnalysisMeta {
  const title = pin.title ?? "";
  const payload =
    pin.payload && typeof pin.payload === "object" && !Array.isArray(pin.payload)
      ? (pin.payload as Record<string, unknown>)
      : {};
  const headline = typeof payload.headline === "string" ? payload.headline.trim() || null : null;
  const summary = typeof payload.summary === "string" ? payload.summary.trim() || null : null;

  // Split the short takeaway off after the first ": " (the agent writes
  // "<matchup — tournament, date>: <takeaway>"); the rest is the identity head.
  let head = title;
  let category: string | null = null;
  const colonIdx = title.indexOf(": ");
  if (colonIdx > 0 && colonIdx < 96) {
    head = title.slice(0, colonIdx);
    category = title.slice(colonIdx + 2).trim() || null;
  }

  let matchup: string | null = null;
  let tournament: string | null = null;
  let date: string | null = null;

  const paren = /^\s*([^(]*?)\s*\(([^)]*)\)\s*$/.exec(head);
  if (paren) {
    // "SUBJECT (matchup, tournament, date)"
    const segs = paren[2].split(",").map((s) => s.trim()).filter(Boolean);
    matchup = segs.find(isMatchupSeg) ?? null;
    date = segs.find(isDateSeg) ?? null;
    tournament = segs.filter((s) => s !== matchup && s !== date).join(" · ") || null;
    if (!matchup) matchup = paren[1].trim() || null;
  } else if (/\s[—–]\s/.test(head)) {
    // "matchup — tournament, date"
    const parts = head.split(/\s[—–]\s/);
    matchup = parts[0].trim() || null;
    const segs = parts.slice(1).join(" ").split(",").map((s) => s.trim()).filter(Boolean);
    date = segs.find(isDateSeg) ?? null;
    tournament = segs.filter((s) => s !== date).join(" · ") || null;
  } else {
    matchup = head.trim() || null;
  }

  // The card leads with the short takeaway; the fuller headline/summary live in
  // "view data" so the face stays scannable (owner: "text-heavy, compressed").
  return { date, tournament, main: matchup || title, category: category ?? headline, summary };
}

export function PinCard({
  pin,
  color,
  inSynthesis,
  onExpand,
  onViewChart,
  onPromote,
}: {
  pin: CasePin;
  color: string;
  /** already promoted into the synthesis? */
  inSynthesis: boolean;
  onExpand: (pin: CasePin) => void;
  onViewChart?: () => void;
  /** promote this evidence up into the synthesis (the report). */
  onPromote?: () => void;
}) {
  const p = pin.provenance;
  const { date, tournament, main, category } = parseAnalysisMeta(pin);

  // De-densified (owner: "text-heavy, all condensed, compressed" + "green line
  // isn't doing much"): no rule, one takeaway line (the full read is in "view
  // data"), and real breathing room between the tiers.
  return (
    <div>
      {(date || tournament) ? (
        <div className="mb-1 flex items-baseline gap-2">
          {date ? <span className="font-mono text-[9px] uppercase tracking-wide text-dim">{date}</span> : null}
          {tournament ? (
            <span className="min-w-0 truncate font-mono text-[9px] uppercase tracking-wide" style={{ color }}>
              {tournament}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 font-mono text-[9px] text-dim">
            {new Date(pin.ts).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        </div>
      ) : null}
      {/* the matchup / subject — the identity, wraps, never truncates */}
      <div className="text-sm font-medium leading-snug text-text">{main}</div>
      {/* one short takeaway — clamped so the card stays scannable */}
      {category ? (
        <p
          className="mt-1 text-xs leading-relaxed text-dim"
          style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
          title={category}
        >
          {category}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-4">
        {onViewChart ? (
          <button
            type="button"
            onClick={onViewChart}
            className="shrink-0 whitespace-nowrap font-mono text-[10px] text-accent transition-colors hover:text-text"
          >
            view chart →
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => onExpand(pin)}
          className="shrink-0 whitespace-nowrap font-mono text-[10px] text-dim transition-colors hover:text-text"
        >
          view data
        </button>
        {onPromote ? (
          inSynthesis ? (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-dim/70">in synthesis ✓</span>
          ) : (
            <button
              type="button"
              onClick={onPromote}
              title="promote this evidence into the synthesis (the report)"
              className="ml-auto shrink-0 whitespace-nowrap font-mono text-[10px] text-accent transition-colors hover:text-text"
            >
              + synthesis
            </button>
          )
        ) : null}
      </div>
      <div
        className="mt-1.5 truncate font-mono text-[9px] text-dim/70"
        title={`${String(p.tool)} · ${String(p.data_window)} · n=${String(p.sample_size)}`}
      >
        {humanWindow(p.data_window)} · n={Number(p.sample_size).toLocaleString?.() ?? p.sample_size}
      </div>
    </div>
  );
}

export default function ArtifactPane({
  c,
  onCaseChanged,
}: {
  c: Case;
  onCaseChanged: (updated: Case) => void;
}) {
  const [noteText, setNoteText] = useState("");
  const [tab, setTab] = useState<"evidence" | "notes" | "study">("evidence");
  const nav = useSurfaceNav();
  const setPendingMarket = useUiStore((s) => s.setPendingMarket);
  // A case anchored to a market/match can jump straight to its chart view
  // (owner ask 2026-07-03: "click on this and view it in a chart view").
  // Player-subject cases carry match-anchored PINS, so the target can come
  // from the pin's own data when the subject has no ticker.
  // Dedicated FOCUS page (owner ask 2026-07-03): a case's chart opens
  // full-page — no Markets browse rail. The case id rides along so the page
  // shows the workbench and annotations land on this case.
  const gotoChart = (ticker: string, lbl: string): void => {
    // SWITCHBOARD: intent via the project store, page via the shell.
    setPendingMarket({ ticker, label: lbl, caseId: c.case_id });
    nav.openPage("chart");
  };
  const viewOnChartFor = (pin: CasePin): (() => void) | undefined => {
    const tkr = tickerFromPin(pin) ?? c.subject.ticker;
    return tkr ? () => gotoChart(tkr, pin.title) : undefined;
  };
  const [expandedPin, setExpandedPin] = useState<CasePin | null>(null);
  const color = STREAM_COLOR[c.stream];

  const addNote = async (): Promise<void> => {
    const text = noteText.trim();
    if (!text) return;
    setNoteText("");
    const updated = await api.addCaseNote(c.case_id, text).catch(() => null);
    if (updated) onCaseChanged(updated);
  };

  // Promote a pin up the ladder into the synthesis (the report).
  const promotePin = async (pin: CasePin): Promise<void> => {
    const updated = await api
      .addSynthesisBlock(c.case_id, { kind: "evidence", pin_id: pin.pin_id })
      .catch(() => null);
    if (updated) onCaseChanged(updated);
  };
  const promotedPinIds = new Set((c.synthesis ?? []).map((b) => b.pin_id).filter(Boolean));

  return (
    <div className="flex min-h-0 flex-col">
      {/* Evidence panel — the case's overview + conversation switcher live in the
          rail now; this pane is the detailed evidence feed, side-by-side with the
          chat (workspace redesign · Stage 1 "Investigate"). */}
      <div className="flex gap-1 border-b border-line">
        {([...(c.stream === "mlb" ? (["study"] as const) : []), "evidence", "notes"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-2 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors ${
              tab === k ? "border-accent text-text" : "border-transparent text-dim hover:text-text"
            }`}
          >
            {k}{k === "study" ? "" : ` · ${k === "evidence" ? c.pins.length : c.notes.length}`}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-3">
        {tab === "study" ? (
          <SituationStudyPanel
            onPin={async (title, payload, provenance) => {
              const updated = await api.pinToCase(c.case_id, {
                kind: "analysis",
                title,
                payload,
                provenance: provenance as CasePin["provenance"],
              });
              onCaseChanged(updated);
            }}
          />
        ) : tab === "evidence" ? (
          c.pins.length === 0 ? (
            <div className="text-xs text-dim">
              No evidence yet — ask the agent to analyze and pin its findings.
            </div>
          ) : (
            [...c.pins].reverse().map((pin) => (
              <PinCard
                key={pin.pin_id}
                pin={pin}
                color={color}
                inSynthesis={promotedPinIds.has(pin.pin_id)}
                onExpand={setExpandedPin}
                onViewChart={viewOnChartFor(pin)}
                onPromote={() => void promotePin(pin)}
              />
            ))
          )
        ) : c.notes.length === 0 ? (
          <div className="text-xs text-dim">No notes yet.</div>
        ) : (
          [...c.notes].reverse().map((n) => (
            <div key={n.note_id} className="border-l border-line pl-3 text-xs leading-relaxed text-text">
              <Markdown text={n.text.replace(/\\n/g, "\n")} />
            </div>
          ))
        )}
      </div>

      {/* add note */}
      <div className="flex items-center gap-2 border-t border-line pt-2">
        <input
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addNote();
          }}
          placeholder="add a note…"
          className="flex-1 bg-transparent text-xs text-text placeholder:text-dim focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void addNote()}
          disabled={!noteText.trim()}
          className="font-mono text-[11px] text-accent disabled:opacity-40"
        >
          + note
        </button>
      </div>
      {expandedPin ? (
        <DataModal
          pin={expandedPin}
          onClose={() => setExpandedPin(null)}
          onViewChart={viewOnChartFor(expandedPin)}
        />
      ) : null}
    </div>
  );
}
