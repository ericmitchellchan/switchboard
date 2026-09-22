// THE REPORT SURFACE (SWIT-73): one markdown document with LIVE views
// embedded — narrative, stat tiles and interactive charts reading as one
// page beside the thread.
//
// Rendering is a straight composition of things that already exist:
//   · reportStore.splitReport cuts the markdown at ```view / ```stat /
//     ```facts fences (SWIT-96 adds the third);
//   · narrative segments go through THE markdown pipeline (MarkdownBody —
//     same processor, same typography, same link policy as every KB doc;
//     MarkdownDocStyles is mounted once so five fragments share one style
//     block). Headings therefore get their `h:<slug>` data-anchor stamps for
//     free, which is what makes `view:<id>#h:<slug>` evidence addresses land;
//   · each ```view block derives its spec (viewStore.parseInlineViewSpec —
//     id `<report>~b<n>`, builtAt from the REPORT so `op: update` reloads
//     every block), loads its own data (useInlineViewData, the same fetch
//     path as a standalone view) and renders through ViewChrome — the SAME
//     toolbar/anchors/pins/hover/drill the standalone surface draws, with
//     the block number namespacing its pin scope;
//   · a malformed block renders as ONE inline error card naming the block;
//     the rest of the report renders (the isolation rule) — and a render
//     THROW inside a block is caught by a per-block boundary (BlockBoundary)
//     so one crashing chart never trips the terminal screen's boundary;
//   · live blocks are capped at reportStore.REPORT_BLOCK_CAP — the split
//     turns the rest into plain code fences plus one `overflow` card.
//
// SWIT-96 (a dashboard is a report with a layout): reportStore.packRows
// groups consecutive `half`/`third`-width view/stat blocks (no narrative
// between them) into CSS grid rows — `EmbeddedView`/`StatBlock` are
// unchanged, they just render inside a narrower cell (`packed` drops their
// own outer margin, since the row wrapper already carries the gutter/gap).
// A ```facts block never packs — see `FactsBlock`. `width` never reaches
// parseInlineViewSpec/parseStatTiles — reportStore.stripBlockWidth removes
// it first, since it is report LAYOUT, not part of either grammar.
//
// This file is a LAZY chunk (ViewSurface reaches it through `lazy()`), and
// the chart libraries stay lazy below it — ViewChrome's ViewBody loads
// uPlot/lightweight-charts only when a block actually draws one.

import { Component, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { CSSProperties, ErrorInfo, ReactNode } from "react";

import type { Artifact } from "../../types";
import {
  REPORT_BLOCK_CAP,
  packRows,
  parseFactsBlock,
  parseStatTiles,
  reportAnchorNonce,
  splitReport,
  stripBlockWidth,
  subscribeReportAnchor,
  takeReportAnchor,
} from "../../lib/reportStore";
import type { FactsItem, ReportSegment, StatTile } from "../../lib/reportStore";
import { log } from "../../lib/logger";
import { parseInlineViewSpec, useInlineViewData } from "../../lib/viewStore";
import type { ViewSpec } from "../../lib/viewStore";
import { statTone } from "../../lib/viewTone";
import { MarkdownBody, MarkdownDocStyles } from "../kb/MarkdownDoc";
import { ViewChrome } from "./ViewSurface";

const MONO = "var(--font-mono)";

type ViewArtifact = Extract<Artifact, { kind: "view" }>;

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

/** An embedded block's frame: one hairline separating a chart region from
 *  the prose around it. */
const BLOCK_FRAME: CSSProperties = {
  margin: "10px 24px 14px",
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: 4,
  overflow: "hidden",
};

/** The inline error card — one line naming the block; no narration. */
const BLOCK_ERROR: CSSProperties = {
  margin: "10px 24px 14px",
  padding: "8px 12px",
  border: "1px solid var(--border)",
  borderRadius: 4,
  fontFamily: MONO,
  fontSize: 10.5,
  lineHeight: 1.5,
  color: "var(--text-muted)",
};

/** SWIT-96: a block PACKED into a grid row (see `packRows`) drops its own
 *  outer margin — the row wrapper already carries the 24px gutter and the
 *  10px gap between cells. Everything else about the box is unchanged. */
function packedStyle(base: CSSProperties, packed: boolean): CSSProperties {
  return packed ? { ...base, margin: 0 } : base;
}

/** A packed row of `columns` cells — 10px gap, the doc's 24px gutter. */
function packedRowStyle(columns: number): CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gap: 10,
    margin: "10px 24px 14px",
  };
}

