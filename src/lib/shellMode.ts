// Shell mode (SWIT-55, the shell-v3 strip-back) — ONE switch, bare by default.
//
// Eric, 2026-09-01: "rip everything out — hide or put away the code — start
// bare bones and build slowly." So everything outside the bare set (Home ·
// Trading · Knowledge base · Threads · the panel) is hidden behind a single
// render gate, and NOTHING is deleted: the hidden surfaces stay in the build,
// in the test suite and behind their routes (a deep link to a Research page
// or the Explorer screen still opens — only the MENU entries go).
//
// The switch is read ONCE at boot, from two places, in this order:
//   1. the URL: `?shell=full` (or `?shell=bare`). The route writer preserves
//      non-route params through replaceState, so the value survives every
//      navigation and an F5 — no rebuild, no config edit, just the URL.
//   2. config.json: `shell_mode: "full"` (alias `shellMode`). Config arrives
//      ASYNC (useConfig → get_config), so the module LATCHES: the first config
//      value applied is the one that counts, and a URL value already set wins
//      over it. Nothing re-reads later — flipping the mode mid-session is not
//      a supported state (the gates are read at render, so the latch is what
//      makes "once" true rather than the hook).
// Anything unrecognised falls through to the next source; the default is bare.
//
// One flag, no per-feature flags: a surface is either in the bare set or it
// is not. Pure rules here (parse/resolve), plus the module singleton the
// components read; `useShellMode` subscribes so the config arrival repaints
// a menu that was already on screen.

import { useSyncExternalStore } from "react";

export type ShellMode = "bare" | "full";

/** The default: bare. Named so the tests and the components say the same word. */
export const DEFAULT_SHELL_MODE: ShellMode = "bare";

/** The URL query key. */
export const SHELL_MODE_PARAM = "shell";

/** Parse one raw value (from the URL or config) into a mode, or null when it
 *  names neither — an unknown word is "no opinion", never an error and never
 *  silently `bare`, so the next source still gets its say. */
export function parseShellModeValue(value: unknown): ShellMode | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "full") return "full";
  if (v === "bare") return "bare";
  return null;
}

/** The URL's opinion: `?shell=full` → full, `?shell=bare` → bare, absent or
 *  unknown → null. Takes the search string (with or without the `?`). */
export function parseShellModeParam(search: string): ShellMode | null {
  return parseShellModeValue(new URLSearchParams(search).get(SHELL_MODE_PARAM));
}

/** THE resolution rule, pure: URL wins, then config, then the default. */
export function resolveShellMode(input: { search?: string; config?: unknown }): ShellMode {
  return (
    (input.search !== undefined ? parseShellModeParam(input.search) : null) ??
    parseShellModeValue(input.config) ??
    DEFAULT_SHELL_MODE
  );
}

// ── Module singleton ─────────────────────────────────────────────────────────

type State = {
  mode: ShellMode;
  /** Once a source has SPOKEN (URL at boot, or the first config apply) the
   *  mode is latched and later config arrivals are ignored. */
  latched: boolean;
};

function bootState(): State {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const fromUrl = parseShellModeParam(search);
  return fromUrl ? { mode: fromUrl, latched: true } : { mode: DEFAULT_SHELL_MODE, latched: false };
}

let state: State = bootState();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** The current mode. */
export function shellMode(): ShellMode {
  return state.mode;
}

/** `true` in bare mode — the render gate every hidden band/chip site reads. */
export function isBare(): boolean {
  return state.mode === "bare";
}

/** Apply config.json's value ONCE. A URL value already set wins; a second
 *  config apply (a re-fetch) is ignored; an unrecognised value neither latches
 *  nor changes anything. Returns the mode in force afterwards. */
export function applyConfigShellMode(value: unknown): ShellMode {
  if (state.latched) return state.mode;
  const parsed = parseShellModeValue(value);
  if (parsed === null) return state.mode;
  state = { mode: parsed, latched: true };
  emit();
  return state.mode;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe a component to the mode — repaints when the config value lands
 *  after first render. */
export function useShellMode(): ShellMode {
  return useSyncExternalStore(subscribe, shellMode, shellMode);
}

/** Tests only: force a mode (latched) or, with `null`, reset to the boot
 *  state so the config-apply path can be exercised again. */
export function __setShellModeForTests(mode: ShellMode | null): void {
  state = mode === null ? bootState() : { mode, latched: true };
  emit();
}
