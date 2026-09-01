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
- 2026-08-02 — The PANEL IS A DISTINCT SURFACE within the SAME zinc ramp (Eric,
  driving the shipped panel): terminal side `--bg-primary` #0C0C0E, panel
  `--bg-panel` #1A1A1D, plus a 1px `--border-subtle` #27272A left edge inside the
  4px divider. That step is the whole move — never a new hue, never tinted text,
  never a status color. The panel's tab strip, header and body are ONE surface: its
  viewers (DocView, FileViewer, WireframeView letterbox, DiagramView canvas) paint
  `transparent` and take their host's value, so the same doc reads #1A1A1D in the
  panel and #0C0C0E full-width. Anything painting `--bg-primary` inside the panel is
  a bug — it punches a terminal-colored hole in it. Mock it as two flat values with a
  hard edge; do NOT reach for a shadow or a gradient to sell the difference.
- 2026-08-02 — MEASURE A SURFACE STEP, don't eyeball the hex. The panel first shipped
  at `--bg-elevated` #0F0F11, which is 3/255 per channel from the terminal —
  **1.021:1**, invisible, and acceptance 6 was really being carried by the divider
  (and in overlay mode, where there IS no divider, by one hairline). A surface
  intended to read as DIFFERENT needs ~**1.10–1.25:1** WCAG relative luminance in
  this dark ramp; #1A1A1D lands at 1.126:1. Quote the ratio in design-state.md
  whenever a new surface value is introduced.
