// HOME (SWIT-45) — the roll-up screen and the app's default route. Ky's
// lesson, adopted: Home has no content of its own — every block here is a
// view over some other record. In this first increment two blocks are REAL
// (Live now reads the thread store; Listening reads the dev-server store and
// probes) and three are RESERVED boxes that say exactly what will land in
// them (Needs you → SWIT-48/51, Between threads → SWIT-52, Kept views →
// SWIT-50). An empty box that names its future beats an empty box.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { PulsingDot } from "./PulsingDot";
import { STATUS_CONFIGS } from "../lib/statusConfig";
import {
  useThreadsView,
  getThreadActions,
  threadRepoName,
  sortThreadsForHistory,
} from "../lib/threadStore";
import { useAllKnownServers, serverKey } from "../lib/devServer";

const MONO = "var(--font-mono)";

const BLOCK_TITLE: CSSProperties = {
  fontFamily: MONO,
  fontSize: 9.5,
  color: "var(--text-dim)",
  textTransform: "uppercase",
  letterSpacing: "1px",
  marginBottom: 6,
  display: "flex",
  alignItems: "baseline",
};

const BLOCK_TITLE_RIGHT: CSSProperties = {
  marginLeft: "auto",
  textTransform: "none",
  letterSpacing: 0,
  color: "var(--text-faint)",
};

const RESERVED_BOX: CSSProperties = {
  border: "1px dashed var(--border-subtle)",
  padding: 14,
  fontFamily: MONO,
  fontSize: 10.5,
  color: "var(--text-dim)",
  lineHeight: 1.6,
};

/** How often the Listening block probes, while Home is on screen. */
const PROBE_MS = 5_000;

export function Home({ active }: { active: boolean }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div
        style={{
          height: 36,
          flex: "none",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          borderBottom: "1px solid var(--border)",
          fontFamily: MONO,
          fontSize: 11.5,
          color: "var(--text-secondary)",
        }}
      >
        Home
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "3fr 2fr",
          gap: 1,
          background: "var(--border)",
          overflow: "hidden",
        }}
      >
        <div style={{ background: "var(--bg-primary)", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 16, minHeight: 0, overflowY: "auto" }}>
          <div>
            <div style={BLOCK_TITLE}>
              Needs you <span style={BLOCK_TITLE_RIGHT}>later</span>
            </div>
            <div style={RESERVED_BOX}>
              Reserved. When every thread has its living page, the open questions and the to-dos owned
              by you collect here, across threads, newest first. Until then this box is empty on
              purpose, not a bug.
            </div>
          </div>
          <LiveNow />
        </div>
        <div style={{ background: "var(--bg-primary)", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 16, minHeight: 0, overflowY: "auto" }}>
          <div>
            <div style={BLOCK_TITLE}>
              Between threads <span style={BLOCK_TITLE_RIGHT}>later</span>
            </div>
            <div style={RESERVED_BOX}>
              Reserved for thread-to-thread updates and requests — the last hour of traffic between
              your conversations.
            </div>
          </div>
          <Listening active={active} />
          <div>
            <div style={BLOCK_TITLE}>
              Kept views <span style={BLOCK_TITLE_RIGHT}>later</span>
            </div>
            <div style={RESERVED_BOX}>
              Reserved. A view the agent showed and you kept lands in the project's scratchpad and is
              listed here.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Threads with a live claude behind them, live-status first — a view over
 *  the thread store, clicking a row opens the thread (the same registered
 *  action the side menu uses). */
function LiveNow() {
  const view = useThreadsView();
  const live = view.threads.filter((t) => view.launched.has(t.id));
  const rows = sortThreadsForHistory(live, view.launched);
  return (
    <div>
      <div style={BLOCK_TITLE}>
        Live now{" "}
        <span style={BLOCK_TITLE_RIGHT}>
          {rows.length === 0 ? "no live threads" : `${rows.length} thread${rows.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {rows.length === 0 ? (
        <div style={RESERVED_BOX}>
          Nothing is running. Open a thread from the side menu (Ctrl+Shift+B), or Ctrl+T for a new
          one.
        </div>
      ) : (
        rows.map((t) => {
          const status = t.sessionId ? view.sessionStatuses[t.sessionId] : undefined;
          const cfg = STATUS_CONFIGS[status ?? "idle"] ?? STATUS_CONFIGS.idle;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => getThreadActions()?.openThread(t.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                textAlign: "left",
                border: "1px solid var(--border)",
                background: "var(--bg-elevated)",
                padding: "8px 10px",
                marginBottom: 5,
                cursor: "pointer",
                fontFamily: MONO,
                fontSize: 11,
                color: "var(--text-secondary)",
              }}
            >
              <PulsingDot color={cfg.color} pulse={cfg.pulse} size={7} />
              <span style={{ color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.title}
              </span>
              <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                {threadRepoName(t.workingDir)}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 9.5, flex: "none" }}>
                open →
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

/** Announced dev servers, probed. The wording rules are the standing ones
 *  (LocalhostView's): a no-cors probe resolving means SOMETHING accepted the
 *  connection; the response is opaque, so this is not a health check and the
 *  copy never claims one. */
function Listening({ active }: { active: boolean }) {
  const servers = useAllKnownServers();
  const [alive, setAlive] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!active || servers.length === 0) return;
    let cancelled = false;
    const probe = () => {
      for (const hit of servers) {
        const key = serverKey(hit.url);
        fetch(hit.url, { mode: "no-cors", cache: "no-store" })
          .then(() => {
            if (!cancelled) setAlive((prev) => (prev[key] === true ? prev : { ...prev, [key]: true }));
          })
          .catch(() => {
            if (!cancelled) setAlive((prev) => (prev[key] === false ? prev : { ...prev, [key]: false }));
          });
      }
    };
    probe();
    const id = window.setInterval(probe, PROBE_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, servers]);

  return (
    <div>
      <div style={BLOCK_TITLE}>
        Listening <span style={BLOCK_TITLE_RIGHT}>probed, not health-checked</span>
      </div>
      {servers.length === 0 ? (
        <div style={RESERVED_BOX}>
          No dev servers announced yet. When a shell prints a local URL it is listed here, probed.
        </div>
      ) : (
        servers.map((hit) => {
          const key = serverKey(hit.url);
          const state = alive[key];
          const dotColor =
            state === true ? "var(--st-done, #10B981)" : state === false ? "var(--st-exited, #52525B)" : "var(--text-faint)";
          const label = state === true ? "listening" : state === false ? "not answering" : "probing…";
          return (
            <div
              key={key}
              title={
                state === true
                  ? "listening — something accepted the probe (opaque response; not a health check)"
                  : state === false
                    ? "not answering — nothing is listening on that port"
                    : "probing"
              }
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "3px 0",
                fontFamily: MONO,
                fontSize: 10.5,
                color: "var(--text-secondary)",
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor, flex: "none" }} />
              <span style={{ color: "var(--text-dim)", fontSize: 9.5 }}>{hit.source}</span>
              <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>{hit.url}</span>
              <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 9.5, flex: "none" }}>{label}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
