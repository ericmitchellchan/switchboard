/** A titled surface panel — the basic content card used across pages.
 *
 * It's a flex column (header + body), so a height-bounded panel (e.g. a grid cell
 * with `min-h-0`) scrolls its BODY instead of overflowing the page. Pass
 * `bodyClassName` to control padding/scroll (default `p-4`); pass `headerRight`
 * for controls in the title bar.
 */

import type { ReactNode } from "react";

export interface PanelProps {
  title?: string;
  children: ReactNode;
  className?: string;
  /** Body wrapper classes. Default `p-4`. Use e.g. `flex min-h-0 flex-col p-0`
   *  to host a fixed sub-header + an internal scroll region. */
  bodyClassName?: string;
  headerRight?: ReactNode;
  /** "Quiet canvas" variant: no outline, no filled surface, no header divider —
   *  the region sits on the page ground and leans on whitespace + hairlines for
   *  structure (workspace redesign, Direction A). */
  bare?: boolean;
}

export default function Panel({ title, children, className, bodyClassName, headerRight, bare }: PanelProps) {
  return (
    <section
      className={[
        bare ? "flex flex-col" : "flex flex-col rounded-lg border border-line/70 bg-surface",
        className ?? "",
      ].join(" ")}
    >
      {title || headerRight ? (
        <div
          className={[
            "flex shrink-0 items-center justify-between gap-2",
            bare ? "pb-2" : "border-b border-line/70 px-4 py-3",
          ].join(" ")}
        >
          <span className="font-mono text-[11px] uppercase tracking-wider text-dim">{title}</span>
          {headerRight}
        </div>
      ) : null}
      <div className={["min-h-0 flex-1", bodyClassName ?? "p-4"].join(" ")}>{children}</div>
    </section>
  );
}