// The STAT CARD (SWIT-73; re-cut 2026-09-09 after Ky's report cards, then
// again SWIT-96 for Ky's headline-tile layout — design/wireframe-kit/
// components.md): the figure top-left, a sparkline top-right, the label
// under the figure, then delta / note / an optional accent chip. Cards flow
// two-up in the panel's width (`flex: 1 1 180px`) when not packed into a
// half/third cell.
const TILE_ROW: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  margin: "10px 24px 16px",
  minWidth: 0,
};

const TILE: CSSProperties = {
  flex: "1 1 180px",
  minWidth: 0,
  padding: "12px 14px 13px",
  background: "var(--bg-active)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontFamily: "var(--font-reading)",
};

const TILE_LABEL: CSSProperties = {
  marginTop: 4,
  fontFamily: MONO,
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-faint)",
};

/** Ky's accent chip on a card (`2 – 3× benchmark`): the accent at 12% for
 *  the fill, the dim accent for the hairline, the accent for the words. */
const TILE_TAG: CSSProperties = {
  display: "inline-block",
  marginTop: 8,
  padding: "2px 8px",
  borderRadius: 6,
  fontSize: 10.5,
  lineHeight: 1.5,
  color: "var(--accent)",
  background: "color-mix(in srgb, var(--accent) 12%, transparent)",
  border: "1px solid var(--accent-dim)",
  whiteSpace: "nowrap",
};

// THE FACTS HEADER (SWIT-96, Ky's FactsRow re-cut for a dashboard's opening
// card — design/wireframe-kit/components.md): ONE raised card, label/value
// pairs in a flex-wrap row. Never packed — see `packRows`.
const FACTS_CARD: CSSProperties = {
  margin: "10px 24px 16px",
  padding: "12px 16px",
  background: "var(--bg-active)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  display: "flex",
  flexWrap: "wrap",
  gap: "8px 28px",
};

const FACTS_LABEL: CSSProperties = {
  fontFamily: MONO,
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-faint)",
};

const FACTS_VALUE: CSSProperties = {
  marginTop: 3,
  fontFamily: "var(--font-reading)",
  fontSize: 13,
  color: "var(--text-primary)",
};

function factsToneColor(tone: FactsItem["tone"]): string {
  if (tone === "accent") return "var(--accent)";
  if (tone === "amber") return "var(--tone-amber)";
  return "var(--text-primary)";
}

/** A tiny trend line, Ky's StatusViz Sparkline: 72×20, no axes, no fill,
 *  nothing for fewer than two points. */
const SPARK_W = 72;
const SPARK_H = 20;
const SPARK_PAD = 1;

