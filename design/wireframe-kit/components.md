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
| `--bg` #0a0a0a | `--bg-secondary` #0a0a0a (side menu, bars) — SAME VALUE since SWIT-72 |
| `--bg-pane` #141414 | `--bg-elevated` #141414; `--bg-primary` #0f0f0f is the terminal side (our extra step) |
| `--bg-raised` #1a1a1a | `--bg-active` #1a1a1a; `--bg-panel` #1e1e1e is the panel's own step |
| `--bg-hover` #242424 | (no direct slot — hovers use `--bg-active`) |
| `--line` #2e2e2e | `--border` #2e2e2e |
| `--line-soft` #1e1e1e | (surface role: `--bg-panel`); `--border-subtle` #3a3a3a is the brighter hairline |
| `--txt` #ededed | `--text-primary` #ededed |
| `--txt-dim` #b4b4b4 | `--text-secondary` #b4b4b4 |
| `--txt-faint` #888888 | `--text-muted` #888888 (labels) / `--text-dim` #6e6e6e (meta) / `--text-faint` #565656 (idle icon) |
| `--accent` #7dd3a8 | `--accent` #7dd3a8 (SWIT-72; `--accent-dim` #3a6450) — emphasis text stays `--text-primary` |
| `--amber` #e8b765 | `--tone-amber` / `--accent-yellow` #e8b765 (`STATUS_CONFIGS.waiting.color`), functional only |
| `--rose` #e88a8a | `--tone-rose` / `--accent-red` #e88a8a, destructive only |

Surfaces (`.sb-surface`, `src/styles/surfaces.css`) speak Lodestar's names for the
same ramp: `--line` = `--border`, `--surface` = `--bg-elevated`, `--surface2` =
`--bg-active`, `--text` / `--dim` / `--dim2` = primary / secondary / muted.

---

## Type ramp

FOUR sizes, no fifth (2026-09-01, the Home hierarchy pass — Eric: "the type seems
disjointed"). Hierarchy on a screen-scale surface comes from this ramp, not from
ad-hoc pixel values:

- **Section label** — 10px uppercase, `letter-spacing: 0.08em`, `--text-faint`.
- **Row / question title** — 12.5px `--text-primary`.
- **Body / options** — 11px `--text-secondary` (options `--text-primary` — the thing
  to read).
- **Meta** — 9.5px `--text-dim`.

Ky's HomeScreen is the model: type scales differ by ROLE (their serif headline /
sans body / mono meta), and the ramp is what carries that logic into our one
typeface. Legacy 11.5px survives in the dense chrome (side-menu rows, tab bar,
inputs in the panel) — the ramp governs Home and every new screen-scale surface.

## Rule-with-label (section header, screen scale)

The section separator on a screen-scale surface (Home): the label, then a 1px
`--border` hairline FILLING the rest of the line, count/meta at the right end —
separation by structure, never by a box.

- **Ky:** HomeScreen's section headings — a small label over whitespace asymmetry;
  the hairline is our terminal-grade version of the same chunking.
- **Ours:** `Home.SectionHeader` — flex row, `gap: 10px`: label (type-ramp section
  label) · `flex: 1; height: 1px; background: var(--border)` · meta 9.5px
  `--text-dim`. Spacing is ASYMMETRIC: ~28px above the header, 10px below — the
  space says where a section starts. The side-menu band header (below) stays as it
  is; this is the screen-scale variant.

## The earned box

An elevated card is RESERVED for a block that asks the user to act; informational
content never gets one. ONE per screen is the norm (Ky's HomeScreen: exactly one
raised card — the thing needing action — everything else flat).

- **Ours:** `--bg-elevated`, 1px `--border`, radius 6, padding 14, column
  `gap: 10px`. Home's question card (Needs you) is the reference: title row
  (question 12.5px `--text-primary`, `thread · repo` meta 9.5px `--text-dim` at
  the top-right), the OptionRow list between hairlines, the dim `or`, one kit
  input at `max-width: 480px`. Requests, items, posts, threads stay flat rows.

## Stat tile (reports — SWIT-73)

ONE NUMBER with a label and an optional n — the report's headline figure. A fenced
`stat` block in a report's markdown renders one tile ({label, value, n?}) or a
wrapping row of them (an array, ≤ 8). The box is earned: it holds a figure the
narrative leans on, never decoration.

- **Ours** (`components/views/ReportView.tsx` `StatTileBox`): `--bg-panel`, 1px
  `--border`, radius 4, padding `8px 14px 9px`, min-width 96px, mono. Label on top:
  9.5px uppercase, 0.5px letter-spacing, `--text-dim`, 3px below it the value: 16px /
  1.2 `--text-primary`; `n=<count>` rides 6px after the value at 9.5px `--text-faint`.
  Tiles sit in a `flex-wrap` row, `gap: 8px`, aligned with the doc's 24px gutter.
- No trend arrows, no tones — a stat tile states a number; judgement lives in the
  narrative beside it.

## Band header

The label over a side-menu band or a page section, with its right-end actions.

- **Ky:** `ky/main/Sidebar.tsx` (THREADS header, ~257–284) — `mt-[18px] mb-1.5 px-3`,
  label `font-mono text-[9px] uppercase tracking-[0.16em] text-txt-faint`; actions
  `See all` in the same voice + `+` at `text-[13px] leading-none px-1`, both
  `hover:text-accent`.
