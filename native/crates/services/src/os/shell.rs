//! Open links and files, reveal a file in Explorer, and the native file and folder pickers.

use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use windows::core::{w, PCWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
    FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName, ShellExecuteW, FOS_CREATEPROMPT,
    FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// `shell:open-external` only follows web links; anything else (file paths, other schemes) is dropped.
pub fn is_openable_external_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

fn wide(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

fn shell_open(target: &std::ffi::OsStr) -> Result<(), String> {
    let target = wide(target);
    let rc = unsafe { ShellExecuteW(None, w!("open"), PCWSTR(target.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    // ShellExecute reports success with a value above 32.
    if rc.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!("ShellExecute failed with code {}", rc.0 as isize))
    }
}

/// Opens a web link in the default browser. Silently ignores anything that is not http(s).
pub fn open_external(url: &str) -> Result<(), String> {
    if !is_openable_external_url(url) {
        return Ok(());
    }
    shell_open(std::ffi::OsStr::new(url))
}

/// Opens a file or folder with its default app.
pub fn open_path(path: &Path) -> Result<(), String> {
    shell_open(path.as_os_str())
}

/// Opens Explorer with the file selected.
pub fn show_in_folder(path: &Path) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// One entry in a file picker's type list: a label and `*.a;*.b` style patterns.
pub struct FileFilter {
    pub name: &'static str,
    pub extensions: &'static [&'static str],
}

fn pick(title: &str, folder: bool, default_dir: Option<&Path>, filters: &[FileFilter]) -> Option<PathBuf> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let title_w = wide(title);
        dialog.SetTitle(PCWSTR(title_w.as_ptr())).ok()?;
        let mut options = dialog.GetOptions().ok()? | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
        if folder {
            options |= FOS_PICKFOLDERS | FOS_CREATEPROMPT;
        }
        dialog.SetOptions(options).ok()?;

        let names: Vec<Vec<u16>> = filters.iter().map(|f| wide(f.name)).collect();
        let specs: Vec<Vec<u16>> = filters
            .iter()
            .map(|f| wide(f.extensions.iter().map(|e| if *e == "*" { "*.*".to_string() } else { format!("*.{e}") }).collect::<Vec<_>>().join(";")))
            .collect();
        let spec_structs: Vec<COMDLG_FILTERSPEC> = names
            .iter()
            .zip(specs.iter())
            .map(|(n, s)| COMDLG_FILTERSPEC { pszName: PCWSTR(n.as_ptr()), pszSpec: PCWSTR(s.as_ptr()) })
            .collect();
        if !folder && !spec_structs.is_empty() {
            dialog.SetFileTypes(&spec_structs).ok()?;
        }
        if let Some(dir) = default_dir {
            let dir_w = wide(dir);
            if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(dir_w.as_ptr()), None) {
                let _ = dialog.SetFolder(&item);
            }
        }

        dialog.Show(None).ok()?;
        let item = dialog.GetResult().ok()?;
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = PathBuf::from(String::from_utf16_lossy(name.as_wide()));
        CoTaskMemFree(Some(name.0 as *const _));
        Some(path)
    }
}

/// Native "open file" dialog. `None` when the user cancels.
pub fn pick_file(title: &str, filters: &[FileFilter]) -> Option<PathBuf> {
    pick(title, false, None, filters)
}

/// Native folder picker. `None` when the user cancels.
pub fn pick_folder(title: &str, default_dir: &Path) -> Option<PathBuf> {
    pick(title, true, Some(default_dir), &[])
}
