//! FR-013: watches the shared folder continuously, and re-scans it on a slower timer regardless of
//! whether any filesystem event fires (`watcher.ts`). Cloud-drive clients do not reliably emit clean
//! events, so the periodic path is the mechanism that guarantees the 60-second target, not a fallback.

use crate::oplog::get_sync_devices_dir;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// Comfortably under the 60-second target, leaving margin for the cloud drive's own delay.
pub const PERIODIC_RESCAN: Duration = Duration::from_secs(30);

/// Events that arrive within this window collapse into one `on_change` call.
const DEBOUNCE: Duration = Duration::from_millis(150);

enum Message {
    Event,
    Stop,
}

pub struct SyncWatcher {
    tx: Sender<Message>,
    worker: Option<JoinHandle<()>>,
    _fs_watcher: Option<RecommendedWatcher>,
}

impl SyncWatcher {
    /// Stops the worker and waits for it. A merge pass in flight finishes first.
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        let _ = self.tx.send(Message::Stop);
        if let Some(handle) = self.worker.take() {
            // Stopping from inside `on_change` (the worker's own thread) must not wait on itself.
            if handle.thread().id() != std::thread::current().id() {
                let _ = handle.join();
            }
        }
        self._fs_watcher = None;
    }
}

impl Drop for SyncWatcher {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Starts watching `<data_dir>/sync/devices/` and calls `on_change` on any event, plus once every
/// `periodic` regardless. `on_change` runs its own merge pass and must not panic for a routine
/// "nothing new" result.
pub fn start_watching(
    data_dir: &Path,
    on_change: Arc<dyn Fn() + Send + Sync>,
    periodic: Duration,
) -> crate::Result<SyncWatcher> {
    let dir = get_sync_devices_dir(data_dir);
    std::fs::create_dir_all(&dir)?;

    let (tx, rx) = channel::<Message>();

    // The OS watcher can fail on some filesystems: the periodic re-scan below still covers this
    // device, just less promptly. This is exactly what FR-013 exists for.
    let event_tx = tx.clone();
    let fs_watcher = notify::recommended_watcher(move |_event: notify::Result<notify::Event>| {
        let _ = event_tx.send(Message::Event);
    })
    .ok()
    .and_then(|mut w| w.watch(&dir, RecursiveMode::NonRecursive).ok().map(|_| w));

    let worker = std::thread::spawn(move || loop {
        match rx.recv_timeout(periodic) {
            Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(Message::Event) => {
                // Collapse a burst (a cloud client writes several files at once) into one pass.
                loop {
                    match rx.recv_timeout(DEBOUNCE) {
                        Ok(Message::Event) => continue,
                        Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                        Err(RecvTimeoutError::Timeout) => break,
                    }
                }
                run_guarded(&on_change);
            }
            Err(RecvTimeoutError::Timeout) => run_guarded(&on_change),
        }
    });

    Ok(SyncWatcher { tx, worker: Some(worker), _fs_watcher: fs_watcher })
}

/// A panic inside one pass must not end the worker: later events and the periodic rescan still run.
fn run_guarded(on_change: &Arc<dyn Fn() + Send + Sync>) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| on_change()));
}
