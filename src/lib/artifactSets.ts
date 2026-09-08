// SETS — one tab for a collection (SWIT-79, Ky's set tabs CC-677).
//
// Eric hit ten tabs on one Lodestar thread; SWIT-69 answered with the ONE
// preview slot, and this is the other half of Ky's answer: N same-kind tabs
// FOLD into one `set` tab the panel steps through (`← n / N →`, `[` / `]`),
// `split` turns it back into one tab per item, and the agent's `view show`
// can hand the panel a set of views as ONE tab from the start.
//
// PURE. Every rule here works on a PanelState / an Artifact list and returns a
// new one; the store half (panelStore.foldActiveKind / unfoldSetAt / the
// per-set position map) applies them. No identity function is needed at this
// level — a fold lands on the item the reader was looking at by REFERENCE
// (the members ARE the strip's own artifact objects), and identity (sorted
// membership) is panelStore.artifactIdentity's job, next to every other kind.
//
// Types only from ../types; nothing from panelStore (which imports this).

import type { Artifact, PanelState } from "../types";

/** A set's member — any kind but a set (flattened) or a session (one live
 *  view — a shell is never a glance inside a switcher). */
export type SetItem = Exclude<Artifact, { kind: "set" | "session" }>;
export type SetArtifact = Extract<Artifact, { kind: "set" }>;

/** Membership cap. Ky has none; ours keeps the lean-record invariant honest
 *  (a set rides in the workspace blob like any tab). */
export const SET_ITEM_CAP = 50;

/** Caption cap — a tab label, not a sentence. */
export const SET_LABEL_CAP = 80;

/** The kinds the header's `⧉ N` may fold. The ✦ page is the strip's fixed
 *  first tab, a question tab is legacy, a session has one live view, and a
 *  set is already one — none of those fold. */
export const FOLDABLE_KINDS: ReadonlySet<Artifact["kind"]> = new Set([
  "kb-doc",
  "repo-file",
  "localhost",
  "surface",
  "view",
]);

export function isFoldableKind(kind: Artifact["kind"]): kind is SetItem["kind"] {
  return FOLDABLE_KINDS.has(kind);
}

/** A plain-words noun for a set of one kind: `3 views`, `2 docs`. */
export function setNounFor(kind: Artifact["kind"], n: number): string {
  const one = n === 1;
  switch (kind) {
    case "view":
      return one ? "view" : "views";
    case "kb-doc":
      return one ? "doc" : "docs";
    case "repo-file":
      return one ? "file" : "files";
    case "surface":
      return one ? "page" : "pages";
    case "localhost":
      return one ? "preview" : "previews";
    default:
      return one ? "item" : "items";
  }
}

/** The caption a FOLD writes: `N <noun>` from the first member's kind (a
 *  fold is always one kind — `tabsOfKind` is what feeds it). */
export function setLabelFor(items: readonly Artifact[]): string {
  const kind = items[0]?.kind ?? "view";
  return `${items.length} ${setNounFor(kind, items.length)}`;
}

/** The strip's tabs of one kind (never sets), with their indices. */
export function tabsOfKind(
  artifacts: readonly Artifact[],
  kind: Artifact["kind"]
): Array<{ index: number; artifact: SetItem }> {
  const out: Array<{ index: number; artifact: SetItem }> = [];
  artifacts.forEach((a, index) => {
    if (a.kind === kind && a.kind !== "set" && a.kind !== "session") out.push({ index, artifact: a });
  });
  return out;
}

/** Can the header offer a fold for this strip's active tab? The count is
 *  what the `⧉ N` prints; 0 = no button. */
export function foldableCount(state: PanelState | null): number {
  if (!state) return 0;
  const active = state.artifacts[state.activeIndex];
  if (!active || !isFoldableKind(active.kind)) return 0;
  const n = tabsOfKind(state.artifacts, active.kind).length;
  return n >= 2 ? n : 0;
}

/** THE FOLD (Ky's foldActiveKind): every tab of the active tab's kind into
 *  ONE set tab in the slot of the first of them; the set becomes active and
 *  `showing` is the position of the tab that WAS active, so the reader lands
 *  on the item they were looking at. Null when there is nothing to fold
 *  (fewer than two of that kind, or the active tab is not foldable). */
