import type { PaneNode } from "../lib/paneLayout";
import type { Session, AgentStatus } from "../types";
import { SessionHeader } from "./SessionHeader";
import { TerminalPane } from "./TerminalPane";
import { PaneDivider } from "./PaneDivider";

interface PaneContainerProps {
  root: PaneNode;
  sessions: Session[];
  focusedPaneId: string | null;
  searchOpen: boolean;
  onCloseSearch: () => void;
  onFocusPane: (paneId: string) => void;
  onResize: (branchId: string, ratio: number) => void;
  onExited: (sessionId: string) => void;
  onStatusChange: (sessionId: string, status: AgentStatus) => void;
  onAutoTask: (task: { text: string; fingerprint: string; priority: "high" | "med" | "low"; category: string }, sessionId: string) => void;
  onResolveTask: (fingerprintPrefix: string) => void;
  onRestart?: (sessionId: string) => void;
  isSplit: boolean;
}

export function PaneContainer({
  root,
  sessions,
  focusedPaneId,
  searchOpen,
  onCloseSearch,
  onFocusPane,
  onResize,
  onExited,
  onStatusChange,
  onAutoTask,
  onResolveTask,
  onRestart,
  isSplit,
}: PaneContainerProps) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
      <PaneNodeRenderer
        node={root}
        sessions={sessions}
        focusedPaneId={focusedPaneId}
        searchOpen={searchOpen}
        onCloseSearch={onCloseSearch}
        onFocusPane={onFocusPane}
        onResize={onResize}
        onExited={onExited}
        onStatusChange={onStatusChange}
        onAutoTask={onAutoTask}
        onResolveTask={onResolveTask}
        onRestart={onRestart}
        isSplit={isSplit}
      />
    </div>
  );
}

interface PaneNodeRendererProps {
  node: PaneNode;
  sessions: Session[];
  focusedPaneId: string | null;
  searchOpen: boolean;
  onCloseSearch: () => void;
  onFocusPane: (paneId: string) => void;
  onResize: (branchId: string, ratio: number) => void;
  onExited: (sessionId: string) => void;
  onStatusChange: (sessionId: string, status: AgentStatus) => void;
  onAutoTask: (task: { text: string; fingerprint: string; priority: "high" | "med" | "low"; category: string }, sessionId: string) => void;
  onResolveTask: (fingerprintPrefix: string) => void;
  onRestart?: (sessionId: string) => void;
  isSplit: boolean;
}

function PaneNodeRenderer({
  node,
  sessions,
  focusedPaneId,
  searchOpen,
  onCloseSearch,
  onFocusPane,
  onResize,
  onExited,
  onStatusChange,
  onAutoTask,
  onResolveTask,
  onRestart,
  isSplit,
}: PaneNodeRendererProps) {
  if (node.type === "leaf") {
    const session = sessions.find((s) => s.id === node.sessionId);
    if (!session) return null;

    const isFocused = node.id === focusedPaneId;

    return (
      <div
        data-pane-pointer-block
        onClick={() => onFocusPane(node.id)}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          border: isSplit
            ? isFocused
              ? "1px solid #A78BFA44"
              : "1px solid transparent"
            : "none",
          transition: "border-color 0.15s",
        }}
      >
        {isSplit && <SessionHeader session={session} compact />}
        <TerminalPane
          session={session}
          searchOpen={isFocused && searchOpen}
          onCloseSearch={onCloseSearch}
          onExited={onExited}
          onStatusChange={onStatusChange}
          onAutoTask={onAutoTask}
          onResolveTask={onResolveTask}
          onRestart={onRestart}
          isFocused={isFocused}
        />
      </div>
    );
  }

  // Branch node
  const isHorizontal = node.direction === "horizontal";
  const firstPercent = `${node.ratio * 100}%`;
  const secondPercent = `${(1 - node.ratio) * 100}%`;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: isHorizontal ? "row" : "column",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          flex: `0 0 calc(${firstPercent} - 2px)`,
          display: "flex",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <PaneNodeRenderer
          node={node.first}
          sessions={sessions}
          focusedPaneId={focusedPaneId}
          searchOpen={searchOpen}
          onCloseSearch={onCloseSearch}
          onFocusPane={onFocusPane}
          onResize={onResize}
          onExited={onExited}
          onStatusChange={onStatusChange}
          onAutoTask={onAutoTask}
          onResolveTask={onResolveTask}
          onRestart={onRestart}
          isSplit={isSplit}
        />
      </div>
      <PaneDivider
        direction={node.direction}
        branchId={node.id}
        onResize={onResize}
      />
      <div
        style={{
          flex: `0 0 calc(${secondPercent} - 2px)`,
          display: "flex",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <PaneNodeRenderer
          node={node.second}
          sessions={sessions}
          focusedPaneId={focusedPaneId}
          searchOpen={searchOpen}
          onCloseSearch={onCloseSearch}
          onFocusPane={onFocusPane}
          onResize={onResize}
          onExited={onExited}
          onStatusChange={onStatusChange}
          onAutoTask={onAutoTask}
          onResolveTask={onResolveTask}
          onRestart={onRestart}
          isSplit={isSplit}
        />
      </div>
    </div>
  );
}
