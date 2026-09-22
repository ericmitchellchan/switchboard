// KEPT VIEW (SWIT-53, half 1 — rendering only): a `.view.json` snapshot
// (ViewChrome's `keep()` writes `_scratch/<project>/<spec.id>-<stamp>.view.json`
// as `{spec, rows}`, no meta today — verified against `keep()` in
// ViewSurface.tsx) rendered through the SAME `ViewChrome` a live view draws
// with, over the snapshot's FROZEN rows — no thread, no data loading, no
// re-run, no drill, no live source at all.
//
// `docKind`'s `.view.json` suffix (lib/kb.ts) routes here through
// ArtifactBody, the one kind switch every host shares (panel, the full-width
// KB screen, the Explorer, the PiP window) — a kept view opens rendered
// wherever a kb-doc opens, with no extra wiring per host.
//
// WHY ViewChrome AND NOT A SEPARATE RENDERER: a kept view IS a view — same
// toolbar, same client-side filters, same spec disclosure, same hover
// tooltip over the same table/candles/bars/line renderers. `frozen` on
// ViewChromeProps hides exactly the affordances that need a live thread
// behind them (re-run, keep-again, pins, drill/send-to-thread) instead of
// forking the component.
//
// PINS ARE OFF, NOT FAKED: ViewChrome's pin file is keyed
// `view:<threadId>:<viewId>` inside `<project>/surface-pins.json` — a kept
// view has neither a real thread nor a real view id an agent could find
// again, so filing a pin there would be a pin nobody could ever locate.
// `frozen` hides the pin toggle and rail rather than pretend the file means
// anything. Lazy chunk, like ReportView — no chart library enters `main`.

import { useMemo } from "react";
import type { CSSProperties } from "react";
import type { Artifact, FileArtifact } from "../../types";
import { parseKeptView } from "../../lib/keptView";
import { ViewChrome } from "./ViewSurface";

// ViewChrome's `artifact` prop type is intentionally not exported (see
// ReportView.tsx, which derives the same local alias) — a view artifact is
// `Extract<Artifact, {kind:"view"}>` from the one source of truth in types.ts.
type ViewArtifact = Extract<Artifact, { kind: "view" }>;

const ERROR_STYLE: CSSProperties = {
  padding: 24,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-dim)",
  lineHeight: 1.6,
};

const NAME_STAMP = /-(\d{4}-\d{2}-\d{2})\.view\.json$/i;

/** The date this snapshot was kept — from the file name `keep()` writes
 *  (`<id>-<YYYY-MM-DD>.view.json`; the trailing anchor means the id's own
 *  dashes never confuse it), falling back to the spec's `builtAt` for a
 *  file placed by hand. Pure. */
export function keptStampFrom(path: string, builtAt: string): string {
  const name = path.split("/").pop() ?? "";
  const match = name.match(NAME_STAMP);
  if (match) return match[1];
  return builtAt.length >= 10 ? builtAt.slice(0, 10) : "unknown date";
}

function noop() {}

export default function KeptView({
  artifact,
  content,
  active,
}: {
  artifact: FileArtifact;
  content: string;
  active: boolean;
}) {
  const parsed = useMemo(() => parseKeptView(content), [content]);

  if (parsed.view === null) {
    return (
      <div style={ERROR_STYLE}>
        <div style={{ color: "var(--text-secondary)", marginBottom: 4 }}>
          {artifact.path.split("/").pop()}
        </div>
        <div>kept view: {parsed.error}</div>
      </div>
    );
  }

  const { spec, rows, meta } = parsed.view;
  const stamp = keptStampFrom(artifact.path, spec.builtAt);
  // A synthetic ViewArtifact for ViewChrome's own bookkeeping (pin identity,
  // artifactRef-style naming) — there is no real thread or live view id
  // behind a kept snapshot; `frozen` is what keeps that fiction harmless
  // (no pin/drill/re-run path ever reads threadId or viewId for real).
  const chromeArtifact: ViewArtifact = { kind: "view", threadId: "", viewId: spec.id };

  return (
    <ViewChrome
      spec={spec}
      error={null}
      rows={rows}
      meta={meta}
      loading={false}
      rerun={noop}
      threadId=""
      viewId={spec.id}
      artifact={chromeArtifact}
      active={active}
      drillKey={null}
      block={null}
      frozen
      frozenLabel={`kept ${stamp} · frozen`}
    />
  );
}
