// Keep-alive terminal registry: xterm Terminal INSTANCES survive React
// unmount/remount. Ported from ky-desktop's terminalRegistry.ts (which evolved
// from this repo's terminal substrate).
//
// Why: claude's TUI streams by REPAINTING its whole in-progress message with
// relative cursor moves. Any snapshot/replay/re-attach cycle demands perfect
// cursor continuity with the snapshot — the first replayed repaint that lands
// against a screen state that no longer exists stamps a duplicated, garbled
// copy into scrollback that nothing ever heals (claude only repaints the LIVE
// frame, never the scrollback above it).
//
// So: never replay. On pane unmount the terminal's DOM subtree moves to a
// hidden `display:none` keep-alive root and the registry-owned PTY listener
// keeps writing into it — the render model is correct at every moment while
// hidden, at zero render cost. Remount adopts the SAME element back into the
// new host and refreshes the viewport (hidden writes advanced the buffer but
// the renderer skipped them). Real disposal happens ONLY on session close
// (App.destroySession → disposeTerminal) or app teardown — a PTY exit never
// disposes, because Switchboard keeps exited sessions in the tab bar with a
// Restart button and the final output must stay readable (shown, parked, or
// re-adopted later). Ownership/steal decision rules live in
// terminalLifecycle.ts (pure, unit-tested under Node).
//
// Handler wiring: because the Terminal outlives any mount, the term-level
// subscriptions (onData → PTY write, onResize → PTY resize, onWriteParsed,
// onScroll, onBufferChange, the clipboard key handler) and the per-session
// Tauri output/exited listeners are registry-owned and created ONCE per
// instance. PTY forwarding is unconditional; React-side extras (status
// detection, task detection, exit callbacks) dispatch through per-SESSION
// hooks that TerminalPane registers — session-scoped rather than mount-scoped
// on purpose: Switchboard shows status dots for background tabs whose panes
// may be unmounted (split mode), so detection must keep running while hidden.
// Per-MOUNT handlers (onStolen) are owner-token guarded: last mount wins, the
// loser is severed so its late cleanup is a no-op.
//
// THE GRID IS PINNED (SWIT-103, terminalGrid.ts): every terminal is created
// at TERMINAL_COLS × TERMINAL_ROWS and nothing here ever fits it to a pane.
// What a layout change needs instead lives in this file too, because it all
// reaches into the entry's DOM: the scroll-range re-sync (viewportReach.ts —
// Ky's replacement for our old cols-1 resize bounce), where the pane sits
// over the fixed grid (hostPark.ts), and the IO the turn-end settle runs
// through (repaintRunner.ts).

import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { open } from "@tauri-apps/plugin-shell";
import {
  writeToSession,
  resizeSession,
  loadScrollback,
  onSessionOutput,
  onSessionExited,
} from "./ipc";
import { log } from "./logger";
import {
  followScrollTop,
  isFollowing,
  isTypedInput,
  parkTarget,
  type HostGeometry,
} from "./hostPark";
import { snapshotModeSuffix } from "./repaintPlan";
import {
  configureRepaintIO,
  forgetRepaint,
  isRepaintRewriting,
  noteRepaintOutput,
  noteRepaintScroll,
  type RepaintTerminal,
} from "./repaintRunner";
import { bouncePtyRows, lastPtyBounceAt } from "./resumeHealRunner";
import { readRestoreGeometry, restoreSettleSequence } from "./scrollbackRestore";
import { TERMINAL_COLS, TERMINAL_ROWS } from "./terminalGrid";
import {
  readViewportReach,
  remeasureViewport,
  type RenderDimensionsLike,
  type ViewportLike,
} from "./viewportReach";
import {
  FIRST_SPAWN_GEN,
  acceptsGeneration,
  adopt,
  attachedLifecycle,
  markExited,
  nextGeneration,
  release,
  revive,
  type KeepAliveLifecycle,
} from "./terminalLifecycle";

const THEME = {
  background: "#0f0f0f",
  foreground: "#ededed",
  cursor: "#7dd3a8",
  cursorAccent: "#0f0f0f",
  selectionBackground: "rgba(125, 211, 168, 0.3)",
  selectionForeground: "#ededed",
  black: "#1a1a1a",
  red: "#EF4444",
  green: "#34D399",
  yellow: "#F59E0B",
  blue: "#60A5FA",
  magenta: "#A78BFA",
  cyan: "#22D3EE",
  white: "#E4E4E7",
  brightBlack: "#52525B",
  brightRed: "#FCA5A5",
  brightGreen: "#6EE7B7",
  brightYellow: "#FCD34D",
  brightBlue: "#93C5FD",
  brightMagenta: "#C4B5FD",
  brightCyan: "#67E8F9",
  brightWhite: "#FAFAFA",
};

export interface TerminalInstance {
  terminal: Terminal;
  webglAddon: WebglAddon | null;
  searchAddon: SearchAddon;
  serializeAddon: SerializeAddon;
  webLinksAddon: WebLinksAddon;
}

/** React-side extras dispatched by the registry-owned subscriptions. Keyed by
 *  SESSION (not mount) — registered once per session by TerminalPane and kept
 *  across unmounts so background sessions keep status/task detection. */
