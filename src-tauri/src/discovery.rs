// Claude-conversation discovery (increment C) — how a PLAIN tab in which the
// user simply typed `claude` becomes a durable, revivable thread.
//
// ── The mechanism, and why this one ─────────────────────────────────────────
//
// Two candidates were on the table:
//
//   (A) walk the process tree from the PTY's shell down to a `claude` process,
//       then read that process's session file;
//   (B) match claude's own session files to a Switchboard tab by cwd + start
//       time.
//
// (B) cannot tell two tabs open in the SAME repo apart — cwd is not identity,
// and "started around the same time" is a guess. Under the standing rule
// (ambiguity must never guess) (B) would have to refuse the single most common
// case Eric actually hits.
//
// (A) is exact, and cheaper than it looks, because of one fact verified on this
// machine: claude writes `~/.claude/sessions/<PID>.json`, keyed by its own
// process id. So the join is
//
//     PTY shell pid → descendant pids → `<pid>.json` exists → that file's
//     `sessionId` IS the conversation uuid
//
// with no name matching (claude is `claude.exe` on Windows today and was
// `node.exe` before — matching on either would rot), no cwd heuristic and no
// time-window guess. A descendant that has a session file IS a claude; one that
// doesn't, isn't.
//
// Verified ancestry on this machine:
//   claude.exe(35860) <- powershell.exe(38792) <- switchboard.exe(14940)
// and 35860.json holds `{"pid":35860,"sessionId":"d283d6aa-…","cwd":"…"}`.
//
// ── The two guards ──────────────────────────────────────────────────────────
//
// 1. FRESHNESS. Windows recycles pids, and a recycled pid makes an unrelated
//    process look like our descendant (real chains observed on this machine
//    loop back on themselves for exactly that reason). A false descendant's
//    real parent held our shell's pid BEFORE we did, so it necessarily started
//    BEFORE our shell — requiring `startedAt >= shell spawn` eliminates it.
//    Session files also outlive their claude, and a stale file is likewise old.
//
// 2. AMBIGUITY REFUSES. If a tab has two claude descendants (nested claude), or
//    if one conversation resolves to two tabs, NEITHER is reported — the caller
//    gets nothing and a warning goes to the log. Mis-binding would attach a
//    conversation to the wrong tab and, on revive, resume the wrong history.
//
// This module OBSERVES only: it reads a process snapshot and some JSON. It
// never writes to a PTY (the standing never-mutate-a-live-shell rule).

use std::collections::{HashMap, HashSet};

/// One resolved binding: this Switchboard tab is running this claude
/// conversation. `cwd` is CLAUDE's working directory (the user may have `cd`'d
/// before launching), which is what the transcript path is munged from and
/// therefore what a promoted thread must store as its workingDir.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct ClaudeDiscovery {
    /// Switchboard session (tab) id.
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// The claude conversation uuid — DISCOVERED, not minted.
    #[serde(rename = "chatSessionId")]
    pub chat_session_id: String,
    pub cwd: String,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
}

/// The subset of `~/.claude/sessions/<pid>.json` we rely on. Extra fields in
/// the real file (procStart, version, bridgeSessionId, status, …) are ignored
/// so a claude release that adds or drops them doesn't break discovery.
#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeSessionFile {
    pub pid: u32,
    pub session_id: String,
    pub cwd: String,
    pub started_at: u64,
}

