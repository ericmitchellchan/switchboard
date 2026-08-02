import { useSyncExternalStore } from "react";
import {
  checkNow,
  getUpdaterState,
  installUpdate,
  retryUpdate,
  subscribeUpdater,
} from "../lib/updater";
import { chipLabel, isChipClickable } from "../lib/updaterState";

// Self-update control for the status bar. Soft white/zinc palette per the kit —
// never a modal, never blocking.
//
// This used to render NOTHING while idle, and the only thing that ever ran a
// check was launch + a 6h timer whose failures are deliberately silent. So an
// update published after launch stayed invisible until the next restart, with
// no way to ask and no sign anything had happened (owner 2026-08-02). There is
// now always a control: press ↻ to check, then press the chip to install.

const BTN: React.CSSProperties = {
  background: "none",
  border: "1px solid #27272A",
  borderRadius: 3,
  padding: "1px 6px",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  lineHeight: "14px",
  color: "#A1A1AA",
  whiteSpace: "nowrap",
};

export function UpdateChip() {
  const state = useSyncExternalStore(subscribeUpdater, getUpdaterState);
  const label = chipLabel(state);
  const clickable = isChipClickable(state);
  // A check only means anything from a resting phase — mid-download the reducer
  // rejects it anyway, so don't offer a button that would do nothing.
  const canCheck =
    state.phase === "idle" || state.phase === "uptodate" || state.phase === "error";

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {label ? (
        <button
          onClick={() => {
            if (state.phase === "available") void installUpdate();
            else if (state.phase === "error") void retryUpdate();
          }}
          disabled={!clickable}
          title={state.phase === "error" && state.error ? state.error : undefined}
          style={{
            ...BTN,
            color: state.phase === "error" ? "#52525B" : "#A1A1AA",
            cursor: clickable ? "pointer" : "default",
          }}
        >
          {label}
        </button>
      ) : null}
      {canCheck ? (
        <button
          onClick={() => void checkNow()}
          title="Check for updates"
          aria-label="Check for updates"
          style={{ ...BTN, cursor: "pointer", padding: "1px 5px" }}
        >
          ↻
        </button>
      ) : null}
    </span>
  );
}
