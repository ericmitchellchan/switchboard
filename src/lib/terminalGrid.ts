// THE ONE TERMINAL GRID (SWIT-103, 2026-09-30 — Eric: "Yes, pin it like Ky").
//
// Every session's terminal — a thread, a plain shell, a panel terminal, the
// floating mirror — is 100 columns by 40 rows for its whole life. The xterm is
// created at this grid, the PTY is spawned at this grid, and no layout change
// (panel open, divider drag, window resize, tab switch, the composer showing)
// ever changes either. The terminal is a fixed texture the pane scrolls over:
// a pane narrower or shorter than the grid scrolls its host, a larger pane
// leaves slack.
//
// Why a constant and not the pane's measured size (ky-desktop's path, CC-591 →
// CC-673 → CC-685, which this repo followed one step behind): xterm re-wraps
// its buffer on a width change, while claude's TUI repaints its live frame
// with cursor-relative moves sized to the rows it drew BEFORE the change. The
// two disagree, and the repaint stamps a duplicated or interleaved copy into
// history that nothing ever repairs — claude only repaints its live frame.
// Grow-only width, deferring refits while the agent works, and a snapshot
// reflow on widen each narrowed that window; none closed it. A grid that
// never changes has no window.
//
// 100 columns is what the panel's default width leaves the pane tree
// (panelStore.defaultPanelWidth, SWIT-79); 40 rows is roughly what that pane
// is tall. Pure constants, no imports — panelStore, ipc and the registry all
// read them from here.

/** Columns of every terminal grid. */
export const TERMINAL_COLS = 100;

/** Rows of every terminal grid. */
export const TERMINAL_ROWS = 40;