- 2026-08-02 — When a surface moves up the ramp, RE-TONE what sits on it. Raising the
  panel put `--bg-active` #151518 BELOW it, so the panel's tab strip flipped to the
  IDE reading: inactive tab recessed to `--bg-primary` (the terminal value = "not
  this document"), hover `--bg-active`, ACTIVE tab = the panel surface itself,
  continuous with the body beneath it. Existing tokens only — a new surface value is
  not a licence to invent tab colors.
- 2026-08-02 — REAL FOLDER AND FILE ICONS, drawn as inline SVG (Eric, driving the
  app: "the icons you're using for the folders are misaligned … we should actually
  just use a folder icon and then a file icon instead of a dot for each file"). This
  SUPERSEDES the same day's earlier "no emoji, no icon font, no SVG, ever" rule for
  folder/file/panel marks, for two reasons. (1) SEMANTICS: unicode geometric shapes
  cannot say "folder" or "document" at 9-11px — `◧ ◆ ◈ ◇ ▪ ▫ ■` are all "a small
  filled shape", which is precisely why they read as dots; every IDE uses vector
  icons for exactly this reason. (2) ALIGNMENT: identical advance is not identical
  ink. Measured in JetBrains Mono (1000 upem, advance 600 for all of them), `◧`/`■`
  fill x 0…600 of the cell, `◆ ◈ ◇` overhang at -10…610, and `▪`/`▫` are a 300-unit
  mark at x 150…450 — so a code file's mark started a quarter-cell right of its
  parent folder's and was half the size, a drift living INSIDE the font that no slot
  arithmetic could reach. Icons live in ONE module (`src/components/icons.tsx`),
  hand-written paths on a 16x16 viewBox centred on (8,8), `currentColor`, no
  dependency. EMOJI AND ICON FONTS REMAIN BANNED; unicode is still right for
  everything that is text (`×`, `›`, `/`, `>_`).
- 2026-08-02 — ONE file icon, not one per kind. Kind-aware file glyphs are gone: the
  distinction was never legible at 12px and it was the thing being read as dots. The
  `+` picker still names the kind in TEXT (its meta column), which is where it works.
  Folders DO take two variants — closed and open, following the row's expander — the
  way every IDE draws them.
- 2026-08-02 — `◧` MOVED TO THE PANEL, as Eric suggested ("the icon used for a folder
  should probably be for the panel"): the tab bar's panel button is a frame with its
  RIGHT portion filled, now drawn as SVG. It sits at the RIGHT END of the tab bar as
  the wordmark's counterpart (wordmark = side menu at the left end, panel button =
  artifact panel at the right end). Active treatment is `--bg-active` + `--text-primary`
  — soft palette, no new hue.
- 2026-08-02 — A PANEL BUTTON ON AN EMPTY PANEL OPENS THE PICKER, it does not toggle
  nothing. Same rule as the StatusBar chip's visibility gate and the `>_` affordance's
  registration: never ship a control whose press is invisible. Panel open or
  remembered → toggle (exactly Ctrl+Shift+P); nothing ever opened on this tab → the
  `+` picker, which is what "open the panel" actually means from a cold start.
- 2026-08-02 — ICON SLOTS ARE FIXED-WIDTH BOXES WITH CENTRED CONTENT, never
  auto-width marks: `[9px expander][2px][12px icon]` = a 23px gutter at every depth,
  present whether or not the row has an expander. That, plus `lineHeight: 0` on the
  gutter, is what makes a file row's icon land on the same x as its sibling folder's
  at depth 0 and depth 5 without changing the row height.
- 2026-08-02 — VERIFY BEFORE YOU TRUST, whichever medium you are in. For text: `▣`
  U+25A3 looked like the obvious folder mark and is simply ABSENT from JetBrains Mono
  — it would have fallen back to another typeface at another advance width. For
  vectors: draw the path, RASTERISE it, and look at it before shipping; a hand-written
  16x16 path is easy to get subtly wrong and nothing in the type system catches a
  folder that reads as a box. "It's in the Geometric Shapes block" and "the path looks
  right in my head" are the same non-evidence.
- 2026-08-30 — ONE COACHING PLATFORM, not Lodestar-inside-Switchboard (Eric, on the
  5c/5d build): the TAB BAR RETIRES — a thread IS the screen (Ky's model); the 44px bar
  keeps its height and becomes wordmark · breadcrumb · right actions. The side menu is
  THREE BANDS: destinations on top (Home / Trading / Research ▸ / Knowledge base ▸),
  THREADS GROUPED BY PROJECT in the middle (live pinned first per group, a `shells`
  group for un-promoted Ctrl+T shells), Explorer COLLAPSED at the bottom (the SWIT-31
  Projects tree, folded). ONE terminal per thread — splits retire; open another thread.
  Home = placeholder (live threads, thread→thread updates, listening servers, a
  reserved status-reports box). Trading is FULL-WIDTH (ambient thread beside it = v2).
  Research pages + KB docs open BESIDE the active thread (left/right pane). Thread→thread
  updates/requests are in (grafted from Ky), delivered through the existing typed-line
  seam. "Lodestar" stops being a nav word — repo/backend name and thread suffix only.
  Mock: features/platform-evolution/wireframes/shell-v1-coaching.html.
- 2026-08-31 — THE PAGE, THREE TABS, AND VIEWS (Eric, adopting Ky's session spine
  write-up): every thread's panel opens on a ✦ PAGE tab that cannot close — theme ·
  needs you · to do · what happened · evidence · questions, in that order, written by
  the agent through fixed operations, never as a document. ONLY THREE THINGS OPEN A
  TAB: a question from the agent (`?` tab, closes on answer), a clicked link (ONE
  preview tab per thread, italic, replaced by the next plain click; Ctrl+click /
  double-click keeps), and a VIEW the agent was asked for. A VIEW is a declaration the
  shell renders with the SAME chart components as Trading/Research (candles · table ·
  dist switch in its toolbar; source + built-at + `spec ▸`; `keep` / `re-run`), never
  agent-written code; every row/bar is an anchor so pins land on it. Home is the ROLL-UP
  of every page's needs-you (+ live now · between threads · listening · kept views) and
  grows no sections of its own. Row chips: `?` = agent waiting on you, `↓ N` = unread
  cross-thread posts, a 6px white dot = changed since you last looked. Mock:
  features/coaching-platform/wireframes/shell-v2.html; spec: requirements.md beside it.
- 2026-09-01 — NO HELPER/NARRATION COPY IN THE UI (Eric, on the first live question
  tab: "why do we need this narration in the actual UI?"). If a sentence explains the
  mechanism ("the answer lands on the page and goes to the agent…", "the agent writes
  this page as it works…"), it belongs in the spec, or at most in a control's native
  `title`. A surface states the thing and its one action; outcome states are one plain
  line, never a bordered note.
- 2026-09-01 — ONE VISUAL VOCABULARY, `design/wireframe-kit/components.md`; NO
  PER-SURFACE BOXES (Eric: "why are there all these different boxes?"). Band header,
  list row, button (primary / quiet / icon / text), input + textarea, chip, the
  question block, the page sections, the tooltip — borrowed from Ky's desktop
  components in our tokens. A row is the click target (no pill inside a row), boxes
  are earned, and a shape the kit lacks is added to the kit before it is drawn.
