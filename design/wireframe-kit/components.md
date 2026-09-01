# Switchboard — Components (2026-09-01, SWIT-57)

The one visual vocabulary. Every surface the shell draws — side-menu bands, the ✦ page,
the question tab, dialogs, pickers — composes from THESE and nothing else; a surface
that needs a shape not listed here adds it HERE first, with its Ky source and its
measurements, then uses it. "Borrow from the Ky platform UI kit while keeping our
terminal flair" (Eric, 2026-09-01): each component names the Ky desktop file it was
lifted from, Ky's measurements, and ours.

Ground rules that apply to every entry (conventions.md has the dated receipts):

- Tokens are `src/styles/global.css` (shell) / `src/styles/surfaces.css` (surfaces).
  No new colour, ever. Status colours come from `statusConfig.ts` and mean status.
- One typeface: `var(--font-mono)` (JetBrains Mono). Hierarchy = size 9–13px, weight
  400–700, the zinc text ramp. Ky's IBM Plex Sans / Newsreader do not come across.
- Square where Ky is round: Ky's `rounded-lg` rows and `rounded-md` buttons become
  radius 0 (rows) / 3 (controls) / 4 (chips) — terminal-grade density, 1px hairlines.
- Ky's `--accent` (mint) hover becomes `--text-primary`. Emphasis is white/zinc.
- Boxes are earned. A row is a row, not a card; a message is a line, not a banner.
  No helper/narration copy in any component — the tooltip and the spec carry it.

Token map used below (Ky name → ours):

| Ky (`ky-desktop/src/styles/global.css`) | Switchboard (`src/styles/global.css`) |
|---|---|
| `--bg` #0a0a0a | `--bg-primary` #0C0C0E (terminal side) / host value inside the panel |
| `--bg-pane` #141414 | `--bg-secondary` #0A0A0B (side menu) / `--bg-panel` #1A1A1D (panel) |
| `--bg-raised` #1a1a1a | `--bg-elevated` #0F0F11 |
| `--bg-hover` #242424 | `--bg-active` #151518 |
| `--line` #2e2e2e | `--border-subtle` #27272A |
| `--line-soft` #1e1e1e | `--border` #1E1E22 |
| `--txt` #ededed | `--text-primary` #E4E4E7 |
| `--txt-dim` #b4b4b4 | `--text-secondary` #A1A1AA |
| `--txt-faint` #888888 | `--text-muted` #71717A (labels) / `--text-dim` #52525B (meta) / `--text-faint` #3F3F46 (idle icon) |
| `--accent` #7dd3a8 | none — `--text-primary` for emphasis and hover |
| `--amber` (needs-input) | `STATUS_CONFIGS.waiting.color` #F59E0B, functional only |
| `--rose` (destructive) | `--accent-red` #EF4444, destructive only |

Surfaces (`.sb-surface`, `src/styles/surfaces.css`) speak Lodestar's names for the
same ramp: `--line` = `--border`, `--surface` = `--bg-elevated`, `--surface2` =
`--bg-active`, `--text` / `--dim` / `--dim2` = primary / secondary / muted.

---

## Band header

The label over a side-menu band or a page section, with its right-end actions.

- **Ky:** `ky/main/Sidebar.tsx` (THREADS header, ~257–284) — `mt-[18px] mb-1.5 px-3`,
  label `font-mono text-[9px] uppercase tracking-[0.16em] text-txt-faint`; actions
  `See all` in the same voice + `+` at `text-[13px] leading-none px-1`, both
  `hover:text-accent`.
- **Ours:** `ThreadsSection.BandHeader`, `SideMenu.SectionLabel`, `PageView.Section`.
  Padding `10px 12px 4px` (side menu) / `0` (page section, the section gap does it).
  Label 9.5px uppercase, `letter-spacing: 1px`, `--text-dim`. Actions: same voice,
  `--text-dim` → `--text-primary` on hover; the count in parentheses `--text-faint`
  with `letter-spacing: 0`; `+` 13px, `line-height: 1`, padding `0 2px`. Right-end
  meta (a count, `earlier (3)`) is `--text-faint`, `text-transform: none`,
  `margin-left: auto`. The 6px NEW dot (below) may sit after the label.
- Clickable labels take `cursor: pointer` and nothing else changes — no underline.

## List row

The one row: side-menu threads, tree rows, picker rows, question options, page items.
The ROW is the click target; nothing inside it is a second button except the reserved
`⋯` slot.

