// Dev-server URL detection (increment F, Decision 1) — "notice, then OFFER".
//
// Eric runs `pnpm dev` in a tab; Switchboard watches the PTY it is already
// watching and NOTICES the `Local:   http://localhost:5173/` line every dev
// server prints on boot. No config, no registry `dev.port` field (which needs
// per-project setup and lies exactly when the intended port was taken), no
// spawning — Switchboard never starts a server, it only reads the output of
// one you started.
//
// TWO HARD RULES, both from the spec and both enforced here rather than in the
// UI:
//   1. DETECTION OFFERS, IT NEVER HIJACKS. A hit records an offer; something
//      the user CLICKS turns that into a panel. Nothing in this module opens,
//      navigates or reveals anything.
//   2. ONE OFFER PER URL PER SESSION. A dev server reprints its banner on every
//      HMR full reload and on every restart; a chip that reappeared each time
//      would be nagware. `known` is the memory, and it is keyed on the
//      normalized URL so `0.0.0.0:8000` and `localhost:8000` are one offer.
//      Dismissing clears every pending candidate, not just the visible one:
//      "not now" answered with the runner-up is the same nagware by another
//      route. Nothing is lost — `known` survives a dismissal and is what the
//      `+` picker lists.
//
// PURE / EFFECTFUL SPLIT, as everywhere else in lib/: `detectDevServerHits` is
// a pure `(chunk) => {url, source}[]` unit-tested against REAL banners (vite,
// next, uvicorn, python http.server, webpack-dev-server, CRA, Django),
// INCLUDING their ANSI-coloured forms — the raw PTY bytes carry escape codes,
// and vite in particular bolds the PORT, mid-URL:
// `http://localhost:\x1b[1m5173\x1b[22m/`. Strip first or the port is never
// seen. The module-level store below owns the per-session tail buffer, the
// RANKED candidate list and the dedupe.
//
// ── WHY A RANKED LIST AND NOT ONE SLOT (2026-08-02, a real bug) ──────────────
// This module used to keep `offer: string | null` and overwrite it on every
// detection, so a session that announced two servers offered whichever printed
// LAST. That is not a corner case on a full-stack project — it is the norm.
// lodestar's `pnpm dev` (scripts/dev.mjs) spawns the FastAPI backend FIRST and
// the desktop app second, and prints `backend  -> http://127.0.0.1:8799`
// before uvicorn has even booted; Eric got his vite app offered only because
// the frontend happened to print last. Reverse the ordering — which is the
// ordering that script actually asks for — and Switchboard offers the API,
// which frames as JSON or a 404, with no way back except typing the URL into
// the `+` picker.
//
// The fix is to keep every candidate and RANK them, using a signal the detector
// takes at PARSE time (see SOURCE_MARKERS): the banner says which tool printed
// it. Deliberately NOT port heuristics — 8000 is uvicorn's default AND python
// http.server's, so a port number is the fragile guess-version of information
// the banner already states outright.
//
// WIRING: `noteDevServerOutput` hangs off the SAME `onOutput` hook
// `noteSessionOutput` and `detectTasks` use (TerminalPane.wireSession) — the
// keep-alive registry dispatches it for every chunk of every session, mounted
// or not. There is deliberately no second listener chain.

import { useSyncExternalStore } from "react";

// ── Pure: ANSI + URL extraction ──────────────────────────────────────────────

/** CSI / OSC / single-char escape sequences. Dev servers colour their banners
 *  and some (vite) emit SGR codes INSIDE the URL — `http://localhost:` then
 *  `ESC[1m` then `5173` — so this runs FIRST and the URL pattern never has to
 *  tolerate an escape mid-token. It also unwraps the OSC-8 hyperlink sequences
 *  some CLIs emit around a URL. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Hosts a dev server announces itself on. Deliberately CLOSED: a LAN address
 *  (webpack's `On Your Network (IPv4): http://10.0.0.5:8080/`, vite's
 *  `--host` line) is the SAME server on a different interface, so offering it
 *  too would double every offer, and a genuinely remote URL in agent output is
 *  not something Switchboard should volunteer to frame. The manual `+` path
 *  (parseManualUrl) is where anything else gets in — by being typed. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "[::]", "0.0.0.0"];

/** Wildcard BINDS. `0.0.0.0` / `[::]` mean "every interface"; neither is a
 *  browsable address, and the one you actually open is loopback. Specific
 *  addresses (`127.0.0.1`, `[::1]`) are left VERBATIM — a server bound only to
 *  IPv4 loopback is reachable at `127.0.0.1` for certain, whereas rewriting it
 *  to `localhost` bets on the resolver. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "[::]"]);

const URL_PATTERN = new RegExp(
  String.raw`(https?)://(` +
    LOOPBACK_HOSTS.map((h) => h.replace(/[.[\]]/g, "\\$&")).join("|") +
    String.raw`):(\d{1,5})(/[^\s"'\`<>()\[\]{}|\\^]*)?`,
  "gi"
);

// ── SOURCE: which KIND of server announced this URL ──────────────────────────

/**
 * What printed the banner. The ONE piece of information that decides which of
 * several URLs a session is offered, so it is taken at parse time — where the
 * banner text still exists — and carried with the URL from there on. Nothing
 * downstream re-sniffs a URL or reasons about its port.
 */
