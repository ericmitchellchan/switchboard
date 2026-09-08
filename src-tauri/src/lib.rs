mod config;
mod discovery;
mod explorer;
mod ipc_guard;
mod kb;
mod power;
mod pty;

use config::{load_config, Config};
use discovery::ClaudeDiscovery;
use pty::{PtyManager, SessionInfo};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{image::Image, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use log;
use uuid::Uuid;

struct AppState {
    pty_manager: PtyManager,
}

#[tauri::command]
async fn create_session(
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
    name: String,
    repo: String,
    working_dir: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<SessionInfo, String> {
    let id = Uuid::new_v4().to_string();
    let c = cols.unwrap_or(120);
    let r = rows.unwrap_or(30);
    let cfg = load_config();

    log::info!("Creating session id={} name={:?} repo={:?} working_dir={:?} cols={} rows={}", id, name, repo, working_dir, c, r);

    // A freshly created session always starts at spawn generation 1: its id is
    // a brand-new UUID, so no stale reader thread can exist for it — the race
    // that generations guard against only arises on restart, where the id is
    // reused. The frontend registry defaults its expectation to 1 accordingly.
    state.pty_manager.create_session(
        id.clone(),
        name.clone(),
        repo.clone(),
        working_dir.clone(),
        c,
        r,
        1,
        Some(cfg.shell),
        app_handle,
    ).map_err(|e| {
        log::error!("Failed to create session id={}: {}", id, e);
        e
    })?;

    Ok(SessionInfo {
        id,
        name,
        repo,
        working_dir,
    })
}

#[tauri::command]
async fn restart_session(
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
    session_id: String,
    name: String,
    repo: String,
    working_dir: String,
    cols: Option<u16>,
    rows: Option<u16>,
    // Client-generated spawn generation. The frontend bumps its expectation
    // BEFORE invoking this command — the old PTY dies inside this call, so by
    // the time any new-gen event can exist the registry already expects it,
    // and the old reader thread's dying events (previous gen) are dropped.
    gen: u64,
) -> Result<SessionInfo, String> {
    let c = cols.unwrap_or(120);
    let r = rows.unwrap_or(30);
    let cfg = load_config();

    log::info!("Restarting session id={} name={:?} repo={:?} working_dir={:?} cols={} rows={} gen={}", session_id, name, repo, working_dir, c, r, gen);

    state.pty_manager.restart_session(
        session_id.clone(),
        name.clone(),
        repo.clone(),
        working_dir.clone(),
        c,
        r,
        gen,
        Some(cfg.shell),
        app_handle,
    ).map_err(|e| {
        log::error!("Failed to restart session id={}: {}", session_id, e);
        e
    })?;

    Ok(SessionInfo {
        id: session_id,
        name,
        repo,
        working_dir,
    })
}

#[tauri::command]
async fn close_session(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<(), String> {
    log::info!("Closing session id={}", session_id);
    state.pty_manager.close_session(&session_id)
}

#[tauri::command]
async fn write_to_session(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state
        .pty_manager
        .write_to_session(&session_id, data.as_bytes())
}

#[tauri::command]
async fn resize_session(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    log::debug!("Resizing session id={} cols={} rows={}", session_id, cols, rows);
    state.pty_manager.resize_session(&session_id, cols, rows)
}

#[tauri::command]
async fn list_sessions(state: State<'_, Arc<AppState>>) -> Result<Vec<SessionInfo>, String> {
    state.pty_manager.list_sessions()
}

#[tauri::command]
async fn rename_session(
    state: State<'_, Arc<AppState>>,
    session_id: String,
    new_name: String,
) -> Result<(), String> {
    state.pty_manager.rename_session(&session_id, new_name)
}

#[tauri::command]
async fn get_config() -> Result<Config, String> {
    log::debug!("Loading config");
    Ok(load_config())
}

#[tauri::command]
async fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "Cannot resolve home directory".to_string())
}

/// The per-IDENTITY local-data folder name (SWIT-29). `switchboard` for the
/// installed app, `switchboard-dev` for a build launched with
/// `tauri.conf.dev.json` (`com.switchboard.dev`), so a WIP build running
/// BESIDE the daily driver never shares its scrollback mirror or its
/// `threads.json` — two processes writing one threads file would be
/// last-writer-wins on every periodic save. Set once in `setup` from the
/// app's own config; before that (or if it were never set) the production
/// name applies. `config.json` is deliberately NOT scoped: the repo list is
/// the same list for both builds (see config.rs).
static DATA_DIR_NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn data_dir_name() -> &'static str {
    DATA_DIR_NAME.get().map(String::as_str).unwrap_or("switchboard")
}

fn scrollback_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Cannot resolve local data dir")?;
    Ok(base.join(data_dir_name()).join("scrollback"))
}

/// The directory terminal scrollback is mirrored into, as an absolute path.
///
/// Read once at boot by the frontend (agentContext) so a PANEL TERMINAL can be
/// NAMED to an agent: a live shell is not something claude can attach to, but
/// its transcript is a file claude can `Read`, and that file is right here.
/// Creating the directory eagerly matters — the reference we hand the agent
/// must point somewhere that exists even if nothing has been flushed yet.
#[tauri::command]
async fn scrollback_root() -> Result<String, String> {
    let dir = scrollback_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Suffix of the AGENT-FACING transcript, alongside `<id>.txt`.
///
/// TWO FILES PER SESSION, ON PURPOSE. `<id>.txt` is the xterm SERIALIZE — SGR
/// runs and absolute cursor moves — because restore and the PiP handoff write
/// it back into another terminal and need that fidelity. `<id>.transcript.txt`
/// is the same buffer as PLAIN TEXT, because its only reader is an agent, and
/// an agent handed escape sequences is being given noise dressed as context.
///
/// PAIRED WITH `agentContext.TRANSCRIPT_SUFFIX`, which composes the path the
/// reference names. Change one and change the other.
const TRANSCRIPT_SUFFIX: &str = ".transcript.txt";

#[tauri::command]
async fn save_transcript(session_id: String, data: String) -> Result<(), String> {
    let dir = scrollback_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}{}", session_id, TRANSCRIPT_SUFFIX));
    std::fs::write(&path, data.as_bytes()).map_err(|e| {
        log::error!("Failed to save transcript for session id={}: {}", session_id, e);
        e.to_string()
    })
}

#[tauri::command]
async fn save_scrollback(session_id: String, data: String) -> Result<(), String> {
    log::debug!("Saving scrollback for session id={}", session_id);
    let dir = scrollback_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.txt", session_id));
    std::fs::write(&path, data.as_bytes()).map_err(|e| {
        log::error!("Failed to save scrollback for session id={}: {}", session_id, e);
        e.to_string()
    })
}

