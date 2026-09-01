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

import { Suspense, lazy, useCallback, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Artifact } from "../../types";
import {
  useView,
  windowRows,
  tableColumns,
  rowAnchorId,
  toOhlcRows,
  toDistBins,
} from "../../lib/viewStore";
import type { ViewRow, ViewSpec } from "../../lib/viewStore";
import { viewPinTargetFor } from "../../lib/pins";
import { getThreadById, threadRepoName } from "../../lib/threadStore";
import { artifactIdentity } from "../../lib/panelStore";
import { kbWriteDoc } from "../../lib/ipc";
import { SurfaceAnchorContext, composeAnchorProviders, domAnchorProvider, ANCHOR_ATTR } from "../../surfaces/anchors";
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

type ViewArtifact = Extract<Artifact, { kind: "view" }>;

export function ViewSurface({ artifact, active }: { artifact: ViewArtifact; active: boolean }) {
  const { threadId, viewId } = artifact;
  const { spec, error, rows, loading, rerun } = useView(threadId, viewId, active);

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
    const { sidecarPath, docKey } = viewPinTargetFor(project, threadId, viewId);
    return {
      artifact,
      sidecarPath,
      docKey,
      identity: artifactIdentity(artifact),
      scopeNote: `view ${docKey}`,
      emptyHint:
        "no pins yet — toggle \u{1F4CC} pin, then click a row, bar or bin. A view pin follows the THING and survives re-run as long as the data still holds it.",
    };
  }, [artifact, project, threadId, viewId]);
  const pins = useAnchoredPins(target, provider, rootEl, pinMode, onPlaced, active);

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

  const windowed = rows ? windowRows(rows) : { rows: [] as ViewRow[], total: 0, windowed: false };

  return (
    <SurfaceAnchorContext.Provider value={registry}>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={TOOLBAR_STYLE}>
          <span style={{ color: "var(--text-primary)", flex: "none" }}>{spec.kind}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{spec.title}</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis" }}>
            {flash ??
              `${spec.source.type === "file" ? spec.source.path : spec.source.url} · ${
                spec.builtAt ? spec.builtAt.slice(0, 16).replace("T", " ") : ""
              } · ${spec.builtBy}${windowed.windowed ? ` · showing ${windowed.rows.length} of ${windowed.total} rows` : ""}`}
          </span>
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
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          <div
            ref={setRoot}
            onClickCapture={pins.onCapture}
            style={{
              position: "relative",
              minHeight: "100%",
              cursor: pinMode ? "crosshair" : undefined,
              background: pinMode ? "rgba(228, 228, 231, 0.04)" : "transparent",
            }}
          >
            <ViewBody spec={spec} rows={windowed.rows} />
            {pins.marks}
          </div>
        </div>
        {pins.rail}
      </div>
    </SurfaceAnchorContext.Provider>
  );
}

// ── Renderers (ours; the agent's data never executes) ────────────────────────

function ViewBody({ spec, rows }: { spec: ViewSpec; rows: ViewRow[] }) {
  switch (spec.kind) {
    case "table":
      return <TableView spec={spec} rows={rows} />;
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
      return <DistView spec={spec} rows={rows} />;
  }
}

/** The table renderer: kit tokens, click-to-sort, `row:<key>` anchors. */
function TableView({ spec, rows }: { spec: ViewSpec; rows: ViewRow[] }) {
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
              {...(anchor ? { [ANCHOR_ATTR]: `row:${anchor}` } : {})}
              style={{ borderBottom: "1px solid var(--border)" }}
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
function DistView({ spec, rows }: { spec: ViewSpec; rows: ViewRow[] }) {
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
            {...{ [ANCHOR_ATTR]: `bin:${i}` }}
            title={`${bin.label}: ${bin.count}`}
            style={{ flex: 1, minWidth: 4, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}
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
