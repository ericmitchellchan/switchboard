/** A small outlined text chip. Meaning is always in the text; the tone only
 *  echoes it (identity is never colour alone). Shared by the Flow table and
 *  the game detail. */

import { T } from "../../../../lib/typeScale";

export type ChipTone = "warn" | "accent" | "up" | "dn" | "dim";

const INK: Record<ChipTone, string> = {
  warn: "var(--chart-3)",
  accent: "var(--accent)",
  up: "var(--up)",
  dn: "var(--dn)",
  dim: "var(--dim)",
};

export default function Chip({ children, tone = "dim", title }: { children: string; tone?: ChipTone; title?: string }) {
  const ink = INK[tone];
  return (
    <span
      title={title}
      className="inline-block whitespace-nowrap rounded-full border px-2"
      style={{ ...T.label, color: ink, borderColor: ink }}
    >
      {children}
    </span>
  );
}
