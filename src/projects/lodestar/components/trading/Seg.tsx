/** A segmented switch (SWIT-130): a few options on one quiet slab, the chosen
 *  one lifted. Hook-free so the render tests can read it. */

import { T } from "../../../../lib/typeScale";

export interface SegOption<K extends string> {
  key: K;
  label: string;
  disabled?: boolean;
  title?: string;
}

export default function Seg<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly SegOption<K>[];
  value: K;
  onChange?: (k: K) => void;
  /** What the switch chooses, for a screen reader. */
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{ display: "inline-flex", gap: 2, background: "var(--bg-secondary)", borderRadius: 6, padding: 2 }}
    >
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            disabled={o.disabled}
            title={o.title}
            data-seg={o.key}
            onClick={() => onChange?.(o.key)}
            style={{
              ...T.bodySm,
              padding: "3px 10px",
              borderRadius: 4,
              border: 0,
              cursor: o.disabled ? "default" : "pointer",
              background: on ? "var(--bg-active)" : "transparent",
              color: on ? "var(--text-primary)" : o.disabled ? "var(--text-faint)" : "var(--text-muted)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
