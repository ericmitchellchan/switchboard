import { useSyncExternalStore } from "react";
import {
  getUpdaterState,
  installUpdate,
  retryUpdate,
  subscribeUpdater,
} from "../lib/updater";
import { chipLabel, isChipClickable } from "../lib/updaterState";

// Unobtrusive self-update chip for the status bar. Hidden until an update is
// known; soft white/zinc palette per the kit — never a modal, never blocking.
export function UpdateChip() {
  const state = useSyncExternalStore(subscribeUpdater, getUpdaterState);
  const label = chipLabel(state);
  if (!label) return null;

  const clickable = isChipClickable(state);
  const dim = state.phase === "error";

  return (
    <button
      onClick={() => {
        if (state.phase === "available") void installUpdate();
        else if (state.phase === "error") void retryUpdate();
      }}
      disabled={!clickable}
      title={state.phase === "error" && state.error ? state.error : undefined}
      style={{
        background: "none",
        border: "1px solid #27272A",
        borderRadius: 3,
        padding: "1px 6px",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        lineHeight: "14px",
        color: dim ? "#52525B" : "#A1A1AA",
        cursor: clickable ? "pointer" : "default",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}
