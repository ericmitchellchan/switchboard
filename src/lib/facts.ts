// THE FACTS ROW (SWIT-79, Ky's markdown/facts.ts CC-702, verbatim rule):
//
//   **Status:** DRAFT · **Tracker:** Linear epic SWIT-54 · **Decision:** …
//
// The front-matter line Eric's specs carry under the title. Read mode renders
// it as a facts row (`<dl>` — small uppercase labels, the values as written,
// a Tickets-style value one item per line) instead of a bold run-on
// paragraph. THE FILE IS UNTOUCHED — this only splits the paragraph for
// display; edit mode shows the line as written.
//
// Ky's placement rule: the facts paragraph is looked for in the FIRST TWO
// sections only (the H1 section, which sits behind a YAML intro in most docs)
// and rendered INSIDE that section between its heading and its prose. Pure.

export type Fact = { key: string; value: string };

export type FactsSplit = {
  /** Markdown before the facts paragraph (the H1 line, an intro). */
  before: string;
  facts: Fact[];
  /** Markdown after the facts paragraph. */
  after: string;
};

/** A `**Key:** ` pair: key ≤ 40 chars, no `*`, no newline. */
const PAIR = /\*\*([^*\n]{1,40}?):\*\*\s*/g;

/** How far down the document the row may sit: the first two SECTIONS
 *  (heading-delimited; text before the first heading counts as one). */
export const FACTS_SECTION_REACH = 2;

/** A paragraph is a facts line when it STARTS with a pair and holds two or
 *  more; the value of each pair runs to the next pair. Null otherwise. */
export function parseFactsParagraph(para: string): Fact[] | null {
  const text = para.trim();
  if (!/^\*\*[^*\n]{1,40}?:\*\*/.test(text)) return null;
  const matches = [...text.matchAll(PAIR)];
  if (matches.length < 2) return null;
  const facts: Fact[] = [];
  matches.forEach((m, i) => {
    const valueStart = m.index! + m[0].length;
    const valueEnd = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    const value = text
      .slice(valueStart, valueEnd)
      .replace(/\s*[·•|]\s*$/, "")
      .trim();
    facts.push({ key: m[1].trim(), value });
  });
  return facts;
}

/** A "Tickets"-style value lists several things: split on ` · ` (and `•`)
 *  into one item per line. Other values stay as one. */
export function factItems(fact: Fact): string[] {
  if (!/^(tickets?|issues?|links?|prs?|refs?)$/i.test(fact.key)) return [fact.value];
  return fact.value
    .split(/\s*[·•]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Section boundaries: ATX headings outside fenced code (the same fence
 *  rule reportStore keeps — backtick or tilde, 3+, closed by its own kind).
 *  Returns the char offset where each section STARTS (a heading line's
 *  start; 0 for text before the first heading when there is any). */
export function sectionStarts(body: string): number[] {
  const starts: number[] = [];
  let offset = 0;
  let fence: { ch: string; len: number } | null = null;
  let sawText = false;
  for (const line of body.split("\n")) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m) {
      const ch = m[1][0];
      const len = m[1].length;
      if (fence === null) fence = { ch, len };
      else if (fence.ch === ch && len >= fence.len) fence = null;
    } else if (fence === null && /^ {0,3}#{1,6}(\s|$)/.test(line)) {
      if (starts.length === 0 && sawText) starts.push(0);
      starts.push(offset);
    } else if (line.trim().length > 0) {
      sawText = true;
    }
    offset += line.length + 1;
  }
  if (starts.length === 0 && sawText) starts.push(0);
  return starts;
}

/** Find the first paragraph in the first FACTS_SECTION_REACH sections that
 *  is a run of ≥ 2 pairs and split it out. Null when there is none — the
 *  document then renders as it always did. */
export function splitFacts(body: string): FactsSplit | null {
  const normalized = body.replace(/\r\n/g, "\n");
  const starts = sectionStarts(normalized);
  const reachEnd = starts.length > FACTS_SECTION_REACH ? starts[FACTS_SECTION_REACH] : normalized.length;
  const scope = normalized.slice(0, reachEnd);
  // Paragraphs: blank-line separated, offsets tracked so the split is by
  // POSITION (a paragraph repeated later in the doc must not be the one cut).
  let offset = 0;
  let fence: { ch: string; len: number } | null = null;
  let paraStart = 0;
  const paragraphs: Array<{ start: number; end: number }> = [];
  const lines = scope.split("\n");
  for (let i = 0; i <= lines.length; i++) {
    const line = i < lines.length ? lines[i] : "";
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m) {
      const ch = m[1][0];
      const len = m[1].length;
      if (fence === null) fence = { ch, len };
      else if (fence.ch === ch && len >= fence.len) fence = null;
    }
    const blank = i === lines.length || (fence === null && line.trim().length === 0);
    if (blank) {
      if (offset > paraStart) paragraphs.push({ start: paraStart, end: offset - 1 });
      paraStart = offset + line.length + 1;
    }
    offset += line.length + 1;
  }
  for (const p of paragraphs) {
    const para = scope.slice(p.start, p.end);
    // A heading line is never a facts paragraph, but one may share a
    // paragraph with the line under it (no blank line) — strip it first.
    const withoutHeading = para.replace(/^ {0,3}#{1,6}[^\n]*\n?/, "");
    const facts = parseFactsParagraph(withoutHeading);
    if (!facts) continue;
    const factsStart = p.start + (para.length - withoutHeading.length);
    return {
      before: normalized.slice(0, factsStart).replace(/\s+$/, ""),
      facts,
      after: normalized.slice(p.end).replace(/^\s+/, ""),
    };
  }
  return null;
}
