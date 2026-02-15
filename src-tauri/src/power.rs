#[cfg(windows)]
use tauri::{AppHandle, Emitter};

/// Install a Win32 window subclass that intercepts WM_POWERBROADCAST messages
/// and emits Tauri events for sleep/wake transitions.
#[cfg(windows)]
pub fn install_power_monitor(
    window: &tauri::WebviewWindow,
    app_handle: AppHandle,
) {
    use windows_sys::Win32::UI::Shell::SetWindowSubclass;

    let hwnd = window.hwnd().expect("Failed to get HWND");
    let handle_ptr = Box::into_raw(Box::new(app_handle)) as usize;

    unsafe {
        SetWindowSubclass(
            hwnd.0 as _,
            Some(power_subclass_proc),
            1, // subclass ID
            handle_ptr,
        );
    }

    log::info!("Power monitor installed on HWND");
}

#[cfg(windows)]
unsafe extern "system" fn power_subclass_proc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    _uid_subclass: usize,
    dw_ref_data: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::Shell::DefSubclassProc;
    use windows_sys::Win32::UI::WindowsAndMessaging::WM_POWERBROADCAST;

    const PBT_APMSUSPEND: usize = 0x0004;
    const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;

    if msg == WM_POWERBROADCAST {
        let app_handle = &*(dw_ref_data as *const AppHandle);

        match wparam {
            PBT_APMSUSPEND => {
                log::info!("Power suspend detected (native WM_POWERBROADCAST)");
                let _ = app_handle.emit("power:suspend", ());
            }
            PBT_APMRESUMEAUTOMATIC => {
                log::info!("Power resume detected (native WM_POWERBROADCAST)");
                let _ = app_handle.emit("power:resume", ());
            }
            _ => {}
        }
    }

    DefSubclassProc(hwnd, msg, wparam, lparam)
}

#[cfg(not(windows))]
pub fn install_power_monitor(
    _window: &tauri::WebviewWindow,
    _app_handle: tauri::AppHandle,
) {
    // No-op on non-Windows platforms
}
