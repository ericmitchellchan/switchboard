import { useCallback, useRef, useState } from "react";

interface PaneDividerProps {
  direction: "horizontal" | "vertical";
  branchId: string;
  onResize: (branchId: string, ratio: number) => void;
}

export function PaneDivider({ direction, branchId, onResize }: PaneDividerProps) {
  const [dragging, setDragging] = useState(false);
  const dividerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);

      const parent = dividerRef.current?.parentElement;
      if (!parent) return;

      const rect = parent.getBoundingClientRect();

      const onMouseMove = (ev: MouseEvent) => {
        let ratio: number;
        if (direction === "horizontal") {
          ratio = (ev.clientX - rect.left) / rect.width;
        } else {
          ratio = (ev.clientY - rect.top) / rect.height;
        }
        onResize(branchId, ratio);
      };

      const onMouseUp = () => {
        setDragging(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        // Re-enable pointer events on iframes/terminals
        const pointerBlockers = document.querySelectorAll("[data-pane-pointer-block]");
        pointerBlockers.forEach((el) => {
          (el as HTMLElement).style.pointerEvents = "";
        });
      };

      document.body.style.cursor =
        direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      // Disable pointer events on terminal panes during drag
      const pointerBlockers = document.querySelectorAll("[data-pane-pointer-block]");
      pointerBlockers.forEach((el) => {
        (el as HTMLElement).style.pointerEvents = "none";
      });

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [direction, branchId, onResize]
  );

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
        backgroundColor: dragging ? "#A78BFA66" : "#1E1E22",
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
