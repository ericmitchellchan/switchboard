import { useState, useEffect, useRef, useCallback } from "react";
import type { SearchAddon } from "@xterm/addon-search";

interface SearchBarProps {
  searchAddon: SearchAddon;
  onClose: () => void;
}

export function SearchBar({ searchAddon, onClose }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState<{ resultIndex: number; resultCount: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Listen for match results
  useEffect(() => {
    const disposable = searchAddon.onDidChangeResults((e) => {
      setMatchCount(e);
    });
    return () => disposable.dispose();
  }, [searchAddon]);

  const findNext = useCallback(() => {
    if (query) searchAddon.findNext(query, { regex: false, caseSensitive: false, decorations: {
      matchOverviewRuler: "#e8b765",
      activeMatchColorOverviewRuler: "#e8b765",
    }});
  }, [query, searchAddon]);

  const findPrev = useCallback(() => {
    if (query) searchAddon.findPrevious(query, { regex: false, caseSensitive: false, decorations: {
      matchOverviewRuler: "#e8b765",
      activeMatchColorOverviewRuler: "#e8b765",
    }});
  }, [query, searchAddon]);

  const handleClose = useCallback(() => {
    searchAddon.clearDecorations();
    onClose();
  }, [searchAddon, onClose]);

  // Search as you type
  useEffect(() => {
    if (query) {
      searchAddon.findNext(query, { regex: false, caseSensitive: false, decorations: {
        matchOverviewRuler: "#e8b765",
        activeMatchColorOverviewRuler: "#e8b765",
      }});
    } else {
      searchAddon.clearDecorations();
      setMatchCount(null);
    }
  }, [query, searchAddon]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      handleClose();
    } else if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      findPrev();
    } else if (e.key === "Enter") {
      e.preventDefault();
      findNext();
    }
  };

  const matchLabel = matchCount
    ? matchCount.resultCount > 0
      ? `${matchCount.resultIndex + 1}/${matchCount.resultCount}`
      : "No results"
    : "";

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 16,
        display: "flex",
        alignItems: "center",
        gap: 4,
        backgroundColor: "var(--bg-active)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "4px 6px",
        zIndex: 10,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find..."
        style={{
          width: 160,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--text-primary)",
          backgroundColor: "var(--bg-primary)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 3,
          padding: "3px 6px",
          outline: "none",
        }}
      />
      {matchLabel && (
        <span
          style={{
            fontSize: 10,
            color: matchCount && matchCount.resultCount > 0 ? "var(--text-muted)" : "var(--accent-red)",
            minWidth: 42,
            textAlign: "center",
          }}
        >
          {matchLabel}
        </span>
      )}
      <button
        onClick={findPrev}
        title="Previous (Shift+Enter)"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--text-muted)",
          padding: "1px 4px",
          borderRadius: 3,
        }}
      >
        {"\u2191"}
      </button>
      <button
        onClick={findNext}
        title="Next (Enter)"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--text-muted)",
          padding: "1px 4px",
          borderRadius: 3,
        }}
      >
        {"\u2193"}
      </button>
      <button
        onClick={handleClose}
        title="Close (Escape)"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--text-dim)",
          padding: "1px 4px",
          borderRadius: 3,
        }}
      >
        {"\u2715"}
      </button>
    </div>
  );
}