/// Parse one session file. Returns None for anything not shaped like a live
/// INTERACTIVE conversation:
///  - missing/empty `sessionId` or `cwd`, or a `sessionId` that isn't uuid-ish
///    (it is interpolated into a transcript filename downstream);
///  - a `kind` that is present and NOT "interactive" — a headless `claude -p`
///    run inside a conversation is not itself the tab's conversation. A file
///    with no `kind` at all is accepted (older writers didn't emit one).
pub fn parse_session_file(raw: &str) -> Option<ClaudeSessionFile> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = v.as_object()?;

    if let Some(kind) = obj.get("kind").and_then(|k| k.as_str()) {
        if kind != "interactive" {
            return None;
        }
    }

    let session_id = obj.get("sessionId")?.as_str()?.to_string();
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return None;
    }
    let cwd = obj.get("cwd")?.as_str()?.to_string();
    if cwd.is_empty() {
        return None;
    }
    let pid = obj.get("pid")?.as_u64()? as u32;
    let started_at = obj.get("startedAt").and_then(|s| s.as_u64()).unwrap_or(0);

    Some(ClaudeSessionFile {
        pid,
        session_id,
        cwd,
        started_at,
    })
}

/// Every pid reachable downward from `root` through the (pid, parent) edges.
/// `root` itself is NOT included — the shell is not the conversation.
///
/// Cycle-safe by construction (a `visited` set): pid reuse produces genuine
/// cycles in a Toolhelp snapshot's parent links, and a naive walk would spin
/// forever on one. pid 0 is never traversed (the idle process is every
/// orphan's nominal parent).
/// parent pid → its children, built ONCE per snapshot. Self-parents and pid 0
/// are dropped here so neither walk below has to think about them.
pub fn child_index(edges: &[(u32, u32)]) -> HashMap<u32, Vec<u32>> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, ppid) in edges {
        if pid == 0 || pid == ppid {
            continue;
        }
        children.entry(ppid).or_default().push(pid);
    }
    children
}

fn descendants_of(root: u32, children: &HashMap<u32, Vec<u32>>) -> HashSet<u32> {
    let mut out: HashSet<u32> = HashSet::new();
    let mut stack = vec![root];
    let mut visited: HashSet<u32> = HashSet::from([root]);
    while let Some(cur) = stack.pop() {
        for &child in children.get(&cur).map(|v| v.as_slice()).unwrap_or(&[]) {
            if visited.insert(child) {
                out.insert(child);
                stack.push(child);
            }
        }
    }
    out
}

/// One tab's inputs to the resolver.
pub struct ShellCandidate {
    pub session_id: String,
    pub shell_pid: u32,
    pub spawned_at_ms: u64,
}

