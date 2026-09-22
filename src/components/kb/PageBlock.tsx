// PAGE BLOCKS (SWIT-95, Ky's plan/PageBlock.tsx + handoff/HandoffBlock.tsx's
// StatusPill) — the shapes every section of the ✦ page is built from: a
// titled block (a foldable chevron, a dim note, an action slot) over
// column-headed rows, a status word as a colored pill, and a row's relative
// age. Ky's Tailwind classes translated into our tokens as inline style
// constants; no opinions about WHAT a block holds, only how one looks.
//
// NO COUNT IN A TITLE AND NO COLORED HEADING (Ky's CC-832 rule, carried
// verbatim): a block's title is always `--text-primary`, never amber —
// whatever needs the reader's attention shows on a ROW (a pill, an owner
// column, an age), not on the section it lives in.
//
// `PillTone`/`statusTone`/`itemPill`/`titleCase`/`ago` are pure — they live
// in `lib/statusPill.ts`, not here, so pageStore and the turn-end hook can
// read the same word→tone rule without importing a component module.

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ago, statusTone, titleCase } from "../../lib/statusPill";
import type { PillTone } from "../../lib/statusPill";

const MONO = "var(--font-mono)";
const READING = "var(--font-reading)";

const HEADER: CSSProperties = {
  display: "flex",
  minWidth: 0,
  alignItems: "center",
  gap: 10,
  // --bg-hover, not --bg-active: on the --bg-panel body (#141414) the
  // #1a1a1a step is the one global.css says "is too close to read"; the
  // header strip is a structural surface, not a hover accent.
  background: "var(--bg-hover)",
  padding: "9px 14px 8px",
};

const TITLE: CSSProperties = {
  margin: 0,
  whiteSpace: "nowrap",
  fontFamily: READING,
  fontSize: 13.5,
  fontWeight: 600,
  color: "var(--text-primary)",
};

const NOTE: CSSProperties = {
  minWidth: 0,
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: MONO,
  fontSize: 10,
  color: "var(--text-faint)",
};

// The body scrolls sideways when a grid's fixed columns outgrow a narrow
// panel; `.page-block-body` gives that bar the terminal host's thin, visible
// thumb (global.css) — Chromium's 15px fallback read as nothing (SWIT-68).
const BODY: CSSProperties = {
  minWidth: 0,
  padding: "2px 14px 4px",
  overflowX: "auto",
};

/** A section of the page: a titled block over its rows — header on the
 *  raised surface with a hairline under it while open, an optional dim note
 *  and an action slot at the right, an optional fold chevron (Ky's
 *  PageBlock). Radius 9, `--bg-panel` body. */
export function PageBlock({
  title,
  note,
  action,
  fold,
  dataPageBlock,
  children,
}: {
  title: string;
  /** Dim mono text beside the title. */
  note?: ReactNode;
  /** At the header's right end. */
  action?: ReactNode;
  /** Present only when the block folds; absent, the block is always open
   *  and the title carries no chevron. */
  fold?: { open: boolean; onToggle: () => void };
  /** SWIT-79's scroll-target name (a focus request's `[data-page-block]`). */
  dataPageBlock?: string;
  children?: ReactNode;
}) {
  const open = fold ? fold.open : true;
  return (
    <section
      data-page-block={dataPageBlock}
      style={{ borderRadius: 9, border: "1px solid var(--border)", background: "var(--bg-panel)" }}
    >
      <header
        style={{
          ...HEADER,
          borderBottom: open ? "1px solid var(--border)" : "none",
          borderRadius: open ? "8px 8px 0 0" : 8,
        }}
      >
        <h2 style={TITLE}>
          {fold ? (
            <button
              type="button"
              onClick={fold.onToggle}
              aria-expanded={open}
              title={open ? "Fold this section" : "Unfold this section"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "none",
                padding: 0,
                font: "inherit",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              <svg
                width="8"
                height="8"
                viewBox="0 0 8 8"
                aria-hidden
                style={{ flex: "none", color: "var(--text-faint)", transform: open ? "rotate(90deg)" : undefined }}
              >
                <path d="M2.5 1 L6 4 L2.5 7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {title}
            </button>
          ) : (
            title
          )}
        </h2>
        {note !== undefined && <span style={NOTE}>{note}</span>}
        {action && <span style={{ display: "flex", flex: "none", alignItems: "center", gap: 6 }}>{action}</span>}
      </header>
      {open && (
        <div className="page-block-body" style={BODY}>
          {children}
        </div>
      )}
    </section>
  );
}

type ColumnLabel = string | { label: string; right: true };

/** The rows' column names, once above them (Ky's ColumnHeads). A `{label,
 *  right}` entry right-aligns. */
export function ColumnHeads({ grid, labels }: { grid: CSSProperties; labels: readonly ColumnLabel[] }) {
  return (
    <div
      style={{
        display: "grid",
        ...grid,
        columnGap: 11,
        borderBottom: "1px solid var(--border)",
        padding: "7px 0 5px",
        fontFamily: MONO,
        fontSize: 9,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-faint)",
      }}
    >
      {labels.map((l, i) =>
        typeof l === "string" ? <span key={i}>{l}</span> : <span key={i} style={{ textAlign: "right" }}>{l.label}</span>
      )}
    </div>
  );
}

