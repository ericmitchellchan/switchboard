# Switchboard

## Project Overview
Tabbed terminal multiplexer desktop app for managing AI coding agent sessions. Split panes, PTY management, agent status detection, and auto-task extraction. Built with Tauri v2 + React 18 + xterm.js v5.

## Architecture

```
src/
├── App.tsx                    → Root orchestrator (hooks + components + lifecycle)
├── types.ts                   → Core interfaces (Session, AgentStatus, Task, Config, etc.)
├── components/
│   ├── TerminalPane.tsx         → xterm.js wrapper, PTY data flow, status/task wiring
│   ├── TabBar.tsx               → Tab bar with scroll, rename, close, group dividers
│   ├── PaneContainer.tsx        → Recursive binary tree pane renderer
│   ├── PaneDivider.tsx          → Drag-to-resize between panes
│   ├── SessionHeader.tsx        → Per-session info bar (repo, cwd, restart)
│   ├── TaskSidebar.tsx          → Auto/manual task list (full/collapsed/hidden)
│   ├── SearchBar.tsx            → Ctrl+F terminal search
│   ├── StatusBar.tsx            → Bottom bar (task count, session count)
│   ├── NewSessionDialog.tsx     → Repo picker / new session config (lazy-loaded)
│   ├── Toast.tsx                → Notification toasts
│   └── PulsingDot.tsx           → Animated status indicator
├── hooks/
│   ├── useSessions.ts           → Session CRUD, tab switching, refs for stale-closure safety
│   ├── usePaneLayout.ts         → Binary tree state (split/close/resize/focus)
│   ├── useConfig.ts             → Load config from Rust backend
│   ├── useKeyboardShortcuts.ts  → Global + xterm key handler
│   ├── useTasks.ts              → Task list with dedup + auto-resolve
│   ├── useSidebarState.ts       → Sidebar visibility cycle (full/collapsed/hidden)
│   └── useToasts.ts             → Toast queue with auto-dismiss
├── lib/
│   ├── terminal.ts              → xterm.js instance pool, attach/detach, WebGL, scroll sync
│   ├── statusDetector.ts        → Agent status state machine (pattern match + dwell hysteresis)
│   ├── taskDetector.ts          → Auto-detect build/test/git errors from PTY output
│   ├── paneLayout.ts            → Immutable binary tree operations
│   ├── workspace.ts             → Periodic save/restore to localStorage + disk
│   ├── ipc.ts                   → Tauri invoke() wrappers for all backend commands
│   ├── statusConfig.ts          → Status colors, icons, labels (single source of truth)
│   ├── logger.ts                → Frontend structured logging
│   ├── updater.ts               → Auto-update check
│   └── export.ts                → Export session to file
└── lib/*.test.ts              → 3 Vitest test suites (paneLayout, statusDetector, taskDetector)

src-tauri/
├── src/
│   ├── main.rs                  → Entry point (calls lib::run)
│   ├── lib.rs                   → Tauri commands, plugin setup, event dispatch
│   ├── config.rs                → Config load from %APPDATA%/switchboard/config.json
│   ├── power.rs                 → Win32 power monitor (sleep/wake events)
│   └── pty/
│       ├── mod.rs               → PtyManager: session registry + reader thread
│       └── session.rs           → PtySession: portable-pty wrapper + Drop cleanup
├── tauri.conf.json              → Window, bundle, updater, identifier config
├── capabilities/default.json    → Tauri ACL permissions
└── build.rs                     → Windows manifest (UTF-8 codepage)

Root:
├── dev.ps1                      → Dev script (sets MSVC env, runs pnpm tauri dev)
├── build.ps1                    → Build script (-Full for NSIS installer, default = cargo check)
├── .nightshift.json             → Nightshift stop hook config
└── RELEASE.md                   → Release & signing process
```

## Data Flow

PTY output (backend → frontend):
```
Shell → portable-pty → base64 encode → Tauri event (per-session) → decode → xterm.js
                                                                       ↓
                                                           statusDetector (onWriteParsed)
                                                           taskDetector (raw UTF-8 text)
```

User input (frontend → backend):
```
Keyboard → xterm onData → invoke("write_to_session") → PTY stdin → shell
```

Clipboard paste (OS-level):
```
Ctrl+V → global-shortcut (Win32) → Rust reads clipboard → "clipboard-paste" event → terminal.paste()
```

## Commands

```bash
pnpm test              # Vitest (single run)
pnpm test:watch        # Vitest (watch mode)
.\dev.ps1              # Dev mode (Tauri + Vite HMR)
.\build.ps1            # Quick cargo check
.\build.ps1 -Full      # Production NSIS installer
```

