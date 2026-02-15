pub mod session;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use session::PtySession;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        PtyManager {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_session(
        &self,
        id: String,
        name: String,
        repo: String,
        working_dir: String,
        cols: u16,
        rows: u16,
        shell: Option<String>,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        let (session, reader) =
            PtySession::spawn(name, repo, working_dir, cols, rows, shell)?;

        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|e| {
                    log::error!("Session lock error on create: {}", e);
                    format!("Lock error: {}", e)
                })?;
            sessions.insert(id.clone(), session);
        }

        log::info!("Session created id={}, spawning reader thread", id);

        // Spawn background reader thread
        let session_id = id.clone();
        let handle = app_handle.clone();
        tokio::task::spawn_blocking(move || {
            read_pty_output(reader, session_id, handle);
        });

        Ok(())
    }

    pub fn restart_session(
        &self,
        id: String,
        name: String,
        repo: String,
        working_dir: String,
        cols: u16,
        rows: u16,
        shell: Option<String>,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        // Close old PTY if it exists (ignore errors — it may already be dead)
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            if let Some(mut old) = sessions.remove(&id) {
                old.kill();
                log::info!("Killed old PTY for restart id={}", id);
            }
        }

        // Create new PTY with same session ID
        let (session, reader) =
            PtySession::spawn(name, repo, working_dir, cols, rows, shell)?;

        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            sessions.insert(id.clone(), session);
        }

        log::info!("Session restarted id={}, spawning reader thread", id);

        let session_id = id.clone();
        let handle = app_handle.clone();
        tokio::task::spawn_blocking(move || {
            read_pty_output(reader, session_id, handle);
        });

        Ok(())
    }

    pub fn close_session(&self, id: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| {
                log::error!("Session lock error on close: {}", e);
                format!("Lock error: {}", e)
            })?;
        if let Some(mut session) = sessions.remove(id) {
            session.kill();
            log::info!("Session removed id={}", id);
        }
        Ok(())
    }

    pub fn write_to_session(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let session = sessions
            .get(id)
            .ok_or_else(|| format!("Session not found: {}", id))?;
        session.write_data(data)
    }

    pub fn resize_session(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let session = sessions
            .get(id)
            .ok_or_else(|| format!("Session not found: {}", id))?;
        session.resize(cols, rows)
    }

    pub fn rename_session(&self, id: &str, new_name: String) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| format!("Session not found: {}", id))?;
        session.name = new_name;
        Ok(())
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionInfo>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        let infos = sessions
            .iter()
            .map(|(id, s)| SessionInfo {
                id: id.clone(),
                name: s.name.clone(),
                repo: s.repo.clone(),
                working_dir: s.working_dir.clone(),
            })
            .collect();
        Ok(infos)
    }
}

fn read_pty_output(mut reader: Box<dyn Read + Send>, session_id: String, app_handle: AppHandle) {
    let mut buf = [0u8; 4096];
    let output_event = format!("session:output:{}", session_id);
    let exited_event = format!("session:exited:{}", session_id);

    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                // EOF — process exited
                log::debug!("PTY reader EOF for session id={}", session_id);
                let _ = app_handle.emit(&exited_event, ());
                break;
            }
            Ok(n) => {
                let encoded = BASE64.encode(&buf[..n]);
                let _ = app_handle.emit(&output_event, encoded);
            }
            Err(e) => {
                log::error!("PTY read error for session id={}: {}", session_id, e);
                let _ = app_handle.emit(&exited_event, ());
                break;
            }
        }
    }
}

#[derive(serde::Serialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub working_dir: String,
}
