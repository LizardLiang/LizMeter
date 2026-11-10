//! Soak mode on the command line.
//!
//! * `--soak-setup [--soak-sync <dir>]` copies `%APPDATA%\lizmeter` to `%APPDATA%\lizmeter-soak` and
//!   points the copy's sync at a test folder (default `%APPDATA%\lizmeter-soak-sync`), then exits.
//! * `--soak-check [--check-dir <profile>]` prints the clean-run summary of the soak profile, exits 0 when clean, 3 when not.
//! * `--soak` runs the app on the soak profile, on its own pipe, and refuses a OneDrive sync folder.

use lizmeter_db::data_location::DataLocation;
use lizmeter_services::soak;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub struct SoakArgs {
    pub run: bool,
    pub setup: bool,
    pub check: bool,
    /// Profile folder `--soak-check` reads instead of the soak profile (read-only).
    pub check_dir: Option<PathBuf>,
    pub sync: Option<PathBuf>,
}

/// A release build has no console of its own. When a terminal started it, write to that terminal.
#[cfg(target_os = "windows")]
pub fn attach_parent_console() {
    use std::os::windows::io::IntoRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{
        AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };
    let missing = |which| unsafe { GetStdHandle(which).map(|h| h.is_invalid() || h.0.is_null()).unwrap_or(true) };
    if !(missing(STD_OUTPUT_HANDLE) || missing(STD_ERROR_HANDLE)) {
        return;
    }
    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS).is_err() {
            return;
        }
        for which in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            if missing(which) {
                if let Ok(f) = std::fs::OpenOptions::new().write(true).open("CONOUT$") {
                    let _ = SetStdHandle(which, HANDLE(f.into_raw_handle()));
                }
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn attach_parent_console() {}

fn appdata() -> Result<PathBuf, String> {
    std::env::var_os("APPDATA").map(PathBuf::from).ok_or_else(|| "APPDATA is not set.".to_string())
}

/// Runs `--soak-setup` or `--soak-check`. Returns the exit code, or `None` for any other launch.
pub fn run_headless(args: &SoakArgs) -> Option<i32> {
    if !(args.setup || args.check) {
        return None;
    }
    let outcome = appdata().and_then(|base| {
        let paths = soak::paths_under(&base);
        if args.setup {
            setup(&paths, args.sync.as_deref())
        } else {
            check(&paths, args.check_dir.as_deref())
        }
    });
    Some(match outcome {
        Ok(code) => code,
        Err(message) => {
            eprintln!("{message}");
            1
        }
    })
}

fn setup(paths: &soak::SoakPaths, sync: Option<&Path>) -> Result<i32, String> {
    let sync = sync.map(Path::to_path_buf).unwrap_or_else(|| paths.sync.clone());
    let report = soak::setup(&paths.source, &paths.soak, &sync, &soak::onedrive_roots_from_env()).map_err(|e| e.to_string())?;
    println!("Soak profile ready: {}", report.soak.display());
    println!("Test sync folder:   {}", report.sync.display());
    println!("Copied: {}", report.copied.join(", "));
    println!("Attachments copied: {}", report.attachments_copied);
    if let Some((count, digest)) = &report.baseline {
        println!("Baseline: {count} todos, ids digest {digest}");
    }
    println!("Start it with: lizmeter.exe --soak");
    Ok(0)
}

fn check(paths: &soak::SoakPaths, dir: Option<&Path>) -> Result<i32, String> {
    let report = soak::check(dir.unwrap_or(&paths.soak)).map_err(|e| e.to_string())?;
    print!("{}", report.render());
    Ok(if report.is_clean() { 0 } else { 3 })
}

/// Picks the soak profile folder for `--soak`, refuses a OneDrive sync folder, and gives the app
/// its own pipe unless the caller set one.
pub fn prepare_run() -> Result<PathBuf, String> {
    let dir = soak::paths_under(&appdata()?).soak;
    if !dir.join("data-location.json").exists() && !dir.join("lizmeter.db").exists() {
        return Err(format!("No soak profile at {}. Run lizmeter.exe --soak-setup first.", dir.display()));
    }
    let data_dir = DataLocation::new(&dir).get_data_dir();
    soak::check_soak_data_dir(&data_dir, &soak::onedrive_roots_from_env()).map_err(|e| e.to_string())?;
    soak::check_soak_data_dir(&dir, &soak::onedrive_roots_from_env()).map_err(|e| e.to_string())?;
    if std::env::var_os("LIZMETER_PIPE_PATH").is_none_or(|v| v.is_empty()) {
        // Single-threaded here: the app has started no thread yet.
        std::env::set_var("LIZMETER_PIPE_PATH", soak::SOAK_PIPE_PATH);
    }
    Ok(dir)
}