## Conventions

- **Module-level Maps** for terminal instances and detector state — survive React remounts, avoid re-renders
- **Refs over state** for values used in async PTY callbacks (stale closure prevention)
- **Immutable tree ops** for pane layout — pure functions in `paneLayout.ts`, React state in `usePaneLayout.ts`
- **Buffer-based status detection** via `onWriteParsed` — preferred over raw chunk parsing for accuracy
- **Dwell-time hysteresis** for status transitions — prevents flickering on rapid output
- **Fingerprint dedup** for auto-detected tasks — same error doesn't create duplicate tasks
- **Base64 encoding** for PTY ↔ frontend data — safe for JSON serialization over Tauri events
- **Single WebGL context** — only the focused pane gets WebGL in split mode; detach on tab switch
- **Lazy loading** — NewSessionDialog loaded via `React.lazy` + Suspense only when repos configured
- **`portable-pty = "=0.8.1"`** — pinned, v0.9 has Windows ConPTY bug
- **CLAUDECODE env var** stripped from PTY sessions

## Nightshift Integration

Nightshift is a Claude Code Stop hook for automated test verification (repo: `ericmitchellchan/nightshift`).

- **Hook path**: `.claude/settings.json` → Stop hook → `C:/Users/ericm/projects/nightshift/scripts/verify-tests.py`
- **Config**: `.nightshift.json` in project root — `test_command: "pnpm test"`, watches `.ts`, `.tsx`, `.rs`
- **Behavior**: When agent finishes and watched files were modified, the hook runs tests
- **On failure**: Agent is blocked (exit code 2) and **must fix before finishing**
- Do not bypass — fix the failing tests

## Known Issues

These are recurring problem areas from git history — be aware when working in these areas:
- **Viewport scroll desync** on tab switch with new content (multiple prior fixes)
- **WebGL texture corruption** after sleep/wake cycle
- **Status detection false positives** from ANSI escape sequences in PTY output
- **Stale closures** in React hooks with async PTY callbacks (use refs)
- **Black screen on alternate buffer switch** (e.g., vim/less opening in terminal)

## Key Docs

- `README.md` — Features, keyboard shortcuts, status indicator reference
- `RELEASE.md` — Release process, code signing, version bumping

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| New tab | Ctrl+T |
| Close tab + session | Ctrl+W |
| Close pane only | Ctrl+Shift+W |
| Prev/next tab | Ctrl+[ / Ctrl+] |
| Jump to tab | Ctrl+1–9 |
| Toggle sidebar | Ctrl+B |
| Terminal search | Ctrl+F |
| Split horizontal | Ctrl+\\ |
| Split vertical | Ctrl+- |
| Move pane focus | Ctrl+Alt+Arrow |

## Jira & Knowledge Routing

- **Jira instance**: ericmitchellchan.atlassian.net (Cloud ID: `26513658-3895-4d82-b441-08240a277d6b`)
- **Jira tools**: Use `mcp__personal-jira__*` for all Jira operations
- **Board type**: Kanban
- **Knowledge layer**: chat-recall with `project="switchboard"`
- **NEVER use `mcp__team-knowledge__*` tools** — those are for Cadence Labs only

### Ticket Types
- **Epic**: Decomposition container — decomposes into Tasks
- **Task**: Unit of work — one agent, one deliverable, explicit file list
- **Bug**: Something broken found during work
- **Request**: Out-of-scope observation — "I noticed this but it's not my task." Agent creates it, does NOT act on it

### Orchestration Workflow
This project uses the spec → Jira decomposition → agent execution pattern:
1. **Spec/Feature** defined (by Eric or orchestrator session)
2. **Epic** created in Jira, decomposed into **Tasks**
3. Each Task specifies: objective, files to modify, files to read, acceptance criteria, verification command
4. **Agents execute Tasks** in isolated sessions — each agent only knows its own Task
5. **Nightshift gates completion** — tests must pass before agent can finish
6. No two Tasks should share files to modify (read-only overlap is fine)

## Agent Instructions

- Read existing code before modifying it.
- Run `pnpm test` before declaring work complete.
- Do not add features beyond what was asked.
- If tests fail, fix them — the Nightshift stop hook blocks on failure (exit code 2).
- When creating orchestration Tasks, specify files to modify explicitly — no two Tasks share files.
- If you discover out-of-scope work, create a **Request** ticket — do NOT act on it.
