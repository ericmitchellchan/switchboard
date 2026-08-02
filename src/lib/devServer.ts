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
//      would be nagware. `seen` is the memory, and it is keyed on the
//      normalized URL so `0.0.0.0:8000` and `localhost:8000` are one offer.
//
// PURE / EFFECTFUL SPLIT, as everywhere else in lib/: `detectDevServerUrl` is
// a pure `(chunk) => url | null` unit-tested against REAL banners (vite, next,
// uvicorn, python http.server, webpack-dev-server, CRA, Django), INCLUDING
// their ANSI-coloured forms — the raw PTY bytes carry escape codes, and vite in
// particular bolds the PORT, mid-URL: `http://localhost:\x1b[1m5173\x1b[22m/`.
// Strip first or the port is never seen. The module-level store below owns the
// per-session tail buffer, the offer and the dedupe.
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

/** Every distinct URL a chunk announces, in order — the store uses this so a
 *  single banner that prints Local AND Network lines cannot lose the loopback
 *  one to ordering. */
export function detectDevServerUrls(chunk: string): string[] {
  if (typeof chunk !== "string" || chunk.length === 0) return [];
  const text = stripAnsi(chunk);
  URL_PATTERN.lastIndex = 0;
  const out: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = normalizeMatch(match[1], match[2], match[3], match[4]);
    if (url && !out.includes(url)) out.push(url);
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
  /** Normalized URLs already offered for this session — the anti-nag memory. */
  seen: Set<string>;
  /** The URL currently being offered (null = nothing pending). */
  offer: string | null;
  /** The session's cwd, published by TerminalPane at wiring time. Used to
   *  resolve which registry PROJECT a live preview is filed under (and
   *  therefore where its pins live). */
  workingDir: string;
};

const sessions = new Map<string, SessionState>();
const listeners = new Set<() => void>();

function bump(): void {
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
    state = { tail: "", seen: new Set(), offer: null, workingDir: "" };
    sessions.set(sessionId, state);
  }
  return state;
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
  const urls = detectDevServerUrls(combined);
  if (urls.length === 0) return;
  let changed = false;
  for (const url of urls) {
    if (state.seen.has(url)) continue;
    state.seen.add(url);
    // LAST hit wins the chip: a server that reports several ports in one
    // banner has printed the one it actually settled on last.
    state.offer = url;
    changed = true;
  }
  if (changed) bump();
}

/** The URL this session is offering to preview, or null. */
export function devServerOfferFor(sessionId: string | null): string | null {
  if (!sessionId) return null;
  return sessions.get(sessionId)?.offer ?? null;
}

/** React hook for the offer chip. A STRING snapshot, so subscribers re-render
 *  only when the offer itself changes. */
export function useDevServerOffer(sessionId: string | null): string | null {
  return useSyncExternalStore(subscribe, () => devServerOfferFor(sessionId));
}

/** Take or dismiss the offer — either way the chip goes away and this URL is
 *  remembered, so the next banner from the same server is silent. */
export function clearDevServerOffer(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state || state.offer === null) return;
  state.offer = null;
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
}