/// THE ambiguity rule, in one pure place.
///
/// Given each tab's shell + spawn time, the process snapshot, and every claude
/// session file on disk, return the bindings that are UNAMBIGUOUS in both
/// directions:
///
///  - a tab with 2+ fresh claude descendants resolves to nothing (nested
///    claude — we cannot say which one "is" the tab);
///  - a conversation uuid that resolves under 2+ tabs is dropped from all of
///    them (a claude reachable from two shells is not evidence about either).
///
/// Dropped candidates are returned in `refused` so the caller can log them —
/// silence about a refusal is how a promotion bug hides.
pub fn resolve_bindings(
    shells: &[ShellCandidate],
    edges: &[(u32, u32)],
    files: &[ClaudeSessionFile],
) -> (Vec<ClaudeDiscovery>, Vec<String>) {
    let by_pid: HashMap<u32, &ClaudeSessionFile> = files.iter().map(|f| (f.pid, f)).collect();
    // Built once for the whole snapshot, not once per tab.
    let children = child_index(edges);
    let mut refused: Vec<String> = Vec::new();
    let mut per_shell: Vec<ClaudeDiscovery> = Vec::new();

    for shell in shells {
        let kids = descendants_of(shell.shell_pid, &children);
        let mut hits: Vec<&ClaudeSessionFile> = kids
            .iter()
            .filter_map(|pid| by_pid.get(pid).copied())
            // Guard 1 — freshness. See the header: a claude that started before
            // our shell did cannot be running INSIDE it, whatever the snapshot's
            // recycled parent links claim.
            .filter(|f| f.started_at >= shell.spawned_at_ms)
            .collect();
        hits.sort_by_key(|f| f.pid);

        match hits.len() {
            0 => {}
            1 => {
                let f = hits[0];
                per_shell.push(ClaudeDiscovery {
                    session_id: shell.session_id.clone(),
                    chat_session_id: f.session_id.clone(),
                    cwd: f.cwd.clone(),
                    started_at: f.started_at,
                });
            }
            n => {
                refused.push(format!(
                    "tab {} has {} claude descendants ({}) — promoting NEITHER",
                    shell.session_id,
                    n,
                    hits.iter()
                        .map(|f| f.pid.to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
        }
    }

    // Guard 2, other direction: one conversation must not claim two tabs.
    let mut uuid_counts: HashMap<String, usize> = HashMap::new();
    for d in &per_shell {
        *uuid_counts.entry(d.chat_session_id.clone()).or_insert(0) += 1;
    }
    let mut out = Vec::with_capacity(per_shell.len());
    for d in per_shell {
        if uuid_counts.get(&d.chat_session_id).copied().unwrap_or(0) > 1 {
            // One line per dropped tab — the log should name every binding
            // that did NOT happen, not just the conversation.
            refused.push(format!(
                "conversation {} resolves under multiple tabs (incl. {}) — promoting NEITHER",
                d.chat_session_id, d.session_id
            ));
            continue;
        }
        out.push(d);
    }
    out
        .sort_by(|a, b| a.session_id.cmp(&b.session_id));
    (out, refused)
}

// ── Effectful edges ─────────────────────────────────────────────────────────

/// Read every parseable `~/.claude/sessions/<pid>.json`. A missing directory
/// (claude never run on this machine) is an empty list, not an error.
pub fn read_claude_session_files() -> Vec<ClaudeSessionFile> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let dir = home.join(".claude").join("sessions");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(f) = parse_session_file(&raw) {
            out.push(f);
        }
    }
    out
}

/// Every (pid, parent pid) pair on the machine.
#[cfg(windows)]
pub fn process_edges() -> Vec<(u32, u32)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };

    let mut edges = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            log::warn!("CreateToolhelp32Snapshot failed — claude discovery skipped this pass");
            return edges;
        }
        let mut entry: PROCESSENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;
        if Process32First(snapshot, &mut entry) != 0 {
            loop {
                edges.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    edges
}

#[cfg(not(windows))]
pub fn process_edges() -> Vec<(u32, u32)> {
    // Promotion is a Windows feature today (Switchboard ships Windows-only).
    // An empty edge list makes discovery a well-defined no-op elsewhere.
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    // The exact bytes of a real file on this machine (2644.json), trimmed of
    // nothing — the parser must survive every field claude actually writes.
    const REAL: &str = r#"{"pid":2644,"sessionId":"cfceb6f2-fa68-42a9-b082-5ba3b15d6771","cwd":"C:\\Users\\ericm\\projects\\kyde-labs","startedAt":1785637333611,"procStart":"639212089325289230","version":"2.1.220","peerProtocol":1,"kind":"interactive","entrypoint":"cli","name":"kyde-labs-c1","nameSource":"derived","status":"idle","updatedAt":1785637334689,"statusUpdatedAt":1785637334689,"bridgeSessionId":"session_01ASYiHXWK4d6xgxgC8jQsWV"}"#;

    /// Test-side convenience: the index is built per SNAPSHOT in production
    /// (once for all tabs), but per call reads better in a test.
    fn descendants(root: u32, edges: &[(u32, u32)]) -> HashSet<u32> {
        descendants_of(root, &child_index(edges))
    }

    fn file(pid: u32, uuid: &str, started_at: u64) -> ClaudeSessionFile {
        ClaudeSessionFile {
            pid,
            session_id: uuid.to_string(),
            cwd: r"C:\repo".to_string(),
            started_at,
        }
    }

    fn shell(id: &str, pid: u32, spawned: u64) -> ShellCandidate {
        ShellCandidate {
            session_id: id.to_string(),
            shell_pid: pid,
            spawned_at_ms: spawned,
        }
    }

    #[test]
    fn parses_a_real_session_file() {
        let f = parse_session_file(REAL).expect("real file must parse");
        assert_eq!(f.pid, 2644);
        assert_eq!(f.session_id, "cfceb6f2-fa68-42a9-b082-5ba3b15d6771");
        assert_eq!(f.cwd, r"C:\Users\ericm\projects\kyde-labs");
        assert_eq!(f.started_at, 1785637333611);
    }

    #[test]
    fn accepts_a_file_without_a_kind_field() {
        let raw = r#"{"pid":7,"sessionId":"a-b","cwd":"C:\\r","startedAt":5}"#;
        assert!(parse_session_file(raw).is_some());
    }

    #[test]
    fn rejects_non_interactive_kinds() {
        let raw = r#"{"pid":7,"sessionId":"a-b","cwd":"C:\\r","startedAt":5,"kind":"print"}"#;
        assert!(parse_session_file(raw).is_none());
    }

    #[test]
    fn rejects_malformed_or_unsafe_records() {
        assert!(parse_session_file("not json").is_none());
        assert!(parse_session_file(r#"{"pid":7,"cwd":"C:\\r"}"#).is_none()); // no sessionId
        assert!(parse_session_file(r#"{"pid":7,"sessionId":"","cwd":"C:\\r"}"#).is_none());
        assert!(parse_session_file(r#"{"pid":7,"sessionId":"a-b","cwd":""}"#).is_none());
        // A traversal-shaped id would be interpolated into a transcript path.
        assert!(parse_session_file(r#"{"pid":7,"sessionId":"../x","cwd":"C:\\r"}"#).is_none());
    }

    #[test]
    fn descendants_walks_the_whole_subtree_and_excludes_the_root() {
        // 100 -> 200 -> 300, plus an unrelated 400.
        let edges = [(200, 100), (300, 200), (400, 999)];
        let d = descendants(100, &edges);
        assert_eq!(d, HashSet::from([200, 300]));
    }

    #[test]
    fn descendants_terminates_on_a_recycled_pid_cycle() {
        // Real chains on this machine loop like this after pid reuse.
        let edges = [(200, 100), (100, 300), (300, 200)];
        let d = descendants(100, &edges);
        // Terminates, and never re-reports the root.
        assert!(!d.contains(&100));
        assert_eq!(d, HashSet::from([200, 300]));
    }

    #[test]
    fn one_claude_under_one_shell_resolves() {
        let (out, refused) = resolve_bindings(
            &[shell("tab-a", 100, 1000)],
            &[(200, 100)],
            &[file(200, "uuid-1", 2000)],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].session_id, "tab-a");
        assert_eq!(out[0].chat_session_id, "uuid-1");
        assert!(refused.is_empty());
    }

    #[test]
    fn a_plain_shell_with_no_claude_resolves_to_nothing() {
        // Acceptance 3.
        let (out, refused) = resolve_bindings(&[shell("tab-a", 100, 1000)], &[(200, 100)], &[]);
        assert!(out.is_empty());
        assert!(refused.is_empty());
    }

    #[test]
    fn two_tabs_same_repo_only_the_one_running_claude_promotes() {
        // Acceptance 4: identical cwd, so cwd-matching would have been a coin
        // flip; descendancy is exact.
        let (out, refused) = resolve_bindings(
            &[shell("tab-a", 100, 1000), shell("tab-b", 500, 1000)],
            &[(200, 100), (600, 500)],
            // 600 is some other child of tab-b's shell with no session file.
            &[file(200, "uuid-1", 2000)],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].session_id, "tab-a");
        assert!(refused.is_empty());
    }

    #[test]
    fn a_stale_session_file_predating_the_shell_is_ignored() {
        // Guard 1: pid 200 was recycled into our descendant; its session file
        // belongs to a claude that died before this tab existed.
        let (out, _) = resolve_bindings(
            &[shell("tab-a", 100, 5000)],
            &[(200, 100)],
            &[file(200, "uuid-old", 1000)],
        );
        assert!(out.is_empty());
    }

    #[test]
    fn a_claude_started_exactly_at_shell_spawn_still_counts() {
        let (out, _) = resolve_bindings(
            &[shell("tab-a", 100, 1000)],
            &[(200, 100)],
            &[file(200, "uuid-1", 1000)],
        );
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn two_claudes_under_one_shell_promote_neither() {
        let (out, refused) = resolve_bindings(
            &[shell("tab-a", 100, 1000)],
            &[(200, 100), (300, 200)],
            &[file(200, "uuid-1", 2000), file(300, "uuid-2", 2100)],
        );
        assert!(out.is_empty(), "ambiguous tab must promote neither");
        assert_eq!(refused.len(), 1);
        assert!(refused[0].contains("tab-a"));
    }

    #[test]
    fn one_claude_under_two_shells_promotes_neither() {
        // Contrived (Switchboard shells are siblings), but the rule must hold
        // whatever the snapshot says.
        let (out, refused) = resolve_bindings(
            &[shell("tab-a", 100, 1000), shell("tab-b", 500, 1000)],
            &[(200, 100), (200, 500)],
            &[file(200, "uuid-1", 2000)],
        );
        assert!(out.is_empty());
        // One refusal line per dropped tab, each naming the conversation.
        assert_eq!(refused.len(), 2);
        assert!(refused.iter().all(|r| r.contains("uuid-1")));
        assert!(refused.iter().any(|r| r.contains("tab-a")));
        assert!(refused.iter().any(|r| r.contains("tab-b")));
    }

    #[test]
    fn a_deeply_nested_claude_still_resolves() {
        // powershell -> cmd -> claude, or claude launched from a sub-shell.
        let (out, _) = resolve_bindings(
            &[shell("tab-a", 100, 1000)],
            &[(200, 100), (300, 200), (400, 300)],
            &[file(400, "uuid-1", 2000)],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].chat_session_id, "uuid-1");
    }

    /// FFI smoke test: everything above is pure and would pass just as happily
    /// against a broken Toolhelp binding. This one proves the snapshot really
    /// enumerates processes — the test binary must find ITSELF, with a parent.
    #[cfg(windows)]
    #[test]
    fn process_edges_enumerates_this_very_process() {
        let edges = process_edges();
        assert!(!edges.is_empty(), "Toolhelp snapshot returned nothing");
        let me = std::process::id();
        let mine = edges
            .iter()
            .find(|(pid, _)| *pid == me)
            .expect("the running test process must appear in its own snapshot");
        assert_ne!(mine.1, 0, "this process must have a parent pid");
        // …and the walk over real edges terminates (no cycle blowup).
        let _ = descendants(me, &edges);
    }

    /// Session files on a developer machine are real; on CI there may be none.
    /// Either way the reader must not panic and must return only records that
    /// satisfy the parser's guarantees.
    #[test]
    fn reading_real_session_files_never_panics_and_yields_valid_records() {
        for f in read_claude_session_files() {
            assert!(!f.session_id.is_empty());
            assert!(!f.cwd.is_empty());
            assert!(f
                .session_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-'));
        }
    }

    #[test]
    fn discoveries_carry_claudes_cwd_not_the_shells() {
        // The user `cd`'d before typing claude — the transcript lives under
        // CLAUDE's cwd, so that is what a promoted thread must store.
        let f = ClaudeSessionFile {
            pid: 200,
            session_id: "uuid-1".into(),
            cwd: r"C:\Users\ericm\projects\orbit".into(),
            started_at: 2000,
        };
        let (out, _) = resolve_bindings(&[shell("tab-a", 100, 1000)], &[(200, 100)], &[f]);
        assert_eq!(out[0].cwd, r"C:\Users\ericm\projects\orbit");
    }
}
