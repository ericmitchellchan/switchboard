import { useEffect, useRef } from "react";
import type { TerminalInstance } from "../lib/terminal";
import { getTerminal } from "../lib/terminal";

interface ShortcutActions {
  onNewTab: () => void;
  onCloseTab: () => void;
  onPrevTab: () => void;
  onNextTab: () => void;
  onSwitchToIndex: (index: number) => void;
}

// Keys we intercept from xterm.js
function isOurShortcut(e: KeyboardEvent): boolean {
  if (!e.ctrlKey) return false;
  const key = e.key.toLowerCase();
  return (
    key === "t" ||
    key === "w" ||
    key === "[" ||
    key === "]" ||
    (key >= "1" && key <= "9")
  );
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
      if (!e.ctrlKey) return;

      const key = e.key.toLowerCase();
      const a = actionsRef.current;

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
