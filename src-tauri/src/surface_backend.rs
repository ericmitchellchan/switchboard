// ── A surface's backend starts when its page opens (SWIT-154) ──────────────
//
// Eric, 2026-10-25: after a laptop restart, Kalshi Trading showed "lodestar's
// backend is not answering" and nothing started it — "shouldn't it be built
// so that if I open this page it starts automatically?". Until then the shell
// started no servers (the localhost-preview rule) and the card printed a
// command for a person to run. For SURFACE backends that rule is replaced:
// the host asks for its backend when the health probe misses, and this
// module starts it.
//
// THE COMMAND NEVER CROSSES IPC. The page names a project; `STARTERS` below
// says what runs for it, in the project's first registry repo
// (`registry.json` → `projects.<key>.repos[0]` under `conventions.reposRoot`).
// A project absent from the table cannot be started, whatever the caller
// sends.
//
// It runs through the jobs module's supervisor (command and cwd as data
// files, a detached windowless wrapper that is nobody's child, log.txt
// rotated) in a per-project dir —
// `%LOCALAPPDATA%/<data_dir_name()>/surface-backends/<project>/` — OUTSIDE
// the jobs index: it belongs to no thread, so no thread gets its end line and
// it never counts against a thread's job cap.
//
// ONE START AT A TIME. `started.json` holds the wrapper's pid and creation
// time; while that process is alive (pid AND creation time match — a
// recycled pid reads as gone), a second ask answers "running" and spawns
// nothing. The host paces its asks too (backendStart.ts); this is the guard
// that holds when two hosts (the panel and a full-width page) ask at once.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// project key → the command its backend starts with. `pnpm backend` brings
/// up Lodestar's :5433 data container first, then the API on :8799;
/// `--if-down` makes it leave alone a backend that answers or is booting
/// (it never reclaims the port from one).
const STARTERS: &[(&str, &str)] = &[("lodestar", "pnpm backend --if-down")];

pub fn starter_for(project: &str) -> Option<&'static str> {
    STARTERS.iter().find(|(p, _)| *p == project).map(|(_, c)| *c)
}

/// The previous run's log is kept as `log.prev.txt` so a failed start can be
/// read after the next one begins.
const PREV_LOG: &str = "log.prev.txt";
const STARTED_FILE: &str = "started.json";

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Started {
    pid: u32,
    pid_started_at: u64,
    started_at: u64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StartOutcome {
    /// "started" = spawned now; "running" = a start from earlier is still alive.
    pub outcome: &'static str,
    /// Where its output goes — the card prints it when the start fails.
    pub log: String,
}

pub fn surface_backends_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Cannot resolve local data dir")?;
    Ok(base.join(super::data_dir_name()).join("surface-backends"))
}

static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Start `project`'s backend in `repo` unless a previous start is still
/// alive. `alive` and `spawn` are injected so the tests never start a
/// process (jobs.rs's rule).
pub fn start_backend(
    base: &Path,
    project: &str,
    repo: &Path,
    alive: &dyn Fn(u32, u64) -> bool,
    spawn: &dyn Fn(&Path, &str, &Path) -> Result<(u32, u64), String>,
) -> Result<StartOutcome, String> {
    let command = starter_for(project).ok_or("this project has no backend start")?;
    // The key becomes a dir name: registry keys are [a-z0-9-], and a table
    // entry is the only way in, but the path is checked anyway.
    if !super::jobs::job_name_ok(project) {
        return Err("invalid project key".into());
    }
    let cwd = super::jobs::cwd_ok(&repo.to_string_lossy())?;
    let dir = base.join(project);
    let log = dir.join("log.txt").to_string_lossy().into_owned();

    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(raw) = std::fs::read_to_string(dir.join(STARTED_FILE)) {
        if let Ok(prev) = serde_json::from_str::<Started>(&raw) {
            if alive(prev.pid, prev.pid_started_at) {
                return Ok(StartOutcome { outcome: "running", log });
            }
        }
    }
    // A fresh run: keep the last log, drop the last exit, rewrite the files.
    let _ = std::fs::rename(dir.join("log.txt"), dir.join(PREV_LOG));
    let _ = std::fs::remove_file(dir.join("exit.json"));
    super::jobs::write_job_files(&dir, command, &cwd, 0)?;
    let exe = super::jobs::powershell_exe();
    let line = super::jobs::wrapper_command_line(&exe, &dir.join("run.ps1"));
    let (pid, pid_started_at) = spawn(&exe, &line, &dir)?;
    let rec = Started { pid, pid_started_at, started_at: now_ms() };
    // The process is already running: a failed record is logged, never an
    // Err — an Err here would read as "nothing started" and invite a second.
    match serde_json::to_string(&rec) {
        Ok(body) => {
            if let Err(e) = std::fs::write(dir.join(STARTED_FILE), body) {
                log::warn!("Surface backend {}: {} not written: {}", project, STARTED_FILE, e);
            }
        }
        Err(e) => log::warn!("Surface backend {}: {} not encoded: {}", project, STARTED_FILE, e),
    }
    log::info!("Surface backend started project={} pid={}", project, pid);
    Ok(StartOutcome { outcome: "started", log })
}

