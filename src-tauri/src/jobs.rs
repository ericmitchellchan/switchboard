// ── Jobs that outlive the session (SWIT-109) ────────────────────────────────
//
// Eric, on the Lodestar review: the paper daemon "died with the laptop
// session on Sep 10"; background tasks died on every account switch. A
// process claude starts is claude's child and dies with it. So the APP
// starts jobs: the MCP `job` tool only APPENDS a request to
// `jobs-inbox.json` (append-only NDJSON, many appenders, one taker — the
// backlog inbox's pattern), App's 5s pass TAKES it and calls the commands
// below, and Rust spawns a detached, windowless wrapper that is nobody's
// child but its own.
//
// FILES — `%LOCALAPPDATA%/<data_dir_name()>/jobs/` (a `.dev` build keeps its
// own, like threads.json):
//   jobs.json        the INDEX — app-owned, written only here, under a lock.
//   <id>/run.ps1     the SUPERVISOR: starts inner.ps1, waits (up to a timeout
//                    when one is set), writes exit.json LAST.
//   <id>/inner.ps1   the RUNNER: reads command.txt, runs it as its own script
//                    block, every line it prints to log.txt (rotated at
//                    LOG_ROTATE_BYTES into log.1.txt).
//   <id>/command.txt the agent's command, as DATA. Neither script contains a
//   <id>/cwd.txt     byte of agent text: both are constant templates whose
//                    only substitutions are two integers this module picks,
//                    and every other value is read from a file at run time
//                    (see `run_script` / `INNER_SCRIPT`).
//   <id>/log.txt     the output; the wrapper is its one writer.
//   <id>/exit.json   `{code, endedAt, timedOut}`; the wrapper is its one writer.
//
// STATE IS DERIVED (so it survives an app restart — the app is a reader of
// the job, never its parent): exit.json present → ended(code); stopped by us
// → stopped; lost once → lost forever; the recorded pid alive AND its
// creation time equal to the one recorded at spawn → running; else lost. The
// creation-time check is what makes a recycled pid (Windows reuses them
// freely) read as "lost", never as "running".
//
// STOP kills the process TREE, and never a stranger: the root is opened by
// pid and its creation time is read THROUGH THAT SAME HANDLE before
// TerminateProcess — an open handle pins the process object, so there is no
// window in which the pid can be recycled between the check and the kill.
// Descendants come from one Toolhelp snapshot, walked only through processes
// created no earlier than the root (a process that predates the root cannot
// be its descendant; it can only be an orphan whose stale parent pid happens
// to match), and each is re-checked through its own handle before it dies.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Mirrors `lib/jobs.ts` and the MCP server — change one, change all three.
pub const JOB_NAME_MAX: usize = 48;
/// Characters, not bytes.
pub const JOB_COMMAND_CAP: usize = 2000;
/// Running `job`-kind jobs per thread (watch runs are bounded by their timeout).
pub const JOBS_RUNNING_PER_THREAD: usize = 8;
/// The runner rotates log.txt → log.1.txt past this; a job's logs never pass 2×.
pub const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
pub const LOG_LINES_DEFAULT: usize = 40;
pub const LOG_LINES_MAX: usize = 400;
/// The `lastLine` a row prints, in characters.
pub const LAST_LINE_CAP: usize = 240;
/// A settled job (ended and its line posted) is kept this long, then pruned.
const JOB_KEEP_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const JOBS_INDEX_CAP: usize = 300;
/// Settled runs kept per watch (SWIT-110) — the rest of their dirs go.
pub const WATCH_RUNS_KEPT: usize = 5;

pub fn jobs_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Cannot resolve local data dir")?;
    Ok(base.join(super::data_dir_name()).join("jobs"))
}

pub fn jobs_inbox_path() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Cannot resolve local data dir")?;
    Ok(base.join(super::data_dir_name()).join("jobs-inbox.json"))
}

// ── Guards (pure) ────────────────────────────────────────────────────────────

/// `[A-Za-z0-9_.-]{1,48}` — a name the agent and the page say out loud.
pub fn job_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= JOB_NAME_MAX
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// App-minted ids are `[a-z0-9-]`; anything else in the index (a hand edit)
/// is never joined onto a path.
pub fn job_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// The command, trimmed: non-empty, ≤ JOB_COMMAND_CAP characters, no NUL.
pub fn command_ok(command: &str) -> Result<String, String> {
    let c = command.trim();
    if c.is_empty() {
        return Err("a job needs a command".into());
    }
    if c.chars().count() > JOB_COMMAND_CAP {
        return Err(format!("command too long (cap {} characters)", JOB_COMMAND_CAP));
    }
    if c.contains('\0') {
        return Err("command contains a NUL".into());
    }
    Ok(c.to_string())
}

/// The working directory: absolute, existing, a directory. Not confined to
/// the thread's repo — the agent already runs anything its terminal can, and
/// a job's whole point is to run where the agent would. Returned as given
/// (no `\\?\` canonical prefix: .NET's WorkingDirectory must read it).
pub fn cwd_ok(cwd: &str) -> Result<PathBuf, String> {
    let c = cwd.trim();
    if c.is_empty() || c.len() > 1024 || c.contains('\0') {
        return Err("invalid working directory".into());
    }
    let p = PathBuf::from(c);
    if !p.is_absolute() {
        return Err(format!("working directory must be absolute: {}", c));
    }
    match std::fs::metadata(&p) {
        Ok(m) if m.is_dir() => Ok(p),
        Ok(_) => Err(format!("not a directory: {}", c)),
        Err(_) => Err(format!("working directory does not exist: {}", c)),
    }
}

// ── The index ────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: String,
    pub name: String,
    pub thread_id: String,
    pub command: String,
    pub cwd: String,
    /// `job` (the agent asked) | `watch-run` (a watch's scheduled run, SWIT-110).
    pub kind: String,
    #[serde(default)]
    pub watch: Option<String>,
    pub pid: u32,
    /// Unix ms: the wrapper's creation time, read from its own handle at spawn.
    pub pid_started_at: u64,
    pub started_at: u64,
    /// 0 = none; the supervisor enforces it (watch runs: 120).
    #[serde(default)]
    pub timeout_secs: u32,
    #[serde(default)]
    pub stopped_at: Option<u64>,
    #[serde(default)]
    pub lost_at: Option<u64>,
    /// When the one "ended" line was posted to the thread's inbox.
    #[serde(default)]
    pub notified_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct JobsIndex {
    pub version: u32,
    pub jobs: Vec<JobRecord>,
}

/// Missing = empty. UNPARSEABLE is an error, never "empty": an index that
/// cannot be read is not rewritten (it would forget every running job and
/// the pids needed to stop them) — the SWIT-107 rule for the project index.
pub fn read_index(dir: &Path) -> Result<JobsIndex, String> {
    match std::fs::read_to_string(dir.join("jobs.json")) {
        Ok(raw) => {
            let raw = raw.trim_start_matches('\u{feff}');
            if raw.trim().is_empty() {
                return Ok(JobsIndex { version: 1, jobs: Vec::new() });
            }
            serde_json::from_str::<JobsIndex>(raw).map_err(|e| format!("jobs.json is unreadable ({}) — not rewriting it", e))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(JobsIndex { version: 1, jobs: Vec::new() }),
        Err(e) => Err(e.to_string()),
    }
}

pub fn write_index(dir: &Path, index: &JobsIndex) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("jobs.json.tmp");
    let body = serde_json::to_string_pretty(&JobsIndex { version: 1, jobs: index.jobs.clone() }).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("jobs.json")).map_err(|e| e.to_string())
}

