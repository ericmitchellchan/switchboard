// VIEW SURFACE (SWIT-50, R4 — the gate): render a view the agent DECLARED —
// table · candles · distribution — with the shell's own components, anchored
// so pins land on rows/bars/bins, keepable to the scratchpad. The agent
// supplied data + a declaration; nothing it wrote EXECUTES here (Inc F/G
// posture by construction).
//
// Anchors reuse the surface machinery wholesale: a local SurfaceAnchorContext
// registry (so CandleChart publishes its programmatic bar:<iso> provider
// exactly as it does inside SurfaceHost), composed over the DOM data-anchor
// provider that the table (`row:<key>`) and the distribution (`bin:<n>`)
// stamp. Pins ride useAnchoredPins with a view target (doc =
// `view:<threadId>:<viewId>` in the project's surface-pins file) — a pin
// survives `re-run` iff its anchor still exists, which is the anchors
// contract doing its job, not new code.
//
// T6 (SWIT-60) — the view explains itself and opens downward:
//   · `spec` (a quiet toolbar button) discloses kind · source · columns ·
//     filters · definition as plain lines (viewStore.specLines).
//   · FILTERS are selects in the toolbar over the spec's declared columns;
//     values come from the LOADED rows and the slice is client-side
//     (applyFilters) — nothing re-fetches. The active filter joins the pin
//     doc scope (viewPinScope → viewPinTargetFor's suffix).
//   · OPENING an anchor — click on a row / bin / bar, Enter on a focused row —
//     resolves the parent's drill for that key and opens the CHILD (the same
//     artifact kind with `drill.key`) in the preview slot via
//     panelStore.openDrillInPanel, `back` returning here. With no drill
//     declared the sentence `show me what is behind <title> › <label>` goes
//     to the thread through the `→ thread` seam (typed, no CR), and the
//     toolbar says `→ thread` while a row is hovered so the affordance is
//     visible without copy. PIN MODE WINS: the capture-phase pin handler
//     stops propagation while armed, and the bubble handler re-checks.
//
// T7 (SWIT-61) — hover metrics, points ⇄ percent, `line` and `bar`:
//   · HOVER is ONE state (T6's `hover`, widened): entering a row / bin / bar
//     — or FOCUSING one — records the anchor, its key, and EVERY field of the
//     row behind it (viewStore.rowForAnchor → rowFields). The renderers read
//     `hoverKey` back to paint the highlight (rows: the kit hover fill
//     `--bg-active`; bars: the brighter `--text-secondary` fill), and
//     `FieldsTooltip` prints the fields near the pointer — `position: fixed`,
//     `pointer-events: none`, clamped to the scroller's box, placed from the
//     last pointer position when the pointer is over the anchor and from the
//     anchor's own rect otherwise (keyboard focus). The pointer is tracked in
//     a REF on the root and applied to the tooltip's style directly, so a
//     mouse move never re-renders the table. Not the browser `title`: that
//     one is late, single-line and unstyled.
//   · CANDLES take a points ⇄ percent toggle in the toolbar: a quiet button
//     that names the OTHER mode (`%` while in points, `pts` while in percent)
//     → CandleChart's `priceMode` prop (the right scale's PriceScaleMode).
//     Anchors and markers are by TIME, so nothing moves but the axis.
//   · `line` renders on LinePanel (uPlot, its own lazy chunk) with `pt:<iso>`
//     anchors published the way candles publish `bar:<iso>`, the spec's
//     `markers` drawn on the canvas, and uPlot's legend as the hover readout.
//     `bar` is the dist renderer under `bar:<key>` anchors (by category, the
//     spec's key column) with the same hover tooltip — one `BarsView` draws
//     both, differing only in the anchor each bar stamps.
//
// T8 (SWIT-62) — `timeline`, the tennis table's drill:
//   · `TimelineView` (its own lazy chunk, uPlot) draws the price line, one
//     SIZED mark per moment toned by the side it backs, and the score as a
//     step band under the price; it publishes `trade:<iso>` anchors the way
//     LinePanel publishes `pt:<iso>` AND calls `onHover` from uPlot's cursor
//     hook, so the T7 tooltip prints the trade's fields (viewStore.
//     rowForAnchor answers `trade:`, unlike the other canvas anchors).
//   · The toolbar states the COVERAGE beside the title from the data file's
//     `meta` (`timelineNote`: `flagged moments only · N of M trades`) — the
//     rows are the flagged moments on disk, and the full tape is a backend
//     upgrade the view must not imply.

