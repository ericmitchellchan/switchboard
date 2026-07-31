# Switchboard wireframe kit

Four-file kit per the /wireframe skill pattern:

- `design-state.md` — tokens + chrome specs, generated FROM CODE with receipts
- `conventions.md` — living memory of standing design decisions (append, dated)
- `wireframe-starter.html` — validated starter; copy it, don't fork the CSS
- `README.md` — this file

## Workflow

1. Copy `wireframe-starter.html` →
   `personal-kb/switchboard/features/<feature>/wireframes/<surface>.html`
2. Compose screens from the kit classes (`.window .tabbar .sidemenu .content .statusbar`),
   extend via CSS variables only. Self-contained: inline everything, no external refs
   (Switchboard's KB view will render these in a sandboxed iframe, Ky-style).
3. One labeled row per scenario, one `.window` per screen, caption under each,
   build-notes legend at the bottom.
4. When Eric states a design rule, append it to `conventions.md` in the same session.

## Regeneration ritual

When `src/styles/global.css`, `src/lib/statusConfig.ts`, or chrome components
(TabBar/StatusBar/TaskSidebar) change: re-extract tokens + dimensions into
`design-state.md`, update the `BEGIN/END kit css` block in the starter to match,
and stamp both with the date. Ground truth is ALWAYS the repo, never a mock.
