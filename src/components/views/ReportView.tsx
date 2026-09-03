// THE REPORT SURFACE (SWIT-73): one markdown document with LIVE views
// embedded — narrative, stat tiles and interactive charts reading as one
// page beside the thread.
//
// Rendering is a straight composition of things that already exist:
//   · reportStore.splitReport cuts the markdown at ```view / ```stat fences;
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
//     the rest of the report renders (the isolation rule).
//
// This file is a LAZY chunk (ViewSurface reaches it through `lazy()`), and
// the chart libraries stay lazy below it — ViewChrome's ViewBody loads
// uPlot/lightweight-charts only when a block actually draws one.

import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";

import type { Artifact } from "../../types";
import { splitReport, parseStatTiles, takeReportAnchor } from "../../lib/reportStore";
import type { ReportSegment, StatTile } from "../../lib/reportStore";
import { parseInlineViewSpec, useInlineViewData } from "../../lib/viewStore";
import type { ViewSpec } from "../../lib/viewStore";
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

// The STAT TILE (SWIT-73; design/wireframe-kit/components.md): one number
// with a label and an optional n — the earned box for a headline figure.
const TILE_ROW: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  margin: "10px 24px 14px",
};

const TILE: CSSProperties = {
  minWidth: 96,
  padding: "8px 14px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  fontFamily: MONO,
};

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
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Evidence → heading (SWIT-73): an address `view:<id>#h:<slug>` parked its
  // anchor in reportStore's one-shot before opening this artifact. Taken only
  // once the markdown is on screen; the stamp lands ASYNC (MarkdownBody's
  // processor then its decorate effect), so a short retry loop holds the
  // taken anchor until the element exists — or gives up quietly (a renamed
  // heading is not an error state).
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
  }, [threadId, viewId, markdown]);

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
            segments.map((seg, i) => (
              <Segment
                key={seg.kind === "markdown" ? `md-${i}` : `b${seg.block}`}
                seg={seg}
                report={spec}
                threadId={threadId}
                viewId={viewId}
                artifact={artifact}
                active={active}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Segment({
  seg,
  report,
  threadId,
  viewId,
  artifact,
  active,
}: {
  seg: ReportSegment;
  report: ViewSpec;
  threadId: string;
  viewId: string;
  artifact: ViewArtifact;
  active: boolean;
}) {
  if (seg.kind === "markdown") return <MarkdownBody content={seg.text} />;
  if (seg.kind === "stat") return <StatBlock block={seg.block} body={seg.body} />;
  return (
    <EmbeddedView
      block={seg.block}
      body={seg.body}
      report={report}
      threadId={threadId}
      viewId={viewId}
      artifact={artifact}
      active={active}
    />
  );
}

function BlockError({ block, kind, error }: { block: number; kind: "view" | "stat"; error: string }) {
  return (
    <div style={BLOCK_ERROR}>
      {kind} block {block}: {error}
    </div>
  );
}

function StatBlock({ block, body }: { block: number; body: string }) {
  const parsed = useMemo(() => parseStatTiles(body), [body]);
  if (parsed.error !== null) return <BlockError block={block} kind="stat" error={parsed.error} />;
  return (
    <div style={TILE_ROW}>
      {parsed.tiles.map((tile, i) => (
        <StatTileBox key={`${tile.label}-${i}`} tile={tile} />
      ))}
    </div>
  );
}

function StatTileBox({ tile }: { tile: StatTile }) {
  return (
    <div style={TILE}>
      <div
        style={{
          fontSize: 9.5,
          letterSpacing: "0.5px",
          textTransform: "uppercase",
          color: "var(--text-dim)",
          marginBottom: 3,
          whiteSpace: "nowrap",
        }}
      >
        {tile.label}
      </div>
      <div style={{ fontSize: 16, lineHeight: 1.2, color: "var(--text-primary)", whiteSpace: "nowrap" }}>
        {tile.value}
        {tile.n !== undefined && (
          <span style={{ fontSize: 9.5, color: "var(--text-faint)", marginLeft: 6 }}>n={tile.n}</span>
        )}
      </div>
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
}: {
  block: number;
  body: string;
  report: ViewSpec;
  threadId: string;
  viewId: string;
  artifact: ViewArtifact;
  active: boolean;
}) {
  const derived = useMemo(() => parseInlineViewSpec(body, block, report), [body, block, report]);
  const data = useInlineViewData(threadId, derived.spec);
  if (derived.spec === null) {
    return <BlockError block={block} kind="view" error={derived.error ?? "malformed"} />;
  }
  return (
    <div style={BLOCK_FRAME}>
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
