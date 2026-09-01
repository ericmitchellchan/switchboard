import { useEffect, useRef } from "react";
import type { TerminalInstance } from "../lib/terminal";
import { getTerminal } from "../lib/terminal";

export interface ShortcutActions {
  onNewTab: () => void;
  onCloseTab: () => void;
  onPrevTab: () => void;
  onNextTab: () => void;
  /** Ctrl+1–9 — jump to the Nth THREAD in side-menu order (SWIT-45). The tab
   *  strip is retired, so index-jumping is thread-row-jumping now. */
  onSwitchToIndex: (index: number) => void;
  onToggleSidebar: () => void;
  onSearch?: () => void;
  /** Ctrl+Shift+W — close the focused PANE without killing its session.
   *  Splits can no longer be CREATED (SWIT-45 retired the split chords), but
   *  a restored workspace may still hold one, so unwinding stays possible. */
  onClosePane?: () => void;
  onExport?: () => void;
  /** Ctrl+Shift+O — toggle the floating PiP window. Moved off Ctrl+Shift+P in
   *  A2, which the artifact panel toggle claimed (architecture.md §Panel
   *  host); the two can't share a chord. */
  onTogglePip?: () => void;
  /** Ctrl+Shift+B — toggle the LEFT workstation side menu (T4). Plain Ctrl+B
   *  stays the right task-sidebar cycle. */
  onToggleSideMenu?: () => void;
  /** Ctrl+Shift+P — TOGGLE the active tab's artifact panel: close what's open,
   *  or reopen the last artifact that tab showed (A3 gave the panel an open
   *  path, and panelStore keeps the per-tab memory). Still a no-op on a tab
   *  that has never had one — and the status-bar chip that advertises the
   *  chord only renders when it would actually do something. */
  onTogglePanel?: () => void;
  /** Ctrl+Shift+M — toggle the FOCUSED pane's composer (increment D). It shows
   *  itself on a tab holding a live claude conversation; this hides it, or
   *  forces one onto a plain shell. Per-session and remembered for the app's
   *  lifetime (lib/composer.toggleComposer). */
  onToggleComposer?: () => void;
  /** Ctrl+Shift+F — toggle the active tab's panel FULL VIEW (SWIT-54): the
   *  panel overlays the whole workspace, the terminal grid untouched beneath
   *  it. A no-op on a tab with no open panel; Esc inside the panel restores
   *  too. Plain Ctrl+F stays terminal search. */
  onTogglePanelMaximize?: () => void;
}

// Keys we intercept from xterm.js
function isOurShortcut(e: KeyboardEvent): boolean {
  // F5 reload (no modifier needed)
  if (e.key === "F5") return true;
  // Ctrl+Shift+R reload
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "r") return true;

  if (!e.ctrlKey) return false;
  // Ctrl+Alt is NOT ours (SWIT-45 review): AltGr reports ctrl+alt on Windows,
  // and on intl layouts AltGr produces brackets/digits — intercepting those
  // would eat typed characters. The split-focus chords that used to live on
  // Ctrl+Alt+Arrow are retired, so nothing of ours is here at all.
  if (e.altKey) return false;
  const key = e.key.toLowerCase();

  // Ctrl+key. The split chords (Ctrl+\ / Ctrl+-) and Ctrl+Alt+Arrow are
  // RETIRED (SWIT-45): one terminal per thread — open another thread instead
  // of splitting. Not intercepting them hands the keys back to the shell.
  if (
    key === "t" ||
    key === "w" ||
    key === "[" ||
    key === "]" ||
    key === "b" ||
    key === "f" ||
    (key >= "1" && key <= "9")
  ) {
    return true;
  }

  // Ctrl+Shift+W (close pane), Ctrl+Shift+S (export),
  // Ctrl+Shift+P (toggle artifact panel), Ctrl+Shift+O (toggle floating window),
  // Ctrl+Shift+M (toggle composer), Ctrl+Shift+F (panel full view, SWIT-54).
  // The tab-move chords (Ctrl+Shift+[/]) went with the tab strip.
  if (
    e.shiftKey &&
    (key === "w" ||
      key === "s" ||
      key === "p" ||
      key === "o" ||
      key === "m" ||
      key === "f")
  ) {
    return true;
  }

  return false;
}

