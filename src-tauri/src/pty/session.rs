use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

pub struct PtySession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    pub name: String,
    pub repo: String,
    pub working_dir: String,
}

impl PtySession {
    pub fn spawn(
        name: String,
        repo: String,
        working_dir: String,
        cols: u16,
        rows: u16,
        shell: Option<String>,
    ) -> Result<(Self, Box<dyn Read + Send>), String> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        let shell_cmd = shell.unwrap_or_else(|| "powershell.exe".to_string());
        let mut cmd = CommandBuilder::new(&shell_cmd);
        cmd.cwd(&working_dir);

        // For PowerShell, disable the logo banner
        if shell_cmd.to_lowercase().contains("powershell") {
            cmd.arg("-NoLogo");
        }

        pair.slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn shell: {}", e))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

        let session = PtySession {
            writer: Arc::new(Mutex::new(writer)),
            master: pair.master,
            name,
            repo,
            working_dir,
        };

        Ok((session, reader))
    }

    pub fn write_data(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self.writer.lock().map_err(|e| format!("Lock error: {}", e))?;
        writer
            .write_all(data)
            .map_err(|e| format!("Write error: {}", e))?;
        writer.flush().map_err(|e| format!("Flush error: {}", e))?;
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
            .map_err(|e| format!("Resize error: {}", e))
    }
}
