// THE OPTION ROW (post-0.5.0, SWIT-54) — one choice of a question, drawn as
// MULTIPLE CHOICE. Shared by the `? question` tab (QuestionView) and Home's
// Needs-you block, so an option reads the same wherever the question is
// answered from.
//
// Eric on 0.5.0's plain-text rows: "I couldn't even tell. I thought this was
// just a list. It should be like a multiple choice or something." So the row
// carries a leading RADIO GLYPH column — the kit's 14px text-glyph column
// (PageView's GLYPH): `○` resting in `--text-dim`, `●` in `--text-primary` on
// hover / focus and on the option that is being sent. No new colour, no radio
// input element: the row is still the target (kit list row), the glyph says
// what kind of target it is. Option text is `--text-primary` — an option is
// the thing to read, not meta.
//
// Keys: the host walks rows with ↑/↓; Enter (native button activation) and
// Space (handled here on keydown so the row does not wait for keyup) pick.

import { useState } from "react";
import type { CSSProperties } from "react";

const MONO = "var(--font-mono)";

/** kit: list row (content-body variant, `5px 8px`). */
const OPTION_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 8px",
  background: "none",
  border: "none",
  boxShadow: "none",
  color: "var(--text-primary)",
  fontFamily: MONO,
  fontSize: 11, // the kit type ramp's body/option size (components.md, SWIT-54)
  lineHeight: 1.5,
  textAlign: "left",
  cursor: "pointer",
  outline: "none",
};

/** kit: the row's leading glyph column — fixed, so labels align. */
const GLYPH: CSSProperties = {
  flex: "none",
  width: 14,
  color: "var(--text-dim)",
};

export function OptionRow({
  label,
  isDefault,
  disabled,
  chosen = false,
  onPick,
}: {
  label: string;
  isDefault: boolean;
  disabled: boolean;
  /** The option being sent right now — draws `●` while the host is busy. */
  chosen?: boolean;
  onPick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const lit = hover || focus || chosen;
  return (
    <button
      type="button"
      role="option"
      aria-selected={focus || chosen}
      data-kit-row=""
      disabled={disabled}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === " ") {
          e.preventDefault();
          if (!disabled) onPick();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        ...OPTION_ROW,
        background: hover || focus ? "var(--bg-active)" : "none",
        boxShadow: focus ? "inset 2px 0 0 var(--text-primary)" : "none",
        opacity: disabled && !chosen ? 0.4 : 1,
      }}
    >
      <span style={{ ...GLYPH, color: lit ? "var(--text-primary)" : "var(--text-dim)" }}>
        {lit ? "●" : "○"}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {isDefault && (
        <span style={{ flex: "none", fontSize: 9.5, color: "var(--text-dim)" }}>default</span>
      )}
    </button>
  );
}
