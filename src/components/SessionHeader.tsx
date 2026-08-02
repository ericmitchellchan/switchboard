import { memo, useCallback } from "react";
import type { Session } from "../types";
import { STATUS_CONFIGS } from "../lib/statusConfig";
import { clearDevServerOffer, useDevServerOffer, useDevServerOfferExtras } from "../lib/devServer";
import { explorerProjects, liveProjectFor } from "../lib/explorer";
import { getActiveTabSession, openInPanel } from "../lib/panelStore";
import { navigate, getNavState } from "../lib/route";
import { log } from "../lib/logger";

interface SessionHeaderProps {
  session: Session;
  compact?: boolean;
}

/** THE OFFER (increment F, Decision 1) — "detection offers, never hijacks".
 *
 *  A dev server announced a URL in this session's output. Nothing has happened
 *  yet and nothing will until this chip is clicked: no panel opened itself, no
 *  screen switched, nothing was written to the terminal. Dismissing (×) is a
 *  first-class outcome, and either way the URL is remembered so the next HMR
 *  banner is silent.
 *
 *  It lives on the SESSION HEADER because that is where "this shell just did
 *  something" belongs, and because the header renders in BOTH layouts (the
 *  single-pane path in App and PaneContainer's split leaves), so the offer
 *  follows the session that made it rather than the tab that happens to be
 *  active.
 *
 *  TWO THINGS THE COPY HAS TO CARRY, both learned from a real session:
 *   1. it says FRAME, not "open" — the panel hosts the running app in an
 *      iframe beside the shell. Switchboard never launches a browser and never
 *      touches a window you already have (a dev script that opens its own
 *      Electron/browser window is that script's doing, and closing it is not
 *      Switchboard's business);
 *   2. a URL already being previewed is never offered again — see
 *      `devServer.noteDevServerOutput`, which asks the panel store before it
 *      records an offer at all. */
function DevServerOffer({ session, compact }: { session: Session; compact: boolean }) {
  const offer = useDevServerOffer(session.id);
  const extras = useDevServerOfferExtras(session.id);

  const take = useCallback(async () => {
    if (!offer) return;
    // The panel is per-TAB, so the artifact opens in the ACTIVE TAB's panel —
    // in a split, the pane that printed the URL and the tab that hosts the
    // panel are the same tab by construction, and falling back to this
    // session's own id keeps the click meaningful if the bridge is unset.
    const target = getActiveTabSession() ?? session.id;
    let project = session.repo;
    try {
      project = liveProjectFor(await explorerProjects(), session.working_dir);
    } catch (e) {
      // The registry is unreachable — still preview it (acceptance 6 is that a
      // project the registry never heard of works), just with a plainer label.
      log.warn(`dev-server offer: project lookup failed, falling back: ${e}`);
      project = session.repo || "local";
    }
    clearDevServerOffer(session.id);
    openInPanel(target, { kind: "localhost", project, url: offer });
    // The panel renders on the terminal screen only — taking an offer from the
    // KB/Explorer screen must reveal it, exactly like applyOpenDecision does.
    if (getNavState().route.screen !== "terminal") navigate({ screen: "terminal" });
  }, [offer, session.id, session.repo, session.working_dir]);

  if (!offer) return null;
  const short = offer.replace(/^https?:\/\//, "").replace(/\/$/, "");

  return (
    <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
      <button
        type="button"
        onClick={take}
        // The verb matters: this does NOT hand the URL to a browser. It frames
        // the running app in the panel beside the shell that started it, which
        // is the whole point of the surface — and is also why nothing happens
        // to any window you already have open.
        title={
          `Frame ${offer} in the artifact panel, beside this shell.\n` +
          `Nothing opens in a browser and no window of yours is touched.` +
          (extras > 0
            ? `\n\nThis shell announced ${extras + 1} servers; this is the one most ` +
              `likely to be an app. The others are listed under +.`
            : "")
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontFamily: "var(--font-mono)",
          fontSize: compact ? 9 : 10,
          lineHeight: 1,
          padding: compact ? "2px 5px" : "3px 7px",
          background: "var(--bg-active)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 3,
          color: "var(--text-secondary)",
          cursor: "pointer",
          maxWidth: 240,
          overflow: "hidden",
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
      >
        <span style={{ color: "var(--text-dim)" }}>frame</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{short}</span>
        {/* A full-stack boot announces several servers and only the best-ranked
            one gets the chip. Saying so is the honest minimum — without it the
            others look like they were never noticed. `+` is where they live. */}
        {extras > 0 && (
          <span style={{ color: "var(--text-dim)", flex: "none" }}>{`+${extras}`}</span>
        )}
      </button>
      <span
        role="button"
        aria-label="Dismiss preview offer"
        title="Not now"
        onClick={() => clearDevServerOffer(session.id)}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: compact ? 10 : 11,
          lineHeight: 1,
          padding: "0 3px",
          color: "#3F3F46",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "#A1A1AA")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "#3F3F46")}
      >
        ×
      </span>
    </span>
  );
}

export const SessionHeader = memo(function SessionHeader({ session, compact }: SessionHeaderProps) {
  const cfg = STATUS_CONFIGS[session.status] || STATUS_CONFIGS.running;
  const repoColor = session.repoColor || "#A78BFA";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: compact ? "4px 10px" : "8px 16px",
        height: compact ? 25 : 33,
        boxSizing: "border-box",
        backgroundColor: "#0F0F11",
        borderBottom: "1px solid #1E1E22",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: compact ? 6 : 10 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: compact ? 10 : 11,
            color: cfg.color,
            fontWeight: 600,
            letterSpacing: "0.05em",
            display: "flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          <span>{cfg.icon}</span>
          {cfg.label}
        </span>
        <span style={{ color: "#3F3F46", fontSize: compact ? 10 : 11 }}>{"\u2502"}</span>
        {session.repo && (
          <>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  backgroundColor: repoColor,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: compact ? 9 : 10,
                  color: repoColor,
                  opacity: 0.7,
                  fontWeight: 500,
                }}
              >
                {session.repo}
              </span>
            </span>
            <span style={{ color: "#3F3F46", fontSize: compact ? 10 : 11 }}>{"\u2502"}</span>
          </>
        )}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: compact ? 10 : 11,
            color: "#A1A1AA",
          }}
        >
          {session.name}
        </span>
        {/* Increment F: renders only when this session actually announced a
            dev-server URL, so it costs nothing on every other shell. */}
        <DevServerOffer session={session} compact={compact === true} />
      </div>
      {!compact && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            color: "#52525B",
          }}
        >
          {session.working_dir}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  return (
    prev.session.status === next.session.status &&
    prev.session.name === next.session.name &&
    prev.session.repo === next.session.repo &&
    prev.session.working_dir === next.session.working_dir &&
    prev.session.repoColor === next.session.repoColor &&
    prev.compact === next.compact
  );
});
