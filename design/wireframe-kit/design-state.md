# Switchboard — Design State

Generated 2026-07-31, regenerated 2026-08-01 (soft-palette chrome migration),
regenerated 2026-08-02 (increment B: panel surface + tree glyphs), regenerated
2026-08-02 (SVG icon set + tab-bar panel button) from repo code. Regenerate when `src/styles/global.css`, `src/lib/statusConfig.ts`, or
the chrome components change (see README).

## Tokens (src/styles/global.css:33-52)

| Token | Value | Use |
|---|---|---|
| `--bg-primary` | `#0C0C0E` | app background, **terminal side** |
| `--bg-secondary` | `#0A0A0B` | tab bar, status bar, sidebars, side menu |
| `--bg-elevated` | `#0F0F11` | cards, dialogs |
| `--bg-panel` | `#1A1A1D` | **artifact panel surface** (2026-08-02) — 1.126:1 vs `--bg-primary` |
| `--bg-active` | `#151518` | active tab / hover / selected row |
| `--border` | `#1E1E22` | primary hairlines |
| `--border-subtle` | `#27272A` | inner dividers, scrollbar thumb, **panel left edge** |
| `--text-primary` | `#E4E4E7` | main text |
| `--text-secondary` | `#A1A1AA` | secondary text, tree row label |
| `--text-muted` | `#71717A` | muted labels, **tree kind icon** |
| `--text-dim` | `#52525B` | dim/meta, **tree expander chevron** |
| `--text-faint` | `#3F3F46` | faintest (idle icon, panel header icon, picker row icon) |
| `--accent-purple` | `#A78BFA` | terminal theme only (cursor, ANSI magenta, selection tint) + repo-identity fallback (SessionHeader, `explorer.DEFAULT_REPO_COLOR`) — chrome demoted to white/zinc 2026-08-01 |
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

## Surfaces — terminal vs panel (2026-08-02)

The two halves of the terminal screen are DIFFERENT surface values in the same
zinc ramp. No new hue, no tinted text, no status colour involved.

| Half | Value | vs `#0C0C0E` | Source |
|---|---|---|---|
| Terminal side (pane tree, xterm) | `--bg-primary` `#0C0C0E` | — | terminal.ts, App.tsx root |
| Divider between them | 4px `--border` `#1E1E22` (drag: `#E4E4E766`) | 1.176:1 | ArtifactPanel.tsx PanelDivider |
| Panel left edge | 1px `--border-subtle` `#27272A`, docked AND overlay | 1.365:1 | ArtifactPanel.tsx:aside |
| Artifact panel (strip + header + body) | `--bg-panel` `#1A1A1D` | **1.126:1** | ArtifactPanel.tsx `PANEL_SURFACE` |

Ratios are WCAG relative luminance. The first pass used `--bg-elevated`
`#0F0F11` — 3/255 per channel, **1.021:1**, i.e. invisible: acceptance 6 was
being carried entirely by the divider, and in OVERLAY mode (no divider) by a
single hairline. `#1A1A1D` is a difference you see without looking for it and
still sits below `--border` `#1E1E22`, so the 4px divider keeps reading
against the panel side too.

The panel is ONE surface top to bottom — its viewers (DocView scroller,
FileViewer `<pre>`, WireframeView letterbox, DiagramView canvas) paint
`transparent` so they take whichever host renders them: `#1A1A1D` in the
panel, `#0C0C0E` on the full-width KB/Explorer screens. Anything painting
`--bg-primary` inside the panel punches a terminal-coloured hole in it.

Panel tab ramp (raised with the surface; existing tokens only):

| Tab state | Value | vs the strip `#1A1A1D` |
|---|---|---|
| inactive | `--bg-primary` `#0C0C0E` — the terminal value, i.e. "not this document" | 1.126:1 |
| hover | `--bg-active` `#151518` | 1.050:1 |
| active | the panel surface itself (transparent), continuous with the body + inset 2px `--text-muted` + weight 600 | — |

Content verified on the new surface: `.kb-doc pre/code` keep `--bg-active`
`#151518` (1.050:1 as a fill — carried by their 1px `--border-subtle` border
at 1.166:1); `--text-secondary` body text reads 6.78:1, `--text-primary`
13.68:1, `--text-muted` 3.59:1; WireframeView's frame box is fully covered by
its iframe at every zoom (`width/height: 100/zoom%` + `scale(zoom)`, own
`#FFFFFF` background) so the letterbox value is never actually visible;
DiagramView runs mermaid `theme: "base"`, whose nodes carry their own fills.

## Chrome dimensions (from component inline styles)