/// Every index read-modify-write runs under this — the inbox drain, a page
/// stop and the snapshot's lost/prune stamps can land in the same tick.
pub static JOBS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn lock() -> std::sync::MutexGuard<'static, ()> {
    JOBS_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

// ── State (pure) ─────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobState {
    Running,
    Ended,
    Stopped,
    Lost,
}

impl JobState {
    pub fn word(self) -> &'static str {
        match self {
            JobState::Running => "running",
            JobState::Ended => "ended",
            JobState::Stopped => "stopped",
            JobState::Lost => "lost",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    pub code: Option<i64>,
    pub ended_at: Option<u64>,
    pub timed_out: bool,
    /// Why the supervisor could not start the runner (code -1), capped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// exit.json, tolerant: `{code, endedAt, timedOut?}` (PowerShell 5.1 writes
/// no BOM through UTF8Encoding(false), but a BOM is stripped anyway). A file
/// that exists but does not parse still means the supervisor reached its
/// last line — it reads as ended with no code.
pub fn parse_exit(raw: &str) -> ExitInfo {
    let v: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}')).unwrap_or(serde_json::Value::Null);
    ExitInfo {
        code: v.get("code").and_then(|c| c.as_i64()),
        ended_at: v.get("endedAt").and_then(|c| c.as_u64()),
        timed_out: v.get("timedOut").and_then(|c| c.as_bool()).unwrap_or(false),
        error: v
            .get("error")
            .and_then(|c| c.as_str())
            .map(|e| e.chars().take(LAST_LINE_CAP).collect()),
    }
}

/// THE state rule (mirrored in lib/jobs.ts `deriveJobState` and the MCP
/// server's `jobState`). `alive` must be read BEFORE `exit`: the supervisor
/// writes exit.json and then exits, so "not alive, then no exit.json" can only
/// mean it died without reaching its last line.
pub fn derive_state(rec: &JobRecord, exit: Option<&ExitInfo>, alive: bool) -> JobState {
    if exit.is_some() {
        JobState::Ended
    } else if rec.stopped_at.is_some() {
        JobState::Stopped
    } else if rec.lost_at.is_some() {
        JobState::Lost
    } else if alive {
        JobState::Running
    } else {
        JobState::Lost
    }
}

fn read_exit(job_dir: &Path) -> Option<ExitInfo> {
    std::fs::read_to_string(job_dir.join("exit.json")).ok().map(|raw| parse_exit(&raw))
}

/// The effectful probe, in the one safe order: liveness first, exit.json
/// after. A record already settled (stopped/lost) is never probed — its pid
/// may belong to anyone by now.
pub fn probe(dir: &Path, rec: &JobRecord) -> (Option<ExitInfo>, bool) {
    let job_dir = dir.join(&rec.id);
    if rec.stopped_at.is_some() || rec.lost_at.is_some() {
        return (read_exit(&job_dir), false);
    }
    if let Some(exit) = read_exit(&job_dir) {
        return (Some(exit), false);
    }
    let alive = process_matches(rec.pid, rec.pid_started_at);
    (read_exit(&job_dir), alive)
}

// ── The wrapper scripts ──────────────────────────────────────────────────────

/// The RUNNER. Constant text (one integer substituted): it reads the command
/// from command.txt and makes a script block of it, so the agent's text is
/// parsed as ITS OWN code in this child process — it can `exit N` (that is
/// the job's exit code) but it cannot reach the supervisor's lines, which
/// live in another process. Output: strings and native stdout as-is, native
/// stderr (ErrorRecords) as their message, other objects as the console would
/// format them; UTF-8 without BOM, flushed per line, FileShare ReadWrite|Delete
/// so the app and the MCP server can read (and the rotation can move) it
/// while it is open.
const INNER_SCRIPT: &str = r#"# Switchboard job runner (SWIT-109) - written by the app. It reads the job's
# command from command.txt and runs it as its own script block; every line the
# command prints goes to log.txt. No job text is part of this file.
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $utf8 } catch {}
$OutputEncoding = $utf8
$env:PYTHONUNBUFFERED = '1'
$env:PYTHONIOENCODING = 'utf-8'
$logPath = Join-Path $here 'log.txt'
$rotated = Join-Path $here 'log.1.txt'
$cap = __LOG_CAP__
function Open-JobLog {
  $fs = [System.IO.File]::Open($logPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]'ReadWrite, Delete')
  $w = New-Object System.IO.StreamWriter($fs, $utf8)
  $w.AutoFlush = $true
  return $w
}
$script:jobLog = Open-JobLog
function Write-JobLog([string]$line) {
  $script:jobLog.WriteLine($line)
  if ($script:jobLog.BaseStream.Length -gt $cap) {
    $script:jobLog.Dispose()
    Move-Item -LiteralPath $logPath -Destination $rotated -Force
    $script:jobLog = Open-JobLog
  }
}
$code = 0
try {
  $source = [System.IO.File]::ReadAllText((Join-Path $here 'command.txt'), $utf8)
  $block = [ScriptBlock]::Create($source)
  $global:LASTEXITCODE = $null
  & $block *>&1 | ForEach-Object {
    $item = $_
    if ($item -is [string]) { Write-JobLog $item }
    elseif ($item -is [System.Management.Automation.ErrorRecord]) { Write-JobLog ($item.ToString()) }
    else { foreach ($l in ($item | Out-String -Stream -Width 240)) { if ($l.Trim().Length -gt 0) { Write-JobLog $l } } }
  }
  if ($null -ne $global:LASTEXITCODE) { $code = $global:LASTEXITCODE }
} catch {
  Write-JobLog ('error: ' + $_)
  $code = 1
}
$script:jobLog.Dispose()
exit $code
"#;

