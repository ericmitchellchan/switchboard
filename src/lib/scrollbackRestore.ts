// RESTORING SCROLLBACK WITHOUT THE OLD CURSOR (SWIT-93, 2026-09-22 — Eric,
// with a screenshot: "when resuming a session or opening Switchboard again, it
// always renders weirdly. I can't even read the context").
//
// What the serialize addon's output CARRIES, read in @xterm/addon-serialize:
// after the rows it appends cursor moves (`ESC[nA` / `ESC[nB` / `ESC[nC` /
// `ESC[nD`) that put the cursor back where it WAS — for a claude session that
// is the input box, several rows above the bottom — and, unless asked not to,
// the terminal MODES that were on (bracketed paste, application cursor keys,
// mouse tracking). So a restored buffer ended with the cursor parked mid-screen
// with the old session's modes armed, and the fresh shell + `claude --resume`
// then painted their frames OVER the rows below that cursor: two transcripts
// interleaved cell by cell, exactly the screenshot.
//
// Two pure rules, applied by terminalRegistry's restore and workspace's save:
//
//   1. `capSerialized` — the 1 MB tail cut happens at a ROW boundary. The old
//      `slice(-MAX)` could land inside an escape sequence or between the two
//      halves of a surrogate pair, and the parser then printed the remainder
//      as text (the `'GBr(usedcisd` fragments in the screenshot's top rows).
//   2. `restoreSettleSequence` — after the restored bytes are parsed, reset
//      attributes, put the cursor on the LAST ROW THAT HOLDS CONTENT and open a
//      fresh line under it, so everything the new session prints lands BELOW
//      the old transcript and the old rows scroll away intact. Measured from
//      the live buffer (`readRestoreGeometry`) rather than guessed from the
//      string: a short restored buffer keeps its prompt near the top instead
//      of being thrown to the viewport's bottom row.
//
// The modes are handled at SAVE time: `serializeTerminal` passes
// `excludeModes: true` — a mode is the running program's, and the program is
// gone by the time the file is read back. NOT restored as plain text: the
// serialized frame is what the PiP handoff writes back into a terminal, and
// colour in scrollback is worth keeping.

/** A serialized frame's row separator (the addon writes `\r\n` between rows;
 *  a wrapped row is joined with cursor moves instead, so cutting only at
 *  `\r\n` never lands inside a wrapped row's join sequence). */
const ROW_SEPARATOR = "\r\n";

/** Keep at most `max` UTF-16 units of the TAIL of a serialized frame, cutting
 *  only at a row boundary. With no boundary in the tail, cut at `max` but
 *  never between the two halves of a surrogate pair. */
export function capSerialized(content: string, max: number): string {
  if (max <= 0) return "";
  if (content.length <= max) return content;
  const start = content.length - max;
  const boundary = content.indexOf(ROW_SEPARATOR, start);
  if (boundary !== -1) return content.slice(boundary + ROW_SEPARATOR.length);
  // No row boundary in the tail: a single enormous row. Cut at `start`, but
  // step past a low surrogate so the first character is whole.
  const code = content.charCodeAt(start);
  const from = code >= 0xdc00 && code <= 0xdfff ? start + 1 : start;
  return content.slice(from);
}

/** What `restoreSettleSequence` needs to know about the buffer AFTER the
 *  restored bytes were parsed — every field 0-based, viewport-relative
 *  where it says so. */
export interface RestoreGeometry {
  /** The viewport's row count. */
  rows: number;
  /** The cursor's row within the viewport. */
  cursorY: number;
  /** The LAST buffer row (viewport-relative) that holds any text; -1 when
   *  the buffer is empty. */
  lastContentRow: number;
}

/** Reset SGR + cursor to the last content row (1-based CUP, column 1) + one
 *  fresh line. Column 1 of a NEW row, never the end of the content row: the
 *  shell's first output starts with its own prompt, and a partial last row
 *  (a claude status line) must not be appended to. */
export function restoreSettleSequence(g: RestoreGeometry): string {
  const rows = Math.max(1, Math.floor(g.rows));
  // Nothing restored, or the cursor already sits below every content row:
  // still open a fresh line so the seam is a line break, not a mid-row join.
  const target = Math.min(Math.max(g.lastContentRow, 0), rows - 1);
  const cursor = Math.min(Math.max(Math.floor(g.cursorY), 0), rows - 1);
  const row = Math.max(target, cursor);
  return `\x1b[0m\x1b[${row + 1};1H\r\n`;
}

/** The subset of xterm's buffer API the geometry read needs — declared here
 *  so the rule is testable with a plain object. */
export interface BufferLike {
  rows: number;
  buffer: {
    active: {
      baseY: number;
      cursorY: number;
      length: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

/** Measure the live buffer after a restore write has been parsed. Walks up
 *  from the bottom of the VIEWPORT (never the whole scrollback) to the last
 *  row with text. */
export function readRestoreGeometry(term: BufferLike): RestoreGeometry {
  const buf = term.buffer.active;
  const rows = term.rows;
  let lastContentRow = -1;
  for (let vy = rows - 1; vy >= 0; vy--) {
    const line = buf.getLine(buf.baseY + vy);
    if (line && line.translateToString(true).length > 0) {
      lastContentRow = vy;
      break;
    }
  }
  return { rows, cursorY: buf.cursorY, lastContentRow };
}
