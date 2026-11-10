//! `process-manager.ts` behaviour against a fake yt-dlp: keyed replacement, prefix kills,
//! tree kills, timeouts and cleanup on drop.
mod common;

use common::{fake_bin_dir, pid_alive, read_args_log, read_pids};
use lizmeter_music::process::{ProcessManager, SpawnOptions};
use std::time::{Duration, Instant};

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for {what}");
}

fn hang_rig(extra: &[(&str, &str)]) -> (tempfile::TempDir, std::path::PathBuf, ProcessManager) {
    let root = tempfile::tempdir().unwrap();
    let mut cfg = vec![("stream_mode", "hang")];
    cfg.extend_from_slice(extra);
    let bin = fake_bin_dir(root.path(), &cfg, &[]);
    let pm = ProcessManager::new(bin.join("yt-dlp.exe"));
    (root, bin, pm)
}

#[test]
fn prepends_no_playlist_unless_the_command_is_playlist_aware() {
    let root = tempfile::tempdir().unwrap();
    let bin = fake_bin_dir(root.path(), &[("version", "1")], &[]);
    let pm = ProcessManager::new(bin.join("yt-dlp.exe"));
    let s = pm.spawn("a", &args(&["--version"]), &SpawnOptions::default()).unwrap();
    s.handle.wait();
    let s = pm.spawn("b", &args(&["--version"]), &SpawnOptions { no_playlist: Some(false), ..Default::default() }).unwrap();
    s.handle.wait();
    let log = read_args_log(&bin);
    assert_eq!(log[0], vec!["--no-playlist", "--version"]);
    assert_eq!(log[1], vec!["--version"]);
}

#[test]
fn a_second_spawn_with_the_same_key_replaces_the_first() {
    let (_root, bin, pm) = hang_rig(&[]);
    let first = pm.spawn("stream:x", &args(&["-o", "-"]), &SpawnOptions::default()).unwrap();
    wait_until("first pid logged", || read_pids(&bin).len() == 1);
    let second = pm.spawn("stream:x", &args(&["-o", "-"]), &SpawnOptions::default()).unwrap();
    assert!(first.handle.has_exited(), "the replaced process must be gone");
    assert!(!second.handle.has_exited());
    assert_eq!(pm.active_count(), 1);
    pm.kill_all();
    assert_eq!(pm.active_count(), 0);
}

#[test]
fn different_keys_run_side_by_side() {
    let (_root, _bin, pm) = hang_rig(&[]);
    let a = pm.spawn("stream:a", &args(&["-o", "-"]), &SpawnOptions::default()).unwrap();
    let b = pm.spawn("metadata:a", &args(&["-o", "-"]), &SpawnOptions::default()).unwrap();
    assert_eq!(pm.active_count(), 2);
    assert!(!a.handle.has_exited() && !b.handle.has_exited());
}

#[test]
fn kill_by_prefix_leaves_other_keys_alone() {
    let (_root, _bin, pm) = hang_rig(&[]);
    let s = pm.spawn("stream:a", &args(&["-o", "-"]), &SpawnOptions::default()).unwrap();
    let m = pm.spawn("metadata:a", &args(&["-o", "-"]), &SpawnOptions::default()).unwrap();
    pm.kill_by_prefix("stream:");
    assert!(s.handle.has_exited());
    assert!(!m.handle.has_exited());
    assert_eq!(pm.active_count(), 1);
}

#[test]
fn killing_a_process_kills_the_children_it_started() {
    let (_root, bin, pm) = hang_rig(&[("spawn_child", "1")]);
    let s = pm.spawn("stream:a", &args(&["-o", "-"]), &SpawnOptions::default()).unwrap();
    wait_until("child pid logged", || read_pids(&bin).iter().any(|(r, _)| r == "child"));
    let child = read_pids(&bin).into_iter().find(|(r, _)| r == "child").unwrap().1;
    assert!(pid_alive(child));
    pm.kill_process("stream:a");
    assert!(s.handle.has_exited());
    wait_until("grandchild exit", || !pid_alive(child));
}

#[test]
fn a_timeout_kills_the_process_and_is_reported() {
    let (_root, _bin, pm) = hang_rig(&[]);
    let opts = SpawnOptions { timeout: Some(Duration::from_millis(300)), ..Default::default() };
    let s = pm.spawn("stream:t", &args(&["-o", "-"]), &opts).unwrap();
    s.handle.wait();
    assert!(s.handle.timed_out());
    wait_until("map entry removed", || pm.active_count() == 0);
}

#[test]
fn an_exited_process_leaves_the_map() {
    let root = tempfile::tempdir().unwrap();
    let bin = fake_bin_dir(root.path(), &[], &[]);
    let pm = ProcessManager::new(bin.join("yt-dlp.exe"));
    let s = pm.spawn("v", &args(&["--version"]), &SpawnOptions::default()).unwrap();
    assert_eq!(s.handle.wait(), Some(0));
    wait_until("map entry removed", || pm.active_count() == 0);
}

#[test]
fn dropping_the_manager_kills_what_is_still_running() {
    let (_root, _bin, pm) = hang_rig(&[]);
    let s = pm.spawn("stream:d", &args(&["-o", "-"]), &SpawnOptions::default()).unwrap();
    let pid = s.handle.pid;
    drop(pm);
    wait_until("process exit", || !pid_alive(pid));
}

#[test]
fn a_missing_binary_is_an_extraction_failure() {
    let pm = ProcessManager::new("Z:\\nowhere\\yt-dlp.exe");
    let e = pm.spawn("k", &args(&[]), &SpawnOptions::default()).err().unwrap();
    assert_eq!(e.code_str(), "EXTRACTION_FAILED");
    assert!(e.message.starts_with("Failed to spawn yt-dlp"));
}