/// The SUPERVISOR. Constant text (one integer substituted: the timeout). It
/// starts the runner as a child with no window, waits, kills the runner's
/// tree on a timeout (exit 124, `timedOut: true`), and writes exit.json as
/// its LAST act, through a tmp + move. A start failure (the cwd vanished)
/// still writes exit.json, with code -1 and the reason.
const RUN_SCRIPT: &str = r#"# Switchboard job supervisor (SWIT-109) - written by the app. It starts
# inner.ps1 (which runs the job's command), waits for it, and writes exit.json
# last. Every value it needs is read from a file beside it.
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$timeoutMs = __TIMEOUT_MS__
$code = $null
$timedOut = $false
$failure = $null
try {
  $cwd = [System.IO.File]::ReadAllText((Join-Path $here 'cwd.txt'), (New-Object System.Text.UTF8Encoding($false)))
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $here 'inner.ps1') + '"'
  $psi.WorkingDirectory = $cwd
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  if ($timeoutMs -gt 0) {
    if (-not $p.WaitForExit($timeoutMs)) {
      $timedOut = $true
      & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /T /F /PID $p.Id | Out-Null
      $p.WaitForExit(5000) | Out-Null
    }
  } else {
    $p.WaitForExit()
  }
  if ($timedOut) { $code = 124 } else { $code = $p.ExitCode }
} catch {
  $failure = '' + $_
  $code = -1
}
$result = @{ code = $code; endedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); timedOut = $timedOut }
if ($failure) { $result.error = $failure }
$tmp = Join-Path $here 'exit.json.tmp'
[System.IO.File]::WriteAllText($tmp, ($result | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $tmp -Destination (Join-Path $here 'exit.json') -Force
"#;

pub fn run_script(timeout_secs: u32) -> String {
    RUN_SCRIPT.replace("__TIMEOUT_MS__", &(u64::from(timeout_secs) * 1000).to_string())
}

pub fn inner_script() -> String {
    INNER_SCRIPT.replace("__LOG_CAP__", &LOG_ROTATE_BYTES.to_string())
}

/// Write a job's dir: the two constant scripts, the command and the cwd as
/// data files, and an empty log (so a reader finds it before the first line).
pub fn write_job_files(job_dir: &Path, command: &str, cwd: &Path, timeout_secs: u32) -> Result<(), String> {
    std::fs::create_dir_all(job_dir).map_err(|e| e.to_string())?;
    let w = |name: &str, body: &str| std::fs::write(job_dir.join(name), body.as_bytes()).map_err(|e| format!("{}: {}", name, e));
    w("command.txt", command)?;
    w("cwd.txt", &cwd.to_string_lossy())?;
    w("inner.ps1", &inner_script())?;
    w("run.ps1", &run_script(timeout_secs))?;
    w("log.txt", "")?;
    Ok(())
}

/// The system PowerShell by absolute path — never a PATH or cwd lookup, so a
/// `powershell.exe` dropped in some directory is never the one that runs.
pub fn powershell_exe() -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe")
}

/// The supervisor's command line. The only variable is the job dir's
/// run.ps1 path — app-built from LOCALAPPDATA and an app-minted id, and a
/// Windows path cannot contain `"`.
pub fn wrapper_command_line(exe: &Path, run_ps1: &Path) -> String {
    format!(
        "\"{}\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{}\"",
        exe.display(),
        run_ps1.display()
    )
}

// ── Processes (Windows) ──────────────────────────────────────────────────────

#[cfg(windows)]
fn filetime_ms(ft: windows_sys::Win32::Foundation::FILETIME) -> Option<u64> {
    const TICKS_PER_MS: u64 = 10_000;
    const EPOCH_DIFF_MS: u64 = 11_644_473_600_000;
    let ticks = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
    (ticks / TICKS_PER_MS).checked_sub(EPOCH_DIFF_MS)
}

/// Creation time + still-running, read through ONE handle.
#[cfg(windows)]
unsafe fn handle_facts(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<(u64, bool)> {
    use windows_sys::Win32::Foundation::{FILETIME, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, GetProcessTimes};
    let mut creation: FILETIME = std::mem::zeroed();
    let mut exit: FILETIME = std::mem::zeroed();
    let mut kernel: FILETIME = std::mem::zeroed();
    let mut user: FILETIME = std::mem::zeroed();
    if GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) == 0 {
        return None;
    }
    let mut code: u32 = 0;
    let running = GetExitCodeProcess(handle, &mut code) != 0 && code == STILL_ACTIVE as u32;
    Some((filetime_ms(creation)?, running))
}

/// Is `pid` still the process we spawned, and still running?
#[cfg(windows)]
pub fn process_matches(pid: u32, started_at: u64) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid == 0 {
        return false;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let facts = handle_facts(h);
        CloseHandle(h);
        matches!(facts, Some((created, true)) if created == started_at)
    }
}

#[cfg(not(windows))]
pub fn process_matches(_pid: u32, _started_at: u64) -> bool {
    false
}

/// Terminate `pid` only if the process holding it now was created at
/// `created` — checked through the handle that does the terminating.
#[cfg(windows)]
fn terminate_if_same(pid: u32, created: u64) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE};
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let ok = match handle_facts(h) {
            Some((c, true)) if c == created => TerminateProcess(h, 1) != 0,
            _ => false,
        };
        CloseHandle(h);
        ok
    }
}

#[cfg(not(windows))]
fn terminate_if_same(_pid: u32, _created: u64) -> bool {
    false
}

/// Which descendants of `root` to kill, pure: walk the parent→children index
/// from the root, descending ONLY through processes created at or after the
/// root (`created` answers per pid; None = gone or unreadable, skipped). An
/// older process listing the root as parent is an orphan whose parent pid
/// was recycled into the root — never ours, and neither is anything under it.
pub fn kill_plan(
    root: u32,
    root_created: u64,
    children: &HashMap<u32, Vec<u32>>,
    created: &dyn Fn(u32) -> Option<u64>,
) -> Vec<(u32, u64)> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::from([root]);
    let mut stack = vec![root];
    while let Some(cur) = stack.pop() {
        for &child in children.get(&cur).map(|v| v.as_slice()).unwrap_or(&[]) {
            if !seen.insert(child) {
                continue;
            }
            match created(child) {
                Some(t) if t >= root_created => {
                    out.push((child, t));
                    stack.push(child);
                }
                _ => {}
            }
        }
    }
    out
}

/// Kill a job's tree. The ROOT goes first (so the supervisor can never write
/// an exit.json claiming the runner's forced exit code), then every planned
/// descendant; the plan is taken before anything dies.
pub fn kill_tree(pid: u32, started_at: u64) -> Result<usize, String> {
    if !process_matches(pid, started_at) {
        return Err("the job is not running".into());
    }
    let edges = super::discovery::process_edges();
    let children = super::discovery::child_index(&edges);
    let plan = kill_plan(pid, started_at, &children, &|p| super::discovery::process_start_time_ms(p));
    if !terminate_if_same(pid, started_at) {
        return Err("could not stop the job's process".into());
    }
    let mut n = 1;
    for (p, created) in plan {
        if terminate_if_same(p, created) {
            n += 1;
        }
    }
    Ok(n)
}

/// Spawn the supervisor DETACHED: CREATE_NO_WINDOW (a hidden console the
/// runner and the command inherit — DETACHED_PROCESS would make every console
/// child the command starts pop its own window), CREATE_NEW_PROCESS_GROUP (no
/// Ctrl+C from anyone else's group), CREATE_BREAKAWAY_FROM_JOB when the app
/// sits in a job object that allows it (retried without when it does not),
/// and bInheritHandles = FALSE: the job inherits NONE of the app's handles —
/// a PTY pipe end held by a job that outlives it would keep that terminal's
/// reader from ever seeing EOF. Returns (pid, creation ms read from the
/// spawn's own process handle).
#[cfg(windows)]
pub fn spawn_detached(exe: &Path, command_line: &str, cwd: &Path) -> Result<(u32, u64), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, PROCESS_INFORMATION, STARTUPINFOW,
    };
    let wide = |s: &std::ffi::OsStr| s.encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let app = wide(exe.as_os_str());
    let dir = wide(cwd.as_os_str());
    let base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
    let mut last_err = String::new();
    for flags in [base | CREATE_BREAKAWAY_FROM_JOB, base] {
        // CreateProcessW may write into the command-line buffer: a fresh copy per try.
        let mut cmd = wide(std::ffi::OsStr::new(command_line));
        unsafe {
            let mut si: STARTUPINFOW = std::mem::zeroed();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let ok = CreateProcessW(
                app.as_ptr(),
                cmd.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                flags,
                std::ptr::null(),
                dir.as_ptr(),
                &si,
                &mut pi,
            );
            if ok != 0 {
                let created = handle_facts(pi.hProcess).map(|(c, _)| c);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                return match created {
                    Some(c) => Ok((pi.dwProcessId, c)),
                    None => Err("spawned, but its creation time is unreadable".into()),
                };
            }
            last_err = std::io::Error::last_os_error().to_string();
        }
    }
    Err(format!("could not start the job: {}", last_err))
}