export type SessionHooks = {
  /** User typed/pasted — status bookkeeping. The PTY write itself is
   *  registry-owned and runs unconditionally. */
  onUserData?: (data: string) => void;
  /** Fires after xterm parses written output — status detection reads the
   *  buffer around the cursor. Runs mounted or hidden. */
  onWriteParsed?: (terminal: Terminal) => void;
  /** Per-chunk raw PTY bytes — task detection. The term.write itself is
   *  registry-owned and runs detached too. */
  onOutput?: (bytes: Uint8Array) => void;
  /** The PTY exited (fires after the exit tail is written). */
  onExited?: () => void;
  /** The turn-end clean rewrite re-laid the buffer (same text, the row count
   *  above the cursor may have moved). Called from INSIDE the snapshot write's
   *  callback, with the cursor where the snapshot put it; the onWriteParsed of
   *  the batch that carried the snapshot is WITHHELD (it is a replay, not a
   *  turn), so anything that tracks a buffer position re-anchors here. */
  onBufferRewritten?: (terminal: Terminal) => void;
};

/** Per-mount handlers, owner-token guarded. */
export type MountHandlers = {
  /** A newer mount adopted the instance out from under this one — the DOM
   *  just emptied; go inert and stop touching the terminal. */
  onStolen?: () => void;
};

type Entry = TerminalInstance & {
  /** Wrapper div that term.open()ed into — moves between the visible host and
   *  the hidden keep-alive root; the xterm element inside survives the move. */
  container: HTMLDivElement;
  lifecycle: KeepAliveLifecycle;
  /** The current owner's per-mount handlers; null while detached. */
  mount: { owner: number; handlers: MountHandlers } | null;
  /** While non-null, PTY output is buffered until scrollback restore lands. */
  pendingRestore: Uint8Array[] | null;
  stop: () => void;
  disposed: boolean;
  /** The pane is FOLLOWING the content's bottom over the fixed grid: new
   *  output keeps it in view. False once the reader scrolled the pane up to
   *  look at the top of the screen; true again when they come back, type, or
   *  the pane is shown afresh (hostPark.ts). */
  hostFollowing: boolean;
  /** A follow pass is queued for the next frame (one per frame, however many
   *  writes parsed in it). */
  followQueued: boolean;
};

const registry = new Map<string, Entry>();
const sessionHooks = new Map<string, SessionHooks>();

// Owner tokens: each mount gets one, so a late cleanup from a mount that lost
// the instance to a newer one (same session in two panes, single↔split
// transitions) is a no-op.
let nextOwnerToken = 1;
export function newOwnerToken(): number {
  return nextOwnerToken++;
}

// Detached terminals live here — in the DOM but display:none, so xterm keeps
// accepting writes (buffer model advances) with zero render cost.
let hiddenRoot: HTMLDivElement | null = null;
function keepAliveRoot(): HTMLDivElement {
  if (!hiddenRoot) {
    hiddenRoot = document.createElement("div");
    hiddenRoot.style.display = "none";
    hiddenRoot.setAttribute("data-terminal-keepalive", "");
    document.body.appendChild(hiddenRoot);
  }
  return hiddenRoot;
}

// Spawn generations: the generation this frontend currently expects a
// session's PTY events to carry. Events stamped with any other generation
// come from a PREVIOUS spawn's unjoined reader thread (restart reuses the
// session id) and are dropped. Defaults to FIRST_SPAWN_GEN when the entry is
// created; bumped by bumpSessionGeneration BEFORE each restart invoke.
const sessionGenerations = new Map<string, number>();

/** Bump the session's expected spawn generation and return it. MUST be called
 *  BEFORE the restart invoke is sent: the old PTY dies inside that invoke, so
 *  bumping first guarantees (a) every dying old-reader event carries a stale
 *  generation and is dropped whenever it arrives, and (b) the new spawn's
 *  very first output — which can overtake the invoke's own resolution, since
 *  Tauri delivers events and invoke results on the same IPC — already matches
 *  the expectation and can never be dropped. */
export function bumpSessionGeneration(sessionId: string): number {
  const next = nextGeneration(sessionGenerations.get(sessionId));
  sessionGenerations.set(sessionId, next);
  return next;
}

/** The generation this frontend currently expects the session's PTY events to
 *  carry — undefined before the registry entry exists (fresh session whose
 *  pane hasn't mounted). Read-only seam for consumers with their own event
 *  subscriptions (T5's shell-ready wait filters stale-spawn chunks with it). */
export function getSessionGeneration(sessionId: string): number | undefined {
  return sessionGenerations.get(sessionId);
}

// Dirty tracking: sessions that received new PTY data since last serialization.
// Owned here because the registry's output listener is what writes the data
// (and marks it dirty — there is no external marker anymore).
const dirtySessionIds = new Set<string>();

export function isSessionDirty(sessionId: string): boolean {
  return dirtySessionIds.has(sessionId);
}
export function clearSessionDirty(sessionId: string): void {
  dirtySessionIds.delete(sessionId);
}

// Monotonic per-session output counters, bumped on every PTY chunk. The
// evidence scrollback scan (SWIT-66 review fix) compares this against the
// count it last scanned at so an idle terminal costs zero; it cannot share
// dirtySessionIds because workspace's serializer CLEARS that bit for its own
// bookkeeping.
const sessionWriteCounts = new Map<string, number>();

export function getSessionWriteCount(sessionId: string): number {
  return sessionWriteCounts.get(sessionId) ?? 0;
}

// Additive per-session INPUT listeners (T5 seam): the registry's onData →
// PTY-write subscription is created ONCE per instance, and the single
// SessionHooks.onUserData slot belongs to TerminalPane (status bookkeeping) —
// last-registration-wins there. Threads need to observe the same user-input
// stream (chatStarted detection) WITHOUT clobbering that slot, so this is a
// multi-listener side channel: observe-only, the PTY write itself stays
// registry-owned and unconditional. Listeners survive in-place restarts (the
// terminal instance does too) and die with the entry on disposal.
const sessionInputListeners = new Map<string, Set<(data: string) => void>>();

