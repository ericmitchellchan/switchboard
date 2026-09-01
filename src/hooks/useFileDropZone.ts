// Drag-and-drop of real files onto a composer (SWIT-59; Ky's fileDropZone,
// carried over).
//
// Tauri swallows OS drag-drop before the webview sees it, so HTML5 onDragOver /
// onDrop never fire — the webview's own onDragDropEvent is the only path. That
// event is WEBVIEW-wide and carries a physical-pixel cursor position, so one
// shared listener hit-tests the position and routes the drop to the zone under
// the cursor: several composers can be mounted at once (a restored split), and
// only the one you dropped on should take it. A drop that lands on NO zone is
// not ours — App's `file-drop` listener pastes it into the active terminal, as
// it always has; a zone that takes a drop CLAIMS it (lib/attachments) so that
// paste stands down.
//
// Hit-testing goes through elementFromPoint rather than comparing rects, so
// stacking (an overlay covering a composer) resolves the same way a real click
// would — topmost wins, a covered zone gets nothing.

import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { noteDropClaimed } from "../lib/attachments";
import { log } from "../lib/logger";

type Zone = {
  el: HTMLElement;
  onDrop: (paths: string[]) => void;
  setOver: (over: boolean) => void;
};

const zones = new Set<Zone>();
let unlisten: (() => void) | null = null;
let starting = false;

function zoneAt(physicalX: number, physicalY: number): Zone | null {
  if (zones.size === 0) return null;
  // The event reports physical device pixels; the DOM works in CSS pixels.
  const ratio = window.devicePixelRatio || 1;
  let node: Element | null = document.elementFromPoint(physicalX / ratio, physicalY / ratio);
  while (node) {
    for (const zone of zones) {
      if (zone.el === node) return zone;
    }
    node = node.parentElement;
  }
  return null;
}

function highlight(active: Zone | null) {
  for (const zone of zones) zone.setOver(zone === active);
}

function ensureListener() {
  if (unlisten || starting) return;
  starting = true;
  void getCurrentWebview()
    .onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        highlight(null);
        return;
      }
      const zone = zoneAt(payload.position.x, payload.position.y);
      if (payload.type === "drop") {
        highlight(null);
        if (zone && payload.paths.length > 0) {
          noteDropClaimed(payload.paths);
          zone.onDrop(payload.paths);
        }
        return;
      }
      // enter / over
      highlight(zone);
    })
    .then((un) => {
      unlisten = un;
    })
    .catch((err) => {
      starting = false;
      log.error(`file drop listener failed: ${err}`);
    });
}

// Vite HMR replaces this module without tearing down the old listener, which
// would double-attach every dropped file. Drop it with the old module.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unlisten?.();
    unlisten = null;
    starting = false;
  });
}

/** Attach `ref` to the element that accepts drops; `isOver` drives the hover cue. */
export function useFileDropZone<T extends HTMLElement>(onPaths: (paths: string[]) => void) {
  const ref = useRef<T | null>(null);
  const [isOver, setIsOver] = useState(false);
  // Keep the latest callback without re-registering the zone every render.
  const handler = useRef(onPaths);
  handler.current = onPaths;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const zone: Zone = {
      el,
      onDrop: (paths) => handler.current(paths),
      setOver: setIsOver,
    };
    zones.add(zone);
    ensureListener();
    return () => {
      zones.delete(zone);
      setIsOver(false);
    };
  }, []);

  return { ref, isOver };
}
