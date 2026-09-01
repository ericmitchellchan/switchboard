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
// inbox.json (written by the app, SWIT-51/52). ONE WRITER PER FILE is the
// design; the shell only READS here, and the guard posture mirrors kb.rs:
// the thread id is validated component-wise (uuid alphabet only — no
// separators, so no traversal is expressible) and the file name comes from a
// closed allowlist, never from the caller's imagination.

fn threads_data_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Cannot resolve local data dir")?;
    Ok(base.join(data_dir_name()).join("threads"))
}

/// The files a thread dir may hold in this increment. SWIT-50 extends this
/// with the views/ listing through its own guarded command.
const THREAD_FILES: [&str; 3] = ["page.json", "answers.json", "inbox.json"];

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

// ── Question answers (SWIT-51) ───────────────────────────────────────────────
// The APP is answers.json's SOLE writer (one-writer-per-file: page.json is
// the MCP server's, this file is ours). Read-modify-write server-side,
// atomic via tmp+rename so the server's read-only glance and the app's own
// 2.5s poll never see a torn file. Single app instance; a lock is overkill.

const ANSWER_TEXT_CAP: usize = 4000;

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
    // Tolerant read: junk degrades to an empty record rather than blocking
    // the one path that must never lose Eric's typed answer.
    let mut answers: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let now_iso = chrono_like_now_iso();
    answers.insert(
        question_id,
        serde_json::json!({ "text": trimmed, "at": now_iso }),
    );
    let payload = serde_json::to_string_pretty(&serde_json::Value::Object(answers))
        .map_err(|e| e.to_string())?;
    let tmp = dir.join("answers.json.tmp");
    std::fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    Ok(())
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

/// ISO-8601 UTC "now" without pulling the chrono crate in for one format:
/// seconds precision is plenty for an answer stamp.
fn chrono_like_now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
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
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, d, h, m, s
    )
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
                        log::debug!("Main window focused, registering paste shortcut");
                        let _ = app.global_shortcut().register(paste_shortcut);
                    } else {
                        log::debug!("Main window unfocused, unregistering paste shortcut");
                        let _ = app.global_shortcut().unregister(paste_shortcut);
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
        prepare_thread_launch,
        list_thread_views,
        read_thread_view,
        read_view_data,
        write_thread_answer,
        append_convention,
        save_thread_attachment,
        save_transcript,
        save_scrollback,
        load_scrollback,
        save_threads,
        load_threads,
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
