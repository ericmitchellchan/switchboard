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

        // Spawn background reader on a plain OS thread — NOT tokio::spawn_blocking,
        // which panics outside a Tokio runtime context and would abort the whole
        // app if this is ever called from a sync path.
        let session_id = id.clone();
        let handle = app_handle.clone();
        std::thread::spawn(move || {
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

        // Plain OS thread — see the note in create_session.
        let session_id = id.clone();
        let handle = app_handle.clone();
        std::thread::spawn(move || {
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

/// Flush cadence for coalesced PTY output. Fast producers (builds, agent TUIs)
/// write in bursts of many small chunks; at one Tauri event per 4 KB read that
/// floods the webview's single UI thread (hundreds of events/sec) and makes the
/// terminal feel sluggish. Accumulating reads and flushing every ~8 ms turns a
/// burst into a handful of larger events — imperceptible added latency, far
/// less UI-thread churn. xterm absorbs large writes cheaply.
const OUTPUT_FLUSH_MS: u64 = 8;

fn read_pty_output(mut reader: Box<dyn Read + Send>, session_id: String, app_handle: AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};

    let mut buf = [0u8; 4096];
    let output_event = format!("session:output:{}", session_id);
    let exited_event = format!("session:exited:{}", session_id);

    // Coalesce output before it crosses the IPC bridge. The reader appends every
    // read into `pending`; a flusher thread drains it on a short cadence and
    // emits one base64 event per batch. Single producer + single consumer
    // draining in order preserves byte order exactly; `done` + the join below
    // guarantee the `exited` event lands strictly after the final output batch.
    let pending: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let done = Arc::new(AtomicBool::new(false));

    let flusher = {
        let pending = pending.clone();
        let done = done.clone();
        let handle = app_handle.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(OUTPUT_FLUSH_MS));
            let batch = match pending.lock() {
                Ok(mut p) if !p.is_empty() => std::mem::take(&mut *p),
                _ => {
                    // Nothing to flush — exit once the reader has signalled EOF.
                    if done.load(Ordering::Acquire) {
                        break;
                    }
                    continue;
                }
            };
            let _ = handle.emit(&output_event, BASE64.encode(&batch));
        })
    };

    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                // EOF — process exited
                log::debug!("PTY reader EOF for session id={}", session_id);
                break;
            }
            Ok(n) => {
                if let Ok(mut p) = pending.lock() {
                    p.extend_from_slice(&buf[..n]);
                }
            }
            Err(e) => {
                log::error!("PTY read error for session id={}: {}", session_id, e);
                break;
            }
        }
    }

    // EOF (or read error): let the flusher drain whatever's left, then join so
    // the exited event is emitted only after the last output batch has gone out.
    done.store(true, Ordering::Release);
    let _ = flusher.join();
    let _ = app_handle.emit(&exited_event, ());
}

#[derive(serde::Serialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub working_dir: String,
}
