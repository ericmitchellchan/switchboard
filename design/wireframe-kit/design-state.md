# Switchboard — Design State

Generated 2026-07-31 from repo code. Regenerate when `src/styles/global.css`,
`src/lib/statusConfig.ts`, or the chrome components change (see README).

## Tokens (src/styles/global.css:33-52)

| Token | Value | Use |
|---|---|---|
| `--bg-primary` | `#0C0C0E` | app background |
| `--bg-secondary` | `#0A0A0B` | tab bar, status bar, sidebars |
| `--bg-elevated` | `#0F0F11` | cards, dialogs |
| `--bg-active` | `#151518` | active tab / hover / selected row |
| `--border` | `#1E1E22` | primary hairlines |
| `--border-subtle` | `#27272A` | inner dividers, scrollbar thumb |
| `--text-primary` | `#E4E4E7` | main text |
| `--text-secondary` | `#A1A1AA` | secondary text |
| `--text-muted` | `#71717A` | muted labels |
| `--text-dim` | `#52525B` | dim/meta |
| `--text-faint` | `#3F3F46` | faintest (idle icon) |
| `--accent-purple` | `#A78BFA` | brand accent, counters/badges (StatusBar.tsx:84) |
| `--accent-green` | `#34D399` | positive accents |
| `--accent-blue` | `#3B82F6` | running |
| `--accent-blue-light` | `#60A5FA` | links/hover on blue |
| `--accent-yellow` | `#F59E0B` | waiting badge (TabBar.tsx:139) |
| `--accent-red` | `#EF4444` | error |
| `--font-mono` | `'JetBrains Mono', 'Cascadia Code', 'SF Mono', monospace` | ALL text — the app is 100% mono |

Font weights bundled: 400 / 500 / 600 / 700 (global.css:1-31). True-dark, no light theme.

## Agent status system (src/lib/statusConfig.ts — single source of truth)

| Status | Color | Pulse | Icon | Label |
|---|---|---|---|---|
| idle | `#3F3F46` | no | ○ | IDLE |
| running | `#3B82F6` | yes | ⟳ | RUNNING |
| waiting | `#F59E0B` | yes | ◉ | WAITING |
| done | `#10B981` | no | ✔ | DONE |
| error | `#EF4444` | no | ✕ | ERROR |
| exited | `#52525B` | no | ○ | EXITED |

Note `done` uses `#10B981` (statusConfig) — NOT the `--accent-green #34D399` token.
Pulse = `pulse-ring` keyframes (global.css:54-57): expanding fading ring.

## Chrome dimensions (from component inline styles)

| Surface | Facts | Source |
|---|---|---|
| Tab bar | h 44px, bg `#0A0A0B`, border-bottom `#1E1E22`, tab pad `0 14px`, title 12.5px, waiting badge 10px `#F59E0B` pill `1px 5px`, group divider 1px `#27272A` | TabBar.tsx:104-141,247 |
| Status bar | h 26px, bg `#0A0A0B`, font 10px, purple count badges `#A78BFA` 9px | StatusBar.tsx:25-84 |
| Task sidebar | full 280px / collapsed 38px / hidden (right side) | TaskSidebar.tsx:68,139 |
| Scrollbars | 5px, thumb `#27272A`, hover `#3F3F46` | global.css:84-99 |
| Terminal | xterm.js, bg `--bg-primary` | terminal.ts |

## Structural model (today)

Top tab bar → center pane tree (terminals, binary splits) → optional RIGHT task
sidebar → bottom status bar. There is NO left side menu yet — the workstation
feature introduces it (see personal-kb spec personal-workstation).
