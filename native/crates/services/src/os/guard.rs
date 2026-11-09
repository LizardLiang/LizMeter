//! Single-writer guard: exactly one process writes a data folder at a time.
//!
//! Two native instances are refused by a named mutex plus an exclusively opened lock file in the
//! data folder. A running Electron LizMeter is detected read-only, by looking for its process
//! (name and `resources\app.asar` next to the executable) without opening, signalling or locking
//! anything of it. The refusal names the holder.
//!
//! The Electron build asks Chromium for no process lock (`requestSingleInstanceLock` is never
//! called in `electron/main/index.ts`), so a second Electron instance is not stopped by the
//! Electron build itself. The native guard is the first one on this machine.

use lizmeter_db::data_location::resolve_path;
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    CreateMutexW, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};

pub const LOCK_FILE_NAME: &str = "lizmeter.lock";
const INFO_FILE_NAME: &str = "lizmeter.lock.json";

/// How to recognise an Electron LizMeter process.
#[derive(Debug, Clone)]
pub struct ElectronMatcher {
    /// Executable file name, compared without regard to case.
    pub exe_name: String,
    /// A path relative to the executable's folder that only the Electron build has.
    pub marker: PathBuf,
}

impl Default for ElectronMatcher {
    fn default() -> Self {
        ElectronMatcher { exe_name: "LizMeter.exe".into(), marker: PathBuf::from("resources").join("app.asar") }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Holder {
    Native { pid: Option<u32>, exe: Option<String> },
    Electron { pid: u32, exe: PathBuf },
}

#[derive(Debug)]
pub enum GuardError {
    Held { data_dir: PathBuf, holder: Holder },
    Io(std::io::Error),
}

impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GuardError::Held { data_dir, holder: Holder::Native { pid, exe } } => {
                let who = match (pid, exe) {
                    (Some(pid), Some(exe)) => format!("process {pid} ({exe})"),
                    (Some(pid), None) => format!("process {pid}"),
                    _ => "another process".to_string(),
                };
                write!(
                    f,
                    "LizMeter is already running on {}, held by {who}. Close it before starting another copy.",
                    data_dir.display()
                )
            }
            GuardError::Held { data_dir, holder: Holder::Electron { pid, exe } } => write!(
                f,
                "The Electron LizMeter is running (process {pid}, {}) and uses the data in {}. Quit it before \
                 starting the native app on the same data.",
                exe.display(),
                data_dir.display()
            ),
            GuardError::Io(e) => write!(f, "Could not take the data folder lock: {e}"),
        }
    }
}

impl std::error::Error for GuardError {}

impl From<std::io::Error> for GuardError {
    fn from(e: std::io::Error) -> Self {
        GuardError::Io(e)
    }
}

/// Held for the life of the process. Dropping it releases the mutex and the lock file.
pub struct SingleWriterGuard {
    mutex: HANDLE,
    _lock: Option<File>,
    info_path: Option<PathBuf>,
}

// The mutex handle is only closed on drop.
unsafe impl Send for SingleWriterGuard {}

impl Drop for SingleWriterGuard {
    fn drop(&mut self) {
        if let Some(info) = &self.info_path {
            let _ = std::fs::remove_file(info);
        }
        unsafe {
            let _ = CloseHandle(self.mutex);
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// The mutex name for a data folder: stable across path spelling, so `C:\x` and `c:\x\.` agree.
pub fn mutex_name_for(data_dir: &Path) -> String {
    let canonical = resolve_path(data_dir).to_string_lossy().to_lowercase();
    let digest = Sha256::digest(canonical.as_bytes());
    let short: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("Local\\LizMeter-DataDir-{short}")
}

fn read_holder_info(info_path: &Path) -> Holder {
    let parsed: Option<serde_json::Value> =
        std::fs::read_to_string(info_path).ok().and_then(|raw| serde_json::from_str(&raw).ok());
    Holder::Native {
        pid: parsed.as_ref().and_then(|v| v.get("pid")?.as_u64()).map(|p| p as u32),
        exe: parsed.as_ref().and_then(|v| v.get("exe")?.as_str()).map(str::to_string),
    }
}

/// Finds a running Electron LizMeter, read-only: a process snapshot plus a path query.
pub fn find_electron_process(matcher: &ElectronMatcher) -> Option<(u32, PathBuf)> {
    let own = std::process::id();
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
    let mut found = None;
    let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while ok {
        let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
        if entry.th32ProcessID != own && name.eq_ignore_ascii_case(&matcher.exe_name) {
            if let Some(exe) = process_image_path(entry.th32ProcessID) {
                let marked = exe.parent().is_some_and(|dir| dir.join(&matcher.marker).exists());
                if marked {
                    found = Some((entry.th32ProcessID, exe));
                    break;
                }
            }
        }
        ok = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    found
}

fn process_image_path(pid: u32) -> Option<PathBuf> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 32768];
        let mut len = buf.len() as u32;
        let res = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        res.ok()?;
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
}

impl SingleWriterGuard {
    /// Takes the guard for `data_dir`. `electron` is `Some` only when a running Electron build
    /// would write this same folder; a soak copy or a test folder passes `None`.
    pub fn acquire(data_dir: &Path, electron: Option<&ElectronMatcher>) -> Result<Self, GuardError> {
        Self::acquire_inner(data_dir, electron, true)
    }

    /// The named mutex only, with no file written into the folder. For a folder a cloud client
    /// syncs: a lock file there would be read as a stray file and uploaded to the peer.
    pub fn acquire_mutex_only(data_dir: &Path) -> Result<Self, GuardError> {
        Self::acquire_inner(data_dir, None, false)
    }

    fn acquire_inner(data_dir: &Path, electron: Option<&ElectronMatcher>, files: bool) -> Result<Self, GuardError> {
        if files {
            std::fs::create_dir_all(data_dir)?;
        }
        let info_path = data_dir.join(INFO_FILE_NAME);
        let name = wide(&mutex_name_for(data_dir));
        let mutex = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
            .map_err(|e| GuardError::Io(std::io::Error::other(e.to_string())))?;
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            unsafe {
                let _ = CloseHandle(mutex);
            }
            return Err(GuardError::Held { data_dir: data_dir.to_path_buf(), holder: read_holder_info(&info_path) });
        }

        if !files {
            return Ok(SingleWriterGuard { mutex, _lock: None, info_path: None });
        }

        // Share mode 0: nobody else can open the file while we hold it, and the OS drops the lock
        // on a crash, so a stale lock never blocks a restart.
        let lock = match OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .share_mode(0)
            .open(data_dir.join(LOCK_FILE_NAME))
        {
            Ok(f) => f,
            Err(e) => {
                unsafe {
                    let _ = CloseHandle(mutex);
                }
                return Err(if e.raw_os_error() == Some(32) {
                    GuardError::Held { data_dir: data_dir.to_path_buf(), holder: read_holder_info(&info_path) }
                } else {
                    GuardError::Io(e)
                });
            }
        };

        if let Some(matcher) = electron {
            if let Some((pid, exe)) = find_electron_process(matcher) {
                unsafe {
                    let _ = CloseHandle(mutex);
                }
                return Err(GuardError::Held {
                    data_dir: data_dir.to_path_buf(),
                    holder: Holder::Electron { pid, exe },
                });
            }
        }

        let exe = std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned());
        let info = serde_json::json!({ "pid": std::process::id(), "exe": exe });
        if let Ok(mut f) = File::create(&info_path) {
            let _ = f.write_all(info.to_string().as_bytes());
        }
        Ok(SingleWriterGuard { mutex, _lock: Some(lock), info_path: Some(info_path) })
    }
}
