import { useCallback, useEffect, useRef, useState } from "react";

interface PaneDividerProps {
  direction: "horizontal" | "vertical";
  branchId: string;
  onResize: (branchId: string, ratio: number) => void;
}

export function PaneDivider({ direction, branchId, onResize }: PaneDividerProps) {
  const [dragBox, setDragBox] = useState<DOMRect | null>(null);
  const dragging = dragBox !== null;
  const dividerRef = useRef<HTMLDivElement>(null);

  // Drag wiring lives in an EFFECT so its teardown also runs on UNMOUNT.
  // Dividers unmount mid-drag whenever the layout changes under them (a pane
  // closes, a tab switch collapses the split), and a mouseup released outside
  // the WebView2 window is never delivered at all — an onMouseUp-only teardown
  // left every pane at `pointer-events: none` with the cursor stuck at
  // col-resize, with no way back short of a reload.
  useEffect(() => {
    if (!dragBox) return;

    const onMouseMove = (ev: MouseEvent) => {
      const ratio =
        direction === "horizontal"
          ? (ev.clientX - dragBox.left) / dragBox.width
          : (ev.clientY - dragBox.top) / dragBox.height;
      onResize(branchId, ratio);
    };
    const onMouseUp = () => setDragBox(null);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    // Disable pointer events on terminal panes during drag
    document.querySelectorAll("[data-pane-pointer-block]").forEach((el) => {
      (el as HTMLElement).style.pointerEvents = "none";
    });

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // Re-enable pointer events on iframes/terminals. Re-queried, not reused:
      // panes can mount or unmount mid-drag.
      document.querySelectorAll("[data-pane-pointer-block]").forEach((el) => {
        (el as HTMLElement).style.pointerEvents = "";
      });
    };
  }, [dragBox, direction, branchId, onResize]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const parent = dividerRef.current?.parentElement;
    if (!parent) return;
    setDragBox(parent.getBoundingClientRect());
  }, []);

  const isHorizontal = direction === "horizontal";

  return (
    <div
      ref={dividerRef}
      onMouseDown={handleMouseDown}
      style={{
        flexShrink: 0,
        width: isHorizontal ? 4 : "100%",
        height: isHorizontal ? "100%" : 4,
        cursor: isHorizontal ? "col-resize" : "row-resize",
        backgroundColor: dragging ? "#EDEDED66" : "var(--border)",
        transition: dragging ? "none" : "background-color 0.15s",
        position: "relative",
        zIndex: 5,
      }}
    >
      {/* Larger hit area */}
      <div
        style={{
          position: "absolute",
          top: isHorizontal ? 0 : -2,
          left: isHorizontal ? -2 : 0,
          width: isHorizontal ? 8 : "100%",
          height: isHorizontal ? "100%" : 8,
        }}
      />
    </div>
  );
}
