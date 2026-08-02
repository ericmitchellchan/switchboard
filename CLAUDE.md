# Switchboard

## Project Overview
Personal workstation desktop app: tabbed terminal multiplexer for AI coding agent sessions (split panes, PTY management, agent status detection, auto-task extraction) plus route-switched Knowledge Base, diagram, and repo Explorer screens with durable agent threads, and a per-tab artifact panel that keeps a doc/wireframe/diagram/repo file co-present with the running shell. Built with Tauri v2 + React 18 + xterm.js v5.

## Architecture

```
src/
├── App.tsx                    → Root orchestrator (hooks + components + lifecycle)
├── types.ts                   → Core interfaces (Session, AgentStatus, Task, Config, etc.)
├── components/
│   ├── TerminalPane.tsx         → xterm.js wrapper, PTY data flow, status/task wiring
│   ├── TabBar.tsx               → Tab bar with scroll, rename, close, group dividers + the right-end artifact-panel button
│   ├── PaneContainer.tsx        → Recursive binary tree pane renderer
│   ├── PaneDivider.tsx          → Drag-to-resize between panes
│   ├── SessionHeader.tsx        → Per-session info bar (repo, cwd, restart)
│   ├── TaskSidebar.tsx          → Auto/manual task list (full/collapsed/hidden; terminal screen only)
│   ├── SearchBar.tsx            → Ctrl+F terminal search
│   ├── Composer.tsx             → THE COMPOSER (increment D): per-pane prose input at the bottom of a terminal pane — Enter sends, Shift+Enter newline, ↑/↓ send history, no paste handler (dictation)
│   ├── StatusBar.tsx            → Bottom bar (task count, session count, update chip)
│   ├── SideMenu.tsx             → Left navigator menu (Ctrl+Shift+B / wordmark click): threads + inline KB + explorer trees
│   ├── ThreadsSection.tsx       → Thread rows in the side menu (status dot, revive chip, `⋯` menu); recent 8 ACTIVE + `See all (N)`
│   ├── ThreadsScreen.tsx        → Thread HISTORY screen (`{screen:"threads"}`): Active | Archived tabs, repo + last activity + filter + per-row revive/unarchive + `⋯` menu
│   ├── ThreadRowMenu.tsx        → The shared `⋯` row menu (portalled, keyboard-navigable) + the inline title editor, used by BOTH thread surfaces
│   ├── KbTreeSection.tsx        → Side-menu KB doc tree (inline navigator) + shared tree row primitives
│   ├── ExplorerTreeSection.tsx  → Side-menu registry projects + IDE-style inline file tree
│   ├── NewThreadDialog.tsx      → Repo picker for creating a thread
│   ├── NewSessionDialog.tsx     → Repo picker / new session config (lazy-loaded)
│   ├── ExplorerView.tsx         → Explorer screen body: breadcrumb + file viewer (tree lives in the side menu); repo files route through the SHARED ArtifactBody kind switch
│   ├── ArtifactPanel.tsx        → Artifact panel host: right-side co-present surface inside the terminal screen (divider, tab strip + `+`, header chrome, docked/overlay); hosts DocView / FileViewer, renders no viewer of its own
│   ├── ArtifactPicker.tsx       → The `+` picker: filterable KB docs + registry projects, repo files browsed one directory at a time (explorerList)
│   ├── UpdateChip.tsx           → In-app updater chip (consent-based install flow)
│   ├── ConfirmDialog.tsx        → Modal confirm (close/destructive actions); `enterConfirms={false}` unbinds Enter for thread delete
│   ├── kb/                      → Knowledge Base screen views
│   │   ├── ArtifactBody.tsx       → THE kind switch (docKind → renderer) shared by DocView and the Explorer's FileViewer; hosts differ only in the fallback
│   │   ├── DocView.tsx            → KB doc load policy (2500ms active-gated poll) + the KB's fallback for unrendered kinds
│   │   ├── MarkdownDoc.tsx        → THE markdown path: one unified pipeline + typography + the link-activation policy (KB docs and repo READMEs alike)
│   │   ├── WireframeView.tsx      → Sandboxed iframe wireframe rendering + pin/note markup (takes an Artifact + content + the host's `onReload`; no KB coupling)
│   │   ├── ComponentPreview.tsx   → .jsx/.tsx preview shell: lazy-loads the compiler, feeds the compiled document to WireframeView's iframe
│   │   └── DiagramView.tsx        → Mermaid diagram surface (lazy chunk, pan/zoom)
│   ├── icons.tsx                → THE icon module: hand-written inline SVG (folder/folder-open/file/panel/localhost/chevrons + the row-menu set: ellipsis/open/rename/archive/unarchive/trash) shared by both trees, the picker, the panel header, the tab-bar button and the thread row menu
│   ├── Toast.tsx                → Notification toasts
│   └── PulsingDot.tsx           → Animated status indicator
├── hooks/
│   ├── useSessions.ts           → Session CRUD, tab switching, refs for stale-closure safety
│   ├── usePaneLayout.ts         → Binary tree state (split/close/resize/focus)
│   ├── useConfig.ts             → Load config from Rust backend
│   ├── useKeyboardShortcuts.ts  → Global + xterm key handler
│   ├── useTasks.ts              → Task list with dedup + auto-resolve
│   ├── useSidebarState.ts       → Sidebar visibility cycle (full/collapsed/hidden)
│   └── useToasts.ts             → Toast queue with auto-dismiss
├── lib/
│   ├── terminalRegistry.ts      → Keep-alive registry: xterm instances survive unmount, once-only PTY wiring, WebGL attach/detach, spawn generations
│   ├── terminalLifecycle.ts     → Pure ownership/steal/park/revive rules for the registry (owner tokens)
│   ├── terminal.ts              → Facade over the registry + measurement/serialize/scroll/fit helpers
│   ├── resizePolicy.ts          → Settled resize policy (grow-only width, snapshot-reflow on widen, mid-stream defer)
│   ├── fitQueue.ts              → Debounced per-session fit pipeline (show/resize coalescing)
│   ├── route.ts                 → URL-backed route model + nav store (screen switching)
│   ├── threadStore.ts           → Durable agent threads: records (explicit + promoted), revive decisions, shell-ready wait, history selection/filter/relative-time helpers, action bridge
│   ├── composer.ts              → Composer wire format (`composeWrite`: single line vs bracketed paste), send-history + caret rules, and the per-session visibility/draft/history store. PURE helpers + module singleton
│   ├── threadPromotion.ts       → Tab→thread promotion (increment C): what a discovery MEANS for the thread list (`planPromotion`) + the poll pass. PURE decision + injected IO; observe-only
│   ├── panelStore.ts            → Artifact panel state (per-TAB `PanelState` = artifact strip + activeIndex, global width), strip ops (`appendOrActivate`/`closeArtifactIn`), layout/drag math, header breadcrumbs, the shared ICON NAMES (`FILE_ICON`/`folderIcon`/`describeArtifact().icon` — drawn by components/icons), open-in-panel decision (`decideOpen`/`fullWidthRoute`), toggle memory, `+`-picker request, active-tab + send-to-thread bridges
│   ├── agentContext.ts          → Agent context injection (T8): shell-safe sanitizer + the two seam builders (`buildSpawnContext`, `buildSendReference`) + KB-root cache. PURE — the effectful ends live in App/threadStore/panelStore
│   ├── kb.ts                    → KB doc list/read data layer (poll while active)
│   ├── pins.ts                  → Wireframe pin/note file model (pure ops over pins JSON) + `pinTargetFor` (KB sidecar vs the hidden `_repo-pins/` mirror for repo files)
│   ├── componentPreview.ts      → LAZY chunk: TypeScript transpile + inlined React UMD → a self-contained preview document (never imported statically)
│   ├── pinsStore.ts             → ONE shared `.pins.json` record per sidecar (refcounted mounts, one debounced writer, injected IO) — the panel and the KB screen can host the same wireframe at once
│   ├── explorer.ts              → Explorer data layer (projects/listing/read via IPC, live-thread annotation)
│   ├── diagramZoom.ts           → Pure pan/zoom math for the diagram surface
│   ├── diagramMeta.ts           → Diagram metadata parsing (.mmd frontmatter/title)
│   ├── updaterState.ts          → Updater state machine (check/consent/progress/install)
│   ├── statusDetector.ts        → Agent status state machine (pattern match + dwell hysteresis)
│   ├── taskDetector.ts          → Auto-detect build/test/git errors from PTY output
│   ├── paneLayout.ts            → Immutable binary tree operations
│   ├── workspace.ts             → Periodic save/restore to localStorage + disk (v2 adds threads, v3 adds per-tab `panels` + `panelWidth`, v4 makes each panel a tab strip)
│   ├── ipc.ts                   → Tauri invoke() wrappers for all backend commands
│   ├── statusConfig.ts          → Status colors, icons, labels (single source of truth)
│   ├── logger.ts                → Frontend structured logging
│   ├── updater.ts               → Auto-update check
│   └── export.ts                → Export session to file
└── lib/*.test.ts              → 18 Vitest test suites (paneLayout, statusDetector, taskDetector, resizePolicy, terminalLifecycle, route, threadStore, threadPromotion, panelStore, agentContext, composer, kb, pins, pinsStore, componentPreview, explorer, diagramZoom, updaterState)

src-tauri/
├── src/
│   ├── main.rs                  → Entry point (calls lib::run)
│   ├── lib.rs                   → Tauri commands, plugin setup, event dispatch
│   ├── config.rs                → Config load from %APPDATA%/switchboard/config.json
│   ├── kb.rs                    → KB backend: traversal-guarded doc tree/read over the personal-kb checkout
│   ├── explorer.rs              → Explorer backend: registry.json-driven repo listing/read (same guard posture)
│   ├── power.rs                 → Win32 power monitor (sleep/wake events)
│   ├── discovery.rs             → Claude discovery: PTY shell pid → descendant pids → `~/.claude/sessions/<pid>.json`. Toolhelp snapshot, freshness + ambiguity guards, observe-only
│   └── pty/
│       ├── mod.rs               → PtyManager: session registry + reader thread
│       └── session.rs           → PtySession: portable-pty wrapper + Drop cleanup
├── tauri.conf.json              → Window, bundle, updater, identifier config
├── capabilities/default.json    → Tauri ACL permissions
└── build.rs                     → Windows manifest (UTF-8 codepage)

Root:
├── dev.ps1                      → Dev script (sets MSVC env, runs pnpm tauri dev)
├── build.ps1                    → Build script (-Full for NSIS installer, default = cargo check)
├── .nightshift.json             → Nightshift stop hook config
└── RELEASE.md                   → Release & signing process
```