import { Suspense, lazy, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, MutableRefObject } from "react";

import type { Artifact } from "../../types";
import {
  useView,
  windowRows,
  tableColumns,
  rowAnchorId,
  toOhlcRows,
  toDistBins,
  toBarRows,
  toLinePoints,
  barKey,
  rowForAnchor,
  rowFields,
  applyFilters,
  filterValues,
  viewPinScope,
  drillKeyForAnchor,
  resolveDrill,
  drillFallbackSentence,
  specLines,
  timelineNote,
} from "../../lib/viewStore";
import type { ActiveFilters, ViewMeta, ViewRow, ViewSpec } from "../../lib/viewStore";
import { viewPinTargetFor } from "../../lib/pins";
import { getThreadById, threadRepoName } from "../../lib/threadStore";
import {
  artifactIdentity,
  getActiveTabSession,
  openDrillInPanel,
  sendToThread,
  useSendToThreadAvailable,
} from "../../lib/panelStore";
import { sanitizeForTypedLine, REF_MAX } from "../../lib/agentContext";
import { kbWriteDoc } from "../../lib/ipc";
import {
  SurfaceAnchorContext,
  composeAnchorProviders,
  domAnchorProvider,
  ANCHOR_ATTR,
  ANCHOR_LABEL_ATTR,
} from "../../surfaces/anchors";
import type { SurfaceAnchorProvider, SurfaceAnchorRegistry } from "../../surfaces/anchors";
import { useAnchoredPins } from "../../surfaces/SurfacePins";
import type { AnchoredPinTarget } from "../../surfaces/SurfacePins";

// The candle and line renderers are LAZY chunks (lightweight-charts, uPlot)
// — the standing preview-dependency rule; a table or dist view loads neither.
const CandleChart = lazy(() => import("../../surfaces/charts/CandleChart"));
const LinePanel = lazy(() => import("../../surfaces/charts/LinePanel"));
const TimelineView = lazy(() => import("./TimelineView"));

const MONO = "var(--font-mono)";

const TOOLBAR_STYLE: CSSProperties = {
  height: 26,
  flex: "none",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "0 10px",
  borderBottom: "1px solid var(--border)",
  fontFamily: MONO,
  fontSize: 10,
  color: "var(--text-muted)",
  whiteSpace: "nowrap",
  overflow: "hidden",
};

const TOOL_BTN: CSSProperties = {
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 3,
  color: "var(--text-dim)",
  fontFamily: MONO,
  fontSize: 10,
  lineHeight: "16px",
  padding: "0 5px",
  cursor: "pointer",
};

/** The kit's quiet select, at toolbar size: transparent, hairline, mono. */
const FILTER_SELECT: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border-subtle)",
  borderRadius: 3,
  color: "var(--text-secondary)",
  fontFamily: MONO,
  fontSize: 10,
  lineHeight: "16px",
  padding: "0 3px",
  maxWidth: 140,
  outline: "none",
};

const SPEC_STYLE: CSSProperties = {
  flex: "none",
  margin: 0,
  padding: "6px 10px",
  borderBottom: "1px solid var(--border)",
  fontFamily: MONO,
  fontSize: 10,
  lineHeight: 1.6,
  color: "var(--text-secondary)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 180,
  overflow: "auto",
};

/** The hover tooltip (T7): the kit's panel surface at tooltip size. */
const TOOLTIP_STYLE: CSSProperties = {
  position: "fixed",
  left: 0,
  top: 0,
  zIndex: 40,
  pointerEvents: "none",
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  columnGap: 10,
  rowGap: 1,
  maxWidth: 340,
  padding: "5px 8px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 4,
  fontFamily: MONO,
  fontSize: 10,
  lineHeight: "15px",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};

type ViewArtifact = Extract<Artifact, { kind: "view" }>;

/** What hovering an anchor means here — printed at the toolbar's right end,
 *  and (T7) the anchor's key + the row's fields for the highlight + tooltip. */
type HoverHint = {
  key: string;
  label: string;
  verb: string;
  fields: [string, string][];
  el: Element;
} | null;

type PriceMode = "points" | "percent";

