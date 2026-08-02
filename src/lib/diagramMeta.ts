// Diagram verification metadata (T9) — a TEXT convention, not a schema.
//
// The kyde-diagram kit stamps code-verified diagrams inside the .mmd itself:
//   - a `%% verified-against: <commit> @ <date>` comment line, and
//   - `(unverified)` suffixes on edge labels whose receipts weren't traced.
// Both survive rendering untouched (mermaid ignores %% comments; the suffix
// is just label text), so the status strip parses the RAW source with two
// regexes. Deliberately lenient: any line containing `verified-against:`
// counts (comment marker not required), matching is case-insensitive.

export interface DiagramMeta {
  /** Trailing text after `verified-against:` (commit / commit @ date), or
   *  null when the diagram carries no stamp. First occurrence wins. */
  verifiedAgainst: string | null;
  /** Number of `(unverified)` markers in the source (0 = none). */
  unverifiedCount: number;
}

export function parseDiagramMeta(mmd: string): DiagramMeta {
  const verifiedAgainst = mmd.match(/verified-against:\s*(.+)/i)?.[1].trim() ?? null;
  const unverifiedCount = (mmd.match(/\(unverified\)/gi) ?? []).length;
  return { verifiedAgainst, unverifiedCount };
}