export type DevServerSource =
  /** vite, Next, webpack-dev-server, CRA, … — an APP. What this surface is for. */
  | "frontend"
  /** `python -m http.server`, `serve`, `http-server` — a directory of files.
   *  Frames as a real page (it is what increment F's probe framed), just not an
   *  app with a dev server behind it. */
  | "static"
  /** A valid loopback URL with no recognisable banner — a one-off, a tool we
   *  have never seen. Acceptance 6 says these must still work, so this ranks
   *  above a KNOWN api (we know that frames as JSON; we do not know that about
   *  this) and below a known frontend. */
  | "unknown"
  /** uvicorn, gunicorn, Django, Flask — frames as JSON or a 404. Offered only
   *  when it is the only thing going, because that beats offering nothing. */
  | "api";

/** A detection: the URL and what announced it. */
export type DevServerHit = { url: string; source: DevServerSource };

/** THE RANKING TABLE. Higher wins; ties break toward the LATER sighting (see
 *  `rankHits`), which preserves the original "a server that reports several
 *  ports in one banner settled on the last one" rule. */
const SOURCE_RANK: Record<DevServerSource, number> = {
  frontend: 3,
  static: 2,
  unknown: 1,
  api: 0,
};

/**
 * Banner signatures, transcribed from what the tools actually print (the same
 * fixtures the test suite is calibrated against). Order does not matter — the
 * NEAREST marker at or before the URL wins, not the first in this list.
 *
 * Deliberately signatures of the TOOL, never of the URL. A pattern here should
 * be something a tool prints once on boot and nothing else prints by accident;
 * that is why `ready in`, `Listening on` and `Running on` (all shared by half a
 * dozen tools in both families) are absent.
 */
const SOURCE_MARKERS: ReadonlyArray<{ source: DevServerSource; pattern: RegExp }> = [
  // ── frontend ──
  { source: "frontend", pattern: /\bVITE v|\bvite v\d|\[vite\]/i },
  { source: "frontend", pattern: /Next\.js|\[next\]/i },
  { source: "frontend", pattern: /webpack-dev-server|webpack compiled/i },
  // CRA prints no product name at all — these two lines are its signature.
  { source: "frontend", pattern: /Compiled successfully|You can now view/i },
  { source: "frontend", pattern: /Angular Live Development Server|\bng serve\b/i },
  { source: "frontend", pattern: /Nuxt|Astro|SvelteKit|Remix|Gatsby|Docusaurus|Storybook/i },
  { source: "frontend", pattern: /Parcel|Rsbuild|Turbopack|Expo|Metro waiting/i },
  // ── static ──
  { source: "static", pattern: /Serving HTTP on/i },
  { source: "static", pattern: /http-server|live-server|\bServing!/i },
  // ── api ──
  { source: "api", pattern: /Uvicorn running on|\buvicorn\b/i },
  { source: "api", pattern: /Gunicorn|Hypercorn|Daphne|Waitress/i },
  { source: "api", pattern: /Starting development server at/i }, // Django
  { source: "api", pattern: /Serving Flask app|WERKZEUG/i },
  { source: "api", pattern: /Puma starting|Rails \d/i },
];

/**
 * How far BACK from a URL a banner marker may sit and still describe it.
 *
 * It has to reach: CRA's "You can now view app in the browser." (~60 chars up),
 * vite's `VITE v5.2.11` (~50, two lines up) and Next's `▲ Next.js` (one line
 * up). It must NOT reach across unrelated output, or a vite banner from earlier
 * in the scrollback would classify a bare URL printed minutes later. 400 is
 * comfortably above the first and well below a screenful.
 */
