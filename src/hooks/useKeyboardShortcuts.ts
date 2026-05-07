import { useEffect, useRef } from "react";
import type { TerminalInstance } from "../lib/terminal";
import { getTerminal } from "../lib/terminal";

export interface ShortcutActions {
  onNewTab: () => void;
  onCloseTab: () => void;
  onPrevTab: () => void;
  onNextTab: () => void;
  onSwitchToIndex: (index: number) => void;
  onToggleSidebar: () => void;
  onSearch?: () => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onClosePane?: () => void;
  onMoveFocus?: (direction: "up" | "down" | "left" | "right") => void;
  onExport?: () => void;
  onMoveTabLeft?: () => void;
  onMoveTabRight?: () => void;
  onTogglePip?: () => void;
}

// Keys we intercept from xterm.js
function isOurShortcut(e: KeyboardEvent): boolean {
  // F5 reload (no modifier needed)
  if (e.key === "F5") return true;
  // Ctrl+Shift+R reload
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "r") return true;

  if (!e.ctrlKey) return false;
  const key = e.key.toLowerCase();

  // Ctrl+key
  if (
    key === "t" ||
    key === "w" ||
    key === "[" ||
    key === "]" ||
    key === "b" ||
    key === "f" ||
    key === "\\" ||
    key === "-" ||
    (key >= "1" && key <= "9")
  ) {
    return true;
  }

  // Ctrl+Shift+W (close pane), Ctrl+Shift+S (export), Ctrl+Shift+[/] (move tab),
  // Ctrl+Shift+P (toggle floating window).
  // Shift+[ produces { and Shift+] produces } on most keyboards
  if (e.shiftKey && (key === "w" || key === "s" || key === "p" || key === "{" || key === "}")) return true;

  // Ctrl+Alt+Arrow (move focus between panes)
  if (e.altKey && (key === "arrowup" || key === "arrowdown" || key === "arrowleft" || key === "arrowright")) {
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

  // Register the custom key handler on the active terminal
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

      const key = e.key.toLowerCase();
      const a = actionsRef.current;

      // Ctrl+Alt+Arrow — move focus between panes
      if (e.altKey) {
        switch (key) {
          case "arrowup":
            e.preventDefault();
            a.onMoveFocus?.("up");
            return;
          case "arrowdown":
            e.preventDefault();
            a.onMoveFocus?.("down");
            return;
          case "arrowleft":
            e.preventDefault();
            a.onMoveFocus?.("left");
            return;
          case "arrowright":
            e.preventDefault();
            a.onMoveFocus?.("right");
            return;
        }
        return;
      }

      // Ctrl+Shift shortcuts
      if (e.shiftKey) {
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
          a.onTogglePip?.();
          return;
        }
        // Ctrl+Shift+[ / Ctrl+Shift+] — move tab left/right
        // On most keyboards, Shift+[ = { and Shift+] = }
        if (key === "{" || key === "[") {
          e.preventDefault();
          a.onMoveTabLeft?.();
          return;
        }
        if (key === "}" || key === "]") {
          e.preventDefault();
          a.onMoveTabRight?.();
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
        case "\\":
          e.preventDefault();
          a.onSplitHorizontal?.();
          break;
        case "-":
          e.preventDefault();
          a.onSplitVertical?.();
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