- **Ky:** `ky/main/Sidebar.tsx` `ThreadRow` (~473–540) — a `<button>` `w-full flex
  items-center gap-[7px] pl-7 pr-7 py-1.5 rounded-lg text-[11.5px]`; idle
  `text-txt-faint`, hover `text-txt hover:bg-bg-hover`, active `bg-bg-hover text-txt`;
  6px dot; `flex-1 truncate` title; the `⋯` absolutely at `right-1`, `opacity-0
  group-hover:opacity-100 focus:opacity-100`. `ky/todos/TodoPanel.tsx` rows (~123–130):
  `group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-bg-hover`, hover-only
  action buttons `hidden group-hover:flex`.
- **Ours:** `<button type="button">` (or a `<div>` with the same style while it holds an
  `<input>` — a button may not contain one). `display: flex; align-items: center;
  gap: 8px; width: 100%; padding: 5px 12px` (side-menu rows indent to `padding-left:
  22px`; content rows inside a 14px-padded body use `5px 8px`); no radius, no border,
  no shadow; 11.5px `--text-secondary` (page item rows: 11px); `text-align: left`.
  Hover: `--bg-active` + `--text-primary`. Active/selected: `--bg-active` + `box-shadow:
  inset 2px 0 0 var(--text-primary)`. In a list that is walked with ↑/↓ (the
  question options) keyboard focus draws the SAME bar as active, via focus state —
  never the UA ring. Title `flex: 1; min-width: 0; overflow: hidden; text-overflow:
  ellipsis; white-space: nowrap`.
- Leading glyph column: 8px status dot (`STATUS_CONFIGS[status].color`; dead =
  `exited`), or a 14px text glyph in `--text-dim` (`○ ⟳ ◔ ✓ ?`), fixed width.
- Trailing: a dim suffix 9.5px `--text-dim` (`max-width: 72px`, ellipsis), then chips,
  then the RESERVED 14px `⋯` slot — always in the flow, only `visibility` toggles on
  hover / focus-within / menu-open, so sweeping the list never re-flows a title.
- Dense rows (page items, evidence): `padding: 2px 0`, no hover fill; evidence rows
  carry a 1px `--border` bottom hairline because they are a table without a table.

## Button

Three ranks. One primary per surface; when a second action feels important it is quiet.

- **Ky:** `ky/components/Buttons.tsx` — `PrimaryButton` `px-3 py-1 rounded-md
  bg-accent text-[12px] font-semibold text-[#0f1115] hover:opacity-90
  disabled:opacity-40`; `SecondaryButton` `px-3 py-1 rounded-md border border-txt-dim
  text-[12px] text-txt hover:bg-bg-hover disabled:opacity-40`. Icon buttons:
  `ky/main/Topbar.tsx` (~370–376) `h-7 w-7 rounded-md text-txt-faint hover:bg-bg-hover
  hover:text-txt-dim`; `ky/chat/ChatTerminal.tsx` composer `+` (~1392) `w-7 h-7 rounded
  text-[15px]`.
