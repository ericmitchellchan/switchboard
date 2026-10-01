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
/// Agent `job` records only (M4 of the review): watch runs are bounded on
/// their own — WATCH_RUNS_KEPT per watch × WATCHES_CAP — so a full set of
/// watches can never push a settled job out before its 7 days.
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
    // The messages never echo the path: a refusal is typed back into the
    // thread under the app's `[switchboard]` prefix, and the path is the
    // agent's text (review of 119bc6b, M1).
    if !p.is_absolute() {
        return Err("the working directory must be an absolute path".into());
    }
    match std::fs::metadata(&p) {
        Ok(m) if m.is_dir() => Ok(p),
        Ok(_) => Err("the working directory is not a directory".into()),
        Err(_) => Err("the working directory does not exist".into()),
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
    /// The FIRST probe that found the process gone with no exit.json. A
    /// second consecutive miss makes the job lost; a live probe clears it
    /// (one failed OpenProcess is not a death).
    #[serde(default)]
    pub missed_at: Option<u64>,
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
            let mut index = serde_json::from_str::<JobsIndex>(raw).map_err(|e| format!("jobs.json is unreadable ({}) — not rewriting it", e))?;
            // A record whose id is not app-minted (a hand edit) is never
            // joined onto a path: it is dropped here, before any probe.
            let before = index.jobs.len();
            index.jobs.retain(|r| job_id_ok(&r.id));
            if index.jobs.len() != before {
                log::warn!("jobs.json: dropped {} record(s) with an invalid id", before - index.jobs.len());
            }
            Ok(index)
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

/// THE state rule (lib/jobs.ts `deriveJobState` and the MCP server's
/// `jobState` mirror it minus the miss count — only this side stamps, and the
/// frontend takes this side's word). `alive` must be read BEFORE `exit`: the
/// supervisor writes exit.json and then exits, so "not alive, then no
/// exit.json" can only mean it died without reaching its last line — but a
/// SINGLE such probe is not trusted (an OpenProcess can fail for a live
/// process): the first miss reads running and is stamped `missedAt`, the
/// second consecutive one is lost.
pub fn derive_state(rec: &JobRecord, exit: Option<&ExitInfo>, alive: bool) -> JobState {
    if exit.is_some() {
        JobState::Ended
    } else if rec.stopped_at.is_some() {
        JobState::Stopped
    } else if rec.lost_at.is_some() {
        JobState::Lost
    } else if alive || rec.missed_at.is_none() {
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
    if !job_id_ok(&rec.id) {
        return (None, false);
    }
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
Remove-Item Env:CLAUDECODE -ErrorAction SilentlyContinue
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
$script:psError = $false
try {
  $source = [System.IO.File]::ReadAllText((Join-Path $here 'command.txt'), $utf8)
  $block = [ScriptBlock]::Create($source)
  $global:LASTEXITCODE = $null
  & $block *>&1 | ForEach-Object {
    $item = $_
    if ($item -is [string]) { Write-JobLog $item }
    elseif ($item -is [System.Management.Automation.ErrorRecord]) {
      # A native command's stderr arrives as NativeCommandError records and
      # is only output; any OTHER error record (a command not found, a missing
      # file) is a PowerShell failure and fails the run.
      if ($item.FullyQualifiedErrorId -notlike 'NativeCommandError*') { $script:psError = $true }
      Write-JobLog ($item.ToString())
    }
    else { foreach ($l in ($item | Out-String -Stream -Width 240)) { if ($l.Trim().Length -gt 0) { Write-JobLog $l } } }
  }
  if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) { $code = $global:LASTEXITCODE }
  elseif ($script:psError) { $code = 1 }
  elseif ($null -ne $global:LASTEXITCODE) { $code = $global:LASTEXITCODE }
} catch {
  Write-JobLog ('error: ' + $_)
  $code = 1
}
$script:jobLog.Dispose()
exit $code
"#;

/// The SUPERVISOR. Constant text (one integer substituted: the timeout). It
/// starts the runner as a child with no window, waits, and writes exit.json
/// as its LAST act, through a tmp + move. A start failure (the cwd vanished)
/// still writes exit.json, with code -1 and the reason in `error`.
///
/// ON A TIMEOUT (exit 124, `timedOut: true`) it kills the runner's tree the
/// way `kill_tree` does — never `taskkill /T`, which follows parent pids with
/// no age check (review of 119bc6b, H1). The runner dies through the .NET
/// Process object's own handle (the one CreateProcess returned, so it cannot
/// be a recycled pid, and holding it keeps the runner's pid reserved while
/// its children are walked); then a small constant C# helper (`SwbTree`,
/// compiled only on this path) takes one Toolhelp snapshot, descends ONLY
/// through processes created no earlier than their own parent, and
/// terminates each after re-reading its creation time through the handle
/// that terminates it. A helper that fails to compile leaves the runner's
/// children running — it never falls back to an unchecked kill.
const RUN_SCRIPT: &str = r##"# Switchboard job supervisor (SWIT-109) - written by the app. It starts
# inner.ps1 (which runs the job's command), waits for it, and writes exit.json
# last. Every value it needs is read from a file beside it.
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
Remove-Item Env:CLAUDECODE -ErrorAction SilentlyContinue
$timeoutMs = __TIMEOUT_MS__
$code = $null
$timedOut = $false
$failure = $null
$treeHelper = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SwbTree {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Entry { public uint dwSize; public uint cntUsage; public uint pid; public IntPtr heap; public uint module; public uint threads; public uint ppid; public int prio; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref Entry e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref Entry e);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  const uint QUERY = 0x1000, TERMINATE = 0x0001;
  public static long CreatedOf(IntPtr h) { long c, e, k, u; return GetProcessTimes(h, out c, out e, out k, out u) ? c : -1; }
  static long Created(uint pid) { IntPtr h = OpenProcess(QUERY, false, pid); if (h == IntPtr.Zero) return -1; long c = CreatedOf(h); CloseHandle(h); return c; }
  public static int KillDescendants(uint root, long rootCreated) {
    var children = new Dictionary<uint, List<uint>>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == new IntPtr(-1)) return 0;
    var e = new Entry(); e.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
    if (Process32FirstW(snap, ref e)) {
      do {
        if (e.pid != 0 && e.pid != e.ppid) { List<uint> l; if (!children.TryGetValue(e.ppid, out l)) { l = new List<uint>(); children[e.ppid] = l; } l.Add(e.pid); }
      } while (Process32NextW(snap, ref e));
    }
    CloseHandle(snap);
    var plan = new List<KeyValuePair<uint, long>>();
    var seen = new HashSet<uint>(); seen.Add(root);
    var stack = new Stack<KeyValuePair<uint, long>>(); stack.Push(new KeyValuePair<uint, long>(root, rootCreated));
    while (stack.Count > 0) {
      var cur = stack.Pop(); List<uint> kids;
      if (!children.TryGetValue(cur.Key, out kids)) continue;
      foreach (uint k in kids) {
        if (!seen.Add(k)) continue;
        long c = Created(k);
        if (c < 0 || c < cur.Value) continue;
        plan.Add(new KeyValuePair<uint, long>(k, c)); stack.Push(new KeyValuePair<uint, long>(k, c));
      }
    }
    int n = 0;
    foreach (var p in plan) {
      IntPtr h = OpenProcess(QUERY | TERMINATE, false, p.Key);
      if (h == IntPtr.Zero) continue;
      if (CreatedOf(h) == p.Value && TerminateProcess(h, 1)) n++;
      CloseHandle(h);
    }
    return n;
  }
}
'@
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
      $helper = $true
      try { Add-Type -TypeDefinition $treeHelper -Language CSharp -ErrorAction Stop } catch { $helper = $false }
      $rootCreated = -1
      if ($helper) { $rootCreated = [SwbTree]::CreatedOf($p.Handle) }
      try { $p.Kill() } catch {}
      $p.WaitForExit(5000) | Out-Null
      if ($helper -and $rootCreated -ge 0) { [SwbTree]::KillDescendants([uint32]$p.Id, [long]$rootCreated) | Out-Null }
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
"##;

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

/// Creation time (unix ms) + still-running for `pid`, through one handle;
/// None when it cannot be opened (gone, or not ours to see). SWIT-113's
/// liveness check reads it for the MCP server's recorded pid.
#[cfg(windows)]
pub fn process_facts(pid: u32) -> Option<(u64, bool)> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let facts = handle_facts(h);
        CloseHandle(h);
        facts
    }
}

