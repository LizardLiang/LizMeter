//! Global shortcuts through `RegisterHotKey`, the native side of Electron's `globalShortcut`.
//!
//! One thread owns every registration (a hotkey belongs to the thread that registered it) and
//! pumps `WM_HOTKEY`. A shortcut another app already holds fails to register; that is reported
//! per binding and is never fatal, as in `ipc-handlers.ts`.

use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
    VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK, VK_MEDIA_STOP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetMessageW, PeekMessageW, PostThreadMessageW, MSG, PM_NOREMOVE, WM_HOTKEY, WM_QUIT,
};

/// The shortcuts the Electron build registers: media keys relayed to the player.
pub const MEDIA_KEY_BINDINGS: [(&str, &str); 3] =
    [("MediaPlayPause", "MediaPlayPause"), ("MediaNextTrack", "MediaNextTrack"), ("MediaPreviousTrack", "MediaPreviousTrack")];

/// Modifier flags plus a virtual-key code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Accelerator {
    pub modifiers: u32,
    pub vk: u32,
}

/// Parses an Electron accelerator string such as `MediaPlayPause` or `Ctrl+Alt+F23`.
pub fn parse_accelerator(accel: &str) -> Option<Accelerator> {
    let mut modifiers = 0u32;
    let mut vk: Option<u32> = None;
    for part in accel.split('+').map(str::trim) {
        if part.is_empty() {
            return None;
        }
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "commandorcontrol" | "cmdorctrl" => modifiers |= MOD_CONTROL.0,
            "alt" | "option" => modifiers |= MOD_ALT.0,
            "shift" => modifiers |= MOD_SHIFT.0,
            "super" | "meta" | "win" => modifiers |= MOD_WIN.0,
            key => {
                if vk.is_some() {
                    return None;
                }
                vk = Some(key_code(key)?);
            }
        }
    }
    vk.map(|vk| Accelerator { modifiers, vk })
}

fn key_code(key: &str) -> Option<u32> {
    match key {
        "mediaplaypause" => return Some(VK_MEDIA_PLAY_PAUSE.0 as u32),
        "medianexttrack" => return Some(VK_MEDIA_NEXT_TRACK.0 as u32),
        "mediaprevioustrack" => return Some(VK_MEDIA_PREV_TRACK.0 as u32),
        "mediastop" => return Some(VK_MEDIA_STOP.0 as u32),
        "space" => return Some(0x20),
        _ => {}
    }
    let b = key.as_bytes();
    if b.len() == 1 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) {
        return Some(b[0].to_ascii_uppercase() as u32);
    }
    if let Some(n) = key.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
        if (1..=24).contains(&n) {
            return Some(0x6F + n);
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub accelerator: String,
    /// Passed back to the callback when the shortcut fires.
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registration {
    pub accelerator: String,
    /// `Err` carries why: an unparsable accelerator, or a shortcut another app already holds.
    pub result: Result<(), String>,
}

pub struct HotkeyManager {
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}

impl HotkeyManager {
    /// Registers every binding and starts pumping. Returns the manager and one outcome per binding.
    pub fn start(
        bindings: Vec<Binding>,
        on_hotkey: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Result<(Self, Vec<Registration>), String> {
        let (tx, rx) = mpsc::channel::<(u32, Vec<Registration>)>();
        let thread = std::thread::Builder::new()
            .name("lizmeter-hotkeys".into())
            .spawn(move || {
                // Force this thread's message queue to exist before anyone posts to it.
                let mut msg = MSG::default();
                unsafe {
                    let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
                }
                let mut registered: Vec<(i32, String)> = vec![];
                let mut results = vec![];
                for (i, b) in bindings.iter().enumerate() {
                    let id = i as i32 + 1;
                    let outcome = match parse_accelerator(&b.accelerator) {
                        None => Err(format!("Unrecognised accelerator: {}", b.accelerator)),
                        Some(a) => unsafe {
                            RegisterHotKey(None, id, HOT_KEY_MODIFIERS(a.modifiers) | MOD_NOREPEAT, a.vk)
                        }
                        .map_err(|e| format!("Could not register {}: {e}", b.accelerator)),
                    };
                    if outcome.is_ok() {
                        registered.push((id, b.action.clone()));
                    }
                    results.push(Registration { accelerator: b.accelerator.clone(), result: outcome });
                }
                let _ = tx.send((unsafe { GetCurrentThreadId() }, results));
                loop {
                    let r = unsafe { GetMessageW(&mut msg, None, 0, 0) };
                    if r.0 <= 0 {
                        break;
                    }
                    if msg.message == WM_HOTKEY {
                        let id = msg.wParam.0 as i32;
                        if let Some((_, action)) = registered.iter().find(|(rid, _)| *rid == id) {
                            on_hotkey(action);
                        }
                    }
                }
                for (id, _) in &registered {
                    unsafe {
                        let _ = UnregisterHotKey(None, *id);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let (thread_id, results) = rx.recv().map_err(|_| "hotkey thread failed to start".to_string())?;
        Ok((HotkeyManager { thread_id, thread: Some(thread) }, results))
    }

    /// Delivers the message Windows posts when binding number `index` (0-based) is pressed, so a
    /// test can exercise the callback path without synthesising keyboard input.
    #[doc(hidden)]
    pub fn simulate_press_for_testing(&self, index: usize) {
        unsafe {
            let _ = PostThreadMessageW(
                self.thread_id,
                WM_HOTKEY,
                windows::Win32::Foundation::WPARAM(index + 1),
                Default::default(),
            );
        }
    }

    /// Unregisters every shortcut and joins the thread.
    pub fn stop(&mut self) {
        if let Some(thread) = self.thread.take() {
            unsafe {
                let _ = PostThreadMessageW(self.thread_id, WM_QUIT, Default::default(), Default::default());
            }
            let _ = thread.join();
        }
    }
}

impl Drop for HotkeyManager {
    fn drop(&mut self) {
        self.stop();
    }
}