const MARKER_LOOKBACK = 400;

/**
 * How good the evidence for a classification is. This exists because ONE URL
 * can be announced more than once in a single detection pass — the store
 * carries a 512-char tail between chunks, so a URL printed at the end of one
 * chunk is re-seen at the start of the next — and the occurrences do not
 * necessarily agree.
 *
 * The case that forced it, from lodestar verbatim:
 *
 *     ▸ chunk 1 ends with vite's banner and `Local: http://127.0.0.1:5273/`
 *     ▸ chunk 2 opens with `[lodestar] backend  -> http://127.0.0.1:8799`
 *       and only THEN `INFO: Uvicorn running on http://127.0.0.1:8799`
 *
 * The label line carries no marker of its own, so a plain "nearest marker
 * before the URL" rule reached back across the chunk seam and classified the
 * BACKEND as `frontend` on the strength of vite's banner. A marker on the URL's
 * OWN LINE is categorically better evidence than one on an earlier line, so it
 * wins outright rather than by proximity.
 */
const enum Evidence {
  None = 0,
  /** A marker on an EARLIER line — vite, Next and CRA all print this way. */
  PrecedingLine = 1,
  /** A marker on the URL's own line — uvicorn, Django, webpack, http.server. */
  SameLine = 2,
}

type Classification = { source: DevServerSource; evidence: Evidence };

/** Nearest marker inside `window`, or null. "Nearest" = latest, so the closest
 *  one to the URL wins when several tools have printed. */
function nearestMarker(window: string): DevServerSource | null {
  let best: DevServerSource | null = null;
  let bestAt = -1;
  for (const { source, pattern } of SOURCE_MARKERS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const re = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(window)) !== null) {
      if (match.index > bestAt) {
        bestAt = match.index;
        best = source;
      }
      if (match.index === re.lastIndex) re.lastIndex += 1; // zero-width guard
    }
  }
  return best;
}

/**
 * Classify the URL at `index`, with the strength of the evidence. Pure; `text`
 * must already be ANSI-stripped.
 *
 * Same line first, then up to `MARKER_LOOKBACK` characters of earlier lines.
 * Bounding the second search is what stops a vite banner from earlier in the
 * scrollback classifying a bare URL printed long afterwards.
 */
function classifyWithEvidence(text: string, index: number): Classification {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const sameLine = nearestMarker(text.slice(lineStart, index));
  if (sameLine) return { source: sameLine, evidence: Evidence.SameLine };
  const from = Math.max(0, index - MARKER_LOOKBACK);
  const preceding = from < lineStart ? nearestMarker(text.slice(from, lineStart)) : null;
  if (preceding) return { source: preceding, evidence: Evidence.PrecedingLine };
  return { source: "unknown", evidence: Evidence.None };
}

/** What announced the URL at `index`. Pure; `text` must be ANSI-stripped. */
export function classifySourceAt(text: string, index: number): DevServerSource {
  return classifyWithEvidence(text, index).source;
}

/** Order candidates best-first: rank descending, then LATER sighting first.
 *  Pure, so the whole offer decision is testable without the store. */
export function rankHits(hits: readonly DevServerHit[]): DevServerHit[] {
  return hits
    .map((hit, i) => ({ hit, i }))
    .sort((a, b) => SOURCE_RANK[b.hit.source] - SOURCE_RANK[a.hit.source] || b.i - a.i)
    .map((entry) => entry.hit);
}

// ── ONE SERVER, ONE IDENTITY (2026-08-02, a real bug — read this before ──────
// ── "simplifying" normalizeMatch to just rewrite the host) ───────────────────
//
// `localhost` and `127.0.0.1` are two SPELLINGS of one server, and everything
// downstream used to compare URL strings, so one dev server could occupy two
// identities: two candidates, two offers, two panel tabs. From Eric's own
// scrollback, verbatim (one `pnpm dev:web`, one vite):
//
//   [lodestar] desktop  -> browser http://localhost:5273     ← the script's label
//     VITE v6.4.3  ready in 240 ms
//     ➜  Local:   http://127.0.0.1:5273/                     ← vite's own banner
//
// The label prints on spawn and the banner ~2s later, so taking the first offer
// framed `localhost:5273`, and the banner then looked NEW: not in `known`, not
// matched by `isLocalhostUrlOpen`'s string compare, so the chip came back and
// the second click appended a SECOND tab for the SAME vite server.
//
// The fix is a comparison key, not a rewrite of the URL. The URL is still
// framed VERBATIM — `normalizeMatch` deliberately leaves a specific loopback
// address alone (a server bound only to IPv4 loopback is reachable at
// 127.0.0.1 for certain, whereas rewriting it to `localhost` bets on the
// resolver; lodestar's vite config pins `host: "127.0.0.1"` for exactly that
// reason). What is folded is only the question "is this the same server?".
//
// HONEST LIMIT: two processes CAN bind the same port separately on 127.0.0.1
// and [::1], and this key calls those one server. That is a trade taken with
// open eyes — a dev machine running two different apps on one port number over
// two IP stacks is vanishingly rarer than one dev server announcing itself
// twice, which is what every full-stack dev script does.

