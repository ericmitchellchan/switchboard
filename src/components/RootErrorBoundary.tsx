import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { log } from "../lib/logger";

// THE LAST BOUNDARY — "the window is never black".
//
// `ScreenErrorBoundary` (App.tsx) is PER-SCREEN and mounts INSIDE App, so it
// catches a crash in the KB view or the artifact panel and swaps that surface
// for a crash card. What it structurally cannot catch is a throw in App's own
// render, in App's own effects, or in the commit phase React runs around them:
// those propagate ABOVE every screen boundary, React unmounts the whole tree,
// and the window paints NOTHING — no chrome, no tab bar, no message. That is
// exactly what shipped on `feat/artifact-panel`: an unbounded render loop
// between `usePaneLayout`'s unstable return object and panelStore's
// bump-invalidated snapshots ended in React throwing "Maximum update depth
// exceeded" out of App's commit phase.
//
// Both halves of that specific loop are fixed. This boundary is here because
// the SHAPE of the failure is the bug: a boot path that can throw must degrade
// to a working, readable app — never to a black rectangle that says nothing and
// offers nothing. It renders the error, and it offers the two recoveries that
// actually work from a dead tree: reload, and reload with the saved workspace
// cleared (the persisted blob is the input most likely to be the trigger, and
// it is the one input the user cannot otherwise get rid of without devtools).

/** The workspace blob — kept in sync with `lib/workspace.ts`'s STORAGE_KEY.
 *  Deliberately duplicated rather than imported: this component must render
 *  even when the module that owns that constant is what failed. */
const WORKSPACE_STORAGE_KEY = "switchboard:workspace";

type Props = { children: ReactNode };
type State = { error: Error | null };

function describe(error: Error): string {
  const stack = typeof error.stack === "string" ? error.stack : "";
  return stack.length > 0 ? stack : String(error);
}

export class RootErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Best-effort: the logger round-trips through a Tauri plugin, and this
    // boundary has to survive that failing too.
    try {
      log.error(`Switchboard crashed at the root: ${describe(error)}`);
      if (info.componentStack) log.error(`Component stack: ${info.componentStack}`);
    } catch {
      // ignore — the console line below is the fallback record
    }
    // eslint-disable-next-line no-console
    console.error("Switchboard crashed at the root", error, info.componentStack);
  }

  private reload = () => {
    window.location.reload();
  };

  private resetWorkspace = () => {
    try {
      localStorage.removeItem(WORKSPACE_STORAGE_KEY);
    } catch {
      // localStorage unavailable — reloading is still worth a try
    }
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: 24,
          background: "var(--bg-primary, #0f0f0f)",
          color: "var(--text-primary, #ededed)",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
        }}
      >
        <span style={{ fontSize: 14 }}>Switchboard hit an error while starting.</span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-dim, #6e6e6e)",
            maxWidth: 620,
            textAlign: "center",
          }}
        >
          Your threads and scrollback are saved to disk and are not affected. If reloading
          does not help, clearing the saved workspace starts a fresh session.
        </span>
        <pre
          style={{
            maxWidth: 720,
            maxHeight: 260,
            overflow: "auto",
            margin: 0,
            padding: 12,
            fontSize: 11,
            lineHeight: 1.5,
            textAlign: "left",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--text-secondary, #b4b4b4)",
            background: "var(--bg-secondary, #141414)",
            border: "1px solid var(--border, #2e2e2e)",
            borderRadius: 4,
          }}
        >
          {describe(error)}
        </pre>
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" onClick={this.reload} style={BUTTON_STYLE}>
            Reload
          </button>
          <button type="button" onClick={this.resetWorkspace} style={BUTTON_STYLE}>
            Clear saved workspace and reload
          </button>
        </div>
      </div>
    );
  }
}

const BUTTON_STYLE = {
  padding: "6px 14px",
  fontFamily: "inherit",
  fontSize: 12,
  color: "var(--text-primary, #ededed)",
  background: "var(--bg-secondary, #141414)",
  border: "1px solid var(--border, #2e2e2e)",
  borderRadius: 4,
  cursor: "pointer",
} as const;
