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

import { Suspense, lazy, useCallback, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

import type { Artifact } from "../../types";
import {
  useView,
  windowRows,
  tableColumns,
  rowAnchorId,
  toOhlcRows,
  toDistBins,
  applyFilters,
  filterValues,
  viewPinScope,
  drillKeyForAnchor,
  resolveDrill,
  drillFallbackSentence,
  specLines,
} from "../../lib/viewStore";
import type { ActiveFilters, ViewRow, ViewSpec } from "../../lib/viewStore";
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

// The candle renderer is a LAZY chunk (lightweight-charts) — the standing
// preview-dependency rule; a table or dist view never loads it.
const CandleChart = lazy(() => import("../../surfaces/charts/CandleChart"));

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

type ViewArtifact = Extract<Artifact, { kind: "view" }>;

/** What hovering an anchor means here — printed at the toolbar's right end. */
type HoverHint = { label: string; verb: string } | null;

export function ViewSurface({ artifact, active }: { artifact: ViewArtifact; active: boolean }) {
  const { threadId, viewId } = artifact;
  const drillKey = artifact.drill?.key ?? null;
  const { spec, error, rows, loading, rerun } = useView(threadId, viewId, active, drillKey);

  // ── Filters (T6): client-side slices, per view instance ───────────────────
  const [activeFilters, setActiveFilters] = useState<ActiveFilters>({});
  const filteredRows = useMemo(
    () => (rows && spec ? applyFilters(rows, spec.filters, activeFilters) : rows),
    [rows, spec, activeFilters]
  );
  const pinScope = useMemo(() => viewPinScope(activeFilters, drillKey), [activeFilters, drillKey]);
  const [showSpec, setShowSpec] = useState(false);
  const [hover, setHover] = useState<HoverHint>(null);
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
      if (outcome === "nothing-here") flashNote("nothing pinnable there — click a row, bar or bin");
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
        "no pins yet — toggle \u{1F4CC} pin, then click a row, bar or bin. A view pin follows the THING and survives re-run as long as the data still holds it.",
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
      if (!spec || el === null) {
        setHover(null);
        return;
      }
      const hit = describeAnchor(el);
      if (!hit) {
        setHover(null);
        return;
      }
      setHover({
        label: hit.label,
        verb: spec.drill ? `› ${spec.drill.title.split("{key}").join(hit.key)}` : "→ thread",
      });
    },
    [spec, describeAnchor]
  );

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
          {(spec.filters ?? []).map((f) => {
            const values = filterValues(rows ?? [], f);
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
            title="Pin mode: click a row, bar or bin to drop a numbered pin"
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
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <div
            ref={setRoot}
            onClickCapture={pins.onCapture}
            onClick={onBodyClick}
            onMouseLeave={() => setHover(null)}
            style={{
              position: "relative",
              minHeight: "100%",
              cursor: pinMode ? "crosshair" : undefined,
              background: pinMode ? "rgba(228, 228, 231, 0.04)" : "transparent",
            }}
          >
            <ViewBody spec={spec} rows={windowed.rows} onActivate={openAnchor} onHover={onHoverAnchor} />
            {pins.marks}
          </div>
        </div>
        {pins.rail}
      </div>
    </SurfaceAnchorContext.Provider>
  );
}

// ── Renderers (ours; the agent's data never executes) ────────────────────────

type RendererProps = {
  spec: ViewSpec;
  rows: ViewRow[];
  /** Enter on a focused anchor (T6) — the click path goes through the wrapper. */
  onActivate: (el: EventTarget | null) => void;
  onHover: (el: EventTarget | null) => void;
};

function ViewBody({ spec, rows, onActivate, onHover }: RendererProps) {
  switch (spec.kind) {
    case "table":
      return <TableView spec={spec} rows={rows} onActivate={onActivate} onHover={onHover} />;
    case "candles":
      return (
        <Suspense
          fallback={
            <div style={{ padding: 24, fontFamily: MONO, fontSize: 11, color: "var(--text-dim)" }}>
              loading chart…
            </div>
          }
        >
          <div style={{ padding: "8px 10px" }}>
            <CandleChart
              bars={toOhlcRows(rows)}
              markers={(spec.markers ?? []).map((m) => ({ ts: m.ts, label: m.label }))}
              height={360}
              intraday
            />
          </div>
        </Suspense>
      );
    case "dist":
      return <DistView spec={spec} rows={rows} onActivate={onActivate} onHover={onHover} />;
  }
}

/** The table renderer: kit tokens, click-to-sort, `row:<key>` anchors.
 *  Rows are focusable (T6): Enter opens the focused row the way a click does. */
function TableView({ spec, rows, onActivate, onHover }: RendererProps) {
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
              style={{ borderBottom: "1px solid var(--border)", cursor: anchor ? "pointer" : undefined, outline: "none" }}
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

/** The distribution renderer: a plain SVG bar chart with `bin:<n>` anchors —
 *  40 honest lines instead of bending uPlot into a histogram. Soft palette;
 *  no new colour. */
function DistView({ spec, rows, onActivate, onHover }: RendererProps) {
  const bins = toDistBins(rows, spec);
  if (bins.length === 0) {
    return (
      <div style={{ padding: 24, fontFamily: MONO, fontSize: 11, color: "var(--text-dim)" }}>
        no bins — a dist view expects pre-binned rows (label + count)
      </div>
    );
  }
  const max = Math.max(...bins.map((b) => Math.abs(b.count)), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, padding: "18px 14px 4px", height: 260 }}>
      {bins.map((bin, i) => {
        const h = Math.max(2, Math.round((Math.abs(bin.count) / max) * 200));
        return (
          <div
            key={`${bin.label}-${i}`}
            {...{ [ANCHOR_ATTR]: `bin:${i}`, [ANCHOR_LABEL_ATTR]: bin.label }}
            tabIndex={0}
            title={`${bin.label}: ${bin.count}`}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onActivate(e.currentTarget);
              }
            }}
            onMouseEnter={(e) => onHover(e.currentTarget)}
            onMouseLeave={() => onHover(null)}
            style={{
              flex: 1,
              minWidth: 4,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              cursor: "pointer",
              outline: "none",
            }}
          >
            <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--text-faint)" }}>
              {bin.count}
            </span>
            <div
              style={{
                width: "100%",
                height: h,
                background: bin.count >= 0 ? "var(--text-muted)" : "var(--text-faint)",
                borderRadius: "2px 2px 0 0",
              }}
            />
            <span
              style={{
                fontFamily: MONO,
                fontSize: 8.5,
                color: "var(--text-dim)",
                maxWidth: "100%",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {bin.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
