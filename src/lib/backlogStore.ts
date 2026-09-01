// THE BACKLOG (SWIT-64) — Eric's holding pen. "Backlog is normally a thought,
// a dump, an idea or something to investigate later. It can graduate to a
// ticket and/or spec and a knowledge base, and any item can be dumped into a
// thread to work on it. The to-do list holds an item before it goes to one of
// these locations." An item is `{text, project | none, stage, links}`: the
// project is a TAG (registry key) or nothing — "it might not be a project, it
// might be just a thought" — the stage says how far it has graduated, and the
// links say where (a ticket key, a spec path, the thread that worked it).
//
// ONE WRITER PER FILE, made structural (the pageStore lesson):
//   backlog.json        ← THIS module, through two narrow Rust commands with a
//                          fixed path (`read_backlog` / `write_backlog`, the
//                          latter shape-checked + capped). The APP is the only
//                          writer; the agent never touches it.
//   backlog-inbox.json  ← the MCP server's `backlog link` op APPENDS; the app
//                          TAKES the file (rename away + read + delete, in
//                          Rust) on its existing 5s pass and folds the entries
//                          in here (`applyInbox`), then rewrites backlog.json.
//                          Apply is IDEMPOTENT — links are a set per item — so
//                          an entry the server re-emits after a racing take
//                          is harmless.
// The app never creates a Linear ticket or a KB file: graduation happens in
// the thread, by the agent, and the inbox is how the agent tells the app what
// it made.
//
// Layout mirrors the repo's other stores: PURE ops first (tolerant parse, the
// item ops, the filter, the drain merge) with a Vitest file beside them, then
// the module singleton with INJECTED IO (`configureBacklogIO`), a debounced
// writer and the `useBacklog()` hook. Nothing here touches the terminal: a
// backlog change repaints the top bar's count and the dropdown, nothing else
// — the freeze rule is unreachable by construction.
//
// Caps mirror `src-tauri/src/lib.rs`'s BACKLOG_* — change one, change both.

import { useSyncExternalStore } from "react";

export const BACKLOG_ITEM_CAP = 500;
/** Code points, not bytes. */
export const BACKLOG_TEXT_CAP = 500;
export const BACKLOG_LINK_CAP = 8;
export const BACKLOG_REF_CAP = 500;
export const BACKLOG_PROJECT_CAP = 64;
export const BACKLOG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Home lists this many open items before `See all`. */
export const HOME_BACKLOG_LIMIT = 8;
/** The thread a `open in thread` creates is titled from this many chars. */
export const BACKLOG_TITLE_MAX = 40;
/** Debounce on the disk write (one write per burst of edits). */
export const BACKLOG_WRITE_DEBOUNCE_MS = 400;

export type BacklogStage = "backlog" | "ticket" | "spec" | "done";
export type BacklogLinkKind = "ticket" | "spec" | "thread";
export const BACKLOG_STAGES: readonly BacklogStage[] = ["backlog", "ticket", "spec", "done"];
export const BACKLOG_LINK_KINDS: readonly BacklogLinkKind[] = ["ticket", "spec", "thread"];

export type BacklogLink = { kind: BacklogLinkKind; ref: string };

export type BacklogItem = {
  id: string;
  text: string;
  /** Registry project key, or null = "just a thought". */
  project: string | null;
  stage: BacklogStage;
  links: BacklogLink[];
  createdAt: number;
  updatedAt: number;
};

export type BacklogFile = { version: 1; items: BacklogItem[] };

/** One queued link from the MCP server (`backlog-inbox.json`). */
export type BacklogInboxEntry = {
  id: string;
  itemId: string;
  kind: "ticket" | "spec";
  ref: string;
  threadId: string;
  at: string;
};

/** The project filter: every item, untagged items only, or one project. */
export type BacklogFilter = "all" | "none" | { project: string };

// ── Pure: parse + serialize ──────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const CONTROL_RE = /[\u0000-\u001F\u007F]/g;

function capPoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

/** A clean item text, or null when nothing usable is left. Control chars
 *  become spaces (an item is one line of prose), whitespace collapses, and the
 *  cap is by code point. */
export function normalizeBacklogText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const clean = text.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  if (clean.length === 0) return null;
  return capPoints(clean, BACKLOG_TEXT_CAP);
}

