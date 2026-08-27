/**
 * Playground (research-streams T4). Named "Research Desk" until 2026-08-02;
 * "desk" survives below only as the internal name for the nothing-open VIEW.
 *
 * Two views over one page:
 *  - DESK (nothing open): the case library as a card grid (mockup Direction A)
 *    with stream/disposition filters, an "unfiled threads" section for
 *    free-floating threads, and "start something new" (blank case per stream +
 *    the classic starters, which stay unfiled threads).
 *  - WORKSPACE (a case or thread open): mockup Direction B's shape — feed rail
 *    (switch cases/threads) · chat center (existing thread mechanics; member-
 *    thread tabs inside a case) · artifact pane (case subject/hypothesis/
 *    disposition + evidence pins with provenance + notes; or the grounding
 *    editor + file-into-case controls for an unfiled thread).
 */

import { useEffect, useRef, useState } from "react";
import Panel from "../components/Panel";
import Markdown from "../components/Markdown";
import CaseRail from "../components/research/CaseRail";
import CaseWorkstation, { type ArtifactRef } from "../components/research/CaseWorkstation";
import SynthesisView from "../components/research/SynthesisView";
import CaseStudy from "../components/research/CaseStudy";
import { DispositionChip } from "../components/research/CaseCard";
import CaseLedger from "../components/research/CaseLedger";
import TradingDash from "../components/research/TradingDash";
import SportsDash from "../components/research/SportsDash";
import HypothesisReport from "../components/research/HypothesisReport";
import {
  ALL_STREAMS,
  STREAM_COLOR,
  STREAM_LABEL,
  subjectLine,
} from "../components/research/streamTheme";
import { usePoll } from "../hooks/usePoll";
import {
  api,
  type Case,
  type CaseDisposition,
  type CasePin,
  type CaseStream,
  type CaseSubject,
  type Thread,
} from "../api/client";
import { useUiStore } from "../stores/uiStore";
import { useSurfaceAgent } from "../../../surfaces/page-api";

/** Starting points — each launches an UNFILED thread the agent answers with its
 * tools (promote into a case any time). Grouped BY DOMAIN (req §6e). */
const STARTER_DOMAINS = ["Sports", "Traditional markets", "Portfolio"] as const;

const STARTERS: { domain: (typeof STARTER_DOMAINS)[number]; title: string; prompt: string }[] = [
  { domain: "Sports", title: "Biggest movers", prompt: "What are the biggest-moving captured markets right now? Use top_movers and summarize what drove the top few." },
  { domain: "Sports", title: "Market overview", prompt: "Give me a market overview — what's captured (by kind) and the date span. Use market_overview." },
  { domain: "Sports", title: "Analyze a game", prompt: "Find the most volatile NBA game in the captured data (top_movers), then walk me through it with get_nba_game_context — key runs, lead changes, and how the market moved." },
  { domain: "Sports", title: "Analyze a tennis match", prompt: "Find the most volatile captured tennis matches (top_movers with prefix='KXATP', then prefix='KXWTA'), pick one with real match data, and walk me through it with get_tennis_match_context — sets, breaks of serve, the biggest win-prob swings, and what the serve/return stats say about why it went that way." },
  { domain: "Traditional markets", title: "ES gamma", prompt: "Show ES dealer positioning: gamma flip, call/put walls, and vol-trigger. Use get_gamma_levels for ES and explain what it implies." },
  { domain: "Traditional markets", title: "Analyze an ES session", prompt: "Find the wildest recent ES trading sessions (list_market_sessions with order='range'), pick one with options data (has_options), and walk me through it with get_market_session_context — the day's arc, which gamma levels price crossed and when, the biggest 5-minute moves, and what spot GEX / HIRO dealer flow were doing at those moments." },
  { domain: "Traditional markets", title: "Gamma shift history", prompt: "How has dealer positioning shifted across the captured days? Use gamma_level_history for SPY and tell me when the gamma flip moved relative to spot, how the call/put walls migrated, and what that implied for the regime." },
  { domain: "Portfolio", title: "Portfolio risk", prompt: "Summarize my portfolio: positions, max-loss by asset class, gross max-loss, and any concentration flags. Use get_portfolio." },
];

/** Blank-case templates per stream (requirements Decided #7b): each pre-wires
 * the right subject kind; trading's pattern subject fills in at intake (T13). */
const CASE_TEMPLATES: { stream: CaseStream; title: string; desc: string; subject: () => CaseSubject }[] = [
  { stream: "tennis", title: "Tennis case", desc: "A player or match under suspicion — profiles, flow anomalies.", subject: () => ({ kind: "player" }) },
  { stream: "mlb", title: "MLB situation case", desc: "A game situation to condition and test (big innings, momentum).", subject: () => ({ kind: "situation", params: {} }) },
  { stream: "trading", title: "Trading pattern case", desc: "A chart pattern to hunt across history (drop a screenshot soon).", subject: () => ({ kind: "pattern" }) },
  { stream: "generic", title: "Blank case", desc: "Anchor a subject, state a hypothesis, accumulate evidence.", subject: () => ({ kind: "market" }) },
];

/** Threads are born "New thread" and, left unnamed, that label shows up in the
 * nav rail, the member-tab, and the panel header at once (owner feedback
 * 2026-07-03: confusing). Name a thread from its opening message the moment it
 * gets one, so it carries a real identity everywhere. */
