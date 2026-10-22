//! THE PASTE GUARD — a Ctrl+V meant for another app goes to that app.
//!
//! Switchboard owns Ctrl+V system-wide (RegisterHotKey) while its main window
//! is focused, because Wispr Flow's simulated Ctrl+V never reaches the webview.
//! The grab is released on blur — but only on blur: the hotkey handler never
//! asked whether Switchboard was really in front. A blur Windows did not report
//! (or one tao did not see) left the grab in place with no end, and every
//! dictation into Slack or Ky was typed into a Switchboard terminal instead,
//! while the app in front got nothing (Eric, 2026-10-21: "it somehow always
//! gets inputted into Switchboard").
//!
//! So the handler checks the FOREGROUND WINDOW first. When it belongs to
//! another process, the paste is not ours: the grab is dropped and the Ctrl+V
//! re-sent to the system, where the app in front receives it as if Switchboard
//! had never been there. The next focus of the main window registers the grab
//! again (the focus handler in lib.rs, unchanged).
//!
//! Windows only. Elsewhere the old behaviour stands.
//!
//! The decision and the key sequence are pure and tested; the Win32 reads and
//! SendInput are the thin shell around them.

/// Who should get a Ctrl+V the global hotkey just caught.
#[derive(Debug, PartialEq, Eq)]
pub enum PasteTarget {
    /// Switchboard is in front (or Windows named no foreground window — a
    /// switch in progress; the old behaviour is the safe reading).
    Ours,
    /// Another process owns the foreground window: forward the paste to it.
    Other(u32),
}

/// THE RULE: a paste is ours only when the foreground window is ours. Every
/// Switchboard window (main, PiP, a surface window) is one process, so the
/// floating windows keep their own paste routing.
pub fn paste_target(foreground_pid: Option<u32>, own_pid: u32) -> PasteTarget {
    match foreground_pid {
        None | Some(0) => PasteTarget::Ours,
        Some(pid) if pid == own_pid => PasteTarget::Ours,
        Some(pid) => PasteTarget::Other(pid),
    }
}

/// One synthetic key event: (virtual key, key-up?).
pub type KeyStep = (u16, bool);

const VK_CONTROL: u16 = 0x11;
const VK_V: u16 = 0x56;

/// The keys that re-send a Ctrl+V. When Ctrl is still held (a person's finger,
/// or the dictation tool's own injected Ctrl not yet released) only V is sent
/// — pressing and releasing Ctrl ourselves would release THEIR Ctrl, and their
/// next V would arrive bare. Otherwise the whole chord, Ctrl released last.
pub fn forward_keys(ctrl_held: bool) -> Vec<KeyStep> {
    if ctrl_held {
        vec![(VK_V, false), (VK_V, true)]
    } else {
        vec![
            (VK_CONTROL, false),
            (VK_V, false),
            (VK_V, true),
            (VK_CONTROL, true),
        ]
    }
}

#[cfg(windows)]
pub use win::{foreground_pid, process_name, send_keys, ctrl_held};

#[cfg(windows)]
mod win {
    use super::KeyStep;

    /// The pid that owns the foreground window, None when there is none.
    pub fn foreground_pid() -> Option<u32> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId,
        };
        // SAFETY: plain Win32 reads; the out-pointer is a local.
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 {
                None
            } else {
                Some(pid)
            }
        }
    }

    /// The executable's file name, for the log line only ("Slack.exe").
    /// PROCESS_QUERY_LIMITED_INFORMATION — the weakest right that names it.
    pub fn process_name(pid: u32) -> Option<String> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        // SAFETY: the handle is closed on every path; the buffer outlives the call.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
            CloseHandle(handle);
            if ok == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            Some(path.rsplit('\\').next().unwrap_or(&path).to_string())
        }
    }

    /// Whether Ctrl is down right now (physical or injected).
    pub fn ctrl_held() -> bool {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
        // SAFETY: a plain read. The high bit is "down now".
        unsafe { (GetAsyncKeyState(VK_CONTROL as i32) as u16 & 0x8000) != 0 }
    }

    /// Inject the steps as ONE SendInput call, so nothing interleaves inside
    /// the chord. Returns how many events Windows accepted.
    pub fn send_keys(steps: &[KeyStep]) -> u32 {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
        };
        let inputs: Vec<INPUT> = steps
            .iter()
            .map(|&(vk, up)| INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: vk,
                        wScan: 0,
                        dwFlags: if up { KEYEVENTF_KEYUP } else { 0 },
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            })
            .collect();
        // SAFETY: `inputs` is a live, correctly sized array of INPUT.
        unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_own_window_in_front_is_ours() {
        assert_eq!(paste_target(Some(42), 42), PasteTarget::Ours);
    }

    #[test]
    fn another_process_in_front_gets_the_paste() {
        assert_eq!(paste_target(Some(7), 42), PasteTarget::Other(7));
    }

    #[test]
    fn no_foreground_window_keeps_the_old_behaviour() {
        assert_eq!(paste_target(None, 42), PasteTarget::Ours);
        assert_eq!(paste_target(Some(0), 42), PasteTarget::Ours);
    }

    #[test]
    fn ctrl_still_held_sends_only_v() {
        assert_eq!(forward_keys(true), vec![(VK_V, false), (VK_V, true)]);
    }

    #[test]
    fn ctrl_released_sends_the_whole_chord_ctrl_last() {
        let keys = forward_keys(false);
        assert_eq!(keys.first(), Some(&(VK_CONTROL, false)));
        assert_eq!(keys.last(), Some(&(VK_CONTROL, true)));
        assert_eq!(&keys[1..3], &[(VK_V, false), (VK_V, true)]);
    }

    /// The Win32 shell, read for real (SendInput is not driven here — a test
    /// must not type into whatever is on screen).
    #[cfg(windows)]
    #[test]
    fn win32_reads_name_this_process() {
        let me = std::process::id();
        let name = process_name(me).expect("own process name");
        assert!(name.to_ascii_lowercase().ends_with(".exe"), "{name}");
        // Whatever is in front, the read must not report a pid of 0.
        assert_ne!(foreground_pid(), Some(0));
    }

    #[test]
    fn every_key_pressed_is_released() {
        for held in [true, false] {
            let keys = forward_keys(held);
            for &(vk, up) in &keys {
                if !up {
                    assert!(keys.contains(&(vk, true)), "{vk:#x} never released");
                }
            }
        }
    }
}