export function addSessionInputListener(
  sessionId: string,
  listener: (data: string) => void
): () => void {
  let set = sessionInputListeners.get(sessionId);
  if (!set) {
    set = new Set();
    sessionInputListeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    const current = sessionInputListeners.get(sessionId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) sessionInputListeners.delete(sessionId);
  };
}

// External per-session state cleanup (e.g. terminal.ts's saved scroll
// positions) — run on every disposal path, including exit-while-hidden, so
// facade-owned maps can't leak. Registered at module load, not per session.
const disposeCleanups: Array<(sessionId: string) => void> = [];
export function registerDisposeCleanup(fn: (sessionId: string) => void): void {
  disposeCleanups.push(fn);
}

// Module-level config for font settings — set once from App after config loads
let terminalConfig = {
  fontSize: 13,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'SF Mono', monospace",
};

export function setTerminalConfig(cfg: { fontSize?: number; fontFamily?: string }) {
  if (cfg.fontSize !== undefined) terminalConfig.fontSize = cfg.fontSize;
  if (cfg.fontFamily !== undefined) terminalConfig.fontFamily = `'${cfg.fontFamily}', 'Cascadia Code', 'SF Mono', monospace`;
}

export function getTerminal(sessionId: string): TerminalInstance | undefined {
  return registry.get(sessionId);
}

export function getAllTerminalIds(): string[] {
  return Array.from(registry.keys());
}

/** True when the session's terminal is parked in the hidden keep-alive root
 *  (no mount is showing it). Such terminals must not get a WebGL context —
 *  they get a fresh one on re-adoption. */
export function isTerminalDetached(sessionId: string): boolean {
  const entry = registry.get(sessionId);
  return !!entry && entry.lifecycle.attachedTo === null;
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Screen-level WebGL gate (T11): when the workstation shell shows a
// non-terminal screen, the WHOLE terminal screen sits behind a screen-level
// display:none that neither TerminalPane's visible prop nor the keep-alive
// root sees — every attached pane would keep its GPU context while KB or the
// Explorer is up. terminal.ts#setTerminalScreenVisible owns the toggle (and
// the re-show repaint); while the gate is closed, enableWebGL is a no-op so
// the acquire/adopt/show/recover paths can't create contexts behind the
// hidden screen either.
let screenWebGLEnabled = true;

/** Flip the gate. Returns true when the value actually changed (the caller
 *  only walks the registry on a real transition). */
export function setScreenWebGLGate(visible: boolean): boolean {
  if (screenWebGLEnabled === visible) return false;
  screenWebGLEnabled = visible;
  return true;
}

/** WebGL renderer, loaded per ATTACH and disposed on detach, so hidden
 *  terminals don't pile up GPU contexts — browsers cap live WebGL contexts
 *  and evict the oldest, which could be the one on screen (the likely root of
 *  the sleep/wake texture corruption). Falls back to the DOM renderer if the
 *  context can't be created or is lost. */
export function enableWebGL(sessionId: string): void {
  if (!screenWebGLEnabled) return; // terminal screen hidden — no GPU contexts
  const entry = registry.get(sessionId);
  if (!entry || entry.webglAddon) return;
  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      log.warn(`WebGL context lost for session id=${sessionId}`);
      webglAddon.dispose();
      if (entry.webglAddon === webglAddon) entry.webglAddon = null;
    });
    entry.terminal.loadAddon(webglAddon);
    entry.webglAddon = webglAddon;
    log.debug(`WebGL enabled for session id=${sessionId}`);
  } catch (e) {
    log.warn(`Failed to enable WebGL for session id=${sessionId}: ${e}`);
    entry.webglAddon = null; /* DOM renderer fallback */
  }
}

export function disableWebGL(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry || !entry.webglAddon) return;
  log.debug(`Disabling WebGL for session id=${sessionId}`);
  try {
    entry.webglAddon.dispose();
  } catch {
    /* context already lost/disposed */
  }
  entry.webglAddon = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SCROLL RANGE (viewportReach.ts) — what replaces the cols-1 bounce.
// ─────────────────────────────────────────────────────────────────────────────

/** xterm's Viewport, reached through the core. Private API, so every use is
 *  optional-chained and the caller treats absence as "nothing to sync". */
function coreViewport(term: Terminal): ViewportLike | undefined {
  return (term as unknown as { _core?: { viewport?: ViewportLike } })._core?.viewport;
}

/** A renderer's dimensions, with the css cell box the host geometry reads. */
type LiveDimensions = RenderDimensionsLike & {
  css: { cell?: { width: number; height: number } };
};

/** The CURRENT renderer's dimensions — the object the Viewport must read.
 *  Private API; the getter throws with no renderer, so absence and a throw
 *  both read as "nothing to re-point". */
function liveRenderDimensions(term: Terminal): LiveDimensions | undefined {
  try {
    return (
      term as unknown as { _core?: { _renderService?: { dimensions?: LiveDimensions } } }
    )._core?._renderService?.dimensions;
  } catch {
    return undefined;
  }
}

function bufferShape(term: Terminal): { baseY: number; viewportY: number; length: number } {
  const b = term.buffer.active;
  return { baseY: b.baseY, viewportY: b.viewportY, length: b.length };
}

function dprNow(): number {
  return typeof window === "undefined" ? -1 : window.devicePixelRatio;
}

