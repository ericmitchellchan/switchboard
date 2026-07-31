mod config;
mod power;
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

    // A freshly created session always starts at spawn generation 1: its id is
    // a brand-new UUID, so no stale reader thread can exist for it — the race
    // that generations guard against only arises on restart, where the id is
    // reused. The frontend registry defaults its expectation to 1 accordingly.
    state.pty_manager.create_session(
        id.clone(),
        name.clone(),
        repo.clone(),
        working_dir.clone(),
        c,
        r,
        1,
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
async fn restart_session(
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
    session_id: String,
    name: String,
    repo: String,
    working_dir: String,
    cols: Option<u16>,
    rows: Option<u16>,
    // Client-generated spawn generation. The frontend bumps its expectation
    // BEFORE invoking this command — the old PTY dies inside this call, so by
    // the time any new-gen event can exist the registry already expects it,
    // and the old reader thread's dying events (previous gen) are dropped.
    gen: u64,
) -> Result<SessionInfo, String> {
    let c = cols.unwrap_or(120);
    let r = rows.unwrap_or(30);
    let cfg = load_config();

    log::info!("Restarting session id={} name={:?} repo={:?} working_dir={:?} cols={} rows={} gen={}", session_id, name, repo, working_dir, c, r, gen);

    state.pty_manager.restart_session(
        session_id.clone(),
        name.clone(),
        repo.clone(),
        working_dir.clone(),
        c,
        r,
        gen,
        Some(cfg.shell),
        app_handle,
    ).map_err(|e| {
        log::error!("Failed to restart session id={}: {}", session_id, e);
        e
    })?;

    Ok(SessionInfo {
        id: session_id,
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

// Thread records disk mirror (T5). Same storage pattern as scrollback: a JSON
// blob under the app's local data dir. The frontend owns the payload shape
// (threadStore.serializeThreadsForDisk); this is a dumb byte store. Written
// atomically-enough via a temp file + rename so a crash mid-write can't leave
// a truncated threads.json (the frontend treats unparseable disk content as
// "no disk copy" and would silently fall back to localStorage).
fn threads_path() -> Result<std::path::PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("Cannot resolve local data dir")?;
    Ok(base.join("switchboard").join("threads.json"))
}

#[tauri::command]
async fn save_threads(data: String) -> Result<(), String> {
    log::debug!("Saving threads ({} bytes)", data.len());
    let path = threads_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data.as_bytes()).map_err(|e| {
        log::error!("Failed to write threads tmp file: {}", e);
        e.to_string()
    })?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        log::error!("Failed to persist threads.json: {}", e);
        e.to_string()
    })
}

#[tauri::command]
async fn load_threads() -> Result<String, String> {
    let path = threads_path()?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => {
            log::error!("Failed to load threads.json: {}", e);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn confirm_app_close(app_handle: tauri::AppHandle) {
    log::info!("App close confirmed by user, exiting");
    app_handle.exit(0);
}

const PIP_WINDOW_LABEL: &str = "pip";

#[tauri::command]
async fn open_pip_window(
    app_handle: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    if app_handle.get_webview_window(PIP_WINDOW_LABEL).is_some() {
        log::debug!("PiP window already open, no-op");
        return Ok(());
    }

    log::info!("Opening PiP window for session id={}", session_id);

    let url = format!("pip.html?session={}", session_id);
    tauri::WebviewWindowBuilder::new(
        &app_handle,
        PIP_WINDOW_LABEL,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("Switchboard — Floating")
    .inner_size(800.0, 500.0)
    .always_on_top(true)
    .decorations(false)
    .skip_taskbar(true)
    .resizable(true)
    .focused(true)
    .build()
    .map_err(|e| {
        log::error!("Failed to open PiP window: {}", e);
        e.to_string()
    })?;

    Ok(())
}

#[tauri::command]
fn close_pip_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window(PIP_WINDOW_LABEL) {
        log::info!("Closing PiP window");
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn is_pip_window_open(app_handle: tauri::AppHandle) -> bool {
    app_handle.get_webview_window(PIP_WINDOW_LABEL).is_some()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = Arc::new(AppState {
        pty_manager: PtyManager::new(),
    });

    // Paste interception modifier is platform-aware: Cmd+V on macOS, Ctrl+V everywhere else.
    // The shortcut name stays `paste_shortcut` so the rest of the code reads naturally.
    #[cfg(target_os = "macos")]
    let paste_shortcut = Shortcut::new(Some(Modifiers::SUPER), Code::KeyV);
    #[cfg(not(target_os = "macos"))]
    let paste_shortcut = Shortcut::new(Some(Modifiers::CONTROL), Code::KeyV);

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .max_file_size(2_000_000) // 2 MB per file
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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

                // Install native power monitor for sleep/wake detection
                power::install_power_monitor(&window, app.handle().clone());
            }

            // Register the paste shortcut globally so it fires at the OS
            // level, catching both real keystrokes and simulated ones from
            // tools like Wispr Flow (which don't reach the webview).
            // Modifier is Cmd on macOS, Ctrl elsewhere (see definition above).
            app.global_shortcut().register(paste_shortcut)?;
            Ok(())
        })
        .on_window_event(move |window, event| {
            match event {
                // Register the global shortcut only while our MAIN window is
                // focused so we don't steal the paste shortcut from other apps.
                // The PiP window's focus events are intentionally ignored here
                // — PiP paste routing is handled separately (see SWIT-36/37).
                tauri::WindowEvent::Focused(focused) => {
                    if window.label() != "main" {
                        return;
                    }
                    let app = window.app_handle();
                    if *focused {
                        log::debug!("Main window focused, registering paste shortcut");
                        let _ = app.global_shortcut().register(paste_shortcut);
                    } else {
                        log::debug!("Main window unfocused, unregistering paste shortcut");
                        let _ = app.global_shortcut().unregister(paste_shortcut);
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
                // Intercept the OS close request on the MAIN window so the
                // frontend can prompt for confirmation. The PiP window closes
                // normally — its label is checked here.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        log::debug!("Main window close requested, deferring to frontend confirmation");
                        api.prevent_close();
                        let _ = window.emit("app-close-requested", ());
                    }
                }
                // PiP window destroyed — fires for OS-level closes (Alt+F4,
                // taskbar close) as well as our in-window X button. Emits the
                // same `pip:closing` event the X button does so main tears
                // down its router and clears pipSessionId, instead of leaving
                // the listener subscribed and forwarding to a dead window.
                tauri::WindowEvent::Destroyed => {
                    if window.label() == PIP_WINDOW_LABEL {
                        log::debug!("PiP window destroyed, notifying main");
                        let _ = window.app_handle().emit("pip:closing", ());
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            restart_session,
            close_session,
            write_to_session,
            resize_session,
            rename_session,
            list_sessions,
            get_config,
            save_scrollback,
            load_scrollback,
            save_threads,
            load_threads,
            clear_scrollback,
            clear_session_scrollback,
            get_home_dir,
            write_file,
            confirm_app_close,
            open_pip_window,
            close_pip_window,
            is_pip_window_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