/** Every spelling of "this machine", folded to one token. `0.0.0.0` and `[::]`
 *  never reach here (normalizeMatch already rewrites those wildcard binds to
 *  `localhost`); they are listed anyway so a manually typed one folds too. */
const LOOPBACK_ALIASES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
  "0.0.0.0",
  "[::]",
]);

/**
 * THE comparison key for a dev-server URL: "which server is this?", not "which
 * string is this". Scheme, port and path are kept verbatim (a path is a ROUTE,
 * and a localhost artifact names one — two routes are two artifacts by design);
 * only the loopback HOST is folded.
 *
 * A non-loopback host (the manual `+` path accepts `box.local:9000`) is left
 * exactly as it is, lowercased — nothing is being claimed about it.
 */
export function serverKey(url: string): string {
  if (typeof url !== "string" || url.length === 0) return "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.toLowerCase();
  }
  const host = parsed.hostname.toLowerCase();
  const canonical = LOOPBACK_ALIASES.has(host) || LOOPBACK_ALIASES.has(`[${host}]`)
    ? "loopback"
    : host;
  const path = parsed.pathname === "" ? "/" : parsed.pathname;
  return `${parsed.protocol}//${canonical}:${parsed.port}${path}${parsed.search}`;
}

/** Do these two URLs name the same running server (and the same route on it)? */
export function sameServer(a: string, b: string): boolean {
  return serverKey(a) === serverKey(b);
}

/** Trailing sentence punctuation is not part of a URL: uvicorn prints
 *  `... http://127.0.0.1:8000 (Press CTRL+C to quit)` and prose ends
 *  `at http://localhost:3000.` — `(` and `)` are already excluded from the
 *  path class, this handles the rest. */
function trimTrailingPunctuation(path: string): string {
  return path.replace(/[.,;:!?]+$/, "");
}

/** Build the canonical form of one match. Returns null for an unusable port,
 *  which is what keeps `http://localhost:0/` and `:99999` out. */
function normalizeMatch(
  scheme: string,
  host: string,
  port: string,
  path: string | undefined
): string | null {
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return null;
  const lower = host.toLowerCase();
  const finalHost = WILDCARD_HOSTS.has(lower) ? "localhost" : lower;
  const finalPath = trimTrailingPunctuation(path ?? "");
  // The SCHEME is preserved: a dev server behind `--https` announces https and
  // downgrading it would frame a URL that does not answer.
  return `${scheme.toLowerCase()}://${finalHost}:${portNumber}${finalPath === "" ? "/" : finalPath}`;
}

/**
 * THE detector. Pure: one chunk of (possibly ANSI-coloured, possibly
 * mid-stream) terminal text in, the FIRST loopback dev-server URL it announces
 * out, or null.
 *
 * Conservative by construction — all three of these must hold:
 *   · the scheme is written out (`http://` / `https://`), so a bare
 *     `localhost:5173` in prose is not a hit;
 *   · the host is in the loopback set above;
 *   · the port is EXPLICIT and in range. `http://localhost/` is a website, not
 *     a dev server announcement, and the ports are what make an offer useful.
 *
 * It does NOT require an announcement keyword (`Local:`, `running on`,
 * `Serving HTTP on`): those differ per tool, change between versions, and
 * acceptance 6 is that a project the registry has never seen still previews.
 * The cost of the looser rule is bounded — the worst case is an OFFER the user
 * ignores, never a panel that opened itself.
 */
export function detectDevServerUrl(chunk: string): string | null {
  return detectDevServerUrls(chunk)[0] ?? null;
}

