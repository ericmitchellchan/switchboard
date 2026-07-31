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
        gen: u64,
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

        log::info!("Session created id={} gen={}, spawning reader thread", id, gen);

        // Spawn background reader on a plain OS thread — NOT tokio::spawn_blocking,
        // which panics outside a Tokio runtime context and would abort the whole
        // app if this is ever called from a sync path.
        let session_id = id.clone();
        let handle = app_handle.clone();
        std::thread::spawn(move || {
            read_pty_output(reader, session_id, gen, handle);
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
        gen: u64,
        shell: Option<String>,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        // Close old PTY if it exists (ignore errors — it may already be dead).
        //
        // NOTE the old reader thread is NOT joined here: it proceeds to EOF on
        // its own schedule, drains its coalescing buffer, and emits its dying
        // session:output / session:exited events — event names keyed only by
        // session id, which the restarted session REUSES. That is why every
        // event carries a spawn generation: the frontend registry drops events
        // whose gen doesn't match its expectation (bumped before this command
        // was invoked), so the stale thread's output can't stamp garbage above
        // the new prompt and its exited event can't re-latch the fresh session.
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

        log::info!("Session restarted id={} gen={}, spawning reader thread", id, gen);

        // Plain OS thread — see the note in create_session.
        let session_id = id.clone();
        let handle = app_handle.clone();
        std::thread::spawn(move || {
            read_pty_output(reader, session_id, gen, handle);
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

/// Per-spawn generation stamp on every event this reader emits. Event names
/// are keyed only by session id; a restart reuses the id, so without the gen
/// the old (unjoined) reader thread's dying events are indistinguishable from
/// the new spawn's. The frontend drops mismatching generations.
#[derive(serde::Serialize, Clone)]
struct OutputPayload {
    gen: u64,
    data: String,
}

#[derive(serde::Serialize, Clone)]
struct ExitedPayload {
    gen: u64,
}

fn read_pty_output(
    mut reader: Box<dyn Read + Send>,
    session_id: String,
    gen: u64,
    app_handle: AppHandle,
) {
    use std::sync::Condvar;

    // Reader/flusher shared state, guarded by one mutex so the Condvar has a
    // race-free predicate (pending non-empty, or done).
    struct Shared {
        pending: Vec<u8>,
        done: bool,
    }

    let mut buf = [0u8; 4096];
    let output_event = format!("session:output:{}", session_id);
    let exited_event = format!("session:exited:{}", session_id);

    // Coalesce output before it crosses the IPC bridge. The reader appends every
    // read into `pending`; a flusher thread drains it and emits one base64 event
    // per batch. Single producer + single consumer draining in order preserves
    // byte order exactly; `done` + the join below guarantee the `exited` event
    // lands strictly after the final output batch. The flusher parks on the
    // Condvar while idle — the 8 ms cadence only runs while data is flowing, so
    // idle sessions cost zero wakeups.
    let sync: Arc<(Mutex<Shared>, Condvar)> = Arc::new((
        Mutex::new(Shared {
            pending: Vec::new(),
            done: false,
        }),
        Condvar::new(),
    ));

    let flusher = {
        let sync = sync.clone();
        let handle = app_handle.clone();
        std::thread::spawn(move || loop {
            // Park until data arrives or the reader signals EOF. A poisoned
            // lock means a panicked peer — recover the guard and carry on.
            {
                let (lock, cvar) = &*sync;
                let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
                while st.pending.is_empty() && !st.done {
                    st = cvar.wait(st).unwrap_or_else(|e| e.into_inner());
                }
                // Drained empty AND done — nothing left to flush, ever.
                if st.pending.is_empty() {
                    break;
                }
            }
            // Data is flowing — sleep one flush interval (lock released) so a
            // burst of reads coalesces into a single batch.
            std::thread::sleep(std::time::Duration::from_millis(OUTPUT_FLUSH_MS));
            let batch = {
                let (lock, _) = &*sync;
                let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
                std::mem::take(&mut st.pending)
            };
            let _ = handle.emit(
                &output_event,
                OutputPayload {
                    gen,
                    data: BASE64.encode(&batch),
                },
            );
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
                let (lock, cvar) = &*sync;
                let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
                st.pending.extend_from_slice(&buf[..n]);
                cvar.notify_one();
            }
            Err(e) => {
                log::error!("PTY read error for session id={}: {}", session_id, e);
                break;
            }
        }
    }

    // EOF (or read error): wake the flusher to drain whatever's left, then join
    // so the exited event is emitted only after the last output batch went out.
    {
        let (lock, cvar) = &*sync;
        lock.lock().unwrap_or_else(|e| e.into_inner()).done = true;
        cvar.notify_one();
    }
    let _ = flusher.join();
    let _ = app_handle.emit(&exited_event, ExitedPayload { gen });
}

#[derive(serde::Serialize, Clone)]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub repo: String,
    pub working_dir: String,
}