| Surface | Facts | Source |
|---|---|---|
| Tab bar | h 44px, bg `#0A0A0B`, border-bottom `#1E1E22`, tab pad `0 14px`, title 12.5px, waiting badge 10px `#F59E0B` pill `1px 5px`, group divider 1px `#27272A`, active-tab top border = status color, drag-over insert line 2px `--text-primary` | TabBar.tsx |
| Tab-bar panel button | RIGHT end, cell pad `0 10px` + 1px `#1E1E22` left border; button 24x24, radius 4, 14px `panel` icon; idle `#71717A` on transparent, hover `--text-primary` on `--bg-elevated`, **panel open = `--text-primary` on `--bg-active`** | TabBar.tsx PanelButton |
| Status bar | h 26px, bg `#0A0A0B`, font 10px, count badge 9px outlined zinc (bg `#151518`, 1px `#27272A`, text `#E4E4E7`) | StatusBar.tsx:25-84 |
| Side menu | w 218px, bg `#0A0A0B`, border-right 1px `#1E1E22`, section label 9.5px uppercase `--text-dim`, rows 11.5px | SideMenu.tsx:57-68 |
| Tree row | pad `4px 10px 4px (12 + depth*10)px`, gap 6, active = `#151518` + inset 2px `--text-primary` | KbTreeSection.tsx TreeRow |
| Tree gutter | **23px slot: 9px expander chevron (`--text-dim`) + 2px gap + 12px kind icon (`--text-muted`)**, both fixed-width boxes, contents centred, `lineHeight: 0` and the 12px icon is under the 11.5px label's 15.2px line box (JetBrains Mono 1.32em), so row height is unchanged | KbTreeSection.tsx GUTTER_STYLE |
| Artifact panel | default w 420px, min 260px, max 960px, min terminal 320px, overlay below 880px container, divider 4px | panelStore.ts:55-92 |
| Panel tab strip | h 24px, bg `#1A1A1D`, tab max-w 150px, 10.5px, active = surface + inset 2px `--text-muted` + weight 600, `+` button 24px | ArtifactPanel.tsx TabStrip |
| Panel header | h 36px, 11.5px, border-bottom `#1E1E22`, 12px kind icon `--text-faint`, actions `--text-dim` → `--text-primary` on hover | ArtifactPanel.tsx HEAD_STYLE |
| Picker row | pad `5px 12px`, gap 8, 12px icon slot `--text-faint`, label 11.5px, meta 9.5px `--text-dim` | ArtifactPicker.tsx |
| Task sidebar | full 280px / collapsed 38px / hidden (right side) | TaskSidebar.tsx:68,139 |
| Scrollbars | 5px, thumb `#27272A`, hover `#3F3F46` | global.css:84-99 |
| Terminal | xterm.js, bg `--bg-primary` | terminal.ts |

## Icons (src/components/icons.tsx — the only icon module)

Hand-written inline SVG, one 16x16 viewBox, ink centred on (8, 8), stroked in
`currentColor` so the caller owns the colour. No dependency, no icon font, no
sprite, no emoji. Names are exported from `panelStore` (`FILE_ICON`,
`FOLDER_ICON`, `FOLDER_OPEN_ICON`, `PANEL_ICON`, `folderIcon(open)`,
`describeArtifact().icon`) so the trees, the `+` picker, the panel header and
the tab-bar button all speak one vocabulary; `Record<IconName, ReactNode>`
makes a name with no drawing a type error.

| Name | Shape | Used by |
|---|---|---|
| `folder` | closed folder, tab left | collapsed directory / project rows (both trees), picker project + dir rows |
| `folder-open` | back panel + swung-down front face | expanded directory / project rows |
| `file` | document, folded top-right corner | EVERY file row (both trees), picker kb + file rows, panel header for kb-doc and repo-file |
| `panel` | frame with its RIGHT portion filled | tab-bar panel button |
| `localhost` | globe | panel header, `localhost` artifact kind (phase B) |
| `chevron-right` / `chevron-down` | expander | tree rows, 9px |

Sizes: `ICON_SIZE` 12 (content), `EXPANDER_SIZE` 9 (chevron), 14 for the
tab-bar button. Stroke 1.4 viewBox units (2 for chevrons).

**One file icon for every kind, on purpose.** Kind-awareness (`◆ ◈ ◇ ▪ ▫ ■`
by `docKind`) is gone — see the 2026-08-02 conventions entry. The picker still
prints `docKind` as TEXT in its meta column, which is where it was ever
legible.

**Alignment is structural, not optical tuning.** Each slot is a fixed-width
flex box with a centred SVG: `[9px expander][2px][12px icon]` = 23px at every
depth, whether or not the row has an expander, so a file's icon lands on the
same x as its sibling folder's at depth 0 and depth 5 alike. This is what the
old text glyphs could not do — measured against the bundled JetBrains Mono
(1000 upem, advance 600 for all of them), the INK inside that identical cell
sat at different offsets: `◧`/`■` filled x 0…600, `◆ ◈ ◇` overhung at
-10…610, and `▪`/`▫` were a 300-unit mark at x 150…450, i.e. a quarter-cell
(2.25px at 9px) to the right of its parent folder's left edge and half the
size. The `▸` expander compounded it, overflowing its 5px slot with ink out
to 6.9px.

## Structural model (today)

Top tab bar → optional LEFT side menu (Ctrl+Shift+B: threads + inline KB +
Explorer trees; it is THE navigator) → center screen area (route-switched:
terminal workspace / KB / Explorer) → optional RIGHT task sidebar (terminal
screen only) → bottom status bar.

The terminal screen's workspace is itself `[pane tree | 4px divider |
artifact panel]`, nested INSIDE the screen so the task sidebar stays outside
the panel's geometry.
