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
- Two faces since 2026-09-09 (Eric: "Bundle IBM Plex Sans for page and doc bodies"),
  Ky's split: `var(--font-reading)` (IBM Plex Sans, bundled) for BODIES — the ✦ page's
  title/rows/turns/questions/input/button, the markdown doc, a stat card's label and
  figure; `var(--font-mono)` (JetBrains Mono) for CHROME — bars, menus, trees, counts,
  owner columns, addresses, stamps, wire text, tables, code. Hierarchy = size 9–17px,
  weight 400–700, the zinc text ramp. Newsreader does not come across.
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

## Stat card (reports — SWIT-73; Ky's report cards since 2026-09-09)

ONE NUMBER with a label, an optional n, one note line and an optional accent chip —
the report's headline figure. A fenced `stat` block in a report's markdown renders one
card ({label, value, n?, note?, tag?}) or a wrapping row of them (an array, ≤ 8). The
box is earned: it holds a figure the narrative leans on, never decoration.

- **Ky:** the report cards Eric pointed at (2026-09-09, the ads-learnings report): a
  raised card, the label in plain words, the figure big, a dim line under it ("4 – 7% is
  called good on ChatGPT Ads"), a green chip ("2 – 3× benchmark"), two-up in the panel.
- **Ours** (`components/views/ReportView.tsx` `StatTileBox`): `--bg-active`, 1px
  `--border`, radius 8, padding `12px 14px 13px`, `flex: 1 1 180px` so cards flow
  two-up in the panel's width, mono. Label 11.5px `--text-secondary`, 6px below it the
  value 24px weight 600 / 1.15 `--text-primary`; `n=<count>` rides 6px after the value
  at 10px `--text-faint`; `note` 10.5px `--text-muted` 4px under the figure; `tag` a
  chip 8px below — 10.5px `--accent` on the accent at 12% (`color-mix`), 1px
  `--accent-dim`, radius 6. Cards sit in a `flex-wrap` row, `gap: 10px`, aligned with
  the doc's 24px gutter.
- No trend arrows — a card states a number; the `tag` is the agent's one-phrase
  judgement, and the narrative beside it carries the rest.
- **Tone (SWIT-81):** a tile's `tone` (`up`/`dn`/`accent`/`neutral`) colours the FIGURE
  only — `up`/`dn` are `--up`/`--dn`, `accent` is `--accent`, `neutral` stays
  `--text-primary`. Omitted, it defaults from the value string's own leading sign
  (`+4%` → up, `-12` → dn, unsigned → neutral) — `lib/viewTone.ts`'s `statTone`. Label,
  note and tag are untouched.

## Tone (bars, tables, stat tiles — SWIT-81)

Colour carries MEANING, never decoration (Ky's 2026-09-20 "no green furniture" rule) —
three renderers that used to draw in greys only now take an explicit or defaulted tone,
resolved by pure helpers in `lib/viewTone.ts` and called by the renderer, never computed
inline.

- **Bar / dist bars:** a spec-level `tone` — `neutral` (`--text-secondary` rest,
  `--text-primary` hover — the old grey rule, now a named choice), `sign` (`--up`/`--dn`
  by the value's sign, 0.85 opacity resting via `color-mix`, full on hover), `accent`, or
  `chart-1`…`chart-8` (the line/candle series palette, `styles/surfaces.css`). Omitted,
  it defaults to `sign` when the column holds both a positive and a negative value, else
  `neutral` (`defaultBarTone`). The anchor and hover STATE are unchanged — only the fill
  moves.
- **Table cells:** an optional `tones` array (≤ 6) of `{column, tone}`. `sign` colours
  the cell TEXT `--up`/`--dn` by the parsed number's sign; `heat` tints the cell
  BACKGROUND from transparent to `--accent` at 22% by the value's position between the
  column's min and max over the loaded rows. A non-numeric cell, or a column with no
  rule, is untouched. Header cells are never tinted.
- **Stat tiles:** see Stat card above.
- Caps and enums are mirrored in the MCP server (the writer for bar/dist `tone` and
  table `tones`) and in `lib/viewTone.ts` (the reader, tolerant — a malformed or
  out-of-kind field is dropped, never a broken spec). A stat tile's `tone` is validated
  by `reportStore.ts`'s `parseTile` alone, STRICT like `n` — the server never sees inside
  the report's markdown file.

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
- Row REMOVAL (SWIT-78, Ky `PlanPanel.tsx` evidence rows: `×` `opacity-0
  group-hover:opacity-100 focus:opacity-100 hover:text-[color:var(--rose)]`, title
  `Take this row off the page`): a trailing `×` at the row's right end, mono 11px
  `--text-faint`, `opacity: 0` until the ROW is hovered or the button itself has
  keyboard focus (`.page-evidence-row` / `.page-evidence-x` in global.css — the one
  group-hover the inline styles cannot express), `--tone-rose` under the pointer.
  While a write is in flight EVERY `×` is disabled (the retractions share one tmp
  file) but only the row being taken off dims to `opacity: 0.4` (`data-retracting`
  on that button) — a disabled-wide opacity revealed every row's `×` at once. Before
  the row leaves, focus moves to a neighbouring row's `×` so a keyboard retraction
  never lands on `body`. The row does not shift when it appears (it sits after the
  status meta; `margin-left: auto` only when there is no meta).

## Button

Three ranks. One primary per surface; when a second action feels important it is quiet.

- **Ky:** `ky/components/Buttons.tsx` — `PrimaryButton` `px-3 py-1 rounded-md
  bg-accent text-[12px] font-semibold text-[#0f1115] hover:opacity-90
  disabled:opacity-40`; `SecondaryButton` `px-3 py-1 rounded-md border border-txt-dim
  text-[12px] text-txt hover:bg-bg-hover disabled:opacity-40`. Icon buttons:
  `ky/main/Topbar.tsx` (~370–376) `h-7 w-7 rounded-md text-txt-faint hover:bg-bg-hover
  hover:text-txt-dim`; `ky/chat/ChatTerminal.tsx` composer `+` (~1392) `w-7 h-7 rounded
  text-[15px]`.
- **Ours — primary:** Ky's PrimaryButton verbatim since 2026-09-09 — `--accent`
  fill, text `--bg-primary` (near-black, as Ky's `#0f1115`), 12px weight 600, padding
  `4px 12px`, radius 6, no border; hover `opacity: .9`; disabled `opacity: .4`. The
  ✦ page's `Send decisions ▸` is this, and (SWIT-91) so is the confirm dialog's
  confirm button — the same shape in `--tone-rose` fill when the action is
  destructive.
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

## The question block — decisions as a batch (SWIT-77)

Where questions are ANSWERED: the ✦ page's Open questions section (`PageView.DecisionsBlock`)
holds EVERY open question and every decided-but-unsent one as ONE numbered list with ONE
send; Home's Needs-you card answers a single question and points at the page for the send.
Answering SAVES (answers.json, at once); the agent hears every answer as one message when
the user presses the one button. Nothing narrates that mechanism on the surface — the
preview box SHOWS it. `QuestionView.tsx` (the old `? question` tab) keeps the single-question
shape for restored workspaces only.

- **Ky:** `ky/plan/DecisionsArtifact.tsx` (CC-688/710/721) — numbered cards oldest-first,
  `open`/`decided` word at the right, `Recommended: <first> — <why>`, option chips (the
  recommendation bordered, the chosen one filled), `or type an answer…` saving on blur, a
  decided row folded to `N · question → answer · change`, the preview box `what the agent
  gets — one message, when you send`, footer `M of N decided · undecided ones go as "still
  open"`, one `Send decisions ▸`; `ky/plan/decisionsStore.ts` for the wire format.
- **Ours — the card:** a dense row block (`padding: 8px 0`, 1px `--border` hairline under
  each) in a column. (1) First line: the NUMBER column (16px, 10px `--text-dim`) · the
  question 11.5px `--text-primary` · the state WORD at the right, 9.5px — `open` in
  `--text-dim`, `decided` in `--text-primary`. Everything below indents 22px past the
  number. (2) `Recommended: <option>` in `--text-primary` then ` — <why>` in
  `--text-secondary` (11px) — rendered only when the agent gave a default or a why; the
  recommended option is the default, else the first option (Ky's rule). (3) Options: the
  OPTION ROW (`components/kb/OptionRow.tsx`, shared with Home) — one LIST ROW per option,
  11px, padding `5px 8px`, the 14px glyph column drawing a text RADIO: `○` `--text-dim`
  resting, `●` `--text-primary` on hover / focus / the option being saved / the answer the
  page holds; `default` after the proposal in 9.5px `--text-dim`; the list between two 1px
  `--border` hairlines. The row IS the target — no bordered pill, no `<input type=radio>`.
  Rows take `keepFocus` (mousedown preventDefault) so a click never blurs the text box.
  (4) A typed answer that is not an option prints as `you: <answer>` (dim label). (5) The
  input: the kit field, placeholder `or type an answer…` / `or change your answer…` /
  `type your answer…` (no options); Enter saves, LEAVING THE BOX saves (Ky's CC-721) —
  Tabbing to one of the block's own buttons is the one blur that does not.
- **Ours — the folded row:** a decided-unsent card collapses to one LIST ROW button
  (`6px 0`, hairline under): number · question in `--text-muted` (ellipsis) · `→ <answer>`
  in `--text-primary` (`flex: 1`, ellipsis) · `change` 9.5px `--text-dim`. Click reopens
  the card with the cursor in its box; the next save folds it again.
- **Ours — the preview box** (an earned box: it holds the exact thing the send does):
  `--bg-elevated`, 1px `--border`, radius 4, padding `8px 10px`, 10px above the footer.
  Label 9.5px uppercase `letter-spacing: .08em` `--text-faint`: `what the agent gets — one
  message, when you send`; body 10.5px / 1.6 `--text-secondary`, `pre-wrap`, the wire
  text verbatim: `Decisions:` then `N. <question>` / `   → <answer | still open>`.
- **Ours — the footer:** one row, 10px `--text-dim`: `M of N decided` (+ ` · undecided ones
  go as "still open"` only when both kinds are present) · the outcome line in
  `--text-muted` when a save or a send failed (`could not save: …` / `not sent — …`; the
  form stays, the answers stay unsent) · the ONE primary button `Send decisions ▸` at the
  right (`--text-primary` fill, `--bg-primary` text, 11px 600, `3px 10px`, radius 3;
  `opacity: .4` disabled — no decision yet, a save in flight, or the thread not live, when
  its label reads `thread not live`; `Sending…` while it goes).
- **Home's card** keeps the single-question shape (question · OptionRow list · `or` · one
  input) inside THE earned box; its outcome line reads `saved · send from the page`, and
  the card drops off Home on the next poll. No send button on Home.
- Resolved states: on the page, DECIDED is a folded section (`show N ▸`) of `question` in
  `--text-muted` over `you: <answer>` / `settled: <answer>` (the agent's `resolve`) in
  `--text-secondary` with the label dim; the legacy tab centres the same voice, or the one
  line `This question is no longer on the page.`

## The page sections

THE PAGE READS LIKE KY'S PLAN PANEL (2026-09-09; `ky/plan/PlanPanel.tsx` — Eric: "it's
this weird gray, everything's monotone, and there are no real sections. I really just
want to copy the Ky platform"). Ky's measurements, our tokens and typeface:

- **Head:** the THREAD TITLE as an H1, 17px weight 600 / 1.25 `--text-primary`; the
  summary (theme + newest turn line) 12.5px `--text-secondary` under it; then the one
  `next →` / `start here →` line — the arrow 11px `--text-faint`, the target 11px
  `--accent`, underlined under the pointer (`.page-next`).
- **Section = H2:** 14px weight 600 `--text-primary`, `padding-bottom: 6px`, a 1px
  `--border` hairline under, `margin-bottom: 4px`; the count 10px weight 400
  `--text-faint` beside it; `hot` (Open questions) turns the title `--tone-amber`; the
  NEW dot after it is 6px `--accent`. Sections are 18px apart (Ky `pt-3 pb-1`).
- **Rows:** 12.5px `--text-primary` / 1.45, `padding: 6–7px 0`, a 1px `--border`
  hairline under EACH (a list, not a wall). Item row = Ky's grid `[18px minmax(0,1fr)
  auto]`, gap 12: a 12×12 radius-3 square bordered `--text-primary` (filled, `✓` 9px in
  `--bg-primary`, when done) · the title (`--text-faint` when done or dropped) · the
  owner column 10px `--text-faint` right-aligned reading `claude · you · team`
  (`waiting · you` in `--tone-amber` weight 600 when the row waits on the user; `in
  progress · claude` otherwise where the state is not obvious). Turn lines: `– ` in
  `--text-faint` + the line, `padding-left: 12px; text-indent: -12px`; earlier turns
  fold behind `earlier (N)` (text link) and open with a 1px `--border` left rule, a
  `Sep 9, 9:09 AM` stamp 10px faint, lines in `--text-secondary`. Evidence: the group
  chips are UNDERLINE TABS on one hairline (10.5px, active = 1.5px `--text-primary`
  bar + primary text, others `--text-faint`); a row lights `--bg-hover` on hover; the
  address 11px `--text-primary` on a 1px `--border` hairline (`.page-address`,
  brighter under the pointer), the label 12px `--text-secondary`, the status 10px
  faint at the right. Text links (`show 4 ▸`, `hide`) 10px `--text-faint` →
  `--text-primary` on hover (`.page-textlink`).
- **The batch:** question 12.5px `--text-primary`; `open`/`decided` 10px; the input is
  Ky's field (`--bg-secondary`, 1px `--border`, radius 6, `6px 10px`, 12px); the preview
  box `--bg-secondary` + hairline, radius 6; `Send decisions ▸` is the accent primary.
- Bodies are `--font-reading` (IBM Plex Sans, decided 2026-09-09); the counts, owner
  column, `open`/`decided`, `change`, addresses, `next →` line, stamps, the preview box
  and the footer are `--font-mono` — exactly the elements Ky marks `font-mono`.

The ✦ page (`PageView.tsx`, re-cut SWIT-67/68/69/77/78; the Ky pass above supersedes
the measurements in this paragraph where they differ): summary · open questions (the
batch, entry above) · to do · what happened · evidence · decided (folded) · done · dropped
(SWIT-78, Ky's CC-703: the agent's never-the-right-row items, collapsed behind a
`show N ▸` / `hide` text link exactly as Decided is — history never competes with the
rows that still matter; its rows are the same ITEM ROW in `--text-dim`, unchecked, never
amber). Every section is
a title + list rows; the only boxes are the batch's preview box. Ky's thread panel is the
reference: ONE page, everything on it. NEEDS YOU IS RETIRED on the page (SWIT-77, Ky's
PlanPanel): a row waiting on the user is a To do row, listed first, with its OWNER column
in `--tone-amber` semibold (`waiting · you`) — the one colour on the page; requests from
other threads sit at the top of To do as post rows. Home keeps its Needs you block.

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
  question is a numbered CARD in the batch (the question block entry) — option text
  stays `--text-primary`, brighter than body. ITEM ROW (words, not glyphs): a checkbox
  `☐`/`☑` in the 14px glyph column, title with ellipsis, then `waiting · you` style
  trailing meta — a one-word status only where not obvious, owner right-aligned 9.5px
  `--text-dim`, or `--tone-amber` 600 when the row waits on the user; no colored glyph,
  no spinner. A cross-thread post: a 9.5px `--text-dim` origin line
  (`↓ <thread>`) then the text. What happened: the latest turn as plain lines,
  `earlier (N) ▸` as a text link button. Evidence: address `--text-primary` · label
  `--text-muted` · status `--text-dim`, 1px `--border` hairline under each; the
  thread's VIEWS appear here too (`view:<id>` rows, label = the view title) and open
  in the preview slot; every row but a `decision:` row ends in the hover-only `×`
  (list row entry, Row REMOVAL). NEW dot: 6px `--text-primary` circle after the item
  or title. A decided-but-unsent answer in the batch carries `not sent yet` in 9.5px
  `--tone-amber` (Ky's `plan-question-unsent`) on its folded row and its card.
- Empty page: the `✦` glyph 14px `--text-muted` over ONE line, `No page yet.` Nothing
  about who writes it or when.
- **Home (`Home.tsx`, SWIT-54 hierarchy pass; re-cut SWIT-91 to this page's own Ky
  pass, SWIT-90)** is the same content at screen scale, now in the page's own
  grammar rather than a second kit voice: ONE left-aligned column, `max-width:
  720px`, sections as this page's SECTION TITLE (H2, entry above) — 14px 600
  reading-face, a 1px `--border` hairline under, the count/meta 10px mono
  `--text-faint` beside it — 18px apart, in page order Needs you · Backlog · Live
  now · Between threads · Listening · Kept views. The RULE-WITH-LABEL header and
  the uppercase faint section-label voice are RETIRED on Home. Every informational
  item is the page's DENSE_ROW (entry above): 12.5px reading-face `--text-primary`
  title, a 1px `--border` hairline under each row, meta 10px mono `--text-faint`
  right-aligned (`open →`, a time, a project, `listening`); hover `--bg-hover` +
  `--text-primary`, focus bar. NO leading glyph column — dots (live status, the
  probe) are data and sit inline before the title. A question in Needs you is THE
  EARNED BOX (entry above) — `--bg-active`, radius 8 — the only card on the
  screen, its input the page's FIELD. An EMPTY section does not render at all; the
  empty ones fold into ONE quiet line at the page bottom, 10px mono `--text-faint`:
  `needs you · live now · … — all quiet` (omitted when nothing is empty).

## Set frame (SWIT-79)

ONE tab for a collection: a switcher row over the member's ordinary surface. Nothing
about the member changes because it is inside a set.

- **Ky:** `ky/thread/SetFrame.tsx` (CC-677) — `flex items-center gap-2 px-3 py-1.5 border-b`
  over `bg-bg-pane`; `←` / `→` `px-1.5 text-[12px] text-txt-faint hover:text-txt`; the
  counter `text-[10.5px] text-txt-faint` (`3 / 9`); the current item's name
  `text-[12.5px] text-txt hover:underline` with a `▾` opening a `listbox` of the items
  (`px-3 py-1 text-[12.5px]`, the current in `text-txt`, the rest `text-txt-dim`, a
  `text-[10px] text-txt-faint` number before each); `split` `text-[10px]` at the right.
- **Ours** (`components/kb/SetFrame.tsx`): the 24px toolbar row (1px `--border` under,
  padding `0 8px 0 10px`, 10.5px `--text-dim`): `←` `n / N` `→` (glyphs 12px `--text-dim`
  → `--text-primary` on hover; the counter `--text-secondary`), the showing member's
  short title 11px `--text-primary` + a dim `▾` (click = the LIST ROW list, `5px 8px`,
  hover `--bg-elevated`, a 16px number column 10px `--text-dim`, the current row
  `--text-primary`), the set's caption at the right end 9.5px `--text-faint`. `split`
  is the PANEL HEADER's action (it acts on the strip), next to `⧉ N` — the fold, shown
  only with ≥ 2 tabs of the active kind. `[` / `]` step on the frame's focusable root.
  The tab prints `⧉ <caption>` (`⧉ 3 views`).

## Doc tick rail (SWIT-79)

Position in a document at a glance, the outline on demand — over the content, never a
reserved column.

- **Ky:** `ky/components/ReviewPage.tsx` `TocTickRail` (CC-702) — a `pl-3 pt-6` column of
  `h-[2px] rounded-full` ticks, `gap-[7px]`, H1 `w-3.5`, deeper `w-2 ml-1`, the active
  one `bg-accent`, the rest `bg-txt-faint/40`; `group-hover` / `group-focus-within`
  slides an `absolute left-0 w-[220px]` overlay (`bg-bg-pane border-r shadow-2xl`,
  `-translate-x-2 → 0`, 100ms) of `h-[14px]` rows: the tick + the heading `font-mono
  text-[10px]` (`text-txt` active, `text-txt-faint hover:text-txt-dim`) + `💬N` comment
  counts in `text-amber` `text-[9px]`.
- **Ours** (`components/kb/DocTickRail.tsx`, geometry `lib/docRail.ts`): the rail is
  34px wide, ticks 2px high in a column with a 7px gap, `padding: 24px 0 0 12px`; H1
  14px flush, deeper 8px indented 4; active `--accent` at opacity 1, the rest
  `--text-faint` at 0.4. The overlay is 220px, `--bg-elevated`, 1px `--border` right
  hairline, `translateX(-8px) → 0` + opacity over 100ms; rows 14px high, `gap: 3px`:
  the tick, the heading name 10px mono (`--text-primary` active, `--text-dim` →
  `--text-secondary` on hover), and a `📌N` pin count 9px `--tone-amber` (the pins
  keyed to that `h:` anchor). The heading's `title` is its text; the count's is
  `N pins`. No shadow (ours are hairlines), no `Introduction` row (a doc with no
  headings draws no rail at all).

## Facts row (SWIT-79)

A spec's front-matter line — `**Owner:** … · **Status:** … · **Tickets:** …` — as a
definition list under the title instead of a bold run-on paragraph. Display only.

- **Ky:** `ky/components/FactsRow.tsx` (CC-702) — `<dl class="flex flex-wrap gap-x-6
  gap-y-2">`; `<dt>` `font-mono text-[9.5px] uppercase tracking-[0.08em] text-txt-faint`,
  `<dd>` `font-sans text-[12.5px] text-txt`; a list-shaped key (`tickets|issues|links|
  prs|refs`) becomes a label over a `<ul class="pl-4 text-txt-dim leading-relaxed">`.
- **Ours** (`components/kb/FactsRow.tsx`, rule `lib/facts.ts`): `margin: 0 24px 16px`
  (the doc's gutter), `<dl>` flex-wrap `gap: 8px 24px`; label 9.5px mono uppercase
  `letter-spacing: 0.08em` `--text-faint`; value 12.5px / 1.5 `--text-primary`, PLAIN
  TEXT (no inline markdown — a third pipeline mount for a bold ticket key is not worth
  a second innerHTML injection); list values 12.5px `--text-secondary`, `padding-left:
  16px`. Sits between `MarkdownBody(before)` and `MarkdownBody(after)`; the paragraph
  is looked for in the first two sections only, and edit mode shows the line as written.

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