#[tauri::command]
async fn load_scrollback(session_id: String) -> Result<String, String> {
    log::debug!("Loading scrollback for session id={}", session_id);
    let dir = scrollback_dir()?;
    let path = dir.join(format!("{}.txt", session_id));
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => {
            log::error!("Failed to load scrollback for session id={}: {}", session_id, e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
async fn clear_scrollback() -> Result<(), String> {
    let dir = scrollback_dir()?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn clear_session_scrollback(session_id: String) -> Result<(), String> {
    let dir = scrollback_dir()?;
    let path = dir.join(format!("{}.txt", session_id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Per-thread data dirs (SWIT-48, the coaching-platform page) ───────────────
// `%LOCALAPPDATA%/switchboard/threads/<threadId>/` holds the thread's page
// files: page.json (written by the MCP server, SWIT-49), answers.json +
// inbox.json + retracted.json (written by the app, SWIT-51/52/78). ONE WRITER PER FILE is the
// design; the shell only READS here, and the guard posture mirrors kb.rs:
// the thread id is validated component-wise (uuid alphabet only — no
// separators, so no traversal is expressible) and the file name comes from a
// closed allowlist, never from the caller's imagination.

fn threads_data_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Cannot resolve local data dir")?;
    Ok(base.join(data_dir_name()).join("threads"))
}

/// The files a thread dir may hold in this increment. SWIT-50 extends this
/// with the views/ listing through its own guarded command. SWIT-78 adds
/// retracted.json — the app's overlay of evidence rows taken off the page.
const THREAD_FILES: [&str; 4] = ["page.json", "answers.json", "inbox.json", "retracted.json"];

/// Thread ids are frontend-minted uuids (threadStore.mintUuid). Anything
/// outside the uuid alphabet is refused outright — there is no path form to
/// sanitize because none can be expressed.
fn valid_thread_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The threads data root, as an absolute path — read once at boot by the
/// frontend (agentContext) so a PAGE can be NAMED to an agent: the page is a
/// JSON file claude can `Read`. Created eagerly for the same reason the
/// scrollback root is: the reference must point somewhere that exists.
#[tauri::command]
async fn threads_root() -> Result<String, String> {
    let dir = threads_data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Read one of a thread's page files. A MISSING file is an empty string, not
/// an error — "no page yet" is the ordinary state of every thread until its
/// agent first writes (SWIT-49), and the 2.5s poll must not log a failure per
/// tick for it.
#[tauri::command]
async fn read_thread_file(thread_id: String, name: String) -> Result<String, String> {
    if !valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    if !THREAD_FILES.contains(&name.as_str()) {
        return Err("invalid thread file name".into());
    }
    let path = threads_data_dir()?.join(&thread_id).join(&name);
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => {
            log::error!("Failed to read thread file {}/{}: {}", thread_id, name, e);
            Err(e.to_string())
        }
    }
}

/// A change stamp over a thread's page files: the max mtime (ms since epoch)
/// of page.json / answers.json / inbox.json / retracted.json, a missing file
/// counting 0. The frontend's 5s pass compares it tick-to-tick and skips the
/// reads when nothing moved — a per-thread stat instead of three reads per
/// thread per tick. Same guard posture as read_thread_file: the id is validated and
/// the names come from the fixed THREAD_FILES set, so nothing caller-named
/// reaches the filesystem. Compared by INEQUALITY on the frontend (a stamp is
/// a change signal, not a clock — a restored older file must still re-read).
#[tauri::command]
async fn thread_files_stamp(thread_id: String) -> Result<u64, String> {
    if !valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    let dir = threads_data_dir()?.join(&thread_id);
    Ok(max_mtime_ms(&dir, &THREAD_FILES))
}

/// Pure half of thread_files_stamp: max mtime in ms across `names` under
/// `dir`; anything unreadable (missing file, missing dir, pre-epoch mtime)
/// contributes 0, so "no page yet" is stamp 0, not an error — the ordinary
/// state of every thread until its agent first writes.
fn max_mtime_ms(dir: &std::path::Path, names: &[&str]) -> u64 {
    let mut max = 0u64;
    for name in names {
        let ms = std::fs::metadata(dir.join(name))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if ms > max {
            max = ms;
        }
    }
    max
}

#[cfg(test)]
mod thread_stamp_tests {
    use super::{max_mtime_ms, valid_thread_id, THREAD_FILES};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "swb-stamp-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_dir_and_missing_files_stamp_zero() {
        assert_eq!(max_mtime_ms(std::path::Path::new("Z:/no/such/dir"), &THREAD_FILES), 0);
        let dir = temp_dir("empty");
        assert_eq!(max_mtime_ms(&dir, &THREAD_FILES), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stamp_is_the_newest_of_the_three_and_moves_on_write() {
        let dir = temp_dir("write");
        std::fs::write(dir.join("page.json"), "{}").unwrap();
        let one = max_mtime_ms(&dir, &THREAD_FILES);
        assert!(one > 0);
        // A second file can only hold the stamp or advance it — and rewriting
        // it advances past any earlier value (mtime moves forward on write).
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("inbox.json"), "{\"posts\":[]}").unwrap();
        let two = max_mtime_ms(&dir, &THREAD_FILES);
        assert!(two > one, "stamp must advance on a newer write: {one} -> {two}");
        // Only the fixed name set counts: an unrelated file moves nothing.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join("other.json"), "x").unwrap();
        assert_eq!(max_mtime_ms(&dir, &THREAD_FILES), two);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn thread_id_guard_is_the_same_one_reads_use() {
        assert!(valid_thread_id("3f1c2a9e-0b7d-4c1e-9a55-1234567890ab"));
        assert!(!valid_thread_id("../escape"));
        assert!(!valid_thread_id(""));
    }

    #[test]
    fn retracted_json_is_in_the_fixed_file_set() {
        // SWIT-78: the overlay is readable through read_thread_file and moves
        // the stamp like the other three — nothing caller-named joins the set.
        assert!(THREAD_FILES.contains(&"retracted.json"));
        assert_eq!(THREAD_FILES.len(), 4);
    }
}

// ── Retracted evidence (SWIT-78 — the correctable record) ────────────────────
// A `×` on an Evidence row takes it off the page. page.json is the MCP
// server's file, so the APP never edits the row: it records `{address, at}` in
// retracted.json (this file's sole writer is the app; same tmp+rename posture
// as answers.json) and the frontend merge hides the row until the agent
// re-posts it with a newer stamp (pageStore.applyRetractions). The list is
// newest-first, one entry per address (a re-retraction moves its stamp — so a
// row that came back can go again), capped so a hand-edited file cannot grow
// without bound. RETRACTED_CAP mirrors pageStore.RETRACTED_CAP.

const RETRACTED_CAP: usize = 200;
/// An address is a page-evidence address (server TEXT_CAP is 500 CHARS, so
/// the cap counts chars, not bytes) — a ticket key, a path, a `surface:`
/// state, a `view:` id. Control characters refused. A `decision:` address is
/// refused too: those rows are synthesized from answers.json at the merge and
/// are corrected on their question, never taken off — the merge ignores the
/// prefix as well (pageStore.isRetracted), so a hand-edited file cannot hide
/// one either.
const RETRACTED_ADDRESS_CAP: usize = 500;
const DECISION_ADDRESS_PREFIX: &str = "decision:";

fn valid_evidence_address(address: &str) -> bool {
    !address.is_empty()
        && address.chars().count() <= RETRACTED_ADDRESS_CAP
        && !address.chars().any(|c| c.is_control())
        && !address.starts_with(DECISION_ADDRESS_PREFIX)
}

/// Pure half of `retract_thread_evidence`: the new list — `{address, at}`
/// FIRST, any older entry for the same address gone, non-object / addressless
/// junk dropped, the oldest beyond the cap dropped. Returns the list.
fn retract_evidence_address(
    existing: &[serde_json::Value],
    address: &str,
    now: &str,
) -> Vec<serde_json::Value> {
    let mut out = Vec::with_capacity(existing.len() + 1);
    out.push(serde_json::json!({ "address": address, "at": now }));
    for entry in existing {
        let Some(obj) = entry.as_object() else { continue };
        match obj.get("address").and_then(|a| a.as_str()) {
            Some(a) if !a.is_empty() && a != address => out.push(entry.clone()),
            _ => {}
        }
    }
    out.truncate(RETRACTED_CAP);
    out
}

fn read_retracted_list(file: &std::path::Path) -> Vec<serde_json::Value> {
    // Tolerant read: junk degrades to an empty list — the one path that must
    // never lose the retraction Eric just made.
    std::fs::read_to_string(file)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            v.get("evidence")
                .and_then(|e| e.as_array().cloned())
                .or_else(|| v.as_array().cloned())
        })
        .unwrap_or_default()
}

/// SWIT-78: take an evidence row off the page. Resolves to the retraction
/// count after the write.
#[tauri::command]
async fn retract_thread_evidence(thread_id: String, address: String) -> Result<usize, String> {
    if !valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    let trimmed = address.trim();
    if !valid_evidence_address(trimmed) {
        return Err("invalid evidence address".into());
    }
    let dir = threads_data_dir()?.join(&thread_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("retracted.json");
    let list = retract_evidence_address(&read_retracted_list(&file), trimmed, &chrono_like_now_iso());
    let n = list.len();
    let payload = serde_json::to_string_pretty(&serde_json::json!({ "version": 1, "evidence": list }))
        .map_err(|e| e.to_string())?;
    let tmp = dir.join("retracted.json.tmp");
    std::fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    Ok(n)
}

#[cfg(test)]
mod retracted_evidence_tests {
    use super::{retract_evidence_address, valid_evidence_address, RETRACTED_CAP};

    #[test]
    fn newest_first_one_entry_per_address_junk_dropped() {
        let existing: Vec<serde_json::Value> = serde_json::from_str(
            r#"[{"address":"SWIT-1","at":"t1"},{"address":"docs/a.md","at":"t0"},"junk",{"at":"no address"},{"address":"","at":"t"}]"#,
        )
        .unwrap();
        let list = retract_evidence_address(&existing, "docs/a.md", "t2");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["address"], "docs/a.md");
        assert_eq!(list[0]["at"], "t2"); // the re-retraction MOVES the stamp
        assert_eq!(list[1]["address"], "SWIT-1");
    }

    #[test]
    fn caps_by_dropping_the_oldest() {
        let existing: Vec<serde_json::Value> = (0..RETRACTED_CAP)
            .map(|i| serde_json::json!({ "address": format!("A-{i}"), "at": "t" }))
            .collect();
        let list = retract_evidence_address(&existing, "NEW-1", "t9");
        assert_eq!(list.len(), RETRACTED_CAP);
        assert_eq!(list[0]["address"], "NEW-1");
        assert_eq!(list[RETRACTED_CAP - 1]["address"], format!("A-{}", RETRACTED_CAP - 2));
    }

    #[test]
    fn address_guard() {
        assert!(valid_evidence_address("SWIT-78"));
        assert!(valid_evidence_address("surface:lodestar/trading?instrument=NQ"));
        assert!(!valid_evidence_address(""));
        assert!(!valid_evidence_address("a\nb"));
        assert!(!valid_evidence_address(&"x".repeat(501)));
        assert!(valid_evidence_address(&"x".repeat(500)));
        // The cap is CHARS (the server's TEXT_CAP), not bytes: 500 two-byte
        // chars is 1000 bytes and still a valid address.
        assert!(valid_evidence_address(&"é".repeat(500)));
        assert!(!valid_evidence_address(&"é".repeat(501)));
        // A decision row is corrected on its question, never retracted.
        assert!(!valid_evidence_address("decision:q1"));
        assert!(valid_evidence_address("decisions/q1.md"));
    }
}

// ── Question answers (SWIT-51; SWIT-77 the batch) ────────────────────────────
// The APP is answers.json's SOLE writer (one-writer-per-file: page.json is
// the MCP server's, this file is ours). Read-modify-write server-side,
// atomic via tmp+rename so the server's read-only glance and the app's own
// 2.5s poll never see a torn file. Single app instance; a lock is overkill.
//
// SWIT-77: an entry is `{text, at, resolvedBy: "user", sentAt?}`. Answering
// SAVES (the entry is REPLACED, so a changed answer drops its `sentAt` and is
// unsent again); `mark_thread_answers_sent` stamps `sentAt` once the batch
// message reached the thread. The unsent rule is the frontend's
// (pageStore.isAnswerUnsent: no sentAt, or sentAt older than at). The two
// extra fields are optional, so an answers.json from before this ticket
// parses unchanged — that is why the unsent set lives HERE and not in a
// second file the allowlist would have to grow for.

const ANSWER_TEXT_CAP: usize = 4000;
/// A batch send names at most the page's open questions (QUESTION_CAP).
const ANSWERS_SENT_CAP: usize = 64;

/// Pure half of `mark_thread_answers_sent`: stamp `sentAt = now` on every
/// listed id that holds an object entry; unknown ids and non-object entries
/// are skipped (a send names what the page showed, and the page may have
/// moved). Returns how many were stamped.
fn stamp_answers_sent(
    answers: &mut serde_json::Map<String, serde_json::Value>,
    ids: &[String],
    now: &str,
) -> usize {
    let mut n = 0;
    for id in ids {
        if let Some(serde_json::Value::Object(entry)) = answers.get_mut(id) {
            entry.insert("sentAt".to_string(), serde_json::Value::String(now.to_string()));
            n += 1;
        }
    }
    n
}

fn read_answers_map(file: &std::path::Path) -> serde_json::Map<String, serde_json::Value> {
    // Tolerant read: junk degrades to an empty record rather than blocking
    // the one path that must never lose Eric's typed answer.
    std::fs::read_to_string(file)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_answers_map(
    dir: &std::path::Path,
    answers: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let file = dir.join("answers.json");
    let payload = serde_json::to_string_pretty(&serde_json::Value::Object(answers))
        .map_err(|e| e.to_string())?;
    let tmp = dir.join("answers.json.tmp");
    std::fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    Ok(())
}

/// SWIT-77: the batch went out — stamp `sentAt` on the answers it carried.
/// Called ONLY after the PTY write succeeded; a failed send leaves the
/// answers unsent, which is what keeps the button honest.
#[tauri::command]
async fn mark_thread_answers_sent(
    thread_id: String,
    question_ids: Vec<String>,
) -> Result<usize, String> {
    if !valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    if question_ids.is_empty() {
        return Ok(0);
    }
    if question_ids.len() > ANSWERS_SENT_CAP {
        return Err(format!("too many question ids (cap {})", ANSWERS_SENT_CAP));
    }
    if let Some(bad) = question_ids.iter().find(|id| !valid_question_id(id)) {
        return Err(format!("invalid question id: {}", bad));
    }
    let dir = threads_data_dir()?.join(&thread_id);
    let file = dir.join("answers.json");
    let mut answers = read_answers_map(&file);
    let n = stamp_answers_sent(&mut answers, &question_ids, &chrono_like_now_iso());
    if n == 0 {
        return Ok(0); // nothing to stamp — no write, no new file
    }
    write_answers_map(&dir, answers)?;
    Ok(n)
}

#[cfg(test)]
mod answers_sent_tests {
    use super::stamp_answers_sent;

    #[test]
    fn stamps_only_listed_object_entries_and_counts_them() {
        let mut answers: serde_json::Map<String, serde_json::Value> = serde_json::from_str(
            r#"{"q1":{"text":"a","at":"2026-09-08T10:00:00Z"},"q2":{"text":"b","at":"t"},"q3":"junk"}"#,
        )
        .unwrap();
        let n = stamp_answers_sent(
            &mut answers,
            &["q1".to_string(), "q3".to_string(), "q9".to_string()],
            "2026-09-08T10:00:05Z",
        );
        assert_eq!(n, 1);
        assert_eq!(answers["q1"]["sentAt"], "2026-09-08T10:00:05Z");
        assert_eq!(answers["q1"]["text"], "a"); // the rest of the entry is untouched
        assert!(answers["q2"].get("sentAt").is_none());
        assert_eq!(answers["q3"], "junk");
    }

    #[test]
    fn empty_id_list_stamps_nothing() {
        let mut answers: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"q1":{"text":"a","at":"t"}}"#).unwrap();
        assert_eq!(stamp_answers_sent(&mut answers, &[], "now"), 0);
        assert!(answers["q1"].get("sentAt").is_none());
    }
}

fn valid_question_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
async fn write_thread_answer(
    thread_id: String,
    question_id: String,
    text: String,
) -> Result<(), String> {
    if !valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    if !valid_question_id(&question_id) {
        return Err("invalid question id".into());
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("an answer cannot be empty".into());
    }
    if trimmed.len() > ANSWER_TEXT_CAP {
        return Err(format!("answer too long (cap {} bytes)", ANSWER_TEXT_CAP));
    }
    let dir = threads_data_dir()?.join(&thread_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("answers.json");
    let mut answers = read_answers_map(&file);
    let now_iso = chrono_like_now_iso();
    // REPLACED, not merged: a re-answer has no `sentAt`, so it is unsent
    // again and the next batch carries the new text (SWIT-77).
    answers.insert(
        question_id,
        serde_json::json!({ "text": trimmed, "at": now_iso, "resolvedBy": "user" }),
    );
    write_answers_map(&dir, answers)
}

/// SWIT-58 — the ONE file the app appends `convention` answers to. Fixed
/// here and resolved through the explorer's registry guard (project KEY →
/// canonical repo root → containment → must already exist), so the frontend
/// supplies a LINE and never a path. The agent never edits this file for a
/// convention answer: the app is the writer, the heading is created once.
const CONVENTIONS_PROJECT: &str = "switchboard";
const CONVENTIONS_REL: &str = "design/wireframe-kit/conventions.md";
const CONVENTIONS_HEADING: &str = "## Decisions recorded by the app";
const CONVENTION_LINE_CAP: usize = 2000;

#[tauri::command]
async fn append_convention(line: String) -> Result<(), String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err("a convention cannot be empty".into());
    }
    if trimmed.len() > CONVENTION_LINE_CAP {
        return Err(format!("convention too long (cap {} bytes)", CONVENTION_LINE_CAP));
    }
    explorer::append_line_for_project(
        CONVENTIONS_PROJECT,
        CONVENTIONS_REL,
        CONVENTIONS_HEADING,
        trimmed,
    )
}

// ── Composer attachments (SWIT-59) ───────────────────────────────────────────
// A PASTED image/file is saved under the thread's data dir:
// `threads/<threadId>/attachments/<name>`. Dropped and picked files never
// come through here (they are paths the agent Reads in place). Guard posture,
// same as the thread files above: the thread id is uuid-alphabet only, the
// thread must be KNOWN (in the threads.json mirror — the frontend flushes it
// at thread creation and on promotion), the file name is held to a closed
// alphabet with no separator in it, and the only dirs this creates are
// `attachments/` and, for a thread that is in the mirror but was never
// launched (so has no data dir yet), the `threads/<threadId>/` above it.

/// Mirrors `MAX_PASTE_BYTES` in lib/attachments.ts — change one, change both.
const ATTACHMENT_CAP: usize = 25 * 1024 * 1024;

/// A file name for the attachments dir: `[A-Za-z0-9._-]` only (so no `/`,
/// `\`, `:`, no spaces), non-empty, not `.`/`..`, not dot-led, <= 128 bytes,
/// and with an extension — the agent picks its reader from it. REFUSED, not
/// mangled: the frontend already produces `<ts>-<n>.<ext>`, so anything else
/// is a caller bug, not input to clean up.
fn attachment_name_ok(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 128 {
        return Err("invalid attachment name".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err("invalid attachment name".into());
    }
    if name.starts_with('.') {
        return Err("invalid attachment name".into());
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => Ok(()),
        _ => Err("attachment name needs an extension".into()),
    }
}

/// Everything about the write EXCEPT the write: the thread's existence (from
/// the mirror's content), the name, the size. Pure so the guard tests need no
/// data dir; the command wires the two files in.
fn attachment_target(
    threads_dir: &std::path::Path,
    mirror_raw: &str,
    thread_id: &str,
    name: &str,
    byte_len: usize,
) -> Result<std::path::PathBuf, String> {
    if !valid_thread_id(thread_id) {
        return Err("invalid thread id".into());
    }
    working_dir_from_mirror(mirror_raw, thread_id)?;
    attachment_name_ok(name)?;
    if byte_len == 0 {
        return Err("empty attachment".into());
    }
    if byte_len > ATTACHMENT_CAP {
        return Err(format!(
            "attachment too large ({} bytes, cap {})",
            byte_len, ATTACHMENT_CAP
        ));
    }
    Ok(threads_dir.join(thread_id).join("attachments").join(name))
}

/// Save pasted bytes as `threads/<thread_id>/attachments/<name>` and return
/// the absolute path. Never overwrites: the frontend stamps names, and a
/// collision means two pastes in one millisecond, which should fail loudly
/// rather than replace a file an agent may already have been told about.
#[tauri::command]
async fn save_thread_attachment(
    thread_id: String,
    name: String,
    data_base64: String,
) -> Result<String, String> {
    use base64::Engine;
    // Refuse before decoding: base64 is 4/3 of the payload, so anything past
    // this is over the cap by construction and not worth allocating for.
    if data_base64.len() > ATTACHMENT_CAP / 3 * 4 + 4 {
        return Err(format!("attachment too large (cap {} bytes)", ATTACHMENT_CAP));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("decode attachment: {}", e))?;
    let mirror = std::fs::read_to_string(threads_path()?)
        .map_err(|e| format!("threads mirror unreadable: {}", e))?;
    let path = attachment_target(&threads_data_dir()?, &mirror, &thread_id, &name, bytes.len())?;
    let dir = path.parent().ok_or("no attachments dir")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // `create_new` makes never-overwrite a PROPERTY of the open, not a check
    // a second paste could race past between `exists()` and `write`.
    let mut file = match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(format!("attachment already exists: {}", name));
        }
        Err(e) => return Err(e.to_string()),
    };
    {
        use std::io::Write;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    log::info!(
        "Saved attachment thread={} name={} bytes={}",
        thread_id,
        name,
        bytes.len()
    );
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod attachment_guard_tests {
    use super::{attachment_name_ok, attachment_target, ATTACHMENT_CAP};
    use std::path::Path;

    const THREAD: &str = "3f1c2a9e-0b7d-4c1e-9a55-1234567890ab";
    fn mirror() -> String {
        format!(
            r#"{{"threads":[{{"id":"{}","workingDir":"C:\\Users\\ericm\\projects\\switchboard"}}]}}"#,
            THREAD
        )
    }

    #[test]
    fn good_name_lands_under_the_thread_attachments_dir() {
        let root = Path::new("C:/data/threads");
        let p = attachment_target(root, &mirror(), THREAD, "1725000000000-1.png", 10).unwrap();
        assert_eq!(p, root.join(THREAD).join("attachments").join("1725000000000-1.png"));
    }

    #[test]
    fn traversal_and_separators_refused() {
        for bad in ["../x.png", "..\\x.png", "a/b.png", "a\\b.png", "C:x.png", "..", "."] {
            assert!(attachment_name_ok(bad).is_err(), "{bad}");
            assert!(attachment_target(Path::new("r"), &mirror(), THREAD, bad, 1).is_err());
        }
    }

    #[test]
    fn bad_names_refused() {
        for bad in ["", ".hidden.png", "no-extension", "sp ace.png", "ünïcode.png", "x.png\0"] {
            assert!(attachment_name_ok(bad).is_err(), "{bad:?}");
        }
        let long = format!("{}.png", "a".repeat(130));
        assert!(attachment_name_ok(&long).is_err());
        assert!(attachment_name_ok("report.final-v2_x.PDF").is_ok());
    }

    #[test]
    fn oversize_and_empty_refused() {
        assert!(attachment_target(Path::new("r"), &mirror(), THREAD, "a.png", ATTACHMENT_CAP).is_ok());
        assert!(attachment_target(Path::new("r"), &mirror(), THREAD, "a.png", ATTACHMENT_CAP + 1).is_err());
        assert!(attachment_target(Path::new("r"), &mirror(), THREAD, "a.png", 0).is_err());
    }

    #[test]
    fn unknown_thread_refused() {
        let other = "9999aaaa-0b7d-4c1e-9a55-1234567890ab";
        let err = attachment_target(Path::new("r"), &mirror(), other, "a.png", 1).unwrap_err();
        assert!(err.contains("unknown thread"), "{err}");
        // A malformed id never reaches the mirror lookup.
        assert!(attachment_target(Path::new("r"), &mirror(), "../x", "a.png", 1).is_err());
        assert!(attachment_target(Path::new("r"), "not json", THREAD, "a.png", 1).is_err());
    }
}

/// ISO-8601 UTC "now" without pulling the chrono crate in for one format.
/// MILLISECONDS, the exact shape of JS `Date#toISOString()`
/// (`2026-09-08T10:00:00.500Z`): the MCP server stamps page rows that way,
/// and a retraction stamped at second precision compared numerically against
/// a ms `updatedAt` lost by the fraction (SWIT-78 review, F1). Every stamp
/// this side writes — answers, sentAt, posts, retractions — is this one shape.
fn chrono_like_now_iso() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    iso_from_millis(millis)
}

/// The pure half: unix milliseconds → `YYYY-MM-DDTHH:MM:SS.mmmZ`.
fn iso_from_millis(millis: u128) -> String {
    let secs = (millis / 1000) as u64;
    let ms = (millis % 1000) as u64;
    // Days-from-civil (Howard Hinnant's algorithm, inverted) — exact for the
    // Gregorian calendar; no leap seconds, which JSON timestamps never carry.
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, d, h, m, s, ms
    )
}

#[cfg(test)]
mod iso_stamp_tests {
    use super::{chrono_like_now_iso, iso_from_millis};

    #[test]
    fn millisecond_shape_matches_js_to_iso_string() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1_000_000_000_000), "2001-09-09T01:46:40.000Z");
        assert_eq!(iso_from_millis(1_000_000_000_500), "2001-09-09T01:46:40.500Z");
        assert_eq!(iso_from_millis(1_000_000_000_007), "2001-09-09T01:46:40.007Z");
        // Leap day, end of a month, a real 2026 stamp.
        assert_eq!(iso_from_millis(1_709_164_799_999), "2024-02-28T23:59:59.999Z");
        assert_eq!(iso_from_millis(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        assert_eq!(iso_from_millis(1_788_861_600_250), "2026-09-08T10:00:00.250Z");
    }

    #[test]
    fn now_has_the_same_shape() {
        let now = chrono_like_now_iso();
        assert_eq!(now.len(), 24, "{now}");
        assert_eq!(&now[10..11], "T");
        assert_eq!(&now[19..20], ".");
        assert!(now.ends_with('Z'));
        assert!(now[20..23].chars().all(|c| c.is_ascii_digit()), "{now}");
    }
}

// ── Cross-thread posts, app side (SWIT-52 — the `@thread` composer form) ─────
// Same record shape the MCP server's `post` tool appends; same honest limit
// (concurrent writers land last-writer-wins over an atomic rename).

const POST_TEXT_CAP: usize = 1000;
const INBOX_CAP: usize = 100;

#[tauri::command]
async fn write_thread_post(
    target_thread_id: String,
    from_title: String,
    from_id: String,
    kind: String,
    text: String,
) -> Result<(), String> {
    if !valid_thread_id(&target_thread_id) {
        return Err("invalid target thread id".into());
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("a post cannot be empty".into());
    }
    if trimmed.len() > POST_TEXT_CAP {
        return Err(format!("post too long (cap {} bytes)", POST_TEXT_CAP));
    }
    let kind = if kind == "update" { "update" } else { "request" };
    let dir = threads_data_dir()?.join(&target_thread_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("inbox.json");
    let mut posts: Vec<serde_json::Value> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            v.get("posts")
                .and_then(|p| p.as_array().cloned())
                .or_else(|| v.as_array().cloned())
        })
        .unwrap_or_default();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    posts.push(serde_json::json!({
        "id": format!("p{:x}", now_ms),
        "from": if from_title.trim().is_empty() { "you" } else { from_title.trim() },
        "fromId": from_id,
        "kind": kind,
        "text": trimmed,
        "at": chrono_like_now_iso(),
    }));
    if posts.len() > INBOX_CAP {
        let drop = posts.len() - INBOX_CAP;
        posts.drain(0..drop);
    }
    let payload = serde_json::to_string_pretty(&serde_json::json!({ "posts": posts }))
        .map_err(|e| e.to_string())?;
    let tmp = dir.join("inbox.json.tmp");
    std::fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Views (SWIT-50) ──────────────────────────────────────────────────────────

fn valid_view_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A thread's view ids, NEWEST-FIRST by modified time. The app polls this at
/// the pins cadence for the ACTIVE thread and opens ids it has not seen —
/// that is how an agent's `view show` becomes a panel tab without any push
/// channel. Missing dir = no views, the ordinary state.
#[tauri::command]
async fn list_thread_views(thread_id: String) -> Result<Vec<String>, String> {
    if !valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    let dir = threads_data_dir()?.join(&thread_id).join("views");
    let mut entries: Vec<(std::time::SystemTime, String)> = Vec::new();
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(".json") {
            if valid_view_id(id) {
                let modified = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                entries.push((modified, id.to_string()));
            }
        }
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(entries.into_iter().map(|(_, id)| id).collect())
}

/// Read one view's SPEC. Missing = "" (the tab renders its cannot-render card
/// naming the id, not an error toast).
#[tauri::command]
async fn read_thread_view(thread_id: String, view_id: String) -> Result<String, String> {
    if !valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    if !valid_view_id(&view_id) {
        return Err("invalid view id".into());
    }
    let path = threads_data_dir()?
        .join(&thread_id)
        .join("views")
        .join(format!("{}.json", view_id));
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Cap on a view's data file — over it the read refuses and the renderer's
/// card says so (the agent should aggregate or window before showing).
const VIEW_DATA_CAP: u64 = 8 * 1024 * 1024;

/// The thread's WORKING DIR, from the threads.json disk mirror — the server-
/// side root for `read_view_data`, so the data root is never client-supplied
/// (the explorer.rs posture; the frontend hands over a thread ID, not a path).
fn thread_working_dir(thread_id: &str) -> Result<std::path::PathBuf, String> {
    let raw = std::fs::read_to_string(threads_path()?)
        .map_err(|e| format!("threads mirror unreadable: {}", e))?;
    working_dir_from_mirror(&raw, thread_id)
}

/// The lookup itself, over the mirror's CONTENT — pure, so "unknown thread"
/// is testable without a disk (the attachment guard below shares it).
fn working_dir_from_mirror(raw: &str, thread_id: &str) -> Result<std::path::PathBuf, String> {
    let data: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("threads mirror unparseable: {}", e))?;
    let threads = data
        .get("threads")
        .and_then(|t| t.as_array())
        .ok_or("threads mirror has no threads array")?;
    for t in threads {
        if t.get("id").and_then(|v| v.as_str()) == Some(thread_id) {
            let dir = t
                .get("workingDir")
                .and_then(|v| v.as_str())
                .ok_or("thread has no workingDir")?;
            return Ok(std::path::PathBuf::from(dir));
        }
    }
    Err(format!("unknown thread: {}", thread_id))
}

/// Read a view's DATA file: a path RELATIVE to the thread's working dir,
/// component-validated (no `..`, no absolute/drive/UNC forms) and then
/// containment-checked against the canonicalized root — the same two-layer
/// guard kb.rs and explorer.rs use. Size-capped; the renderer windows rows
/// for display on top of this.
#[tauri::command]
async fn read_view_data(thread_id: String, rel_path: String) -> Result<String, String> {
    if !valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    // Layer 1: the RAW relative path, component-wise.
    if rel_path.is_empty() || rel_path.len() > 512 {
        return Err("invalid data path".into());
    }
    for component in rel_path.split(['/', '\\']) {
        if component.is_empty() || component == "." || component == ".." || component.contains(':') {
            return Err("data path must be relative, inside the thread's working directory".into());
        }
    }
    let root = thread_working_dir(&thread_id)?;
    let root_canon = std::fs::canonicalize(&root)
        .map_err(|e| format!("thread working dir unresolvable: {}", e))?;
    let candidate = root_canon.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    // Layer 2: containment of the CANONICALIZED final path (closes junctions;
    // canonicalize requires existence, so the final component is covered).
    let canon = std::fs::canonicalize(&candidate)
        .map_err(|e| format!("data file unreadable: {}", e))?;
    if !canon.starts_with(&root_canon) {
        return Err("data path escapes the thread's working directory".into());
    }
    let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("data path is not a file".into());
    }
    if meta.len() > VIEW_DATA_CAP {
        return Err(format!(
            "data file is {} bytes; the cap is {} — aggregate or window the rows before showing them",
            meta.len(),
            VIEW_DATA_CAP
        ));
    }
    std::fs::read_to_string(&canon).map_err(|e| e.to_string())
}

// ── Deck notes (SWIT-75) ─────────────────────────────────────────────────────
// The chart review loop's ONE write into the thread cwd: `<deck dir>/notes.json`
// — one note per drilled child, written by the APP (the agent Reads it). The
// guard is `read_view_data`'s posture narrowed to a directory: the rel dir is
// component-validated, must already EXIST (canonicalize — this command never
// creates a directory, only the file inside a deck the exporter wrote), lies
// inside the canonical root, and the FILE NAME IS FIXED — nothing about it is
// client data. The body is shape-checked and capped; refused, never repaired.

const VIEW_NOTES_FILE: &str = "notes.json";
const VIEW_NOTES_CAP: usize = 1024 * 1024;

/// Everything about the write EXCEPT the write: the target path for a deck
/// dir under a working-dir root. `""` names the root itself. Pure over the
/// filesystem it is given, so the guard tests run in a temp dir.
fn view_notes_target(root: &std::path::Path, rel_dir: &str) -> Result<std::path::PathBuf, String> {
    if rel_dir.len() > 512 {
        return Err("invalid notes dir".into());
    }
    // Layer 1: the RAW relative dir, component-wise (read_view_data's rule).
    if !rel_dir.is_empty() {
        for component in rel_dir.split(['/', '\\']) {
            if component.is_empty() || component == "." || component == ".." || component.contains(':') {
                return Err("notes dir must be relative, inside the thread's working directory".into());
            }
        }
    }
    let root_canon = std::fs::canonicalize(root)
        .map_err(|e| format!("thread working dir unresolvable: {}", e))?;
    let candidate = if rel_dir.is_empty() {
        root_canon.clone()
    } else {
        root_canon.join(rel_dir.replace('/', std::path::MAIN_SEPARATOR_STR))
    };
    // Layer 2: containment of the CANONICALIZED dir — canonicalize requires
    // existence, which is also the "never creates a directory" rule.
    let canon = std::fs::canonicalize(&candidate)
        .map_err(|e| format!("notes dir does not exist: {}", e))?;
    if !canon.starts_with(&root_canon) {
        return Err("notes dir escapes the thread's working directory".into());
    }
    let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
    if !meta.is_dir() {
        return Err("notes dir is not a directory".into());
    }
    Ok(canon.join(VIEW_NOTES_FILE))
}

/// The file's shape: `{version: 1, notes: {<key>: {text: string, …}}}` and
/// under the cap. Mirrors lib/viewNotes.ts's parse, as a REFUSAL.
fn validate_view_notes(data: &str) -> Result<(), String> {
    if data.len() > VIEW_NOTES_CAP {
        return Err(format!("notes file is {} bytes; the cap is {}", data.len(), VIEW_NOTES_CAP));
    }
    let v: serde_json::Value =
        serde_json::from_str(data).map_err(|e| format!("notes file is not JSON: {}", e))?;
    let obj = v.as_object().ok_or("notes file must be an object")?;
    if obj.get("version").and_then(|x| x.as_u64()) != Some(1) {
        return Err("notes file version must be 1".into());
    }
    let notes = obj
        .get("notes")
        .and_then(|n| n.as_object())
        .ok_or("notes file needs a notes object")?;
    for (key, note) in notes {
        if key.is_empty() {
            return Err("a note key cannot be empty".into());
        }
        let n = note.as_object().ok_or("each note must be an object")?;
        if n.get("text").and_then(|t| t.as_str()).is_none() {
            return Err(format!("note {} has no text", key));
        }
    }
    Ok(())
}

#[tauri::command]
async fn write_view_notes(thread_id: String, rel_dir: String, data: String) -> Result<(), String> {
    if !valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    validate_view_notes(&data)?;
    let root = thread_working_dir(&thread_id)?;
    let path = view_notes_target(&root, &rel_dir)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod view_notes_guard_tests {
    use super::{validate_view_notes, view_notes_target, VIEW_NOTES_CAP};
    use std::path::PathBuf;

    fn temp_root(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "switchboard-notes-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(p.join("deck").join("days")).unwrap();
        std::fs::write(p.join("deck").join("index.json"), "[]").unwrap();
        p
    }

    #[test]
    fn a_deck_dir_lands_on_its_fixed_file_name() {
        let root = temp_root("good");
        let p = view_notes_target(&root, "deck").unwrap();
        assert_eq!(p.file_name().unwrap(), "notes.json");
        assert!(p.ends_with(PathBuf::from("deck").join("notes.json")));
        // Either separator, a nested dir, and the root itself.
        assert!(view_notes_target(&root, "deck\\days").is_ok());
        assert!(view_notes_target(&root, "deck/days").is_ok());
        assert_eq!(view_notes_target(&root, "").unwrap().file_name().unwrap(), "notes.json");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn traversal_absolute_and_drive_forms_refused() {
        let root = temp_root("trav");
        for bad in ["../x", "deck/..", "deck/../..", "..", "./deck", "deck//days", "C:deck", "/deck", "\\deck"] {
            assert!(view_notes_target(&root, bad).is_err(), "{bad}");
        }
        let long = "a/".repeat(300);
        assert!(view_notes_target(&root, &long).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_dir_that_does_not_exist_is_refused_never_created() {
        let root = temp_root("missing");
        let err = view_notes_target(&root, "deck/nope").unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
        assert!(!root.join("deck").join("nope").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_is_not_a_notes_dir_and_the_name_cannot_be_chosen() {
        let root = temp_root("file");
        // Naming the index file, or a would-be notes file, as the dir: refused.
        assert!(view_notes_target(&root, "deck/index.json").is_err());
        assert!(view_notes_target(&root, "deck/notes.json").is_err());
        assert!(view_notes_target(&root, "deck/other.json").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Junction (dir reparse point) escape: `jdir` inside the root that
    /// junctions OUTSIDE it must be caught by the canonical containment
    /// check, both as the deck dir itself and as a parent (kb.rs's
    /// `write_rejects_junctioned_parent_dir_escape`, narrowed to a dir).
    /// Junctions need no privilege, so this runs everywhere on Windows.
    #[cfg(windows)]
    #[test]
    fn a_junctioned_dir_escaping_the_root_is_refused() {
        let root = temp_root("junction");
        let outside = temp_root("junction-outside");
        let junction = root.join("jdir");
        if !make_junction(&junction, &outside) {
            eprintln!("junction creation failed — skipping");
            return;
        }
        let err = view_notes_target(&root, "jdir").unwrap_err();
        assert!(err.contains("escapes"), "unexpected error: {err}");
        // A real dir REACHED THROUGH the junction (`outside/deck` exists).
        let err = view_notes_target(&root, "jdir/deck").unwrap_err();
        assert!(err.contains("escapes"), "unexpected error: {err}");
        assert!(!outside.join("notes.json").exists());
        assert!(!outside.join("deck").join("notes.json").exists());
        let _ = std::fs::remove_dir(&junction);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// Create an NTFS junction (no privilege required). Returns false if the
    /// tool or filesystem refuses. cmd's mklink rejects `\\?\` verbatim
    /// forms, so the paths are stripped for the shell (kb.rs's helper).
    #[cfg(windows)]
    fn make_junction(link: &std::path::Path, target: &std::path::Path) -> bool {
        fn plain(p: &std::path::Path) -> String {
            let s = p.to_string_lossy();
            match s.strip_prefix(r"\\?\") {
                Some(rest) => rest.to_string(),
                None => s.into_owned(),
            }
        }
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &plain(link), &plain(target)])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn body_shape_and_cap_are_refused_not_repaired() {
        assert!(validate_view_notes(r#"{"version":1,"notes":{}}"#).is_ok());
        assert!(validate_view_notes(
            r#"{"version":1,"notes":{"2026-02-19":{"text":"chase","updatedAt":"2026-09-08T10:00:00Z"}}}"#
        )
        .is_ok());
        for bad in [
            "",
            "not json",
            "[]",
            r#"{"version":2,"notes":{}}"#,
            r#"{"version":1}"#,
            r#"{"version":1,"notes":[]}"#,
            r#"{"version":1,"notes":{"":{"text":"x"}}}"#,
            r#"{"version":1,"notes":{"a":{"updatedAt":"x"}}}"#,
            r#"{"version":1,"notes":{"a":"x"}}"#,
        ] {
            assert!(validate_view_notes(bad).is_err(), "{bad}");
        }
        let big = format!(r#"{{"version":1,"notes":{{"a":{{"text":"{}"}}}}}}"#, "x".repeat(VIEW_NOTES_CAP));
        assert!(validate_view_notes(&big).is_err());
    }
}

/// Prepare a thread's LAUNCH (SWIT-49): create its data dir and write the
/// per-spawn `--mcp-config` file pointing claude at Switchboard's own MCP
/// server (a dependency-free Node script shipped as a resource). Regenerated
/// at EVERY spawn — stale config dies with the session — and thread identity
/// rides in the server's ENV, so tools carry no thread-id param. Returns the
/// config file's absolute path; any failure means the frontend simply omits
/// the flag (degraded: the thread runs without page tools, exactly as before).
#[tauri::command]
async fn prepare_thread_launch(app: tauri::AppHandle, thread_id: String) -> Result<String, String> {
    if !valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    let thread_dir = threads_data_dir()?.join(&thread_id);
    std::fs::create_dir_all(&thread_dir).map_err(|e| e.to_string())?;
    // The server script: the bundled resource in a packaged build; the
    // checkout's copy under `cargo`/`tauri dev` (resource_dir may not carry
    // dev resources on every platform, and the checkout path is exact there).
    let resource = app
        .path()
        .resource_dir()
        .ok()
        .map(|d| d.join("resources").join("mcp").join("switchboard-mcp.cjs"))
        .filter(|p| p.exists());
    let dev_copy = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("mcp")
        .join("switchboard-mcp.cjs");
    let server = match resource {
        Some(p) => p,
        None if dev_copy.exists() => dev_copy,
        None => return Err("switchboard-mcp.cjs not found in resources".into()),
    };
    let config = serde_json::json!({
        "mcpServers": {
            "switchboard": {
                "command": "node",
                "args": [server.to_string_lossy()],
                "env": {
                    "SWITCHBOARD_THREAD_ID": thread_id,
                    "SWITCHBOARD_THREAD_DIR": thread_dir.to_string_lossy(),
                    // SWIT-52: what the `post` tool needs — the threads root
                    // (to reach a TARGET thread's inbox) and the records file
                    // (to resolve a title to a thread id, read-only).
                    "SWITCHBOARD_THREADS_ROOT": threads_data_dir()?.to_string_lossy(),
                    "SWITCHBOARD_THREADS_JSON": threads_path()?.to_string_lossy(),
                    // SWIT-64: the `backlog` tool's ONE write target — the
                    // inbox the app drains. backlog.json itself is never
                    // handed to the server.
                    "SWITCHBOARD_BACKLOG_INBOX": backlog_inbox_path()?.to_string_lossy(),
                }
            }
        }
    });
    let config_path = thread_dir.join("mcp-config.json");
    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(config_path.to_string_lossy().into_owned())
}

// Thread records disk mirror (T5). Same storage pattern as scrollback: a JSON
// blob under the app's local data dir. The frontend owns the payload shape
// (threadStore.serializeThreadsForDisk); this is a dumb byte store. Written
// atomically-enough via a temp file + rename so a crash mid-write can't leave
// a truncated threads.json (the frontend treats unparseable disk content as
// "no disk copy" and would silently fall back to localStorage).
fn threads_path() -> Result<std::path::PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Cannot resolve local data dir")?;
    Ok(base.join(data_dir_name()).join("threads.json"))
}

// Serializes concurrent save_threads invocations: every writer shares one tmp
// path, so an unserialized flush racing the periodic tick could rename a
// half-written tmp over threads.json. The lock spans write+rename, making the
// pair atomic relative to other savers (single app instance; tiny payloads,
// so briefly blocking the async runtime thread is fine).
static THREADS_SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
async fn save_threads(data: String) -> Result<(), String> {
    log::debug!("Saving threads ({} bytes)", data.len());
    let path = threads_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let _guard = THREADS_SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data.as_bytes()).map_err(|e| {
        log::error!("Failed to write threads tmp file: {}", e);
        e.to_string()
    })?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        log::error!("Failed to persist threads.json: {}", e);
        e.to_string()
    })
}

#[tauri::command]
async fn load_threads() -> Result<String, String> {
    let path = threads_path()?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => {
            log::error!("Failed to load threads.json: {}", e);
            Err(e.to_string())
        }
    }
}

// ── Backlog (SWIT-64) ────────────────────────────────────────────────────────
// `backlog.json` sits beside `threads.json` under the same identity-scoped
// data dir (a `.dev` build keeps its own backlog), and the APP is its ONLY
// writer: two narrow commands, a FIXED path, and a shape check on the way in
// so a hand-edited or runaway payload never lands. The agent's `backlog` MCP
// tool never touches this file — it appends to `backlog-inbox.json`, which
// the app DRAINS (take = rename away + read + delete, so an append that
// races the drain lands in a fresh inbox rather than being lost) and folds
// into backlog.json on its 5s pass. The writer rule differs per file:
// backlog.json has ONE writer (the app); the inbox is APPEND-ONLY NDJSON
// with MANY appenders (one MCP server per live thread, one `appendFileSync`
// of one line each) and ONE taker (`take_backlog_inbox` below — a rename
// takes an append-only file exactly as it took a rewritten one; the
// frontend's line-wise parse drops a torn last line alone).
//
// Caps mirror `src/lib/backlogStore.ts` — change one, change the other.

const BACKLOG_ITEM_CAP: usize = 500;
/// Characters, not bytes: the frontend counts code points.
const BACKLOG_TEXT_CAP: usize = 500;
const BACKLOG_LINK_CAP: usize = 8;
const BACKLOG_ID_MAX: usize = 64;
const BACKLOG_REF_CAP: usize = 500;
const BACKLOG_PROJECT_CAP: usize = 64;
const BACKLOG_STAGES: [&str; 4] = ["backlog", "ticket", "spec", "done"];
const BACKLOG_LINK_KINDS: [&str; 3] = ["ticket", "spec", "thread"];
/// Bytes. Sized ABOVE the content caps, not below them: the pretty-printed
/// worst case under the caps (500 items × 500-char text + 8 × 500-char
/// refs, 4-byte UTF-8) is ~9 MB, and 2 MiB refused a backlog that every
/// other cap called legal. 8 MiB holds any realistic backlog (a real item is
/// a sentence and a link is a key or a path — ~25 KB per item at the caps,
/// under 1 KB in practice) while still stopping a runaway payload.
const BACKLOG_BYTES_CAP: usize = 8 * 1024 * 1024;

fn backlog_path() -> Result<std::path::PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Cannot resolve local data dir")?;
    Ok(base.join(data_dir_name()).join("backlog.json"))
}

fn backlog_inbox_path() -> Result<std::path::PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Cannot resolve local data dir")?;
    Ok(base.join(data_dir_name()).join("backlog-inbox.json"))
}

fn backlog_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= BACKLOG_ID_MAX
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The SHAPE gate for `write_backlog`, pure over the raw text so the tests
/// need no data dir. Refuses, never repairs: the frontend's `parseBacklog`
/// already tolerates and drops bad fields on the way IN, so anything that
/// reaches this command malformed is a caller bug.
fn validate_backlog(raw: &str) -> Result<(), String> {
    if raw.len() > BACKLOG_BYTES_CAP {
        return Err(format!("backlog too large (cap {} bytes)", BACKLOG_BYTES_CAP));
    }
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("backlog is not JSON: {}", e))?;
    let obj = v.as_object().ok_or("backlog must be an object")?;
    if obj.get("version").and_then(|x| x.as_u64()) != Some(1) {
        return Err("backlog version must be 1".into());
    }
    let items = obj
        .get("items")
        .and_then(|x| x.as_array())
        .ok_or("backlog.items must be an array")?;
    if items.len() > BACKLOG_ITEM_CAP {
        return Err(format!("too many backlog items (cap {})", BACKLOG_ITEM_CAP));
    }
    let mut ids = std::collections::HashSet::new();
    for item in items {
        let it = item.as_object().ok_or("backlog item must be an object")?;
        let id = it.get("id").and_then(|x| x.as_str()).ok_or("backlog item needs an id")?;
        if !backlog_id_ok(id) {
            return Err(format!("invalid backlog item id {:?}", id));
        }
        if !ids.insert(id.to_string()) {
            return Err(format!("duplicate backlog item id {:?}", id));
        }
        let text = it.get("text").and_then(|x| x.as_str()).ok_or("backlog item needs text")?;
        let chars = text.chars().count();
        if text.trim().is_empty() || chars > BACKLOG_TEXT_CAP {
            return Err(format!("backlog item text must be 1..={} chars", BACKLOG_TEXT_CAP));
        }
        let stage = it.get("stage").and_then(|x| x.as_str()).ok_or("backlog item needs a stage")?;
        if !BACKLOG_STAGES.contains(&stage) {
            return Err(format!("invalid backlog stage {:?}", stage));
        }
        match it.get("project") {
            None | Some(serde_json::Value::Null) => {}
            Some(serde_json::Value::String(p)) => {
                if p.chars().count() > BACKLOG_PROJECT_CAP {
                    return Err("backlog project tag too long".into());
                }
            }
            Some(_) => return Err("backlog project must be a string or null".into()),
        }
        let links = it
            .get("links")
            .and_then(|x| x.as_array())
            .ok_or("backlog item needs a links array")?;
        if links.len() > BACKLOG_LINK_CAP {
            return Err(format!("too many links on one item (cap {})", BACKLOG_LINK_CAP));
        }
        for link in links {
            let l = link.as_object().ok_or("backlog link must be an object")?;
            let kind = l.get("kind").and_then(|x| x.as_str()).ok_or("backlog link needs a kind")?;
            if !BACKLOG_LINK_KINDS.contains(&kind) {
                return Err(format!("invalid backlog link kind {:?}", kind));
            }
            let r = l.get("ref").and_then(|x| x.as_str()).ok_or("backlog link needs a ref")?;
            if r.trim().is_empty() || r.chars().count() > BACKLOG_REF_CAP {
                return Err(format!("backlog link ref must be 1..={} chars", BACKLOG_REF_CAP));
            }
        }
        for stamp in ["createdAt", "updatedAt"] {
            if !it.get(stamp).map(|x| x.is_number()).unwrap_or(false) {
                return Err(format!("backlog item needs a numeric {}", stamp));
            }
        }
    }
    Ok(())
}

static BACKLOG_SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The backlog file's text; missing = "" (no backlog yet is the ordinary
/// first state, and the frontend's parse treats "" as empty).
#[tauri::command]
async fn read_backlog() -> Result<String, String> {
    match std::fs::read_to_string(backlog_path()?) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => {
            log::error!("Failed to read backlog.json: {}", e);
            Err(e.to_string())
        }
    }
}

/// Replace backlog.json — shape-checked, tmp + rename under a lock (the
/// threads.json posture). The path is fixed; nothing about it is client data.
#[tauri::command]
async fn write_backlog(data: String) -> Result<(), String> {
    validate_backlog(&data)?;
    let path = backlog_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let _guard = BACKLOG_SAVE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        log::error!("Failed to persist backlog.json: {}", e);
        e.to_string()
    })
}

/// TAKE the agent inbox: rename it away, read it, delete it, return the text
/// ("" when there was none). The rename is what makes the drain safe against
/// a server append in flight — the server writes tmp + rename, so a new
/// entry either landed in the file we took or creates a fresh inbox after
/// it; nothing is truncated under a writer. A server whose read predates the
/// take re-emits already-taken entries on its next rename; the frontend's
/// apply is idempotent for exactly that reason.
#[tauri::command]
async fn take_backlog_inbox() -> Result<String, String> {
    let path = backlog_inbox_path()?;
    let taken = path.with_extension("json.taking");
    match std::fs::rename(&path, &taken) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.to_string()),
    }
    let content = std::fs::read_to_string(&taken).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::remove_file(&taken) {
        log::warn!("Could not remove taken backlog inbox: {}", e);
    }
    Ok(content)
}

