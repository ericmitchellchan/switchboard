// THE back control (increment G, Decision 5) — one component, used by every
// full-width screen's header.
//
// `route.ts` has carried a `history` stack and `navigateBack()` since T4 and
// nothing ever called them: `open full` and a tree click both navigate, both
// push, and there was no way back short of the side menu (which lands you on a
// screen, not on where you WERE). This is that missing half.
//
// It is deliberately not the webview's back gesture. The store's stack is the
// only stack — see `writeRouteToUrl`'s note on why mirroring it into
// `pushState` would give Alt+Left a second one that drifts.
//
// Going back to the terminal restores the artifact panel by construction: the
// panel is per-TAB state in `panelStore` and navigation never touches it.

import type { CSSProperties } from "react";
import { navigateBack, useBackTargetLabel, useCanNavigateBack } from "../lib/route";
import { Icon } from "./icons";

const STYLE: CSSProperties = {
  flex: "none",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 18,
  height: 18,
  marginLeft: -4,
  background: "none",
  border: "none",
  padding: 0,
  borderRadius: 3,
  color: "var(--text-dim)",
  cursor: "pointer",
};

export function BackButton() {
  const canGoBack = useCanNavigateBack();
  const label = useBackTargetLabel();
  // RENDERED ONLY WHEN IT WOULD DO SOMETHING. A permanently-visible back arrow
  // that is dead on the first screen you land on is the same dead affordance
  // the panel button avoids on an empty panel.
  if (!canGoBack) return null;
  return (
    <button
      type="button"
      onClick={navigateBack}
      title={label ? `Back to ${label}` : "Back"}
      aria-label={label ? `Back to ${label}` : "Back"}
      style={STYLE}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--text-primary)";
        e.currentTarget.style.background = "var(--bg-active)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--text-dim)";
        e.currentTarget.style.background = "none";
      }}
    >
      <Icon name="chevron-left" size={11} />
    </button>
  );
}
