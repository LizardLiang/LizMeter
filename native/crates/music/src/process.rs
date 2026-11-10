//! `process-manager.ts`: yt-dlp child processes tracked by purpose key, with kill-by-key,
//! kill-by-prefix, kill-all and a timeout. Arguments are an array, never a shell string.
//!
//! Killing a process kills its whole tree (`taskkill /T /F`): yt-dlp starts ffmpeg children that
//! `Child::kill` alone would leave running.

use crate::error::{MusicError, Result};
use lizmeter_core::MusicErrorCode;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(120_000);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A command that opens no console window.
pub fn command(program: &Path) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Kills `pid` and every process it started. Blocks until the helper returns.
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("taskkill");
        c.args(["/pid", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        c.creation_flags(CREATE_NO_WINDOW);
        let _ = c.status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
    }
}

#[derive(Debug, Clone, Default)]
pub struct SpawnOptions {
    /// Default 120 s.
    pub timeout: Option<Duration>,
    /// `--no-playlist` is prepended unless this is `Some(false)` (playlist-aware commands).
    pub no_playlist: Option<bool>,
}

/// One tracked child. Its pipes are handed to the caller as [`Spawned`].
pub struct ProcHandle {
    pub pid: u32,
    id: u64,
    child: Mutex<Child>,
    status: Mutex<Option<ExitStatus>>,
    timed_out: AtomicBool,
    killed: AtomicBool,
}

impl ProcHandle {
    fn poll(&self) -> Option<ExitStatus> {
        if let Some(s) = *lock(&self.status) {
            return Some(s);
        }
        let s = lock(&self.child).try_wait().ok().flatten();
        if s.is_some() {
            *lock(&self.status) = s;
        }
        s
    }

    /// Waits for the process to exit. `None` when it died without an exit code.
    pub fn wait(&self) -> Option<i32> {
        loop {
            if let Some(s) = self.poll() {
                return s.code();
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn timed_out(&self) -> bool {
        self.timed_out.load(Ordering::SeqCst)
    }

    /// Whether [`ProcHandle::kill`] stopped a live process (a stop, a replacement or a shutdown),
    /// as opposed to the process ending by itself.
    pub fn was_killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }

    pub fn has_exited(&self) -> bool {
        self.poll().is_some()
    }

    /// Kills the tree and waits (bounded) for the exit so file handles are released.
    pub fn kill(&self) {
        if self.poll().is_some() {
            return;
        }
        self.killed.store(true, Ordering::SeqCst);
        kill_tree(self.pid);
        let _ = lock(&self.child).kill();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if self.poll().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

pub struct Spawned {
    pub handle: Arc<ProcHandle>,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
}

type Tracked = Arc<Mutex<HashMap<String, Arc<ProcHandle>>>>;

/// Concurrent keyed yt-dlp processes. Dropping the manager kills whatever is still running.
pub struct ProcessManager {
    yt_dlp: PathBuf,
    active: Tracked,
    next_id: AtomicU64,
}

impl ProcessManager {
    pub fn new(yt_dlp_path: impl Into<PathBuf>) -> Self {
        ProcessManager { yt_dlp: yt_dlp_path.into(), active: Arc::default(), next_id: AtomicU64::new(1) }
    }

    /// Starts yt-dlp with `args`. A process already running under `key` is killed first
    /// (replacement); other keys run side by side.
    pub fn spawn(&self, key: &str, args: &[String], options: &SpawnOptions) -> Result<Spawned> {
        let timeout = options.timeout.unwrap_or(DEFAULT_TIMEOUT);
        self.kill_process(key);

        let mut final_args: Vec<String> = Vec::with_capacity(args.len() + 1);
        if options.no_playlist != Some(false) {
            final_args.push("--no-playlist".into());
        }
        final_args.extend_from_slice(args);

        let mut cmd = command(&self.yt_dlp);
        cmd.args(&final_args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| MusicError::new(MusicErrorCode::ExtractionFailed, format!("Failed to spawn yt-dlp: {e}")))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let handle = Arc::new(ProcHandle {
            pid: child.id(),
            id: self.next_id.fetch_add(1, Ordering::SeqCst),
            child: Mutex::new(child),
            status: Mutex::new(None),
            timed_out: AtomicBool::new(false),
            killed: AtomicBool::new(false),
        });
        lock(&self.active).insert(key.to_string(), handle.clone());

        // Watcher: removes the map entry on exit and enforces the timeout.
        let (h, active, key) = (handle.clone(), self.active.clone(), key.to_string());
        let started = Instant::now();
        std::thread::spawn(move || loop {
            if h.poll().is_some() {
                remove_if_same(&active, &key, h.id);
                return;
            }
            if started.elapsed() >= timeout && !h.timed_out() {
                h.timed_out.store(true, Ordering::SeqCst);
                remove_if_same(&active, &key, h.id);
                kill_tree(h.pid);
            }
            std::thread::sleep(Duration::from_millis(25));
        });
        Ok(Spawned { handle, stdout, stderr })
    }

    /// Kills the process under `key`. No-op when there is none.
    pub fn kill_process(&self, key: &str) {
        let h = lock(&self.active).remove(key);
        if let Some(h) = h {
            h.kill();
        }
    }

    pub fn kill_all(&self) {
        let all: Vec<_> = lock(&self.active).drain().map(|(_, h)| h).collect();
        for h in all {
            h.kill();
        }
    }

    /// Kills every process whose key starts with `prefix` (`music:stop` uses `stream:`). Returns
    /// once each is gone, so a caller can delete the file it was writing.
    pub fn kill_by_prefix(&self, prefix: &str) {
        let hit: Vec<_> = {
            let mut m = lock(&self.active);
            let keys: Vec<String> = m.keys().filter(|k| k.starts_with(prefix)).cloned().collect();
            keys.into_iter().filter_map(|k| m.remove(&k)).collect()
        };
        for h in hit {
            h.kill();
        }
    }

    pub fn active_count(&self) -> usize {
        lock(&self.active).len()
    }

    /// Processes still running, for diagnostics.
    pub fn active_pids(&self) -> Vec<u32> {
        lock(&self.active).values().map(|h| h.pid).collect()
    }
}

impl Drop for ProcessManager {
    fn drop(&mut self) {
        self.kill_all();
    }
}

fn remove_if_same(active: &Tracked, key: &str, id: u64) {
    let mut m = lock(active);
    if m.get(key).is_some_and(|h| h.id == id) {
        m.remove(key);
    }
}

/// Output of a short command run to completion.
pub struct Captured {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a short command with a timeout, capturing both streams. Used for the `--version` health
/// checks and the ffmpeg probes. A timeout kills the tree and returns `TimedOut`.
pub fn run_capture(program: &Path, args: &[&str], timeout: Duration) -> std::io::Result<Captured> {
    let mut cmd = command(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let mut out = child.stdout.take().expect("piped");
    let mut err = child.stderr.take().expect("piped");
    let t_out = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let t_err = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let started = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break Some(s);
        }
        if started.elapsed() >= timeout {
            kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stdout = String::from_utf8_lossy(&t_out.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&t_err.join().unwrap_or_default()).into_owned();
    match status {
        Some(s) => Ok(Captured { code: s.code(), stdout, stderr }),
        None => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "process timed out")),
    }
}
