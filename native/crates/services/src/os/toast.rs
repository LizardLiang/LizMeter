//! Windows toast notifications, the native side of Electron's `Notification`.
//!
//! An unpackaged app needs an AppUserModelID with a display name registered under
//! `HKCU\Software\Classes\AppUserModelId`; the key is created on first use. The installer
//! (phase 12) owns the final id and the Start-menu shortcut.

use windows::core::{HSTRING, PCWSTR};
use windows::Data::Xml::Dom::XmlDocument;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE,
    REG_SZ,
};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

pub const APP_USER_MODEL_ID: &str = "com.lizmeter.native";
pub const APP_DISPLAY_NAME: &str = "LizMeter";

fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// The toast payload: a title line and a body line.
pub fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape_xml(title),
        escape_xml(body)
    )
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Creates `HKCU\Software\Classes\AppUserModelId\<id>` with a `DisplayName`, if it is not there.
fn register_app_id() -> Result<(), String> {
    let path = wide(&format!("Software\\Classes\\AppUserModelId\\{APP_USER_MODEL_ID}"));
    let mut key = HKEY::default();
    let rc = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(path.as_ptr()),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut key,
            None,
        )
    };
    if rc.is_err() {
        return Err(format!("could not open the AppUserModelId registry key: {rc:?}"));
    }
    let name = wide("DisplayName");
    let value: Vec<u8> = wide(APP_DISPLAY_NAME).iter().flat_map(|u| u.to_le_bytes()).collect();
    let rc = unsafe { RegSetValueExW(key, PCWSTR(name.as_ptr()), None, REG_SZ, Some(&value)) };
    unsafe {
        let _ = RegCloseKey(key);
    }
    if rc.is_err() {
        return Err(format!("could not write the AppUserModelId display name: {rc:?}"));
    }
    Ok(())
}

/// Shows a toast. Errors are returned for the caller to log; a missed toast is never fatal.
pub fn show_toast(title: &str, body: &str) -> Result<(), String> {
    unsafe {
        // Already initialised on this thread is fine (S_FALSE / RPC_E_CHANGED_MODE).
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
    register_app_id()?;
    let doc = XmlDocument::new().map_err(|e| e.to_string())?;
    doc.LoadXml(&HSTRING::from(toast_xml(title, body))).map_err(|e| e.to_string())?;
    let toast = ToastNotification::CreateToastNotification(&doc).map_err(|e| e.to_string())?;
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_USER_MODEL_ID))
        .map_err(|e| e.to_string())?;
    notifier.Show(&toast).map_err(|e| e.to_string())
}
