//! Single-writer guard tests. Everything runs on temporary data folders. The Electron holder is a
//! stub: a copy of this test binary, renamed, with a `resources\app.asar` beside it. No real
//! LizMeter process is touched.

use lizmeter_services::os::guard::{mutex_name_for, ElectronMatcher, GuardError, Holder, SingleWriterGuard};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

const HOLD_DIR_ENV: &str = "LIZMETER_GUARD_TEST_HOLD_DIR";

/// Run only as a child of the tests below: holds the guard until its stdin closes.
#[test]
#[ignore = "helper process for the guard tests"]
fn guard_holder_process() {
    let dir = PathBuf::from(std::env::var(HOLD_DIR_ENV).expect("hold dir"));
    let _guard = SingleWriterGuard::acquire(&dir, None).expect("holder acquires");
    println!("GUARD-READY");
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
}

/// Run only as a child of the tests below: a process that exists until its stdin closes.
#[test]
#[ignore = "helper process for the guard tests"]
fn stub_process_sleep() {
    println!("STUB-READY");
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
}

fn spawn_helper(exe: &Path, test_name: &str, hold_dir: Option<&Path>, ready: &str) -> Child {
    let mut cmd = Command::new(exe);
    cmd.args(["--ignored", "--exact", test_name, "--nocapture", "--test-threads=1"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = hold_dir {
        cmd.env(HOLD_DIR_ENV, dir);
    }
    let mut child = cmd.spawn().expect("spawn helper");
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        assert!(reader.read_line(&mut line).unwrap() > 0, "helper exited before it was ready");
        if line.contains(ready) {
            break;
        }
    }
    // Keep draining so the child never blocks on a full pipe.
    std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = reader.read_to_end(&mut sink);
    });
    child
}

