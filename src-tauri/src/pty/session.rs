use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

#[cfg(windows)]
extern "system" {
    fn SetConsoleCP(wCodePageID: u32) -> i32;
    fn SetConsoleOutputCP(wCodePageID: u32) -> i32;
}

pub struct PtySession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pub name: String,
    pub repo: String,
    pub working_dir: String,
    /// OS pid of the shell this PTY spawned — the ROOT of the process-tree
    /// walk that finds a claude conversation running inside this tab
    /// (discovery.rs). `None` only if portable-pty couldn't report one, in
    /// which case the tab is simply never a promotion candidate.
    pub shell_pid: Option<u32>,
    /// Wall-clock ms when the shell above was spawned. Discovery requires a
    /// candidate claude to have STARTED AFTER this instant — the guard against
    /// Windows pid reuse, where a long-dead process's recycled pid can make an
    /// unrelated process look like our descendant (its real parent held the pid
    /// before we did, so it necessarily predates our shell).
    ///
    /// That argument only holds WHILE WE STILL OWN THE PID. Once the shell
    /// exits the OS may hand `shell_pid` to anything, and a process started
    /// under the recycled pid passes the freshness test trivially — hence
    /// `shell_exited` below, plus the creation-time cross-check in
    /// discovery::process_start_time_ms.
    pub spawned_at_ms: u64,
    /// The spawn generation this session was created under. The reader thread
    /// carries the same stamp, so a DYING reader from a previous spawn can be
    /// told apart from the live one (restart_session reuses the session id).
    pub gen: u64,
    /// The shell process is gone (reader hit EOF): the user typed `exit` or the
    /// shell crashed, but the TAB is still open, so the session stays in the
    /// map (its scrollback is still readable and restart reuses the entry).
    ///
    /// LOAD-BEARING for discovery: a dead shell must never be a process-walk
    /// root. `killer` keeps no OS handle on the child, so the pid is reusable
    /// the instant the shell exits, and walking a recycled pid can bind a
    /// STRANGER's claude conversation to this tab — which revive would then
    /// `--resume`. Sessions only ever leave the map on close/restart, so
    /// without this flag there was nothing to distinguish a live shell from a
    /// dead one.
    pub shell_exited: bool,
}

/// Unix-epoch milliseconds, saturating at 0 before 1970 (unreachable in
/// practice; avoids an unwrap on a clock skewed behind the epoch).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl PtySession {
    pub fn spawn(
        name: String,
        repo: String,
        working_dir: String,
        cols: u16,
        rows: u16,
        shell: Option<String>,
        gen: u64,
    ) -> Result<(Self, Box<dyn Read + Send>), String> {
        // Set parent process console to UTF-8 before creating ConPTY
        #[cfg(windows)]
        unsafe {
            SetConsoleCP(65001);
            SetConsoleOutputCP(65001);
        }

        // Strip the Windows verbatim `\\?\` prefix from the spawn cwd. Claude
        // Code keys folder-trust by the EXACT path string in ~/.claude.json, so
        // the verbatim form is a DIFFERENT key than the user's trusted
        // normal-path entries — trust never sticks and the dialog re-fires on
        // every launch. Normalized paths match. Network paths use the verbatim
        // form `\\?\UNC\server\share`, which maps back to `\\server\share` —
        // a bare strip would leave the invalid `UNC\server\share`.
        let working_dir = if let Some(unc) = working_dir.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{}", unc)
        } else if let Some(stripped) = working_dir.strip_prefix(r"\\?\") {
            stripped.to_string()
        } else {
            working_dir
        };

        log::info!("Spawning PTY shell={:?} working_dir={:?} cols={} rows={}", shell, working_dir, cols, rows);

        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| {
                log::error!("Failed to open PTY: {}", e);
                format!("Failed to open PTY: {}", e)
            })?;

        let shell_cmd = shell.unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else if cfg!(target_os = "linux") {
                "/bin/bash".to_string()
            } else {
                "powershell.exe".to_string()
            }
        });
        let mut cmd = CommandBuilder::new(&shell_cmd);
        cmd.cwd(&working_dir);

        // Remove env vars that would prevent tools from launching inside Switchboard
        // (e.g. Claude Code refuses to start if it detects a parent CLAUDECODE session)
        cmd.env_remove("CLAUDECODE");

        let shell_lower = shell_cmd.to_lowercase();
        if shell_lower.contains("powershell") || shell_lower.contains("pwsh") {
            cmd.arg("-NoLogo");
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg("chcp 65001 | Out-Null");
        }

        let child = pair.slave
            .spawn_command(cmd)
            .map_err(|e| {
                log::error!("Failed to spawn shell {:?}: {}", shell_cmd, e);
                format!("Failed to spawn shell: {}", e)
            })?;
        let killer = child.clone_killer();
        // Captured BEFORE the child handle is dropped — this pid is the root of
        // the discovery walk (see PtySession::shell_pid).
        let shell_pid = child.process_id();
        let spawned_at_ms = now_ms();
        log::info!("PTY shell spawned pid={:?} at={}", shell_pid, spawned_at_ms);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| {
                log::error!("Failed to clone PTY reader: {}", e);
                format!("Failed to clone PTY reader: {}", e)
            })?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| {
                log::error!("Failed to take PTY writer: {}", e);
                format!("Failed to take PTY writer: {}", e)
            })?;

        let session = PtySession {
            writer: Arc::new(Mutex::new(writer)),
            master: pair.master,
            killer,
            name,
            repo,
            working_dir,
            shell_pid,
            spawned_at_ms,
            gen,
            shell_exited: false,
        };

        Ok((session, reader))
    }

    pub fn write_data(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self.writer.lock().map_err(|e| {
            log::error!("PTY writer lock error: {}", e);
            format!("Lock error: {}", e)
        })?;
        writer
            .write_all(data)
            .map_err(|e| {
                log::error!("PTY write error: {}", e);
                format!("Write error: {}", e)
            })?;
        writer.flush().map_err(|e| {
            log::error!("PTY flush error: {}", e);
            format!("Flush error: {}", e)
        })?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| {
                log::error!("PTY resize error: {}", e);
                format!("Resize error: {}", e)
            })
    }

    pub fn kill(&mut self) {
        log::debug!("Killing PTY session");
        let _ = self.killer.kill();
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.kill();
    }
}