#[cfg(not(windows))]
pub fn process_facts(_pid: u32) -> Option<(u64, bool)> {
    None
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
/// from the root, descending ONLY through a process created at or after its
/// OWN PARENT (`created` answers per pid; None = gone or unreadable, skipped)
/// — discovery.rs's freshness rule, applied at every step. The root's age is
/// not enough (review of 119bc6b, H1): a long-running job's subprocess can
/// hold a pid recycled from an exited launcher, and a process that launcher
/// started still lists that pid as its parent — younger than the root, older
/// than the subprocess, and never ours. Nothing under a refused process is
/// followed either.
pub fn kill_plan(
    root: u32,
    root_created: u64,
    children: &HashMap<u32, Vec<u32>>,
    created: &dyn Fn(u32) -> Option<u64>,
) -> Vec<(u32, u64)> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::from([root]);
    let mut stack = vec![(root, root_created)];
    while let Some((cur, cur_created)) = stack.pop() {
        for &child in children.get(&cur).map(|v| v.as_slice()).unwrap_or(&[]) {
            if !seen.insert(child) {
                continue;
            }
            match created(child) {
                Some(t) if t >= cur_created => {
                    out.push((child, t));
                    stack.push((child, t));
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
/// their states: a unique name among RUNNING jobs of the same kind (all
/// threads — the name is how the agent and the page say which one; a watch's
/// run carries its watch's name, and one run of a watch at a time), and ≤
/// JOBS_RUNNING_PER_THREAD running `job`s per thread.
pub fn start_conflict(records: &[JobRecord], states: &[JobState], thread_id: &str, name: &str, kind: &str) -> Option<String> {
    let running = || records.iter().zip(states).filter(|(_, s)| **s == JobState::Running).map(|(r, _)| r);
    if running().any(|r| r.name == name && r.kind == kind) {
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
        missed_at: None,
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
/// the newest WATCH_RUNS_KEPT settled ones, and every settled run of a watch
/// that no longer exists (`watches` = the names in watches.json; None when
/// that file is unreadable, and then no run is judged orphaned); then, over
/// JOBS_INDEX_CAP `job` records, the oldest settled JOBS until it fits
/// (watch runs never count toward, or are pruned by, that cap).
pub fn prune_plan(
    records: &[JobRecord],
    states: &[(JobState, Option<ExitInfo>)],
    now: u64,
    watches: Option<&std::collections::HashSet<String>>,
) -> Vec<String> {
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
    for (watch, mut runs) in by_watch {
        runs.sort_by_key(|&i| std::cmp::Reverse(records[i].started_at));
        let orphaned = watches.map(|w| !w.contains(watch)).unwrap_or(false);
        for &i in runs.iter().skip(if orphaned { 0 } else { WATCH_RUNS_KEPT }) {
            drop.push(records[i].id.clone());
        }
    }
    let jobs_left = (0..records.len()).filter(|&i| records[i].kind == "job" && !drop.contains(&records[i].id)).count();
    if jobs_left > JOBS_INDEX_CAP {
        let mut rest: Vec<usize> = (0..records.len())
            .filter(|&i| records[i].kind == "job" && settled(i) && !drop.contains(&records[i].id))
            .collect();
        rest.sort_by_key(|&i| settled_at(&records[i], states[i].1.as_ref()));
        for &i in rest.iter().take(jobs_left - JOBS_INDEX_CAP) {
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

/// lastLine cache: (log.txt's length, last line) per job id — the tail is
/// re-read only when that length changed (grew, or restarted after a
/// rotation), so the 5s snapshot costs one stat per job. A pruned job's entry
/// is dropped with it.
static LAST_LINES: std::sync::Mutex<Option<HashMap<String, (u64, String)>>> = std::sync::Mutex::new(None);

fn forget_last_line(id: &str) {
    let mut guard = LAST_LINES.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(map) = guard.as_mut() {
        map.remove(id);
    }
}

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
    for (rec, (state, exit, alive)) in index.jobs.iter_mut().zip(&probes) {
        if *state == JobState::Lost && rec.lost_at.is_none() {
            rec.lost_at = Some(now);
            dirty = true;
            log::warn!("Job lost id={} name={} (pid {} gone with no exit.json, twice)", rec.id, rec.name, rec.pid);
        } else if *state == JobState::Running && exit.is_none() && !*alive && rec.missed_at.is_none() {
            rec.missed_at = Some(now);
            dirty = true;
        } else if *alive && rec.missed_at.is_some() {
            rec.missed_at = None;
            dirty = true;
        }
    }
    let states: Vec<(JobState, Option<ExitInfo>)> = probes.iter().map(|(s, e, _)| (*s, e.clone())).collect();
    let watch_names = read_watches(dir).ok().map(|w| w.watches.into_iter().map(|w| w.name).collect::<std::collections::HashSet<_>>());
    let dropped = prune_plan(&index.jobs, &states, now, watch_names.as_ref());
    let mut rows = Vec::new();
    let mut kept = Vec::new();
    for (rec, (state, exit, alive)) in index.jobs.iter().zip(probes) {
        if dropped.contains(&rec.id) {
            if job_id_ok(&rec.id) {
                let _ = std::fs::remove_dir_all(dir.join(&rec.id));
            }
            forget_last_line(&rec.id);
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
            obj.remove("missedAt");
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
    // Bytes, then a LOSSY decode: invalid UTF-8 (a torn multi-byte append)
    // costs the line it is in — whose JSON then fails alone — never the batch.
    let bytes = std::fs::read(&taken).map_err(|e| e.to_string())?;
    let content = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => {
            log::warn!("jobs inbox held invalid UTF-8; the lines around it are kept");
            String::from_utf8_lossy(e.as_bytes()).into_owned()
        }
    };
    if let Err(e) = std::fs::remove_file(&taken) {
        log::warn!("Could not remove taken jobs inbox: {}", e);
    }
    Ok(content)
}

fn mirror_raw() -> Result<String, String> {
    std::fs::read_to_string(super::threads_path()?).map_err(|e| format!("threads mirror unreadable: {}", e))
}

// ── Watches (SWIT-110) ───────────────────────────────────────────────────────
//
// Eric: the Kalshi capture wrote zero prices for a month unnoticed; "Are we
// now collecting ITF?". A WATCH is a job on a schedule with a pass/fail
// reading: `watches.json` in the jobs dir is app-owned (these commands are
// its one writer, under WATCHES_LOCK — taken BEFORE JOBS_LOCK, never after),
// and while the app runs, App's 5s pass starts each due watch as a short
// `watch-run` job (WATCH_TIMEOUT_SECS, enforced by the supervisor). Exit ≠ 0
// (or a timeout, or a lost run) is failing. The pass→fail and fail→pass
// EDGES are the frontend's (lib/jobs.ts `watchEdge`); these commands only
// record what happened.

pub const WATCH_TIMEOUT_SECS: u32 = 120;
pub const WATCH_EVERY_MIN: u32 = 5;
/// A week.
pub const WATCH_EVERY_MAX: u32 = 7 * 24 * 60;
pub const WATCHES_PER_THREAD: usize = 8;
pub const WATCHES_CAP: usize = 64;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Watch {
    pub name: String,
    pub thread_id: String,
    pub command: String,
    pub cwd: String,
    pub every_min: u32,
    pub created_at: u64,
    #[serde(default)]
    pub last_run_at: Option<u64>,
    /// The newest run's job id.
    #[serde(default)]
    pub last_job_id: Option<String>,
    /// The run the current `status` was read from (so a run is judged once).
    #[serde(default)]
    pub judged_job_id: Option<String>,
    /// `unknown` until the first run is judged, then `pass` | `fail`.
    #[serde(default = "unknown_status")]
    pub status: String,
    #[serde(default)]
    pub last_line: String,
    /// When `status` last changed.
    #[serde(default)]
    pub changed_at: Option<u64>,
}

fn unknown_status() -> String {
    "unknown".into()
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct WatchesFile {
    pub version: u32,
    pub watches: Vec<Watch>,
}

pub static WATCHES_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Missing = none; unparseable = an error, never rewritten (read_index's rule).
pub fn read_watches(dir: &Path) -> Result<WatchesFile, String> {
    match std::fs::read_to_string(dir.join("watches.json")) {
        Ok(raw) => {
            let raw = raw.trim_start_matches('\u{feff}');
            if raw.trim().is_empty() {
                return Ok(WatchesFile { version: 1, watches: Vec::new() });
            }
            serde_json::from_str(raw).map_err(|e| format!("watches.json is unreadable ({}) — not rewriting it", e))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(WatchesFile { version: 1, watches: Vec::new() }),
        Err(e) => Err(e.to_string()),
    }
}

pub fn write_watches(dir: &Path, file: &WatchesFile) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("watches.json.tmp");
    let body = serde_json::to_string_pretty(&WatchesFile { version: 1, watches: file.watches.clone() }).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("watches.json")).map_err(|e| e.to_string())
}

pub struct WatchSpec<'a> {
    pub thread_id: &'a str,
    pub name: &'a str,
    pub command: &'a str,
    pub cwd: Option<&'a str>,
    pub every_min: u32,
}

/// SET (the inbox's `watch`): every job guard, then the schedule's own — a
/// cadence of WATCH_EVERY_MIN..=WATCH_EVERY_MAX minutes, a name no OTHER
/// thread's watch holds (the same thread re-setting it REPLACES it and its
/// reading starts over), ≤ WATCHES_PER_THREAD per thread, ≤ WATCHES_CAP.
pub fn set_watch(dir: &Path, mirror_raw: &str, spec: &WatchSpec, now: u64) -> Result<Watch, String> {
    if !super::valid_thread_id(spec.thread_id) {
        return Err("invalid thread id".into());
    }
    let thread_dir = super::working_dir_from_mirror(mirror_raw, spec.thread_id)?;
    if !job_name_ok(spec.name) {
        return Err(format!("watch name must be {} or fewer of A-Z a-z 0-9 _ . -", JOB_NAME_MAX));
    }
    let command = command_ok(spec.command)?;
    let cwd = match spec.cwd {
        Some(c) if !c.trim().is_empty() => cwd_ok(c)?,
        _ => cwd_ok(&thread_dir.to_string_lossy())?,
    };
    if spec.every_min < WATCH_EVERY_MIN || spec.every_min > WATCH_EVERY_MAX {
        return Err(format!("every must be {}..={} minutes", WATCH_EVERY_MIN, WATCH_EVERY_MAX));
    }
    let _guard = WATCHES_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = read_watches(dir)?;
    if let Some(other) = file.watches.iter().find(|w| w.name == spec.name && w.thread_id != spec.thread_id) {
        return Err(format!("another thread already watches {} — pick another name", other.name));
    }
    file.watches.retain(|w| w.name != spec.name);
    let mine = file.watches.iter().filter(|w| w.thread_id == spec.thread_id).count();
    if mine >= WATCHES_PER_THREAD {
        return Err(format!("this thread already has {} watches (cap {})", mine, WATCHES_PER_THREAD));
    }
    if file.watches.len() >= WATCHES_CAP {
        return Err(format!("{} watches already (cap {})", file.watches.len(), WATCHES_CAP));
    }
    let watch = Watch {
        name: spec.name.to_string(),
        thread_id: spec.thread_id.to_string(),
        command,
        cwd: cwd.to_string_lossy().into_owned(),
        every_min: spec.every_min,
        created_at: now,
        last_run_at: None,
        last_job_id: None,
        judged_job_id: None,
        status: unknown_status(),
        last_line: String::new(),
        changed_at: None,
    };
    file.watches.push(watch.clone());
    write_watches(dir, &file)?;
    Ok(watch)
}

/// REMOVE (the inbox's `unwatch`, or the user's). `thread_id` Some = only
/// that thread's own watch; None = the user's hand on Home.
pub fn remove_watch(dir: &Path, thread_id: Option<&str>, name: &str) -> Result<(), String> {
    let _guard = WATCHES_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = read_watches(dir)?;
    let Some(i) = file.watches.iter().position(|w| w.name == name) else {
        return Err(format!("no watch named {}", name));
    };
    if let Some(t) = thread_id {
        if file.watches[i].thread_id != t {
            return Err(format!("{} is another thread's watch", name));
        }
    }
    file.watches.remove(i);
    write_watches(dir, &file)
}

/// RUN one watch now (App's pass decides it is due): a `watch-run` job with
/// the watch's name, thread, command and cwd and the WATCH_TIMEOUT_SECS
/// timeout. Three outcomes (review of 5ef0419, H2):
/// - a run of it is already IN FLIGHT (the watch was re-set while its old
///   run was running): Ok(None), and NOTHING is recorded — a conflict means
///   "skip this tick", never "failing";
/// - started: Ok(Some(run)); `lastRunAt` + `lastJobId` move;
/// - could not start (anything: a missing threads mirror, an unknown thread,
///   a vanished cwd, a spawn error): `lastRunAt` moves on EVERY such path so
///   it is retried at the next due time and not every tick, the watch reads
///   failing with the reason, and `judgedJobId` is set to the last run so
///   that older run is never judged again (it would read "passing" and flap).
pub fn run_watch(
    dir: &Path,
    mirror: &Result<String, String>,
    name: &str,
    now: u64,
    spawn: &dyn Fn(&Path, &str, &Path) -> Result<(u32, u64), String>,
) -> Result<Option<JobRecord>, String> {
    let _guard = WATCHES_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = read_watches(dir)?;
    let Some(i) = file.watches.iter().position(|w| w.name == name) else {
        return Err(format!("no watch named {}", name));
    };
    let w = file.watches[i].clone();
    if run_in_flight(dir, &w.name)? {
        return Ok(None);
    }
    let spec = StartSpec {
        thread_id: &w.thread_id,
        name: &w.name,
        command: &w.command,
        cwd: Some(&w.cwd),
        kind: "watch-run",
        watch: Some(&w.name),
        timeout_secs: WATCH_TIMEOUT_SECS,
    };
    let result = match mirror {
        Ok(m) => start_job(dir, m, &spec, spawn),
        Err(e) => Err(e.clone()),
    };
    let entry = &mut file.watches[i];
    entry.last_run_at = Some(now);
    match &result {
        Ok(rec) => entry.last_job_id = Some(rec.id.clone()),
        Err(e) => {
            if entry.status != "fail" {
                entry.changed_at = Some(now);
            }
            entry.status = "fail".into();
            entry.judged_job_id = entry.last_job_id.clone();
            entry.last_line = format!("could not start: {}", e).chars().take(LAST_LINE_CAP).collect();
        }
    }
    write_watches(dir, &file)?;
    result.map(Some)
}

/// Is a run of this watch running now? (Under the caller's WATCHES_LOCK; this
/// takes JOBS_LOCK — the one lock order.)
fn run_in_flight(dir: &Path, watch: &str) -> Result<bool, String> {
    let _guard = lock();
    let index = read_index(dir)?;
    let states = states_of(dir, &index);
    Ok(index
        .jobs
        .iter()
        .zip(states)
        .any(|(r, (s, _, _))| r.kind == "watch-run" && r.watch.as_deref() == Some(watch) && s == JobState::Running))
}

/// RECORD a finished run's reading. Only the watch's CURRENT run can be
/// recorded (a stale judgement of an older run is refused), once.
pub fn record_watch(dir: &Path, name: &str, job_id: &str, status: &str, last_line: &str, now: u64) -> Result<(), String> {
    if status != "pass" && status != "fail" {
        return Err("status must be pass or fail".into());
    }
    let _guard = WATCHES_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = read_watches(dir)?;
    let Some(w) = file.watches.iter_mut().find(|w| w.name == name) else {
        return Err(format!("no watch named {}", name));
    };
    if w.last_job_id.as_deref() != Some(job_id) {
        return Err(format!("{} is not the current run of {}", job_id, name));
    }
    if w.judged_job_id.as_deref() == Some(job_id) {
        return Ok(());
    }
    if w.status != status {
        w.changed_at = Some(now);
    }
    w.status = status.into();
    w.judged_job_id = Some(job_id.into());
    w.last_line = last_line.chars().take(LAST_LINE_CAP).collect();
    write_watches(dir, &file)
}

#[tauri::command]
pub async fn watches_read() -> Result<String, String> {
    let file = read_watches(&jobs_dir()?)?;
    serde_json::to_string(&file.watches).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn watch_set(thread_id: String, name: String, command: String, cwd: Option<String>, every_min: u32) -> Result<(), String> {
    let spec = WatchSpec { thread_id: &thread_id, name: &name, command: &command, cwd: cwd.as_deref(), every_min };
    set_watch(&jobs_dir()?, &mirror_raw()?, &spec, now_ms()).map(|_| ())
}

/// `thread_id` None = the user (Home's two-click `unwatch`).
#[tauri::command]
pub async fn watch_remove(thread_id: Option<String>, name: String) -> Result<(), String> {
    remove_watch(&jobs_dir()?, thread_id.as_deref(), &name)
}

#[tauri::command]
pub async fn watch_run(name: String) -> Result<(), String> {
    // The mirror's failure is a start failure like any other: run_watch
    // records it (and moves lastRunAt), it is not an early return.
    run_watch(&jobs_dir()?, &mirror_raw(), &name, now_ms(), &spawn_detached).map(|_| ())
}

#[tauri::command]
pub async fn watch_record(name: String, job_id: String, status: String, last_line: String) -> Result<(), String> {
    record_watch(&jobs_dir()?, &name, &job_id, &status, &last_line, now_ms())
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
    // A deleted thread gets no line (and no `threads/<id>/` recreated for it).
    if super::working_dir_from_mirror(&mirror_raw()?, &rec.thread_id).is_err() {
        return Ok(false);
    }
    super::append_app_post(&rec.thread_id, &format!("job-{}", rec.id), &text)?;
    Ok(true)
}

/// Post one line from the jobs machinery to a thread (a refused request).
#[tauri::command]
pub async fn jobs_post(thread_id: String, text: String) -> Result<(), String> {
    // Only a thread the mirror knows: a request's thread id is the inbox's
    // text, and an unknown one must not create `threads/<id>/`.
    super::working_dir_from_mirror(&mirror_raw()?, &thread_id)?;
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
            missed_at: None,
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
        assert_eq!(derive_state(&r, None, false), JobState::Running, "ONE miss is not a loss");
        let missed = JobRecord { missed_at: Some(9), ..r.clone() };
        assert_eq!(derive_state(&missed, None, false), JobState::Lost, "two consecutive misses are");
        assert_eq!(derive_state(&missed, None, true), JobState::Running);
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
        assert!(!run.to_lowercase().contains("taskkill"), "no unchecked /T tree kill");
        assert!(run.contains("c < cur.Value"), "the helper applies the parent-age rule");
        assert!(run.contains("Remove-Item Env:CLAUDECODE") && inner_script().contains("Remove-Item Env:CLAUDECODE"));
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
        assert_eq!(rows[1]["state"], "running", "the first miss is not trusted");
        assert!(read_index(&d).unwrap().jobs[1].missed_at.is_some());
        assert!(read_index(&d).unwrap().jobs[1].lost_at.is_none());
        assert!(rows[1].get("missedAt").is_none());
        let rows = snapshot(&d).unwrap();
        assert_eq!(rows.as_array().unwrap()[1]["state"], "lost");
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
        let dropped = prune_plan(&records, &states, now, Some(&std::collections::HashSet::from(["w".to_string()])));
        assert!(!prune_plan(&records, &states, now, Some(&std::collections::HashSet::new())).iter().any(|d| d == "run"), "a running run is never an orphan");
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

    #[test]
    fn kill_plan_needs_each_child_younger_than_its_own_parent() {
        // Root 100 (created 50). Its subprocess D holds pid 201 (created 90),
        // a pid recycled from an exited launcher P that, at 70, started an
        // unrelated U (pid 202) — younger than the ROOT, older than D. U still
        // lists 201 as its parent. The root-age rule would kill U; the
        // parent-age rule does not, nor anything under U.
        let children = discovery_children(&[(201, 100), (202, 201), (203, 202), (204, 201)]);
        let created = |p: u32| match p {
            201 => Some(90),
            202 => Some(70),
            203 => Some(95),
            204 => Some(99),
            _ => None,
        };
        let mut plan = kill_plan(100, 50, &children, &created);
        plan.sort();
        assert_eq!(plan, vec![(201, 90), (204, 99)]);
    }

    #[test]
    fn a_watch_is_set_replaced_capped_and_removed_by_its_own_thread() {
        let d = temp_dir("watch");
        let work = temp_dir("wwork");
        let m = mirror(&work);
        let spec = |name: &'static str, every_min: u32| WatchSpec { thread_id: THREAD, name, command: "python check.py", cwd: None, every_min };
        assert!(set_watch(&d, &m, &spec("prices", 4), 1).unwrap_err().contains("5..="));
        assert!(set_watch(&d, &m, &spec("prices", WATCH_EVERY_MAX + 1), 1).is_err());
        assert!(set_watch(&d, &m, &spec("bad name", 5), 1).is_err());
        let w = set_watch(&d, &m, &spec("prices", 15), 1).unwrap();
        assert_eq!((w.status.as_str(), w.cwd.clone()), ("unknown", work.to_string_lossy().into_owned()));
        // The same thread re-setting it replaces it (one entry, a fresh reading).
        set_watch(&d, &m, &spec("prices", 30), 2).unwrap();
        let file = read_watches(&d).unwrap();
        assert_eq!(file.watches.len(), 1);
        assert_eq!(file.watches[0].every_min, 30);
        // Another thread cannot take the name, and cannot remove it.
        let other = "9999aaaa-0b7d-4c1e-9a55-1234567890ab";
        let m2 = serde_json::json!({"threads": [
            {"id": THREAD, "workingDir": work.to_string_lossy()},
            {"id": other, "workingDir": work.to_string_lossy()},
        ]})
        .to_string();
        let theirs = WatchSpec { thread_id: other, ..spec("prices", 15) };
        assert!(set_watch(&d, &m2, &theirs, 3).unwrap_err().contains("another thread"));
        assert!(remove_watch(&d, Some(other), "prices").unwrap_err().contains("another thread"));
        // The per-thread cap.
        for i in 1..WATCHES_PER_THREAD {
            let name: &'static str = Box::leak(format!("w{i}").into_boxed_str());
            set_watch(&d, &m, &spec(name, 5), 4).unwrap();
        }
        assert!(set_watch(&d, &m, &spec("one-more", 5), 5).unwrap_err().contains("cap 8"));
        // Removal: the owner, or the user (None).
        remove_watch(&d, Some(THREAD), "prices").unwrap();
        remove_watch(&d, None, "w1").unwrap();
        assert!(remove_watch(&d, None, "w1").unwrap_err().contains("no watch"));
        assert_eq!(read_watches(&d).unwrap().watches.len(), WATCHES_PER_THREAD - 2);
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn a_run_is_a_timed_watch_run_job_recorded_once_and_a_failed_start_reads_failing() {
        let d = temp_dir("wrun");
        let work = temp_dir("wrwork");
        let m = mirror(&work);
        set_watch(&d, &m, &WatchSpec { thread_id: THREAD, name: "itf", command: "python itf.py", cwd: None, every_min: 5 }, 1).unwrap();
        let fake = |_: &Path, _: &str, _: &Path| -> Result<(u32, u64), String> { Ok((u32::MAX - 9, 1)) };
        let mm = Ok(m.clone());
        let rec = run_watch(&d, &mm, "itf", 100, &fake).unwrap().expect("started");
        assert_eq!((rec.kind.as_str(), rec.watch.as_deref(), rec.timeout_secs), ("watch-run", Some("itf"), WATCH_TIMEOUT_SECS));
        assert!(std::fs::read_to_string(d.join(&rec.id).join("run.ps1")).unwrap().contains("$timeoutMs = 120000"));
        let w = &read_watches(&d).unwrap().watches[0];
        assert_eq!((w.last_run_at, w.last_job_id.clone()), (Some(100), Some(rec.id.clone())));
        // Only the current run is recorded, once.
        assert!(record_watch(&d, "itf", "j-old", "fail", "x", 200).is_err());
        assert!(record_watch(&d, "itf", &rec.id, "maybe", "x", 200).is_err());
        record_watch(&d, "itf", &rec.id, "fail", "0 prices captured", 200).unwrap();
        record_watch(&d, "itf", &rec.id, "pass", "ignored", 300).unwrap();
        let w = &read_watches(&d).unwrap().watches[0];
        assert_eq!((w.status.as_str(), w.last_line.as_str(), w.changed_at), ("fail", "0 prices captured", Some(200)));
        // A run that cannot start moves lastRunAt and reads failing, with why.
        // (The first run has ended — a run with no exit.json and one missed
        // probe still counts as in flight, and the next run would be skipped.)
        std::fs::write(d.join(&rec.id).join("exit.json"), r#"{"code":1,"endedAt":150,"timedOut":false}"#).unwrap();
        let broken = |_: &Path, _: &str, _: &Path| -> Result<(u32, u64), String> { Err("no powershell".into()) };
        assert_eq!(run_watch(&d, &mm, "itf", 400, &broken).unwrap_err(), "no powershell");
        let w = &read_watches(&d).unwrap().watches[0];
        assert_eq!((w.status.as_str(), w.last_run_at), ("fail", Some(400)));
        assert!(w.last_line.contains("could not start: no powershell"));
        assert!(run_watch(&d, &mm, "nope", 1, &fake).is_err());
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&work);
    }

    /// Review of 5ef0419, H2: after a PASSING run, a watch that cannot start
    /// reads failing and STAYS failing — the old passing run is never judged
    /// again — and every failure path moves lastRunAt.
    #[test]
    fn a_watch_that_cannot_start_stays_failing_and_waits_for_its_next_due_time() {
        let d = temp_dir("wflap");
        let work = temp_dir("wflapwork");
        let m = mirror(&work);
        let mm: Result<String, String> = Ok(m.clone());
        set_watch(&d, &m, &WatchSpec { thread_id: THREAD, name: "cap", command: "x", cwd: None, every_min: 5 }, 1).unwrap();
        let fake = |_: &Path, _: &str, _: &Path| -> Result<(u32, u64), String> { Ok((u32::MAX - 11, 1)) };
        let first = run_watch(&d, &mm, "cap", 100, &fake).unwrap().unwrap();
        // The run ended passing and was judged so.
        std::fs::write(d.join(&first.id).join("exit.json"), r#"{"code":0,"endedAt":150,"timedOut":false}"#).unwrap();
        record_watch(&d, "cap", &first.id, "pass", "ok", 160).unwrap();
        // The next run cannot start.
        let broken = |_: &Path, _: &str, _: &Path| -> Result<(u32, u64), String> { Err("spawn failed".into()) };
        assert!(run_watch(&d, &mm, "cap", 400, &broken).is_err());
        let w = read_watches(&d).unwrap().watches[0].clone();
        assert_eq!(w.status, "fail");
        assert_eq!(w.judged_job_id.as_deref(), Some(first.id.as_str()), "the old run is marked judged");
        assert_eq!(w.last_run_at, Some(400));
        // Re-recording that old run (what the pass would try) changes nothing.
        record_watch(&d, "cap", &first.id, "pass", "ok", 500).unwrap();
        assert_eq!(read_watches(&d).unwrap().watches[0].status, "fail");
        // A missing threads mirror is a start failure too — recorded, lastRunAt moved.
        let no_mirror: Result<String, String> = Err("threads mirror unreadable".into());
        assert!(run_watch(&d, &no_mirror, "cap", 700, &fake).is_err());
        let w = read_watches(&d).unwrap().watches[0].clone();
        assert_eq!((w.status.as_str(), w.last_run_at), ("fail", Some(700)));
        assert!(w.last_line.contains("threads mirror unreadable"));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&work);
    }

    /// H2 (b): re-setting a watch while its run is in flight is a SKIP.
    #[test]
    fn a_run_in_flight_is_skipped_never_recorded_failing() {
        let d = temp_dir("wskip");
        let work = temp_dir("wskipwork");
        let m = mirror(&work);
        let mm: Result<String, String> = Ok(m.clone());
        set_watch(&d, &m, &WatchSpec { thread_id: THREAD, name: "cap", command: "x", cwd: None, every_min: 5 }, 1).unwrap();
        // A run "in flight": this test process's own pid + creation time.
        let me = std::process::id();
        let created = crate::discovery::process_start_time_ms(me).unwrap();
        let alive = |_: &Path, _: &str, _: &Path| -> Result<(u32, u64), String> { Ok((me, created)) };
        run_watch(&d, &mm, "cap", 100, &alive).unwrap().unwrap();
        // The agent re-sets it: the reading starts over, the old run still runs.
        set_watch(&d, &m, &WatchSpec { thread_id: THREAD, name: "cap", command: "y", cwd: None, every_min: 5 }, 200).unwrap();
        let never = |_: &Path, _: &str, _: &Path| -> Result<(u32, u64), String> { panic!("started a second run") };
        assert!(run_watch(&d, &mm, "cap", 300, &never).unwrap().is_none());
        let w = read_watches(&d).unwrap().watches[0].clone();
        assert_eq!((w.status.as_str(), w.last_run_at, w.last_line.as_str()), ("unknown", None, ""));
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn the_index_cap_counts_jobs_not_watch_runs() {
        let now = 10 * 24 * 60 * 60 * 1000u64;
        let mut records = Vec::new();
        let mut states = Vec::new();
        // 300 recent, posted jobs + 320 watch runs (64 watches × 5).
        for i in 0..300 {
            records.push(JobRecord { notified_at: Some(1), started_at: now - 1000 + i as u64, ..rec(&format!("j{i}"), "a", "job") });
            states.push((JobState::Ended, None));
        }
        for i in 0..320 {
            records.push(JobRecord { watch: Some(format!("w{}", i / 5)), started_at: now - 500, ..rec(&format!("r{i}"), "w", "watch-run") });
            states.push((JobState::Ended, None));
        }
        let watches: std::collections::HashSet<String> = (0..64).map(|i| format!("w{i}")).collect();
        assert!(prune_plan(&records, &states, now, Some(&watches)).is_empty(), "no recent job is pushed out by watch runs");
        records.push(JobRecord { notified_at: Some(1), started_at: 1, ..rec("oldest", "a", "job") });
        states.push((JobState::Ended, None));
        let dropped = prune_plan(&records, &states, 1_000_000, Some(&watches));
        assert_eq!(dropped, vec!["oldest".to_string()], "one job over the cap: the oldest settled job goes");
    }

    #[test]
    fn the_inbox_take_keeps_the_lines_around_invalid_utf8() {
        let d = temp_dir("inbox");
        let path = d.join("jobs-inbox.json");
        let mut bytes = b"{\"op\":\"stop\",\"name\":\"a\"}\n".to_vec();
        bytes.extend_from_slice(&[0xff, 0xfe, b'\n']);
        bytes.extend_from_slice(b"{\"op\":\"stop\",\"name\":\"b\"}\n");
        std::fs::write(&path, bytes).unwrap();
        let text = take_inbox(&path).unwrap();
        assert!(text.contains("\"a\"") && text.contains("\"b\""), "{text}");
        assert!(!path.exists() && !path.with_extension("json.taking").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_watch_run_and_an_agent_job_may_share_a_name() {
        let recs = vec![JobRecord { watch: Some("itf".into()), ..rec("j1", "itf", "watch-run") }];
        let running = vec![JobState::Running];
        assert!(start_conflict(&recs, &running, THREAD, "itf", "job").is_none());
        assert!(start_conflict(&recs, &running, THREAD, "itf", "watch-run").unwrap().contains("already running"), "one run of a watch at a time");
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

    fn run_sync(d: &Path) -> ExitInfo {
        let out = std::process::Command::new(powershell_exe())
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(d.join("run.ps1"))
            .output()
            .unwrap();
        assert!(out.status.success(), "{:?}", out);
        parse_exit(&std::fs::read_to_string(d.join("exit.json")).unwrap())
    }

    /// Review of 119bc6b, H3: a command that is not found, or a file that is
    /// missing, FAILS the run (exit 1) — a native command's stderr does not,
    /// and an explicit `exit` wins.
    #[cfg(windows)]
    #[test]
    fn a_powershell_error_fails_the_run_and_native_stderr_does_not() {
        let cases: [(&str, i64); 5] = [
            ("definitely-not-a-command-swb", 1),
            ("Get-Content -LiteralPath 'C:\\definitely\\missing\\swb.txt'", 1),
            ("cmd /c \"echo warn 1>&2\"", 0),
            ("Get-Content -LiteralPath 'C:\\definitely\\missing\\swb.txt'; exit 0", 0),
            ("cmd /c \"exit 4\"; 'after'", 4),
        ];
        for (cmd, want) in cases {
            let d = temp_dir("pserr");
            write_job_files(&d, cmd, &d, 0).unwrap();
            assert_eq!(run_sync(&d).code, Some(want), "{cmd}");
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    /// H1: a timeout kills the runner AND the command's own child — with the
    /// safe helper, not `taskkill /T`.
    #[cfg(windows)]
    #[test]
    fn a_timeout_kills_the_commands_child_too() {
        struct Reaper(Option<(u32, u64)>, Option<std::process::Child>);
        impl Drop for Reaper {
            fn drop(&mut self) {
                if let Some((pid, created)) = self.0 {
                    let _ = kill_tree(pid, created);
                }
                if let Some(c) = self.1.as_mut() {
                    let _ = c.kill();
                }
            }
        }
        let d = temp_dir("treekill");
        let cmd = "$c = Start-Process -FilePath ping.exe -ArgumentList '-n','60','127.0.0.1' -NoNewWindow -PassThru; [IO.File]::WriteAllText((Join-Path (Get-Location) 'child.txt'), [string]$c.Id); $c.WaitForExit()";
        write_job_files(&d, cmd, &d, 3).unwrap();
        let supervisor = std::process::Command::new(powershell_exe())
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(d.join("run.ps1"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut reaper = Reaper(None, Some(supervisor));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let child_pid: u32 = loop {
            if let Ok(t) = std::fs::read_to_string(d.join("child.txt")) {
                if let Ok(p) = t.trim().parse() {
                    break p;
                }
            }
            assert!(std::time::Instant::now() < deadline, "the command never started its child");
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        let created = crate::discovery::process_start_time_ms(child_pid).expect("the child is running");
        reaper.0 = Some((child_pid, created));
        let status = reaper.1.as_mut().unwrap().wait().unwrap();
        assert!(status.success());
        let exit = parse_exit(&std::fs::read_to_string(d.join("exit.json")).unwrap());
        assert_eq!((exit.code, exit.timed_out), (Some(124), true));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!process_matches(child_pid, created), "the command's child survived the timeout");
        drop(reaper);
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
