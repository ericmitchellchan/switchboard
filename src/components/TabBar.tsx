import { useRef, useState, useEffect } from "react";
import type { Session } from "../types";
import { PulsingDot } from "./PulsingDot";
import { STATUS_CONFIGS } from "../lib/statusConfig";

interface TabBarProps {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, newName: string) => void;
  onReorder?: (sessionId: string, newIndex: number) => void;
  waitingCount: number;
}

export function TabBar({
  sessions,
  activeId,
  onSelect,
  onClose,
  onRename,
  onReorder,
  waitingCount,
}: TabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const checkScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  };

  useEffect(() => {
    checkScroll();
    const el = scrollRef.current;
    if (el) {
      el.addEventListener("scroll", checkScroll);
      const ro = new ResizeObserver(checkScroll);
      ro.observe(el);
      return () => {
        el.removeEventListener("scroll", checkScroll);
        ro.disconnect();
      };
    }
  }, []);

  // Auto-scroll active tab into view
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeId) return;
    const activeTab = el.querySelector(
      `[data-session-id="${activeId}"]`
    ) as HTMLElement | null;
    if (activeTab) {
      activeTab.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [activeId]);

  // Focus input when editing starts
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const scroll = (dir: number) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * 160, behavior: "smooth" });
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  const cancelRename = () => {
    setEditingId(null);
  };

  // Group sessions by group/repo for dividers
  let lastGroup = "";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        backgroundColor: "#0A0A0B",
        borderBottom: "1px solid #1E1E22",
        height: 44,
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {/* App title */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          gap: 7,
          borderRight: "1px solid #1E1E22",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            fontWeight: 700,
            color: "#E4E4E7",
            letterSpacing: "0.02em",
          }}
        >
          SWITCHBOARD
        </span>
        {waitingCount > 0 && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#0A0A0B",
              backgroundColor: "#F59E0B",
              borderRadius: 4,
              padding: "1px 5px",
              fontFamily: "var(--font-mono)",
            }}
          >
            {waitingCount}
          </span>
        )}
      </div>

      {/* Scrollable tab area */}
      <div
        style={{
          display: "flex",
          flex: 1,
          overflow: "hidden",
          alignItems: "stretch",
          position: "relative",
        }}
      >
        {canScrollLeft && (
          <button
            onClick={() => scroll(-1)}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: 28,
              background: "linear-gradient(90deg, #0A0A0B 60%, transparent)",
              border: "none",
              cursor: "pointer",
              zIndex: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              color: "#71717A",
            }}
          >
            {"\u2039"}
          </button>
        )}

        <div
          ref={scrollRef}
          className="tabs-scroll"
          style={{
            display: "flex",
            flex: 1,
            overflowX: "auto",
            overflowY: "hidden",
            alignItems: "stretch",
            scrollbarWidth: "none",
          }}
        >
          {sessions.map((session, idx) => {
            const isActive = session.id === activeId;
            const cfg = STATUS_CONFIGS[session.status] || STATUS_CONFIGS.running;
            const groupKey = session.group || session.repo || "";
            const showDivider = groupKey !== lastGroup && idx > 0 && groupKey !== "";
            lastGroup = groupKey;

            const isHovered = hoveredId === session.id;
            const showClose = isActive || isHovered;

            return (
              <div
                key={session.id}
                data-session-id={session.id}
                draggable={!!onReorder}
                onDragStart={(e) => {
                  setDraggedId(session.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDraggedId(null);
                  setDragOverIdx(null);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverIdx(idx);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggedId && onReorder) {
                    onReorder(draggedId, idx);
                  }
                  setDraggedId(null);
                  setDragOverIdx(null);
                }}
                onMouseEnter={() => setHoveredId(session.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  display: "flex",
                  alignItems: "stretch",
                  flexShrink: 0,
                  opacity: draggedId === session.id ? 0.4 : 1,
                  borderLeft: dragOverIdx === idx && draggedId && draggedId !== session.id
                    ? "2px solid #A78BFA"
                    : "none",
                  transition: "opacity 0.15s",
                }}
              >
                {showDivider && (
                  <div style={{ display: "flex", alignItems: "center", paddingLeft: 4, gap: 4 }}>
                    <div style={{ width: 1, backgroundColor: "#27272A", margin: "8px 0" }} />
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 8.5,
                        fontWeight: 600,
                        color: "#52525B",
                        letterSpacing: "0.04em",
                        padding: "0 4px",
                      }}
                    >
                      {groupKey.toUpperCase()}
                    </span>
                  </div>
                )}
                <button
                  onClick={() => onSelect(session.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "0 6px 0 14px",
                    border: "none",
                    borderTop: isActive
                      ? `2px solid ${cfg.color}`
                      : "2px solid transparent",
                    borderBottom: "none",
                    borderLeft: session.repoColor
                      ? `3px solid ${session.repoColor}`
                      : "none",
                    backgroundColor: isActive ? "#151518" : "transparent",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    color: isActive ? "#E4E4E7" : "#71717A",
                    transition: "background-color 0.15s ease, color 0.15s ease",
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                    position: "relative",
                  }}
                >
                  <PulsingDot
                    color={cfg.color}
                    pulse={cfg.pulse}
                    size={6}
                  />
                  {editingId === session.id ? (
                    <input
                      ref={inputRef}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") cancelRename();
                      }}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11.5,
                        fontWeight: isActive ? 600 : 400,
                        color: "#E4E4E7",
                        backgroundColor: "#27272A",
                        border: "1px solid #3F3F46",
                        borderRadius: 3,
                        padding: "1px 4px",
                        outline: "none",
                        width: Math.max(60, editValue.length * 7.5),
                      }}
                    />
                  ) : (
                    <span
                      style={{ fontWeight: isActive ? 600 : 400 }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingId(session.id);
                        setEditValue(session.name);
                      }}
                    >
                      {session.name}
                    </span>
                  )}
                  {session.repo && (
                    <span
                      style={{
                        fontSize: 9,
                        color: "#52525B",
                        opacity: isActive ? 0.8 : 0.5,
                      }}
                    >
                      {session.repo}
                    </span>
                  )}
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(session.id);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 18,
                      height: 18,
                      borderRadius: 4,
                      fontSize: 14,
                      lineHeight: 1,
                      color: showClose ? "#71717A" : "transparent",
                      cursor: "pointer",
                      transition: "color 0.1s, background-color 0.1s",
                      backgroundColor: "transparent",
                      marginLeft: 2,
                      flexShrink: 0,
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.color = "#E4E4E7";
                      (e.currentTarget as HTMLElement).style.backgroundColor = "#3F3F46";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.color = showClose ? "#71717A" : "transparent";
                      (e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
                    }}
                  >
                    {"\u00D7"}
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        {canScrollRight && (
          <button
            onClick={() => scroll(1)}
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              width: 28,
              background: "linear-gradient(270deg, #0A0A0B 60%, transparent)",
              border: "none",
              cursor: "pointer",
              zIndex: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              color: "#71717A",
            }}
          >
            {"\u203A"}
          </button>
        )}
      </div>
    </div>
  );
}