- **Ours:** `ThreadsSection.BandHeader`, `SideMenu.SectionLabel`. (The ✦ page's section
  titles left this voice with SWIT-68 — see The page sections below.)
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
- **Ours — primary:** `--text-primary` fill, text `--bg-primary` (near-black,
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
  2026-08-01: count badges are bg `--bg-active` / 1px `--border-subtle` / text `--text-primary` — that is
  this chip in its EMPHASIS form: `--text-primary` on border `--text-secondary`, used
  for `↓ N` unread). Nothing is filled: the filled `?` "agent waiting" chip RETIRED with
  SWIT-69 (words, not glyphs) — a thread's open questions are a dim 9.5px `· N` count
  with a worded `title` (`1 open question`); the waiting state lives in the status dot.

## The question block

Where a question is ANSWERED: the ✦ page's Open questions section (`PageView.InlineQuestion`,
SWIT-67 — `ask` no longer opens a tab) and Home's Needs-you card. The shape everywhere:
the question · options as a plain list · one input · one action. Nothing else — no glyph
box, no note about where the answer goes (that is the spec's sentence, `requirements.md`
R4). `QuestionView.tsx` (the old `? question` tab) keeps the same shape for restored
workspaces only.

- **Ky:** `ky/chat/ChatTerminal.tsx` composer + permission strip (~1305–1330): the
  prompt as one line, `✓ Approve ↵` / `✕ Deny esc` as two buttons in a row, the
  textarea below; `ky/todos/TodoPanel.tsx` for the list-of-rows + one input shape.
- **Ours:** body padding `14px`, `gap: 12px`, column. (1) Question: 12.5px
  `--text-primary`, `line-height: 1.5`. (2) Options: the OPTION ROW
  (`components/kb/OptionRow.tsx`, shared with Home's Needs-you block) — one LIST ROW per
  option, 11px (the ramp's option size), padding `5px 8px`, with the 14px leading glyph column drawing a text
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

The ✦ page (`PageView.tsx`, re-cut SWIT-67/68/69): summary · open questions · needs you ·
to do · what happened · evidence · questions · done. Every section is a title + list
rows; no section is a box. Ky's thread panel is the reference: ONE page, everything on it.

- **Ky:** `ky/todos/TodoPanel.tsx` (header + rows + one input), `ky/thread/LedgerPanel.tsx`
  for the ledger's section-then-rows rhythm, `ky/components/InfoNote.tsx` for the rule
  that explanatory prose is never resting on the page.
- **Ours:** body padding `12px 14px`, 11px, `line-height: 1.45`, `--text-secondary`,
  `gap: 26px` between sections (air between, tight within). SUMMARY at the top, no
  label: the theme line + the newest turn's first line as one plain 11.5px
  `--text-secondary` paragraph; under it, an optional `start here → <address>` line
  (the turn's reviewFirst, drawn as the same link an Evidence row gets). SECTION
  TITLE: sentence case, 12.5px `--text-primary`, upright — the count beside it in
  11px `--text-dim` (`Open questions 1` · `To do 4`); the uppercase faint band-header
  voice is RETIRED on this page (Home keeps its rule-with-label headers). An open
  question renders the FULL question block in place (options as OptionRows between
  hairlines, input, quiet `answer`) — option text stays `--text-primary`, brighter
  than body. ITEM ROW (words, not glyphs): a checkbox `☐`/`☑` in the 14px glyph
  column, title with ellipsis, then `waiting · you` style trailing meta — a one-word
  status only where not obvious, owner right-aligned 9.5px `--text-dim`; no colored
  glyph, no spinner. A cross-thread post: a 9.5px `--text-dim` origin line
  (`↓ <thread>`) then the text. What happened: the latest turn as plain lines,
  `earlier (N) ▸` as a text link button. Evidence: address `--text-primary` · label
  `--text-muted` · status `--text-dim`, 1px `--border` hairline under each; the
  thread's VIEWS appear here too (`view:<id>` rows, label = the view title) and open
  in the preview slot. NEW dot: 6px `--text-primary` circle after the item or title.
- Empty page: the `✦` glyph 14px `--text-muted` over ONE line, `No page yet.` Nothing
  about who writes it or when.
- **Home (`Home.tsx`, SWIT-54 hierarchy pass)** is the same content at screen scale
  with Ky's HomeScreen hierarchy logic: ONE left-aligned column, `max-width: 720px`,
  sections separated by the RULE-WITH-LABEL header (~28px above, 10px below — the
  whitespace asymmetry chunks them; entry above) in page order Needs you · Backlog ·
  Live now · Between threads · Listening · Kept views. Type follows the RAMP: titles
  12.5px `--text-primary`, body 11px, meta 9.5px `--text-dim` right-aligned in one
  column (`open →`, a time, a project, `listening`). Every informational item is a
  flat content-body list row (`5px 8px`, hover `--bg-active` + `--text-primary`,
  focus bar) with NO leading glyph column — dots (live status, the probe) are data
  and sit inline before the title; `?`/`○`/`→` decoration is gone, the section
  label says what rows are. A question in Needs you is THE EARNED BOX (entry above)
  — the only card on the screen. An EMPTY section does not render at all; the empty
  ones fold into ONE quiet line at the page bottom, 9.5px `--text-dim`:
  `needs you · live now · … — all quiet` (omitted when nothing is empty).

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
