// THE DOC TICK RAIL (SWIT-79, Ky's TocTickRail CC-702): a 34px column left
// of a markdown document — one 2px tick per heading (H1 wider), the heading
// nearest the scroll top in accent, the rest faint — that slides a 220px
// overlay of heading names + pin counts out OVER the content on hover or
// focus-within (Tab reaches it, so the buttons are never invisible tab
// stops); a click scroll-jumps to the heading.
//
// The ticks are MEASURED from the stamped `h:` anchors (MarkdownDoc's
// decorateDocAnchors) after paint and re-measured on resize / any mutation /
// scroll — SurfacePins' useAnchorPositions pattern, one rAF per burst — so
// the positions are never a stored guess. The geometry rule (which tick is
// active, the two tick shapes) is lib/docRail, pure and tested.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ANCHOR_ATTR } from "../../surfaces/anchors";
import {
  RAIL_OVERLAY_WIDTH,
  RAIL_WIDTH,
  TICK_GAP,
  TICK_HEIGHT,
  railTicks,
  type DocHeading,
} from "../../lib/docRail";

const MONO = "var(--font-mono)";

/** Collect the document's headings by their stamped anchors, in order,
 *  with their offsets from the DOC's top. */
function measureHeadings(doc: HTMLElement): DocHeading[] {
  const box = doc.getBoundingClientRect();
  const out: DocHeading[] = [];
  doc.querySelectorAll<HTMLElement>(`h1[${ANCHOR_ATTR}], h2[${ANCHOR_ATTR}], h3[${ANCHOR_ATTR}], h4[${ANCHOR_ATTR}], h5[${ANCHOR_ATTR}], h6[${ANCHOR_ATTR}]`).forEach((h) => {
    const key = h.getAttribute(ANCHOR_ATTR);
    if (!key || !key.startsWith("h:")) return;
    out.push({
      key,
      level: Number(h.tagName.slice(1)) || 1,
      text: (h.textContent ?? "").replace(/\s+/g, " ").trim() || key,
      top: Math.round(h.getBoundingClientRect().top - box.top),
    });
  });
  return out;
}

function sameHeadings(a: readonly DocHeading[], b: readonly DocHeading[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].top !== b[i].top || a[i].text !== b[i].text || a[i].level !== b[i].level) return false;
  }
  return true;
}

export function DocTickRail({
  docEl,
  scrollerEl,
  pinsByAnchor,
}: {
  /** The rendered document (anchor root). */
  docEl: HTMLElement | null;
  /** The element that scrolls it — where the scroll top is read and set. */
  scrollerEl: HTMLElement | null;
  /** Pin count per `h:` anchor key. */
  pinsByAnchor: ReadonlyMap<string, number>;
}) {
  const [headings, setHeadings] = useState<DocHeading[]>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const [open, setOpen] = useState(false);
  const frame = useRef<number | null>(null);

  const measure = useCallback(() => {
    frame.current = null;
    if (!docEl) {
      setHeadings((prev) => (prev.length > 0 ? [] : prev));
      return;
    }
    const next = measureHeadings(docEl);
    setHeadings((prev) => (sameHeadings(prev, next) ? prev : next));
    if (scrollerEl) setScrollTop(scrollerEl.scrollTop);
  }, [docEl, scrollerEl]);
  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(measure);
  }, [measure]);

  useEffect(() => {
    schedule();
    if (!docEl) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(docEl);
    const mo = new MutationObserver(schedule);
    mo.observe(docEl, { subtree: true, childList: true, attributes: true, characterData: true });
    const scroller = scrollerEl;
    scroller?.addEventListener("scroll", schedule, { passive: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      scroller?.removeEventListener("scroll", schedule);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [schedule, docEl, scrollerEl]);

  const jump = useCallback(
    (key: string) => {
      const h = headings.find((x) => x.key === key);
      if (!h || !scrollerEl) return;
      scrollerEl.scrollTo({ top: Math.max(0, h.top - 8), behavior: "smooth" });
    },
    [headings, scrollerEl]
  );

  if (headings.length === 0) return null;
  const ticks = railTicks(headings, scrollTop, pinsByAnchor);

  const tickStyle = (t: (typeof ticks)[number]): CSSProperties => ({
    display: "block",
    flex: "none",
    height: TICK_HEIGHT,
    width: t.width,
    marginLeft: t.indent,
    borderRadius: 1,
    background: t.active ? "var(--accent)" : "var(--text-faint)",
    opacity: t.active ? 1 : 0.4,
    transition: "background-color 0.1s",
  });

  return (
    <div
      data-testid="doc-tick-rail"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      style={{ position: "relative", flex: "none", width: RAIL_WIDTH, minHeight: 0 }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: TICK_GAP, paddingTop: 24, paddingLeft: 12, height: "100%", overflow: "hidden" }}>
        {ticks.map((t) => (
          <span key={t.key} style={tickStyle(t)} />
        ))}
      </div>
      {/* The overlay: the same ticks with their names and pin counts, over
          the content (never a reserved column). Kit list rows, 10px mono. */}
      <div
        data-testid="doc-tick-overlay"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: 30,
          width: RAIL_OVERLAY_WIDTH,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transform: open ? "translateX(0)" : "translateX(-8px)",
          transition: "opacity 0.1s, transform 0.1s",
          background: "var(--bg-elevated)",
          borderRight: "1px solid var(--border)",
          overflowY: "auto",
          paddingTop: 24,
          paddingLeft: 12,
          paddingRight: 8,
        }}
      >
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
          {ticks.map((t) => (
            <li key={t.key} style={{ height: 14, display: "flex", alignItems: "center", gap: 8, lineHeight: 1 }}>
              <span style={tickStyle(t)} />
              <button
                type="button"
                onClick={() => jump(t.key)}
                title={t.text}
                style={{
                  minWidth: 0,
                  flex: "0 1 auto",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  padding: 0,
                  fontFamily: MONO,
                  fontSize: 10,
                  lineHeight: 1,
                  color: t.active ? "var(--text-primary)" : "var(--text-dim)",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = t.active ? "var(--text-primary)" : "var(--text-dim)")}
              >
                {t.text}
              </button>
              {t.pins > 0 && (
                <span
                  style={{ flex: "none", fontFamily: MONO, fontSize: 9, lineHeight: 1, color: "var(--tone-amber)" }}
                  title={`${t.pins} ${t.pins === 1 ? "pin" : "pins"}`}
                >
                  {"\u{1F4CC}"}
                  {t.pins}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