/// The project's first repo, from the registry the Explorer reads.
fn repo_of(project: &str) -> Result<PathBuf, String> {
    super::explorer::load_registry()?
        .into_iter()
        .find(|p| p.key == project)
        .and_then(|p| p.repos.into_iter().next())
        .map(PathBuf::from)
        .ok_or_else(|| "the project has no repo in registry.json".to_string())
}

/// Start a surface's backend (the host calls it when the health probe
/// misses). Returns `StartOutcome` as JSON.
#[tauri::command]
pub async fn surface_backend_start(project: String) -> Result<String, String> {
    if starter_for(&project).is_none() {
        return Err("this project has no backend start".into());
    }
    let repo = repo_of(&project)?;
    let out = start_backend(
        &surface_backends_dir()?,
        &project,
        &repo,
        &super::jobs::process_matches,
        &super::jobs::spawn_detached,
    )?;
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sb-surface-backend-{}-{}", name, uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn only_a_listed_project_has_a_start() {
        assert_eq!(starter_for("lodestar"), Some("pnpm backend --if-down"));
        assert_eq!(starter_for("orbit"), None);
        assert_eq!(starter_for("lodestar; calc"), None);
    }

    #[test]
    fn an_unlisted_project_is_refused_without_spawning() {
        let base = tmp("unlisted");
        let spawned = Cell::new(0);
        let r = start_backend(&base, "orbit", &base, &|_, _| false, &|_, _, _| {
            spawned.set(spawned.get() + 1);
            Ok((1, 1))
        });
        assert!(r.is_err());
        assert_eq!(spawned.get(), 0);
    }

    #[test]
    fn starts_once_then_answers_running_while_the_first_is_alive() {
        let base = tmp("once");
        let repo = tmp("repo");
        let spawned = Cell::new(0);
        let spawn = |_: &Path, _: &str, _: &Path| {
            spawned.set(spawned.get() + 1);
            Ok((4242, 777))
        };
        let alive = |pid: u32, at: u64| pid == 4242 && at == 777;
        let first = start_backend(&base, "lodestar", &repo, &alive, &spawn).unwrap();
        assert_eq!(first.outcome, "started");
        let second = start_backend(&base, "lodestar", &repo, &alive, &spawn).unwrap();
        assert_eq!(second.outcome, "running");
        assert_eq!(spawned.get(), 1);
        // The command is the table's, written as data for the supervisor.
        let cmd = std::fs::read_to_string(base.join("lodestar").join("command.txt")).unwrap();
        assert_eq!(cmd, "pnpm backend --if-down");
    }

    #[test]
    fn a_dead_previous_start_is_replaced_and_its_log_kept() {
        let base = tmp("dead");
        let repo = tmp("repo2");
        let spawn = |_: &Path, _: &str, _: &Path| Ok((9, 9));
        start_backend(&base, "lodestar", &repo, &|_, _| false, &spawn).unwrap();
        let dir = base.join("lodestar");
        std::fs::write(dir.join("log.txt"), "port busy\n").unwrap();
        std::fs::write(dir.join("exit.json"), "{\"code\":1}").unwrap();
        let again = start_backend(&base, "lodestar", &repo, &|_, _| false, &spawn).unwrap();
        assert_eq!(again.outcome, "started");
        assert_eq!(std::fs::read_to_string(dir.join(PREV_LOG)).unwrap(), "port busy\n");
        assert!(!dir.join("exit.json").exists());
        assert_eq!(std::fs::read_to_string(dir.join("log.txt")).unwrap(), "");
    }

    /// Starts the REAL backend from the real registry — a manual check, not CI:
    /// `cargo test --lib surface_backend -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_start_of_the_lodestar_backend() {
        let repo = repo_of("lodestar").unwrap();
        let out = start_backend(
            &surface_backends_dir().unwrap(),
            "lodestar",
            &repo,
            &crate::jobs::process_matches,
            &crate::jobs::spawn_detached,
        )
        .unwrap();
        println!("{:?}", out);
    }

    #[test]
    fn a_missing_repo_dir_is_refused() {
        let base = tmp("norepo");
        let r = start_backend(&base, "lodestar", &base.join("nope"), &|_, _| false, &|_, _, _| Ok((1, 1)));
        assert!(r.is_err());
    }
}