#[cfg(not(windows))]
pub fn spawn_detached(_exe: &Path, _command_line: &str, _cwd: &Path) -> Result<(u32, u64), String> {
    Err("jobs are Windows-only".into())
}

// ── Start / stop / snapshot (effectful, over a jobs dir) ─────────────────────

pub struct StartSpec<'a> {
    pub thread_id: &'a str,
    pub name: &'a str,
    pub command: &'a str,
    /// None = the thread's working directory.
    pub cwd: Option<&'a str>,
    pub kind: &'a str,
    pub watch: Option<&'a str>,
    pub timeout_secs: u32,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static ID_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// An app-minted id: `j<ms base16>-<counter>-<4 hex of a uuid>`, `[a-z0-9-]`.
pub fn mint_job_id(now: u64) -> String {
    let n = ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 4096;
    let r = uuid::Uuid::new_v4().simple().to_string();
    format!("j{:x}-{:x}-{}", now, n, &r[..4])
}

/// The live state of every record, probed once (under the caller's lock).
pub fn states_of(dir: &Path, index: &JobsIndex) -> Vec<(JobState, Option<ExitInfo>, bool)> {
    index
        .jobs
        .iter()
        .map(|r| {
            let (exit, alive) = probe(dir, r);
            (derive_state(r, exit.as_ref(), alive), exit, alive)
        })
        .collect()
}

/// The start-time guards that need the index, pure over the records and
/// their states: a unique name among RUNNING jobs (all threads — the name is
/// how the agent and the page say which one), and ≤ JOBS_RUNNING_PER_THREAD
/// running `job`s per thread.
pub fn start_conflict(records: &[JobRecord], states: &[JobState], thread_id: &str, name: &str, kind: &str) -> Option<String> {
    let running = || records.iter().zip(states).filter(|(_, s)| **s == JobState::Running).map(|(r, _)| r);
    if running().any(|r| r.name == name) {
        return Some(format!("a job named {} is already running — stop it first or pick another name", name));
    }
    if kind == "job" {
        let n = running().filter(|r| r.thread_id == thread_id && r.kind == "job").count();
        if n >= JOBS_RUNNING_PER_THREAD {
            return Some(format!("this thread already has {} jobs running (cap {})", n, JOBS_RUNNING_PER_THREAD));
        }
    }
    None
}

/// START: every guard, then the files, then the detached spawn, then the
/// index. `mirror_raw` is threads.json's content (the thread must be known —
/// save_thread_attachment's rule). The spawner is injected so the guard
/// tests never start a process.
pub fn start_job(
    dir: &Path,
    mirror_raw: &str,
    spec: &StartSpec,
    spawn: &dyn Fn(&Path, &str, &Path) -> Result<(u32, u64), String>,
) -> Result<JobRecord, String> {
    if !super::valid_thread_id(spec.thread_id) {
        return Err("invalid thread id".into());
    }
    let thread_dir = super::working_dir_from_mirror(mirror_raw, spec.thread_id)?;
    if !job_name_ok(spec.name) {
        return Err(format!("job name must be {} or fewer of A-Z a-z 0-9 _ . -", JOB_NAME_MAX));
    }
    let command = command_ok(spec.command)?;
    let cwd = match spec.cwd {
        Some(c) if !c.trim().is_empty() => cwd_ok(c)?,
        _ => cwd_ok(&thread_dir.to_string_lossy())?,
    };
    if spec.kind != "job" && spec.kind != "watch-run" {
        return Err("invalid job kind".into());
    }
    let _guard = lock();
    let mut index = read_index(dir)?;
    let states: Vec<JobState> = states_of(dir, &index).into_iter().map(|(s, _, _)| s).collect();
    if let Some(why) = start_conflict(&index.jobs, &states, spec.thread_id, spec.name, spec.kind) {
        return Err(why);
    }
    let now = now_ms();
    let id = mint_job_id(now);
    let job_dir = dir.join(&id);
    if let Err(e) = write_job_files(&job_dir, &command, &cwd, spec.timeout_secs) {
        let _ = std::fs::remove_dir_all(&job_dir);
        return Err(e);
    }
    let exe = powershell_exe();
    let line = wrapper_command_line(&exe, &job_dir.join("run.ps1"));
    let (pid, pid_started_at) = match spawn(&exe, &line, &job_dir) {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&job_dir);
            return Err(e);
        }
    };
    let rec = JobRecord {
        id,
        name: spec.name.to_string(),
        thread_id: spec.thread_id.to_string(),
        command,
        cwd: cwd.to_string_lossy().into_owned(),
        kind: spec.kind.to_string(),
        watch: spec.watch.map(str::to_string),
        pid,
        pid_started_at,
        started_at: now,
        timeout_secs: spec.timeout_secs,
        stopped_at: None,
        lost_at: None,
        notified_at: None,
    };
    index.jobs.push(rec.clone());
    write_index(dir, &index)?;
    log::info!("Job started id={} name={} thread={} pid={}", rec.id, rec.name, rec.thread_id, pid);
    Ok(rec)
}

/// STOP one record: kill its tree (pid + creation-time checked) and stamp
/// `stoppedAt`. A job that is not running is refused with its state.
pub fn stop_record(dir: &Path, pick: &dyn Fn(&JobRecord, JobState) -> bool) -> Result<JobRecord, String> {
    let _guard = lock();
    let mut index = read_index(dir)?;
    let states = states_of(dir, &index);
    let found = index.jobs.iter().zip(&states).position(|(r, (s, _, _))| pick(r, *s));
    let Some(i) = found else {
        return Err("no such job".into());
    };
    if states[i].0 != JobState::Running {
        return Err(format!("job {} is {}, not running", index.jobs[i].name, states[i].0.word()));
    }
    kill_tree(index.jobs[i].pid, index.jobs[i].pid_started_at)?;
    index.jobs[i].stopped_at = Some(now_ms());
    write_index(dir, &index)?;
    log::info!("Job stopped id={} name={}", index.jobs[i].id, index.jobs[i].name);
    Ok(index.jobs[i].clone())
}

/// When a settled record stopped mattering: its end, its stop, its loss, or
/// (nothing known) its start.
fn settled_at(rec: &JobRecord, exit: Option<&ExitInfo>) -> u64 {
    exit.and_then(|e| e.ended_at)
        .or(rec.stopped_at)
        .or(rec.lost_at)
        .unwrap_or(rec.started_at)
}

/// Which records to PRUNE, pure: never a running one. A `job` whose line was
/// posted and that settled more than JOB_KEEP_MS ago; a watch's runs past
/// the newest WATCH_RUNS_KEPT settled ones; then, over JOBS_INDEX_CAP, the
/// oldest settled records until it fits.
pub fn prune_plan(records: &[JobRecord], states: &[(JobState, Option<ExitInfo>)], now: u64) -> Vec<String> {
    let mut drop: Vec<String> = Vec::new();
    let settled = |i: usize| states[i].0 != JobState::Running && (records[i].kind != "job" || records[i].notified_at.is_some());
    for i in 0..records.len() {
        if records[i].kind == "job" && settled(i) && now.saturating_sub(settled_at(&records[i], states[i].1.as_ref())) > JOB_KEEP_MS {
            drop.push(records[i].id.clone());
        }
    }
    let mut by_watch: HashMap<&str, Vec<usize>> = HashMap::new();
    for i in 0..records.len() {
        if records[i].kind == "watch-run" && states[i].0 != JobState::Running {
            by_watch.entry(records[i].watch.as_deref().unwrap_or("")).or_default().push(i);
        }
    }
    for (_, mut runs) in by_watch {
        runs.sort_by_key(|&i| std::cmp::Reverse(records[i].started_at));
        for &i in runs.iter().skip(WATCH_RUNS_KEPT) {
            drop.push(records[i].id.clone());
        }
    }
    let remaining = records.len().saturating_sub(drop.len());
    if remaining > JOBS_INDEX_CAP {
        let mut rest: Vec<usize> = (0..records.len()).filter(|&i| settled(i) && !drop.contains(&records[i].id)).collect();
        rest.sort_by_key(|&i| settled_at(&records[i], states[i].1.as_ref()));
        for &i in rest.iter().take(remaining - JOBS_INDEX_CAP) {
            drop.push(records[i].id.clone());
        }
    }
    drop
}

