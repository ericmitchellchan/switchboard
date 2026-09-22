// STATUS PILLS (SWIT-95, Ky's HandoffBlock.StatusPill + rowModel.statusTone) —
// the pure word→tone rule shared by every pill on the ✦ page (To do's STATUS
// column, Artifacts' STATUS column). No React, no IO.
//
// A pill's WORD carries the state (`waiting`, `done`, `in progress`…) and its
// TONE is read off that word — solid amber/green/blue for a state that means
// something, a neutral outline for one that doesn't, a dim outline for a state
// that is over. Unknown words are neutral rather than a guessed color.
//
// `ago` is a small relative-age word for a row's stamp (`Age`, in
// components/kb/PageBlock.tsx) — simpler than Ky's own `ago` (which steps to a
// weekday then a month/day): every stamp on the ✦ page is recent thread
// activity, never months old, so Xm/Xh/Xd is the whole range that matters.

import { isWaitingOnUser } from "./pageStore";
import type { PageItem } from "./pageStore";

export type PillTone = "amber" | "green" | "blue" | "neutral" | "dim";

/** Waiting on the user, or something is blocking it. */
const AMBER_WORDS = new Set(["waiting", "needs you", "blocked"]);
/** The work happened, or the answer is final. */
const GREEN_WORDS = new Set(["done", "merged", "passed", "decided", "settled", "released"]);
/** Live and moving. */
const BLUE_WORDS = new Set(["in progress", "open", "running", "review"]);
/** Over, and not in a way that needs a color — a dim outline, same reading as
 *  Ky's ledger DIM_WORDS. */
const DIM_WORDS = new Set(["closed", "dropped", "rejected", "stale", "mentioned", "seen in thread"]);

/** The tone a status WORD reads as. Case- and whitespace-insensitive; an
 *  unrecognized word is `neutral` — a plain outline, never a guessed color. */
export function statusTone(word: string): PillTone {
  const w = word.trim().toLowerCase();
  if (AMBER_WORDS.has(w)) return "amber";
  if (GREEN_WORDS.has(w)) return "green";
  if (BLUE_WORDS.has(w)) return "blue";
  if (DIM_WORDS.has(w)) return "dim";
  return "neutral";
}

/** A pill's word in Title Case (Ky's `titleCase`): "in progress" → "In
 *  Progress". A letter already a capital stays so. */
export function titleCase(word: string): string {
  return word
    .split(" ")
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export type ItemPill = { word: string; tone: PillTone };

/** An item's STATUS pill: the state word (`in_progress` → `in progress`), and
 *  its tone — amber whenever the row is WAITING ON THE USER
 *  (`pageStore.isWaitingOnUser`, the same predicate the owner column reads),
 *  which overrides whatever the state word's own tone would be, else the
 *  state word's tone as `statusTone` reads it. */
export function itemPill(item: Pick<PageItem, "state" | "owner">): ItemPill {
  const word = item.state === "in_progress" ? "in progress" : item.state;
  return { word, tone: isWaitingOnUser(item) ? "amber" : statusTone(word) };
}

/** A relative age word for a stamp: `now` under a minute, else `Xm` / `Xh` /
 *  `Xd` — the ✦ page's rows are all recent thread activity, so the range
 *  never needs to step further than days. An unparseable stamp is `""`. */
export function ago(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = Math.max(0, now - t);
  if (d < 60_000) return "now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / 86_400_000)}d`;
}
