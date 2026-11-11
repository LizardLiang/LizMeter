//! Static checks on `native/Packager.toml`. The installer itself is never run against a real
//! profile: these tests hold the rules that keep the user's data safe.

const CONFIG: &str = include_str!("../../../Packager.toml");

/// The release shape of the installer config before the review fix, kept to prove the rules below fail on it.
const BEFORE_FIX: &str = include_str!("fixtures/packager_before_fix.toml");

fn hook_of(config: &str) -> &str {
    let start = config.find("preinstall-section = '''").expect("preinstall section") + "preinstall-section = '''".len();
    let end = config[start..].find("'''").expect("section end") + start;
    &config[start..end]
}

fn hook() -> &'static str {
    hook_of(CONFIG)
}

/// The NSIS commands only, without the TOML comments above the section.
fn lines_of(config: &str) -> Vec<&str> {
    hook_of(config).lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with(';')).collect()
}

fn hook_lines() -> Vec<&'static str> {
    lines_of(CONFIG)
}

/// Rules that keep a running Electron and a failed uninstall from passing as success.
fn electron_guard_violations(config: &str) -> Vec<&'static str> {
    let lines = lines_of(config);
    let text = lines.join("
");
    let pos = |needle: &str| text.find(needle);
    let mut v = Vec::new();
    let probe = pos("FileOpen $ElectronProbe \"$ElectronDir\\LizMeter.exe\" a");
    let exec = pos("ExecWait");
    if probe.is_none() || exec.is_none() || probe > exec {
        v.push("a running Electron must be probed (write-open of its exe) before the uninstaller starts");
    }
    if !text.contains("The previous LizMeter is running") {
        v.push("a running Electron must abort with a clear message");
    }
    if !text.contains("IfFileExists \"$ElectronDir\\LizMeter.exe\" 0 electron_not_running") {
        v.push("the probe must skip a missing exe, FileOpen would create it");
    }
    if !text.contains("IfFileExists \"$ElectronDir\\Uninstall LizMeter.exe\"") {
        v.push("the uninstaller must exist before ExecWait");
    }
    let after_exec = exec.map(|e| &text[e..]).unwrap_or("");
    if !after_exec.contains("IfErrors electron_failed") {
        v.push("a failed launch must abort");
    }
    if !after_exec.contains("StrCmp $ElectronExit \"\" electron_failed") {
        v.push("an empty exit code must abort");
    }
    if !after_exec.contains("IfFileExists \"$ElectronDir\\LizMeter.exe\" electron_failed") {
        v.push("success needs the Electron exe gone");
    }
    if !after_exec.contains("StrCmp $ElectronUninstall \"\" electron_removed") {
        v.push("success needs the uninstall key gone");
    }
    let lower = text.to_lowercase();
    for kill in ["taskkill", "stop-process", "/im ", "killproc", "nsprocess"] {
        if lower.contains(kill) {
            v.push("the hook must never kill a process");
        }
    }
    v
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
fn a_running_electron_stops_the_installer_and_a_failed_uninstall_never_passes() {
    let v = electron_guard_violations(CONFIG);
    assert!(v.is_empty(), "{v:?}");
}

#[test]
fn the_rules_fail_on_the_config_before_the_fix() {
    let v = electron_guard_violations(BEFORE_FIX);
    assert!(v.len() >= 5, "{v:?}");
}

#[test]
fn the_hook_never_touches_the_data_folder() {
    let lines = hook_lines().join("\n").to_lowercase();
    for forbidden in ["$appdata", "%appdata%", "lizmeter-soak", "copyfiles", "rename", "deleteregkey"] {
        assert!(!lines.contains(forbidden), "hook mentions {forbidden}");
    }
    // Delete and RMDir touch only the Electron install folder.
    for l in hook_lines() {
        let l = l.to_lowercase();
        if l.starts_with("delete") || l.starts_with("rmdir") {
            assert!(l.contains("$electrondir"), "{l}");
        }
    }
    // The only file the hook opens is the Electron exe, to probe whether it runs.
    for l in hook_lines() {
        if l.to_lowercase().starts_with("fileopen") {
            assert!(l.contains("\"$ElectronDir\\LizMeter.exe\""), "{l}");
        }
    }
    // Registry access is reads only.
    assert!(!lines.contains("writeregstr"));
}
