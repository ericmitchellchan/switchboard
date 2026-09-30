// THE LANE NAME RULE (SWIT-108) — its own module so pageStore (which parses
// `page.lane`) and route.ts (which follows a renamed lane) can use it without
// importing lanes.ts, which reads pageStore's brief parser. Pure. Mirrored in
// the MCP server (switchboard-mcp.cjs: LANE_NAME_CAP / LANE_NAME_RE) — change
// one, change the other.

/** A lane name is a few words (`Gamma model`, `Kalshi MLB`). Counted in code
 *  points. */
export const LANE_NAME_MAX = 48;

/** Letters and digits first, then words and a little punctuation. None of
 *  the characters the typed-line sanitizer strips (`" \ $ % \``) — the name
 *  rides on the launch line (agentContext's lane clause) and must arrive
 *  there unchanged. */
const LANE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.,&+'()/:#-]*$/u;

export type LaneNameResult = { ok: true; name: string } | { ok: false; reason: string };

/** THE name rule: NFC, whitespace folded, trimmed; 1..LANE_NAME_MAX code
 *  points; the charset above. A refusal says why, in words the editor can
 *  put in its `title`. */
export function normalizeLaneName(raw: unknown): LaneNameResult {
  if (typeof raw !== "string") return { ok: false, reason: "a lane name is text" };
  const name = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (name.length === 0) return { ok: false, reason: "a lane needs a name" };
  if (Array.from(name).length > LANE_NAME_MAX) {
    return { ok: false, reason: `a lane name is at most ${LANE_NAME_MAX} characters` };
  }
  if (!LANE_NAME_RE.test(name)) {
    return { ok: false, reason: "a lane name starts with a letter or digit and holds letters, digits, spaces and - _ . , & + ' ( ) / : #" };
  }
  return { ok: true, name };
}

/** The comparison key: two spellings that differ only in case or spacing
 *  are ONE lane (`Gamma model` = `gamma  model`). */
export function laneNameKey(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function sameLaneName(a: string, b: string): boolean {
  return laneNameKey(a) === laneNameKey(b);
}