const DEFAULT_THREAD_TITLES = new Set(["New thread", "thread", ""]);
function deriveThreadTitle(text: string): string {
  const firstLine = text.split("\n")[0].replace(/\s+/g, " ").trim();
  if (firstLine.length <= 48) return firstLine || "New thread";
  const cut = firstLine.slice(0, 48);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?-]+$/, "")}…`;
}

/** A live "still working" pulse — three staggered dots. Shown while the agent
 * runs so the owner can tell thinking / streaming / done apart (owner feedback
 * 2026-07-03: "I don't know if it's thinking or done"). */

/** A readable Markdown snapshot of a case — what "save to knowledge" writes into the KB
 *  (a durable, commentable copy that backlinks to the live case). */
function caseToMarkdown(c: Case): string {
  const archived = new Set(c.archived_ids ?? []);
  const lines: string[] = [`# ${c.title}`, "", `\`${c.stream} · ${c.disposition}\`${c.subject?.label ? ` — ${c.subject.label}` : ""}`, ""];
  if (c.hypothesis) lines.push("## Hypothesis", "", c.hypothesis, "");
  const notes = (c.notes ?? []).filter((n) => !archived.has(n.note_id));
  if (notes.length) {
    lines.push("## Notes", "");
    for (const n of notes) lines.push(`- ${n.text}`);
    lines.push("");
  }
  if ((c.synthesis ?? []).length) {
    lines.push("## Synthesis", "");
    for (const b of c.synthesis) {
      if (b.kind === "claim" && b.text) lines.push(b.text, "");
      else if (b.kind === "evidence") lines.push(`- **evidence:** ${c.pins.find((p) => p.pin_id === b.pin_id)?.title ?? b.pin_id}`);
    }
    lines.push("");
  }
  lines.push("---", `*Snapshot of a Lodestar case · ${c.pins.length} evidence · ${c.notes.length} notes*`);
  return lines.join("\n");
}