/** Every distinct URL a chunk announces, in order. */
export function detectDevServerUrls(chunk: string): string[] {
  return detectDevServerHits(chunk).map((hit) => hit.url);
}

/** THE detector proper: every distinct URL a chunk announces, in order, EACH
 *  TAGGED with what announced it — the store uses this so a single banner that
 *  prints Local AND Network lines cannot lose the loopback one to ordering, and
 *  so a full-stack boot can be ranked rather than raced.
 *
 *  The source is decided HERE, against the banner text, and travels with the
 *  URL from this point on. First sighting of a URL wins its position; the store
 *  handles the case where a later, more specific banner refines an `unknown`. */
export function detectDevServerHits(chunk: string): DevServerHit[] {
  if (typeof chunk !== "string" || chunk.length === 0) return [];
  const text = stripAnsi(chunk);
  URL_PATTERN.lastIndex = 0;
  const out: DevServerHit[] = [];
  // Evidence per URL, so a REPEAT occurrence with better evidence upgrades the
  // classification in place. Position in the list stays the first sighting's —
  // the order URLs were announced in is what the ranking's tie-break reads.
  const evidence = new Map<string, Evidence>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = normalizeMatch(match[1], match[2], match[3], match[4]);
    if (!url) continue;
    const found = classifyWithEvidence(text, match.index ?? 0);
    const existing = out.find((hit) => hit.url === url);
    if (!existing) {
      out.push({ url, source: found.source });
      evidence.set(url, found.evidence);
      continue;
    }
    if (found.evidence > (evidence.get(url) ?? Evidence.None)) {
      existing.source = found.source;
      evidence.set(url, found.evidence);
    }
  }
  return out;
}

/**
 * The MANUAL path (`+` picker → "open a URL"), for servers whose banner this
 * detector does not recognise. Deliberately more permissive than detection:
 * the user typed it, so a LAN box or a container hostname is fair game — but
 * it still has to be an http(s) URL with a host, because that is all an
 * `<iframe src>` can be.
 *
 *   "3000"                  → http://localhost:3000/
 *   ":3000"                 → http://localhost:3000/
 *   "localhost:3000"        → http://localhost:3000/
 *   "127.0.0.1:8000/admin"  → http://127.0.0.1:8000/admin
 *   "http://box.local:9000" → http://box.local:9000/
 *   "pnpm dev"              → null
 */