/// The last non-empty line of a log (the tail's last 8 KB), capped.
pub fn last_line_of(text: &str) -> String {
    let line = text
        .trim_start_matches('\u{feff}')
        .lines()
        .rev()
        .map(str::trim_end)
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");
    line.chars().take(LAST_LINE_CAP).collect()
}

fn read_tail(path: &Path, max_bytes: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max_bytes);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.take(max_bytes).read_to_end(&mut buf);
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    // A cut mid-file starts mid-line: drop the partial first line.
    if start > 0 {
        if let Some(nl) = text.find('\n') {
            text = text[nl + 1..].to_string();
        }
    }
    text
}

/// The last `n` lines of a job's output (log.1.txt's tail first when the
/// current file is short — a rotation happened).
pub fn log_tail_lines(job_dir: &Path, n: usize) -> Vec<String> {
    let n = n.clamp(1, LOG_LINES_MAX);
    let lines_of = |t: String| -> Vec<String> {
        t.trim_start_matches('\u{feff}').lines().map(|l| l.trim_end().to_string()).collect()
    };
    let mut lines = lines_of(read_tail(&job_dir.join("log.txt"), 512 * 1024));
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    if lines.len() < n {
        let mut older = lines_of(read_tail(&job_dir.join("log.1.txt"), 512 * 1024));
        older.append(&mut lines);
        lines = older;
    }
    let skip = lines.len().saturating_sub(n);
    lines.into_iter().skip(skip).collect()
}

/// lastLine cache: (log len, last line) per job id — a log is re-read only
/// when it grew, so the 5s snapshot costs one stat per job.
static LAST_LINES: std::sync::Mutex<Option<HashMap<String, (u64, String)>>> = std::sync::Mutex::new(None);

fn cached_last_line(job_dir: &Path, id: &str) -> String {
    let path = job_dir.join("log.txt");
    let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut guard = LAST_LINES.lock().unwrap_or_else(|p| p.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some((l, line)) = map.get(id) {
        if *l == len {
            return line.clone();
        }
    }
    let mut line = last_line_of(&read_tail(&path, 8 * 1024));
    if line.is_empty() && len == 0 {
        line = last_line_of(&read_tail(&job_dir.join("log.1.txt"), 8 * 1024));
    }
    map.insert(id.to_string(), (len, line.clone()));
    line
}

/// THE SNAPSHOT (App's 5s pass): every record with its probe, its last line
/// — and the two stamps only this read can make: `lostAt` the first time a
/// record derives lost (lost is then permanent, whatever later holds its
/// pid), and the prune. The index is rewritten only when one of those moved.
pub fn snapshot(dir: &Path) -> Result<serde_json::Value, String> {
    let _guard = lock();
    let mut index = read_index(dir)?;
    let probes = states_of(dir, &index);
    let now = now_ms();
    let mut dirty = false;
    for (rec, (state, _, _)) in index.jobs.iter_mut().zip(&probes) {
        if *state == JobState::Lost && rec.lost_at.is_none() {
            rec.lost_at = Some(now);
            dirty = true;
            log::warn!("Job lost id={} name={} (pid {} gone with no exit.json)", rec.id, rec.name, rec.pid);
        }
    }
    let states: Vec<(JobState, Option<ExitInfo>)> = probes.iter().map(|(s, e, _)| (*s, e.clone())).collect();
    let dropped = prune_plan(&index.jobs, &states, now);
    let mut rows = Vec::new();
    let mut kept = Vec::new();
    for (rec, (state, exit, alive)) in index.jobs.iter().zip(probes) {
        if dropped.contains(&rec.id) {
            if job_id_ok(&rec.id) {
                let _ = std::fs::remove_dir_all(dir.join(&rec.id));
            }
            continue;
        }
        kept.push(rec.clone());
        let last_line = if job_id_ok(&rec.id) { cached_last_line(&dir.join(&rec.id), &rec.id) } else { String::new() };
        let mut row = serde_json::to_value(rec).map_err(|e| e.to_string())?;
        if let Some(obj) = row.as_object_mut() {
            obj.insert("alive".into(), serde_json::Value::Bool(alive));
            obj.insert("exit".into(), serde_json::to_value(&exit).unwrap_or(serde_json::Value::Null));
            obj.insert("state".into(), serde_json::Value::String(state.word().into()));
            obj.insert("lastLine".into(), serde_json::Value::String(last_line));
            // Never hand the pid out: nothing on the frontend acts on it.
            obj.remove("pid");
            obj.remove("pidStartedAt");
        }
        rows.push(row);
    }
    if !dropped.is_empty() {
        index.jobs = kept;
        dirty = true;
    }
    if dirty {
        write_index(dir, &index)?;
    }
    Ok(serde_json::Value::Array(rows))
}

/// Mark a record's one ended-line as posted; false when it already was (the
/// caller then posts nothing — once per job, across restarts).
pub fn claim_notify(dir: &Path, id: &str) -> Result<Option<JobRecord>, String> {
    let _guard = lock();
    let mut index = read_index(dir)?;
    let Some(rec) = index.jobs.iter_mut().find(|r| r.id == id) else {
        return Err("no such job".into());
    };
    if rec.notified_at.is_some() {
        return Ok(None);
    }
    rec.notified_at = Some(now_ms());
    let out = rec.clone();
    write_index(dir, &index)?;
    Ok(Some(out))
}

/// TAKE the inbox: rename away, read, delete — take_backlog_inbox's rule.
pub fn take_inbox(path: &Path) -> Result<String, String> {
    let taken = path.with_extension("json.taking");
    match std::fs::rename(path, &taken) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.to_string()),
    }
    let content = std::fs::read_to_string(&taken).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::remove_file(&taken) {
        log::warn!("Could not remove taken jobs inbox: {}", e);
    }
    Ok(content)
}