- **Ours — primary:** `--text-primary` fill, text `#0C0C0E` (the one hardcoded value,
  as Ky's `#0f1115`: on-white text is near-black in any theme), 11px weight 600,
  padding `3px 10px`, radius 3, no border; hover `opacity: .9`; disabled `opacity: .4`.
  The confirm dialog's non-destructive button is this (conventions 2026-08-01).
- **Ours — quiet:** transparent, 1px `--border-subtle`, `--text-secondary`, 11px,
  padding `3px 10px`, radius 3; hover `--text-primary` + border `--text-secondary`;
  disabled `opacity: .4`. Destructive quiet: text + border `--accent-red`.
- **Ours — icon:** 24×24, radius 4, transparent; `--text-muted` → hover `--text-primary`
  on `--bg-elevated`; "on" state `--text-primary` on `--bg-active` (TabBar PanelButton,
  design-state.md). Text glyph 13–14px `line-height: 1`, or a 14px `icons.tsx` SVG.
- **Ours — text link button** (a verb in a header or footer: `See all`, `earlier (3) ▸`,
  `clear done`): no box at all — 9.5–10px `--text-dim` → `--text-primary` on hover,
  padding 0. Ky: `TodoPanel.tsx` `clear done · N` (~95–101).

## Input + textarea

- **Ky:** `ky/todos/TodoPanel.tsx` (~105–117) `w-full bg-bg border border-line-soft
  rounded-md px-2.5 py-1.5 text-[12px] text-txt placeholder:text-txt-faint
  focus:outline-none focus:border-txt-dim`; `ky/chat/ChatTerminal.tsx` composer
  textarea (~1352–1386) `rows={2} bg-bg-pane border border-line-soft rounded px-3 py-2
  text-[12.5px] resize-y min-h-[58px] max-h-[40vh] focus:border-txt-dim`; Sidebar
  rename input (~466) `bg-bg border border-txt-dim rounded px-2 py-1 text-[11.5px]`.
- **Ours:** `background: transparent` (the field takes its host's surface — a
  `--bg-primary` fill inside the panel punches a terminal-coloured hole, conventions
  2026-08-02), 1px `--border-subtle`, radius 3, padding `5px 8px`, 11.5px, `line-height:
  1.5`, `--text-primary`, `outline: none`, focus border `--text-dim` (via focus
  state on the shell's inline-styled fields; `:focus` in surfaces.css). Placeholder
  `--text-faint` where a stylesheet reaches it (surfaces); the shell's inline-styled
  fields take the UA placeholder until a shared class exists. Textarea: `rows={2}`,
  `resize: vertical`.
  Enter sends / Shift+Enter newline where it is a message box (the composer's rule).
  Inline rename: the same field at the row's own size, border `--text-secondary`.
- Surfaces: `.sb-surface input/select/textarea` get this as their BASE (layered under
  Tailwind's utilities so a page's own `px-2 rounded-md` still wins); `select` keeps
  an opaque `--surface` fill because a transparent native popup is unreadable.

## Chip

A small fact after a title: a count, an unread marker, a kind. Never a control unless
it says so (a chip that toggles is a quiet button at chip size).

- **Ky:** `ky/main/Sidebar.tsx` nav count (~409) `text-[9.5px] font-semibold
  text-txt-faint bg-bg-hover px-1.5 py-px rounded-[5px] min-w-[18px] text-center`; the
  `reply` marker (~516) `text-[8.5px] font-mono uppercase tracking-wide text-amber`;
  `ky/components/FilterBar.tsx` toggle chip (~107) `inline-flex gap-1.5 rounded-md
  border px-2 py-0.5`.
- **Ours:** 9px, padding `0 5px`, 1px `--border-subtle`, radius 4, `--text-muted`,
  `white-space: nowrap`, `flex: none`. Outlined zinc, not filled (conventions
  2026-08-01: count badges are bg `#151518` / 1px `#27272A` / text `#E4E4E7` — that is
  this chip in its EMPHASIS form: `--text-primary` on border `--text-secondary`, used
  for `↓ N` unread). FUNCTIONAL chip: a `statusConfig` fill with `#0C0C0E` text weight
  600 and no border — the `?` "agent waiting on you". Nothing else is filled.

## The question block

What the `? question` tab draws (`QuestionView.tsx`): the question · options as a plain
list · one input · one action. Nothing else — no glyph box, no note about where the
answer goes (that is the spec's sentence, `requirements.md` R4).

- **Ky:** `ky/chat/ChatTerminal.tsx` composer + permission strip (~1305–1330): the
  prompt as one line, `✓ Approve ↵` / `✕ Deny esc` as two buttons in a row, the
  textarea below; `ky/todos/TodoPanel.tsx` for the list-of-rows + one input shape.
- **Ours:** body padding `14px`, `gap: 12px`, column. (1) Question: 12.5px
  `--text-primary`, `line-height: 1.5`. (2) Options: the OPTION ROW
  (`components/kb/OptionRow.tsx`, shared with Home's Needs-you block) — one LIST ROW per
  option, 11.5px, padding `5px 8px`, with the 14px leading glyph column drawing a text
  RADIO: `○` in `--text-dim` resting, `●` in `--text-primary` on hover / focus and on
  the option being sent; the option text itself `--text-primary`; `default` after the
  agent's proposal in 9.5px `--text-dim`. The list sits between two 1px `--border`
  hairlines (`padding: 4px 0`) so the choice reads as one block. Keyboard: Tab/↑/↓
  move, Enter, Space or click picks; the focused row draws the active bar + `--bg-active`.
  The row IS the target: no bordered pill, no `<input type=radio>` — the glyph is what
  says "multiple choice" (post-0.5.0: rows with no glyph read as a paragraph).
  (3) A dim `or` line (10px `--text-dim`) then the input: the kit textarea, 2 rows,
  placeholder `type your own…` (`type your answer…` with no options); Enter sends.
  (4) Action: ONE quiet button `answer`, right-aligned under the input, drawn at full
  strength while the box is empty (an empty submit is a no-op; `opacity: .4` made it
  read as absent) and dimmed only while a send is in flight. Outcome states are one
  plain line in `--text-muted` on the SAME row, to the LEFT of the button — the failure
  text, or `saved on the page — no live terminal` — never a bordered note.
- Resolved states (answered / gone) are the same voice centred: the question in
  `--text-secondary` and `you: <answer>` in `--text-primary`; or the one line `This
  question is no longer on the page.`

## The page sections

The ✦ page (`PageView.tsx`): theme · needs you · to do · what happened · evidence ·
questions · done. Every section is a band header + list rows; no section is a box.

- **Ky:** `ky/todos/TodoPanel.tsx` (header + rows + one input), `ky/thread/LedgerPanel.tsx`
  for the ledger's section-then-rows rhythm, `ky/components/InfoNote.tsx` for the rule
  that explanatory prose is never resting on the page.
- **Ours:** body padding `12px 14px`, 11px, `line-height: 1.55`, `--text-secondary`,
  `gap: 14px` between sections. Theme: 12.5px `--text-primary`, no label. Section
  title: the band header at padding 0 with its right-end meta. Rows: the dense list
  row (`padding: 2px 0`) — leading 14px glyph column, title with ellipsis, trailing
  9.5px `--text-dim` owner/status. A question row: `?` glyph in `--text-primary`, the
  text, the options after it as 10px `--text-dim` separated by ` · `. A cross-thread
  post: a 9.5px `--text-dim` origin line (`↓ <thread>`) then the text. What happened:
  the latest turn as plain lines, `earlier (N) ▸` as a text link button. Evidence:
  address `--text-primary` · label `--text-muted` · status `--text-dim`, 1px `--border`
  hairline under each. NEW dot: 6px `--text-primary` circle after the item or title.
- Empty page: the `✦` glyph 14px `--text-muted` over ONE line, `No page yet.` Nothing
  about who writes it or when.
- **Home (`Home.tsx`, post-0.5.0)** is the same shape at screen scale: ONE left-aligned
  column, `max-width: 720px`, padding `18px`, `gap: 18px` between band sections (Needs
  you · Backlog · Live now · Between threads · Listening · Kept views). Section title =
  the band header with its right-end count. Every item is the content-body list row
  (`5px 8px`, 14px glyph column, hover `--bg-active` + `--text-primary`, focus bar,
  9.5px `--text-dim` meta at the right: `open →`, a time, a project). No 2-column grid,
  no card (border + elevated fill), no dashed reserved box: an EMPTY section is one
  dim line in the row's own padding — `nothing needs you`, `no live threads`,
  `nothing in the last hour`, `nothing listening`, `no kept views`, `nothing in the
  backlog`. A question in Needs you is the `?` row followed, indented to the text
  column, by the question block above (option rows between hairlines · `or` · one
  kit input).

## Tooltip

Native `title` for HINTS. The shell has no hint-tooltip component and does not want one.
The ONE styled tooltip is the DATA tooltip below — it prints a row, not a sentence.

- **Ky:** every hint is a `title=` attribute — `ky/main/Topbar.tsx` `"Ask Ky — ambient
  chat (Ctrl/⌘+I)"`, `ky/main/Sidebar.tsx` `"Thread actions"`, `"New thread"`,
  `ky/todos/TodoPanel.tsx` `"Work on it in a thread (spawns a seeded agent thread)"`.
- **Ours:** one clause, present tense, says what the click does; the chord in
  parentheses at the end when there is one (`Toggle the artifact panel (Ctrl+Shift+P)`).
  A tooltip is where a mechanism sentence goes when it must exist in the app at all;
  it never appears as resting text beside the control.

### Data tooltip (views — T7, SWIT-61)

Hovering or focusing a row / bin / bar in a view shows EVERY field of the row behind
it. Not `title`: that one is late, single-line and unstyled, and the point is reading
metrics while the pointer moves.

- Card: `--bg-panel`, 1px `--border-subtle`, 4px radius, `5px 8px` padding, mono 10px /
  15px lines, max 340px wide. Two-column grid: key `--text-dim` · value `--text-primary`,
  values ellipsised, one line per field in the row's own order. No title, no arrow.
- Placement: `position: fixed`, `pointer-events: none`, 12/14px off the pointer, flipped
  to the other side when it would leave the scroller's box; from keyboard focus it sits
  under the focused element instead. Hidden while pin mode is armed.
- The hovered mark highlights at the same time: rows take `--bg-active` (the kit hover
  fill), bars take the brighter `--text-secondary` fill with their label in
  `--text-primary`.
- Canvas charts (candles, line) keep their own readout / legend and get no card.
