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
- 2026-08-01 — The purple-chrome migration LANDED with the workstation (T11): tab
  drag-over indicator, StatusBar/TaskSidebar count badges (now outlined zinc: bg
  `#151518`, 1px `#27272A`, text `#E4E4E7`), restart button, focused-pane border,
  divider drag highlight, dialog selection bars, non-destructive confirm button
  (white), and KB pin badges/counters are all white/zinc. `#A78BFA` survives ONLY
  inside the terminal theme (cursor, ANSI magenta, selection tint) and as the
  default repo-identity fallback; functional colors (statusConfig, waiting badge,
  task category/priority) untouched.
