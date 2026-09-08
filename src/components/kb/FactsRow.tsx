// THE FACTS ROW (SWIT-79, Ky's FactsRow CC-702): a spec's front-matter line
// as a `<dl>` — small uppercase labels, the values as written, a
// Tickets-style value one item per line. Display only — the paragraph
// stays in the file, and edit mode shows it as the line it is.
//
// Values are rendered as PLAIN TEXT, not inline markdown: the row sits
// between two MarkdownBody fragments and a third pipeline mount for a bold
// ticket key is not worth a second innerHTML injection point. The kit
// entry (components.md → Facts row) has the measurements.

import type { CSSProperties } from "react";
import { factItems, type Fact } from "../../lib/facts";

const MONO = "var(--font-mono)";

const LABEL: CSSProperties = {
  fontFamily: MONO,
  fontSize: 9.5,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--text-faint)",
  margin: 0,
};

const VALUE: CSSProperties = {
  fontFamily: MONO,
  fontSize: 12.5,
  lineHeight: 1.5,
  color: "var(--text-primary)",
  margin: 0,
};

export function FactsRow({ facts }: { facts: Fact[] }) {
  const single = facts.filter((f) => factItems(f).length === 1);
  const lists = facts.filter((f) => factItems(f).length > 1);
  return (
    <div data-testid="facts-row" style={{ margin: "0 24px 16px" }}>
      {single.length > 0 && (
        <dl style={{ display: "flex", flexWrap: "wrap", gap: "8px 24px", margin: 0 }}>
          {single.map((f, i) => (
            <div key={`${i}:${f.key}`} style={{ minWidth: 0, maxWidth: "100%" }}>
              <dt style={LABEL}>{f.key}</dt>
              <dd style={VALUE}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {lists.map((f, i) => (
        <div key={`${i}:${f.key}`} style={{ marginTop: 8 }}>
          <div style={LABEL}>{f.key}</div>
          <ul style={{ ...VALUE, color: "var(--text-secondary)", marginTop: 2, paddingLeft: 16 }}>
            {factItems(f).map((item, j) => (
              <li key={`${j}:${item}`}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
