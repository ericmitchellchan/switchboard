// What a tab actually PRINTS — pure, so the de-duplication rules are asserted
// without a DOM (2026-08-02, Eric, driving the app).
//
// The bug this exists to kill: one tab could say the same word three times.
// A thread created in the switchboard repo produced a session named
// `switchboard · Aug 2`, with `repo: "switchboard"` and `group/repo` also
// "switchboard" — and TabBar drew all three:
//
//     │ SWITCHBOARD │ ● switchboard  switchboard  × │
//       group label    name          repo suffix
//
// Each piece is individually justified — the group label separates runs of
// tabs from different repos, the repo suffix disambiguates two tabs with the
// same name — and each becomes noise the moment the tab's own name already
// carries the word. Both rules below are therefore about REDUNDANCY, not about
// hiding information: nothing is dropped that the row does not already say.
//
// The comparison is deliberately PREFIX-based rather than equality. A synced
// tab/thread name is `<repo> · <date>`, so `switchboard · Aug 2` must suppress
// the `switchboard` suffix exactly as a bare `switchboard` does — otherwise
// the default name (the common case) would keep the duplicate forever.

/** Case- and separator-insensitive "does `name` already lead with `word`?".
 *  A prefix only counts when it ends at a WORD boundary: `switchboard` leads
 *  `switchboard · Aug 2` but not `switchboarding`, which is a different repo. */
export function nameLeadsWith(name: string, word: string): boolean {
  const n = name.trim().toLowerCase();
  const w = word.trim().toLowerCase();
  if (w.length === 0 || n.length === 0) return false;
  if (!n.startsWith(w)) return false;
  if (n.length === w.length) return true;
  // Next char must be a separator, not more of a longer word.
  return /[\s\-_./\\·:]/.test(n.charAt(w.length));
}

/** The dim `repo` chip drawn after a tab's name, or `null` to draw nothing.
 *  Null when the name already leads with the repo — the chip would be a second
 *  copy of a word the reader just read. */
export function tabRepoSuffix(name: string, repo: string | undefined): string | null {
  const r = (repo ?? "").trim();
  if (r.length === 0) return null;
  return nameLeadsWith(name, r) ? null : r;
}

/** The uppercase group label drawn in the divider BEFORE a tab, or `null` for
 *  a rule with no text.
 *
 *  The divider itself stays either way — it is what separates two runs of tabs
 *  — but its LABEL is dropped when the very next tab's name already says the
 *  group's name. With one tab in the group (the normal case for a per-repo
 *  thread) the label was pure duplication of the tab beside it. */
export function tabGroupLabel(groupKey: string, nextTabName: string): string | null {
  const g = groupKey.trim();
  if (g.length === 0) return null;
  return nameLeadsWith(nextTabName, g) ? null : g.toUpperCase();
}