fn kill(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn temp_dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[test]
fn a_second_acquire_on_one_folder_is_refused_naming_this_process() {
    let dir = temp_dir();
    let first = SingleWriterGuard::acquire(dir.path(), None).unwrap();
    let err = SingleWriterGuard::acquire(dir.path(), None).err().expect("second acquire fails");
    match &err {
        GuardError::Held { holder: Holder::Native { pid, .. }, .. } => assert_eq!(*pid, Some(std::process::id())),
        other => panic!("unexpected: {other:?}"),
    }
    assert!(err.to_string().contains(&format!("process {}", std::process::id())), "{err}");
    drop(first);
    SingleWriterGuard::acquire(dir.path(), None).expect("released on drop");
}

#[test]
fn different_folders_do_not_block_each_other() {
    let (a, b) = (temp_dir(), temp_dir());
    let _ga = SingleWriterGuard::acquire(a.path(), None).unwrap();
    let _gb = SingleWriterGuard::acquire(b.path(), None).unwrap();
}

#[test]
fn the_mutex_name_ignores_case_and_path_spelling() {
    let dir = temp_dir();
    let spelled = dir.path().join(".");
    let upper = PathBuf::from(dir.path().to_string_lossy().to_uppercase());
    assert_eq!(mutex_name_for(dir.path()), mutex_name_for(&spelled));
    assert_eq!(mutex_name_for(dir.path()), mutex_name_for(&upper));
    assert_ne!(mutex_name_for(dir.path()), mutex_name_for(temp_dir().path()));
    assert!(mutex_name_for(dir.path()).starts_with("Local\\LizMeter-DataDir-"));
}

#[test]
fn another_native_process_holds_the_folder_and_the_refusal_names_it() {
    let dir = temp_dir();
    let exe = std::env::current_exe().unwrap();
    let holder = spawn_helper(&exe, "guard_holder_process", Some(dir.path()), "GUARD-READY");
    let holder_pid = holder.id();

    let err = SingleWriterGuard::acquire(dir.path(), None).err().expect("refused while the holder runs");
    match &err {
        GuardError::Held { holder: Holder::Native { pid, exe }, .. } => {
            assert_eq!(*pid, Some(holder_pid));
            assert!(exe.is_some());
        }
        other => panic!("unexpected: {other:?}"),
    }
    assert!(err.to_string().contains(&holder_pid.to_string()), "{err}");

    // A killed holder cannot clean up after itself; the OS drops its mutex and file lock.
    kill(holder);
    SingleWriterGuard::acquire(dir.path(), None).expect("a crashed holder does not leave a stale lock");
}

struct Stub {
    _tmp: tempfile::TempDir,
    child: Child,
    matcher: ElectronMatcher,
}

fn electron_stub(marker_present: bool) -> Stub {
    let tmp = temp_dir();
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let exe_name = format!("LizMeterStub{}x{n}.exe", std::process::id());
    let stub_exe = tmp.path().join(&exe_name);
    std::fs::copy(std::env::current_exe().unwrap(), &stub_exe).unwrap();
    if marker_present {
        std::fs::create_dir_all(tmp.path().join("resources")).unwrap();
        std::fs::write(tmp.path().join("resources").join("app.asar"), b"").unwrap();
    }
    let child = spawn_helper(&stub_exe, "stub_process_sleep", None, "STUB-READY");
    let matcher = ElectronMatcher { exe_name, marker: PathBuf::from("resources").join("app.asar") };
    Stub { _tmp: tmp, child, matcher }
}

#[test]
fn a_running_electron_build_blocks_a_native_start_on_the_same_data_and_is_named() {
    let dir = temp_dir();
    let stub = electron_stub(true);
    let stub_pid = stub.child.id();

    let err = SingleWriterGuard::acquire(dir.path(), Some(&stub.matcher)).err().expect("refused");
    match &err {
        GuardError::Held { holder: Holder::Electron { pid, exe }, .. } => {
            assert_eq!(*pid, stub_pid);
            assert!(exe.to_string_lossy().contains("LizMeterStub"));
        }
        other => panic!("unexpected: {other:?}"),
    }
    assert!(err.to_string().contains("Electron LizMeter is running"), "{err}");

    // A soak copy or test folder does not share data with that Electron build: no check, no refusal.
    SingleWriterGuard::acquire(dir.path(), None).expect("no Electron check requested");
    kill(stub.child);
}

#[test]
fn a_process_without_the_electron_marker_is_not_mistaken_for_electron() {
    let dir = temp_dir();
    let stub = electron_stub(false);
    SingleWriterGuard::acquire(dir.path(), Some(&stub.matcher)).expect("same name, but no resources\\app.asar");
    kill(stub.child);
}

#[test]
fn no_electron_process_means_the_native_start_goes_ahead() {
    let dir = temp_dir();
    let matcher = ElectronMatcher { exe_name: "LizMeterNobodyRunsThis.exe".into(), marker: PathBuf::from("resources").join("app.asar") };
    SingleWriterGuard::acquire(dir.path(), Some(&matcher)).expect("nothing to detect");
}

#[test]
fn the_electron_check_never_names_this_process() {
    // The matcher below matches this very binary (its name, and a marker that always exists), so only
    // the finder skipping its own pid keeps the result from naming this process.
    let own = std::env::current_exe().unwrap();
    let matcher = ElectronMatcher {
        exe_name: own.file_name().unwrap().to_string_lossy().into_owned(),
        marker: PathBuf::from("."),
    };
    let found = lizmeter_services::os::guard::find_electron_process(&matcher);
    assert!(found.is_none_or(|(pid, _)| pid != std::process::id()));
}

#[test]
fn the_mutex_only_guard_blocks_a_second_holder_and_writes_no_file() {
    let dir = temp_dir();
    let held = SingleWriterGuard::acquire_mutex_only(dir.path()).unwrap();
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "nothing is written into the folder");
    assert!(SingleWriterGuard::acquire_mutex_only(dir.path()).is_err());
    assert!(SingleWriterGuard::acquire(dir.path(), None).is_err(), "the file guard shares the same mutex");
    drop(held);
    SingleWriterGuard::acquire_mutex_only(dir.path()).unwrap();
}
