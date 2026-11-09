//! OS integrations: the single-writer guard, global shortcuts, toast notifications, the
//! notification sound, links and file pickers, and the main-window defaults.

pub mod guard;
pub mod hotkeys;
pub mod shell;
pub mod sound;
pub mod toast;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The main window the Electron build creates (`createWindow` in `electron/main/index.ts`).
/// Electron keeps no window state between runs; parity means the same fixed defaults.
pub mod window {
    pub const DEFAULT_WIDTH: f32 = 1200.0;
    pub const DEFAULT_HEIGHT: f32 = 800.0;
    pub const MIN_WIDTH: f32 = 600.0;
    pub const FRAMELESS: bool = true;
}

/// Everything a service call needs from the desktop. Tests use [`RecordingHost`].
pub trait Host: Send + Sync {
    fn notify(&self, title: &str, body: &str);
    fn play_notification_sound(&self);
    fn open_external(&self, url: &str);
    /// Opens a file or folder with its default app; `Err` carries the failure text.
    fn open_path(&self, path: &Path) -> Result<(), String>;
    fn show_in_folder(&self, path: &Path);
    fn pick_file(&self, title: &str) -> Option<PathBuf>;
    fn pick_folder(&self, title: &str, default_dir: &Path) -> Option<PathBuf>;
    /// Asks the app to restart itself once the current reply has been delivered.
    fn request_relaunch(&self);
}

/// The Windows implementation. A relaunch request is recorded for the app loop to act on:
/// the app polls [`WindowsHost::take_relaunch_request`], starts a new process and exits.
#[derive(Default)]
pub struct WindowsHost {
    relaunch: std::sync::atomic::AtomicBool,
}

impl WindowsHost {
    /// True once, after a service asked for a relaunch.
    pub fn take_relaunch_request(&self) -> bool {
        self.relaunch.swap(false, std::sync::atomic::Ordering::SeqCst)
    }
}

impl Host for WindowsHost {
    fn notify(&self, title: &str, body: &str) {
        if let Err(e) = toast::show_toast(title, body) {
            eprintln!("[notification] could not show toast: {e}");
        }
    }

    fn play_notification_sound(&self) {
        sound::play_chime();
    }

    fn open_external(&self, url: &str) {
        if let Err(e) = shell::open_external(url) {
            eprintln!("[shell] could not open link: {e}");
        }
    }

    fn open_path(&self, path: &Path) -> Result<(), String> {
        shell::open_path(path)
    }

    fn show_in_folder(&self, path: &Path) {
        if let Err(e) = shell::show_in_folder(path) {
            eprintln!("[shell] could not reveal file: {e}");
        }
    }

    fn pick_file(&self, title: &str) -> Option<PathBuf> {
        const FILTERS: [shell::FileFilter; 3] = [
            shell::FileFilter { name: "Images", extensions: &["png", "jpg", "jpeg", "gif", "webp", "avif"] },
            shell::FileFilter {
                name: "Documents",
                extensions: &["pdf", "txt", "md", "csv", "doc", "docx", "xls", "xlsx", "ppt", "pptx"],
            },
            shell::FileFilter { name: "All Files", extensions: &["*"] },
        ];
        shell::pick_file(title, &FILTERS)
    }

    fn pick_folder(&self, title: &str, default_dir: &Path) -> Option<PathBuf> {
        shell::pick_folder(title, default_dir)
    }

    fn request_relaunch(&self) {
        self.relaunch.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// One call a [`RecordingHost`] saw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostCall {
    Notify(String, String),
    Sound,
    OpenExternal(String),
    OpenPath(PathBuf),
    ShowInFolder(PathBuf),
    Relaunch,
}

/// A host that touches nothing: it records calls and answers pickers from a script.
#[derive(Default)]
pub struct RecordingHost {
    pub calls: Mutex<Vec<HostCall>>,
    pub file_to_pick: Mutex<Option<PathBuf>>,
    pub folder_to_pick: Mutex<Option<PathBuf>>,
}

impl RecordingHost {
    pub fn calls(&self) -> Vec<HostCall> {
        self.calls.lock().unwrap().clone()
    }

    fn record(&self, call: HostCall) {
        self.calls.lock().unwrap().push(call);
    }
}

impl Host for RecordingHost {
    fn notify(&self, title: &str, body: &str) {
        self.record(HostCall::Notify(title.into(), body.into()));
    }
    fn play_notification_sound(&self) {
        self.record(HostCall::Sound);
    }
    fn open_external(&self, url: &str) {
        self.record(HostCall::OpenExternal(url.into()));
    }
    fn open_path(&self, path: &Path) -> Result<(), String> {
        self.record(HostCall::OpenPath(path.to_path_buf()));
        Ok(())
    }
    fn show_in_folder(&self, path: &Path) {
        self.record(HostCall::ShowInFolder(path.to_path_buf()));
    }
    fn pick_file(&self, _title: &str) -> Option<PathBuf> {
        self.file_to_pick.lock().unwrap().take()
    }
    fn pick_folder(&self, _title: &str, _default_dir: &Path) -> Option<PathBuf> {
        self.folder_to_pick.lock().unwrap().take()
    }
    fn request_relaunch(&self) {
        self.record(HostCall::Relaunch);
    }
}
