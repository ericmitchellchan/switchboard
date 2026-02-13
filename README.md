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
- **Repo-aware sessions** — configure repos to get color-coded tabs and quick-launch via Ctrl+T
- **Terminal search** — Ctrl+F in-terminal search powered by xterm.js addon-search
- **Clipboard integration** — Ctrl+V paste works with Wispr Flow and other tools that simulate keystrokes
- **Keyboard-driven** — full shortcut set for tab/pane management

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+T | New session |
| Ctrl+W | Close tab + session |
| Ctrl+Shift+W | Close pane only (keep session) |
| Ctrl+[ / Ctrl+] | Previous / next tab |
| Ctrl+1-9 | Jump to tab by index |
| Ctrl+B | Toggle task sidebar |
| Ctrl+F | Terminal search |
| Ctrl+\ | Split horizontal |
| Ctrl+- | Split vertical |
| Ctrl+Alt+Arrow | Move focus between panes |

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

### Build

```powershell
.\build.ps1
```

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite
- **Terminal**: xterm.js v5 (with WebGL, search, fit addons)
- **Desktop**: Tauri v2
- **PTY**: portable-pty 0.8.1
- **Font**: JetBrains Mono (bundled)
