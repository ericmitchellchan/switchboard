# Switchboard — Design Conventions (living memory)

Append dated one-liners when Eric states a rule or corrects a mock. Delete entries
that stop being true.

- 2026-07-31 — SOFTER PALETTE (Eric, on the workstation shell mock): base is black /
  white / zinc like Ky — color is reserved for FUNCTIONAL status only (statusConfig
  dots, waiting badge). Brand purple is demoted: active indicators, pins, counters,
  and chips use white/zinc emphasis, not color. Applies to all new-surface mocks;
  the app's existing purple chrome (#A78BFA tab underline, StatusBar badges) migrates
  to match when the workstation ships.
- 2026-07-31 — Everything is JetBrains Mono. No second typeface, ever; hierarchy comes
  from size (9-13px range), weight (400-700), and the zinc text ramp.
- 2026-07-31 — True-dark zinc palette only (#0A-#15 backgrounds). No blue-tinted darks,
  no light theme. Purple #A78BFA is the brand accent; status colors are reserved for
  agent status and must not be used decoratively.
- 2026-07-31 — Status dots/labels ALWAYS come from statusConfig.ts values — never
  invent status colors or labels in a mock.
- 2026-07-31 — Match the current app chrome (44px tab bar, 26px status bar) in any
  mock of an existing surface; new surfaces (side menu, KB view) compose from the
  same tokens. Never invent chrome the app doesn't have without flagging it as NEW.
- 2026-07-31 — Density is terminal-grade: small type, 1px hairlines, tight paddings.
  If a mock looks like a web app, it's wrong.
- 2026-07-31 — (from global conventions) Wireframes live in the feature's KB folder
  (personal-kb/switchboard/features/<feature>/wireframes/), one self-contained HTML
  file per surface with inline kit CSS.
- 2026-08-01 — The side menu is THE navigator (Eric, on the running app): sections are
  TREES, not nav items — KNOWLEDGE BASE renders the doc tree inline, EXPLORER renders
  registry projects with IDE-style inline file browsing. Screens render CONTENT only
  (breadcrumb + viewer, full width); no duplicate in-screen rails.
- 2026-08-01 — No intermediate "browse" rows in the side menu (the old "Browse docs" /
  "By repo" items are gone): a section header is followed directly by its tree.
- 2026-08-01 — The SWITCHBOARD wordmark toggles the side menu on click (same action
  as Ctrl+Shift+B). Cursor pointer only — no visual redesign of the wordmark.
- 2026-08-01 — The purple-chrome migration LANDED with the workstation (T11): tab
  drag-over indicator, StatusBar/TaskSidebar count badges (now outlined zinc: bg
  `#151518`, 1px `#27272A`, text `#E4E4E7`), restart button, focused-pane border,
  divider drag highlight, dialog selection bars, non-destructive confirm button
  (white), and KB pin badges/counters are all white/zinc. `#A78BFA` survives ONLY
  inside the terminal theme (cursor, ANSI magenta, selection tint) and as the
  default repo-identity fallback; functional colors (statusConfig, waiting badge,
  task category/priority) untouched.
- 2026-08-02 — The PANEL is the co-present mode; SCREENS stay full-width reading. An
  artifact (KB doc, wireframe, diagram, repo file) opens in a right-hand panel beside
  the live shell — a click from the terminal screen opens the panel, a click from the
  KB/Explorer screen opens full width, and Ctrl+click inverts either. Mock the panel
  as a surface INSIDE the terminal screen (`pane tree | 4px divider | panel`), never
  as a third top-level column beside the task sidebar; below a narrow breakpoint it
  overlays the pane tree rather than crushing it.
- 2026-08-02 — The soft palette holds INSIDE the panel: its chrome (header glyph +
  breadcrumb, the `→ thread` / `open full` / `×` actions, the divider) is white/zinc
  only, same ramp and same 1px hairlines as the rest of the app. Status colors stay
  functional-only — nothing in the panel is colored to decorate it.
- 2026-08-02 — The PANEL IS A DISTINCT SURFACE, one step up the SAME zinc ramp
  (Eric, driving the shipped panel): terminal side `--bg-primary` #0C0C0E, panel
  `--bg-elevated` #0F0F11, plus a 1px `--border-subtle` #27272A left edge inside the
  4px divider. That step is the whole move — never a new hue, never tinted text,
  never a status color. The panel's tab strip, header and body are ONE surface: its
  viewers (DocView, FileViewer, WireframeView letterbox, DiagramView canvas) paint
  `transparent` and take their host's value, so the same doc reads #0F0F11 in the
  panel and #0C0C0E full-width. Anything painting `--bg-primary` inside the panel is
  a bug — it punches a terminal-colored hole in it. Mock it as two flat values with a
  hard edge; do NOT reach for a shadow or a gradient to sell the difference.
- 2026-08-02 — FOLDER vs FILE SYMBOLS in both trees: a directory row is expander +
  `◧`, a file row is a blank expander slot + a kind glyph (`◆` markdown · `◈`
  wireframe · `◇` diagram · `▪` code · `▫` data · `■` anything else). Diamonds =
  documents that render, squares = raw text, `◧` = container. The vocabulary lives in
  `panelStore` and is SHARED with the panel header and the `+` picker — anchors come
  out of `describeArtifact` and the file split out of `kb.docKind`; never write a
  second mapping. Glyphs are 9px `--text-muted` (expander `--text-dim`) so they sit
  below the 11.5px `--text-secondary` label, and they live in a fixed 14px gutter so
  a file's name lines up under its sibling folders'. No emoji, no icon font, no SVG,
  ever.
- 2026-08-02 — VERIFY A GLYPH AGAINST THE BUNDLED FONT before using it. `▣` U+25A3
  looked like the obvious folder mark and is simply ABSENT from JetBrains Mono — it
  would have fallen back to another typeface at another advance width and shifted
  every label on the row. cmap-check new glyphs against all four weights in
  `src/assets/fonts/` (advance must be 600/1000) and add them to
  `MONO_SAFE_CODEPOINTS` in `panelStore.test.ts`. "It's in the Geometric Shapes
  block" is not evidence.