function Sparkline({ series }: { series: number[] }) {
  if (series.length < 2) return null;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min;
  const points = series
    .map((v, i) => {
      const x = (i / (series.length - 1)) * SPARK_W;
      const y =
        span === 0
          ? SPARK_H / 2
          : SPARK_H - SPARK_PAD - ((v - min) / span) * (SPARK_H - SPARK_PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} style={{ flex: "none" }} aria-hidden="true">
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function ReportView({
  spec,
  markdown,
  error,
  threadId,
  viewId,
  artifact,
  active,
}: {
  spec: ViewSpec;
  markdown: string | null;
  error: string | null;
  threadId: string;
  viewId: string;
  artifact: ViewArtifact;
  active: boolean;
}) {
  const segments = useMemo(() => (markdown === null ? [] : splitReport(markdown)), [markdown]);
  const rows = useMemo(() => packRows(segments), [segments]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Evidence → heading (SWIT-73): an address `view:<id>#h:<slug>` parked its
  // anchor in reportStore's one-shot before opening this artifact. The slot
  // is OBSERVABLE — the nonce bumps on every request — so a report ALREADY
  // on screen consumes a fresh click now rather than whenever it happens to
  // re-render. Taken only once the markdown is on screen; the stamp lands
  // ASYNC (MarkdownBody's processor then its decorate effect), so a short
  // retry loop holds the taken anchor until the element exists — or gives up
  // quietly (a renamed heading is not an error state).
  const anchorRequest = useSyncExternalStore(subscribeReportAnchor, reportAnchorNonce);
  useEffect(() => {
    if (markdown === null) return;
    const anchor = takeReportAnchor(threadId, viewId);
    if (!anchor) return;
    let tries = 0;
    let timer = 0;
    const find = () => {
      const el = rootRef.current?.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`);
      if (el) {
        el.scrollIntoView({ block: "start" });
        return;
      }
      if (++tries < 12) timer = window.setTimeout(find, 150);
    };
    find();
    return () => window.clearTimeout(timer);
  }, [threadId, viewId, markdown, anchorRequest]);

  const sourcePath = spec.source.type === "file" ? spec.source.path : "";
  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={TOOLBAR_STYLE}>
        <span style={{ color: "var(--text-primary)", flex: "none" }}>report</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{spec.title}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis" }}>
          {sourcePath}
          {spec.builtAt ? ` · ${spec.builtAt.slice(0, 16).replace("T", " ")}` : ""} · {spec.builtBy}
        </span>
      </div>
      <div ref={rootRef} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {/* The narrative fragments share the KB doc typography; the report
            trims the per-fragment padding so segments read as one page. */}
        <MarkdownDocStyles />
        <style>{`.sb-report .kb-doc { padding: 6px 24px 2px; }`}</style>
        <div className="sb-report" style={{ maxWidth: 860, paddingBottom: 48 }}>
          {markdown === null ? (
            <div style={{ padding: 24, fontFamily: MONO, fontSize: 11, color: "var(--text-dim)" }}>
              {error ?? "loading…"}
            </div>
          ) : (
            rows.map((row, ri) =>
              row.columns > 1 ? (
                <div key={`row-${ri}`} style={packedRowStyle(row.columns)}>
                  {row.segments.map((seg) => (
                    <Segment
                      key={segKey(seg, ri)}
                      seg={seg}
                      report={spec}
                      threadId={threadId}
                      viewId={viewId}
                      artifact={artifact}
                      active={active}
                      packed
                    />
                  ))}
                </div>
              ) : (
                <Segment
                  key={segKey(row.segments[0], ri)}
                  seg={row.segments[0]}
                  report={spec}
                  threadId={threadId}
                  viewId={viewId}
                  artifact={artifact}
                  active={active}
                />
              )
            )
          )}
        </div>
      </div>
    </div>
  );
}

/** A segment's React key — the block number for anything live (stable
 *  across re-packing), else the row index (markdown/overflow segments are
 *  never involved in packing, so a row index is a stable-enough key). */
function segKey(seg: ReportSegment, rowIndex: number): string {
  if (seg.kind === "view" || seg.kind === "stat" || seg.kind === "facts") return `b${seg.block}`;
  if (seg.kind === "overflow") return `overflow-${rowIndex}`;
  return `md-${rowIndex}`;
}

function Segment({
  seg,
  report,
  threadId,
  viewId,
  artifact,
  active,
  packed = false,
}: {
  seg: ReportSegment;
  report: ViewSpec;
  threadId: string;
  viewId: string;
  artifact: ViewArtifact;
  active: boolean;
  packed?: boolean;
}) {
  if (seg.kind === "markdown") return <MarkdownBody content={seg.text} />;
  if (seg.kind === "overflow") {
    return (
      <div style={BLOCK_ERROR}>
        report has {seg.total} view/stat/facts blocks; the cap is {REPORT_BLOCK_CAP} — the rest
        render as code
      </div>
    );
  }
  if (seg.kind === "facts") return <FactsBlock block={seg.block} body={seg.body} />;
  if (seg.kind === "stat") return <StatBlock block={seg.block} body={seg.body} packed={packed} />;
  return (
    <BlockBoundary block={seg.block} packed={packed}>
      <EmbeddedView
        block={seg.block}
        body={seg.body}
        report={report}
        threadId={threadId}
        viewId={viewId}
        artifact={artifact}
        active={active}
        packed={packed}
      />
    </BlockBoundary>
  );
}

// Per-BLOCK crash isolation (SWIT-73 review): a render throw inside one
// embedded chart becomes THAT block's error card, never the terminal screen's
// boundary — the same rule SurfaceErrorBoundary applies per page, at block
// grain. No retry button: the markdown poll / `op: update` remounts blocks
// when the report changes, which is the honest recovery path.
type BoundaryState = { error: Error | null };

class BlockBoundary extends Component<{ block: number; packed?: boolean; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error(`Report view block ${this.props.block} crashed: ${error}${info.componentStack ?? ""}`);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={packedStyle(BLOCK_ERROR, this.props.packed ?? false)}>
          view block {this.props.block} failed to render:{" "}
          {String(this.state.error.message || this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

function BlockError({
  block,
  kind,
  error,
  packed = false,
}: {
  block: number;
  kind: "view" | "stat" | "facts";
  error: string;
  packed?: boolean;
}) {
  return (
    <div style={packedStyle(BLOCK_ERROR, packed)}>
      {kind} block {block}: {error}
    </div>
  );
}

function StatBlock({ block, body, packed = false }: { block: number; body: string; packed?: boolean }) {
  const parsed = useMemo(() => parseStatTiles(stripBlockWidth(body)), [body]);
  if (parsed.error !== null) return <BlockError block={block} kind="stat" error={parsed.error} packed={packed} />;
  return (
    <div style={packedStyle(TILE_ROW, packed)}>
      {parsed.tiles.map((tile, i) => (
        <StatTileBox key={`${tile.label}-${i}`} tile={tile} />
      ))}
    </div>
  );
}

function StatTileBox({ tile }: { tile: StatTile }) {
  const hasSpark = (tile.series?.length ?? 0) >= 2;
  return (
    <div style={TILE}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div
          style={{
            fontSize: 24,
            fontWeight: 600,
            lineHeight: 1.15,
            color: statTone(tile),
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {tile.value}
          {tile.n !== undefined && (
            <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 400, color: "var(--text-faint)", marginLeft: 6 }}>n={tile.n}</span>
          )}
        </div>
        {hasSpark && <Sparkline series={tile.series as number[]} />}
      </div>
      <div style={TILE_LABEL}>{tile.label}</div>
      {tile.delta && (
        <div style={{ marginTop: 4, fontFamily: MONO, fontSize: 10.5, color: "var(--text-muted)" }}>{tile.delta}</div>
      )}
      {tile.note && (
        <div style={{ marginTop: 4, fontSize: 10.5, lineHeight: 1.45, color: "var(--text-muted)" }}>{tile.note}</div>
      )}
      {tile.tag && <span style={TILE_TAG}>{tile.tag}</span>}
    </div>
  );
}

function FactsBlock({ block, body }: { block: number; body: string }) {
  const parsed = useMemo(() => parseFactsBlock(body), [body]);
  if (parsed.error !== null) return <BlockError block={block} kind="facts" error={parsed.error} />;
  return (
    <div style={FACTS_CARD}>
      {parsed.items.map((item, i) => (
        <div key={`${item.label}-${i}`}>
          <div style={FACTS_LABEL}>{item.label}</div>
          <div style={{ ...FACTS_VALUE, color: factsToneColor(item.tone) }}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

/** One embedded ```view block: derive the spec, load its data, draw the SAME
 *  chrome a standalone view gets. The error card is parseInlineViewSpec's
 *  message; a load failure renders inside the chrome (the cannot-render card
 *  with `try again`), exactly as standalone. */
function EmbeddedView({
  block,
  body,
  report,
  threadId,
  viewId,
  artifact,
  active,
  packed = false,
}: {
  block: number;
  body: string;
  report: ViewSpec;
  threadId: string;
  viewId: string;
  artifact: ViewArtifact;
  active: boolean;
  packed?: boolean;
}) {
  const derived = useMemo(
    () => parseInlineViewSpec(stripBlockWidth(body), block, report),
    [body, block, report]
  );
  const data = useInlineViewData(threadId, derived.spec);
  if (derived.spec === null) {
    return <BlockError block={block} kind="view" error={derived.error ?? "malformed"} packed={packed} />;
  }
  return (
    <div style={packedStyle(BLOCK_FRAME, packed)}>
      <ViewChrome
        spec={derived.spec}
        error={data.error}
        rows={data.rows}
        meta={data.meta}
        loading={data.loading}
        rerun={data.rerun}
        threadId={threadId}
        viewId={viewId}
        artifact={artifact}
        active={active}
        drillKey={null}
        block={block}
        embedded
      />
    </div>
  );
}
