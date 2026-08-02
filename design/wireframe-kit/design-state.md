# Switchboard — Design State

Generated 2026-07-31, regenerated 2026-08-01 (soft-palette chrome migration),
regenerated 2026-08-02 (increment B: panel surface + tree glyphs) from repo
code. Regenerate when `src/styles/global.css`, `src/lib/statusConfig.ts`, or
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
| `--text-muted` | `#71717A` | muted labels, **tree kind glyph** |
| `--text-dim` | `#52525B` | dim/meta, **tree expander** |
| `--text-faint` | `#3F3F46` | faintest (idle icon, panel header glyph) |
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
| Tab bar | h 44px, bg `#0A0A0B`, border-bottom `#1E1E22`, tab pad `0 14px`, title 12.5px, waiting badge 10px `#F59E0B` pill `1px 5px`, group divider 1px `#27272A`, active-tab top border = status color, drag-over insert line 2px `--text-primary` | TabBar.tsx:104-141,247 |
| Status bar | h 26px, bg `#0A0A0B`, font 10px, count badge 9px outlined zinc (bg `#151518`, 1px `#27272A`, text `#E4E4E7`) | StatusBar.tsx:25-84 |
| Side menu | w 218px, bg `#0A0A0B`, border-right 1px `#1E1E22`, section label 9.5px uppercase `--text-dim`, rows 11.5px | SideMenu.tsx:57-68 |
| Tree row | pad `4px 10px 4px (12 + depth*10)px`, gap 6, active = `#151518` + inset 2px `--text-primary` | KbTreeSection.tsx TreeRow |
| Tree gutter | 14px slot: 5px expander (`▸`/`▾`, 9px, `--text-dim`) + 3px gap + kind glyph (9px, `--text-muted`) | KbTreeSection.tsx GUTTER_STYLE |
| Artifact panel | default w 420px, min 260px, max 960px, min terminal 320px, overlay below 880px container, divider 4px | panelStore.ts:55-92 |
| Panel tab strip | h 24px, bg `#1A1A1D`, tab max-w 150px, 10.5px, active = surface + inset 2px `--text-muted` + weight 600, `+` button 24px | ArtifactPanel.tsx TabStrip |
| Panel header | h 36px, 11.5px, border-bottom `#1E1E22`, glyph `--text-faint`, actions `--text-dim` → `--text-primary` on hover | ArtifactPanel.tsx HEAD_STYLE |
| Task sidebar | full 280px / collapsed 38px / hidden (right side) | TaskSidebar.tsx:68,139 |
| Scrollbars | 5px, thumb `#27272A`, hover `#3F3F46` | global.css:84-99 |
| Terminal | xterm.js, bg `--bg-primary` | terminal.ts |

## Tree glyphs (src/lib/panelStore.ts — single source of truth)

Folder and file rows are visually distinct in BOTH side-menu trees. The
vocabulary is shared with the panel header and the `+` picker: the anchors are
read out of `describeArtifact`, and the file split comes from `kb.docKind` —
the same switch DocView routes on.

| Row | Glyph | Codepoint | Meaning |
|---|---|---|---|
| folder / project root | `◧` | U+25E7 | `FOLDER_GLYPH` — a box with a spine (drawer) |
| markdown | `◆` | U+25C6 | `describeArtifact` kb-doc glyph |
| wireframe (`.html`) | `◈` | U+25C8 | renders in a sandboxed iframe |
| diagram (`.mmd`) | `◇` | U+25C7 | renders via mermaid |
| code (`.tsx`/`.jsx`) | `▪` | U+25AA | raw text, source |
| data (`.json`) | `▫` | U+25AB | raw text, data |
| anything else | `■` | U+25A0 | `describeArtifact` repo-file glyph |

Diamonds = documents that render; squares = raw text; `◧` = container.
Expander `▸`/`▾` (U+25B8/U+25BE) stays on directory rows in addition to the
folder glyph; file rows keep a blank 5px expander slot so their names line up
under their sibling folders'.

**Font coverage is verified, not assumed.** All nine codepoints were
cmap-checked against all four bundled weights of
`src/assets/fonts/JetBrainsMono-*.woff2` on 2026-08-02: present in every
weight, advance 600/1000 in every weight (exactly one mono cell). Being in
the Geometric Shapes block is NOT evidence — `▣` U+25A3, the obvious folder
glyph, is MISSING from the font and would have fallen back to another
typeface at another width. `MONO_SAFE_CODEPOINTS` in `panelStore.test.ts` is
the regression guard.

## Structural model (today)

Top tab bar → optional LEFT side menu (Ctrl+Shift+B: threads + inline KB +
Explorer trees; it is THE navigator) → center screen area (route-switched:
terminal workspace / KB / Explorer) → optional RIGHT task sidebar (terminal
screen only) → bottom status bar.

The terminal screen's workspace is itself `[pane tree | 4px divider |
artifact panel]`, nested INSIDE the screen so the task sidebar stays outside
the panel's geometry.