/** Re-sync xterm's scroll area after the terminal came back on screen — out
 *  of the keep-alive root, a hidden tab, a hidden screen, or a sleeping
 *  window.
 *
 *  While hidden, PTY output kept advancing the buffer, and every advance had
 *  xterm record a viewport height of ZERO and size its scroll area one screen
 *  short. Nothing re-measures on re-show, so an idle terminal keeps the
 *  hidden-era range and the wheel scrolls against a range that no longer
 *  matches the buffer ("scrolling is stuck / snaps back"). We used to poke
 *  this with a cols-1 → cols resize; a cols change re-wraps the whole buffer,
 *  the one thing a pinned grid never does. `syncScrollArea(true)` is the whole
 *  fix and it is non-destructive: it recomputes the scroll area AND the
 *  scrollTop through xterm's own caches, from buffer state — no cols change,
 *  no reflow, no SIGWINCH.
 *
 *  It also re-points the Viewport at the LIVE renderer's dimensions first:
 *  every show loads a fresh WebGL renderer, and the Viewport would otherwise
 *  go on reading the one dropped at hide (wrong by a display-scaling change). */
export function resyncTerminalViewport(sessionId: string, cause: string): void {
  const entry = registry.get(sessionId);
  if (!entry || entry.disposed) return;
  let frames = 0;
  const attempt = (): void => {
    // Disposed, or replaced, while we waited on layout.
    const live = registry.get(sessionId);
    if (!live || live !== entry || live.disposed) return;
    // A host still mid-layout measures 0, and syncing there would record
    // ANOTHER zero-height viewport — the same staleness we are here to clear.
    // Bounded wait: a pane that never lays out (mounted into a hidden tab)
    // gets its own resync when it is shown.
    if (live.container.offsetHeight <= 0 || live.container.offsetWidth <= 0) {
      if (frames++ < 10) {
        requestAnimationFrame(attempt);
        return;
      }
      log.debug(`viewport resync id=${sessionId} cause=${cause} applied=false why=not-laid-out`);
      return;
    }
    const viewport = coreViewport(live.terminal);
    if (!viewport?.syncScrollArea) {
      log.warn(`viewport resync id=${sessionId} cause=${cause} applied=false why=no-viewport`);
      return;
    }
    const outcome = remeasureViewport(viewport, liveRenderDimensions(live.terminal));
    const reach = readViewportReach(viewport, bufferShape(live.terminal));
    const line =
      `viewport resync id=${sessionId} cause=${cause} repointed=${outcome.repointed} cellChanged=${outcome.cellChanged}` +
      ` dpr=${dprNow()} viewportY=${live.terminal.buffer.active.viewportY} baseY=${live.terminal.buffer.active.baseY}` +
      (reach ? ` maxRow=${reach.plan.maxRow} shortRows=${reach.plan.shortRows}` : "");
    // The routine case (a fresh renderer, same numbers) is debug; a cell that
    // really changed, or a range still short after the sync, is the forensic.
    if (outcome.cellChanged || (reach && reach.plan.short)) log.info(line);
    else log.debug(line);
  };
  requestAnimationFrame(attempt);
}

/** The DOM scroller's range must reach the buffer's bottom row. Called where
 *  the reader is about to need the bottom — the start of a wheel gesture — it
 *  measures, and when the range is short forces a full re-measure and logs
 *  the geometry, so the log says WHY the range was short and whether the
 *  re-measure held. Returns true when a short range was found. */
