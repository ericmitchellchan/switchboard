mod config;
mod pty;

use config::{load_config, Config};
use pty::{PtyManager, SessionInfo};
use std::sync::Arc;
use tauri::{image::Image, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use log;
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

    log::info!("Creating session id={} name={:?} repo={:?} working_dir={:?} cols={} rows={}", id, name, repo, working_dir, c, r);

    state.pty_manager.create_session(
        id.clone(),
        name.clone(),
        repo.clone(),
        working_dir.clone(),
        c,
        r,
        Some(cfg.shell),
        app_handle,
    ).map_err(|e| {
        log::error!("Failed to create session id={}: {}", id, e);
        e
    })?;

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
    log::info!("Closing session id={}", session_id);
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
    log::debug!("Resizing session id={} cols={} rows={}", session_id, cols, rows);
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
    log::debug!("Loading config");
    Ok(load_config())
}

#[tauri::command]
async fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "Cannot resolve home directory".to_string())
}

fn scrollback_dir() -> Result<std::path::PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Cannot resolve local data dir")?;
    Ok(base.join("switchboard").join("scrollback"))
}

#[tauri::command]
async fn save_scrollback(session_id: String, data: String) -> Result<(), String> {
    log::debug!("Saving scrollback for session id={}", session_id);
    let dir = scrollback_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.txt", session_id));
    std::fs::write(&path, data.as_bytes()).map_err(|e| {
        log::error!("Failed to save scrollback for session id={}: {}", session_id, e);
        e.to_string()
    })
}

#[tauri::command]
async fn load_scrollback(session_id: String) -> Result<String, String> {
    log::debug!("Loading scrollback for session id={}", session_id);
    let dir = scrollback_dir()?;
    let path = dir.join(format!("{}.txt", session_id));
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => {
            log::error!("Failed to load scrollback for session id={}: {}", session_id, e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
async fn clear_scrollback() -> Result<(), String> {
    let dir = scrollback_dir()?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn clear_session_scrollback(session_id: String) -> Result<(), String> {
    let dir = scrollback_dir()?;
    let path = dir.join(format!("{}.txt", session_id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState {
        pty_manager: PtyManager::new(),
    });

    let ctrl_v = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyV);

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Ok(text) = app.clipboard().read_text() {
                            if !text.is_empty() {
                                log::debug!("Clipboard paste triggered, content length={}", text.len());
                                let _ = app.emit("clipboard-paste", text);
                            }
                        }
                    }
                })
                .build(),
        )
        .manage(app_state)
        .setup(move |app| {
            // Set window icon from bundled PNG
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/icon.png")) {
                    let _ = window.set_icon(icon);
                }
            }

            // Register Ctrl+V as a global shortcut so it fires at the OS
            // level, catching both real keystrokes and simulated ones from
            // tools like Wispr Flow (which don't reach the webview).
            app.global_shortcut().register(ctrl_v)?;
            Ok(())
        })
        .on_window_event(move |window, event| {
            match event {
                // Register the global shortcut only while our window is focused
                // so we don't steal Ctrl+V from other applications.
                tauri::WindowEvent::Focused(focused) => {
                    let app = window.app_handle();
                    if *focused {
                        log::debug!("Window focused, registering Ctrl+V shortcut");
                        let _ = app.global_shortcut().register(ctrl_v);
                    } else {
                        log::debug!("Window unfocused, unregistering Ctrl+V shortcut");
                        let _ = app.global_shortcut().unregister(ctrl_v);
                    }
                }
                // Emit file paths when files are dropped onto the window
                tauri::WindowEvent::DragDrop(drag_event) => {
                    if let tauri::DragDropEvent::Drop { paths, .. } = drag_event {
                        let path_strings: Vec<String> = paths
                            .iter()
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect();
                        if !path_strings.is_empty() {
                            let _ = window.emit("file-drop", path_strings);
                        }
                    }
                }
                _ => {}
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
            save_scrollback,
            load_scrollback,
            clear_scrollback,
            clear_session_scrollback,
            get_home_dir,
            write_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
