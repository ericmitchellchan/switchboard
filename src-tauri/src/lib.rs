mod config;
mod pty;

use config::{load_config, Config};
use pty::{PtyManager, SessionInfo};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
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

    let ctrl_v = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyV);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Ok(text) = app.clipboard().read_text() {
                            if !text.is_empty() {
                                let _ = app.emit("clipboard-paste", text);
                            }
                        }
                    }
                })
                .build(),
        )
        .manage(app_state)
        .setup(move |app| {
            // Register Ctrl+V as a global shortcut so it fires at the OS
            // level, catching both real keystrokes and simulated ones from
            // tools like Wispr Flow (which don't reach the webview).
            app.global_shortcut().register(ctrl_v)?;
            Ok(())
        })
        .on_window_event(move |window, event| {
            // Register the global shortcut only while our window is focused
            // so we don't steal Ctrl+V from other applications.
            if let tauri::WindowEvent::Focused(focused) = event {
                let app = window.app_handle();
                if *focused {
                    let _ = app.global_shortcut().register(ctrl_v);
                } else {
                    let _ = app.global_shortcut().unregister(ctrl_v);
                }
            }
        })
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