fn mirror_raw() -> Result<String, String> {
    std::fs::read_to_string(super::threads_path()?).map_err(|e| format!("threads mirror unreadable: {}", e))
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn take_jobs_inbox() -> Result<String, String> {
    take_inbox(&jobs_inbox_path()?)
}

/// Start a `job` for a thread (the inbox's `start`). Returns the record.
#[tauri::command]
pub async fn job_start(thread_id: String, name: String, command: String, cwd: Option<String>) -> Result<String, String> {
    let dir = jobs_dir()?;
    let spec = StartSpec {
        thread_id: &thread_id,
        name: &name,
        command: &command,
        cwd: cwd.as_deref(),
        kind: "job",
        watch: None,
        timeout_secs: 0,
    };
    let rec = start_job(&dir, &mirror_raw()?, &spec, &spawn_detached)?;
    serde_json::to_string(&rec).map_err(|e| e.to_string())
}

/// Stop the thread's RUNNING job of that name (the inbox's `stop` — a thread
/// stops its own jobs, not another thread's).
#[tauri::command]
pub async fn job_stop(thread_id: String, name: String) -> Result<(), String> {
    let dir = jobs_dir()?;
    // Prefer the running record: an ended one may share the name.
    let running = stop_record(&dir, &|r, s| r.thread_id == thread_id && r.name == name && s == JobState::Running);
    match running {
        Err(e) if e == "no such job" => Err(format!("no running job named {} in this thread", name)),
        other => other.map(|_| ()),
    }
}

/// Stop by id — the page's and Home's two-click stop (the user's hand).
#[tauri::command]
pub async fn job_stop_id(id: String) -> Result<(), String> {
    stop_record(&jobs_dir()?, &|r, _| r.id == id).map(|_| ())
}

#[tauri::command]
pub async fn jobs_snapshot() -> Result<String, String> {
    let v = snapshot(&jobs_dir()?)?;
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

/// The last `lines` lines of a job's output (default 40, max 400).
#[tauri::command]
pub async fn job_log_tail(id: String, lines: Option<usize>) -> Result<Vec<String>, String> {
    if !job_id_ok(&id) {
        return Err("invalid job id".into());
    }
    Ok(log_tail_lines(&jobs_dir()?.join(&id), lines.unwrap_or(LOG_LINES_DEFAULT)))
}

/// Post a job's ONE ended-line to its thread's inbox, once: the claim is
/// stamped in the index first, so a failed post is not retried into a
/// duplicate (a missing line beats two).
#[tauri::command]
pub async fn job_notify(id: String, text: String) -> Result<bool, String> {
    let Some(rec) = claim_notify(&jobs_dir()?, &id)? else {
        return Ok(false);
    };
    super::append_app_post(&rec.thread_id, &format!("job-{}", rec.id), &text)?;
    Ok(true)
}

/// Post one line from the jobs machinery to a thread (a refused request).
#[tauri::command]
pub async fn jobs_post(thread_id: String, text: String) -> Result<(), String> {
    let n = ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    super::append_app_post(&thread_id, &format!("jn{:x}-{:x}", now_ms(), n), &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const THREAD: &str = "3f1c2a9e-0b7d-4c1e-9a55-1234567890ab";

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("swb-jobs-{}-{}", tag, uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn mirror(work: &Path) -> String {
        serde_json::json!({"threads": [{"id": THREAD, "workingDir": work.to_string_lossy()}]}).to_string()
    }

    fn rec(id: &str, name: &str, kind: &str) -> JobRecord {
        JobRecord {
            id: id.into(),
            name: name.into(),
            thread_id: THREAD.into(),
            command: "x".into(),
            cwd: "C:\\".into(),
            kind: kind.into(),
            watch: None,
            pid: 1,
            pid_started_at: 1,
            started_at: 1_000,
            timeout_secs: 0,
            stopped_at: None,
            lost_at: None,
            notified_at: None,
        }
    }

    #[test]
    fn names_ids_and_commands() {
        for ok in ["capture", "paper-daemon", "kalshi.v2", "a_b", &"x".repeat(48)] {
            assert!(job_name_ok(ok), "{ok}");
        }
        for bad in ["", "sp ace", "a/b", "a\\b", "ümlaut", "semi;colon", "q\"uote", &"x".repeat(49)] {
            assert!(!job_name_ok(bad), "{bad:?}");
        }
        assert!(job_id_ok(&mint_job_id(1_788_861_600_250)));
        assert!(!job_id_ok("../x") && !job_id_ok("J1") && !job_id_ok(""));
        assert_eq!(command_ok("  python run.py  ").unwrap(), "python run.py");
        assert!(command_ok("   ").is_err());
        assert!(command_ok(&"é".repeat(JOB_COMMAND_CAP)).is_ok(), "the cap counts characters");
        assert!(command_ok(&"é".repeat(JOB_COMMAND_CAP + 1)).is_err());
        assert!(command_ok("a\0b").is_err());
    }

    #[test]
    fn cwd_must_be_an_existing_absolute_directory() {
        let d = temp_dir("cwd");
        assert_eq!(cwd_ok(&d.to_string_lossy()).unwrap(), d);
        assert!(cwd_ok("relative\\dir").is_err());
        assert!(cwd_ok(&d.join("nope").to_string_lossy()).unwrap_err().contains("does not exist"));
        std::fs::write(d.join("f.txt"), "x").unwrap();
        assert!(cwd_ok(&d.join("f.txt").to_string_lossy()).unwrap_err().contains("not a directory"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_state_rule() {
        let r = rec("j1", "a", "job");
        let exit = ExitInfo { code: Some(0), ended_at: Some(5), timed_out: false, error: None };
        assert_eq!(derive_state(&r, Some(&exit), true), JobState::Ended, "exit.json wins even while the supervisor exits");
        assert_eq!(derive_state(&r, None, true), JobState::Running);
        assert_eq!(derive_state(&r, None, false), JobState::Lost);
        let stopped = JobRecord { stopped_at: Some(9), ..r.clone() };
        assert_eq!(derive_state(&stopped, None, false), JobState::Stopped);
        let lost = JobRecord { lost_at: Some(9), ..r.clone() };
        assert_eq!(derive_state(&lost, None, true), JobState::Lost, "lost is permanent — a recycled pid never revives it");
        assert_eq!(parse_exit("\u{feff}{\"code\":3,\"endedAt\":42,\"timedOut\":false}"), ExitInfo { code: Some(3), ended_at: Some(42), timed_out: false, error: None });
        assert_eq!(parse_exit("garbage"), ExitInfo { code: None, ended_at: None, timed_out: false, error: None });
        assert!(parse_exit("{\"code\":124,\"endedAt\":1,\"timedOut\":true}").timed_out);
        assert_eq!(parse_exit("{\"code\":-1,\"endedAt\":1,\"error\":\"no such dir\"}").error.as_deref(), Some("no such dir"));
    }

    #[test]
    fn the_wrapper_scripts_are_constant_and_carry_no_job_text() {
        let run = run_script(120);
        assert!(run.contains("$timeoutMs = 120000"));
        assert!(run_script(0).contains("$timeoutMs = 0"));
        assert!(!run.contains("__"), "every placeholder substituted");
        assert!(run.contains("'cwd.txt'") && run.contains("'inner.ps1'") && run.contains("'exit.json'"));
        let inner = inner_script();
        assert!(inner.contains(&format!("$cap = {}", LOG_ROTATE_BYTES)));
        assert!(!inner.contains("__"));
        assert!(inner.contains("'command.txt'") && inner.contains("[ScriptBlock]::Create($source)"));
        // Written files: the command lands ONLY in command.txt, byte for byte.
        let d = temp_dir("files");
        let evil = "'; Remove-Item C:\\ -Recurse; '\" `$(boom) }\r\nexit 7 # \"";
        write_job_files(&d, evil, &d, 0).unwrap();
        assert_eq!(std::fs::read_to_string(d.join("command.txt")).unwrap(), evil);
        for f in ["run.ps1", "inner.ps1"] {
            let body = std::fs::read_to_string(d.join(f)).unwrap();
            assert!(!body.contains("boom") && !body.contains("Remove-Item C:"), "{f} carries job text");
        }
        assert_eq!(std::fs::read_to_string(d.join("cwd.txt")).unwrap(), d.to_string_lossy());
        assert_eq!(std::fs::read_to_string(d.join("log.txt")).unwrap(), "");
        let line = wrapper_command_line(&powershell_exe(), &d.join("run.ps1"));
        assert!(line.starts_with('"') && line.ends_with("run.ps1\""), "{line}");
        assert!(line.contains("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File"));
        assert!(powershell_exe().ends_with("System32\\WindowsPowerShell\\v1.0\\powershell.exe"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn start_guards_refuse_before_anything_is_written_or_spawned() {
        let d = temp_dir("guards");
        let work = temp_dir("work");
        let m = mirror(&work);
        let never = |_: &Path, _: &str, _: &Path| -> Result<(u32, u64), String> { panic!("spawned") };
        let spec = |name: &'static str, command: &'static str, cwd: Option<&'static str>| StartSpec {
            thread_id: THREAD,
            name,
            command,
            cwd,
            kind: "job",
            watch: None,
            timeout_secs: 0,
        };
        assert!(start_job(&d, &m, &spec("a b", "x", None), &never).is_err());
        assert!(start_job(&d, &m, &spec("a", "  ", None), &never).is_err());
        assert!(start_job(&d, &m, &spec("a", "x", Some("C:\\definitely\\not\\here")), &never).is_err());
        let other = StartSpec { thread_id: "9999aaaa-0b7d-4c1e-9a55-1234567890ab", ..spec("a", "x", None) };
        assert!(start_job(&d, &m, &other, &never).unwrap_err().contains("unknown thread"));
        let bad_id = StartSpec { thread_id: "../x", ..spec("a", "x", None) };
        assert!(start_job(&d, &m, &bad_id, &never).is_err());
        let bad_kind = StartSpec { kind: "daemon", ..spec("a", "x", None) };
        assert!(start_job(&d, &m, &bad_kind, &never).is_err());
        assert!(std::fs::read_dir(&d).unwrap().next().is_none(), "nothing written");
        // A spawn failure leaves no dir and no record.
        let fails = |_: &Path, _: &str, _: &Path| -> Result<(u32, u64), String> { Err("nope".into()) };
        assert_eq!(start_job(&d, &m, &spec("a", "x", None), &fails).unwrap_err(), "nope");
        assert!(read_index(&d).unwrap().jobs.is_empty());
        assert!(std::fs::read_dir(&d).unwrap().all(|e| !e.unwrap().path().is_dir()));
        // A good start: the cwd defaults to the thread's working dir.
        let fake = |_: &Path, line: &str, _: &Path| -> Result<(u32, u64), String> {
            assert!(line.contains("run.ps1"));
            Ok((u32::MAX - 7, 1))
        };
        let r = start_job(&d, &m, &spec("capture", "python capture.py", None), &fake).unwrap();
        assert_eq!(r.cwd, work.to_string_lossy());
        assert_eq!(r.kind, "job");
        assert_eq!(read_index(&d).unwrap().jobs, vec![r.clone()]);
        assert_eq!(std::fs::read_to_string(d.join(&r.id).join("command.txt")).unwrap(), "python capture.py");
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn unique_running_name_and_the_per_thread_cap() {
        let recs: Vec<JobRecord> = (0..8).map(|i| rec(&format!("j{i}"), &format!("n{i}"), "job")).collect();
        let running = vec![JobState::Running; 8];
        assert!(start_conflict(&recs, &running, THREAD, "n3", "job").unwrap().contains("already running"));
        assert!(start_conflict(&recs, &running, THREAD, "fresh", "job").unwrap().contains("cap 8"));
        assert!(start_conflict(&recs, &running, "other-thread", "fresh", "job").is_none());
        assert!(start_conflict(&recs, &running, THREAD, "fresh", "watch-run").is_none(), "watch runs are not capped here");
        let mut ended = running.clone();
        ended[3] = JobState::Ended;
        ended[4] = JobState::Lost;
        assert!(start_conflict(&recs, &ended, THREAD, "n3", "job").is_none(), "an ENDED name is free again");
    }

    #[test]
    fn unreadable_index_is_refused_never_rewritten() {
        let d = temp_dir("index");
        assert!(read_index(&d).unwrap().jobs.is_empty());
        std::fs::write(d.join("jobs.json"), "{ not json").unwrap();
        assert!(read_index(&d).unwrap_err().contains("not rewriting"));
        assert!(snapshot(&d).is_err());
        assert_eq!(std::fs::read_to_string(d.join("jobs.json")).unwrap(), "{ not json");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn snapshot_stamps_lost_once_and_reads_exit_and_last_line() {
        let d = temp_dir("snap");
        let mut a = rec("ja", "ended", "job");
        let b = JobRecord { pid: u32::MAX - 3, ..rec("jb", "gone", "job") };
        a.pid = u32::MAX - 5;
        std::fs::create_dir_all(d.join("ja")).unwrap();
        std::fs::write(d.join("ja").join("exit.json"), r#"{"code":2,"endedAt":5000,"timedOut":false}"#).unwrap();
        std::fs::write(d.join("ja").join("log.txt"), "\u{feff}one\r\ntwo\r\n\r\n").unwrap();
        write_index(&d, &JobsIndex { version: 1, jobs: vec![a, b] }).unwrap();
        let rows = snapshot(&d).unwrap();
        let rows = rows.as_array().unwrap();
        assert_eq!(rows[0]["state"], "ended");
        assert_eq!(rows[0]["exit"]["code"], 2);
        assert_eq!(rows[0]["lastLine"], "two");
        assert!(rows[0].get("pid").is_none(), "no pid leaves Rust");
        assert_eq!(rows[1]["state"], "lost");
        let lost_at = read_index(&d).unwrap().jobs[1].lost_at.expect("stamped");
        snapshot(&d).unwrap();
        assert_eq!(read_index(&d).unwrap().jobs[1].lost_at, Some(lost_at), "stamped once");
        // Notified once.
        assert!(claim_notify(&d, "ja").unwrap().is_some());
        assert!(claim_notify(&d, "ja").unwrap().is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn prune_keeps_running_and_recent_and_the_newest_watch_runs() {
        let day = 24 * 60 * 60 * 1000u64;
        let now = 30 * day;
        let mut old = rec("old", "old", "job");
        old.notified_at = Some(1);
        let mut old_unposted = rec("old2", "old2", "job");
        old_unposted.notified_at = None;
        let mut recent = rec("recent", "recent", "job");
        recent.notified_at = Some(1);
        let running = rec("run", "run", "job");
        let mut runs: Vec<JobRecord> = (0..8)
            .map(|i| JobRecord { watch: Some("w".into()), started_at: 1000 + i, ..rec(&format!("w{i}"), "w", "watch-run") })
            .collect();
        let mut records = vec![old, old_unposted, recent, running];
        records.append(&mut runs);
        let exit = |t: u64| Some(ExitInfo { code: Some(0), ended_at: Some(t), timed_out: false, error: None });
        let mut states = vec![
            (JobState::Ended, exit(day)),
            (JobState::Ended, exit(day)),
            (JobState::Ended, exit(now - day)),
            (JobState::Running, None),
        ];
        states.extend((0..8).map(|_| (JobState::Ended, exit(now))));
        let dropped = prune_plan(&records, &states, now);
        assert!(dropped.contains(&"old".to_string()));
        assert!(!dropped.contains(&"old2".to_string()), "its line was never posted");
        assert!(!dropped.contains(&"recent".to_string()) && !dropped.contains(&"run".to_string()));
        let mut dropped_runs: Vec<&String> = dropped.iter().filter(|d| d.starts_with('w')).collect();
        dropped_runs.sort();
        assert_eq!(dropped_runs, vec!["w0", "w1", "w2"], "the newest {} runs stay", WATCH_RUNS_KEPT);
    }

    #[test]
    fn kill_plan_walks_only_through_processes_younger_than_the_root() {
        // 100 (root, created 50) → 101 (60) → 102 (70); 103 lists 100 as its
        // parent but predates it (a recycled parent pid) and 104 is under 103.
        let children = discovery_children(&[(101, 100), (102, 101), (103, 100), (104, 103), (105, 999)]);
        let created = |p: u32| match p {
            101 => Some(60),
            102 => Some(70),
            103 => Some(10),
            104 => Some(80),
            _ => None,
        };
        let mut plan = kill_plan(100, 50, &children, &created);
        plan.sort();
        assert_eq!(plan, vec![(101, 60), (102, 70)]);
    }

    fn discovery_children(edges: &[(u32, u32)]) -> HashMap<u32, Vec<u32>> {
        crate::discovery::child_index(edges)
    }

    #[test]
    fn log_tail_reads_across_a_rotation() {
        let d = temp_dir("tail");
        std::fs::write(d.join("log.1.txt"), "a\nb\nc\n").unwrap();
        std::fs::write(d.join("log.txt"), "d\ne\n").unwrap();
        assert_eq!(log_tail_lines(&d, 3), vec!["c", "d", "e"]);
        assert_eq!(log_tail_lines(&d, 1), vec!["e"]);
        assert_eq!(log_tail_lines(&d, 10_000).len(), 5, "clamped, not an error");
        assert_eq!(last_line_of(&"x".repeat(500)).chars().count(), LAST_LINE_CAP);
        let _ = std::fs::remove_dir_all(&d);
    }

    // ── Real processes (short, self-cleaning) ────────────────────────────────

    /// Runs the wrapper SYNCHRONOUSLY (no detach): the scripts' own behaviour
    /// — output to the log, the command's exit code, exit.json — with a
    /// command that is hostile to naive quoting.
    #[cfg(windows)]
    #[test]
    fn the_wrapper_runs_a_command_logs_it_and_writes_its_exit_code() {
        let d = temp_dir("real");
        let cmd = "'hi'; Write-Output \"it's `\"quoted`\"\"; cmd /c \"echo from-stderr 1>&2\"; exit 3";
        write_job_files(&d, cmd, &d, 0).unwrap();
        let out = std::process::Command::new(powershell_exe())
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(d.join("run.ps1"))
            .output()
            .unwrap();
        assert!(out.status.success(), "{:?}", out);
        let exit = parse_exit(&std::fs::read_to_string(d.join("exit.json")).unwrap());
        assert_eq!(exit.code, Some(3));
        assert!(!exit.timed_out && exit.ended_at.is_some());
        let log = std::fs::read_to_string(d.join("log.txt")).unwrap();
        assert!(!log.starts_with('\u{feff}'), "no BOM");
        let lines: Vec<&str> = log.lines().collect();
        assert!(lines.contains(&"hi"), "{log}");
        assert!(lines.contains(&"it's \"quoted\""), "{log}");
        assert!(lines.iter().any(|l| l.contains("from-stderr")), "{log}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The supervisor enforces a timeout: the runner's tree is killed, the
    /// code is 124 and `timedOut` is set.
    #[cfg(windows)]
    #[test]
    fn the_wrapper_enforces_its_timeout() {
        let d = temp_dir("timeout");
        write_job_files(&d, "'started'; Start-Sleep -Seconds 30; 'never'", &d, 2).unwrap();
        let t0 = std::time::Instant::now();
        let out = std::process::Command::new(powershell_exe())
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(d.join("run.ps1"))
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(t0.elapsed().as_secs() < 20, "took {:?}", t0.elapsed());
        let exit = parse_exit(&std::fs::read_to_string(d.join("exit.json")).unwrap());
        assert_eq!(exit.code, Some(124));
        assert!(exit.timed_out);
        let log = std::fs::read_to_string(d.join("log.txt")).unwrap();
        assert!(log.contains("started") && !log.contains("never"), "{log}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The real DETACHED spawn + the real tree kill. Short (a 30 s sleep that
    /// is stopped at once, after a 1 s job that finishes on its own), and a
    /// guard kills whatever is left if an assertion fails midway.
    #[cfg(windows)]
    #[test]
    fn a_detached_job_runs_to_its_end_and_a_stopped_one_leaves_no_process() {
        struct Reaper(Vec<(u32, u64)>);
        impl Drop for Reaper {
            fn drop(&mut self) {
                for (pid, created) in &self.0 {
                    let _ = kill_tree(*pid, *created);
                }
            }
        }
        let d = temp_dir("detached");
        let work = temp_dir("dwork");
        let m = mirror(&work);
        let mut reaper = Reaper(Vec::new());
        let spec = |name: &'static str, command: &'static str| StartSpec {
            thread_id: THREAD,
            name,
            command,
            cwd: None,
            kind: "job",
            watch: None,
            timeout_secs: 0,
        };
        let quick = start_job(&d, &m, &spec("quick", "Start-Sleep -Seconds 1; 'hi'"), &spawn_detached).unwrap();
        reaper.0.push((quick.pid, quick.pid_started_at));
        assert!(process_matches(quick.pid, quick.pid_started_at));
        assert!(!process_matches(quick.pid, quick.pid_started_at + 1), "a different creation time is a different process");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !d.join(&quick.id).join("exit.json").exists() {
            assert!(std::time::Instant::now() < deadline, "the quick job never ended");
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        let rows = snapshot(&d).unwrap();
        assert_eq!(rows[0]["state"], "ended");
        assert_eq!(rows[0]["exit"]["code"], 0);
        assert_eq!(rows[0]["lastLine"], "hi");

        let slow = start_job(&d, &m, &spec("slow", "Start-Sleep -Seconds 30"), &spawn_detached).unwrap();
        reaper.0.push((slow.pid, slow.pid_started_at));
        // Let the supervisor start its runner so there is a tree to kill.
        std::thread::sleep(std::time::Duration::from_millis(2500));
        let children = crate::discovery::child_index(&crate::discovery::process_edges());
        let tree = kill_plan(slow.pid, slow.pid_started_at, &children, &|p| crate::discovery::process_start_time_ms(p));
        assert!(!tree.is_empty(), "the runner is under the supervisor");
        assert!(start_job(&d, &m, &spec("slow", "x"), &spawn_detached).unwrap_err().contains("already running"));
        let stopped = stop_record(&d, &|r, _| r.name == "slow").unwrap();
        assert!(stopped.stopped_at.is_some());
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(!process_matches(slow.pid, slow.pid_started_at), "the supervisor is gone");
        for (p, c) in &tree {
            assert!(!process_matches(*p, *c), "descendant {p} survived the stop");
        }
        let rows = snapshot(&d).unwrap();
        assert_eq!(rows[1]["state"], "stopped");
        assert!(!d.join(&slow.id).join("exit.json").exists(), "a stopped job writes no exit code");
        assert!(stop_record(&d, &|r, _| r.name == "slow").unwrap_err().contains("stopped, not running"));
        drop(reaper);
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&work);
    }
}