export function ensureViewportReach(sessionId: string, cause: string): boolean {
  const entry = registry.get(sessionId);
  if (!entry || entry.disposed) return false;
  try {
    const viewport = coreViewport(entry.terminal);
    if (!viewport) return false;
    const before = readViewportReach(viewport, bufferShape(entry.terminal));
    if (!before || !before.plan.short) return false;
    const outcome = remeasureViewport(viewport, liveRenderDimensions(entry.terminal));
    const after = readViewportReach(viewport, bufferShape(entry.terminal));
    log.info(
      `viewport short id=${sessionId} cause=${cause} healed=${after !== null && !after.plan.short}` +
        ` repointed=${outcome.repointed} cellChanged=${outcome.cellChanged} dpr=${dprNow()}` +
        ` ${JSON.stringify(before.detail)} afterMaxRow=${after?.plan.maxRow ?? -1}`
    );
    return true;
  } catch (e) {
    // A log-only path in effect: nothing here may throw into a wheel handler.
    log.warn(`viewport reach check failed id=${sessionId}: ${e}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHERE THE PANE SITS OVER THE FIXED GRID (hostPark.ts holds the rules).
// The host is the pane element the terminal's container is mounted in; it
// scrolls on both axes (TerminalPane). Nothing here touches the grid.
// ─────────────────────────────────────────────────────────────────────────────

/** The pane element showing this terminal, or null while it is parked. */
function hostOf(entry: Entry): HTMLElement | null {
  if (entry.lifecycle.attachedTo === null) return null;
  const host = entry.container.parentElement;
  return host && host !== hiddenRoot ? host : null;
}

/** On screen for real — not display:none (a hidden tab, a hidden screen, the
 *  keep-alive root) and not zero-size. */
function isLaidOut(entry: Entry): boolean {
  const host = hostOf(entry);
  if (!host || host.offsetParent === null) return false;
  const rect = host.getBoundingClientRect();
  return rect.width >= 8 && rect.height >= 8;
}

/** Where the pane should sit to show the content's bottom, with the row
 *  height the follow rules need — or null when there is nothing to park. The
 *  slack is read FIRST and alone: a pane that fits the grid (the common case)
 *  and a hidden one both stop there, before the buffer is walked. */
function hostTarget(entry: Entry, host: HTMLElement): { target: number; rowHeight: number } | null {
  const scrollHeight = host.scrollHeight;
  const clientHeight = host.clientHeight;
  if (!(scrollHeight - clientHeight > 1)) return null;
  const screen = readRestoreGeometry(entry.terminal);
  const g: HostGeometry = {
    scrollHeight,
    clientHeight,
    rowHeight: liveRenderDimensions(entry.terminal)?.css.cell?.height ?? 0,
    cursorY: screen.cursorY,
    lastContentRow: screen.lastContentRow,
  };
  const target = parkTarget(g);
  return target === null ? null : { target, rowHeight: g.rowHeight };
}

/** Put the content's bottom in view and start following it — an EXPLICIT
 *  park: the pane was just shown, or the user typed / sent. A no-op for a
 *  pane that fits the grid. */
export function parkTerminalHost(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry || entry.disposed) return;
  entry.hostFollowing = true;
  const host = hostOf(entry);
  if (!host) return;
  const t = hostTarget(entry, host);
  if (t && Math.abs(host.scrollTop - t.target) >= 1) host.scrollTop = t.target;
}

/** New output landed, or the pane changed size: keep the content's bottom in
 *  view IF the pane is following it and the reader is at the live screen (a
 *  reader up in xterm's history is looking at old rows; the pane stays put).
 *  `settled` = output is quiet (the turn-end settle, a pane resize) — only
 *  then may the pane move UP to content that collapsed (hostPark). */
export function followTerminalHost(sessionId: string, settled: boolean): void {
  const entry = registry.get(sessionId);
  if (!entry || entry.disposed || !entry.hostFollowing) return;
  const host = hostOf(entry);
  if (!host) return;
  const buf = entry.terminal.buffer.active;
  if (buf.viewportY < buf.baseY) return;
  const t = hostTarget(entry, host);
  if (!t) return;
  const next = followScrollTop(t.target, host.scrollTop, t.rowHeight, settled);
  if (Math.abs(host.scrollTop - next) >= 1) host.scrollTop = next;
}

/** The pane scrolled (TerminalPane's scroll listener — the user's wheel or
 *  scrollbar, or one of the parks above): is it still holding the content's
 *  bottom? A pane with nothing to scroll is always following. */
export function noteTerminalHostScroll(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (!entry || entry.disposed) return;
  const host = hostOf(entry);
  if (!host) return;
  const t = hostTarget(entry, host);
  entry.hostFollowing = t === null ? true : isFollowing(t.target, host.scrollTop, t.rowHeight);
}

/** One follow pass per frame, however many writes parsed in it. */
function queueFollow(sessionId: string, entry: Entry): void {
  if (entry.followQueued || !entry.hostFollowing || entry.lifecycle.attachedTo === null) return;
  entry.followQueued = true;
  requestAnimationFrame(() => {
    entry.followQueued = false;
    if (entry.disposed || isRepaintRewriting(sessionId)) return;
    followTerminalHost(sessionId, false);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TURN-END SETTLE's hands (repaintRunner.ts holds the clock and the
// sequencing; this is the live terminal it works on).
// ─────────────────────────────────────────────────────────────────────────────

/** xterm's active mouse encoding (DEFAULT | SGR | SGR_PIXELS). Private API;
 *  absent → null, which appends nothing. */
function mouseEncodingOf(term: Terminal): string | null {
  const enc = (term as unknown as { _core?: { coreMouseService?: { activeEncoding?: unknown } } })
    ._core?.coreMouseService?.activeEncoding;
  return typeof enc === "string" ? enc : null;
}

function repaintHandle(entry: Entry): RepaintTerminal {
  const term = entry.terminal;
  return {
    instance: term,
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    buffer: term.buffer,
    laidOut: () => isLaidOut(entry),
    hasSelection: () => term.hasSelection(),
    hasFocus: () => !!term.element && term.element.contains(document.activeElement),
    focus: () => term.focus(),
    // The WHOLE buffer WITH its modes (unlike the scrollback save, which
    // drops them): the program is still running, and the reset below clears
    // bracketed paste, application cursor keys, mouse tracking and focus
    // reporting out from under it. Measured against xterm 5.5 + this addon
    // in headless Chrome (SWIT-103): serialize → reset → write comes back
    // with the same rows, the same baseY, the same cursor cell and the modes
    // re-armed; a hidden cursor (claude hides it) survives the reset by
    // itself, so nothing is appended for it. The mouse ENCODING is (the reset
    // puts it back to DEFAULT and the addon only re-arms the tracking mode).
    serialize: () =>
      entry.serializeAddon.serialize() +
      snapshotModeSuffix({ mouseEncoding: mouseEncodingOf(term) }),
    bracketedPaste: () => term.modes.bracketedPasteMode,
    // OPACITY, not visibility: a visibility-hidden element cannot hold focus,
    // so the helper textarea blurred and keystrokes typed during the parse went
    // to <body>. Opacity 0 keeps focus and looks the same — the pane's own
    // background shows through either way.
    setHidden: (hidden) => {
      if (term.element) term.element.style.opacity = hidden ? "0" : "";
    },
    reset: () => term.reset(),
    resize: (cols, rows) => term.resize(cols, rows),
    write: (data, done) => term.write(data, done),
    refresh: () => term.refresh(0, term.rows - 1),
    scrollToBottom: () => term.scrollToBottom(),
    scrollLines: (amount) => term.scrollLines(amount),
  };
}

configureRepaintIO({
  getTerminal: (sessionId) => {
    const entry = registry.get(sessionId);
    return entry && !entry.disposed ? repaintHandle(entry) : undefined;
  },
  resyncViewport: resyncTerminalViewport,
  bouncePty: bouncePtyRows,
  lastBounceAt: lastPtyBounceAt,
  // Output went quiet: the content's bottom is a fact now, so a following
  // pane may come UP to content that collapsed (a `clear`).
  onSettle: (sessionId) => followTerminalHost(sessionId, true),
  onRewritten: (sessionId) => {
    const entry = registry.get(sessionId);
    if (!entry || entry.disposed) return;
    sessionHooks.get(sessionId)?.onBufferRewritten?.(entry.terminal);
  },
});

/** Process one PTY chunk: render it, mark for the periodic scrollback save,
 *  count it toward the turn-end settle, and dispatch the session's React-side
 *  extras (task detection). THE one live-output write site — restored
 *  scrollback and the exit notice are written directly and are not output. */
function writeChunk(entry: Entry, sessionId: string, bytes: Uint8Array): void {
  entry.terminal.write(bytes);
  dirtySessionIds.add(sessionId);
  sessionWriteCounts.set(sessionId, (sessionWriteCounts.get(sessionId) ?? 0) + 1);
  sessionHooks.get(sessionId)?.onOutput?.(bytes);
  // AFTER the hooks, on purpose: the resume heal arms its settle timer in
  // that hook and this arms the turn-end settle's, both the same length, so
  // the heal reads the screen first — before a rewrite this settle may start
  // has reset the buffer under it.
  noteRepaintOutput(sessionId, bytes.length);
}

/** Adopt the session's live terminal into `host` (moving its DOM subtree), or
 *  create one there on first mount. `adopted` = the buffer is already rendered
 *  and current — the mount has nothing to replay or wait on. The grid is NOT
 *  an option: every terminal is TERMINAL_COLS × TERMINAL_ROWS. */
export function acquireTerminal(
  sessionId: string,
  host: HTMLElement,
  owner: number,
  opts?: { restoredFromId?: string }
): { instance: TerminalInstance; adopted: boolean } {
  const existing = registry.get(sessionId);
  if (existing && !existing.disposed) {
    // Every existing entry is adoptable — including an exited one, whose
    // buffer (the exit tail) is exactly what the remount is there to show.
    const outcome = adopt(existing.lifecycle, owner);
    if (outcome.steal) {
      // Last mount wins (same session in two panes) — tell the loser its
      // pane emptied and sever its handlers so nothing double-fires.
      log.debug(`Terminal stolen id=${sessionId} from=${existing.mount?.owner} to=${owner}`);
      existing.mount?.handlers.onStolen?.();
    }
    existing.mount = null;
    existing.lifecycle = outcome.next;
    host.appendChild(existing.container);
    enableWebGL(sessionId);
    // Hidden writes advanced the buffer but the renderer skipped them —
    // repaint the viewport now that it's visible again. refresh() redraws
    // ROWS only; the scroll area it scrolls within is stale from the hidden
    // era, so re-sync that too. With the grid pinned no refit follows an
    // adopt, so this is the only thing that touches the viewport.
    existing.terminal.refresh(0, existing.terminal.rows - 1);
    existing.hostFollowing = true; // a fresh pane starts on the content
    resyncTerminalViewport(sessionId, "adopt");
    log.debug(
      `Terminal adopted id=${sessionId} owner=${owner} grid=${existing.terminal.cols}x${existing.terminal.rows} baseY=${existing.terminal.buffer.active.baseY}`
    );
    return { instance: existing, adopted: true };
  }

  log.debug(
    `Creating terminal for session id=${sessionId} grid=${TERMINAL_COLS}x${TERMINAL_ROWS} owner=${owner}`
  );

  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "100%";
  host.appendChild(container);

  const terminal = new Terminal({
    fontFamily: terminalConfig.fontFamily,
    fontSize: terminalConfig.fontSize,
    lineHeight: 1.3,
    theme: THEME,
    cursorBlink: true,
    cursorStyle: "bar" as const,
    scrollback: 10000,
    allowProposedApi: true,
    convertEol: true,
    screenReaderMode: false,
    // THE PINNED GRID, from the first frame and for the instance's whole life
    // (terminalGrid.ts). The PTY was spawned at the same grid (ipc.ts), so
    // the program inside sees one size, ever. No fit addon is loaded: the
    // pane's measured size never reaches the grid.
    cols: TERMINAL_COLS,
    rows: TERMINAL_ROWS,
  });
  const searchAddon = new SearchAddon();
  terminal.loadAddon(searchAddon);
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);
  const webLinksAddon = new WebLinksAddon((_event, uri) => {
    open(uri).catch(console.error);
  });
  terminal.loadAddon(webLinksAddon);
  terminal.open(container);

  const entry: Entry = {
    terminal,
    webglAddon: null,
    searchAddon,
    serializeAddon,
    webLinksAddon,
    container,
    lifecycle: attachedLifecycle(owner),
    mount: null,
    pendingRestore: opts?.restoredFromId ? [] : null,
    stop: () => {},
    disposed: false,
    hostFollowing: true,
    followQueued: false,
  };
  registry.set(sessionId, entry);
  enableWebGL(sessionId);

  // Registry-owned term subscriptions — created once for the instance's whole
  // life. PTY forwarding is unconditional; React-side extras dispatch through
  // the session hooks (which persist across unmounts).
  terminal.onData((data) => {
    sessionHooks.get(sessionId)?.onUserData?.(data);
    const inputListeners = sessionInputListeners.get(sessionId);
    if (inputListeners) for (const fn of inputListeners) fn(data);
    writeToSession(sessionId, data).catch(console.error);
    // Typing or pasting takes the reader to the prompt: xterm scrolls its own
    // history there on input, and on a pane shorter than the grid the PANE
    // has to come too or the text lands below the fold.
    if (isTypedInput(data)) parkTerminalHost(sessionId);
  });
  terminal.onResize(({ cols, rows }) => {
    // The xterm → PTY mirror, so the two can never disagree. It does not fire
    // in normal running: the grid is pinned and no layout path resizes it. The
    // one caller of terminal.resize left is the turn-end rewrite's way back
    // onto the pin (repaintPlan) — hence the loud line if this ever runs.
    log.warn(
      `Terminal grid changed id=${sessionId} -> ${cols}x${rows} (pinned ${TERMINAL_COLS}x${TERMINAL_ROWS}); syncing the PTY`
    );
    resizeSession(sessionId, cols, rows).catch(console.error);
  });
  terminal.onWriteParsed(() => {
    // The turn-end rewrite re-emits the transcript into a reset terminal:
    // that is not output, and the status detector must not read a new turn
    // out of it. The runner keeps the flag up until the microtask AFTER the
    // snapshot's write callback, and xterm fires this for the batch after
    // running that callback — so the batch that carried the snapshot is the
    // one skipped (the detector re-anchored through onBufferRewritten inside
    // the callback). A live chunk parsed in that same batch is skipped with
    // it; the next chunk's parse reads from the re-anchored row and covers it.
    if (isRepaintRewriting(sessionId)) return;
    sessionHooks.get(sessionId)?.onWriteParsed?.(terminal);
    queueFollow(sessionId, entry);
  });
  terminal.onScroll(() => {
    // A terminal-side scroll (output, scrollToBottom, typed input): a rewrite
    // deferred under a scrolled-up reader flushes once they are back.
    noteRepaintScroll(sessionId);
  });
  terminal.buffer.onBufferChange(() => {
    // Without a refresh + texture atlas clear, WebGL can render stale glyphs
    // from the previous buffer when an app like vim or Claude Code's plan
    // editor switches to/from the alt screen.
    terminal.refresh(0, terminal.rows - 1);
    if (entry.webglAddon) terminal.clearTextureAtlas();
  });

  // Clipboard keys: Ctrl/Cmd+C copies the selection ONLY when there is one —
  // otherwise it falls through as the interrupt. Ctrl/Cmd+V just SKIPS xterm's
  // keydown mapping (^V) so the browser's default paste proceeds: xterm wires
  // its own `paste` listener (bracketed paste into the PTY), so writing the
  // clipboard here too would double-paste every paste/dictation (Wispr Flow
  // injects via paste). NOTE: useKeyboardShortcuts replaces this handler once
  // the session first becomes active (xterm has a single custom-handler slot);
  // its handler carries the same Ctrl+C rule — this one covers the window
  // before first activation.
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === "c" || e.key === "C")) {
      if (terminal.hasSelection()) {
        // clipboard can reject (permission/focus) — swallow so it doesn't
        // surface as an unhandled rejection.
        void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
        terminal.clearSelection();
        return false; // handled — keep ^C from interrupting
      }
      return true; // no selection → ^C interrupts as usual
    }
    if (mod && !e.shiftKey && !e.altKey && (e.key === "v" || e.key === "V")) return false;
    return true;
  });

  // The generation this entry's events must carry. Set synchronously at entry
  // creation — before the listeners below even register — so the first output
  // of a fresh session can never be generation-dropped. A fresh session id is
  // a brand-new UUID (no stale reader threads possible), hence gen 1; after a
  // restart the expectation was already bumped pre-invoke and must be kept.
  if (!sessionGenerations.has(sessionId)) {
    sessionGenerations.set(sessionId, FIRST_SPAWN_GEN);
  }

  // Registry-owned Tauri listeners — they outlive any mount, which is the
  // point: output keeps flowing into the terminal while detached, so its
  // render model is correct at every moment and reattach has nothing to
  // reconcile. They die only with the entry (session close). Both drop events
  // stamped with a stale spawn generation: after an in-place restart the old
  // reader thread's dying output would stamp garbage above the new prompt,
  // and its exited event would re-latch the fresh session (Restart button
  // over a running shell).
  void (async () => {
    const unOut = await onSessionOutput(sessionId, (data, gen) => {
      if (entry.disposed) return;
      if (!acceptsGeneration(sessionGenerations.get(sessionId), gen)) {
        log.debug(
          `Dropping stale-gen output id=${sessionId} gen=${gen} expected=${sessionGenerations.get(sessionId)}`
        );
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = b64ToBytes(data);
      } catch (e) {
        log.warn(`Base64 decode error for session id=${sessionId}: ${e}`);
        return;
      }
      // Buffer PTY output while scrollback is being restored to prevent the
      // new shell's prompt from appearing before the old scrollback content.
      if (entry.pendingRestore) {
        entry.pendingRestore.push(bytes);
        return;
      }
      writeChunk(entry, sessionId, bytes);
    });
    const unExit = await onSessionExited(sessionId, (gen) => {
      if (entry.disposed) return;
      if (!acceptsGeneration(sessionGenerations.get(sessionId), gen)) {
        log.debug(
          `Dropping stale-gen exited id=${sessionId} gen=${gen} expected=${sessionGenerations.get(sessionId)}`
        );
        return;
      }
      entry.terminal.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      sessionHooks.get(sessionId)?.onExited?.();
      // Exit never disposes — shown or parked, the entry survives so the
      // final output stays readable (Switchboard keeps exited sessions in
      // the tab bar with a Restart button). Only session close tears down.
      entry.lifecycle = markExited(entry.lifecycle);
    });
    entry.stop = () => {
      unOut();
      unExit();
    };
    if (entry.disposed) entry.stop(); // raced a dispose while subscribing
  })();

  // Restore scrollback for sessions restored from a saved workspace, then
  // flush any PTY chunks that arrived meanwhile (xterm writes are queued in
  // order, so the restore content lands first).
  //
  // SWIT-93: the serialized frame ends by moving the cursor back to where it
  // WAS (claude's input box, rows above the bottom), so the fresh shell and
  // the resumed claude painted over the old rows. After the frame is PARSED
  // (the write callback — not merely queued) the buffer is measured and a
  // settle sequence puts the cursor on a fresh line under the last content
  // row; only then do the buffered PTY chunks flush. `lib/scrollbackRestore`
  // holds the pure rule.
  if (opts?.restoredFromId) {
    const restoredFromId = opts.restoredFromId;
    log.debug(`Restoring scrollback for session id=${sessionId} from=${restoredFromId}`);
    loadScrollback(restoredFromId)
      .then(
        (content) =>
          new Promise<void>((resolve) => {
            if (!content || entry.disposed) return resolve();
            entry.terminal.write(content, () => {
              if (entry.disposed) return resolve();
              const settle = restoreSettleSequence(readRestoreGeometry(entry.terminal));
              entry.terminal.write(settle, () => {
                entry.terminal.scrollToBottom();
                resolve();
              });
            });
          })
      )
      .then(() => log.debug(`Scrollback restored for session id=${sessionId}`))
      .catch((e) => {
        log.warn(`Failed to restore scrollback for session id=${sessionId}: ${e}`);
      })
      .finally(() => {
        const buffered = entry.pendingRestore;
        entry.pendingRestore = null;
        if (buffered && !entry.disposed) {
          for (const chunk of buffered) writeChunk(entry, sessionId, chunk);
        }
      });
  }

  return { instance: entry, adopted: false };
}

/** Register the session's React-side extras. Idempotent — last registration
 *  wins; hooks persist across unmounts (background sessions keep detecting). */
export function registerSessionHooks(sessionId: string, hooks: SessionHooks): void {
  sessionHooks.set(sessionId, hooks);
}

/** Remove a session's hooks (call on session close/restart-rewire). */
export function unregisterSessionHooks(sessionId: string): void {
  sessionHooks.delete(sessionId);
}

/** Bind the mounted component's per-mount handlers. Owner-guarded: a mount
 *  that already lost the instance can't clobber the current owner's. */
export function bindMountHandlers(sessionId: string, owner: number, handlers: MountHandlers): void {
  const entry = registry.get(sessionId);
  if (entry && entry.lifecycle.attachedTo === owner) entry.mount = { owner, handlers };
}

/** Unbind at mount cleanup — only this owner's own binding. */
export function unbindMountHandlers(sessionId: string, owner: number): void {
  const entry = registry.get(sessionId);
  if (entry && entry.mount?.owner === owner) entry.mount = null;
}

/** A mount is unmounting: detach into the keep-alive root. Never disposes —
 *  exited or not, the buffer stays readable until session close. */
export function releaseTerminal(sessionId: string, owner: number): void {
  const entry = registry.get(sessionId);
  if (!entry) return;
  const outcome = release(entry.lifecycle, owner);
  if (outcome.action === "ignore") return; // a newer mount owns it now
  log.debug(`Terminal released to keep-alive id=${sessionId} owner=${owner}`);
  entry.lifecycle = outcome.next;
  entry.mount = null;
  disableWebGL(sessionId); // no GPU context while hidden; DOM renderer takes over
  keepAliveRoot().appendChild(entry.container);
}

/** In-place restart on the same session id (App's Restart button): clear the
 *  exited latch so the lifecycle state stays truthful for the new PTY that is
 *  about to stream into the same live terminal. */
export function reviveSession(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (entry) entry.lifecycle = revive(entry.lifecycle);
}

/** Tear the instance down for real: session close / kill, app teardown.
 *  Unconditional — the caller has decided the session itself is over. */
export function disposeTerminal(sessionId: string): void {
  const entry = registry.get(sessionId);
  if (entry) disposeEntry(sessionId, entry);
}

function disposeEntry(sessionId: string, entry: Entry): void {
  if (entry.disposed) return;
  log.debug(`Disposing terminal for session id=${sessionId}`);
  entry.disposed = true;
  registry.delete(sessionId);
  entry.stop();
  entry.mount = null;
  entry.pendingRestore = null;
  if (entry.webglAddon) {
    try {
      entry.webglAddon.dispose();
    } catch {
      /* context already lost/disposed */
    }
    entry.webglAddon = null;
  }
  try {
    entry.terminal.dispose();
  } catch {
    /* already disposed */
  }
  entry.container.remove();
  dirtySessionIds.delete(sessionId);
  sessionWriteCounts.delete(sessionId);
  forgetRepaint(sessionId);
  sessionInputListeners.delete(sessionId);
  sessionGenerations.delete(sessionId); // session closed — id never reused
  for (const fn of disposeCleanups) fn(sessionId);
}