export function parseManualUrl(input: string): string | null {
  const raw = (input ?? "").trim();
  if (raw.length === 0 || /\s/.test(raw)) return null;
  if (/^\d{1,5}$/.test(raw) || /^:\d{1,5}$/.test(raw)) {
    const port = Number(raw.replace(":", ""));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return `http://localhost:${port}/`;
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.hostname.length === 0) return null;
  // A host with no port and no dot is almost certainly not a URL at all
  // ("pnpm" parses as a hostname). Require EITHER an explicit port or a
  // dotted/bracketed host, so junk in the filter box does not sprout a row.
  const looksLikeHost = parsed.port.length > 0 || parsed.hostname.includes(".") || parsed.hostname.includes(":");
  if (!looksLikeHost) return null;
  const wildcard = WILDCARD_HOSTS.has(parsed.hostname.toLowerCase());
  if (wildcard) parsed.hostname = "localhost";
  return parsed.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Store — per-session offers (module singleton + useSyncExternalStore, the same
// shape as panelStore / threadStore, deliberately not zustand)
// ─────────────────────────────────────────────────────────────────────────────

/** How much of the previous chunk is carried forward. A PTY chunk can split a
 *  URL anywhere (`http://local` | `host:5173/`), so the tail is prepended to
 *  the next chunk before detection. 512 is far longer than any URL and costs
 *  one string concat per chunk. Re-detection across the overlap is harmless:
 *  `seen` dedupes by URL. */
const TAIL_LENGTH = 512;

type SessionState = {
  tail: string;
  /** EVERY URL this session has announced, in arrival order, each with the
   *  source that announced it. This is the anti-nag memory (a URL in here is
   *  never offered a second time), the ranking input, and the list the `+`
   *  picker shows so a candidate that lost the chip is still reachable. One
   *  array, one source of truth — it replaced a `Set<string>` that could only
   *  answer "have we seen this". */
  known: DevServerHit[];
  /** URLs with an offer still PENDING — a subset of `known`, emptied when the
   *  chip is taken or dismissed. `known` deliberately survives that, so
   *  dismissing does not also forget where your servers are. */
  candidates: string[];
  /** Ranked `known`, cached so `devServerKnownFor` can be a stable
   *  useSyncExternalStore snapshot. Invalidated on every mutation. */
  rankedKnown: DevServerHit[] | null;
  /** The session's cwd, published by TerminalPane at wiring time. Used to
   *  resolve which registry PROJECT a live preview is filed under (and
   *  therefore where its pins live). */
  workingDir: string;
};

/** Stable empty result, so a session with nothing detected returns the SAME
 *  reference every render (a fresh `[]` would loop useSyncExternalStore). */
const NO_HITS: readonly DevServerHit[] = Object.freeze([]);

const sessions = new Map<string, SessionState>();
const listeners = new Set<() => void>();

/** "Is this URL already being previewed?" — INJECTED, so this module keeps
 *  importing nothing but React and stays unit-testable without a panel store.
 *  App wires `panelStore.isLocalhostUrlOpen` at boot; unset means "nothing is
 *  open", which is the correct answer before the panel store exists. */
let previewOpenCheck: ((url: string) => boolean) | null = null;

export function setPreviewOpenCheck(check: ((url: string) => boolean) | null): void {
  previewOpenCheck = check;
}

/** Is a preview of this URL already on screen? Never throws — a broken checker
 *  must degrade to "offer it", not silence detection entirely. */
function alreadyPreviewed(url: string): boolean {
  if (!previewOpenCheck) return false;
  try {
    return previewOpenCheck(url) === true;
  } catch {
    return false;
  }
}

/** Monotonic change counter — the memoized derivations below (sibling lookups)
 *  hold their results until it moves. */
let version = 0;

function bump(): void {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function stateFor(sessionId: string): SessionState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = { tail: "", known: [], candidates: [], rankedKnown: null, workingDir: "" };
    sessions.set(sessionId, state);
  }
  return state;
}

/** The source recorded for a URL this session knows, or `unknown`. */
function sourceOf(state: SessionState, url: string): DevServerSource {
  return state.known.find((hit) => hit.url === url)?.source ?? "unknown";
}

/** Pending candidates as hits, ready to rank. */
function pendingHits(state: SessionState): DevServerHit[] {
  return state.candidates.map((url) => ({ url, source: sourceOf(state, url) }));
}

/** TerminalPane publishes a session's cwd once, at wiring time. Cheap, and it
 *  is the only thing that lets the manual `+` path and the offer name a
 *  PROJECT without another IPC round trip per click. */
export function registerSessionDir(sessionId: string, workingDir: string): void {
  const state = stateFor(sessionId);
  if (state.workingDir === workingDir) return;
  state.workingDir = workingDir;
}

export function sessionDirFor(sessionId: string | null): string {
  if (!sessionId) return "";
  return sessions.get(sessionId)?.workingDir ?? "";
}

/**
 * Feed one chunk of a session's PTY output. Records an OFFER for the first
 * loopback URL this session has not already offered — and does nothing else:
 * no navigation, no panel, no toast. Called from TerminalPane's registry
 * `onOutput` hook, beside detectTasks.
 */
export function noteDevServerOutput(sessionId: string, text: string): void {
  if (sessionId.length === 0 || typeof text !== "string" || text.length === 0) return;
  const state = stateFor(sessionId);
  const combined = state.tail + text;
  state.tail = combined.slice(-TAIL_LENGTH);
  const hits = detectDevServerHits(combined);
  if (hits.length === 0) return;
  let changed = false;
  for (const hit of hits) {
    // MATCHED BY SERVER, NOT BY STRING (see "ONE SERVER, ONE IDENTITY" above).
    // `http://localhost:5273/` and `http://127.0.0.1:5273/` are one vite, and
    // a dev script that prints its own label line before the tool boots
    // announces both.
    const key = serverKey(hit.url);
    const existing = state.known.find((k) => serverKey(k.url) === key);
    if (existing) {
      // ALREADY KNOWN — never a second offer (the anti-nag rule). But a server
      // can legitimately be announced TWICE with different specificity:
      // lodestar's dev script prints `backend  -> http://127.0.0.1:8799` as a
      // plain label BEFORE uvicorn boots and names itself. The first sighting
      // is `unknown`, the second is `api`, and the later, more specific one is
      // the true one. Refining never re-offers; it only corrects the ranking.
      // Only ever unknown → named. Deliberately NOT a rank comparison: an
      // `api` re-seen on a line with no banner would "upgrade" to `unknown`
      // (rank 1 > rank 0), unlearning what uvicorn already told us.
      if (existing.source === "unknown" && hit.source !== "unknown") {
        existing.source = hit.source;
        // The better-evidenced sighting wins the SPELLING too: a tool's own
        // banner states the address it actually bound, while a hand-written
        // label line states what its author assumed. Framing what vite printed
        // is the difference between a preview and a blank frame when
        // `localhost` resolves to ::1 and the server is on 127.0.0.1 only.
        if (existing.url !== hit.url) {
          const pending = state.candidates.indexOf(existing.url);
          existing.url = hit.url;
          // Only REWRITE a candidate that is still pending. Adding one here
          // would resurrect an offer the user already took or dismissed —
          // which is the duplicate-tab bug wearing a different hat.
          if (pending >= 0) state.candidates[pending] = hit.url;
        }
        state.rankedKnown = null;
        changed = true;
      }
      continue;
    }
    state.known.push({ ...hit });
    state.rankedKnown = null;
    changed = true;
    // ALREADY ON SCREEN = ALREADY ANSWERED. A server restart reprints its
    // banner, and a `pnpm dev` in a SECOND tab announces a port the first tab's
    // preview is already framing — in both cases the URL is new to THIS
    // session's `known` list, so the anti-nag memory above does not cover it
    // and the chip would offer something Eric is looking at. It still joins
    // `known`, so closing the preview later does not make the banner pop back
    // — and it stays listed in the `+` picker either way.
    if (alreadyPreviewed(hit.url)) continue;
    state.candidates.push(hit.url);
  }
  if (changed) bump();
}

/** THE offer: the best-ranked pending candidate's URL, or null.
 *
 *  "Best" is `SOURCE_RANK` — a frontend dev server outranks a static server,
 *  which outranks an unrecognised one, which outranks a known API. So a
 *  full-stack boot offers the APP whichever of its servers printed first, and a
 *  backend-only session still gets its backend offered, because that beats
 *  offering nothing. */
export function devServerOfferFor(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const state = sessions.get(sessionId);
  if (!state || state.candidates.length === 0) return null;
  return rankHits(pendingHits(state))[0]?.url ?? null;
}

/** How many OTHER candidates are pending behind the offer. The chip says so
 *  rather than pretending one URL is all there was; the `+` picker is where
 *  they are actually reachable. A number, so it is a valid store snapshot. */
export function devServerOfferExtrasFor(sessionId: string | null): number {
  if (!sessionId) return 0;
  const count = sessions.get(sessionId)?.candidates.length ?? 0;
  return count > 0 ? count - 1 : 0;
}

/** Every dev-server URL this session has announced, best-ranked first, whether
 *  or not its offer is still pending. THE reachability affordance: a candidate
 *  that lost the chip — or a chip that was dismissed — is still one `+` away
 *  instead of being lost to a URL you have to remember and retype. */
export function devServerKnownFor(sessionId: string | null): readonly DevServerHit[] {
  if (!sessionId) return NO_HITS;
  const state = sessions.get(sessionId);
  if (!state || state.known.length === 0) return NO_HITS;
  if (!state.rankedKnown) state.rankedKnown = rankHits(state.known);
  return state.rankedKnown;
}

// ── SIBLING SERVERS — "what else is alive in this session?" ──────────────────
// The live preview frames ONE server (the frontend, by the ranking). Eric's
// ask, verbatim: *"It'd be nice to have the backend thing there too just
// because we know what's actually alive. It's not kind of ghost running."*
//
// The answer is deliberately NOT a second panel tab. Framing an API renders
// JSON or a 404, which tells him less than a dot does. So the preview names
// the OTHER servers the same shell announced, and probes each one.
//
// Keyed on the URL rather than on a session id because that is the join the
// caller can actually make: LocalhostView is handed an ARTIFACT (a URL and a
// project), not a session — it renders in the panel of whichever tab holds it
// and in the floating window, which has no session at all. Looking the URL up
// in the announcement store answers "which shell printed this?" without
// threading a session id through two hosts and a pop-out window. A URL nothing
// announced (typed into `+`) has no siblings, which is the honest answer: we
// know of no others.

/** Sibling lookups are memoized per URL and invalidated wholesale on any store
 *  change, so the array a component receives is reference-stable between
 *  changes — a fresh `[]` (or a fresh array) every render would spin
 *  useSyncExternalStore. */
let siblingCache = new Map<string, readonly DevServerHit[]>();
let siblingCacheVersion = -1;

/**
 * Every OTHER server known to the session(s) that announced `url`, best-ranked
 * first. Deduped by `serverKey`, so a server two shells both announced appears
 * once, and the framed server itself never appears in its own sibling list.
 */
export function siblingServersFor(url: string): readonly DevServerHit[] {
  if (typeof url !== "string" || url.length === 0) return NO_HITS;
  if (siblingCacheVersion !== version) {
    siblingCache = new Map();
    siblingCacheVersion = version;
  }
  const cached = siblingCache.get(url);
  if (cached) return cached;
  const self = serverKey(url);
  const collected: DevServerHit[] = [];
  const seenKeys = new Set<string>([self]);
  for (const state of sessions.values()) {
    if (!state.known.some((hit) => serverKey(hit.url) === self)) continue;
    for (const hit of state.known) {
      const key = serverKey(hit.url);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      collected.push(hit);
    }
  }
  const result: readonly DevServerHit[] = collected.length === 0 ? NO_HITS : rankHits(collected);
  siblingCache.set(url, result);
  return result;
}

/** The preview's liveness strip. Stable between store changes (see
 *  `siblingCache`), so it is a legal useSyncExternalStore snapshot. */
export function useSiblingServers(url: string): readonly DevServerHit[] {
  return useSyncExternalStore(subscribe, () => siblingServersFor(url));
}

// ── ALL KNOWN SERVERS — Home's Listening block (SWIT-45) ─────────────────────
// Every server ANY session has announced, deduped by serverKey, best-ranked
// first. Same memoization discipline as the sibling cache: rebuilt only when
// the store version moves, so the array is a legal snapshot. Announcements
// only — whether each one is ANSWERING is the caller's probe (Home's), with
// the standing no-cors wording: this store never claims liveness.

let allKnownCache: readonly DevServerHit[] = NO_HITS;
let allKnownCacheVersion = -1;

export function allKnownServers(): readonly DevServerHit[] {
  if (allKnownCacheVersion === version) return allKnownCache;
  allKnownCacheVersion = version;
  const seenKeys = new Set<string>();
  const collected: DevServerHit[] = [];
  for (const state of sessions.values()) {
    for (const hit of state.known) {
      const key = serverKey(hit.url);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      collected.push(hit);
    }
  }
  allKnownCache = collected.length === 0 ? NO_HITS : rankHits(collected);
  return allKnownCache;
}

export function useAllKnownServers(): readonly DevServerHit[] {
  return useSyncExternalStore(subscribe, allKnownServers);
}

/** React hook for the offer chip. A STRING snapshot, so subscribers re-render
 *  only when the offer itself changes. */
export function useDevServerOffer(sessionId: string | null): string | null {
  return useSyncExternalStore(subscribe, () => devServerOfferFor(sessionId));
}

/** Companion primitive snapshot: how many others are waiting behind it. */
export function useDevServerOfferExtras(sessionId: string | null): number {
  return useSyncExternalStore(subscribe, () => devServerOfferExtrasFor(sessionId));
}

/** The picker's list. Safe as a snapshot because `rankedKnown` is cached and
 *  only rebuilt when the session's URLs actually change. */
export function useDevServerKnown(sessionId: string | null): readonly DevServerHit[] {
  return useSyncExternalStore(subscribe, () => devServerKnownFor(sessionId));
}

/** Take or dismiss the offer — either way the chip goes away and EVERY pending
 *  candidate is cleared with it, not just the one on display.
 *
 *  Dismiss means "not now", and answering it by immediately offering the
 *  runner-up would be exactly the nagware the one-offer-per-URL rule exists to
 *  prevent. The URLs stay in `known`, so nothing is lost — they are listed in
 *  the `+` picker. */
export function clearDevServerOffer(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state || state.candidates.length === 0) return;
  state.candidates = [];
  bump();
}

/** Tab closed: forget everything about it (the session id is never reused). */
export function clearDevServerSession(sessionId: string): void {
  if (!sessions.delete(sessionId)) return;
  bump();
}

/** Test-only reset. */
export function __resetDevServerForTests(): void {
  sessions.clear();
  listeners.clear();
  previewOpenCheck = null;
  version += 1;
  siblingCache = new Map();
  siblingCacheVersion = -1;
  allKnownCache = NO_HITS;
  allKnownCacheVersion = -1;
}