/** check · item · link · status · owner. */
export const TODO_GRID: CSSProperties = { gridTemplateColumns: "14px minmax(0,1fr) 150px 124px 52px" };
/** artifact · title · status · updated · ×. */
export const ARTIFACT_GRID: CSSProperties = { gridTemplateColumns: "176px minmax(0,1fr) 124px 52px 14px" };
/** time · line. */
export const TURN_GRID: CSSProperties = { gridTemplateColumns: "64px minmax(0,1fr)" };

const DOT: CSSProperties = { display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", flex: "none" };

/** The "moved since your last visit" marker — the one place the accent
 *  means "you are here for the first time." */
export function NewDot({ style }: { style?: CSSProperties } = {}) {
  return <span style={{ ...DOT, ...style }} title="New since you last looked" />;
}

const PILL_BASE: CSSProperties = {
  display: "inline-flex",
  maxWidth: "100%",
  width: 124,
  overflow: "hidden",
  whiteSpace: "nowrap",
  justifyContent: "center",
  borderRadius: 11,
  fontFamily: MONO,
  fontSize: 10,
  fontWeight: 600,
  padding: "2px 8px",
};

const PILL_TONE: Record<PillTone, CSSProperties> = {
  amber: { background: "var(--tone-amber)", color: "var(--bg-primary)" },
  green: { background: "var(--accent)", color: "var(--bg-primary)" },
  blue: { background: "var(--tone-blue)", color: "var(--bg-primary)" },
  neutral: { background: "var(--bg-hover)", color: "var(--text-secondary)", border: "1px solid var(--border)" },
  dim: { background: "transparent", color: "var(--text-faint)", border: "1px solid var(--border)" },
};

/** A status word as a solid, one-width pill (Ky's HandoffBlock.StatusPill):
 *  a long word truncates rather than growing the slot. An empty word draws
 *  nothing — a bare column, not an empty pill. */
export function StatusPill({ word, tone }: { word: string; tone?: PillTone }) {
  if (!word) return null;
  const t = tone ?? statusTone(word);
  const text = titleCase(word);
  return (
    <span style={{ ...PILL_BASE, ...PILL_TONE[t] }} title={text} data-tone={t}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{text}</span>
    </span>
  );
}

const AGE: CSSProperties = { whiteSpace: "nowrap", textAlign: "right", fontFamily: MONO, fontSize: 10, color: "var(--text-faint)" };

/** A row's age, dim at the right, with the new dot in front of it when the
 *  row moved since the reader last looked (Ky's Age). */
export function Age({ at, isNew = false }: { at: string | null | undefined; isNew?: boolean }) {
  const valid = Boolean(at) && !Number.isNaN(Date.parse(at ?? ""));
  return (
    <span style={AGE} title={valid ? new Date(at as string).toLocaleString() : undefined}>
      {isNew && <NewDot style={{ marginRight: 4 }} />}
      {valid ? ago(at as string) : ""}
    </span>
  );
}

const FOLD_LINK: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  padding: "6px 0",
  fontFamily: MONO,
  fontSize: 10,
  color: "var(--text-faint)",
  cursor: "pointer",
};

/** "N finished · show" / "hide" — the one row folded rows sit behind
 *  (Decided, Dropped, This turn's earlier turns). */
export function Fold({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="page-textlink" onClick={() => setOpen((v) => !v)} style={FOLD_LINK}>
        {open ? "hide" : `${count} ${label} · show`}
      </button>
      {open && children}
    </div>
  );
}

const TABS: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 16, borderBottom: "1px solid var(--border)", paddingTop: 4, marginBottom: 4 };

function tabStyle(on: boolean): CSSProperties {
  return {
    marginBottom: -1,
    padding: "4px 0 6px",
    background: "none",
    border: "none",
    borderBottom: `1.5px solid ${on ? "var(--text-primary)" : "transparent"}`,
    fontFamily: MONO,
    fontSize: 10.5,
    color: on ? "var(--text-primary)" : "var(--text-faint)",
    whiteSpace: "nowrap",
    flex: "none",
    cursor: "pointer",
  };
}

/** A block's filter by kind — one tab per present group, each with its own
 *  count (Ky's TypeTabs; our groups already include an aggregate `recent`
 *  first, so unlike Ky's this never adds a synthetic "All" of its own —
 *  there is no unfiltered total in the underlying model to show). */
export function TypeTabs({
  tabs,
  selected,
  onSelect,
}: {
  tabs: ReadonlyArray<{ id: string; label: string; count: number }>;
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div style={TABS} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={selected === t.id} onClick={() => onSelect(t.id)} style={tabStyle(selected === t.id)}>
          {t.label} <span style={{ color: "var(--text-faint)" }}>{t.count}</span>
        </button>
      ))}
    </div>
  );
}