export default function Playground() {
  const promoted = useUiStore((s) => s.selectedThreadId);
  const setSelectedThread = useUiStore((s) => s.setSelectedThread);
  const screenContext = useUiStore((s) => s.screenContext);
  const reportCtx = useUiStore((s) => s.reportCtx);
  const closeReport = useUiStore((s) => s.closeReport);

  // Cached: returning to the Playground must not blank the rail while the
  // first poll lands (owner-reported 2026-08-02).
  const { data: threads } = usePoll(api.getThreads, 3000, undefined, "threads");
  const { data: allCases } = usePoll(() => api.listCases(), 3000, undefined, "cases");
  const setView = useUiStore((s) => s.setView);

  // Desk filters.
  const [streamFilter, setStreamFilter] = useState<CaseStream | null>(null);
  const [dispositionFilter, setDispositionFilter] = useState<CaseDisposition | null>(null);
  const [caseQuery, setCaseQuery] = useState(""); // free-text (acceptance: "searchable")
  // Desk tabs (desk-dashboards phase 2): Cases + the two curated dashboards +
  // New case. The per-domain study tabs folded into the case Study view — a
  // case is the only door into an investigation OR a study.
  const [deskTab, setDeskTab] = useState<"cases" | "tdash" | "sdash" | "new">("cases");
  // Another surface (the Overview) can drill into a SPECIFIC desk tab. Consumed
  // once and cleared, so a later plain visit still lands on the case library.
  const pendingDeskTab = useUiStore((s) => s.pendingDeskTab);
  const setPendingDeskTab = useUiStore((s) => s.setPendingDeskTab);
  useEffect(() => {
    if (!pendingDeskTab) return;
    if (["cases", "tdash", "sdash", "new"].includes(pendingDeskTab)) {
      setDeskTab(pendingDeskTab as typeof deskTab);
    }
    setPendingDeskTab(null);
  }, [pendingDeskTab, setPendingDeskTab]);

  // Workspace selection: an open case (with an active member thread) OR an
  // unfiled thread. openCase===null && selectedId===null -> desk view.
  const [openCaseId, setOpenCaseId] = useState<string | null>(null);
  const [openCase, setOpenCase] = useState<Case | null>(null);
  const [caseSavedFor, setCaseSavedFor] = useState<string | null>(null); // case id snapshotted to KB
  const [savingCase, setSavingCase] = useState(false);

  const saveCaseToKnowledge = async (): Promise<void> => {
    if (!openCase || savingCase) return;
    setSavingCase(true);
    try {
      await api.createKnowledge({
        title: openCase.title,
        body: caseToMarkdown(openCase),
        type: "research",
        tags: [openCase.stream, openCase.disposition].filter(Boolean),
        case_id: openCase.case_id,
      });
      setCaseSavedFor(openCase.case_id);
    } finally {
      setSavingCase(false);
    }
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);

  const [prompt, setPrompt] = useState("");
  const [liveText, setLiveText] = useState("");

  // Unfiled-thread grounding fields (LODE Phase 1) — edited locally, saved on blur.
  const [refTicker, setRefTicker] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [labelsText, setLabelsText] = useState("");
  const [fileIntoCaseId, setFileIntoCaseId] = useState("");
  // Resizable artifact pane (owner ask 2026-07-02): drag the divider. Pointer
  // CAPTURE keeps move/up on the handle element itself — no window listeners
  // to leak on unmount or a swallowed pointerup (review finding).
  const [paneW, setPaneW] = useState(480); // the workstation holds charts — give it room
  // The case rail (Investigate view): collapses to a spine so the conversation +
  // evidence get the room; open it to switch threads/evidence/conversations.
  const [railCollapsed, setRailCollapsed] = useState(false);
  // The case's three faces: Investigate (work), Synthesize (the report), and
  // Study (the stream's exploration surfaces, full width — phase 2).
  const [viewMode, setViewMode] = useState<"investigate" | "synthesize" | "study">("investigate");
  // Right panel = the workstation VIEWPORT: open artifacts (evidence / notes /
  // agent-composed charts) from the left home into tabs. Nothing is stored here.
  const [openArtifacts, setOpenArtifacts] = useState<ArtifactRef[]>([]);
  const [activeArtifactKey, setActiveArtifactKey] = useState<string | null>(null);
  const openArtifact = (ref: ArtifactRef): void => {
    setOpenArtifacts((prev) => (prev.some((o) => o.key === ref.key) ? prev : [...prev, ref]));
    setActiveArtifactKey(ref.key);
  };
  const closeArtifact = (key: string): void => {
    setOpenArtifacts((prev) => prev.filter((o) => o.key !== key));
    setActiveArtifactKey((cur) => {
      if (cur !== key) return cur;
      const rest = openArtifacts.filter((o) => o.key !== key);
      return rest[rest.length - 1]?.key ?? null;
    });
  };
  const dragState = useRef<{ startX: number; startW: number } | null>(null);
  const dragPane = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startW: paneW };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const dragMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const s = dragState.current;
    if (!s) return;
    setPaneW(Math.min(860, Math.max(300, s.startW + (s.startX - e.clientX))));
  };
  const dragEnd = (e: React.PointerEvent<HTMLDivElement>): void => {
    dragState.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const scrollRef = useRef<HTMLDivElement>(null);

  const caseList = allCases ?? [];
  const threadList = threads ?? [];
  const unfiled = threadList.filter((t) => !t.case_id);
  const memberThreads = openCase
    ? threadList.filter((t) => openCase.thread_ids.includes(t.thread_id))
    : [];

  // A "Promote to thread" from the ambient popup selects that thread here — and
  // opens its case when it has one. Fetched directly (the threads poll may not
  // have resolved yet on a fresh mount).
  useEffect(() => {
    if (!promoted) return;
    api
      .getThread(promoted)
      .then((t) => {
        if (t.case_id) setOpenCaseId(t.case_id);
        // land on the conversation that was just promoted, not whichever face
        // happened to be open last (study/synthesize both hide the chat)
        setViewMode("investigate");
        setSelectedId(promoted);
      })
      .catch(() => setSelectedId(promoted));
    setSelectedThread(null);
  }, [promoted, setSelectedThread]);

  // Load the open case. Cleared immediately on switch so case A's artifacts
  // never render (or drive auto-select) under case B's id while B fetches.
  useEffect(() => {
    setOpenCase(null);
    if (!openCaseId) return;
    let cancelled = false;
    api.getCase(openCaseId).then((c) => {
      if (!cancelled) setOpenCase(c);
    }).catch(() => !cancelled && setOpenCaseId(null));
    return () => {
      cancelled = true;
    };
  }, [openCaseId]);

  // Keep the open case fresh from the poll: the agent pins evidence / adds notes
  // via MCP mid-conversation, and the artifact pane must show it without a
  // reopen. Strictly-newer guard so a poll can't clobber a local onCaseChanged.
  useEffect(() => {
    if (!openCaseId || !allCases) return;
    const fresh = allCases.find((c) => c.case_id === openCaseId);
    if (fresh && (!openCase || fresh.updated_at > openCase.updated_at)) setOpenCase(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allCases]);

  // Inside a case with no thread picked, select its most recent member thread.
  // Guarded on case_id === openCaseId so a stale case can't pick its thread
  // under a different case id.
  useEffect(() => {
    if (openCase && openCase.case_id === openCaseId && !selectedId && openCase.thread_ids.length > 0) {
      const newest = threadList
        .filter((t) => openCase.thread_ids.includes(t.thread_id))
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
      if (newest) setSelectedId(newest.thread_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCase?.case_id, threadList.length]);

  // Load the selected thread.
  useEffect(() => {
    setLiveText(""); // the previous thread's status line must not follow the selection
    if (!selectedId) {
      setThread(null);
      return;
    }
    let cancelled = false;
    api.getThread(selectedId).then((t) => {
      if (cancelled) return;
      setThread(t);
      // Retroactively name a still-default thread from its first message, so
      // "New thread" stops showing in the rail / tab / header for threads made
      // before auto-naming (owner: "it still has a new thread on the bottom").
      if (DEFAULT_THREAD_TITLES.has(t.title)) {
        const firstUser = t.messages.find((m) => m.role === "you");
        if (firstUser) {
          void api
            .updateThreadMeta(t.thread_id, { title: deriveThreadTitle(firstUser.text) })
            .then((u) => !cancelled && setThread(u))
            .catch(() => undefined);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // SWITCHBOARD: no in-page agent stream — the thread beside this page IS
  // the agent (page-api useSurfaceAgent); replies live in the terminal.
  const agent = useSurfaceAgent();


  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [thread, liveText]);

  // Sync the unfiled-thread grounding editor when a different thread is selected.
  useEffect(() => {
    setRefTicker(thread?.reference_ticker ?? "");
    setHypothesis(thread?.hypothesis ?? "");
    setLabelsText((thread?.labels ?? []).join(", "));
    setFileIntoCaseId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.thread_id]);

  const saveMeta = async (): Promise<void> => {
    const tid = selectedId;
    if (!tid) return;
    const labels = labelsText.split(",").map((s) => s.trim()).filter(Boolean);
    const updated = await api
      .updateThreadMeta(tid, {
        reference_ticker: refTicker.trim() || null,
        hypothesis: hypothesis.trim() || null,
        labels,
      })
      .catch(() => null);
    if (updated) setThread(updated);
  };

  const runAgent = async (text: string): Promise<void> => {
    // SWITCHBOARD: the prompt is TYPED into the thread beside this page (the
    // user presses Enter) and the reply happens there — nothing streams back
    // into this log. The case framing rides as a one-line prefix so the
    // thread knows what it is looking at. Lodestar's thread record keeps the
    // QUESTIONS (appendThread in `send`); the answers live in the terminal.
    const framing = openCase && openCase.case_id === openCaseId ? `[case ${openCase.title}] ` : "";
    const r = agent.send(`${framing}${text}`);
    if (!r.sent) {
      setLiveText("(no thread beside this page to ask — open a terminal running claude in this tab)");
      return;
    }
    setLiveText(
      r.truncated
        ? "→ typed into the thread beside this page, TRUNCATED to one line's worth (~800 chars) — press Enter there, or paste the rest yourself"
        : "→ typed into the thread beside this page — press Enter there; the reply appears in the terminal",
    );
  };

  const send = async (): Promise<void> => {
    const tid = selectedId;
    if (!tid || !prompt.trim()) return;
    const text = prompt.trim();
    setPrompt("");
    // Name the thread from its opening message (kills the triple "New thread").
    const nameOnFirst =
      !!thread && thread.thread_id === tid && thread.messages.length === 0 && DEFAULT_THREAD_TITLES.has(thread.title);
    await api.appendThread(tid, "you", text).catch(() => undefined);
    if (nameOnFirst) {
      await api.updateThreadMeta(tid, { title: deriveThreadTitle(text) }).catch(() => undefined);
    }
    await api.getThread(tid).then(setThread).catch(() => undefined);
    await runAgent(text);
  };

  // Entry points -------------------------------------------------------------

  const openCaseView = (id: string): void => {
    setOpenCaseId(id);
    setSelectedId(null);
    setViewMode("investigate");
  };

  const closeWorkspace = (): void => {
    setOpenCaseId(null);
    setSelectedId(null);
  };

  // Delete the open case AND its conversations (owner ask 2026-07-03). Guarded
  // by a confirm — deleting a case discards the whole investigation.
  const deleteOpenCase = async (): Promise<void> => {
    if (!openCaseId) return;
    const n = openCase?.thread_ids.length ?? 0;
    const label = openCase?.title ?? "this case";
    if (!window.confirm(`Delete "${label}"${n ? ` and its ${n} conversation${n === 1 ? "" : "s"}` : ""}? This can't be undone.`)) {
      return;
    }
    await api.deleteCase(openCaseId).catch(() => null);
    closeWorkspace();
  };

  // Promote a conversation artifact (a workbench widget) up to evidence — the
  // first rung of the ladder. Carries the widget's own provenance if it has one.
  const widgetPinTitle = (w: { type: string; title?: string }): string =>
    w.title ?? `${w.type} artifact`;
  // Already promoted to evidence? (dedupe — repeated clicks must not pile up
  // identical pins). Matched by the title+type we stamp at promotion time.
  const widgetIsEvidence = (w: { type: string; title?: string }): boolean =>
    (openCase?.pins ?? []).some(
      (p) => p.title === widgetPinTitle(w) && (p.payload as Record<string, unknown>)?.widget_type === w.type,
    );

  const promoteWidget = async (w: {
    type: string;
    params: Record<string, unknown>;
    title?: string;
  }): Promise<void> => {
    if (!openCase || widgetIsEvidence(w)) return;
    // Normalize provenance to the pin validator's strict 5-key shape — the
    // workbench only requires a dict, so a partial one would 400 and the click
    // would silently no-op (pre-PR review). Fill/coerce every field.
    const raw =
      w.params?.provenance && typeof w.params.provenance === "object"
        ? (w.params.provenance as Record<string, unknown>)
        : {};
    const n = Number(raw.sample_size);
    const prov: CasePin["provenance"] = {
      tool: typeof raw.tool === "string" && raw.tool ? raw.tool : "conversation artifact",
      params: raw.params && typeof raw.params === "object" ? (raw.params as Record<string, unknown>) : {},
      data_window: typeof raw.data_window === "string" && raw.data_window ? raw.data_window : "—",
      sample_size: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0,
      computed_at:
        typeof raw.computed_at === "string" && raw.computed_at ? raw.computed_at : new Date().toISOString(),
    };
    const updated = await api
      .pinToCase(openCase.case_id, {
        kind: w.type === "table" ? "analysis" : "chart",
        title: widgetPinTitle(w),
        payload: { ...w.params, widget_type: w.type },
        provenance: prov,
      })
      .catch(() => null);
    if (updated) setOpenCase(updated);
  };

  const newCase = async (tpl: (typeof CASE_TEMPLATES)[number]): Promise<void> => {
    // Auto-anchor to the active screen's market when the template has no
    // stronger subject (requirements Decided #7a).
    const subject = tpl.subject();
    const ticker = screenContext().ticker ?? null;
    if (subject.kind === "market" && ticker) subject.ticker = ticker;
    const c = await api
      .createCase({ title: tpl.title, stream: tpl.stream, subject })
      .catch(() => null);
    if (c) openCaseView(c.case_id);
  };

  const newThreadInCase = async (): Promise<void> => {
    if (!openCaseId) return;
    const updated = await api
      .attachCaseThread(openCaseId, { title: "New thread" })
      .catch(() => null);
    if (updated) {
      setOpenCase(updated);
      const newest = updated.thread_ids[updated.thread_ids.length - 1];
      if (newest) setSelectedId(newest);
    }
  };

  const newUnfiledThread = async (): Promise<void> => {
    const t = await api.createThread({
      title: "New thread",
      reference_ticker: screenContext().ticker ?? null,
    });
    setSelectedId(t.thread_id);
  };

  const fileThreadIntoCase = async (): Promise<void> => {
    const tid = selectedId;
    if (!tid || !fileIntoCaseId) return;
    const updated = await api
      .attachCaseThread(fileIntoCaseId, { threadId: tid })
      .catch(() => null);
    if (updated) {
      setOpenCaseId(updated.case_id);
      setViewMode("investigate"); // show the thread we just filed, not a stale face
      const t = await api.getThread(tid).catch(() => null);
      if (t) setThread(t);
    }
  };

  // Return the active member thread to "unfiled" (both sides un-sync'd server-side).
  const unfileActiveThread = async (): Promise<void> => {
    if (!openCaseId || !selectedId) return;
    const updated = await api.detachCaseThread(openCaseId, selectedId).catch(() => null);
    if (updated) {
      setOpenCase(updated);
      setSelectedId(null);
    }
  };

  // Per-conversation ⋯ menu (CaseRail). The thread poll (3s) reflects the change;
  // archive/delete also deselect if the active thread was the target.
  const renameThread = (id: string, title: string): void => {
    void api.updateThreadMeta(id, { title }).catch(() => undefined);
  };
  const archiveThread = (id: string): void => {
    void api.updateThreadMeta(id, { archived: true }).catch(() => undefined);
    if (id === selectedId) setSelectedId(null);
  };
  const removeThread = async (id: string): Promise<void> => {
    // Detach from the case first so its thread_ids don't dangle, then delete.
    if (openCaseId) {
      const updated = await api.detachCaseThread(openCaseId, id).catch(() => null);
      if (updated) setOpenCase(updated);
    }
    await api.deleteThread(id).catch(() => undefined);
    if (id === selectedId) setSelectedId(null);
  };

  // Curate evidence/notes in place (left home). Closes any open viewport tab for it.
  const deletePin = async (pinId: string): Promise<void> => {
    if (!openCaseId) return;
    const u = await api.deleteCasePin(openCaseId, pinId).catch(() => null);
    if (u) setOpenCase(u);
    closeArtifact(`evidence:${pinId}`);
  };
  const deleteNote = async (noteId: string): Promise<void> => {
    if (!openCaseId) return;
    const u = await api.deleteCaseNote(openCaseId, noteId).catch(() => null);
    if (u) setOpenCase(u);
    closeArtifact(`note:${noteId}`);
  };
  const archiveItem = async (itemId: string): Promise<void> => {
    if (!openCaseId) return;
    const u = await api.archiveCaseItem(openCaseId, itemId, true).catch(() => null);
    if (u) setOpenCase(u);
    closeArtifact(`evidence:${itemId}`);
    closeArtifact(`note:${itemId}`);
  };

  // Switching cases clears the workstation (its artifacts belonged to the prior case).
  useEffect(() => {
    setOpenArtifacts([]);
    setActiveArtifactKey(null);
  }, [openCaseId]);

  // Create a thread pre-seeded with a starter prompt and run it (stays unfiled).
  const startFrom = async (text: string, title: string): Promise<void> => {
    const t = await api.createThread({ title, reference_ticker: screenContext().ticker ?? null });
    setSelectedId(t.thread_id);
    await api.appendThread(t.thread_id, "you", text).catch(() => undefined);
    await api.getThread(t.thread_id).then(setThread).catch(() => undefined);
    await runAgent(text);
  };

  // Filters ------------------------------------------------------------------

  const caseQ = caseQuery.trim().toLowerCase();
  const matchesQuery = (c: Case): boolean =>
    !caseQ ||
    c.title.toLowerCase().includes(caseQ) ||
    (c.hypothesis ?? "").toLowerCase().includes(caseQ) ||
    c.labels.some((l) => l.toLowerCase().includes(caseQ)) ||
    (c.subject.label ?? "").toLowerCase().includes(caseQ);
  const filteredCases = caseList.filter(
    (c) =>
      matchesQuery(c) &&
      (streamFilter === null || c.stream === streamFilter) &&
      (dispositionFilter === null || c.disposition === dispositionFilter),
  );

  const pendingCaseId = useUiStore((s) => s.pendingCaseId);
  const setPendingCase = useUiStore((s) => s.setPendingCase);
  useEffect(() => {
    if (!pendingCaseId) return;
    openCaseView(pendingCaseId);
    setPendingCase(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCaseId]);

  const inWorkspace = openCaseId !== null || selectedId !== null;

  // Tell the ambient agent what's on screen, so Ctrl+I ("chart X") knows which
  // domain's tools apply and that render_exploration has a surface to land on.
  // With the domain tabs gone (phase 2) that surface is a case's STUDY view —
  // which labels ITSELF (CaseStudy knows the active surface and the case id, and
  // this effect doesn't), so study mode is skipped here to avoid two writers
  // fighting over one label.
  useEffect(() => {
    if (inWorkspace) {
      if (openCase && viewMode === "study") return;
      if (openCase) {
        setView("playground", `Playground · Case (${viewMode})`);
      } else {
        setView("playground", "Playground · Unfiled thread");
      }
      return;
    }
    const label: Record<typeof deskTab, string> = {
      cases: "Cases",
      tdash: "Trading dashboard",
      sdash: "Sports dashboard",
      new: "New case",
    };
    setView("playground", `Playground · ${label[deskTab]}`);
  }, [deskTab, inWorkspace, viewMode, openCase, setView]);


  // ───────────────────────────── DESK VIEW ─────────────────────────────
  if (!inWorkspace) {
    return (
      <div className="flex h-full flex-col overflow-y-auto pr-1">
        {/* One name for this surface: "Playground" (owner 2026-08-02). It used to
            be titled "Research Desk" here while the nav and title bar said
            Playground — three names for one place. */}
        <h1 className="font-mono text-lg font-medium tracking-tight">Playground</h1>
        {/* tabs — sub-pages of the Playground (redesign) */}
        <div className="mb-5 mt-3 flex gap-5 border-b border-line">
          {([
            ["cases", "Cases"],
            ["tdash", "Trading"],
            ["sdash", "Sports"],
            ["new", "New case"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setDeskTab(key)}
              className={`-mb-px border-b-2 pb-2.5 text-sm transition-colors ${
                deskTab === key
                  ? "border-accent font-medium text-text"
                  : "border-transparent text-dim hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── CASES — the investigations ── */}
        {deskTab === "cases" ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                value={caseQuery}
                onChange={(e) => setCaseQuery(e.target.value)}
                placeholder="search cases…"
                className="w-44 rounded-md border border-line bg-bg px-2 py-0.5 text-xs text-text placeholder:text-dim focus:border-accent focus:outline-none"
              />
              {ALL_STREAMS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStreamFilter(streamFilter === s ? null : s)}
                  className={`rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors ${
                    streamFilter === s ? "border-transparent text-bg" : "border-line text-dim hover:text-text"
                  }`}
                  style={streamFilter === s ? { background: STREAM_COLOR[s] } : undefined}
                >
                  {STREAM_LABEL[s]}
                </button>
              ))}
              {dispositionFilter ? (
                <button type="button" onClick={() => setDispositionFilter(null)} className="font-mono text-[11px] text-accent">
                  ✕ {dispositionFilter}
                </button>
              ) : null}
              <span className="ml-auto font-mono text-[11px] text-dim">
                {filteredCases.length} case{filteredCases.length === 1 ? "" : "s"}
              </span>
            </div>
            {filteredCases.length > 0 ? (
              /* Ledger rows (owner-picked Direction A, 2026-07-31) — the card
                 grid is gone; CaseCard remains only for DispositionChip/ago. */
              <CaseLedger
                cases={filteredCases}
                onOpen={openCaseView}
                onFilterDisposition={(d) => setDispositionFilter(dispositionFilter === d ? null : d)}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-line p-4 text-sm text-dim">
                No cases yet — open <span className="text-text">New case</span> to start one.
              </div>
            )}
          </>
        ) : null}

        {/* ── NEW CASE — the door into an investigation ── */}
        {deskTab === "new" ? (
          <>
            <p className="mb-3 text-sm text-dim">A case is a tracked investigation — anchor a subject and a thesis, accumulate evidence.</p>

            {/* Vision Assist — SWITCHBOARD: the in-page vision intake needed a
                streamed agent reply to parse; here the agent is the thread
                beside the page. Until it can hand structured results back,
                the flow is: drop the chart into that thread and ask. */}
            <div className="mb-4 rounded-lg border border-dashed border-accent/50 bg-accent/[0.04] p-4">
              <div className="text-sm font-medium text-text">Vision Assist — hunt a chart pattern</div>
              <div className="text-xs text-dim">
                Drop the chart screenshot into the thread beside this page and ask it to propose the
                pattern; then start a case from the read here.
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
              {CASE_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.stream}
                  type="button"
                  onClick={() => void newCase(tpl)}
                  className="rounded-lg border border-line bg-bg p-3 text-left transition-colors hover:border-accent"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: STREAM_COLOR[tpl.stream] }} />
                    <span className="text-sm text-text">{tpl.title}</span>
                  </div>
                  <div className="mt-1 text-xs text-dim">{tpl.desc}</div>
                </button>
              ))}
            </div>

            {/* quick explorations — throwaway threads (promote into a case any time) */}
            <div className="mb-2 mt-8 flex items-baseline gap-2">
              <h2 className="text-sm font-medium text-text">Quick explorations</h2>
              <span className="font-mono text-[11px] text-dim">a throwaway question — promote into a case any time</span>
              <div className="h-px flex-1 bg-line" />
              <button
                type="button"
                onClick={() => void newUnfiledThread()}
                className="rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-dim hover:text-text"
              >
                + blank
              </button>
            </div>
            <div className="space-y-4 pb-4">
              {STARTER_DOMAINS.map((domain) => (
                <div key={domain}>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-dim">{domain}</div>
                  <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                    {STARTERS.filter((s) => s.domain === domain).map((s) => (
                      <button
                        key={s.title}
                        type="button"
                        onClick={() => void startFrom(s.prompt, s.title)}
                        className="rounded-lg border border-line bg-bg p-3 text-left transition-colors hover:border-accent"
                      >
                        <div className="text-sm text-text">{s.title}</div>
                        <div className="mt-1 line-clamp-2 text-xs text-dim">{s.prompt}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {/* ── Desk dashboards (phase 1) — what's generally relevant per domain ── */}
        {deskTab === "tdash" ? <TradingDash /> : null}
        {deskTab === "sdash" ? <SportsDash /> : null}
      </div>
    );
  }

  // The hypothesis report opens as an in-platform PAGE (nav rail stays via the Layout);
  // ^I still works over it, and "← back to case" returns here.
  if (reportCtx) {
    return (
      <HypothesisReport
        hypothesis={reportCtx.hypothesis}
        levels={reportCtx.levels}
        note={reportCtx.note}
        symbol={reportCtx.symbol}
        timeframe={reportCtx.timeframe}
        window={reportCtx.window}
        backtest={reportCtx.backtest}
        caseId={reportCtx.caseId ?? openCaseId}
        variant="page"
        onClose={closeReport}
      />
    );
  }

  // ─────────────────────────── WORKSPACE VIEW ───────────────────────────
  return (
    <div className="flex h-full flex-col">
      {/* Header controls share ONE system: every control is h-7, same radius, no hard
          borders — subtle surface fills carry state instead (owner feedback 2026-07-12). */}
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={closeWorkspace}
          className="flex h-7 items-center rounded-md px-2.5 font-mono text-[11px] text-dim transition-colors hover:bg-surface hover:text-text"
        >
          ← Playground
        </button>
        <h1 className="truncate font-mono text-base font-medium tracking-tight">
          {openCase ? openCase.title : thread?.title ?? "thread"}
        </h1>
        {openCase ? <DispositionChip disposition={openCase.disposition} /> : null}
        {/* the case's three faces: Investigate (work) · Synthesize (the report)
            · Study (the stream's exploration surfaces, phase 2) */}
        {openCase ? (
          <div className="inline-flex h-7 items-center rounded-md bg-surface p-0.5 font-mono text-[11px]">
            {(["investigate", "synthesize", "study"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                className={`flex h-6 items-center rounded px-2.5 transition-colors ${
                  viewMode === mode ? "bg-surface2 text-text" : "text-dim hover:text-text"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        ) : null}
        {/* snapshot the case into the knowledge base (durable copy + backlink) */}
        {openCase ? (
          caseSavedFor === openCase.case_id ? (
            <span className="flex h-7 items-center px-1 font-mono text-[11px]" style={{ color: "#4ea96a" }}>
              ✓ in knowledge
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void saveCaseToKnowledge()}
              disabled={savingCase}
              title="snapshot this case into your knowledge base (a durable, commentable copy)"
              className="flex h-7 items-center rounded-md px-2.5 font-mono text-[11px] text-dim transition-colors hover:bg-surface hover:text-accent disabled:opacity-40"
            >
              {savingCase ? "saving…" : "＋ knowledge"}
            </button>
          )
        ) : null}
        {/* compact switcher — replaces the space-eating left rail (owner
            feedback 2026-07-02): jump to any case or unfiled thread from here */}
        <select
          value={openCaseId ? `c:${openCaseId}` : selectedId ? `t:${selectedId}` : ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("c:")) openCaseView(v.slice(2));
            else if (v.startsWith("t:")) {
              setOpenCaseId(null);
              setSelectedId(v.slice(2));
            }
          }}
          className="ml-auto h-7 max-w-[260px] rounded-md bg-surface px-2 font-mono text-[11px] text-dim transition-colors hover:text-text focus:outline-none"
        >
          <option value="" disabled>
            switch to…
          </option>
          {caseList.length > 0 ? (
            <optgroup label="cases">
              {caseList.map((c) => (
                <option key={c.case_id} value={`c:${c.case_id}`}>
                  {c.title} · {subjectLine(c.subject)}
                </option>
              ))}
            </optgroup>
          ) : null}
          {unfiled.length > 0 ? (
            <optgroup label="unfiled threads">
              {unfiled.map((t) => (
                <option key={t.thread_id} value={`t:${t.thread_id}`}>
                  {t.title}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </div>

      {viewMode !== "investigate" && openCase ? (
        // Synthesize / Study faces: the case rail + one full-width surface —
        // the report, or the stream's study surfaces (their fixed-viewBox
        // charts need the room the workstation pane wouldn't give them).
        <div
          className="grid min-h-0 flex-1 gap-0"
          style={{ gridTemplateColumns: `${railCollapsed ? 40 : 236}px 1fr` }}
        >
          <CaseRail
            c={openCase}
            onCaseChanged={setOpenCase}
            memberThreads={memberThreads}
            selectedId={selectedId}
            collapsed={railCollapsed}
            onToggleCollapse={() => setRailCollapsed((v) => !v)}
            onSelectThread={setSelectedId}
            onNewThread={() => void newThreadInCase()}
            onUnfileThread={() => void unfileActiveThread()}
            onDelete={() => void deleteOpenCase()}
            onRenameThread={renameThread}
            onArchiveThread={archiveThread}
            onDeleteThread={(id) => void removeThread(id)}
            onOpenArtifact={openArtifact}
            activeArtifactKey={activeArtifactKey}
            onArchiveItem={(id) => void archiveItem(id)}
            onDeletePin={(id) => void deletePin(id)}
            onDeleteNote={(id) => void deleteNote(id)}
          />
          {viewMode === "study" ? (
            // keyed on the case: the surfaces hold their own state (an open
            // pitcher deep-dive, filters), which must not carry into another case
            <CaseStudy key={openCase.case_id} caseId={openCase.case_id} stream={openCase.stream} />
          ) : (
            <div className="min-h-0 overflow-hidden py-1 pl-6">
              <SynthesisView c={openCase} onCaseChanged={setOpenCase} />
            </div>
          )}
        </div>
      ) : (
      <div
        className="grid min-h-0 flex-1 gap-0"
        style={{
          gridTemplateColumns: openCase
            ? `${railCollapsed ? 40 : 236}px 1fr 10px ${paneW}px`
            : `1fr 10px ${paneW}px`,
        }}
      >
        {/* case rail (Investigate view): overview + conversation switcher, on
            demand. Collapses to a spine so chat + evidence get the room. */}
        {openCase ? (
          <CaseRail
            c={openCase}
            onCaseChanged={setOpenCase}
            memberThreads={memberThreads}
            selectedId={selectedId}
            collapsed={railCollapsed}
            onToggleCollapse={() => setRailCollapsed((v) => !v)}
            onSelectThread={setSelectedId}
            onNewThread={() => void newThreadInCase()}
            onUnfileThread={() => void unfileActiveThread()}
            onDelete={() => void deleteOpenCase()}
            onRenameThread={renameThread}
            onArchiveThread={archiveThread}
            onDeleteThread={(id) => void removeThread(id)}
            onOpenArtifact={openArtifact}
            activeArtifactKey={activeArtifactKey}
            onArchiveItem={(id) => void archiveItem(id)}
            onDeletePin={(id) => void deletePin(id)}
            onDeleteNote={(id) => void deleteNote(id)}
          />
        ) : null}
        {/* chat center — the thread is named by the rail's conversation list, so
            the panel header would just echo it. Only title for a lone unfiled
            thread, where nothing else names it. */}
        <Panel
          bare
          title={openCase ? undefined : thread?.title ?? "thread"}
          className="min-h-0"
          bodyClassName="flex min-h-0 flex-col pr-5"
        >
          {/* Chat is now PURE (owner: "the chat should stay the chat") — the
              agent's composed workbench moved to the right workstation panel. */}
          {!thread ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-dim">
              {openCase && openCase.thread_ids.length === 0
                ? "No conversations yet — start one in the case rail."
                : "Pick a conversation from the rail."}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                {thread.messages.map((m, i) =>
                  m.role === "you" ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[85%] rounded-lg bg-surface2 px-3 py-1.5 text-sm text-text">
                        {m.text}
                      </div>
                    </div>
                  ) : (
                    <div key={i}>
                      <Markdown text={m.text} />
                    </div>
                  ),
                )}
                {liveText && <Markdown text={liveText} />}
              </div>

              <div className="mt-3 flex items-end gap-2 rounded-lg border border-line bg-bg px-2 py-1.5 focus-within:border-accent">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={2}
                  placeholder="Continue the thread…"
                  className="max-h-32 min-h-0 flex-1 resize-none bg-transparent text-sm text-text placeholder:text-dim focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!prompt.trim()}
                  className="rounded-md bg-accent px-2.5 py-1 text-sm font-medium text-bg disabled:opacity-40"
                >
                  ↑
                </button>
              </div>
              <div className="mt-1 px-1 font-mono text-[11px] text-dim">
                ↵ send · ⇧↵ newline · the reply lands in the thread beside this page
              </div>
            </div>
          )}
        </Panel>

        {/* drag handle */}
        <div
          onPointerDown={dragPane}
          onPointerMove={dragMove}
          onPointerUp={dragEnd}
          onPointerCancel={dragEnd}
          title="drag to resize"
          className="group flex touch-none cursor-col-resize items-stretch justify-center"
        >
          <div className="w-px bg-line/70 transition-colors group-hover:bg-accent" />
        </div>

        {/* artifact workstation — the agent's composed charts (workbench) + the
            case's evidence, as tabs. The visual surface, off the chat. */}
        <Panel
          bare
          title={openCase ? "workstation" : "grounding"}
          className="min-h-0"
          bodyClassName="flex min-h-0 flex-col pl-5"
        >
          {openCase ? (
            <CaseWorkstation
              c={openCase}
              open={openArtifacts}
              activeKey={activeArtifactKey}
              onSelect={setActiveArtifactKey}
              onClose={closeArtifact}
              onCaseChanged={setOpenCase}
              onPromoteWidget={(w) => void promoteWidget(w)}
              isWidgetEvidence={widgetIsEvidence}
            />
          ) : (
            <div className="flex min-h-0 flex-col gap-2">
              {/* unfiled thread: grounding editor (LODE Phase 1) + file-into-case */}
              <div className="grid grid-cols-[64px_1fr] items-center gap-x-2 gap-y-1.5 rounded-lg border border-line bg-bg px-2.5 py-2">
                <label className="text-[11px] uppercase tracking-wide text-dim">ticker</label>
                <input
                  value={refTicker}
                  onChange={(e) => setRefTicker(e.target.value)}
                  onBlur={() => void saveMeta()}
                  placeholder="reference market"
                  className="w-full bg-transparent font-mono text-xs text-text placeholder:text-dim focus:outline-none"
                />
                <label className="text-[11px] uppercase tracking-wide text-dim">thesis</label>
                <input
                  value={hypothesis}
                  onChange={(e) => setHypothesis(e.target.value)}
                  onBlur={() => void saveMeta()}
                  placeholder="the hypothesis you're testing"
                  className="w-full bg-transparent text-xs text-text placeholder:text-dim focus:outline-none"
                />
                <label className="text-[11px] uppercase tracking-wide text-dim">labels</label>
                <input
                  value={labelsText}
                  onChange={(e) => setLabelsText(e.target.value)}
                  onBlur={() => void saveMeta()}
                  placeholder="comma, separated"
                  className="w-full bg-transparent text-xs text-text placeholder:text-dim focus:outline-none"
                />
              </div>
              {caseList.length > 0 ? (
                <div className="rounded-lg border border-line bg-bg px-2.5 py-2">
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-dim">
                    file into a case
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={fileIntoCaseId}
                      onChange={(e) => setFileIntoCaseId(e.target.value)}
                      className="flex-1 rounded border border-line bg-bg py-1 text-xs text-text focus:outline-none"
                    >
                      <option value="">choose a case…</option>
                      {caseList.map((c) => (
                        <option key={c.case_id} value={c.case_id}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void fileThreadIntoCase()}
                      disabled={!fileIntoCaseId}
                      className="font-mono text-[11px] text-accent disabled:opacity-40"
                    >
                      attach →
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </Panel>
      </div>
      )}
    </div>
  );
}
