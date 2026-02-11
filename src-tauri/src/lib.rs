mod config;
mod pty;

use config::{load_config, Config};
use pty::{PtyManager, SessionInfo};
use std::sync::Arc;
use tauri::State;
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

    state.pty_manager.create_session(
        id.clone(),
        name.clone(),
        repo.clone(),
        working_dir.clone(),
        c,
        r,
        Some(cfg.shell),
        app_handle,
    )?;

    Ok(SessionInfo {
        id,
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
    Ok(load_config())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState {
        pty_manager: PtyManager::new(),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            create_session,
            close_session,
            write_to_session,
            resize_session,
            rename_session,
            list_sessions,
            get_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