export function ViewSurface({ artifact, active }: { artifact: ViewArtifact; active: boolean }) {
  const { threadId, viewId } = artifact;
  const drillKey = artifact.drill?.key ?? null;
  const { spec, error, rows, meta, loading, rerun } = useView(threadId, viewId, active, drillKey);

  // ── Filters (T6): client-side slices, per view instance ───────────────────
  const [activeFilters, setActiveFilters] = useState<ActiveFilters>({});
  const filteredRows = useMemo(
    () => (rows && spec ? applyFilters(rows, spec.filters, activeFilters) : rows),
    [rows, spec, activeFilters]
  );
  const pinScope = useMemo(() => viewPinScope(activeFilters, drillKey), [activeFilters, drillKey]);
  const [showSpec, setShowSpec] = useState(false);
  const [hover, setHover] = useState<HoverHint>(null);
  const [priceMode, setPriceMode] = useState<PriceMode>("points");
  // The last pointer position over the body — a ref, read by the tooltip,
  // never state (a mouse move must not re-render the table).
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Per-filter value lists are a scan of every row; a hover re-render must
  // not redo it (review, T4-T6). Keyed on the loaded rows + the declared
  // filters only — the ACTIVE selection does not change the option set.
  const specFilters = spec?.filters;
  const filterOptions = useMemo(
    () => (specFilters ?? []).map((f) => ({ filter: f, values: filterValues(rows ?? [], f) })),
    [rows, specFilters]
  );
  const canSend = useSendToThreadAvailable();

  // The project a view's pins + keeps file under: the thread's repo name.
  const project = useMemo(() => {
    const thread = getThreadById(threadId);
    return thread ? threadRepoName(thread.workingDir) : "unknown";
  }, [threadId]);

  // ── Anchors: local registry (canvas) + DOM provider (table/dist) ───────────
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const publishedRef = useRef<SurfaceAnchorProvider | null>(null);
  const registry = useMemo<SurfaceAnchorRegistry>(
    () => ({
      publish: (provider) => {
        publishedRef.current = provider;
        return () => {
          if (publishedRef.current === provider) publishedRef.current = null;
        };
      },
    }),
    []
  );
  const provider = useMemo<SurfaceAnchorProvider>(() => {
    const dom = domAnchorProvider(() => rootRef.current);
    return {
      getAnchor: (target) =>
        composeAnchorProviders(publishedRef.current, dom).getAnchor(target),
      locateAnchor: (key) =>
        composeAnchorProviders(publishedRef.current, dom).locateAnchor(key),
    };
  }, []);
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el;
    setRootEl(el);
  }, []);

  // ── Pins (the existing anchored machinery, view-targeted) ──────────────────
  const [pinMode, setPinMode] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const flashNote = useCallback((note: string) => {
    setFlash(note);
    window.setTimeout(() => setFlash(null), 1800);
  }, []);
  const onPlaced = useCallback(
    (outcome: "pinned" | "nothing-here") => {
      setPinMode(false);
      if (outcome === "nothing-here") flashNote("nothing pinnable there — click a row, bar, bin or mark");
    },
    [flashNote]
  );
  const target = useMemo<AnchoredPinTarget>(() => {
    // The ACTIVE filter (and the drill key) scope the doc: a pin dropped on
    // one date lives under that date and is not drawn on another (T6).
    const { sidecarPath, docKey } = viewPinTargetFor(project, threadId, viewId, pinScope);
    return {
      artifact,
      sidecarPath,
      docKey,
      identity: `${artifactIdentity(artifact)}${pinScope}`,
      scopeNote: `view ${docKey}`,
      emptyHint:
        "no pins yet — toggle \u{1F4CC} pin, then click a row, bar, bin or mark. A view pin follows the THING and survives re-run as long as the data still holds it.",
    };
  }, [artifact, project, threadId, viewId, pinScope]);
  const pins = useAnchoredPins(target, provider, rootEl, pinMode, onPlaced, active);

  // ── Open an anchor (T6): drill into the preview slot, else → thread ───────
  const describeAnchor = useCallback(
    (el: EventTarget | null): { key: string; label: string } | null => {
      if (!spec || !filteredRows) return null;
      const anchor = provider.getAnchor(el);
      if (!anchor) return null;
      return drillKeyForAnchor(anchor.key, { rows: filteredRows, spec });
    },
    [spec, filteredRows, provider]
  );
  const openAnchor = useCallback(
    (el: EventTarget | null) => {
      if (!spec) return;
      const hit = describeAnchor(el);
      if (!hit) return;
      if (spec.drill) {
        const resolved = resolveDrill(spec, hit.key);
        if (resolved.error !== null) {
          flashNote(resolved.error);
          return;
        }
        const sessionId = getActiveTabSession();
        if (!sessionId) {
          flashNote("no thread to open it beside");
          return;
        }
        openDrillInPanel(sessionId, artifact, { kind: "view", threadId, viewId, drill: { key: hit.key } });
        return;
      }
      if (!canSend) {
        flashNote("no live thread to ask");
        return;
      }
      sendToThread(sanitizeForTypedLine(drillFallbackSentence(spec.title, hit.label), REF_MAX));
    },
    [spec, describeAnchor, flashNote, artifact, threadId, viewId, canSend]
  );
  const onBodyClick = useCallback(
    (e: ReactMouseEvent) => {
      // Pin mode took this click in the capture phase; the re-check is belt
      // and braces for a host that renders the capture handler elsewhere.
      if (pinMode) return;
      if (e.defaultPrevented) return;
      openAnchor(e.target);
    },
    [pinMode, openAnchor]
  );
  const onHoverAnchor = useCallback(
    (el: EventTarget | null) => {
      if (!spec || !filteredRows || el === null || !(el instanceof Element)) {
        setHover(null);
        return;
      }
      const anchor = provider.getAnchor(el);
      const hit = anchor ? drillKeyForAnchor(anchor.key, { rows: filteredRows, spec }) : null;
      if (!anchor || !hit) {
        setHover(null);
        return;
      }
      const row = rowForAnchor(anchor.key, { rows: filteredRows, spec });
      setHover((prev) =>
        prev && prev.key === anchor.key && prev.el === el
          ? prev
          : {
              key: anchor.key,
              label: hit.label,
              verb: spec.drill ? `› ${spec.drill.title.split("{key}").join(hit.key)}` : "→ thread",
              fields: row ? rowFields(row) : [],
              el,
            }
      );
    },
    [spec, filteredRows, provider]
  );
  const onPointerMove = useCallback((e: ReactMouseEvent) => {
    pointerRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  // ── keep → the scratchpad (decided Q4) ─────────────────────────────────────
  const [keeping, setKeeping] = useState(false);
  const keep = useCallback(async () => {
    if (!spec || keeping) return;
    setKeeping(true);
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      const relPath = `_scratch/${project}/${spec.id}-${stamp}.view.json`;
      await kbWriteDoc(relPath, JSON.stringify({ spec, rows: rows ?? [] }, null, 2));
      flashNote(`kept — _scratch/${project}/ (promote it from there when it earns a home)`);
    } catch (err) {
      flashNote(`keep failed: ${String(err)}`);
    } finally {
      setKeeping(false);
    }
  }, [spec, rows, project, keeping, flashNote]);

  // ── The cannot-render card (R4 edge case) ──────────────────────────────────
  if (!spec || (error && rows === null)) {
    const sourceLine = spec
      ? spec.source.type === "file"
        ? `file ${spec.source.path} (in the thread's working directory)`
        : `query ${spec.source.url}`
      : `views/${viewId}.json`;
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: 24,
          textAlign: "center",
          fontFamily: MONO,
          fontSize: 11,
          color: "var(--text-dim)",
          lineHeight: 1.6,
        }}
      >
        <span style={{ color: "var(--text-secondary)" }}>
          {spec ? spec.title : "this view cannot render"}
        </span>
        <span>source: {sourceLine}</span>
        <span style={{ color: "var(--text-muted)", maxWidth: 420 }}>
          {error ?? (loading ? "loading…" : "no data yet")}
        </span>
        {spec && (
          <button type="button" style={{ ...TOOL_BTN, borderColor: "var(--border-subtle)" }} onClick={rerun}>
            try again
          </button>
        )}
      </div>
    );
  }

  const windowed = filteredRows ? windowRows(filteredRows) : { rows: [] as ViewRow[], total: 0, windowed: false };
  const filtered = filteredRows !== null && rows !== null && filteredRows.length !== rows.length;

  return (
    <SurfaceAnchorContext.Provider value={registry}>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={TOOLBAR_STYLE}>
          <span style={{ color: "var(--text-primary)", flex: "none" }}>{spec.kind}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{spec.title}</span>
          {spec.kind === "timeline" && (
            <span style={{ color: "var(--text-dim)", flex: "none" }}>{timelineNote(meta, windowed.total)}</span>
          )}
          {filterOptions.map(({ filter: f, values }) => {
            const current = activeFilters[f.column] ?? "";
            return (
              <select
                key={f.column}
                value={current}
                onChange={(e) =>
                  setActiveFilters((prev) => ({ ...prev, [f.column]: e.target.value }))
                }
                title={`${f.label ?? f.column} — ${f.kind}, ${values.length} values`}
                style={{
                  ...FILTER_SELECT,
                  ...(current.length > 0 ? { color: "var(--text-primary)", borderColor: "var(--text-secondary)" } : {}),
                }}
              >
                <option value="">{f.label ?? f.column}</option>
                {values.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            );
          })}
          <span style={{ flex: 1 }} />
          <span style={{ color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis" }}>
            {flash ??
              (hover
                ? `${hover.label} ${hover.verb}`
                : `${spec.source.type === "file" ? spec.source.path : spec.source.url} · ${
                    spec.builtAt ? spec.builtAt.slice(0, 16).replace("T", " ") : ""
                  } · ${spec.builtBy}${
                    filtered ? ` · ${filteredRows?.length ?? 0} of ${rows?.length ?? 0} rows` : ""
                  }${windowed.windowed ? ` · showing ${windowed.rows.length} of ${windowed.total} rows` : ""}`)}
          </span>
          {spec.kind === "candles" && (
            <button
              type="button"
              style={TOOL_BTN}
              onClick={() => setPriceMode((m) => (m === "points" ? "percent" : "points"))}
              title={
                priceMode === "points"
                  ? "Price scale as percent change from the first visible bar"
                  : "Price scale in points"
              }
            >
              {priceMode === "points" ? "%" : "pts"}
            </button>
          )}
          <button
            type="button"
            style={{
              ...TOOL_BTN,
              ...(showSpec ? { color: "var(--text-primary)", borderColor: "var(--text-secondary)" } : {}),
            }}
            onClick={() => setShowSpec((v) => !v)}
            title="What this view is: kind, source, columns, filters, the rule that defines its rows"
          >
            spec
          </button>
          <button
            type="button"
            style={{
              ...TOOL_BTN,
              ...(pinMode ? { color: "var(--text-primary)", borderColor: "var(--text-secondary)" } : {}),
            }}
            onClick={() => setPinMode((m) => !m)}
            title="Pin mode: click a row, bar, bin or mark to drop a numbered pin"
          >
            {"\u{1F4CC}"} pin{pins.count > 0 ? ` ${pins.count}` : ""}
          </button>
          <button
            type="button"
            style={TOOL_BTN}
            onClick={rerun}
            disabled={loading}
            title={
              spec.source.type === "query"
                ? "Re-run the query — refreshes only on your gesture"
                : "Re-read the data file"
            }
          >
            {loading ? "…" : "re-run"}
          </button>
          <button
            type="button"
            style={TOOL_BTN}
            onClick={() => void keep()}
            disabled={keeping}
            title={`Keep this view: snapshot spec + rows to the scratchpad (_scratch/${project}/) — promote it to the KB or a Research page from there`}
          >
            keep
          </button>
        </div>
        {showSpec && <pre style={SPEC_STYLE}>{specLines(spec).join("\n")}</pre>}
        <div ref={scrollerRef} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <div
            ref={setRoot}
            onClickCapture={pins.onCapture}
            onClick={onBodyClick}
            onMouseMove={onPointerMove}
            onMouseLeave={() => {
              pointerRef.current = null;
              setHover(null);
            }}
            style={{
              position: "relative",
              minHeight: "100%",
              cursor: pinMode ? "crosshair" : undefined,
              background: pinMode ? "rgba(228, 228, 231, 0.04)" : "transparent",
            }}
          >
            <ViewBody
              spec={spec}
              rows={windowed.rows}
              meta={meta}
              hoverKey={hover?.key ?? null}
              priceMode={priceMode}
              onActivate={openAnchor}
              onHover={onHoverAnchor}
            />
            {pins.marks}
            {hover && hover.fields.length > 0 && !pinMode && (
              <FieldsTooltip
                fields={hover.fields}
                anchorEl={hover.el}
                pointerRef={pointerRef}
                boundsRef={scrollerRef}
              />
            )}
          </div>
        </div>
        {pins.rail}
      </div>
    </SurfaceAnchorContext.Provider>
  );
}

// ── The hover tooltip (T7) ───────────────────────────────────────────────────

/** Every field of the hovered row, near the pointer, clamped to the
 *  scroller's box. Placement is written to the element's style directly from
 *  a mousemove listener on the bounds — no React state per move. When the
 *  pointer is not over the anchor (keyboard focus, or the first paint before
 *  any move) it sits under the anchor's own box. */
function FieldsTooltip({
  fields,
  anchorEl,
  pointerRef,
  boundsRef,
}: {
  fields: [string, string][];
  anchorEl: Element;
  pointerRef: MutableRefObject<{ x: number; y: number } | null>;
  boundsRef: MutableRefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const bounds = boundsRef.current;
    if (!el) return;
    const place = (x: number, y: number) => {
      const b = bounds?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left = x + 12;
      let top = y + 14;
      if (left + w > b.right - 4) left = Math.max(b.left + 4, x - 12 - w);
      if (top + h > b.bottom - 4) top = Math.max(b.top + 4, y - 14 - h);
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
    };
    const rect = anchorEl.getBoundingClientRect();
    const p = pointerRef.current;
    const overAnchor =
      p !== null && p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom;
    if (overAnchor && p) place(p.x, p.y);
    else place(rect.left + Math.min(rect.width / 2, 120), rect.bottom - 8);
    const onMove = (e: MouseEvent) => place(e.clientX, e.clientY);
    bounds?.addEventListener("mousemove", onMove);
    return () => bounds?.removeEventListener("mousemove", onMove);
  }, [fields, anchorEl, pointerRef, boundsRef]);
  return (
    <div ref={ref} style={TOOLTIP_STYLE} role="tooltip">
      {fields.map(([k, v]) => (
        <FieldLine key={k} k={k} v={v} />
      ))}
    </div>
  );
}

function FieldLine({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span style={{ color: "var(--text-dim)" }}>{k}</span>
      <span style={{ color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</span>
    </>
  );
}

// ── Renderers (ours; the agent's data never executes) ────────────────────────

type RendererProps = {
  spec: ViewSpec;
  rows: ViewRow[];
  /** The hovered/focused anchor key (T7) — the renderer paints its highlight. */
  hoverKey: string | null;
  /** Enter on a focused anchor (T6) — the click path goes through the wrapper. */
  onActivate: (el: EventTarget | null) => void;
  onHover: (el: EventTarget | null) => void;
};

const ViewBody = memo(function ViewBody({
  spec,
  rows,
  meta,
  hoverKey,
  priceMode,
  onActivate,
  onHover,
}: RendererProps & { priceMode: PriceMode; meta: ViewMeta | null }) {
  switch (spec.kind) {
    case "timeline":
      return (
        <Suspense fallback={<ChartFallback />}>
          <div style={{ padding: "8px 10px" }}>
            <TimelineView spec={spec} rows={rows} meta={meta} hoverKey={hoverKey} onHover={onHover} />
          </div>
        </Suspense>
      );
    case "table":
      return <TableView spec={spec} rows={rows} hoverKey={hoverKey} onActivate={onActivate} onHover={onHover} />;
    case "candles":
      return (
        <Suspense fallback={<ChartFallback />}>
          <div style={{ padding: "8px 10px" }}>
            <CandleChart
              bars={toOhlcRows(rows)}
              markers={(spec.markers ?? []).map((m) => ({ ts: m.ts, label: m.label }))}
              height={360}
              intraday
              priceMode={priceMode}
            />
          </div>
        </Suspense>
      );
    case "line":
      return (
        <Suspense fallback={<ChartFallback />}>
          <LineView spec={spec} rows={rows} />
        </Suspense>
      );
    case "dist":
    case "bar":
      return <BarsView spec={spec} rows={rows} hoverKey={hoverKey} onActivate={onActivate} onHover={onHover} />;
  }
});

function ChartFallback() {
  return (
    <div style={{ padding: 24, fontFamily: MONO, fontSize: 11, color: "var(--text-dim)" }}>loading chart…</div>
  );
}

/** The table renderer: kit tokens, click-to-sort, `row:<key>` anchors.
 *  Rows are focusable (T6): Enter opens the focused row the way a click does;
 *  focus shows the same tooltip hover does (T7). */
function TableView({ spec, rows, hoverKey, onActivate, onHover }: RendererProps) {
  const columns = tableColumns(rows, spec);
  const [sort, setSort] = useState<{ column: string; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { column, dir } = sort;
    return [...rows].sort((a, b) => {
      const av = a[column];
      const bv = b[column];
      const an = Number(av);
      const bn = Number(bv);
      if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }, [rows, sort]);
  if (rows.length === 0) {
    return (
      <div style={{ padding: 24, fontFamily: MONO, fontSize: 11, color: "var(--text-dim)" }}>
        no rows
      </div>
    );
  }
  return (
    <table
      style={{
        borderCollapse: "collapse",
        fontFamily: MONO,
        fontSize: 10.5,
        width: "100%",
        color: "var(--text-secondary)",
      }}
    >
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c}
              onClick={() =>
                setSort((prev) =>
                  prev?.column === c ? { column: c, dir: prev.dir === 1 ? -1 : 1 } : { column: c, dir: 1 }
                )
              }
              title="Sort by this column"
              style={{
                position: "sticky",
                top: 0,
                background: "var(--bg-panel)",
                color: sort?.column === c ? "var(--text-primary)" : "var(--text-dim)",
                fontWeight: 500,
                fontSize: 9.5,
                textTransform: "uppercase",
                letterSpacing: "0.6px",
                textAlign: "left",
                padding: "4px 8px",
                borderBottom: "1px solid var(--border-subtle)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {c}
              {sort?.column === c ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(() => {
          // Duplicate key-column values happen in real data (review): the
          // FIRST occurrence keeps the bare anchor (a pin resolves to it);
          // later duplicates get suffixed React keys and NO anchor — two rows
          // sharing one pin anchor would be a mark pointing at the wrong row.
          const seenAnchors = new Set<string>();
          return sorted.map((row, i) => {
            const rawAnchor = rowAnchorId(row, spec);
            const anchor = rawAnchor !== null && !seenAnchors.has(rawAnchor) ? rawAnchor : null;
            if (anchor !== null) seenAnchors.add(anchor);
            return (
            <tr
              key={anchor ?? `dup-${rawAnchor ?? "row"}-${i}`}
              {...(anchor ? { [ANCHOR_ATTR]: `row:${anchor}`, [ANCHOR_LABEL_ATTR]: anchor, tabIndex: 0 } : {})}
              onKeyDown={
                anchor
                  ? (e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        onActivate(e.currentTarget);
                      }
                    }
                  : undefined
              }
              onMouseEnter={anchor ? (e) => onHover(e.currentTarget) : undefined}
              onMouseLeave={anchor ? () => onHover(null) : undefined}
              onFocus={anchor ? (e) => onHover(e.currentTarget) : undefined}
              onBlur={anchor ? () => onHover(null) : undefined}
              style={{
                borderBottom: "1px solid var(--border)",
                cursor: anchor ? "pointer" : undefined,
                outline: "none",
                background: anchor !== null && hoverKey === `row:${anchor}` ? "var(--bg-active)" : undefined,
              }}
            >
              {columns.map((c) => {
                const v = row[c];
                const n = Number(v);
                const numeric = typeof v === "number" || (typeof v === "string" && Number.isFinite(n) && v.trim() !== "");
                return (
                  <td
                    key={c}
                    style={{
                      padding: "3px 8px",
                      textAlign: numeric ? "right" : "left",
                      whiteSpace: "nowrap",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {v === null || v === undefined ? "" : String(v)}
                  </td>
                );
              })}
            </tr>
            );
          });
        })()}
      </tbody>
    </table>
  );
}

/** The distribution AND category-bar renderer: plain flex bars with
 *  `bin:<n>` (dist) or `bar:<key>` (bar) anchors — 40 honest lines instead of
 *  bending uPlot into a histogram. Soft palette; the hovered bar takes the
 *  brighter `--text-secondary` fill (T7). Duplicate categories on a bar view
 *  follow the table's rule: the FIRST keeps the anchor, later ones get none. */
function BarsView({ spec, rows, hoverKey, onActivate, onHover }: RendererProps) {
  // Binning is a full pass over the rows; the parent's hover state re-renders
  // this component with the same props, so the bins are memoised on them.
  const bars = useMemo(() => {
    if (spec.kind === "bar") {
      const seen = new Set<string>();
      return toBarRows(rows, spec).map((b) => {
        const anchor = seen.has(b.key) ? null : barKey(b.key);
        seen.add(b.key);
        return { label: b.key, count: b.value, anchor };
      });
    }
    return toDistBins(rows, spec).map((b, i) => ({ label: b.label, count: b.count, anchor: `bin:${i}` as string | null }));
  }, [rows, spec]);
  if (bars.length === 0) {
    return (
      <div style={{ padding: 24, fontFamily: MONO, fontSize: 11, color: "var(--text-dim)" }}>
        {spec.kind === "bar"
          ? "no bars — a bar view expects one row per category (key + value)"
          : "no bins — a dist view expects pre-binned rows (label + count)"}
      </div>
    );
  }
  const max = Math.max(...bars.map((b) => Math.abs(b.count)), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, padding: "18px 14px 4px", height: 260 }}>
      {bars.map((bar, i) => {
        const h = Math.max(2, Math.round((Math.abs(bar.count) / max) * 200));
        const hovered = bar.anchor !== null && hoverKey === bar.anchor;
        return (
          <div
            key={`${bar.label}-${i}`}
            {...(bar.anchor ? { [ANCHOR_ATTR]: bar.anchor, [ANCHOR_LABEL_ATTR]: bar.label, tabIndex: 0 } : {})}
            onKeyDown={
              bar.anchor
                ? (e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onActivate(e.currentTarget);
                    }
                  }
                : undefined
            }
            onMouseEnter={bar.anchor ? (e) => onHover(e.currentTarget) : undefined}
            onMouseLeave={bar.anchor ? () => onHover(null) : undefined}
            onFocus={bar.anchor ? (e) => onHover(e.currentTarget) : undefined}
            onBlur={bar.anchor ? () => onHover(null) : undefined}
            style={{
              flex: 1,
              minWidth: 4,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              cursor: bar.anchor ? "pointer" : undefined,
              outline: "none",
            }}
          >
            <span style={{ fontFamily: MONO, fontSize: 8.5, color: hovered ? "var(--text-secondary)" : "var(--text-faint)" }}>
              {bar.count}
            </span>
            <div
              style={{
                width: "100%",
                height: h,
                background: hovered
                  ? "var(--text-secondary)"
                  : bar.count >= 0
                    ? "var(--text-muted)"
                    : "var(--text-faint)",
                borderRadius: "2px 2px 0 0",
              }}
            />
            <span
              style={{
                fontFamily: MONO,
                fontSize: 8.5,
                color: hovered ? "var(--text-primary)" : "var(--text-dim)",
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {bar.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Three days or less of data reads as a session (time-of-day ticks). */
const INTRADAY_SPAN_S = 3 * 24 * 3600;

/** The line renderer (T7): the spec's series (or every numeric column) over
 *  one time axis on LinePanel, `pt:<iso>` anchors, the spec's markers on the
 *  canvas. uPlot's legend is the hover readout. */
function LineView({ spec, rows }: { spec: ViewSpec; rows: ViewRow[] }) {
  const points = useMemo(() => toLinePoints(rows, spec), [rows, spec]);
  const series = useMemo(() => points.series.map((s) => ({ label: s.label, values: s.values })), [points]);
  const markers = useMemo(() => (spec.markers ?? []).map((m) => ({ ts: m.ts, label: m.label })), [spec.markers]);
  if (points.xs.length === 0 || points.series.length === 0) {
    return (
      <div style={{ padding: 24, fontFamily: MONO, fontSize: 11, color: "var(--text-dim)" }}>
        no series — a line view expects rows with a time column and at least one numeric column
      </div>
    );
  }
  const intraday = points.xs[points.xs.length - 1] - points.xs[0] <= INTRADAY_SPAN_S;
  return (
    <div style={{ padding: "8px 10px" }}>
      <LinePanel xs={points.xs} series={series} points={points.ts} markers={markers} height={300} intraday={intraday} />
    </div>
  );
}
