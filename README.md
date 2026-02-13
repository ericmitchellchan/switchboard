# Switchboard

A terminal manager built with Tauri v2, React 18, and xterm.js. Designed for running multiple AI coding agents (Claude Code, Cursor, etc.) side by side with status detection, task tracking, and workspace persistence.

## Features

- **Tabbed terminal sessions** with split panes (horizontal/vertical binary tree layout)
- **Agent status detection** — automatically detects running/waiting/idle/error/exited states from PTY output
- **Toast notifications** when a background session needs your input
- **Task sidebar** with auto-detection of build errors, test failures, and git conflicts
- **Workspace persistence** — sessions, pane layout, and terminal scrollback survive app restarts
- **Clipboard integration** — Ctrl+C copies selected text, Ctrl+V pastes (including Wispr Flow support via global shortcut)
- **Terminal search** (Ctrl+F) with xterm.js search addon
- **Repo-aware sessions** — configure repos in `switchboard.toml` for quick project switching
- **WebGL rendering** with automatic fallback

## Prerequisites

- **Node.js** v22+ (ARM64 or x64)
- **pnpm** (`npm install -g pnpm`)
- **Rust** stable toolchain via rustup
- **Visual Studio Build Tools** (MSVC linker + Windows SDK)

## Getting Started

```powershell
# Install dependencies
pnpm install

# Run in development mode (sets up MSVC environment automatically)
.\dev.ps1

# Rust compile check only
.\build.ps1
```

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+T | New tab |
| Ctrl+W | Close tab and session |
| Ctrl+Shift+W | Close pane only (keep session) |
| Ctrl+[ / Ctrl+] | Previous / next tab |
| Ctrl+1-9 | Jump to tab by index |
| Ctrl+B | Toggle task sidebar |
| Ctrl+F | Search in terminal |
| Ctrl+\\ | Split pane horizontally (side by side) |
| Ctrl+- | Split pane vertically (stacked) |
| Ctrl+Alt+Arrow | Move focus between panes |
| Ctrl+C | Copy selection, or SIGINT if no selection |
| Ctrl+V | Paste from clipboard |

## Project Structure

```
src/                    # React frontend
  App.tsx               # Root component
  types.ts              # TypeScript interfaces
  components/           # UI components (TabBar, TerminalPane, StatusBar, etc.)
  hooks/                # React hooks (useSessions, usePaneLayout, useTasks, etc.)
  lib/                  # Core logic (terminal, IPC, status/task detection, workspace)
src-tauri/              # Rust backend
  src/lib.rs            # Tauri commands (session management, scrollback persistence)
  src/pty/              # PTY session management (ConPTY on Windows)
  src/config.rs         # Config loading from switchboard.toml
```

## Configuration

Create a `switchboard.toml` in the app's config directory to define repos:

```toml
shell = "powershell.exe"

[[repos]]
path = "C:\\Users\\you\\projects\\my-app"
color = "#60A5FA"
group = "work"
```

## Tech Stack

- **Tauri v2** — native window, IPC, system access
- **React 18** — UI rendering
- **xterm.js v5** — terminal emulation (WebGL, search, serialize, fit addons)
- **portable-pty 0.8.1** — PTY management (ConPTY on Windows)
- **Vite** — frontend bundler
- **TypeScript** — type safety throughout
