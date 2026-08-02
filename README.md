# Switchboard

A terminal multiplexer for AI coding agents. Manage multiple PTY sessions in a tabbed, split-pane interface with real-time status detection, task tracking, and workspace persistence.

Built with Tauri v2, React 18, TypeScript, and xterm.js.

## Features

- **Tabbed terminal sessions** with per-tab PTY processes
- **Split panes** — horizontal and vertical splits with resizable dividers
- **Agent status detection** — automatically detects running, waiting (needs approval), done, and error states from terminal output
- **Persistent notifications** — background tabs that need input show a sticky toast until you respond
- **Task sidebar** — auto-detects build errors, test failures, and git conflicts; also supports manual notes
- **Workspace persistence** — sessions, tabs, pane layout, and scrollback restored on restart
- **Sleep/wake recovery** — native Win32 power event detection preserves sessions through sleep cycles, with JS heartbeat fallback
- **Session restart** — restart exited sessions in-place with a single click
- **Auto-update** — checks for updates on startup via GitHub Releases
- **Repo-aware sessions** — configure repos to get color-coded tabs and quick-launch via Ctrl+T
- **Terminal search** — Ctrl+F in-terminal search powered by xterm.js addon-search
- **Clipboard integration** — Ctrl+V paste works with Wispr Flow and other tools that simulate keystrokes
- **Keyboard-driven** — full shortcut set for tab/pane management

## Keyboard Shortcuts

The full set, as bound in `src/hooks/useKeyboardShortcuts.ts` (the source of truth).

| Shortcut | Action |
|---|---|
| Ctrl+T | New session |
| Ctrl+W | Close tab + session |
| Ctrl+Shift+W | Close pane only (keep session) |
| Ctrl+[ / Ctrl+] | Previous / next tab |
| Ctrl+Shift+[ / Ctrl+Shift+] | Move the active tab left / right |
| Ctrl+1-9 | Jump to tab by index |
| Ctrl+B | Cycle task sidebar (full → collapsed → hidden) |
| Ctrl+Shift+B | Toggle the side menu (navigator: threads, KB tree, explorer tree) |
| Ctrl+Shift+P | Toggle the artifact panel for the active tab |
| Ctrl+Shift+M | Toggle the composer on the focused pane |
| Ctrl+Shift+O | Toggle the floating picture-in-picture terminal window |
| Ctrl+Shift+S | Export the active session's scrollback to a file |
| Ctrl+F | Terminal search |
| Ctrl+\ | Split horizontal |
| Ctrl+- | Split vertical |
| Ctrl+Alt+Arrow | Move focus between panes |
| F5 or Ctrl+Shift+R | Reload the app window |
| Ctrl+C | Copy selection — or send SIGINT when nothing is selected |
| Ctrl+V | Paste into the terminal (also handled at the OS level for simulated keystrokes) |

Ctrl+Shift+P is a true toggle: it closes an open panel and reopens the last artifact
that tab showed. It does nothing on a tab that has never had one — the status-bar
`Ctrl+Shift+P panel` hint appears only when the chord would actually do something.

The **composer** is the prose input at the bottom of a terminal pane: Enter sends,
Shift+Enter makes a newline, ↑/↓ walk recent sends. It appears by itself on a pane whose
session is holding a live claude conversation; Ctrl+Shift+M (or the `×` on the box)
hides it, and the same chord forces one onto a plain shell. It sends prose only —
Ctrl+C, Esc and arrow-key TUI navigation still belong to the terminal, so click into it
for those (Esc from the composer hands focus back).

Not a keyboard chord, but the other half of the panel: **Ctrl+click** a side-menu tree
row to invert the open behavior — from the terminal screen a plain click opens in the
panel and Ctrl+click opens full width; on the KB/Explorer screens it's the reverse.

## Status Indicators

Each tab shows a colored dot reflecting the session state:

- **Blue (pulsing)** — Running: actively producing output
- **Yellow (pulsing)** — Waiting: needs approval or input (y/n prompt, permission request)
- **Green** — Done: output finished, ready for next command
- **Red** — Error: error detected in output
- **Gray** — Exited: process ended

## Development

### Prerequisites

- Node.js (v22+)
- pnpm
- Rust toolchain (stable)
- Visual Studio Build Tools (for MSVC linker on Windows)

### Setup

```bash
pnpm install
```

### Dev

```powershell
# On Windows (sets MSVC env vars automatically):
.\dev.ps1

# Or manually:
pnpm tauri dev
```

### Quick Check (Rust only)

```powershell
.\build.ps1
```

### Production Build

```powershell
.\build.ps1 -Full
```

Produces an NSIS installer at `src-tauri/target/release/bundle/nsis/`. Installs to `%LOCALAPPDATA%` (no admin required).

### Releasing

See [RELEASE.md](RELEASE.md) for the full release process (signing keys, GitHub Actions, version bumping).

## Architecture

```
src/                    # React frontend
  App.tsx               # Root component, wires hooks + components
  components/           # TabBar, TerminalPane, PaneContainer, TaskSidebar, etc.
  hooks/                # useSessions, usePaneLayout, useKeyboardShortcuts, etc.
  lib/                  # terminal.ts, statusDetector.ts, taskDetector.ts, paneLayout.ts
src-tauri/              # Rust backend
  src/lib.rs            # Tauri commands, plugin registration, setup
  src/pty/              # PTY session management (portable-pty)
  src/power.rs          # Win32 sleep/wake detection (WM_POWERBROADCAST)
  src/config.rs         # User config loading
```

Terminal instances are stored in a module-level Map outside React state to avoid re-renders. PTY output is base64-encoded and sent over Tauri events per session. The pane layout is an immutable binary tree of leaves and branches.

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite
- **Terminal**: xterm.js v5 (with WebGL, search, fit addons)
- **Desktop**: Tauri v2
- **PTY**: portable-pty 0.8.1
- **Font**: JetBrains Mono (bundled)
- **Installer**: NSIS (Windows)
- **Auto-update**: tauri-plugin-updater via GitHub Releases