function normalizeProject(v: unknown): string | null {
  const p = str(v)?.trim() ?? "";
  if (p.length === 0) return null;
  return capPoints(p, BACKLOG_PROJECT_CAP);
}

function normalizeRef(v: unknown): string | null {
  const r = str(v)?.replace(CONTROL_RE, " ").trim() ?? "";
  if (r.length === 0) return null;
  return capPoints(r, BACKLOG_REF_CAP);
}

function parseLinks(v: unknown): BacklogLink[] {
  if (!Array.isArray(v)) return [];
  const out: BacklogLink[] = [];
  const seen = new Set<string>();
  for (const l of v) {
    if (!isRecord(l)) continue;
    const kind = l.kind;
    if (kind !== "ticket" && kind !== "spec" && kind !== "thread") continue;
    const ref = normalizeRef(l.ref);
    if (!ref) continue;
    const key = `${kind} ${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, ref });
    if (out.length >= BACKLOG_LINK_CAP) break;
  }
  return out;
}

/** Tolerant read of backlog.json: a broken item drops ALONE, never the file;
 *  "" and junk are the empty backlog. Duplicate ids keep the first. Order is
 *  preserved as stored (newest first is the convention `addItem` keeps). */
export function parseBacklog(raw: string): BacklogItem[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = isRecord(data) && Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
  const out: BacklogItem[] = [];
  const seen = new Set<string>();
  for (const it of list) {
    if (!isRecord(it)) continue;
    const id = str(it.id);
    if (!id || !BACKLOG_ID_RE.test(id) || seen.has(id)) continue;
    const text = normalizeBacklogText(it.text);
    if (!text) continue;
    const stage: BacklogStage = (BACKLOG_STAGES as readonly string[]).includes(String(it.stage))
      ? (it.stage as BacklogStage)
      : "backlog";
    const createdAt = num(it.createdAt) ?? 0;
    seen.add(id);
    out.push({
      id,
      text,
      project: normalizeProject(it.project),
      stage,
      links: parseLinks(it.links),
      createdAt,
      updatedAt: num(it.updatedAt) ?? createdAt,
    });
    if (out.length >= BACKLOG_ITEM_CAP) break;
  }
  return out;
}

export function serializeBacklog(items: readonly BacklogItem[]): string {
  const file: BacklogFile = { version: 1, items: items.slice(0, BACKLOG_ITEM_CAP) };
  return JSON.stringify(file, null, 2);
}

/** Tolerant read of the inbox the server appends to. */
export function parseBacklogInbox(raw: string): BacklogInboxEntry[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = isRecord(data) && Array.isArray(data.entries) ? data.entries : Array.isArray(data) ? data : [];
  const out: BacklogInboxEntry[] = [];
  for (const e of list) {
    if (!isRecord(e)) continue;
    const itemId = str(e.itemId);
    const ref = normalizeRef(e.ref);
    if (!itemId || !BACKLOG_ID_RE.test(itemId) || !ref) continue;
    if (e.kind !== "ticket" && e.kind !== "spec") continue;
    out.push({
      id: str(e.id) ?? "",
      itemId,
      kind: e.kind,
      ref,
      threadId: str(e.threadId) ?? "",
      at: str(e.at) ?? "",
    });
  }
  return out;
}

// ── Pure: item ops (every op returns a NEW array; unchanged input → same array) ──

let idCounter = 0;

/** A new item id: time-based, unique within a session, id-alphabet only. */
export function newBacklogId(now: number): string {
  idCounter = (idCounter + 1) % 1296;
  return `b${now.toString(36)}${idCounter.toString(36).padStart(2, "0")}`;
}

export type AddItemResult = { items: BacklogItem[]; item: BacklogItem | null };

/** Prepend a new item (newest first). Empty text or a full backlog adds
 *  nothing and says so through `item: null`. */
export function addItem(
  items: readonly BacklogItem[],
  text: string,
  project: string | null,
  now: number,
  id: string = newBacklogId(now)
): AddItemResult {
  const clean = normalizeBacklogText(text);
  if (!clean || items.length >= BACKLOG_ITEM_CAP || !BACKLOG_ID_RE.test(id)) {
    return { items: items as BacklogItem[], item: null };
  }
  if (items.some((i) => i.id === id)) return { items: items as BacklogItem[], item: null };
  const item: BacklogItem = {
    id,
    text: clean,
    project: normalizeProject(project),
    stage: "backlog",
    links: [],
    createdAt: now,
    updatedAt: now,
  };
  return { items: [item, ...items], item };
}

function update(
  items: readonly BacklogItem[],
  id: string,
  now: number,
  fn: (item: BacklogItem) => BacklogItem | null
): BacklogItem[] {
  const index = items.findIndex((i) => i.id === id);
  if (index < 0) return items as BacklogItem[];
  const next = fn(items[index]);
  if (next === null || next === items[index]) return items as BacklogItem[];
  const out = items.slice();
  out[index] = { ...next, updatedAt: now };
  return out;
}

export function setStage(items: readonly BacklogItem[], id: string, stage: BacklogStage, now: number): BacklogItem[] {
  return update(items, id, now, (it) => (it.stage === stage ? it : { ...it, stage }));
}

/** Add a link; a duplicate (same kind + ref) or a full link list leaves the
 *  item untouched — links are a SET, which is what makes the inbox drain
 *  idempotent. */
export function addLink(items: readonly BacklogItem[], id: string, link: BacklogLink, now: number): BacklogItem[] {
  const ref = normalizeRef(link.ref);
  if (!ref || !BACKLOG_LINK_KINDS.includes(link.kind)) return items as BacklogItem[];
  return update(items, id, now, (it) => {
    if (it.links.some((l) => l.kind === link.kind && l.ref === ref)) return it;
    if (it.links.length >= BACKLOG_LINK_CAP) return it;
    return { ...it, links: [...it.links, { kind: link.kind, ref }] };
  });
}

/** GRADUATE: record where the item went (a ticket key / a spec path) and
 *  move a plain backlog item to that stage. An item that already graduated
 *  keeps its stage (a spec'd item that also gets a ticket stays `spec`; a
 *  done item stays done) — the link is still recorded. */
export function graduate(
  items: readonly BacklogItem[],
  id: string,
  kind: "ticket" | "spec",
  ref: string,
  now: number
): BacklogItem[] {
  const linked = addLink(items, id, { kind, ref }, now);
  const item = linked.find((i) => i.id === id);
  if (!item || item.stage !== "backlog") return linked;
  return setStage(linked, id, kind, now);
}

export function setProject(items: readonly BacklogItem[], id: string, project: string | null, now: number): BacklogItem[] {
  const next = normalizeProject(project);
  return update(items, id, now, (it) => (it.project === next ? it : { ...it, project: next }));
}

export function removeItem(items: readonly BacklogItem[], id: string): BacklogItem[] {
  const out = items.filter((i) => i.id !== id);
  return out.length === items.length ? (items as BacklogItem[]) : out;
}

/** Fold the server's inbox in: every entry is a `graduate`. Idempotent —
 *  applying the same entries twice changes nothing the second time. Entries
 *  naming an item that no longer exists are dropped (a deleted item does not
 *  come back because an agent linked it). */
export function applyInbox(
  items: readonly BacklogItem[],
  entries: readonly BacklogInboxEntry[],
  now: number
): { items: BacklogItem[]; applied: number } {
  let cur = items as BacklogItem[];
  let applied = 0;
  for (const e of entries) {
    const next = graduate(cur, e.itemId, e.kind, e.ref, now);
    if (next !== cur) applied += 1;
    cur = next;
  }
  return { items: cur, applied };
}

// ── Pure: selectors ──────────────────────────────────────────────────────────

export function isOpen(item: BacklogItem): boolean {
  return item.stage !== "done";
}

/** Open items, newest first (by createdAt; ties keep stored order). */
export function openItems(items: readonly BacklogItem[]): BacklogItem[] {
  return items.filter(isOpen).slice().sort((a, b) => b.createdAt - a.createdAt);
}

export function doneItems(items: readonly BacklogItem[]): BacklogItem[] {
  return items.filter((i) => !isOpen(i)).slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function matchesFilter(item: BacklogItem, filter: BacklogFilter): boolean {
  if (filter === "all") return true;
  if (filter === "none") return item.project === null;
  return item.project === filter.project;
}

/** The dropdown's list under a filter: open items newest first; `done`
 *  folded separately by the caller (doneItems + the same filter). */
export function visibleItems(items: readonly BacklogItem[], filter: BacklogFilter): BacklogItem[] {
  return openItems(items).filter((i) => matchesFilter(i, filter));
}

/** Project tags PRESENT on items (for the filter chips), sorted. */
export function projectsPresent(items: readonly BacklogItem[]): string[] {
  const set = new Set<string>();
  for (const i of items) if (i.project) set.add(i.project);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** The quick-add tag chip cycles `none → <projects…> → none`. `current` not
 *  in the list (a project the registry dropped) cycles to the first. */
export function cycleProjectTag(current: string | null, projects: readonly string[]): string | null {
  if (projects.length === 0) return null;
  if (current === null) return projects[0];
  const i = projects.indexOf(current);
  if (i < 0) return projects[0];
  return i + 1 < projects.length ? projects[i + 1] : null;
}

export function threadLinkOf(item: BacklogItem): string | null {
  return item.links.find((l) => l.kind === "thread")?.ref ?? null;
}

/** The item a thread was opened from, if any (link kind `thread`). Re-derived
 *  at every spawn — a revived thread still knows its item. */
export function itemForThread(items: readonly BacklogItem[], threadId: string): BacklogItem | null {
  if (!threadId) return null;
  return items.find((i) => i.links.some((l) => l.kind === "thread" && l.ref === threadId)) ?? null;
}

/** What the thread opened from an item is titled: the first ~40 chars, cut
 *  at a word when one is near, `…` when cut. */
export function backlogThreadTitle(text: string): string {
  const clean = normalizeBacklogText(text) ?? "";
  const points = Array.from(clean);
  if (points.length <= BACKLOG_TITLE_MAX) return clean;
  let cut = points.slice(0, BACKLOG_TITLE_MAX).join("");
  const space = cut.lastIndexOf(" ");
  if (space >= BACKLOG_TITLE_MAX * 0.6) cut = cut.slice(0, space);
  return `${cut.trimEnd()}…`;
}

/** The stage glyph the rows draw (kit: a 14px text glyph in --text-dim). */
export function stageGlyph(stage: BacklogStage): string {
  switch (stage) {
    case "backlog":
      return "○";
    case "ticket":
      return "◔";
    case "spec":
      return "◑";
    case "done":
      return "✓";
  }
}

/** The link glyphs after a row's text, in link order, de-duplicated by kind. */
export function linkGlyphs(item: BacklogItem): Array<{ kind: BacklogLinkKind; glyph: string; ref: string }> {
  const out: Array<{ kind: BacklogLinkKind; glyph: string; ref: string }> = [];
  const seen = new Set<BacklogLinkKind>();
  for (const l of item.links) {
    if (seen.has(l.kind)) continue;
    seen.add(l.kind);
    out.push({ kind: l.kind, glyph: l.kind === "ticket" ? "#" : l.kind === "spec" ? "§" : "→", ref: l.ref });
  }
  return out;
}

// ── The module singleton ─────────────────────────────────────────────────────

export type BacklogIO = {
  read: () => Promise<string>;
  write: (text: string) => Promise<void>;
  /** TAKE the server inbox (rename away + read + delete): "" when empty. */
  takeInbox: () => Promise<string>;
};

let io: BacklogIO | null = null;
let items: BacklogItem[] = [];
let loaded = false;
let panelOpen = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writeOwed = false;
let lastWriteError: string | null = null;

export type BacklogView = {
  items: BacklogItem[];
  loaded: boolean;
  /** Items not `done` — the top bar's `To-dos · N`. */
  openCount: number;
  panelOpen: boolean;
  lastWriteError: string | null;
};

let view: BacklogView = { items, loaded, openCount: 0, panelOpen, lastWriteError };
const listeners = new Set<() => void>();

function publish(): void {
  view = { items, loaded, openCount: items.filter(isOpen).length, panelOpen, lastWriteError };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getView(): BacklogView {
  return view;
}

/** React hook: the backlog view, re-rendering on any change. */
export function useBacklog(): BacklogView {
  return useSyncExternalStore(subscribe, getView);
}

export function getBacklogItems(): BacklogItem[] {
  return items;
}

/** App wires the three IPC calls here before any render. Null leaves the
 *  store inert: edits stay in memory and nothing is written, so a wiring
 *  mistake cannot present an empty backlog and then overwrite the real one. */
export function configureBacklogIO(next: BacklogIO | null): void {
  io = next;
}

/** Load backlog.json once at boot. Edits made before the load landed (rare —
 *  the panel mounts after boot) are kept: disk first, then local items disk
 *  does not know, and the merge is written back. A failed read leaves the
 *  store UNLOADED so no write can clobber a file we could not read. */
export async function initBacklog(): Promise<void> {
  if (!io) return;
  let raw: string;
  try {
    raw = await io.read();
  } catch (err) {
    lastWriteError = `backlog unreadable: ${err instanceof Error ? err.message : String(err)}`;
    publish();
    return;
  }
  const disk = parseBacklog(raw);
  const local = items.filter((i) => !disk.some((d) => d.id === i.id));
  items = local.length > 0 ? [...local, ...disk] : disk;
  loaded = true;
  publish();
  if (local.length > 0) scheduleWrite();
}

function scheduleWrite(): void {
  // Never write before a successful load (Ky's todoStore rule): an empty
  // pre-load store must not overwrite the stored list.
  if (!loaded || !io) return;
  writeOwed = true;
  if (writeTimer !== null) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flushBacklogWrites();
  }, BACKLOG_WRITE_DEBOUNCE_MS);
}

/** Write now if a write is owed (the debounce's body; also the beforeunload
 *  flush). Serialised: a write in flight defers the next until it settles. */
let writing: Promise<void> | null = null;
export async function flushBacklogWrites(): Promise<void> {
  if (writing) {
    await writing;
  }
  if (!writeOwed || !io || !loaded) return;
  writeOwed = false;
  const text = serializeBacklog(items);
  writing = io
    .write(text)
    .then(() => {
      if (lastWriteError !== null) {
        lastWriteError = null;
        publish();
      }
    })
    .catch((err) => {
      // The edit is kept in memory and shown; the next edit retries.
      lastWriteError = `backlog not saved: ${err instanceof Error ? err.message : String(err)}`;
      writeOwed = true;
      publish();
    })
    .finally(() => {
      writing = null;
    });
  await writing;
}

function commit(next: BacklogItem[]): boolean {
  if (next === items) return false;
  items = next;
  publish();
  scheduleWrite();
  return true;
}

/** Quick-add. Returns the new item, or null when the text was empty / the
 *  backlog is full. */
export function backlogAdd(text: string, project: string | null): BacklogItem | null {
  const r = addItem(items, text, project, Date.now());
  if (r.item) commit(r.items);
  return r.item;
}

export function backlogSetStage(id: string, stage: BacklogStage): void {
  commit(setStage(items, id, stage, Date.now()));
}

export function backlogGraduate(id: string, kind: "ticket" | "spec", ref: string): void {
  commit(graduate(items, id, kind, ref, Date.now()));
}

export function backlogAddLink(id: string, link: BacklogLink): void {
  commit(addLink(items, id, link, Date.now()));
}

export function backlogSetProject(id: string, project: string | null): void {
  commit(setProject(items, id, project, Date.now()));
}

export function backlogRemove(id: string): void {
  commit(removeItem(items, id));
}

/** The item a thread was opened from (spawn-context lookup). */
export function backlogItemForThread(threadId: string): BacklogItem | null {
  return itemForThread(items, threadId);
}

/** The 5s pass: take the server inbox and fold it in. Costs one IPC call
 *  when there is nothing (the take returns "" for a missing file). Skipped
 *  until the backlog has loaded — entries would otherwise be applied to an
 *  empty list and lost. Never throws. */
let draining = false;
export async function drainBacklogInbox(): Promise<number> {
  if (!io || !loaded || draining) return 0;
  draining = true;
  try {
    const raw = await io.takeInbox();
    const entries = parseBacklogInbox(raw);
    if (entries.length === 0) return 0;
    const { items: next, applied } = applyInbox(items, entries, Date.now());
    commit(next);
    return applied;
  } catch {
    return 0;
  } finally {
    draining = false;
  }
}

export function setBacklogPanelOpen(open: boolean): void {
  if (panelOpen === open) return;
  panelOpen = open;
  publish();
}

export function toggleBacklogPanel(): void {
  setBacklogPanelOpen(!panelOpen);
}

export function isBacklogPanelOpen(): boolean {
  return panelOpen;
}

/** Test seam: back to the never-loaded state. */
export function __resetBacklogForTests(): void {
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = null;
  writeOwed = false;
  writing = null;
  draining = false;
  items = [];
  loaded = false;
  panelOpen = false;
  lastWriteError = null;
  io = null;
  publish();
}
