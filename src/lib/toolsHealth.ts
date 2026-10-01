// SWIT-113 — THE PAGE TOOLS DROPPED MID-SESSION, AND NOW SOMETHING SAYS SO.
//
// The launch-time chip (SWIT-65, `no page — plain shell`) only knew what
// `prepare_thread_launch` said. On Sep 24 a gamma thread lost its page and
// view tools after a model switch; the agent told Eric to reconnect from a
// menu and the app said nothing. The MCP server now records itself in the
// thread dir (`mcp.json`: pid + start time, `endedAt` when its input closes —
// switchboard-mcp.cjs) and Rust's `thread_mcp_health` judges it against the
// pid's own creation time. This module is the rule App's 5s pass applies to
// that reading. Pure.
//
// WHAT COUNTS. Only a reading about THIS launch's server: a record that
// started before the launch (`launchedAt` − `LAUNCH_SKEW_MS`) belongs to the
// previous claude and says nothing. `none` (no record) is no claim either —
// the SWIT-65 rule: we only say what the files tell us. A server that is
// `ended` or `gone` must stay so for `DROP_AFTER_MS` before the chip shows:
// a `/mcp` reconnect replaces the server in a second or two, and a second,
// short-lived server that took the record over and then ended is corrected by
// the live server re-asserting its record (`MCP_REASSERT_MS` in the server).

import type { ThreadPrepared } from "./threadStore";

export type McpHealthState = "none" | "alive" | "ended" | "gone";

export type McpHealthReading = { state: McpHealthState; startedAt: number };

/** How long a server must read ended/gone before the chip claims it. Longer
 *  than the server's re-assert interval (20s) so a record another server
 *  briefly owned never chips. */
export const DROP_AFTER_MS = 30_000;

/** A server may boot a little before the launch is recorded (the record is
 *  stamped after the line is typed). */
export const LAUNCH_SKEW_MS = 5_000;

/** The chip's `title` reason — what happened and the two ways out. */
export const TOOLS_DROPPED_REASON =
  "This thread's page tools stopped answering mid-session (claude exited, or its tools disconnected — a model switch can do it). " +
  "If claude is still running, type /mcp in it to reconnect them.";

/** Runtime memory per thread: when the current run of bad readings began. */
export type ToolsWatch = { badSince: number | null };

export type ToolsVerdict =
  /** Leave the record as it is. */
  | { kind: "keep"; watch: ToolsWatch }
  /** The tools are back (a reconnect): the launch's prepared state again. */
  | { kind: "recovered"; watch: ToolsWatch }
  /** Say so: the chip shows. */
  | { kind: "dropped"; watch: ToolsWatch };

/** The launch time the health rule may speak for, or null. A launch that
 *  prepared (`prepared: true`), or one this rule already marked dropped —
 *  never a real prep failure or a conversation started outside Switchboard,
 *  whose own reasons are truer. */
export function healthLaunchAt(p: ThreadPrepared | undefined): number | null {
  if (!p || typeof p.at !== "number") return null;
  if (p.prepared) return p.at;
  return p.dropped === true ? p.at : null;
}

/** THE rule, one reading at a time. */
export function nextToolsVerdict(
  current: ThreadPrepared,
  launchedAt: number,
  reading: McpHealthReading,
  watch: ToolsWatch,
  now: number
): ToolsVerdict {
  const thisLaunch = reading.state !== "none" && reading.startedAt >= launchedAt - LAUNCH_SKEW_MS;
  const isDropped = !current.prepared;
  if (!thisLaunch) return { kind: "keep", watch: { badSince: null } };
  if (reading.state === "alive") {
    return isDropped ? { kind: "recovered", watch: { badSince: null } } : { kind: "keep", watch: { badSince: null } };
  }
  // ended / gone, about this launch's server.
  const badSince = watch.badSince ?? now;
  if (!isDropped && now - badSince >= DROP_AFTER_MS) return { kind: "dropped", watch: { badSince } };
  return { kind: "keep", watch: { badSince } };
}