#[cfg(test)]
mod backlog_guard_tests {
    use super::{validate_backlog, BACKLOG_ITEM_CAP, BACKLOG_LINK_CAP, BACKLOG_TEXT_CAP};

    fn item(id: &str, text: &str, stage: &str, links: &str) -> String {
        format!(
            r#"{{"id":"{}","text":"{}","project":null,"stage":"{}","links":[{}],"createdAt":1,"updatedAt":1}}"#,
            id, text, stage, links
        )
    }
    fn file(items: &[String]) -> String {
        format!(r#"{{"version":1,"items":[{}]}}"#, items.join(","))
    }

    #[test]
    fn a_well_formed_file_passes() {
        let f = file(&[
            item("a1", "look into duckdb", "backlog", ""),
            item(
                "b2",
                "spec the thing",
                "spec",
                r#"{"kind":"spec","ref":"switchboard/features/x/requirements.md"},{"kind":"thread","ref":"3f1c2a9e-0b7d-4c1e-9a55-1234567890ab"}"#,
            ),
        ]);
        assert!(validate_backlog(&f).is_ok());
        assert!(validate_backlog(r#"{"version":1,"items":[]}"#).is_ok());
    }

    #[test]
    fn shape_is_refused_not_repaired() {
        for bad in [
            "",
            "not json",
            "[]",
            r#"{"version":2,"items":[]}"#,
            r#"{"version":1}"#,
            r#"{"version":1,"items":{}}"#,
            r#"{"version":1,"items":[null]}"#,
            r#"{"version":1,"items":[{"id":"a","text":"x","stage":"backlog","links":[]}]}"#, // no stamps
        ] {
            assert!(validate_backlog(bad).is_err(), "{bad}");
        }
        assert!(validate_backlog(&file(&[item("a", "x", "later", "")])).is_err());
        assert!(validate_backlog(&file(&[item("../a", "x", "backlog", "")])).is_err());
        assert!(validate_backlog(&file(&[item("a", "   ", "backlog", "")])).is_err());
        assert!(validate_backlog(&file(&[item("a", "x", "backlog", r#"{"kind":"pr","ref":"1"}"#)])).is_err());
        assert!(validate_backlog(&file(&[item("a", "x", "backlog", r#"{"kind":"ticket","ref":""}"#)])).is_err());
        assert!(validate_backlog(&file(&[item("a", "x", "backlog", ""), item("a", "y", "backlog", "")])).is_err());
    }

    #[test]
    fn caps_are_enforced() {
        let long = "é".repeat(BACKLOG_TEXT_CAP);
        assert!(validate_backlog(&file(&[item("a", &long, "backlog", "")])).is_ok());
        let longer = "é".repeat(BACKLOG_TEXT_CAP + 1);
        assert!(validate_backlog(&file(&[item("a", &longer, "backlog", "")])).is_err());
        let links_ok: Vec<String> = (0..BACKLOG_LINK_CAP)
            .map(|i| format!(r#"{{"kind":"ticket","ref":"SWIT-{}"}}"#, i))
            .collect();
        assert!(validate_backlog(&file(&[item("a", "x", "ticket", &links_ok.join(","))])).is_ok());
        let mut links_over = links_ok.clone();
        links_over.push(r#"{"kind":"ticket","ref":"SWIT-99"}"#.to_string());
        assert!(validate_backlog(&file(&[item("a", "x", "ticket", &links_over.join(","))])).is_err());
        let many: Vec<String> = (0..BACKLOG_ITEM_CAP)
            .map(|i| item(&format!("i{}", i), "x", "backlog", ""))
            .collect();
        assert!(validate_backlog(&file(&many)).is_ok());
        let mut over = many.clone();
        over.push(item("extra", "x", "backlog", ""));
        assert!(validate_backlog(&file(&over)).is_err());
    }
}

// ── Claude session ground truth (T5 review gate 3) ──────────────────────────
// claude persists a conversation transcript at
//   ~/.claude/projects/<munged-cwd>/<session_id>.jsonl
// only after the first real turn. Checking that file is the GROUND TRUTH for
// "--resume vs --session-id" at revive time — the frontend's chatStarted flag
// is a UI hint that can false-positive (typing into the shell after claude
// exits) and false-negative (first turn typed in the PiP window bypasses the
// main window's detector). Disk truth heals both directions.
//
// Munging convention, verified against the real directory names in
// ~/.claude/projects/ on this machine (e.g. C:\Users\ericm\projects\orbit →
// C--Users-ericm-projects-orbit, C:\Users\ericm → C--Users-ericm): every
// non-alphanumeric character becomes '-' (drive colon included: "C:" → "C-"),
// CASE PRESERVED (…-Antigravity-… and …-antigravity coexist as distinct
// dirs). Separators and colons are the cases proven by those dirs; the
// broader non-alphanumeric rule matches claude-code's implementation for
// characters (dots, underscores) that no local project path exercises.

/// Munge an absolute cwd into claude's project-directory name. Accepts either
/// slash style, a verbatim prefix (\\?\C:\… or \\?\UNC\server\share), and
/// trailing separators.
fn munge_claude_project_dir(cwd: &str) -> String {
    // Verbatim prefixes: \\?\UNC\server\share is really \\server\share;
    // \\?\C:\… is really C:\… (same normalization create_session applies).
    let normalized: String = if let Some(rest) = cwd.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = cwd.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        cwd.to_string()
    };
    let trimmed = normalized.trim_end_matches(['\\', '/']);
    trimmed
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

#[tauri::command]
async fn claude_session_exists(working_dir: String, session_id: String) -> Result<bool, String> {
    // session_id is interpolated into a filename — hold it to uuid shape.
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("invalid session id".to_string());
    }
    let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
    let path = home
        .join(".claude")
        .join("projects")
        .join(munge_claude_project_dir(&working_dir))
        .join(format!("{}.jsonl", session_id));
    let exists = path.is_file();
    log::debug!(
        "claude_session_exists dir={} id={} -> {}",
        working_dir,
        session_id,
        exists
    );
    Ok(exists)
}

#[cfg(test)]
mod claude_munge_tests {
    use super::munge_claude_project_dir;

    #[test]
    fn windows_path_with_drive_colon() {
        // Verified against the real dir C--Users-ericm-projects-orbit
        assert_eq!(
            munge_claude_project_dir(r"C:\Users\ericm\projects\orbit"),
            "C--Users-ericm-projects-orbit"
        );
    }

    #[test]
    fn short_path() {
        // Verified against the real dir C--Users-ericm
        assert_eq!(munge_claude_project_dir(r"C:\Users\ericm"), "C--Users-ericm");
    }

    #[test]
    fn forward_slashes_equivalent() {
        assert_eq!(
            munge_claude_project_dir("C:/Users/ericm/projects/orbit"),
            "C--Users-ericm-projects-orbit"
        );
    }

    #[test]
    fn case_preserved() {
        // …-Antigravity-… and …-antigravity exist as DISTINCT real dirs
        assert_eq!(
            munge_claude_project_dir(r"C:\Users\ericm\projects\Antigravity\nba-jarvis"),
            "C--Users-ericm-projects-Antigravity-nba-jarvis"
        );
    }

    #[test]
    fn trailing_separators_trimmed() {
        assert_eq!(
            munge_claude_project_dir(r"C:\Users\ericm\projects\orbit\"),
            "C--Users-ericm-projects-orbit"
        );
        assert_eq!(
            munge_claude_project_dir("C:/Users/ericm/projects/orbit/"),
            "C--Users-ericm-projects-orbit"
        );
    }

    #[test]
    fn verbatim_prefix_stripped() {
        assert_eq!(
            munge_claude_project_dir(r"\\?\C:\Users\ericm\projects\orbit"),
            "C--Users-ericm-projects-orbit"
        );
    }

    #[test]
    fn verbatim_unc_prefix() {
        assert_eq!(
            munge_claude_project_dir(r"\\?\UNC\server\share\repo"),
            "--server-share-repo"
        );
    }

    #[test]
    fn dots_and_underscores_munge_to_dashes() {
        // No local project path exercises these; rule follows claude-code's
        // non-alphanumeric convention.
        assert_eq!(
            munge_claude_project_dir(r"C:\repos\my_app.v2"),
            "C--repos-my-app-v2"
        );
    }
}

// ── Claude discovery (increment C) ──────────────────────────────────────────
// Answers "is a claude conversation running inside any of these tabs, and
// which one?" by walking each tab's PTY process tree — see discovery.rs for
// the mechanism, the two guards, and why session-file cwd matching was
// rejected. OBSERVE-ONLY: a process snapshot plus some JSON reads. Nothing on
// this path can write to a shell.
#[tauri::command]
async fn discover_claude_sessions(
    state: State<'_, Arc<AppState>>,
    session_ids: Vec<String>,
) -> Result<Vec<ClaudeDiscovery>, String> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    // shell_candidates has already dropped tabs whose shell EXITED (a dead
    // shell's pid is reusable, so it must not be a walk root — see
    // PtyManager::shell_candidates). Guard 3's second half runs here: ask the
    // OS when the process currently holding each pid was created and drop any
    // root that post-dates our own spawn. That catches the window where the
    // shell is gone but its reader has not reached EOF yet.
    let shells: Vec<_> = state
        .pty_manager
        .shell_candidates(&session_ids)?
        .into_iter()
        .filter(|s| {
            let created = discovery::process_start_time_ms(s.shell_pid);
            let ours = discovery::shell_pid_is_ours(created, s.spawned_at_ms);
            if !ours {
                log::warn!(
                    "Claude discovery refused: tab {} shell pid {} was created at {:?}, after our spawn at {} — the pid was recycled, not walking it",
                    s.session_id, s.shell_pid, created, s.spawned_at_ms
                );
            }
            ours
        })
        .collect();
    if shells.is_empty() {
        return Ok(Vec::new());
    }
    let files = discovery::read_claude_session_files();
    if files.is_empty() {
        return Ok(Vec::new());
    }
    let edges = discovery::process_edges();
    let (found, refused) = discovery::resolve_bindings(&shells, &edges, &files);
    // Refusals are NEVER silent: a promotion that didn't happen because two
    // candidates matched is the exact thing that would otherwise look like a
    // bug with no trace.
    for reason in refused {
        log::warn!("Claude discovery refused: {}", reason);
    }
    // Deliberately NO per-discovery log line: this command runs on a poll, so a
    // line per bound tab would be thousands of identical entries a day. The
    // frontend logs the state CHANGES (promoted / rebound / adopted), which is
    // the part worth reading; refusals above are rare and always logged.
    Ok(found)
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn confirm_app_close(app_handle: tauri::AppHandle) {
    log::info!("App close confirmed by user, exiting");
    app_handle.exit(0);
}

const PIP_WINDOW_LABEL: &str = "pip";

/// Open the floating window.
///
/// It hosts ONE of two things, decided here by which query param the URL
/// carries (increment F, Decision 2 — one window lifecycle, not a second
/// window type):
///   · `?session=<id>`  — a mirrored terminal (the original Ctrl+Shift+O), or
///   · `?artifact=<json>` — an artifact popped out of the panel.
///
/// `artifact` is the URL-ENCODED JSON of the Artifact record, encoded by the
/// caller (`encodeURIComponent`) so it survives the query string. This command
/// does not parse it: the shape belongs to the frontend's `sanitizeArtifact`,
/// which the PiP page runs on it before rendering anything, exactly like every
/// other load path.
#[tauri::command]
async fn open_pip_window(
    app_handle: tauri::AppHandle,
    session_id: String,
    artifact: Option<String>,
) -> Result<(), String> {
    if app_handle.get_webview_window(PIP_WINDOW_LABEL).is_some() {
        log::debug!("PiP window already open, no-op");
        return Ok(());
    }

    log::info!(
        "Opening PiP window for session id={} artifact={}",
        session_id,
        artifact.is_some()
    );

    let url = match artifact.as_deref() {
        Some(encoded) if !encoded.is_empty() => {
            format!("pip.html?session={}&artifact={}", session_id, encoded)
        }
        _ => format!("pip.html?session={}", session_id),
    };
    tauri::WebviewWindowBuilder::new(
        &app_handle,
        PIP_WINDOW_LABEL,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("Switchboard — Floating")
    .inner_size(800.0, 500.0)
    .always_on_top(true)
    .decorations(false)
    .skip_taskbar(true)
    .resizable(true)
    .focused(true)
    .build()
    .map_err(|e| {
        log::error!("Failed to open PiP window: {}", e);
        e.to_string()
    })?;

    Ok(())
}

#[tauri::command]
fn close_pip_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window(PIP_WINDOW_LABEL) {
        log::info!("Closing PiP window");
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn is_pip_window_open(app_handle: tauri::AppHandle) -> bool {
    app_handle.get_webview_window(PIP_WINDOW_LABEL).is_some()
}

/// A SURFACE WINDOW (platform evolution, Inc 5d — SWIT-42): one project page
/// in its own always-on-top window — Lodestar's trading HUD over NinjaTrader
/// is the first. Generalised from the PiP: same `pip.html` entry, a
/// `?surface=<encoded artifact json>` param instead of `?session=`, and a
/// label PER PAGE (`surface-<project>-<page>`) so a HUD and a popped-out doc
/// never fight over one window. Opening an already-open one FOCUSES it.
///
/// The label is validated here, not trusted from the frontend: Tauri labels
/// are `[A-Za-z0-9-/:_]`, and a label is also a lookup key.
#[tauri::command]
async fn open_surface_window(
    app_handle: tauri::AppHandle,
    label: String,
    artifact: String,
    title: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if label.is_empty()
        || !label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid surface window label {:?}", label));
    }
    if artifact.is_empty() {
        return Err("surface window needs an artifact".into());
    }
    if let Some(existing) = app_handle.get_webview_window(&label) {
        log::debug!("Surface window {} already open, focusing", label);
        let _ = existing.set_focus();
        return Ok(());
    }
    let w = if width.is_finite() { width.clamp(200.0, 1600.0) } else { 380.0 };
    let h = if height.is_finite() { height.clamp(120.0, 1200.0) } else { 260.0 };
    log::info!("Opening surface window {} ({}x{})", label, w, h);
    tauri::WebviewWindowBuilder::new(
        &app_handle,
        &label,
        tauri::WebviewUrl::App(format!("pip.html?surface={}", artifact).into()),
    )
    .title(if title.is_empty() { "Switchboard — Surface".to_string() } else { title })
    .inner_size(w, h)
    .always_on_top(true)
    .decorations(false)
    .skip_taskbar(true)
    .resizable(true)
    .focused(true)
    .build()
    .map_err(|e| {
        log::error!("Failed to open surface window {}: {}", label, e);
        e.to_string()
    })?;
    Ok(())
}

#[tauri::command]
fn close_surface_window(app_handle: tauri::AppHandle, label: String) -> Result<(), String> {
    // Only a SURFACE window closes this way — never `main` (its close is the
    // confirm flow) and never the PiP (its own command owns that lifecycle).
    if !label.starts_with("surface-") {
        return Err(format!("not a surface window: {:?}", label));
    }
    if let Some(window) = app_handle.get_webview_window(&label) {
        log::info!("Closing surface window {}", label);
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// PNG-encode a clipboard image off the hotkey thread and emit it as
/// `clipboard-paste-image` `{ dataBase64, byteLength }`. The frontend stages it
/// for the FOCUSED composer only (App.tsx); anywhere else it is dropped, as an
/// image paste always was. Oversize images are logged and dropped here so a
/// 4K wallpaper does not cross the bridge just to be refused.
fn emit_clipboard_image(app: tauri::AppHandle, rgba: Vec<u8>, width: u32, height: u32) {
    use base64::Engine;
    std::thread::spawn(move || {
        if width == 0 || height == 0 || rgba.len() != (width as usize) * (height as usize) * 4 {
            log::warn!(
                "Clipboard image has an unexpected shape ({}x{}, {} bytes)",
                width,
                height,
                rgba.len()
            );
            return;
        }
        let mut png_bytes: Vec<u8> = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = match encoder.write_header() {
                Ok(w) => w,
                Err(e) => {
                    log::error!("Clipboard image: png header failed: {}", e);
                    return;
                }
            };
            if let Err(e) = writer.write_image_data(&rgba) {
                log::error!("Clipboard image: png encode failed: {}", e);
                return;
            }
        }
        if png_bytes.len() > ATTACHMENT_CAP {
            log::warn!("Clipboard image too large to paste ({} bytes)", png_bytes.len());
            return;
        }
        log::debug!(
            "Clipboard image paste triggered, {}x{}, png bytes={}",
            width,
            height,
            png_bytes.len()
        );
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
        let _ = app.emit(
            "clipboard-paste-image",
            serde_json::json!({ "dataBase64": data_base64, "byteLength": png_bytes.len() }),
        );
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState {
        pty_manager: PtyManager::new(),
    });

    // Paste interception modifier is platform-aware: Cmd+V on macOS, Ctrl+V everywhere else.
    // The shortcut name stays `paste_shortcut` so the rest of the code reads naturally.
    #[cfg(target_os = "macos")]
    let paste_shortcut = Shortcut::new(Some(Modifiers::SUPER), Code::KeyV);
    #[cfg(not(target_os = "macos"))]
    let paste_shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyV);

    // Debounce for the blur-side hotkey UNREGISTER below: each blur bumps the
    // generation and arms a timer; a re-focus (or a newer blur) bumps it
    // again, so only a blur that STAYS unfocused for the window actually
    // unregisters Ctrl+V.
    const BLUR_UNREGISTER_MS: u64 = 500;
    let blur_generation: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .max_file_size(2_000_000) // 2 MB per file
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Ok(text) = app.clipboard().read_text() {
                            if !text.is_empty() {
                                log::debug!("Clipboard paste triggered, content length={}", text.len());
                                let _ = app.emit("clipboard-paste", text);
                                return;
                            }
                        }
                        // No text: an IMAGE (a screenshot) is the other thing
                        // a clipboard holds (SWIT-59). RegisterHotKey consumed
                        // the keystroke, so the webview will never see a paste
                        // event for it — encode it here and hand it over.
                        if let Ok(image) = app.clipboard().read_image() {
                            emit_clipboard_image(
                                app.clone(),
                                image.rgba().to_vec(),
                                image.width(),
                                image.height(),
                            );
                        }
                    }
                })
                .build(),
        )
        .manage(app_state)
        .setup(move |app| {
            // Identity-scoped local data (SWIT-29): a `.dev` identifier gets
            // its own scrollback + threads folder. Set before any command can
            // run, so no path is ever computed under the wrong name.
            let identifier = app.config().identifier.clone();
            let _ = DATA_DIR_NAME.set(
                if identifier.ends_with(".dev") { "switchboard-dev" } else { "switchboard" }.to_string(),
            );
            log::info!("Local data folder: {} (identifier {})", data_dir_name(), identifier);

            // THE IPC ORIGIN ALLOWLIST — installed BEFORE anything can invoke.
            // Derived from the app's own config, never from a webview round
            // trip (see ipc_guard.rs for why per-invoke `Webview::url()` is not
            // an option). `is_dev` gates the dev server's origin so the same
            // tauri.conf.json cannot hand IPC to port 1620 in a shipped build.
            ipc_guard::install_app_origins(
                app.config().build.dev_url.as_ref().map(|u| u.as_str()),
                tauri::is_dev(),
            );

            // Set window icon from bundled PNG
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/icon.png")) {
                    let _ = window.set_icon(icon);
                }

                // Install native power monitor for sleep/wake detection
                power::install_power_monitor(&window, app.handle().clone());
            }

            // Register the paste shortcut globally so it fires at the OS
            // level, catching both real keystrokes and simulated ones from
            // tools like Wispr Flow (which don't reach the webview).
            // Modifier is Cmd on macOS, Ctrl elsewhere (see definition above).
            app.global_shortcut().register(paste_shortcut)?;
            Ok(())
        })
        .on_window_event(move |window, event| {
            match event {
                // Register the global shortcut only while our MAIN window is
                // focused so we don't steal the paste shortcut from other apps.
                // The PiP window's focus events are intentionally ignored here
                // — PiP paste routing is handled separately (see SWIT-36/37).
                tauri::WindowEvent::Focused(focused) => {
                    if window.label() != "main" {
                        return;
                    }
                    let app = window.app_handle();
                    if *focused {
                        // A re-focus cancels any pending debounced unregister
                        // (below); registration stays IMMEDIATE.
                        blur_generation.fetch_add(1, Ordering::SeqCst);
                        log::debug!("Main window focused, registering paste shortcut");
                        let _ = app.global_shortcut().register(paste_shortcut);
                    } else {
                        // DEBOUNCED unregister (0.5.2). A snipping overlay
                        // flips focus several times within a couple of
                        // seconds, and the old immediate unregister left
                        // Ctrl+V unowned in the gap — Eric's first paste
                        // after a screenshot produced no hotkey event at
                        // all. A blur arms a BLUR_UNREGISTER_MS timer; a
                        // re-focus bumps the generation and the stale timer
                        // stands down. HONEST TRADE: for up to 500ms after
                        // really switching away, Switchboard still consumes
                        // a Ctrl+V meant for the other app; that paste is
                        // retryable, while a swallowed image paste into OUR
                        // window was a silent loss. Taken deliberately.
                        let generation = blur_generation.fetch_add(1, Ordering::SeqCst) + 1;
                        let generation_ref = blur_generation.clone();
                        let app = app.clone();
                        log::debug!("Main window unfocused, debouncing paste shortcut unregister");
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(BLUR_UNREGISTER_MS));
                            let main_app = app.clone();
                            // The generation is re-checked ON the main thread,
                            // right beside the unregister (RegisterHotKey is
                            // thread-affine on Windows, and the plugin's calls
                            // belong on the main thread anyway), so a focus
                            // racing the timer cannot lose.
                            let _ = app.run_on_main_thread(move || {
                                if generation_ref.load(Ordering::SeqCst) == generation {
                                    log::debug!("Main window still unfocused, unregistering paste shortcut");
                                    let _ = main_app.global_shortcut().unregister(paste_shortcut);
                                }
                            });
                        });
                    }
                }
                // Emit file paths when files are dropped onto the window
                tauri::WindowEvent::DragDrop(drag_event) => {
                    if let tauri::DragDropEvent::Drop { paths, .. } = drag_event {
                        let path_strings: Vec<String> = paths
                            .iter()
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect();
                        if !path_strings.is_empty() {
                            let _ = window.emit("file-drop", path_strings);
                        }
                    }
                }
                // Intercept the OS close request on the MAIN window so the
                // frontend can prompt for confirmation. The PiP window closes
                // normally — its label is checked here.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        log::debug!("Main window close requested, deferring to frontend confirmation");
                        api.prevent_close();
                        let _ = window.emit("app-close-requested", ());
                    }
                }
                // PiP window destroyed — fires for OS-level closes (Alt+F4,
                // taskbar close) as well as our in-window X button. Emits the
                // same `pip:closing` event the X button does so main tears
                // down its router and clears pipSessionId, instead of leaving
                // the listener subscribed and forwarding to a dead window.
                tauri::WindowEvent::Destroyed => {
                    if window.label() == PIP_WINDOW_LABEL {
                        log::debug!("PiP window destroyed, notifying main");
                        let _ = window.app_handle().emit("pip:closing", ());
                    }
                }
                _ => {}
            }
        })
        // EVERY app command goes through the origin gate first (ipc_guard.rs).
        // `generate_handler!` expands to a plain closure, so wrapping it is the
        // whole mechanism — there is no second entry point into these commands.
        //
        // What this covers and what it does NOT: `plugin:`/`core:` commands
        // never reach here (tauri dispatches them to `extend_api` earlier) and
        // do not need to — they are already ACL-gated to `ExecutionContext::
        // Local` because capabilities/default.json declares no `remote` URLs.
        // The app's own commands were the ones falling through, and this closes
        // exactly that gap. Anything added to the list below inherits the gate
        // by construction.
        .invoke_handler(move |invoke| {
            let origin = invoke
                .message
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            if !ipc_guard::is_app_origin(origin.as_deref()) {
                log::error!(
                    "IPC REJECTED: command {:?} from origin {:?} (webview {:?}) — not the app's own document",
                    invoke.message.command(),
                    origin.as_deref().unwrap_or("<none>"),
                    invoke.message.webview_ref().label(),
                );
                invoke.resolver.reject(ipc_guard::REJECTION);
                return true;
            }
            app_commands(invoke)
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// The app's command table. Split out of the builder so the origin gate above
/// reads as one decision rather than being buried in a macro invocation.
fn app_commands(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    // The `fn` ascription is load-bearing, not decoration: `generate_handler!`
    // expands to a capture-less closure whose parameter type is normally pinned
    // by `invoke_handler`'s trait bound. Wrapping it removes that bound, and
    // without an expected type the closure body cannot be inferred (E0282).
    // Capture-less means it coerces to a plain fn pointer, so this costs
    // nothing.
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        create_session,
        restart_session,
        close_session,
        write_to_session,
        resize_session,
        rename_session,
        list_sessions,
        get_config,
        scrollback_root,
        threads_root,
        read_thread_file,
        thread_files_stamp,
        prepare_thread_launch,
        list_thread_views,
        read_thread_view,
        read_view_data,
        write_view_notes,
        write_thread_answer,
        mark_thread_answers_sent,
        retract_thread_evidence,
        append_convention,
        save_thread_attachment,
        save_transcript,
        save_scrollback,
        load_scrollback,
        save_threads,
        load_threads,
        read_backlog,
        write_backlog,
        take_backlog_inbox,
        claude_session_exists,
        discover_claude_sessions,
        clear_scrollback,
        clear_session_scrollback,
        get_home_dir,
        kb::kb_root,
        kb::kb_list_docs,
        kb::kb_read_doc,
        kb::kb_write_doc,
        kb::list_scratch_views,
        write_thread_post,
        explorer::explorer_projects,
        explorer::explorer_list,
        explorer::explorer_read,
        explorer::explorer_write,
        write_file,
        confirm_app_close,
        open_pip_window,
        open_surface_window,
        close_surface_window,
        close_pip_window,
        is_pip_window_open,
    ];
    handler(invoke)
}