export function useKeyboardShortcuts(
  actions: ShortcutActions,
  activeSessionId: string | null
) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // Register the custom key handler on the active terminal.
  //
  // Handler-slot interplay: xterm has a SINGLE custom-key-handler slot. The
  // registry installs a baseline handler (Ctrl+C copy / Ctrl+V skip) at
  // instance creation — this effect REPLACES it the first time the session
  // becomes active and never restores it, so both handlers must carry the
  // same clipboard rules (this one adds the shortcut interception on top).
  // TODO: centralize the clipboard rules in the registry's handler with a
  // pluggable shortcut hook so there's one handler instead of two copies.
  useEffect(() => {
    if (!activeSessionId) return;

    const instance: TerminalInstance | undefined =
      getTerminal(activeSessionId);
    if (!instance) return;

    const handler = instance.terminal.attachCustomKeyEventHandler(
      (e: KeyboardEvent) => {
        // Ctrl+C: copy selection or send SIGINT
        if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "c" && e.type === "keydown") {
          if (instance.terminal.hasSelection()) {
            navigator.clipboard.writeText(instance.terminal.getSelection()).catch(console.error);
            instance.terminal.clearSelection();
            return false; // don't send to PTY
          }
          return true; // no selection → send SIGINT as normal
        }

        // Ctrl+V: skip xterm's keydown mapping (^V) so the browser's default
        // paste proceeds — xterm's own `paste` listener does the bracketed
        // paste into the PTY. Same rule as the registry's baseline handler
        // (terminalRegistry.ts); writing the clipboard here would double-paste.
        if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "v" && e.type === "keydown") {
          return false;
        }

        if (isOurShortcut(e)) {
          // Return false = xterm won't process it, we handle it in the global listener
          return false;
        }
        return true;
      }
    );

    return () => {
      // attachCustomKeyEventHandler doesn't return an unlisten, but setting a new one replaces it.
      // We'll let the next effect call replace it. The handler variable suppresses unused warnings.
      void handler;
    };
  }, [activeSessionId]);

  // Global keyboard listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // F5 or Ctrl+Shift+R — reload page (Tauri WebView2 doesn't handle F5)
      if (e.key === "F5" || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "r")) {
        e.preventDefault();
        window.location.reload();
        return;
      }

      if (!e.ctrlKey) return;
      // AltGr = ctrl+alt on Windows: a German AltGr+8 ("[") must insert a
      // bracket in the composer/editor, never fire onPrevTab. Ctrl+Alt has no
      // chords of ours any more (the split set retired), so hand it all back.
      if (e.altKey) return;

      const key = e.key.toLowerCase();
      const a = actionsRef.current;

      // Ctrl+Shift shortcuts
      if (e.shiftKey) {
        if (key === "b") {
          e.preventDefault();
          a.onToggleSideMenu?.();
          return;
        }
        if (key === "w") {
          e.preventDefault();
          a.onClosePane?.();
          return;
        }
        if (key === "s") {
          e.preventDefault();
          a.onExport?.();
          return;
        }
        if (key === "p") {
          e.preventDefault();
          a.onTogglePanel?.();
          return;
        }
        if (key === "o") {
          e.preventDefault();
          a.onTogglePip?.();
          return;
        }
        if (key === "m") {
          e.preventDefault();
          a.onToggleComposer?.();
          return;
        }
        if (key === "f") {
          e.preventDefault();
          a.onTogglePanelMaximize?.();
          return;
        }
      }

      switch (key) {
        case "t":
          e.preventDefault();
          a.onNewTab();
          break;
        case "w":
          e.preventDefault();
          a.onCloseTab();
          break;
        case "[":
          e.preventDefault();
          a.onPrevTab();
          break;
        case "]":
          e.preventDefault();
          a.onNextTab();
          break;
        case "b":
          e.preventDefault();
          a.onToggleSidebar();
          break;
        case "f":
          e.preventDefault();
          a.onSearch?.();
          break;
        default:
          if (key >= "1" && key <= "9") {
            e.preventDefault();
            a.onSwitchToIndex(parseInt(key, 10) - 1);
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
