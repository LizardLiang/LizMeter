//! Static checks on `native/Packager.toml`. The installer itself is never run against a real
//! profile: these tests hold the rules that keep the user's data safe.

const CONFIG: &str = include_str!("../../../Packager.toml");

fn hook() -> &'static str {
    let start = CONFIG.find("preinstall-section = '''").expect("preinstall section") + "preinstall-section = '''".len();
    let end = CONFIG[start..].find("'''").expect("section end") + start;
    &CONFIG[start..end]
}

/// The NSIS commands only, without the TOML comments above the section.
fn hook_lines() -> Vec<&'static str> {
    hook().lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with(';')).collect()
}

#[test]
fn installs_per_user_as_lizmeter() {
    assert!(CONFIG.contains("product-name = \"LizMeter\""));
    assert!(CONFIG.contains("installer-mode = \"currentUser\""));
    assert!(CONFIG.contains("formats = [\"nsis\"]"));
    assert!(CONFIG.contains("main = true"));
}

#[test]
fn the_uninstaller_never_offers_to_delete_app_data() {
    // `appdata-paths` makes the uninstaller offer to remove those folders.
    assert!(!CONFIG.contains("appdata-paths"));
}

#[test]
fn removes_the_electron_build_through_its_own_quiet_uninstaller() {
    let h = hook();
    // electron-builder's per-user key for appId com.lizmeter.app (uuid v5 of the appId).
    assert!(h.contains(r#"HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\d7c9c3d8-3982-5ac5-a5ff-124a887808d8""#));
    assert!(h.contains("\"QuietUninstallString\""));
    // `_?=` keeps the uninstaller in place, so ExecWait waits for the real uninstall and its exit code.
    assert!(h.contains(r#"ExecWait '"$ElectronDir\Uninstall LizMeter.exe" /currentuser /S _?=$ElectronDir'"#));
    // A missing Electron install (empty value) skips the removal; a failed removal stops the install.
    assert!(h.contains("StrCmp $ElectronUninstall \"\" electron_done"));
    assert!(h.contains("Abort"));
}

#[test]
fn the_hook_never_touches_the_data_folder() {
    let lines = hook_lines().join("\n").to_lowercase();
    for forbidden in ["$appdata", "%appdata%", "lizmeter-soak", "copyfiles", "rename", "fileopen", "deleteregkey"] {
        assert!(!lines.contains(forbidden), "hook mentions {forbidden}");
    }
    // Delete and RMDir touch only the Electron install folder.
    for l in hook_lines() {
        let l = l.to_lowercase();
        if l.starts_with("delete") || l.starts_with("rmdir") {
            assert!(l.contains("$electrondir"), "{l}");
        }
    }
    // Registry access is reads only.
    assert!(!lines.contains("writeregstr"));
}