export function foldPlan(
  state: PanelState
): { next: PanelState; set: SetArtifact; showing: number } | null {
  const active = state.artifacts[state.activeIndex];
  if (!active || !isFoldableKind(active.kind)) return null;
  const group = tabsOfKind(state.artifacts, active.kind);
  if (group.length < 2) return null;
  const items = group.map((g) => g.artifact);
  const set: SetArtifact = { kind: "set", label: setLabelFor(items), items };
  const first = group[0].index;
  const removed = new Set(group.map((g) => g.index));
  const artifacts: Artifact[] = [];
  state.artifacts.forEach((a, i) => {
    if (i === first) artifacts.push(set);
    else if (!removed.has(i)) artifacts.push(a);
  });
  return {
    next: { artifacts, activeIndex: artifacts.indexOf(set) },
    set,
    showing: Math.max(0, items.indexOf(active as SetItem)),
  };
}

/** THE SPLIT (Ky's unfoldSet): the set at `index` back into one tab per
 *  item, in place, the item that was showing active. Null when `index` is
 *  not a set. */
export function unfoldPlan(state: PanelState, index: number, showing: number): PanelState | null {
  const set = state.artifacts[index];
  if (!set || set.kind !== "set") return null;
  const artifacts = [...state.artifacts.slice(0, index), ...set.items, ...state.artifacts.slice(index + 1)];
  return { artifacts, activeIndex: index + setPosition(showing, set.items.length) };
}

/** A stored position clamped into the set's membership (items can change
 *  under a live set — the agent re-shows a bigger batch). */
export function setPosition(raw: number | undefined, size: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0;
  return Math.min(Math.max(n, 0), Math.max(size - 1, 0));
}

/** Wrap-around step (Ky's `go`): `← ` from the first lands on the last. */
export function stepPosition(current: number, dir: 1 | -1, size: number): number {
  if (size <= 0) return 0;
  return (((current + dir) % size) + size) % size;
}

/** Every leaf artifact of a strip — a set's members counted, the set itself
 *  not. What "is X open anywhere" questions walk. */
export function flattenArtifacts(artifacts: readonly Artifact[]): Artifact[] {
  const out: Artifact[] = [];
  for (const a of artifacts) {
    if (a.kind === "set") out.push(...a.items);
    else out.push(a);
  }
  return out;
}

// ── The agent's sets (the `view` tool's `show` with `set:`) ─────────────────
// The server writes `sets.json` in the thread dir — `{version:1, sets:[{id,
// label, ids, builtAt}]}` newest first — and App's view-intent poll reads it
// beside the views/ listing: an id not seen before opens ONE set tab of those
// views in the preview slot. Caps mirror the server's (SET_CAP / SET_ITEM_CAP).

export type ThreadSet = { id: string; label: string; ids: string[]; builtAt: string };

const SET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Tolerant parse: junk → no sets; a broken entry drops alone; member ids
 *  outside the view-id alphabet drop alone; a set left with no members drops. */
export function parseSetsFile(raw: string): ThreadSet[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
  const list = (data as { sets?: unknown }).sets;
  if (!Array.isArray(list)) return [];
  const out: ThreadSet[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !SET_ID_RE.test(e.id) || seen.has(e.id)) continue;
    if (!Array.isArray(e.ids)) continue;
    const ids: string[] = [];
    for (const id of e.ids) {
      if (typeof id === "string" && SET_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
      if (ids.length >= SET_ITEM_CAP) break;
    }
    if (ids.length === 0) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      label: typeof e.label === "string" && e.label.trim().length > 0 ? e.label.trim().slice(0, SET_LABEL_CAP) : `${ids.length} ${setNounFor("view", ids.length)}`,
      ids,
      builtAt: typeof e.builtAt === "string" ? e.builtAt : "",
    });
  }
  return out;
}

/** The artifact a thread set opens as: one set tab of view artifacts. */
export function setArtifactFor(threadId: string, set: ThreadSet): SetArtifact {
  return {
    kind: "set",
    label: set.label,
    items: set.ids.map((viewId) => ({ kind: "view" as const, threadId, viewId })),
  };
}