## Data Flow

PTY output (backend → frontend):
```
Shell → portable-pty → base64 encode → Tauri event (per-session) → decode → xterm.js
                                                                       ↓
                                                           statusDetector (onWriteParsed)
                                                           taskDetector (raw UTF-8 text)
```

User input (frontend → backend):
```
Keyboard → xterm onData → invoke("write_to_session") → PTY stdin → shell
```

Clipboard paste (OS-level):
```
Ctrl+V → global-shortcut (Win32) → Rust reads clipboard → "clipboard-paste" event → terminal.paste()
```

## Commands

```bash
pnpm test              # Vitest (single run)
pnpm test:watch        # Vitest (watch mode)
.\dev.ps1              # Dev mode (Tauri + Vite HMR)
.\build.ps1            # Quick cargo check
.\build.ps1 -Full      # Production NSIS installer
```

## Conventions

- **Module-level Maps** for terminal instances and detector state — survive React remounts, avoid re-renders
- **Refs over state** for values used in async PTY callbacks (stale closure prevention)
- **Immutable tree ops** for pane layout — pure functions in `paneLayout.ts`, React state in `usePaneLayout.ts`
- **Buffer-based status detection** via `onWriteParsed` — preferred over raw chunk parsing for accuracy
- **Dwell-time hysteresis** for status transitions — prevents flickering on rapid output
- **Fingerprint dedup** for auto-detected tasks — same error doesn't create duplicate tasks
- **Base64 encoding** for PTY ↔ frontend data — safe for JSON serialization over Tauri events
- **WebGL per attach/detach** — every ATTACHED, visible pane gets its own WebGL context; contexts are dropped on detach/park/CSS-hide and NEVER exist for hidden terminals (keep-alive root, hidden tabs, non-terminal screens); re-show re-enables + repaints
- **Keep-alive registry, never replay** — xterm instances survive React unmount in a hidden DOM root and keep receiving PTY writes; remount adopts the same element back (a snapshot/replay cycle garbles claude's repaint-based TUI). Exit never disposes; only session close does
- **Spawn generations** — every PTY event carries the spawn's generation; the expectation is bumped BEFORE each restart invoke so a dying old reader thread's output/exit events are dropped, never rendered
- **Grow-only resize policy** — terminal cols never shrink on pane narrow (horizontal scroll instead); widen = snapshot-reflow; mid-stream grid changes deferred until output settles (`resizePolicy.ts`)
- **Threads** — a thread binds a tab to a claude conversation via `chatSessionId` + `chatStarted` (UI hint); the revive `--resume` vs `--session-id` choice comes from disk GROUND TRUTH (`claude_session_exists`), never from the hint. `chatSessionId` is MINTED by the explicit `+ new thread` path and DISCOVERED by the promotion path — same field, so revive needs no special-casing
- **Tab/thread parity — promote on claude, never on tab creation** — a plain `Ctrl+T` shell gets no record (history would fill with throwaway `git status` shells, and a revive chip on a never-persisted session lies). The moment a claude conversation is actually running in ANY tab, that tab is promoted to a thread. Detection is a PROCESS-TREE walk (`discovery.rs`): the PTY's shell pid → descendants → whichever owns a `~/.claude/sessions/<pid>.json`, which keys on the claude PID and carries the conversation uuid + cwd. Not cwd/start-time matching — that cannot tell two tabs in the same repo apart. Two guards are load-bearing: a candidate must have STARTED AFTER our shell (Windows pid reuse makes unrelated processes look like descendants), and AMBIGUITY REFUSES (two claudes under one tab, or one claude under two tabs → promote NEITHER and log). The whole path is OBSERVE-ONLY: a process snapshot plus JSON reads, never a `writeToSession`. Polling stops entirely when every tab is bound
- **Threads list = recent 8 + `See all (N)`** — the 218px rail caps at `MENU_THREAD_LIMIT`, EXCEPT that live threads are never truncated out (`selectMenuThreads` widens the slice rather than hiding a conversation you are having). The overflow row and the section label both open `{screen:"threads"}`, the param-less, deep-linkable history screen
- **A plain `claude` in a bound tab starts a NEW thread** — increment C ADOPTED the restarted conversation into the existing record, which silently rebound the row to a fresh empty conversation and forgot the old uuid (the only thing that made it revivable). Now `planPromotion` returns `supersede`: the old thread is UNBOUND (uuid intact, still in the history, still revivable) and a second record is created for the tab, through the same `createThread` a fresh promotion uses. Idempotency is unchanged where it matters — a re-detected conversation (same uuid) never produces a second record — and both ambiguity refusals still hold. A tab may therefore accumulate several records over its life: a conversation and a shell are different things, and only one of them is durable
- **Archive is a state, delete is a loss, and the UI never confuses them** — `Thread.archivedAt` hides a thread from the rail, from the `See all (N)` count and from the history screen's Active tab; it appears under **Archived**, still persisted (through `sanitizeThread` → localStorage + disk), still revivable, unarchivable in one click. `isThreadArchived`/`activeThreads`/`archivedThreads` are THE predicates — the filter lives inside `selectMenuThreads` so the rail and its count cannot disagree. Promotion deliberately matches archived records too (otherwise a rediscovered conversation would mint a duplicate), and `markThreadLaunched` unarchives, because a running conversation is not "not now". DELETE, by contrast, is one dialog with Enter unbound and copy that states plainly that claude's transcript on disk is NOT deleted — only Switchboard's record and its revive affordance go
- **One shared record per `.pins.json`, never per mount** — the artifact panel and the keep-alive KB screen can host the SAME wireframe simultaneously (`display:none` is not unmount). Component-local pin state meant two copies and a silent last-writer-wins clobber, so all mounts go through `pinsStore` (refcounted subscribe, one debounced writer per sidecar, flush on last release). `pins.ts` stays pure and owns the file's contents; the store owns sharing and IO
- **ONE kind switch, and the KB is not special** — `docKind` (lib/kb.ts) is the kind vocabulary and `ArtifactBody` is the ONLY place that maps a kind to a renderer. The Explorer's `FileViewer` used to know just `.md` and `<pre>` everything else, so an HTML mockup living in a REPO rendered as source in both the panel and the Explorer screen while the identical file in the KB rendered fine. Renderers therefore take an `Artifact` + its CONTENT, never a path they load themselves: the HOST owns loading policy (KB = useKbDoc's 2500ms active-gated poll, repo = a one-shot `explorerRead`), and the only per-host difference left is the FALLBACK for kinds nothing renders (KB: a placeholder note; repo: the file's source)
- **Repo markup annotates into the KB, never into the repo** — `kb_write_doc` is guarded to the KB root and repos stay clean, so a repo file's pins are MIRRORED to `_repo-pins/<project>/<repo-rel-dir>/.pins.json` (`pins.pinTargetFor`). The `_` root hides the whole tree from the KB listing (kb.rs `skip_dir` + `buildKbTree`), the scheme is collision-free (unique project keys; multi-repo projects carry the repo name as their first path component) and reversible. It is the SAME per-folder sidecar shape as a KB doc, so the one-record-per-sidecar store is still the only pins writer
- **The wireframe toolbar's ⟳ is the HOST's read, forced** — a renderer still never loads a path itself: `onReload` is threaded DocView/FileViewer → ArtifactBody → WireframeView (and through ComponentPreview, which just recompiles the new source). KB docs re-run `useKbDoc`'s effect through a nonce, so the forced read is the same read and the same `mergeDocRead` fold the 2.5s poll uses (unchanged content → identity-equal state → no re-render); repo files re-run their one-shot `explorerRead` the same way. It is shown for BOTH kinds on purpose — a repo read never polls and a KB poll pauses while its host is hidden — and it cannot disturb zoom or pins, which are keyed on the artifact and held in `pinsStore`, not derived from content
- **Preview dependencies are lazy or they are not added** — mermaid (DiagramView) and the JSX/TSX compiler (`lib/componentPreview.ts`: TypeScript + React's UMD builds) are reachable ONLY through a module-level `import()`. `pnpm build` is the check: `mermaid.core-*.js` and `componentPreview-*.js` must be their own chunks and `main` must contain neither. Untrusted component code is COMPILED in the app and EXECUTED only inside WireframeView's `allow-scripts`/no-`allow-same-origin` iframe
- **Artifact panel is per-TAB, never per-pane** — `panelStore` keys on the TAB's `activeSessionId`, not `effectiveActiveSessionId` (the focused pane). A split terminal + panel just shares the width: moving pane focus never swaps or blanks the panel, and persistence never forks one binding per pane
- **Panel geometry is measured against the WORKSPACE container** — App nests `[pane tree | divider | ArtifactPanel]` in a container that EXCLUDES the TaskSidebar, so the panel's right edge is the container's right edge. Every width rule in `panelStore` (`panelLayoutFor`, `panelWidthFromDrag`, the MIN_TERMINAL_WIDTH floor, overlay's `right: 0`) assumes that nesting; re-parenting the panel next to the sidebar makes all of them wrong by exactly the sidebar's width (0/38/280px)
- **Two honest agent-context seams, and no third** — (1) SPAWN-TIME: `--append-system-prompt "<one-liner>"` on the thread launch line, re-derived from the target tab's panel at EVERY spawn so stale context dies with the session; a fresh thread inherits the panel it was launched from so the sentence is true. (2) SEND-TO-THREAD: `→ thread` TYPES a reference into the terminal with NO trailing `\r` — the Enter is the user's. Anything that injects mid-conversation or presses Enter for the user is out of scope. Both strings go through `agentContext.sanitizeForTypedLine` (control chars, `" \ $ % \``) because they land on a shell line
- **The composer sends prose, and multi-line goes as ONE paste** — `composer.composeWrite` is THE wire-format decision and the only thing about the composer that is hard to get right: single-line content is `<text>` + one CR (`\r`), multi-line is `ESC[200~<text, newlines → CR>ESC[201~` followed by ONE trailing CR. Without the bracketing each embedded newline is its own Enter and a 4-line message becomes 4 submissions; the line breaks INSIDE the markers are CR (exactly what xterm's `prepareTextForTerminal` does), so a composer send and a Ctrl+V paste are byte-identical to the TUI, and the one CR outside the end marker is the only submit. Control characters are STRIPPED from composed text — a literal `ESC[201~` in dictated or pasted text would break OUT of the paste — which is also Decision 3: Ctrl+C, Esc and arrow-key TUI navigation stay the terminal's job and nothing proxies them. Empty/whitespace-only is a no-op, never a bare Enter
- **Composer visibility is DERIVED from promotion, never re-detected** — a pane shows a composer when its session is bound to a thread that is in threadStore's `launched` set (increment C's signal, set by both the explicit launch and the promotion pass, cleared on PTY exit / tab close). Ctrl+Shift+M stores a per-SESSION override that wins in both directions (hide it on a live conversation; force one onto a plain shell) and lasts the app's lifetime only — nothing composer-related is persisted. Per-PANE, deliberately unlike the per-TAB artifact panel: the composer TYPES INTO A SESSION, so in a split it must address the focused pane's. It adds NO resize logic — showing it changes the container height and the pane's existing ResizeObserver → fitQueue → grow-only policy handles it exactly like a divider drag
- **`chatStarted` on a composer send is EXPLICIT** — `writeToSession` bypasses the input detector on purpose (feeding IPC writes back in re-opens the false-positive class T5 removed), so the composer calls `markChatStarted` directly on a successful send and flushes to disk. The detector is untouched: typing into the terminal still flips the flag through it. A FAILED write leaves the text in the box and surfaces the failure — a message is never silently swallowed
- **No paste handler on the composer, ever** — Wispr Flow dictation injects by PASTING. xterm's clipboard path needed explicit rules to avoid double-pasting because it INTERCEPTS; the composer's `<textarea>` does not, so the native paste (or App's OS-level `clipboard-paste` → `execCommand("insertText")` route for simulated keystrokes) inserts exactly once. Adding an `onPaste` would re-create the double-insert bug
- **Workspace v4** — `panels: Record<sessionId, PanelState>` (`{artifacts, activeIndex}`) + `panelWidth` ride inside the same localStorage blob; the v3→v4 migration wraps each single `Artifact` into a one-tab strip. On restore, keys remap through the session idMap and unmapped ones are DROPPED (a panel binding without its tab is meaningless, unlike a thread, which is severed and stays revivable). Records stay LEAN via `sanitizeArtifact`/`sanitizePanelState` on every load path
- **One artifact, one tab** — a panel holds MANY artifacts; re-opening one already in the strip ACTIVATES its tab rather than appending a duplicate (compared by `artifactIdentity`: kind + project + path). Same lesson as the shared pins store — two tabs naming one document would mean two records of everything downstream. A strip is never empty: closing the last tab removes the session's panel, and Ctrl+Shift+P hides/restores the WHOLE strip (the strip's own `×` is what closes one artifact)
- **Lazy loading** — NewSessionDialog loaded via `React.lazy` + Suspense only when repos configured; mermaid is its own lazy chunk (DiagramView)
- **`portable-pty = "=0.8.1"`** — pinned, v0.9 has Windows ConPTY bug
- **CLAUDECODE env var** stripped from PTY sessions

## Nightshift Integration

Nightshift is a Claude Code Stop hook for automated test verification (repo: `ericmitchellchan/nightshift`).

- **Hook path**: `.claude/settings.json` → Stop hook → `C:/Users/ericm/projects/nightshift/scripts/verify-tests.py`
- **Config**: `.nightshift.json` in project root — `test_command: "pnpm test"`, watches `.ts`, `.tsx`, `.rs`
- **Behavior**: When agent finishes and watched files were modified, the hook runs tests
- **On failure**: Agent is blocked (exit code 2) and **must fix before finishing**
- Do not bypass — fix the failing tests

## Known Issues

These are recurring problem areas from git history — be aware when working in these areas:
- **Viewport scroll desync** on tab switch with new content (multiple prior fixes)
- **WebGL texture corruption** after sleep/wake cycle
- **Status detection false positives** from ANSI escape sequences in PTY output
- **Stale closures** in React hooks with async PTY callbacks (use refs)
- **Black screen on alternate buffer switch** (e.g., vim/less opening in terminal)

## Key Docs

- `README.md` — Features, keyboard shortcuts, status indicator reference
- `RELEASE.md` — Release process, code signing, version bumping

## Keyboard Shortcuts

`src/hooks/useKeyboardShortcuts.ts` is the SOURCE OF TRUTH — this table and README's
are reconciled against it. Adding a chord means updating both.

| Action | Shortcut |
|--------|----------|
| New tab | Ctrl+T |
| Close tab + session | Ctrl+W |
| Close pane only | Ctrl+Shift+W |
| Prev/next tab | Ctrl+[ / Ctrl+] |
| Move tab left/right | Ctrl+Shift+[ / Ctrl+Shift+] |
| Jump to tab | Ctrl+1–9 |
| Cycle task sidebar (full/collapsed/hidden) | Ctrl+B |
| Toggle side menu (navigator) | Ctrl+Shift+B |
| Toggle artifact panel (active tab) | Ctrl+Shift+P |
| Toggle composer (focused pane) | Ctrl+Shift+M |
| Toggle floating PiP window | Ctrl+Shift+O |
| Export session scrollback | Ctrl+Shift+S |
| Terminal search | Ctrl+F |
| Split horizontal | Ctrl+\\ |
| Split vertical | Ctrl+- |
| Move pane focus | Ctrl+Alt+Arrow |
| Reload app window | F5 or Ctrl+Shift+R |
| Copy selection / SIGINT | Ctrl+C |
| Paste into terminal | Ctrl+V |

Chord notes:
- **Ctrl+Shift+P moved PiP to Ctrl+Shift+O** (A2) — the two cannot share a chord.
- **Ctrl+Shift+W / Ctrl+Shift+S / Ctrl+Shift+O / Ctrl+Shift+[ ] / Ctrl+Alt+Arrow /
  Ctrl+- are keyboard-ONLY** — no button, hint or tooltip surfaces them anywhere in
  the UI. The StatusBar hint strip advertises Ctrl+T/W/[ ]/F/\\/1-9 as plain text plus
  FOUR clickable buttons: Ctrl+Shift+B menu, Ctrl+Shift+P panel (rendered only while
  the chord would do something), Ctrl+Shift+M composer (rendered whenever a session is
  focused — forcing a composer onto a plain shell is a supported state, so this toggle
  is never a no-op), and Ctrl+B tasks.
- **The TAB BAR carries the two surface buttons**: the SWITCHBOARD wordmark (left end)
  toggles the side menu, and the panel button (right end) toggles the artifact panel —
  or, on a tab whose panel is EMPTY, opens the `+` picker instead, because a toggle
  with nothing to show would be a dead affordance. That empty state is the only place
  the button diverges from Ctrl+Shift+P.
- **Ctrl+Shift+P reveals the terminal screen** when the route is elsewhere — the panel
  renders only there, so toggling from KB/Explorer would otherwise be invisible.
  Mirrors `applyOpenDecision`'s `revealTerminal`.
- **Ctrl+click** on a side-menu tree row inverts the open decision (panel ⇄ full
  width) — mouse, not keyboard; the rule lives in `panelStore.decideOpen`.

## Tracker & Knowledge Routing

- **Tracker**: Linear workspace `ericmitchell` (linear.app/ericmitchell). Personal Jira (ericmitchellchan.atlassian.net) was DEACTIVATED 2026-07 — never create/read tickets there.
- **Linear team**: SWIT (mirrors the old Jira key; old SWIT-x ticket refs are historical)
- **Tracker tools**: Linear MCP (`mcp__linear__*`, mcp.linear.app). `mcp__personal-jira__*` is DEAD — do not call it.
- **Board type**: Kanban
- **Knowledge layer**: chat-recall with `project="switchboard"`
- **NEVER use `mcp__team-knowledge__*` tools** — those are for Cadence Labs only

### Ticket Types
- **Epic**: Decomposition container — decomposes into Tasks
- **Task**: Unit of work — one agent, one deliverable, explicit file list
- **Bug**: Something broken found during work
- **Request**: Out-of-scope observation — "I noticed this but it's not my task." Agent creates it, does NOT act on it

### Orchestration Workflow

**Canonical spec**: `nightshift/docs/workflow-spec.md` — full 7-phase workflow (decomposition, review, relationships, execution, verification, exception handling, rollback).

#### Sub-Agent Rules
- Read the full ticket + all blocked-by and related tickets before starting
- **Ask, don't assume** — surface specific questions on the ticket, move to the next clear ticket
- Stay in scope — out-of-scope work becomes a **Request** ticket, not action
- Do not proceed on parts with unanswered **Open Questions**
- Paste context into tickets — do not link to files expecting agents to find them

#### When Things Go Wrong
- **Contract mismatch** (blocker output != expectation): Stop, comment on ticket, wait for orchestrator
- **Missing dependency** (not in any ticket): Stop, comment "Blocked — [thing] required for [reason]"
- **Design-level problem**: Create a Request ticket, orchestrator pauses epic
- **Persistent test failure**: Comment what was tried and why it failed, do not bypass the Stop hook

#### Execution Constraints
- No two Tasks modify the same file (read-only overlap is fine)
- Foundation first — shared types/utilities before features
- Convergence files (barrel exports, route configs) get a dedicated integration task that runs last
- Serial epics per-project; parallel across different projects is fine
- One task, one session — implement, verify, exit

## Agent Instructions

- Read existing code before modifying it.
- Run `pnpm test` before declaring work complete.
- Do not add features beyond what was asked.
- If tests fail, fix them — do not bypass the Stop hook.
- If you discover out-of-scope work, create a **Request** ticket — do NOT act on it.
