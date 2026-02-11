import { useState, useCallback } from "react";
import type { SidebarState } from "../types";

const STORAGE_KEY = "switchboard:sidebar";
const CYCLE: SidebarState[] = ["full", "collapsed", "hidden"];

function loadState(): SidebarState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && CYCLE.includes(raw as SidebarState)) return raw as SidebarState;
  } catch {
    // ignore
  }
  return "hidden";
}

export function useSidebarState() {
  const [sidebarState, setSidebarState] = useState<SidebarState>(loadState);

  const cycleSidebar = useCallback(() => {
    setSidebarState((prev) => {
      const idx = CYCLE.indexOf(prev);
      const next = CYCLE[(idx + 1) % CYCLE.length];
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return { sidebarState, cycleSidebar };
}
